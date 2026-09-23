import * as THREE from "three";
import { SculptMeshData, computeVertexNormals, edgeKey } from "./sculptMesh";

type Tri = [number, number, number];

function edgeLength(positions: number[], a: number, b: number): number {
  return Math.hypot(
    positions[b * 3] - positions[a * 3],
    positions[b * 3 + 1] - positions[a * 3 + 1],
    positions[b * 3 + 2] - positions[a * 3 + 2],
  );
}

function midpointDistance(positions: number[], a: number, b: number, point: THREE.Vector3): number {
  const mx = (positions[a * 3] + positions[b * 3]) * 0.5;
  const my = (positions[a * 3 + 1] + positions[b * 3 + 1]) * 0.5;
  const mz = (positions[a * 3 + 2] + positions[b * 3 + 2]) * 0.5;
  return Math.hypot(mx - point.x, my - point.y, mz - point.z);
}

/**
 * Adaptive local edge-split refinement: triangles near the brush hit point
 * whose edges exceed `detailSize` get subdivided. Self-limiting — once
 * edges are at or below `detailSize`, splitting stops, so density is
 * bounded even under repeated strokes over the same spot.
 *
 * Marks individual *edges* for subdivision (not whole triangles), then
 * retriangulates each affected triangle by an 8-way pattern based on which
 * of its 3 edges got a midpoint (0-3 edges marked). This is the same
 * red-green refinement technique marmelab's sculpt-3D uses — cheaper than
 * always fully splitting every triangle a marked edge touches, while
 * staying crack-free (a shared edge's midpoint is created once and reused
 * by both triangles on either side).
 *
 * One call performs one split round; a continuous drag calls this
 * repeatedly (see the 100ms throttle in Viewport.tsx), so a stroke that
 * needs several halvings to reach `detailSize` converges over a few calls
 * rather than looping internally — same cadence as the stroke itself.
 *
 * No edge collapse/flip in v1 (density only ever grows) — a documented
 * fast-follow, not a bug.
 */
