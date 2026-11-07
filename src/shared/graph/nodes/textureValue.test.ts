import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { TEXTURE_VALUE_NODE, sampleBilinear, scanPoint, shapeValue } from "./textureValue";

/** A 2×1 RGBA texture: black on the left, white on the right. */
function halves(): THREE.DataTexture {
  const data = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]);
  const t = new THREE.DataTexture(data, 2, 1);
  t.needsUpdate = true;
  return t;
}

const evalAt = (inputs: Record<string, unknown>, params: Record<string, unknown>, time = 0, nodeId = "tv") =>
  (TEXTURE_VALUE_NODE.evaluate!(inputs, { ...TEXTURE_VALUE_NODE.defaultParams, ...params }, { nodeId, time, step: 0 } as never) as { value: number }).value;

describe("Texture → Value", () => {
  it("reads bilinear between texel centres, wrapping", () => {
    const px = { data: [0, 0, 0, 255, 255, 255, 255, 255], width: 2, height: 1 };
    expect(sampleBilinear(px, 0.25, 0.5, "red")).toBeCloseTo(0);
    expect(sampleBilinear(px, 0.75, 0.5, "red")).toBeCloseTo(1);
    expect(sampleBilinear(px, 0.5, 0.5, "red")).toBeCloseTo(0.5);
    // Past the right edge: halfway back to the black on the left.
    expect(sampleBilinear(px, 1, 0.5, "red")).toBeCloseTo(0.5);
  });

  it("the circle comes back to its start every 1 / speed seconds", () => {
    const [u0, v0] = scanPoint("circle", 0, 0.25, 0.3, 0.5);
    const [u1, v1] = scanPoint("circle", 4, 0.25, 0.3, 0.5);
    expect(u1).toBeCloseTo(u0);
    expect(v1).toBeCloseTo(v0);
    expect(scanPoint("line", 2, 0.25, 0.3, 0.7)).toEqual([0.5, 0.7]);
  });

  it("multiplies, offsets, clamps", () => {
    expect(shapeValue(0.5, 4, -1, false)).toBe(1);
    expect(shapeValue(0.5, 4, 0, true)).toBe(1);
    expect(shapeValue(0.5, -1, 0, true)).toBe(0);
  });

  it("moves along the texture in time, and remaps a bare value", () => {
    const tex = halves();
    const line = { path: "line", speed: 0.25, row: 0.5, channel: "red" };
    expect(evalAt({ texture: tex }, line, 1)).toBeCloseTo(0); // u = 0.25
    expect(evalAt({ texture: tex }, line, 3)).toBeCloseTo(1); // u = 0.75
    // The Time input over the clock.
    expect(evalAt({ texture: tex, time: 3 }, line, 1)).toBeCloseTo(1);
    expect(evalAt({ texture: tex }, { ...line, multiply: 0.5, offset: 0.1 }, 3)).toBeCloseTo(0.6);
    // No texture: Value, shaped. 0–127 → 0–1.
    expect(evalAt({ value: 127 }, { multiply: 1 / 127 })).toBeCloseTo(1);
    expect(evalAt({ value: 300 }, { multiply: 1 / 127 })).toBe(1);
    expect(evalAt({ value: 300 }, { multiply: 1 / 127, clamp: false })).toBeCloseTo(300 / 127);
  });
});
