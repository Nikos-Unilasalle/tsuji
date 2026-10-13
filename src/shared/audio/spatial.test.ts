import { describe, expect, it } from "vitest";
import { attenuation, spatialGain } from "./spatial";

describe("attenuation", () => {
  it("is full inside the inner radius and silent at and beyond the outer", () => {
    for (const r of ["linear", "smooth", "natural"] as const) {
      expect(attenuation(0, 2, 10, r)).toBe(1);
      expect(attenuation(2, 2, 10, r)).toBe(1);
      expect(attenuation(10, 2, 10, r)).toBe(0);
      expect(attenuation(50, 2, 10, r)).toBe(0);
    }
  });

  it("falls monotonically between the radii", () => {
    for (const r of ["linear", "smooth", "natural"] as const) {
      let prev = 1;
      for (let d = 2; d <= 10; d += 0.5) {
        const a = attenuation(d, 2, 10, r);
        expect(a).toBeLessThanOrEqual(prev + 1e-9);
        prev = a;
      }
    }
  });

  it("linear is the straight line between the radii", () => {
    expect(attenuation(6, 2, 10, "linear")).toBeCloseTo(0.5);
  });

  it("tolerates an outer radius smaller than the inner one", () => {
    expect(attenuation(3, 5, 1, "linear")).toBe(1);
    expect(attenuation(6, 5, 1, "linear")).toBe(0);
  });
});

describe("spatialGain", () => {
  const at = { x: 0, y: 0, z: 0 };
  it("global is heard the same everywhere", () => {
    expect(spatialGain("global", { x: 999, y: 0, z: 0 }, at, 1, 2, "linear")).toBe(1);
  });
  it("local follows the distance from the listener to the source", () => {
    expect(spatialGain("local", { x: 6, y: 0, z: 0 }, at, 2, 10, "linear")).toBeCloseTo(0.5);
    expect(spatialGain("local", { x: 3, y: 4, z: 0 }, at, 2, 10, "linear")).toBeCloseTo(1 - 3 / 8);
  });
  it("without a camera the listener stands at the origin", () => {
    expect(spatialGain("local", null, { x: 6, y: 0, z: 0 }, 2, 10, "linear")).toBeCloseTo(0.5);
  });
});
