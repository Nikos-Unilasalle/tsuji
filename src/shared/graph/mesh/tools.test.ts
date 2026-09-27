import { describe, it, expect } from "vitest";
import { createQuadBox, createQuadPlane, QuadMesh, computeFaceNormal, deleteFaces } from "../quadMesh";
import { validateQuadMesh } from "./validate";
import {
  compactMesh,
  dissolveEdges,
  dissolveFaces,
  dissolveVertices,
  duplicateFaces,
  extrudeFacesIndividual,
  faceUVMapper,
  fillVertices,
  flipFaces,
  insetRegion,
  mergeByDistance,
  mergeVertices,
  mirrorMovesX,
  mirrorXMap,
  subdivideFaces,
} from "./tools";
import * as THREE from "three";

function expectSound(result: QuadMesh, input: QuadMesh) {
  const before = validateQuadMesh(input);
  const after = validateQuadMesh(result);
  expect(after.errors).toEqual([]);
  expect(after.nonManifoldEdges).toBe(before.nonManifoldEdges);
  expect(after.inconsistentEdges).toBe(0);
  if (before.boundaryEdges === 0) expect(after.boundaryEdges).toBe(0);
  expect(after.orphanVertices).toBe(0);
}

// 3×3 grid: vertex (ix, iy) = iy * 4 + ix; face (fx, fy) = fy * 3 + fx.
const grid = () => createQuadPlane(3, 3, 3, 3);

describe("faceUVMapper", () => {
  it("reproduces an affine UV layout exactly", () => {
    const p: [number, number, number][] = [[0, 0, 0], [2, 0, 0], [2, 1, 0], [0, 1, 0]];
    const map = faceUVMapper(p, [0, 1, 2, 3], [[0, 0], [1, 0], [1, 1], [0, 1]]);
    const [u, v] = map(new THREE.Vector3(1, 0.25, 0));
    expect(u).toBeCloseTo(0.5, 9);
    expect(v).toBeCloseTo(0.25, 9);
  });
});

describe("extrudeFacesIndividual", () => {
  it("walls every selected face, even between neighbours", () => {
    const box = createQuadBox();
    const { mesh } = extrudeFacesIndividual(box, [0, 2], 0.3); // front + top, adjacent
    expectSound(mesh, box);
    expect(mesh.faces).toHaveLength(6 + 4 + 4);
  });
});

