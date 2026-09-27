import { describe, it, expect } from "vitest";
import {
  cloneQuadMesh,
  createQuadBox,
  createQuadPlane,
  deleteFaces,
  extractFaces,
  extrudeFaces,
  getLoopCutPreviewSegments,
  insetFaces,
  loopCut,
  QuadMesh,
  quadMeshToBufferGeometry,
  withFaceUVs,
} from "../quadMesh";
import { validateQuadMesh } from "./validate";

/** No structural faults, and no surface damage the input didn't already have. */
function expectSound(result: QuadMesh, input: QuadMesh) {
  const before = validateQuadMesh(input);
  const after = validateQuadMesh(result);
  expect(after.errors).toEqual([]);
  expect(after.nonManifoldEdges).toBe(before.nonManifoldEdges);
  expect(after.inconsistentEdges).toBe(before.inconsistentEdges);
  // A closed surface stays closed. (An open one legitimately gains boundary
  // edges: cutting across a border edge splits it in two.)
  if (before.boundaryEdges === 0) expect(after.boundaryEdges).toBe(0);
  else expect(after.boundaryEdges).toBeGreaterThanOrEqual(before.boundaryEdges);
  expect(after.orphanVertices).toBe(0);
}

/** A box whose six faces use material slots 0..5 and carry distinctive UVs. */
function markedBox(): QuadMesh {
  const box = createQuadBox();
  box.faceMaterials = [0, 1, 2, 3, 4, 5];
  box.faceUVs = box.faces.map((face, f) => face.map((_, i) => [f + i * 0.1, f] as [number, number]));
  return box;
}

describe("extrudeFaces", () => {
  it("keeps a closed box closed, and every existing face's UVs", () => {
    const box = markedBox();
    const { mesh, newFaces } = extrudeFaces(box, [2], 0.5); // top
    expectSound(mesh, box);
    expect(newFaces).toEqual([2]);
    expect(mesh.faces).toHaveLength(10);
    for (let f = 0; f < 6; f++) expect(mesh.faceUVs![f]).toEqual(box.faceUVs![f]);
    // Four walls, each inheriting the top's material.
    expect(mesh.faceMaterials).toEqual([0, 1, 2, 3, 4, 5, 2, 2, 2, 2]);
  });

  it("extrudes a region as one piece: walls only on its border", () => {
    const box = createQuadBox();
    const { mesh } = extrudeFaces(box, [0, 2], 0.25); // front + top share an edge
    expectSound(mesh, box);
    expect(mesh.faces).toHaveLength(6 + 6);
  });

  it("ignores invalid and duplicate indices", () => {
    const box = createQuadBox();
    const { mesh, newFaces } = extrudeFaces(box, [2, 2, 99, -1], 0.5);
    expect(newFaces).toEqual([2]);
    expectSound(mesh, box);
  });
});

describe("insetFaces", () => {
  it("insets quads with exact UVs and inherited materials", () => {
    const box = markedBox();
    const { mesh } = insetFaces(box, [0], 0.25);
    expectSound(mesh, box);
    expect(mesh.faces).toHaveLength(10);
    // The border quad along the face's first edge keeps that edge's UVs.
    expect(mesh.faceUVs![6].slice(0, 2)).toEqual(box.faceUVs![0].slice(0, 2));
    // Inner corner 0: a quarter of the way from corner 0's UV to the UV centroid.
    const uvs = box.faceUVs![0];
    const cu = uvs.reduce((s, uv) => s + uv[0], 0) / 4;
    expect(mesh.faceUVs![0][0][0]).toBeCloseTo(uvs[0][0] + (cu - uvs[0][0]) * 0.25, 9);
    expect(mesh.faceMaterials!.slice(6)).toEqual([0, 0, 0, 0]);
  });

  it("insets triangles and n-gons too", () => {
    const shape: QuadMesh = {
      positions: [[0, 0, 0], [1, 0, 0], [1.5, 1, 0], [0.5, 1.5, 0], [-0.5, 1, 0], [0.5, -1, 0]],
      faces: [[0, 1, 2, 3, 4], [1, 0, 5]],
    };
    const { mesh } = insetFaces(shape, [0, 1], 0.2);
    expectSound(mesh, shape);
    expect(mesh.faces).toHaveLength(2 + 5 + 3);
    expect(mesh.faces[0]).toHaveLength(5);
    expect(mesh.faces[1]).toHaveLength(3);
  });
});

