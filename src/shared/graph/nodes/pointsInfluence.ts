import * as THREE from "three";
import { NodeDefinition } from "../types";
import { resolvePointsInput } from "./pointsGeometry";
import { findFirstMesh } from "../meshRequired";
import { createNodeCache } from "../nodeCaches";
import { getTexturePaintState } from "./texturePaint";
import { clearPaintCanvas, createPaintCanvas, restorePaintCanvas, type TexturePaintTool } from "../../three/texturePainter";
import { syncCanvasTexture } from "../../three/layeredTexture";

/** The tools in the node's palette. Erase paints 0 rather than clearing to transparent, so the map stays opaque. */
export type PointsInfluenceTool = "paint" | "erase" | "smooth" | "fill";

/** The preset values the palette offers for the brush, in the order their buttons render. */
export const POINTS_INFLUENCE_LEVELS = [0, 0.2, 0.4, 0.6, 0.8, 1.0];

/** App.tsx's onAction id for the Compute button. */
export const POINTS_INFLUENCE_COMPUTE_ACTION = "points-influence/compute";

/** The empty map: no influence anywhere. */
export const POINTS_INFLUENCE_BASE = "#000000";

/**
 * Points Influence — like Points Selection, but graded: every point gets its
 * own 0-1 influence instead of a binary in/out.
 *
 * The influence is painted on the surface, not on the points: a grayscale
 * texture (black 0, white 1) on the input mesh's UVs, using Texture Paint's
 * canvas, strokes and save path (see Viewport.tsx — isTexturePaintNode
 * covers this node too). Painting therefore costs what painting a texture
 * costs, whatever the point count. Compute (App.tsx's onAction) then reads
 * the map under each vertex's UV and writes the result to `influences`,
 * which is what the node outputs — so a stroke changes nothing downstream
 * until Compute runs.
 *
 * `influences` stores only the non-zero entries (index -> 0-1), the same
 * sparse convention as Points Selection's `selectedIndices`.
 *
 * Outputs `influence`, not `mask`, but it's still a same-length numeric list
 * consumers read by index — Spring Vector / Wiggle Vector's Mask input (a
 * continuous 0-1 blend, not a binary threshold — see spring.ts/wiggle.ts)
 * and Extrude Mesh's per-vertex distance scale both accept it interchangeably
 * with Points Selection's own (0-or-1) mask output.
 */
