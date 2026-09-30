import type { QuadMesh } from "../quadMesh";
import { triangulateFace } from "./triangulate";
import { packIslands } from "./pack";
import { angleIslands } from "./unwrap";
import { boxProjectFace, type UV } from "./uv";

/*
 * Unwrap: least-squares conformal maps (Lévy et al., 2002) — Blender's
 * "Conformal" unwrap. Each island (faces joined across edges that are not
 * seams) is flattened keeping angles as close as possible to the 3D ones,
 * with two vertices pinned; then every island is scaled to its 3D area (one
 * texel density for all) and packed into 0..1.
 *
 * A vertex on a seam that runs *into* an island without splitting it (the one
 * seam down a cylinder) becomes two UV vertices, one per side: corners around
 * a vertex share a UV vertex only when joined across a non-seam edge.
 */

type V3 = [number, number, number];
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: readonly number[]) => Math.sqrt(dot(a, a));

const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);

export interface UnwrapResult {
  mesh: QuadMesh;
  islands: number;
}

/**
 * Unwraps `faces` (every face when empty) and packs the result into 0..1.
 * Faces outside the set keep their UVs.
 */
export function unwrapFaces(mesh: QuadMesh, faces: number[] | null, margin = 0.02): UnwrapResult {
  const target = (faces && faces.length > 0 ? [...new Set(faces)] : mesh.faces.map((_, f) => f)).filter((f) => (mesh.faces[f]?.length ?? 0) >= 3);
  const faceUVs: UV[][] = mesh.faces.map((face, f) =>
    (mesh.faceUVs?.[f]?.length === face.length ? mesh.faceUVs[f] : face.map(() => [0, 0])).map((uv) => [uv[0], uv[1]] as UV),
  );
  if (target.length === 0) return { mesh: { ...mesh, faceUVs }, islands: 0 };

  const inSet = new Set(target);
  const seams = new Set((mesh.seamEdges ?? []).map(([a, b]) => edgeKey(a, b)));
  const byEdge = new Map<string, number[]>();
  for (const f of target) {
    const face = mesh.faces[f];
    face.forEach((v, i) => {
      const key = edgeKey(v, face[(i + 1) % face.length]);
      const list = byEdge.get(key) ?? [];
      list.push(f);
      byEdge.set(key, list);
    });
  }
  /** An edge the layout stays joined across: two faces of the set, no seam. */
  const joined = (key: string) => !seams.has(key) && byEdge.get(key)?.length === 2;

  // Islands: flood fill across joined edges.
  const islandOf = new Map<number, number>();
  const islands: number[][] = [];
  for (const seed of target) {
    if (islandOf.has(seed)) continue;
    const id = islands.length;
    const group = [seed];
    islandOf.set(seed, id);
    for (let k = 0; k < group.length; k++) {
      const face = mesh.faces[group[k]];
      face.forEach((v, i) => {
        const key = edgeKey(v, face[(i + 1) % face.length]);
        if (!joined(key)) return;
        for (const g of byEdge.get(key)!) {
          if (!islandOf.has(g) && inSet.has(g)) {
            islandOf.set(g, id);
            group.push(g);
          }
        }
      });
    }
    islands.push(group);
  }

  // A closed island (no border, no seam — a whole box, a sphere) can't lie
  // flat in one piece: cut it by angle first, as Smart UV Project would.
  const finalIslands: number[][] = [];
  for (const group of islands) {
    const closed = group.every((f) => {
      const face = mesh.faces[f];
      return face.every((v, i) => joined(edgeKey(v, face[(i + 1) % face.length])));
    });
    if (closed) finalIslands.push(...angleIslands(mesh, group).map((i) => i.faces));
    else finalIslands.push(group);
  }
  const islandId = new Map<number, number>();
  finalIslands.forEach((group, id) => group.forEach((f) => islandId.set(f, id)));
  /** Joined, and within one island (the angle cut above counts as a seam). */
  const connected = (key: string) => {
    if (!joined(key)) return false;
    const [f, g] = byEdge.get(key)!;
    return islandId.get(f) === islandId.get(g);
  };

  const packed: UV[][] = [];
  for (const group of finalIslands) {
    const uvs = unwrapIsland(mesh, group, connected);
    const points: UV[] = [];
    for (const f of group) {
      faceUVs[f] = uvs.get(f)!;
      points.push(...faceUVs[f]);
    }
    packed.push(points);
  }
  packIslands(packed, margin);
  return { mesh: { ...mesh, faceUVs }, islands: finalIslands.length };
}

