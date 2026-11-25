import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { EvalContext } from "../types";
import { createQuadBox, createQuadPlane, type PolyMesh } from "../quadMesh";
import { polyMeshFromGeometry, polyMeshToGeometry, readPolyMesh } from "../mesh/polyIO";
import { readAttribute, setGroup } from "../mesh/polyAttributes";
import { DELETE_GEOMETRY_NODE, EXTRUDE_MESH_NODE } from "./meshEdit";
import { SELECT_NODE } from "./selectNodes";
import { emitModifiedMesh, createModifierMesh } from "./object";

let n = 0;
const ctx = (): EvalContext => ({ time: 0, step: 0, nodeId: `mep-${n++}` });
const obj = (m: PolyMesh) => new THREE.Mesh(polyMeshToGeometry(m), new THREE.MeshStandardMaterial());
const poly = (o: unknown) => readPolyMesh(o as THREE.Object3D)!.mesh;
const count = (m: PolyMesh, name: string) => Array.from(readAttribute(m, "face", name)?.values ?? []).filter(Boolean).length;

describe("Extrude Mesh — PolyMesh path", () => {
  it("extrudes a group of quads, writing top/side groups and keeping attributes", () => {
    const src = setGroup(createQuadBox(), "face", "top", [0, 0, 0, 0, 0, 0].map((_, i) => (i === 2 ? 1 : 0)));
    const params = { ...EXTRUDE_MESH_NODE.defaultParams, group: "top", distance: 1 };
    const out = poly(EXTRUDE_MESH_NODE.evaluate({ geometry: obj(src) }, params, ctx()).geometry);
    expect(out.faces.length).toBe(10);
    expect(out.faces.every((f) => f.length === 4)).toBe(true);
    expect(count(out, "extrude_top")).toBe(1);
    expect(count(out, "extrude_side")).toBe(4);
    expect(count(out, "top")).toBeGreaterThanOrEqual(1);
  });
  it("multi-pass grows", () => {
    const src = createQuadPlane(1, 1, 1, 1);
    const params = { ...EXTRUDE_MESH_NODE.defaultParams, group: "*", distance: 0.5, passes: 3, scale: 0.8 };
    const out = poly(EXTRUDE_MESH_NODE.evaluate({ geometry: obj(src) }, params, ctx()).geometry);
    expect(out.faces.length).toBe(1 + 3 * 4);
  });
  it("keeps the legacy triangle path when the group is empty", () => {
    const params = { ...EXTRUDE_MESH_NODE.defaultParams, group: "" };
    const out = EXTRUDE_MESH_NODE.evaluate({ geometry: obj(createQuadBox()) }, params, ctx()).geometry as THREE.Mesh;
    expect(out.geometry.userData.quadMesh).toBeUndefined();
  });
  it("new nodes default to the PolyMesh path", () => {
    expect(EXTRUDE_MESH_NODE.newNodeParams?.group).toBe("*");
  });
});

describe("Delete Geometry — PolyMesh path", () => {
  it("deletes a selected group and keeps others", () => {
    const sel = SELECT_NODE.evaluate(
      { geometry: obj(setGroup(createQuadBox(), "face", "keepme", [1, 0, 0, 0, 0, 0])) },
      { ...SELECT_NODE.defaultParams, mode: "normal", direction: new THREE.Vector3(0, 1, 0), angle: 10, name: "top" },
      ctx(),
    );
    const params = { ...DELETE_GEOMETRY_NODE.defaultParams, group: "top", selectMode: "all" };
    const out = poly(DELETE_GEOMETRY_NODE.evaluate({ geometry: sel.geometry }, params, ctx()).geometry);
    expect(out.faces.length).toBe(5);
    expect(count(out, "top")).toBe(0);
    expect(count(out, "keepme")).toBe(1);
  });
  it("deletes points and their faces, or keeps only the selection", () => {
    const plane = createQuadPlane(1, 1, 2, 2);
    const params = { ...DELETE_GEOMETRY_NODE.defaultParams, group: "0", domain: "point", selectMode: "all" };
    const out = poly(DELETE_GEOMETRY_NODE.evaluate({ geometry: obj(plane) }, params, ctx()).geometry);
    expect(out.faces.length).toBe(3);
    const kept = poly(DELETE_GEOMETRY_NODE.evaluate({ geometry: obj(plane) }, { ...params, domain: "face", group: "0", keepSelected: true }, ctx()).geometry);
    expect(kept.faces.length).toBe(1);
  });
});

describe("attribute survival through legacy modifiers", () => {
  it("a scratch-built geometry recovers the source's groups", () => {
    const src = obj(setGroup(createQuadBox(), "face", "g", [1, 0, 0, 0, 0, 0]));
    const fresh = new THREE.BoxGeometry(1, 1, 1);
    const out = createModifierMesh();
    emitModifiedMesh(out, { inputObj: src, srcMesh: src, geometry: fresh, nodeId: "x" });
    const m = polyMeshFromGeometry(out.geometry)!;
    expect(count(m, "g")).toBe(1);
  });
  it("a cloned geometry with a rewritten index is not mistaken for its source", () => {
    const g = polyMeshToGeometry(createQuadBox());
    const c = g.clone();
    c.setIndex(Array.from(c.index!.array).slice(0, 6));
    expect(polyMeshFromGeometry(c)!.faces.length).toBe(1);
  });
});
