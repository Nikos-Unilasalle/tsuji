import { describe, expect, it } from "vitest";
import {
  GROUP_INPUT_TYPE,
  GROUP_OUTPUT_TYPE,
  GROUP_SCENE_OUTPUT,
  GROUP_TYPE,
  NEW_PORT_SOCKET_DEF,
  collectAllNodeIds,
  graphAtPath,
  groupInputPorts,
  replaceGraphAtPath,
  resolveDefinition,
  walkGraphs,
} from "./groups";
import { createRegistry, emptyGraph, Graph, NodeDefinition, NodeInstance } from "./types";

const PASSTHROUGH: NodeDefinition = {
  type: "value/passthrough",
  label: "Passthrough",
  category: "math",
  inputs: [{ id: "in", label: "In", type: "value" }],
  outputs: [{ id: "out", label: "Out", type: "value" }],
  defaultParams: { in: 0 },
  evaluate: (inputs) => ({ out: Number(inputs.in) || 0 }),
};

/** Stands in for the real structure/group of P1 — only its identity matters here. */
const GROUP: NodeDefinition = {
  type: GROUP_TYPE,
  label: "Group",
  category: "structure",
  inputs: [],
  outputs: [],
  defaultParams: {},
  evaluate: () => ({}),
};

const REGISTRY = createRegistry([PASSTHROUGH, GROUP]);

function node(id: string, type: string, params: Record<string, unknown> = {}): NodeInstance {
  return { id, type, params, position: { x: 0, y: 0 } };
}

function subgraphWithPorts(): Graph {
  return {
    ...emptyGraph(),
    nodes: [
      node("in", GROUP_INPUT_TYPE, { ports: [{ id: "amount", label: "Amount", type: "value" }] }),
      node("inner", "value/passthrough"),
      node("out", GROUP_OUTPUT_TYPE, { ports: [{ id: "result", label: "Result", type: "value" }] }),
    ],
  };
}

describe("resolveDefinition", () => {
  it("returns the type's own definition for an ordinary node", () => {
    expect(resolveDefinition(node("a", "value/passthrough"), REGISTRY)).toBe(PASSTHROUGH);
  });

  it("returns undefined for an unknown type, as registry.get did", () => {
    expect(resolveDefinition(node("a", "does/not-exist"), REGISTRY)).toBeUndefined();
    expect(resolveDefinition(undefined, REGISTRY)).toBeUndefined();
  });

  it("derives a group's sockets from its boundary nodes", () => {
    const group = { ...node("g", GROUP_TYPE), subgraph: subgraphWithPorts() };
    const def = resolveDefinition(group, REGISTRY)!;

    expect(def.inputs).toEqual([{ id: "amount", label: "Amount", type: "value" }, NEW_PORT_SOCKET_DEF]);
    expect(def.outputs).toEqual([
      { id: "result", label: "Result", type: "value" },
      GROUP_SCENE_OUTPUT,
      NEW_PORT_SOCKET_DEF,
    ]);
  });

  it("appends the implicit scene output only when the author has not declared one", () => {
    const subgraph = {
      ...emptyGraph(),
      nodes: [node("out", GROUP_OUTPUT_TYPE, { ports: [{ id: "geometry", label: "My Scene", type: "geometry" }] })],
    };
    const def = resolveDefinition({ ...node("g", GROUP_TYPE), subgraph }, REGISTRY)!;

    expect(def.outputs).toEqual([{ id: "geometry", label: "My Scene", type: "geometry" }, NEW_PORT_SOCKET_DEF]);
  });

  it("ignores malformed port entries rather than producing a broken socket", () => {
    const subgraph = {
      ...emptyGraph(),
      nodes: [node("in", GROUP_INPUT_TYPE, { ports: [{ label: "no id" }, null, { id: "ok", type: "vector" }] })],
    };
    expect(groupInputPorts(subgraph)).toEqual([{ id: "ok", label: "ok", type: "vector" }]);
  });

  it("gives a group with no boundary nodes nothing but the empty socket to grow from", () => {
    const def = resolveDefinition({ ...node("g", GROUP_TYPE), subgraph: emptyGraph() }, REGISTRY)!;
    expect(def.inputs).toEqual([NEW_PORT_SOCKET_DEF]);
    expect(def.outputs).toEqual([GROUP_SCENE_OUTPUT, NEW_PORT_SOCKET_DEF]);
  });

  it("memoizes per subgraph object, and re-derives once the subgraph is replaced", () => {
    const subgraph = subgraphWithPorts();
    const group = { ...node("g", GROUP_TYPE), subgraph };

    expect(resolveDefinition(group, REGISTRY)).toBe(resolveDefinition(group, REGISTRY));

    const renamed: Graph = {
      ...subgraph,
      nodes: subgraph.nodes.map((n) =>
        n.id === "in" ? { ...n, params: { ports: [{ id: "amount", label: "Strength", type: "value" }] } } : n,
      ),
    };
    const after = resolveDefinition({ ...group, subgraph: renamed }, REGISTRY)!;
    expect(after.inputs[0].label).toBe("Strength");
  });
});

describe("graph traversal", () => {
  const inner: Graph = { ...emptyGraph(), nodes: [node("deep", "value/passthrough")] };
  const middle: Graph = {
    ...emptyGraph(),
    nodes: [node("mid", "value/passthrough"), { ...node("inner-group", GROUP_TYPE), subgraph: inner }],
  };
  const root: Graph = {
    ...emptyGraph(),
    nodes: [node("top", "value/passthrough"), { ...node("group", GROUP_TYPE), subgraph: middle }],
  };

  it("walks nested graphs outermost first", () => {
    expect(walkGraphs(root)).toEqual([root, middle, inner]);
  });

  it("collects every node id across nesting levels", () => {
    expect(collectAllNodeIds(root).sort()).toEqual(["deep", "group", "inner-group", "mid", "top"]);
  });

  it("resolves a path of group ids", () => {
    expect(graphAtPath(root, [])).toBe(root);
    expect(graphAtPath(root, ["group"])).toBe(middle);
    expect(graphAtPath(root, ["group", "inner-group"])).toBe(inner);
  });

  it("returns undefined for a path that no longer leads anywhere", () => {
    expect(graphAtPath(root, ["gone"])).toBeUndefined();
    expect(graphAtPath(root, ["top"])).toBeUndefined();
  });

  it("replaces a nested graph while leaving untouched branches identical", () => {
    const replacement: Graph = { ...emptyGraph(), nodes: [node("fresh", "value/passthrough")] };
    const next = replaceGraphAtPath(root, ["group", "inner-group"], replacement);

    expect(graphAtPath(next, ["group", "inner-group"])).toBe(replacement);
    // The sibling at the root keeps its identity, so caches keyed by object
    // reference (the evaluator's structural cache) survive the edit.
    expect(next.nodes[0]).toBe(root.nodes[0]);
    expect(graphAtPath(root, ["group", "inner-group"])).toBe(inner);
  });
});
