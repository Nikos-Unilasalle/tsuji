import { describe, expect, it } from "vitest";
import { valueNoise3 } from "./valueNoise";

// The implementation before it was flattened for speed. Kept verbatim so the
// rewrite is held to the exact same numbers: every seeded drawing in a saved
// project depends on them.
function referenceLattice(ix: number, iy: number, iz: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(iz | 0, 0x61c88647);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
function referenceOctave(x: number, y: number, z: number): number {
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const fz = smooth(z - z0);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const plane = (zi: number) =>
    lerp(
      lerp(referenceLattice(x0, y0, zi), referenceLattice(x0 + 1, y0, zi), fx),
      lerp(referenceLattice(x0, y0 + 1, zi), referenceLattice(x0 + 1, y0 + 1, zi), fx),
      fy,
    );
  return lerp(plane(z0), plane(z0 + 1), fz);
}
function referenceNoise(x: number, y = 0, z = 0, octaves = 4, falloff = 0.5): number {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return 0;
  let total = 0;
  let amplitude = 0.5;
  let frequency = 1;
  for (let i = 0; i < octaves; i++) {
    total += amplitude * referenceOctave(x * frequency + i * 17.31, y * frequency + i * 5.77, z * frequency + i * 11.13);
    amplitude *= falloff;
    frequency *= 2;
  }
  return total;
}

describe("valueNoise3", () => {
  it("matches the original implementation bit for bit", () => {
    let seed = 12345;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      return (seed >>> 0) / 4294967296;
    };
    const scales = [1, 10, 1000, 1e7, 3e9];
    for (let i = 0; i < 20000; i++) {
      const s = scales[i % scales.length];
      const x = (rand() - 0.5) * s;
      const y = (rand() - 0.5) * s;
      const z = i % 3 === 0 ? 0 : (rand() - 0.5) * s;
      const octaves = 1 + (i % 6);
      const falloff = 0.3 + rand() * 0.4;
      expect(valueNoise3(x, y, z, octaves, falloff)).toBe(referenceNoise(x, y, z, octaves, falloff));
    }
  });

  it("returns 0 for non-finite input", () => {
    expect(valueNoise3(NaN)).toBe(0);
    expect(valueNoise3(1, Infinity)).toBe(0);
  });
});
