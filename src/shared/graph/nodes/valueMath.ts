import { NodeDefinition } from "../types";

const OPS: Record<string, (a: number, b: number) => number> = {
  add: (a, b) => a + b,
  subtract: (a, b) => a - b,
  multiply: (a, b) => a * b,
  divide: (a, b) => (b === 0 ? 0 : a / b),
  min: Math.min,
  max: Math.max,
  clamp: (a, b) => Math.min(Math.max(a, 0), b > 0 ? b : 1),
  mod: (a, b) => {
    if (b === 0) return 0;
    const abs = Math.abs(b);
    return ((a % abs) + abs) % abs;
  },
  power: Math.pow,
  // Unary, like every other op here it still takes (a, b) — b is just
  // unused, so a wire into B keeps working (silently ignored) rather than
  // needing its own single-input node.
  abs: (a) => Math.abs(a),
  "less-than": (a, b) => (a < b ? 1 : 0),
};

/** One node, an `op` param picks the operation — matches Blender's Math node rather than a node per operator. */
export const VALUE_MATH_NODE: NodeDefinition = {
  type: "value/math",
  label: "Value Math",
  category: "math",
  inputs: [
    { id: "a", label: "A", type: "value" },
    { id: "b", label: "B", type: "value" },
  ],
  outputs: [{ id: "out", label: "Out", type: "value" }],
  defaultParams: { op: "add", a: 0, b: 0 },
  paramFields: [
    { id: "op", label: "Operation", kind: "select", options: Object.keys(OPS) },
    { id: "a", label: "A (fallback)", kind: "number" },
    { id: "b", label: "B (fallback)", kind: "number" },
  ],
  evaluate: (inputs, params) => {
    const op = OPS[String(params.op)] ?? OPS.add;
    const a = inputs.a !== undefined ? Number(inputs.a) : (Number(params.a) || 0);
    const b = inputs.b !== undefined ? Number(inputs.b) : (Number(params.b) || 0);
    return { out: op(isNaN(a) ? 0 : a, isNaN(b) ? 0 : b) };
  },
};

/** Clamp node — restricts an incoming scalar value between Min and Max limits. */
export const CLAMP_NODE: NodeDefinition = {
  type: "value/clamp",
  label: "Clamp",
  category: "math",
  inputs: [
    { id: "value", label: "Value", type: "value" },
    { id: "min", label: "Min", type: "value" },
    { id: "max", label: "Max", type: "value" },
  ],
  outputs: [{ id: "out", label: "Out", type: "value" }],
  defaultParams: { value: 0, min: 0, max: 1 },
  paramFields: [
    { id: "value", label: "Value (fallback)", kind: "number" },
    { id: "min", label: "Min Limit", kind: "number" },
    { id: "max", label: "Max Limit", kind: "number" },
  ],
  evaluate: (inputs, params) => {
    const val = inputs.value !== undefined ? Number(inputs.value) : (Number(params.value) || 0);
    const minVal = inputs.min !== undefined ? Number(inputs.min) : (params.min !== undefined ? Number(params.min) : 0);
    const maxVal = inputs.max !== undefined ? Number(inputs.max) : (params.max !== undefined ? Number(params.max) : 1);

    const safeVal = isNaN(val) ? 0 : val;
    const safeMin = isNaN(minVal) ? 0 : minVal;
    const safeMax = isNaN(maxVal) ? 1 : maxVal;

    const lower = Math.min(safeMin, safeMax);
    const upper = Math.max(safeMin, safeMax);

    return { out: Math.min(upper, Math.max(lower, safeVal)) };
  },
};

/**
 * A bare constant — the simplest possible source for a Value socket.
 * "Integer" isn't a separate socket type (the graph only has one numeric
 * type, "value") — it's a display/rounding mode on this node: step >= 1
 * makes DragNumberInput auto-format/scrub as a whole number (see its
 * isIntegerField), and evaluate() rounds so a wired Count/Index downstream
 * actually gets a whole number rather than a float that happens to display
 * rounded.
 */
export const VALUE_CONSTANT_NODE: NodeDefinition = {
  type: "value/constant",
  label: "Value",
  category: "math",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: "value" }],
  defaultParams: { type: "float", value: 0 },
  dynamicParamFields: (instance) => {
    const isInteger = instance.params.type === "integer";
    return [
      { id: "type", label: "Type", kind: "select", options: ["float", "integer"] },
      { id: "value", label: "Value", kind: "number", step: isInteger ? 1 : 0.1 },
    ];
  },
  evaluate: (_inputs, params) => {
    const raw = Number(params.value) || 0;
    return { out: params.type === "integer" ? Math.round(raw) : raw };
  },
};

/**
 * Expected to be the single most-used node in the catalogue — the universal
 * "rescale a value from one range to another," which is what every sensor- or
 * audio-to-parameter mapping reduces to. Clamps to the output range by
 * default (unclamped extrapolation is rarely what a VJ wants from a live
 * signal that briefly spikes past its expected range).
 */
export const MAP_RANGE_NODE: NodeDefinition = {
  type: "value/map-range",
  label: "Map Range",
  category: "math",
  inputs: [{ id: "value", label: "Value", type: "value" }],
  outputs: [{ id: "out", label: "Out", type: "value" }],
  defaultParams: { inMin: 0, inMax: 1, outMin: 0, outMax: 1, clamp: 1 },
  paramFields: [
    { id: "inMin", label: "In Min", kind: "number" },
    { id: "inMax", label: "In Max", kind: "number" },
    { id: "outMin", label: "Out Min", kind: "number" },
    { id: "outMax", label: "Out Max", kind: "number" },
    { id: "clamp", label: "Clamp", kind: "boolean" },
  ],
  evaluate: (inputs, params) => {
    const inMin = Number(params.inMin) || 0;
    const inMax = Number(params.inMax) || 0;
    const outMin = Number(params.outMin) || 0;
    const outMax = Number(params.outMax) || 0;
    const value = Number(inputs.value) || 0;

    const span = inMax - inMin;
    let t = span === 0 ? 0 : (value - inMin) / span;
    if (params.clamp) t = Math.min(1, Math.max(0, t));

    return { out: outMin + t * (outMax - outMin) };
  },
};
