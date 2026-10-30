import { SkinWeights, weldVertices } from "./skinning";

/**
 * Painted corrections on top of Skin's automatic weights.
 *
 * Nothing painted replaces the automatic weights: each stroke leaves, per
 * joint and per vertex, an offset from them. The automatic weights can then be
 * weighed again (another falloff, a moved joint) and the paint still says
 * "more of this joint here, less there". A vertex never painted keeps its
 * automatic weights exactly.
 *
 * Applying one joint's offset sets that joint's share of the vertex and scales
 * every other joint so the total stays 1; what a joint gives up when nothing
 * else holds the vertex goes to its parent (a root's, to its first child).
 * Joints apply in index order.
 */

/** Per joint, per vertex: the offset from the automatic weight. */
export type PaintLayer = Map<number, Map<number, number>>;

/** What a Skin node stores, one entry per mesh it binds (null where nothing is painted). */
export interface StoredPaint {
  /** Vertex count the paint was made on: paint on a mesh of another size is dropped, not misplaced. */
  vertices: number;
  /** Joint index -> flat [vertex, offset, vertex, offset, ...]. */
  joints: Record<string, number[]>;
}

export type WeightBrush = "Add" | "Subtract" | "Smooth";
export const WEIGHT_BRUSHES: WeightBrush[] = ["Add", "Subtract", "Smooth"];

/** Offsets smaller than this are no paint at all. */
const NEGLIGIBLE = 1e-4;

export function readPaintLayer(raw: unknown, mesh: number, vertexCount: number): PaintLayer {
  const layer: PaintLayer = new Map();
  if (!Array.isArray(raw)) return layer;
  const stored = raw[mesh] as StoredPaint | null | undefined;
  if (!stored || stored.vertices !== vertexCount || !stored.joints || typeof stored.joints !== "object") return layer;
  for (const [key, flat] of Object.entries(stored.joints)) {
    const joint = Number(key);
    if (!Number.isInteger(joint) || joint < 0 || !Array.isArray(flat)) continue;
    const offsets = new Map<number, number>();
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const v = flat[i];
      const d = Number(flat[i + 1]);
      if (Number.isInteger(v) && v >= 0 && v < vertexCount && Number.isFinite(d) && Math.abs(d) >= NEGLIGIBLE) offsets.set(v, Math.max(-1, Math.min(1, d)));
    }
    if (offsets.size > 0) layer.set(joint, offsets);
  }
  return layer;
}

/** The params value for these layers; an empty list when nothing is painted anywhere. */
export function storePaintLayers(layers: PaintLayer[], vertexCounts: number[]): (StoredPaint | null)[] {
  const out: (StoredPaint | null)[] = layers.map((layer, i) => {
    const joints: Record<string, number[]> = {};
    let any = false;
    for (const joint of [...layer.keys()].sort((a, b) => a - b)) {
      const flat: number[] = [];
      for (const v of [...layer.get(joint)!.keys()].sort((a, b) => a - b)) {
        const d = Math.round(layer.get(joint)!.get(v)! * 1e4) / 1e4;
        if (Math.abs(d) >= NEGLIGIBLE) flat.push(v, d);
      }
      if (flat.length > 0) {
        joints[joint] = flat;
        any = true;
      }
    }
    return any ? { vertices: vertexCounts[i], joints } : null;
  });
  while (out.length > 0 && out[out.length - 1] === null) out.pop();
  return out;
}

export function cloneSkin(skin: SkinWeights): SkinWeights {
  return { influences: skin.influences, indices: skin.indices.slice(), weights: skin.weights.slice() };
}

/** How much of vertex `v` follows `joint`. */
export function jointWeight(skin: SkinWeights, v: number, joint: number): number {
  let w = 0;
  const o = v * skin.influences;
  for (let k = 0; k < skin.influences; k++) if (skin.indices[o + k] === joint) w += skin.weights[o + k];
  return w;
}

/** Where a joint's weight goes when nothing else holds the vertex. */
function heirOf(joint: number, parents: number[]): number {
  if (parents[joint] >= 0) return parents[joint];
  return parents.indexOf(joint);
}

/**
 * Writes the painted weights of `vertices` (every painted vertex when omitted)
 * into `into`, starting from `auto`. `into` may be a copy of `auto` made
 * earlier: vertices not listed are left as they are.
 */
