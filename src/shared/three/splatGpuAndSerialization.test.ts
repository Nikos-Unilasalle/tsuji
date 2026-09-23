import { describe, expect, it } from "vitest";
import {
  LAYERS_PER_SPLAT_TEXTURE,
  MAX_GPU_LAYERS,
  buildSplatFragmentShader,
  compositeOnGpu,
  packSplatBytes,
  splatTextureCount,
} from "./splatCompositorGPU";
import {
  LAYERS_PER_IMAGE,
  bytesToBase64,
  imageCountFor,
  isSplatEnvelope,
  packLayerGroup,
  parseSplatEnvelope,
  restoreSplatAuto,
  serializeSplatToPng,
  unpackLayerGroup,
} from "./splatSerialization";
import { createSplatBuffer, serializeSplatBuffer } from "./textureMixEngine";

describe("packSplatBytes", () => {
  it("quantizes weights into RGBA channels, one layer per channel", () => {
    const w = 2;
    const h = 2;
    const layers = 3;
    const weights = new Float32Array(w * h * layers);
    // Pixel 0: layer0 = 1, pixel 1: layer2 = 0.5.
    weights[0] = 1;
    weights[1 * layers + 2] = 0.5;

    const bytes = new Uint8Array(w * h * 4);
    packSplatBytes(weights, w, h, layers, [bytes]);

    expect(bytes[0]).toBe(255);
    expect(bytes[1]).toBe(0);
    expect(bytes[6]).toBe(128); // pixel 1, blue channel = layer 2
    // The fourth channel has no layer behind it and must be zero.
    expect(bytes[3]).toBe(0);
  });

  it("spreads layers past the fourth into the second texture", () => {
    const layers = 6;
    const weights = new Float32Array(1 * 1 * layers);
    weights[5] = 1; // layer 5 -> texture 1, green channel

    const t0 = new Uint8Array(4);
    const t1 = new Uint8Array(4);
    packSplatBytes(weights, 1, 1, layers, [t0, t1]);

    expect(Array.from(t0)).toEqual([0, 0, 0, 0]);
    expect(t1[1]).toBe(255);
  });

  it("only repacks the requested region", () => {
    const size = 4;
    const layers = 2;
    const weights = new Float32Array(size * size * layers).fill(1);
    const bytes = new Uint8Array(size * size * 4);

    packSplatBytes(weights, size, size, layers, [bytes], { minX: 0, minY: 0, maxX: 0, maxY: 0 });
    expect(bytes[0]).toBe(255);
    // Anything outside the rect must be untouched — that is the whole point.
    expect(bytes[(3 * size + 3) * 4]).toBe(0);
  });

  it("sizes the texture set from the layer count", () => {
    expect(splatTextureCount(1)).toBe(1);
    expect(splatTextureCount(LAYERS_PER_SPLAT_TEXTURE)).toBe(1);
    expect(splatTextureCount(LAYERS_PER_SPLAT_TEXTURE + 1)).toBe(2);
    expect(splatTextureCount(MAX_GPU_LAYERS)).toBe(2);
  });
});

describe("buildSplatFragmentShader", () => {
  it("unrolls one guarded block per layer slot", () => {
    const src = buildSplatFragmentShader(MAX_GPU_LAYERS);
    for (let i = 0; i < MAX_GPU_LAYERS; i++) {
      expect(src).toContain(`uniform sampler2D uLayer${i};`);
      expect(src).toContain(`if (uLayerCount > ${i})`);
    }
    // Weights come from two RGBA textures, not a sampler array.
    expect(src).toContain("w0[0]");
    expect(src).toContain("w1[0]");
    expect(src).not.toContain("uLayers[");
  });

  it("normalizes by the accumulated weight so drifted maps stay stable", () => {
    expect(buildSplatFragmentShader()).toContain("acc / total");
  });
});

describe("compositeOnGpu", () => {
  it("declines without a renderer, so the caller falls back to the CPU", () => {
    const weights = createSplatBuffer(4, 4, 2);
    expect(compositeOnGpu(null, {}, [{ color: "#fff" }], weights, 4, 2)).toBeNull();
  });

  it("declines when there are more layers than the shader binds", () => {
    const weights = createSplatBuffer(4, 4, 12);
    const fakeRenderer = {} as never;
    expect(compositeOnGpu(fakeRenderer, {}, [], weights, 4, MAX_GPU_LAYERS + 1)).toBeNull();
  });
});

