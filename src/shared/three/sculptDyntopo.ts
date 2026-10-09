import * as THREE from "three";
import { SculptMeshData, computeVertexNormals } from "./sculptMesh";

/** Edges longer than `SPLIT_RATIO × detail` get split; halves of that stay above half the target, so a split never immediately wants merging back. */
const SPLIT_RATIO = 4 / 3;
/** Rounds of "split everything too long" per call — enough for a 2^MAX_ROUNDS refinement of a coarse base mesh under one hit, so the brush never grabs triangles much bigger than itself. */
const MAX_ROUNDS = 8;
const FLIP_SWEEPS = 3;
/** Hard ceiling so a tiny Detail on a huge brush can't freeze the tab. */
const MAX_TRIANGLES = 400_000;
/** Packs an undirected edge into one number — an order of magnitude faster than string keys on large meshes. */
const KEY_STRIDE = 67108864; // 2^26 vertices

function key(a: number, b: number): number {
  return a < b ? a * KEY_STRIDE + b : b * KEY_STRIDE + a;
}
function keyLo(k: number): number {
  return Math.floor(k / KEY_STRIDE);
}
function keyHi(k: number): number {
  return k % KEY_STRIDE;
}

function edgeLength(p: number[], a: number, b: number): number {
  return Math.hypot(p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]);
}

function buildEdgeMap(tris: number[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (let t = 0; t < tris.length; t += 3) {
    const tri = t / 3;
    for (let e = 0; e < 3; e++) {
      const k = key(tris[t + e], tris[t + ((e + 1) % 3)]);
      const list = map.get(k);
      if (list) list.push(tri);
      else map.set(k, [tri]);
    }
  }
  return map;
}

function nearBrush(p: number[], a: number, b: number, hit: THREE.Vector3, radius: number): boolean {
  const mx = (p[a * 3] + p[b * 3]) * 0.5 - hit.x;
  const my = (p[a * 3 + 1] + p[b * 3 + 1]) * 0.5 - hit.y;
  const mz = (p[a * 3 + 2] + p[b * 3 + 2]) * 0.5 - hit.z;
  return mx * mx + my * my + mz * mz < radius * radius;
}

/**
 * One round of crack-free edge splitting. Returns whether anything was split.
 *
 * Marked edges propagate with the longest-edge rule (Rivara bisection): a
 * triangle with any marked edge also splits its *longest* edge. That is what
 * keeps the children well shaped — the earlier red-green pattern split a lone edge of
 * a triangle regardless of its proportions, and the sliver triangles that
 * produced were what made a single stroke look stretched. The chain always
 * terminates (each hop moves to a strictly longer edge).
 */
function splitRound(
  positions: number[],
  tris: number[],
  mask: number[] | null,
  hit: THREE.Vector3,
  radius: number,
  splitLength: number,
): boolean {
  const edgeMap = buildEdgeMap(tris);
  const marked = new Set<number>();
  const stack: number[] = [];

  for (const k of edgeMap.keys()) {
    const a = keyLo(k);
    const b = keyHi(k);
    if (edgeLength(positions, a, b) <= splitLength) continue;
    if (!nearBrush(positions, a, b, hit, radius)) continue;
    marked.add(k);
    stack.push(k);
  }
  if (marked.size === 0) return false;

  while (stack.length > 0) {
    const k = stack.pop() as number;
    for (const tri of edgeMap.get(k) ?? []) {
      const a = tris[tri * 3];
      const b = tris[tri * 3 + 1];
      const c = tris[tri * 3 + 2];
      const edges = [key(a, b), key(b, c), key(c, a)];
      const lens = [edgeLength(positions, a, b), edgeLength(positions, b, c), edgeLength(positions, c, a)];
      let longest = 0;
      for (let i = 1; i < 3; i++) if (lens[i] > lens[longest]) longest = i;
      const e = edges[longest];
      if (!marked.has(e)) {
        marked.add(e);
        stack.push(e);
      }
    }
  }

  if (tris.length / 3 + marked.size * 2 > MAX_TRIANGLES) return false;

  const midpoint = new Map<number, number>();
  for (const k of marked) {
    const a = keyLo(k);
    const b = keyHi(k);
    // Plain midpoint, deliberately: no snapping to a sphere. It keeps a cube
    // flat and a sculpted shape where the artist left it; the next brush
    // dab, not the remesher, decides the surface.
    const idx = positions.length / 3;
    positions.push(
      (positions[a * 3] + positions[b * 3]) * 0.5,
      (positions[a * 3 + 1] + positions[b * 3 + 1]) * 0.5,
      (positions[a * 3 + 2] + positions[b * 3 + 2]) * 0.5,
    );
    if (mask) mask.push((mask[a] + mask[b]) * 0.5);
    midpoint.set(k, idx);
  }

  const next: number[] = [];
  const push = (a: number, b: number, c: number) => next.push(a, b, c);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t];
    const b = tris[t + 1];
    const c = tris[t + 2];
    const m01 = midpoint.get(key(a, b));
    const m12 = midpoint.get(key(b, c));
    const m20 = midpoint.get(key(c, a));
    const pattern = (m01 !== undefined ? 1 : 0) | (m12 !== undefined ? 2 : 0) | (m20 !== undefined ? 4 : 0);
    switch (pattern) {
      case 0:
        push(a, b, c);
        break;
      case 1:
        push(a, m01 as number, c);
        push(m01 as number, b, c);
        break;
      case 2:
        push(a, b, m12 as number);
        push(a, m12 as number, c);
        break;
      case 4:
        push(a, b, m20 as number);
        push(b, c, m20 as number);
        break;
      case 3:
        // a-b and b-c: cut the corner at b, then the remaining quad along its shorter diagonal.
        push(m01 as number, b, m12 as number);
        if (edgeLength(positions, a, m12 as number) < edgeLength(positions, m01 as number, c)) {
          push(a, m01 as number, m12 as number);
          push(a, m12 as number, c);
        } else {
          push(a, m01 as number, c);
          push(m01 as number, m12 as number, c);
        }
        break;
      case 6:
        push(m12 as number, c, m20 as number);
        if (edgeLength(positions, a, m12 as number) < edgeLength(positions, b, m20 as number)) {
          push(a, b, m12 as number);
          push(a, m12 as number, m20 as number);
        } else {
          push(a, b, m20 as number);
          push(b, m12 as number, m20 as number);
        }
        break;
      case 5:
        push(m20 as number, a, m01 as number);
        if (edgeLength(positions, b, m20 as number) < edgeLength(positions, m01 as number, c)) {
          push(m01 as number, b, m20 as number);
          push(b, c, m20 as number);
        } else {
          push(m01 as number, b, c);
          push(m01 as number, c, m20 as number);
        }
        break;
      case 7:
        push(a, m01 as number, m20 as number);
        push(b, m12 as number, m01 as number);
        push(c, m20 as number, m12 as number);
        push(m01 as number, m12 as number, m20 as number);
        break;
    }
  }
  tris.length = 0;
  for (let i = 0; i < next.length; i++) tris.push(next[i]);
  return true;
}

