import { describe, expect, it, vi } from "vitest";
import {
  deserializeGraph,
  deserializeProject,
  serializeProject,
  ensureOvmExtension,
  incrementFilename,
  serializeGraph,
} from "./storage";
import { CANVAS_COUNT, emptyGraph, Graph, Project } from "./types";

describe("storage utilities", () => {
  describe("ensureOvmExtension", () => {
    it("appends .tsuji if missing", () => {
      expect(ensureOvmExtension("project")).toBe("project.tsuji");
    });

    it("keeps .tsuji extension if present", () => {
      expect(ensureOvmExtension("project_v1.tsuji")).toBe("project_v1.tsuji");
    });

    it("keeps .json/.ovm extensions for backward compatibility", () => {
      expect(ensureOvmExtension("project_v1.json")).toBe("project_v1.json");
      expect(ensureOvmExtension("project_v1.ovm")).toBe("project_v1.ovm");
    });
  });

  describe("incrementFilename", () => {
    it("increments .tsuji version numbers", () => {
      expect(incrementFilename("project_v1.tsuji")).toBe("project_v2.tsuji");
      expect(incrementFilename("graph_01.tsuji")).toBe("graph_02.tsuji");
      expect(incrementFilename("scene_09.tsuji")).toBe("scene_10.tsuji");
    });

    it("appends _v2.tsuji when no number exists", () => {
      expect(incrementFilename("my_graph.tsuji")).toBe("my_graph_v2.tsuji");
      expect(incrementFilename("my_graph")).toBe("my_graph_v2.tsuji");
    });

    it("handles .json files gracefully", () => {
      expect(incrementFilename("project_v1.json")).toBe("project_v2.json");
    });
  });

  describe("serializeGraph & deserializeGraph", () => {
    it("round-trips a valid graph including keyframes, markers and exposedParams", () => {
      const graph: Graph = {
        nodes: [
          { id: "1", type: "time", position: { x: 0, y: 0 }, params: {} },
          { id: "2", type: "render", position: { x: 100, y: 0 }, params: {} },
        ],
        connections: [
          { id: "1.sec->2.geom", fromNode: "1", fromSocket: "seconds", toNode: "2", toSocket: "geometry" },
        ],
        keyframes: {
          node1: {
            radius: [{ frame: 0, value: 1 }, { frame: 30, value: 5 }],
          },
        },
        markers: [{ frame: 12 }, { frame: 45, label: "Drop" }, { frame: 90 }],
        exposedParams: [{ nodeId: "1", paramId: "seconds", label: "Time (s)" }],
      };

      const json = serializeGraph(graph);
      const restored = deserializeGraph(json);

      expect(restored).toEqual(graph);
    });

    it("defaults exposedParams to [] for a file saved before this feature existed", () => {
      const saved = JSON.stringify({
        nodes: [{ id: "1", type: "time", position: { x: 0, y: 0 }, params: {} }],
        connections: [],
      });

      const restored = deserializeGraph(saved);

      expect(restored.exposedParams).toEqual([]);
    });

    it("drops a wire into a socket the node no longer has", () => {
      // A .ovm saved back when the Camera still carried its unused geometry
      // input. The evaluator ignores such a connection, but the editor would
      // draw it anchored to a handle that isn't there any more.
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const saved = JSON.stringify({
        nodes: [
          { id: "box", type: "object/box", position: { x: 0, y: 0 }, params: {} },
          { id: "cam", type: "calibration/camera", position: { x: 100, y: 0 }, params: {} },
        ],
        connections: [
          { id: "dead", fromNode: "box", fromSocket: "geometry", toNode: "cam", toSocket: "geometry" },
          { id: "live", fromNode: "box", fromSocket: "geometry", toNode: "cam", toSocket: "target" },
        ],
      });

      const restored = deserializeGraph(saved);

      expect(restored.connections.map((c) => c.id)).toEqual(["live"]);
    });

    it("throws on invalid JSON or missing fields", () => {
      expect(() => deserializeGraph("not json")).toThrow();
      expect(() => deserializeGraph("{}")).toThrow("missing 'nodes'");
      expect(() => deserializeGraph('{"nodes": [{}], "connections": []}')).toThrow("missing required fields");
    });
  });

  describe("serializeProject & deserializeProject", () => {
    function projectWith(graphs: Graph[], activeCanvas = 0): Project {
      return { canvases: graphs, activeCanvas };
    }

    const canvasOne: Graph = {
      nodes: [{ id: "a", type: "object/box", position: { x: 0, y: 0 }, params: {} }],
      connections: [],
      keyframes: {},
      markers: [],
    };
    const canvasTwo: Graph = {
      nodes: [{ id: "b", type: "object/sphere", position: { x: 10, y: 20 }, params: {} }],
      connections: [],
      keyframes: {},
      markers: [{ frame: 7 }],
    };

    it("round-trips every canvas and which one was open", () => {
      const restored = deserializeProject(serializeProject(projectWith([canvasOne, canvasTwo], 1)));

      expect(restored.activeCanvas).toBe(1);
      expect(restored.canvases[0].nodes.map((n) => n.id)).toEqual(["a"]);
      expect(restored.canvases[1].nodes.map((n) => n.id)).toEqual(["b"]);
      expect(restored.canvases[1].markers).toEqual([{ frame: 7 }]);
    });

    it("always writes and reads a full set of canvas slots", () => {
      const restored = deserializeProject(serializeProject(projectWith([canvasOne])));

      expect(restored.canvases).toHaveLength(CANVAS_COUNT);
      expect(restored.canvases.slice(1).every((c) => c.nodes.length === 0)).toBe(true);
    });

    it("reads a single-graph .ovm saved before canvases existed as canvas 1", () => {
      // The whole point of the migration: nobody has to convert a file.
      const legacy = serializeGraph(canvasOne);

      const restored = deserializeProject(legacy);

      expect(restored.activeCanvas).toBe(0);
      expect(restored.canvases[0].nodes.map((n) => n.id)).toEqual(["a"]);
      expect(restored.canvases).toHaveLength(CANVAS_COUNT);
    });

    it("clamps an out-of-range active canvas rather than opening nothing", () => {
      const saved = JSON.stringify({ canvases: [canvasOne], activeCanvas: 99 });

      expect(deserializeProject(saved).activeCanvas).toBe(CANVAS_COUNT - 1);
    });

    it("names the offending canvas when one of them is malformed", () => {
      const saved = JSON.stringify({ canvases: [canvasOne, { nodes: [{}], connections: [] }] });

      expect(() => deserializeProject(saved)).toThrow("canvas 2");
    });

    it("an empty document survives the round trip", () => {
      const restored = deserializeProject(serializeProject(projectWith([emptyGraph()])));

      expect(restored.canvases).toHaveLength(CANVAS_COUNT);
      expect(restored.canvases.every((c) => c.nodes.length === 0)).toBe(true);
    });
  });
});

