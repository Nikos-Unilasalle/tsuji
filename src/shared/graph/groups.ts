import { SocketDef, SocketType } from "./sockets";
import { Graph, NodeDefinition, NodeInstance, NodeRegistry } from "./types";

/**
 * Node groups — a selection collapsed into one node holding a subgraph.
 *
 * This file is the part of that feature every *other* file has to know
 * about: how a group instance's sockets are worked out, and how to walk a
 * graph that now has graphs inside it. The group node type itself, and the
 * recursive evaluation, live in nodes/group.ts.
 *
 * The one rule that ripples everywhere: a group's sockets belong to the
 * *instance*, not to its type. `registry.get(instance.type)` was enough to
 * describe any node until now; for a group it returns a definition with no
 * ports at all. Every caller that needs a node's real sockets goes through
 * `resolveDefinition` instead.
 */

export const GROUP_TYPE = "structure/group";
export const GROUP_INPUT_TYPE = "structure/group-input";
export const GROUP_OUTPUT_TYPE = "structure/group-output";

/**
 * One port on a group's boundary, as stored in the `ports` param of the
 * `structure/group-input` / `structure/group-output` node that declares it.
 *
 * Deliberately not a second list kept on the group node itself: the ports the
 * subgraph wires into and the ports the parent graph wires into are the same
 * ports, and two copies of that list would be two things to keep in step.
 */
export interface GroupPort {
  id: string;
  label: string;
  type: SocketType;
}

/**
 * The group node's implicit output: everything built inside it that nothing
 * downstream took ownership of, parented into one container.
 *
 * Without it, dropping a Box inside a group would make it vanish — the
 * viewport draws what the *outer* graph's scene roots resolve to, reading
 * each one's `geometry` output, and the outer graph sees a single node. Hence
 * the id: `geometry` is the socket the viewport looks for, not a name chosen
 * for display. Suppressed when the author has already declared a port with
 * this id, so an explicit output always wins.
 */
export const GROUP_SCENE_OUTPUT: SocketDef = { id: "geometry", label: "Scene", type: "geometry" };

/**
 * The empty socket every boundary carries at the end of its list: wire
 * anything into it and it becomes a real port, typed by whatever was wired.
 *
 * This is how a group grows ports after it exists — the alternative being a
 * dialog asking for a name and a type before you are allowed to make the
 * connection you were already making. `any` so no drag is rejected on its way
 * in; the port that materialises takes the *concrete* type of the socket at
 * the other end, not `any`.
 */
export const NEW_PORT_SOCKET = "__new";
export const NEW_PORT_SOCKET_DEF: SocketDef = { id: NEW_PORT_SOCKET, label: "+", type: "any" };

function isPort(value: unknown): value is GroupPort {
  if (!value || typeof value !== "object") return false;
  const port = value as Partial<GroupPort>;
  return typeof port.id === "string" && port.id.length > 0 && typeof port.type === "string";
}

/** The ports declared by one group-input/group-output instance, ignoring malformed entries. */
export function portsOf(instance: NodeInstance | undefined): GroupPort[] {
  const raw = instance?.params?.ports;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPort).map((port) => ({ id: port.id, label: port.label || port.id, type: port.type }));
}

function toSockets(ports: GroupPort[]): SocketDef[] {
  return ports.map((port) => ({ id: port.id, label: port.label, type: port.type }));
}

/**
 * The same ports, as sockets that take ownership of the geometry wired into
 * them — what a `structure/group-output` declares.
 *
 * Exposing geometry on the boundary is the author saying "this is what leaves
 * the group", so the node feeding it stops being one of the subgraph's own
 * scene roots and does not also land in the group's container (which would
 * put the same object in two places and let three.js's single-parent rule
 * decide which one wins, differently on different frames).
 */
function toOwningSockets(ports: GroupPort[]): SocketDef[] {
  return toSockets(ports).map((socket) =>
    socket.type === "geometry" || socket.type === "any" ? { ...socket, owns: true } : socket,
  );
}

/**
 * The boundary nodes of a subgraph. A group has at most one of each — the
 * editor never creates a second — but a hand-edited file could, so the first
 * one found wins rather than the whole group failing to resolve.
 */
