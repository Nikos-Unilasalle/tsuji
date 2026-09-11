import { describe, expect, it } from "vitest";
import { Connection, Graph, NodeInstance } from "./types";
import { GIZMO_SELECTABLE_TYPES, resolveGizmoTarget } from "./transformLookup";

function node(id: string, type: string): NodeInstance {
  return { id, type, params: {}, position: { x: 0, y: 0 } };
}

function wire(fromNode: string, fromSocket: string, toNode: string, toSocket: string): Connection {
  return { id: `${fromNode}->${toNode}`, fromNode, fromSocket, toNode, toSocket };
}

describe("resolveGizmoTarget", () => {
  it("finds a Transform node wired directly into the object's matrix input", () => {
    // Arrange
    const graph: Graph = {
      nodes: [node("t1", "transform"), node("box1", "object/box")],
      connections: [wire("t1", "matrix", "box1", "matrix")],
    };

    // Act
    const result = resolveGizmoTarget(graph, "box1");

    // Assert
    expect(result).toEqual({ kind: "absolute", transformNodeId: "t1" });
  });

  it("resolves a Matrix Transform node as an offset target, with its own base source", () => {
    // Arrange
    const graph: Graph = {
      nodes: [node("t1", "transform"), node("mt1", "transform/matrix-transform"), node("box1", "object/box")],
      connections: [wire("t1", "matrix", "mt1", "matrix"), wire("mt1", "matrix", "box1", "matrix")],
    };

    // Act
    const result = resolveGizmoTarget(graph, "box1");

    // Assert
    expect(result).toEqual({ kind: "offset", transformNodeId: "mt1", baseSourceNodeId: "t1" });
  });

  it("resolves a Matrix Transform node with no base wired as an offset target with a null base", () => {
    const graph: Graph = {
      nodes: [node("mt1", "transform/matrix-transform"), node("box1", "object/box")],
      connections: [wire("mt1", "matrix", "box1", "matrix")],
    };

    const result = resolveGizmoTarget(graph, "box1");

    expect(result).toEqual({ kind: "offset", transformNodeId: "mt1", baseSourceNodeId: null });
  });

  it("falls through to a native target when nothing is wired into matrix, for an object type with a native pose", () => {
    const graph: Graph = { nodes: [node("box1", "object/box")], connections: [] };
    expect(resolveGizmoTarget(graph, "box1")).toEqual({
      kind: "native",
      objectNodeId: "box1",
      deltaSourceNodeId: null,
    });
  });

  it("curve nodes (from_points, primitive, svg, to_line) resolve to a native target", () => {
    for (const type of ["curve/from_points", "curve/primitive", "curve/svg", "curve/svg_solid", "curve/svg_mesh", "curve/to_line"]) {
      const graph: Graph = { nodes: [node("c1", type)], connections: [] };
      expect(resolveGizmoTarget(graph, "c1")).toEqual({ kind: "native", objectNodeId: "c1", deltaSourceNodeId: null });
    }
  });

  it("falls through to a native target when the wired source is not a Transform or Matrix Transform node — the wired node becomes the delta", () => {
    // Arrange — a Look At node also outputs a matrix, but isn't editable via location/rotation/scale
    const graph: Graph = {
      nodes: [node("look1", "transform/look-at"), node("box1", "object/box")],
      connections: [wire("look1", "matrix", "box1", "matrix")],
    };

    // Act / Assert — the object's own native pose is still draggable; the
    // Look At output composes on top of it as the delta, not cancelling it.
    expect(resolveGizmoTarget(graph, "box1")).toEqual({
      kind: "native",
      objectNodeId: "box1",
      deltaSourceNodeId: "look1",
    });
  });

  it("a connection into a different socket doesn't count as a delta source", () => {
    const graph: Graph = {
      nodes: [node("t1", "transform"), node("box1", "object/box")],
      connections: [wire("t1", "matrix", "box1", "color")],
    };
    expect(resolveGizmoTarget(graph, "box1")).toEqual({
      kind: "native",
      objectNodeId: "box1",
      deltaSourceNodeId: null,
    });
  });

  it("gives an imported glTF model its own native pose, like an OBJ", () => {
    // Both loaders write location/rotation/scale through
    // composeNativeMatrixWithPivot and tag their meshes with the node id, so
    // there is nothing to tell them apart here — glTF was simply never listed.
    const graph: Graph = { nodes: [node("gltf1", "object/gltf")], connections: [] };
    expect(resolveGizmoTarget(graph, "gltf1")).toEqual({
      kind: "native",
      objectNodeId: "gltf1",
      deltaSourceNodeId: null,
    });
  });

  it("an imported glTF still defers to a Transform wired into its matrix", () => {
    const graph: Graph = {
      nodes: [node("t1", "transform"), node("gltf1", "object/gltf")],
      connections: [wire("t1", "matrix", "gltf1", "matrix")],
    };
    expect(resolveGizmoTarget(graph, "gltf1")).toEqual({
      kind: "absolute",
      transformNodeId: "t1",
    });
  });

  it("returns null for an unknown object node id", () => {
    const graph: Graph = { nodes: [], connections: [] };
    expect(resolveGizmoTarget(graph, "missing")).toBeNull();
  });

  it("returns null for an object type with no native pose (e.g. Ambient Light, position-independent) and nothing Transform-like wired in", () => {
    const graph: Graph = { nodes: [node("amb1", "light/ambient")], connections: [] };
    expect(resolveGizmoTarget(graph, "amb1")).toBeNull();
  });

  it("returns null for a node type not in GIZMO_SELECTABLE_TYPES at all", () => {
    const graph: Graph = { nodes: [node("osc1", "value/oscillator")], connections: [] };
    expect(resolveGizmoTarget(graph, "osc1")).toBeNull();
  });
});

