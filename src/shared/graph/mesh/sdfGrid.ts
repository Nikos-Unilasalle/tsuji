import type { PolyMesh } from "../quadMesh";
import { boxProjectUVs } from "../quadMesh";
import { valueNoise3 } from "../../math/valueNoise";
import { meshTriangles } from "./selectOps";

/*
 * Signed distance grids — the value the Volume nodes pass around (phase 8 of
 * docs/parametric-modeling-plan.md).
 *
 * A grid is a dense lattice of samples, x fastest, negative inside. It
 * travels between nodes inside the `geometry` socket: the node outputs a mesh
 * of the zero iso-surface (so the volume shows in the viewport like any
 * other shape) and the grid itself rides along in `userData.sdfGrid`.
 *
 * Everything here is plain typed arrays, free of THREE and of the node system
 * so it can be tested and later moved off-thread as is.
 *
 * Distances are exact only inside a narrow band around the surface (a few
 * voxels, where the iso-surface and the blends live); further out they are
 * propagated with a 3-D chamfer pass, which overestimates by a few percent.
 * That is plenty for offsets, smooth unions and remeshing, and keeps a 128³
 * mesh conversion at triangles × band-voxels rather than voxels × triangles.
 */

export interface SdfGrid {
  /** Sample counts along x, y, z. */
  dims: [number, number, number];
  /** World (local-space) position of sample (0, 0, 0). */
  origin: [number, number, number];
  /** Spacing between samples, the same on every axis. */
  voxel: number;
  /** dims[0] * dims[1] * dims[2] signed distances, x fastest, negative inside. */
  values: Float32Array;
}

/** 128³: past this a rebuild stops being a pause and starts being a hang. */
export const MAX_SDF_SAMPLES = 128 * 128 * 128;
/** No axis longer than this, whatever the aspect ratio. */
export const MAX_SDF_DIM = 256;

export type Vec3 = [number, number, number];

/** True when `v` is a structurally sound grid (every node checks before trusting userData). */
export function isSdfGrid(v: unknown): v is SdfGrid {
  if (!v || typeof v !== "object") return false;
  const g = v as Partial<SdfGrid>;
  if (!Array.isArray(g.dims) || g.dims.length !== 3 || !Array.isArray(g.origin) || g.origin.length !== 3) return false;
  if (!(g.values instanceof Float32Array) || !(typeof g.voxel === "number" && g.voxel > 0 && Number.isFinite(g.voxel))) return false;
  const [nx, ny, nz] = g.dims;
  if (![nx, ny, nz].every((n) => Number.isInteger(n) && n >= 2)) return false;
  if (!g.origin.every((n) => Number.isFinite(n))) return false;
  return g.values.length === nx * ny * nz;
}

export function sdfSampleCount(grid: Pick<SdfGrid, "dims">): number {
  return grid.dims[0] * grid.dims[1] * grid.dims[2];
}

export interface GridPlan {
  dims: [number, number, number];
  origin: [number, number, number];
  voxel: number;
  /** The voxel had to grow to stay under MAX_SDF_SAMPLES. */
  capped: boolean;
}

/**
 * The lattice covering [min, max] plus `padding` (world units) plus two
 * spare voxels on every side — the outermost samples must be outside the
 * shape or the surface is clipped flat against the grid.
 *
 * `voxel` wins when positive; otherwise `resolution` cells span the longest
 * side. The voxel grows (never the cap) when the result would be too big.
 */
export function planGrid(min: readonly number[], max: readonly number[], opts: { voxel?: number; resolution?: number; padding?: number }): GridPlan {
  const lo = [0, 1, 2].map((k) => (Number.isFinite(min[k]) ? min[k] : 0));
  const hi = [0, 1, 2].map((k) => (Number.isFinite(max[k]) ? Math.max(max[k], lo[k]) : lo[k]));
  const pad = Math.max(0, Number.isFinite(opts.padding) ? (opts.padding as number) : 0);
  const ext = [0, 1, 2].map((k) => hi[k] - lo[k] + 2 * pad);
  const longest = Math.max(ext[0], ext[1], ext[2], 1e-6);
  let voxel = opts.voxel && opts.voxel > 0 && Number.isFinite(opts.voxel) ? opts.voxel : longest / Math.max(2, Math.min(512, Math.round(opts.resolution ?? 32)));
  // A voxel far smaller than the shape would ask for billions of samples
  // before the cap loop below brings it back: start it at a sane floor.
  voxel = Math.max(voxel, longest / 4096);
  let capped = false;
  let dims: [number, number, number] = [0, 0, 0];
  for (let guard = 0; guard < 200; guard++) {
    dims = ext.map((e) => Math.max(3, Math.ceil(e / voxel) + 1 + 4)) as [number, number, number];
    if (dims[0] * dims[1] * dims[2] <= MAX_SDF_SAMPLES && Math.max(...dims) <= MAX_SDF_DIM) break;
    voxel *= 1.08;
    capped = true;
  }
  const origin = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2 - ((dims[k] - 1) * voxel) / 2) as [number, number, number];
  return { dims, origin, voxel, capped };
}

