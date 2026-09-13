import { resolveDefinition } from "./groups";
import { Graph, NodeDefinition, NodeRegistry } from "./types";

/**
 * Which nodes' objects the viewport draws.
 *
 * The rule is "the last geometry node of a chain is what renders": a node
 * that produces geometry is in the scene unless something downstream has
 * taken ownership of that geometry — a Merge that reparents it, an Array
 * that clones it, a Curve Deform that rebuilds it, a Render it is wired
 * into. Drop a Box on the canvas and it is on screen; wire it into a Merge
 * and only the Merge's group is, because the Box now belongs to it.
 *
 * This replaces "everything must reach a Render node". That rule never
 * actually held — lights and Empties were already exempt, each for the same
 * reason: requiring a path to Render before an object exists gets the
 * dependency backwards. Render keeps its geometry input, and it is still a
 * perfectly good way to say "this subtree is my output", it just isn't the
 * price of admission any more.
 *
 * Ownership is declared, not guessed, on the consuming socket (`owns` in
 * SocketDef). It cannot be inferred from socket types: a Spot Light's
 * `target` and a Look At's `target` are both geometry-typed, but they only
 * *read* a position — the object they aim at has to stay visible.
 *
 * Geometry routed through grouping containers (e.g. List Group) or pass-through
 * nodes (e.g. Reroute) is tracked recursively: if the downstream consumer
 * (Spawner, Merge, Array, Render) takes ownership, the upstream source object
 * is also marked as owned.
 */

/** Sockets carrying an Object3D — `any` included, since a Reroute or a Logic Bridge only knows its real type once something is wired into it. */
const GEOMETRY_BEARING_TYPES = new Set(["geometry", "any"]);

/**
 * Lights are put into the scene by the viewport's own light pass, not by
 * this one: a light has to exist even when it is only wired up as another
 * node's aim target, and it is the one kind of object that is invisible in
 * its own right anyway.
 */
const SELF_MANAGED_CATEGORIES = new Set(["lighting"]);

function producesGeometry(def: NodeDefinition): boolean {
  return def.outputs.some((socket) => GEOMETRY_BEARING_TYPES.has(socket.type));
}

/**
 * The consuming node's input sockets, dynamic ones included — a Merge's
 * `in3` only exists once three wires are already attached, and a connection
 * into it has to resolve to a socket like any other.
 */
function inputSocketsOf(def: NodeDefinition, graph: Graph, nodeId: string) {
  if (!def.dynamicInputs) return def.inputs;
  const incoming = graph.connections.filter((c) => c.toNode === nodeId);
  return def.dynamicInputs(incoming) ?? def.inputs;
}

/** Does any connection out of `nodeId` hand its geometry to a socket that claims ownership of it? */
function isOwnedDownstream(
  graph: Graph,
  registry: NodeRegistry,
  nodeId: string,
  visited = new Set<string>()
): boolean {
  if (visited.has(nodeId)) return false;
  visited.add(nodeId);

  return graph.connections.some((connection) => {
    if (connection.fromNode !== nodeId) return false;
    const consumer = graph.nodes.find((n) => n.id === connection.toNode);
    if (!consumer) return false;
    const consumerDef = resolveDefinition(consumer, registry);
    if (!consumerDef) return false;
    const socket = inputSocketsOf(consumerDef, graph, connection.toNode).find((s) => s.id === connection.toSocket);
    if (!socket) return false;

    // Direct ownership claim on the receiving socket
    if (socket.owns) {
      const producer = graph.nodes.find((n) => n.id === connection.fromNode);
      const producerDef = resolveDefinition(producer, registry);
      const fromSocket = producerDef?.outputs.find((s) => s.id === connection.fromSocket);
      if (
        fromSocket &&
        (fromSocket.type === "curve" ||
          fromSocket.type === "matrix" ||
          fromSocket.type === "value" ||
          fromSocket.type === "color" ||
          fromSocket.type === "texture")
      ) {
        return false;
      }
      return true;
    }

    // Multi-hop ownership: if the consumer is a pass-through/grouping node without
    // standalone rendering (like List Group or Reroute), propagate downstream.
    if (consumerDef.category === "list" || consumerDef.type === "utility/reroute") {
      return isOwnedDownstream(graph, registry, consumer.id, visited);
    }

    return false;
  });
}

/**
 * Node ids whose evaluated geometry the viewport should add to its scene, in
 * graph order. Permissive on purpose: a node with an `any` output is
 * included, and the caller drops the ones that didn't actually evaluate to
 * an Object3D — which keeps this function free of the dynamic-socket
 * resolution that answering "is this Reroute carrying geometry today"
 * otherwise needs.
 */
export function resolveSceneRoots(graph: Graph, registry: NodeRegistry): string[] {
  return graph.nodes
    .filter((node) => {
      const def = resolveDefinition(node, registry);
      if (!def || SELF_MANAGED_CATEGORIES.has(def.category)) return false;
      if (!producesGeometry(def)) return false;
      return !isOwnedDownstream(graph, registry, node.id);
    })
    .map((node) => node.id);
}
