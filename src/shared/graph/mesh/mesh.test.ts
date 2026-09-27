import { describe, it, expect } from "vitest";
import { createQuadBox, createQuadPlane, QuadMesh } from "../quadMesh";
import { buildTopology } from "./topology";
import { validateQuadMesh } from "./validate";
import { triangulateFace } from "./triangulate";

type V3 = [number, number, number];

/** Signed area of a triangle projected on Z — positive when counter-clockwise seen from +Z. */
const areaZ = (p: V3[], [a, b, c]: number[]) =>
  ((p[b][0] - p[a][0]) * (p[c][1] - p[a][1]) - (p[b][1] - p[a][1]) * (p[c][0] - p[a][0])) / 2;

describe("buildTopology", () => {
  it("links every edge of a closed box to its twin", () => {
    const topo = buildTopology(createQuadBox());
    expect(topo.edges).toHaveLength(12);
    expect(topo.heOrigin).toHaveLength(24);
    for (let h = 0; h < 24; h++) {
      const t = topo.heTwin[h];
      expect(t).toBeGreaterThanOrEqual(0);
      expect(topo.heTwin[t]).toBe(h);
      // Twins run opposite ways along the same edge.
      expect(topo.heOrigin[t]).toBe(topo.heOrigin[topo.heNext[h]]);
      expect(topo.heEdge[t]).toBe(topo.heEdge[h]);
    }
    expect(topo.nonManifoldEdgeCount).toBe(0);
    expect(topo.inconsistentEdgeCount).toBe(0);
    expect(topo.vertexFaces(6).sort()).toEqual([0, 2, 4]);
  });

  it("marks boundary edges on an open grid", () => {
    const topo = buildTopology(createQuadPlane(1, 1, 2, 2));
    let boundary = 0;
    for (let e = 0; e < topo.edges.length; e++) if (topo.isBoundaryEdge(e)) boundary++;
    expect(boundary).toBe(8);
    expect(topo.findHalfedge(0, 1)).toBeGreaterThanOrEqual(0);
    expect(topo.findHalfedge(1, 0)).toBe(-1); // boundary: no face runs 1 → 0
  });

  it("counts non-manifold and flipped edges instead of linking them", () => {
    const fin: QuadMesh = {
      positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1]],
      faces: [[0, 1, 2], [1, 0, 3], [0, 1, 4]],
    };
    expect(buildTopology(fin).nonManifoldEdgeCount).toBe(1);

    const flipped: QuadMesh = {
      positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0]],
      faces: [[0, 1, 2], [0, 1, 3]],
    };
    const topo = buildTopology(flipped);
    expect(topo.inconsistentEdgeCount).toBe(1);
    expect(topo.heTwin[0]).toBe(-1);
  });
});

describe("validateQuadMesh", () => {
  it("passes a sound mesh", () => {
    const report = validateQuadMesh(createQuadBox());
    expect(report).toEqual({ errors: [], boundaryEdges: 0, nonManifoldEdges: 0, inconsistentEdges: 0, orphanVertices: 0 });
  });

  it("reports structural faults", () => {
    const broken: QuadMesh = {
      positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [NaN, 0, 0]],
      faces: [[0, 1, 1], [0, 5, 2]],
      faceUVs: [[[0, 0], [1, 0], [0, 1]]],
    };
    const { errors } = validateQuadMesh(broken);
    expect(errors.some((e) => e.includes("vertex 3"))).toBe(true);
    expect(errors.some((e) => e.includes("repeated"))).toBe(true);
    expect(errors.some((e) => e.includes("out of range"))).toBe(true);
    expect(errors.some((e) => e.startsWith("faceUVs"))).toBe(true);
  });
});

describe("triangulateFace", () => {
  it("keeps the 0–2 diagonal on a convex quad", () => {
    const p: V3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    expect(triangulateFace(p, [0, 1, 2, 3])).toEqual([[0, 1, 2], [0, 2, 3]]);
  });

  it("switches diagonal on a concave (dart) quad", () => {
    // Vertex 2 is pushed inward (a reflex corner). Listed so it lands on
    // corner 3, the 0–2 diagonal runs outside the quad and must be avoided.
    const p: V3[] = [[0, 0, 0], [2, 0, 0], [0.5, 0.5, 0], [0, 2, 0]];
    const face = [3, 0, 1, 2];
    const tris = triangulateFace(p, face);
    expect(tris).toEqual([[0, 1, 3], [1, 2, 3]]);
    for (const t of tris) expect(areaZ(p, t.map((i) => face[i]))).toBeGreaterThan(0);
    // And with the reflex vertex on corner 2, 0–2 is the right diagonal.
    expect(triangulateFace(p, [0, 1, 2, 3])).toEqual([[0, 1, 2], [0, 2, 3]]);
  });

  it("ear-clips a concave n-gon with the face's winding and full area", () => {
    // An L shape, counter-clockwise seen from +Z; area 3.
    const p: V3[] = [[0, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0], [1, 2, 0], [0, 2, 0]];
    const face = [0, 1, 2, 3, 4, 5];
    const tris = triangulateFace(p, face);
    expect(tris).toHaveLength(4);
    let area = 0;
    for (const t of tris) {
      const a = areaZ(p, t.map((i) => face[i]));
      expect(a).toBeGreaterThan(0);
      area += a;
    }
    expect(area).toBeCloseTo(3, 9);
  });

  it("works in any plane orientation", () => {
    // The same L shape standing in the XZ plane, wound to face -Y.
    const p: V3[] = [[0, 0, 0], [2, 0, 0], [2, 0, 1], [1, 0, 1], [1, 0, 2], [0, 0, 2]];
    expect(triangulateFace(p, [0, 1, 2, 3, 4, 5])).toHaveLength(4);
  });
});
