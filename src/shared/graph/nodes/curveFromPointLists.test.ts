import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CURVES_FROM_POINT_LISTS_NODE } from "./curveFromPointLists";
import { EvalContext } from "../types";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "curve-lists-test" };

function line(x: number): THREE.Vector3[] {
  return [new THREE.Vector3(x, 0, 0), new THREE.Vector3(x, 1, 0), new THREE.Vector3(x, 2, 0)];
}

describe("CURVES_FROM_POINT_LISTS_NODE", () => {
  it("builds an empty mesh with no lists wired", () => {
    const res = CURVES_FROM_POINT_LISTS_NODE.evaluate({}, CURVES_FROM_POINT_LISTS_NODE.defaultParams, CTX);
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(mesh.geometry.attributes.position?.count ?? 0).toBe(0);
  });

  it("builds one merged mesh from multiple point lists", () => {
    const res = CURVES_FROM_POINT_LISTS_NODE.evaluate(
      { pointLists: [line(0), line(1), line(2)] },
      CURVES_FROM_POINT_LISTS_NODE.defaultParams,
      { ...CTX, nodeId: "curve-lists-multi" },
    );
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh.geometry.attributes.position.count).toBeGreaterThan(0);
  });

  it("skips a sub-list too short to form a curve rather than throwing", () => {
    const res = CURVES_FROM_POINT_LISTS_NODE.evaluate(
      { pointLists: [line(0), [new THREE.Vector3(5, 5, 5)], []] },
      CURVES_FROM_POINT_LISTS_NODE.defaultParams,
      { ...CTX, nodeId: "curve-lists-short" },
    );
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh.geometry.attributes.position.count).toBeGreaterThan(0);
  });

  it("reads a wired material input over color params (extractMaterialParams contract)", () => {
    const res = CURVES_FROM_POINT_LISTS_NODE.evaluate(
      { pointLists: [line(0)], material: { color: new THREE.Color(0x00ff00), roughness: 0.9 } },
      CURVES_FROM_POINT_LISTS_NODE.defaultParams,
      { ...CTX, nodeId: "curve-lists-material" },
    );
    const mesh = res.geometry as THREE.Mesh;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    expect(mat.color.getHex()).toBe(0x00ff00);
    expect(mat.roughness).toBeCloseTo(0.9);
  });

  it("outputs one curve per usable point list", () => {
    const res = CURVES_FROM_POINT_LISTS_NODE.evaluate(
      { pointLists: [line(0), [new THREE.Vector3()], line(2)] },
      CURVES_FROM_POINT_LISTS_NODE.defaultParams,
      { ...CTX, nodeId: "curve-lists-out" },
    );
    const curves = res.curves as THREE.Curve<THREE.Vector3>[];
    expect(curves).toHaveLength(2);
    expect(curves[1].getPoint(0).x).toBeCloseTo(2);
  });

  it("rebuilds geometry only when the signature actually changes", () => {
    const nodeId = "curve-lists-cache";
    const a = CURVES_FROM_POINT_LISTS_NODE.evaluate({ pointLists: [line(0)] }, CURVES_FROM_POINT_LISTS_NODE.defaultParams, { ...CTX, nodeId });
    const geomA = (a.geometry as THREE.Mesh).geometry;
    const b = CURVES_FROM_POINT_LISTS_NODE.evaluate({ pointLists: [line(0)] }, CURVES_FROM_POINT_LISTS_NODE.defaultParams, { ...CTX, nodeId });
    const geomB = (b.geometry as THREE.Mesh).geometry;
    expect(geomB).toBe(geomA);
  });
});
