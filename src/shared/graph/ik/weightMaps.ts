import { SkinWeights } from "./skinning";
import { VertexMirror } from "./weightPaint";

/**
 * Weight maps: a Skin's weights painted on the surface, one grayscale map per
 * joint (and per mesh, when the Skin binds several), white the vertex
 * following the joint entirely, black not at all.
 *
 * A joint's map starts as its weights at the moment one begins painting it,
 * so what is shown is what the mesh does. Painting changes nothing until
 * Compute reads every map under each vertex's UV into a target per vertex,
 * stored compactly (a byte per vertex, base64) in `weightTargets`.
 *
 * Applying the targets, a painted joint takes its value; the joints left
 * unpainted share what remains, in the proportions of their own weights.
 * Painted values adding up past 1 are scaled down to 1; a remainder nothing
 * unpainted can take goes to the parent of the painted joint that lost the
 * most (a root's, to its first child).
 */

/** Joint -> one byte per vertex, 0..255 for weight 0..1. */
export type WeightTargets = Map<number, Uint8Array>;

export interface StoredTarget {
  /** Vertex count Compute read the map for: on a mesh of another size the target is dropped, not misplaced. */
  vertices: number;
  /** One byte per vertex, base64. */
  data: string;
}

/** `weightTargets` and `weightMaps` are keyed by mesh and joint. */
export const mapKey = (mesh: number, joint: number) => `${mesh}:${joint}`;

export function parseMapKey(key: string): { mesh: number; joint: number } | null {
  const match = /^(\d+):(\d+)$/.exec(key);
  return match ? { mesh: Number(match[1]), joint: Number(match[2]) } : null;
}

export function encodeBytes(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function decodeBytes(data: string): Uint8Array {
  const text = atob(data);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

export function toBytes(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Math.round(Math.max(0, Math.min(1, values[i])) * 255);
  return out;
}

/** The targets stored for `mesh`, those made on another vertex count left out. */
export function readTargets(raw: unknown, mesh: number, vertexCount: number): WeightTargets {
  const out: WeightTargets = new Map();
  if (!raw || typeof raw !== "object") return out;
  for (const [key, entry] of Object.entries(raw as Record<string, StoredTarget>)) {
    const at = parseMapKey(key);
    if (!at || at.mesh !== mesh || !entry || entry.vertices !== vertexCount || typeof entry.data !== "string") continue;
    try {
      const bytes = decodeBytes(entry.data);
      if (bytes.length === vertexCount) out.set(at.joint, bytes);
    } catch {
      // A damaged entry is no paint.
    }
  }
  return out;
}

export function storeTarget(bytes: Uint8Array): StoredTarget {
  return { vertices: bytes.length, data: encodeBytes(bytes) };
}

/** Where a joint's weight goes when nothing else can take it. */
function heirOf(joint: number, parents: number[]): number {
  if (parents[joint] >= 0) return parents[joint];
  return parents.indexOf(joint);
}

/** Writes into `into` the weights `base` gets with `targets` applied. With no targets, `base` as it is. */
export function applyWeightTargets(base: SkinWeights, targets: WeightTargets, parents: number[], into: SkinWeights): void {
  const n = base.influences;
  into.indices.set(base.indices);
  into.weights.set(base.weights);
  if (targets.size === 0) return;
  const painted = [...targets.keys()];
  const vertexCount = base.indices.length / n;
  const share = new Map<number, number>();
  for (let v = 0; v < vertexCount; v++) {
    const o = v * n;
    share.clear();
    for (let k = 0; k < n; k++) {
      const w = base.weights[o + k];
      if (w > 0) share.set(base.indices[o + k], (share.get(base.indices[o + k]) ?? 0) + w);
    }
    let paintedSum = 0;
    let lost = 0;
    let loser = -1;
    for (const j of painted) {
      const t = targets.get(j)![v] / 255;
      const drop = (share.get(j) ?? 0) - t;
      if (drop > lost) {
        lost = drop;
        loser = j;
      }
      paintedSum += t;
    }
    let others = 0;
    for (const [j, w] of share) if (!targets.has(j)) others += w;

    const out = new Map<number, number>();
    if (paintedSum >= 1) {
      for (const j of painted) out.set(j, targets.get(j)![v] / 255 / paintedSum);
    } else if (others > 1e-6) {
      for (const j of painted) out.set(j, targets.get(j)![v] / 255);
      const scale = (1 - paintedSum) / others;
      for (const [j, w] of share) if (!targets.has(j)) out.set(j, w * scale);
    } else {
      for (const j of painted) out.set(j, targets.get(j)![v] / 255);
      const heir = loser >= 0 ? heirOf(loser, parents) : -1;
      if (heir >= 0) out.set(heir, (out.get(heir) ?? 0) + 1 - paintedSum);
    }

    const kept = [...out].filter(([, w]) => w > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, n);
    const total = kept.reduce((sum, [, w]) => sum + w, 0);
    if (total <= 0) continue;
    for (let k = 0; k < n; k++) {
      into.indices[o + k] = k < kept.length ? kept[k][0] : 0;
      into.weights[o + k] = k < kept.length ? kept[k][1] / total : 0;
    }
  }
}

/**
 * L → R (from "left") or R → L: one side of every painted joint copied onto
 * the other, mirrored. `positions` are the bind-pose vertices in the rig's
 * own space (x = 0 its centre plane, the character's left at +x).
 *
 * A vertex across the plane from the side copied takes, for joint j, the
 * value its counterpart has for j's own counterpart ("Left Knee" ↔ "Right
 * Knee"); vertices on the copied side, on the plane or without a counterpart
 * keep theirs. `current(joint, vertex)` gives a joint's weight where it has
 * no map, so a counterpart that was never painted mirrors as it stands.
 * Returns the new targets of every joint that has or gains one.
 */
export function mirrorTargets(
  targets: WeightTargets,
  current: (joint: number, vertex: number) => number,
  positions: ArrayLike<number>,
  mirror: VertexMirror,
  jointMirror: number[],
  from: "left" | "right",
): WeightTargets {
  const vertexCount = Math.floor(positions.length / 3);
  const value = (joint: number, v: number) => {
    const bytes = targets.get(joint);
    return bytes ? bytes[v] : Math.round(Math.max(0, Math.min(1, current(joint, v))) * 255);
  };
  const joints = new Set<number>();
  for (const j of targets.keys()) {
    joints.add(j);
    joints.add(jointMirror[j] ?? j);
  }
  const sign = from === "left" ? 1 : -1;
  const slack = 1e-6;
  const out: WeightTargets = new Map();
  for (const j of joints) {
    const bytes = new Uint8Array(vertexCount);
    const other = jointMirror[j] ?? j;
    for (let v = 0; v < vertexCount; v++) {
      bytes[v] = value(j, v);
      if (positions[v * 3] * sign >= -slack) continue;
      const w = mirror.mirrorOf[mirror.weldOf[v]];
      if (w < 0) continue;
      const m = mirror.members[w][0];
      if (m !== v) bytes[v] = value(other, m);
    }
    out.set(j, bytes);
  }
  return out;
}
