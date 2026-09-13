import * as THREE from "three";
import { evaluateGraph } from "../evaluate";
import { boundaryNodes, GROUP_INPUT_TYPE, GROUP_OUTPUT_TYPE, GROUP_TYPE, portsOf } from "../groups";
import { createNodeCache } from "../nodeCaches";
import { resolveSceneRoots } from "../sceneRoots";
import { EvalContext, Graph, NodeDefinition } from "../types";

/**
 * A group: a whole graph, evaluated as one node.
 *
 * The parent graph sees a single node with the ports its boundary declares;
 * inside, everything works exactly as it does at the top level — same
 * evaluator, same clock, same registry. Which is the point: a group is not a
 * second kind of graph with its own rules, it is the same graph one level
 * down. See groups.ts for how the ports are worked out and why the sockets
 * belong to the instance rather than to the type.
 *
 * Node ids stay globally unique across levels, so nothing keyed by node id —
 * keyframes, the caches below, the HUD's exposed params — needs to know that
 * nesting exists at all.
 */

/**
 * The container holding whatever the group builds and nobody outside claimed.
 *
 * One per group node, reused across frames: the objects inside are owned by
 * the inner nodes' own caches, so this only ever borrows them and must not
 * dispose anything when it is dropped.
 */
const containers = createNodeCache<THREE.Group>();

// Scene roots depend on the subgraph's shape, which changes on an edit, not on
// a frame — the same reasoning (and the same fix) as Viewport's cachedRoots.
const rootsBySubgraph = new WeakMap<Graph, string[]>();

function sceneRootsOf(subgraph: Graph, ctx: EvalContext): string[] {
  let roots = rootsBySubgraph.get(subgraph);
  if (!roots) {
    roots = resolveSceneRoots(subgraph, ctx.registry!);
    rootsBySubgraph.set(subgraph, roots);
  }
  return roots;
}

function syncContainer(container: THREE.Group, objects: THREE.Object3D[]): void {
  for (let i = container.children.length - 1; i >= 0; i--) {
    const child = container.children[i];
    if (!objects.includes(child)) container.remove(child);
  }
  for (const object of objects) {
    if (object.parent !== container) container.add(object);
  }
}

export const GROUP_NODE: NodeDefinition = {
  type: GROUP_TYPE,
  label: "Group",
  category: "structure",
  // Both lists are per-instance — resolveDefinition replaces them with the
  // boundary's ports. What is declared here is what an *empty* group has.
  inputs: [],
  outputs: [],
  defaultParams: { name: "Group" },
  paramFields: [{ id: "name", label: "Name", kind: "text" }],
  evaluate: (inputs, _params, ctx) => {
    const subgraph = ctx.instance?.subgraph;
    if (!subgraph || !ctx.registry) return {};

    // Nested groups each get their own scope, so a group inside a group can't
    // become its parent's carried-over frame either.
    const evalScope = ctx.evalScope ? `${ctx.evalScope}/${ctx.nodeId}` : ctx.nodeId;

    // ctx.keyframes rides through untouched: keys are stored on the document
    // that owns the timeline, keyed by node id, and grouping does not change
    // a node's id. An interior node stays animated by exactly the keys it had
    // before it was grouped.
    const results = evaluateGraph(subgraph, ctx.registry, {
      ...ctx,
      nodeId: "",
      instance: undefined,
      evalScope,
      groupInputs: inputs,
    });

    const outputs: Record<string, unknown> = {};
    const output = boundaryNodes(subgraph).output;
    if (output) {
      const produced = results.get(output.id) ?? {};
      for (const port of portsOf(output)) outputs[port.id] = produced[port.id];
    }

    // Everything the interior built that no boundary port claimed still has to
    // reach the screen: the outer graph only draws this one node.
    if (outputs.geometry === undefined) {
      let container = containers.get(ctx.nodeId);
      if (!container) {
        container = new THREE.Group();
        container.name = `group:${ctx.nodeId}`;
        containers.set(ctx.nodeId, container);
      }
      const objects: THREE.Object3D[] = [];
      for (const rootId of sceneRootsOf(subgraph, ctx)) {
        const geometry = results.get(rootId)?.geometry;
        if (geometry instanceof THREE.Object3D) objects.push(geometry);
      }
      syncContainer(container, objects);
      outputs.geometry = container;
    }

    return outputs;
  },
};

export const GROUP_INPUT_NODE: NodeDefinition = {
  type: GROUP_INPUT_TYPE,
  label: "Group Input",
  category: "structure",
  inputs: [],
  // Per-instance: one output per port the group exposes — see resolveDefinition.
  outputs: [],
  defaultParams: { ports: [] },
  evaluate: (_inputs, params, ctx) => {
    const outputs: Record<string, unknown> = {};
    const incoming = ctx.groupInputs ?? {};
    for (const port of portsOf({ id: ctx.nodeId, type: GROUP_INPUT_TYPE, params, position: { x: 0, y: 0 } })) {
      outputs[port.id] = incoming[port.id];
    }
    return outputs;
  },
};

export const GROUP_OUTPUT_NODE: NodeDefinition = {
  type: GROUP_OUTPUT_TYPE,
  label: "Group Output",
  category: "structure",
  // Per-instance: one input per port the group exposes.
  inputs: [],
  outputs: [],
  defaultParams: { ports: [] },
  /**
   * Hands its inputs straight back as outputs. It produces nothing of its own
   * — the group node reads this node's results to know what leaves the
   * boundary, and going through the results map is what makes the values
   * arrive after the interior's topological order has run, not before.
   */
  evaluate: (inputs) => ({ ...inputs }),
};
