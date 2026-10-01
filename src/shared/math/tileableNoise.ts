/**
 * Tileable 3D noise after Sébastien Hillaire's TileableVolumeNoise (the cloud
 * noise of "Physically Based Sky, Atmosphere and Cloud Rendering in
 * Frostbite", SIGGRAPH 2016) — Perlin, Worley, Perlin-Worley and the two
 * GPU Pro 7 cloud textures, all periodic over the unit cube.
 *
 * This is the CPU twin of `three/shaders/tileableNoiseGlsl.ts`: same integer
 * hash, same lattice wrap, same channel recipes, line for line. The GPU copy
 * is what renders; this one is the spec the tests hold it to, and a sampler
 * for anything that needs a value on the CPU.
 *
 * Tiling comes from the lattice, not from blending: every cell index is taken
 * modulo an integer period before it is hashed, so cell `period` *is* cell 0.
 * That is why every frequency here is rounded to an integer — a fractional one
 * would leave a seam.
 *
 * The original hashes with `fract(sin(n) * 43758.5)`, whose precision on a GPU
 * varies by vendor; PCG3D (Jarzynski & Olano, JCGT 2020) is pure integer math,
 * so both twins agree bit for bit on the lattice.
 */

export const TILEABLE_PATTERNS = ["perlin", "worley", "perlin-worley", "cloud-shape", "cloud-detail"] as const;
export type TileablePattern = (typeof TILEABLE_PATTERNS)[number];

export const TILEABLE_PATTERN_LABELS: Record<TileablePattern, string> = {
  perlin: "Perlin (fBm)",
  worley: "Worley (fBm)",
  "perlin-worley": "Perlin-Worley",
  "cloud-shape": "Cloud Shape (GPU Pro 7)",
  "cloud-detail": "Cloud Detail (GPU Pro 7)",
};

/** Base frequency each pattern was tuned at in the original tool — cells across one tile. */
export const TILEABLE_DEFAULT_FREQUENCY: Record<TileablePattern, number> = {
  perlin: 4,
  worley: 4,
  "perlin-worley": 4,
  "cloud-shape": 4,
  "cloud-detail": 2,
};

export const MAX_TILEABLE_OCTAVES = 8;

export interface TileableSettings {
  pattern: TileablePattern;
  /** Cells across one tile, per axis. Rounded to whole numbers, at least 1. */
  frequency: [number, number, number];
  /** Packed single value, or four channels (RGBA). */
  channels: boolean;
  octaves: number;
  gain: number;
  seed: number;
}

export function asTileablePattern(value: unknown): TileablePattern {
  return (TILEABLE_PATTERNS as readonly string[]).includes(String(value)) ? (value as TileablePattern) : "perlin";
}

/** Whole cells per tile — the one invariant tiling depends on. */
export function tileFrequency(value: unknown, fallback = 4): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(1, Math.min(256, n)) : fallback;
}

// ---------------------------------------------------------------- hash

/** PCG3D on three uint32 lanes; returns the top 24 bits of each lane as [0, 1). */
function hash3(x: number, y: number, z: number, seed: number, out: Float64Array): Float64Array {
  let vx = (Math.imul(x + Math.imul(seed, 65536), 1664525) + 1013904223) >>> 0;
  let vy = (Math.imul(y, 1664525) + 1013904223) >>> 0;
  let vz = (Math.imul(z, 1664525) + 1013904223) >>> 0;
  vx = (vx + Math.imul(vy, vz)) >>> 0;
  vy = (vy + Math.imul(vz, vx)) >>> 0;
  vz = (vz + Math.imul(vx, vy)) >>> 0;
  vx = (vx ^ (vx >>> 16)) >>> 0;
  vy = (vy ^ (vy >>> 16)) >>> 0;
  vz = (vz ^ (vz >>> 16)) >>> 0;
  vx = (vx + Math.imul(vy, vz)) >>> 0;
  vy = (vy + Math.imul(vz, vx)) >>> 0;
  vz = (vz + Math.imul(vx, vy)) >>> 0;
  out[0] = (vx >>> 8) / 16777215;
  out[1] = (vy >>> 8) / 16777215;
  out[2] = (vz >>> 8) / 16777215;
  return out;
}

const wrap = (i: number, period: number) => ((i % period) + period) % period;

// ---------------------------------------------------------------- primitives

/**
 * Gradient noise is ~±0.5 for unit-cube gradients; this spreads it over
 * [0, 1] without clipping more than the far tails. Must match the GLSL.
 */
export const PERLIN_RANGE = 1.4;

const g = new Float64Array(3);

