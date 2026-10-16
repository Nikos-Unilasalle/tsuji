import { NodeDefinition } from "../types";
import { fromBoolean, SocketType, toBoolean } from "../sockets";
import { createNodeCache } from "../nodeCaches";

const COMPARE_OPS = ["equal", "not_equal", "greater", "greater_equal", "less", "less_equal"];

/** Compare node — compares two scalar values and outputs 0 or 1 (boolean). */
export const COMPARE_NODE: NodeDefinition = {
  type: "logic/compare",
  label: "Compare",
  category: "logic",
  pure: true,
  inputs: [
    { id: "a", label: "A", type: "value" },
    { id: "b", label: "B", type: "value" },
  ],
  outputs: [{ id: "out", label: "Out", type: "value" }],
  defaultParams: { op: "equal", a: 0, b: 0 },
  paramFields: [
    { id: "op", label: "Operation", kind: "select", options: COMPARE_OPS },
    { id: "a", label: "A (fallback)", kind: "number" },
    { id: "b", label: "B (fallback)", kind: "number" },
  ],
  evaluate: (inputs, params) => {
    const a = inputs.a !== undefined ? Number(inputs.a) || 0 : Number(params.a) || 0;
    const b = inputs.b !== undefined ? Number(inputs.b) || 0 : Number(params.b) || 0;
    const op = String(params.op || "equal");

    let res = false;
    switch (op) {
      case "equal":
        res = Math.abs(a - b) < 1e-6;
        break;
      case "not_equal":
        res = Math.abs(a - b) >= 1e-6;
        break;
      case "greater":
        res = a > b;
        break;
      case "greater_equal":
        res = a >= b;
        break;
      case "less":
        res = a < b;
        break;
      case "less_equal":
        res = a <= b;
        break;
      default:
        res = Math.abs(a - b) < 1e-6;
    }

    return { out: fromBoolean(res) };
  },
};

const LOGIC_OPS = ["and", "or", "not", "xor", "nand", "nor"];

/** Boolean Logic node — AND/OR/NOT/XOR operations on value inputs. */
export const BOOLEAN_LOGIC_NODE: NodeDefinition = {
  type: "logic/boolean",
  label: "Boolean Logic",
  category: "logic",
  pure: true,
  inputs: [
    { id: "a", label: "A", type: "value" },
    { id: "b", label: "B", type: "value" },
  ],
  outputs: [{ id: "out", label: "Out", type: "value" }],
  defaultParams: { op: "and", a: 0, b: 0 },
  paramFields: [
    { id: "op", label: "Operation", kind: "select", options: LOGIC_OPS },
    { id: "a", label: "A (fallback)", kind: "boolean" },
    { id: "b", label: "B (fallback)", kind: "boolean" },
  ],
  evaluate: (inputs, params) => {
    const a = toBoolean(inputs.a !== undefined ? inputs.a : params.a);
    const b = toBoolean(inputs.b !== undefined ? inputs.b : params.b);
    const op = String(params.op || "and");

    let res = false;
    switch (op) {
      case "and":
        res = a && b;
        break;
      case "or":
        res = a || b;
        break;
      case "not":
        res = !a;
        break;
      case "xor":
        res = (a && !b) || (!a && b);
        break;
      case "nand":
        res = !(a && b);
        break;
      case "nor":
        res = !(a || b);
        break;
      default:
        res = a && b;
    }

    return { out: fromBoolean(res) };
  },
};

/** State map for Trigger node: node ID -> previous boolean state */
const triggerStateCache = createNodeCache<boolean>();

/** Trigger node — rising-edge detector. Outputs 1 on the exact step the input transitions from false to true. */
export const TRIGGER_NODE: NodeDefinition = {
  type: "logic/trigger",
  label: "Trigger",
  category: "logic",
  inputs: [{ id: "in", label: "In", type: "value" }],
  outputs: [{ id: "trigger", label: "Trigger", type: "value" }],
  defaultParams: { in: 0 },
  paramFields: [{ id: "in", label: "In (fallback)", kind: "boolean" }],
  evaluate: (inputs, params, ctx) => {
    const current = toBoolean(inputs.in !== undefined ? inputs.in : params.in);
    const prev = triggerStateCache.get(ctx.nodeId) ?? false;
    triggerStateCache.set(ctx.nodeId, current);

    const isRisingEdge = current && !prev;
    return { trigger: fromBoolean(isRisingEdge) };
  },
};

/** State map for Toggle node: node ID -> { state: boolean, prevTrigger: boolean } */
const toggleStateCache = createNodeCache<{ state: boolean; prevTrigger: boolean }>();

