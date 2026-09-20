import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import { createQuadBox, quadMeshToBufferGeometry, QuadMesh } from "../quadMesh";
import { applyWeldedPointMoves, EDIT_MESH_POINTS_NODE } from "./editMeshPoints";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "edit-points-test" };

describe("EDIT_MESH_POINTS_NODE", () => {
  it("passes the basis through unedited before pointsList is seeded", () => {
    const basis = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const res = EDIT_MESH_POINTS_NODE.evaluate({ basis }, { pointsList: [] }, CTX);
    expect(res.geometry).toBe(basis);
  });

  it("rebuilds the mesh from an edited pointsList once seeded", () => {
    const basis = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    const posAttr = basis.geometry.attributes.position;
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < posAttr.count; i++) points.push(new THREE.Vector3().fromBufferAttribute(posAttr, i));
    // Move just the first vertex.
    points[0] = points[0].clone().add(new THREE.Vector3(5, 0, 0));

    const res = EDIT_MESH_POINTS_NODE.evaluate({ basis }, { pointsList: points }, CTX);
    const outMesh = res.geometry as THREE.Mesh;
    const outPos = outMesh.geometry.attributes.position;
    expect(outPos.getX(0)).toBeCloseTo(points[0].x);
    expect(outPos.getX(1)).toBeCloseTo(posAttr.getX(1));
  });

  it("synchronizes geometry.userData.quadMesh positions when basis geometry carries a quadMesh", () => {
    const quadBox = createQuadBox(2, 2, 2);
    const geom = quadMeshToBufferGeometry(quadBox);
    const basis = new THREE.Mesh(geom);
    const posAttr = basis.geometry.attributes.position;
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < posAttr.count; i++) points.push(new THREE.Vector3().fromBufferAttribute(posAttr, i));

    const targetIdx = 0;
    const origPos = points[targetIdx].clone();
    const moves = new Map([[targetIdx, origPos.clone().add(new THREE.Vector3(5, 0, 0))]]);
    const movedPoints = applyWeldedPointMoves(points, moves);

    const res = EDIT_MESH_POINTS_NODE.evaluate({ basis }, { pointsList: movedPoints }, CTX);
    const outMesh = res.geometry as THREE.Mesh;
    expect(outMesh.geometry.userData.quadMesh).toBeDefined();
    const updatedQuad = outMesh.geometry.userData.quadMesh as QuadMesh;
    const matching = updatedQuad.positions.some(
      (p) => Math.abs(p[0] - (origPos.x + 5)) < 1e-4 && Math.abs(p[1] - origPos.y) < 1e-4 && Math.abs(p[2] - origPos.z) < 1e-4,
    );
    expect(matching).toBe(true);
  });

  it("passes through unchanged (with a warning, not a crash) when pointsList no longer matches the basis's vertex count", () => {
    const basis = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)); // 24 verts
    const stalePoints = [new THREE.Vector3(0, 0, 0)]; // seeded from some other mesh

    const res = EDIT_MESH_POINTS_NODE.evaluate({ basis }, { pointsList: stalePoints }, CTX);
    expect(res.geometry).toBe(basis);
  });

  it("returns null with nothing wired into Basis", () => {
    const res = EDIT_MESH_POINTS_NODE.evaluate({}, { pointsList: [] }, CTX);
    expect(res.geometry).toBeNull();
  });
});

describe("applyWeldedPointMoves", () => {
  /** A corner shared by three faces, plus one unrelated vertex — a Box's real layout in miniature. */
  const corner = () => [
    new THREE.Vector3(1, 1, 1),
    new THREE.Vector3(1, 1, 1),
    new THREE.Vector3(1, 1, 1),
    new THREE.Vector3(-1, 0, 0),
  ];

  it("drags every vertex coincident with the moved one, so a corner doesn't tear apart", () => {
    const moved = applyWeldedPointMoves(corner(), new Map([[0, new THREE.Vector3(1, 5, 1)]]));
    // All three entries of that corner followed...
    for (const i of [0, 1, 2]) expect(moved[i].y).toBeCloseTo(5);
    // ...and the unrelated vertex stayed put.
    expect(moved[3].x).toBeCloseTo(-1);
    expect(moved[3].y).toBeCloseTo(0);
  });

  it("applies exactly one delta to a welded vertex even when several of its coincident twins move together", () => {
    // A marquee inevitably grabs all of a corner's stacked handles; indices
    // 0 and 1 both move by +4 in Y, index 2 must end up +4 too, not +8.
    const moves = new Map([
      [0, new THREE.Vector3(1, 5, 1)],
      [1, new THREE.Vector3(1, 5, 1)],
    ]);
    const moved = applyWeldedPointMoves(corner(), moves);
    expect(moved[2].y).toBeCloseTo(5);
  });

  it("leaves distinct vertices alone — welding never merges points that only happen to be nearby", () => {
    const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.01, 0, 0)];
    const moved = applyWeldedPointMoves(points, new Map([[0, new THREE.Vector3(0, 3, 0)]]));
    expect(moved[0].y).toBeCloseTo(3);
    expect(moved[1].y).toBeCloseTo(0);
  });

  it("reads plain {x,y,z} objects, the form a saved .tsuji round-trips pointsList as", () => {
    const raw = [{ x: 2, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }];
    const moved = applyWeldedPointMoves(raw, new Map([[0, new THREE.Vector3(2, 7, 0)]]));
    expect(moved[0]).toBeInstanceOf(THREE.Vector3);
    expect(moved[1].y).toBeCloseTo(7);
  });
});
