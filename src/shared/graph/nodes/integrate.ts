import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { clockInput, numberInput } from "./object";
import { asVector3 } from "./transform";

/**
 * Integrators: the missing half of every control scheme.
 *
 * An input node says how hard you are pushing *right now*. Wiring that
 * straight into a position makes the stick an absolute coordinate — let go and
 * the object snaps back to the origin, because zero push means position zero.
 * What movement actually needs is the accumulation of that push over time:
 * `position += velocity × dt`. That is this node, and it is deliberately
 * generic — the same brick integrates an acceleration into a speed, a rate
 * into an angle, a flow into a level, or an audio envelope into a fill.
 *
 * The one non-obvious decision is that **damping is per second, not per
 * frame**. A per-frame multiplier makes an object coast further on a slow
 * machine than on a fast one, which is the class of bug that only shows up on
 * someone else's hardware — the same reasoning as the Action Map's smoothing
 * and the Interaction Map's fade.
 *
 * Damping decays *the accumulated value*, which is friction when that value is
 * a velocity and a pull toward the origin when it is a position. Chaining two
 * integrators — damped for the velocity, undamped for the position — is the
 * arrangement that gives a character both drag and a place to stand still.
 */

export interface IntegratorStep {
  /** Accumulated value carried from the previous frame. */
  current: number;
  /** Rate of change per second — what is being integrated. */
  rate: number;
  /** Seconds since the previous frame. */
  dt: number;
  /** Fraction of the value shed per second, as a rate constant. 0 = frictionless. */
  damping: number;
}

/**
 * One integration step with exponential damping.
 *
 * Damping is applied to what is already there before the new contribution is
 * added, so a constant rate settles at a terminal value (`rate / damping`)
 * instead of growing without bound — which is what makes damping usable as
 * friction on a velocity.
 */
export function stepIntegrator({ current, rate, dt, damping }: IntegratorStep): number {
  if (!Number.isFinite(current)) return 0;
  const safeRate = Number.isFinite(rate) ? rate : 0;
  if (dt <= 0) return current;

  const damped = damping > 0 ? current * Math.exp(-damping * dt) : current;
  return damped + safeRate * dt;
}

/** Clamps to a range, ignoring the limits when they are not a real range. */
export function clampToRange(value: number, min: number, max: number, enabled: boolean): number {
  if (!enabled || !(max > min)) return value;
  return Math.max(min, Math.min(max, value));
}

interface ScalarState {
  value: number;
  lastTime?: number;
}

interface VectorState {
  value: THREE.Vector3;
  lastTime?: number;
}

const scalarCache = createNodeCache<ScalarState>();
const vectorCache = createNodeCache<VectorState>();

/**
 * How far the clock must jump backwards before this counts as a scrub rather
 * than a rounding wobble — the same threshold Spring and Squash & Stretch use.
 */
const REWIND_THRESHOLD = 0.5;

interface Timing {
  dt: number;
  reseed: boolean;
}

/**
 * Turns the clock into a delta, and decides whether the accumulated value
 * still means anything.
 *
 * Scrubbing the timeline backwards has to reset an integrator: what it holds
 * is the sum of everything that happened *since it started*, and that sum is
 * meaningless once you have jumped to a different point in time. Snapping back
 * to Initial is what makes a scrubbed frame reproducible, which an export
 * depends on.
 */
function timing(lastTime: number | undefined, time: number): Timing {
  if (lastTime === undefined) return { dt: 0, reseed: true };
  if (time < lastTime - REWIND_THRESHOLD) return { dt: 0, reseed: true };
  return { dt: Math.max(0, time - lastTime), reseed: false };
}

function isResetting(inputs: Record<string, unknown>, params: Record<string, unknown>): boolean {
  const raw = inputs.reset !== undefined ? inputs.reset : params.reset;
  return Number(raw) > 0.5;
}

/**
 * Integrate — accumulates a rate into a running total.
 *
 * Wire a speed in and read a position out; wire an acceleration in and read a
 * speed. Damping turns it into friction: with damping on, a constant input
 * settles at a terminal value instead of running away.
 */
