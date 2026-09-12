import * as THREE from "three";
import { worldMatrixOf } from "../../graph/objectPosition";
import { getBoundsTree, initBvhRaycast } from "../bvh";

/**
 * A height field baked off a mesh, for scattering things onto it in a shader.
 *
 * Red carries the world height, green carries whether the ray hit anything at all — the corners
 * of a round island's bounding box have no ground under them, and a blade of grass planted there
 * would otherwise stand on the zero plane.
 */
export interface GroundHeightField {
  texture: THREE.DataTexture;
  center: THREE.Vector2;
  size: THREE.Vector2;
  signature: string;
}

/**
 * What the field depends on: the meshes, their poses, and the resolution asked for. Baking is a
 * raycast per texel, so it has to happen only when one of those actually changes.
 */
export function groundSignature(object: THREE.Object3D, resolution: number): string {
  const parts: string[] = [String(resolution)];
  const matrix = new THREE.Matrix4();

  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible) return;
    worldMatrixOf(mesh, matrix);
    parts.push(`${mesh.geometry.uuid}:${matrix.elements.map((n) => Math.round(n * 1000)).join(",")}`);
  });

  return parts.join("|");
}

/**
 * The height under a world XZ point, and whether there is ground there at all.
 *
 * The TypeScript twin of `sampleGround` in the grass shader — same bilinear filter, same rule
 * that all four texels have to be hits, so a blade and a leaf agree on where the ground ends.
 */
export function sampleGroundHeight(field: GroundHeightField, x: number, z: number): { height: number; hit: number } {
  const width = field.texture.image.width;
  const data = field.texture.image.data as Float32Array;

  const u = (x - field.center.x) / field.size.x + 0.5;
  const v = (z - field.center.y) / field.size.y + 0.5;
  if (u < 0 || u > 1 || v < 0 || v > 1) return { height: 0, hit: 0 };

  const cx = Math.min(width - 1, Math.max(0, u * width - 0.5));
  const cz = Math.min(width - 1, Math.max(0, v * width - 0.5));
  const i0 = Math.floor(cx);
  const j0 = Math.floor(cz);
  const i1 = Math.min(width - 1, i0 + 1);
  const j1 = Math.min(width - 1, j0 + 1);
  const fx = cx - i0;
  const fz = cz - j0;

  const at = (i: number, j: number) => (j * width + i) * 4;
  const k00 = at(i0, j0);
  const k10 = at(i1, j0);
  const k01 = at(i0, j1);
  const k11 = at(i1, j1);

  const height =
    (data[k00] * (1 - fx) + data[k10] * fx) * (1 - fz) + (data[k01] * (1 - fx) + data[k11] * fx) * fz;
  const hit = Math.min(data[k00 + 1], data[k10 + 1], data[k01 + 1], data[k11 + 1]);

  return { height, hit };
}

function collectMeshes(object: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.visible && mesh.geometry) meshes.push(mesh);
  });
  return meshes;
}

/**
 * Rasterises the surface of `object` into a height texture by dropping a ray on every texel.
 *
 * Raycasting rather than reading the geometry directly, because the ground can be anything a
 * graph produced: a Terrain, an imported mesh, several merged objects, a displaced plane. The
 * project installs three-mesh-bvh over `Mesh.raycast`, so this is a BVH query per texel.
 */
export function bakeGroundHeight(
  object: THREE.Object3D,
  resolution: number,
  previous?: GroundHeightField,
): GroundHeightField | null {
  const meshes = collectMeshes(object);
  if (meshes.length === 0) return null;

  // The poses the raycaster will use have to be the ones this evaluation computed, not whatever
  // matrixWorld still holds from last frame.
  const matrix = new THREE.Matrix4();
  for (const mesh of meshes) {
    worldMatrixOf(mesh, matrix);
    mesh.matrixWorld.copy(matrix);
    mesh.matrixWorldNeedsUpdate = false;
  }

  const bounds = new THREE.Box3();
  const meshBounds = new THREE.Box3();
  for (const mesh of meshes) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    meshBounds.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
    bounds.union(meshBounds);
  }
  if (bounds.isEmpty()) return null;

  const size = new THREE.Vector2(Math.max(0.001, bounds.max.x - bounds.min.x), Math.max(0.001, bounds.max.z - bounds.min.z));
  const center = new THREE.Vector2((bounds.min.x + bounds.max.x) * 0.5, (bounds.min.z + bounds.max.z) * 0.5);
  const rayHeight = bounds.max.y + Math.max(1, bounds.max.y - bounds.min.y);

  const width = Math.max(2, Math.floor(resolution));
  const data = new Float32Array(width * width * 4);

  // Without a bounds tree every ray walks every triangle, and a 128x128 field over a 128x128
  // terrain is half a billion triangle tests: 80 seconds rather than milliseconds. Both calls are
  // idempotent, so asking here costs nothing beyond the first bake.
  initBvhRaycast();
  for (const mesh of meshes) getBoundsTree(mesh.geometry);

  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  const origin = new THREE.Vector3();
  const down = new THREE.Vector3(0, -1, 0);

  for (let j = 0; j < width; j++) {
    // Texel centres, so texel 0 sits half a texel inside the bounds rather than on the edge.
    const z = bounds.min.z + ((j + 0.5) / width) * size.y;
    for (let i = 0; i < width; i++) {
      const x = bounds.min.x + ((i + 0.5) / width) * size.x;
      origin.set(x, rayHeight, z);
      raycaster.set(origin, down);

      let height = 0;
      let hit = 0;
      for (const mesh of meshes) {
        const intersections = raycaster.intersectObject(mesh, false);
        if (intersections.length === 0) continue;
        const y = intersections[0].point.y;
        // The highest surface wins, so grass grows on a bridge rather than in the river below it.
        if (hit === 0 || y > height) height = y;
        hit = 1;
      }

      const k = (j * width + i) * 4;
      data[k] = height;
      data[k + 1] = hit;
      data[k + 3] = 1;
    }
  }

  const reusable = previous && previous.texture.image.width === width;
  const texture = reusable
    ? previous!.texture
    : new THREE.DataTexture(data, width, width, THREE.RGBAFormat, THREE.FloatType);

  if (reusable) {
    (texture.image.data as Float32Array).set(data);
  } else {
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
  }
  texture.needsUpdate = true;

  return { texture, center, size, signature: groundSignature(object, resolution) };
}