export function applyPaintLayer(auto: SkinWeights, layer: PaintLayer, parents: number[], into: SkinWeights, vertices?: Iterable<number>): void {
  const n = auto.influences;
  let todo: Iterable<number>;
  if (vertices) todo = vertices;
  else {
    const all = new Set<number>();
    for (const offsets of layer.values()) for (const v of offsets.keys()) all.add(v);
    todo = all;
  }
  const joints = [...layer.keys()].sort((a, b) => a - b);
  const share = new Map<number, number>();
  for (const v of todo) {
    const o = v * n;
    share.clear();
    for (let k = 0; k < n; k++) {
      const w = auto.weights[o + k];
      if (w > 0) share.set(auto.indices[o + k], (share.get(auto.indices[o + k]) ?? 0) + w);
    }
    let painted = false;
    for (const joint of joints) {
      const d = layer.get(joint)!.get(v);
      if (d === undefined) continue;
      painted = true;
      const old = share.get(joint) ?? 0;
      const now = Math.max(0, Math.min(1, old + d));
      const restOld = 1 - old;
      const restNow = 1 - now;
      if (restOld > 1e-6) {
        const scale = restNow / restOld;
        for (const [j, w] of share) if (j !== joint) share.set(j, w * scale);
      } else if (restNow > 0) {
        const heir = heirOf(joint, parents);
        if (heir >= 0) share.set(heir, (share.get(heir) ?? 0) + restNow);
      }
      share.set(joint, now);
    }
    if (!painted) {
      into.indices.set(auto.indices.subarray(o, o + n), o);
      into.weights.set(auto.weights.subarray(o, o + n), o);
      continue;
    }
    // The strongest `n`, renormalised.
    const kept = [...share].filter(([, w]) => w > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, n);
    const total = kept.reduce((sum, [, w]) => sum + w, 0);
    if (total <= 0) {
      into.indices.set(auto.indices.subarray(o, o + n), o);
      into.weights.set(auto.weights.subarray(o, o + n), o);
      continue;
    }
    for (let k = 0; k < n; k++) {
      into.indices[o + k] = k < kept.length ? kept[k][0] : 0;
      into.weights[o + k] = k < kept.length ? kept[k][1] / total : 0;
    }
  }
}

/** Neighbours through welded positions, so a split mesh smooths across its seams. */
export interface PaintNeighbours {
  weldOf: Int32Array;
  reps: Int32Array;
  /** Per weld, the welds sharing a triangle edge with it. */
  around: Int32Array[];
}

export function paintNeighbours(positions: ArrayLike<number>, index: ArrayLike<number> | null): PaintNeighbours {
  const vertexCount = Math.floor(positions.length / 3);
  const { weldOf, reps, welds } = weldVertices(positions, vertexCount);
  const sets: Set<number>[] = Array.from({ length: welds }, () => new Set<number>());
  const triangles = index ? Math.floor(index.length / 3) : Math.floor(vertexCount / 3);
  const at = (i: number) => weldOf[index ? index[i] : i];
  for (let t = 0; t < triangles; t++) {
    const a = at(t * 3);
    const b = at(t * 3 + 1);
    const c = at(t * 3 + 2);
    if (a !== b) sets[a].add(b), sets[b].add(a);
    if (b !== c) sets[b].add(c), sets[c].add(b);
    if (c !== a) sets[c].add(a), sets[a].add(c);
  }
  return { weldOf, reps: reps.subarray(0, welds), around: sets.map((s) => Int32Array.from(s)) };
}

export interface Dab {
  joint: number;
  tool: WeightBrush;
  /** Brush centre, in the same space as `positions`. */
  center: { x: number; y: number; z: number };
  radius: number;
  /** 0..1: how far one dab goes towards its target at the brush centre. */
  strength: number;
}

/**
 * One dab of the brush: moves `joint`'s weight under it towards 1 (Add), 0
 * (Subtract) or its neighbours' average (Smooth), with a smooth falloff to the
 * brush's edge. Updates `layer`, rewrites the touched vertices of `skin` (the
 * painted weights, starting from `auto`) and returns them.
 * `positions` are where the vertices are now, so one paints what one sees.
 */
