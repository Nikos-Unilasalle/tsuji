import * as THREE from "three";

/**
 * Which points of a mesh-sized point cloud the camera actually sees, for
 * brushes and picks that must not reach through the surface to the far side.
 *
 * A BVH raycast per point (what Edit Mesh does for its handful of handles)
 * costs ~4 µs at 25k points — 14 ms for one brush dab, 100 ms for a full
 * cloud. Here the surface's view depth is rendered once into a float target,
 * read back once, and every point is compared against it: one GPU pass and
 * one readback per camera / mesh change, then O(1) per point.
 */

/** A point counts as on the surface within this fraction of its distance — vertices sit exactly on their faces. */
const DEPTH_TOLERANCE = 0.004;
/** The depth target is rendered at this fraction of the viewport, which is plenty for a 3×3-pixel comparison. */
const DEPTH_SCALE = 0.5;

/**
 * Fills `out[i]` with 1 when point i is seen, 0 when the surface hides it.
 * `depth` is an RGBA float readback (row 0 at the bottom, GL order) whose red
 * channel holds the surface's view-space depth, 0 where there is no surface.
 * Each point is checked against the farthest surface in the 3×3 pixels around
 * its own, so a vertex on a slope or on the silhouette is never hidden by its
 * own faces. Points off-screen or behind the camera count as seen: the picks
 * skip those on their own.
 */
export function computePointVisibility(
  positions: Float32Array,
  count: number,
  /** view matrix × the cloud's space matrix */
  modelView: THREE.Matrix4,
  /** projection × view × space */
  modelViewProjection: THREE.Matrix4,
  depth: Float32Array,
  width: number,
  height: number,
  out: Uint8Array,
): void {
  const v = modelView.elements;
  const e = modelViewProjection.elements;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (w <= 0) {
      out[i] = 1;
      continue;
    }
    const px = Math.floor((((e[0] * x + e[4] * y + e[8] * z + e[12]) / w + 1) * width) / 2);
    const py = Math.floor((((e[1] * x + e[5] * y + e[9] * z + e[13]) / w + 1) * height) / 2);
    if (px < 0 || py < 0 || px >= width || py >= height) {
      out[i] = 1;
      continue;
    }
    const pointDepth = -(v[2] * x + v[6] * y + v[10] * z + v[14]);
    let farthest = 0;
    let open = false;
    for (let dy = -1; dy <= 1 && !open; dy++) {
      const row = py + dy;
      if (row < 0 || row >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const col = px + dx;
        if (col < 0 || col >= width) continue;
        const d = depth[(row * width + col) * 4];
        if (d <= 0) {
          open = true; // background right next to it: on the silhouette, seen
          break;
        }
        if (d > farthest) farthest = d;
      }
    }
    out[i] = open || pointDepth <= farthest * (1 + DEPTH_TOLERANCE) ? 1 : 0;
  }
}

const DEPTH_VERTEX = /* glsl */ `
  varying float vViewDepth;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const DEPTH_FRAGMENT = /* glsl */ `
  varying float vViewDepth;
  void main() {
    gl_FragColor = vec4(vViewDepth, 0.0, 0.0, 1.0);
  }
`;

export interface DepthProbe {
  /** Renders `geometry` placed by `spaceMatrix` as seen by `camera` and returns its view-depth readback. */
  render(
    renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
    geometry: THREE.BufferGeometry,
    spaceMatrix: THREE.Matrix4,
    widthPx: number,
    heightPx: number,
  ): { depth: Float32Array; width: number; height: number };
  dispose(): void;
}

export function createDepthProbe(): DepthProbe {
  const material = new THREE.ShaderMaterial({ vertexShader: DEPTH_VERTEX, fragmentShader: DEPTH_FRAGMENT, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  let target: THREE.WebGLRenderTarget | null = null;
  let depth = new Float32Array(0);
  const savedClear = new THREE.Color();

  return {
    render(renderer, camera, geometry, spaceMatrix, widthPx, heightPx) {
      const width = Math.max(1, Math.round(widthPx * DEPTH_SCALE));
      const height = Math.max(1, Math.round(heightPx * DEPTH_SCALE));
      if (!target || target.width !== width || target.height !== height) {
        target?.dispose();
        target = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true });
        depth = new Float32Array(width * height * 4);
      }
      mesh.geometry = geometry;
      mesh.matrix.copy(spaceMatrix);
      mesh.matrixWorld.copy(spaceMatrix);

      const savedTarget = renderer.getRenderTarget();
      renderer.getClearColor(savedClear);
      const savedAlpha = renderer.getClearAlpha();
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, depth);
      renderer.setRenderTarget(savedTarget);
      renderer.setClearColor(savedClear, savedAlpha);
      return { depth, width, height };
    },
    dispose() {
      target?.dispose();
      target = null;
      material.dispose();
    },
  };
}