export function boundaryNodes(subgraph: Graph): { input?: NodeInstance; output?: NodeInstance } {
  return {
    input: subgraph.nodes.find((n) => n.type === GROUP_INPUT_TYPE),
    output: subgraph.nodes.find((n) => n.type === GROUP_OUTPUT_TYPE),
  };
}

export function groupInputPorts(subgraph: Graph): GroupPort[] {
  return portsOf(boundaryNodes(subgraph).input);
}

export function groupOutputPorts(subgraph: Graph): GroupPort[] {
  return portsOf(boundaryNodes(subgraph).output);
}

/**
 * Derived definitions are memoized on the subgraph object itself.
 *
 * Graph state is replaced immutably on every edit (App.tsx), so a new
 * subgraph object *is* the signal that something inside changed — including a
 * renamed or retyped port. An in-place mutation of a subgraph would not
 * invalidate this, which is the same contract `evaluate.ts` already relies on
 * for its structural cache.
 */
const derivedDefinitions = new WeakMap<Graph, NodeDefinition>();

function deriveGroupDefinition(instance: NodeInstance, base: NodeDefinition): NodeDefinition {
  const subgraph = instance.subgraph!;
  const cached = derivedDefinitions.get(subgraph);
  if (cached) return cached;

  const outputs = toSockets(groupOutputPorts(subgraph));
  if (!outputs.some((socket) => socket.id === GROUP_SCENE_OUTPUT.id)) outputs.push(GROUP_SCENE_OUTPUT);

  const derived: NodeDefinition = {
    ...base,
    // Both sides end in the empty socket: a group gains an input from the
    // outside (it shows up on Group Input inside) and an output by dragging
    // out of it (it shows up on Group Output inside).
    inputs: [...toSockets(groupInputPorts(subgraph)), NEW_PORT_SOCKET_DEF],
    outputs: [...outputs, NEW_PORT_SOCKET_DEF],
  };
  derivedDefinitions.set(subgraph, derived);
  return derived;
}

/**
 * The boundary nodes' own sockets are per-instance too, and for the same
 * reason: they *are* the port list. Memoized on the ports array, which the
 * editor replaces rather than mutates whenever a port is added, renamed or
 * retyped.
 */
const derivedBoundaryDefinitions = new WeakMap<object, NodeDefinition>();

function deriveBoundaryDefinition(instance: NodeInstance, base: NodeDefinition): NodeDefinition {
  const key = Array.isArray(instance.params?.ports) ? (instance.params.ports as object) : undefined;
  const cached = key && derivedBoundaryDefinitions.get(key);
  if (cached) return cached;

  const ports = portsOf(instance);
  const derived: NodeDefinition =
    instance.type === GROUP_INPUT_TYPE
      ? { ...base, inputs: [], outputs: [...toSockets(ports), NEW_PORT_SOCKET_DEF] }
      : { ...base, inputs: [...toOwningSockets(ports), NEW_PORT_SOCKET_DEF], outputs: [] };

  if (key) derivedBoundaryDefinitions.set(key, derived);
  return derived;
}

/**
 * A node instance's real definition — its type's, except for a group, whose
 * sockets come from the subgraph it carries.
 *
 * Returns undefined for an unknown type, exactly as `registry.get` did, so
 * every existing "no definition, skip it" branch keeps behaving the same.
 */
export function resolveDefinition(
  instance: NodeInstance | undefined,
  registry: NodeRegistry,
): NodeDefinition | undefined {
  if (!instance) return undefined;
  const base = registry.get(instance.type);
  if (!base) return base;
  if (instance.subgraph) return deriveGroupDefinition(instance, base);
  if (instance.type === GROUP_INPUT_TYPE || instance.type === GROUP_OUTPUT_TYPE) {
    return deriveBoundaryDefinition(instance, base);
  }
  return base;
}

/** True for a node that carries a subgraph — the only kind whose ports vary per instance. */
export function isGroupInstance(instance: NodeInstance | undefined): boolean {
  return Boolean(instance?.subgraph);
}

