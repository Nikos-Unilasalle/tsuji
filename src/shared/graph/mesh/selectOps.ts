import type { PolyMesh } from "../quadMesh";
import { domainEdges, faceNormals, readAttribute, type AttrDomain } from "./polyAttributes";
import { triangulateFace } from "./triangulate";
import { PointTree, closestPointOnTriangle } from "./spatial";
import { getTopology } from "./topology";
import { promoteMask } from "./promote";
import type { MeshSelection, SelectMode } from "./selection";

/*
 * The geometry behind the Select nodes, kept free of THREE and of the node
 * system so it can be tested (and reused by Attribute and modelling nodes):
 * where every element is, which side of a surface a point is on, how far
 * along the surface two points are, random masks that don't reshuffle when
 * the percentage changes.
 */

type V3 = readonly [number, number, number] | readonly number[];

/** Representative position per element, 3 numbers each: point, edge midpoint, face centroid, corner's point. */
export function elementPositions(mesh: PolyMesh, domain: AttrDomain): Float64Array {
  if (domain === "point") return readAttribute(mesh, "point", "P")!.values;
  if (domain === "face") return readAttribute(mesh, "face", "P")!.values;
  if (domain === "edge") {
    const edges = domainEdges(mesh);
    const out = new Float64Array(edges.length * 3);
    edges.forEach(([a, b], i) => {
      const p = mesh.positions[a], q = mesh.positions[b];
      out[i * 3] = (p[0] + q[0]) / 2;
      out[i * 3 + 1] = (p[1] + q[1]) / 2;
      out[i * 3 + 2] = (p[2] + q[2]) / 2;
    });
    return out;
  }
  const out: number[] = [];
  for (const face of mesh.faces) for (const v of face) out.push(...mesh.positions[v]);
  return Float64Array.from(out);
}

/** Representative unit normal per element. */
export function elementNormals(mesh: PolyMesh, domain: AttrDomain): Float64Array {
  if (domain === "face") return faceNormals(mesh);
  const pointN = readAttribute(mesh, "point", "N")!.values;
  if (domain === "point") return pointN;
  if (domain === "corner") {
    const fn = faceNormals(mesh);
    const out: number[] = [];
    mesh.faces.forEach((face, f) => face.forEach(() => out.push(fn[f * 3], fn[f * 3 + 1], fn[f * 3 + 2])));
    return Float64Array.from(out);
  }
  const edges = domainEdges(mesh);
  const out = new Float64Array(edges.length * 3);
  edges.forEach(([a, b], i) => {
    let x = pointN[a * 3] + pointN[b * 3], y = pointN[a * 3 + 1] + pointN[b * 3 + 1], z = pointN[a * 3 + 2] + pointN[b * 3 + 2];
    const l = Math.hypot(x, y, z) || 1;
    out[i * 3] = x / l;
    out[i * 3 + 1] = y / l;
    out[i * 3 + 2] = z / l;
  });
  return out;
}

/** Stable hash → [0, 1). The same element keeps its number whatever the percentage. */
export function hash01(i: number, seed: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.round(seed * 1000) | 0, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Each element in with probability `fraction`; raising the fraction only adds elements. */
export function randomMask(count: number, fraction: number, seed: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = hash01(i, seed) < fraction ? 1 : 0;
  return out;
}

// ---------------------------------------------------------------- triangles

/** Every face triangulated, 9 numbers per triangle, and the face each came from. */
export function meshTriangles(mesh: PolyMesh): { coords: Float64Array; faceOf: Int32Array } {
  const coords: number[] = [];
  const faceOf: number[] = [];
  mesh.faces.forEach((face, f) => {
    for (const [a, b, c] of triangulateFace(mesh.positions, face)) {
      coords.push(...mesh.positions[face[a]], ...mesh.positions[face[b]], ...mesh.positions[face[c]]);
      faceOf.push(f);
    }
  });
  return { coords: Float64Array.from(coords), faceOf: Int32Array.from(faceOf) };
}

/**
 * Inside test by generalised winding number (Jacobson et al. 2013): the sum
 * of the solid angles the triangles subtend, over 4π. Robust to small holes
 * and self-intersections, unlike ray parity, which a single gap flips.
 */
export function makeInsideTest(target: PolyMesh): (x: number, y: number, z: number) => boolean {
  const { coords } = meshTriangles(target);
  const n = coords.length / 9;
  return (x, y, z) => {
    let total = 0;
    for (let t = 0; t < n; t++) {
      const o = t * 9;
      const ax = coords[o] - x, ay = coords[o + 1] - y, az = coords[o + 2] - z;
      const bx = coords[o + 3] - x, by = coords[o + 4] - y, bz = coords[o + 5] - z;
      const cx = coords[o + 6] - x, cy = coords[o + 7] - y, cz = coords[o + 8] - z;
      const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz), lc = Math.hypot(cx, cy, cz);
      const det = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
      const div = la * lb * lc + (ax * bx + ay * by + az * bz) * lc + (bx * cx + by * cy + bz * cz) * la + (cx * ax + cy * ay + cz * az) * lb;
      total += 2 * Math.atan2(det, div);
    }
    return total / (4 * Math.PI) > 0.5;
  };
}

