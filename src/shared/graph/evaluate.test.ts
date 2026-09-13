import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { disposeEvalSession, evaluateGraph, topoSort } from "./evaluate";
import { Connection, EvalContext, Graph, NodeDefinition, NodeInstance, createRegistry } from "./types";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "" };

function node(id: string, type: string, params: Record<string, unknown> = {}): NodeInstance {
  return { id, type, params, position: { x: 0, y: 0 } };
}

function edge(fromNode: string, fromSocket: string, toNode: string, toSocket: string): Connection {
  return { id: `${fromNode}.${fromSocket}->${toNode}.${toSocket}`, fromNode, fromSocket, toNode, toSocket };
}

/** A constant Value node — the simplest possible source, output = its own param. */
const CONST: NodeDefinition = {
  type: "test/const",
  label: "Const",
  category: "math",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: "value" }],
  defaultParams: { value: 0 },
  evaluate: (_inputs, params) => ({ out: Number(params.value) || 0 }),
};

/** Value + Value -> Value, missing input treated as 0 — proves the evaluator threads data through. */
const ADD: NodeDefinition = {
  type: "test/add",
  label: "Add",
  category: "math",
  inputs: [
    { id: "a", label: "A", type: "value" },
    { id: "b", label: "B", type: "value" },
  ],
  outputs: [{ id: "out", label: "Out", type: "value" }],
  defaultParams: {},
  evaluate: (inputs) => ({ out: (Number(inputs.a) || 0) + (Number(inputs.b) || 0) }),
};

/** Reads its input directly (not via the `params` argument) — proves the fallback for an unconnected socket comes from defaultParams, not a stale copy of it. */
const DEFAULTED: NodeDefinition = {
  type: "test/defaulted",
  label: "Defaulted",
  category: "math",
  inputs: [{ id: "a", label: "A", type: "value" }],
  outputs: [{ id: "out", label: "Out", type: "value" }],
  defaultParams: { a: 9 },
  evaluate: (inputs) => ({ out: Number(inputs.a) }),
};

const THROWS: NodeDefinition = {
  type: "test/throws",
  label: "Throws",
  category: "math",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: "value" }],
  defaultParams: {},
  evaluate: () => {
    throw new Error("boom");
  },
};

const REGISTRY = createRegistry([CONST, ADD, DEFAULTED, THROWS]);

describe("topoSort", () => {
  test("orders a simple chain source-first", () => {
    const graph: Graph = {
      nodes: [node("a", "test/const"), node("b", "test/const"), node("c", "test/add")],
      connections: [edge("a", "out", "c", "a"), edge("b", "out", "c", "b")],
    };

    const { order, cyclic } = topoSort(graph);

    expect(cyclic).toEqual([]);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
  });

  test("reports a cycle instead of hanging", () => {
    const graph: Graph = {
      nodes: [node("a", "test/add"), node("b", "test/add")],
      connections: [edge("a", "out", "b", "a"), edge("b", "out", "a", "a")],
    };

    const { order, cyclic } = topoSort(graph);

    expect(order).toEqual([]);
    expect(cyclic.sort()).toEqual(["a", "b"]);
  });

  test("ignores a connection left dangling by a deleted node", () => {
    const graph: Graph = {
      nodes: [node("a", "test/const")],
      connections: [edge("ghost", "out", "a", "a")],
    };

    const { order, cyclic } = topoSort(graph);

    expect(order).toEqual(["a"]);
    expect(cyclic).toEqual([]);
  });
});

