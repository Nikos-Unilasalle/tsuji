import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import { MESH_TO_POINTS_NODE, POINTS_TO_MESH_NODE, mapQuadVerticesToBuffer } from "./pointsGeometry";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "p2g-test" };

describe("MESH_TO_POINTS_NODE", () => {
  it("extracts one point per raw vertex-buffer entry, in local space", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(5, 0, 0); // world offset — should NOT leak into local points

    const res = MESH_TO_POINTS_NODE.evaluate({ geometry: mesh }, {}, CTX);
    const points = res.points as THREE.Vector3[];

    expect(points.length).toBe(mesh.geometry.attributes.position.count);
    // local space: box corners stay within [-0.5, 0.5], not shifted by +5
    expect(Math.max(...points.map((p) => Math.abs(p.x)))).toBeLessThanOrEqual(0.5001);
  });

  it("passes the original geometry through unchanged, for Points to Mesh to rebuild from", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const res = MESH_TO_POINTS_NODE.evaluate({ geometry: mesh }, {}, CTX);
    expect(res.geometry).toBe(mesh);
  });

  it("returns empty output rather than throwing when nothing is wired", () => {
    const res = MESH_TO_POINTS_NODE.evaluate({}, {}, CTX);
    expect(res.points).toEqual([]);
    expect(res.count).toBe(0);
  });

  it("reads through a posed wrapper group (the OBJ Model case), not just the mesh's own identity local matrix", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)); // matrix stays identity
    const wrapper = new THREE.Group();
    wrapper.matrixAutoUpdate = false;
    wrapper.matrix.setPosition(10, -2, 7);
    wrapper.add(mesh);

    const res = MESH_TO_POINTS_NODE.evaluate({ geometry: wrapper }, {}, CTX);
    const pos = new THREE.Vector3().setFromMatrixPosition(res.matrix as THREE.Matrix4);
    expect(pos.x).toBeCloseTo(10);
    expect(pos.y).toBeCloseTo(-2);
    expect(pos.z).toBeCloseTo(7);
    // and points themselves stay in local space (not shifted by the pose)
    const points = res.points as THREE.Vector3[];
    expect(Math.max(...points.map((p) => Math.abs(p.x)))).toBeLessThanOrEqual(0.5001);
  });

  it("an optional Matrix input composes as an outer transform on top of the mesh's own world matrix", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.matrixAutoUpdate = false;
    mesh.matrix.setPosition(1, 0, 0);

    const extra = new THREE.Matrix4().makeTranslation(0, 5, 0);
    const res = MESH_TO_POINTS_NODE.evaluate({ geometry: mesh, matrix: extra }, {}, CTX);
    const pos = new THREE.Vector3().setFromMatrixPosition(res.matrix as THREE.Matrix4);
    expect(pos.x).toBeCloseTo(1);
    expect(pos.y).toBeCloseTo(5);
  });
});

describe("POINTS_TO_MESH_NODE", () => {
  it("round-trips: Mesh to Points -> move one point -> Points to Mesh reflects it", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const extracted = MESH_TO_POINTS_NODE.evaluate({ geometry: mesh }, {}, CTX);
    const points = (extracted.points as THREE.Vector3[]).map((p) => p.clone());
    points[0].y += 10; // displace one vertex far away

    const res = POINTS_TO_MESH_NODE.evaluate(
      { geometry: extracted.geometry, points },
      {},
      { ...CTX, nodeId: "p2g-test-2" },
    );
    const outMesh = res.geometry as THREE.Mesh;
    const newPos = outMesh.geometry.attributes.position;
    expect(newPos.getY(0)).toBeCloseTo(points[0].y, 4);
  });

  it("does not mutate the original mesh's geometry", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const originalY0 = mesh.geometry.attributes.position.getY(0);
    const extracted = MESH_TO_POINTS_NODE.evaluate({ geometry: mesh }, {}, CTX);
    const points = (extracted.points as THREE.Vector3[]).map((p) => p.clone());
    points[0].y += 10;

    POINTS_TO_MESH_NODE.evaluate({ geometry: extracted.geometry, points }, {}, { ...CTX, nodeId: "p2g-test-3" });
    expect(mesh.geometry.attributes.position.getY(0)).toBe(originalY0);
  });

  it("falls back to the unmodified input, with no crash, on a vertex-count mismatch", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const tooFewPoints = [new THREE.Vector3(0, 0, 0)];

    const res = POINTS_TO_MESH_NODE.evaluate({ geometry: mesh, points: tooFewPoints }, {}, { ...CTX, nodeId: "p2g-test-4" });
    expect(res.geometry).toBe(mesh);
  });

  it("returns null rather than throwing when nothing is wired", () => {
    const res = POINTS_TO_MESH_NODE.evaluate({}, {}, { ...CTX, nodeId: "p2g-test-5" });
    expect(res.geometry).toBeNull();
  });

  it("preserves the source's pose through a posed wrapper group (the OBJ Model case)", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)); // matrix stays identity
    const wrapper = new THREE.Group();
    wrapper.matrixAutoUpdate = false;
    wrapper.matrix.setPosition(3, -1, 4);
    wrapper.add(mesh);

    const points = new Array(mesh.geometry.attributes.position.count).fill(0).map((_, i) => {
      const p = new THREE.Vector3();
      p.fromBufferAttribute(mesh.geometry.attributes.position, i);
      return p;
    });

    const res = POINTS_TO_MESH_NODE.evaluate({ geometry: wrapper, points }, {}, { ...CTX, nodeId: "p2g-test-pose" });
    const outMesh = res.geometry as THREE.Mesh;
    const pos = new THREE.Vector3().setFromMatrixPosition(outMesh.matrix);
    expect(pos.x).toBeCloseTo(3);
    expect(pos.y).toBeCloseTo(-1);
    expect(pos.z).toBeCloseTo(4);
  });
});

describe("mapQuadVerticesToBuffer", () => {
  it("maps each quad vertex to the first coincident buffer vertex, else the nearest within reach, else -1", () => {
    const pos = new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 0, 0, 2.004, 0, 0], 3);
    const quad = { positions: [[1, 0, 0], [0, 0, 0], [2, 0, 0], [5, 5, 5]] as [number, number, number][], faces: [] };
    expect(Array.from(mapQuadVerticesToBuffer(quad, pos))).toEqual([1, 0, 3, -1]);
  });
});
