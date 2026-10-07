import { describe, expect, test } from "vitest";
import { ease, readStep, SEQUENCE_NODE, stepCount, stepStarts } from "./sequence";
import { Connection, EvalContext } from "../types";

const ctx = (time: number, extra: Partial<EvalContext> = {}): EvalContext => ({ nodeId: "seq", time, step: Math.round(time * 60), ...extra });
const base = SEQUENCE_NODE.defaultParams as Record<string, unknown>;
const steps = (...list: [string, number, string?, string?][]) => {
  const p: Record<string, unknown> = { ...base, steps: list.length };
  list.forEach(([name, duration, kind, start], i) => {
    p[`step${i}Name`] = name;
    p[`step${i}Duration`] = duration;
    if (kind) p[`step${i}Ease`] = kind;
    if (start !== undefined) p[`step${i}Start`] = start;
  });
  return p;
};
const wire = (fromSocket: string): Connection => ({ id: fromSocket, fromNode: "seq", fromSocket, toNode: "other", toSocket: "progress" });

describe("steps", () => {
  test("each step reads its own fields, with defaults for the rest", () => {
    expect(readStep(steps(["curve", 2, "out", "zoom"]), 0)).toEqual({ name: "curve", duration: 2, ease: "out", at: "zoom" });
    expect(readStep({}, 4)).toEqual({ name: "step 5", duration: 1, ease: "smooth", at: undefined });
    expect(readStep({ step0Start: "@7.5" }, 0).at).toBe(7.5);
  });

  test("the step count grows with the Steps field, wired outputs and steps with settings", () => {
    expect(stepCount({ steps: 3 }, [])).toBe(3);
    expect(stepCount({ steps: 3 }, ["step5"])).toBe(6);
    expect(stepCount({ steps: 2, step3Duration: 2 }, [])).toBe(4);
    expect(stepCount({ steps: 2 }, ["index", "progresses"])).toBe(2);
  });

  test("steps follow each other unless they name their start", () => {
    const list = [readStep({ step0Duration: 2 }, 0), readStep({ step1Start: "m" }, 1), readStep({}, 2), readStep({ step3Start: "10" }, 3)];
    expect(stepStarts(list, (l) => (l === "m" ? 5 : undefined))).toEqual([0, 5, 6, 10]);
  });
});

describe("ease", () => {
  test("every ease runs 0 → 1, smooth through the middle", () => {
    for (const kind of ["smooth", "linear", "in", "out", "back"] as const) {
      expect(ease(kind, 0)).toBeCloseTo(0, 9);
      expect(ease(kind, 1)).toBeCloseTo(1, 9);
    }
    expect(ease("smooth", 0.5)).toBe(0.5);
    expect(ease("back", 0.9)).toBeGreaterThan(1);
  });
});

describe("SEQUENCE_NODE", () => {
  test("one output per step, named after it, then a spare that adds one when wired", () => {
    const outputs = SEQUENCE_NODE.dynamicOutputs!([], [], steps(["curve", 2], ["tangent", 1]));
    expect(outputs.slice(0, 3).map((o) => [o.id, o.label])).toEqual([
      ["step0", "curve (0–1)"],
      ["step1", "tangent (0–1)"],
      ["step2", "+ wire to add a step"],
    ]);
    const grown = SEQUENCE_NODE.dynamicOutputs!([wire("step2")], [], steps(["curve", 2], ["tangent", 1]));
    expect(grown.slice(0, 4).map((o) => o.id)).toEqual(["step0", "step1", "step2", "step3"]);
    expect(grown[2].label).toBe("step 3 (0–1)");
    expect(grown[3].label).toBe("+ wire to add a step");
  });

  test("the panel shows a group of fields for every step, wired ones included", () => {
    const instance = { id: "seq", type: "time/sequence", position: { x: 0, y: 0 }, params: { ...base, steps: 1 } };
    const fields = SEQUENCE_NODE.dynamicParamFields!(instance, [wire("step2")]);
    expect(fields.filter((f) => f.id.endsWith("Duration")).map((f) => f.id)).toEqual(["step0Duration", "step1Duration", "step2Duration"]);
  });

  test("timeline mode: each step's progress at a given time", () => {
    const p = steps(["a", 2, "linear"], ["b", 1, "linear"]);
    const at = (t: number) => SEQUENCE_NODE.evaluate({}, p, ctx(t));
    expect(at(1)).toMatchObject({ step0: 0.5, step1: 0, index: 0, current: "a" });
    expect(at(2.5)).toMatchObject({ step0: 1, step1: 0.5, index: 1, current: "b", local: 0.5 });
    expect(at(10)).toMatchObject({ step0: 1, step1: 1, total: 3 });
    expect(at(-1).index).toBe(-1);
  });

  test("a wired spare step joins the sequence with default timing", () => {
    const out = SEQUENCE_NODE.evaluate({}, steps(["a", 1, "linear"]), ctx(1.5, { connectedOutputs: new Set(["step1"]) }));
    expect(out.step1).toBe(0.5);
    expect(out.total).toBe(2);
  });

  test("a step can start on a timeline marker", () => {
    const out = SEQUENCE_NODE.evaluate({}, steps(["a", 1, "linear"], ["b", 2, "linear", "go"]), ctx(5, { markers: [{ frame: 120, label: "go" }], fps: 30 }));
    expect(out.step1).toBe(0.5);
  });

  test("trigger mode: Next sets each step off, Back takes it back", () => {
    const p = { ...steps(["a", 1, "linear"], ["b", 1, "linear"]), mode: "trigger" };
    const run = (t: number, next = 0, back = 0) => SEQUENCE_NODE.evaluate({ next, back }, p, ctx(t, { nodeId: "seq-live" }));
    expect(run(0).step0).toBe(0);
    run(5, 1);
    expect(run(5.5).step0).toBe(0.5);
    expect(run(9).step1).toBe(0);
    run(10, 1);
    expect(run(10.25).step1).toBe(0.25);
    run(11, 0, 1);
    expect(run(11.5).step1).toBe(0);
    expect(run(11.5).step0).toBe(1);
  });

  test("a file saved with the one-line steps is spelled out into fields", () => {
    const up = SEQUENCE_NODE.upgradeParams!({ steps: "curve: 2; tangent: 1 out @zoom; pause: 1" });
    expect(up).toMatchObject({
      steps: 3,
      step0Name: "curve", step0Duration: 2, step0Ease: "smooth",
      step1Name: "tangent", step1Duration: 1, step1Ease: "out", step1Start: "zoom",
      step2Name: "pause",
    });
    const current = { steps: 2 };
    expect(SEQUENCE_NODE.upgradeParams!(current)).toBe(current);
  });
});
