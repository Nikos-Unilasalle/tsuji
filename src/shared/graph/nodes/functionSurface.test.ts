import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { FUNCTION_SURFACE_NODE } from "./functionSurface";
import { EvalContext } from "../types";
import { spaceMatrix } from "../mathSpace";

const ctx = (nodeId: string, time = 0): EvalContext => ({ nodeId, time, step: 0 });
const params = (o: Record<string, unknown> = {}) => ({ ...(FUNCTION_SURFACE_NODE.defaultParams as Record<string, unknown>), ...o });
const meshOf = (out: Record<string, unknown>) => (out.geometry as THREE.Group).children[0] as THREE.Mesh;
const triangles = (out: Record<string, unknown>) => (meshOf(out).geometry.getIndex()?.count ?? 0) / 3;

describe("FUNCTION_SURFACE_NODE", () => {
  test("z = f(x, y) on a grid, z up through a 3D space", () => {
    const space = spaceMatrix(new THREE.Matrix4(), "3D", new THREE.Vector3(1, 1, 1));
    const out = FUNCTION_SURFACE_NODE.evaluate({ space }, params({ formula: "x + 2y", resolution: 2, uMin: 0, uMax: 2, vMin: 0, vMax: 2 }), ctx("fs-a"));
    const points = out.points as THREE.Vector3[];
    expect(points).toHaveLength(9);
    // Math (2, 2, 6) → world (2, 6, −2): z is up.
    const last = points[8];
    expect([last.x, last.y, last.z].map((v) => v + 0)).toEqual([2, 6, -2]);
    expect(triangles(out)).toBe(8);
  });

  test("parametric surfaces: a sphere of radius 2", () => {
    const out = FUNCTION_SURFACE_NODE.evaluate({}, params({ mode: "parametric", formula: "(2 sin u cos v, 2 sin u sin v, 2 cos u)", uMin: 0, uMax: Math.PI, vMin: 0, vMax: 2 * Math.PI, resolution: 16 }), ctx("fs-b"));
    for (const p of out.points as THREE.Vector3[]) expect(p.length()).toBeCloseTo(2, 6);
  });

  test("undefined or cut points leave holes, not spikes", () => {
    const whole = triangles(FUNCTION_SURFACE_NODE.evaluate({}, params({ formula: "1", resolution: 10 }), ctx("fs-c")));
    const spiked = FUNCTION_SURFACE_NODE.evaluate({}, params({ formula: "1 / (x² + y²)", resolution: 10, zMax: 2 }), ctx("fs-d"));
    expect(triangles(spiked)).toBeLessThan(whole);
    for (const p of spiked.points as THREE.Vector3[]) expect(p.z).toBeLessThanOrEqual(2);
  });

  test("Drawn unrolls the surface row by row", () => {
    const full = triangles(FUNCTION_SURFACE_NODE.evaluate({}, params({ formula: "0", resolution: 10 }), ctx("fs-e")));
    const half = triangles(FUNCTION_SURFACE_NODE.evaluate({}, params({ formula: "0", resolution: 10, progress: 0.5 }), ctx("fs-f")));
    expect(half).toBe(full / 2);
  });

  test("a static formula is not rebuilt as time passes; one that reads t is", () => {
    const geometryAt = (formula: string, id: string, time: number) => {
      const out = FUNCTION_SURFACE_NODE.evaluate({}, params({ formula, resolution: 4 }), ctx(id, time));
      return (meshOf(out).geometry.getAttribute("position") as THREE.BufferAttribute).version;
    };
    const v0 = geometryAt("x", "fs-static", 0);
    expect(geometryAt("x", "fs-static", 1)).toBe(v0);
    const w0 = geometryAt("x t", "fs-live", 0);
    expect(geometryAt("x t", "fs-live", 1)).toBeGreaterThan(w0);
  });

  test("a broken formula hides the surface without throwing", () => {
    const out = FUNCTION_SURFACE_NODE.evaluate({}, params({ formula: "x +" }), ctx("fs-g"));
    expect(meshOf(out).visible).toBe(false);
  });
});
