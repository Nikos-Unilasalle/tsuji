import { describe, it, expect } from "vitest";
import { createQuadBox, createQuadPlane, QuadMesh } from "../quadMesh";
import {
  convertSelection,
  emptySelection,
  flatFaces,
  growSelection,
  linkedSelection,
  normalizeEdges,
  shrinkSelection,
} from "./selection";
import { edgeLoop, edgeRing } from "./loops";

// A 3×3 quad grid: vertex (ix, iy) = iy * 4 + ix, face (fx, fy) = fy * 3 + fx.
const grid = () => createQuadPlane(3, 3, 3, 3);
const sortEdges = (edges: [number, number][]) => edges.map((e) => `${e[0]}_${e[1]}`).sort();
const withPoints = (points: number[]) => ({ ...emptySelection(), points });
const withFaces = (faces: number[]) => ({ ...emptySelection(), faces });

describe("edgeLoop", () => {
  it("runs straight across the grid until it hits the border", () => {
    // Row 1, middle edge 5–6: through the valence-4 vertices 5 and 6 to both borders.
    expect(sortEdges(edgeLoop(grid(), 5, 6))).toEqual(["4_5", "5_6", "6_7"]);
  });

  it("follows the whole border from a boundary edge", () => {
    expect(edgeLoop(grid(), 0, 1)).toHaveLength(12);
  });

  it("stops at poles (a cube corner has three edges)", () => {
    expect(edgeLoop(createQuadBox(), 4, 5)).toHaveLength(1);
  });
});

describe("edgeRing", () => {
  it("collects the rungs across the quad ring", () => {
    expect(sortEdges(edgeRing(grid(), 5, 6))).toEqual(["13_14", "1_2", "5_6", "9_10"]);
  });

  it("goes all the way around a box", () => {
    expect(edgeRing(createQuadBox(), 4, 5)).toHaveLength(4);
  });
});

describe("convertSelection", () => {
  const box = createQuadBox();
  const top = box.faces[2]; // [7, 6, 2, 3]

  it("points → faces keeps faces whose corners are all selected", () => {
    expect(convertSelection(box, "points", withPoints(top), "faces").faces).toEqual([2]);
    expect(convertSelection(box, "points", withPoints([7, 6, 2]), "faces").faces).toEqual([]);
  });

  it("faces → points / edges takes their corners and edges", () => {
    expect(convertSelection(box, "faces", withFaces([2]), "points").points).toEqual([...top].sort((a, b) => a - b));
    expect(convertSelection(box, "faces", withFaces([2]), "edges").edges).toHaveLength(4);
  });

  it("edges → faces keeps faces whose every edge is selected", () => {
    const edges = convertSelection(box, "faces", withFaces([2]), "edges").edges;
    expect(convertSelection(box, "edges", { ...emptySelection(), edges }, "faces").faces).toEqual([2]);
    expect(convertSelection(box, "edges", { ...emptySelection(), edges: edges.slice(1) }, "faces").faces).toEqual([]);
  });
});

describe("grow / shrink", () => {
  it("grows faces to everything sharing a vertex, and shrinks back", () => {
    const grown = growSelection(grid(), "faces", withFaces([4]));
    expect(grown.faces).toHaveLength(9);
    expect(shrinkSelection(grid(), "faces", grown).faces).toEqual([4]);
  });

  it("grows points to their neighbours", () => {
    expect(growSelection(grid(), "points", withPoints([5])).points).toEqual([1, 4, 5, 6, 9]);
  });

  it("shrinks points off the selection's border", () => {
    const all = withPoints(Array.from({ length: 16 }, (_, i) => i));
    expect(shrinkSelection(grid(), "points", all).points).toEqual([5, 6, 9, 10]);
  });
});

describe("linked / flat", () => {
  it("selects only the island the selection is on", () => {
    const a = createQuadBox();
    const two: QuadMesh = {
      positions: [...a.positions, ...a.positions.map(([x, y, z]) => [x + 3, y, z] as [number, number, number])],
      faces: [...a.faces, ...a.faces.map((f) => f.map((v) => v + 8))],
    };
    expect(linkedSelection(two, "points", withPoints([0])).points).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(linkedSelection(two, "faces", withFaces([7])).faces).toEqual([6, 7, 8, 9, 10, 11]);
  });

  it("floods faces up to an angle", () => {
    expect(flatFaces(createQuadBox(), [2], 30)).toEqual([2]);
    expect(flatFaces(createQuadBox(), [2], 91)).toHaveLength(6);
    expect(flatFaces(grid(), [0], 1)).toHaveLength(9);
  });
});

describe("normalizeEdges", () => {
  it("normalises, deduplicates and drops junk", () => {
    expect(normalizeEdges([[3, 1], [1, 3], [2, 2], "x", [4]])).toEqual([[1, 3]]);
    expect(normalizeEdges(undefined)).toEqual([]);
  });
});