function triNormal(p: number[], a: number, b: number, c: number, out: THREE.Vector3): THREE.Vector3 {
  const ux = p[b * 3] - p[a * 3];
  const uy = p[b * 3 + 1] - p[a * 3 + 1];
  const uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3];
  const vy = p[c * 3 + 1] - p[a * 3 + 1];
  const vz = p[c * 3 + 2] - p[a * 3 + 2];
  return out.set(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

/**
 * Flips interior edges to their shorter diagonal. After a split the surface
 * is full of long thin quads cut the wrong way; this is the pass that turns
 * them back into near-equilateral triangles. A flip is refused when it would
 * fold the surface (new face normals disagreeing with the old ones), duplicate
 * an existing edge, or leave a vertex with fewer than 3 neighbors.
 */
function flipPass(positions: number[], tris: number[], hit: THREE.Vector3, radius: number): void {
  const n0 = new THREE.Vector3();
  const n1 = new THREE.Vector3();
  const m0 = new THREE.Vector3();
  const m1 = new THREE.Vector3();

  for (let sweep = 0; sweep < FLIP_SWEEPS; sweep++) {
    const edgeMap = buildEdgeMap(tris);
    const valence = new Map<number, number>();
    for (const k of edgeMap.keys()) {
      valence.set(keyLo(k), (valence.get(keyLo(k)) ?? 0) + 1);
      valence.set(keyHi(k), (valence.get(keyHi(k)) ?? 0) + 1);
    }
    const touched = new Set<number>();
    let flips = 0;

    for (const [k, owners] of edgeMap) {
      if (owners.length !== 2) continue;
      const [t0, t1] = owners;
      if (touched.has(t0) || touched.has(t1)) continue;
      const a0 = keyLo(k);
      const b0 = keyHi(k);
      if (!nearBrush(positions, a0, b0, hit, radius)) continue;

      // Orient so tri0 reads (a, b, c) and tri1 reads (b, a, d).
      let a = -1;
      let b = -1;
      let c = -1;
      for (let e = 0; e < 3; e++) {
        const u = tris[t0 * 3 + e];
        const v = tris[t0 * 3 + ((e + 1) % 3)];
        if (key(u, v) === k) {
          a = u;
          b = v;
          c = tris[t0 * 3 + ((e + 2) % 3)];
          break;
        }
      }
      let d = -1;
      for (let e = 0; e < 3; e++) {
        const v = tris[t1 * 3 + e];
        if (v !== a && v !== b) d = v;
      }
      if (a < 0 || d < 0 || c === d) continue;
      if ((valence.get(a) ?? 0) <= 3 || (valence.get(b) ?? 0) <= 3) continue;
      if (edgeMap.has(key(c, d))) continue;
      if (edgeLength(positions, c, d) >= edgeLength(positions, a, b) * 0.95) continue;

      // New faces (a, d, c) and (d, b, c) must keep facing where the old ones did.
      triNormal(positions, a, b, c, n0);
      triNormal(positions, b, a, d, n1);
      triNormal(positions, a, d, c, m0);
      triNormal(positions, d, b, c, m1);
      if (m0.dot(n0) <= 0 || m0.dot(n1) <= 0 || m1.dot(n0) <= 0 || m1.dot(n1) <= 0) continue;
      if (m0.lengthSq() < 1e-14 || m1.lengthSq() < 1e-14) continue;

      tris[t0 * 3] = a;
      tris[t0 * 3 + 1] = d;
      tris[t0 * 3 + 2] = c;
      tris[t1 * 3] = d;
      tris[t1 * 3 + 1] = b;
      tris[t1 * 3 + 2] = c;
      valence.set(a, (valence.get(a) as number) - 1);
      valence.set(b, (valence.get(b) as number) - 1);
      valence.set(c, (valence.get(c) as number) + 1);
      valence.set(d, (valence.get(d) as number) + 1);
      touched.add(t0);
      touched.add(t1);
      flips++;
    }
    if (flips === 0) break;
  }
}

/**
 * Dynamic-topology refinement under the brush, Blender-dyntopo style: the
 * mesh gains resolution exactly where the brush is, so a small dab on a
 * coarse base primitive carves detail instead of dragging a few huge
 * triangles around.
 *
 * Every call splits to convergence (edges near the hit end up at most
 * `detailSize × 4/3` long, up to a round and triangle budget) — a single
 * pass used to leave triangles several times larger than the brush, and
 * displacing their corners is what made the first dab stretch the whole
 * surface. Splits follow the longest-edge rule and are followed by edge
 * flips, so the result stays made of well-proportioned triangles.
 *
 * No edge collapse yet: density only ever grows.
 */
export function refineNearBrush(
  mesh: SculptMeshData,
  hitPoint: THREE.Vector3,
  radius: number,
  detailSize: number,
): SculptMeshData {
  const positions = Array.from(mesh.positions);
  const tris = Array.from(mesh.indices);
  const mask = mesh.mask ? Array.from(mesh.mask) : null;
  const splitLength = Math.max(0.001, detailSize) * SPLIT_RATIO;

  let changed = false;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (!splitRound(positions, tris, mask, hitPoint, radius, splitLength)) break;
    changed = true;
  }
  if (!changed) {
    return { positions: mesh.positions, normals: mesh.normals, indices: mesh.indices, mask: mesh.mask };
  }

  flipPass(positions, tris, hitPoint, radius);

  const flatPositions = new Float32Array(positions);
  const flatIndices = new Uint32Array(tris);
  return {
    positions: flatPositions,
    normals: computeVertexNormals(flatPositions, flatIndices),
    indices: flatIndices,
    mask: mask ? new Float32Array(mask) : undefined,
  };
}
