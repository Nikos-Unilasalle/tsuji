/**
 * Smooth 3D value noise summed over octaves, Processing-style: each octave
 * doubles the frequency and halves the weight, starting at 0.5. The result
 * sits in [0, ~0.94] with a mean near 0.47 — the range thresholds such as
 * "noise³ < 0.1" written for Processing's noise() were tuned against, which is
 * why it is deliberately not normalised to [0, 1].
 */

function lattice(ix: number, iy: number, iz: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(iz | 0, 0x61c88647);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function octave(x: number, y: number, z: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const fz = smooth(z - z0);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const plane = (zi: number) =>
    lerp(
      lerp(lattice(x0, y0, zi), lattice(x0 + 1, y0, zi), fx),
      lerp(lattice(x0, y0 + 1, zi), lattice(x0 + 1, y0 + 1, zi), fx),
      fy,
    );
  return lerp(plane(z0), plane(z0 + 1), fz);
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
