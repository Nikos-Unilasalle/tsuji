import type { PolyMesh } from "../quadMesh";
import { domainEdges, type AttrDomain } from "./polyAttributes";
import { getTopology } from "./topology";

/*
 * Moving selections and values between domains (Houdini's Group Promote and
 * Attribute Promote, Blender's implicit domain interpolation).
 *
 * Masks (0/1) use a rule:
 *  - "any": the element is in when any of its related elements is;
 *  - "all": only when all of them are.
 * The default rule depends on the direction and matches Blender: going *up*
 * (point → edge → face) a face is selected when all its points are; going
 * *down* (face → point) a point is selected when any face around it is.
 *
 * Values average (or min / max / sum) over the related elements.
 */

export type PromoteRule = "any" | "all";
export type PromoteReduce = "average" | "min" | "max" | "sum" | "first";

const RANK: Record<AttrDomain, number> = { point: 0, edge: 1, corner: 1, face: 2 };

export function defaultPromoteRule(from: AttrDomain, to: AttrDomain): PromoteRule {
  return RANK[to] > RANK[from] ? "all" : "any";
}

/**
 * For each element of `to`, the elements of `from` it relates to. Built per
 * (mesh, from, to) and cached: promoting is common in group expressions.
 */
const relationCache = new WeakMap<PolyMesh, Map<string, number[][]>>();

export function domainRelations(mesh: PolyMesh, from: AttrDomain, to: AttrDomain): number[][] {
  let cache = relationCache.get(mesh);
  const key = `${from}>${to}`;
  const hit = cache?.get(key);
  if (hit) return hit;
  const rel = buildRelations(mesh, from, to);
  if (!cache) {
    cache = new Map();
    relationCache.set(mesh, cache);
  }
  cache.set(key, rel);
  return rel;
}

function buildRelations(mesh: PolyMesh, from: AttrDomain, to: AttrDomain): number[][] {
  if (from === to) return identity(countOf(mesh, to));

  // Everything goes through points as the common denominator, except the
  // direct face<->corner and face<->edge relations, which are exact.
  if (to === "point") {
    const out: number[][] = Array.from({ length: mesh.positions.length }, () => []);
    if (from === "face") mesh.faces.forEach((face, f) => face.forEach((v) => out[v].push(f)));
    else if (from === "edge") domainEdges(mesh).forEach(([a, b], e) => (out[a].push(e), out[b].push(e)));
    else if (from === "corner") {
      let c = 0;
      mesh.faces.forEach((face) => face.forEach((v) => out[v].push(c++)));
    }
    return out;
  }
  if (from === "point") {
    if (to === "face") return mesh.faces.map((face) => [...face]);
    if (to === "edge") return domainEdges(mesh).map(([a, b]) => [a, b]);
    if (to === "corner") return mesh.faces.flatMap((face) => face.map((v) => [v]));
  }
  if (from === "corner" && to === "face") {
    let c = 0;
    return mesh.faces.map((face) => face.map(() => c++));
  }
  if (from === "face" && to === "corner") return mesh.faces.flatMap((face, f) => face.map(() => [f]));
  if (from === "edge" && to === "face") {
    const topology = getTopology(mesh);
    const edgeIndex = edgeIndexMap(mesh);
    return mesh.faces.map((face) => {
      const out: number[] = [];
      for (let i = 0; i < face.length; i++) {
        const a = face[i];
        const b = face[(i + 1) % face.length];
        const e = edgeIndex.get(a < b ? a * 0x100000000 + b : b * 0x100000000 + a);
        if (e !== undefined) out.push(e);
      }
      void topology;
      return out;
    });
  }
  if (from === "face" && to === "edge") {
    const topology = getTopology(mesh);
    return domainEdges(mesh).map(([a, b]) => topology.edgeFaces(a, b));
  }
  if (from === "corner" && to === "edge") {
    // corner -> point -> edge
    const viaPoint = domainRelations(mesh, "corner", "point");
    return domainEdges(mesh).map(([a, b]) => [...viaPoint[a], ...viaPoint[b]]);
  }
  if (from === "edge" && to === "corner") {
    // edge -> corner: the edges leaving each corner's vertex inside its face
    const edgeIndex = edgeIndexMap(mesh);
    return mesh.faces.flatMap((face) =>
      face.map((v, i) => {
        const out: number[] = [];
        for (const w of [face[(i + 1) % face.length], face[(i + face.length - 1) % face.length]]) {
          const e = edgeIndex.get(v < w ? v * 0x100000000 + w : w * 0x100000000 + v);
          if (e !== undefined) out.push(e);
        }
        return out;
      }),
    );
  }
  return identity(countOf(mesh, to));
}

function edgeIndexMap(mesh: PolyMesh): Map<number, number> {
  const map = new Map<number, number>();
  domainEdges(mesh).forEach(([a, b], e) => map.set(a * 0x100000000 + b, e));
  return map;
}

function identity(n: number): number[][] {
  return Array.from({ length: n }, (_, i) => [i]);
}

function countOf(mesh: PolyMesh, domain: AttrDomain): number {
  if (domain === "point") return mesh.positions.length;
  if (domain === "face") return mesh.faces.length;
  if (domain === "edge") return domainEdges(mesh).length;
  let n = 0;
  for (const f of mesh.faces) n += f.length;
  return n;
}

/** A 0/1 mask on `from` as a mask on `to`. */
export function promoteMask(
  mesh: PolyMesh,
  from: AttrDomain,
  to: AttrDomain,
  mask: ArrayLike<number>,
  rule: PromoteRule = defaultPromoteRule(from, to),
): Uint8Array {
  if (from === to) return Uint8Array.from(mask as ArrayLike<number>, (v) => (v ? 1 : 0));
  const rel = domainRelations(mesh, from, to);
  const out = new Uint8Array(rel.length);
  rel.forEach((list, i) => {
    if (list.length === 0) return;
    if (rule === "any") out[i] = list.some((j) => mask[j]) ? 1 : 0;
    else out[i] = list.every((j) => mask[j]) ? 1 : 0;
  });
  return out;
}

/** Values (`size` per element) on `from`, reduced onto `to`. */
export function promoteValues(
  mesh: PolyMesh,
  from: AttrDomain,
  to: AttrDomain,
  values: ArrayLike<number>,
  size: number,
  reduce: PromoteReduce = "average",
): Float64Array {
  const rel = domainRelations(mesh, from, to);
  const out = new Float64Array(rel.length * size);
  rel.forEach((list, i) => {
    if (list.length === 0) return;
    for (let c = 0; c < size; c++) {
      let acc = reduce === "min" ? Infinity : reduce === "max" ? -Infinity : 0;
      for (const j of list) {
        const v = values[j * size + c] ?? 0;
        if (reduce === "min") acc = Math.min(acc, v);
        else if (reduce === "max") acc = Math.max(acc, v);
        else acc += v;
        if (reduce === "first") break;
      }
      out[i * size + c] = reduce === "average" ? acc / list.length : acc;
    }
  });
  return out;
}
