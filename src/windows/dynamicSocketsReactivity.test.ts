import { describe, expect, it } from "vitest";
import { Node } from "@xyflow/react";
import { GraphNodeData } from "./GraphNode";
import { NodeRegistry, NodeInstance, Graph } from "../shared/graph/types";
import { CONTOUR_SCAN_NODE } from "../shared/graph/nodes/contourScan";

describe("Dynamic socket reactivity on param changes", () => {
  const registry: NodeRegistry = new Map([
    [CONTOUR_SCAN_NODE.type, CONTOUR_SCAN_NODE],
  ]);

  it("updates node socket data when params switch style to curves", () => {
    const initialInstance: NodeInstance = {
      id: "scan1",
      type: CONTOUR_SCAN_NODE.type,
      position: { x: 0, y: 0 },
      params: { style: "ribbons" },
    };

    const initialOutputs = CONTOUR_SCAN_NODE.dynamicOutputs!([], [], initialInstance.params);
    expect(initialOutputs.map((s) => s.id)).toEqual(["geometry", "matrix"]);

    const prevNode: Node<GraphNodeData> = {
      id: "scan1",
      type: "graphNode",
      position: { x: 0, y: 0 },
      data: {
        nodeId: "scan1",
        nodeType: CONTOUR_SCAN_NODE.type,
        label: CONTOUR_SCAN_NODE.label,
        inputs: CONTOUR_SCAN_NODE.inputs,
        outputs: initialOutputs,
      },
    };

    const updatedGraph: Graph = {
      nodes: [
        {
          id: "scan1",
          type: CONTOUR_SCAN_NODE.type,
          position: { x: 0, y: 0 },
          params: { style: "curves" },
        },
      ],
      connections: [],
    };

    const graphNode = updatedGraph.nodes.find((gn) => gn.id === prevNode.id)!;
    const def = registry.get(graphNode.type)!;
    const nextOutputs = def.dynamicOutputs!([], [], graphNode.params);
    const nextNode: Node<GraphNodeData> = {
      ...prevNode,
      data: {
        ...prevNode.data,
        outputs: nextOutputs,
        params: graphNode.params,
      },
    };

    const updatedNode = {
      ...prevNode,
      data: {
        ...prevNode.data,
        ...(nextNode ? nextNode.data : {}),
        params: graphNode.params,
      },
    };

    expect(updatedNode.data.outputs.map((s) => s.id)).toEqual([
      "geometry",
      "curves",
      "curve",
      "matrix",
    ]);
  });
});
