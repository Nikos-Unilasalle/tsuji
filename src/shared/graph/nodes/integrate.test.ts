import * as THREE from "three";
import { describe, expect, test } from "vitest";
import {
  INTEGRATE_NODE,
  INTEGRATE_VECTOR_NODE,
  clampToRange,
  stepIntegrator,
} from "./integrate";
import { EvalContext } from "../types";

function makeContext(nodeId: string, time: number): EvalContext {
  return { nodeId, time, step: Math.round(time * 60) };
}

/** Runs a node over a series of times, returning the output each frame. */
function run<T>(
  node: typeof INTEGRATE_NODE,
  nodeId: string,
  frames: { time: number; inputs?: Record<string, unknown> }[],
  params: Record<string, unknown>,
): T[] {
  return frames.map(
    (frame) => node.evaluate(frame.inputs ?? {}, params, makeContext(nodeId, frame.time)) as T,
  );
}

describe("stepIntegrator", () => {
  test("a constant rate accumulates linearly", () => {
    let value = 0;
    for (let i = 0; i < 10; i++) {
      value = stepIntegrator({ current: value, rate: 2, dt: 0.1, damping: 0 });
    }
    expect(value).toBeCloseTo(2, 6);
  });

  test("no time passing means no accumulation", () => {
    expect(stepIntegrator({ current: 5, rate: 100, dt: 0, damping: 0 })).toBe(5);
  });

  test("damping is per second, so the result does not depend on the frame rate", () => {
    // The bug this pins: a per-frame multiplier makes an object coast further
    // on a slow machine than on a fast one.
    const coarse = stepIntegrator({ current: 1, rate: 0, dt: 0.2, damping: 3 });

    let fine = 1;
    for (let i = 0; i < 4; i++) {
      fine = stepIntegrator({ current: fine, rate: 0, dt: 0.05, damping: 3 });
    }
    expect(fine).toBeCloseTo(coarse, 10);
  });

  test("with damping, a constant rate settles at a terminal value instead of running away", () => {
    // Terminal value is rate / damping — this is what makes damping usable as
    // friction on a velocity.
    let value = 0;
    for (let i = 0; i < 2000; i++) {
      value = stepIntegrator({ current: value, rate: 6, dt: 0.01, damping: 2 });
    }
    expect(value).toBeCloseTo(3, 1);
  });

  test("damping alone decays toward zero without overshooting into negatives", () => {
    let value = 10;
    for (let i = 0; i < 200; i++) {
      value = stepIntegrator({ current: value, rate: 0, dt: 0.05, damping: 4 });
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(value).toBeLessThan(0.01);
  });

  test("a non-finite rate or accumulator cannot poison the total", () => {
    expect(stepIntegrator({ current: 3, rate: NaN, dt: 0.1, damping: 0 })).toBe(3);
    expect(stepIntegrator({ current: NaN, rate: 1, dt: 0.1, damping: 0 })).toBe(0);
  });
});

describe("clampToRange", () => {
  test("clamps only when asked and only when the range is real", () => {
    expect(clampToRange(5, 0, 3, true)).toBe(3);
    expect(clampToRange(-5, 0, 3, true)).toBe(0);
    expect(clampToRange(5, 0, 3, false)).toBe(5);
    // An inverted or empty range is treated as "no limits" rather than
    // collapsing the value onto a single number.
    expect(clampToRange(5, 3, 3, true)).toBe(5);
    expect(clampToRange(5, 10, 2, true)).toBe(5);
  });
});

describe("math/integrate node", () => {
  const params = (overrides: Record<string, unknown> = {}) => ({
    ...INTEGRATE_NODE.defaultParams,
    ...overrides,
  });

  test("the first frame yields the initial value, not a jump", () => {
    const [first] = run<{ value: number }>(
      INTEGRATE_NODE,
      "int-1",
      [{ time: 0, inputs: { rate: 10 } }],
      params({ initial: 2 }),
    );
    expect(first.value).toBe(2);
  });

  test("a held rate accumulates, and letting go leaves it where it stood", () => {
    // This is the reported bug in node form: releasing the key must not send
    // the value back to zero.
    const frames = [
      { time: 0, inputs: { rate: 0 } },
      { time: 0.5, inputs: { rate: 4 } },
      { time: 1.0, inputs: { rate: 4 } },
      { time: 1.5, inputs: { rate: 0 } },
      { time: 2.0, inputs: { rate: 0 } },
    ];
    const out = run<{ value: number }>(INTEGRATE_NODE, "int-2", frames, params());

    expect(out[1].value).toBeCloseTo(2, 6);
    expect(out[2].value).toBeCloseTo(4, 6);
    // Rate back to zero: the total holds.
    expect(out[3].value).toBeCloseTo(4, 6);
    expect(out[4].value).toBeCloseTo(4, 6);
  });

  test("a negative rate winds it back down", () => {
    const out = run<{ value: number }>(
      INTEGRATE_NODE,
      "int-3",
      [
        { time: 0, inputs: { rate: 0 } },
        { time: 1, inputs: { rate: 5 } },
        { time: 2, inputs: { rate: -5 } },
      ],
      params(),
    );
    expect(out[2].value).toBeCloseTo(0, 6);
  });

  test("Reset returns it to Initial while held", () => {
    const out = run<{ value: number }>(
      INTEGRATE_NODE,
      "int-4",
      [
        { time: 0, inputs: { rate: 0 } },
        { time: 1, inputs: { rate: 3 } },
        { time: 2, inputs: { rate: 3, reset: 1 } },
        { time: 3, inputs: { rate: 3 } },
      ],
      params({ initial: 1 }),
    );
    expect(out[1].value).toBeCloseTo(4, 6);
    expect(out[2].value).toBe(1);
    // And it carries on integrating from there afterwards.
    expect(out[3].value).toBeCloseTo(4, 6);
  });

  test("scrubbing the timeline backwards reseeds it", () => {
    // What it holds is the sum of everything since it started; that sum is
    // meaningless once you jump to a different point in time, and an export
    // has to be reproducible frame by frame.
    const out = run<{ value: number }>(
      INTEGRATE_NODE,
      "int-5",
      [
        { time: 0, inputs: { rate: 2 } },
        { time: 3, inputs: { rate: 2 } },
        { time: 0.2, inputs: { rate: 2 } },
      ],
      params({ initial: 0 }),
    );
    expect(out[1].value).toBeCloseTo(6, 6);
    expect(out[2].value).toBe(0);
  });

  test("a tiny backwards wobble is not treated as a scrub", () => {
    const out = run<{ value: number }>(
      INTEGRATE_NODE,
      "int-6",
      [
        { time: 0, inputs: { rate: 2 } },
        { time: 1, inputs: { rate: 2 } },
        { time: 0.9, inputs: { rate: 2 } },
      ],
      params(),
    );
    expect(out[1].value).toBeCloseTo(2, 6);
    // Clock went back by less than the rewind threshold: hold, do not reseed.
    expect(out[2].value).toBeCloseTo(2, 6);
  });

  test("limits bound the accumulation when enabled", () => {
    const out = run<{ value: number }>(
      INTEGRATE_NODE,
      "int-7",
      [
        { time: 0, inputs: { rate: 100 } },
        { time: 1, inputs: { rate: 100 } },
        { time: 2, inputs: { rate: 100 } },
      ],
      params({ useLimits: true, min: 0, max: 10 }),
    );
    expect(out[2].value).toBe(10);
  });

  test("damping makes a constant push settle instead of accelerating for ever", () => {
    const dt = 0.02;
    const rate = 8;
    const damping = 4;
    const frames = Array.from({ length: 400 }, (_, i) => ({ time: i * dt, inputs: { rate } }));
    const out = run<{ value: number }>(INTEGRATE_NODE, "int-8", frames, params({ damping }));

    // Stepping discretely, the terminal value is rate·dt / (1 − e^(−damping·dt)),
    // which sits a little above the continuous rate/damping — 2.08 rather than
    // exactly 2. What matters is that it settles rather than running away.
    const terminal = (rate * dt) / (1 - Math.exp(-damping * dt));
    const last = out[out.length - 1].value;
    const secondToLast = out[out.length - 2].value;

    expect(last).toBeCloseTo(terminal, 6);
    expect(last).toBeCloseTo(secondToLast, 9);
    expect(last).toBeLessThan(rate);
  });

  test("two instances keep separate totals", () => {
    run<{ value: number }>(INTEGRATE_NODE, "int-9a", [{ time: 0 }, { time: 1, inputs: { rate: 5 } }], params());
    const [, b] = run<{ value: number }>(
      INTEGRATE_NODE,
      "int-9b",
      [{ time: 0 }, { time: 1, inputs: { rate: 1 } }],
      params(),
    );
    expect(b.value).toBeCloseTo(1, 6);
  });
});

describe("vector/integrate node", () => {
  const params = (overrides: Record<string, unknown> = {}) => ({
    ...INTEGRATE_VECTOR_NODE.defaultParams,
    ...overrides,
  });

  const frames = (rate: THREE.Vector3, times: number[]) =>
    times.map((time) => ({ time, inputs: { rate } }));

  test("a movement vector accumulates into a position and stays put when it stops", () => {
    const out = run<{ value: THREE.Vector3 }>(
      INTEGRATE_VECTOR_NODE,
      "vint-1",
      [
        { time: 0, inputs: { rate: new THREE.Vector3(0, 0, 0) } },
        { time: 1, inputs: { rate: new THREE.Vector3(3, 0, -2) } },
        { time: 2, inputs: { rate: new THREE.Vector3(0, 0, 0) } },
      ],
      params(),
    );
    expect(out[1].value.x).toBeCloseTo(3, 6);
    expect(out[1].value.z).toBeCloseTo(-2, 6);
    // Released: it holds its ground rather than snapping home.
    expect(out[2].value.x).toBeCloseTo(3, 6);
    expect(out[2].value.z).toBeCloseTo(-2, 6);
  });

  test("all three axes integrate independently", () => {
    const out = run<{ value: THREE.Vector3 }>(
      INTEGRATE_VECTOR_NODE,
      "vint-2",
      frames(new THREE.Vector3(1, 2, 3), [0, 1]),
      params(),
    );
    expect(out[1].value.toArray()).toEqual([1, 2, 3]);
  });

  test("Max Length bounds the accumulation as a circle, not a box", () => {
    // Per-axis clamping would let a diagonal reach 1.41× further than a
    // straight line, so a bounded area comes out square when it was meant to
    // be round — the same reasoning as the gamepad's radial deadzone.
    const out = run<{ value: THREE.Vector3; length: number }>(
      INTEGRATE_VECTOR_NODE,
      "vint-3",
      frames(new THREE.Vector3(10, 0, 10), [0, 1, 2]),
      params({ maxLength: 5 }),
    );
    expect(out[2].length).toBeCloseTo(5, 6);
    expect(out[2].value.x).toBeCloseTo(out[2].value.z, 6);
  });

  test("the Length output matches the vector it came with", () => {
    const out = run<{ value: THREE.Vector3; length: number }>(
      INTEGRATE_VECTOR_NODE,
      "vint-4",
      frames(new THREE.Vector3(3, 0, 4), [0, 1]),
      params(),
    );
    expect(out[1].length).toBeCloseTo(5, 6);
  });

  test("the output is cloned, so a downstream node cannot write into the accumulator", () => {
    const out = run<{ value: THREE.Vector3 }>(
      INTEGRATE_VECTOR_NODE,
      "vint-5",
      frames(new THREE.Vector3(1, 0, 0), [0, 1, 2]),
      params(),
    );
    out[1].value.set(999, 999, 999);
    expect(out[2].value.x).toBeCloseTo(2, 6);
  });

  test("Reset drops it back to Initial", () => {
    const out = run<{ value: THREE.Vector3 }>(
      INTEGRATE_VECTOR_NODE,
      "vint-6",
      [
        { time: 0, inputs: { rate: new THREE.Vector3(1, 0, 0) } },
        { time: 1, inputs: { rate: new THREE.Vector3(1, 0, 0) } },
        { time: 2, inputs: { rate: new THREE.Vector3(1, 0, 0), reset: 1 } },
      ],
      params({ initial: new THREE.Vector3(0, 5, 0) }),
    );
    expect(out[1].value.x).toBeCloseTo(1, 6);
    expect(out[2].value.toArray()).toEqual([0, 5, 0]);
  });

  test("damping brings a moving value to rest", () => {
    const held = Array.from({ length: 50 }, (_, i) => ({
      time: i * 0.02,
      inputs: { rate: new THREE.Vector3(5, 0, 0) },
    }));
    const coasting = Array.from({ length: 200 }, (_, i) => ({
      time: 1 + i * 0.02,
      inputs: { rate: new THREE.Vector3(0, 0, 0) },
    }));
    const out = run<{ value: THREE.Vector3 }>(
      INTEGRATE_VECTOR_NODE,
      "vint-7",
      [...held, ...coasting],
      params({ damping: 3 }),
    );
    expect(out[out.length - 1].value.length()).toBeLessThan(0.05);
  });
});
