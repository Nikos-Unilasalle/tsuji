import { describe, it, expect } from "vitest";
import {
  rgbToOklab,
  oklabToRgb,
  oklabToOklch,
  oklchToHex,
  calculateContrastRatio,
  clusterImageData,
  generateThemeFromClusters,
  extractThemeFromImageData,
} from "./themeFromImage";

describe("themeFromImage engine", () => {
  it("converts sRGB to OKLab and back accurately", () => {
    const original = { r: 120, g: 200, b: 240 };
    const lab = rgbToOklab(original);
    const converted = oklabToRgb(lab);

    expect(Math.abs(converted.r - original.r)).toBeLessThanOrEqual(1);
    expect(Math.abs(converted.g - original.g)).toBeLessThanOrEqual(1);
    expect(Math.abs(converted.b - original.b)).toBeLessThanOrEqual(1);
  });

  it("calculates WCAG contrast ratios accurately", () => {
    // Pure black on pure white is 21:1
    const maxRatio = calculateContrastRatio("#000000", "#ffffff");
    expect(maxRatio).toBeCloseTo(21, 0);

    // Identical colors is 1:1
    const sameRatio = calculateContrastRatio("#123456", "#123456");
    expect(sameRatio).toBeCloseTo(1, 1);
  });

  it("clusters synthetic image pixel data", () => {
    // 10x10 image: half warm amber (#d97706), half sky blue (#38bdf8)
    const data = new Uint8ClampedArray(10 * 10 * 4);
    for (let i = 0; i < 50; i++) {
      data[i * 4] = 217;
      data[i * 4 + 1] = 119;
      data[i * 4 + 2] = 6;
      data[i * 4 + 3] = 255;
    }
    for (let i = 50; i < 100; i++) {
      data[i * 4] = 56;
      data[i * 4 + 1] = 189;
      data[i * 4 + 2] = 248;
      data[i * 4 + 3] = 255;
    }

    const clusters = clusterImageData(data, 4, 6);
    expect(clusters.length).toBeGreaterThanOrEqual(2);
    expect(clusters[0].weight).toBeGreaterThan(0);
  });

  it("generates a fully valid, WCAG AAA compliant Light theme", () => {
    const data = new Uint8ClampedArray(20 * 20 * 4);
    for (let i = 0; i < 400; i++) {
      data[i * 4] = 235; // parchment ivory
      data[i * 4 + 1] = 230;
      data[i * 4 + 2] = 220;
      data[i * 4 + 3] = 255;
    }
    // Add a splash of cyan
    for (let i = 0; i < 50; i++) {
      data[i * 4] = 56;
      data[i * 4 + 1] = 184;
      data[i * 4 + 2] = 206;
      data[i * 4 + 3] = 255;
    }

    const clusters = clusterImageData(data, 6, 6);
    const theme = generateThemeFromClusters(clusters, { mode: "light", name: "Parchment Light" });

    expect(theme.name).toBe("Parchment Light");
    expect(theme.isPreset).toBe(false);

    const keys = [
      "chromeBg",
      "chromeSurface",
      "chromeSurfaceRaised",
      "chromeBorder",
      "chromeText",
      "chromeTextMuted",
      "canvasBg",
      "canvasNodeList",
      "canvasSceneBg",
      "canvasSceneActive",
      "canvasNode",
      "canvasNodeRaised",
      "accentColor",
      "viewportBgTop",
      "viewportBgBottom",
      "viewportGrid",
    ] as const;

    for (const k of keys) {
      expect(theme.colors[k]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }

    // Light theme backgrounds must be bright (> #c0c0c0)
    expect(theme.colors.chromeSurface.toLowerCase()).not.toBe("#000000");

    // WCAG contrast check between chromeText and chromeSurface must be >= 7:1 (AAA)
    const contrast = calculateContrastRatio(theme.colors.chromeText, theme.colors.chromeSurface);
    expect(contrast).toBeGreaterThanOrEqual(7.0);
  });

  it("generates a fully valid, WCAG AAA compliant Dark theme", () => {
    const data = new Uint8ClampedArray(20 * 20 * 4);
    for (let i = 0; i < 400; i++) {
      data[i * 4] = 30; // deep slate
      data[i * 4 + 1] = 35;
      data[i * 4 + 2] = 45;
      data[i * 4 + 3] = 255;
    }
    // Add a splash of violet
    for (let i = 0; i < 50; i++) {
      data[i * 4] = 168;
      data[i * 4 + 1] = 85;
      data[i * 4 + 2] = 247;
      data[i * 4 + 3] = 255;
    }

    const clusters = clusterImageData(data, 6, 6);
    const theme = generateThemeFromClusters(clusters, { mode: "dark" });

    expect(theme.name).toContain("Dark");

    // WCAG contrast check between chromeText and chromeSurface must be >= 7:1
    const contrast = calculateContrastRatio(theme.colors.chromeText, theme.colors.chromeSurface);
    expect(contrast).toBeGreaterThanOrEqual(7.0);

    // Node list color must be present
    expect(theme.colors.canvasNodeList).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("converts OKLab to OKLCH and formats to Hex", () => {
    const lab = rgbToOklab({ r: 56, g: 189, b: 248 });
    const lch = oklabToOklch(lab);
    expect(lch.L).toBeGreaterThan(0.6);
    expect(lch.C).toBeGreaterThan(0.1);

    const hex = oklchToHex(lch);
    expect(hex.toLowerCase()).toBe("#38bdf8");
  });

  it("extracts theme directly from ImageData-like structure", () => {
    const data = new Uint8ClampedArray(4 * 4 * 4);
    data.fill(200);
    const mockImageData = { data, width: 4, height: 4 } as ImageData;
    const theme = extractThemeFromImageData(mockImageData, { mode: "light", name: "Direct" });
    expect(theme.name).toBe("Direct");
    expect(theme.colors.chromeBg).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});
