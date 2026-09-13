import { describe, expect, it } from "vitest";
import { evaluateGraph } from "./evaluate";
import { groupPorts, groupSelection, materializeNewPort, ungroupNode } from "./groupSelection";
import {
  GROUP_INPUT_TYPE,
  GROUP_OUTPUT_TYPE,
  GROUP_TYPE,
  NEW_PORT_SOCKET,
  portsOf,
  resolveDefinition,
} from "./groups";
import { DEFAULT_REGISTRY } from "./nodes";
import { Connection, EvalContext, Graph, NodeInstance, emptyGraph } from "./types";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "" };

function node(id: string, type: string, params: Record<string, unknown> = {}, x = 0, y = 0): NodeInstance {
  return { id, type, params, position: { x, y } };
}

function edge(fromNode: string, fromSocket: string, toNode: string, toSocket: string): Connection {
  return { id: `${fromNode}.${fromSocket}->${toNode}.${toSocket}`, fromNode, fromSocket, toNode, toSocket };
}

/** Deterministic ids, so a test can name the group and its boundary nodes. */
function ids(): () => string {
  const names = ["group", "gi", "go"];
  let i = 0;
  return () => names[i++] ?? `extra-${i}`;
}

/** src → mul → sink, with `mul` the node about to be grouped. */
function chain(): Graph {
  return {
    ...emptyGraph(),
    nodes: [
      node("src", "value/constant", { value: 4 }, 0, 0),
      node("mul", "value/math", { op: "multiply", b: 3 }, 200, 0),
      node("sink", "value/math", { op: "add", b: 1 }, 400, 0),
    ],
    connections: [edge("src", "out", "mul", "a"), edge("mul", "out", "sink", "a")],
  };
}