/**
 * Closest point on a mesh's surface. Candidate triangles come from a tree of
 * triangle centroids (the nearest few dozen), each tested exactly; for
 * meshes with long thin triangles a larger candidate count is used.
 */
export function makeClosestPoint(target: PolyMesh): (x: number, y: number, z: number) => { point: [number, number, number]; distance: number; face: number; normal: [number, number, number] } | null {
  const { coords, faceOf } = meshTriangles(target);
  const n = coords.length / 9;
  if (n === 0) return () => null;
  const centroids = new Float64Array(n * 3);
  let maxEdge = 0;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    for (let k = 0; k < 3; k++) centroids[t * 3 + k] = (coords[o + k] + coords[o + 3 + k] + coords[o + 6 + k]) / 3;
    maxEdge = Math.max(
      maxEdge,
      Math.hypot(coords[o] - coords[o + 3], coords[o + 1] - coords[o + 4], coords[o + 2] - coords[o + 5]),
      Math.hypot(coords[o] - coords[o + 6], coords[o + 1] - coords[o + 7], coords[o + 2] - coords[o + 8]),
    );
  }
  const tree = new PointTree(centroids);
  const fn = faceNormals(target);
  const tri = (t: number) => {
    const o = t * 9;
    return [
      [coords[o], coords[o + 1], coords[o + 2]],
      [coords[o + 3], coords[o + 4], coords[o + 5]],
      [coords[o + 6], coords[o + 7], coords[o + 8]],
    ] as const;
  };
  return (x, y, z) => {
    // Any triangle containing a point closer than d has its centroid within
    // d + maxEdge: search that radius around the best candidate so far.
    const first = tree.nearest(x, y, z);
    let best = -1;
    let bestD = Infinity;
    let bestP: [number, number, number] = [0, 0, 0];
    const test = (t: number) => {
      const [a, b, c] = tri(t);
      const r = closestPointOnTriangle([x, y, z], a, b, c);
      const d = Math.hypot(r.point[0] - x, r.point[1] - y, r.point[2] - z);
      if (d < bestD) {
        bestD = d;
        best = t;
        bestP = r.point;
      }
    };
    test(first.index);
    for (const t of tree.within(x, y, z, bestD + maxEdge)) test(t);
    const f = faceOf[best];
    return { point: bestP, distance: bestD, face: f, normal: [fn[f * 3], fn[f * 3 + 1], fn[f * 3 + 2]] };
  };
}

// ---------------------------------------------------------------- graph walks

