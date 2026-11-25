import type { PolyMesh } from "../quadMesh";
import {
  attrSize,
  domainSize,
  faceArea,
  faceNormals,
  facePieces,
  isBuiltinAttribute,
  listAttributeNames,
  readAttribute,
  setAttribute,
  type AttrDomain,
  type AttrType,
} from "./polyAttributes";
import { domainRelations } from "./promote";
import { PointTree, closestPointOnTriangle } from "./spatial";
import { elementPositions, pointNeighbours } from "./selectOps";
import { triangulateFace } from "./triangulate";

/*
 * The pure geometry behind the Attribute nodes (phase 3 of
 * docs/parametric-modeling-plan.md), free of THREE and of the node system so
 * it can be tested on its own: which elements neighbour which (Blur), where
 * on another surface an element lands (Transfer), discrete curvature and
 * perimeters (Measure), lists ↔ value arrays, texture pixels → numbers.
 *
 * Values travel as flat Float64Arrays, `size` numbers per element — the shape
 * readAttribute returns and setAttribute takes.
 */

// ---------------------------------------------------------------- names

/**
 * Attribute names matching a pattern: names separated by spaces or commas,
 * `*` and `?` wildcards (`rest_*`, `*`). Order follows `available`.
 */
export function matchNames(pattern: string, available: readonly string[]): string[] {
  const parts = String(pattern ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return [];
  const tests = parts.map((p) => {
    if (!/[*?]/.test(p)) return (n: string) => n === p;
    const re = new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
    return (n: string) => re.test(n);
  });
  return available.filter((n) => tests.some((t) => t(n)));
}

/** The literal names of a pattern (no wildcards), for names that are not stored yet (built-ins). */
export function literalNames(pattern: string): string[] {
  return String(pattern ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s && !/[*?]/.test(s));
}

/** Built-in names a node may write (setAttribute turns them into geometry changes). */
export function isWritableBuiltin(domain: AttrDomain, name: string): boolean {
  if (domain === "point") return name === "P";
  if (domain === "face") return name === "material_index";
  if (domain === "corner") return name === "Cd";
  return name === "sharp" || name === "seam" || name === "crease";
}

/** Whether `name` can be written on `domain` (stored attribute, or a writable built-in). */
export function canWrite(domain: AttrDomain, name: string): boolean {
  return !isBuiltinAttribute(domain, name) || isWritableBuiltin(domain, name);
}

/**
 * The current values of an attribute as a starting point for a write that
 * leaves some elements alone: the stored values when the size matches,
 * otherwise zeros (or white for a fresh colour, which reads better than black).
 */
export function baseValues(mesh: PolyMesh, domain: AttrDomain, name: string, type: AttrType): Float64Array {
  const size = attrSize(type);
  const count = domainSize(mesh, domain);
  const current = readAttribute(mesh, domain, name);
  if (current && current.size === size) return Float64Array.from(current.values);
  const out = new Float64Array(count * size);
  if (type === "color") out.fill(1);
  return out;
}

/** Non-finite numbers replaced by the old value (or 0): a formula dividing by zero must not put NaN in a mesh. */
export function sanitize(values: Float64Array, fallback?: ArrayLike<number>): Float64Array {
  for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) values[i] = fallback && Number.isFinite(fallback[i]) ? fallback[i] : 0;
  return values;
}

// ---------------------------------------------------------------- adjacency / blur

/**
 * Neighbours of every element of a domain: points through edges, faces
 * through shared edges, edges and corners through shared points.
 */
export function elementAdjacency(mesh: PolyMesh, domain: AttrDomain): number[][] {
  if (domain === "point") return pointNeighbours(mesh);
  const count = domainSize(mesh, domain);
  const out: Set<number>[] = Array.from({ length: count }, () => new Set<number>());
  if (domain === "face") {
    const facesOfEdge = domainRelations(mesh, "face", "edge");
    for (const faces of facesOfEdge) for (const f of faces) for (const g of faces) if (f !== g) out[f].add(g);
  } else {
    const elementsOfPoint = domainRelations(mesh, domain, "point");
    for (const list of elementsOfPoint) for (const a of list) for (const b of list) if (a !== b) out[a].add(b);
  }
  return out.map((s) => [...s]);
}