describe("evaluateGraph", () => {
  test("threads a value from a source node to a consumer through a connection", () => {
    const graph: Graph = {
      nodes: [node("a", "test/const", { value: 3 }), node("b", "test/const", { value: 4 }), node("c", "test/add")],
      connections: [edge("a", "out", "c", "a"), edge("b", "out", "c", "b")],
    };

    const result = evaluateGraph(graph, REGISTRY, CTX);

    expect(result.get("c")?.out).toBe(7);
  });

  test("an unconnected input falls back to the node instance's own param", () => {
    const graph: Graph = {
      nodes: [node("a", "test/const", { value: 10 }), node("c", "test/add", { b: 5 })],
      connections: [edge("a", "out", "c", "a")],
    };

    const result = evaluateGraph(graph, REGISTRY, CTX);

    expect(result.get("c")?.out).toBe(15);
  });

  test("an unconnected input with no instance override falls back to defaultParams, not undefined", () => {
    const graph: Graph = { nodes: [node("a", "test/defaulted")], connections: [] };

    const result = evaluateGraph(graph, REGISTRY, CTX);

    expect(result.get("a")?.out).toBe(9);
  });

  test("an unknown node type is skipped, not fatal to the rest of the graph", () => {
    const graph: Graph = {
      nodes: [node("a", "test/const", { value: 1 }), node("ghost", "not/registered")],
      connections: [],
    };

    const result = evaluateGraph(graph, REGISTRY, CTX);

    expect(result.get("a")?.out).toBe(1);
    expect(result.has("ghost")).toBe(false);
  });

  test("a node that throws does not take the rest of the graph down with it", () => {
    const graph: Graph = {
      nodes: [node("a", "test/const", { value: 1 }), node("bad", "test/throws")],
      connections: [],
    };

    const result = evaluateGraph(graph, REGISTRY, CTX);

    expect(result.get("a")?.out).toBe(1);
    expect(result.get("bad")).toEqual({});
  });

  test("a connected socket whose source now rejects keeps the previous frame's value instead of its static param", () => {
    // CONST feeds ADD's `a` socket with 3. First pass: ADD sees 3 -> out 4.
    const healthy: Graph = {
      nodes: [node("src", "test/const", { value: 3 }), node("c", "test/add", { a: 99, b: 1 })],
      connections: [edge("src", "out", "c", "a")],
    };
    expect(evaluateGraph(healthy, REGISTRY, CTX).get("c")?.out).toBe(4);

    // Same topology, but `src` (same id) now throws. The connected socket must
    // keep the last value it actually produced (3), not fall back to param 99.
    const broken: Graph = {
      nodes: [node("src", "test/throws"), node("c", "test/add", { a: 99, b: 1 })],
      connections: [edge("src", "out", "c", "a")],
    };
    const result = evaluateGraph(broken, REGISTRY, CTX);
    expect(result.get("c")?.out).toBe(4);
  });

  test("cyclic nodes are still evaluated, not silently dropped", () => {
    const graph: Graph = {
      nodes: [node("a", "test/add"), node("b", "test/add")],
      connections: [edge("a", "out", "b", "a"), edge("b", "out", "a", "a")],
    };

    const result = evaluateGraph(graph, REGISTRY, CTX);

    expect(result.has("a")).toBe(true);
    expect(result.has("b")).toBe(true);
  });

  test("evaluates all demo .ovm files cleanly with DEFAULT_REGISTRY", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const { DEFAULT_REGISTRY } = await import("./nodes");
    const { rehydrateGraphParams } = await import("./rehydrateParams");

    const demosDir = path.join(__dirname, "../../../public/demos");
    const files = fs.readdirSync(demosDir).filter((f) => f.endsWith(".tsuji") || f.endsWith(".ovm"));

    const { deserializeProject } = await import("./storage");

    for (const file of files) {
      // Same reason as demos.test.ts: a demo saved from the app carries the
      // multi-canvas project shape, which a raw JSON.parse-as-Graph misreads.
      const project = deserializeProject(fs.readFileSync(path.join(demosDir, file), "utf-8"), DEFAULT_REGISTRY);
      const demoGraph = project.canvases.find((c) => c.nodes.length > 0) ?? project.canvases[0];
      const rehydrated = rehydrateGraphParams(demoGraph, DEFAULT_REGISTRY);
      const result = evaluateGraph(rehydrated, DEFAULT_REGISTRY, CTX);
      expect(result.size).toBeGreaterThan(0);
    }
    // Explicit timeout: this evaluates *every* demo, so it gets slower with
    // each one added — it crossed vitest's 5s default at ~60 demos and
    // started failing at random depending on machine load, which reads as a
    // real regression rather than the test simply outgrowing its budget.
  }, 30_000);
});

