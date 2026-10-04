import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { EvalContext } from "../types";
import { curveStrokeMeta } from "../../three/brushScene";
import { STROKE_OUTLINE_NODE, STROKE_STYLE_NODE } from "./strokePaint";
import { WRITE_ON_NODE } from "./writeOn";
import { BRUSH_CANVAS_NODE, buildBrushCanvasScene } from "./brushCanvas";

const ctx = (nodeId: string, time = 0): EvalContext => ({ time, step: 0, nodeId });

function stroke(pressures?: number[]): THREE.CatmullRomCurve3 {
  const c = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(2, 0, 0)]);
  if (pressures) curveStrokeMeta.set(c, { pressures, color: "#222222" });
  return c;
}

function bounds(curve: THREE.Curve<THREE.Vector3>): THREE.Box3 {
  return new THREE.Box3().setFromPoints(curve.getPoints(200));
}

describe("STROKE_OUTLINE_NODE", () => {
  test("a closed shape around the stroke, as wide as its width, with round ends", () => {
    const out = STROKE_OUTLINE_NODE.evaluate({ curves: [stroke()] }, { ...STROKE_OUTLINE_NODE.defaultParams, usePressure: false }, ctx("so-a"));
    const outline = (out.curves as THREE.CatmullRomCurve3[])[0];
    expect(outline.closed).toBe(true);
    const box = bounds(outline);
    expect(box.max.y).toBeCloseTo(0.1, 1);
    expect(box.min.y).toBeCloseTo(-0.1, 1);
    expect(box.max.x).toBeGreaterThan(2.05);
    expect(box.min.x).toBeLessThan(-0.05);
  });

  test("width follows a drawn stroke's pressure", () => {
    const out = STROKE_OUTLINE_NODE.evaluate({ curves: [stroke([0.1, 0.1, 1])] }, STROKE_OUTLINE_NODE.defaultParams, ctx("so-b"));
    const points = (out.curves as THREE.CatmullRomCurve3[])[0].points;
    const near = (x: number) => Math.max(...points.filter((p) => Math.abs(p.x - x) < 0.05).map((p) => Math.abs(p.y)));
    expect(near(1.8)).toBeGreaterThan(near(0.2) * 2);
  });

  test("same strokes, same outlines; nothing wired, nothing out", () => {
    const strokes = [stroke()];
    const a = STROKE_OUTLINE_NODE.evaluate({ curves: strokes }, STROKE_OUTLINE_NODE.defaultParams, ctx("so-c"));
    const b = STROKE_OUTLINE_NODE.evaluate({ curves: strokes }, STROKE_OUTLINE_NODE.defaultParams, ctx("so-c"));
    expect((b.curves as unknown[])[0]).toBe((a.curves as unknown[])[0]);
    expect(STROKE_OUTLINE_NODE.evaluate({}, STROKE_OUTLINE_NODE.defaultParams, ctx("so-d")).curves).toEqual([]);
  });
});

describe("STROKE_STYLE_NODE", () => {
  test("paints its own copies, one value per curve, the last repeating — the source keeps its paint", () => {
    const source = [stroke([0.5, 1, 0.5]), stroke(), stroke()];
    const out = STROKE_STYLE_NODE.evaluate(
      { curves: source, opacities: [0, 0.5], bleeds: [0.1, 0.2, 0.3] },
      STROKE_STYLE_NODE.defaultParams,
      ctx("ss-a"),
    );
    const curves = out.curves as THREE.Curve<THREE.Vector3>[];
    expect(curves[0]).not.toBe(source[0]);
    const metas = curves.map((c) => curveStrokeMeta.get(c)!);
    expect(metas.map((m) => m.opacity)).toEqual([0, 0.5, 0.5]);
    expect(metas.map((m) => m.bleed)).toEqual([0.1, 0.2, 0.3]);
    expect(metas[0].pressures).toEqual([0.5, 1, 0.5]);
    expect(curveStrokeMeta.get(source[0])!.opacity).toBeUndefined();
    const again = STROKE_STYLE_NODE.evaluate({ curves: source }, STROKE_STYLE_NODE.defaultParams, ctx("ss-a"));
    expect((again.curves as unknown[])[0]).toBe(curves[0]);
  });

  test("Brush Canvas paints each curve with its own paint, and leaves out the ones at zero", () => {
    const styled = STROKE_STYLE_NODE.evaluate(
      { curves: [stroke(), stroke()], opacities: [0, 0.5], weights: [1, 2] },
      { ...STROKE_STYLE_NODE.defaultParams, setFillColor: true, fillColor: new THREE.Color(0x808080) },
      ctx("ss-b"),
    );
    const params = { ...BRUSH_CANVAS_NODE.defaultParams, frameMode: "fixed", fillOpacity: 100, strokeWeight: 2 };
    const scene = buildBrushCanvasScene({ curves: styled.curves }, params, { time: 0, step: 0 });
    expect(scene.paths).toHaveLength(1);
    expect(scene.paths[0].fill?.opacity).toBe(50);
    expect(scene.paths[0].fill?.color).toBe("#808080");
    expect(scene.paths[0].stroke?.weight).toBe(4);
  });
});

describe("Write On per-stroke lists", () => {
  test("progress and time since done, one entry per stroke whether started or not", () => {
    const params = { ...WRITE_ON_NODE.defaultParams, speed: 1, pause: 0, ease: "linear" };
    const out = WRITE_ON_NODE.evaluate({ curves: [stroke(), stroke(), stroke()] }, params, ctx("wo-l", 3));
    expect(out.progress).toEqual([1, 0.5, 0]);
    expect((out.age as number[])[0]).toBeCloseTo(1);
    expect(out.age).toEqual([expect.any(Number), 0, 0]);
  });
});
