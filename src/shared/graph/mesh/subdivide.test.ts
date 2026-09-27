import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { createQuadBox, createQuadPlane, quadMeshToBufferGeometry, cloneQuadMesh } from "../quadMesh";
import { validateQuadMesh } from "./validate";
import { catmullClarkQuadMesh } from "./subdivide";
import { setEdgeCrease, setEdgeFlag } from "./attributes";
import { getTopology } from "./topology";
import { SUBDIVIDE_NODE } from "../nodes/subdivide";
import { EvalContext } from "../types";

const allEdges = (m: ReturnType<typeof createQuadBox>) => getTopology(m).edges.map(([a, b]) => [a, b] as [number, number]);

describe("catmullClarkQuadMesh", () => {
  it("turns a cube into 24 quads, closed, rounded inward", () => {
    const out = catmullClarkQuadMesh(createQuadBox(2, 2, 2), 1);
    expect(out.faces).toHaveLength(24);
    expect(out.positions).toHaveLength(8 + 6 + 12);
    expect(out.faces.every((f) => f.length === 4)).toBe(true);
    const r = validateQuadMesh(out);
    expect(r.errors).toEqual([]);
    expect(r.boundaryEdges).toBe(0);
    expect(r.inconsistentEdges).toBe(0);
    // A cube corner moves to (5/9) of the way: (1,1,1) → (5/9, 5/9, 5/9).
    expect(out.positions[6][0]).toBeCloseTo(5 / 9, 9);
  });

  it("keeps fully creased edges hard", () => {
    const box = createQuadBox(2, 2, 2);
    const out = catmullClarkQuadMesh(setEdgeCrease(box, allEdges(box), 1), 2);
    // Every vertex stays on the cube's surface: the shape doesn't round off.
    for (const p of out.positions) expect(Math.max(...p.map(Math.abs))).toBeCloseTo(1, 9);
    expect(out.edgeCreases!.length).toBe(12 * 4);
  });

  it("keeps an open grid flat, its border on the border line", () => {
    const out = catmullClarkQuadMesh(createQuadPlane(2, 2, 2, 2), 1);
    for (const p of out.positions) expect(p[2]).toBeCloseTo(0, 9);
    // A mid-border vertex stays on its border; a corner rounds off along
    // the diagonal, as a subdivided plane does in Blender.
    expect(out.positions[1]).toEqual([0, -1, 0]);
    expect(out.positions[0][0]).toBeCloseTo(out.positions[0][1], 9);
  });

  it("subdivides n-gons and triangles into quads", () => {
    const shape = { positions: [[0, 0, 0], [1, 0, 0], [1.5, 1, 0], [0.5, 1.5, 0], [-0.5, 1, 0]] as [number, number, number][], faces: [[0, 1, 2, 3, 4]] };
    expect(catmullClarkQuadMesh(shape, 1).faces).toHaveLength(5);
  });

  it("hands sharp edges on to both halves", () => {
    const out = catmullClarkQuadMesh(setEdgeFlag(createQuadBox(), "sharpEdges", [[6, 7]]), 1);
    expect(out.sharpEdges).toHaveLength(2);
  });
});

describe("Subdivide node on an Edit Mesh cage", () => {
  const ctx = { time: 0, step: 0, nodeId: "subdiv-quad" } as EvalContext;
  const run = (geometry: THREE.BufferGeometry) =>
    SUBDIVIDE_NODE.evaluate({ geometry: new THREE.Mesh(geometry) }, { mode: "catmull-clark", levels: 1 }, ctx).geometry as THREE.Mesh;

  it("subdivides the quads, not triangles, and follows vertex edits", () => {
    const maxX = (m: THREE.Mesh) => {
      m.geometry.computeBoundingBox();
      return m.geometry.boundingBox!.max.x;
    };
    const box = createQuadBox();
    const first = run(quadMeshToBufferGeometry(box));
    expect((first.geometry.userData.quadMesh.faces as number[][]).length).toBe(24);
    const before = maxX(first);

    // Same topology, one vertex moved: the output must change.
    const moved = cloneQuadMesh(box);
    moved.positions[6] = [2, 2, 2];
    const second = run(quadMeshToBufferGeometry(moved));
    expect(maxX(second)).toBeGreaterThan(before + 0.1);
  });
});
