import * as THREE from "three";
import { Graph, KeyframeStore, NodeInstance } from "./types";

/**
 * Deep-copies a graph while keeping its THREE instances *as instances*,
 * along with its keyframes and markers.
 *
 * The obvious `JSON.parse(JSON.stringify(graph))` does not: it flattens a
 * THREE.Vector3 into a plain `{x, y, z}` and a THREE.Color into `{r, g, b}`.
 * Every node's `evaluate` guards its params with `instanceof` before trusting
 * them (see asVector3 in transform.ts and friends), so a flattened param
 * silently reads as absent and falls back to the node's default. Undo/redo
 * used that JSON round-trip for its snapshots, which is why stepping back
 * quietly reset every vector and colour in the graph to defaults instead of
 * restoring what was there.
 *
 * Same failure the IPC boundary has, but the cure differs: IPC genuinely
 * hands over JSON and has to rebuild instances from the registry's
 * defaultParams (rehydrateParams.ts). Here the originals are still in memory,
 * so they can just be cloned — no registry, no guessing a param's intended
 * type from its shape.
 */
export function cloneParamValue(value: unknown): unknown {
  if (value instanceof THREE.Vector3) return value.clone();
  if (value instanceof THREE.Color) return value.clone();
  if (value instanceof THREE.Matrix4) return value.clone();
  if (value instanceof THREE.Quaternion) return value.clone();
  if (value instanceof THREE.Euler) return value.clone();
  if (ArrayBuffer.isView(value)) {
    // Typed arrays (Float32Array, Uint32Array, etc.) used in geometry buffers
    return (value as Float32Array).slice();
  }
  if (Array.isArray(value)) {
    // Fast path for plain primitive arrays (e.g. vertex indices, point coordinates):
    // check if any element is an object that needs deep cloning.
    let hasObjects = false;
    for (let i = 0; i < value.length; i++) {
      const el = value[i];
      if (el !== null && typeof el === "object") {
        hasObjects = true;
        break;
      }
    }
    if (!hasObjects) {
      return value.slice();
    }
    return value.map(cloneParamValue);
  }
  // Textures, meshes and other GPU resources are shared on purpose — a node's
  // cached mesh must stay the same object across frames — so anything that
  // isn't a plain object is passed through by reference rather than copied.
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return cloneParams(value as Record<string, unknown>);
  }
  return value;
}

export function cloneParams(params: Record<string, unknown>): Record<string, unknown> {
  const cloned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) cloned[key] = cloneParamValue(value);
  return cloned;
}

export function cloneKeyframes(store?: KeyframeStore): KeyframeStore | undefined {
  if (!store) return undefined;
  const cloned: KeyframeStore = {};
  for (const [nodeId, paramMap] of Object.entries(store)) {
    cloned[nodeId] = {};
    for (const [paramKey, list] of Object.entries(paramMap)) {
      cloned[nodeId][paramKey] = list.map((kf) => ({
        frame: kf.frame,
        value: cloneParamValue(kf.value),
        easeIn: kf.easeIn,
        easeStrength: kf.easeStrength,
        easeBezier: kf.easeBezier ? ([...kf.easeBezier] as [number, number, number, number]) : undefined,
      }));
    }
  }
  return cloned;
}

function cloneNode(node: NodeInstance): NodeInstance {
  return {
    id: node.id,
    type: node.type,
    position: { x: node.position.x, y: node.position.y },
    params: cloneParams(node.params),
    // A group's subgraph is part of the node, so a snapshot that shared it by
    // reference would let an edit inside the group reach into every undo entry
    // taken before it.
    ...(node.subgraph ? { subgraph: cloneGraph(node.subgraph) } : {}),
  };
}

export function cloneGraph(graph: Graph): Graph {
  return {
    nodes: graph.nodes.map(cloneNode),
    connections: graph.connections.map((c) => ({ ...c })),
    keyframes: cloneKeyframes(graph.keyframes),
    markers: graph.markers ? graph.markers.map((m) => ({ ...m })) : undefined,
    exposedParams: graph.exposedParams ? graph.exposedParams.map((e) => ({ ...e })) : undefined,
  };
}
