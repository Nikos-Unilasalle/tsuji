import { describe, expect, it } from "vitest";
import { Node } from "@xyflow/react";
import { toGraph } from "./GraphEditor";
import { GraphNodeData } from "./GraphNode";
import { NodeInstance } from "../shared/graph/types";

describe("toGraph", () => {
  it("keeps the pins and keyframes of a node inside a group, drops a deleted node's", () => {
    const inner: NodeInstance = { id: "inner", type: "value/constant", params: {}, position: { x: 0, y: 0 } };
    const group: NodeInstance = {
      id: "group",
      type: "group/group",
      params: {},
      position: { x: 0, y: 0 },
      subgraph: { nodes: [inner], connections: [] },
    };
    const gone: NodeInstance = { id: "gone", type: "value/constant", params: {}, position: { x: 0, y: 0 } };
    // The canvas shows the top level only: the group, not what it holds; "gone" was deleted.
    const flow = [{ id: "group", position: { x: 5, y: 5 }, data: {} }] as unknown as Node<GraphNodeData>[];
    const g = toGraph(
      [group, gone],
      flow,
      [],
      { inner: { value: [{ frame: 0, value: 1 }] }, gone: { value: [{ frame: 0, value: 1 }] } },
      [],
      [
        { nodeId: "inner", paramId: "value" },
        { nodeId: "gone", paramId: "value" },
      ],
    );
    expect(g.exposedParams).toEqual([{ nodeId: "inner", paramId: "value" }]);
    expect(Object.keys(g.keyframes ?? {})).toEqual(["inner"]);
  });
});
