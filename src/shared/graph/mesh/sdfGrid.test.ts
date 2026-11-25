import { describe, expect, it } from "vitest";
import { createQuadBox, createQuadSphere } from "../quadMesh";
import { combineSdf, meshToSdf, noiseSdf, offsetSdf, planGrid, pointsToSdf, sampleSdf, sdfInsideVolume, sdfToPolyMesh, smoothSdf } from "./sdfGrid";

export function signedVolume(m: { positions: number[][]; faces: number[][] }): number {
  let v = 0;
  for (const f of m.faces)
    for (let i = 1; i + 1 < f.length; i++) {
      const a = m.positions[f[0]], b = m.positions[f[i]], c = m.positions[f[i + 1]];
      v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
  return v;
}

describe("sdfGrid", () => {
  it("plans grids under the cap", () => {
    const p = planGrid([0, 0, 0], [100, 100, 100], { voxel: 0.01 });
    expect(p.capped).toBe(true);
    expect(p.dims[0] * p.dims[1] * p.dims[2]).toBeLessThanOrEqual(128 ** 3);
  });

  it("points to SDF: one sphere meshes at its radius with outward quads", () => {
    const { grid } = pointsToSdf([0, 0, 0], [1], { resolution: 24 })!;
    expect(sampleSdf(grid, 0, 0, 0)).toBeCloseTo(-1, 1);
    expect(sampleSdf(grid, 2, 0, 0)).toBeCloseTo(1, 1);
    const mesh = sdfToPolyMesh(grid, { relax: 2 });
    expect(mesh.faces.length).toBeGreaterThan(50);
    expect(mesh.faces.every((f) => f.length === 4)).toBe(true);
    for (const p of mesh.positions) expect(Math.abs(Math.hypot(...p) - 1)).toBeLessThan(0.08);
    expect(signedVolume(mesh)).toBeGreaterThan(3.5);
  });

  it("mesh to SDF of a sphere is signed", () => {
    const { grid } = meshToSdf(createQuadSphere(1, 8), { resolution: 24 })!;
    expect(sampleSdf(grid, 0, 0, 0)).toBeLessThan(-0.8);
    expect(sampleSdf(grid, 1.5, 0, 0)).toBeCloseTo(0.5, 1);
    const vol = sdfInsideVolume(grid);
    expect(vol).toBeGreaterThan(3.6);
    expect(vol).toBeLessThan(4.6);
  });

  it("fills the far field by chamfer", () => {
    const { grid } = meshToSdf(createQuadBox(1, 1, 1), { voxel: 0.1, padding: 1, band: 2 })!;
    expect(sampleSdf(grid, 0, 0, 0)).toBeCloseTo(-0.5, 1);
    expect(sampleSdf(grid, 1.4, 0, 0)).toBeGreaterThan(0.8);
    expect(sampleSdf(grid, 1.4, 0, 0)).toBeLessThan(1.0);
  });

  it("shell mode turns an open mesh into a slab", () => {
    const plane = { positions: [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]] as [number, number, number][], faces: [[0, 1, 2, 3]] };
    const { grid } = meshToSdf(plane, { voxel: 0.05, sign: "shell", thickness: 0.1 })!;
    expect(sampleSdf(grid, 0, 0, 0)).toBeLessThan(0);
    expect(sampleSdf(grid, 0, 0.3, 0)).toBeGreaterThan(0);
  });

  it("union / subtract / intersect change the volume", () => {
    const a = pointsToSdf([0, 0, 0], [1], { voxel: 0.1 })!.grid;
    const b = pointsToSdf([1, 0, 0], [1], { voxel: 0.1 })!.grid;
    const va = sdfInsideVolume(a);
    const u = sdfInsideVolume(combineSdf(a, b, "union", 0).grid);
    const s = sdfInsideVolume(combineSdf(a, b, "subtract", 0).grid);
    const i = sdfInsideVolume(combineSdf(a, b, "intersect", 0).grid);
    expect(u).toBeGreaterThan(va * 1.4);
    // Two unit spheres one apart overlap in a lens of π·5/12 ≈ 1.31.
    const lens = (Math.PI * 5) / 12;
    expect(Math.abs(i - lens)).toBeLessThan(0.2);
    expect(Math.abs(s - (va - lens))).toBeLessThan(0.2);
    expect(Math.abs(s + i - va)).toBeLessThan(va * 0.1);
    expect(sdfInsideVolume(combineSdf(a, b, "union", 0.5).grid)).toBeGreaterThan(u);
  });

  it("offset, smooth and noise", () => {
    const a = pointsToSdf([0, 0, 0], [1], { voxel: 0.1 })!.grid;
    expect(sampleSdf(offsetSdf(a, 0.5).grid, 1.5, 0, 0)).toBeCloseTo(0, 1);
    expect(sampleSdf(smoothSdf(a, 3), 1, 0, 0)).toBeCloseTo(0, 1);
    const n = noiseSdf(a, { amplitude: 0.1, frequency: 2, seed: 1 }).grid;
    expect(Math.abs(sampleSdf(n, 1, 0, 0))).toBeLessThan(0.15);
    expect(n.values.every(Number.isFinite)).toBe(true);
  });
});
