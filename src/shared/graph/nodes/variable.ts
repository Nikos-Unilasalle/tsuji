import { NodeDefinition, NodeInstance } from "../types";

/**
 * Blender-style named variables: a Set Variable node writes a value under a
 * name, a Get Variable node reads it back by picking that name from a
 * dropdown — no wire between them. This is the escape hatch for the case a
 * direct connection can't cover: reading a value from a node that live in
 * another part of the graph, or in another canvas entirely.
 *
 * The store is a single module-level Map, not per-canvas. Only the active
 * canvas is ever evaluated (see types.ts's Project doc), so a Set Variable
 * sitting in canvas 2 could not keep a per-canvas slot alive while canvas 5
 * runs — the value would vanish the moment you left. Keeping it global is
 * what lets a score, a difficulty level, or a "which room am I in" flag
 * survive a Go To Canvas switch (canvas.ts) instead of resetting to nothing.
 *
 * `dynamicParamFields` only ever sees its own instance, not the graph (see
 * NodeDefinition's doc) — a Get Variable can't scan the tree for every Set
 * Variable's name. Instead every Set Variable that has ever evaluated adds
 * its name to `knownNames`, and Get Variable's dropdown reads that — the same
 * "leave it in a module slot for the app to notice" indirection already used
 * by canvasSwitchStore and the inspector.
 */

const knownNames = new Set<string>();

let store = new Map<string, unknown>();
let storeEpoch = 0;

/**
 * Variables are simulation-like state — the reset that clears an
 * integrator's accumulated total (see simulationEpoch.ts) clears these too,
 * rather than leaving a stale score or flag behind from before the reset.
 * Names already seen are kept, so the dropdown doesn't empty out.
 */
function ensureEpoch(epoch: number): void {
  if (epoch !== storeEpoch) {
    store = new Map();
    storeEpoch = epoch;
  }
}

export function knownVariableNames(): string[] {
  return Array.from(knownNames).sort();
}

/** Test seam. */
export function resetVariablesForTesting(): void {
  store = new Map();
  knownNames.clear();
  storeEpoch = 0;
}

function normalizeName(raw: unknown): string {
  const name = String(raw ?? "").trim();
  return name.length > 0 ? name : "value";
}

function nameOptions(instance: NodeInstance): string[] {
  const names = knownVariableNames();
  const current = normalizeName(instance.params.name);
  return names.includes(current) ? names : [current, ...names];
}

/**
 * Set Variable — stores its input under Name and passes it straight through,
 * so it can sit inline in a chain instead of dead-ending it.
 */
export const SET_VARIABLE_NODE: NodeDefinition = {
  type: "variable/set",
  label: "Set Variable",
  category: "utility",
  inputs: [{ id: "value", label: "Value", type: "any" }],
  outputs: [{ id: "value", label: "Value", type: "any" }],
  defaultParams: { name: "myVariable" },
  paramFields: [{ id: "name", label: "Name", kind: "text" }],
  evaluate: (inputs, params, ctx) => {
    ensureEpoch(ctx.simulationEpoch ?? 0);
    const name = normalizeName(params.name);
    knownNames.add(name);
    store.set(name, inputs.value);
    return { value: inputs.value };
  },
};

/**
 * Get Variable — reads back whatever the matching Set Variable last wrote.
 * Undefined (never set, or cleared by a simulation reset) rather than 0: a
 * downstream node's own `numberInput`/`asVector3`-style fallback already
 * knows what to do with that, and guessing a type here would be wrong as
 * often as not.
 */
export const GET_VARIABLE_NODE: NodeDefinition = {
  type: "variable/get",
  label: "Get Variable",
  category: "utility",
  inputs: [],
  outputs: [{ id: "value", label: "Value", type: "any" }],
  defaultParams: { name: "myVariable" },
  dynamicParamFields: (instance) => [
    { id: "name", label: "Name", kind: "select", options: nameOptions(instance) },
  ],
  evaluate: (_inputs, params, ctx) => {
    ensureEpoch(ctx.simulationEpoch ?? 0);
    const name = normalizeName(params.name);
    return { value: store.has(name) ? store.get(name) : undefined };
  },
};