export const POINTS_INFLUENCE_NODE: NodeDefinition = {
  type: "list/points-influence",
  label: "Points Influence",
  category: "list",
  inputs: [
    { id: "geometry", label: "Geometry (shortcut)", type: "geometry" },
    { id: "points", label: "Points", type: "list" },
    { id: "matrix", label: "Matrix (viewport placement)", type: "matrix" },
  ],
  outputs: [
    { id: "points", label: "Points (passthrough)", type: "list" },
    { id: "influence", label: "Influence (0-1 per point)", type: "list" },
    { id: "matrix", label: "Matrix (passthrough)", type: "matrix" },
    { id: "geometry", label: "Geometry (passthrough)", type: "geometry" },
    { id: "count", label: "Painted Count", type: "value" },
  ],
  defaultParams: {
    // Written by Compute from the painted map. Sparse: point index -> 0-1.
    influences: {} as Record<number, number>,
    // The painted map, as Texture Paint stores its canvas.
    textureData: "",
    resolution: 1024,
    brushTool: "paint" as PointsInfluenceTool,
    brushValue: 1,
    brushSize: 24,
    brushOpacity: 1,
    brushHardness: 0.5,
    symmetryX: false,
    usePressure: true,
    pressureTarget: "both",
  },
  paramFields: [
    {
      id: "computeNote",
      label:
        "Paint on the surface, then Compute to give each point the influence under it. Shift-drag a line in the viewport for a gradient "
        + "(100% at the start, 0% at the end), applied at once. The mesh needs UVs.",
      kind: "note",
    },
    { id: "compute", label: "Compute", kind: "button", action: POINTS_INFLUENCE_COMPUTE_ACTION },
    { id: "resolution", label: "Map Resolution", kind: "select", options: ["512", "1024", "2048"], group: "Brush" },
    {
      id: "brushTool",
      label: "Tool",
      kind: "select",
      options: ["paint", "erase", "smooth", "fill"],
      optionLabels: ["Paint", "Erase", "Smooth", "Fill"],
      group: "Brush",
    },
    { id: "brushValue", label: "Influence", kind: "number", step: 0.05, group: "Brush" },
    { id: "brushSize", label: "Size (map px)", kind: "number", step: 1, group: "Brush" },
    { id: "brushOpacity", label: "Opacity", kind: "number", step: 0.05, group: "Brush" },
    { id: "brushHardness", label: "Hardness", kind: "number", step: 0.05, group: "Brush" },
    { id: "symmetryX", label: "Mirror X (UV)", kind: "boolean", group: "Brush" },
    { id: "usePressure", label: "Stylus Pressure", kind: "boolean", group: "Brush" },
  ],
  // Reads nothing but its inputs and params (the paint canvas it keeps in
  // sync is only read by the viewport and Compute): on a still mesh it hands
  // back the same lists.
  pure: true,
  evaluate: (inputs, params, ctx) => {
    ensureInfluenceMap(ctx.nodeId, params);

    // An animated upstream (a Wiggle on the object's matrix) re-evaluates
    // this node every frame without touching a vertex: reuse the point and
    // influence lists while the source's position buffer is the same one,
    // unchanged, rather than re-extracting a Vector3 per vertex each frame.
    let cache = influenceCache.get(ctx.nodeId);
    if (!cache) {
      cache = {};
      influenceCache.set(ctx.nodeId, cache);
    }
    const srcMesh = inputs.geometry instanceof THREE.Object3D ? findFirstMesh(inputs.geometry) : null;
    const attr = srcMesh?.geometry?.attributes.position;
    const pos = attr instanceof THREE.BufferAttribute ? attr : undefined;
    let points: unknown[];
    let matrix: THREE.Matrix4;
    let geometry: THREE.Object3D | null;
    if (srcMesh && pos && cache.points && cache.posArray === pos.array && cache.posVersion === pos.version && cache.points.length === pos.count) {
      const inputObj = inputs.geometry as THREE.Object3D;
      inputObj.updateMatrixWorld(true);
      points = cache.points;
      matrix = srcMesh.matrixWorld.clone();
      geometry = inputObj;
    } else {
      ({ points, matrix, geometry } = resolvePointsInput(inputs, ctx.nodeId, "Points Influence"));
      cache.points = pos ? points : undefined;
      cache.posArray = pos?.array;
      cache.posVersion = pos?.version;
    }

    const influences = params.influences && typeof params.influences === "object" ? (params.influences as Record<string, number>) : {};
    if (cache.influencePoints !== points || cache.influences !== influences || !cache.influence) {
      let painted = 0;
      cache.influence = points.map((_, i) => {
        const v = Number(influences[i]) || 0;
        if (v > 0) painted++;
        return Math.max(0, Math.min(1, v));
      });
      cache.painted = painted;
      cache.influencePoints = points;
      cache.influences = influences;
    }

    return { points, influence: cache.influence, matrix, geometry, count: cache.painted ?? 0 };
  },
};

interface InfluenceCache {
  /** The source position buffer the points were read from, and its version then. */
  posArray?: unknown;
  posVersion?: number;
  points?: unknown[];
  /** The points and stored influences `influence` was built for. */
  influencePoints?: unknown[];
  influences?: Record<string, number>;
  influence?: number[];
  painted?: number;
}

const influenceCache = createNodeCache<InfluenceCache>();

function readResolution(params: Record<string, unknown>): number {
  return Math.max(64, Math.min(4096, Number(params.resolution) || 1024));
}

/**
 * Creates (or resizes) the node's paint canvas and brings it in line with
 * `textureData` — a reload, undo, or Clear. The canvas lives in Texture
 * Paint's per-node state, which is where the viewport's strokes look for it.
 */
