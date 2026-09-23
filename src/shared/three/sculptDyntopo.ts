import * as THREE from "three";
import { SculptMeshData, computeVertexNormals, edgeKey } from "./sculptMesh";

type Tri = [number, number, number];

function triangleMaxEdge(positions: number[], tri: Tri): number {
  const [a, b, c] = tri;
  const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
  const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
  const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
  const ab = Math.hypot(bx - ax, by - ay, bz - az);
  const bc = Math.hypot(cx - bx, cy - by, cz - bz);
  const ca = Math.hypot(ax - cx, ay - cy, az - cz);
  return Math.max(ab, bc, ca);
}

function triangleNearPoint(positions: number[], tri: Tri, point: THREE.Vector3, radius: number): boolean {
  const [a, b, c] = tri;
  for (const v of [a, b, c]) {
    const dx = positions[v * 3] - point.x;
    const dy = positions[v * 3 + 1] - point.y;
    const dz = positions[v * 3 + 2] - point.z;
    if (Math.hypot(dx, dy, dz) <= radius) return true;
  }
  return false;
}

/**
 * Adaptive local edge-split refinement: triangles near the brush hit point
 * whose longest edge exceeds `detailSize` get subdivided. Self-limiting —
 * once edges are at or below `detailSize`, splitting stops, so density is
 * bounded even under repeated strokes over the same spot.
 *
 * v1 simplification (see plan): a triangle whose edge must be split because
 * a *neighbor* is being split is itself fully split (all 3 edges), rather
 * than bisected the way true red-green refinement would. This is crack-free
 * and always terminates, just not maximally efficient in triangle count —
 * true green (2-way) triangles are a fast-follow, not required for
 * "detail increases where you sculpt."
 *
 * No edge collapse/decimation in v1 (density only ever grows) — also a
 * documented fast-follow, not a bug.
 */
export function refineNearBrush(
  mesh: SculptMeshData,
  hitPoint: THREE.Vector3,
  radius: number,
  detailSize: number,
  maxIterations = 4,
): SculptMeshData {
  const targetEdge = Math.max(0.001, detailSize);
  let positions = Array.from(mesh.positions);
  let tris: Tri[] = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    tris.push([mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]]);
  }
  let mask = mesh.mask ? Array.from(mesh.mask) : null;

  for (let iter = 0; iter < maxIterations; iter++) {
    // Seed set: triangles near the brush whose longest edge is too long.
    const seeds: number[] = [];
    for (let i = 0; i < tris.length; i++) {
      if (triangleNearPoint(positions, tris[i], hitPoint, radius) && triangleMaxEdge(positions, tris[i]) > targetEdge) {
        seeds.push(i);
      }
    }
    if (seeds.length === 0) break;

    // Edge -> triangle indices, over the current (pre-split) triangle set.
    const edgeToTris = new Map<string, number[]>();
    for (let i = 0; i < tris.length; i++) {
      const [a, b, c] = tris[i];
      for (const [u, v] of [[a, b], [b, c], [c, a]] as [number, number][]) {
        const key = edgeKey(u, v);
        const list = edgeToTris.get(key);
        if (list) list.push(i);
        else edgeToTris.set(key, [i]);
      }
    }

    // Propagate: any triangle sharing an edge with a to-be-split triangle
    // must itself be split too (see doc comment above).
    const toSplit = new Set<number>(seeds);
    const queue = [...seeds];
    while (queue.length > 0) {
      const ti = queue.pop() as number;
      const [a, b, c] = tris[ti];
      for (const [u, v] of [[a, b], [b, c], [c, a]] as [number, number][]) {
        const neighbors = edgeToTris.get(edgeKey(u, v)) ?? [];
        for (const nj of neighbors) {
          if (!toSplit.has(nj)) {
            toSplit.add(nj);
            queue.push(nj);
          }
        }
      }
    }

    const midpointCache = new Map<string, number>();
    const getMidpoint = (a: number, b: number): number => {
      const key = edgeKey(a, b);
      const cached = midpointCache.get(key);
      if (cached !== undefined) return cached;
      const mx = (positions[a * 3] + positions[b * 3]) * 0.5;
      const my = (positions[a * 3 + 1] + positions[b * 3 + 1]) * 0.5;
      const mz = (positions[a * 3 + 2] + positions[b * 3 + 2]) * 0.5;
      const idx = positions.length / 3;
      positions.push(mx, my, mz);
      if (mask) mask.push((mask[a] + mask[b]) * 0.5);
      midpointCache.set(key, idx);
      return idx;
    };

    const nextTris: Tri[] = [];
    for (let i = 0; i < tris.length; i++) {
      if (!toSplit.has(i)) {
        nextTris.push(tris[i]);
        continue;
      }
      const [a, b, c] = tris[i];
      const ab = getMidpoint(a, b);
      const bc = getMidpoint(b, c);
      const ca = getMidpoint(c, a);
      nextTris.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    tris = nextTris;
  }

  const flatIndices = new Uint32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) {
    flatIndices[i * 3] = tris[i][0];
    flatIndices[i * 3 + 1] = tris[i][1];
    flatIndices[i * 3 + 2] = tris[i][2];
  }
  const flatPositions = new Float32Array(positions);
  const normals = computeVertexNormals(flatPositions, flatIndices);
  return {
    positions: flatPositions,
    normals,
    indices: flatIndices,
    mask: mask ? new Float32Array(mask) : undefined,
  };
}
