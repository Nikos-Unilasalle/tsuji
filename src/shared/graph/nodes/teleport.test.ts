import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { DEFAULT_REGISTRY } from "./index";
import { evaluateGraph } from "../evaluate";
import { resolveSceneRoots } from "../sceneRoots";
import { pruneDanglingConnections } from "../pruneConnections";
import { TELEPORT_TYPE } from "./teleport";
import type { Graph, NodeInstance } from "../types";

const node = (id: string, type: string, params: Record<string, unknown> = {}): NodeInstance => ({
  id,
  type,
  params: { ...(DEFAULT_REGISTRY.get(type)?.defaultParams ?? {}), ...params },
  position: { x: 0, y: 0 },
});
const teleport = (id: string, source: string) =>
  node(id, TELEPORT_TYPE, { source, ports: DEFAULT_REGISTRY.get("object/box")!.outputs.map(({ id, label, type }) => ({ id, label, type })) });
const graphOf = (nodes: NodeInstance[], wires: [string, string, string, string][]) =>
  ({
    nodes,
    connections: wires.map(([a, as, b, bs]) => ({ id: `${a}.${as}->${b}.${bs}`, fromNode: a, fromSocket: as, toNode: b, toSocket: bs })),
    keyframes: {},
    markers: [],
    exposedParams: [],
  }) as unknown as Graph;
const run = (g: Graph) => evaluateGraph(g, DEFAULT_REGISTRY, { time: 0, step: 0, nodeId: "", registry: DEFAULT_REGISTRY });

describe("teleport", () => {
  // Listed before its source on purpose: the order comes from the teleport link, not the list.
  const g = graphOf(
    [teleport("tp", "box"), node("box", "object/box"), node("ext", "modifier/extrude", { group: "*", distance: 0.3 })],
    [["tp", "geometry", "ext", "geometry"]],
  );

  it("hands on its source's outputs, evaluated after it", () => {
    const r = run(g);
    expect(r.get("tp")!.geometry).toBe(r.get("box")!.geometry);
    expect(r.get("ext")!.geometry).toBeInstanceOf(THREE.Object3D);
  });

  it("is never drawn itself, and what it feeds owns the source", () => {
    expect(resolveSceneRoots(g, DEFAULT_REGISTRY)).toEqual(["ext"]);
    const unused = graphOf([teleport("tp", "box"), node("box", "object/box")], []);
    expect(resolveSceneRoots(unused, DEFAULT_REGISTRY)).toEqual(["box"]);
  });

  it("keeps its wires on load (its sockets are stored with it)", () => {
    expect(pruneDanglingConnections(g, DEFAULT_REGISTRY).connections).toHaveLength(1);
  });
});