export function refineNearBrush(
  mesh: SculptMeshData,
  hitPoint: THREE.Vector3,
  radius: number,
  detailSize: number,
): SculptMeshData {
  const targetEdge = Math.max(0.001, detailSize);
  const positions = Array.from(mesh.positions);
  const tris: Tri[] = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    tris.push([mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]]);
  }
  const mask = mesh.mask ? Array.from(mesh.mask) : null;

  // Edge -> triangle indices, so a marked edge's neighbor triangle can be
  // found to keep the retriangulation crack-free.
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

  // STEP 1: mark edges that are too long and close enough to the brush.
  const edgesToSplit = new Set<string>();
  for (let i = 0; i < tris.length; i++) {
    const [a, b, c] = tris[i];
    for (const [u, v] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      if (edgeLength(positions, u, v) <= targetEdge * 1.5) continue;
      if (midpointDistance(positions, u, v, hitPoint) >= radius * 0.8) continue;
      edgesToSplit.add(edgeKey(u, v));
    }
  }
  if (edgesToSplit.size === 0) {
    return { positions: mesh.positions, normals: mesh.normals, indices: mesh.indices, mask: mesh.mask };
  }

  // STEP 2: propagate for triangle quality — a triangle with 2 of its 3
  // edges marked gets its 3rd marked too (avoids a sliver), and a lone
  // marked edge on a very thin triangle pulls in its longest edge too.
  let changed = true;
  let guard = 0;
  while (changed && guard < 5) {
    changed = false;
    guard++;
    const toAdd = new Set<string>();
    for (const edge of edgesToSplit) {
      for (const triIdx of edgeToTris.get(edge) ?? []) {
        const [a, b, c] = tris[triIdx];
        const e01 = edgeKey(a, b);
        const e12 = edgeKey(b, c);
        const e20 = edgeKey(c, a);
        const marked = [e01, e12, e20].filter((e) => edgesToSplit.has(e) || toAdd.has(e));
        if (marked.length === 2) {
          for (const e of [e01, e12, e20]) {
            if (!edgesToSplit.has(e) && !toAdd.has(e)) {
              toAdd.add(e);
              changed = true;
            }
          }
        } else if (marked.length === 1) {
          const lens: [string, number][] = [
            [e01, edgeLength(positions, a, b)],
            [e12, edgeLength(positions, b, c)],
            [e20, edgeLength(positions, c, a)],
          ];
          const maxLen = Math.max(...lens.map(([, l]) => l));
          const minLen = Math.min(...lens.map(([, l]) => l));
          if (minLen > 0 && maxLen / minLen > 3) {
            for (const [e, l] of lens) {
              if (l === maxLen && !edgesToSplit.has(e) && !toAdd.has(e)) {
                toAdd.add(e);
                changed = true;
              }
            }
          }
        }
      }
    }
    for (const e of toAdd) edgesToSplit.add(e);
  }

  // STEP 3: create (deduplicated) midpoints for every marked edge.
  const midpointIndex = new Map<string, number>();
  for (const edge of edgesToSplit) {
    const [a, b] = edge.split("_").map(Number);
    let mx = (positions[a * 3] + positions[b * 3]) * 0.5;
    let my = (positions[a * 3 + 1] + positions[b * 3 + 1]) * 0.5;
    let mz = (positions[a * 3 + 2] + positions[b * 3 + 2]) * 0.5;

    // If both endpoints sit roughly the same distance from the origin
    // (a sphere-ish primitive), project the midpoint back onto that
    // radius instead of leaving it flat — keeps a subdivided sphere
    // looking round under the brush instead of faceted.
    const lenA = Math.hypot(positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]);
    const lenB = Math.hypot(positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]);
    const avgLen = (lenA + lenB) * 0.5;
    if (avgLen > 1e-6 && Math.abs(lenA - avgLen) < avgLen * 0.3 && Math.abs(lenB - avgLen) < avgLen * 0.3) {
      const midLen = Math.hypot(mx, my, mz) || 1;
      const s = avgLen / midLen;
      mx *= s;
      my *= s;
      mz *= s;
    }

    const idx = positions.length / 3;
    positions.push(mx, my, mz);
    if (mask) mask.push((mask[a] + mask[b]) * 0.5);
    midpointIndex.set(edge, idx);
  }

  // STEP 4: retriangulate each triangle by an 8-way pattern based on which
  // of its 3 edges got a midpoint.
  const nextTris: Tri[] = [];
  for (const [a, b, c] of tris) {
    const e01 = edgeKey(a, b);
    const e12 = edgeKey(b, c);
    const e20 = edgeKey(c, a);
    const has01 = edgesToSplit.has(e01);
    const has12 = edgesToSplit.has(e12);
    const has20 = edgesToSplit.has(e20);
    const pattern = (has01 ? 1 : 0) | (has12 ? 2 : 0) | (has20 ? 4 : 0);

    if (pattern === 0) {
      nextTris.push([a, b, c]);
      continue;
    }
    const m01 = midpointIndex.get(e01);
    const m12 = midpointIndex.get(e12);
    const m20 = midpointIndex.get(e20);

    switch (pattern) {
      case 1: // only a-b
        nextTris.push([a, m01 as number, c], [m01 as number, b, c]);
        break;
      case 2: // only b-c
        nextTris.push([a, b, m12 as number], [a, m12 as number, c]);
        break;
      case 4: // only c-a
        nextTris.push([a, b, m20 as number], [b, c, m20 as number]);
        break;
      case 3: // a-b and b-c
        nextTris.push([a, m01 as number, c], [m01 as number, b, m12 as number], [m01 as number, m12 as number, c]);
        break;
      case 5: // a-b and c-a
        nextTris.push([a, m01 as number, m20 as number], [m01 as number, b, c], [m20 as number, m01 as number, c]);
        break;
      case 6: // b-c and c-a
        nextTris.push([a, b, m12 as number], [a, m12 as number, m20 as number], [m20 as number, m12 as number, c]);
        break;
      case 7: // all three
        nextTris.push(
          [a, m01 as number, m20 as number],
          [b, m12 as number, m01 as number],
          [c, m20 as number, m12 as number],
          [m01 as number, m12 as number, m20 as number],
        );
        break;
    }
  }

  const flatIndices = new Uint32Array(nextTris.length * 3);
  for (let i = 0; i < nextTris.length; i++) {
    flatIndices[i * 3] = nextTris[i][0];
    flatIndices[i * 3 + 1] = nextTris[i][1];
    flatIndices[i * 3 + 2] = nextTris[i][2];
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
