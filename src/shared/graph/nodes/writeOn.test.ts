import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { EvalContext } from "../types";
import { curveStrokeMeta } from "../../three/brushScene";
import { WRITE_ON_NODE, writeOnTiming } from "./writeOn";

const ctx = (nodeId: string, time = 0): EvalContext => ({ time, step: 0, nodeId });

function line(x0: number, x1: number, pressures?: number[]): THREE.CatmullRomCurve3 {
  const c = new THREE.CatmullRomCurve3([new THREE.Vector3(x0, 0, 0), new THREE.Vector3((x0 + x1) / 2, 0, 0), new THREE.Vector3(x1, 0, 0)]);
  if (pressures) curveStrokeMeta.set(c, { pressures, color: "#111111" });
  return c;
}

describe("writeOnTiming", () => {
  test("strokes follow one another, each as long as its length takes, with a pause between", () => {
    const t = writeOnTiming([2, 1], 2, 0.5, 0);
    expect(t.durations).toEqual([1, 0.5]);
    expect(t.starts).toEqual([0, 1.5]);
    expect(t.total).toBe(2);
  });

  test("full overlap draws everything at once", () => {
    const t = writeOnTiming([2, 1], 2, 0.5, 1);
    expect(t.starts).toEqual([0, 0]);
    expect(t.total).toBe(1);
  });
});

describe("WRITE_ON_NODE", () => {
  const params = { ...WRITE_ON_NODE.defaultParams, speed: 1, pause: 0, ease: "linear" };
  const strokes = [line(0, 2), line(0, 1)];

  test("before the start nothing is drawn; after the end everything is, and Done says so", () => {
    const before = WRITE_ON_NODE.evaluate({ curves: strokes }, { ...params, startTime: 1 }, ctx("w-a", 0.5));
    expect(before.curves).toEqual([]);
    const after = WRITE_ON_NODE.evaluate({ curves: strokes }, params, ctx("w-a", 10));
    expect((after.curves as unknown[]).length).toBe(2);
    expect(after.done).toBe(1);
    expect(after.duration).toBeCloseTo(3, 1);
  });

  test("mid-way, the first stroke is whole and the second half-written, its tip where the brush is", () => {
    const out = WRITE_ON_NODE.evaluate({ curves: strokes }, params, ctx("w-b", 2.5));
    const curves = out.curves as THREE.Curve<THREE.Vector3>[];
    expect(curves).toHaveLength(2);
    expect(curves[1].getPoint(1).x).toBeCloseTo(0.5, 1);
    expect(out.active).toBe(1);
    expect((out.tip as THREE.Vector3).x).toBeCloseTo(0.5, 1);
    expect(out.done).toBe(0);
  });

  test("a finished stroke is the same object every frame", () => {
    const a = WRITE_ON_NODE.evaluate({ curves: strokes }, params, ctx("w-c", 2.2));
    const b = WRITE_ON_NODE.evaluate({ curves: strokes }, params, ctx("w-c", 2.6));
    expect((a.curves as unknown[])[0]).toBe((b.curves as unknown[])[0]);
  });

  test("a drawn stroke's pressure is cut along with it", () => {
    const pressed = [line(0, 2, [0.2, 1, 0.2])];
    const out = WRITE_ON_NODE.evaluate({ curves: pressed }, { ...params, timing: "progress", progress: 0.5 }, ctx("w-d"));
    const curve = (out.curves as THREE.Curve<THREE.Vector3>[])[0];
    const meta = curveStrokeMeta.get(curve)!;
    expect(meta.color).toBe("#111111");
    expect(meta.pressures![0]).toBeCloseTo(0.2, 1);
    expect(meta.pressures![meta.pressures!.length - 1]).toBeGreaterThan(0.9);
  });

  test("nothing wired: nothing drawn, no throw", () => {
    const out = WRITE_ON_NODE.evaluate({}, WRITE_ON_NODE.defaultParams, ctx("w-e", 3));
    expect(out.curves).toEqual([]);
    expect(out.done).toBe(0);
    expect(out.duration).toBe(0);
  });
});