describe("groupSelection", () => {
  it("replaces the selection with one group node holding it", () => {
    const { graph, groupId } = groupSelection(chain(), ["mul"], DEFAULT_REGISTRY, ids())!;

    expect(groupId).toBe("group");
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(["group", "sink", "src"]);
    const group = graph.nodes.find((n) => n.id === "group")!;
    expect(group.subgraph!.nodes.map((n) => n.type)).toEqual([GROUP_INPUT_TYPE, "value/math", GROUP_OUTPUT_TYPE]);
  });

  it("turns each crossing wire into a port, named after the socket it serves", () => {
    const { graph } = groupSelection(chain(), ["mul"], DEFAULT_REGISTRY, ids())!;
    const group = graph.nodes.find((n) => n.id === "group")!;

    expect(groupPorts(group)).toEqual({
      inputs: [{ id: "a", label: "a", type: "value" }],
      outputs: [{ id: "out", label: "out", type: "value" }],
    });
    expect(graph.connections).toEqual([
      expect.objectContaining({ fromNode: "src", fromSocket: "out", toNode: "group", toSocket: "a" }),
      expect.objectContaining({ fromNode: "group", fromSocket: "out", toNode: "sink", toSocket: "a" }),
    ]);
  });

  it("evaluates to what the ungrouped graph did", () => {
    const before = evaluateGraph(chain(), DEFAULT_REGISTRY, CTX).get("sink")?.out;
    const { graph } = groupSelection(chain(), ["mul"], DEFAULT_REGISTRY, ids())!;

    expect(evaluateGraph(graph, DEFAULT_REGISTRY, CTX).get("sink")?.out).toBe(before);
    expect(before).toBe(13);
  });

  it("gives two wires from the same source a single shared port", () => {
    const graph: Graph = {
      ...emptyGraph(),
      nodes: [
        node("src", "value/constant", { value: 2 }),
        node("m1", "value/math", { op: "add" }, 200, 0),
        node("m2", "value/math", { op: "add" }, 200, 120),
      ],
      connections: [edge("src", "out", "m1", "a"), edge("src", "out", "m2", "a")],
    };

    const result = groupSelection(graph, ["m1", "m2"], DEFAULT_REGISTRY, ids())!;
    const group = result.graph.nodes.find((n) => n.id === "group")!;

    expect(groupPorts(group).inputs).toHaveLength(1);
    expect(result.graph.connections).toHaveLength(1);
    expect(group.subgraph!.connections.filter((c) => c.fromNode === "gi")).toHaveLength(2);
  });

  it("leaves the keyframes where they are — a grouped node keeps its id, so its keys still find it", () => {
    const graph: Graph = {
      ...chain(),
      keyframes: {
        mul: { b: [{ frame: 0, value: 1 }] },
        sink: { b: [{ frame: 0, value: 9 }] },
      },
    };

    const { graph: grouped } = groupSelection(graph, ["mul"], DEFAULT_REGISTRY, ids())!;
    expect(grouped.keyframes).toEqual(graph.keyframes);
    expect(grouped.nodes.find((n) => n.id === "group")!.subgraph!.keyframes).toEqual({});
  });

  it("animates an interior node from the document's own keyframe store", () => {
    const graph: Graph = { ...chain(), keyframes: { mul: { b: [{ frame: 0, value: 10 }] } } };
    const { graph: grouped } = groupSelection(graph, ["mul"], DEFAULT_REGISTRY, ids())!;

    const results = evaluateGraph(grouped, DEFAULT_REGISTRY, {
      ...CTX,
      currentFrame: 0,
      keyframes: grouped.keyframes,
    });
    // src (4) × b keyframed to 10 — the key reaches the node through the group.
    expect(results.get("group")?.out).toBe(40);
  });

  it("leaves wires that never crossed the boundary untouched", () => {
    const graph = chain();
    const { graph: grouped } = groupSelection(graph, ["src", "mul"], DEFAULT_REGISTRY, ids())!;
    const group = grouped.nodes.find((n) => n.id === "group")!;

    expect(group.subgraph!.connections).toContainEqual(expect.objectContaining({ fromNode: "src", toNode: "mul" }));
    expect(groupPorts(group).inputs).toEqual([]);
  });

  it("refuses a selection made only of boundary nodes", () => {
    const graph: Graph = { ...emptyGraph(), nodes: [node("gi", GROUP_INPUT_TYPE, { ports: [] })] };
    expect(groupSelection(graph, ["gi"], DEFAULT_REGISTRY, ids())).toBeNull();
    expect(groupSelection(chain(), [], DEFAULT_REGISTRY, ids())).toBeNull();
  });
});