function ensureInfluenceMap(nodeId: string, params: Record<string, unknown>): void {
  const state = getTexturePaintState(nodeId);
  const res = readResolution(params);
  if (!state.canvas || state.lastRes !== res) {
    state.canvas = createPaintCanvas(res, res, POINTS_INFLUENCE_BASE);
    state.lastRes = res;
    state.lastDataUrl = undefined;
    // Data, not colour: no sRGB decode, so the shader reads the value painted.
    state.texture = syncCanvasTexture(state.texture, state.canvas, THREE.NoColorSpace);
  }
  const dataUrl = String(params.textureData || "");
  if (dataUrl !== state.lastDataUrl) {
    state.lastDataUrl = dataUrl;
    const canvas = state.canvas;
    if (dataUrl) {
      restorePaintCanvas(canvas, dataUrl, () => {
        if (state.texture) state.texture.needsUpdate = true;
      });
    } else {
      clearPaintCanvas(canvas, POINTS_INFLUENCE_BASE);
      if (state.texture) state.texture.needsUpdate = true;
    }
  }
}

export function readPointsInfluenceTool(params: Record<string, unknown>): PointsInfluenceTool {
  const tool = params.brushTool;
  return tool === "erase" || tool === "smooth" || tool === "fill" ? tool : "paint";
}

export function readPointsInfluenceValue(params: Record<string, unknown>): number {
  const v = Number(params.brushValue);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}

