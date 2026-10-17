import * as THREE from "three";

/**
 * Viewport markers for a *mesh-sized* point cloud — Points Selection and
 * Points Influence, where the point count is a mesh's vertex count (an
 * 80k-face OBJ is ~240k) rather than a curve's handful of control points.
 *
 * This exists because `createCurvePointHandles` builds one THREE.Mesh — with
 * its own PlaneGeometry and Material — per point, and billboards each one
 * individually every frame. That is exactly right for a curve you drag by
 * its control points (each handle has to be independently pickable by
 * TransformControls), and catastrophic at vertex scale: a sphere's ~2k
 * vertices meant 2k draw calls a frame, and a real OBJ meant hundreds of
 * thousands of live Meshes, which is a hang rather than a slowdown.
 *
 * Everything here is one THREE.Points instead: a single draw call at any
 * count, positions and colors in flat typed arrays updated in place, and
 * hit-testing done with plain matrix math over those arrays rather than by
 * asking each of N Object3Ds for its world position. Nothing in this file
 * is per-point on the CPU except tight loops over Float32Arrays.
 *
 * The tradeoff versus curve handles is that individual points are not
 * draggable Object3Ds — which is exactly the contract these two nodes want,
 * since they only ever *select* or *paint* points, never move them.
 */

const HANDLE_SIZE_PX = 5;
const HANDLE_COLOR = 0x84cc16;
const HANDLE_SELECTED_COLOR = 0x38bdf8;
/** Screen-space pick radius. A world-space one would be unclickable zoomed out and grab half the scene zoomed in. */
const PICK_RADIUS_PX = 12;
const RENDER_ORDER = 999;

export interface PointCloudHandles {
  readonly group: THREE.Group;
  /**
   * Update the cloud to `points`, expressed in the space of `spaceMatrix`.
   * `colorOverride` wins per index when it returns a color (the influence
   * heatmap); otherwise a point is drawn selected or unselected.
   */
  sync(
    points: THREE.Vector3[],
    spaceMatrix: THREE.Matrix4,
    selectedIndices: Set<number> | number[] | number | null,
    colorOverride?: (idx: number) => number | null | undefined
  ): void;
  /**
   * Recolor only `indices`, leaving positions and every other color as the
   * last sync left them — a brush stroke touches the points under the brush,
   * and a full sync per pointermove recolored all of a mesh's vertices to
   * change a few hundred. Only the span the indices cover is re-uploaded.
   * Indices outside the current cloud are ignored.
   */
  updateColors(indices: Iterable<number>, color: (idx: number) => number): void;
  clear(): void;
  /** Index of the point nearest the pointer within PICK_RADIUS_PX, or null. */
  pick(ndc: THREE.Vector2, camera: THREE.Camera, widthPx: number, heightPx: number): number | null;
  /** All point indices inside the screen-space marquee box. */
  pickRect(
    rect: { minX: number; minY: number; maxX: number; maxY: number },
    camera: THREE.Camera,
    widthPx: number,
    heightPx: number
  ): number[];
  /** All point indices within `radiusPx` of `centerPx`, with distance — the brush hit test. */
  pickCircle(
    centerPx: { x: number; y: number },
    radiusPx: number,
    camera: THREE.Camera,
    widthPx: number,
    heightPx: number
  ): { index: number; distance: number }[];
  /** Every visible point's screen position — the Gradient tool's projection basis. */
  projectAll(camera: THREE.Camera, widthPx: number, heightPx: number): { index: number; x: number; y: number }[];
  count(): number;
}

function toSet(val: Set<number> | number[] | number | null): Set<number> | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "number") return new Set([val]);
  if (Array.isArray(val)) return new Set(val);
  return val;
}

