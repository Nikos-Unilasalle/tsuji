import { describe, expect, test } from "vitest";
import { BOUNDARY, insetPolygon, P2, polygonArea, pointInPolygon, polygonCentroid, voronoiCells } from "./voronoi2d";
import { chainEdges, directionField, poissonDisk, tessellate } from "./voronoi2dLayout";

const SQUARE: P2[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
// An L: the unit square minus its top-right quarter, so 0.75 in area and concave.
const ELL: P2[] = [[0, 0], [1, 0], [1, 0.5], [0.5, 0.5], [0.5, 1], [0, 1]];

function randomSites(n: number, seed = 1): P2[] {
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, (): P2 => [r(), r()]);
}

function segmentsCross(a: P2, b: P2, c: P2, d: P2): boolean {
  const o = (p: P2, q: P2, r: P2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < -1e-12 && o(c, d, a) * o(c, d, b) < -1e-12;
}

describe("voronoiCells", () => {
  test("cells tile a square exactly", () => {
    const cells = voronoiCells(randomSites(200), SQUARE);
    const total = cells.reduce((s, c) => s + polygonArea(c.verts), 0);
    expect(total).toBeCloseTo(1, 6);
    for (const c of cells) expect(polygonArea(c.verts)).toBeGreaterThan(0);
  });

  test("cells tile a concave outline, either winding", () => {
    const sites = randomSites(300, 7);
    for (const outline of [ELL, [...ELL].reverse()]) {
      const total = voronoiCells(sites, outline).reduce((s, c) => s + Math.abs(polygonArea(c.verts)), 0);
      expect(total).toBeCloseTo(0.75, 3);
    }
  });

  test("two sites split a square down the bisector, labelled by neighbour", () => {
    const [a, b] = voronoiCells([[0.25, 0.5], [0.75, 0.5]], SQUARE);
    expect(polygonArea(a.verts)).toBeCloseTo(0.5, 9);
    expect(a.labels.filter((l) => l === 1)).toHaveLength(1);
    expect(b.labels.filter((l) => l === 0)).toHaveLength(1);
    expect(a.labels.filter((l) => l === BOUNDARY)).toHaveLength(3);
  });

  test("no sites gives no cells; a lone site outside still owns the outline", () => {
    expect(voronoiCells([], SQUARE)).toEqual([]);
    expect(polygonArea(voronoiCells([[5, 5]], SQUARE)[0].verts)).toBeCloseTo(1, 9);
    const [, far] = voronoiCells([[0.5, 0.5], [9, 9]], SQUARE);
    expect(far.verts).toHaveLength(0);
  });
});

describe("tessellate with walls", () => {
  test("no cross edge crosses a wall, and the wall is lined with edges", () => {
    const wall: P2[] = [[0, 0.1], [1, 0.9]];
    const seeds = poissonDisk(SQUARE, () => 0.06, 3, 5000);
    const t = tessellate({ outline: SQUARE, seeds, walls: [wall], wallSpacing: 0, relax: 2 });
    for (const [a, b] of t.crossEdges) expect(segmentsCross(a, b, wall[0], wall[1])).toBe(false);
    const wallLength = t.wallEdges.reduce((s, [a, b]) => s + Math.hypot(b[0] - a[0], b[1] - a[1]), 0);
    expect(wallLength).toBeGreaterThan(Math.hypot(1, 0.8) * 0.9);
    expect(t.crossEdges.length).toBeGreaterThan(100);
  });
});

describe("poissonDisk", () => {
  test("respects the spacing and stays inside", () => {
    const pts = poissonDisk(ELL, () => 0.05, 1, 10000);
    expect(pts.length).toBeGreaterThan(150);
    for (let i = 0; i < pts.length; i++) {
      expect(pts[i][0] > 0.5 && pts[i][1] > 0.5).toBe(false);
      for (let j = i + 1; j < pts.length; j++) expect(Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1])).toBeGreaterThan(0.0499);
    }
  });

  test("denser where the spacing is smaller, and deterministic", () => {
    const f = (x: number) => 0.02 + 0.08 * x;
    const pts = poissonDisk(SQUARE, f, 9, 10000);
    const left = pts.filter((p) => p[0] < 0.5).length;
    expect(left).toBeGreaterThan(2 * (pts.length - left));
    expect(poissonDisk(SQUARE, f, 9, 10000)).toEqual(pts);
  });

  test("a zero or NaN spacing is clamped, not runaway", () => {
    expect(poissonDisk(SQUARE, () => 0, 1, 500).length).toBeLessThanOrEqual(500);
    expect(poissonDisk(SQUARE, () => NaN, 1, 500).length).toBeGreaterThan(0);
    expect(poissonDisk([], () => 0.1, 1, 500)).toEqual([]);
  });
});

