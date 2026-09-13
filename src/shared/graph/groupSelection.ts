import {
  GROUP_INPUT_TYPE,
  GROUP_OUTPUT_TYPE,
  GROUP_TYPE,
  GroupPort,
  NEW_PORT_SOCKET,
  boundaryNodes,
  portsOf,
  resolveDefinition,
} from "./groups";
import { SocketType } from "./sockets";
import { Connection, Graph, NodeInstance, NodeRegistry } from "./types";

/**
 * Collapsing a selection into a group, and expanding it back.
 *
 * Kept as pure graph→graph functions rather than living in the editor: this
 * is the part with the actual rules in it (which wires become ports, which
 * keyframes travel with their node), and it is worth being able to test
 * without a canvas. GraphEditor.tsx only supplies the selection, the ids and
 * the undo step.
 */

const BOUNDARY_GAP = 260;

function connectionId(fromNode: string, fromSocket: string, toNode: string, toSocket: string): string {
  return `${fromNode}.${fromSocket}->${toNode}.${toSocket}`;
}

function socketTypeOf(
  graph: Graph,
  registry: NodeRegistry,
  nodeId: string,
  socketId: string,
  side: "inputs" | "outputs",
): SocketType {
  const instance = graph.nodes.find((n) => n.id === nodeId);
  const def = resolveDefinition(instance, registry);
  const sockets = side === "inputs" ? def?.inputs : def?.outputs;
  return sockets?.find((s) => s.id === socketId)?.type ?? "any";
}

/** A port id that reads like the socket it stands for, and collides with nothing already taken. */
function uniquePortId(base: string, taken: Set<string>): string {
  let id = base || "port";
  let n = 2;
  while (taken.has(id)) id = `${base}_${n++}`;
  taken.add(id);
  return id;
}

function boundsOf(nodes: NodeInstance[]): { minX: number; maxX: number; midX: number; midY: number } {
  const xs = nodes.map((n) => n.position.x);
  const ys = nodes.map((n) => n.position.y);
  const minX = xs.length ? Math.min(...xs) : 0;
  const maxX = xs.length ? Math.max(...xs) : 0;
  const minY = ys.length ? Math.min(...ys) : 0;
  const maxY = ys.length ? Math.max(...ys) : 0;
  return { minX, maxX, midX: (minX + maxX) / 2, midY: (minY + maxY) / 2 };
}

export interface GroupResult {
  graph: Graph;
  groupId: string;
}

/**
 * The selection replaced by one group node holding it.
 *
 * Every wire that crossed the selection's boundary becomes a port: several
 * wires from the same source share one, because they were carrying the same
 * value and two ports would be two things to keep wired the same way.
 *
 * Node ids do not change — a grouped node is the same node, one level down.
 * Its keyframes travel with it (they are keyed by that id, and the timeline
 * shows the level being edited), while everything the selection did not
 * include stays exactly where it was.
 *
 * Returns the graph unchanged when there is nothing groupable in the
 * selection — a lone boundary node, say, which belongs to the group it
 * already defines.
 */