/** One island's corner UVs, at 3D scale (one UV unit per scene unit), unpacked. */
function unwrapIsland(mesh: QuadMesh, group: number[], joined: (key: string) => boolean): Map<number, UV[]> {
  const P = mesh.positions;

  // UV vertices: face corners around a vertex, united across joined edges.
  const cornerId = (f: number, i: number) => `${f}:${i}`;
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const f of group) mesh.faces[f].forEach((_, i) => parent.set(cornerId(f, i), cornerId(f, i)));
  const inGroup = new Set(group);
  const cornersOnEdge = new Map<string, { f: number; i: number }[]>();
  for (const f of group) {
    const face = mesh.faces[f];
    face.forEach((v, i) => {
      const key = edgeKey(v, face[(i + 1) % face.length]);
      const list = cornersOnEdge.get(key) ?? [];
      list.push({ f, i });
      cornersOnEdge.set(key, list);
    });
  }
  for (const [key, uses] of cornersOnEdge) {
    if (uses.length !== 2 || !joined(key) || !inGroup.has(uses[0].f) || !inGroup.has(uses[1].f)) continue;
    const [p, q] = uses;
    const fp = mesh.faces[p.f];
    const fq = mesh.faces[q.f];
    for (const v of [fp[p.i], fp[(p.i + 1) % fp.length]]) {
      parent.set(find(cornerId(p.f, fp.indexOf(v))), find(cornerId(q.f, fq.indexOf(v))));
    }
  }
  const uvIndex = new Map<string, number>();
  const uvVertex: number[] = []; // mesh vertex of each UV vertex
  const cornerUV = new Map<string, number>();
  for (const f of group) {
    mesh.faces[f].forEach((v, i) => {
      const root = find(cornerId(f, i));
      let idx = uvIndex.get(root);
      if (idx === undefined) {
        idx = uvVertex.length;
        uvIndex.set(root, idx);
        uvVertex.push(v);
      }
      cornerUV.set(cornerId(f, i), idx);
    });
  }
  const n = uvVertex.length;

  // Triangles, in UV-vertex indices, with their local 2D frames.
  const tris: { idx: [number, number, number]; q: [number, number][]; weight: number }[] = [];
  let area3D = 0;
  const avgNormal: V3 = [0, 0, 0];
  for (const f of group) {
    const face = mesh.faces[f];
    for (const [a, b, c] of triangulateFace(P, face)) {
      const p0 = P[face[a]], p1 = P[face[b]], p2 = P[face[c]];
      const e1 = sub(p1, p0);
      const e2 = sub(p2, p0);
      const nrm = cross(e1, e2);
      const twiceArea = len(nrm);
      const l1 = len(e1);
      if (twiceArea < 1e-14 || l1 < 1e-12) continue;
      area3D += twiceArea / 2;
      avgNormal[0] += nrm[0]; avgNormal[1] += nrm[1]; avgNormal[2] += nrm[2];
      const x: V3 = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
      const z: V3 = [nrm[0] / twiceArea, nrm[1] / twiceArea, nrm[2] / twiceArea];
      const y = cross(z, x);
      tris.push({
        idx: [cornerUV.get(cornerId(f, a))!, cornerUV.get(cornerId(f, b))!, cornerUV.get(cornerId(f, c))!],
        q: [[0, 0], [l1, 0], [dot(e2, x), dot(e2, y)]],
        weight: 1 / Math.sqrt(twiceArea),
      });
    }
  }

  // A flat projection along the island's normal: the fallback, and the solver's start.
  const projected = projectAlong(P, uvVertex, avgNormal);
  const result = (uv: UV[]) => {
    const out = new Map<number, UV[]>();
    for (const f of group) out.set(f, mesh.faces[f].map((_, i) => [...uv[cornerUV.get(cornerId(f, i))!]] as UV));
    return out;
  };
  if (tris.length === 0 || n < 3) {
    return new Map(group.map((f) => {
      const nn = avgNormal;
      return [f, boxProjectFace(mesh, mesh.faces[f], { x: nn[0], y: nn[1], z: nn[2] })];
    }));
  }

  // Pins: the two UV vertices furthest apart along the island's longest extent.
  let pinA = 0, pinB = 0;
  {
    let lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (const v of uvVertex) for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], P[v][k]);
      hi[k] = Math.max(hi[k], P[v][k]);
    }
    const axis = [0, 1, 2].reduce((best, k) => (hi[k] - lo[k] > hi[best] - lo[best] ? k : best), 0);
    uvVertex.forEach((v, i) => {
      if (P[v][axis] < P[uvVertex[pinA]][axis]) pinA = i;
      if (P[v][axis] > P[uvVertex[pinB]][axis]) pinB = i;
    });
  }
  if (pinA === pinB) return result(projected);

  // Pinned values: the projection's, so the start already satisfies them.
  const pinned = new Map<number, UV>([[pinA, projected[pinA]], [pinB, projected[pinB]]]);
  const free: number[] = [];
  const column = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (!pinned.has(i)) column[i] = free.push(i) - 1;

  // Two rows per triangle: the real and imaginary parts of Σ W_j U_j = 0,
  // W_j = (x_{j+2} − x_{j+1}) + i (y_{j+2} − y_{j+1}), U_j = u_j + i v_j.
  const rowCols: number[][] = [];
  const rowVals: number[][] = [];
  const rhs: number[] = [];
  for (const { idx, q, weight } of tris) {
    const re: number[] = [], im: number[] = [];
    const colsRe: number[] = [], colsIm: number[] = [];
    let bRe = 0, bIm = 0;
    for (let j = 0; j < 3; j++) {
      const k = (j + 1) % 3;
      const l = (j + 2) % 3;
      const wr = (q[l][0] - q[k][0]) * weight;
      const wi = (q[l][1] - q[k][1]) * weight;
      const vtx = idx[j];
      const pin = pinned.get(vtx);
      if (pin) {
        // Known: moves to the right-hand side.
        bRe -= wr * pin[0] - wi * pin[1];
        bIm -= wi * pin[0] + wr * pin[1];
        continue;
      }
      const c = column[vtx] * 2;
      colsRe.push(c, c + 1); re.push(wr, -wi);
      colsIm.push(c, c + 1); im.push(wi, wr);
    }
    rowCols.push(colsRe, colsIm);
    rowVals.push(re, im);
    rhs.push(bRe, bIm);
  }

  const x = new Float64Array(free.length * 2);
  free.forEach((vtx, i) => {
    x[i * 2] = projected[vtx][0];
    x[i * 2 + 1] = projected[vtx][1];
  });
  solveLeastSquares(rowCols, rowVals, rhs, x);

  const uv: UV[] = projected.map((p) => [p[0], p[1]]);
  free.forEach((vtx, i) => {
    uv[vtx] = [x[i * 2], x[i * 2 + 1]];
  });

  // Mirrored (the other conformal solution)? Flip it back.
  let signed = 0;
  for (const { idx: [a, b, c] } of tris) {
    signed += (uv[b][0] - uv[a][0]) * (uv[c][1] - uv[a][1]) - (uv[c][0] - uv[a][0]) * (uv[b][1] - uv[a][1]);
  }
  if (signed < 0) for (const p of uv) p[0] = -p[0];

  // 3D scale: the island's UV area equals its surface area.
  const areaUV = Math.abs(signed) / 2;
  if (areaUV > 1e-14 && Number.isFinite(areaUV)) {
    const s = Math.sqrt(area3D / areaUV);
    for (const p of uv) {
      p[0] *= s;
      p[1] *= s;
    }
  }
  if (uv.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return result(projected);
  return result(uv);
}