describe("materializeNewPort", () => {
  /** The chain with `mul` grouped — a group with one input and one output port. */
  function grouped(): Graph {
    return groupSelection(chain(), ["mul"], DEFAULT_REGISTRY, ids())!.graph;
  }

  const fresh = () => {
    let i = 0;
    return () => `new-${i++}`;
  };

  it("leaves an ordinary connection alone", () => {
    const graph = grouped();
    expect(
      materializeNewPort(
        graph,
        { fromNode: "src", fromSocket: "out", toNode: "group", toSocket: "a" },
        DEFAULT_REGISTRY,
        fresh(),
      ),
    ).toBeNull();
  });

  it("into a group's empty input: a new input port, typed by the source", () => {
    const graph = grouped();
    const result = materializeNewPort(
      graph,
      { fromNode: "src", fromSocket: "out", toNode: "group", toSocket: NEW_PORT_SOCKET },
      DEFAULT_REGISTRY,
      fresh(),
    )!;

    const group = result.graph.nodes.find((n) => n.id === "group")!;
    expect(groupPorts(group).inputs).toEqual([
      { id: "a", label: "a", type: "value" },
      { id: "out", label: "out", type: "value" },
    ]);
    // The port shows up as an output of Group Input inside — which is the
    // whole point of declaring it there.
    const groupInput = group.subgraph!.nodes.find((n) => n.type === GROUP_INPUT_TYPE)!;
    expect(resolveDefinition(groupInput, DEFAULT_REGISTRY)!.outputs.map((s) => s.id)).toEqual([
      "a",
      "out",
      NEW_PORT_SOCKET,
    ]);
    expect(result.connection).toMatchObject({ fromNode: "src", toNode: "group", toSocket: "out" });
  });

  it("out of a group's empty output: a new output port, typed by the target", () => {
    const graph = grouped();
    const result = materializeNewPort(
      graph,
      { fromNode: "group", fromSocket: NEW_PORT_SOCKET, toNode: "sink", toSocket: "b" },
      DEFAULT_REGISTRY,
      fresh(),
    )!;

    const group = result.graph.nodes.find((n) => n.id === "group")!;
    expect(groupPorts(group).outputs).toEqual([
      { id: "out", label: "out", type: "value" },
      { id: "b", label: "b", type: "value" },
    ]);
    expect(result.connection).toMatchObject({ fromNode: "group", fromSocket: "b", toNode: "sink" });
  });

  it("into Group Output's empty input, from inside the group", () => {
    const subgraph = grouped().nodes.find((n) => n.id === "group")!.subgraph!;
    const result = materializeNewPort(
      subgraph,
      { fromNode: "mul", fromSocket: "out", toNode: "go", toSocket: NEW_PORT_SOCKET },
      DEFAULT_REGISTRY,
      fresh(),
    )!;

    const output = result.graph.nodes.find((n) => n.id === "go")!;
    expect(portsOf(output).map((p) => p.id)).toEqual(["out", "out_2"]);
    expect(result.connection.toSocket).toBe("out_2");
  });

  it("out of Group Input's empty output, typed by whatever it lands on", () => {
    const subgraph = grouped().nodes.find((n) => n.id === "group")!.subgraph!;
    const result = materializeNewPort(
      subgraph,
      { fromNode: "gi", fromSocket: NEW_PORT_SOCKET, toNode: "mul", toSocket: "b" },
      DEFAULT_REGISTRY,
      fresh(),
    )!;

    expect(portsOf(result.graph.nodes.find((n) => n.id === "gi")!)).toEqual([
      { id: "a", label: "a", type: "value" },
      { id: "b", label: "b", type: "value" },
    ]);
    expect(result.connection).toMatchObject({ fromNode: "gi", fromSocket: "b", toNode: "mul", toSocket: "b" });
  });

  it("adds the missing boundary node when the group hasn't got one", () => {
    const graph: Graph = {
      ...emptyGraph(),
      nodes: [
        node("src", "value/constant", { value: 1 }),
        { ...node("g", GROUP_TYPE), subgraph: { ...emptyGraph(), nodes: [node("box", "object/box")] } },
      ],
    };

    const result = materializeNewPort(
      graph,
      { fromNode: "src", fromSocket: "out", toNode: "g", toSocket: NEW_PORT_SOCKET },
      DEFAULT_REGISTRY,
      fresh(),
    )!;

    const subgraph = result.graph.nodes.find((n) => n.id === "g")!.subgraph!;
    const created = subgraph.nodes.find((n) => n.type === GROUP_INPUT_TYPE)!;
    expect(created.id).toBe("new-0");
    expect(portsOf(created)).toEqual([{ id: "out", label: "out", type: "value" }]);
  });

  it("carries the concrete type across, not the empty socket's `any`", () => {
    const graph: Graph = {
      ...emptyGraph(),
      nodes: [node("box", "object/box"), { ...node("g", GROUP_TYPE), subgraph: emptyGraph() }],
    };

    const result = materializeNewPort(
      graph,
      { fromNode: "box", fromSocket: "geometry", toNode: "g", toSocket: NEW_PORT_SOCKET },
      DEFAULT_REGISTRY,
      fresh(),
    )!;

    const group = result.graph.nodes.find((n) => n.id === "g")!;
    expect(groupPorts(group).inputs).toEqual([{ id: "geometry", label: "geometry", type: "geometry" }]);
  });

  it("refuses to name a port from one empty socket to another", () => {
    const graph = grouped();
    expect(
      materializeNewPort(
        graph,
        { fromNode: "group", fromSocket: NEW_PORT_SOCKET, toNode: "group", toSocket: NEW_PORT_SOCKET },
        DEFAULT_REGISTRY,
        fresh(),
      ),
    ).toBeNull();
  });
});