export function paintDab(
  layer: PaintLayer,
  auto: SkinWeights,
  skin: SkinWeights,
  parents: number[],
  positions: ArrayLike<number>,
  neighbours: PaintNeighbours | null,
  dab: Dab,
): number[] {
  const { joint, tool, center, radius } = dab;
  const strength = Math.max(0, Math.min(1, dab.strength));
  const r2 = radius * radius;
  const vertexCount = Math.floor(positions.length / 3);
  const hit: number[] = [];
  const reach: number[] = [];
  for (let v = 0; v < vertexCount; v++) {
    const dx = positions[v * 3] - center.x;
    const dy = positions[v * 3 + 1] - center.y;
    const dz = positions[v * 3 + 2] - center.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= r2) continue;
    const t = 1 - d2 / r2;
    hit.push(v);
    reach.push(t * t);
  }
  if (hit.length === 0) return hit;

  // Targets first, all read from the weights before this dab, so Smooth does not chase itself.
  const targets = hit.map((v) => {
    if (tool === "Add") return 1;
    if (tool === "Subtract") return 0;
    if (!neighbours) return jointWeight(skin, v, joint);
    const around = neighbours.around[neighbours.weldOf[v]];
    if (around.length === 0) return jointWeight(skin, v, joint);
    let sum = 0;
    for (let i = 0; i < around.length; i++) sum += jointWeight(skin, neighbours.reps[around[i]], joint);
    return sum / around.length;
  });

  let offsets = layer.get(joint);
  if (!offsets) {
    offsets = new Map();
    layer.set(joint, offsets);
  }
  hit.forEach((v, i) => {
    const now = jointWeight(skin, v, joint);
    const step = (targets[i] - now) * strength * reach[i];
    const base = jointWeight(auto, v, joint);
    // Kept to what can show: auto + offset within 0..1.
    const d = Math.max(-base, Math.min(1 - base, (offsets!.get(v) ?? 0) + step));
    if (Math.abs(d) < NEGLIGIBLE) offsets!.delete(v);
    else offsets!.set(v, d);
  });
  if (offsets.size === 0) layer.delete(joint);
  applyPaintLayer(auto, layer, parents, skin, hit);
  return hit;
}

// ---------------------------------------------------------------------------
// Left / right symmetry

/**
 * Each joint's counterpart across the body's centre plane (x = 0 of the rig):
 * by name where the rig names its joints ("Left Knee" ↔ "Right Knee"), else
 * the joint nearest its mirrored rest position. A joint on the centre line,
 * or with no counterpart close enough, is its own.
 */
