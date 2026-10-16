import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { isRigNodeType, setInFront } from "./inFront";

const part = () => new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshStandardMaterial());

describe("a rig in front", () => {
  it("draws every part on top and puts back exactly what was there", () => {
    const group = new THREE.Group();
    const a = part();
    const b = part();
    b.renderOrder = 5;
    b.material.depthWrite = false;
    group.add(a, b);

    setInFront(group, true);
    for (const mesh of [a, b]) {
      expect(mesh.material.depthTest).toBe(false);
      expect(mesh.material.depthWrite).toBe(false);
      expect(mesh.renderOrder).toBeGreaterThan(100);
    }

    setInFront(group, false);
    expect([a.material.depthTest, a.material.depthWrite, a.renderOrder]).toEqual([true, true, 0]);
    expect([b.material.depthTest, b.material.depthWrite, b.renderOrder]).toEqual([true, false, 5]);
  });

  it("covers parts added later and does not forget the original on a second call", () => {
    const group = new THREE.Group();
    const a = part();
    group.add(a);
    setInFront(group, true);
    setInFront(group, true);
    const late = part();
    group.add(late);
    setInFront(group, true);
    expect(late.material.depthTest).toBe(false);
    setInFront(group, false);
    expect(a.material.depthTest).toBe(true);
    expect(late.material.depthTest).toBe(true);
  });

  it("handles material arrays and objects with no material", () => {
    const group = new THREE.Group();
    const multi = new THREE.Mesh(new THREE.BoxGeometry(), [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()]);
    group.add(multi, new THREE.Object3D());
    setInFront(group, true);
    expect((multi.material as THREE.Material[]).every((m) => !m.depthTest)).toBe(true);
    setInFront(group, false);
    expect((multi.material as THREE.Material[]).every((m) => m.depthTest)).toBe(true);
  });

  it("knows the rig nodes, and that Skin is not one", () => {
    for (const type of ["rig/human", "rig/polypede", "rig/polypede-motion", "rig/biped-motion", "rig/skeleton"]) expect(isRigNodeType(type)).toBe(true);
    expect(isRigNodeType("rig/skin")).toBe(false);
    expect(isRigNodeType("object/box")).toBe(false);
  });
});