export function emptyGrid(plan: Pick<GridPlan, "dims" | "origin" | "voxel">, fill = 0): SdfGrid {
  return { dims: [...plan.dims], origin: [...plan.origin], voxel: plan.voxel, values: new Float32Array(plan.dims[0] * plan.dims[1] * plan.dims[2]).fill(fill) };
}

/** The grid's [min, max] box. */
export function gridBounds(grid: Pick<SdfGrid, "dims" | "origin" | "voxel">): { min: Vec3; max: Vec3 } {
  const min = [...grid.origin] as Vec3;
  const max = [0, 1, 2].map((k) => grid.origin[k] + (grid.dims[k] - 1) * grid.voxel) as Vec3;
  return { min, max };
}

/**
 * Trilinear sample. Outside the grid the boundary value plus the distance to
 * the box is returned — a conservative "outside" that keeps unions and
 * resampling continuous instead of clamping to a constant.
 */
export function sampleSdf(grid: SdfGrid, x: number, y: number, z: number): number {
  const [nx, ny, nz] = grid.dims;
  const inv = 1 / grid.voxel;
  let fx = (x - grid.origin[0]) * inv;
  let fy = (y - grid.origin[1]) * inv;
  let fz = (z - grid.origin[2]) * inv;
  let outside = 0;
  if (fx < 0 || fx > nx - 1 || fy < 0 || fy > ny - 1 || fz < 0 || fz > nz - 1) {
    const cx = Math.min(Math.max(fx, 0), nx - 1);
    const cy = Math.min(Math.max(fy, 0), ny - 1);
    const cz = Math.min(Math.max(fz, 0), nz - 1);
    outside = Math.hypot(fx - cx, fy - cy, fz - cz) * grid.voxel;
    fx = cx;
    fy = cy;
    fz = cz;
  }
  const x0 = Math.min(Math.floor(fx), nx - 2);
  const y0 = Math.min(Math.floor(fy), ny - 2);
  const z0 = Math.min(Math.floor(fz), nz - 2);
  const tx = fx - x0, ty = fy - y0, tz = fz - z0;
  const v = grid.values;
  const sxy = nx * ny;
  const i = x0 + nx * y0 + sxy * z0;
  const c00 = v[i] + (v[i + 1] - v[i]) * tx;
  const c10 = v[i + nx] + (v[i + nx + 1] - v[i + nx]) * tx;
  const c01 = v[i + sxy] + (v[i + sxy + 1] - v[i + sxy]) * tx;
  const c11 = v[i + sxy + nx] + (v[i + sxy + nx + 1] - v[i + sxy + nx]) * tx;
  const c0 = c00 + (c10 - c00) * ty;
  const c1 = c01 + (c11 - c01) * ty;
  const value = c0 + (c1 - c0) * tz;
  return Number.isFinite(value) ? value + outside : outside;
}

/** Central-difference gradient (not normalised). */
export function sdfGradient(grid: SdfGrid, x: number, y: number, z: number): Vec3 {
  const h = grid.voxel * 0.5;
  return [
    (sampleSdf(grid, x + h, y, z) - sampleSdf(grid, x - h, y, z)) / (2 * h),
    (sampleSdf(grid, x, y + h, z) - sampleSdf(grid, x, y - h, z)) / (2 * h),
    (sampleSdf(grid, x, y, z + h) - sampleSdf(grid, x, y, z - h)) / (2 * h),
  ];
}

/** Volume enclosed (voxels below `iso` × voxel³) — what the tests compare. */
export function sdfInsideVolume(grid: SdfGrid, iso = 0): number {
  let n = 0;
  for (let i = 0; i < grid.values.length; i++) if (grid.values[i] < iso) n++;
  return n * grid.voxel ** 3;
}

// ================================================================ distance propagation

/**
 * Two-pass 3-D chamfer over magnitudes, in place: every sample ends at most
 * (neighbour + step length) for its 26 neighbours. Exact samples near the
 * surface are never raised (the true distance obeys the same inequality), so
 * this only fills what the narrow band left at Infinity.
 */
