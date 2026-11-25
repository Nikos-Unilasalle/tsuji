import type { PolyMesh } from "../quadMesh";
import { triangulateFace } from "./triangulate";
import { edgeDistances } from "./selectOps";

/*
 * Geodesic distance by the heat method (Crane, Weischedel & Wardetzky 2013):
 *
 *   1. let heat diffuse from the sources for a short time t:  (M + tL) u = δ
 *   2. normalise its gradient per triangle:                    X = −∇u / |∇u|
 *   3. find the function whose gradient best matches X:        L φ = −∇·X
 *
 * L is the cotangent Laplacian (positive semi-definite form), M the lumped
 * (barycentric) mass. Both solves are symmetric positive (semi-)definite and
 * go through a Jacobi-preconditioned conjugate gradient — no dense matrix,
 * no factorisation, so a 100k-point mesh stays in memory.
 *
 * Unlike Dijkstra along edges, the result does not depend on how the mesh
 * is triangulated: on a plane it is the straight-line distance, not the
 * Manhattan-ish zig-zag of edge paths. When anything goes wrong (degenerate
 * triangles, a solve that will not converge, non-finite values) the edge
 * Dijkstra distance is returned instead and `method` says so.
 *
 * Points that no source can reach (another mesh island) get -1.
 */

export interface GeodesicResult {
  distance: Float64Array;
  method: "heat" | "dijkstra";
  /** Why the heat method was abandoned, if it was. */
  reason?: string;
}

/** Symmetric sparse matrix in CSR form. */
interface Csr {
  n: number;
  rowStart: Int32Array;
  cols: Int32Array;
  vals: Float64Array;
}

function multiply(m: Csr, x: Float64Array, out: Float64Array, shift?: { diag: Float64Array; scale: number }): void {
  for (let i = 0; i < m.n; i++) {
    let s = 0;
    for (let k = m.rowStart[i]; k < m.rowStart[i + 1]; k++) s += m.vals[k] * x[m.cols[k]];
    if (shift) s += shift.diag[i] * shift.scale * x[i];
    out[i] = s;
  }
}

/** Jacobi-preconditioned CG on (A + scale·diag(D)) x = b. Returns iterations, or -1 when it diverged. */
export function conjugateGradient(
  a: Csr,
  b: Float64Array,
  x: Float64Array,
  opts: { shift?: { diag: Float64Array; scale: number }; tolerance?: number; maxIterations?: number } = {},
): number {
  const n = a.n;
  const tol = opts.tolerance ?? 1e-10;
  const maxIt = opts.maxIterations ?? Math.max(200, 4 * n);
  const diag = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let k = a.rowStart[i]; k < a.rowStart[i + 1]; k++) if (a.cols[k] === i) diag[i] += a.vals[k];
    if (opts.shift) diag[i] += opts.shift.diag[i] * opts.shift.scale;
    if (!(diag[i] > 1e-300)) diag[i] = 1;
  }
  const r = new Float64Array(n);
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const ap = new Float64Array(n);
  multiply(a, x, ap, opts.shift);
  let bNorm = 0;
  for (let i = 0; i < n; i++) {
    r[i] = b[i] - ap[i];
    z[i] = r[i] / diag[i];
    p[i] = z[i];
    bNorm += b[i] * b[i];
  }
  bNorm = Math.sqrt(bNorm) || 1;
  let rz = 0;
  for (let i = 0; i < n; i++) rz += r[i] * z[i];
  for (let it = 0; it < maxIt; it++) {
    let rNorm = 0;
    for (let i = 0; i < n; i++) rNorm += r[i] * r[i];
    if (Math.sqrt(rNorm) <= tol * bNorm) return it;
    multiply(a, p, ap, opts.shift);
    let pap = 0;
    for (let i = 0; i < n; i++) pap += p[i] * ap[i];
    if (!(Math.abs(pap) > 1e-300) || !Number.isFinite(pap)) return Math.sqrt(rNorm) <= 1e-6 * bNorm ? it : -1;
    const alpha = rz / pap;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * ap[i];
      z[i] = r[i] / diag[i];
    }
    let rzNext = 0;
    for (let i = 0; i < n; i++) rzNext += r[i] * z[i];
    const beta = rzNext / rz;
    rz = rzNext;
    if (!Number.isFinite(beta)) return -1;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
  // Out of iterations: accept a solution that is close, refuse one that is not.
  let rNorm = 0;
  for (let i = 0; i < n; i++) rNorm += r[i] * r[i];
  return Math.sqrt(rNorm) <= 1e-4 * bNorm ? maxIt : -1;
}