export function mirrorJoints(rest: { x: number; y: number; z: number }[], names?: string[]): number[] {
  let extent = 1e-6;
  for (const p of rest) extent = Math.max(extent, Math.abs(p.x), Math.abs(p.y), Math.abs(p.z));
  const tolerance = 0.03 * extent;
  return rest.map((p, i) => {
    const name = names?.[i];
    if (name && /\b(Left|Right)\b/.test(name)) {
      const other = name.replace(/\b(Left|Right)\b/g, (side) => (side === "Left" ? "Right" : "Left"));
      const k = names!.indexOf(other);
      if (k >= 0) return k;
    }
    let best = i;
    let bestD = tolerance;
    rest.forEach((q, k) => {
      const d = Math.hypot(q.x + p.x, q.y - p.y, q.z - p.z);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    return best;
  });
}

/** Vertices by position: each position's mirror across x = 0, and every vertex sitting at each position. */
export interface VertexMirror {
  weldOf: Int32Array;
  /** Per weld, the weld across the plane (itself on it, −1 where none lies close). */
  mirrorOf: Int32Array;
  /** Per weld, its vertices. */
  members: number[][];
}

/**
 * Pairs each vertex with the one across the x = 0 plane, `positions` given in
 * the space whose x = 0 is the centre plane. Vertices at the same position
 * (a seam) go together, so paint copied across reaches all of them. A mesh
 * that is not quite symmetric still pairs, within 1% of its size.
 */
export function mirrorVertices(positions: ArrayLike<number>): VertexMirror {
  const count = Math.floor(positions.length / 3);
  const { weldOf, reps, welds } = weldVertices(positions, count);
  const members: number[][] = Array.from({ length: welds }, () => []);
  for (let v = 0; v < count; v++) members[weldOf[v]].push(v);
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let w = 0; w < welds; w++) {
    const o = reps[w] * 3;
    min = min.map((m, a) => Math.min(m, positions[o + a]));
    max = max.map((m, a) => Math.max(m, positions[o + a]));
  }
  const size = welds > 0 ? Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) : 0;
  const tolerance = Math.max(1e-6, 0.01 * size);
  const cell = (x: number) => Math.floor(x / tolerance);
  const grid = new Map<string, number[]>();
  for (let w = 0; w < welds; w++) {
    const o = reps[w] * 3;
    const key = `${cell(positions[o])},${cell(positions[o + 1])},${cell(positions[o + 2])}`;
    const list = grid.get(key);
    if (list) list.push(w);
    else grid.set(key, [w]);
  }
  const mirrorOf = new Int32Array(welds).fill(-1);
  for (let w = 0; w < welds; w++) {
    const o = reps[w] * 3;
    const x = -positions[o];
    const y = positions[o + 1];
    const z = positions[o + 2];
    let best = -1;
    let bestD = tolerance;
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (let k = -1; k <= 1; k++) {
          for (const u of grid.get(`${cell(x) + i},${cell(y) + j},${cell(z) + k}`) ?? []) {
            const q = reps[u] * 3;
            const d = Math.hypot(positions[q] - x, positions[q + 1] - y, positions[q + 2] - z);
            if (d < bestD) {
              bestD = d;
              best = u;
            }
          }
        }
    mirrorOf[w] = best;
  }
  return { weldOf, mirrorOf, members };
}

/**
 * Copies `joint`'s paint on `vertices` (just painted) across the centre
 * plane: onto `jointMirror[joint]`, at the mirrored vertices. Returns the
 * vertices it wrote, for the caller to apply.
 */
export function mirrorPaint(layer: PaintLayer, joint: number, vertices: number[], mirror: VertexMirror, jointMirror: number[]): number[] {
  const other = jointMirror[joint] ?? joint;
  const source = layer.get(joint);
  // Read first: across the centre the same joint may be both written and read.
  const copies: [number, number | undefined][] = [];
  for (const v of vertices) {
    const w = mirror.mirrorOf[mirror.weldOf[v]];
    if (w < 0) continue;
    const d = source?.get(v);
    for (const m of mirror.members[w]) if (m !== v || other !== joint) copies.push([m, d]);
  }
  if (copies.length === 0) return [];
  let target = layer.get(other);
  if (!target) {
    target = new Map();
    layer.set(other, target);
  }
  for (const [m, d] of copies) {
    if (d === undefined) target.delete(m);
    else target.set(m, d);
  }
  if (target.size === 0) layer.delete(other);
  return [...new Set(copies.map(([m]) => m))];
}

/**
 * Automatic weights made symmetric: every vertex on one side of the centre
 * plane takes the weights of its counterpart on the other, each joint swapped
 * for its own counterpart ("Left Knee" → "Right Knee"). `positions` are the
 * vertices in the rig's own space (x = 0 its centre plane); `from` is the side
 * copied, the character's left being +x. Vertices on the plane, or with no
 * counterpart, keep their own. Writes `skin` in place.
 */
export function mirrorSkinWeights(skin: SkinWeights, positions: ArrayLike<number>, mirror: VertexMirror, jointMirror: number[], from: "left" | "right"): void {
  const n = skin.influences;
  const count = Math.min(Math.floor(positions.length / 3), skin.indices.length / n);
  const sign = from === "left" ? 1 : -1;
  const slack = 1e-6;
  for (let v = 0; v < count; v++) {
    // Only the side being written: strictly across the plane from the side copied.
    if (positions[v * 3] * sign >= -slack) continue;
    const w = mirror.mirrorOf[mirror.weldOf[v]];
    if (w < 0) continue;
    const m = mirror.members[w][0];
    if (m === v) continue;
    for (let k = 0; k < n; k++) {
      skin.indices[v * n + k] = jointMirror[skin.indices[m * n + k]] ?? skin.indices[m * n + k];
      skin.weights[v * n + k] = skin.weights[m * n + k];
    }
  }
}
