import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ROTO_MASK_NODE, maskKey, maskRasterSize } from "./maskRoto";
import { TEXTURE_APPLY_MASK_NODE, TEXTURE_MASK_NODE, TEXTURE_PLANE_NODE } from "./texture";
import { DEFAULT_REGISTRY } from "./index";
import { createLayer, createPaintLayer, ellipsePoints, rectPoints } from "../maskShapes";
import { encodeBitmap } from "../maskBitmap";
import { disposeNodeCaches } from "../nodeCaches";
import { EvalContext } from "../types";

const ctx = (nodeId: string): EvalContext => ({ nodeId, time: 0, step: 0 });
const run = (id: string, params: Record<string, unknown>, inputs: Record<string, unknown> = {}) =>
  ROTO_MASK_NODE.evaluate(inputs, { ...ROTO_MASK_NODE.defaultParams, ...params }, ctx(id)) as { mask: THREE.DataTexture; aspect: number };

const pixel = (t: THREE.DataTexture, u: number, v: number) => {
  const { width, height, data } = t.image as { width: number; height: number; data: Uint8Array };
  return data[(Math.floor(v * height) * width + Math.floor(u * width)) * 4];
};

describe("registration", () => {
  it("Roto Mask is a texture tool, and the old Mask is now Channel Mask under the same id", () => {
    expect(DEFAULT_REGISTRY.get("mask/roto")).toBe(ROTO_MASK_NODE);
    expect(ROTO_MASK_NODE.category).toBe("textureTools");
    expect(DEFAULT_REGISTRY.get("texture/mask")).toBe(TEXTURE_MASK_NODE);
    expect(TEXTURE_MASK_NODE.label).toBe("Channel Mask");
    expect(DEFAULT_REGISTRY.get("texture/apply-mask")).toBe(TEXTURE_APPLY_MASK_NODE);
  });

  it("Texture to Plane has a Mask input", () => {
    expect(TEXTURE_PLANE_NODE.inputs.find((i) => i.id === "mask")?.type).toBe("texture");
  });
});

describe("maskRasterSize", () => {
  it("the long side is the resolution and the shape follows the aspect", () => {
    expect(maskRasterSize("1024", 2)).toEqual([1024, 512]);
    expect(maskRasterSize("1024", 0.5)).toEqual([512, 1024]);
    expect(maskRasterSize("512", 1)).toEqual([512, 512]);
  });

  it("clamps what is out of range", () => {
    expect(maskRasterSize("99999", 1)).toEqual([2048, 2048]);
    expect(maskRasterSize("junk", NaN)).toEqual([1024, 1024]);
    expect(maskRasterSize(1024, 0)).toEqual([1024, 1024]);
  });
});

describe("Roto Mask", () => {
  it("with nothing drawn it is white: the picture does not vanish", () => {
    const { mask } = run("rm-empty", { resolution: "512" });
    expect(pixel(mask, 0.5, 0.5)).toBe(255);
    expect(pixel(mask, 0.01, 0.01)).toBe(255);
    disposeNodeCaches(["rm-empty"]);
  });

  it("a drawn shape shows inside and hides outside, in the right orientation", () => {
    // A box in the top-left of the image: v = 1 is the top.
    const layer = createLayer(rectPoints(0.1, 0.6, 0.4, 0.9));
    const { mask } = run("rm-box", { resolution: "512", masks: [layer] });
    expect(pixel(mask, 0.25, 0.75)).toBe(255);
    expect(pixel(mask, 0.25, 0.25)).toBe(0);
    expect(pixel(mask, 0.75, 0.75)).toBe(0);
    disposeNodeCaches(["rm-box"]);
  });

  it("is a plain texture other nodes can read: grey, opaque, unmanaged colour", () => {
    const { mask } = run("rm-tex", { resolution: "512", masks: [createLayer(ellipsePoints(0.5, 0.5, 0.3, 0.3))] });
    expect(mask).toBeInstanceOf(THREE.DataTexture);
    expect(mask.colorSpace).toBe(THREE.NoColorSpace);
    const data = (mask.image as { data: Uint8Array }).data;
    expect(data[0]).toBe(data[1]);
    expect(data[1]).toBe(data[2]);
    expect(data[3]).toBe(255);
    disposeNodeCaches(["rm-tex"]);
  });

  it("takes its aspect ratio from a reference image, else from the Aspect param", () => {
    const image = new THREE.DataTexture(new Uint8Array(4 * 4 * 2 * 4), 8, 2);
    const withReference = run("rm-ref", { resolution: "512", aspect: 1 }, { reference: image });
    expect(withReference.aspect).toBeCloseTo(4, 3);
    expect((withReference.mask.image as { width: number; height: number }).height).toBe(128);
    const without = run("rm-noref", { resolution: "512", aspect: 2 });
    expect(without.aspect).toBeCloseTo(2, 3);
    disposeNodeCaches(["rm-ref", "rm-noref"]);
  });

  it("returns the same texture while nothing changes, and re-rasterises when a shape does", () => {
    const params = { resolution: "512", masks: [createLayer(rectPoints(0.1, 0.1, 0.5, 0.5))] };
    const first = run("rm-same", params);
    const version = first.mask.version;
    const again = run("rm-same", params);
    expect(again.mask).toBe(first.mask);
    expect(again.mask.version).toBe(version);

    const moved = run("rm-same", { ...params, masks: [createLayer(rectPoints(0.5, 0.5, 0.9, 0.9), { id: params.masks[0].id })] });
    expect(moved.mask.version).toBeGreaterThan(version);
    expect(pixel(moved.mask, 0.7, 0.7)).toBe(255);
    disposeNodeCaches(["rm-same"]);
  });

  it("Show the whole image lets everything through while editing", () => {
    const layers = [createLayer(rectPoints(0.1, 0.1, 0.2, 0.2))];
    const { mask } = run("rm-full", { resolution: "512", masks: layers, showFull: true });
    expect(pixel(mask, 0.9, 0.9)).toBe(255);
    const back = run("rm-full", { resolution: "512", masks: layers, showFull: false });
    expect(pixel(back.mask, 0.9, 0.9)).toBe(0);
    disposeNodeCaches(["rm-full"]);
  });

  it("junk in the masks param does not throw", () => {
    expect(() => run("rm-junk", { masks: [null, 3, { points: "x" }, { id: "a", points: [{ x: NaN, y: 0 }] }] })).not.toThrow();
    disposeNodeCaches(["rm-junk"]);
  });

  it("the key ignores layer names and ids but not shapes or settings", () => {
    const a = createLayer(rectPoints(0, 0, 1, 1));
    expect(maskKey([a], 64, 64, false)).toBe(maskKey([{ ...a, name: "renamed", id: "other" }], 64, 64, false));
    expect(maskKey([a], 64, 64, false)).not.toBe(maskKey([{ ...a, feather: 0.1 }], 64, 64, false));
    expect(maskKey([a], 64, 64, false)).not.toBe(maskKey([a], 64, 32, false));
  });
});

