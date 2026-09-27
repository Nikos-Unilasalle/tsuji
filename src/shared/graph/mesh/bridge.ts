import * as THREE from "three";
import { QuadMesh, cloneQuadMesh, withFaceUVs } from "../quadMesh";
import { buildTopology } from "./topology";
import { compactMesh, projectNewFaceUVs } from "./tools";
import type { UV } from "./uv";

type Pair = [number, number];

/**
 * Orders edges into chains: each connected piece becomes its vertex sequence,
 * `closed` when it loops. Null if any piece branches (a vertex with three or
 * more of the edges).
 */
export function edgeChains(edges: Pair[]): { verts: number[]; closed: boolean }[] | null {
  const adj = new Map<number, number[]>();
  for (const [a, b] of edges) {
    if (a === b) continue;
    adj.set(a, [...(adj.get(a) ?? []), b]);
    adj.set(b, [...(adj.get(b) ?? []), a]);
  }
  for (const list of adj.values()) if (list.length > 2) return null;
  const seen = new Set<number>();
  const chains: { verts: number[]; closed: boolean }[] = [];
  // Open chains first, from an end; then whatever is left is loops.
  const starts = [...adj.keys()].sort((x, y) => (adj.get(x)!.length - adj.get(y)!.length) || x - y);
  for (const s of starts) {
    if (seen.has(s)) continue;
    const verts = [s];
    seen.add(s);
    let prev = -1;
    let cur = s;
    for (;;) {
      const nxt = adj.get(cur)!.find((n) => n !== prev && !seen.has(n));
      if (nxt === undefined) break;
      verts.push(nxt);
      seen.add(nxt);
      prev = cur;
      cur = nxt;
    }
    const closed = verts.length > 2 && adj.get(verts[verts.length - 1])!.includes(s);
    chains.push({ verts, closed });
  }
  return chains;
}

