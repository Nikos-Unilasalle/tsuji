import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { EvalContext, NodeDefinition } from "../types";
import { createQuadBox, createQuadPlane, type PolyMesh } from "../quadMesh";
import { polyMeshToGeometry, readPolyMesh } from "../mesh/polyIO";
import { readAttribute } from "../mesh/polyAttributes";
import {
  GROUP_COMBINE_NODE,
  GROUP_EXPAND_NODE,
  GROUP_PATH_NODE,
  SELECT_DISTANCE_NODE,
  SELECT_MEASURE_NODE,
  SELECT_NODE,
  SELECT_TOPOLOGY_NODE,
} from "./selectNodes";

let n = 0;
const ctx = (): EvalContext => ({ time: 0, step: 0, nodeId: `sel-${n++}` });
const meshObj = (m: PolyMesh) => new THREE.Mesh(polyMeshToGeometry(m), new THREE.MeshStandardMaterial());

function run(def: NodeDefinition, input: THREE.Object3D, params: Record<string, unknown>, inputs: Record<string, unknown> = {}) {
  const out = def.evaluate({ geometry: input, ...inputs }, { ...def.defaultParams, ...params }, ctx());
  const mesh = readPolyMesh(out.geometry as THREE.Object3D)!.mesh;
  return { out, mesh };
}
const group = (m: PolyMesh, domain: "point" | "edge" | "face", name: string) =>
  Array.from(readAttribute(m, domain, name)?.values ?? []).map((v) => (v ? 1 : 0));

describe("Select", () => {
  it("box selects the top face", () => {
    const { out, mesh } = run(SELECT_NODE, meshObj(createQuadBox()), { mode: "box", center: new THREE.Vector3(0, 0.5, 0), size: new THREE.Vector3(2, 0.2, 2), name: "top" });
    expect(out.count).toBe(1);
    expect(group(mesh, "face", "top").reduce((a, b) => a + b)).toBe(1);
  });
  it("normal mode, inverted, intersect", () => {
    const base = meshObj(createQuadBox());
    const { out } = run(SELECT_NODE, base, { mode: "normal", direction: new THREE.Vector3(0, 1, 0), angle: 10, invert: true });
    expect(out.count).toBe(5);
  });
  it("respects world space", () => {
    const obj = meshObj(createQuadBox());
    obj.position.set(10, 0, 0);
    obj.updateMatrix();
    const { out } = run(SELECT_NODE, obj, { mode: "sphere", center: new THREE.Vector3(10, 0, 0), radius: 2, domain: "point" });
    expect(out.count).toBe(8);
    const { out: local } = run(SELECT_NODE, obj, { mode: "sphere", center: new THREE.Vector3(10, 0, 0), radius: 2, domain: "point", space: "local" });
    expect(local.count).toBe(0);
  });
  it("random is stable as the fraction grows", () => {
    const plane = meshObj(createQuadPlane(1, 1, 10, 10));
    const a = run(SELECT_NODE, plane, { mode: "random", fraction: 0.3 }).out.mask as number[];
    const b = run(SELECT_NODE, plane, { mode: "random", fraction: 0.6 }).out.mask as number[];
    a.forEach((v, i) => v && expect(b[i]).toBe(1));
  });
  it("inside object", () => {
    const plane = meshObj(createQuadPlane(4, 4, 8, 8));
    const box = meshObj(createQuadBox(1, 1, 1));
    const { out } = run(SELECT_NODE, plane, { mode: "inside-object", domain: "point" }, { object: box });
    expect(out.count).toBeGreaterThan(0);
    expect(out.count).toBeLessThan(81);
  });
  it("write modes combine with an existing group", () => {
    const first = run(SELECT_NODE, meshObj(createQuadBox()), { mode: "normal", direction: new THREE.Vector3(0, 1, 0), angle: 10, name: "g" });
    const second = run(SELECT_NODE, first.out.geometry as THREE.Object3D, { mode: "normal", direction: new THREE.Vector3(0, -1, 0), angle: 10, name: "g", write: "add" });
    expect(second.out.count).toBe(2);
  });
});

describe("Select Topology / Measure / Distance", () => {
  it("boundary edges of a plane", () => {
    const { out } = run(SELECT_TOPOLOGY_NODE, meshObj(createQuadPlane(1, 1, 2, 2)), { mode: "boundary", domain: "edge" });
    expect(out.count).toBe(8);
  });
  it("sharp edges of a box", () => {
    expect(run(SELECT_TOPOLOGY_NODE, meshObj(createQuadBox()), { mode: "sharp", angle: 45, domain: "edge" }).out.count).toBe(12);
  });
  it("largest area faces", () => {
    const { out } = run(SELECT_MEASURE_NODE, meshObj(createQuadBox(2, 1, 1)), { measure: "area", relative: true, min: 0.9, max: 1 });
    expect(out.count).toBe(4);
  });
  it("distance weights fall off", () => {
    const { out, mesh } = run(SELECT_DISTANCE_NODE, meshObj(createQuadPlane(2, 2, 4, 4)), { domain: "point", radius: 0.6 });
    expect(out.count).toBeGreaterThan(0);
    const w = readAttribute(mesh, "point", "weight")!.values;
    expect(Math.max(...w)).toBeCloseTo(1);
  });
  it("surface distance", () => {
    const { out } = run(SELECT_DISTANCE_NODE, meshObj(createQuadPlane(2, 2, 4, 4)), { domain: "point", radius: 0.6, metric: "surface" });
    expect(out.count).toBeGreaterThan(0);
  });
});

describe("Groups", () => {
  it("combine, expand and path", () => {
    const top = run(SELECT_NODE, meshObj(createQuadPlane(2, 2, 4, 4)), { mode: "box", center: new THREE.Vector3(0, 0, 0), size: new THREE.Vector3(0.6, 1, 0.6), name: "c" });
    expect(top.out.count).toBe(4);
    const grown = run(GROUP_EXPAND_NODE, top.out.geometry as THREE.Object3D, { source: "c", sourceDomain: "face", mode: "grow", steps: 1, name: "g" });
    expect(grown.out.count).toBe(16);
    const combined = run(GROUP_COMBINE_NODE, grown.out.geometry as THREE.Object3D, { expression: "g & !c", name: "ring" });
    expect(combined.out.count).toBe(12);
    const border = run(GROUP_EXPAND_NODE, top.out.geometry as THREE.Object3D, { source: "c", mode: "border", domain: "edge", name: "b" });
    expect(border.out.count).toBe(8);

    const ends = run(SELECT_NODE, meshObj(createQuadPlane(2, 2, 4, 4)), { mode: "expression", expression: "0", domain: "point", name: "start" });
    const both = run(SELECT_NODE, ends.out.geometry as THREE.Object3D, { mode: "expression", expression: "24", domain: "point", name: "end" });
    const path = run(GROUP_PATH_NODE, both.out.geometry as THREE.Object3D, { mode: "shortest-path" });
    expect((path.out.points as number[])[0]).toBe(0);
    expect(path.out.count).toBeGreaterThanOrEqual(4);
  });
});