export function groupSelection(
  graph: Graph,
  selectedIds: readonly string[],
  registry: NodeRegistry,
  newId: () => string,
): GroupResult | null {
  const selected = new Set(
    graph.nodes
      .filter((n) => selectedIds.includes(n.id))
      .filter((n) => n.type !== GROUP_INPUT_TYPE && n.type !== GROUP_OUTPUT_TYPE)
      .map((n) => n.id),
  );
  if (selected.size === 0) return null;

  const inner = graph.nodes.filter((n) => selected.has(n.id));
  const outer = graph.nodes.filter((n) => !selected.has(n.id));
  const groupId = newId();
  const inputNodeId = newId();
  const outputNodeId = newId();

  const inputPorts: GroupPort[] = [];
  const outputPorts: GroupPort[] = [];
  const inputPortBySource = new Map<string, string>();
  const outputPortBySource = new Map<string, string>();
  const takenInput = new Set<string>();
  const takenOutput = new Set<string>();

  const innerConnections: Connection[] = [];
  const outerConnections: Connection[] = [];

  for (const c of graph.connections) {
    const fromInside = selected.has(c.fromNode);
    const toInside = selected.has(c.toNode);

    if (fromInside && toInside) {
      innerConnections.push({ ...c });
      continue;
    }
    if (!fromInside && !toInside) {
      outerConnections.push({ ...c });
      continue;
    }

    if (!fromInside && toInside) {
      const key = `${c.fromNode}:${c.fromSocket}`;
      let portId = inputPortBySource.get(key);
      if (!portId) {
        portId = uniquePortId(c.toSocket, takenInput);
        inputPortBySource.set(key, portId);
        inputPorts.push({
          id: portId,
          label: c.toSocket,
          type: socketTypeOf(graph, registry, c.fromNode, c.fromSocket, "outputs"),
        });
        outerConnections.push({
          id: connectionId(c.fromNode, c.fromSocket, groupId, portId),
          fromNode: c.fromNode,
          fromSocket: c.fromSocket,
          toNode: groupId,
          toSocket: portId,
        });
      }
      innerConnections.push({
        id: connectionId(inputNodeId, portId, c.toNode, c.toSocket),
        fromNode: inputNodeId,
        fromSocket: portId,
        toNode: c.toNode,
        toSocket: c.toSocket,
      });
      continue;
    }

    // fromInside && !toInside
    const key = `${c.fromNode}:${c.fromSocket}`;
    let portId = outputPortBySource.get(key);
    if (!portId) {
      portId = uniquePortId(c.fromSocket, takenOutput);
      outputPortBySource.set(key, portId);
      outputPorts.push({
        id: portId,
        label: c.fromSocket,
        type: socketTypeOf(graph, registry, c.fromNode, c.fromSocket, "outputs"),
      });
      innerConnections.push({
        id: connectionId(c.fromNode, c.fromSocket, outputNodeId, portId),
        fromNode: c.fromNode,
        fromSocket: c.fromSocket,
        toNode: outputNodeId,
        toSocket: portId,
      });
    }
    outerConnections.push({
      id: connectionId(groupId, portId, c.toNode, c.toSocket),
      fromNode: groupId,
      fromSocket: portId,
      toNode: c.toNode,
      toSocket: c.toSocket,
    });
  }

  const { minX, maxX, midX, midY } = boundsOf(inner);

  const subgraph: Graph = {
    nodes: [
      {
        id: inputNodeId,
        type: GROUP_INPUT_TYPE,
        params: { ports: inputPorts },
        position: { x: minX - BOUNDARY_GAP, y: midY },
      },
      ...inner,
      {
        id: outputNodeId,
        type: GROUP_OUTPUT_TYPE,
        params: { ports: outputPorts },
        position: { x: maxX + BOUNDARY_GAP, y: midY },
      },
    ],
    connections: innerConnections,
    // Keyframes stay on the document that owns the timeline: they are keyed
    // by node id, grouping does not change a node's id, and one store means
    // the timeline, the evaluator and undo never have to agree on which of
    // two places a key lives in.
    keyframes: {},
    markers: [],
    exposedParams: [],
  };

  const group: NodeInstance = {
    id: groupId,
    type: GROUP_TYPE,
    params: { name: "Group" },
    position: { x: midX, y: midY },
    subgraph,
  };

  return {
    groupId,
    graph: {
      ...graph,
      nodes: [...outer, group],
      connections: outerConnections,
    },
  };
}

/**
 * A group dissolved back into the graph that holds it — the inverse of
 * groupSelection, wires included: what came in through a port lands on
 * whatever that port fed inside, and what left through one comes straight
 * from the node that produced it.
 *
 * The one thing that cannot survive is a wire out of the group's implicit
 * `geometry` output: it stood for "everything inside that nothing claimed",
 * which is not a single node's output and has no equivalent once the interior
 * is back in the open. Those objects go back to rendering in their own right,
 * so nothing disappears — but a Merge that was collecting them loses them.
 */