/**
 * Laplacian smoothing of values over an adjacency: each pass moves every
 * element `weight` of the way to the average of its neighbours (Jacobi, so
 * the result does not depend on element order). Elements outside `mask` keep
 * their value but still pull on their neighbours — they act as pins.
 */
export function blurValues(
  values: ArrayLike<number>,
  size: number,
  adjacency: readonly (readonly number[])[],
  iterations: number,
  weight = 1,
  mask?: ArrayLike<number>,
): Float64Array {
  let cur = Float64Array.from(values);
  let next = new Float64Array(cur.length);
  const w = Number.isFinite(weight) ? Math.max(0, Math.min(1, weight)) : 1;
  const passes = Math.max(0, Math.min(1000, Math.round(Number.isFinite(iterations) ? iterations : 0)));
  for (let it = 0; it < passes; it++) {
    for (let i = 0; i < adjacency.length; i++) {
      const nb = adjacency[i];
      for (let c = 0; c < size; c++) {
        const own = cur[i * size + c];
        if ((mask && !mask[i]) || nb.length === 0) {
          next[i * size + c] = own;
          continue;
        }
        let acc = 0;
        for (const j of nb) acc += cur[j * size + c];
        next[i * size + c] = own + (acc / nb.length - own) * w;
      }
    }
    const t = cur;
    cur = next;
    next = t;
  }
  return cur;
}

// ---------------------------------------------------------------- surface queries

export interface SurfaceHit {
  point: [number, number, number];
  distance: number;
  face: number;
  /** The three points of the triangle hit, and their corners (domain indices). */
  points: [number, number, number];
  corners: [number, number, number];
  /** Barycentric weights of the hit for points / corners. */
  bary: [number, number, number];
}

/** Index of each face's first corner in the corner domain. */
export function cornerStarts(mesh: PolyMesh): Int32Array {
  const out = new Int32Array(mesh.faces.length);
  let c = 0;
  mesh.faces.forEach((face, f) => {
    out[f] = c;
    c += face.length;
  });
  return out;
}

/**
 * Closest point on a mesh's surface, with the triangle and barycentrics —
 * what Attribute Transfer needs to interpolate point and corner values. Same
 * search as selectOps.makeClosestPoint: a k-d tree of triangle centroids,
 * then every triangle whose centroid could still hold something closer.
 */
export function makeSurfaceLocator(mesh: PolyMesh): (x: number, y: number, z: number) => SurfaceHit | null {
  const tris: number[] = []; // face, a, b, c (local corner indices)
  mesh.faces.forEach((face, f) => {
    if (face.length < 3) return;
    for (const [a, b, c] of triangulateFace(mesh.positions, face)) tris.push(f, a, b, c);
  });
  const n = tris.length / 4;
  if (n === 0) return () => null;
  const starts = cornerStarts(mesh);
  const P = mesh.positions;
  const centroids = new Float64Array(n * 3);
  let maxEdge = 0;
  for (let t = 0; t < n; t++) {
    const face = mesh.faces[tris[t * 4]];
    const a = P[face[tris[t * 4 + 1]]], b = P[face[tris[t * 4 + 2]]], c = P[face[tris[t * 4 + 3]]];
    for (let k = 0; k < 3; k++) centroids[t * 3 + k] = (a[k] + b[k] + c[k]) / 3;
    maxEdge = Math.max(maxEdge, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]), Math.hypot(b[0] - c[0], b[1] - c[1], b[2] - c[2]));
  }
  const tree = new PointTree(centroids);
  return (x, y, z) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    let best: SurfaceHit | null = null;
    const test = (t: number) => {
      const f = tris[t * 4];
      const face = mesh.faces[f];
      const la = tris[t * 4 + 1], lb = tris[t * 4 + 2], lc = tris[t * 4 + 3];
      const r = closestPointOnTriangle([x, y, z], P[face[la]], P[face[lb]], P[face[lc]]);
      const d = Math.hypot(r.point[0] - x, r.point[1] - y, r.point[2] - z);
      if (!best || d < best.distance) {
        best = {
          point: r.point,
          distance: d,
          face: f,
          points: [face[la], face[lb], face[lc]],
          corners: [starts[f] + la, starts[f] + lb, starts[f] + lc],
          bary: [r.u, r.v, r.w],
        };
      }
    };
    test(tree.nearest(x, y, z).index);
    const radius = (best as SurfaceHit | null)!.distance + maxEdge;
    for (const t of tree.within(x, y, z, radius)) test(t);
    return best;
  };
}