/** `#rrggbb` gray for an influence: the map stores influence v as the gray v. */
export function influenceGray(v: number): string {
  const byte = Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${byte}${byte}${byte}`;
}

/** The Texture Paint tool and colour a stroke of this node uses. */
export function influenceStroke(params: Record<string, unknown>): { tool: TexturePaintTool; color: string } {
  const tool = readPointsInfluenceTool(params);
  if (tool === "erase") return { tool: "paint", color: POINTS_INFLUENCE_BASE };
  return { tool, color: influenceGray(readPointsInfluenceValue(params)) };
}

interface UvSource {
  count: number;
  getX(i: number): number;
  getY(i: number): number;
}

interface PositionSource extends UvSource {
  getZ(i: number): number;
}

/**
 * The influence under each vertex: the painted map bilinearly sampled at the
 * vertex's UV (V up, as the painter maps it), the gray times its alpha.
 *
 * Vertices that share a position — the copies a UV seam splits a vertex
 * into — get the strongest of their samples, so a stroke that stopped at
 * the seam on one side of the UV layout still moves the whole point.
 *
 * Returns only the non-zero entries, rounded to 1/1000.
 */
export function sampleInfluences(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  uv: UvSource,
  position?: PositionSource,
): Record<number, number> {
  const values = sampleMap(pixels, width, height, uv);

  if (position && position.count === uv.count) {
    const key = (i: number) =>
      `${Math.round(position.getX(i) * 1e5)},${Math.round(position.getY(i) * 1e5)},${Math.round(position.getZ(i) * 1e5)}`;
    const strongest = new Map<string, number>();
    for (let i = 0; i < values.length; i++) {
      const k = key(i);
      strongest.set(k, Math.max(strongest.get(k) ?? 0, values[i]));
    }
    for (let i = 0; i < values.length; i++) values[i] = strongest.get(key(i)) ?? values[i];
  }

  return sparseInfluences(values);
}

/** The map bilinearly sampled under each UV (V up, as the painter maps it): the gray times its alpha, 0-1. */
function sampleMap(pixels: Uint8ClampedArray, width: number, height: number, uv: UvSource): Float32Array {
  const values = new Float32Array(uv.count);
  const read = (x: number, y: number) => {
    const xi = ((x % width) + width) % width;
    const yi = Math.max(0, Math.min(height - 1, y));
    const o = (yi * width + xi) * 4;
    return (pixels[o] / 255) * (pixels[o + 3] / 255);
  };
  for (let i = 0; i < uv.count; i++) {
    const u = ((uv.getX(i) % 1) + 1) % 1;
    const v = Math.max(0, Math.min(1, uv.getY(i)));
    const fx = u * width - 0.5;
    const fy = (1 - v) * height - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const top = read(x0, y0) * (1 - tx) + read(x0 + 1, y0) * tx;
    const bottom = read(x0, y0 + 1) * (1 - tx) + read(x0 + 1, y0 + 1) * tx;
    values[i] = top * (1 - ty) + bottom * ty;
  }
  return values;
}

/**
 * Compute: the influence each vertex of `geometry` reads from the node's
 * painted map. Null when the geometry has no UVs (nothing to sample with)
 * or the node has no map yet.
 */
export function computePointInfluences(nodeId: string, geometry: THREE.BufferGeometry): Record<number, number> | null {
  const uv = geometry.attributes.uv;
  const canvas = getTexturePaintState(nodeId).canvas;
  if (!uv || !canvas) return null;
  const ctx2d = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx2d) return null;
  const { data } = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
  return sampleInfluences(data, canvas.width, canvas.height, uv, geometry.attributes.position);
}

/**
 * Gradient (Shift-drag in the viewport): each vertex's influence is its own
 * projection onto the dragged screen line — 1 at the start, 0 at the end,
 * linear in between, clamped past either end. `screen` holds the vertices'
 * projected positions, x then y, in the same pixels as the line.
 */
export function gradientInfluences(
  screen: Float32Array,
  start: { x: number; y: number },
  end: { x: number; y: number },
): Float32Array {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lenSq = dx * dx + dy * dy || 1;
  const values = new Float32Array(screen.length / 2);
  for (let i = 0; i < values.length; i++) {
    const t = ((screen[i * 2] - start.x) * dx + (screen[i * 2 + 1] - start.y) * dy) / lenSq;
    values[i] = 1 - Math.max(0, Math.min(1, t));
  }
  return values;
}

/** The sparse `influences` param for one value per vertex: the non-zero entries, rounded to 1/1000. */
export function sparseInfluences(values: ArrayLike<number>): Record<number, number> {
  const out: Record<number, number> = {};
  for (let i = 0; i < values.length; i++) {
    const rounded = Math.round(values[i] * 1000) / 1000;
    if (rounded > 0) out[i] = rounded;
  }
  return out;
}

/**
 * Rasterises one value per vertex into an RGBA map, on the UV layout:
 * every triangle filled with its corners' values blended across it, the
 * gray v as influence v, as the painter stores it. Texels no triangle
 * covers are 0, apart from a few texels of padding grown out of each
 * island's edge so bilinear reads at a seam don't pull in that 0.
 */
export function rasterizeVertexValues(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  uv: UvSource,
  values: ArrayLike<number>,
  index?: ArrayLike<number> | null,
): void {
  const written = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
    pixels[i + 3] = 255;
  }
  forEachUvTexel(width, height, uv, values, index, (o, v) => {
    const byte = Math.round(Math.max(0, Math.min(1, v)) * 255);
    pixels[o * 4] = pixels[o * 4 + 1] = pixels[o * 4 + 2] = byte;
    written[o] = 1;
  });

  // Padding: each pass copies into every empty texel the value of a written neighbour.
  const offsets = [-1, 1, -width, width];
  for (let pass = 0; pass < 3; pass++) {
    const grown: number[] = [];
    for (let o = 0; o < written.length; o++) {
      if (written[o]) continue;
      const x = o % width;
      for (const d of offsets) {
        const n = o + d;
        if (n < 0 || n >= written.length || written[n] !== 1) continue;
        if ((d === -1 && x === 0) || (d === 1 && x === width - 1)) continue;
        grown.push(o, pixels[n * 4]);
        break;
      }
    }
    for (let i = 0; i < grown.length; i += 2) {
      const o = grown[i];
      pixels[o * 4] = pixels[o * 4 + 1] = pixels[o * 4 + 2] = grown[i + 1];
      written[o] = 2;
    }
    for (let o = 0; o < written.length; o++) if (written[o] === 2) written[o] = 1;
  }
}

/**
 * Shift-drag's gradient: the node's map repainted whole from the line (see
 * gradientInfluences), and the influences that gives each vertex — what
 * Compute would read back from that map, without the round trip. Null when
 * the geometry has no UVs or the node has no map yet.
 */
export function applyInfluenceGradient(
  nodeId: string,
  geometry: THREE.BufferGeometry,
  screen: Float32Array,
  start: { x: number; y: number },
  end: { x: number; y: number },
): Record<number, number> | null {
  const uv = geometry.attributes.uv;
  const state = getTexturePaintState(nodeId);
  const canvas = state.canvas;
  if (!uv || !canvas) return null;
  const ctx2d = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx2d) return null;
  const values = gradientInfluences(screen, start, end);
  const image = ctx2d.createImageData(canvas.width, canvas.height);
  rasterizeVertexValues(image.data, canvas.width, canvas.height, uv, values, geometry.index?.array);
  ctx2d.putImageData(image, 0, 0);
  if (state.texture) state.texture.needsUpdate = true;
  return sparseInfluences(values);
}

/** Calls `put` for every texel a UV triangle covers, with its corners' values blended at that texel. */
function forEachUvTexel(
  width: number,
  height: number,
  uv: UvSource,
  values: ArrayLike<number>,
  index: ArrayLike<number> | null | undefined,
  put: (texel: number, value: number) => void,
): void {
  const triCount = Math.floor((index ? index.length : uv.count) / 3);
  for (let t = 0; t < triCount; t++) {
    const a = index ? index[t * 3] : t * 3;
    const b = index ? index[t * 3 + 1] : t * 3 + 1;
    const c = index ? index[t * 3 + 2] : t * 3 + 2;
    // Canvas pixels, V up as the painter maps it.
    const ax = uv.getX(a) * width, ay = (1 - uv.getY(a)) * height;
    const bx = uv.getX(b) * width, by = (1 - uv.getY(b)) * height;
    const cx = uv.getX(c) * width, cy = (1 - uv.getY(c)) * height;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue;
    const va = values[a], vb = values[b], vc = values[c];
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const wa = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
        const wb = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
        const wc = 1 - wa - wb;
        if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
        put(y * width + x, va * wa + vb * wb + vc * wc);
      }
    }
  }
}

/**
 * Which texels of a width×height map the UV layout covers (1) — its islands,
 * plus the few texels of padding rasterizeVertexValues grows round them.
 */
export function uvCoverageMask(width: number, height: number, uv: UvSource, index?: ArrayLike<number> | null): Uint8Array {
  const pixels = new Uint8ClampedArray(width * height * 4);
  rasterizeVertexValues(pixels, width, height, uv, new Float32Array(uv.count).fill(1), index);
  const mask = new Uint8Array(width * height);
  for (let o = 0; o < mask.length; o++) mask[o] = pixels[o * 4] > 0 ? 1 : 0;
  return mask;
}

/** One box-blur pass of `radius` along rows (step 1) or columns (step width), in place via `tmp`. */
function boxPass(data: Float32Array, tmp: Float32Array, width: number, height: number, radius: number, horizontal: boolean): void {
  const lines = horizontal ? height : width;
  const length = horizontal ? width : height;
  const step = horizontal ? 1 : width;
  const span = radius * 2 + 1;
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * width : line;
    let sum = 0;
    // Edges clamp: the window repeats the first/last texel.
    for (let k = -radius; k <= radius; k++) sum += data[base + Math.max(0, Math.min(length - 1, k)) * step];
    for (let i = 0; i < length; i++) {
      tmp[base + i * step] = sum / span;
      const out = Math.max(0, i - radius);
      const into = Math.min(length - 1, i + radius + 1);
      sum += data[base + into * step] - data[base + out * step];
    }
  }
  data.set(tmp);
}

/**
 * The influence map blurred by `radius` texels (three box passes each way,
 * close to a Gaussian). With a coverage `mask` (uvCoverageMask), only the
 * islands are averaged — the empty texels between them are left out of the
 * sums rather than counted as 0 — so an island's edge doesn't darken toward
 * the gaps; texels outside the mask keep their value. Returns a new RGBA
 * buffer, opaque, the gray as influence.
 */
export function blurInfluenceMap(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
  mask?: Uint8Array | null,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src);
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return out;
  const n = width * height;
  const value = new Float32Array(n);
  const weight = new Float32Array(n);
  for (let o = 0; o < n; o++) {
    const w = mask ? mask[o] : 1;
    value[o] = ((src[o * 4] / 255) * (src[o * 4 + 3] / 255)) * w;
    weight[o] = w;
  }
  const tmp = new Float32Array(n);
  // A third of the radius per pass: three passes reach about `radius`.
  const passRadius = Math.max(1, Math.round(r / 3));
  for (let pass = 0; pass < 3; pass++) {
    for (const horizontal of [true, false]) {
      boxPass(value, tmp, width, height, passRadius, horizontal);
      if (mask) boxPass(weight, tmp, width, height, passRadius, horizontal);
    }
  }
  for (let o = 0; o < n; o++) {
    if (mask && !mask[o]) continue;
    const v = mask ? (weight[o] > 1e-6 ? value[o] / weight[o] : 0) : value[o];
    const byte = Math.round(Math.max(0, Math.min(1, v)) * 255);
    out[o * 4] = out[o * 4 + 1] = out[o * 4 + 2] = byte;
    out[o * 4 + 3] = 255;
  }
  return out;
}

/**
 * What a surface blur of one mesh's map needs, built once per Blur drag:
 * the UV coverage, the vertices welded by position (the copies a UV seam
 * splits a vertex into become one again) with their neighbours across the
 * surface, and how big a texel and an edge are in scene units.
 */
export interface SurfaceBlurSetup {
  width: number;
  height: number;
  uv: UvSource;
  index: ArrayLike<number> | null;
  mask: Uint8Array;
  /** Buffer vertex -> welded vertex. */
  weldOf: Int32Array;
  weldCount: number;
  /** Welded neighbours, CSR: those of w are adj[adjStart[w] .. adjStart[w + 1]). */
  adjStart: Int32Array;
  adj: Int32Array;
  /** Scene units per map texel, and the mean edge length. */
  texelWorld: number;
  edgeWorld: number;
}

export function prepareSurfaceBlur(
  width: number,
  height: number,
  uv: UvSource,
  position: PositionSource,
  index?: ArrayLike<number> | null,
): SurfaceBlurSetup {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const q = 1e5 / Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-9);
  const ids = new Map<string, number>();
  const weldOf = new Int32Array(position.count);
  for (let i = 0; i < position.count; i++) {
    const key = `${Math.round(position.getX(i) * q)},${Math.round(position.getY(i) * q)},${Math.round(position.getZ(i) * q)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    weldOf[i] = id;
  }
  const weldCount = ids.size;

  const neighbours: Set<number>[] = Array.from({ length: weldCount }, () => new Set<number>());
  const triCount = Math.floor((index ? index.length : position.count) / 3);
  let worldSum = 0, texelSum = 0, edges = 0;
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const i = index ? index[t * 3 + k] : t * 3 + k;
      const j = index ? index[t * 3 + ((k + 1) % 3)] : t * 3 + ((k + 1) % 3);
      const a = weldOf[i], b = weldOf[j];
      if (a === b) continue;
      neighbours[a].add(b);
      neighbours[b].add(a);
      worldSum += Math.hypot(position.getX(i) - position.getX(j), position.getY(i) - position.getY(j), position.getZ(i) - position.getZ(j));
      texelSum += Math.hypot((uv.getX(i) - uv.getX(j)) * width, (uv.getY(i) - uv.getY(j)) * height);
      edges++;
    }
  }
  const adjStart = new Int32Array(weldCount + 1);
  for (let w = 0; w < weldCount; w++) adjStart[w + 1] = adjStart[w] + neighbours[w].size;
  const adj = new Int32Array(adjStart[weldCount]);
  for (let w = 0; w < weldCount; w++) adj.set([...neighbours[w]], adjStart[w]);

  return {
    width,
    height,
    uv,
    index: index ?? null,
    mask: uvCoverageMask(width, height, uv, index),
    weldOf,
    weldCount,
    adjStart,
    adj,
    texelWorld: texelSum > 0 ? worldSum / texelSum : 0,
    edgeWorld: edges > 0 ? worldSum / edges : 0,
  };
}

