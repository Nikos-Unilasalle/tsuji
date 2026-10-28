/**
 * The eight 4-operator FM algorithms, after the Yamaha 4-op family (DX100, DX27, TX81Z). Operators are numbered 1–4
 * as on those synths and stored at index 0–3; operator 4 carries the feedback. A modulator always has a higher number
 * than what it modulates, so the voice can compute 4, 3, 2, 1 in that order with every input already known.
 *
 *   1  4→3→2→1          2  (3+4)→2→1        3  (3→2)+4 → 1      4  (4→3)+2 → 1
 *   5  4→3, 2→1         6  4→(1, 2, 3)      7  4→3, 2, 1        8  1, 2, 3, 4
 *
 * Carriers are heard; the rest only modulate.
 */

export interface FmAlgorithm {
  /** modulators[k]: the operators (index) whose output modulates operator k. */
  modulators: number[][];
  /** carriers: the operators (index) that are heard. */
  carriers: number[];
}

const alg = (modulators: number[][], carriers: number[]): FmAlgorithm => ({ modulators, carriers });

export const FM_ALGORITHMS: FmAlgorithm[] = [
  alg([[1], [2], [3], []], [0]),
  alg([[1], [2, 3], [], []], [0]),
  alg([[1, 3], [2], [], []], [0]),
  alg([[1, 2], [], [3], []], [0]),
  alg([[1], [], [3], []], [0, 2]),
  alg([[3], [3], [3], []], [0, 1, 2]),
  alg([[], [], [3], []], [0, 1, 2]),
  alg([[], [], [], []], [0, 1, 2, 3]),
];

/** 1-based, as shown to the user; anything out of range is clamped. */
export function fmAlgorithm(n: number): FmAlgorithm {
  return FM_ALGORITHMS[Math.min(FM_ALGORITHMS.length, Math.max(1, Math.round(n))) - 1];
}

/**
 * The algorithm as a dense 4×4 routing matrix (row = modulated operator, column = modulator, 1 or 0) and a carrier
 * weight per operator (1 / number of carriers, so every algorithm sounds at the same level). Branch-free in the
 * sample loop.
 */
export function routingOf(a: FmAlgorithm): { matrix: Float32Array; carrierGain: Float32Array } {
  const matrix = new Float32Array(16);
  a.modulators.forEach((mods, k) => mods.forEach((j) => (matrix[k * 4 + j] = 1)));
  const carrierGain = new Float32Array(4);
  for (const k of a.carriers) carrierGain[k] = 1 / a.carriers.length;
  return { matrix, carrierGain };
}