// ---------------------------------------------------------------- transfer

export type TransferMethod = "nearest-point" | "nearest-surface" | "nearest-face";
export const TRANSFER_METHODS: readonly TransferMethod[] = ["nearest-point", "nearest-surface", "nearest-face"];

export interface TransferOptions {
  domain: AttrDomain;
  /** A name pattern (`*`, `Cd mass`, `rest_*`). */
  names: string;
  method: TransferMethod;
  /** Elements farther than this keep their values; 0 or less = no limit. */
  maxDistance: number;
  /** Width of the blend zone inside maxDistance (0 = hard edge). */
  falloff: number;
  /** Elements to write (others keep their values). */
  mask?: ArrayLike<number>;
}

export interface TransferResult {
  mesh: PolyMesh;
  written: string[];
  missing: string[];
  readOnly: string[];
  /** Elements that received some of the source (weight > 0). */
  reached: number;
}

/** Names on `source` a transfer pattern picks: stored attributes, plus built-ins named literally (and Cd when the source is coloured). */
export function transferNames(source: PolyMesh, domain: AttrDomain, pattern: string): { names: string[]; missing: string[] } {
  const stored = listAttributeNames(source, domain, false);
  const available = [...stored];
  if (domain === "corner" && source.faceColors?.some((c) => c) && !available.includes("Cd")) available.push("Cd");
  const names = matchNames(pattern, available);
  const missing: string[] = [];
  for (const lit of literalNames(pattern)) {
    if (names.includes(lit)) continue;
    if (readAttribute(source, domain, lit)) names.push(lit);
    else missing.push(lit);
  }
  return { names, missing };
}

/**
 * Copies attributes from `source` onto `target` by proximity (Houdini's
 * Attribute Transfer, Blender's Sample Nearest / Sample Nearest Surface):
 *  - nearest-point: the value of the closest source element of the domain;
 *  - nearest-surface: the closest point on the source surface, point and
 *    corner values interpolated with its barycentrics (face values: the face
 *    hit); edges fall back to nearest-point;
 *  - nearest-face: the face hit, unblended (point/corner values averaged over
 *    that face), the faceted look.
 * A max distance and falloff blend the transferred value with the target's own.
 */
