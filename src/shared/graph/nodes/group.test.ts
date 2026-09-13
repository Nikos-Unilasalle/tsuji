import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { evaluateGraph } from "../evaluate";
import { GROUP_INPUT_TYPE, GROUP_OUTPUT_TYPE, GROUP_TYPE } from "../groups";
import { DEFAULT_REGISTRY } from "./index";
import { deserializeGraph, serializeGraph } from "../storage";
import { Connection, EvalContext, Graph, NodeInstance, emptyGraph } from "../types";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "" };

function node(id: string, type: string, params: Record<string, unknown> = {}): NodeInstance {
  return { id, type, params, position: { x: 0, y: 0 } };
}

function edge(fromNode: string, fromSocket: string, toNode: string, toSocket: string): Connection {
  return { id: `${fromNode}.${fromSocket}->${toNode}.${toSocket}`, fromNode, fromSocket, toNode, toSocket };
}

/**
 * A group that doubles its input: Group Input → Value Math (multiply by 2) →
 * Group Output. Built from real registered nodes, so what it proves is that a
 * subgraph runs through the ordinary evaluator rather than a parallel path.
 */
function doublingGroup(id: string): NodeInstance {
  const subgraph: Graph = {
    ...emptyGraph(),
    nodes: [
      node("gi", GROUP_INPUT_TYPE, { ports: [{ id: "amount", label: "Amount", type: "value" }] }),
      node("mul", "value/math", { op: "multiply", b: 2 }),
      node("go", GROUP_OUTPUT_TYPE, { ports: [{ id: "result", label: "Result", type: "value" }] }),
    ],
    connections: [edge("gi", "amount", "mul", "a"), edge("mul", "out", "go", "result")],
  };
  return { ...node(id, GROUP_TYPE), subgraph };
}

describe("structure/group", () => {
  it("evaluates its subgraph and hands the boundary's outputs to the parent", () => {
    const graph: Graph = {
      ...emptyGraph(),
      nodes: [node("src", "value/constant", { value: 21 }), doublingGroup("g"), node("sink", "value/math", { op: "add", b: 0 })],
      connections: [edge("src", "out", "g", "amount"), edge("g", "result", "sink", "a")],
    };

    const results = evaluateGraph(graph, DEFAULT_REGISTRY, CTX);
    expect(results.get("g")?.result).toBe(42);
    expect(results.get("sink")?.out).toBe(42);
  });

  it("matches the equivalent flat graph", () => {
    const grouped: Graph = {
      ...emptyGraph(),
      nodes: [node("src", "value/constant", { value: 5 }), doublingGroup("g")],
      connections: [edge("src", "out", "g", "amount")],
    };
    const flat: Graph = {
      ...emptyGraph(),
      nodes: [node("src", "value/constant", { value: 5 }), node("mul", "value/math", { op: "multiply", b: 2 })],
      connections: [edge("src", "out", "mul", "a")],
    };

    expect(evaluateGraph(grouped, DEFAULT_REGISTRY, CTX).get("g")?.result).toBe(
      evaluateGraph(flat, DEFAULT_REGISTRY, CTX).get("mul")?.out,
    );
  });

  it("puts interior geometry nobody claimed into a container the viewport can draw", () => {
    const subgraph: Graph = { ...emptyGraph(), nodes: [node("box", "object/box")] };
    const graph: Graph = { ...emptyGraph(), nodes: [{ ...node("g", GROUP_TYPE), subgraph }] };

    const results = evaluateGraph(graph, DEFAULT_REGISTRY, CTX);
    const container = results.get("g")?.geometry as THREE.Group;
    const box = results.get("g") && (evaluateGraph(subgraph, DEFAULT_REGISTRY, CTX).get("box")?.geometry as THREE.Object3D);

    expect(container).toBeInstanceOf(THREE.Group);
    expect(container.children).toContain(box);
  });

  it("reuses the same container across frames, without piling up children", () => {
    const subgraph: Graph = { ...emptyGraph(), nodes: [node("box", "object/box")] };
    const graph: Graph = { ...emptyGraph(), nodes: [{ ...node("g2", GROUP_TYPE), subgraph }] };

    const first = evaluateGraph(graph, DEFAULT_REGISTRY, CTX).get("g2")?.geometry as THREE.Group;
    const second = evaluateGraph(graph, DEFAULT_REGISTRY, CTX).get("g2")?.geometry as THREE.Group;

    expect(second).toBe(first);
    expect(second.children).toHaveLength(1);
  });

  it("nests: a group inside a group still resolves", () => {
    const inner = doublingGroup("inner");
    const middle: Graph = {
      ...emptyGraph(),
      nodes: [
        node("gi", GROUP_INPUT_TYPE, { ports: [{ id: "amount", label: "Amount", type: "value" }] }),
        inner,
        node("go", GROUP_OUTPUT_TYPE, { ports: [{ id: "result", label: "Result", type: "value" }] }),
      ],
      connections: [edge("gi", "amount", "inner", "amount"), edge("inner", "result", "go", "result")],
    };
    const graph: Graph = {
      ...emptyGraph(),
      nodes: [node("src", "value/constant", { value: 3 }), { ...node("outer", GROUP_TYPE), subgraph: middle }],
      connections: [edge("src", "out", "outer", "amount")],
    };

    expect(evaluateGraph(graph, DEFAULT_REGISTRY, CTX).get("outer")?.result).toBe(6);
  });

  it("an empty group evaluates to an empty container rather than failing", () => {
    const graph: Graph = { ...emptyGraph(), nodes: [{ ...node("g3", GROUP_TYPE), subgraph: emptyGraph() }] };
    const results = evaluateGraph(graph, DEFAULT_REGISTRY, CTX);

    expect((results.get("g3")?.geometry as THREE.Group).children).toHaveLength(0);
  });

  it("survives a save/load round trip, interior included", () => {
    const graph: Graph = {
      ...emptyGraph(),
      nodes: [node("src", "value/constant", { value: 7 }), doublingGroup("g")],
      connections: [edge("src", "out", "g", "amount")],
    };

    const reloaded = deserializeGraph(serializeGraph(graph));
    expect(reloaded.nodes.find((n) => n.id === "g")?.subgraph?.nodes).toHaveLength(3);
    expect(evaluateGraph(reloaded, DEFAULT_REGISTRY, CTX).get("g")?.result).toBe(14);
  });

  it("keeps a wire inside a group only while its port exists", () => {
    const group = doublingGroup("g");
    const subgraph = group.subgraph!;
    const withRetiredPort: Graph = {
      ...emptyGraph(),
      nodes: [
        {
          ...group,
          subgraph: {
            ...subgraph,
            nodes: subgraph.nodes.map((n) => (n.id === "gi" ? { ...n, params: { ports: [] } } : n)),
          },
        },
      ],
    };

    const reloaded = deserializeGraph(serializeGraph(withRetiredPort));
    const innerConnections = reloaded.nodes[0].subgraph!.connections;
    expect(innerConnections.map((c) => c.fromNode)).not.toContain("gi");
    expect(innerConnections).toHaveLength(1);
  });
});
