/**
 * Seeded 2D gradient noise + fBm for the map generator. Self-contained and
 * integer-hashed (no Math.sin tricks, no Math.random), so a given seed gives
 * bit-identical terrain on every machine.
 */

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Gradient noise, roughly in [-1, 1]. */
export function noise2D(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const dot = (ix: number, iy: number, dx: number, dy: number): number => {
    const a = hash2(ix, iy, seed) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const n00 = dot(x0, y0, fx, fy);
  const n10 = dot(x0 + 1, y0, fx - 1, fy);
  const n01 = dot(x0, y0 + 1, fx, fy - 1);
  const n11 = dot(x0 + 1, y0 + 1, fx - 1, fy - 1);
  const nx0 = n00 + u * (n10 - n00);
  const nx1 = n01 + u * (n11 - n01);
  return (nx0 + v * (nx1 - nx0)) * 1.41;
}

/** Fractal sum of noise2D, normalised to roughly [-1, 1]. */
export function fbm2D(x: number, y: number, seed: number, octaves: number, gain = 0.5): number {
  const oct = Math.max(1, Math.min(8, Math.round(octaves)));
  let total = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    total += noise2D(x * freq, y * freq, seed + i * 101) * amp;
    norm += amp;
    amp *= gain;
    freq *= 2;
  }
  return norm > 0 ? total / norm : 0;
}
