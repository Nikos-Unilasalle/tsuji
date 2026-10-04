import * as THREE from "three";
import { createPRNG } from "../../math/random";
import { vertsPerStrand } from "./tubeMesh";

/**
 * Patches — blotchy vertex colouring for tubes: a base colour with two
 * colours of patches over it, every strand patterned differently. Koi
 * (white, red, black), a cow, a leopard, a camouflage are all this with
 * other colours, sizes and coverage, which is why it isn't a koi feature.
 *
 * The field is a sum of three skewed sine waves along and around the tube:
 * smooth, seamless round it, and different per strand without a noise
 * texture to sample.
 */

export interface PatchParams {
  base: THREE.Color;
  colorA: THREE.Color;
  colorB: THREE.Color;
  /** Share of the surface each colour covers, 0-1. */
  coverageA: number;
  coverageB: number;
  /** Patches along the strand, roughly. */
  scale: number;
  /** Push patches onto the top (positive) or belly (negative), -1 to 1. */
  topBias: number;
  /** How much coverage differs from strand to strand, 0-1. */
  variation: number;
  seed: number;
}

export const PATCH_PRESETS: Record<string, Record<string, unknown>> = {
  Koi: {
    patchBase: new THREE.Color(0xf3eee4), patchA: new THREE.Color(0xd9452b), patchB: new THREE.Color(0x1c1b1d),
    coverageA: 0.32, coverageB: 0.1, patchScale: 2.5, topBias: 0.35, patchVariation: 0.8,
  },
  Cow: {
    patchBase: new THREE.Color(0xf4f1ea), patchA: new THREE.Color(0x1e1b18), patchB: new THREE.Color(0x6b4a33),
    coverageA: 0.4, coverageB: 0, patchScale: 2, topBias: 0, patchVariation: 0.4,
  },
  Leopard: {
    patchBase: new THREE.Color(0xd9a35b), patchA: new THREE.Color(0x2a1d14), patchB: new THREE.Color(0x8a5a2b),
    coverageA: 0.22, coverageB: 0.18, patchScale: 9, topBias: 0, patchVariation: 0.2,
  },
  Camouflage: {
    patchBase: new THREE.Color(0x6d7a4a), patchA: new THREE.Color(0x3d4a2a), patchB: new THREE.Color(0xa59a6a),
    coverageA: 0.35, coverageB: 0.25, patchScale: 3.5, topBias: 0, patchVariation: 0.3,
  },
};

function field(rng: () => number, scale: number): (u: number, theta: number) => number {
  const waves = [0, 1, 2].map(() => ({
    f: scale * (0.6 + rng() * 0.8),
    a: (rng() * 2 - 1) * 2.5,
    b: (rng() * 2 - 1) * 2.5,
    p: rng() * Math.PI * 2,
  }));
  return (u, theta) => {
    let n = 0;
    for (const w of waves) n += Math.sin(w.f * u * Math.PI * 2 + w.a * Math.cos(theta) + w.b * Math.sin(theta) + w.p);
    return n / 3;
  };
}

/**
 * Where a sum of three unit sines (spread roughly ±1, peaked at 0) crosses
 * `coverage` of the surface — a rough inverse, close enough that 0.5 reads
 * as half and 0 and 1 as none and all.
 */
function threshold(coverage: number): number {
  const c = Math.max(0, Math.min(1, coverage));
  if (c <= 0) return Infinity;
  if (c >= 1) return -Infinity;
  return (1 - 2 * c) * 0.75;
}

const scratch = new THREE.Color();

/** Colours every strand. Static per layout and settings: done when either changes, not per frame. */
export function paintPatches(geometry: THREE.BufferGeometry, counts: number[], radial: number, p: PatchParams): void {
  const color = geometry.getAttribute("color") as THREE.BufferAttribute;
  const ring = radial + 1;
  let o = 0;
  counts.forEach((m, s) => {
    const rng = createPRNG(Math.floor(p.seed) * 4099 + s * 7717 + 3);
    const va = (rng() * 2 - 1) * p.variation;
    const vb = (rng() * 2 - 1) * p.variation;
    const ta = threshold(p.coverageA * (1 + va));
    const tb = threshold(p.coverageB * (1 + vb));
    const fa = field(rng, p.scale);
    const fb = field(rng, p.scale * 1.3);
    const paint = (v: number, u: number, theta: number) => {
      const bias = p.topBias * Math.sin(theta) * 0.5;
      scratch.copy(p.base);
      if (fa(u, theta) + bias > ta) scratch.copy(p.colorA);
      if (fb(u, theta) + bias > tb) scratch.copy(p.colorB);
      color.setXYZ(v, scratch.r, scratch.g, scratch.b);
    };
    paint(o, 0, Math.PI / 2);
    for (let k = 0; k < m; k++) {
      const u = m > 1 ? k / (m - 1) : 0;
      for (let j = 0; j < ring; j++) paint(o + 1 + k * ring + j, u, ((j % radial) / radial) * Math.PI * 2);
    }
    paint(o + vertsPerStrand(m, radial) - 1, 1, Math.PI / 2);
    o += vertsPerStrand(m, radial);
  });
  color.needsUpdate = true;
}

/** Plain white, so the material colour shows through untouched when patches are off. */
export function clearPatches(geometry: THREE.BufferGeometry): void {
  const color = geometry.getAttribute("color") as THREE.BufferAttribute;
  (color.array as Float32Array).fill(1);
  color.needsUpdate = true;
}
