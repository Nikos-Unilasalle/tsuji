import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { FUNCTION_CURVE_NODE } from "./functionCurve";
import { EvalContext } from "../types";

const ctx = (nodeId: string, time = 0): EvalContext => ({ nodeId, time, step: 0 });
const params = (o: Record<string, unknown> = {}) => ({ ...(FUNCTION_CURVE_NODE.defaultParams as Record<string, unknown>), ...o });
const pts = (out: Record<string, unknown>) => out.points as THREE.Vector3[];

describe("FUNCTION_CURVE_NODE", () => {
  test("y = f(x) samples the formula over the range", () => {
    const out = FUNCTION_CURVE_NODE.evaluate({}, params({ formula: "x²", from: -2, to: 2, samples: 4 }), ctx("fc-a"));
    expect(pts(out).map((p) => [p.x, p.y])).toEqual([[-2, 4], [-1, 1], [0, 0], [1, 1], [2, 4]]);
  });

  test("parameters a–d come from wires or the panel", () => {
    const wired = FUNCTION_CURVE_NODE.evaluate({ a: 3 }, params({ formula: "a x", from: 1, to: 1, samples: 2 }), ctx("fc-b"));
    expect(pts(wired)[0].y).toBe(3);
  });

  test("parametric and polar kinds", () => {
    const helix = pts(FUNCTION_CURVE_NODE.evaluate({}, params({ mode: "parametric", formula: "(cos t, sin t, t)", from: 0, to: Math.PI, samples: 2 }), ctx("fc-c")));
    expect(helix[2].x).toBeCloseTo(-1, 9);
    expect(helix[2].z).toBeCloseTo(Math.PI, 9);
    const circle = pts(FUNCTION_CURVE_NODE.evaluate({}, params({ mode: "polar", formula: "2", from: 0, to: Math.PI / 2, samples: 2 }), ctx("fc-d")));
    expect(circle[2].x).toBeCloseTo(0, 9);
    expect(circle[2].y).toBeCloseTo(2, 9);
  });

  test("an asymptote splits the curve, each branch reaching the cut exactly", () => {
    const out = FUNCTION_CURVE_NODE.evaluate({}, params({ formula: "1/x", from: -2, to: 2, samples: 400, yMin: -5, yMax: 5 }), ctx("fc-e"));
    const curves = out.curves as THREE.CatmullRomCurve3[];
    expect(curves).toHaveLength(2);
    const ys = curves.flatMap((c) => c.points.map((p) => p.y));
    expect(Math.max(...ys)).toBeCloseTo(5, 6);
    expect(Math.min(...ys)).toBeCloseTo(-5, 6);
  });

  test("a gap where the formula is undefined splits it too", () => {
    const out = FUNCTION_CURVE_NODE.evaluate({}, params({ formula: "√(1 − x²)", from: -3, to: 3, samples: 600 }), ctx("fc-f"));
    expect((out.curves as unknown[]).length).toBe(1);
    for (const p of pts(out)) expect(Math.abs(p.x)).toBeLessThanOrEqual(1.0001);
  });

  test("Drawn traces the curve progressively by length", () => {
    const half = pts(FUNCTION_CURVE_NODE.evaluate({}, params({ formula: "0", from: 0, to: 10, samples: 10, progress: 0.5 }), ctx("fc-g")));
    expect(Math.max(...half.map((p) => p.x))).toBeCloseTo(5, 9);
    const none = FUNCTION_CURVE_NODE.evaluate({}, params({ formula: "0", progress: 0 }), ctx("fc-h"));
    const line = (none.geometry as THREE.Group).children.find((c) => c instanceof LineSegments2)!;
    expect(line.visible).toBe(false);
  });

  test("a Space places the curve on its axes", () => {
    const space = new THREE.Matrix4().makeTranslation(10, 0, 0).multiply(new THREE.Matrix4().makeScale(2, 2, 2));
    const p = pts(FUNCTION_CURVE_NODE.evaluate({ space }, params({ formula: "1", from: 0, to: 0, samples: 2 }), ctx("fc-i")))[0];
    expect(p.toArray()).toEqual([10, 2, 0]);
  });

  test("t follows the timeline in y = f(x)", () => {
    const a = pts(FUNCTION_CURVE_NODE.evaluate({}, params({ formula: "t", from: 0, to: 0, samples: 2 }), ctx("fc-j", 2)))[0];
    expect(a.y).toBe(2);
  });

  test("a broken formula draws nothing and does not throw", () => {
    const out = FUNCTION_CURVE_NODE.evaluate({}, params({ formula: "sin(" }), ctx("fc-k"));
    expect(out.curves).toEqual([]);
  });

  test("a steep piece crossing the whole window between two samples is kept", () => {
    // Samples at x = −5, 0, 5 are all outside; the line still crosses the window between 0 and 5.
    const out = FUNCTION_CURVE_NODE.evaluate({}, params({ formula: "5.75(x − 3) + 3.75", from: -5, to: 5, samples: 2, yMin: -3, yMax: 6 }), ctx("fc-steep"));
    const ys = pts(out).map((p) => p.y);
    expect(ys).toHaveLength(2);
    expect(Math.min(...ys)).toBeCloseTo(-3, 9);
    expect(Math.max(...ys)).toBeCloseTo(6, 9);
  });

  test("Area is the signed integral between Fill From and Fill To", () => {
    const area = (o: Record<string, unknown>, id: string) => FUNCTION_CURVE_NODE.evaluate({}, params({ fill: true, samples: 800, ...o }), ctx(id)).area as number;
    expect(area({ formula: "x²", fillFrom: 0, fillTo: 3 }, "fc-area-a")).toBeCloseTo(9, 3);
    expect(area({ formula: "x", fillFrom: -1, fillTo: 1 }, "fc-area-b")).toBeCloseTo(0, 6);
    expect(area({ formula: "x²", fillFrom: 3, fillTo: 0 }, "fc-area-c")).toBeCloseTo(-9, 3);
    expect(area({ mode: "polar", formula: "1", from: 0, to: 2 * Math.PI, fillFrom: 0, fillTo: 2 * Math.PI }, "fc-area-d")).toBeCloseTo(Math.PI, 3);
  });

  test("the fill is coloured by sign and split exactly at the axis", () => {
    const out = FUNCTION_CURVE_NODE.evaluate({}, params({ formula: "x", fill: true, fillFrom: -1, fillTo: 1, samples: 3 }), ctx("fc-fill"));
    const fill = (out.geometry as THREE.Group).children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh;
    expect(fill.visible).toBe(true);
    const pos = fill.geometry.getAttribute("position");
    const col = fill.geometry.getAttribute("color");
    for (let i = 0; i < pos.count; i++) {
      // Blue (above) vertices never sit below the axis, red (below) never above it.
      if (col.getZ(i) > col.getX(i)) expect(pos.getY(i)).toBeGreaterThanOrEqual(-1e-9);
      else expect(pos.getY(i)).toBeLessThanOrEqual(1e-9);
    }
  });

  test("no fill drawn unless asked; Area still reported", () => {
    const out = FUNCTION_CURVE_NODE.evaluate({}, params({ formula: "1", fillFrom: 0, fillTo: 2 }), ctx("fc-nofill"));
    const fill = (out.geometry as THREE.Group).children.find((c) => c instanceof THREE.Mesh)!;
    expect(fill.visible).toBe(false);
    expect(out.area).toBeCloseTo(2, 6);
  });
});
