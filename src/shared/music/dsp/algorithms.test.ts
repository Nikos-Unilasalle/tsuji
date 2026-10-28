import { describe, expect, it } from "vitest";
import { FM_ALGORITHMS, fmAlgorithm, routingOf } from "./algorithms";

describe("FM_ALGORITHMS", () => {
  it("has the eight 4-op algorithms with 1, 1, 1, 1, 2, 3, 3 and 4 carriers", () => {
    expect(FM_ALGORITHMS.map((a) => a.carriers.length)).toEqual([1, 1, 1, 1, 2, 3, 3, 4]);
  });

  it("only lets an operator be modulated by a higher-numbered one, so 4, 3, 2, 1 is a valid order", () => {
    for (const a of FM_ALGORITHMS) a.modulators.forEach((mods, k) => mods.forEach((j) => expect(j).toBeGreaterThan(k)));
  });

  it("uses every operator: each one is heard, or modulates something", () => {
    for (const a of FM_ALGORITHMS) {
      for (let k = 0; k < 4; k++) {
        const modulates = a.modulators.some((mods) => mods.includes(k));
        expect(a.carriers.includes(k) !== modulates).toBe(true);
      }
    }
  });

  it("clamps out-of-range numbers", () => {
    expect(fmAlgorithm(0)).toBe(FM_ALGORITHMS[0]);
    expect(fmAlgorithm(99)).toBe(FM_ALGORITHMS[7]);
    expect(fmAlgorithm(4.6)).toBe(FM_ALGORITHMS[4]);
  });

  it("splits the output evenly between carriers", () => {
    const { carrierGain, matrix } = routingOf(fmAlgorithm(6));
    expect([...carrierGain]).toEqual([1 / 3, 1 / 3, 1 / 3, 0].map(Math.fround));
    // Operator 4 modulates operators 1, 2 and 3.
    expect([matrix[3], matrix[7], matrix[11]]).toEqual([1, 1, 1]);
  });
});
