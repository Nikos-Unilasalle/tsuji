import { resolveDefinition } from "./groups";
import { Connection, Graph, NodeDefinition, NodeRegistry } from "./types";

/**
 * Drops connections a loaded graph carries that no longer lead anywhere: a
 * node type that has since been removed, or — the case this was written for
 * — a socket that has. The Camera's unused `geometry` input was deleted once
 * it turned out nothing ever read it, and a .ovm saved with a wire into it
 * would otherwise keep that wire forever: the evaluator ignores it (it only
 * reads declared sockets), but the editor still draws it, anchored to a
 * handle that isn't there any more.
 *
 * Sockets are a public surface — every saved file references them by id — so
 * something has to absorb the difference when one is retired. Doing it at
 * load time, once, keeps every reader downstream from having to wonder
 * whether a connection points at anything.
 */

/**
 * A node's sockets as they stand for *this* instance, dynamic ones included:
 * a Merge's `in3` only exists once three wires are attached, and it is a
 * perfectly valid target even though the static definition never mentions it.
 */
function socketIds(
  def: NodeDefinition,
  side: "inputs" | "outputs",
  graph: Graph,
  nodeId: string,
): Set<string> {
  const connections = graph.connections.filter((c) =>
    side === "inputs" ? c.toNode === nodeId : c.fromNode === nodeId,
  );
  const dynamic = side === "inputs" ? def.dynamicInputs : def.dynamicOutputs;
  const sockets = dynamic ? (dynamic(connections) ?? def[side]) : def[side];
  return new Set(sockets.map((socket) => socket.id));
}

function isLive(connection: Connection, graph: Graph, registry: NodeRegistry): boolean {
  const from = graph.nodes.find((n) => n.id === connection.fromNode);
  const to = graph.nodes.find((n) => n.id === connection.toNode);
  if (!from || !to) return false;

  const fromDef = resolveDefinition(from, registry);
  const toDef = resolveDefinition(to, registry);
  // An unknown node type is left alone on purpose: its definition may simply
  // not be registered in this window, and dropping its wires would quietly
  // rewrite a graph we don't understand.
  if (!fromDef || !toDef) return true;

  return (
    socketIds(fromDef, "outputs", graph, from.id).has(connection.fromSocket) &&
    socketIds(toDef, "inputs", graph, to.id).has(connection.toSocket)
  );
}

/**
 * The same graph with dead connections removed, or the graph itself when
 * there are none — at every depth: a wire inside a group is as saved, as
 * loaded and as capable of outliving its socket as one at the top level.
 */
export function pruneDanglingConnections(graph: Graph, registry: NodeRegistry): Graph {
  const live = graph.connections.filter((connection) => isLive(connection, graph, registry));

  let nodesChanged = false;
  const nodes = graph.nodes.map((node) => {
    if (!node.subgraph) return node;
    const subgraph = pruneDanglingConnections(node.subgraph, registry);
    if (subgraph === node.subgraph) return node;
    nodesChanged = true;
    return { ...node, subgraph };
  });

  if (live.length === graph.connections.length) {
    return nodesChanged ? { ...graph, nodes } : graph;
  }

  for (const connection of graph.connections) {
    if (live.includes(connection)) continue;
    console.warn(
      `dropped a connection to a socket that no longer exists: ${connection.fromNode}.${connection.fromSocket} -> ${connection.toNode}.${connection.toSocket}`,
    );
  }

  return { ...graph, nodes, connections: live };
}