export function ungroupNode(graph: Graph, groupId: string): Graph | null {
  const group = graph.nodes.find((n) => n.id === groupId);
  if (!group?.subgraph) return null;

  const subgraph = group.subgraph;
  const { input, output } = boundaryNodes(subgraph);
  const boundaryIds = new Set([input?.id, output?.id].filter(Boolean) as string[]);

  const inner = subgraph.nodes.filter((n) => !boundaryIds.has(n.id));
  const { midX, midY } = boundsOf(inner);
  const dx = group.position.x - midX;
  const dy = group.position.y - midY;
  const moved = inner.map((n) => ({ ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }));

  const connections: Connection[] = [];

  for (const c of subgraph.connections) {
    if (!boundaryIds.has(c.fromNode) && !boundaryIds.has(c.toNode)) connections.push({ ...c });
  }

  for (const c of graph.connections) {
    if (c.toNode === groupId) {
      // Into a port: re-target at everything that port fed inside.
      const consumers = subgraph.connections.filter((s) => s.fromNode === input?.id && s.fromSocket === c.toSocket);
      for (const consumer of consumers) {
        connections.push({
          id: connectionId(c.fromNode, c.fromSocket, consumer.toNode, consumer.toSocket),
          fromNode: c.fromNode,
          fromSocket: c.fromSocket,
          toNode: consumer.toNode,
          toSocket: consumer.toSocket,
        });
      }
      continue;
    }
    if (c.fromNode === groupId) {
      // Out of a port: source it from whatever fed that port inside. A wire
      // out of the implicit scene output has no such source and is dropped.
      const producer = subgraph.connections.find((s) => s.toNode === output?.id && s.toSocket === c.fromSocket);
      if (!producer) continue;
      connections.push({
        id: connectionId(producer.fromNode, producer.fromSocket, c.toNode, c.toSocket),
        fromNode: producer.fromNode,
        fromSocket: producer.fromSocket,
        toNode: c.toNode,
        toSocket: c.toSocket,
      });
      continue;
    }
    connections.push({ ...c });
  }

  return {
    ...graph,
    nodes: [...graph.nodes.filter((n) => n.id !== groupId), ...moved],
    connections,
    keyframes: { ...(graph.keyframes ?? {}), ...(subgraph.keyframes ?? {}) },
  };
}

/**
 * A boundary node of `subgraph`, adding it if the group hasn't got one yet —
 * a group made empty, or one whose whole input side was deleted, still has to
 * accept a new port.
 */
function withBoundary(
  subgraph: Graph,
  type: typeof GROUP_INPUT_TYPE | typeof GROUP_OUTPUT_TYPE,
  newId: () => string,
): { subgraph: Graph; node: NodeInstance } {
  const existing = subgraph.nodes.find((n) => n.type === type);
  if (existing) return { subgraph, node: existing };

  const { minX, maxX, midY } = boundsOf(subgraph.nodes);
  const node: NodeInstance = {
    id: newId(),
    type,
    params: { ports: [] },
    position:
      type === GROUP_INPUT_TYPE
        ? { x: minX - BOUNDARY_GAP, y: midY }
        : { x: maxX + BOUNDARY_GAP, y: midY },
  };
  return { subgraph: { ...subgraph, nodes: [...subgraph.nodes, node] }, node };
}

function appendPort(node: NodeInstance, base: string, type: SocketType): { node: NodeInstance; port: GroupPort } {
  const ports = portsOf(node);
  const port: GroupPort = { id: uniquePortId(base, new Set(ports.map((p) => p.id))), label: base, type };
  return { node: { ...node, params: { ...node.params, ports: [...ports, port] } }, port };
}

function replaceNode(graph: Graph, node: NodeInstance): Graph {
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === node.id ? node : n)) };
}