export function createPointCloudHandles(): PointCloudHandles {
  const group = new THREE.Group();
  // Driven by the source object's world matrix, never by position/quaternion/scale.
  group.matrixAutoUpdate = false;

  let cloud: THREE.Points | null = null;
  let geometry: THREE.BufferGeometry | null = null;
  let positions: Float32Array = new Float32Array(0);
  let colors: Float32Array = new Float32Array(0);
  let pointCount = 0;
  const spaceMatrix = new THREE.Matrix4();

  // Reused across hit tests so picking never allocates.
  const combined = new THREE.Matrix4();
  const scratchColor = new THREE.Color();
  /**
   * hex → linear RGB, filled on first use. `setHex` converts sRGB → linear
   * (three's color management) on every call, which was most of sync's cost
   * at mesh vertex counts; the colors used are a handful (two, or the 256 of
   * the influence heatmap), so each is converted once.
   */
  const rgbByHex = new Map<number, [number, number, number]>();
  function rgbOf(hex: number): [number, number, number] {
    let rgb = rgbByHex.get(hex);
    if (!rgb) {
      scratchColor.setHex(hex);
      rgb = [scratchColor.r, scratchColor.g, scratchColor.b];
      rgbByHex.set(hex, rgb);
    }
    return rgb;
  }

  function clear() {
    if (cloud) {
      group.remove(cloud);
      cloud.geometry.dispose();
      (cloud.material as THREE.Material).dispose();
    }
    cloud = null;
    geometry = null;
    positions = new Float32Array(0);
    colors = new Float32Array(0);
    pointCount = 0;
  }

  function build(count: number) {
    clear();
    positions = new Float32Array(count * 3);
    colors = new Float32Array(count * 3);
    geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    // sizeAttenuation off makes `size` a constant pixel size, which is what
    // the per-handle billboard-and-counter-scale dance was hand-rolling
    // before — and it stays correct under a scaled space matrix for free.
    // depthTest off so a point buried inside its own mesh is still visible
    // and clickable, matching the curve handles' convention.
    const material = new THREE.PointsMaterial({
      size: HANDLE_SIZE_PX,
      sizeAttenuation: false,
      vertexColors: true,
      depthTest: false,
      transparent: true,
    });
    cloud = new THREE.Points(geometry, material);
    cloud.renderOrder = RENDER_ORDER;
    cloud.frustumCulled = false; // the cloud tracks a deforming mesh; a stale bounding sphere must never hide it
    cloud.matrixAutoUpdate = false;
    group.add(cloud);
    pointCount = count;
  }

  /**
   * projectionMatrix * viewMatrix * spaceMatrix — lets a hit test turn a
   * local point straight into clip space with one inlined multiply, instead
   * of walking N Object3Ds.
   */
  function updateCombined(camera: THREE.Camera): Float32Array | number[] {
    camera.updateMatrixWorld();
    combined.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(spaceMatrix);
    return combined.elements as unknown as number[];
  }

  /** Projects point `i` to screen pixels; returns false when it's behind the camera. */
  function projectPoint(
    e: Float32Array | number[],
    i: number,
    widthPx: number,
    heightPx: number,
    out: { x: number; y: number },
  ): boolean {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (w <= 0) return false; // behind the camera
    const ndcX = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
    const ndcY = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
    out.x = ((ndcX + 1) * widthPx) / 2;
    out.y = ((-ndcY + 1) * heightPx) / 2;
    return true;
  }

  const scratchScreen = { x: 0, y: 0 };

  return {
    group,

    sync(points, matrix, selectedIndices, colorOverride) {
      if (points.length !== pointCount) build(points.length);
      if (!geometry || pointCount === 0) return;

      const selected = toSet(selectedIndices);

      for (let i = 0; i < pointCount; i++) {
        const p = points[i];
        const b = i * 3;
        positions[b] = p.x;
        positions[b + 1] = p.y;
        positions[b + 2] = p.z;

        const override = colorOverride?.(i);
        const hex = override !== null && override !== undefined ? override : selected?.has(i) ? HANDLE_SELECTED_COLOR : HANDLE_COLOR;
        const rgb = rgbOf(hex);
        colors[b] = rgb[0];
        colors[b + 1] = rgb[1];
        colors[b + 2] = rgb[2];
      }

      geometry.attributes.position.needsUpdate = true;
      // A pending updateColors range would otherwise limit this upload to it.
      (geometry.attributes.color as THREE.BufferAttribute).clearUpdateRanges();
      geometry.attributes.color.needsUpdate = true;

      spaceMatrix.copy(matrix);
      group.matrix.copy(matrix);
      // Forced: nothing else recomputes matrixWorld for a group whose matrix
      // is assigned rather than derived.
      group.updateMatrixWorld(true);
    },

    updateColors(indices, color) {
      if (!geometry || pointCount === 0) return;
      let min = Infinity;
      let max = -Infinity;
      for (const i of indices) {
        if (i < 0 || i >= pointCount) continue;
        const rgb = rgbOf(color(i));
        const b = i * 3;
        colors[b] = rgb[0];
        colors[b + 1] = rgb[1];
        colors[b + 2] = rgb[2];
        if (i < min) min = i;
        if (i > max) max = i;
      }
      if (max < min) return;
      const attr = geometry.attributes.color as THREE.BufferAttribute;
      attr.addUpdateRange(min * 3, (max - min + 1) * 3);
      attr.needsUpdate = true;
    },

    clear,

    pick(ndc, camera, widthPx, heightPx) {
      if (pointCount === 0) return null;
      const e = updateCombined(camera);
      // The pointer in the same pixel space projectPoint reports.
      const px = ((ndc.x + 1) * widthPx) / 2;
      const py = ((-ndc.y + 1) * heightPx) / 2;

      let bestIndex: number | null = null;
      let bestDistance = PICK_RADIUS_PX;
      for (let i = 0; i < pointCount; i++) {
        if (!projectPoint(e, i, widthPx, heightPx, scratchScreen)) continue;
        const distance = Math.hypot(scratchScreen.x - px, scratchScreen.y - py);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = i;
        }
      }
      return bestIndex;
    },

    pickRect(rect, camera, widthPx, heightPx) {
      const matches: number[] = [];
      if (pointCount === 0) return matches;
      const e = updateCombined(camera);
      const minX = Math.min(rect.minX, rect.maxX);
      const maxX = Math.max(rect.minX, rect.maxX);
      const minY = Math.min(rect.minY, rect.maxY);
      const maxY = Math.max(rect.minY, rect.maxY);

      for (let i = 0; i < pointCount; i++) {
        if (!projectPoint(e, i, widthPx, heightPx, scratchScreen)) continue;
        if (scratchScreen.x >= minX && scratchScreen.x <= maxX && scratchScreen.y >= minY && scratchScreen.y <= maxY) {
          matches.push(i);
        }
      }
      return matches;
    },

    pickCircle(centerPx, radiusPx, camera, widthPx, heightPx) {
      const matches: { index: number; distance: number }[] = [];
      if (pointCount === 0) return matches;
      const e = updateCombined(camera);

      for (let i = 0; i < pointCount; i++) {
        if (!projectPoint(e, i, widthPx, heightPx, scratchScreen)) continue;
        const distance = Math.hypot(scratchScreen.x - centerPx.x, scratchScreen.y - centerPx.y);
        if (distance <= radiusPx) matches.push({ index: i, distance });
      }
      return matches;
    },

    projectAll(camera, widthPx, heightPx) {
      const result: { index: number; x: number; y: number }[] = [];
      if (pointCount === 0) return result;
      const e = updateCombined(camera);

      for (let i = 0; i < pointCount; i++) {
        if (!projectPoint(e, i, widthPx, heightPx, scratchScreen)) continue;
        result.push({ index: i, x: scratchScreen.x, y: scratchScreen.y });
      }
      return result;
    },

    count() {
      return pointCount;
    },
  };
}
