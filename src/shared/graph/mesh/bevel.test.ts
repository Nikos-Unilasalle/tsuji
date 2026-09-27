import { describe, it, expect } from "vitest";
import { createQuadBox, createQuadPlane, QuadMesh, computeFaceNormal } from "../quadMesh";
import { validateQuadMesh } from "./validate";
import { bevelEdges } from "./bevel";
import { getTopology } from "./topology";

function expectClosedAndSound(mesh: QuadMesh) {
  const r = validateQuadMesh(mesh);
  expect(r.errors).toEqual([]);
  expect(r.nonManifoldEdges).toBe(0);
  expect(r.inconsistentEdges).toBe(0);
  expect(r.boundaryEdges).toBe(0);
  expect(r.orphanVertices).toBe(0);
}

const boxEdges = (): [number, number][] => getTopology(createQuadBox()).edges.map(([a, b]) => [a, b]);

describe("bevelEdges", () => {
  it("chamfers one cube edge into a strip", () => {
    const box = createQuadBox();
    const { mesh, newFaces } = bevelEdges(box, [[6, 7]], 0.1); // front-top edge
    expectClosedAndSound(mesh);
    expect(newFaces).toHaveLength(1);
    expect(mesh.faces).toHaveLength(7);
    // The two side faces each gained a corner.
    expect(mesh.faces.filter((f) => f.length === 5)).toHaveLength(2);
    // The strip leans 45° between front and top.
    const n = computeFaceNormal(mesh.positions, mesh.faces[newFaces[0]]);
    expect(n.y).toBeCloseTo(Math.SQRT1_2, 6);
    expect(n.z).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("rounds with several segments", () => {
    const box = createQuadBox();
    const { mesh, newFaces } = bevelEdges(box, [[6, 7]], 0.2, 4);
    expectClosedAndSound(mesh);
    expect(newFaces).toHaveLength(4);
    // The side faces take the rounded profile into their outline.
    expect(mesh.faces.filter((f) => f.length === 5 + 3)).toHaveLength(2);
  });

  it("bevels every cube edge, with a patch on each corner", () => {
    const box = createQuadBox();
    for (const segments of [1, 3]) {
      const { mesh, newFaces } = bevelEdges(box, boxEdges(), 0.1, segments);
      expectClosedAndSound(mesh);
      // 12 strips × segments, plus 8 corner patches.
      expect(newFaces).toHaveLength(12 * segments + 8);
      expect(mesh.faces).toHaveLength(6 + 12 * segments + 8);
    }
  });

  it("bevels an edge loop straight through, no patch where it passes", () => {
    const box = createQuadBox();
    // The four edges around the top face.
    const loop: [number, number][] = [[7, 6], [6, 2], [2, 3], [3, 7]];
    const { mesh, newFaces } = bevelEdges(box, loop, 0.1, 2);
    expectClosedAndSound(mesh);
    // Neighbouring strips share their corner profile: no patches.
    expect(newFaces).toHaveLength(4 * 2);
  });

  it("ends a bevel in the middle of a grid with a small cap", () => {
    // 3×3 grid; the middle horizontal edge 5–6 between interior vertices.
    const plane = createQuadPlane(3, 3, 3, 3);
    const { mesh, newFaces } = bevelEdges(plane, [[5, 6]], 0.1);
    const r = validateQuadMesh(mesh);
    expect(r.errors).toEqual([]);
    expect(r.nonManifoldEdges).toBe(0);
    expect(r.inconsistentEdges).toBe(0);
    expect(r.boundaryEdges).toBe(12);
    // The strip plus a triangle cap at each end; both vertices stay.
    expect(newFaces).toHaveLength(3);
    expect(mesh.positions).toHaveLength(16 + 4);
  });

  it("runs across a grid from border to border", () => {
    const plane = createQuadPlane(3, 3, 3, 3);
    const { mesh, newFaces } = bevelEdges(plane, [[4, 5], [5, 6], [6, 7]], 0.1);
    const r = validateQuadMesh(mesh);
    expect(r.errors).toEqual([]);
    expect(r.nonManifoldEdges).toBe(0);
    expect(r.inconsistentEdges).toBe(0);
    expect(r.orphanVertices).toBe(0);
    expect(newFaces).toHaveLength(3);
  });

  it("skips open-border edges and does nothing at zero width", () => {
    const plane = createQuadPlane(1, 1, 1, 1);
    expect(bevelEdges(plane, [[0, 1]], 0.1).newFaces).toEqual([]);
    expect(bevelEdges(createQuadBox(), [[6, 7]], 0).newFaces).toEqual([]);
  });
});
