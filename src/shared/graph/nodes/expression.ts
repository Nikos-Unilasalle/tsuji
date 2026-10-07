import * as THREE from "three";
import { NodeDefinition, NodeInstance, ParamFieldDef } from "../types";
import { clockInput, numberInput } from "./object";
import { CompiledExpression, compileExpression, ExpressionError } from "../../math/expression";

/** The names a formula can read: each one a socket of the Expression node. */
export const EXPRESSION_VARIABLES = ["x", "y", "z", "t", "a", "b", "c", "d"] as const;

const compiled = new Map<string, CompiledExpression | ExpressionError>();

/**
 * A formula compiled once and reused, or the mistake in it. Shared by every
 * node that takes a formula, keyed by the formula and the names it may read.
 */
export function cachedExpression(source: string, variables: readonly string[]): CompiledExpression | ExpressionError {
  const key = `${variables.join(",")}|${source}`;
  let hit = compiled.get(key);
  if (!hit) {
    try {
      hit = compileExpression(source, [...variables]);
    } catch (e) {
      hit = e instanceof ExpressionError ? e : new ExpressionError(String(e), 0);
    }
    if (compiled.size > 500) compiled.delete(compiled.keys().next().value as string);
    compiled.set(key, hit);
  }
  return hit;
}

/** A read-only warning line naming the mistake in a formula param, for dynamicParamFields. */
export function formulaErrorField(id: string, source: unknown, variables: readonly string[]): ParamFieldDef[] {
  const result = cachedExpression(String(source ?? ""), variables);
  if (!(result instanceof ExpressionError)) return [];
  return [{ id: `${id}Error`, label: `⚠ ${result.message} (at character ${result.position + 1})`, kind: "note", tone: "warn" }];
}

const BASE_FIELDS: ParamFieldDef[] = [
  { id: "formula", label: "Formula", kind: "text", group: "Formula" },
  { id: "a", label: "a (when unwired)", kind: "number", step: 0.1, group: "Parameters" },
  { id: "b", label: "b (when unwired)", kind: "number", step: 0.1, group: "Parameters" },
  { id: "c", label: "c (when unwired)", kind: "number", step: 0.1, group: "Parameters" },
  { id: "d", label: "d (when unwired)", kind: "number", step: 0.1, group: "Parameters" },
  { id: "x", label: "x (when unwired)", kind: "number", step: 0.1, group: "Parameters" },
  { id: "y", label: "y (when unwired)", kind: "number", step: 0.1, group: "Parameters" },
  { id: "z", label: "z (when unwired)", kind: "number", step: 0.1, group: "Parameters" },
  {
    id: "help",
    label:
      "Write it as on paper: 2x² − 3x + 1, 3sin x, (x+1)(x−1), √(1 − x²), |x|, e^(−x²). ln is the natural log, log the decimal one. " +
      "x < 0 ? −x : x (or if(x < 0, −x, x)) for pieces. A comma list — (cos t, sin t, t/4) — gives a vector. " +
      "t follows the timeline unless wired; wire a list into any letter to get one result per item.",
    kind: "note",
    group: "Formula",
  },
];

/**
 * Expression — a formula typed as on paper, evaluated with the values wired
 * into its letters. The building block under every math node (curves,
 * surfaces, fields), and useful on its own anywhere a number has a rule:
 * `0.5 + 0.5 sin(2πt)` to pulse a light, `a x² + b` to place a point.
 *
 * Unwired, a–d and x–z read their panel values (sliders to scrub) and t
 * reads the timeline. Wire a list into any letter and the formula runs once
 * per item, so `x²` over a list of x gives the list of squares.
 */
export const EXPRESSION_NODE: NodeDefinition = {
  type: "math/expression",
  label: "Expression",
  category: "math",
  inputs: EXPRESSION_VARIABLES.map((v) => ({ id: v, label: v, type: "any" as const })),
  outputs: [
    { id: "value", label: "Value", type: "value" },
    { id: "vector", label: "Vector (comma list)", type: "vector" },
    { id: "list", label: "List (per item)", type: "list" },
  ],
  defaultParams: { formula: "sin(x)", a: 1, b: 0, c: 0, d: 0, x: 0, y: 0, z: 0 },
  paramFields: BASE_FIELDS,
  dynamicParamFields: (instance: NodeInstance) => [...formulaErrorField("formula", instance.params.formula, EXPRESSION_VARIABLES), ...BASE_FIELDS],
  evaluate: (inputs, params, ctx) => {
    const result = cachedExpression(String(params.formula ?? ""), EXPRESSION_VARIABLES);
    if (result instanceof ExpressionError) return { value: 0, vector: new THREE.Vector3(), list: [] };

    const scope: Record<string, number> = {};
    let length = -1;
    for (const v of EXPRESSION_VARIABLES) {
      const raw = inputs[v];
      if (Array.isArray(raw)) length = Math.max(length, raw.length);
      else scope[v] = v === "t" ? clockInput(inputs, params, ctx, "t") : numberInput(raw, params[v], 0);
    }

    const toVector = (r: number[]) => new THREE.Vector3(r[0] ?? 0, r[1] ?? 0, r[2] ?? 0);
    if (length < 0) {
      const r = result.evaluate(scope);
      return { value: r[0], vector: toVector(r), list: [result.dimension > 1 ? toVector(r) : r[0]] };
    }

    const list: (number | THREE.Vector3)[] = [];
    for (let i = 0; i < length; i++) {
      for (const v of EXPRESSION_VARIABLES) {
        const raw = inputs[v];
        if (!Array.isArray(raw)) continue;
        const item = raw[Math.min(i, raw.length - 1)];
        scope[v] = numberInput(item, 0, 0);
      }
      const r = result.evaluate(scope);
      list.push(result.dimension > 1 ? toVector(r) : r[0]);
    }
    const first = list[0];
    return {
      value: typeof first === "number" ? first : first ? first.x : 0,
      vector: first instanceof THREE.Vector3 ? first.clone() : new THREE.Vector3(),
      list,
    };
  },
};
