import type { NodeDefinition, NodeInstance } from "../types";
import type { SocketDef } from "../sockets";

/*
 * Teleport — a stand-in for another node's outputs, placed anywhere on the
 * canvas, so a node used far away doesn't need a wire running across the
 * whole graph. Made from a node's right-click menu ("Teleport"); a node can
 * have as many as you like. It has no inputs and the same outputs as its
 * source (`params.source`), and hands on exactly what the source produced:
 * the evaluator runs it right after its source and copies the source's
 * results (see evaluate.ts), and anything it feeds counts as fed by the
 * source (scene roots, ownership — see sceneRoots.ts).
 *
 * `params.ports` keeps the source's output sockets as they were when the
 * teleport was made (refreshed by the editor), so the file stays valid —
 * wires out of it resolve — without looking the source up.
 */

export const TELEPORT_TYPE = "utility/teleport";

export function isTeleport(node: NodeInstance | undefined): boolean {
  return node?.type === TELEPORT_TYPE;
}

export function teleportSource(node: NodeInstance | undefined): string {
  return node && typeof node.params.source === "string" ? node.params.source : "";
}

function portsOf(params: Record<string, unknown> | undefined): SocketDef[] {
  const raw = params?.ports;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is SocketDef => typeof p === "object" && p !== null && typeof (p as SocketDef).id === "string" && typeof (p as SocketDef).type === "string",
  );
}

export const TELEPORT_NODE: NodeDefinition = {
  type: TELEPORT_TYPE,
  label: "Teleport",
  category: "structure",
  // Made from a node's right-click menu, never from the palette.
  hidden: true,
  description: "The outputs of another node, here — so its wires don't have to cross the whole canvas. Right-click a node → Teleport to make one.",
  inputs: [],
  outputs: [],
  dynamicOutputs: (_connections, _types, params) => portsOf(params),
  defaultParams: { source: "", ports: [] },
  paramFields: [],
  // The evaluator copies the source's results instead of calling this.
  evaluate: () => ({}),
};
