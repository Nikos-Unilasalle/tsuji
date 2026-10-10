import { describe, expect, it } from "vitest";
import { MAPGEN4_STYLE, colormap, generateElevation, generateMesh, stylizeMap } from "./index";

const lum = (img: Uint8Array, n: number, x: number, y: number): number => {
  const o = (y * n + x) * 4;
  return img[o] + img[o + 1] + img[o + 2];
};

describe("mapgen4 colormap", () => {
  it("matches the original formulas at known points", () => {
    expect(colormap(-1, 0)).toEqual([0, 0, 0]);
    expect(colormap(-0.5, 0)).toEqual([24, 32, 63.5]);
    expect(colormap(0, 0)).toEqual([210, 185, 139]);
    expect(colormap(0, 1)).toEqual([110, 140, 94]);
    // Half way up, dry land is half way to white.
    expect(colormap(0.5, 0)[0]).toBeCloseTo(232.5, 5);
    expect(colormap(0.999, 0)[0]).toBeGreaterThan(254);
  });

  it("gets darker in deeper water and wetter land gets darker too", () => {
    expect(colormap(-0.8, 0)[2]).toBeLessThan(colormap(-0.2, 0)[2]);
    expect(colormap(0.1, 1)[1]).toBeLessThan(colormap(0.1, 0)[1]);
  });
});

describe("stylizeMap", () => {
  const N = 64;
  const mesh = generateMesh(2, 0.02);
  const ramp = (f: (x: number) => number) => {
    const e = new Float32Array(mesh.numPoints);
    for (let i = 0; i < e.length; i++) e[i] = f(mesh.points[i * 2]);
    return e;
  };

  it("is deterministic and returns an opaque N×N RGBA image", () => {
    const e = generateElevation(mesh, { seed: 2, scale: 3, octaves: 4, ridges: 0.5, mountains: 2.6, island: 0.8, seaLevel: 0.42, paintStrength: 1, lowlands: 1.7, oceanDepth: 0.9 });
    const a = stylizeMap({ mesh, elevation: e }, { size: N, ...MAPGEN4_STYLE });
    const b = stylizeMap({ mesh, elevation: e }, { size: N, ...MAPGEN4_STYLE });
    expect(a.length).toBe(N * N * 4);
    expect(Array.from(a)).toEqual(Array.from(b));
    for (let i = 3; i < a.length; i += 4) expect(a[i]).toBe(255);
  });

  it("lights slopes that face the light and darkens the others", () => {
    // Default light comes from the west: a slope rising to the east faces west.
    const facing = stylizeMap({ mesh, elevation: ramp((x) => 0.05 + 0.5 * x) }, { size: N, ...MAPGEN4_STYLE });
    const away = stylizeMap({ mesh, elevation: ramp((x) => 0.05 + 0.5 * (1 - x)) }, { size: N, ...MAPGEN4_STYLE });
    expect(lum(facing, N, 32, 32)).toBeGreaterThan(lum(away, N, 32, 32));
  });

  it("paints rivers blue and ocean dark", () => {
    const sea = stylizeMap({ mesh, elevation: ramp(() => -0.9) }, { size: N, ...MAPGEN4_STYLE });
    expect(lum(sea, N, 32, 32)).toBeLessThan(120);
    const shallow = stylizeMap({ mesh, elevation: ramp(() => -0.05) }, { size: N, ...MAPGEN4_STYLE });
    expect(lum(shallow, N, 32, 32)).toBeGreaterThan(lum(sea, N, 32, 32));
  });

  it("flips rows into texture orientation: the map's y = 1 edge is row 0", () => {
    // Deep sea at y < 0.5, land at y > 0.5.
    const e = new Float32Array(mesh.numPoints);
    for (let i = 0; i < e.length; i++) e[i] = mesh.points[i * 2 + 1] < 0.5 ? -0.9 : 0.3;
    const img = stylizeMap({ mesh, elevation: e }, { size: N, ...MAPGEN4_STYLE, outlineStrength: 0 });
    expect(lum(img, N, 32, 4)).toBeGreaterThan(lum(img, N, 32, N - 5));
  });
});
