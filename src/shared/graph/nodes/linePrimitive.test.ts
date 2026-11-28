import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { DEFAULT_REGISTRY } from "./index";
import { evaluateGraph } from "../evaluate";
import { readPolyMesh } from "../mesh/polyIO";
import { readAttribute } from "../mesh/polyAttributes";
import type { Graph, NodeInstance } from "../types";

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

describe("Line primitive", () => {
  it("is a wire mesh, a curve and a list of points, all the same line", () => {
    const out = run(graphOf([node("l", "object/line", { start: new THREE.Vector3(1, 0, 0), end: new THREE.Vector3(1, 2, 0), segments: 4 })], [])).get("l")!;
    const poly = readPolyMesh(out.geometry as THREE.Object3D)!.mesh;
    expect(poly.positions).toHaveLength(5);
    expect(poly.edges).toHaveLength(4);
    expect(poly.faces).toHaveLength(0);
    expect(Array.from(readAttribute(poly, "point", "u")!.values)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect((out.points as THREE.Vector3[]).map((p) => p.y)).toEqual([0, 0.5, 1, 1.5, 2]);
    expect((out.curve as THREE.Curve<THREE.Vector3>).getPoint(1).toArray()).toEqual([1, 2, 0]);
  });

  it("revolves into a surface", () => {
    const g = graphOf(
      [node("l", "object/line", { start: new THREE.Vector3(1, 0, 0), end: new THREE.Vector3(0.5, 2, 0), segments: 4 }), node("rev", "modeling/revolve", { segments: 12 })],
      [["l", "geometry", "rev", "geometry"]],
    );
    const poly = readPolyMesh(run(g).get("rev")!.geometry as THREE.Object3D)!.mesh;
    expect(poly.faces).toHaveLength(4 * 12);
  });

  it("gives Copy to Points one copy per point", () => {
    const g = graphOf(
      [node("l", "object/line", { segments: 6 }), node("box", "object/box"), node("copy", "modeling/copy-to-points")],
      [
        ["l", "geometry", "copy", "geometry"],
        ["box", "geometry", "copy", "source"],
      ],
    );
    expect(run(g).get("copy")!.copies).toBe(7);
  });
});
