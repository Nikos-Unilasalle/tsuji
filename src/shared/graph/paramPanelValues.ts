import { evaluateKeyframeValue, EvalResult } from "./evaluate";
import { Graph, NodeDefinition, NodeInstance } from "./types";

/**
 * What the param panel should show for each of a node's fields.
 *
 * A field has to read from the same place its edits are written to, or it
 * misreports and the keyframe taken from it captures the wrong value.
 * Editing always writes `instance.params`, so that is the base — and an
 * evaluated value is layered on top only where the param genuinely isn't in
 * charge:
 *
 *  - a *connected* input socket ignores its param entirely (the param is
 *    only the unconnected fallback), so the upstream value is what's
 *    actually in effect and is the useful thing to display;
 *  - a node *output* is a readout, not a setting — it may only fill in a key
 *    that isn't an editable param at all (a solver's `error`, a camera's
 *    computed `projection`).
 *
 * Both layers used to be spread unconditionally over the params, which let a
 * node's output shadow the identically-named param it was derived from. The
 * Empty is the clearest case: it emits a `location` output decomposed from
 * its composed matrix, which covered the `location` param the panel was
 * editing — so the field displayed the composed result while a gizmo drag
 * wrote the base into the param underneath it, and the two disagreed as soon
 * as anything was wired into the Empty's Matrix input.
 */
/**
 * Which of a node's input sockets currently have a wire in them.
 *
 * A param sharing a socket's id is only that socket's *unconnected*
 * fallback, so while the wire is there the param is not in charge of
 * anything — the panel shows the incoming value (see below) and editing the
 * field underneath it is overwritten on the next evaluation. The panel uses
 * this to say so rather than leaving the operator to discover it by typing
 * into a field that silently springs back.
 */
const DEG_TO_RAD = Math.PI / 180;

/**
 * Whether a socket is a scalar angle — a `value` input whose param is stored
 * in radians but labelled and edited in degrees (`degrees: true`).
 *
 * These are the sockets that read a wire as degrees (degreesInput in
 * nodes/object.ts), so the panel has to undo that to get back to the stored
 * unit everything else here is in. Vector `rotation` sockets are deliberately
 * excluded: they carry radians between nodes and never went through the
 * degrees conversion. See graph/angleUnits.test.ts, which pins both sets.
 */
function isDegreeScalarSocket(def: NodeDefinition, instance: NodeInstance, socketId: string): boolean {
  if (!def.inputs?.some((input) => input.id === socketId && input.type === "value")) return false;
  const fields = [...(def.paramFields ?? [])];
  try {
    const dynamic = def.dynamicParamFields?.(instance);
    if (dynamic) fields.push(...dynamic);
  } catch {
    // A builder that needs more than this instance contributes nothing; the
    // static fields already cover every degrees-marked scalar today.
  }
  return fields.some((field) => field.id === socketId && (field as { degrees?: boolean }).degrees === true);
}

export function connectedSocketIds(graph: Graph, nodeId: string): Set<string> {
  const connected = new Set<string>();
  for (const connection of graph.connections) {
    if (connection.toNode === nodeId) connected.add(connection.toSocket);
  }
  return connected;
}

export function paramPanelValues(
  graph: Graph,
  instance: NodeInstance,
  def: NodeDefinition,
  results: EvalResult | null,
  currentFrame?: number,
): Record<string, unknown> {
  const evaluated = results?.get(instance.id) ?? null;
  const merged: Record<string, unknown> = { ...def.defaultParams, ...instance.params };

  if (graph.keyframes && currentFrame !== undefined && currentFrame >= 0) {
    const nodeKeyframes = graph.keyframes[instance.id];
    if (nodeKeyframes) {
      for (const paramKey of Object.keys(merged)) {
        if ((def.type === "curve/grease-pencil" || def.type === "curve/paint-on-geometry") && paramKey === "frames") continue;
        merged[paramKey] = evaluateKeyframeValue(
          graph.keyframes,
          instance.id,
          paramKey,
          currentFrame,
          merged[paramKey],
        );
      }
    }
  }

  const evaluatedInputs = (evaluated?.__evaluatedInputs as Record<string, unknown>) ?? {};
  for (const socketId of connectedSocketIds(graph, instance.id)) {
    // Only overlay a value that actually arrived. A connected source that
    // produced nothing (threw, unknown type, never-resolved cycle) leaves the
    // entry undefined; keeping an undefined here would overwrite the
    // keyframed/param fallback the panel should still trust rather than show
    // nothing or a wrong static value for a socket that is ostensibly driven.
    if (socketId in evaluatedInputs && evaluatedInputs[socketId] !== undefined) {
      const value = evaluatedInputs[socketId];
      // Everything in `merged` is in STORED units, because the panel converts
      // on the way out (toDisplayUnit). A scalar angle wire is in degrees
      // (see degreesInput in nodes/object.ts — it matches the "(°)" label the
      // operator reads), so it has to come back to radians here or the
      // panel's own conversion applies a second time and a wired 36° reads
      // as 2063.
      merged[socketId] = isDegreeScalarSocket(def, instance, socketId) ? Number(value) * DEG_TO_RAD : value;
    }
  }

  for (const [key, value] of Object.entries(evaluated ?? {})) {
    // Hidden evaluator bookkeeping (__evaluatedInputs, a group's __subResults), never params.
    if (key.startsWith("__")) continue;
    if (key in def.defaultParams) continue;
    merged[key] = value;
  }

  return merged;
}