/** Cotangent of the angle between u and v, clamped (needle triangles would give ±∞). */
function cot(ux: number, uy: number, uz: number, vx: number, vy: number, vz: number): number {
  const d = ux * vx + uy * vy + uz * vz;
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  const c = Math.hypot(cx, cy, cz);
  if (c < 1e-14) return 0;
  return Math.max(-1e4, Math.min(1e4, d / c));
}

export function heatGeodesic(mesh: PolyMesh, sources: Iterable<number>, opts: { timeScale?: number } = {}): GeodesicResult {
  const n = mesh.positions.length;
  const seeds = [...new Set([...sources].filter((s) => Number.isInteger(s) && s >= 0 && s < n))];
  const dijkstra = (reason: string): GeodesicResult => {
    const { dist } = edgeDistances(mesh, seeds);
    return { distance: dist.map((d) => (Number.isFinite(d) ? d : -1)), method: "dijkstra", reason };
  };
  if (!seeds.length) return { distance: new Float64Array(n).fill(-1), method: "dijkstra", reason: "no source points" };

  const P = mesh.positions;
  const tris: number[] = [];
  for (const face of mesh.faces) for (const [a, b, c] of triangulateFace(P, face)) tris.push(face[a], face[b], face[c]);
  const triCount = tris.length / 3;
  if (!triCount) return dijkstra("no faces");

  // Off-diagonal cotan weights (half sums), mass, mean edge length.
  const weights = new Map<number, number>();
  const key = (i: number, j: number) => (i < j ? i * n + j : j * n + i);
  const mass = new Float64Array(n);
  const cots = new Float64Array(triCount * 3);
  let edgeSum = 0;
  let edgeCount = 0;
  for (let t = 0; t < triCount; t++) {
    const i = tris[t * 3], j = tris[t * 3 + 1], k = tris[t * 3 + 2];
    const pi = P[i], pj = P[j], pk = P[k];
    const eij = [pj[0] - pi[0], pj[1] - pi[1], pj[2] - pi[2]];
    const eik = [pk[0] - pi[0], pk[1] - pi[1], pk[2] - pi[2]];
    const ejk = [pk[0] - pj[0], pk[1] - pj[1], pk[2] - pj[2]];
    const cx = eij[1] * eik[2] - eij[2] * eik[1], cy = eij[2] * eik[0] - eij[0] * eik[2], cz = eij[0] * eik[1] - eij[1] * eik[0];
    const area = 0.5 * Math.hypot(cx, cy, cz);
    if (!(area > 1e-20) || !Number.isFinite(area)) continue;
    const ci = cot(eij[0], eij[1], eij[2], eik[0], eik[1], eik[2]);
    const cj = cot(-eij[0], -eij[1], -eij[2], ejk[0], ejk[1], ejk[2]);
    const ck = cot(-eik[0], -eik[1], -eik[2], -ejk[0], -ejk[1], -ejk[2]);
    cots[t * 3] = ci;
    cots[t * 3 + 1] = cj;
    cots[t * 3 + 2] = ck;
    weights.set(key(j, k), (weights.get(key(j, k)) ?? 0) + ci / 2);
    weights.set(key(i, k), (weights.get(key(i, k)) ?? 0) + cj / 2);
    weights.set(key(i, j), (weights.get(key(i, j)) ?? 0) + ck / 2);
    mass[i] += area / 3;
    mass[j] += area / 3;
    mass[k] += area / 3;
    edgeSum += Math.hypot(...eij) + Math.hypot(...eik) + Math.hypot(...ejk);
    edgeCount += 3;
  }
  if (!edgeCount) return dijkstra("degenerate faces");
  const h = edgeSum / edgeCount;
  for (let i = 0; i < n; i++) if (!(mass[i] > 0)) mass[i] = h * h * 1e-6; // isolated points: keep M invertible

  // CSR of L (positive semi-definite): L_ij = −w_ij, L_ii = Σ w_ij.
  const rows: { c: number; v: number }[][] = Array.from({ length: n }, () => []);
  const diag = new Float64Array(n);
  for (const [k, w] of weights) {
    const i = Math.floor(k / n), j = k % n;
    rows[i].push({ c: j, v: -w });
    rows[j].push({ c: i, v: -w });
    diag[i] += w;
    diag[j] += w;
  }
  const rowStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) rowStart[i + 1] = rowStart[i] + rows[i].length + 1;
  const cols = new Int32Array(rowStart[n]);
  const vals = new Float64Array(rowStart[n]);
  for (let i = 0; i < n; i++) {
    let k = rowStart[i];
    cols[k] = i;
    vals[k++] = diag[i];
    for (const e of rows[i]) {
      cols[k] = e.c;
      vals[k++] = e.v;
    }
  }
  const L: Csr = { n, rowStart, cols, vals };

  // 1. Heat flow. (M + tL) u = δ, written as tL + M with M on the diagonal shift.
  const t = h * h * Math.max(1e-3, Number.isFinite(opts.timeScale) ? (opts.timeScale as number) : 1);
  const tL: Csr = { ...L, vals: vals.map((v) => v * t) };
  const delta = new Float64Array(n);
  for (const s of seeds) delta[s] = 1;
  const u = new Float64Array(n);
  if (conjugateGradient(tL, delta, u, { shift: { diag: mass, scale: 1 }, tolerance: 1e-12 }) < 0) return dijkstra("heat solve diverged");

  // 2. Normalised gradient per triangle, 3. its divergence per point.
  const div = new Float64Array(n);
  for (let tr = 0; tr < triCount; tr++) {
    const i = tris[tr * 3], j = tris[tr * 3 + 1], k = tris[tr * 3 + 2];
    const pi = P[i], pj = P[j], pk = P[k];
    const e1 = [pj[0] - pi[0], pj[1] - pi[1], pj[2] - pi[2]];
    const e2 = [pk[0] - pi[0], pk[1] - pi[1], pk[2] - pi[2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    const a2 = Math.hypot(nx, ny, nz);
    if (!(a2 > 1e-20)) continue;
    const N = [nx / a2, ny / a2, nz / a2];
    // ∇u = Σ u_v (N × e_v) / 2A, e_v the edge opposite v, counter-clockwise.
    const gx = [0, 0, 0];
    const corners: [number, number[], number[]][] = [
      [u[i], pk, pj],
      [u[j], pi, pk],
      [u[k], pj, pi],
    ];
    for (const [uv, from, to] of corners) {
      // Opposite edge of each corner, oriented to keep the triangle's winding.
      const ex = from[0] - to[0], ey = from[1] - to[1], ez = from[2] - to[2];
      gx[0] += uv * (N[1] * ez - N[2] * ey);
      gx[1] += uv * (N[2] * ex - N[0] * ez);
      gx[2] += uv * (N[0] * ey - N[1] * ex);
    }
    const gl = Math.hypot(gx[0], gx[1], gx[2]);
    if (!(gl > 0) || !Number.isFinite(gl)) continue; // no heat reached it (another island)
    const X = [-gx[0] / gl, -gx[1] / gl, -gx[2] / gl];
    const ci = cots[tr * 3], cj = cots[tr * 3 + 1], ck = cots[tr * 3 + 2];
    const dotX = (a: readonly number[], b: readonly number[]) => (b[0] - a[0]) * X[0] + (b[1] - a[1]) * X[1] + (b[2] - a[2]) * X[2];
    div[i] += 0.5 * (ck * dotX(pi, pj) + cj * dotX(pi, pk));
    div[j] += 0.5 * (ci * dotX(pj, pk) + ck * dotX(pj, pi));
    div[k] += 0.5 * (cj * dotX(pk, pi) + ci * dotX(pk, pj));
  }

  // 3. Poisson: L φ = −div. L is singular (constants), so a tiny mass shift
  // pins it; the constant is fixed afterwards by the sources.
  const phi = new Float64Array(n);
  const rhs = div.map((v) => -v);
  if (conjugateGradient(L, rhs, phi, { shift: { diag: mass, scale: 1e-8 / (h * h) }, tolerance: 1e-10 }) < 0) return dijkstra("Poisson solve diverged");
  if (!phi.every(Number.isFinite)) return dijkstra("non-finite result");

  // Distance grows away from the sources: flip if the solve came out mirrored.
  const reach = edgeDistances(mesh, seeds).dist;
  let srcMean = 0;
  for (const s of seeds) srcMean += phi[s];
  srcMean /= seeds.length;
  let otherMean = 0, others = 0;
  for (let i = 0; i < n; i++) if (Number.isFinite(reach[i]) && reach[i] > 0) (otherMean += phi[i]), others++;
  if (others && otherMean / others < srcMean) for (let i = 0; i < n; i++) phi[i] = -phi[i];
  // Each mesh island is solved up to its own constant: zero it at that
  // island's nearest source.
  const comp = components(n, tris);
  const base = new Map<number, number>();
  for (const s of seeds) base.set(comp[s], Math.min(base.get(comp[s]) ?? Infinity, phi[s]));
  const distance = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const b = base.get(comp[i]);
    distance[i] = Number.isFinite(reach[i]) && b !== undefined ? Math.max(0, phi[i] - b) : -1;
  }
  for (const s of seeds) distance[s] = 0;
  return { distance, method: "heat" };
}

/** Connected component per point through the triangles (union-find). */
function components(n: number, tris: number[]): Int32Array {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let t = 0; t < tris.length; t += 3) {
    const a = find(tris[t]);
    for (let k = 1; k < 3; k++) {
      const b = find(tris[t + k]);
      if (a !== b) parent[b] = a;
    }
  }
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) out[i] = find(i);
  return out;
}