describe("ungroupNode", () => {
  it("is the inverse of grouping, wires and evaluation included", () => {
    const original = chain();
    const { graph: grouped } = groupSelection(original, ["mul"], DEFAULT_REGISTRY, ids())!;
    const restored = ungroupNode(grouped, "group")!;

    expect(restored.nodes.map((n) => n.id).sort()).toEqual(["mul", "sink", "src"]);
    expect(restored.connections.map((c) => `${c.fromNode}.${c.fromSocket}->${c.toNode}.${c.toSocket}`).sort()).toEqual([
      "mul.out->sink.a",
      "src.out->mul.a",
    ]);
    expect(evaluateGraph(restored, DEFAULT_REGISTRY, CTX).get("sink")?.out).toBe(13);
  });

  it("keeps the interior's keyframes attached to their nodes", () => {
    const graph: Graph = { ...chain(), keyframes: { mul: { b: [{ frame: 0, value: 1 }] } } };
    const { graph: grouped } = groupSelection(graph, ["mul"], DEFAULT_REGISTRY, ids())!;

    expect(ungroupNode(grouped, "group")!.keyframes).toEqual({ mul: { b: [{ frame: 0, value: 1 }] } });
  });

  it("fans one port back out to every node it fed", () => {
    const graph: Graph = {
      ...emptyGraph(),
      nodes: [
        node("src", "value/constant", { value: 2 }),
        node("m1", "value/math", { op: "add" }),
        node("m2", "value/math", { op: "add" }),
      ],
      connections: [edge("src", "out", "m1", "a"), edge("src", "out", "m2", "a")],
    };
    const { graph: grouped } = groupSelection(graph, ["m1", "m2"], DEFAULT_REGISTRY, ids())!;
    const restored = ungroupNode(grouped, "group")!;

    expect(restored.connections).toHaveLength(2);
    expect(restored.connections.every((c) => c.fromNode === "src")).toBe(true);
  });

  it("drops a wire out of the implicit scene output, which has no single source", () => {
    const graph: Graph = {
      ...emptyGraph(),
      nodes: [node("box", "object/box"), node("merge", "merge")],
      connections: [],
    };
    const { graph: grouped } = groupSelection(graph, ["box"], DEFAULT_REGISTRY, ids())!;
    const withSceneWire: Graph = {
      ...grouped,
      connections: [...grouped.connections, edge("group", "geometry", "merge", "in1")],
    };

    const restored = ungroupNode(withSceneWire, "group")!;
    expect(restored.connections).toEqual([]);
    expect(restored.nodes.map((n) => n.id).sort()).toEqual(["box", "merge"]);
  });

  it("returns null for a node that is not a group", () => {
    expect(ungroupNode(chain(), "mul")).toBeNull();
    expect(ungroupNode(chain(), "nope")).toBeNull();
  });

  it("re-centres the interior on where the group node sat", () => {
    const { graph: grouped } = groupSelection(chain(), ["mul"], DEFAULT_REGISTRY, ids())!;
    const group = grouped.nodes.find((n) => n.id === "group")!;
    const restored = ungroupNode(grouped, "group")!;

    expect(restored.nodes.find((n) => n.id === "mul")!.position).toEqual(group.position);
  });

  it("leaves the boundary nodes behind rather than pasting them into the parent", () => {
    const { graph: grouped } = groupSelection(chain(), ["mul"], DEFAULT_REGISTRY, ids())!;
    const restored = ungroupNode(grouped, "group")!;

    expect(restored.nodes.some((n) => n.type === GROUP_INPUT_TYPE || n.type === GROUP_OUTPUT_TYPE)).toBe(false);
    expect(restored.nodes.some((n) => n.type === GROUP_TYPE)).toBe(false);
  });
});