/** Toggle node — flip-flop that toggles output state (0/1) on rising edge of trigger input. */
export const TOGGLE_NODE: NodeDefinition = {
  type: "logic/toggle",
  label: "Toggle",
  category: "logic",
  inputs: [{ id: "trigger", label: "Trigger", type: "value" }],
  outputs: [{ id: "out", label: "Out", type: "value" }],
  defaultParams: { initial: 0 },
  paramFields: [{ id: "initial", label: "Initial State", kind: "boolean" }],
  evaluate: (inputs, params, ctx) => {
    const trig = toBoolean(inputs.trigger);
    const cached = toggleStateCache.get(ctx.nodeId) || {
      state: toBoolean(params.initial),
      prevTrigger: false,
    };

    if (trig && !cached.prevTrigger) {
      cached.state = !cached.state;
    }
    cached.prevTrigger = trig;
    toggleStateCache.set(ctx.nodeId, cached);

    return { out: fromBoolean(cached.state) };
  },
};

/** Gate/Switch node — passes input value if enable is truthy, otherwise outputs fallback/0. */
export const GATE_NODE: NodeDefinition = {
  type: "logic/gate",
  label: "Gate",
  category: "logic",
  pure: true,
  inputs: [
    { id: "value", label: "Value", type: "value" },
    { id: "enable", label: "Enable", type: "value" },
  ],
  outputs: [{ id: "out", label: "Out", type: "value" }],
  defaultParams: { value: 0, enable: 1, offValue: 0 },
  paramFields: [
    { id: "value", label: "Value (fallback)", kind: "number" },
    { id: "enable", label: "Enable (fallback)", kind: "boolean" },
    { id: "offValue", label: "Off Value", kind: "number" },
  ],
  evaluate: (inputs, params) => {
    const enable = toBoolean(inputs.enable !== undefined ? inputs.enable : params.enable);
    const value = inputs.value !== undefined ? Number(inputs.value) || 0 : Number(params.value) || 0;
    const offValue = Number(params.offValue) || 0;

    return { out: enable ? value : offValue };
  },
};

/**
 * Logic Bridge node — Conditional Multiplexer / Switch.
 * Selects between Input A (If True) and Input B (If False) based on Condition (0 or 1).
 * Inputs A & B and Output dynamically adapt to match whatever socket type is connected to them.
 */
export const LOGIC_BRIDGE_NODE: NodeDefinition = {
  type: "logic/bridge",
  label: "Logic Bridge",
  category: "logic",
  pure: true,
  inputs: [
    { id: "condition", label: "Condition", type: "value" },
    { id: "ifTrue", label: "If True (A)", type: "any", owns: true },
    { id: "ifFalse", label: "If False (B)", type: "any", owns: true },
  ],
  dynamicInputs: (_connections, connectionTypes) => {
    const connTrue = connectionTypes?.find((c) => c.connection.toSocket === "ifTrue");
    const connFalse = connectionTypes?.find((c) => c.connection.toSocket === "ifFalse");

    const activeType: SocketType =
      (connTrue && connTrue.sourceSocketType !== "any" ? connTrue.sourceSocketType : undefined) ||
      (connFalse && connFalse.sourceSocketType !== "any" ? connFalse.sourceSocketType : undefined) ||
      "any";

    return [
      { id: "condition", label: "Condition", type: "value" },
      { id: "ifTrue", label: "If True (A)", type: activeType, owns: true },
      { id: "ifFalse", label: "If False (B)", type: activeType, owns: true },
    ];
  },
  dynamicOutputs: (_connections, connectionTypes) => {
    const connTrue = connectionTypes?.find((c) => c.connection.toSocket === "ifTrue");
    const connFalse = connectionTypes?.find((c) => c.connection.toSocket === "ifFalse");

    const activeType: SocketType =
      (connTrue && connTrue.sourceSocketType !== "any" ? connTrue.sourceSocketType : undefined) ||
      (connFalse && connFalse.sourceSocketType !== "any" ? connFalse.sourceSocketType : undefined) ||
      "any";

    return [{ id: "out", label: "Output", type: activeType }];
  },
  outputs: [{ id: "out", label: "Output", type: "any" }],
  defaultParams: { condition: 1 },
  paramFields: [{ id: "condition", label: "Condition (1=True, 0=False)", kind: "boolean" }],
  evaluate: (inputs, params) => {
    const cond = toBoolean(inputs.condition !== undefined ? inputs.condition : params.condition);
    const valTrue = inputs.ifTrue;
    const valFalse = inputs.ifFalse;

    const result = cond ? valTrue : valFalse;
    return { out: result };
  },
};