describe("insetPolygon", () => {
  test("shrinks a square evenly and collapses when too far", () => {
    const inner = insetPolygon(SQUARE, 0.1)!;
    expect(polygonArea(inner)).toBeCloseTo(0.64, 6);
    expect(insetPolygon(SQUARE, 0.6)).toBeNull();
  });
});

describe("wall rows, chains, stretch", () => {
  const RECT: P2[] = [[0, 0], [4, 0], [4, 1], [0, 1]];
  test("a narrow strip between two parallel walls becomes a ladder of straight rungs", () => {
    const walls: P2[][] = [[[-1, 0.45], [5, 0.45]], [[-1, 0.55], [5, 0.55]]];
    const seeds = poissonDisk(RECT, () => 0.2, 2, 5000);
    const t = tessellate({ outline: RECT, seeds, walls, wallSpacing: 0, relax: 1, wallRows: 1 });
    const rungs = t.crossEdges.filter(([a, b]) => Math.min(a[1], b[1]) > 0.449 && Math.max(a[1], b[1]) < 0.551);
    expect(rungs.length).toBeGreaterThan(10);
    for (const [a, b] of rungs) {
      expect(Math.abs(a[0] - b[0])).toBeLessThan(0.01);
      expect(Math.abs(Math.abs(a[1] - b[1]) - 0.1)).toBeLessThan(0.005);
    }
  });

  test("more wall rows replace free seeds beside the walls with fixed rows", () => {
    const walls: P2[][] = [[[-1, 0.5], [5, 0.5]]];
    const seeds = poissonDisk(RECT, () => 0.08, 4, 5000);
    const one = tessellate({ outline: RECT, seeds, walls, wallSpacing: 0.08, relax: 0, wallRows: 1 });
    const three = tessellate({ outline: RECT, seeds, walls, wallSpacing: 0.08, relax: 0, wallRows: 3 });
    const fixed = (k: typeof one) => k.kinds.filter((x) => x.wall === -2).length;
    expect(fixed(one)).toBe(0);
    expect(fixed(three)).toBeGreaterThan(100);
    const near = (k: typeof one) => k.sites.filter((p, i) => k.kinds[i].wall === -1 && Math.abs(p[1] - 0.5) < 0.2).length;
    expect(near(three)).toBe(0);
  });

  test("chains join straight-on edges and drop short ones", () => {
    const edges: [P2, P2][] = [[[0, 0], [1, 0]], [[1, 0], [2, 0.1]], [[1, 0], [1, 1]], [[5, 5], [5.1, 5]]];
    const chains = chainEdges(edges, (35 * Math.PI) / 180, 0.5, 1e-6);
    expect(chains.find((c) => c.length === 3)).toBeTruthy();
    expect(chains.some((c) => c[0][0] === 5 || c[c.length - 1][0] === 5)).toBe(false);
  });
});

describe("stretch along a direction field", () => {
  test("cells follow a circular guide and still (nearly) tile the outline", () => {
    const ring = (r: number, n = 64): P2[] => Array.from({ length: n + 1 }, (_, i): P2 => [Math.cos((i / n) * 2 * Math.PI) * r, Math.sin((i / n) * 2 * Math.PI) * r]);
    const outline = ring(1).slice(0, -1);
    const field = directionField([ring(0.6)]);
    expect(Math.abs(Math.cos(field([0.6, 0])))).toBeLessThan(0.05);
    const seeds = poissonDisk(outline, () => 0.07, 5, 5000, 24, { k: 3, angleAt: field });
    const t = tessellate({ outline, seeds, walls: [], wallSpacing: 0, relax: 0, aniso: { k: 3, angleAt: field } });
    // A turning metric leaves slivers at some junctions: few, away from the field's singular centre.
    let holes = 0;
    let samples = 0;
    for (let i = 0; i < 4000; i++) {
      const a = (i * 2.399963) % (2 * Math.PI);
      const r = 0.3 + 0.6 * Math.sqrt((i + 0.5) / 4000);
      const q: P2 = [Math.cos(a) * r, Math.sin(a) * r];
      samples++;
      if (!t.cells.some((c) => c.verts.length >= 3 && pointInPolygon(q, c.verts))) holes++;
    }
    expect(holes / samples).toBeLessThan(0.05);
    let tangential = 0;
    let counted = 0;
    for (const c of t.cells) {
      if (c.verts.length < 3) continue;
      const [cx, cy] = polygonCentroid(c.verts);
      const r = Math.hypot(cx, cy);
      if (r < 0.3 || r > 0.9) continue;
      let sxx = 0, syy = 0, sxy = 0;
      for (const [x, y] of c.verts) {
        sxx += (x - cx) ** 2;
        syy += (y - cy) ** 2;
        sxy += (x - cx) * (y - cy);
      }
      const major = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      const radial = Math.atan2(cy, cx);
      tangential += Math.abs(Math.sin(major - radial));
      counted++;
    }
    expect(tangential / counted).toBeGreaterThan(0.8);
  });
});
