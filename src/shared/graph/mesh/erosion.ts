/*
 * Heightfield erosion on a mesh (phase 9, HeightField Erode).
 *
 * The classic droplet and thermal models are written for raster grids; here
 * they run on the mesh's own point graph instead, so any heightfield-like
 * mesh — a Terrain, a subdivided plane, an imported scan, even a mesh with
 * irregular triangles — erodes without being resampled to a raster first
 * (and keeps its exact vertex count, topology and attributes).
 *
 * Height is the position along `up`; erosion only ever moves points along it.
 *
 *  - Hydraulic (droplets): a droplet lands on a random point and walks the
 *    steepest-descent edge. Its carrying capacity is slope × water ×
 *    capacity; below capacity it picks up soil (split between the point and
 *    its neighbours, so it carves channels rather than single-vertex pits),
 *    above it drops the excess. Water evaporates each step; a droplet that
 *    reaches a pit fills it with what it carries, one that reaches the mesh
 *    border leaves with its load.
 *  - Thermal: wherever an edge is steeper than the talus angle, material
 *    slides from the high end to the low one — peaks slump, cliffs become
 *    scree slopes.
 *
 * `flow` (water that passed each point) and `sediment` (net material
 * deposited, eroded is negative) are returned for shading and masks.
 */

export type Vec3 = [number, number, number];

export interface ErosionOptions {
  up: Vec3;
  iterations: number;
  /** Droplets per iteration. */
  droplets: number;
  /** Water each droplet starts with. */
  rain: number;
  /** Fraction of the capacity deficit picked up per step. */
  erosion: number;
  /** Fraction of the excess load dropped per step. */
  deposition: number;
  capacity: number;
  evaporation: number;
  maxSteps: number;
  /** Thermal passes per iteration. */
  thermal: number;
  /** Talus (repose) angle, degrees. */
  talus: number;
  thermalRate: number;
  seed: number;
  /** Points that may not move (border, masked out). 1 = frozen. */
  frozen?: Uint8Array;
  /** Points on the mesh border: droplets leave there. */
  border?: Uint8Array;
}

export const MAX_DROPLET_STEPS = 4_000_000;

