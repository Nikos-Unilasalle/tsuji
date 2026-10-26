/**
 * Smooth 3D value noise summed over octaves, Processing-style: each octave
 * doubles the frequency and halves the weight, starting at 0.5. The result
 * sits in [0, ~0.94] with a mean near 0.47 — the range thresholds such as
 * "noise³ < 0.1" written for Processing's noise() were tuned against, which is
 * why it is deliberately not normalised to [0, 1].
 */

const HX = 0x27d4eb2d;
const HY = 0x165667b1;
const HZ = 0x61c88647;

/**
 * The lattice value at one corner, from its three coordinates already
 * multiplied by HX/HY/HZ (32-bit wrapping, as Math.imul). The corners of a
 * cell differ by one step, and imul(x + 1, H) is imul(x, H) + H modulo 2³², so
 * octave() multiplies once per axis and steps from there.
 */
function hashCorner(hx: number, hy: number, hz: number): number {
  let h = hx ^ hy ^ hz;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// Written out flat — no closures, no repeated multiplies: this runs a few
// million times when a brush-stroke node rebuilds (two noise reads per vertex,
// four octaves each), and the closures alone made the garbage collector a
// visible part of a slider drag.
function octave(x: number, y: number, z: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  let fx = x - x0;
  let fy = y - y0;
  let fz = z - z0;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  fz = fz * fz * (3 - 2 * fz);

  const hx0 = Math.imul(x0 | 0, HX);
  const hx1 = (hx0 + HX) | 0;
  const hy0 = Math.imul(y0 | 0, HY);
  const hy1 = (hy0 + HY) | 0;
  const hz0 = Math.imul(z0 | 0, HZ);
  const hz1 = (hz0 + HZ) | 0;

  let a = hashCorner(hx0, hy0, hz0);
  let b = hashCorner(hx1, hy0, hz0);
  const ab0 = a + (b - a) * fx;
  a = hashCorner(hx0, hy1, hz0);
  b = hashCorner(hx1, hy1, hz0);
  const cd0 = a + (b - a) * fx;
  const p0 = ab0 + (cd0 - ab0) * fy;

  a = hashCorner(hx0, hy0, hz1);
  b = hashCorner(hx1, hy0, hz1);
  const ab1 = a + (b - a) * fx;
  a = hashCorner(hx0, hy1, hz1);
  b = hashCorner(hx1, hy1, hz1);
  const cd1 = a + (b - a) * fx;
  const p1 = ab1 + (cd1 - ab1) * fy;

  return p0 + (p1 - p0) * fz;
}

export function valueNoise3(x: number, y = 0, z = 0, octaves = 4, falloff = 0.5): number {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return 0;
  let total = 0;
  let amplitude = 0.5;
  let frequency = 1;
  for (let i = 0; i < octaves; i++) {
    // Each octave is shifted so their lattices do not line up at the origin.
    total += amplitude * octave(x * frequency + i * 17.31, y * frequency + i * 5.77, z * frequency + i * 11.13);
    amplitude *= falloff;
    frequency *= 2;
  }
  return total;
}
