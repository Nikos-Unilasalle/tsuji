import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import { MaterialValue } from "../sockets";
import { MATERIAL_NODE, MATERIAL_SHADOW_CATCHER_NODE } from "./material";
import { extractMaterialParams, OBJECT_BOX_NODE, applyMaterialParams } from "./object";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "test" };

describe("MATERIAL_NODE", () => {
  it("outputs a material descriptor from defaultParams when nothing is wired", () => {
    const res = MATERIAL_NODE.evaluate({}, MATERIAL_NODE.defaultParams, CTX) as { material: MaterialValue };
    expect(res.material.color.getHex()).toBe(0xffffff);
    expect(res.material.emissive.getHex()).toBe(0x000000);
    expect(res.material.roughness).toBeCloseTo(0.4);
    expect(res.material.metalness).toBeCloseTo(0.1);
    expect(res.material.opacity).toBeCloseTo(1);
    expect(res.material.shadeless).toBe(false);
    expect(res.material.wireframe).toBe(false);
  });

  it("reflects wired inputs over defaultParams", () => {
    const res = MATERIAL_NODE.evaluate(
      { color: new THREE.Color(0xff0000), roughness: 0.9, opacity: 0.5 },
      MATERIAL_NODE.defaultParams,
      CTX,
    ) as { material: MaterialValue };
    expect(res.material.color.getHex()).toBe(0xff0000);
    expect(res.material.roughness).toBeCloseTo(0.9);
    expect(res.material.opacity).toBeCloseTo(0.5);
  });

  it("carries transmission and thickness (glass params)", () => {
    const res = MATERIAL_NODE.evaluate(
      { transmission: 1, thickness: 2 },
      MATERIAL_NODE.defaultParams,
      CTX,
    ) as { material: MaterialValue };
    expect(res.material.transmission).toBeCloseTo(1);
    expect(res.material.thickness).toBeCloseTo(2);
  });
});

describe("material input priority", () => {
  it("extractMaterialParams prefers the connected material over internal params", () => {
    const connected: MaterialValue = {
      color: new THREE.Color(0x00ff00),
      emissive: new THREE.Color(0x000000),
      emissiveIntensity: 1,
      shadeless: false,
      roughness: 0.9,
      metalness: 0.2,
      wireframe: false,
      opacity: 0.5,
      transmission: 0.6,
      thickness: 1.5,
    };
    const res = extractMaterialParams(
      { material: connected, color: new THREE.Color(0x0000ff), roughness: 0.1 },
      { color: new THREE.Color(0xff0000), roughness: 0.2, opacity: 1 },
    );
    expect(res.color.getHex()).toBe(0x00ff00);
    expect(res.roughness).toBeCloseTo(0.9);
    expect(res.opacity).toBeCloseTo(0.5);
    expect(res.transmission).toBeCloseTo(0.6);
    expect(res.thickness).toBeCloseTo(1.5);
  });

  it("a box uses the connected material over its own color/roughness params", () => {
    const out = OBJECT_BOX_NODE.evaluate(
      { material: { color: new THREE.Color(0x00ff00), roughness: 0.7 } },
      { ...OBJECT_BOX_NODE.defaultParams, color: new THREE.Color(0xff0000), roughness: 0.1 },
      CTX,
    );
    const mat = (out.geometry as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(mat.color.getHex()).toBe(0x00ff00);
    expect(mat.roughness).toBeCloseTo(0.7);
  });

  it("transmission upgrades the material to MeshPhysicalMaterial", () => {
    const out = OBJECT_BOX_NODE.evaluate(
      {},
      { ...OBJECT_BOX_NODE.defaultParams, transmission: 1, thickness: 2, roughness: 0 },
      CTX,
    );
    const mat = (out.geometry as THREE.Mesh).material;
    expect(mat).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect((mat as THREE.MeshPhysicalMaterial).transmission).toBeCloseTo(1);
    expect((mat as THREE.MeshPhysicalMaterial).thickness).toBeCloseTo(2);
    expect((mat as THREE.MeshPhysicalMaterial).roughness).toBeCloseTo(0);
  });

  it("drops back to MeshStandardMaterial when transmission returns to 0", () => {
    const withGlass = OBJECT_BOX_NODE.evaluate(
      {},
      { ...OBJECT_BOX_NODE.defaultParams, transmission: 1 },
      CTX,
    );
    const mesh = withGlass.geometry as THREE.Mesh;
    expect(mesh.material).toBeInstanceOf(THREE.MeshPhysicalMaterial);

    const back = OBJECT_BOX_NODE.evaluate(
      {},
      { ...OBJECT_BOX_NODE.defaultParams, transmission: 0 },
      CTX,
    );
    const mesh2 = back.geometry as THREE.Mesh;
    expect(mesh2.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(mesh2.material).not.toBeInstanceOf(THREE.MeshPhysicalMaterial);
  });

  it("a textured material stays opaque when the texture has no alpha (so it shows through glass)", () => {
    const tex = new THREE.Texture();
    tex.image = { data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]) };
    const out = OBJECT_BOX_NODE.evaluate(
      { texture: tex },
      { ...OBJECT_BOX_NODE.defaultParams, opacity: 1 },
      CTX,
    );
    const mat = (out.geometry as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(mat.map).toBe(tex);
    expect(mat.transparent).toBe(false);
  });

  it("a textured material stays transparent when the texture carries alpha (PNG alpha)", () => {
    const tex = new THREE.Texture();
    tex.image = { data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128]) };
    const out = OBJECT_BOX_NODE.evaluate(
      { texture: tex },
      { ...OBJECT_BOX_NODE.defaultParams, opacity: 1 },
      CTX,
    );
    const mat = (out.geometry as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(mat.transparent).toBe(true);
  });

  it("applyMaterialParams skips re-application (no per-frame needsUpdate) when unchanged", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    const p = extractMaterialParams({}, { roughness: 0.5, metalness: 0.2 });
    applyMaterialParams(mesh, p, THREE.FrontSide);
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const appliedVersion = mat.version;

    applyMaterialParams(mesh, p, THREE.FrontSide);
    expect(mat.version).toBe(appliedVersion);

    // needsUpdate forces a full shader recompile — only the *defines* (which
    // map slots are filled, whether it draws transparent) need that. A plain
    // uniform change like roughness reaches the GPU without one, so it must
    // NOT bump version, even though the value itself is still applied.
    applyMaterialParams(mesh, { ...p, roughness: 0.9 }, THREE.FrontSide);
    expect(mat.roughness).toBe(0.9);
    expect(mat.version).toBe(appliedVersion);

    // A defines-affecting change (opacity crossing into transparent) does
    // bump it — a different shader program is genuinely needed.
    applyMaterialParams(mesh, { ...p, roughness: 0.9, opacity: 0.5 }, THREE.FrontSide);
    expect(mat.transparent).toBe(true);
    expect(mat.version).toBe(appliedVersion + 1);
  });
});