export function chamferExtend(mag: Float32Array, dims: readonly number[], voxel: number): void {
  const [nx, ny, nz] = dims;
  const sxy = nx * ny;
  const w1 = voxel, w2 = voxel * Math.SQRT2, w3 = voxel * Math.sqrt(3);
  // Neighbours that come earlier in scan order (dz, dy, dx), with weights.
  const back: [number, number, number, number][] = [];
  for (let dz = -1; dz <= 0; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dz === 0 && (dy > 0 || (dy === 0 && dx >= 0))) continue;
        const n = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        back.push([dx, dy, dz, n === 1 ? w1 : n === 2 ? w2 : w3]);
      }
  const offs = Int32Array.from(back, ([dx, dy, dz]) => dx + nx * dy + sxy * dz);
  const ws = Float32Array.from(back, (b) => b[3]);
  const m = back.length;
  const pass = (forward: boolean) => {
    const s = forward ? 1 : -1;
    for (let zi = 0; zi < nz; zi++) {
      const z = forward ? zi : nz - 1 - zi;
      for (let yi = 0; yi < ny; yi++) {
        const y = forward ? yi : ny - 1 - yi;
        // Interior rows skip the bounds checks: that is nearly every sample.
        const interiorRow = z > 0 && z < nz - 1 && y > 0 && y < ny - 1;
        for (let xi = 0; xi < nx; xi++) {
          const x = forward ? xi : nx - 1 - xi;
          const i = x + nx * y + sxy * z;
          let best = mag[i];
          if (interiorRow && x > 0 && x < nx - 1) {
            for (let q = 0; q < m; q++) {
              const c = mag[i + s * offs[q]] + ws[q];
              if (c < best) best = c;
            }
          } else {
            for (const [dx, dy, dz, w] of back) {
              const xx = x + dx * s, yy = y + dy * s, zz = z + dz * s;
              if (xx < 0 || yy < 0 || zz < 0 || xx >= nx || yy >= ny || zz >= nz) continue;
              const c = mag[xx + nx * yy + sxy * zz] + w;
              if (c < best) best = c;
            }
          }
          mag[i] = best;
        }
      }
    }
  };
  pass(true);
  pass(false);
  // A grid with no seed at all stays Infinity: give it something finite.
  const far = Math.hypot(nx, ny, nz) * voxel;
  for (let i = 0; i < mag.length; i++) if (!Number.isFinite(mag[i])) mag[i] = far;
}

// ================================================================ mesh → SDF

