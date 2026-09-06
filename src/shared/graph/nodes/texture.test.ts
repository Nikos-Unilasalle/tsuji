import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { EvalContext } from "../types";
import { TEXTURE_IMAGE_NODE, TEXTURE_PIXEL_SPAWNER_NODE, TEXTURE_PLANE_NODE, TEXTURE_PROCEDURAL_NODE, TEXTURE_TO_NORMAL_NODE, TEXTURE_TRANSFORM_NODE, replaceCanvasTexture } from "./texture";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "tex-test-1" };

describe("TEXTURE NODES", () => {
  it("TEXTURE_PROCEDURAL_NODE registers patterns and degrades gracefully without a DOM", () => {
    expect(TEXTURE_PROCEDURAL_NODE.type).toBe("texture/procedural");
    const fields = TEXTURE_PROCEDURAL_NODE.dynamicParamFields!({ id: "p", type: "texture/procedural", position: { x: 0, y: 0 }, params: {} } as never);
    const typeField = fields.find((f) => f.id === "type") as { options?: string[] };
    expect(typeField.options).toEqual(
      expect.arrayContaining(["checker", "gradient", "stripes", "grid", "rings", "wave", "perlin", "voronoi", "noise"]),
    );
    // Octaves only appears when perlin is selected.
    const perlinFields = TEXTURE_PROCEDURAL_NODE.dynamicParamFields!({ id: "p", type: "texture/procedural", position: { x: 0, y: 0 }, params: { type: "perlin" } } as never);
    expect(perlinFields.some((f) => f.id === "octaves")).toBe(true);
    // Exposes scale and seed inputs
    expect(TEXTURE_PROCEDURAL_NODE.inputs.some((i) => i.id === "scale")).toBe(true);
    expect(TEXTURE_PROCEDURAL_NODE.inputs.some((i) => i.id === "seed")).toBe(true);
    // Node environment has no `document` → evaluate returns a null texture, not a crash.
    const res = TEXTURE_PROCEDURAL_NODE.evaluate({}, TEXTURE_PROCEDURAL_NODE.defaultParams, CTX);
    expect(res.texture).toBeNull();
  });

  it("TEXTURE_TO_NORMAL_NODE registers and degrades gracefully without a DOM", () => {
    expect(TEXTURE_TO_NORMAL_NODE.type).toBe("texture/to_normal");
    const res = TEXTURE_TO_NORMAL_NODE.evaluate({ texture: new THREE.Texture() }, TEXTURE_TO_NORMAL_NODE.defaultParams, CTX);
    expect(res.normal).toBeNull();
  });

  it("TEXTURE_IMAGE_NODE evaluates fallback empty texture", () => {
    const res = TEXTURE_IMAGE_NODE.evaluate({}, TEXTURE_IMAGE_NODE.defaultParams, CTX);
    expect(res.texture).toBeInstanceOf(THREE.Texture);
    expect(res.aspectRatio).toBe(1.0);
  });

  it("TEXTURE_PLANE_NODE creates 3D plane mesh with texture mapping", () => {
    const tex = new THREE.Texture();
    const res = TEXTURE_PLANE_NODE.evaluate(
      { texture: tex },
      TEXTURE_PLANE_NODE.defaultParams,
      CTX
    );

    const mesh = res.geometry as THREE.Mesh;
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(true);
    expect((mesh.material as THREE.MeshStandardMaterial).color.r).toBe(1);

    // Default rotation is horizontal (-90 deg around X), matching Plane primitive
    const defaultRot = TEXTURE_PLANE_NODE.defaultParams.rotation as THREE.Vector3;
    expect(defaultRot.x).toBeCloseTo(-Math.PI / 2);
    expect(defaultRot.y).toBe(0);
    expect(defaultRot.z).toBe(0);

    expect(TEXTURE_PLANE_NODE.inputs.some((i) => i.id === "visible")).toBe(true);
    expect(TEXTURE_PLANE_NODE.defaultParams.visible).toBe(1);
    expect(mesh.visible).toBe(true);
    expect(mesh.renderOrder).toBe(0);

    const hiddenRes = TEXTURE_PLANE_NODE.evaluate(
      { texture: tex },
      { ...TEXTURE_PLANE_NODE.defaultParams, visible: 0 },
      CTX
    );
    expect((hiddenRes.geometry as THREE.Mesh).visible).toBe(false);

    const wiredRes = TEXTURE_PLANE_NODE.evaluate(
      { texture: tex, visible: 1 },
      { ...TEXTURE_PLANE_NODE.defaultParams, visible: 0 },
      CTX
    );
    expect((wiredRes.geometry as THREE.Mesh).visible).toBe(true);
  });

  it("TEXTURE_TRANSFORM_NODE modifies texture repeat and rotation", () => {
    const tex = new THREE.Texture();
    const res = TEXTURE_TRANSFORM_NODE.evaluate(
      { texture: tex, rotation: 90 },
      { scaleX: 2, scaleY: 3, offsetX: 0.5, offsetY: 0.5, rotation: 0 },
      CTX
    );

    const transformedTex = res.texture as THREE.Texture;
    expect(transformedTex).toBeInstanceOf(THREE.Texture);
    expect(transformedTex.repeat.x).toBe(2);
    expect(transformedTex.repeat.y).toBe(3);
    expect(transformedTex.rotation).toBeCloseTo(Math.PI / 2);
  });

  it("TEXTURE_PIXEL_SPAWNER_NODE registers properly and handles missing DOM / empty inputs gracefully", () => {
    expect(TEXTURE_PIXEL_SPAWNER_NODE.type).toBe("texture/pixel-spawner");
    const res = TEXTURE_PIXEL_SPAWNER_NODE.evaluate(
      { texture: null, density: 50 },
      TEXTURE_PIXEL_SPAWNER_NODE.defaultParams,
      CTX
    );
    expect(res.geometry).toBeInstanceOf(THREE.Group);
    expect(res.count).toBe(0);
    expect(res.colors).toEqual([]);
    expect(res.positions).toEqual([]);
    expect(res.intensities).toEqual([]);
  });

  it("TEXTURE_PIXEL_SPAWNER_NODE supports orientation options (xy, xz, yz)", () => {
    const fields = TEXTURE_PIXEL_SPAWNER_NODE.dynamicParamFields!({ id: "p", type: "texture/pixel-spawner", position: { x: 0, y: 0 }, params: {} } as never);
    const orientationField = fields.find((f) => f.id === "orientation") as { options?: string[] };
    expect(orientationField).toBeDefined();
    expect(orientationField.options).toEqual(["xy", "xz", "yz"]);
  });
});

