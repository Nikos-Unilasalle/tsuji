import { NodeDefinition, NodeInstance, ParamFieldDef } from "../types";

/**
 * Blender-style named variables: a Set Variable node writes a value under a
 * name, a Get Variable node reads it back by picking that name from a
 * dropdown — no wire between them. This is the escape hatch for the case a
 * direct connection can't cover: reading a value from a node that lives in
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
 * Variable's name. Instead every Set Variable that evaluates this frame
 * registers its name, and Get Variable's dropdown reads that.
 */

export type VariableType = "Float" | "Int" | "String";

interface Registration {
  type: VariableType;
}

/**
 * Registered names/types, double-buffered by graph step rather than
 * accumulated forever.
 *
 * The naive version — add to a Set and never remove — looked right until
 * someone typed a name into the field: every keystroke is a live `evaluate`
 * call with that instant's half-typed text ("T", "To", "Tot", "Toto", ...),
 * and each one would have permanently registered itself, leaving Get
 * Variable's dropdown full of typing fragments long after the real name
 * ("Toto") was the only one anybody meant to keep.
 *
 * Instead each graph step (`ctx.step`) gets its own registration set: the
 * moment a Set Variable evaluates in a *new* step, the previous step's set
 * becomes "live" and a fresh "pending" one starts collecting. A name only
 * survives in the dropdown for as long as some Set Variable node is still
 * actually using it on recent frames — stop typing (or delete the node) and
 * the fragment ages out within a frame or two, no disposal bookkeeping needed.
 */
let pendingRegistrations = new Map<string, Registration>();
let liveRegistrations = new Map<string, Registration>();
let currentStep = -1;

function register(step: number, name: string, type: VariableType): void {
  if (step !== currentStep) {
    liveRegistrations = pendingRegistrations;
    pendingRegistrations = new Map();
    currentStep = step;
  }
  pendingRegistrations.set(name, { type });
}

function registeredType(name: string): VariableType | undefined {
  return pendingRegistrations.get(name)?.type ?? liveRegistrations.get(name)?.type;
}

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
  const names = new Set<string>([...liveRegistrations.keys(), ...pendingRegistrations.keys()]);
  return Array.from(names).sort();
}

/** Test seam. */
export function resetVariablesForTesting(): void {
  store = new Map();
  storeEpoch = 0;
  pendingRegistrations = new Map();
  liveRegistrations = new Map();
  currentStep = -1;
}

function normalizeName(raw: unknown): string {
  const name = String(raw ?? "").trim();
  return name.length > 0 ? name : "value";
}

function normalizeType(raw: unknown): VariableType {
  return raw === "Int" || raw === "String" ? raw : "Float";
}

function defaultForType(type: VariableType): unknown {
  return type === "String" ? "" : 0;
}

function coerceToType(raw: unknown, type: VariableType): unknown {
  if (type === "String") return raw === undefined || raw === null ? "" : String(raw);
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return type === "Int" ? Math.round(n) : n;
}

function nameOptions(instance: NodeInstance): string[] {
  const names = knownVariableNames();
  const current = normalizeName(instance.params.name);
  return names.includes(current) ? names : [current, ...names];
}

/**
 * Set Variable — stores its input (or Initial Value, when nothing is wired)
 * under Name, coerced to Type, and passes the same coerced value straight
 * through so it can sit inline in a chain instead of dead-ending it.
 */
export const SET_VARIABLE_NODE: NodeDefinition = {
  type: "variable/set",
  label: "Set Variable",
  category: "utility",
  inputs: [{ id: "value", label: "Value", type: "any" }],
  outputs: [{ id: "value", label: "Value", type: "any" }],
  defaultParams: { name: "myVariable", type: "Float", initial: 0 },
  dynamicParamFields: (instance): ParamFieldDef[] => {
    const type = normalizeType(instance.params.type);
    const initialField: ParamFieldDef =
      type === "String"
        ? { id: "initial", label: "Initial Value", kind: "text" }
        : { id: "initial", label: "Initial Value", kind: "number", step: type === "Int" ? 1 : 0.1 };
    return [
      { id: "name", label: "Name", kind: "text" },
      { id: "type", label: "Type", kind: "select", options: ["Float", "Int", "String"] },
      initialField,
    ];
  },
  evaluate: (inputs, params, ctx) => {
    ensureEpoch(ctx.simulationEpoch ?? 0);
    const name = normalizeName(params.name);
    const type = normalizeType(params.type);
    register(ctx.step, name, type);

    const raw = inputs.value !== undefined ? inputs.value : params.initial;
    const value = coerceToType(raw, type);
    store.set(name, value);
    return { value };
  },
};

/**
 * Get Variable — reads back whatever the matching Set Variable last wrote.
 * A name no Set Variable has ever declared reads back undefined (a
 * downstream node's own `numberInput`/`asVector3`-style fallback knows what
 * to do with that); a declared-but-not-yet-set-this-epoch name reads back
 * its type's default instead, since the type is already known.
 */
export const GET_VARIABLE_NODE: NodeDefinition = {
  type: "variable/get",
  label: "Get Variable",
  category: "utility",
  inputs: [],
  outputs: [{ id: "value", label: "Value", type: "any" }],
  defaultParams: { name: "myVariable" },
  dynamicParamFields: (instance): ParamFieldDef[] => [
    { id: "name", label: "Name", kind: "select", options: nameOptions(instance) },
  ],
  evaluate: (_inputs, params, ctx) => {
    ensureEpoch(ctx.simulationEpoch ?? 0);
    const name = normalizeName(params.name);
    if (store.has(name)) return { value: store.get(name) };
    const type = registeredType(name);
    return { value: type ? defaultForType(type) : undefined };
  },
};
