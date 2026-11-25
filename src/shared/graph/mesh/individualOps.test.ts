import { it, expect } from "vitest";
import { extrudeFacesIndividual, insetRegion } from "./tools";
import { createQuadBox, createQuadPlane, extrudeFaces } from "../quadMesh";

// Individual inset / extrude run in one pass; they must give exactly what
// processing the faces one after another gave (and did in O(n²)).
it("individual inset equals insetting each face in turn", () => {
  for (const [m, faces] of [[createQuadPlane(2, 1.5, 4, 3), [0, 2, 3, 7, 9]], [createQuadBox(), [0, 1, 2, 3, 4, 5]]] as const) {
  const fast = insetRegion(m, [...faces], 0.05, 0.02, true).mesh;
  let seq: any = m;
  for (const f of faces) seq = insetRegion(seq, [f], 0.05, 0.02, false).mesh;
  expect(fast.faces).toEqual(seq.faces);
  fast.positions.forEach((p: number[], i: number) => p.forEach((c, k) => expect(c).toBeCloseTo(seq.positions[i][k], 9)));
  fast.faceUVs!.forEach((uv: any, i: number) => uv.forEach((u: any, k: number) => { expect(u[0]).toBeCloseTo(seq.faceUVs![i][k][0], 9); expect(u[1]).toBeCloseTo(seq.faceUVs![i][k][1], 9); }));
  }
});
it("individual extrude equals extruding each face in turn", () => {
  for (const [m, faces] of [[createQuadPlane(2, 1.5, 4, 3), [0, 1, 2, 5, 9]], [createQuadBox(), [0, 2, 3]]] as const) {
    const fast = extrudeFacesIndividual(m, [...faces], 0.3).mesh;
    let seq: any = m;
    for (const f of faces) seq = extrudeFaces(seq, [f], 0.3).mesh;
    expect(fast.faces).toEqual(seq.faces);
    fast.positions.forEach((p: number[], i: number) => p.forEach((c, k) => expect(c).toBeCloseTo(seq.positions[i][k], 9)));
    expect(fast.faceUVs!.every((uv: any, i: number) => uv.length === fast.faces[i].length)).toBe(true);
  }
});