describe("replaceCanvasTexture", () => {
  // A duck-typed stand-in for HTMLCanvasElement: THREE.CanvasTexture only ever
  // stores the reference as `.image` at construction time, so a plain object
  // with the right shape exercises the real code path with no DOM required.
  const fakeCanvas = () => ({ width: 64, height: 64 }) as unknown as HTMLCanvasElement;

  it("creates a texture wired up with the given color space and repeat wrapping", () => {
    const canvas = fakeCanvas();
    const texture = replaceCanvasTexture(undefined, canvas, THREE.SRGBColorSpace);
    expect(texture.image).toBe(canvas);
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    expect(texture.wrapT).toBe(THREE.RepeatWrapping);
  });

  it("returns a new texture object on every call, never the one passed in", () => {
    // This is the actual fix: three.js's fast canvas-upload path
    // (glCopySubTextureCHROMIUM) assumes a texture's GPU storage still
    // matches the size it was first allocated at. Reusing the same texture
    // object across a canvas resize and only flipping `needsUpdate` hits
    // that assumption and silently corrupts or drops the upload — logged by
    // Chrome as "Offset overflows texture dimensions" — even though the
    // canvas itself holds the correct new pixels. A fresh object sidesteps
    // it by making three allocate GPU storage sized for the canvas as it is
    // now, every time.
    const canvas = fakeCanvas();
    const first = replaceCanvasTexture(undefined, canvas, THREE.SRGBColorSpace);
    const second = replaceCanvasTexture(first, canvas, THREE.SRGBColorSpace);
    const third = replaceCanvasTexture(second, canvas, THREE.SRGBColorSpace);

    expect(second).not.toBe(first);
    expect(third).not.toBe(second);
  });

  it("disposes the texture it replaces, so a redraw doesn't leak a GPU texture per edit", () => {
    const canvas = fakeCanvas();
    const first = replaceCanvasTexture(undefined, canvas, THREE.SRGBColorSpace);
    const disposeSpy = vi.spyOn(first, "dispose");

    replaceCanvasTexture(first, canvas, THREE.SRGBColorSpace);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("does nothing to dispose when there was no previous texture", () => {
    expect(() => replaceCanvasTexture(undefined, fakeCanvas(), THREE.SRGBColorSpace)).not.toThrow();
  });

  it("keeps normal/roughness maps linear rather than sRGB", () => {
    const texture = replaceCanvasTexture(undefined, fakeCanvas(), THREE.LinearSRGBColorSpace);
    expect(texture.colorSpace).toBe(THREE.LinearSRGBColorSpace);
  });
});