function corner(ix: number, iy: number, iz: number, fx: number, fy: number, fz: number, seed: number): number {
  hash3(ix, iy, iz, seed, g);
  return (g[0] * 2 - 1) * fx + (g[1] * 2 - 1) * fy + (g[2] * 2 - 1) * fz;
}

/** Tileable gradient noise at lattice coordinate `p`, period in cells. Roughly [-0.6, 0.6]. */
export function tileablePerlin(px: number, py: number, pz: number, period: [number, number, number], seed = 0): number {
  const x0 = Math.floor(px), y0 = Math.floor(py), z0 = Math.floor(pz);
  const fx = px - x0, fy = py - y0, fz = pz - z0;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const ax = wrap(x0, period[0]), ay = wrap(y0, period[1]), az = wrap(z0, period[2]);
  const bx = (ax + 1) % period[0], by = (ay + 1) % period[1], bz = (az + 1) % period[2];
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return lerp(
    lerp(
      lerp(corner(ax, ay, az, fx, fy, fz, seed), corner(bx, ay, az, fx - 1, fy, fz, seed), ux),
      lerp(corner(ax, by, az, fx, fy - 1, fz, seed), corner(bx, by, az, fx - 1, fy - 1, fz, seed), ux),
      uy,
    ),
    lerp(
      lerp(corner(ax, ay, bz, fx, fy, fz - 1, seed), corner(bx, ay, bz, fx - 1, fy, fz - 1, seed), ux),
      lerp(corner(ax, by, bz, fx, fy - 1, fz - 1, seed), corner(bx, by, bz, fx - 1, fy - 1, fz - 1, seed), ux),
      uy,
    ),
    uz,
  );
}

/**
 * Inverted F1 Worley (1 at a feature point, 0 a cell away), from the squared
 * distance like the original — that is what gives clouds their billows.
 */
export function tileableWorley(px: number, py: number, pz: number, period: [number, number, number], seed = 0): number {
  const x0 = Math.floor(px), y0 = Math.floor(py), z0 = Math.floor(pz);
  const fx = px - x0, fy = py - y0, fz = pz - z0;
  let d = 1;
  for (let k = -1; k <= 1; k++) {
    const cz = wrap(z0 + k, period[2]);
    for (let j = -1; j <= 1; j++) {
      const cy = wrap(y0 + j, period[1]);
      for (let i = -1; i <= 1; i++) {
        hash3(wrap(x0 + i, period[0]), cy, cz, seed, g);
        const rx = i + g[0] - fx, ry = j + g[1] - fy, rz = k + g[2] - fz;
        d = Math.min(d, rx * rx + ry * ry + rz * rz);
      }
    }
  }
  return 1 - d;
}

// ---------------------------------------------------------------- patterns (uvw in the unit tile)

type Freq = [number, number, number];
const scaled = (f: Freq, k: number): Freq => [f[0] * k, f[1] * k, f[2] * k];
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function worleyAt(u: number, v: number, w: number, f: Freq, seed: number): number {
  return tileableWorley(u * f[0], v * f[1], w * f[2], f, seed);
}

export function perlinFbm(u: number, v: number, w: number, freq: Freq, octaves: number, gain: number, seed: number): number {
  let sum = 0, amp = 1, norm = 0, f = freq;
  const n = Math.max(1, Math.min(MAX_TILEABLE_OCTAVES, Math.round(octaves)));
  for (let i = 0; i < n; i++) {
    sum += tileablePerlin(u * f[0], v * f[1], w * f[2], f, seed) * amp;
    norm += amp;
    amp *= gain;
    f = scaled(f, 2);
  }
  return clamp01((sum / norm) * PERLIN_RANGE + 0.5);
}

export function worleyFbm(u: number, v: number, w: number, freq: Freq, octaves: number, gain: number, seed: number): number {
  let sum = 0, amp = 1, norm = 0, f = freq;
  const n = Math.max(1, Math.min(MAX_TILEABLE_OCTAVES, Math.round(octaves)));
  for (let i = 0; i < n; i++) {
    sum += worleyAt(u, v, w, f, seed) * amp;
    norm += amp;
    amp *= gain;
    f = scaled(f, 2);
  }
  return clamp01(sum / norm);
}

/** GPU Pro 7 p.101: Perlin remapped into [worley, 1] — Worley's billows with Perlin's connectedness. */
export function perlinWorley(u: number, v: number, w: number, freq: Freq, octaves: number, gain: number, seed: number): number {
  const p = perlinFbm(u, v, w, freq, octaves, gain, seed);
  const wf =
    worleyAt(u, v, w, freq, seed) * 0.625 +
    worleyAt(u, v, w, scaled(freq, 4), seed) * 0.25 +
    worleyAt(u, v, w, scaled(freq, 7), seed) * 0.125;
  return wf + p * (1 - wf);
}