describe("the visible socket", () => {
  const HIDEABLE: NodeDefinition = {
    type: "test/hideable",
    label: "Hideable",
    category: "structure",
    inputs: [{ id: "visible", label: "Visible", type: "value" }],
    outputs: [{ id: "geometry", label: "Geometry", type: "geometry" }],
    defaultParams: { visible: 1 },
    evaluate: () => ({ geometry: new THREE.Object3D() }),
  };

  const OPAQUE: NodeDefinition = {
    type: "test/no-visible-socket",
    label: "No Visible Socket",
    category: "structure",
    inputs: [],
    outputs: [{ id: "geometry", label: "Geometry", type: "geometry" }],
    defaultParams: {},
    evaluate: () => {
      const object = new THREE.Object3D();
      object.visible = false;
      return { geometry: object };
    },
  };

  function evaluateOne(def: NodeDefinition, params: Record<string, unknown>): THREE.Object3D {
    const graph: Graph = {
      nodes: [{ id: "n1", type: def.type, params, position: { x: 0, y: 0 } }],
      connections: [],
    };
    const results = evaluateGraph(graph, createRegistry([def]), CTX);
    return results.get("n1")?.geometry as THREE.Object3D;
  }

  test("a node only has to declare the socket — the evaluator applies it", () => {
    expect(evaluateOne(HIDEABLE, { visible: 0 }).visible).toBe(false);
    expect(evaluateOne(HIDEABLE, { visible: 1 }).visible).toBe(true);
  });

  test("booleans work as well as the 0/1 the param panel stores", () => {
    expect(evaluateOne(HIDEABLE, { visible: false }).visible).toBe(false);
    expect(evaluateOne(HIDEABLE, { visible: true }).visible).toBe(true);
  });

  test("a node without the socket keeps whatever visibility it set itself", () => {
    expect(evaluateOne(OPAQUE, {}).visible).toBe(false);
  });

  test("a wire drives it, so a Logic node can switch an object off", () => {
    const SWITCH: NodeDefinition = {
      type: "test/switch",
      label: "Switch",
      category: "logic",
      inputs: [],
      outputs: [{ id: "out", label: "Out", type: "value" }],
      defaultParams: {},
      evaluate: () => ({ out: 0 }),
    };
    const graph: Graph = {
      nodes: [
        { id: "sw", type: "test/switch", params: {}, position: { x: 0, y: 0 } },
        { id: "obj", type: "test/hideable", params: { visible: 1 }, position: { x: 0, y: 0 } },
      ],
      connections: [{ id: "c", fromNode: "sw", fromSocket: "out", toNode: "obj", toSocket: "visible" }],
    };

    const results = evaluateGraph(graph, createRegistry([SWITCH, HIDEABLE]), CTX);

    expect((results.get("obj")?.geometry as THREE.Object3D).visible).toBe(false);
  });
});

