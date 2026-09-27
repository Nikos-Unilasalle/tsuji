import { describe, it, expect } from "vitest";
import { createQuadBox, createQuadPlane } from "../quadMesh";
import { validateQuadMesh } from "./validate";
import { knifeCut } from "./knife";

describe("knifeCut", () => {
  it("cuts a quad in two between two edge midpoints", () => {
    const plane = createQuadPlane(1, 1, 1, 1); // [0, 1, 3, 2]
    const { mesh, newEdges, skipped } = knifeCut(plane, [
      { edge: [0, 1], t: 0.5 },
      { edge: [2, 3], t: 0.5 },
    ]);
    expect(skipped).toBe(0);
    expect(newEdges).toHaveLength(1);
    expect(mesh.faces).toHaveLength(2);
    expect(mesh.faces.every((f) => f.length === 4)).toBe(true);
    expect(validateQuadMesh(mesh).errors).toEqual([]);
  });

  it("cuts across two faces of a box, keeping it closed", () => {
    const box = createQuadBox();
    // Front-bottom edge → front-top edge → back-top edge: down the front, over the top.
    const { mesh, newEdges, skipped } = knifeCut(box, [
      { edge: [4, 5], t: 0.5 },
      { edge: [6, 7], t: 0.5 },
      { edge: [2, 3], t: 0.5 },
    ]);
    expect(skipped).toBe(0);
    expect(newEdges).toHaveLength(2);
    const r = validateQuadMesh(mesh);
    expect(r.errors).toEqual([]);
    expect(r.boundaryEdges).toBe(0);
    expect(r.inconsistentEdges).toBe(0);
    expect(mesh.faces).toHaveLength(8);
  });

  it("cuts a diagonal between two vertices", () => {
    const box = createQuadBox();
    const { mesh } = knifeCut(box, [{ vertex: 4 }, { vertex: 6 }]);
    expect(mesh.faces.filter((f) => f.length === 3)).toHaveLength(2);
    expect(validateQuadMesh(mesh).boundaryEdges).toBe(0);
  });

  it("places two cuts on the same edge in order", () => {
    const plane = createQuadPlane(1, 1, 1, 1);
    const { mesh } = knifeCut(plane, [
      { edge: [0, 1], t: 0.25 },
      { edge: [2, 3], t: 0.25 },
      { edge: [2, 3], t: 0.75 },
      { edge: [0, 1], t: 0.75 },
    ]);
    expect(validateQuadMesh(mesh).errors).toEqual([]);
    expect(mesh.faces).toHaveLength(3);
  });

  it("skips a segment whose points share no face", () => {
    const box = createQuadBox();
    // Front-bottom edge to back-top edge: no common face.
    const { skipped } = knifeCut(box, [{ edge: [4, 5], t: 0.5 }, { edge: [2, 3], t: 0.5 }]);
    expect(skipped).toBe(1);
  });
});
