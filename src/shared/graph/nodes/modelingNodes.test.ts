import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createQuadBox } from "../quadMesh";
import { polyMeshToGeometry, readPolyMesh } from "../mesh/polyIO";
import { readAttribute, setGroup } from "../mesh/polyAttributes";
import { joinMeshes } from "../mesh/join";
import { JOIN_NODE, MATERIAL_BY_GROUP_NODE } from "./modelingNodes";

const ctx = (id: string) => ({ time: 0, step: 0, nodeId: id });
const obj = (m = createQuadBox()) => new THREE.Mesh(polyMeshToGeometry(m), new THREE.MeshStandardMaterial({ color: 0xff0000 }));

describe("join", () => {
  it("unites meshes and their attributes", () => {
    const a = setGroup(createQuadBox(), "face", "ga", [1, 0, 0, 0, 0, 0]);
    const b = setGroup(createQuadBox(), "point", "gb", [1, 1, 0, 0, 0, 0, 0, 0]);
    const j = joinMeshes([a, b], "src");
    expect(j.faces.length).toBe(12);
    expect(j.attributes!.face!.ga.data).toHaveLength(12);
    expect(j.attributes!.point!.gb.data).toHaveLength(16);
    expect(j.attributes!.face!.src.data.slice(6)).toEqual([1, 1, 1, 1, 1, 1]);
  });
  it("node places the other input where it is", () => {
    const b = obj();
    b.position.set(5, 0, 0);
    b.updateMatrix();
    const out = JOIN_NODE.evaluate({ geometry: obj(), b }, JOIN_NODE.defaultParams, ctx("join1"));
    const m = readPolyMesh(out.geometry as THREE.Object3D)!.mesh;
    expect(m.faces.length).toBe(12);
    expect(Math.max(...m.positions.map((p) => p[0]))).toBeCloseTo(5.5);
  });
});

describe("material by group", () => {
  it("assigns a new slot to the group and an extra material", () => {
    const src = obj(setGroup(createQuadBox(), "face", "selected", [1, 1, 0, 0, 0, 0]));
    const material = { color: new THREE.Color(0x00ff00), emissive: new THREE.Color(0), emissiveIntensity: 1, shadeless: false, roughness: 0.5, metalness: 0, wireframe: false, opacity: 1, transmission: 0, thickness: 0.5 };
    const out = MATERIAL_BY_GROUP_NODE.evaluate({ geometry: src, material }, MATERIAL_BY_GROUP_NODE.defaultParams, ctx("mbg1"));
    const mesh = out.geometry as THREE.Mesh;
    expect(Array.isArray(mesh.material)).toBe(true);
    expect((mesh.material as THREE.Material[]).length).toBe(2);
    const idx = readAttribute(readPolyMesh(mesh)!.mesh, "face", "material_index")!.values;
    expect(Array.from(idx)).toEqual([1, 1, 0, 0, 0, 0]);
    expect(mesh.geometry.groups.length).toBe(2);
  });
});