/** Squared distance from p to triangle abc (Ericson 5.1.5), allocation-free. */
export function pointTriangleDistSq(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx: number, qy: number, qz: number;
  if (d1 <= 0 && d2 <= 0) {
    qx = ax; qy = ay; qz = az;
  } else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) {
      qx = bx; qy = by; qz = bz;
    } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        qx = ax + abx * v; qy = ay + aby * v; qz = az + abz * v;
      } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) {
          qx = cx; qy = cy; qz = cz;
        } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            qx = ax + acx * w; qy = ay + acy * w; qz = az + acz * w;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
              qx = bx + (cx - bx) * w; qy = by + (cy - by) * w; qz = bz + (cz - bz) * w;
            } else {
              const denom = 1 / (va + vb + vc);
              const v = vb * denom, w = vc * denom;
              qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

export interface MeshToSdfOptions {
  voxel?: number;
  /** Cells along the longest side when `voxel` is 0. */
  resolution?: number;
  /** Extra room around the mesh, world units. */
  padding?: number;
  /** Exact-distance band, in voxels (≥ 1.5). */
  band?: number;
  /**
   * "solid": inside/outside from the mesh (needs a closed mesh). "shell":
   * unsigned distance minus `thickness` — open meshes (a plane, a ribbon)
   * become a thin solid instead of nonsense.
   */
  sign?: "solid" | "shell";
  thickness?: number;
}

/**
 * Signed distance to a mesh. Magnitude: exact closest-point distance within
 * the band (each triangle splatted into the voxels near it), chamfer beyond.
 * Sign: ray parity along x, y and z, majority vote — three independent rays
 * agree on any closed mesh and outvote each other where one slips through a
 * small hole or grazes an edge. Band voxels the rays disagree on are settled
 * by the generalised winding number when that is affordable.
 */
export function meshToSdf(mesh: PolyMesh, opts: MeshToSdfOptions = {}): { grid: SdfGrid; capped: boolean } | null {
  const { coords } = meshTriangles(mesh);
  const triCount = coords.length / 9;
  if (triCount === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < coords.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const c = coords[i + k];
      if (!Number.isFinite(c)) continue;
      if (c < min[k]) min[k] = c;
      if (c > max[k]) max[k] = c;
    }
  }
  if (!Number.isFinite(min[0])) return null;
  const shell = opts.sign === "shell";
  const thickness = Math.max(0, opts.thickness ?? 0);
  const plan = planGrid(min, max, { voxel: opts.voxel, resolution: opts.resolution, padding: (opts.padding ?? 0) + (shell ? thickness : 0) });
  const grid = emptyGrid(plan, Infinity);
  const [nx, ny, nz] = grid.dims;
  const sxy = nx * ny;
  const { voxel, origin } = grid;
  const bandVoxels = Math.max(1.5, opts.band ?? 3) + (shell ? thickness / voxel : 0);
  const bandW = bandVoxels * voxel;
  const mag = grid.values;

  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const ax = coords[o], ay = coords[o + 1], az = coords[o + 2];
    const bx = coords[o + 3], by = coords[o + 4], bz = coords[o + 5];
    const cx = coords[o + 6], cy = coords[o + 7], cz = coords[o + 8];
    if (![ax, ay, az, bx, by, bz, cx, cy, cz].every(Number.isFinite)) continue;
    const lo = [Math.min(ax, bx, cx), Math.min(ay, by, cy), Math.min(az, bz, cz)];
    const hi = [Math.max(ax, bx, cx), Math.max(ay, by, cy), Math.max(az, bz, cz)];
    const i0 = Math.max(0, Math.floor((lo[0] - bandW - origin[0]) / voxel));
    const i1 = Math.min(nx - 1, Math.ceil((hi[0] + bandW - origin[0]) / voxel));
    const j0 = Math.max(0, Math.floor((lo[1] - bandW - origin[1]) / voxel));
    const j1 = Math.min(ny - 1, Math.ceil((hi[1] + bandW - origin[1]) / voxel));
    const k0 = Math.max(0, Math.floor((lo[2] - bandW - origin[2]) / voxel));
    const k1 = Math.min(nz - 1, Math.ceil((hi[2] + bandW - origin[2]) / voxel));
    for (let k = k0; k <= k1; k++) {
      const pz = origin[2] + k * voxel;
      for (let j = j0; j <= j1; j++) {
        const py = origin[1] + j * voxel;
        for (let i = i0; i <= i1; i++) {
          const px = origin[0] + i * voxel;
          const d2 = pointTriangleDistSq(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz);
          if (d2 > bandW * bandW) continue;
          const idx = i + nx * j + sxy * k;
          const d = Math.sqrt(d2);
          if (d < mag[idx]) mag[idx] = d;
        }
      }
    }
  }
  chamferExtend(mag, grid.dims, voxel);

  if (shell) {
    for (let i = 0; i < mag.length; i++) mag[i] = mag[i] - thickness;
    return { grid, capped: plan.capped };
  }

  const votes = new Uint8Array(mag.length);
  for (let axis = 0; axis < 3; axis++) parityVotes(coords, grid, axis, votes);

  // Settle the band samples the rays disagree on with the winding number,
  // when the bill (samples × triangles) is small enough to pay in one build.
  const ambiguous: number[] = [];
  for (let i = 0; i < votes.length; i++) if ((votes[i] === 1 || votes[i] === 2) && mag[i] <= bandW) ambiguous.push(i);
  let winding: ((x: number, y: number, z: number) => number) | null = null;
  if (ambiguous.length && ambiguous.length * triCount <= 3e7) winding = windingNumber(coords);
  if (winding) {
    for (const idx of ambiguous) {
      const i = idx % nx, j = Math.floor(idx / nx) % ny, k = Math.floor(idx / sxy);
      votes[idx] = winding(origin[0] + i * voxel, origin[1] + j * voxel, origin[2] + k * voxel) > 0.5 ? 3 : 0;
    }
  }
  for (let i = 0; i < mag.length; i++) if (votes[i] >= 2) mag[i] = -mag[i];
  return { grid, capped: plan.capped };
}

/**
 * Adds 1 to `votes` for every sample an axis-aligned ray finds inside (odd
 * number of crossings before it). The rays run through the sample rows,
 * nudged by an irrational fraction of a voxel so they never pass exactly
 * through a mesh edge or vertex (which would count it twice or not at all).
 */
function parityVotes(coords: Float64Array, grid: SdfGrid, axis: number, votes: Uint8Array): void {
  const [nx, ny, nz] = grid.dims;
  const dims = [nx, ny, nz];
  const b = (axis + 1) % 3, c = (axis + 2) % 3;
  const nb = dims[b], nc = dims[c], na = dims[axis];
  const { voxel, origin } = grid;
  const eb = voxel * 1.234567e-4, ec = voxel * 7.654321e-5;
  const rows = new Map<number, number[]>();
  const n = coords.length / 9;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const pa = [coords[o + axis], coords[o + 3 + axis], coords[o + 6 + axis]];
    const pb = [coords[o + b], coords[o + 3 + b], coords[o + 6 + b]];
    const pc = [coords[o + c], coords[o + 3 + c], coords[o + 6 + c]];
    if (![...pa, ...pb, ...pc].every(Number.isFinite)) continue;
    const area = (pb[1] - pb[0]) * (pc[2] - pc[0]) - (pb[2] - pb[0]) * (pc[1] - pc[0]);
    if (Math.abs(area) < 1e-18) continue; // seen edge-on: the ray never crosses it
    const j0 = Math.max(0, Math.ceil((Math.min(...pb) - origin[b] - eb) / voxel));
    const j1 = Math.min(nb - 1, Math.floor((Math.max(...pb) - origin[b] - eb) / voxel));
    const k0 = Math.max(0, Math.ceil((Math.min(...pc) - origin[c] - ec) / voxel));
    const k1 = Math.min(nc - 1, Math.floor((Math.max(...pc) - origin[c] - ec) / voxel));
    for (let k = k0; k <= k1; k++) {
      const qc = origin[c] + k * voxel + ec;
      for (let j = j0; j <= j1; j++) {
        const qb = origin[b] + j * voxel + eb;
        // Barycentrics in the (b, c) projection.
        const w0 = ((pb[1] - qb) * (pc[2] - qc) - (pb[2] - qb) * (pc[1] - qc)) / area;
        const w1 = ((pb[2] - qb) * (pc[0] - qc) - (pb[0] - qb) * (pc[2] - qc)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const hit = w0 * pa[0] + w1 * pa[1] + w2 * pa[2];
        const key = j + nb * k;
        let list = rows.get(key);
        if (!list) rows.set(key, (list = []));
        list.push(hit);
      }
    }
  }
  const stride = [1, nx, nx * ny];
  for (const [key, list] of rows) {
    list.sort((x, y) => x - y);
    const j = key % nb, k = Math.floor(key / nb);
    let ptr = 0;
    for (let i = 0; i < na; i++) {
      const pos = origin[axis] + i * voxel;
      while (ptr < list.length && list[ptr] < pos) ptr++;
      if (ptr & 1) votes[i * stride[axis] + j * stride[b] + k * stride[c]]++;
    }
  }
}

