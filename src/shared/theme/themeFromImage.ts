/**
 * Advanced image-based theme generator for Tsuji.
 * Uses perceptual OKLab / OKLCH color space for perceptually uniform clustering,
 * tonal grid derivation, and strict WCAG contrast compliance.
 */

import { ThemeColors, ThemeDefinition } from "./themeStore";

export interface ImageThemeOptions {
  mode: "light" | "dark";
  name?: string;
}

// ---------------------------------------------------------------------------
// 1. Precise Color Conversions (sRGB <-> Linear RGB <-> OKLab <-> OKLCH)
// ---------------------------------------------------------------------------

export interface RGB {
  r: number; // 0..255
  g: number; // 0..255
  b: number; // 0..255
}

export interface OKLab {
  L: number; // 0..1
  a: number; // roughly -0.4..0.4
  b: number; // roughly -0.4..0.4
}

export interface OKLCH {
  L: number; // 0..1
  C: number; // 0..0.4+
  h: number; // 0..360 (degrees)
}

export function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v: number): number {
  const clamped = Math.max(0, Math.min(1, v));
  const s = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(255, s * 255)));
}

export function rgbToOklab(rgb: RGB): OKLab {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

export function oklabToRgb(lab: OKLab): RGB {
  const l_ = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const m_ = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const s_ = lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  return {
    r: linearToSrgb(r),
    g: linearToSrgb(g),
    b: linearToSrgb(b),
  };
}

export function oklabToOklch(lab: OKLab): OKLCH {
  const C = Math.hypot(lab.a, lab.b);
  let h = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L: lab.L, C, h };
}

export function oklchToOklab(lch: OKLCH): OKLab {
  const rad = (lch.h * Math.PI) / 180;
  return {
    L: lch.L,
    a: lch.C * Math.cos(rad),
    b: lch.C * Math.sin(rad),
  };
}

export function oklchToHex(lch: OKLCH): string {
  const lab = oklchToOklab(lch);
  const rgb = oklabToRgb(lab);
  return rgbToHex(rgb);
}