describe("splat PNG packing", () => {
  it("round-trips weights through the RGBA packing", () => {
    const w = 4;
    const h = 4;
    const layers = 3;
    const weights = new Float32Array(w * h * layers);
    for (let p = 0; p < w * h; p++) {
      weights[p * layers] = 0.25;
      weights[p * layers + 1] = 0.5;
      weights[p * layers + 2] = 0.25;
    }

    const bytes = packLayerGroup(weights, w, h, layers, 0);
    const restored = new Float32Array(w * h * layers);
    unpackLayerGroup(restored, bytes, w, h, layers, 0);

    for (let i = 0; i < weights.length; i++) {
      expect(restored[i]).toBeCloseTo(weights[i], 2);
    }
  });

  it("round-trips a layer that lives in the second image", () => {
    const layers = 6;
    const weights = new Float32Array(2 * 2 * layers);
    weights[0 * layers + 4] = 1;
    weights[3 * layers + 5] = 0.5;

    const group1 = packLayerGroup(weights, 2, 2, layers, 1);
    const restored = new Float32Array(2 * 2 * layers);
    unpackLayerGroup(restored, group1, 2, 2, layers, 1);

    expect(restored[0 * layers + 4]).toBeCloseTo(1, 2);
    expect(restored[3 * layers + 5]).toBeCloseTo(0.5, 2);
  });

  it("needs one image per four layers", () => {
    expect(imageCountFor(1)).toBe(1);
    expect(imageCountFor(LAYERS_PER_IMAGE)).toBe(1);
    expect(imageCountFor(LAYERS_PER_IMAGE + 1)).toBe(2);
    expect(imageCountFor(8)).toBe(2);
  });
});

describe("splat envelope", () => {
  it("recognizes its own payloads and rejects the legacy format", () => {
    const envelope = JSON.stringify({ v: 1, w: 4, h: 4, l: 2, png: ["data:image/png;base64,x"] });
    expect(isSplatEnvelope(envelope)).toBe(true);
    expect(parseSplatEnvelope(envelope)?.l).toBe(2);

    const legacy = serializeSplatBuffer(createSplatBuffer(4, 4, 2));
    expect(isSplatEnvelope(legacy)).toBe(false);
    expect(parseSplatEnvelope(legacy)).toBeNull();
    expect(parseSplatEnvelope("{\"v\":1, broken")).toBeNull();
  });

  it("still restores files written in the legacy raw format", () => {
    const weights = createSplatBuffer(4, 4, 2);
    weights[0] = 0.5;
    weights[1] = 0.5;
    const legacy = serializeSplatBuffer(weights);

    let restored: Float32Array | null = null;
    restoreSplatAuto(legacy, 4, 4, 2, (w) => {
      restored = w;
    });

    expect(restored).not.toBeNull();
    expect((restored as unknown as Float32Array)[0]).toBeCloseTo(0.5, 2);
  });

  it("refuses a payload baked at another resolution rather than stretching it", () => {
    const envelope = JSON.stringify({ v: 1, w: 512, h: 512, l: 2, png: ["data:image/png;base64,x"] });
    let called = false;
    let value: Float32Array | null = new Float32Array(1);
    restoreSplatAuto(envelope, 1024, 1024, 2, (w) => {
      called = true;
      value = w;
    });
    expect(called).toBe(true);
    expect(value).toBeNull();
  });

  it("reports nothing for an empty payload", () => {
    let value: Float32Array | null = new Float32Array(1);
    restoreSplatAuto("", 4, 4, 2, (w) => {
      value = w;
    });
    expect(value).toBeNull();
  });

  it("degrades to an empty payload when there is no canvas to encode with", () => {
    // Headless: the live buffer stays authoritative rather than being lost.
    expect(serializeSplatToPng(createSplatBuffer(4, 4, 2), 4, 4, 2)).toBe("");
  });
});

describe("bytesToBase64", () => {
  it("encodes in chunks rather than one character at a time", () => {
    const bytes = new Uint8Array(100_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;

    const started = Date.now();
    const encoded = bytesToBase64(bytes);
    // The old per-character concat took seconds on a buffer this size.
    expect(Date.now() - started).toBeLessThan(500);
    expect(encoded.length).toBeGreaterThan(100_000);
    expect(atob(encoded).charCodeAt(5)).toBe(5);
  });
});