/**
 * Every graph in a tree, outermost first: the graph itself, then each group's
 * subgraph, depth first.
 *
 * What anything that used to iterate `graph.nodes` once — serialization,
 * pruning, file rehydration, cache disposal — walks instead, so a nested
 * graph is never quietly left out of a pass that was meant to cover the
 * document.
 */
export function walkGraphs(graph: Graph): Graph[] {
  const out: Graph[] = [graph];
  for (const node of graph.nodes) {
    if (node.subgraph) out.push(...walkGraphs(node.subgraph));
  }
  return out;
}

/** Every node instance in a tree, groups themselves included, depth first. */
export function walkNodes(graph: Graph): NodeInstance[] {
  const out: NodeInstance[] = [];
  for (const g of walkGraphs(graph)) out.push(...g.nodes);
  return out;
}

/**
 * Every node id in a tree, groups themselves included.
 *
 * Ids stay globally unique across nesting levels (see NodeInstance.subgraph),
 * so this really is a flat set and the per-node-id caches can be addressed
 * with it directly — deleting a group has to drop what its whole interior
 * owned, not just the group node's own entry.
 */
export function collectAllNodeIds(graph: Graph): string[] {
  return walkNodes(graph).map((n) => n.id);
}

/**
 * A node anywhere in the tree, by id — ids are globally unique, so there is
 * exactly one answer and no path needed to ask the question.
 */
export function findNodeDeep(graph: Graph, nodeId: string): NodeInstance | undefined {
  for (const node of graph.nodes) {
    if (node.id === nodeId) return node;
    if (node.subgraph) {
      const found = findNodeDeep(node.subgraph, nodeId);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * A node plus the graph that actually holds it — for a caller that needs the
 * node's *context* as well (its connections, its level's keyframes) rather
 * than just the instance.
 */
export function findNodeWithGraph(
  graph: Graph,
  nodeId: string,
): { instance: NodeInstance; graph: Graph } | undefined {
  for (const node of graph.nodes) {
    if (node.id === nodeId) return { instance: node, graph };
    if (node.subgraph) {
      const found = findNodeWithGraph(node.subgraph, nodeId);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * The same graph with one node — at whatever depth it sits — replaced by
 * `update(node)`. Untouched branches keep their object identity, so an edit
 * inside a group doesn't invalidate the caches keyed on every *other*
 * subgraph.
 *
 * Returns the graph itself when the node isn't there, matching the "nothing
 * to update, nothing changes" shape App.tsx's setGraph updaters already use.
 */
export function updateNodeDeep(
  graph: Graph,
  nodeId: string,
  update: (node: NodeInstance) => NodeInstance,
): Graph {
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    if (node.id === nodeId) {
      changed = true;
      return update(node);
    }
    if (!node.subgraph) return node;
    const subgraph = updateNodeDeep(node.subgraph, nodeId, update);
    if (subgraph === node.subgraph) return node;
    changed = true;
    return { ...node, subgraph };
  });
  return changed ? { ...graph, nodes } : graph;
}

/**
 * The subgraph a path of group node ids leads to — how the editor addresses
 * "the level currently being edited" after a dive-in.
 *
 * Returns undefined when the path no longer resolves (the group was deleted
 * or undone away), which the caller reads as "pop back to the root".
 */
export function graphAtPath(root: Graph, path: readonly string[]): Graph | undefined {
  let current: Graph = root;
  for (const nodeId of path) {
    const node = current.nodes.find((n) => n.id === nodeId);
    if (!node?.subgraph) return undefined;
    current = node.subgraph;
  }
  return current;
}

/**
 * `root` with the graph at `path` replaced — the write side of graphAtPath,
 * rebuilding only the spine down to it so every untouched branch keeps its
 * object identity (and with it, the evaluator's structural cache and this
 * file's derived definitions).
 */
export function replaceGraphAtPath(root: Graph, path: readonly string[], next: Graph): Graph {
  if (path.length === 0) return next;
  const [head, ...rest] = path;
  return {
    ...root,
    nodes: root.nodes.map((node) => {
      if (node.id !== head || !node.subgraph) return node;
      return { ...node, subgraph: replaceGraphAtPath(node.subgraph, rest, next) };
    }),
  };
}