describe("painted layers", () => {
  const bitmap = (w: number, h: number, fill: (x: number, y: number) => number) => {
    const bytes = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bytes[y * w + x] = fill(x, y);
    return encodeBitmap(w, h, bytes);
  };

  it("a painted layer shows where it was painted, at any mask resolution", () => {
    // Painted on a 64×64 bitmap, the left half; the mask is rasterised at 512.
    const layer = createPaintLayer(bitmap(64, 64, (x) => (x < 32 ? 255 : 0)));
    const { mask } = run("rm-paint", { resolution: "512", masks: [layer] });
    expect(pixel(mask, 0.2, 0.5)).toBe(255);
    expect(pixel(mask, 0.8, 0.5)).toBe(0);
    disposeNodeCaches(["rm-paint"]);
  });

  it("paint and shapes combine in one stack, in order", () => {
    const paint = createPaintLayer(bitmap(64, 64, () => 255));
    const hole = createLayer(ellipsePoints(0.5, 0.5, 0.2, 0.2), { mode: "subtract" });
    const { mask } = run("rm-mixed", { resolution: "512", masks: [paint, hole] });
    expect(pixel(mask, 0.5, 0.5)).toBe(0);
    expect(pixel(mask, 0.9, 0.9)).toBe(255);
    disposeNodeCaches(["rm-mixed"]);
  });

  it("re-rasterises when the painted pixels change, and only then", () => {
    const first = createPaintLayer(bitmap(32, 32, (x) => (x < 16 ? 255 : 0)), { id: "same" });
    const a = run("rm-repaint", { resolution: "512", masks: [first] });
    const version = a.mask.version;
    expect(run("rm-repaint", { resolution: "512", masks: [{ ...first }] }).mask.version).toBe(version);
    const edited = { ...first, bitmap: bitmap(32, 32, (x) => (x >= 16 ? 255 : 0)) };
    const b = run("rm-repaint", { resolution: "512", masks: [edited] });
    expect(b.mask.version).toBeGreaterThan(version);
    expect(pixel(b.mask, 0.8, 0.5)).toBe(255);
    expect(pixel(b.mask, 0.2, 0.5)).toBe(0);
    disposeNodeCaches(["rm-repaint"]);
  });
});

describe("Texture to Plane with a mask", () => {
  it("wires the mask in as the material's alpha map", () => {
    const { mask } = run("rm-plane", { resolution: "512", masks: [createLayer(ellipsePoints(0.5, 0.5, 0.3, 0.3))] });
    const out = TEXTURE_PLANE_NODE.evaluate(
      { mask },
      TEXTURE_PLANE_NODE.defaultParams,
      ctx("plane-masked"),
    ) as { geometry: THREE.Mesh };
    const material = out.geometry.material as THREE.MeshStandardMaterial;
    expect(material.alphaMap).toBe(mask);
    expect(material.transparent).toBe(true);

    // Unwiring it clears the map.
    const bare = TEXTURE_PLANE_NODE.evaluate({}, TEXTURE_PLANE_NODE.defaultParams, ctx("plane-masked")) as { geometry: THREE.Mesh };
    expect((bare.geometry.material as THREE.MeshStandardMaterial).alphaMap).toBeNull();
    disposeNodeCaches(["rm-plane", "plane-masked"]);
  });
});

describe("a masked texture on a 3D object", () => {
  it("is known to have alpha, so the object is not drawn opaque", async () => {
    const { textureHasAlpha } = await import("./object");
    const gpuTexture = new THREE.Texture();
    expect(textureHasAlpha(gpuTexture)).toBe(false);
    gpuTexture.userData.hasAlpha = true;
    expect(textureHasAlpha(gpuTexture)).toBe(true);
  });
});
