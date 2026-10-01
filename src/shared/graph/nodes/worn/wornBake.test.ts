import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { collectWornMeshes, dilate, normalFromHeight } from "./wornBake";
import { MATERIAL_WORN_NODE, WORN_BAKE_ACTION } from "../materialWorn";
import { applyMaterialParams } from "../object";

describe("Worn texture export", () => {
  it("grows the UV islands past their edges, so filtering never pulls the background in", () => {
    // 5 × 1: one covered texel in the middle.
    const px = new Uint8Array(5 * 4);
    px.set([200, 100, 50, 255], 2 * 4);
    dilate(px, 5, 1, 2);
    for (let x = 0; x < 5; x++) expect(Array.from(px.subarray(x * 4, x * 4 + 4))).toEqual([200, 100, 50, 255]);
    // Only so far out.
    const wide = new Uint8Array(9 * 4);
    wide.set([10, 20, 30, 255], 0);
    dilate(wide, 9, 1, 3);
    expect(wide[3 * 4 + 3]).toBe(255);
    expect(wide[4 * 4 + 3]).toBe(0);
  });

  it("turns a height ramp into normals leaning away from the rise", () => {
    const w = 4, h = 1;
    const height = new Uint8Array(w * h * 4);
    for (let x = 0; x < w; x++) height.set([x * 60, 0, 0, 255], x * 4);
    const n = normalFromHeight(height, w, h);
    // Rising towards +x: the normal tips towards −x (red below 128), and still faces out.
    expect(n[4]).toBeLessThan(128);
    expect(n[6]).toBeGreaterThan(128);
    const flat = normalFromHeight(new Uint8Array(w * h * 4), w, h);
    expect(Array.from(flat.subarray(0, 3))).toEqual([128, 128, 255]);
  });

  it("finds the meshes a Worn material draws, preferring the ones on stage", () => {
    const res = MATERIAL_WORN_NODE.evaluate({}, MATERIAL_WORN_NODE.defaultParams, { time: 0, step: 0, nodeId: "worn-bake-collect" }) as any;
    const onStage = new THREE.Mesh(new THREE.BoxGeometry());
    const offStage = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1));
    applyMaterialParams(onStage, res.material);
    applyMaterialParams(offStage, res.material);
    const other = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    const scene = new THREE.Scene();
    scene.add(onStage);
    const uniforms = res.material.customMaterial.__wornUniforms;
    expect(collectWornMeshes([onStage, offStage, other, 42], uniforms)).toEqual([onStage]);
    scene.remove(onStage);
    expect(collectWornMeshes([onStage, offStage, other], uniforms)).toHaveLength(2);
  });

  it("offers the export as a button on the node", () => {
    const button = MATERIAL_WORN_NODE.paramFields!.find((f) => f.kind === "button") as any;
    expect(button.action).toBe(WORN_BAKE_ACTION);
  });
});
