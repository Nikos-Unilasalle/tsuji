import type { NodeDefinition, ParamFieldDef } from "../types";
import type { SocketDef } from "../sockets";

/**
 * Params opened as inputs, on demand: a node's number, on/off and choice params can each be given a value socket from
 * the param panel (the plug beside the field), so a user's own procedure — an LFO, a noise, a counter, a probe of
 * another track — can drive it. Only the params asked for get a socket, so a node with dozens of knobs (an FM voice)
 * stays readable until someone wants to play one of them.
 *
 * The params opened are listed in the instance's own `paramInputs` param. A wired value replaces the param for the
 * evaluation: a number as it comes, an on/off by > 0, a choice by its index in the list (wrapping — 0 is the first,
 * −1 the last), so counting through scales or modes is one wire.
 */
export const PARAM_INPUTS_KEY = "paramInputs";
const KINDS = new Set(["number", "boolean", "select"]);

/** The params of a definition that can be opened as inputs: not already a socket, not a whole patch (a preset). */
export function socketableFields(def: Pick<NodeDefinition, "inputs" | "paramFields">): ParamFieldDef[] {
  const taken = new Set(def.inputs.map((s) => s.id));
  return (def.paramFields ?? []).filter((f) => KINDS.has(f.kind) && !taken.has(f.id) && f.id !== "preset");
}

/** The ids of the params opened on an instance (unknown ones dropped). */
export function openedParams(params: Record<string, unknown> | undefined, fields: readonly ParamFieldDef[]): ParamFieldDef[] {
  const list = params?.[PARAM_INPUTS_KEY];
  if (!Array.isArray(list) || list.length === 0) return [];
  return fields.filter((f) => list.includes(f.id));
}

/** A socket's label: the field's label up to its first explanation. */
const shortLabel = (f: ParamFieldDef) => String(f.label ?? f.id).split(/ [—(]/)[0];

/** A wired value read as the param's kind; undefined when it cannot be. */
export function paramFromInput(f: ParamFieldDef, v: unknown): unknown {
  const x = typeof v === "boolean" ? (v ? 1 : 0) : Number(v);
  if (!Number.isFinite(x)) return undefined;
  if (f.kind === "boolean") return x > 0;
  if (f.kind === "select") {
    const options = (f as { options?: readonly unknown[] }).options ?? [];
    if (options.length === 0) return undefined;
    const n = options.length;
    return options[((Math.round(x) % n) + n) % n];
  }
  return x;
}

/** The definition, with params that can be opened as inputs. */
export function withParamInputs(def: NodeDefinition): NodeDefinition {
  const fields = socketableFields(def);
  if (fields.length === 0) return def;
  const socketOf = (f: ParamFieldDef): SocketDef => ({ id: f.id, label: shortLabel(f), type: "value" });
  return {
    ...def,
    paramInputs: fields.map((f) => f.id),
    dynamicInputs: (connections, types, params) => {
      const base = def.dynamicInputs ? def.dynamicInputs(connections, types, params) : def.inputs;
      const opened = openedParams(params, fields);
      return opened.length === 0 ? base : [...base, ...opened.map(socketOf)];
    },
    evaluate: (inputs, params, ctx) => {
      const opened = openedParams(params, fields);
      let p = params;
      for (const f of opened) {
        if (!ctx.connectedInputs?.has(f.id)) continue;
        const v = paramFromInput(f, inputs[f.id]);
        if (v === undefined) continue;
        if (p === params) p = { ...params };
        p[f.id] = v;
      }
      return def.evaluate(inputs, p, ctx);
    },
  };
}
