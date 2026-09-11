import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import { MATERIAL_WORN_NODE, computeGeometryCurvature, ensureCurvatureAttribute } from "./materialWorn";
import { MATERIAL_NODE } from "./material";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "worn-test" };

describe("MATERIAL_WORN_NODE and Curvature computation", () => {
  it("evaluates MATERIAL_WORN_NODE and creates a custom MeshStandardMaterial with curvature uniforms", () => {
    const res = MATERIAL_WORN_NODE.evaluate({}, MATERIAL_WORN_NODE.defaultParams, CTX);
    expect(res.material).toBeDefined();

    const matParams = res.material as any;
    expect(matParams.customMaterial).toBeInstanceOf(THREE.MeshStandardMaterial);
    const customMat = matParams.customMaterial as THREE.MeshStandardMaterial;

    expect((customMat as any).__isWornMaterial).toBe(true);
    expect((customMat as any).__needsCurvature).toBe(true);

    const u = (customMat as any).__wornUniforms;
    expect(u).toBeDefined();
    expect(u.uWearAmount.value).toBe(0.4);
    expect(u.uDirtAmount.value).toBe(0.4);
    expect(u.uContrast.value).toBe(2.0);
  });

  it("extracts and blends 3 connected input materials (base, worn, dirt)", () => {
    // 1. Red base
    const baseMatRes = MATERIAL_NODE.evaluate(
      {},
      { color: new THREE.Color(0xff0000), roughness: 0.7, metalness: 0.2 },
      { time: 0, step: 0, nodeId: "base-mat" }
    );
    // 2. Gold worn
    const wornMatRes = MATERIAL_NODE.evaluate(
      {},
      { color: new THREE.Color(0xffd700), roughness: 0.1, metalness: 0.95 },
      { time: 0, step: 0, nodeId: "worn-mat" }
    );
    // 3. Black dirt
    const dirtMatRes = MATERIAL_NODE.evaluate(
      {},
      { color: new THREE.Color(0x111111), roughness: 0.9, metalness: 0.0 },
      { time: 0, step: 0, nodeId: "dirt-mat" }
    );

    const res = MATERIAL_WORN_NODE.evaluate(
      {
        base: baseMatRes.material,
        worn: wornMatRes.material,
        dirt: dirtMatRes.material,
        wearAmount: 0.6,
        dirtAmount: 0.3,
      },
      MATERIAL_WORN_NODE.defaultParams,
      CTX
    );

    const customMat = (res.material as any).customMaterial;
    const u = customMat.__wornUniforms;

    // Check that custom inputs propagated to shader uniforms
    expect(u.uBaseColor.value.getHexString()).toBe("ff0000");
    expect(u.uBaseRoughness.value).toBeCloseTo(0.7);
    expect(u.uBaseMetalness.value).toBeCloseTo(0.2);

    expect(u.uWornColor.value.getHexString()).toBe("ffd700");
    expect(u.uWornRoughness.value).toBeCloseTo(0.1);
    expect(u.uWornMetalness.value).toBeCloseTo(0.95);

    expect(u.uDirtColor.value.getHexString()).toBe("111111");
    expect(u.uWearAmount.value).toBeCloseTo(0.6);
    expect(u.uDirtAmount.value).toBeCloseTo(0.3);
  });

  it("computes positive curvature (convex) on outer box corners and near-zero on plane", () => {
    const plane = new THREE.PlaneGeometry(2, 2, 4, 4);
    const planeCurv = computeGeometryCurvature(plane);
    // Interior and boundary plane vertices are flat
    let maxPlaneCurv = 0;
    for (let i = 0; i < planeCurv.count; i++) {
      maxPlaneCurv = Math.max(maxPlaneCurv, Math.abs(planeCurv.getX(i)));
    }
    expect(maxPlaneCurv).toBeLessThan(0.01);

    const box = new THREE.BoxGeometry(2, 2, 2);
    ensureCurvatureAttribute(box);
    const boxCurv = box.getAttribute("curvature") as THREE.BufferAttribute;
    expect(boxCurv).toBeDefined();
    // All corners of a box are strictly convex (positive curvature)
    for (let i = 0; i < boxCurv.count; i++) {
      expect(boxCurv.getX(i)).toBeGreaterThan(0.2);
    }
  });
});