describe("insetRegion", () => {
  it("insets one quad by an absolute thickness", () => {
    const box = createQuadBox(2, 2, 2);
    const { mesh } = insetRegion(box, [0], 0.25);
    expectSound(mesh, box);
    expect(mesh.faces).toHaveLength(10);
    // The inner face is 2 - 2×0.25 = 1.5 wide.
    const xs = mesh.faces[0].map((v) => mesh.positions[v][0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1.5, 9);
  });

  it("insets a region as a whole: only its outer border", () => {
    const plane = grid();
    const { mesh } = insetRegion(plane, [3, 4, 5], 0.1); // the middle row
    expectSound(mesh, plane);
    // 8 border edges around a 3×1 strip, one quad each; inside edges untouched.
    expect(mesh.faces).toHaveLength(9 + 8);
  });

  it("insets individually when asked", () => {
    const plane = grid();
    const { mesh } = insetRegion(plane, [3, 4, 5], 0.1, 0, true);
    expectSound(mesh, plane);
    expect(mesh.faces).toHaveLength(9 + 12);
  });

  it("pushes the inset part out by depth", () => {
    const plane = createQuadPlane(1, 1, 1, 1);
    const { mesh } = insetRegion(plane, [0], 0.1, 0.5);
    for (const v of mesh.faces[0]) expect(mesh.positions[v][2]).toBeCloseTo(0.5, 9);
  });

  it("keeps a continuous UV layout", () => {
    const plane = createQuadPlane(1, 1, 1, 1); // uv = position + 0.5
    const { mesh } = insetRegion(plane, [0], 0.1);
    mesh.faces.forEach((face, f) =>
      face.forEach((v, i) => {
        const [x, y] = mesh.positions[v];
        expect(mesh.faceUVs![f][i][0]).toBeCloseTo(x + 0.5, 9);
        expect(mesh.faceUVs![f][i][1]).toBeCloseTo(y + 0.5, 9);
      }),
    );
  });
});

describe("merge", () => {
  it("merges vertices at their centre and drops collapsed faces", () => {
    const plane = grid();
    // Collapse the middle face's four corners: it vanishes, neighbours become triangles.
    const { mesh, vertex } = mergeVertices(plane, [5, 6, 9, 10], "center");
    expect(validateQuadMesh(mesh).errors).toEqual([]);
    expect(mesh.faces).toHaveLength(8);
    expect(mesh.positions[vertex!]).toEqual([0, 0, 0]);
  });

  it("welds coincident vertices by distance", () => {
    const box = createQuadBox();
    // Split the box into two pieces with duplicate vertices along a seam.
    const split: QuadMesh = {
      positions: [...box.positions, ...box.positions.map((p) => [...p] as [number, number, number])],
      faces: box.faces.map((f, i) => (i < 3 ? f : f.map((v) => v + 8))),
    };
    expect(validateQuadMesh(split).boundaryEdges).toBeGreaterThan(0);
    const { mesh, removed } = mergeByDistance(split, 1e-6);
    expect(removed).toBe(8);
    expectSound(mesh, box);
  });
});

describe("dissolve", () => {
  it("dissolves a patch of faces into one n-gon", () => {
    const plane = grid();
    const { mesh, newFaces } = dissolveFaces(plane, [0, 1, 3, 4]);
    expect(validateQuadMesh(mesh).errors).toEqual([]);
    expect(mesh.faces).toHaveLength(9 - 4 + 1);
    expect(mesh.faces[newFaces[0]]).toHaveLength(8);
    expect(mesh.positions).toHaveLength(16 - 1); // the patch's inner vertex
    expect(computeFaceNormal(mesh.positions, mesh.faces[newFaces[0]]).z).toBeCloseTo(1, 9);
  });

  it("leaves a ring-shaped region (a hole in the middle) alone", () => {
    const plane = grid();
    const ring = [0, 1, 2, 3, 5, 6, 7, 8];
    expect(dissolveFaces(plane, ring).mesh.faces).toHaveLength(9);
  });

  it("dissolves an edge between two quads", () => {
    const plane = grid();
    const { mesh } = dissolveEdges(plane, [[5, 9]]); // between faces 3 and 4
    expect(validateQuadMesh(mesh).errors).toEqual([]);
    expect(mesh.faces).toHaveLength(8);
    expect(mesh.faces.some((f) => f.length === 6)).toBe(true);
  });

  it("dissolves an interior vertex, and drops a mid-edge one", () => {
    const plane = grid();
    const { mesh } = dissolveVertices(plane, [5]);
    expect(validateQuadMesh(mesh).errors).toEqual([]);
    expect(mesh.faces).toHaveLength(6);
    expect(mesh.positions).toHaveLength(15);

    // A strip made with an extra vertex mid-edge: dissolving it restores a quad.
    const kinked: QuadMesh = { positions: [[0, 0, 0], [0.5, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], faces: [[0, 1, 2, 3, 4]] };
    const { mesh: quad } = dissolveVertices(kinked, [1]);
    expect(quad.faces).toEqual([[0, 1, 2, 3]]);
  });
});

describe("fillVertices", () => {
  it("fills a hole with the right winding", () => {
    const box = createQuadBox();
    const open = deleteFaces(box, [2]); // remove the top
    const hole = [...box.faces[2]]; // same indices: no vertex was dropped
    const { mesh, newFaces } = fillVertices(open, hole);
    expectSound(mesh, box);
    expect(validateQuadMesh(mesh).boundaryEdges).toBe(0);
    expect(computeFaceNormal(mesh.positions, mesh.faces[newFaces[0]]).y).toBeCloseTo(1, 9);
  });

  it("makes a face from loose points in a sensible order", () => {
    const loose: QuadMesh = { positions: [[0, 0, 0], [1, 1, 0], [1, 0, 0], [0, 1, 0]], faces: [] };
    const { mesh } = fillVertices(loose, [0, 1, 2, 3]);
    expect(mesh.faces).toHaveLength(1);
    // Convex order, not the bow-tie 0-1-2-3.
    const f = mesh.faces[0];
    expect(Math.abs(computeFaceNormal(mesh.positions, f).z)).toBeCloseTo(1, 9);
  });

  it("does nothing when the face already exists", () => {
    const box = createQuadBox();
    expect(fillVertices(box, box.faces[0]).newFaces).toEqual([]);
  });
});

describe("flip / duplicate / subdivide", () => {
  it("flips normals", () => {
    const box = createQuadBox();
    const flipped = flipFaces(box, [0]);
    expect(computeFaceNormal(flipped.positions, flipped.faces[0]).z).toBeCloseTo(-1, 9);
    expect(flipped.faceUVs![0]).toEqual([...box.faceUVs![0]].reverse());
  });

  it("duplicates faces as a separate piece", () => {
    const box = createQuadBox();
    const { mesh, newFaces } = duplicateFaces(box, [0, 2]);
    expect(validateQuadMesh(mesh).errors).toEqual([]);
    expect(mesh.positions).toHaveLength(8 + 6);
    expect(newFaces).toEqual([6, 7]);
  });

  it("subdivides a face and keeps neighbours attached", () => {
    const box = createQuadBox();
    const { mesh, newFaces } = subdivideFaces(box, [2]);
    expectSound(mesh, box);
    expect(newFaces).toHaveLength(4);
    // The four side faces each gained the midpoint of their top edge.
    expect(mesh.faces.filter((f) => f.length === 5)).toHaveLength(4);
  });
});

describe("mirror", () => {
  it("finds X counterparts and mirrors moves onto them", () => {
    const box = createQuadBox();
    const map = mirrorXMap(box);
    // (-0.5, -0.5, -0.5) ↔ (0.5, -0.5, -0.5)
    expect(map[0]).toBe(1);
    expect(map[1]).toBe(0);
    const moves = mirrorMovesX(box, new Map([[1, [0.8, -0.5, -0.5]]]), map);
    expect(moves.get(0)).toEqual([-0.8, -0.5, -0.5]);
  });
});

describe("compactMesh", () => {
  it("drops degenerate faces and unused vertices", () => {
    const m: QuadMesh = { positions: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [5, 5, 5]], faces: [[0, 1, 1, 2], [0, 0, 1]], faceUVs: [[[0, 0], [1, 0], [1, 0], [1, 1]], [[0, 0], [0, 0], [1, 0]]] };
    const { mesh } = compactMesh(m);
    expect(mesh.faces).toEqual([[0, 1, 2]]);
    expect(mesh.positions).toHaveLength(3);
  });
});