/** Generalised winding number (Jacobson 2013): ~1 inside a closed mesh, ~0 outside. */
function windingNumber(coords: Float64Array): (x: number, y: number, z: number) => number {
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
      const s = 2 * Math.atan2(det, div);
      if (Number.isFinite(s)) total += s;
    }
    return total / (4 * Math.PI);
  };
}

// ================================================================ points → SDF

/**
 * Union of spheres, one per point (xyz flat, radius per point). Exact
 * within the band, chamfer beyond — outside every sphere's reach is always
 * outside, so no sign pass is needed.
 */
export function pointsToSdf(
  points: ArrayLike<number>,
  radii: ArrayLike<number>,
  opts: { voxel?: number; resolution?: number; padding?: number; band?: number } = {},
): { grid: SdfGrid; capped: boolean } | null {
  const count = Math.floor(points.length / 3);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const ok: number[] = [];
  for (let p = 0; p < count; p++) {
    const r = radii[p];
    const x = points[p * 3], y = points[p * 3 + 1], z = points[p * 3 + 2];
    if (!(r > 0) || !Number.isFinite(r) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    ok.push(p);
    min[0] = Math.min(min[0], x - r); min[1] = Math.min(min[1], y - r); min[2] = Math.min(min[2], z - r);
    max[0] = Math.max(max[0], x + r); max[1] = Math.max(max[1], y + r); max[2] = Math.max(max[2], z + r);
  }
  if (!ok.length) return null;
  const plan = planGrid(min, max, opts);
  const grid = emptyGrid(plan, Infinity);
  const [nx, ny, nz] = grid.dims;
  const sxy = nx * ny;
  const { voxel, origin } = grid;
  const bandW = Math.max(1.5, opts.band ?? 3) * voxel;
  const v = grid.values;
  for (const p of ok) {
    const r = radii[p];
    const x = points[p * 3], y = points[p * 3 + 1], z = points[p * 3 + 2];
    const reach = r + bandW;
    const i0 = Math.max(0, Math.floor((x - reach - origin[0]) / voxel)), i1 = Math.min(nx - 1, Math.ceil((x + reach - origin[0]) / voxel));
    const j0 = Math.max(0, Math.floor((y - reach - origin[1]) / voxel)), j1 = Math.min(ny - 1, Math.ceil((y + reach - origin[1]) / voxel));
    const k0 = Math.max(0, Math.floor((z - reach - origin[2]) / voxel)), k1 = Math.min(nz - 1, Math.ceil((z + reach - origin[2]) / voxel));
    for (let k = k0; k <= k1; k++) {
      const dz = origin[2] + k * voxel - z;
      for (let j = j0; j <= j1; j++) {
        const dy = origin[1] + j * voxel - y;
        for (let i = i0; i <= i1; i++) {
          const dx = origin[0] + i * voxel - x;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
          if (d > bandW) continue;
          const idx = i + nx * j + sxy * k;
          if (d < v[idx]) v[idx] = d;
        }
      }
    }
  }
  // Chamfer on magnitudes: inside samples were all written (they lie in their
  // sphere's box), so everything still Infinity is outside.
  const neg = new Uint8Array(v.length);
  for (let i = 0; i < v.length; i++) if (v[i] < 0) (neg[i] = 1), (v[i] = -v[i]);
  chamferExtend(v, grid.dims, voxel);
  for (let i = 0; i < v.length; i++) if (neg[i]) v[i] = -v[i];
  return { grid, capped: plan.capped };
}

// ================================================================ operations

export type SdfCombineOp = "union" | "subtract" | "intersect";

/** Polynomial smooth minimum (Quilez); k = blend radius, 0 = hard. */
export function smoothMin(a: number, b: number, k: number): number {
  if (!(k > 0)) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

export function smoothMax(a: number, b: number, k: number): number {
  return -smoothMin(-a, -b, k);
}

/**
 * Maps a point in A's space into B's space (B's grid was built in another
 * object's local frame). `scale` converts B's distances back to A's units.
 */
export interface SdfTransform {
  apply(x: number, y: number, z: number, out: Vec3): void;
  scale: number;
}

/** Samples `fn` at every lattice point of `plan` into a new grid. */
export function resampleGrid(plan: Pick<GridPlan, "dims" | "origin" | "voxel">, fn: (x: number, y: number, z: number) => number): SdfGrid {
  const grid = emptyGrid(plan);
  const [nx, ny, nz] = grid.dims;
  let idx = 0;
  for (let k = 0; k < nz; k++) {
    const z = grid.origin[2] + k * grid.voxel;
    for (let j = 0; j < ny; j++) {
      const y = grid.origin[1] + j * grid.voxel;
      for (let i = 0; i < nx; i++) {
        const value = fn(grid.origin[0] + i * grid.voxel, y, z);
        grid.values[idx++] = Number.isFinite(value) ? value : 0;
      }
    }
  }
  return grid;
}

function transformedBounds(grid: SdfGrid, toA: ((p: Vec3) => Vec3) | null): { min: Vec3; max: Vec3 } {
  const { min, max } = gridBounds(grid);
  if (!toA) return { min, max };
  const out = { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3 };
  for (let c = 0; c < 8; c++) {
    const p = toA([c & 1 ? max[0] : min[0], c & 2 ? max[1] : min[1], c & 4 ? max[2] : min[2]]);
    for (let k = 0; k < 3; k++) {
      out.min[k] = Math.min(out.min[k], p[k]);
      out.max[k] = Math.max(out.max[k], p[k]);
    }
  }
  return out;
}

/**
 * A ∪ / − / ∩ B with a smooth blend of radius `k`, on a fresh grid: the
 * union covers both boxes, the others only A's (nothing outside A survives).
 * `bToA`/`aToB` move points between the two grids' frames when they differ.
 */
export function combineSdf(
  a: SdfGrid,
  b: SdfGrid,
  op: SdfCombineOp,
  k: number,
  frames?: { aToB: SdfTransform; bToA: (p: Vec3) => Vec3 },
): { grid: SdfGrid; capped: boolean } {
  const blend = Math.max(0, Number.isFinite(k) ? k : 0);
  const boxA = gridBounds(a);
  let min = boxA.min, max = boxA.max;
  if (op === "union") {
    const boxB = transformedBounds(b, frames?.bToA ?? null);
    min = [0, 1, 2].map((i) => Math.min(boxA.min[i], boxB.min[i])) as Vec3;
    max = [0, 1, 2].map((i) => Math.max(boxA.max[i], boxB.max[i])) as Vec3;
  }
  // B's voxel measured in A's units.
  const voxel = Math.min(a.voxel, b.voxel * (frames?.aToB.scale ?? 1));
  // A smooth union bulges up to k/4 past both shapes.
  const plan = planGrid(min, max, { voxel, padding: blend * 0.25 });
  const q: Vec3 = [0, 0, 0];
  const grid = resampleGrid(plan, (x, y, z) => {
    const da = sampleSdf(a, x, y, z);
    let db: number;
    if (frames) {
      frames.aToB.apply(x, y, z, q);
      db = sampleSdf(b, q[0], q[1], q[2]) * frames.aToB.scale;
    } else db = sampleSdf(b, x, y, z);
    if (op === "subtract") return smoothMax(da, -db, blend);
    if (op === "intersect") return smoothMax(da, db, blend);
    return smoothMin(da, db, blend);
  });
  return { grid, capped: plan.capped };
}

/** Dilates (distance > 0) or erodes (< 0) — the grid grows to keep a dilated surface inside it. */
export function offsetSdf(src: SdfGrid, distance: number): { grid: SdfGrid; capped: boolean } {
  const d = Number.isFinite(distance) ? distance : 0;
  const { min, max } = gridBounds(src);
  const plan = planGrid(min, max, { voxel: src.voxel, padding: Math.max(0, d) });
  return { grid: resampleGrid(plan, (x, y, z) => sampleSdf(src, x, y, z) - d), capped: plan.capped };
}

/** `iterations` passes of a separable [1 2 1]/4 blur — rounds edges, removes voxel noise. */
export function smoothSdf(src: SdfGrid, iterations: number): SdfGrid {
  const n = Math.max(0, Math.min(50, Math.round(iterations)));
  const [nx, ny, nz] = src.dims;
  let cur = Float32Array.from(src.values);
  let next = new Float32Array(cur.length);
  const strides = [1, nx, nx * ny];
  const dims = [nx, ny, nz];
  for (let it = 0; it < n; it++) {
    for (let axis = 0; axis < 3; axis++) {
      const s = strides[axis];
      const len = dims[axis];
      for (let idx = 0; idx < cur.length; idx++) {
        const coord = Math.floor(idx / s) % len;
        const lo = coord > 0 ? cur[idx - s] : cur[idx];
        const hi = coord < len - 1 ? cur[idx + s] : cur[idx];
        next[idx] = 0.25 * lo + 0.5 * cur[idx] + 0.25 * hi;
      }
      const t = cur;
      cur = next;
      next = t;
    }
  }
  return { dims: [...src.dims], origin: [...src.origin], voxel: src.voxel, values: cur };
}

/**
 * Adds 3-D value noise to the distances (zero-mean, ±amplitude). The grid
 * grows by the amplitude so bumps pushed outward are not clipped.
 */
export function noiseSdf(
  src: SdfGrid,
  opts: { amplitude: number; frequency: number; octaves?: number; seed?: number; offset?: readonly number[] },
): { grid: SdfGrid; capped: boolean } {
  const amp = Number.isFinite(opts.amplitude) ? opts.amplitude : 0;
  const freq = Number.isFinite(opts.frequency) && opts.frequency > 0 ? opts.frequency : 1;
  const oct = Math.max(1, Math.min(8, Math.round(opts.octaves ?? 3)));
  const seed = Number.isFinite(opts.seed) ? (opts.seed as number) : 0;
  const off = [0, 1, 2].map((k) => (Number.isFinite(opts.offset?.[k]) ? (opts.offset![k] as number) : 0));
  // valueNoise3's mean depends on the octave count; normalise to ±1.
  let norm = 0;
  for (let i = 0, a = 0.5; i < oct; i++, a *= 0.5) norm += a;
  const { min, max } = gridBounds(src);
  const plan = planGrid(min, max, { voxel: src.voxel, padding: Math.abs(amp) });
  const sx = seed * 31.7 + off[0], sy = seed * 17.3 + off[1], sz = seed * 23.9 + off[2];
  const grid = resampleGrid(plan, (x, y, z) => {
    const n = valueNoise3(x * freq + sx, y * freq + sy, z * freq + sz, oct) / norm; // ~[0, 1]
    return sampleSdf(src, x, y, z) + (n * 2 - 1) * amp;
  });
  return { grid, capped: plan.capped };
}

/** Moves a grid by a world offset (no resampling). */
export function translateSdf(src: SdfGrid, offset: readonly number[]): SdfGrid {
  return { ...src, origin: [src.origin[0] + offset[0], src.origin[1] + offset[1], src.origin[2] + offset[2]] };
}

// ================================================================ SDF → mesh

const CORNERS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
const EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];
const OTHER_AXES: ReadonlyArray<readonly [number, number]> = [[1, 2], [2, 0], [0, 1]];

/**
 * The iso-surface as a quad PolyMesh, by naive Surface Nets (the algorithm
 * three/sdf/surfaceNets.ts uses for Weld, here emitting quads instead of
 * triangle pairs): one vertex per cell the surface crosses, at the mean of
 * the cell's edge crossings, one quad per crossed lattice edge.
 *
 * `relax` passes of Laplacian smoothing follow, each pulled back onto the
 * iso-surface along the gradient so smoothing evens the quads out without
 * shrinking the shape.
 */
export function sdfToPolyMesh(grid: SdfGrid, opts: { iso?: number; relax?: number; uvs?: boolean } = {}): PolyMesh {
  const iso = Number.isFinite(opts.iso) ? (opts.iso as number) : 0;
  const [nx, ny, nz] = grid.dims;
  const { voxel, origin } = grid;
  const field = grid.values;
  const sxy = nx * ny;
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const positions: Vec3[] = [];
  const faces: number[][] = [];
  if (cx < 1 || cy < 1 || cz < 1) return { positions, faces };
  const value = (i: number) => {
    const v = field[i] - iso;
    return Number.isFinite(v) ? v : 1;
  };

  const cellVertex = new Int32Array(cx * cy * cz).fill(-1);
  const cellIndex = (x: number, y: number, z: number) => x + cx * (y + cy * z);
  const corner = new Float64Array(8);
  for (let z = 0; z < cz; z++) {
    for (let y = 0; y < cy; y++) {
      for (let x = 0; x < cx; x++) {
        let neg = 0;
        for (let c = 0; c < 8; c++) {
          const [dx, dy, dz] = CORNERS[c];
          const v = value(x + dx + nx * (y + dy) + sxy * (z + dz));
          corner[c] = v;
          if (v < 0) neg++;
        }
        if (neg === 0 || neg === 8) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of EDGES) {
          const va = corner[a], vb = corner[b];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          const ca = CORNERS[a], cb = CORNERS[b];
          sx += ca[0] + (cb[0] - ca[0]) * t;
          sy += ca[1] + (cb[1] - ca[1]) * t;
          sz += ca[2] + (cb[2] - ca[2]) * t;
          n++;
        }
        cellVertex[cellIndex(x, y, z)] = positions.length;
        positions.push([origin[0] + (x + sx / n) * voxel, origin[1] + (y + sy / n) * voxel, origin[2] + (z + sz / n) * voxel]);
      }
    }
  }
  if (!positions.length) return { positions, faces };

  const s = [0, 0, 0];
  const cell = [0, 0, 0];
  const cellLimit = [cx, cy, cz];
  const sampleLimit = [nx, ny, nz];
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        s[0] = x; s[1] = y; s[2] = z;
        const here = value(x + nx * y + sxy * z);
        for (let axis = 0; axis < 3; axis++) {
          if (s[axis] + 1 >= sampleLimit[axis]) continue;
          const [u, v] = OTHER_AXES[axis];
          if (s[u] < 1 || s[u] > cellLimit[u] - 1 || s[v] < 1 || s[v] > cellLimit[v] - 1) continue;
          s[axis] += 1;
          const there = value(s[0] + nx * s[1] + sxy * s[2]);
          s[axis] -= 1;
          if (here < 0 === there < 0) continue;
          cell[0] = s[0]; cell[1] = s[1]; cell[2] = s[2];
          cell[u] -= 1; cell[v] -= 1;
          const v00 = cellVertex[cellIndex(cell[0], cell[1], cell[2])];
          cell[u] += 1;
          const v10 = cellVertex[cellIndex(cell[0], cell[1], cell[2])];
          cell[v] += 1;
          const v11 = cellVertex[cellIndex(cell[0], cell[1], cell[2])];
          cell[u] -= 1;
          const v01 = cellVertex[cellIndex(cell[0], cell[1], cell[2])];
          if (v00 < 0 || v10 < 0 || v11 < 0 || v01 < 0) continue;
          // Wound to face from inside to outside whichever end is solid.
          faces.push(here < 0 ? [v00, v10, v11, v01] : [v00, v01, v11, v10]);
        }
      }
    }
  }

  const relax = Math.max(0, Math.min(20, Math.round(opts.relax ?? 0)));
  if (relax > 0) relaxOntoSurface(positions, faces, grid, iso, relax);
  const mesh: PolyMesh = { positions, faces };
  return opts.uvs === false ? mesh : boxProjectUVs(mesh);
}