export const INTEGRATE_NODE: NodeDefinition = {
  type: "math/integrate",
  label: "Integrate",
  category: "math",
  inputs: [
    { id: "rate", label: "Rate (per second)", type: "value" },
    { id: "time", label: "Time", type: "value" },
    { id: "damping", label: "Damping", type: "value" },
    { id: "reset", label: "Reset", type: "value" },
  ],
  outputs: [{ id: "value", label: "Value", type: "value" }],
  defaultParams: {
    rate: 0,
    initial: 0,
    damping: 0,
    reset: 0,
    useLimits: false,
    min: -100,
    max: 100,
  },
  paramFields: [
    { id: "rate", label: "Rate (per second)", kind: "number", step: 0.1 },
    { id: "initial", label: "Initial Value", kind: "number", step: 0.1 },
    { id: "damping", label: "Damping (per second, 0 = frictionless)", kind: "number", step: 0.1 },
    {
      id: "dampingNote",
      label:
        "Damping decays the accumulated value toward zero. On a velocity that is friction; " +
        "on a position it pulls back to the origin — leave it at 0 there.",
      kind: "note",
    },
    { id: "useLimits", label: "Clamp to Limits", kind: "boolean", group: "Limits" },
    { id: "min", label: "Min", kind: "number", step: 0.5, group: "Limits" },
    { id: "max", label: "Max", kind: "number", step: 0.5, group: "Limits" },
  ],
  evaluate: (inputs, params, ctx) => {
    const initial = numberInput(undefined, params.initial, 0);

    let state = scalarCache.get(ctx.nodeId);
    if (!state) {
      state = { value: initial };
      scalarCache.set(ctx.nodeId, state);
    }

    const time = clockInput(inputs, params, ctx);
    const { dt, reseed } = timing(state.lastTime, time);
    state.lastTime = time;

    if (reseed || isResetting(inputs, params)) {
      state.value = initial;
      return { value: state.value };
    }

    state.value = stepIntegrator({
      current: state.value,
      rate: numberInput(inputs.rate, params.rate, 0),
      dt,
      damping: Math.max(0, numberInput(inputs.damping, params.damping, 0)),
    });

    state.value = clampToRange(
      state.value,
      numberInput(undefined, params.min, -100),
      numberInput(undefined, params.max, 100),
      Boolean(params.useLimits),
    );

    return { value: state.value };
  },
};

/**
 * Integrate Vector — the same accumulation on three axes at once.
 *
 * This is the one a character controller wants: a movement vector from an
 * Action Map goes in, a position comes out, and letting go of the key leaves
 * the character where it stood instead of teleporting it home.
 *
 * Max Length clamps the *accumulated* vector radially rather than per axis,
 * for the same reason the gamepad's deadzone is radial: an axis-wise clamp
 * makes a diagonal reach further than a straight line, so a bounded area comes
 * out square when it was meant to be round.
 */
export const INTEGRATE_VECTOR_NODE: NodeDefinition = {
  type: "vector/integrate",
  label: "Integrate Vector",
  category: "math",
  inputs: [
    { id: "rate", label: "Rate (per second)", type: "vector" },
    { id: "time", label: "Time", type: "value" },
    { id: "damping", label: "Damping", type: "value" },
    { id: "reset", label: "Reset", type: "value" },
  ],
  outputs: [
    { id: "value", label: "Value", type: "vector" },
    { id: "length", label: "Length", type: "value" },
  ],
  defaultParams: {
    initial: new THREE.Vector3(0, 0, 0),
    damping: 0,
    reset: 0,
    maxLength: 0,
  },
  paramFields: [
    { id: "initial", label: "Initial Value", kind: "vector" },
    { id: "damping", label: "Damping (per second, 0 = frictionless)", kind: "number", step: 0.1 },
    {
      id: "dampingNote",
      label:
        "Damping decays the accumulated value toward zero. On a velocity that is friction; " +
        "on a position it pulls back to the origin — leave it at 0 there.",
      kind: "note",
    },
    { id: "maxLength", label: "Max Length (0 = unbounded)", kind: "number", step: 0.5 },
  ],
  evaluate: (inputs, params, ctx) => {
    const initial = asVector3(params.initial, new THREE.Vector3());

    let state = vectorCache.get(ctx.nodeId);
    if (!state) {
      state = { value: initial.clone() };
      vectorCache.set(ctx.nodeId, state);
    }

    const time = clockInput(inputs, params, ctx);
    const { dt, reseed } = timing(state.lastTime, time);
    state.lastTime = time;

    if (reseed || isResetting(inputs, params)) {
      state.value.copy(initial);
      return { value: state.value.clone(), length: state.value.length() };
    }

    const rate = asVector3(inputs.rate, new THREE.Vector3());
    const damping = Math.max(0, numberInput(inputs.damping, params.damping, 0));

    state.value.set(
      stepIntegrator({ current: state.value.x, rate: rate.x, dt, damping }),
      stepIntegrator({ current: state.value.y, rate: rate.y, dt, damping }),
      stepIntegrator({ current: state.value.z, rate: rate.z, dt, damping }),
    );

    const maxLength = Math.max(0, numberInput(undefined, params.maxLength, 0));
    if (maxLength > 0 && state.value.length() > maxLength) {
      state.value.setLength(maxLength);
    }

    // Cloned on the way out: a downstream node mutating the vector would
    // otherwise be writing straight into this node's accumulated state.
    return { value: state.value.clone(), length: state.value.length() };
  },
};
