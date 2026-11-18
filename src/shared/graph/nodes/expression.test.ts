import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { EXPRESSION_NODE } from "./expression";
import { EvalContext } from "../types";

const ctx = (time = 0, connected: string[] = []): EvalContext => ({ nodeId: "expr", time, step: Math.round(time * 60), connectedInputs: new Set(connected) });
const params = (formula: string, o: Record<string, unknown> = {}) => ({ ...(EXPRESSION_NODE.defaultParams as Record<string, unknown>), formula, ...o });

describe("EXPRESSION_NODE", () => {
  test("wired values feed the letters; unwired ones read the panel", () => {
    const out = EXPRESSION_NODE.evaluate({ x: 3 }, params("a x² + b", { a: 2, b: 1 }), ctx(0, ["x"]));
    expect(out.value).toBe(19);
  });

  test("t follows the timeline unless wired", () => {
    expect(EXPRESSION_NODE.evaluate({}, params("2t"), ctx(1.5)).value).toBe(3);
    expect(EXPRESSION_NODE.evaluate({ t: 10 }, params("2t"), ctx(1.5, ["t"])).value).toBe(20);
  });

  test("f is the timeline frame, or the clock counted in frames with no timeline", () => {
    expect(EXPRESSION_NODE.evaluate({}, params("f"), { ...ctx(2), currentFrame: 17 }).value).toBe(17);
    expect(EXPRESSION_NODE.evaluate({}, params("f"), { ...ctx(2), fps: 24 }).value).toBe(48);
    expect(EXPRESSION_NODE.evaluate({ f: 5 }, params("f + 1"), ctx(2, ["f"])).value).toBe(6);
  });

  test("a comma list gives a vector", () => {
    const out = EXPRESSION_NODE.evaluate({}, params("(1, 2x, 3)", { x: 2 }), ctx());
    expect(out.vector).toEqual(new THREE.Vector3(1, 4, 3));
  });

  test("a list in any letter runs the formula once per item", () => {
    const out = EXPRESSION_NODE.evaluate({ x: [1, 2, 3], a: 10 }, params("a + x²"), ctx(0, ["x", "a"]));
    expect(out.list).toEqual([11, 14, 19]);
    const vectors = EXPRESSION_NODE.evaluate({ t: [0, Math.PI] }, params("(cos t, sin t)"), ctx(0, ["t"])).list as THREE.Vector3[];
    expect(vectors[1].x).toBeCloseTo(-1, 12);
  });

  test("a broken formula yields zeros and names the mistake in the panel", () => {
    expect(EXPRESSION_NODE.evaluate({}, params("2 +"), ctx()).value).toBe(0);
    const fields = EXPRESSION_NODE.dynamicParamFields!({ id: "e", type: "math/expression", position: { x: 0, y: 0 }, params: params("2 +") });
    expect(fields[0]).toMatchObject({ kind: "note", tone: "warn" });
    expect(String(fields[0].label)).toMatch(/ends too early/);
    const fine = EXPRESSION_NODE.dynamicParamFields!({ id: "e", type: "math/expression", position: { x: 0, y: 0 }, params: params("x+1") });
    expect(fine.some((f) => f.kind === "note" && "tone" in f)).toBe(false);
  });
});