export function transferAttributes(target: PolyMesh, source: PolyMesh, opts: TransferOptions): TransferResult {
  const { domain } = opts;
  const { names, missing } = transferNames(source, domain, opts.names);
  const result: TransferResult = { mesh: target, written: [], missing, readOnly: [], reached: 0 };
  const count = domainSize(target, domain);
  if (names.length === 0 || count === 0 || domainSize(source, domain) === 0) return result;

  const positions = elementPositions(target, domain);
  const method: TransferMethod = domain === "edge" ? "nearest-point" : opts.method;
  const maxD = Number.isFinite(opts.maxDistance) && opts.maxDistance > 0 ? opts.maxDistance : Infinity;
  const falloff = Number.isFinite(opts.falloff) ? Math.max(0, opts.falloff) : 0;
  const weightAt = (d: number) => {
    if (!(d <= maxD)) return 0;
    if (maxD === Infinity || falloff <= 0) return 1;
    return Math.max(0, Math.min(1, (maxD - d) / falloff));
  };

  // Where every target element lands — computed once, shared by every name.
  const weights = new Float64Array(count);
  let nearest: Int32Array | null = null;
  let hits: (SurfaceHit | null)[] | null = null;
  if (method === "nearest-point") {
    const tree = new PointTree(elementPositions(source, domain));
    nearest = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      if (opts.mask && !opts.mask[i]) continue;
      const r = tree.nearest(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      nearest[i] = r.index;
      weights[i] = r.index >= 0 ? weightAt(Math.sqrt(r.distSq)) : 0;
    }
  } else {
    const locate = makeSurfaceLocator(source);
    hits = new Array(count).fill(null);
    for (let i = 0; i < count; i++) {
      if (opts.mask && !opts.mask[i]) continue;
      const h = locate(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      hits[i] = h;
      weights[i] = h ? weightAt(h.distance) : 0;
    }
  }
  for (let i = 0; i < count; i++) if (weights[i] > 0) result.reached++;

  const srcStarts = domain === "corner" ? cornerStarts(source) : null;
  let mesh = target;
  for (const name of names) {
    if (!canWrite(domain, name)) {
      result.readOnly.push(name);
      continue;
    }
    const src = readAttribute(source, domain, name);
    if (!src) continue;
    const { size, type } = src;
    const old = baseValues(mesh, domain, name, type);
    const out = Float64Array.from(old);
    const value = new Float64Array(size);
    for (let i = 0; i < count; i++) {
      const w = weights[i];
      if (w <= 0) continue;
      value.fill(0);
      if (nearest) {
        const j = nearest[i];
        for (let c = 0; c < size; c++) value[c] = src.values[j * size + c];
      } else {
        const h = hits![i]!;
        if (domain === "face") {
          for (let c = 0; c < size; c++) value[c] = src.values[h.face * size + c];
        } else if (method === "nearest-surface") {
          const idx = domain === "point" ? h.points : h.corners;
          for (let k = 0; k < 3; k++) for (let c = 0; c < size; c++) value[c] += src.values[idx[k] * size + c] * h.bary[k];
        } else {
          // nearest-face: the average over the face hit.
          const face = source.faces[h.face];
          for (let k = 0; k < face.length; k++) {
            const j = domain === "point" ? face[k] : srcStarts![h.face] + k;
            for (let c = 0; c < size; c++) value[c] += src.values[j * size + c] / face.length;
          }
        }
      }
      for (let c = 0; c < size; c++) {
        let v = old[i * size + c] * (1 - w) + value[c] * w;
        if (type === "bool") v = v >= 0.5 ? 1 : 0;
        out[i * size + c] = v;
      }
    }
    mesh = setAttribute(mesh, domain, name, type, sanitize(out, old));
    result.written.push(name);
  }
  result.mesh = mesh;
  return result;
}

// ---------------------------------------------------------------- measure

/** Perimeter of every face. */
export function facePerimeters(mesh: PolyMesh): Float64Array {
  const out = new Float64Array(mesh.faces.length);
  mesh.faces.forEach((face, f) => {
    let p = 0;
    for (let i = 0; i < face.length; i++) {
      const a = mesh.positions[face[i]], b = mesh.positions[face[(i + 1) % face.length]];
      if (a && b) p += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    }
    out[f] = p;
  });
  return out;
}

/**
 * Discrete mean curvature per point, signed (convex > 0 with outward
 * normals), in 1/length: on a sphere of radius r it reads ≈ 1/r. The umbrella
 * Laplacian (neighbour average − point) projected on the normal, over half
 * the mean squared edge length — cheap, robust on n-gons, good enough to
 * select ridges and valleys. Points with no neighbours read 0.
 */
export function pointCurvature(mesh: PolyMesh): Float64Array {
  const nb = pointNeighbours(mesh);
  const N = readAttribute(mesh, "point", "N")!.values;
  const out = new Float64Array(mesh.positions.length);
  mesh.positions.forEach((p, i) => {
    const list = nb[i];
    if (list.length === 0) return;
    let lx = 0, ly = 0, lz = 0, e2 = 0;
    for (const j of list) {
      const q = mesh.positions[j];
      const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
      lx += dx;
      ly += dy;
      lz += dz;
      e2 += dx * dx + dy * dy + dz * dz;
    }
    lx /= list.length;
    ly /= list.length;
    lz /= list.length;
    e2 /= list.length;
    if (e2 < 1e-24) return;
    const k = (-2 * (lx * N[i * 3] + ly * N[i * 3 + 1] + lz * N[i * 3 + 2])) / e2;
    out[i] = Number.isFinite(k) ? k : 0;
  });
  return out;
}

export type MeasureKind = "area" | "perimeter" | "curvature" | "piece" | "centroid" | "normal";
export const MEASURE_KINDS: readonly MeasureKind[] = ["area", "perimeter", "curvature", "piece", "centroid", "normal"];

/**
 * A measure on its natural domain (faces for area / perimeter / centroid /
 * normal / piece, points for curvature), optionally aggregated per connected
 * piece (sum for area and perimeter, area-weighted mean for centroid and
 * normal, mean for curvature).
 */
export function measure(mesh: PolyMesh, kind: MeasureKind, perPiece: boolean): { domain: AttrDomain; size: number; values: Float64Array } {
  if (kind === "curvature") {
    const values = pointCurvature(mesh);
    if (!perPiece) return { domain: "point", size: 1, values };
    // Through faces: mean curvature of the piece, spread back to its points.
    const pieces = facePieces(mesh);
    const faceVals = new Float64Array(mesh.faces.length);
    mesh.faces.forEach((face, f) => {
      let s = 0;
      for (const v of face) s += values[v];
      faceVals[f] = face.length ? s / face.length : 0;
    });
    return { domain: "face", size: 1, values: aggregate(pieces, faceVals, 1, null) };
  }
  const nf = mesh.faces.length;
  const area = new Float64Array(nf);
  mesh.faces.forEach((face, f) => (area[f] = faceArea(mesh, face)));
  let size = 1;
  let values: Float64Array;
  if (kind === "area") values = area;
  else if (kind === "perimeter") values = facePerimeters(mesh);
  else if (kind === "piece") values = Float64Array.from(facePieces(mesh));
  else if (kind === "centroid") {
    size = 3;
    values = Float64Array.from(readAttribute(mesh, "face", "P")!.values);
  } else {
    size = 3;
    values = Float64Array.from(faceNormals(mesh));
  }
  if (!perPiece || kind === "piece") return { domain: "face", size, values };
  const pieces = facePieces(mesh);
  const sum = kind === "area" || kind === "perimeter";
  const agg = aggregate(pieces, values, size, sum ? null : area, sum);
  if (kind === "normal") {
    for (let i = 0; i < nf; i++) {
      const l = Math.hypot(agg[i * 3], agg[i * 3 + 1], agg[i * 3 + 2]);
      if (l > 1e-12) for (let c = 0; c < 3; c++) agg[i * 3 + c] /= l;
    }
  }
  return { domain: "face", size, values: agg };
}

/** Per-face values reduced per piece (weighted mean, or sum) and written back to every face of the piece. */
function aggregate(pieces: Int32Array, values: Float64Array, size: number, weights: Float64Array | null, sum = false): Float64Array {
  let np = 0;
  for (const p of pieces) np = Math.max(np, p + 1);
  const weighted = new Float64Array(np * size);
  const plain = new Float64Array(np * size);
  const wsum = new Float64Array(np);
  const count = new Float64Array(np);
  pieces.forEach((p, f) => {
    const w = weights ? weights[f] : 1;
    for (let c = 0; c < size; c++) {
      weighted[p * size + c] += values[f * size + c] * w;
      plain[p * size + c] += values[f * size + c];
    }
    wsum[p] += w;
    count[p]++;
  });
  const out = new Float64Array(pieces.length * size);
  pieces.forEach((p, f) => {
    for (let c = 0; c < size; c++) {
      let v: number;
      if (sum) v = plain[p * size + c];
      // A zero-area piece still needs a mean: fall back to equal weights.
      else if (wsum[p] > 1e-20) v = weighted[p * size + c] / wsum[p];
      else v = count[p] ? plain[p * size + c] / count[p] : 0;
      out[f * size + c] = v;
    }
  });
  return out;
}

// ---------------------------------------------------------------- lists

export type ListMismatch = "repeat" | "clamp" | "zero";
export const LIST_MISMATCH: readonly ListMismatch[] = ["repeat", "clamp", "zero"];

/** Components of one list item: a number, {x,y,z}, {r,g,b}, an array, a boolean. Null when unreadable. */
export function itemComponents(item: unknown): number[] | null {
  if (typeof item === "number") return [item];
  if (typeof item === "boolean") return [item ? 1 : 0];
  if (Array.isArray(item)) return item.slice(0, 3).map((v) => Number(v));
  if (item && typeof item === "object") {
    const o = item as Record<string, unknown>;
    if ("x" in o && "y" in o) return [Number(o.x), Number(o.y), Number(o.z ?? 0)];
    if ("r" in o && "g" in o && "b" in o) return [Number(o.r), Number(o.g), Number(o.b)];
  }
  if (typeof item === "string" && item.trim() !== "" && Number.isFinite(Number(item))) return [Number(item)];
  return null;
}

/** The natural size of a list (3 when its first readable item is a vector or colour). */
export function listItemSize(list: readonly unknown[]): 1 | 3 {
  for (const item of list) {
    const c = itemComponents(item);
    if (c) return c.length > 1 ? 3 : 1;
  }
  return 1;
}

/**
 * A list written onto `targets` (element indices, in order), `size` numbers
 * each, into a copy of `base`. When the list is shorter than the targets:
 * repeat it, hold its last item (clamp), or leave the rest at zero.
 * Unreadable items read as 0; a number into a vector fills all three.
 */
export function listToValues(list: readonly unknown[], targets: readonly number[], size: number, base: Float64Array, mismatch: ListMismatch): Float64Array {
  const out = Float64Array.from(base);
  const n = list.length;
  targets.forEach((el, k) => {
    let item: unknown;
    if (k < n) item = list[k];
    else if (n === 0 || mismatch === "zero") item = 0;
    else if (mismatch === "repeat") item = list[k % n];
    else item = list[n - 1];
    const comps = itemComponents(item) ?? [0];
    for (let c = 0; c < size; c++) {
      const v = comps.length === 1 ? comps[0] : comps[c] ?? 0;
      out[el * size + c] = Number.isFinite(v) ? v : 0;
    }
  });
  return out;
}

// ---------------------------------------------------------------- texture pixels

export interface PixelSource {
  data: ArrayLike<number>;
  width: number;
  height: number;
  /** Numbers per texel (4 for RGBA). Inferred from the data length when left out. */
  channels?: number;
  /** What one stored unit is: 255 for bytes, 1 for floats. */
  scale?: number;
  /** Row 0 is the top of the image (canvas/image textures, flipY) rather than v = 0. */
  topDown?: boolean;
  /** Decodes a stored value (half floats). */
  decode?: (v: number) => number;
}

/**
 * RGBA at (u, v), bilinear, the texture repeated, into `out`. One-channel
 * textures (RedFormat) read as grey with alpha 1; two-channel as RG.
 */
export function samplePixels(px: PixelSource, u: number, v: number, out: Float64Array | number[]): void {
  const w = Math.max(1, Math.floor(px.width));
  const h = Math.max(1, Math.floor(px.height));
  const ch = px.channels ?? Math.max(1, Math.min(4, Math.round(px.data.length / (w * h)) || 4));
  const scale = px.scale && px.scale > 0 ? 1 / px.scale : 1;
  const decode = px.decode;
  if (!Number.isFinite(u)) u = 0;
  if (!Number.isFinite(v)) v = 0;
  const vv = px.topDown ? 1 - v : v;
  const x = u * w - 0.5;
  const y = vv * h - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const wrap = (i: number, n: number) => ((i % n) + n) % n;
  out[0] = out[1] = out[2] = out[3] = 0;
  const add = (xi: number, yi: number, wt: number) => {
    if (wt === 0) return;
    const base = (wrap(yi, h) * w + wrap(xi, w)) * ch;
    const read = (k: number) => {
      const raw = Number(px.data[base + k] ?? 0);
      const val = (decode ? decode(raw) : raw) * scale;
      return Number.isFinite(val) ? val : 0;
    };
    const r = read(0);
    const g = ch >= 2 ? read(1) : r;
    const b = ch >= 3 ? read(2) : ch === 2 ? 0 : r;
    const a = ch >= 4 ? read(3) : 1;
    out[0] += r * wt;
    out[1] += g * wt;
    out[2] += b * wt;
    out[3] += a * wt;
  };
  add(x0, y0, (1 - fx) * (1 - fy));
  add(x0 + 1, y0, fx * (1 - fy));
  add(x0, y0 + 1, (1 - fx) * fy);
  add(x0 + 1, y0 + 1, fx * fy);
}

/** sRGB-encoded component → linear (the colour space vertex colours are stored in). */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
