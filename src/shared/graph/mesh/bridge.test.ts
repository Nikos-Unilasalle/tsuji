import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { createQuadBox, QuadMesh, computeFaceNormal, computeFaceCentroid } from "../quadMesh";
import { validateQuadMesh } from "./validate";
import { bridgeEdgeLoops, bridgeFaces, edgeChains, spinEdges } from "./bridge";

/** Two separate open boxes (no top on the lower one, no bottom on the upper one), stacked with a gap. */
function stackedOpenBoxes(): QuadMesh {
  const lower = createQuadBox();
  const upper = createQuadBox();
  const positions = [...lower.positions, ...upper.positions.map(([x, y, z]) => [x, y + 2, z] as [number, number, number])];
  const faces = [
    ...lower.faces.filter((_, f) => f !== 2), // drop top
    ...upper.faces.filter((_, f) => f !== 3).map((f) => f.map((v) => v + 8)), // drop bottom
  ];
  return { positions, faces };
}

describe("edgeChains", () => {
  it("orders loops and open chains, and refuses branches", () => {
    const chains = edgeChains([[1, 2], [0, 1], [5, 6], [6, 7], [7, 5]])!;
    expect(chains.find((c) => !c.closed)!.verts).toEqual([0, 1, 2]);
    expect(chains.find((c) => c.closed)!.verts).toHaveLength(3);
    expect(edgeChains([[0, 1], [0, 2], [0, 3]])).toBeNull();
  });
});

describe("bridgeEdgeLoops", () => {
  it("joins two open boxes into one closed shape", () => {
    const mesh = stackedOpenBoxes();
    const loops: [number, number][] = [[7, 6], [6, 2], [2, 3], [3, 7], [8, 9], [9, 13], [13, 12], [12, 8]];
    const { mesh: out, newFaces, error } = bridgeEdgeLoops(mesh, loops);
    expect(error).toBeUndefined();
    expect(newFaces).toHaveLength(4);
    const r = validateQuadMesh(out);
    expect(r.errors).toEqual([]);
    expect(r.boundaryEdges).toBe(0);
    expect(r.inconsistentEdges).toBe(0);
    expect(r.nonManifoldEdges).toBe(0);
    // Straight up the sides, not twisted: every bridge face is vertical.
    for (const f of newFaces) expect(Math.abs(computeFaceNormal(out.positions, out.faces[f]).y)).toBeLessThan(1e-9);
  });

  it("refuses mismatched loops", () => {
    const mesh = stackedOpenBoxes();
    expect(bridgeEdgeLoops(mesh, [[7, 6], [6, 2], [8, 9], [9, 13], [13, 12]]).error).toBeDefined();
  });
});

describe("bridgeFaces", () => {
  it("tunnels through a box", () => {
    // A box extruded into a thick slab would be closer to real use; a plain
    // box's front and back faces make the same tunnel.
    const box = createQuadBox();
    const { mesh, newFaces, error } = bridgeFaces(box, [0, 1]);
    expect(error).toBeUndefined();
    expect(newFaces).toHaveLength(4);
    const r = validateQuadMesh(mesh);
    expect(r.errors).toEqual([]);
    expect(r.boundaryEdges).toBe(0);
    expect(r.inconsistentEdges).toBe(0);
    expect(mesh.faces).toHaveLength(6 - 2 + 4);
  });

});

describe("spinEdges", () => {
  // A profile in the XY plane: from the axis out and up — a cup's section.
  const profile = (): QuadMesh => ({
    positions: [[0, 0, 0], [1, 0, 0], [1, 1, 0]],
    faces: [],
  });

  it("lathes a full turn into a closed-bottom cup", () => {
    const { mesh, newFaces } = spinEdges(profile(), [[0, 1], [1, 2]], "y", 360, 12);
    const r = validateQuadMesh(mesh);
    expect(r.errors).toEqual([]);
    expect(r.inconsistentEdges).toBe(0);
    expect(r.nonManifoldEdges).toBe(0);
    // Bottom: 12 triangles meeting on the axis; side: 12 quads.
    expect(newFaces).toHaveLength(24);
    expect(mesh.faces.filter((f) => f.length === 3)).toHaveLength(12);
    // Only the rim is open.
    expect(r.boundaryEdges).toBe(12);
    // Sides face outward.
    const side = newFaces.map((f) => mesh.faces[f]).find((f) => f.length === 4)!;
    const n = computeFaceNormal(mesh.positions, side);
    const c = computeFaceCentroid(mesh.positions, side);
    expect(n.dot(new THREE.Vector3(c.x, 0, c.z))).toBeGreaterThan(0);
  });

  it("spins a partial turn without closing", () => {
    const { mesh } = spinEdges(profile(), [[1, 2]], "y", 90, 3);
    expect(mesh.faces).toHaveLength(3);
    // The profile's two vertices and three rotated copies of each (the
    // unused vertex 0 is dropped).
    expect(mesh.positions).toHaveLength(2 + 3 * 2);
  });
});
