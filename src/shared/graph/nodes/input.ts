import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { growingSockets } from "../dynamicInputs";
import { fromBoolean } from "../sockets";
import { numberInput } from "./object";
import {
  GamepadSnapshot,
  STANDARD_BUTTONS,
  StandardButton,
  applyDeadzone,
  applyStickDeadzone,
  axisValue,
  buttonValue,
  getGamepadSnapshot,
  maxButton,
} from "../gamepadRuntime";

/* -------------------------------------------------------------------------- */
/* Gamepad                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Gamepad — one controller, read fresh each frame.
 *
 * Polled rather than listened to, because that is how the browser exposes
 * gamepads: `getGamepads()` hands back a snapshot, not a live object. That
 * happens to be exactly what a graph wants, so unlike the Keyboard node there
 * is no global state here to drift out of sync.
 *
 * The stick outputs come in two shapes on purpose. The scalar axes are the raw
 * browser convention (up is −1), for anyone wiring an axis into arbitrary
 * maths; the vector outputs are pre-mapped onto the ground plane as (x, 0, y),
 * which in a Y-up, −Z-forward world means pushing the stick up walks the
 * character forward. Almost every use is the second one, and deriving it by
 * hand every time invites the sign error.
 */
export const GAMEPAD_NODE: NodeDefinition = {
  type: "io/gamepad",
  label: "Gamepad",
  category: "io",
  inputs: [
    { id: "index", label: "Player Index", type: "value" },
    { id: "deadzone", label: "Deadzone", type: "value" },
  ],
  outputs: [
    { id: "connected", label: "Connected", type: "value" },
    { id: "leftStick", label: "Left Stick (XZ)", type: "vector" },
    { id: "rightStick", label: "Right Stick (XZ)", type: "vector" },
    { id: "leftX", label: "Left X", type: "value" },
    { id: "leftY", label: "Left Y", type: "value" },
    { id: "rightX", label: "Right X", type: "value" },
    { id: "rightY", label: "Right Y", type: "value" },
    { id: "leftTrigger", label: "Left Trigger", type: "value" },
    { id: "rightTrigger", label: "Right Trigger", type: "value" },
    { id: "dpad", label: "D-Pad (XZ)", type: "vector" },
    { id: "a", label: "A / Cross", type: "value" },
    { id: "b", label: "B / Circle", type: "value" },
    { id: "x", label: "X / Square", type: "value" },
    { id: "y", label: "Y / Triangle", type: "value" },
    { id: "leftBumper", label: "Left Bumper", type: "value" },
    { id: "rightBumper", label: "Right Bumper", type: "value" },
    { id: "start", label: "Start", type: "value" },
    { id: "anyButton", label: "Any Button", type: "value" },
    { id: "buttons", label: "All Buttons", type: "list" },
  ],
  defaultParams: {
    index: 0,
    deadzone: 0.15,
    triggerDeadzone: 0.05,
  },
  paramFields: [
    { id: "index", label: "Player Index (0–3)", kind: "number", step: 1 },
    { id: "deadzone", label: "Stick Deadzone", kind: "number", step: 0.01 },
    { id: "triggerDeadzone", label: "Trigger Deadzone", kind: "number", step: 0.01 },
    {
      id: "note",
      label:
        "Browsers hide gamepads from a page until the user presses something on them — " +
        "a controller that is plugged in but untouched reads as disconnected. Press a button once.",
      kind: "note",
    },
  ],
  evaluate: (inputs, params) => {
    const index = Math.max(0, Math.floor(numberInput(inputs.index, params.index, 0)));
    const deadzone = Math.max(0, Math.min(0.95, numberInput(inputs.deadzone, params.deadzone, 0.15)));
    const triggerDeadzone = Math.max(0, Math.min(0.95, numberInput(undefined, params.triggerDeadzone, 0.05)));

    const pad: GamepadSnapshot = getGamepadSnapshot(index);

    const left = applyStickDeadzone(axisValue(pad, 0), axisValue(pad, 1), deadzone);
    const right = applyStickDeadzone(axisValue(pad, 2), axisValue(pad, 3), deadzone);

    const button = (name: StandardButton) => buttonValue(pad, name);

    // The d-pad is four digital buttons; folding them into one vector is what
    // makes it interchangeable with a stick downstream.
    const dpadX = button("dpadRight") - button("dpadLeft");
    const dpadY = button("dpadDown") - button("dpadUp");

    return {
      connected: fromBoolean(pad.connected),
      leftStick: new THREE.Vector3(left.x, 0, left.y),
      rightStick: new THREE.Vector3(right.x, 0, right.y),
      leftX: left.x,
      leftY: left.y,
      rightX: right.x,
      rightY: right.y,
      leftTrigger: applyDeadzone(button("leftTrigger"), triggerDeadzone),
      rightTrigger: applyDeadzone(button("rightTrigger"), triggerDeadzone),
      dpad: new THREE.Vector3(dpadX, 0, dpadY),
      a: button("a"),
      b: button("b"),
      x: button("x"),
      y: button("y"),
      leftBumper: button("leftBumper"),
      rightBumper: button("rightBumper"),
      start: button("start"),
      anyButton: maxButton(pad),
      buttons: Object.keys(STANDARD_BUTTONS).map((name) => buttonValue(pad, name as StandardButton)),
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Action Map                                                                 */
/* -------------------------------------------------------------------------- */

interface ActionState {
  value: number;
  time: number;
  active: boolean;
}

const actionCache = createNodeCache<ActionState>();

export const ACTION_COMBINE_MODES = ["strongest", "sum", "average"] as const;
export type ActionCombineMode = (typeof ACTION_COMBINE_MODES)[number];

/**
 * Combines a set of raw source values into one signed action value.
 *
 * `strongest` is the default because it is what "several ways to do the same
 * thing" means: holding W *and* pushing the stick forward should walk at one
 * speed, not two.
 */
export function combineSources(values: number[], mode: ActionCombineMode): number {
  const usable = values.filter((v) => Number.isFinite(v));
  if (usable.length === 0) return 0;

  if (mode === "sum") return usable.reduce((total, v) => total + v, 0);
  if (mode === "average") return usable.reduce((total, v) => total + v, 0) / usable.length;

  let strongest = 0;
  for (const value of usable) {
    if (Math.abs(value) > Math.abs(strongest)) strongest = value;
  }
  return strongest;
}

/**
 * Exponential smoothing toward a target, framerate-independent.
 *
 * `smoothing` is the time in seconds to close most of the gap, not a
 * per-frame blend factor — the same reason the Interaction Map's fade is a
 * half-life. A per-frame lerp makes a control feel sharper on a fast machine
 * than on a slow one, which is the kind of bug that only shows up on someone
 * else's hardware.
 */
export function smoothToward(current: number, target: number, smoothing: number, delta: number): number {
  if (smoothing <= 0 || delta <= 0) return target;
  const blend = 1 - Math.exp(-delta / smoothing);
  return current + (target - current) * blend;
}

const POSITIVE_PREFIX = "pos";
const NEGATIVE_PREFIX = "neg";

/**
 * Action Map — several inputs, one named action.
 *
 * This is the brick that keeps a control scheme out of the rest of the graph.
 * "Move forward" is one wire, and whether it came from W, the left stick, a
 * d-pad or a touch control is this node's business alone. Without it, every
 * consumer has to know about every input device, and adding a gamepad means
 * editing the whole graph rather than one node.
 *
 * Positive and Negative are separate growing sockets because most actions are
 * really axes: forward *minus* back, right *minus* left. Wiring D into
 * Positive and A into Negative gives a −1…1 axis from two digital keys, which
 * is the case an "add up the inputs" node cannot express.
 *
 * It reads no hardware of its own. Keyboard, Gamepad and Mouse nodes do that;
 * this one only combines, and so works just as well on a value from an
 * oscillator, an audio peak or a network feed.
 */
export const ACTION_MAP_NODE: NodeDefinition = {
  type: "io/action-map",
  label: "Action Map",
  category: "io",
  inputs: [
    { id: `${POSITIVE_PREFIX}0`, label: "Positive 1", type: "value" },
    { id: `${NEGATIVE_PREFIX}0`, label: "Negative 1", type: "value" },
  ],
  dynamicInputs: (connections) => [
    ...growingSockets(connections, POSITIVE_PREFIX, (i) => ({
      id: `${POSITIVE_PREFIX}${i}`,
      label: `Positive ${i + 1}`,
      type: "value" as const,
    })),
    ...growingSockets(connections, NEGATIVE_PREFIX, (i) => ({
      id: `${NEGATIVE_PREFIX}${i}`,
      label: `Negative ${i + 1}`,
      type: "value" as const,
    })),
  ],
  outputs: [
    { id: "value", label: "Value", type: "value" },
    { id: "active", label: "Active", type: "value" },
    { id: "pressed", label: "Pressed", type: "value" },
    { id: "released", label: "Released", type: "value" },
  ],
  defaultParams: {
    action: "move",
    mode: "strongest",
    scale: 1,
    deadzone: 0,
    smoothing: 0,
    threshold: 0.5,
    clamp: true,
    invert: false,
  },
  paramFields: [
    { id: "action", label: "Action Name", kind: "text" },
    { id: "mode", label: "Combine", kind: "select", options: [...ACTION_COMBINE_MODES] },
    { id: "scale", label: "Scale", kind: "number", step: 0.1 },
    { id: "invert", label: "Invert", kind: "boolean" },
    { id: "clamp", label: "Clamp to -1…1", kind: "boolean" },
    { id: "deadzone", label: "Deadzone", kind: "number", step: 0.01 },
    { id: "smoothing", label: "Smoothing (seconds to settle)", kind: "number", step: 0.02 },
    { id: "threshold", label: "Active Threshold", kind: "number", step: 0.05 },
  ],
  evaluate: (inputs, params, ctx) => {
    const mode = (ACTION_COMBINE_MODES as readonly string[]).includes(String(params.mode))
      ? (params.mode as ActionCombineMode)
      : "strongest";

    const gather = (prefix: string): number[] => {
      const values: number[] = [];
      for (const [key, raw] of Object.entries(inputs)) {
        if (!key.startsWith(prefix)) continue;
        const value = Number(raw);
        if (Number.isFinite(value)) values.push(value);
      }
      return values;
    };

    const positive = combineSources(gather(POSITIVE_PREFIX), mode);
    const negative = combineSources(gather(NEGATIVE_PREFIX), mode);

    let value = positive - negative;

    value = applyDeadzone(value, Math.max(0, Math.min(0.95, numberInput(undefined, params.deadzone, 0))));
    value *= numberInput(undefined, params.scale, 1);
    if (params.invert) value = -value;
    if (params.clamp ?? true) value = Math.max(-1, Math.min(1, value));

    const time = ctx.time ?? 0;
    const previous = actionCache.get(ctx.nodeId);
    const delta = previous ? Math.max(0, time - previous.time) : 0;

    const smoothing = Math.max(0, numberInput(undefined, params.smoothing, 0));
    const smoothed = previous ? smoothToward(previous.value, value, smoothing, delta) : value;

    const threshold = Math.max(0, numberInput(undefined, params.threshold, 0.5));
    const active = Math.abs(smoothed) >= threshold;
    const wasActive = previous?.active ?? false;

    actionCache.set(ctx.nodeId, { value: smoothed, time, active });

    return {
      value: smoothed,
      active: fromBoolean(active),
      pressed: fromBoolean(active && !wasActive),
      released: fromBoolean(!active && wasActive),
    };
  },
};