export function rgbToHex(rgb: RGB): string {
  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

export function hexToRgb(hex: string): RGB {
  const clean = hex.replace("#", "").trim();
  if (clean.length === 3) {
    return {
      r: parseInt(clean[0] + clean[0], 16),
      g: parseInt(clean[1] + clean[1], 16),
      b: parseInt(clean[2] + clean[2], 16),
    };
  }
  const val = parseInt(clean, 16);
  return {
    r: (val >> 16) & 255,
    g: (val >> 8) & 255,
    b: val & 255,
  };
}

// ---------------------------------------------------------------------------
// 2. WCAG Relative Luminance and Contrast
// ---------------------------------------------------------------------------

export function getRelativeLuminance(rgb: RGB): number {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function calculateContrastRatio(hex1: string, hex2: string): number {
  const lum1 = getRelativeLuminance(hexToRgb(hex1));
  const lum2 = getRelativeLuminance(hexToRgb(hex2));
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  return (brightest + 0.05) / (darkest + 0.05);
}

// ---------------------------------------------------------------------------
// 3. Fast OKLab K-Means Clustering
// ---------------------------------------------------------------------------

interface Cluster {
  lab: OKLab;
  weight: number;
}

export function clusterImageData(data: Uint8ClampedArray, k = 8, iterations = 6): Cluster[] {
  const pixels: OKLab[] = [];
  const totalPixels = data.length / 4;
  const step = Math.max(1, Math.floor(totalPixels / 2000)); // sample ~2000 pixels

  for (let i = 0; i < data.length; i += step * 4) {
    const a = data[i + 3];
    if (a < 128) continue; // ignore transparent
    const rgb: RGB = { r: data[i], g: data[i + 1], b: data[i + 2] };
    pixels.push(rgbToOklab(rgb));
  }

  if (pixels.length === 0) {
    // Fallback neutral
    return [{ lab: { L: 0.5, a: 0, b: 0 }, weight: 1 }];
  }

  // Initialize centroids with k evenly-spaced samples
  const actualK = Math.min(k, pixels.length);
  const centroids: OKLab[] = [];
  for (let i = 0; i < actualK; i++) {
    const idx = Math.floor((i * pixels.length) / actualK);
    centroids.push({ ...pixels[idx] });
  }

  const assignments = new Int32Array(pixels.length);
  const counts = new Int32Array(actualK);

  for (let iter = 0; iter < iterations; iter++) {
    counts.fill(0);
    const sumL = new Float64Array(actualK);
    const sumA = new Float64Array(actualK);
    const sumB = new Float64Array(actualK);

    for (let p = 0; p < pixels.length; p++) {
      const px = pixels[p];
      let bestDist = Infinity;
      let bestC = 0;

      for (let c = 0; c < actualK; c++) {
        const ct = centroids[c];
        const dL = px.L - ct.L;
        const da = px.a - ct.a;
        const db = px.b - ct.b;
        const dist = dL * dL * 2 + da * da + db * db; // emphasize lightness distance
        if (dist < bestDist) {
          bestDist = dist;
          bestC = c;
        }
      }

      assignments[p] = bestC;
      counts[bestC]++;
      sumL[bestC] += px.L;
      sumA[bestC] += px.a;
      sumB[bestC] += px.b;
    }

    for (let c = 0; c < actualK; c++) {
      if (counts[c] > 0) {
        centroids[c] = {
          L: sumL[c] / counts[c],
          a: sumA[c] / counts[c],
          b: sumB[c] / counts[c],
        };
      }
    }
  }

  return centroids
    .map((lab, i) => ({ lab, weight: counts[i] / pixels.length }))
    .filter((c) => c.weight > 0)
    .sort((a, b) => b.weight - a.weight);
}

// ---------------------------------------------------------------------------
// 4. Semantic Palette Synthesis
// ---------------------------------------------------------------------------

function describeHue(h: number, isDark: boolean): string {
  let hueName = "Slate";
  if (h >= 15 && h < 45) hueName = "Amber";
  else if (h >= 45 && h < 75) hueName = "Sand";
  else if (h >= 75 && h < 140) hueName = "Sage";
  else if (h >= 140 && h < 175) hueName = "Mint";
  else if (h >= 175 && h < 210) hueName = "Aqua";
  else if (h >= 210 && h < 255) hueName = "Cyan";
  else if (h >= 255 && h < 290) hueName = "Cobalt";
  else if (h >= 290 && h < 330) hueName = "Amethyst";
  else hueName = "Rose";

  return `${hueName} (${isDark ? "Dark" : "Light"})`;
}

export function generateThemeFromClusters(clusters: Cluster[], options: ImageThemeOptions): ThemeDefinition {
  const isDark = options.mode === "dark";

  // 1. Ambient cluster: highest pixel coverage
  const ambientCluster = clusters[0] || { lab: { L: 0.5, a: 0, b: 0 }, weight: 1 };
  const ambientLch = oklabToOklch(ambientCluster.lab);
  const ambHue = ambientLch.h;
  const ambChroma = Math.min(0.04, ambientLch.C);

  // 2. Accent cluster: cluster with the highest chromatic punch
  // We score clusters by Chroma^1.4 * sqrt(weight)
  let bestAccentLch: OKLCH = { ...ambientLch, C: Math.max(0.12, ambientLch.C) };
  let bestScore = -1;

  for (const c of clusters) {
    const lch = oklabToOklch(c.lab);
    if (lch.C >= 0.035) {
      const score = Math.pow(lch.C, 1.4) * Math.sqrt(c.weight);
      if (score > bestScore) {
        bestScore = score;
        bestAccentLch = lch;
      }
    }
  }

  const accHue = bestAccentLch.h;
  const targetAccChroma = Math.max(0.13, Math.min(0.24, bestAccentLch.C * 1.3));

  // 3. Construct the palette with calibrated OKLCH lightness steps
  let colors: ThemeColors;

  if (isDark) {
    colors = {
      chromeBg: oklchToHex({ L: 0.13, C: ambChroma * 0.25, h: ambHue }),
      chromeSurface: oklchToHex({ L: 0.19, C: ambChroma * 0.35, h: ambHue }),
      chromeSurfaceRaised: oklchToHex({ L: 0.26, C: ambChroma * 0.45, h: ambHue }),
      chromeBorder: oklchToHex({ L: 0.35, C: ambChroma * 0.5, h: ambHue }),
      chromePillBg: oklchToHex({ L: 0.10, C: ambChroma * 0.2, h: ambHue }),
      chromeText: oklchToHex({ L: 0.94, C: 0.008, h: ambHue }),
      chromeTextMuted: oklchToHex({ L: 0.68, C: 0.018, h: ambHue }),
      canvasBg: oklchToHex({ L: 0.16, C: ambChroma * 0.35, h: ambHue }),
      canvasNodeList: oklchToHex({ L: 0.14, C: ambChroma * 0.3, h: ambHue }),
      canvasSceneBg: oklchToHex({ L: 0.16, C: ambChroma * 0.35, h: ambHue }),
      canvasSceneActive: oklchToHex({ L: 0.72, C: targetAccChroma, h: accHue }),
      canvasNode: oklchToHex({ L: 0.22, C: ambChroma * 0.4, h: ambHue }),
      canvasNodeRaised: oklchToHex({ L: 0.28, C: ambChroma * 0.45, h: ambHue }),
      accentColor: oklchToHex({ L: 0.72, C: targetAccChroma, h: accHue }),
      viewportBgTop: oklchToHex({ L: 0.17, C: ambChroma * 0.4, h: ambHue }),
      viewportBgBottom: oklchToHex({ L: 0.27, C: ambChroma * 0.55, h: (ambHue + 15) % 360 }),
      viewportGrid: oklchToHex({ L: 0.37, C: ambChroma * 0.35, h: ambHue }),
    };
  } else {
    colors = {
      chromeBg: oklchToHex({ L: 0.91, C: ambChroma * 0.25, h: ambHue }),
      chromeSurface: oklchToHex({ L: 0.96, C: ambChroma * 0.18, h: ambHue }),
      chromeSurfaceRaised: oklchToHex({ L: 0.995, C: 0.005, h: ambHue }),
      chromeBorder: oklchToHex({ L: 0.81, C: ambChroma * 0.3, h: ambHue }),
      chromePillBg: oklchToHex({ L: 0.85, C: ambChroma * 0.2, h: ambHue }),
      chromeText: oklchToHex({ L: 0.18, C: 0.012, h: ambHue }),
      chromeTextMuted: oklchToHex({ L: 0.48, C: 0.018, h: ambHue }),
      canvasBg: oklchToHex({ L: 0.87, C: ambChroma * 0.3, h: ambHue }),
      canvasNodeList: oklchToHex({ L: 0.92, C: ambChroma * 0.22, h: ambHue }),
      canvasSceneBg: oklchToHex({ L: 0.93, C: ambChroma * 0.22, h: ambHue }),
      canvasSceneActive: oklchToHex({ L: 0.52, C: targetAccChroma, h: accHue }),
      canvasNode: oklchToHex({ L: 0.97, C: ambChroma * 0.15, h: ambHue }),
      canvasNodeRaised: oklchToHex({ L: 0.90, C: ambChroma * 0.28, h: ambHue }),
      accentColor: oklchToHex({ L: 0.52, C: targetAccChroma, h: accHue }),
      viewportBgTop: oklchToHex({ L: 0.88, C: ambChroma * 0.3, h: ambHue }),
      viewportBgBottom: oklchToHex({ L: 0.96, C: ambChroma * 0.2, h: (ambHue + 15) % 360 }),
      viewportGrid: oklchToHex({ L: 0.74, C: ambChroma * 0.25, h: ambHue }),
    };
  }


  // 4. WCAG AAA Contrast Check & Enforcement (>= 7:1)
  let contrast = calculateContrastRatio(colors.chromeText, colors.chromeSurface);
  let textL = isDark ? 0.94 : 0.18;
  while (contrast < 7.0 && (isDark ? textL < 0.99 : textL > 0.05)) {
    textL = isDark ? textL + 0.01 : textL - 0.01;
    colors.chromeText = oklchToHex({ L: textL, C: 0.006, h: ambHue });
    contrast = calculateContrastRatio(colors.chromeText, colors.chromeSurface);
  }

  const name = options.name?.trim() || describeHue(accHue, isDark);

  return {
    id: `custom-img-${Date.now()}`,
    name,
    isPreset: false,
    colors,
  };
}

// ---------------------------------------------------------------------------
// 5. High-level image extraction APIs
// ---------------------------------------------------------------------------

export function extractThemeFromImageData(imageData: ImageData, options: ImageThemeOptions): ThemeDefinition {
  const clusters = clusterImageData(imageData.data);
  return generateThemeFromClusters(clusters, options);
}

export function extractThemeFromImageElement(img: HTMLImageElement, options: ImageThemeOptions): ThemeDefinition {
  const canvas = document.createElement("canvas");
  const maxDim = 96;
  const ratio = Math.min(maxDim / (img.naturalWidth || maxDim), maxDim / (img.naturalHeight || maxDim));
  const w = Math.max(1, Math.round((img.naturalWidth || maxDim) * ratio));
  const h = Math.max(1, Math.round((img.naturalHeight || maxDim) * ratio));

  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Unable to obtain 2D canvas context.");
  }
  ctx.drawImage(img, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);
  return extractThemeFromImageData(imgData, options);
}

export function extractThemeFromFile(file: File, mode: "light" | "dark"): Promise<ThemeDefinition> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image file."));
    reader.onload = (e) => {
      const src = e.target?.result as string;
      const img = new Image();
      img.onerror = () => reject(new Error("Failed to load image."));
      img.onload = () => {
        try {
          const rawName = file.name.replace(/\.[^/.]+$/, "").trim();
          const cleanName = rawName.charAt(0).toUpperCase() + rawName.slice(1);
          const theme = extractThemeFromImageElement(img, {
            mode,
            name: `${cleanName} (${mode === "dark" ? "Dark" : "Light"})`,
          });
          resolve(theme);
        } catch (err) {
          reject(err);
        }
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}
