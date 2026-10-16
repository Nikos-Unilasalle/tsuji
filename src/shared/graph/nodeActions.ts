import { cloneParams } from "./cloneGraph";
import type { NodeDefinition } from "./types";

/*
 * The icons under a node on hover (see GraphNode): Freeze, for anything that
 * outputs geometry, Apply, for a node with a pose of its own, and Reset, for a
 * node that declares one (see NodeDefinition.reset). Both reach App's onNodeAction as an action id.
 */

/** Bake the node's current geometry into a new Frozen Geometry node. */
export const NODE_FREEZE_ACTION = "node/freeze";
/** Apply Rotation & Scale: fold the node's own turn and stretch into its geometry, as Blender's Ctrl+A (see poseSockets.ts). */
export const NODE_APPLY_TRANSFORM_ACTION = "node/apply-transform";
/** Put the node's authored data back to its defaults (NodeDefinition.reset with `params`). */
export const NODE_RESET_PARAMS_ACTION = "node/reset-params";

/** Whether a node has a pose of its own to apply — the objects with Location / Rotation / Scale sockets. */
export function canApplyTransform(def: NodeDefinition | undefined): boolean {
  return Boolean(def?.poseSockets);
}

/** The action Reset sends for this definition, or null when it has none. */
export function resetActionOf(def: NodeDefinition | undefined): string | null {
  if (!def?.reset) return null;
  return "action" in def.reset ? def.reset.action : NODE_RESET_PARAMS_ACTION;
}

/** The params a params-Reset writes: each listed one back to its default. Null when there is nothing to reset. */
export function nodeResetPatch(def: NodeDefinition | undefined): Record<string, unknown> | null {
  if (!def?.reset || !("params" in def.reset)) return null;
  const defaults = cloneParams(def.defaultParams);
  const patch: Record<string, unknown> = {};
  for (const id of def.reset.params) patch[id] = defaults[id] ?? null;
  return patch;
}