/**
 * A connection dropped on a boundary's empty socket, turned into a real port
 * plus the connection the caller actually meant.
 *
 * Four ways to reach here, and they are the same operation seen from four
 * sides — outside or inside the group, incoming or outgoing:
 *
 *   into a group's `+` input   → a new input port  (typed by the source)
 *   out of a group's `+` output → a new output port (typed by the target)
 *   into Group Output's `+`    → a new output port (typed by the source)
 *   out of Group Input's `+`   → a new input port  (typed by the target)
 *
 * The port always takes the *other end's* concrete type, never `any`: the
 * empty socket accepts anything precisely so that the type can be read off
 * whatever turned up.
 *
 * Returns null when the connection has nothing to do with an empty socket,
 * which is every ordinary connection — the caller carries on as before.
 */
export function materializeNewPort(
  graph: Graph,
  connection: { fromNode: string; fromSocket: string; toNode: string; toSocket: string },
  registry: NodeRegistry,
  newId: () => string,
): { graph: Graph; connection: Connection } | null {
  const from = graph.nodes.find((n) => n.id === connection.fromNode);
  const to = graph.nodes.find((n) => n.id === connection.toNode);
  if (!from || !to) return null;

  const intoNew = connection.toSocket === NEW_PORT_SOCKET;
  const outOfNew = connection.fromSocket === NEW_PORT_SOCKET;
  if (!intoNew && !outOfNew) return null;
  // A wire from one empty socket to another names nothing on either side.
  if (intoNew && outOfNew) return null;

  const sourceType = () => socketTypeOf(graph, registry, connection.fromNode, connection.fromSocket, "outputs");
  const targetType = () => socketTypeOf(graph, registry, connection.toNode, connection.toSocket, "inputs");

  // Inside a group: the boundary node is right here, in this graph.
  if (intoNew && to.type === GROUP_OUTPUT_TYPE) {
    const { node, port } = appendPort(to, connection.fromSocket, sourceType());
    return {
      graph: replaceNode(graph, node),
      connection: connect(connection.fromNode, connection.fromSocket, to.id, port.id),
    };
  }
  if (outOfNew && from.type === GROUP_INPUT_TYPE) {
    const { node, port } = appendPort(from, connection.toSocket, targetType());
    return {
      graph: replaceNode(graph, node),
      connection: connect(from.id, port.id, connection.toNode, connection.toSocket),
    };
  }

  // Outside a group: the port is declared by a boundary node one level down.
  if (intoNew && to.subgraph) {
    const { subgraph, node } = withBoundary(to.subgraph, GROUP_INPUT_TYPE, newId);
    const { node: withPort, port } = appendPort(node, connection.fromSocket, sourceType());
    return {
      graph: replaceNode(graph, { ...to, subgraph: replaceNode(subgraph, withPort) }),
      connection: connect(connection.fromNode, connection.fromSocket, to.id, port.id),
    };
  }
  if (outOfNew && from.subgraph) {
    const { subgraph, node } = withBoundary(from.subgraph, GROUP_OUTPUT_TYPE, newId);
    const { node: withPort, port } = appendPort(node, connection.toSocket, targetType());
    return {
      graph: replaceNode(graph, { ...from, subgraph: replaceNode(subgraph, withPort) }),
      connection: connect(from.id, port.id, connection.toNode, connection.toSocket),
    };
  }

  return null;
}

function connect(fromNode: string, fromSocket: string, toNode: string, toSocket: string): Connection {
  return { id: connectionId(fromNode, fromSocket, toNode, toSocket), fromNode, fromSocket, toNode, toSocket };
}

/** The ports a boundary node declares, as the param panel edits them. */
export function setBoundaryPorts(graph: Graph, nodeId: string, ports: GroupPort[]): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, params: { ...n.params, ports } } : n)),
  };
}

/** Every port a group exposes, in the order the boundary declares them. */
export function groupPorts(group: NodeInstance): { inputs: GroupPort[]; outputs: GroupPort[] } {
  if (!group.subgraph) return { inputs: [], outputs: [] };
  const { input, output } = boundaryNodes(group.subgraph);
  return { inputs: portsOf(input), outputs: portsOf(output) };
}
