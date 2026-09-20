import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { resolveCurveEditTarget } from "./curveLookup";
import { Connection, Graph, NodeInstance } from "./types";

function node(id: string, type: string, params: Record<string, unknown> = {}): NodeInstance {
  return { id, type, position: { x: 0, y: 0 }, params };
}

function wire(fromNode: string, fromSocket: string, toNode: string, toSocket: string): Connection {
  return { id: `${fromNode}:${fromSocket}->${toNode}:${toSocket}`, fromNode, fromSocket, toNode, toSocket };
}

const POINTS = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)];

describe("resolveCurveEditTarget", () => {
  test("a Curve to Mesh with a Curve from Points wired in edits the producer's points, in the mesh's space", () => {
    const graph: Graph = {
      nodes: [node("pts1", "curve/from_points", { pointsList: POINTS }), node("mesh1", "curve/to_mesh")],
      connections: [wire("pts1", "curve", "mesh1", "curve")],
    };

    expect(resolveCurveEditTarget(graph, "mesh1")).toEqual({ pointsNodeId: "pts1", spaceNodeId: "mesh1" });
  });

  test("selecting the producer resolves the same pair — handles look identical from either end of the wire", () => {
    const graph: Graph = {
      nodes: [node("pts1", "curve/from_points", { pointsList: POINTS }), node("mesh1", "curve/to_mesh")],
      connections: [wire("pts1", "curve", "mesh1", "curve")],
    };

    expect(resolveCurveEditTarget(graph, "pts1")).toEqual({ pointsNodeId: "pts1", spaceNodeId: "mesh1" });
  });

  test("a Curve to Mesh with nothing wired in edits its own fallback list, in its own space", () => {
    const graph: Graph = {
      nodes: [node("mesh1", "curve/to_mesh", { pointsList: POINTS })],
      connections: [],
    };

    expect(resolveCurveEditTarget(graph, "mesh1")).toEqual({ pointsNodeId: "mesh1", spaceNodeId: "mesh1" });
  });

  test("a parametric curve upstream has no draggable points", () => {
    const graph: Graph = {
      nodes: [node("prim1", "curve/primitive"), node("mesh1", "curve/to_mesh", { pointsList: POINTS })],
      connections: [wire("prim1", "curve", "mesh1", "curve")],
    };

    expect(resolveCurveEditTarget(graph, "mesh1")).toBeNull();
  });

  test("a node with no points and no curve input has no handles", () => {
    const graph: Graph = { nodes: [node("box1", "object/box")], connections: [] };

    expect(resolveCurveEditTarget(graph, "box1")).toBeNull();
  });

  test("nothing selected, or a stale selection, resolves to null", () => {
    const graph: Graph = { nodes: [node("pts1", "curve/from_points", { pointsList: POINTS })], connections: [] };

    expect(resolveCurveEditTarget(graph, null)).toBeNull();
    expect(resolveCurveEditTarget(graph, "deleted")).toBeNull();
  });

  test("a lone Curve from Points is edited in world space", () => {
    const graph: Graph = { nodes: [node("pts1", "curve/from_points", { pointsList: POINTS })], connections: [] };

    expect(resolveCurveEditTarget(graph, "pts1")).toEqual({ pointsNodeId: "pts1", spaceNodeId: "pts1" });
  });

  test("Curve Deform places the points it deforms along, same as Curve to Mesh", () => {
    const graph: Graph = {
      nodes: [node("pts1", "curve/from_points", { pointsList: POINTS }), node("def1", "curve/deform")],
      connections: [wire("pts1", "curve", "def1", "curve")],
    };

    expect(resolveCurveEditTarget(graph, "def1")).toEqual({ pointsNodeId: "pts1", spaceNodeId: "def1" });
  });

  test("Lattice Deform edits its own control points in its own space", () => {
    const graph: Graph = {
      nodes: [node("lat1", "modifier/lattice", { pointsList: POINTS })],
      connections: [],
    };

    expect(resolveCurveEditTarget(graph, "lat1")).toEqual({ pointsNodeId: "lat1", spaceNodeId: "lat1" });
  });

  test("Edit Mesh Points edits its own control points in its own space even when pointsList is unseeded", () => {
    const graph: Graph = {
      nodes: [node("box1", "object/box"), node("edit1", "object/edit_points", { pointsList: [] })],
      connections: [wire("box1", "geometry", "edit1", "basis")],
    };

    expect(resolveCurveEditTarget(graph, "edit1")).toEqual({ pointsNodeId: "edit1", spaceNodeId: "edit1" });
  });

  test("Edit Mesh Points with seeded pointsList resolves to its own node for points and space", () => {
    const graph: Graph = {
      nodes: [node("edit1", "object/edit_points", { pointsList: POINTS })],
      connections: [],
    };

    expect(resolveCurveEditTarget(graph, "edit1")).toEqual({ pointsNodeId: "edit1", spaceNodeId: "edit1" });
  });
});

