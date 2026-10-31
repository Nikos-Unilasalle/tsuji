import { describe, it, expect } from "vitest";
import { SkinWeights } from "./skinning";
import { applyWeightTargets, decodeBytes, encodeBytes, mapKey, parseMapKey, readTargets, storeTarget, WeightTargets } from "./weightMaps";
import { cloneSkin, jointWeight } from "./weightPaint";

/** Three influences per vertex: [joint, weight] pairs. */
function skinOf(rows: [number, number][][]): SkinWeights {
  const indices = new Uint16Array(rows.length * 3);
  const weights = new Float32Array(rows.length * 3);
  rows.forEach((row, v) => row.forEach(([j, w], k) => {
    indices[v * 3 + k] = j;
    weights[v * 3 + k] = w;
  }));
  return { influences: 3, indices, weights };
}

const parents = [-1, 0, 1];
const apply = (base: SkinWeights, targets: WeightTargets) => {
  const out = cloneSkin(base);
  applyWeightTargets(base, targets, parents, out);
  return out;
};
const byte = (w: number) => Math.round(w * 255);

describe("weight maps", () => {
  it("gives a painted joint its value, the unpainted ones what is left in their proportions", () => {
    const base = skinOf([[[0, 0.5], [1, 0.3], [2, 0.2]]]);
    const out = apply(base, new Map([[1, Uint8Array.of(byte(0.6))]]));
    expect(jointWeight(out, 0, 1)).toBeCloseTo(0.6, 2);
    expect(jointWeight(out, 0, 0)).toBeCloseTo(0.4 * (0.5 / 0.7), 2);
    expect(jointWeight(out, 0, 2)).toBeCloseTo(0.4 * (0.2 / 0.7), 2);
  });

  it("scales painted values down when they add up past 1", () => {
    const base = skinOf([[[0, 1], [1, 0], [2, 0]]]);
    const out = apply(base, new Map([[1, Uint8Array.of(255)], [2, Uint8Array.of(255)]]));
    expect(jointWeight(out, 0, 1)).toBeCloseTo(0.5);
    expect(jointWeight(out, 0, 2)).toBeCloseTo(0.5);
    expect(jointWeight(out, 0, 0)).toBe(0);
  });

  it("hands what a lone painted joint gives up to its parent", () => {
    const base = skinOf([[[2, 1], [0, 0], [0, 0]]]);
    const out = apply(base, new Map([[2, Uint8Array.of(byte(0.25))]]));
    expect(jointWeight(out, 0, 2)).toBeCloseTo(0.25, 2);
    expect(jointWeight(out, 0, 1)).toBeCloseTo(0.75, 2);
  });

  it("leaves the weights alone with nothing computed", () => {
    const base = skinOf([[[0, 0.7], [1, 0.3], [2, 0]]]);
    expect(Array.from(apply(base, new Map()).weights)).toEqual(Array.from(base.weights));
  });

  it("stores a byte per vertex and reads it back for the right mesh and vertex count only", () => {
    const bytes = Uint8Array.from({ length: 70000 }, (_, i) => i % 256);
    expect(Array.from(decodeBytes(encodeBytes(bytes)))).toEqual(Array.from(bytes));
    expect(parseMapKey(mapKey(2, 15))).toEqual({ mesh: 2, joint: 15 });
    const stored = { [mapKey(0, 3)]: storeTarget(Uint8Array.of(1, 2, 3)), [mapKey(1, 4)]: storeTarget(Uint8Array.of(9)) };
    expect(Array.from(readTargets(stored, 0, 3).get(3)!)).toEqual([1, 2, 3]);
    expect(readTargets(stored, 0, 4).size).toBe(0);
    expect([...readTargets(stored, 1, 1).keys()]).toEqual([4]);
  });
});
