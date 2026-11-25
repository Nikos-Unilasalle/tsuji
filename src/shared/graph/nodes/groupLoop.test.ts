import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { evaluateGraph } from "../evaluate";
import { DEFAULT_REGISTRY } from "./index";
import { readPolyMesh } from "../mesh/polyIO";
import { Connection, EvalContext, Graph, NodeInstance, emptyGraph } from "../types";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "", registry: DEFAULT_REGISTRY };
const node = (id: string, type: string, params: Record<string, unknown> = {}): NodeInstance => ({ id, type, params, position: { x: 0, y: 0 } });
const edge = (a: string, as: string, b: string, bs: string): Connection => ({ id: `${a}.${as}->${b}.${bs}`, fromNode: a, fromSocket: as, toNode: b, toSocket: bs });
// A fresh array per boundary node: groups.ts caches derived definitions by the ports array.
const port = () => [{ id: "geometry", label: "Geometry", type: "geometry" }];

function loopGraph(interior: NodeInstance[], wires: Connection[], groupParams: Record<string, unknown>, source: NodeInstance): Graph {
  const sub: Graph = {
    ...emptyGraph(),
    nodes: [node("gin", "structure/group-input", { ports: port() }), ...interior, node("gout", "structure/group-output", { ports: port() })],
    connections: wires,
  };
  const group: NodeInstance = { ...node("grp", "structure/group", { ...DEFAULT_REGISTRY.get("structure/group")!.defaultParams, ...groupParams }), subgraph: sub };
  return { ...emptyGraph(), nodes: [source, group], connections: [edge(source.id, "geometry", "grp", "geometry")] };
}

describe("group loops", () => {
  it("repeat feeds each iteration's geometry into the next", () => {
    const extrude = node("ex", "modifier/extrude", { ...DEFAULT_REGISTRY.get("modifier/extrude")!.defaultParams, group: "*", distance: 0.2 });
    const g = loopGraph([extrude], [edge("gin", "geometry", "ex", "geometry"), edge("ex", "geometry", "gout", "geometry")], { loop: "repeat", iterations: 3 }, node("pl", "object/plane"));
    const results = evaluateGraph(g, DEFAULT_REGISTRY, CTX);
    const out = results.get("grp")?.geometry as THREE.Object3D;
    expect(readPolyMesh(out)!.mesh.faces.length).toBe(13);
  });

  it("for-each-count merges independent iterations, Loop Info drives them", () => {
    const info = node("info", "structure/loop-info");
    const xf = node("sel", "select/basic", { ...DEFAULT_REGISTRY.get("select/basic")!.defaultParams, mode: "all" });
    const g = loopGraph([info, xf], [edge("gin", "geometry", "sel", "geometry"), edge("sel", "geometry", "gout", "geometry")], { loop: "for-each-count", iterations: 4 }, node("bx", "object/box"));
    const results = evaluateGraph(g, DEFAULT_REGISTRY, CTX);
    const out = results.get("grp")?.geometry as THREE.Object3D;
    expect(readPolyMesh(out)!.mesh.faces.length).toBe(24);
  });

  it("for-each-piece runs once per connected piece", () => {
    const join = node("j", "modeling/join", { sourceAttribute: "" });
    const sel = node("sel", "select/basic", { ...DEFAULT_REGISTRY.get("select/basic")!.defaultParams, mode: "all" });
    const sub: Graph = {
      ...emptyGraph(),
      nodes: [node("gin", "structure/group-input", { ports: port() }), sel, node("gout", "structure/group-output", { ports: port() })],
      connections: [edge("gin", "geometry", "sel", "geometry"), edge("sel", "geometry", "gout", "geometry")],
    };
    const g: Graph = {
      ...emptyGraph(),
      nodes: [
        node("b1", "object/box"),
        { ...node("b2", "object/box", { ...DEFAULT_REGISTRY.get("object/box")!.defaultParams, location: new THREE.Vector3(3, 0, 0) }) },
        join,
        { ...node("grp", "structure/group", { ...DEFAULT_REGISTRY.get("structure/group")!.defaultParams, loop: "for-each-piece" }), subgraph: sub },
      ],
      connections: [edge("b1", "geometry", "j", "geometry"), edge("b2", "geometry", "j", "b"), edge("j", "geometry", "grp", "geometry")],
    };
    const results = evaluateGraph(g, DEFAULT_REGISTRY, CTX);
    const m = readPolyMesh(results.get("grp")?.geometry as THREE.Object3D)!.mesh;
    expect(m.faces.length).toBe(12);
  });
});
