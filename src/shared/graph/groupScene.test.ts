import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { resolveActiveEnvironment } from "../three/environmentSync";
import { deepResultEntries, evaluateGraph } from "./evaluate";
import { groupSelection } from "./groupSelection";
import { DEFAULT_REGISTRY } from "./nodes";
import { findRenderNodeId } from "./nodes/render";
import { Connection, EvalContext, Graph, NodeInstance, emptyGraph } from "./types";

/**
 * The scene-wide nodes — Render, Environment, lights — keep doing their job
 * once grouped: the app finds them wherever they sit in the tree.
 */

const CTX: EvalContext = { time: 0, step: 0, nodeId: "", registry: DEFAULT_REGISTRY };

function node(id: string, type: string, x = 0): NodeInstance {
  return { id, type, params: {}, position: { x, y: 0 } };
}

function edge(fromNode: string, fromSocket: string, toNode: string, toSocket: string): Connection {
  return { id: `${fromNode}.${fromSocket}->${toNode}.${toSocket}`, fromNode, fromSocket, toNode, toSocket };
}

function scene(): Graph {
  return {
    ...emptyGraph(),
    nodes: [node("env", "lighting/environment"), node("lamp", "light/point", 100), node("render", "render", 300)],
    connections: [edge("env", "environment", "render", "environment")],
  };
}

function grouped(ids: string[]): Graph {
  let n = 0;
  return groupSelection(scene(), ids, DEFAULT_REGISTRY, () => `g${n++}`)!.graph;
}

describe("scene nodes inside a group", () => {
  it("finds the Render node inside a group", () => {
    const graph = grouped(["env", "lamp", "render"]);
    expect(graph.nodes.some((n) => n.id === "render")).toBe(false);
    expect(findRenderNodeId(graph)).toBe("render");
  });

  it("reaches a grouped light and Environment through the nested results", () => {
    const graph = grouped(["env", "lamp", "render"]);
    const results = evaluateGraph(graph, DEFAULT_REGISTRY, CTX);

    const lights: THREE.Light[] = [];
    for (const [, res] of deepResultEntries(results)) {
      const obj = (res.light || res.geometry) as unknown;
      if (obj instanceof THREE.Object3D) obj.traverse((c) => c instanceof THREE.Light && lights.push(c));
    }
    expect(lights.length).toBeGreaterThan(0);
    expect(resolveActiveEnvironment(results, findRenderNodeId(graph)!)).not.toBeNull();
  });

  it("carries an Environment out of a group into a Render outside it", () => {
    const graph = grouped(["env"]);
    const results = evaluateGraph(graph, DEFAULT_REGISTRY, CTX);
    const env = results.get("render")?.environment;
    expect(env && typeof env === "object").toBe(true);
  });
});