/** Most smoothing passes one surface blur runs: past this, a dense mesh at a big radius is approximated. */
const SURFACE_BLUR_MAX_PASSES = 300;

/**
 * The whole map blurred over the surface, across UV seams.
 *
 * Inside each island the map is blurred in UV space (blurInfluenceMap),
 * which keeps the painted detail finer than the mesh. That alone stops at
 * every seam: the two sides of a cut are far apart in the map, so a value
 * can't flow from one to the other. So the result is then read at every
 * vertex, the copies a seam splits a vertex into are welded back together,
 * and the values are smoothed over the mesh's edges — about as far, in
 * scene units, as `radius` texels — and the change each vertex gets is
 * blended across its triangles and added to the map. A seam ends up with
 * one value on both sides, and the blur spreads across it.
 */
export function blurInfluenceOnSurface(setup: SurfaceBlurSetup, src: Uint8ClampedArray, radius: number): Uint8ClampedArray {
  const { width, height, uv, index, mask, weldOf, weldCount, adjStart, adj, texelWorld, edgeWorld } = setup;
  const blurred = blurInfluenceMap(src, width, height, radius, mask);
  if (radius <= 0 || weldCount === 0) return blurred;

  const sampled = sampleMap(blurred, width, height, uv);
  let values = new Float32Array(weldCount);
  const copies = new Uint32Array(weldCount);
  for (let i = 0; i < sampled.length; i++) {
    values[weldOf[i]] += sampled[i];
    copies[weldOf[i]]++;
  }
  for (let w = 0; w < weldCount; w++) if (copies[w]) values[w] /= copies[w];

  // Each pass moves a vertex halfway to its neighbours' mean, spreading by
  // about half an edge: (radius in scene units / edge)² passes reach it.
  const reach = edgeWorld > 0 ? (radius * texelWorld) / edgeWorld : 0;
  const passes = Math.min(SURFACE_BLUR_MAX_PASSES, Math.max(1, Math.round(reach * reach)));
  let next = new Float32Array(weldCount);
  for (let pass = 0; pass < passes; pass++) {
    for (let w = 0; w < weldCount; w++) {
      const start = adjStart[w], end = adjStart[w + 1];
      if (start === end) {
        next[w] = values[w];
        continue;
      }
      let sum = 0;
      for (let k = start; k < end; k++) sum += values[adj[k]];
      next[w] = values[w] * 0.5 + (sum / (end - start)) * 0.5;
    }
    [values, next] = [next, values];
  }

  const delta = new Float32Array(sampled.length);
  for (let i = 0; i < sampled.length; i++) delta[i] = values[weldOf[i]] - sampled[i];
  const change = new Float32Array(width * height);
  const written = new Uint8Array(width * height);
  forEachUvTexel(width, height, uv, delta, index, (o, v) => {
    change[o] = v;
    written[o] = 1;
  });
  // The padding round the islands takes the change of the texel it grew from.
  const offsets = [-1, 1, -width, width];
  for (let pass = 0; pass < 3; pass++) {
    const grown: number[] = [];
    for (let o = 0; o < written.length; o++) {
      if (written[o] || !mask[o]) continue;
      const x = o % width;
      for (const d of offsets) {
        const n = o + d;
        if (n < 0 || n >= written.length || written[n] !== 1) continue;
        if ((d === -1 && x === 0) || (d === 1 && x === width - 1)) continue;
        grown.push(o, change[n]);
        break;
      }
    }
    for (let i = 0; i < grown.length; i += 2) {
      change[grown[i]] = grown[i + 1];
      written[grown[i]] = 1;
    }
  }

  for (let o = 0; o < change.length; o++) {
    if (!written[o]) continue;
    const byte = Math.round(Math.max(0, Math.min(1, blurred[o * 4] / 255 + change[o])) * 255);
    blurred[o * 4] = blurred[o * 4 + 1] = blurred[o * 4 + 2] = byte;
  }
  return blurred;
}