describe("loopCut", () => {
  it("cuts the full ring around a box", () => {
    const box = markedBox();
    const { mesh, newVertexIndices } = loopCut(box, [4, 5], 1);
    expectSound(mesh, box);
    expect(mesh.faces).toHaveLength(10);
    expect(newVertexIndices).toHaveLength(4);
  });

  it("shares vertices between neighbours at an off-centre ratio", () => {
    // Measured per face, 0.3 from one end put neighbours' cuts at 0.3 and 0.7
    // of their shared edge: two vertices where there should be one, and a
    // crack all the way around.
    const box = createQuadBox();
    const { mesh, newVertexIndices } = loopCut(box, [4, 5], 0.3);
    expectSound(mesh, box);
    expect(newVertexIndices).toHaveLength(4);
    // The cut sits 0.3 along the start edge 4 → 5 (x from -0.5 to 0.5).
    const xs = newVertexIndices.map((v) => mesh.positions[v]).filter((p) => p[1] === -0.5 && p[2] === 0.5);
    expect(xs[0]?.[0]).toBeCloseTo(-0.2, 9);
  });

  it("splits an open strip in both directions from the start edge", () => {
    // Three quads stacked vertically; start on the edge between the first two.
    const strip = createQuadPlane(1, 3, 1, 3);
    const { mesh, newVertexIndices } = loopCut(strip, [2, 3], 1);
    expectSound(mesh, strip);
    expect(mesh.faces).toHaveLength(6);
    expect(newVertexIndices).toHaveLength(4);
    expect(getLoopCutPreviewSegments(strip, [2, 3], 1)).toHaveLength(3);
  });

  it("interpolates UVs along the cut", () => {
    const plane = createQuadPlane(1, 1, 1, 1); // per-vertex uvs, one quad
    const { mesh } = loopCut(plane, [0, 1], 1);
    const all = mesh.faceUVs!.flat();
    expect(all.some(([u, v]) => Math.abs(u - 0.5) < 1e-9 && v === 0)).toBe(true);
    expect(all.some(([u, v]) => Math.abs(u - 0.5) < 1e-9 && v === 1)).toBe(true);
  });

  it("stops at triangles", () => {
    const mixed: QuadMesh = {
      positions: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [2, 0.5, 0]],
      faces: [[0, 1, 2, 3], [1, 4, 2]],
    };
    const { mesh } = loopCut(mixed, [0, 1], 1);
    expectSound(mesh, withFaceUVs(mixed));
    expect(mesh.faces).toHaveLength(3);
  });
});

describe("deleteFaces / extractFaces", () => {
  it("carry materials and UVs with the faces they keep", () => {
    const box = markedBox();
    const rest = deleteFaces(box, [1, 3]);
    expect(validateQuadMesh(rest).errors).toEqual([]);
    expect(rest.faceMaterials).toEqual([0, 2, 4, 5]);
    expect(rest.faceUVs![1]).toEqual(box.faceUVs![2]);

    const piece = extractFaces(box, [3]);
    expect(piece.faceMaterials).toEqual([3]);
    expect(piece.positions).toHaveLength(4);
  });
});

describe("quadMeshToBufferGeometry materials", () => {
  it("emits one group per material slot", () => {
    const box = cloneQuadMesh(createQuadBox());
    box.faceMaterials = [0, 1, 0, 1, 0, 2];
    const geometry = quadMeshToBufferGeometry(box);
    expect(geometry.groups.map((g) => g.materialIndex)).toEqual([0, 1, 2]);
    expect(geometry.groups.map((g) => g.count)).toEqual([18, 12, 6]);
    expect(quadMeshToBufferGeometry(createQuadBox()).groups).toEqual([]);
  });
});
