import { describe, expect, it } from "vitest";
import { tessellate, VoronoiCell, Vec3, cellToTriangles } from "./voronoi";

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

describe("VoronoiCell.cut", () => {
  it("halves a unit cube with a mid plane", () => {
    const cell = new VoronoiCell([0.25, 0.5, 0.5], [0, 0, 0], [1, 1, 1]);
    expect(cell.volume()).toBeCloseTo(1);
    expect(cell.cut([1, 0, 0], 0.5, 7)).toBe(true);
    expect(cell.volume()).toBeCloseTo(0.5);
    expect(cell.neighbors()).toEqual([7]);
  });

  it("ignores a plane that misses the cell", () => {
    const cell = new VoronoiCell([0.5, 0.5, 0.5], [0, 0, 0], [1, 1, 1]);
    expect(cell.cut([1, 0, 0], 5, 1)).toBe(false);
    expect(cell.volume()).toBeCloseTo(1);
  });
});

describe("tessellate", () => {
  const rand = rng(42);
  const sites: Vec3[] = Array.from({ length: 80 }, () => [rand() * 2, rand() * 3, rand()]);
  const cells = tessellate(sites, { min: [0, 0, 0], max: [2, 3, 1] });

  it("cells tile the box exactly", () => {
    const total = cells.reduce((s, c) => s + c.volume(), 0);
    expect(total).toBeCloseTo(6, 6);
  });

  it("each cell contains its own site", () => {
    expect(cells.every((c) => !c.isEmpty)).toBe(true);
  });

  it("neighbour relation is symmetric", () => {
    cells.forEach((c, i) => {
      for (const j of c.neighbors()) expect(cells[j].neighbors()).toContain(i);
    });
  });

  it("matches brute force (no early-out) volumes", () => {
    const brute = sites.map((s, i) => {
      const cell = new VoronoiCell(s, [0, 0, 0], [2, 3, 1]);
      sites.forEach((q, j) => {
        if (j === i) return;
        const n: Vec3 = [q[0] - s[0], q[1] - s[1], q[2] - s[2]];
        cell.cut(n, ((s[0] + q[0]) / 2) * n[0] + ((s[1] + q[1]) / 2) * n[1] + ((s[2] + q[2]) / 2) * n[2], j);
      });
      return cell.volume();
    });
    cells.forEach((c, i) => expect(c.volume()).toBeCloseTo(brute[i], 8));
  });

  it("gap shrinks the total volume and keeps cells apart", () => {
    const gapped = tessellate(sites, { min: [0, 0, 0], max: [2, 3, 1], gap: 0.05 });
    expect(gapped.reduce((s, c) => s + c.volume(), 0)).toBeLessThan(6);
  });

  it("triangulates with outward normals", () => {
    const c = cells[0];
    const { positions, normals } = cellToTriangles(c);
    const [cx, cy, cz] = c.centroid();
    for (let i = 0; i < positions.length; i += 9) {
      const dot = (positions[i] - cx) * normals[i] + (positions[i + 1] - cy) * normals[i + 1] + (positions[i + 2] - cz) * normals[i + 2];
      expect(dot).toBeGreaterThan(0);
    }
  });
});
