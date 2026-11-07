import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { is2DVector, readComponent, resolveExposedField, splitComponentId, withComponent } from "./exposedComponent";
import type { ParamFieldDef } from "./types";

const fields: ParamFieldDef[] = [
  { id: "position", label: "Position", kind: "vector", step: 0.1 },
  { id: "rotation", label: "Rotation", kind: "vector", degrees: true },
  { id: "size", label: "Size", kind: "number" },
];

describe("splitComponentId", () => {
  it("splits an axis off a param id", () => {
    expect(splitComponentId("position.y")).toEqual({ baseId: "position", axis: "y" });
    expect(splitComponentId("position")).toBeNull();
    expect(splitComponentId("a.w")).toBeNull();
  });
});

describe("withComponent", () => {
  it("keeps the vector's shape", () => {
    expect(withComponent([1, 2, 3], "y", 9)).toEqual([1, 9, 3]);
    expect(withComponent({ x: 1, y: 2 }, "x", 5)).toEqual({ x: 5, y: 2 });
    const v = new THREE.Vector3(1, 2, 3);
    const next = withComponent(v, "z", 7);
    expect(next).toBeInstanceOf(THREE.Vector3);
    expect(next).toMatchObject({ x: 1, y: 2, z: 7 });
    expect(v.z).toBe(3);
  });
  it("tells 2D from 3D", () => {
    expect(is2DVector(new THREE.Vector2(1, 2))).toBe(true);
    expect(is2DVector(new THREE.Vector3())).toBe(false);
    expect(is2DVector([1, 2])).toBe(true);
  });
});

describe("resolveExposedField", () => {
  const values = { position: { x: 1, y: 2, z: 3 }, rotation: [0, Math.PI, 0], size: 4 };
  it("resolves a whole param as itself", () => {
    const r = resolveExposedField(fields, values, "size")!;
    expect(r.field.id).toBe("size");
    expect(r.value).toBe(4);
    expect(r.toStored(5)).toBe(5);
  });
  it("resolves an axis as a number writing the whole vector", () => {
    const r = resolveExposedField(fields, values, "position.y")!;
    expect(r.field).toMatchObject({ id: "position.y", kind: "number", label: "Position Y", step: 0.1 });
    expect(r.baseId).toBe("position");
    expect(r.value).toBe(2);
    expect(r.toStored(8)).toEqual({ x: 1, y: 8, z: 3 });
    // A fresher vector (another axis just written) is the one set on.
    expect(r.toStored(8, { x: 6, y: 2, z: 3 })).toEqual({ x: 6, y: 8, z: 3 });
  });
  it("keeps degrees on a rotation axis", () => {
    const r = resolveExposedField(fields, values, "rotation.y")!;
    expect(r.field).toMatchObject({ kind: "number", degrees: true });
    expect(readComponent(values.rotation, "y")).toBeCloseTo(Math.PI);
  });
  it("drops what no longer resolves", () => {
    expect(resolveExposedField(fields, values, "size.x")).toBeNull();
    expect(resolveExposedField(fields, values, "gone")).toBeNull();
  });
});
