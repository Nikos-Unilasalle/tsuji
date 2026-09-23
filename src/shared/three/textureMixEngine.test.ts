import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  calculateMixFalloff,
  createSplatBuffer,
  ensureSplatBuffer,
  applyMixStroke,
  serializeSplatBuffer,
  restoreSplatBuffer,
  computeHeightSlopeWeights,
} from "./textureMixEngine";

describe("textureMixEngine", () => {
  it("calculates falloff correctly", () => {
    expect(calculateMixFalloff(0, "smooth")).toBe(1.0);
    expect(calculateMixFalloff(1.0, "smooth")).toBe(0.0);
    expect(calculateMixFalloff(0.5, "linear")).toBeCloseTo(0.5, 4);
    expect(calculateMixFalloff(0.5, "flat")).toBe(1.0);
  });

  it("creates splat buffer with layer 0 at 100% weight", () => {
    const w = 4;
    const h = 4;
    const layers = 3;
    const buffer = createSplatBuffer(w, h, layers);
    expect(buffer.length).toBe(w * h * layers);
    // First pixel
    expect(buffer[0]).toBe(1.0);
    expect(buffer[1]).toBe(0.0);
    expect(buffer[2]).toBe(0.0);
  });

  it("resizes or reuses splat buffer", () => {
    const b1 = createSplatBuffer(8, 8, 2);
    const b2 = ensureSplatBuffer(b1, 8, 8, 2);
    expect(b1).toBe(b2);

    const b3 = ensureSplatBuffer(b1, 16, 16, 2);
    expect(b3.length).toBe(16 * 16 * 2);
  });

  it("paints on active layer and normalizes all weights to sum to 1", () => {
    const w = 10;
    const h = 10;
    const layers = 3;
    const buffer = createSplatBuffer(w, h, layers);

    // Paint layer 1 at center (UV 0.5, 0.5)
    applyMixStroke(buffer, w, h, layers, {
      tool: "paint",
      activeLayer: 1,
      radius: 4,
      strength: 1.0,
      falloff: "flat",
      uv: { x: 0.5, y: 0.5 },
    });

    const centerIdx = (5 * w + 5) * layers;
    // Layer 1 weight should have increased
    expect(buffer[centerIdx + 1]).toBeGreaterThan(0.2);
    // Sum of weights must equal 1.0
    const sum = buffer[centerIdx] + buffer[centerIdx + 1] + buffer[centerIdx + 2];
    expect(sum).toBeCloseTo(1.0, 4);
  });

  it("erases active layer weight and renormalizes", () => {
    const w = 8;
    const h = 8;
    const layers = 2;
    const buffer = createSplatBuffer(w, h, layers);

    // First paint layer 1
    applyMixStroke(buffer, w, h, layers, {
      tool: "paint",
      activeLayer: 1,
      radius: 5,
      strength: 1.0,
      falloff: "flat",
      uv: { x: 0.5, y: 0.5 },
    });
    const idx = (4 * w + 4) * layers;
    const weightBeforeErase = buffer[idx + 1];

    // Now erase layer 1
    applyMixStroke(buffer, w, h, layers, {
      tool: "erase",
      activeLayer: 1,
      radius: 5,
      strength: 1.0,
      falloff: "flat",
      uv: { x: 0.5, y: 0.5 },
    });
    expect(buffer[idx + 1]).toBeLessThan(weightBeforeErase);
    const sum = buffer[idx] + buffer[idx + 1];
    expect(sum).toBeCloseTo(1.0, 4);
  });

  it("fills canvas with active layer", () => {
    const w = 4;
    const h = 4;
    const layers = 3;
    const buffer = createSplatBuffer(w, h, layers);

    applyMixStroke(buffer, w, h, layers, {
      tool: "fill",
      activeLayer: 2,
      radius: 1,
      strength: 1,
      falloff: "flat",
      uv: { x: 0, y: 0 },
    });

    for (let i = 0; i < w * h; i++) {
      expect(buffer[i * layers + 2]).toBe(1.0);
      expect(buffer[i * layers + 0]).toBe(0.0);
    }
  });

  it("serializes and restores splat buffer", () => {
    const w = 4;
    const h = 4;
    const layers = 2;
    const buffer = createSplatBuffer(w, h, layers);
    buffer[0] = 0.4;
    buffer[1] = 0.6;

    const str = serializeSplatBuffer(buffer);
    expect(typeof str).toBe("string");
    expect(str.length).toBeGreaterThan(0);

    const restored = restoreSplatBuffer(str, w, h, layers);
    expect(restored).not.toBeNull();
    if (restored) {
      expect(restored[0]).toBeCloseTo(0.4, 1);
      expect(restored[1]).toBeCloseTo(0.6, 1);
    }
  });

  it("scales stroke radius and strength with stylus pressure", () => {
    const w = 16;
    const h = 16;
    const layers = 2;
    const bLight = createSplatBuffer(w, h, layers);
    const bHard = createSplatBuffer(w, h, layers);

    // Light pressure stroke
    applyMixStroke(bLight, w, h, layers, {
      tool: "paint",
      activeLayer: 1,
      radius: 6,
      strength: 1.0,
      falloff: "flat",
      uv: { x: 0.5, y: 0.5 },
      pressure: 0.2,
      pressureAffects: "both",
    });

    // Hard pressure stroke
    applyMixStroke(bHard, w, h, layers, {
      tool: "paint",
      activeLayer: 1,
      radius: 6,
      strength: 1.0,
      falloff: "flat",
      uv: { x: 0.5, y: 0.5 },
      pressure: 1.0,
      pressureAffects: "both",
    });

    const centerIdx = (8 * w + 8) * layers;
    // Hard stroke should have imparted stronger weight than light stroke
    expect(bHard[centerIdx + 1]).toBeGreaterThan(bLight[centerIdx + 1]);
  });

  it("computes height and slope weights procedurally for a 3D mesh", () => {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 2, 2));
    const w = 8;
    const h = 8;
    const layers = 3;
    const buffer = createSplatBuffer(w, h, layers);

    // Flat horizontal plane: normal is (0,0,1) for PlaneGeometry by default, rotate so normal is (0,1,0)
    plane.rotation.x = -Math.PI / 2;
    plane.updateMatrixWorld(true);

    computeHeightSlopeWeights(buffer, w, h, layers, plane, {
      slopeAngle: 30,
      slopeBlend: 10,
      slopeLayer: 1,
      snowHeight: 0.8,
      snowLayer: 2,
      baseLayer: 0,
      noiseAmount: 0,
    });

    // Since the plane is flat, baseLayer (0) should dominate everywhere
    for (let i = 0; i < w * h; i++) {
      expect(buffer[i * layers + 0]).toBeGreaterThan(0.5);
    }
  });
});
