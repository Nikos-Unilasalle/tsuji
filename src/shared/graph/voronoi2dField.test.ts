import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { P2, pointInPolygon, polygonArea, polygonCentroid, simplePolygon, untangle, voronoiCells } from "./voronoi2d";
import { directionField, poissonDisk } from "./voronoi2dLayout";
import { fieldTessellate, splitRing } from "./voronoi2dField";
import { VORONOI_2D_NODE } from "./nodes/voronoi2d";
import { EvalContext } from "./types";

const circle = (r: number, n = 64): P2[] => Array.from({ length: n }, (_, i): P2 => [Math.cos((i / n) * 2 * Math.PI) * r, Math.sin((i / n) * 2 * Math.PI) * r]);

describe("fieldTessellate", () => {
  const outline = circle(1);
  const field = directionField([[...circle(0.6), circle(0.6)[0]]]);
  const seeds = poissonDisk(outline, () => 0.12, 3, 5000, 24, { k: 4, angleAt: field });

  test("cells stretched along a turning field tile the outline with no gap or overlap", () => {
    const t = fieldTessellate({ outline, seeds, walls: [], relax: 1, k: 4, angleAt: field, resolution: 300 });
    let holes = 0;
    let doubles = 0;
    for (let i = 0; i < 3000; i++) {
      const a = (i * 2.399963) % (2 * Math.PI);
      const r = 0.95 * Math.sqrt((i + 0.5) / 3000);
      const q: P2 = [Math.cos(a) * r, Math.sin(a) * r];
      const n = t.cells.filter((c) => pointInPolygon(q, c.verts)).length;
      if (n === 0) holes++;
      if (n > 1) doubles++;
    }
    expect(holes).toBeLessThan(15); // only where a sample falls on a shared edge's simplification
    expect(doubles).toBeLessThan(15);
    const area = t.cells.reduce((s, c) => s + polygonArea(c.verts), 0);
    expect(area).toBeGreaterThan(Math.abs(polygonArea(outline)) * 0.99);
    // Cells run around the circle: their longer extent is tangential.
    let tangential = 0;
    let counted = 0;
    for (const c of t.cells) {
      const [cx, cy] = polygonCentroid(c.verts);
      const r = Math.hypot(cx, cy);
      if (r < 0.35 || r > 0.85) continue;
      let along = 0;
      let across = 0;
      for (const [x, y] of c.verts) {
        along = Math.max(along, Math.abs(((x - cx) * -cy + (y - cy) * cx) / r));
        across = Math.max(across, Math.abs(((x - cx) * cx + (y - cy) * cy) / r));
      }
      counted++;
      if (along > across) tangential++;
    }
    expect(tangential / counted).toBeGreaterThan(0.8);
  });

  test("edges join at shared junctions: every polyline end meets another edge or the outline", () => {
    const t = fieldTessellate({ outline, seeds, walls: [], relax: 0, k: 4, angleAt: field, resolution: 300 });
    const ends = t.crossEdges.flatMap((l) => [l[0], l[l.length - 1]]);
    const key = (p: P2) => `${p[0].toFixed(9)},${p[1].toFixed(9)}`;
    const count = new Map<string, number>();
    for (const p of ends) count.set(key(p), (count.get(key(p)) ?? 0) + 1);
    for (const p of ends) {
      const onOutline = Math.hypot(p[0], p[1]) > 0.99;
      if (!onOutline) expect(count.get(key(p))).toBeGreaterThanOrEqual(2);
    }
  });

  test("a wall is hard: no cell reaches across it, and wall edges lie on it", () => {
    const square: P2[] = [[0, 0], [2, 0], [2, 1], [0, 1]];
    const wall: P2[] = [[-0.1, 0.5], [2.1, 0.5]];
    const pts = poissonDisk(square, () => 0.15, 9, 5000);
    const t = fieldTessellate({ outline: square, seeds: pts, walls: [wall], relax: 0, k: 3, angleAt: () => 0, resolution: 200 });
    for (const c of t.cells) {
      const ys = c.verts.map((p) => p[1]);
      expect(Math.min(...ys) < 0.49 && Math.max(...ys) > 0.51).toBe(false);
    }
    expect(t.wallEdges.length).toBeGreaterThan(0);
    for (const l of t.wallEdges) for (const p of l) expect(Math.abs(p[1] - 0.5)).toBeLessThan(1e-9);
  });
});

describe("polygon repair", () => {
  test("untangle keeps the larger loop of a figure eight", () => {
    const eight: P2[] = [[0, 0], [2, 1], [2, 0], [0, 1]];
    const out = untangle(eight);
    expect(out.length).toBe(3);
    expect(Math.abs(polygonArea(out))).toBeCloseTo(0.5, 9);
  });

  test("simplePolygon drops a spike and repeated points", () => {
    const spiky: P2[] = [[0, 0], [1, 0], [1, 0], [1, 1], [1.5, 1], [1, 1], [0, 1]];
    const out = simplePolygon(spiky)!;
    expect(out).toHaveLength(4);
    expect(polygonArea(out)).toBeCloseTo(1, 9);
  });

  test("splitRing cuts a lens at its two tips", () => {
    const lens: P2[] = [...Array.from({ length: 9 }, (_, i): P2 => [i / 8, Math.sin((i / 8) * Math.PI) * 0.2]), ...Array.from({ length: 7 }, (_, i): P2 => [1 - (i + 1) / 8, -Math.sin(((i + 1) / 8) * Math.PI) * 0.2])];
    const pieces = splitRing(lens);
    expect(pieces).toHaveLength(2);
  });

  test("voronoiCells covers a concave outline exactly (no edge-noise cuts)", () => {
    // A thin, notched band — the shape of a vein-bounded wing panel.
    const band: P2[] = [[0, 0], [1, -0.03], [1.6, 0.05], [1.0, 0.12], [0.55, 0.09], [0.5, 0.16], [0.45, 0.09], [0, 0.15]];
    const pts = poissonDisk(band, () => 0.03, 4, 5000);
    const cells = voronoiCells(pts, band);
    const total = cells.reduce((s, c) => s + (c.verts.length >= 3 ? Math.abs(polygonArea(c.verts)) : 0), 0);
    expect(total).toBeCloseTo(Math.abs(polygonArea(band)), 6);
  });
});

describe("Voronoi 2D regions", () => {
  test("one tessellation per region: no cell crosses a region border", () => {
    const left = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 1, 0), new THREE.Vector3(0, 1, 0)];
    const right = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(2, 0, 0), new THREE.Vector3(2, 1, 0), new THREE.Vector3(1, 1, 0)];
    const pts = poissonDisk([[0, 0], [2, 0], [2, 1], [0, 1]], () => 0.1, 2, 5000).map(([x, y]) => new THREE.Vector3(x, y, 0));
    const out = VORONOI_2D_NODE.evaluate({ regions: [left, right], points: pts }, { ...VORONOI_2D_NODE.defaultParams, wallRows: 2 }, { time: 0, step: 0, nodeId: "reg" } as EvalContext) as Record<string, unknown>;
    const cells = out.cells as THREE.Vector3[][];
    expect(cells.length).toBeGreaterThan(100);
    for (const c of cells) {
      const xs = c.map((p) => p.x);
      expect(Math.min(...xs) < 0.999 && Math.max(...xs) > 1.001).toBe(false);
    }
    expect((out.areas as number[]).reduce((s, a) => s + a, 0)).toBeCloseTo(2, 3);
    expect(out.outline as unknown[]).toHaveLength(2);
  });
});