function mulberry32(seed: number): () => number {
  let a = (Math.floor(seed * 7919) ^ 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function erodeHeightfield(
  positions: ReadonlyArray<readonly number[]>,
  neighbours: ReadonlyArray<ReadonlyArray<number>>,
  opts: ErosionOptions,
): { positions: Vec3[]; flow: Float64Array; sediment: Float64Array; steps: number; limited: boolean } {
  const n = positions.length;
  const ul = Math.hypot(...opts.up) || 1;
  const up: Vec3 = [opts.up[0] / ul, opts.up[1] / ul, opts.up[2] / ul];
  const h0 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = positions[i];
    const v = p[0] * up[0] + p[1] * up[1] + p[2] * up[2];
    h0[i] = Number.isFinite(v) ? v : 0;
  }
  const h = Float64Array.from(h0);
  const flow = new Float64Array(n);
  // Horizontal edge lengths (in the plane ⟂ up): slope is rise over run.
  const run: Float64Array[] = neighbours.map((list, i) => {
    const out = new Float64Array(list.length);
    const p = positions[i];
    list.forEach((j, k) => {
      const q = positions[j];
      const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const along = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
      const hz = Math.sqrt(Math.max(0, d[0] * d[0] + d[1] * d[1] + d[2] * d[2] - along * along));
      out[k] = hz > 1e-9 ? hz : 1e-9;
    });
    return out;
  });
  const frozen = opts.frozen;
  const border = opts.border;
  const movable = (i: number) => !frozen || !frozen[i];
  const rand = mulberry32(Number.isFinite(opts.seed) ? opts.seed : 0);

  const iterations = Math.max(0, Math.min(1000, Math.round(opts.iterations)));
  let droplets = Math.max(0, Math.round(opts.droplets));
  const maxSteps = Math.max(1, Math.min(500, Math.round(opts.maxSteps)));
  let limited = false;
  if (iterations * droplets * maxSteps > MAX_DROPLET_STEPS) {
    droplets = Math.max(1, Math.floor(MAX_DROPLET_STEPS / Math.max(1, iterations * maxSteps)));
    limited = true;
  }
  const erosion = clamp01(opts.erosion);
  const deposition = clamp01(opts.deposition);
  const evaporation = clamp01(opts.evaporation);
  const capacity = Math.max(0, finite(opts.capacity, 4));
  const rain = Math.max(0, finite(opts.rain, 1));
  const tanTalus = Math.tan((Math.max(0, Math.min(89, finite(opts.talus, 35))) * Math.PI) / 180);
  const thermalRate = clamp01(opts.thermalRate);
  const thermal = Math.max(0, Math.min(50, Math.round(opts.thermal)));
  // Typical edge run: scales the tiny minimum slope so flat land still erodes a little.
  let meanRun = 0, runCount = 0;
  for (const r of run) for (const v of r) (meanRun += v), runCount++;
  meanRun = runCount ? meanRun / runCount : 1;
  const minSlope = 0.01;

  const add = (i: number, amount: number) => {
    if (movable(i)) h[i] += amount;
  };
  /** Removes `amount` around i: half at i, half shared by its neighbours. */
  const erodeAt = (i: number, amount: number) => {
    const list = neighbours[i];
    if (!list.length) return add(i, -amount);
    add(i, -amount * 0.5);
    const share = (amount * 0.5) / list.length;
    for (const j of list) add(j, -share);
  };

  let steps = 0;
  if (n > 0) {
    for (let it = 0; it < iterations; it++) {
      for (let d = 0; d < droplets; d++) {
        let v = Math.min(n - 1, Math.floor(rand() * n));
        let water = rain;
        let load = 0;
        for (let s = 0; s < maxSteps; s++) {
          steps++;
          flow[v] += water;
          const list = neighbours[v];
          let next = -1;
          let best = 0;
          for (let k = 0; k < list.length; k++) {
            const slope = (h[v] - h[list[k]]) / run[v][k];
            if (slope > best) (best = slope), (next = k);
          }
          if (next < 0) {
            // A pit: fill it (no higher than its lowest rim) with the load.
            let rim = Infinity;
            for (const j of list) rim = Math.min(rim, h[j]);
            add(v, Number.isFinite(rim) ? Math.min(load, Math.max(0, rim - h[v])) : load);
            break;
          }
          const j = list[next];
          const drop = h[v] - h[j];
          const cap = Math.max(best, minSlope) * water * capacity * meanRun;
          if (load > cap) {
            const dep = Math.min((load - cap) * deposition, drop);
            add(v, dep);
            load -= dep;
          } else {
            // Never dig below the next point: that would make a pit the next droplet fills.
            const take = Math.min((cap - load) * erosion, drop * 0.9);
            if (movable(v)) {
              erodeAt(v, take);
              load += take;
            }
          }
          water *= 1 - evaporation;
          v = j;
          if (water < rain * 1e-3) {
            add(v, load);
            break;
          }
          if (border && border[v]) break; // carried off the edge of the map
        }
      }
      for (let t = 0; t < thermal; t++) thermalPass(h, neighbours, run, tanTalus, thermalRate, frozen);
    }
  }

  const sediment = new Float64Array(n);
  const out: Vec3[] = new Array(n);
  for (let i = 0; i < n; i++) {
    let dh = h[i] - h0[i];
    if (!Number.isFinite(dh)) dh = 0;
    sediment[i] = dh;
    const p = positions[i];
    out[i] = [p[0] + up[0] * dh, p[1] + up[1] * dh, p[2] + up[2] * dh];
  }
  return { positions: out, flow, sediment, steps, limited };
}

function thermalPass(
  h: Float64Array,
  neighbours: ReadonlyArray<ReadonlyArray<number>>,
  run: Float64Array[],
  tanTalus: number,
  rate: number,
  frozen?: Uint8Array,
): void {
  // Jacobi: every edge reads the heights of the pass start, so the result
  // doesn't depend on point order.
  const delta = new Float64Array(h.length);
  for (let i = 0; i < h.length; i++) {
    const list = neighbours[i];
    for (let k = 0; k < list.length; k++) {
      const j = list[k];
      if (j <= i) continue; // each edge once
      const diff = h[i] - h[j];
      const excess = Math.abs(diff) - tanTalus * run[i][k];
      if (excess <= 0) continue;
      const hi = diff > 0 ? i : j, lo = diff > 0 ? j : i;
      if (frozen && (frozen[hi] || frozen[lo])) continue;
      // Divided by valence so a point with many steep edges can't overshoot.
      const move = (rate * excess * 0.5) / Math.max(neighbours[hi].length, 1);
      delta[hi] -= move;
      delta[lo] += move;
    }
  }
  for (let i = 0; i < h.length; i++) h[i] += delta[i];
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

function finite(v: number, fb: number): number {
  return Number.isFinite(v) ? v : fb;
}
