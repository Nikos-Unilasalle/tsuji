import * as THREE from "three";
import { describe, expect, test } from "vitest";
import {
  freshSubgraph,
  getGraphClipboard,
  hasGraphClipboard,
  markOwnClipboardPayload,
  parseGraphClipboard,
  resolvePasteClipboard,
  serializeGraphClipboard,
  setGraphClipboard,
} from "./clipboard";
import { GROUP_TYPE } from "./groups";
import { NodeInstance } from "./types";

describe("GRAPH CLIPBOARD SYSTEM", () => {
  test("stores and retrieves copied nodes, connections, and keyframes", () => {
    const nodeA: NodeInstance = {
      id: "node-1",
      type: "transform",
      position: { x: 100, y: 200 },
      params: { location: new THREE.Vector3(1, 2, 3), name: "Box" },
    };

    setGraphClipboard({
      nodes: [nodeA],
      connections: [],
      keyframes: {
        "node-1": {
          "rotation.x": [{ frame: 0, value: 0 }, { frame: 60, value: 90 }],
        },
      },
    });

    expect(hasGraphClipboard()).toBe(true);

    const clip = getGraphClipboard();
    expect(clip).not.toBeNull();
    expect(clip?.nodes).toHaveLength(1);
    expect(clip?.nodes[0].id).toBe("node-1");
    expect(clip?.nodes[0].params.location).toBeInstanceOf(THREE.Vector3);
    expect((clip?.nodes[0].params.location as THREE.Vector3).x).toBe(1);
    expect(clip?.keyframes?.["node-1"]?.["rotation.x"]).toHaveLength(2);

    // Mutation of retrieved clipboard does not corrupt global store
    clip!.nodes[0].position.x = 999;
    (clip!.nodes[0].params.location as THREE.Vector3).x = 777;

    const clip2 = getGraphClipboard();
    expect(clip2?.nodes[0].position.x).toBe(100);
    expect((clip2?.nodes[0].params.location as THREE.Vector3).x).toBe(1);
  });
});

describe("SYSTEM CLIPBOARD PAYLOAD", () => {
  const nodes: NodeInstance[] = [
    {
      id: "a",
      type: "transform",
      position: { x: 10, y: 20 },
      params: { location: new THREE.Vector3(1, 2, 3), name: "Box" },
    },
    {
      id: "b",
      type: "transform",
      position: { x: 200, y: 20 },
      params: { name: "Other" },
    },
  ];
  const connections = [{ id: "a.out->b.in", fromNode: "a", fromSocket: "geometry", toNode: "b", toSocket: "geometry" }];

  test("round-trips nodes, params (as THREE instances), inner connections and keyframes", () => {
    const { text, id } = serializeGraphClipboard({
      nodes,
      connections,
      keyframes: { a: { "rotation.x": [{ frame: 0, value: 0 }, { frame: 10, value: 45 }] } },
    });
    const parsed = parseGraphClipboard(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe(id);
    expect(parsed!.data.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(parsed!.data.nodes[0].params.location).toBeInstanceOf(THREE.Vector3);
    expect((parsed!.data.nodes[0].params.location as THREE.Vector3).toArray()).toEqual([1, 2, 3]);
    expect(parsed!.data.nodes[0].params.name).toBe("Box");
    expect(parsed!.data.keyframes?.a?.["rotation.x"]).toHaveLength(2);
  });

  test("keeps a group's interior", () => {
    const group: NodeInstance = {
      id: "g",
      type: GROUP_TYPE,
      position: { x: 0, y: 0 },
      params: { name: "G" },
      subgraph: { nodes: [{ id: "inner", type: "transform", position: { x: 0, y: 0 }, params: {} }], connections: [] },
    };
    const parsed = parseGraphClipboard(serializeGraphClipboard({ nodes: [group], connections: [] }).text);
    expect(parsed?.data.nodes[0].subgraph?.nodes[0].id).toBe("inner");
  });

  test("rejects anything that isn't a tsuji payload", () => {
    for (const text of [
      "",
      "hello",
      "{not json",
      JSON.stringify({ nodes: [], connections: [] }),
      JSON.stringify({ format: "other/nodes", version: 1, graph: { nodes: [], connections: [] } }),
      JSON.stringify({ format: "tsuji/nodes", version: 999, graph: { nodes: [], connections: [] } }),
      JSON.stringify({ format: "tsuji/nodes", version: 1, graph: { nodes: [{ id: "x" }], connections: [] } }),
      JSON.stringify({ format: "tsuji/nodes", version: 1, graph: { nodes: [null], connections: [] } }),
      JSON.stringify({ format: "tsuji/nodes", version: 1, graph: "nope" }),
      JSON.stringify({ format: "tsuji/nodes", version: 1, graph: { nodes: [], connections: [] } }),
    ]) {
      expect(parseGraphClipboard(text)).toBeNull();
    }
    expect(parseGraphClipboard(null)).toBeNull();
  });

  test("a foreign payload wins over the in-memory copy; this window's own payload does not", () => {
    setGraphClipboard({ nodes: [nodes[1]], connections: [] });
    const own = serializeGraphClipboard({ nodes: [nodes[1]], connections: [] });
    markOwnClipboardPayload(own.id);
    expect(resolvePasteClipboard(own.text)?.nodes[0].params.name).toBe("Other");

    const foreign = serializeGraphClipboard({ nodes: [nodes[0]], connections: [] });
    expect(resolvePasteClipboard(foreign.text)?.nodes[0].params.name).toBe("Box");
    // Unrelated text leaves the in-app clipboard in charge.
    expect(resolvePasteClipboard("some text")?.nodes[0].params.name).toBe("Other");
  });

  test("freshSubgraph gives interior nodes new ids and remaps their wiring and keyframes", () => {
    const idMap = new Map<string, string>();
    let n = 0;
    const out = freshSubgraph(
      {
        nodes: [
          { id: "i1", type: "transform", position: { x: 0, y: 0 }, params: {} },
          { id: "i2", type: "transform", position: { x: 0, y: 0 }, params: {} },
        ],
        connections: [{ id: "c", fromNode: "i1", fromSocket: "geometry", toNode: "i2", toSocket: "geometry" }],
        keyframes: { i1: { x: [{ frame: 0, value: 1 }] } },
        exposedParams: [{ nodeId: "i2", paramId: "x" }],
      },
      idMap,
      () => `new${++n}`,
    );
    expect(out.nodes.map((x) => x.id)).toEqual(["new1", "new2"]);
    expect(out.connections[0]).toMatchObject({ fromNode: "new1", toNode: "new2" });
    expect(Object.keys(out.keyframes!)).toEqual(["new1"]);
    expect(out.exposedParams?.[0].nodeId).toBe("new2");
    expect(idMap.get("i1")).toBe("new1");
  });
});
