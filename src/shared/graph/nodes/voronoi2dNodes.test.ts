import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { EvalContext } from "../types";
import { VORONOI_2D_NODE } from "./voronoi2d";
import { POISSON_DISK_2D_NODE } from "./poissonDisk2d";
import { HEIGHT_FROM_LINES_NODE, heightAt } from "./heightFromLines";

const ctx = (nodeId: string): EvalContext => ({ time: 0, step: 0, nodeId }) as EvalContext;

function circle(r: number): THREE.Curve<THREE.Vector3> {
  const pts = Array.from({ length: 16 }, (_, i) => new THREE.Vector3(Math.cos((i / 16) * Math.PI * 2) * r, Math.sin((i / 16) * Math.PI * 2) * r, 0));
  return new THREE.CatmullRomCurve3(pts, true);
}

describe("POISSON_DISK_2D_NODE", () => {
  test("fills a circle, denser where the formula says, same list object when unchanged", () => {
    const boundary = circle(1);
    const params = { ...POISSON_DISK_2D_NODE.defaultParams, spacing: 0.1, formula: "s (0.4 + u)" };
    const a = POISSON_DISK_2D_NODE.evaluate({ boundary }, params, ctx("pd")) as { points: THREE.Vector3[]; count: number };
    expect(a.count).toBeGreaterThan(100);
    for (const p of a.points) expect(p.length()).toBeLessThan(1.001);
    const left = a.points.filter((p) => p.x < 0).length;
    expect(left).toBeGreaterThan(a.count - left);
    const b = POISSON_DISK_2D_NODE.evaluate({ boundary }, params, ctx("pd")) as { points: THREE.Vector3[] };
    expect(b.points).toBe(a.points);
  });

  test("nothing wired, or a broken formula, does not throw", () => {
    expect((POISSON_DISK_2D_NODE.evaluate({}, POISSON_DISK_2D_NODE.defaultParams, ctx("pd0")) as { count: number }).count).toBe(0);
    const out = POISSON_DISK_2D_NODE.evaluate({ boundary: circle(1) }, { ...POISSON_DISK_2D_NODE.defaultParams, formula: "s *" }, ctx("pd1")) as { count: number };
    expect(out.count).toBeGreaterThan(0);
  });
});

describe("VORONOI_2D_NODE", () => {
  test("cells cover the outline, walls clipped, edges are 2-point lists", () => {
    const boundary = circle(1);
    const seeds = (POISSON_DISK_2D_NODE.evaluate({ boundary }, { ...POISSON_DISK_2D_NODE.defaultParams, spacing: 0.12 }, ctx("s"))).points;
    const wall = new THREE.LineCurve3(new THREE.Vector3(-2, 0, 0.1), new THREE.Vector3(2, 0, 0.1));
    const out = VORONOI_2D_NODE.evaluate({ boundary, points: seeds, walls: [wall] }, VORONOI_2D_NODE.defaultParams, ctx("v")) as Record<string, unknown>;
    const areas = out.areas as number[];
    const polyArea = areas.reduce((s, a) => s + a, 0);
    expect(polyArea).toBeGreaterThan(Math.PI * 0.97);
    expect(polyArea).toBeLessThan(Math.PI * 1.001);
    const walls = out.walls as THREE.Vector3[][];
    expect(walls).toHaveLength(1);
    expect(Math.abs(walls[0][0].x)).toBeCloseTo(1, 1);
    expect(walls[0][0].z).toBeCloseTo(0.1, 6);
    for (const e of out.edges as THREE.Vector3[][]) {
      expect(e).toHaveLength(2);
      // No cross vein runs through the wall.
      expect(e[0].y * e[1].y).toBeGreaterThanOrEqual(-1e-9);
    }
    expect(out.geometry).toBeInstanceOf(THREE.Mesh);
    const again = VORONOI_2D_NODE.evaluate({ boundary, points: seeds, walls: [wall] }, VORONOI_2D_NODE.defaultParams, ctx("v")) as Record<string, unknown>;
    expect(again.geometry).toBe(out.geometry);
    expect((again.geometry as THREE.Mesh).geometry).toBe((out.geometry as THREE.Mesh).geometry);
    expect(again.edges).toBe(out.edges);
  });

  test("unwired: empty outputs, no throw", () => {
    const out = VORONOI_2D_NODE.evaluate({}, VORONOI_2D_NODE.defaultParams, ctx("v0")) as Record<string, unknown>;
    expect(out.count).toBe(0);
    expect(out.edges).toEqual([]);
  });
});