describe("resolveGizmoTarget — a Transform node with a wired channel defers that object to its own native pose", () => {
  it("stays absolute when the Transform node is fully unwired", () => {
    const graph: Graph = {
      nodes: [node("t1", "transform"), node("box1", "object/box")],
      connections: [wire("t1", "matrix", "box1", "matrix")],
    };
    expect(resolveGizmoTarget(graph, "box1")).toEqual({ kind: "absolute", transformNodeId: "t1" });
  });

  it("falls to native (object's own pose, Transform node as delta) when rotation is wired", () => {
    const graph: Graph = {
      nodes: [node("vec1", "vector/compose"), node("t1", "transform"), node("box1", "object/box")],
      connections: [wire("vec1", "out", "t1", "rotation"), wire("t1", "matrix", "box1", "matrix")],
    };
    expect(resolveGizmoTarget(graph, "box1")).toEqual({
      kind: "native",
      objectNodeId: "box1",
      deltaSourceNodeId: "t1",
    });
  });

  it("falls to native when only location or only scale is wired too", () => {
    const graphLoc: Graph = {
      nodes: [node("vec1", "vector/compose"), node("t1", "transform"), node("box1", "object/box")],
      connections: [wire("vec1", "out", "t1", "location"), wire("t1", "matrix", "box1", "matrix")],
    };
    expect(resolveGizmoTarget(graphLoc, "box1")).toEqual({
      kind: "native",
      objectNodeId: "box1",
      deltaSourceNodeId: "t1",
    });
  });
});

describe("GIZMO_SELECTABLE_TYPES", () => {
  it("lists the primitive object node types", () => {
    expect(GIZMO_SELECTABLE_TYPES).toEqual([
      "object/box",
      "object/plane",
      "object/sphere",
      "object/disc",
      "object/cylinder",
      "object/cone",
      "object/bar_graph",
      "object/line_graph",
      "object/chart_axis",
      "object/pie_chart",
      "object/scatter_plot",
      "object/point_cloud",
      "object/obj",
      "object/gltf",
      "object/frozen",
      "object/text",
      "curve/to_mesh",
      "curve/to_mesh_list",
      "curve/from_points",
      "curve/primitive",
      "curve/svg",
      "curve/svg_solid",
      "curve/svg_mesh",
      "curve/to_line",
      "curve/to_line_list",
      "curve/deform",
      "structure/merge",
      "object/empty",
      "texture/plane",
      "object/decal",
      "light/directional",
      "light/point",
      "light/spot",
      "light/probe",
      "calibration/camera",
      "calibration/grid",
      "modifier/lattice",
  "modifier/edit-mesh",
      "particles/force-field",
      "particles/curl-noise",
      "particles/strange-attractor",
      "particles/emitter",
      "object/raccoon",
      "object/laser-beam",
      "curve/grease-pencil",
      "curve/paint-on-geometry",
    ]);
  });
});

describe("resolveGizmoTarget — pure geometry modifiers defer to their source", () => {
  it("a Subdivide node (no native pose, no matrix input) resolves to what feeds its geometry input", () => {
    const graph: Graph = {
      nodes: [node("box1", "object/box"), node("sub1", "modifier/subdivide")],
      connections: [wire("box1", "geometry", "sub1", "geometry")],
    };

    const result = resolveGizmoTarget(graph, "sub1");

    expect(result).toEqual({ kind: "native", objectNodeId: "box1", deltaSourceNodeId: null });
  });

  it("still prefers an explicit Transform wired into the modifier's own matrix, if one exists", () => {
    const graph: Graph = {
      nodes: [node("box1", "object/box"), node("sub1", "modifier/subdivide"), node("t1", "transform")],
      connections: [
        wire("box1", "geometry", "sub1", "geometry"),
        wire("t1", "matrix", "sub1", "matrix"),
      ],
    };

    const result = resolveGizmoTarget(graph, "sub1");

    expect(result).toEqual({ kind: "absolute", transformNodeId: "t1" });
  });

  it("chains through more than one pass-through modifier", () => {
    const graph: Graph = {
      nodes: [node("box1", "object/box"), node("sub1", "modifier/subdivide"), node("sub2", "modifier/subdivide")],
      connections: [
        wire("box1", "geometry", "sub1", "geometry"),
        wire("sub1", "geometry", "sub2", "geometry"),
      ],
    };

    const result = resolveGizmoTarget(graph, "sub2");

    expect(result).toEqual({ kind: "native", objectNodeId: "box1", deltaSourceNodeId: null });
  });

  it("gives up (null) rather than looping forever on a cyclic geometry chain", () => {
    const graph: Graph = {
      nodes: [node("sub1", "modifier/subdivide"), node("sub2", "modifier/subdivide")],
      connections: [
        wire("sub1", "geometry", "sub2", "geometry"),
        wire("sub2", "geometry", "sub1", "geometry"),
      ],
    };

    expect(() => resolveGizmoTarget(graph, "sub1")).not.toThrow();
    expect(resolveGizmoTarget(graph, "sub1")).toBeNull();
  });

  it("a node with no geometry input wired and no native pose still resolves to nothing", () => {
    const graph: Graph = {
      nodes: [node("sub1", "modifier/subdivide")],
      connections: [],
    };

    expect(resolveGizmoTarget(graph, "sub1")).toBeNull();
  });
});