describe("Rotation Mode migration", () => {
  const nodes = [
    { id: "box", type: "object/box", position: { x: 0, y: 0 }, params: { rotation: { x: 0.3, y: 0.4, z: 0 } } },
    { id: "set", type: "object/box", position: { x: 0, y: 0 }, params: { rotationMode: "YXZ" } },
    { id: "tx", type: "transform", position: { x: 0, y: 0 }, params: {} },
    { id: "val", type: "value/constant", position: { x: 0, y: 0 }, params: { value: 1 } },
  ];

  it("gives every rotating node in an older file the composition it was made with", () => {
    const project = deserializeProject(JSON.stringify({ canvases: [{ nodes, connections: [] }], activeCanvas: 0 }));
    const byId = new Map(project.canvases[0].nodes.map((n) => [n.id, n.params]));
    expect(byId.get("box")?.rotationMode).toBe("ZYX");
    expect(byId.get("tx")?.rotationMode).toBe("ZYX");
    expect(byId.get("set")?.rotationMode).toBe("YXZ");
    expect(byId.get("val")).not.toHaveProperty("rotationMode");
  });

  it("leaves a file saved since then alone", () => {
    const saved = serializeProject({ canvases: [{ ...emptyGraph(), nodes: nodes as Graph["nodes"] }], activeCanvas: 0 });
    const project = deserializeProject(saved);
    expect(project.canvases[0].nodes.find((n) => n.id === "box")?.params).not.toHaveProperty("rotationMode");
  });

  it("migrates a single-graph file too", () => {
    const graph = deserializeGraph(JSON.stringify({ nodes, connections: [] }));
    expect(graph.nodes.find((n) => n.id === "box")?.params.rotationMode).toBe("ZYX");
  });
});
