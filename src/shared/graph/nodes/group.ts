import * as THREE from "three";
import { evaluateGraph } from "../evaluate";
import { composeNativeMatrix } from "./transform";
import { boundaryNodes, GROUP_INPUT_TYPE, GROUP_OUTPUT_TYPE, GROUP_TYPE, groupRendersOwnContainer, portsOf } from "../groups";
import { createNodeCache } from "../nodeCaches";
import { resolveSceneRoots } from "../sceneRoots";
import { EvalContext, Graph, NodeDefinition, ParamFieldDef } from "../types";

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

const POSED_PARAM_FIELDS: ParamFieldDef[] = [
  { id: "name", label: "Name", kind: "text" },
  { id: "visible", label: "Visible", kind: "boolean", group: "Transform" },
  { id: "location", label: "Location", kind: "vector", group: "Transform" },
  { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true, group: "Transform" },
  { id: "scale", label: "Scale", kind: "vector", group: "Transform" },
];

export const GROUP_NODE: NodeDefinition = {
  type: GROUP_TYPE,
  label: "Group",
  category: "structure",
  // Both lists are per-instance — resolveDefinition replaces them with the
  // boundary's ports. What is declared here is what an *empty* group has.
  inputs: [],
  outputs: [],
  defaultParams: {
    name: "Group",
    visible: 1,
    // A native pose, the same one Merge owns and for the same reason: the
    // group's container is one object holding everything the interior built,
    // so the viewport gizmo can move, rotate and scale the whole set at once
    // instead of the author diving in to nudge each node. Only meaningful
    // while the group renders its own container — see resolveGizmoTarget.
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
  },
  paramFields: POSED_PARAM_FIELDS,
  /**
   * The pose is only real while the group renders its own container. A group
   * that hands an interior object out through a `geometry` port doesn't place
   * anything — showing Location/Rotation/Scale there would be three knobs
   * that move nothing, which is worse than not showing them.
   */
  dynamicParamFields: (instance) =>
    !instance.subgraph || groupRendersOwnContainer(instance.subgraph)
      ? POSED_PARAM_FIELDS
      : [
          { id: "name", label: "Name", kind: "text" },
          { id: "visible", label: "Visible", kind: "boolean" },
          {
            id: "forwarded",
            label:
              "This group's Geometry output comes from a node inside it, which places itself — move that node, or remove the port to let the group hold its own contents.",
            kind: "note",
          },
        ],
  evaluate: (inputs, params, ctx) => {
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
      // Tagged so a click on anything inside resolves to the group: from
      // outside, the group is the thing you selected (Viewport.tsx walks up
      // to the outermost tag that the graph it is drawing actually knows).
      container.userData.nodeId = ctx.nodeId;

      const objects: THREE.Object3D[] = [];
      for (const rootId of sceneRootsOf(subgraph, ctx)) {
        const geometry = results.get(rootId)?.geometry;
        if (geometry instanceof THREE.Object3D) objects.push(geometry);
      }
      syncContainer(container, objects);

      // The pose the gizmo drags. Skipped for the frame the gizmo is holding
      // this node, exactly as Merge does: the evaluator would otherwise
      // overwrite the matrix TransformControls just set, 60 times a second.
      if (ctx.nodeId !== ctx.liveEditNodeId) {
        container.matrixAutoUpdate = false;
        container.matrix.copy(
          composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params),
        );
      }

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
