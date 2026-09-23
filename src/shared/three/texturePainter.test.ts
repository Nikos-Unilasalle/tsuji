import { describe, expect, it } from "vitest";
import {
  colorWithAlpha,
  createPaintCanvas,
  applyPaintStroke,
  clearPaintCanvas,
} from "./texturePainter";

describe("texturePainter", () => {
  it("converts hex to rgba correctly with alpha", () => {
    expect(colorWithAlpha("#ff0000", 0.5)).toBe("rgba(255, 0, 0, 0.5)");
    expect(colorWithAlpha("#00ff00", 1)).toBe("rgba(0, 255, 0, 1)");
    expect(colorWithAlpha("#123", 0.8)).toBe("rgba(17, 34, 51, 0.8)");
  });

  it("creates paint canvas with correct dimensions", () => {
    const canvas = createPaintCanvas(256, 128);
    expect(canvas.width).toBe(256);
    expect(canvas.height).toBe(128);
  });

  it("applies fill stroke across canvas", () => {
    const canvas = createPaintCanvas(64, 64, "#000000");
    applyPaintStroke(canvas, {
      tool: "fill",
      color: "#ff0000",
      radius: 10,
      opacity: 1,
      hardness: 1,
      uv: { x: 0.5, y: 0.5 },
    });
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const p = ctx.getImageData(32, 32, 1, 1).data;
      expect(p[0]).toBe(255); // R
      expect(p[1]).toBe(0);   // G
      expect(p[2]).toBe(0);   // B
    }
  });

  it("applies paint stroke at UV coordinate", () => {
    const canvas = createPaintCanvas(100, 100, "#000000");
    applyPaintStroke(canvas, {
      tool: "paint",
      color: "#00ff00",
      radius: 15,
      opacity: 1,
      hardness: 0.9,
      uv: { x: 0.5, y: 0.5 },
    });
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const center = ctx.getImageData(50, 50, 1, 1).data;
      expect(center[1]).toBeGreaterThan(200); // Green channel is high

      const corner = ctx.getImageData(0, 0, 1, 1).data;
      expect(corner[1]).toBe(0); // Far away from brush
    }
  });

  it("samples color using eyedropper tool", () => {
    const canvas = createPaintCanvas(64, 64, "#123456");
    const result = applyPaintStroke(canvas, {
      tool: "eyedropper",
      color: "#ffffff",
      radius: 5,
      opacity: 1,
      hardness: 1,
      uv: { x: 0.5, y: 0.5 },
    });
    expect(result.sampledColor).toBe("#123456");
  });

  it("clears canvas with base color", () => {
    const canvas = createPaintCanvas(32, 32, "#ff0000");
    clearPaintCanvas(canvas, "#0000ff");
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const p = ctx.getImageData(16, 16, 1, 1).data;
      expect(p[2]).toBe(255); // Blue
      expect(p[0]).toBe(0);   // Red cleared
    }
  });

  it("modulates stroke radius with pressure", () => {
    const canvasLight = createPaintCanvas(100, 100, "#000000");
    const canvasHard = createPaintCanvas(100, 100, "#000000");

    // Very light touch
    applyPaintStroke(canvasLight, {
      tool: "paint",
      color: "#ffffff",
      radius: 20,
      opacity: 1,
      hardness: 1,
      uv: { x: 0.5, y: 0.5 },
      pressure: 0.1,
      pressureAffects: "size",
    });

    // Hard touch
    applyPaintStroke(canvasHard, {
      tool: "paint",
      color: "#ffffff",
      radius: 20,
      opacity: 1,
      hardness: 1,
      uv: { x: 0.5, y: 0.5 },
      pressure: 1.0,
      pressureAffects: "size",
    });

    const ctxLight = canvasLight.getContext("2d");
    const ctxHard = canvasHard.getContext("2d");
    if (ctxLight && ctxHard) {
      // 10 pixels away from center:
      // Hard touch radius is 20px, so point (60, 50) is inside and white
      // Light touch radius is 2px, so point (60, 50) is outside and black
      const pLight = ctxLight.getImageData(60, 50, 1, 1).data;
      const pHard = ctxHard.getImageData(60, 50, 1, 1).data;
      expect(pHard[0]).toBe(255);
      expect(pLight[0]).toBe(0);
    }
  });
});
