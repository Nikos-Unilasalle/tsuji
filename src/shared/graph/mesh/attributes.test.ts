import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { createQuadBox, createQuadPlane, deleteFaces, loopCut, quadMeshToBufferGeometry } from "../quadMesh";
import { paintCorners, setEdgeCrease, setEdgeFlag } from "./attributes";
import { compactMesh, mergeVertices, subdivideFaces } from "./tools";

/** Normals of the output vertices sitting at `p` whose normal is closest to `dir`. */
function normalAt(geometry: THREE.BufferGeometry, p: [number, number, number], dir: THREE.Vector3): THREE.Vector3 {
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  let best = new THREE.Vector3();
  let bestDot = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    if (Math.hypot(pos.getX(i) - p[0], pos.getY(i) - p[1], pos.getZ(i) - p[2]) > 1e-6) continue;
    const n = new THREE.Vector3(nor.getX(i), nor.getY(i), nor.getZ(i));
    if (n.dot(dir) > bestDot) {
      bestDot = n.dot(dir);
      best = n;
    }
  }
  return best;
}

describe("sharp edges", () => {
  it("keep a smooth-shaded corner hard where they fence a face off", () => {
    const box = createQuadBox();
    const smooth = quadMeshToBufferGeometry(box, "smooth");
    const front = new THREE.Vector3(0, 0, 1);
    // Unmarked: the front face's corner at vertex 6 blends three faces.
    expect(normalAt(smooth, [0.5, 0.5, 0.5], front).z).toBeCloseTo(1 / Math.sqrt(3), 6);
    // Both of the front face's edges at vertex 6 sharp: that corner is flat.
    const marked = setEdgeFlag(box, "sharpEdges", [[6, 7], [5, 6]]);
    const hard = quadMeshToBufferGeometry(marked, "smooth");
    expect(normalAt(hard, [0.5, 0.5, 0.5], front).z).toBeCloseTo(1, 6);
  });

  it("follow the edge through renumbering and splits", () => {
    const box = setEdgeFlag(createQuadBox(), "sharpEdges", [[6, 7]]);
    // Deleting the bottom keeps every vertex: still marked.
    expect(deleteFaces(box, [3]).sharpEdges).toEqual([[6, 7]]);
    // A loop cut across it splits it in two.
    const cut = loopCut(box, [4, 5], 1).mesh;
    expect(cut.sharpEdges).toHaveLength(2);
    // Subdividing the top splits it too.
    expect(subdivideFaces(box, [2]).mesh.sharpEdges).toHaveLength(2);
    // Merging its two ends away removes it.
    expect(mergeVertices(box, [6, 7]).mesh.sharpEdges).toEqual([]);
  });

  it("creases are stored with their weight", () => {
    const creased = setEdgeCrease(createQuadBox(), [[7, 6]], 0.5);
    expect(creased.edgeCreases).toEqual([[6, 7, 0.5]]);
    expect(setEdgeCrease(creased, [[6, 7]], 0).edgeCreases).toEqual([]);
  });
});

describe("vertex colours", () => {
  it("paint face corners and reach the geometry", () => {
    const painted = paintCorners(createQuadBox(), [1, 0, 0], { faces: [0] });
    const geometry = quadMeshToBufferGeometry(painted);
    const color = geometry.attributes.color;
    expect(color).toBeDefined();
    let red = 0;
    for (let i = 0; i < color.count; i++) if (color.getX(i) === 1 && color.getY(i) === 0) red++;
    expect(red).toBe(4);
    // No colours: no attribute.
    expect(quadMeshToBufferGeometry(createQuadBox()).attributes.color).toBeUndefined();
  });

  it("stay on their faces through compaction", () => {
    const painted = paintCorners(createQuadPlane(2, 1, 2, 1), [0, 0, 1], { vertices: [0] });
    const { mesh } = compactMesh(deleteFaces(painted, [1]));
    expect(mesh.faceColors![0]![0]).toEqual([0, 0, 1]);
  });
});
