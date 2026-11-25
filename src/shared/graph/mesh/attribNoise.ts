import { valueNoise3 } from "../../math/valueNoise";

/*
 * Noise and hashing for attribute work (Attribute Expression's noise(),
 * fbm(), curl(), rand(); Attribute Noise; Attribute Randomize).
 *
 * Built on math/valueNoise (the noise the rest of Tsuji already uses, so a
 * displacement here and a brush stroke there share a look), but re-centred:
 * valueNoise3 is Processing-style, in [0, ~0.94] around 0.47, which suits
 * thresholds; a displacement wants noise centred on 0 so the surface moves
 * both in and out and keeps its average place. Every function here returns a
 * finite number for any finite input, and 0 for non-finite input.
 */

/** Sum of the octave weights valueNoise3 uses (0.5 + 0.25 + …), to rescale fbm into [0, 1]. */
function octaveWeight(octaves: number): number {
  return 1 - Math.pow(0.5, octaves);
}

/** Smooth 3D value noise in [-1, 1], mean 0. One octave. */
export function signedNoise3(x: number, y: number, z: number): number {
  // One octave of valueNoise3 is 0.5 × lattice value in [0, 1].
  const v = valueNoise3(x, y, z, 1) * 2;
  return Number.isFinite(v) ? v * 2 - 1 : 0;
}

/** Fractal (fbm) value noise in [-1, 1]: `octaves` layers, each twice the frequency and `roughness` the weight. */
export function fbmNoise3(x: number, y: number, z: number, octaves = 4, roughness = 0.5): number {
  const oct = Math.max(1, Math.min(12, Math.round(Number.isFinite(octaves) ? octaves : 4)));
  const r = Number.isFinite(roughness) ? Math.max(0, Math.min(1, roughness)) : 0.5;
  if (r === 0.5) {
    const v = valueNoise3(x, y, z, oct, 0.5) / octaveWeight(oct);
    return Number.isFinite(v) ? v * 2 - 1 : 0;
  }
  // Custom roughness: sum the octaves here (valueNoise3's falloff starts its
  // amplitude at 0.5 and would need the same normalisation anyway).
  let total = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  for (let i = 0; i < oct; i++) {
    total += amp * signedNoise3(x * freq + i * 17.31, y * freq + i * 5.77, z * freq + i * 11.13);
    norm += amp;
    amp *= r;
    freq *= 2;
  }
  return norm > 0 ? total / norm : 0;
}

/**
 * Curl of a noise vector potential: a divergence-free field (no sources or
 * sinks), the classic "smoke" advection field. Central differences of three
 * decorrelated noise potentials; magnitude roughly in [-3, 3].
 */
export function curlNoise3(x: number, y: number, z: number, out: Float64Array | number[] = new Float64Array(3), octaves = 1): Float64Array | number[] {
  const h = 1e-3;
  const n = (px: number, py: number, pz: number) => (octaves > 1 ? fbmNoise3(px, py, pz, octaves) : signedNoise3(px, py, pz));
  // Potential ψ = (A, B, C) with A, B, C offset copies of one noise.
  const A = (px: number, py: number, pz: number) => n(px, py, pz);
  const B = (px: number, py: number, pz: number) => n(px + 31.416, py - 47.853, pz + 12.793);
  const C = (px: number, py: number, pz: number) => n(px - 19.2, py + 63.1, pz - 81.7);
  const dCdy = (C(x, y + h, z) - C(x, y - h, z)) / (2 * h);
  const dBdz = (B(x, y, z + h) - B(x, y, z - h)) / (2 * h);
  const dAdz = (A(x, y, z + h) - A(x, y, z - h)) / (2 * h);
  const dCdx = (C(x + h, y, z) - C(x - h, y, z)) / (2 * h);
  const dBdx = (B(x + h, y, z) - B(x - h, y, z)) / (2 * h);
  const dAdy = (A(x, y + h, z) - A(x, y - h, z)) / (2 * h);
  // Scaled down so it sits in the same rough range as the scalar noise.
  const k = 0.25;
  out[0] = (dCdy - dBdz) * k;
  out[1] = (dAdz - dCdx) * k;
  out[2] = (dBdx - dAdy) * k;
  return out;
}

const bits = new Float64Array(1);
const words = new Uint32Array(bits.buffer);

function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * A stable pseudo-random number in [0, 1) from any number and a seed: the
 * same (x, seed) always gives the same value, neighbouring integers give
 * unrelated ones. Hashes the float's bits, so rand(0.5) and rand(0.25) differ
 * too (Houdini's rand floors; here `rand(floor(x))` does that if wanted).
 */
export function hashRandom(x: number, seed = 0): number {
  bits[0] = Number.isFinite(x) ? x + 0 : 0; // + 0 folds -0 into 0
  let h = mix32(words[0] ^ 0x9e3779b9);
  h = mix32(h ^ words[1] ^ 0x85ebca6b);
  bits[0] = Number.isFinite(seed) ? seed + 0 : 0;
  h = mix32(h ^ words[0] ^ 0xc2b2ae35);
  h = mix32(h ^ words[1]);
  return h / 4294967296;
}

/** A uniformly distributed random unit vector for element `i` (Marsaglia-free: z uniform, angle uniform). */
export function randomUnitVector(i: number, seed: number, out: Float64Array | number[], at = 0): void {
  const z = hashRandom(i, seed * 7 + 1) * 2 - 1;
  const a = hashRandom(i, seed * 7 + 2) * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  out[at] = r * Math.cos(a);
  out[at + 1] = r * Math.sin(a);
  out[at + 2] = z;
}