const dist2 = (m: QuadMesh, a: number, b: number) => {
  const p = m.positions[a];
  const q = m.positions[b];
  return (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
};

/**
 * Bridges two edge loops (or two open chains) with a band of quads —
 * Blender's Bridge Edge Loops. Both must have the same number of vertices.
 * Loops are matched up at the rotation and direction that keeps the bridge
 * shortest, so they needn't be listed in any particular order; the band is
 * wound to agree with faces already on those edges.
 */
export function bridgeEdgeLoops(
  mesh: QuadMesh,
  edges: Pair[],
): { mesh: QuadMesh; newFaces: number[]; error?: string } {
  const chains = edgeChains(edges);
  if (!chains || chains.length !== 2) return { mesh: cloneQuadMesh(mesh), newFaces: [], error: "Select exactly two edge loops" };
  const [A, B] = chains;
  if (A.closed !== B.closed) return { mesh: cloneQuadMesh(mesh), newFaces: [], error: "Both loops must be closed, or both open" };
  if (A.verts.length !== B.verts.length) {
    return { mesh: cloneQuadMesh(mesh), newFaces: [], error: `The loops have ${A.verts.length} and ${B.verts.length} vertices` };
  }
  const n = A.verts.length;
  const a = A.verts;

  // Best match for B: every rotation (closed) and both directions.
  let best: number[] = B.verts;
  let bestCost = Infinity;
  for (const dir of [B.verts, [...B.verts].reverse()]) {
    for (let r = 0; r < (A.closed ? n : 1); r++) {
      const cand = dir.map((_, i) => dir[(i + r) % n]);
      let cost = 0;
      for (let i = 0; i < n; i++) cost += dist2(mesh, a[i], cand[i]);
      if (cost < bestCost) {
        bestCost = cost;
        best = cand;
      }
    }
  }

  const topo = buildTopology(mesh);
  const quads: number[][] = [];
  const steps = A.closed ? n : n - 1;
  for (let i = 0; i < steps; i++) {
    const j = (i + 1) % n;
    quads.push([a[i], a[j], best[j], best[i]]);
  }
  // Wind against existing faces: a face already running a[i] → a[j] means
  // the bridge must run a[j] → a[i].
  let vote = 0;
  for (const q of quads) {
    for (let k = 0; k < 4; k++) {
      const u = q[k];
      const v = q[(k + 1) % 4];
      if (topo.findHalfedge(u, v) >= 0) vote--;
      if (topo.findHalfedge(v, u) >= 0) vote++;
    }
  }
  const next = withFaceUVs(cloneQuadMesh(mesh));
  const created: number[] = [];
  for (const q of quads) {
    next.faces.push(vote < 0 ? [...q].reverse() : q);
    next.faceUVs!.push([]);
    if (next.faceMaterials) next.faceMaterials.push(0);
    if (next.faceShading && next.faceShading.length > 0) next.faceShading.push(next.shading ?? "auto");
    created.push(next.faces.length - 1);
  }
  projectNewFaceUVs(next, created);
  const { mesh: out, remapFace } = compactMesh(next);
  return { mesh: out, newFaces: created.map((f) => remapFace[f]).filter((f) => f >= 0) };
}

/**
 * Bridges two groups of selected faces: both are removed and their borders
 * joined by a band of quads — a tunnel through a box, a handle between two
 * pieces.
 */
export function bridgeFaces(mesh: QuadMesh, faces: number[]): { mesh: QuadMesh; newFaces: number[]; error?: string } {
  const topo = buildTopology(mesh);
  const selected = new Set(faces.filter((f) => f >= 0 && f < mesh.faces.length));
  // Border edges of the selection: an edge with exactly one selected face.
  const borderEdges: Pair[] = [];
  for (let e = 0; e < topo.edges.length; e++) {
    const [u, v] = topo.edges[e];
    const around = topo.edgeFaces(u, v).filter((f) => selected.has(f));
    if (around.length === 1) borderEdges.push([u, v]);
  }
  const next = withFaceUVs(cloneQuadMesh(mesh));
  for (const f of selected) next.faces[f] = [];
  // Emptied faces keep the vertex numbering until the bridge is built; the
  // compaction at its end drops them.
  const bridged = bridgeEdgeLoops(next, borderEdges);
  if (bridged.error) return { mesh: cloneQuadMesh(mesh), newFaces: [], error: bridged.error };
  return bridged;
}

/**
 * Spins a profile of edges around an axis through `center` (local space) —
 * a lathe: `steps` copies rotated through `angleDeg`, joined by quads. A full
 * turn closes onto the start, and vertices on the axis are shared rather
 * than copied (the quads touching them become triangles). UVs run around the
 * turn (u) and along the profile (v); faces point away from the axis.
 */
export function spinEdges(
  mesh: QuadMesh,
  edges: Pair[],
  axis: "x" | "y" | "z",
  angleDeg: number,
  steps: number,
  center: [number, number, number] = [0, 0, 0],
): { mesh: QuadMesh; newFaces: number[] } {
  const chains = edgeChains(edges);
  const count = Math.max(1, Math.min(256, Math.round(steps)));
  if (!chains || chains.length === 0 || angleDeg === 0) return { mesh: cloneQuadMesh(mesh), newFaces: [] };
  const axisVec = new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
  const c = new THREE.Vector3(...center);
  const full = Math.abs(Math.abs(angleDeg) - 360) < 1e-6;
  const next = withFaceUVs(cloneQuadMesh(mesh));
  const created: number[] = [];

  const scale = new THREE.Box3().setFromPoints(mesh.positions.map((p) => new THREE.Vector3(...p))).getSize(new THREE.Vector3()).length() || 1;
  const onAxis = (v: number) => {
    const p = new THREE.Vector3(...mesh.positions[v]).sub(c);
    return p.clone().sub(axisVec.clone().multiplyScalar(p.dot(axisVec))).length() < scale * 1e-6;
  };

  for (const chain of chains) {
    const profileVerts = chain.verts;
    // Vertex index of profile vertex v at step k.
    const ring: number[][] = [profileVerts];
    for (let k = 1; k <= count; k++) {
      if (full && k === count) {
        ring.push(profileVerts);
        break;
      }
      const q = new THREE.Quaternion().setFromAxisAngle(axisVec, THREE.MathUtils.degToRad((angleDeg * k) / count));
      ring.push(
        profileVerts.map((v) => {
          if (onAxis(v)) return v;
          const p = new THREE.Vector3(...mesh.positions[v]).sub(c).applyQuaternion(q).add(c);
          next.positions.push([p.x, p.y, p.z]);
          return next.positions.length - 1;
        }),
      );
    }
    // v along the profile, by length.
    const along = [0];
    for (let i = 1; i < profileVerts.length; i++) {
      const d = Math.sqrt(dist2(mesh, profileVerts[i - 1], profileVerts[i]));
      along.push(along[i - 1] + d);
    }
    const closing = chain.closed ? Math.sqrt(dist2(mesh, profileVerts[profileVerts.length - 1], profileVerts[0])) : 0;
    const total = along[along.length - 1] + closing || 1;

    const segCount = chain.closed ? profileVerts.length : profileVerts.length - 1;
    const faces: { face: number[]; uvs: UV[] }[] = [];
    for (let k = 0; k < count; k++) {
      for (let i = 0; i < segCount; i++) {
        const j = (i + 1) % profileVerts.length;
        const vi = along[i];
        const vj = j === 0 && chain.closed ? total : along[j];
        const u0 = k / count;
        const u1 = (k + 1) / count;
        const face = [ring[k][i], ring[k][j], ring[k + 1][j], ring[k + 1][i]];
        const uvs: UV[] = [[u0, vi / total], [u0, vj / total], [u1, vj / total], [u1, vi / total]];
        // Collapse corners shared on the axis (quad → triangle).
        const keep = face.map((_, idx) => idx).filter((idx) => face[idx] !== face[(idx + 1) % 4]);
        if (new Set(keep.map((idx) => face[idx])).size < 3) continue;
        faces.push({ face: keep.map((idx) => face[idx]), uvs: keep.map((idx) => uvs[idx]) });
      }
    }
    // Outward: summed over every face (area-weighted), the normals should
    // point away from the axis. Faces square to the axis (a cup's bottom)
    // weigh nothing, so they can't swing the vote.
    let outward = 0;
    for (const { face } of faces) {
      const pts = face.map((v) => new THREE.Vector3(...next.positions[v]));
      const n = new THREE.Vector3().subVectors(pts[1], pts[0]).cross(new THREE.Vector3().subVectors(pts[2], pts[0]));
      const centroid = pts.reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(pts.length).sub(c);
      outward += n.dot(centroid.sub(axisVec.clone().multiplyScalar(centroid.dot(axisVec))));
    }
    const flip = outward < 0;
    for (const { face, uvs } of faces) {
      next.faces.push(flip ? [...face].reverse() : face);
      next.faceUVs!.push(flip ? [...uvs].reverse() : uvs);
      if (next.faceMaterials) next.faceMaterials.push(0);
      if (next.faceShading && next.faceShading.length > 0) next.faceShading.push(next.shading ?? "auto");
      created.push(next.faces.length - 1);
    }
  }
  const { mesh: out, remapFace } = compactMesh(next);
  return { mesh: out, newFaces: created.map((f) => remapFace[f]).filter((f) => f >= 0) };
}
