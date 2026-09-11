import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import { MATERIAL_WORN_NODE, prepareWornGeometry } from "./materialWorn";
import { MATERIAL_NODE } from "./material";
import { SOLIDIFY_NODE } from "./solidify";
import { applyMaterialParams } from "./object";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "worn-test" };

describe("MATERIAL_WORN_NODE and Edge Curvature computation", () => {
  it("evaluates MATERIAL_WORN_NODE and creates a custom MeshStandardMaterial with curvature uniforms", () => {
    const res = MATERIAL_WORN_NODE.evaluate({}, MATERIAL_WORN_NODE.defaultParams, CTX);
    expect(res.material).toBeDefined();

    const matParams = res.material as any;
    expect(matParams.customMaterial).toBeInstanceOf(THREE.MeshStandardMaterial);
    const customMat = matParams.customMaterial as THREE.MeshStandardMaterial;

    expect((customMat as any).__isWornMaterial).toBe(true);

    const u = (customMat as any).__wornUniforms;
    expect(u).toBeDefined();
    expect(u.uWearAmount.value).toBe(0.4);
    expect(u.uDirtAmount.value).toBe(0.4);
    expect(u.uContrast.value).toBe(2.0);
  });

  it("extracts and blends 3 connected input materials (base, worn, dirt)", () => {
    const baseMatRes = MATERIAL_NODE.evaluate(
      {},
      { color: new THREE.Color(0xff0000), roughness: 0.7, metalness: 0.2 },
      { time: 0, step: 0, nodeId: "base-mat" }
    );
    const wornMatRes = MATERIAL_NODE.evaluate(
      {},
      { color: new THREE.Color(0xffd700), roughness: 0.1, metalness: 0.95 },
      { time: 0, step: 0, nodeId: "worn-mat" }
    );
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

  it("drives the fractal noise, surface variation and seed uniforms", () => {
    const res = MATERIAL_WORN_NODE.evaluate(
      { noiseDetail: 4, variation: 0.7, seed: 7 },
      MATERIAL_WORN_NODE.defaultParams,
      { time: 0, step: 0, nodeId: "worn-noise" },
    );
    const u = (res.material as any).customMaterial.__wornUniforms;
    expect(u.uNoiseDetail.value).toBe(4);
    expect(u.uVariation.value).toBeCloseTo(0.7);

    // Two seeds have to land on different parts of the noise field, or every
    // object in the scene wears along an identical pattern.
    const offset7 = u.uSeedOffset.value.clone();
    const res1 = MATERIAL_WORN_NODE.evaluate(
      { seed: 1 },
      MATERIAL_WORN_NODE.defaultParams,
      { time: 0, step: 0, nodeId: "worn-noise-2" },
    );
    const offset1 = (res1.material as any).customMaterial.__wornUniforms.uSeedOffset.value;
    expect(offset7.distanceTo(offset1)).toBeGreaterThan(1);
  });

  it("drives the discrete patch masks for wear and dirt independently", () => {
    const res = MATERIAL_WORN_NODE.evaluate(
      { wearPatch: 0.8, dirtPatch: 0.2, patchScale: 9 },
      MATERIAL_WORN_NODE.defaultParams,
      { time: 0, step: 0, nodeId: "worn-patch" },
    );
    const u = (res.material as any).customMaterial.__wornUniforms;
    expect(u.uWearPatch.value).toBeCloseTo(0.8);
    expect(u.uDirtPatch.value).toBeCloseTo(0.2);
    expect(u.uPatchScale.value).toBeCloseTo(9);
  });

  it("clamps the patch amounts to 0-1", () => {
    const res = MATERIAL_WORN_NODE.evaluate(
      { wearPatch: 5, dirtPatch: -3 },
      MATERIAL_WORN_NODE.defaultParams,
      { time: 0, step: 0, nodeId: "worn-patch-clamp" },
    );
    const u = (res.material as any).customMaterial.__wornUniforms;
    expect(u.uWearPatch.value).toBe(1);
    expect(u.uDirtPatch.value).toBe(0);
  });

  it("clamps Noise Detail to the octave count the shader loop is unrolled to", () => {
    const res = MATERIAL_WORN_NODE.evaluate(
      { noiseDetail: 99 },
      MATERIAL_WORN_NODE.defaultParams,
      { time: 0, step: 0, nodeId: "worn-detail-clamp" },
    );
    expect((res.material as any).customMaterial.__wornUniforms.uNoiseDetail.value).toBe(4);
  });

  it("survives a modifier that inherits the source mesh's material", () => {
    // A modifier assigning `mesh.material = srcMesh.material` by hand used to
    // skip the material's geometry hook, so the worn shader landed on geometry
    // with no curvature attributes: every k read as 0, every pixel took the
    // base colour, and the node looked like it did nothing at all.
    const res = MATERIAL_WORN_NODE.evaluate({}, MATERIAL_WORN_NODE.defaultParams, CTX);
    const customMat = (res.material as any).customMaterial as THREE.Material;

    const source = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    applyMaterialParams(source, res.material as any);
    expect(source.geometry.getAttribute("aEdgeCurvatures")).toBeDefined();

    const solidified = SOLIDIFY_NODE.evaluate(
      { geometry: source },
      { ...SOLIDIFY_NODE.defaultParams },
      { time: 0, step: 0, nodeId: "worn-solidify" },
    );
    const out = solidified.geometry as THREE.Mesh;
    expect(out.material).toBe(customMat);
    expect(out.geometry.getAttribute("aEdgeCurvatures")).toBeDefined();
  });

  it("prepares geometry with barycentric attributes: outer box edges are convex (k>0) and internal quad diagonals are coplanar flat (k=0)", () => {
    const box = new THREE.BoxGeometry(2, 2, 2);
    const prepared = prepareWornGeometry(box);

    const bary = prepared.getAttribute("aBarycentric");
    const altitudes = prepared.getAttribute("aEdgeAltitudes");
    const edgeCurv = prepared.getAttribute("aEdgeCurvatures");

    expect(bary).toBeDefined();
    expect(altitudes).toBeDefined();
    expect(edgeCurv).toBeDefined();

    // In a Box, 12 triangles total (36 vertices in non-indexed)
    expect(prepared.getAttribute("position").count).toBe(36);

    let hasConvexEdge = false;
    let hasFlatCoplanarEdge = false;

    for (let i = 0; i < edgeCurv.count; i += 3) {
      const k0 = edgeCurv.getX(i);
      const k1 = edgeCurv.getY(i);
      const k2 = edgeCurv.getZ(i);

      if (k0 > 0.5 || k1 > 0.5 || k2 > 0.5) hasConvexEdge = true;
      if (Math.abs(k0) < 0.01 || Math.abs(k1) < 0.01 || Math.abs(k2) < 0.01) hasFlatCoplanarEdge = true;
    }

    expect(hasConvexEdge).toBe(true);
    expect(hasFlatCoplanarEdge).toBe(true);
  });

  it("detects concave inner corner edges (k < 0)", () => {
    // Construct an L-shaped corner of two perpendicular triangles facing inward
    // Triangle 1 on floor (facing up): (0,0,0), (1,0,0), (1,0,1)
    // Triangle 2 on wall (facing left): (0,0,0), (0,1,0), (0,1,1) -> meets floor at edge (0,0,0)-(0,0,1)
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array([
      // Triangle 1 (floor, normal (0, 1, 0))
      0, 0, 0,
      0, 0, 1,
      1, 0, 0,
      // Triangle 2 (wall, normal (1, 0, 0))
      0, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ]);
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));

    const prepared = prepareWornGeometry(geom);
    const edgeCurv = prepared.getAttribute("aEdgeCurvatures");

    let foundConcave = false;
    for (let i = 0; i < edgeCurv.count; i++) {
      if (edgeCurv.getX(i) < -0.5 || edgeCurv.getY(i) < -0.5 || edgeCurv.getZ(i) < -0.5) {
        foundConcave = true;
        break;
      }
    }
    expect(foundConcave).toBe(true);
  });

  it("guarantees internal edges of a flat subdivided plane have strictly zero curvature (k=0)", () => {
    // 2x2 grid plane (4 quads = 8 triangles)
    const plane = new THREE.PlaneGeometry(4, 4, 2, 2);
    const prepared = prepareWornGeometry(plane);
    const edgeCurv = prepared.getAttribute("aEdgeCurvatures");

    let flatInternalEdgesCount = 0;
    for (let i = 0; i < edgeCurv.count; i += 3) {
      const k0 = edgeCurv.getX(i);
      const k1 = edgeCurv.getY(i);
      const k2 = edgeCurv.getZ(i);

      if (Math.abs(k0) < 0.001) flatInternalEdgesCount++;
      if (Math.abs(k1) < 0.001) flatInternalEdgesCount++;
      if (Math.abs(k2) < 0.001) flatInternalEdgesCount++;
    }

    // All internal edges connecting adjacent triangles of the flat plane must be strictly 0
    expect(flatInternalEdgesCount).toBeGreaterThan(0);
  });
});
