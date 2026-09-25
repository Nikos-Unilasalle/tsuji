import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { OUTPUT_SIZE_CUSTOM, OUTPUT_SIZE_INHERIT, outputSizeFields, resolveOutputSize, textureRevision, textureSize } from "./gpuTexture";
import { TEXTURE_BLUR_NODE, TEXTURE_LEVELS_NODE } from "./nodes/textureTools";

const sized = (width: number, height: number) => {
  const t = new THREE.Texture();
  t.image = { width, height };
  return t;
};

describe("resolveOutputSize", () => {
  it("follows the input's real dimensions by default, including legacy graphs with no size param", () => {
    expect(resolveOutputSize({ size: OUTPUT_SIZE_INHERIT }, [sized(1920, 1080)])).toEqual([1920, 1080]);
    expect(resolveOutputSize({ resolution: 256 }, [sized(1920, 1080)])).toEqual([1920, 1080]);
  });

  it("skips inputs with no known size and falls back when none have one", () => {
    expect(resolveOutputSize({}, [null, sized(800, 600)])).toEqual([800, 600]);
    expect(resolveOutputSize({}, [new THREE.Texture()], [512, 256])).toEqual([512, 256]);
  });

  it("uses presets and custom width × height", () => {
    expect(resolveOutputSize({ size: "3840 × 2160 (4K UHD)" }, [sized(10, 10)])).toEqual([3840, 2160]);
    expect(resolveOutputSize({ size: OUTPUT_SIZE_CUSTOM, width: 1000, height: 400 }, [])).toEqual([1000, 400]);
  });

  it("only shows width/height fields for Custom", () => {
    expect(outputSizeFields({ size: OUTPUT_SIZE_INHERIT }).map((f) => f.id)).toEqual(["size"]);
    expect(outputSizeFields({ size: OUTPUT_SIZE_CUSTOM }).map((f) => f.id)).toEqual(["size", "width", "height"]);
  });
});

describe("textureSize / textureRevision", () => {
  it("reads video dimensions over element attributes", () => {
    const t = new THREE.Texture();
    t.image = { width: 0, height: 0, videoWidth: 1280, videoHeight: 720 };
    expect(textureSize(t)).toEqual([1280, 720]);
  });

  it("changes when a regular texture is re-uploaded", () => {
    const t = sized(4, 4);
    const before = textureRevision(t);
    t.needsUpdate = true;
    expect(textureRevision(t)).not.toBe(before);
  });
});

describe("texture tool nodes", () => {
  it("expose Output Size instead of a square pixel resolution", () => {
    for (const def of [TEXTURE_BLUR_NODE, TEXTURE_LEVELS_NODE]) {
      const ids = def.dynamicParamFields!({ id: "n", type: def.type, position: { x: 0, y: 0 }, params: def.defaultParams } as never).map((f) => f.id);
      expect(ids).toContain("size");
      expect(ids).not.toContain("resolution");
    }
  });

  it("degrade to null without a renderer", () => {
    const out = TEXTURE_BLUR_NODE.evaluate({ texture: sized(64, 64) }, TEXTURE_BLUR_NODE.defaultParams, { nodeId: "blur-test" } as never);
    expect(out.texture).toBeNull();
  });
});

describe("new texture nodes", () => {
  it("register generators with explicit sizes and no inherit option", async () => {
    const { TEXTURE_NOISE_NODE, TEXTURE_WAVE_NODE } = await import("./nodes/textureTools");
    for (const def of [TEXTURE_NOISE_NODE, TEXTURE_WAVE_NODE]) {
      const size = def.dynamicParamFields!({ id: "n", type: def.type, position: { x: 0, y: 0 }, params: def.defaultParams } as never).find((f) => f.id === "size");
      expect(size && "options" in size ? size.options : []).not.toContain(OUTPUT_SIZE_INHERIT);
    }
  });
});