describe("MATERIAL_SHADOW_CATCHER_NODE", () => {
  it("outputs a ShadowMaterial with default parameters", () => {
    const res = MATERIAL_SHADOW_CATCHER_NODE.evaluate(
      {},
      MATERIAL_SHADOW_CATCHER_NODE.defaultParams,
      CTX,
    ) as { material: MaterialValue };
    expect(res.material.customMaterial).toBeInstanceOf(THREE.ShadowMaterial);
    const mat = res.material.customMaterial as THREE.ShadowMaterial;
    expect(mat.opacity).toBeCloseTo(0.6);
    expect(mat.color.getHex()).toBe(0x000000);
    expect(mat.side).toBe(THREE.DoubleSide);
  });

  it("updates opacity, color, and side from inputs and params", () => {
    const res = MATERIAL_SHADOW_CATCHER_NODE.evaluate(
      { opacity: 0.8, color: new THREE.Color(0x223344), doubleSided: 0 },
      MATERIAL_SHADOW_CATCHER_NODE.defaultParams,
      CTX,
    ) as { material: MaterialValue };
    const mat = res.material.customMaterial as THREE.ShadowMaterial;
    expect(mat.opacity).toBeCloseTo(0.8);
    expect(mat.color.getHex()).toBe(0x223344);
    expect(mat.side).toBe(THREE.FrontSide);
  });

  it("sets receiveShadow=true and castShadow=false on mesh when applied", () => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshStandardMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = false;

    const shadowMat = new THREE.ShadowMaterial();
    applyMaterialParams(
      mesh,
      {
        customMaterial: shadowMat,
        color: new THREE.Color(0x000000),
        emissive: new THREE.Color(0x000000),
        emissiveIntensity: 0,
        shadeless: false,
        roughness: 1,
        metalness: 0,
        wireframe: false,
        opacity: 1,
        transmission: 0,
        thickness: 0,
      },
      THREE.DoubleSide,
    );

    expect(mesh.material).toBe(shadowMat);
    expect(mesh.receiveShadow).toBe(true);
    expect(mesh.castShadow).toBe(false);
  });
});