/** Undirected point adjacency through face edges and loose edges. */
export function pointNeighbours(mesh: PolyMesh): number[][] {
  const out: number[][] = Array.from({ length: mesh.positions.length }, () => []);
  for (const [a, b] of domainEdges(mesh)) {
    out[a].push(b);
    out[b].push(a);
  }
  return out;
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(key: number, val: number) {
    const k = this.keys, v = this.vals;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): [number, number] {
    const k = this.keys, v = this.vals;
    const topK = k[0], topV = v[0];
    const lastK = k.pop()!, lastV = v.pop()!;
    if (k.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        let mk = lastK;
        if (l < k.length && k[l] < mk) (m = l), (mk = k[l]);
        if (r < k.length && k[r] < mk) (m = r), (mk = k[r]);
        if (m === i) break;
        k[i] = k[m];
        v[i] = v[m];
        i = m;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return [topK, topV];
  }
}

/**
 * Distance from the nearest seed point, measured along the mesh's edges
 * (Dijkstra). Infinity where unreachable or beyond `maxDistance`. A cheap,
 * good-enough geodesic on even meshes; the heat method (phase 9) refines it.
 */
export function edgeDistances(mesh: PolyMesh, seeds: Iterable<number>, maxDistance = Infinity): { dist: Float64Array; prev: Int32Array } {
  const n = mesh.positions.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const nb = pointNeighbours(mesh);
  const heap = new MinHeap();
  for (const s of seeds) {
    if (s < 0 || s >= n) continue;
    dist[s] = 0;
    heap.push(0, s);
  }
  while (heap.size) {
    const [d, v] = heap.pop();
    if (d > dist[v] || d > maxDistance) continue;
    const p = mesh.positions[v];
    for (const w of nb[v]) {
      const q = mesh.positions[w];
      const nd = d + Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      if (nd < dist[w] && nd <= maxDistance) {
        dist[w] = nd;
        prev[w] = v;
        heap.push(nd, w);
      }
    }
  }
  return { dist, prev };
}

/** Shortest edge path from any point of `from` to any point of `to`, as a point list (empty if none). */
export function shortestPath(mesh: PolyMesh, from: Iterable<number>, to: Iterable<number>): number[] {
  const { dist, prev } = edgeDistances(mesh, from);
  let end = -1;
  let best = Infinity;
  for (const t of to) if (dist[t] < best) (best = dist[t]), (end = t);
  if (end < 0) return [];
  const path: number[] = [];
  for (let v = end; v >= 0; v = prev[v]) path.push(v);
  return path.reverse();
}

/** Edge mask (domain order) for consecutive point pairs of a path. */
export function pathEdgeMask(mesh: PolyMesh, paths: number[][]): Uint8Array {
  const edges = domainEdges(mesh);
  const index = new Map<string, number>();
  edges.forEach(([a, b], i) => index.set(`${a}_${b}`, i));
  const mask = new Uint8Array(edges.length);
  for (const path of paths) {
    for (let i = 1; i < path.length; i++) {
      const a = Math.min(path[i - 1], path[i]), b = Math.max(path[i - 1], path[i]);
      const e = index.get(`${a}_${b}`);
      if (e !== undefined) mask[e] = 1;
    }
  }
  return mask;
}

// ---------------------------------------------------------------- domain <-> legacy selection

export function modeOf(domain: AttrDomain): SelectMode {
  return domain === "point" ? "points" : domain === "edge" ? "edges" : "faces";
}

/** A mask on a domain as Edit Mesh's MeshSelection (corners go through faces). */
export function maskToSelection(mesh: PolyMesh, domain: AttrDomain, mask: ArrayLike<number>): MeshSelection {
  const sel: MeshSelection = { points: [], edges: [], faces: [] };
  if (domain === "point") for (let i = 0; i < mask.length; i++) mask[i] && sel.points.push(i);
  else if (domain === "edge") {
    domainEdges(mesh).forEach(([a, b], i) => mask[i] && sel.edges.push([a, b]));
  } else {
    const faceMask = domain === "corner" ? promoteMask(mesh, "corner", "face", mask) : mask;
    for (let i = 0; i < faceMask.length; i++) faceMask[i] && sel.faces.push(i);
  }
  return sel;
}

export function selectionToMask(mesh: PolyMesh, domain: AttrDomain, sel: MeshSelection): Uint8Array {
  if (domain === "point") {
    const m = new Uint8Array(mesh.positions.length);
    for (const v of sel.points) if (v >= 0 && v < m.length) m[v] = 1;
    return m;
  }
  if (domain === "edge") {
    const set = new Set(sel.edges.map(([a, b]) => (a < b ? `${a}_${b}` : `${b}_${a}`)));
    return Uint8Array.from(domainEdges(mesh), ([a, b]) => (set.has(`${a}_${b}`) ? 1 : 0));
  }
  const faceMask = new Uint8Array(mesh.faces.length);
  for (const f of sel.faces) if (f >= 0 && f < faceMask.length) faceMask[f] = 1;
  return domain === "corner" ? promoteMask(mesh, "face", "corner", faceMask) : faceMask;
}

/** Valence (edge count) of every point. */
export function pointValence(mesh: PolyMesh): Int32Array {
  const out = new Int32Array(mesh.positions.length);
  for (const [a, b] of domainEdges(mesh)) {
    out[a]++;
    out[b]++;
  }
  return out;
}

/** Edges used by 3+ faces, or whose two faces disagree on winding. */
export function nonManifoldEdgeMask(mesh: PolyMesh): Uint8Array {
  const topo = getTopology(mesh);
  const edges = domainEdges(mesh);
  return Uint8Array.from(edges, ([a, b]) => {
    const faces = topo.edgeFaces(a, b);
    if (faces.length > 2) return 1;
    if (faces.length === 2 && (topo.findHalfedge(a, b) < 0 || topo.findHalfedge(b, a) < 0)) return 1;
    return 0;
  });
}

/** Distance helper. */
export function distance(a: V3, b: V3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
