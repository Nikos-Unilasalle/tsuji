import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { renderInstanced } from "./instancedRender";

describe("renderInstanced", () => {
  it("draws N placements of one template as a single InstancedMesh", () => {
    const template = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const group = new THREE.Group();
    const items = [0, 1, 2].map((i) => ({
      template,
      matrix: new THREE.Matrix4().makeTranslation(i * 2, 0, 0),
    }));

    renderInstanced("node-1", group, items);

    expect(group.children.length).toBe(1);
    const mesh = group.children[0] as THREE.InstancedMesh;
    expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
    expect(mesh.count).toBe(3);

    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    mesh.getMatrixAt(2, m);
    m.decompose(pos, new THREE.Quaternion(), new THREE.Vector3());
    expect(pos.x).toBeCloseTo(4);
  });

  it("carries per-instance color via instanceColor", () => {
    const template = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff }));
    const group = new THREE.Group();
    const red = new THREE.Color(1, 0, 0);
    const blue = new THREE.Color(0, 0, 1);

    renderInstanced("node-2", group, [
      { template, matrix: new THREE.Matrix4(), color: red },
      { template, matrix: new THREE.Matrix4(), color: blue },
    ]);

    const mesh = group.children[0] as THREE.InstancedMesh;
    expect(mesh.instanceColor).not.toBeNull();
    const c = new THREE.Color();
    mesh.getColorAt(0, c);
    expect(c.r).toBeCloseTo(1);
    expect(c.b).toBeCloseTo(0);
    mesh.getColorAt(1, c);
    expect(c.r).toBeCloseTo(0);
    expect(c.b).toBeCloseTo(1);
  });

  it("buckets a compound template into one InstancedMesh per mesh, preserving each part's local offset", () => {
    const partA = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const partB = new THREE.Mesh(new THREE.SphereGeometry(1));
    partB.matrixAutoUpdate = false;
    partB.matrix.makeTranslation(5, 0, 0);
    partB.updateMatrixWorld(true);
    const compound = new THREE.Group();
    compound.add(partA, partB);
    compound.updateMatrixWorld(true);

    const group = new THREE.Group();
    renderInstanced("node-3", group, [{ template: compound, matrix: new THREE.Matrix4().makeTranslation(10, 0, 0) }]);

    expect(group.children.length).toBe(2);
    const meshes = group.children as THREE.InstancedMesh[];
    const sphereMesh = meshes.find((m) => m.geometry.type === "SphereGeometry")!;
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    sphereMesh.getMatrixAt(0, m);
    m.decompose(pos, new THREE.Quaternion(), new THREE.Vector3());
    // Placement (10,0,0) + the part's own local offset (5,0,0).
    expect(pos.x).toBeCloseTo(15);
  });

  it("rebuilds cleanly across repeated calls for the same nodeId, disposing the previous meshes", () => {
    const template = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const group = new THREE.Group();

    renderInstanced("node-4", group, [{ template, matrix: new THREE.Matrix4() }]);
    expect(group.children.length).toBe(1);
    expect((group.children[0] as THREE.InstancedMesh).count).toBe(1);

    renderInstanced("node-4", group, [
      { template, matrix: new THREE.Matrix4() },
      { template, matrix: new THREE.Matrix4() },
    ]);
    expect(group.children.length).toBe(1);
    expect((group.children[0] as THREE.InstancedMesh).count).toBe(2);
  });

  it("applies template transformation matrix (location, rotation, scale) to instances", () => {
    const template = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    template.position.set(2, 3, 4);
    template.scale.set(2, 2, 2);
    template.updateMatrix();

    const group = new THREE.Group();
    renderInstanced("node-5", group, [
      { template, matrix: new THREE.Matrix4().makeTranslation(10, 0, 0) },
    ]);

    const mesh = group.children[0] as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(0, m);

    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    m.decompose(pos, new THREE.Quaternion(), scale);

    expect(pos.x).toBeCloseTo(12); // 10 + 2
    expect(pos.y).toBeCloseTo(3);
    expect(pos.z).toBeCloseTo(4);
    expect(scale.x).toBeCloseTo(2);
    expect(scale.y).toBeCloseTo(2);
    expect(scale.z).toBeCloseTo(2);
  });

  it("applies template pivot offset and transformation matrix together", () => {
    const template = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 2, 16));
    // Pivot at base of cylinder (local y = -1)
    template.userData.pivot = new THREE.Vector3(0, -1, 0);
    // Scale height by 2
    template.scale.set(1, 2, 1);
    template.updateMatrix();

    const group = new THREE.Group();
    renderInstanced("node-6", group, [
      { template, matrix: new THREE.Matrix4().makeTranslation(5, 10, 0) },
    ]);

    const mesh = group.children[0] as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(0, m);

    // The pivot point in geometry coords is (0, -1, 0).
    // Under m, this pivot point should land at exactly the placement translation (5, 10, 0).
    const pivotWorld = new THREE.Vector3(0, -1, 0).applyMatrix4(m);
    expect(pivotWorld.x).toBeCloseTo(5);
    expect(pivotWorld.y).toBeCloseTo(10);
    expect(pivotWorld.z).toBeCloseTo(0);
  });
});