function relaxOntoSurface(positions: Vec3[], faces: number[][], grid: SdfGrid, iso: number, passes: number): void {
  const nb: Set<number>[] = positions.map(() => new Set<number>());
  for (const f of faces)
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      nb[a].add(b);
      nb[b].add(a);
    }
  const lists = nb.map((s) => [...s]);
  const next: Vec3[] = positions.map((p) => [p[0], p[1], p[2]]);
  const maxStep = grid.voxel;
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < positions.length; i++) {
      const list = lists[i];
      const p = positions[i];
      if (!list.length) {
        next[i] = [p[0], p[1], p[2]];
        continue;
      }
      let ax = 0, ay = 0, az = 0;
      for (const j of list) {
        ax += positions[j][0];
        ay += positions[j][1];
        az += positions[j][2];
      }
      const m = 1 / list.length;
      let x = p[0] + (ax * m - p[0]) * 0.5;
      let y = p[1] + (ay * m - p[1]) * 0.5;
      let z = p[2] + (az * m - p[2]) * 0.5;
      // One Newton step back onto the iso-surface; clamped so a flat
      // gradient (a cusp, a thin wall) cannot fling the vertex away.
      const f = sampleSdf(grid, x, y, z) - iso;
      const g = sdfGradient(grid, x, y, z);
      const g2 = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
      if (g2 > 1e-8 && Number.isFinite(f)) {
        let s = f / g2;
        const len = Math.abs(s) * Math.sqrt(g2);
        if (len > maxStep) s *= maxStep / len;
        x -= g[0] * s;
        y -= g[1] * s;
        z -= g[2] * s;
      }
      next[i] = Number.isFinite(x + y + z) ? [x, y, z] : [p[0], p[1], p[2]];
    }
    for (let i = 0; i < positions.length; i++) positions[i] = next[i];
  }
}

/**
 * A stable id per grid object, for node rebuild signatures. Grids are never
 * mutated after a node hands them out (a node that changes one builds a new
 * one), so identity is content: hashing millions of floats every frame is
 * what this avoids.
 */
const gridIds = new WeakMap<SdfGrid, number>();
let nextGridId = 1;
export function sdfSignature(grid: SdfGrid): string {
  let id = gridIds.get(grid);
  if (id === undefined) gridIds.set(grid, (id = nextGridId++));
  return `sdf#${id}`;
}