/**
 * The 128³ base-shape texture: R = Perlin-Worley, G/B/A = Worley fBm at three
 * rising frequencies. The cell multipliers are the original's (2, 8, 14 for
 * the Perlin-Worley Worley, 2..16 for the channels), relative to `base`.
 */
export function cloudShape(u: number, v: number, w: number, base: Freq, seed: number): [number, number, number, number] {
  const perlin = perlinFbm(u, v, w, scaled(base, 2), 3, 0.5, seed);
  const w2 = worleyAt(u, v, w, scaled(base, 2), seed);
  const w4 = worleyAt(u, v, w, scaled(base, 4), seed);
  const w8 = worleyAt(u, v, w, scaled(base, 8), seed);
  const w14 = worleyAt(u, v, w, scaled(base, 14), seed);
  const w16 = worleyAt(u, v, w, scaled(base, 16), seed);
  const pwWorley = w2 * 0.625 + w8 * 0.25 + w14 * 0.125;
  return [
    pwWorley + perlin * (1 - pwWorley),
    w2 * 0.625 + w4 * 0.25 + w8 * 0.125,
    w4 * 0.625 + w8 * 0.25 + w16 * 0.125,
    w8 * 0.75 + w16 * 0.25,
  ];
}

/** The original's `noiseShapePacked`: Perlin-Worley eroded by the low-frequency Worley fBm. */
export function packCloudShape(c: readonly number[]): number {
  const low = c[1] * 0.625 + c[2] * 0.25 + c[3] * 0.125;
  return clamp01((c[0] - (low - 1)) / (2 - low));
}

/** The 32³ erosion texture: three Worley fBm at rising frequencies. */
export function cloudDetail(u: number, v: number, w: number, base: Freq, seed: number): [number, number, number, number] {
  const w1 = worleyAt(u, v, w, base, seed);
  const w2 = worleyAt(u, v, w, scaled(base, 2), seed);
  const w4 = worleyAt(u, v, w, scaled(base, 4), seed);
  const w8 = worleyAt(u, v, w, scaled(base, 8), seed);
  return [w1 * 0.625 + w2 * 0.25 + w4 * 0.125, w2 * 0.625 + w4 * 0.25 + w8 * 0.125, w4 * 0.75 + w8 * 0.25, 1];
}

export function packCloudDetail(c: readonly number[]): number {
  return c[0] * 0.625 + c[1] * 0.25 + c[2] * 0.125;
}

function simple(pattern: TileablePattern, u: number, v: number, w: number, f: Freq, s: TileableSettings): number {
  if (pattern === "worley") return worleyFbm(u, v, w, f, s.octaves, s.gain, s.seed);
  if (pattern === "perlin-worley") return perlinWorley(u, v, w, f, s.octaves, s.gain, s.seed);
  return perlinFbm(u, v, w, f, s.octaves, s.gain, s.seed);
}

/**
 * One texel of a pattern at `uvw` in the unit tile (any real value — it
 * wraps). Packed mode returns the value in all of RGB with A = 1; channel
 * mode returns the cloud channels, or for the plain noises the same noise at
 * ×1, ×2, ×4, ×8 frequency — one fetch, four octaves to mix in a shader.
 */
export function sampleTileable(u: number, v: number, w: number, s: TileableSettings): [number, number, number, number] {
  u -= Math.floor(u);
  v -= Math.floor(v);
  w -= Math.floor(w);
  const f: Freq = [tileFrequency(s.frequency[0]), tileFrequency(s.frequency[1]), tileFrequency(s.frequency[2])];
  if (s.pattern === "cloud-shape" || s.pattern === "cloud-detail") {
    const c = s.pattern === "cloud-shape" ? cloudShape(u, v, w, f, s.seed) : cloudDetail(u, v, w, f, s.seed);
    if (s.channels) return c;
    const p = s.pattern === "cloud-shape" ? packCloudShape(c) : packCloudDetail(c);
    return [p, p, p, 1];
  }
  if (!s.channels) {
    const p = simple(s.pattern, u, v, w, f, s);
    return [p, p, p, 1];
  }
  return [
    simple(s.pattern, u, v, w, f, s),
    simple(s.pattern, u, v, w, scaled(f, 2), s),
    simple(s.pattern, u, v, w, scaled(f, 4), s),
    simple(s.pattern, u, v, w, scaled(f, 8), s),
  ];
}