/** The vertices projected on the plane across `normal`, as 2D points. */
function projectAlong(P: V3[] | [number, number, number][], vertices: number[], normal: V3): UV[] {
  const l = len(normal);
  const nz: V3 = l > 1e-12 ? [normal[0] / l, normal[1] / l, normal[2] / l] : [0, 0, 1];
  const helper: V3 = Math.abs(nz[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u = cross(helper, nz);
  const lu = len(u);
  u = [u[0] / lu, u[1] / lu, u[2] / lu];
  const v = cross(nz, u);
  return vertices.map((vi) => [dot(P[vi], u), dot(P[vi], v)]);
}

/**
 * min ‖A x − b‖² by conjugate gradients on the normal equations (CGLS),
 * starting from `x` (updated in place). A is given row by row, sparse.
 */
function solveLeastSquares(rowCols: number[][], rowVals: number[][], b: number[], x: Float64Array): void {
  const m = b.length;
  const nCols = x.length;
  const Ax = (v: Float64Array, out: Float64Array) => {
    for (let r = 0; r < m; r++) {
      let s = 0;
      const cols = rowCols[r];
      const vals = rowVals[r];
      for (let k = 0; k < cols.length; k++) s += vals[k] * v[cols[k]];
      out[r] = s;
    }
  };
  const ATx = (v: Float64Array, out: Float64Array) => {
    out.fill(0);
    for (let r = 0; r < m; r++) {
      const cols = rowCols[r];
      const vals = rowVals[r];
      const vr = v[r];
      for (let k = 0; k < cols.length; k++) out[cols[k]] += vals[k] * vr;
    }
  };
  const r = new Float64Array(m);
  Ax(x, r);
  for (let i = 0; i < m; i++) r[i] = b[i] - r[i];
  const s = new Float64Array(nCols);
  ATx(r, s);
  const p = Float64Array.from(s);
  const q = new Float64Array(m);
  let gamma = s.reduce((acc, v) => acc + v * v, 0);
  const tolerance = Math.max(1e-24, gamma * 1e-20);
  const maxIterations = Math.min(4000, Math.max(200, nCols * 2));
  for (let it = 0; it < maxIterations && gamma > tolerance; it++) {
    Ax(p, q);
    const qq = q.reduce((acc, v) => acc + v * v, 0);
    if (qq < 1e-300) break;
    const alpha = gamma / qq;
    for (let i = 0; i < nCols; i++) x[i] += alpha * p[i];
    for (let i = 0; i < m; i++) r[i] -= alpha * q[i];
    ATx(r, s);
    const next = s.reduce((acc, v) => acc + v * v, 0);
    const beta = next / gamma;
    gamma = next;
    for (let i = 0; i < nCols; i++) p[i] = s[i] + beta * p[i];
  }
}
