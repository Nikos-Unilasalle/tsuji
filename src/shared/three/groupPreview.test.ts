import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { DEFAULT_REGISTRY } from "../graph/nodes/index";
import { evaluateGraph } from "../graph/evaluate";
import { computeGroupPreview, SELECTION_COLOR, SHEET_COLOR } from "./groupPreview";
import type { Graph, NodeInstance } from "../graph/types";

const node = (id: string, type: string, params: Record<string, unknown> = {}): NodeInstance => ({
  id,
  type,
  params: { ...DEFAULT_REGISTRY.get(type)!.defaultParams, ...params },
  position: { x: 0, y: 0 },
});
const wire = (a: string, b: string) => ({ id: `${a}->${b}`, fromNode: a, fromSocket: "geometry", toNode: b, toSocket: "geometry" });

function setup() {
  const graph = {
    nodes: [
      node("box", "object/box"),
      node("top", "select/basic", { mode: "normal", direction: new THREE.Vector3(0, 1, 0), angle: 10, name: "top", domain: "face" }),
      node("ext", "modifier/extrude", { group: "top", distance: 0.5 }),
      node("sheet", "attribute/spreadsheet", { domain: "face" }),
    ],
    connections: [wire("box", "top"), wire("top", "ext"), wire("ext", "sheet")],
    keyframes: {},
    markers: [],
    exposedParams: [],
  } as unknown as Graph;
  const results = evaluateGraph(graph, DEFAULT_REGISTRY, { time: 0, step: 0, nodeId: "", registry: DEFAULT_REGISTRY });
  return { graph, results };
}

const base = { registry: DEFAULT_REGISTRY, shownGroups: [], expressionHover: null, sheetHover: null };

describe("group preview", () => {
  it("shows the group a modifier works on, on its input", () => {
    const { graph, results } = setup();
    const p = computeGroupPreview({ ...base, graph, results, selectedNodeId: "ext" });
    expect(p.badge?.text).toContain("Works on “top” · 1 / 6 faces");
    expect(p.layers).toHaveLength(1);
    expect(p.layers[0].color).toBe(SELECTION_COLOR);
    expect([...p.layers[0].mask].filter(Boolean)).toHaveLength(1);
  });

  it("shows the group a Select node writes, and previews a hovered formula", () => {
    const { graph, results } = setup();
    expect(computeGroupPreview({ ...base, graph, results, selectedNodeId: "top" }).badge?.text).toContain("Writes “top”");
    const hovered = computeGroupPreview({
      ...base,
      graph,
      results,
      selectedNodeId: "ext",
      expressionHover: { nodeId: "ext", fieldId: "group", expression: "@P.y<0" },
    });
    expect(hovered.badge?.text).toContain("Preview “@P.y<0”");
  });

  it("reports unknown names as an error", () => {
    const { graph, results } = setup();
    graph.nodes[2].params.group = "nope";
    const p = computeGroupPreview({ ...base, graph, results, selectedNodeId: "ext" });
    expect(p.badge?.error).toBe(true);
    expect(p.badge?.text).toContain("Unknown: nope");
  });

  it("offers the mesh's groups in the menu and draws the ticked ones", () => {
    const { graph, results } = setup();
    const first = computeGroupPreview({ ...base, graph, results, selectedNodeId: "ext" });
    const keys = first.available.map((g) => g.key);
    expect(keys).toEqual(expect.arrayContaining(["face:top", "face:extrude_top", "face:extrude_side"]));
    const shown = computeGroupPreview({ ...base, graph, results, selectedNodeId: "ext", shownGroups: ["face:extrude_side"] });
    expect(shown.legend.map((l) => l.name)).toEqual(["extrude_side"]);
    expect(shown.layers).toHaveLength(2);
  });

  it("lights up the element under a spreadsheet row", () => {
    const { graph, results } = setup();
    const p = computeGroupPreview({ ...base, graph, results, selectedNodeId: null, sheetHover: { nodeId: "sheet", index: 3 } });
    expect(p.layers).toHaveLength(1);
    expect(p.layers[0].color).toBe(SHEET_COLOR);
    expect(p.layers[0].mask[3]).toBe(1);
  });
});

import { createGroupOverlay } from "./groupOverlay";

describe("group overlay", () => {
  it("builds each layer once and drops the ones no longer shown", () => {
    const { graph, results } = setup();
    const p = computeGroupPreview({ ...base, graph, results, selectedNodeId: "ext", shownGroups: ["face:extrude_side"] });
    const overlay = createGroupOverlay();
    overlay.sync(p.layers);
    expect(overlay.group.children).toHaveLength(2);
    const kept = overlay.group.children[0];
    overlay.sync(p.layers.slice(0, 1));
    expect(overlay.group.children).toEqual([kept]);
    overlay.sync([]);
    expect(overlay.group.children).toHaveLength(0);
  });
});