describe("HEIGHT_FROM_LINES_NODE", () => {
  const ridge = [new THREE.Vector3(-1, 0, 1), new THREE.Vector3(1, 0, 1)];
  const valley = [new THREE.Vector3(-1, 1, -1), new THREE.Vector3(1, 1, -1)];

  test("two lines, power 1: linear across the strip", () => {
    const g = [ridge, valley].map((l) => ({ pts: l.map((p) => [p.x, p.y] as [number, number]), h: l.map((p) => p.z) }));
    expect(heightAt([0, 0.25], g, 2, 1)).toBeCloseTo(0.5, 9);
    expect(heightAt([0.3, 0.5], g, 2, 1)).toBeCloseTo(0, 9);
    expect(heightAt([0, 0], g, 2, 1)).toBe(1);
  });

  test("lifts point lists and a mesh; keeps the mesh when nothing changed", () => {
    const params = HEIGHT_FROM_LINES_NODE.defaultParams;
    const pts = [[new THREE.Vector3(0, 0.75, 0), new THREE.Vector3(0, 0.25, 0)]];
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 4, 4), new THREE.MeshStandardMaterial());
    mesh.position.set(0, 0.5, 0);
    mesh.updateMatrix();
    const out = HEIGHT_FROM_LINES_NODE.evaluate({ points: pts, guides: [ridge, valley], geometry: mesh }, params, ctx("h")) as Record<string, unknown>;
    const lifted = out.points as THREE.Vector3[][];
    expect(lifted[0][0].z).toBeCloseTo(-0.5, 9);
    expect(lifted[0][1].z).toBeCloseTo(0.5, 9);
    expect(pts[0][0].z).toBe(0);
    const m = out.geometry as THREE.Mesh;
    expect(m.material).toBe(mesh.material);
    const zs = Array.from({ length: m.geometry.attributes.position.count }, (_, i) => m.geometry.attributes.position.getZ(i));
    expect(Math.max(...zs)).toBeCloseTo(1, 6);
    expect(Math.min(...zs)).toBeCloseTo(-1, 6);
    const again = HEIGHT_FROM_LINES_NODE.evaluate({ points: pts, guides: [ridge, valley], geometry: mesh }, params, ctx("h")) as Record<string, unknown>;
    expect(again.geometry).toBe(m);
    expect((again.geometry as THREE.Mesh).geometry).toBe(m.geometry);
  });

  test("no guides: geometry untouched, no throw", () => {
    const out = HEIGHT_FROM_LINES_NODE.evaluate({}, HEIGHT_FROM_LINES_NODE.defaultParams, ctx("h0")) as Record<string, unknown>;
    expect(out.geometry).toBeNull();
  });
});

describe("stretch", () => {
  test("Poisson Disk 2D stretch spreads points along the direction", () => {
    const boundary = circle(1);
    const base = { ...POISSON_DISK_2D_NODE.defaultParams, spacing: 0.1 };
    const iso = (POISSON_DISK_2D_NODE.evaluate({ boundary }, base, ctx("st0")) as { count: number }).count;
    const st = (POISSON_DISK_2D_NODE.evaluate({ boundary }, { ...base, stretch: 3, stretchAngle: 0 }, ctx("st1")) as { count: number }).count;
    expect(st).toBeLessThan(iso * 0.5);
  });

  test("Voronoi 2D stretch elongates cells along the direction", () => {
    const boundary = circle(1);
    const pts = (POISSON_DISK_2D_NODE.evaluate({ boundary }, { ...POISSON_DISK_2D_NODE.defaultParams, spacing: 0.1, stretch: 3 }, ctx("st2")) as { points: THREE.Vector3[] }).points;
    const out = VORONOI_2D_NODE.evaluate({ boundary, points: pts }, { ...VORONOI_2D_NODE.defaultParams, stretch: 3, relax: 1, minChainLength: 0.3 }, ctx("st3")) as Record<string, unknown>;
    let ext = [0, 0];
    for (const c of out.cells as THREE.Vector3[][]) {
      const xs = c.map((p) => p.x);
      const ys = c.map((p) => p.y);
      ext = [ext[0] + Math.max(...xs) - Math.min(...xs), ext[1] + Math.max(...ys) - Math.min(...ys)];
    }
    expect(ext[0] / ext[1]).toBeGreaterThan(1.8);
    expect((out.chains as unknown[]).length).toBeGreaterThan(5);
  });
});