describe("evaluator sessions", () => {
  /**
   * A source that produces a value on some frames and nothing on others — the
   * evaluator is supposed to fall back to the *same session's* previous frame
   * when a wired source goes quiet, which is what makes this observable.
   */
  const FLAKY: NodeDefinition = {
    type: "test/flaky",
    label: "Flaky",
    category: "math",
    inputs: [],
    outputs: [{ id: "out", label: "Out", type: "value" }],
    defaultParams: { value: 0, emit: 1 },
    evaluate: (_inputs, params) => (params.emit ? { out: Number(params.value) } : {}),
  };

  const PASSTHROUGH: NodeDefinition = {
    type: "test/passthrough",
    label: "Passthrough",
    category: "math",
    inputs: [{ id: "in", label: "In", type: "value" }],
    outputs: [{ id: "out", label: "Out", type: "value" }],
    defaultParams: {},
    evaluate: (inputs) => ({ out: inputs.in }),
  };

  const registry = createRegistry([FLAKY, PASSTHROUGH]);

  function graphEmitting(value: number, emit: number): Graph {
    return {
      nodes: [node("src", "test/flaky", { value, emit }), node("sink", "test/passthrough")],
      connections: [edge("src", "out", "sink", "in")],
    };
  }

  test("one session's frame can't stand in as another's previous frame", () => {
    // Session A sees 10 on its first frame...
    evaluateGraph(graphEmitting(10, 1), registry, { ...CTX, sessionId: "a" });
    // ...and session B sees 99 on its own.
    evaluateGraph(graphEmitting(99, 1), registry, { ...CTX, sessionId: "b" });

    // Now A's source goes quiet. It must fall back to 10 — A's own last value —
    // not to 99, which is simply another viewport's frame.
    const res = evaluateGraph(graphEmitting(10, 0), registry, { ...CTX, sessionId: "a" });
    expect(res.get("sink")?.out).toBe(10);
  });

  test("a session still carries its own frame forward", () => {
    evaluateGraph(graphEmitting(7, 1), registry, { ...CTX, sessionId: "solo" });
    const res = evaluateGraph(graphEmitting(7, 0), registry, { ...CTX, sessionId: "solo" });
    expect(res.get("sink")?.out).toBe(7);
  });

  /**
   * A group evaluates its subgraph through a nested evaluateGraph call on the
   * same session — the scope is what keeps that inner pass from becoming the
   * outer graph's "previous frame".
   */
  test("a nested scope does not overwrite its parent's carried-over frame", () => {
    evaluateGraph(graphEmitting(10, 1), registry, { ...CTX, sessionId: "nested" });
    evaluateGraph(graphEmitting(99, 1), registry, { ...CTX, sessionId: "nested", evalScope: "group-1" });

    const outer = evaluateGraph(graphEmitting(10, 0), registry, { ...CTX, sessionId: "nested" });
    expect(outer.get("sink")?.out).toBe(10);

    const inner = evaluateGraph(graphEmitting(99, 0), registry, {
      ...CTX,
      sessionId: "nested",
      evalScope: "group-1",
    });
    expect(inner.get("sink")?.out).toBe(99);
  });

  test("disposing a session drops its nested scopes too", () => {
    evaluateGraph(graphEmitting(42, 1), registry, { ...CTX, sessionId: "doomed", evalScope: "group-1" });
    disposeEvalSession("doomed");

    const res = evaluateGraph(graphEmitting(42, 0), registry, {
      ...CTX,
      sessionId: "doomed",
      evalScope: "group-1",
    });
    expect(res.get("sink")?.out).toBeUndefined();
  });
});

describe("structural cache", () => {
  /**
   * The cache used to be a single "last graph" slot, which a group's nested
   * pass would evict on every frame. Alternating between two graphs is the
   * cheap stand-in for that: both must keep answering correctly, and neither
   * may pick up the other's topology.
   */
  const registry = createRegistry([CONST, ADD]);

  const graphA: Graph = {
    nodes: [node("a", "test/const", { value: 1 }), node("sum", "test/add")],
    connections: [edge("a", "out", "sum", "a")],
  };
  const graphB: Graph = {
    nodes: [node("a", "test/const", { value: 100 }), node("sum", "test/add")],
    connections: [edge("a", "out", "sum", "b")],
  };

  test("two graphs evaluated alternately keep their own topology", () => {
    for (let i = 0; i < 3; i++) {
      expect(evaluateGraph(graphA, registry, CTX).get("sum")?.out).toBe(1);
      expect(evaluateGraph(graphB, registry, CTX).get("sum")?.out).toBe(100);
    }
  });
});
