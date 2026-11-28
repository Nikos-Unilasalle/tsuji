import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { canConnectSockets, coerceInput, geometryOfPoints, pointsOfGeometry } from "./socketCoercion";
import { readPolyMesh } from "./mesh/polyIO";
import { DEFAULT_REGISTRY } from "./nodes/index";
import { evaluateGraph } from "./evaluate";
import type { Graph, NodeInstance } from "./types";

const node = (id: string, type: string, params: Record<string, unknown> = {}): NodeInstance => ({
  id,
  type,
  params: { ...DEFAULT_REGISTRY.get(type)!.defaultParams, ...params },
  position: { x: 0, y: 0 },
});
const graphOf = (nodes: NodeInstance[], wires: [string, string, string, string][]) =>
  ({
    nodes,
    connections: wires.map(([a, as, b, bs]) => ({ id: `${a}.${as}->${b}.${bs}`, fromNode: a, fromSocket: as, toNode: b, toSocket: bs })),
    keyframes: {},
    markers: [],
    exposedParams: [],
  }) as unknown as Graph;
const run = (g: Graph) => evaluateGraph(g, DEFAULT_REGISTRY, { time: 0, step: 0, nodeId: "", registry: DEFAULT_REGISTRY });

describe("socket coercion", () => {
  it("lets points and curves connect across their two shapes, nothing else", () => {
    expect(canConnectSockets("list", "geometry")).toBe(true);
    expect(canConnectSockets("geometry", "list")).toBe(true);
    expect(canConnectSockets("curve", "list")).toBe(true);
    expect(canConnectSockets("list", "curve")).toBe(true);
    expect(canConnectSockets("value", "geometry")).toBe(false);
    expect(canConnectSockets("geometry", "curve")).toBe(false);
  });

  it("leaves values of the right shape alone", () => {
    const list = [new THREE.Vector3()];
    expect(coerceInput(list, "list")).toBe(list);
    const obj = new THREE.Object3D();
    expect(coerceInput(obj, "geometry")).toBe(obj);
  });

  it("round-trips points through a point-only mesh", () => {
    const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 2, 3)];
    const mesh = geometryOfPoints(pts);
    const read = readPolyMesh(mesh)!;
    expect(read.mesh.positions).toEqual([
      [0, 0, 0],
      [1, 2, 3],
    ]);
    expect(pointsOfGeometry(mesh).map((p) => p.toArray())).toEqual([
      [0, 0, 0],
      [1, 2, 3],
    ]);
  });

  it("feeds a list of points into Copy to Points (geometry)", () => {
    const g = graphOf(
      [node("xs", "list/generate", { count: 5 }), node("pts", "math/expression", { formula: "(x, 0, 0)" }), node("box", "object/box"), node("copy", "modeling/copy-to-points")],
      [
        ["xs", "list", "pts", "x"],
        ["pts", "list", "copy", "geometry"],
        ["box", "geometry", "copy", "source"],
      ],
    );
    const out = run(g).get("copy")!;
    expect(out.copies).toBe(5);
  });

  it("feeds a mesh (geometry) into a list of points and a list into a curve", () => {
    const g = graphOf(
      [node("box", "object/box"), node("curve", "curve/from_points")],
      [["box", "geometry", "curve", "points"]],
    );
    const out = run(g).get("curve")!;
    expect(out.curve).toBeInstanceOf(THREE.Curve);
    expect(coerceInput([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)], "curve")).toBeInstanceOf(THREE.Curve);
  });
});
