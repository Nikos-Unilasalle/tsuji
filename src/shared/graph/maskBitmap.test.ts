import { describe, expect, it } from "vitest";
import {
  bitmapFingerprint,
  decodeBitmap,
  decodeBytes,
  emptyBitmap,
  encodeBitmap,
  encodeBytes,
  isValidBitmap,
} from "./maskBitmap";
import { createPaintLayer, sanitizeLayers } from "./maskShapes";
import { compositeMasks, layerAlpha, boxBlur, resampleBitmap } from "./maskRaster";

describe("run-length bitmap", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = Uint8Array.from({ length: 5000 }, (_, i) => (i % 7 === 0 ? (i * 37) & 255 : 0));
    expect(Array.from(decodeBytes(encodeBytes(bytes), bytes.length))).toEqual(Array.from(bytes));
  });

  it("round-trips long runs, past a one-byte count", () => {
    const bytes = new Uint8Array(100000).fill(255);
    bytes[500] = 3;
    expect(Array.from(decodeBytes(encodeBytes(bytes), bytes.length))).toEqual(Array.from(bytes));
  });

  it("an empty megapixel is a few bytes, not a megabyte", () => {
    expect(emptyBitmap(1024, 1024).data.length).toBeLessThan(16);
  });

  it("is deterministic", () => {
    const bytes = Uint8Array.from([1, 1, 2, 3, 3, 3]);
    expect(encodeBytes(bytes)).toBe(encodeBytes(bytes));
  });

  it("corrupt or short data never throws and never overruns", () => {
    expect(decodeBytes("!!!not base64!!!", 10)).toHaveLength(10);
    expect(Array.from(decodeBytes("", 4))).toEqual([0, 0, 0, 0]);
    // A run claiming far more than the bitmap holds is clipped to it.
    const big = encodeBytes(new Uint8Array(1000).fill(9));
    expect(decodeBytes(big, 10)).toHaveLength(10);
    expect(Array.from(decodeBytes(big, 10)).every((v) => v === 9)).toBe(true);
  });

  it("validates a bitmap's shape", () => {
    expect(isValidBitmap({ w: 4, h: 4, data: "" })).toBe(true);
    expect(isValidBitmap({ w: 0, h: 4, data: "" })).toBe(false);
    expect(isValidBitmap({ w: 99999, h: 4, data: "" })).toBe(false);
    expect(isValidBitmap({ w: 1.5, h: 4, data: "" })).toBe(false);
    expect(isValidBitmap({ w: 4, h: 4 })).toBe(false);
    expect(isValidBitmap(null)).toBe(false);
  });

  it("decodeBitmap hands back the same bytes for the same data", () => {
    const bitmap = encodeBitmap(2, 2, Uint8Array.from([0, 255, 128, 7]));
    expect(Array.from(decodeBitmap(bitmap))).toEqual([0, 255, 128, 7]);
    expect(decodeBitmap(bitmap)).toBe(decodeBitmap({ ...bitmap }));
  });

  it("the fingerprint changes with the pixels and the size, not with the object", () => {
    const a = encodeBitmap(2, 2, Uint8Array.from([0, 255, 0, 0]));
    const b = encodeBitmap(2, 2, Uint8Array.from([0, 255, 0, 1]));
    expect(bitmapFingerprint(a)).toBe(bitmapFingerprint({ ...a }));
    expect(bitmapFingerprint(a)).not.toBe(bitmapFingerprint(b));
    expect(bitmapFingerprint(a)).not.toBe(bitmapFingerprint({ ...a, w: 1, h: 4 }));
  });
});

describe("paint layers in the stack", () => {
  const painted = (w: number, h: number, fill: (x: number, y: number) => number) => {
    const bytes = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bytes[y * w + x] = fill(x, y);
    return encodeBitmap(w, h, bytes);
  };

  it("sanitizeLayers keeps a paint layer and its bitmap, and drops a corrupt bitmap", () => {
    const bitmap = emptyBitmap(8, 8);
    const [kept] = sanitizeLayers([createPaintLayer(bitmap, { id: "p" })]);
    expect(kept.kind).toBe("paint");
    expect(kept.bitmap).toEqual(bitmap);
    expect(kept.name).toBe("Paint");
    const [broken] = sanitizeLayers([{ id: "q", kind: "paint", bitmap: { w: -1, h: 2, data: "x" } }]);
    expect(broken.kind).toBe("paint");
    expect(broken.bitmap).toBeUndefined();
  });

  it("a painted layer shows where it is painted", () => {
    const layer = createPaintLayer(painted(16, 8, (x) => (x < 8 ? 255 : 0)));
    const a = layerAlpha(layer, 16, 8);
    expect(a[3]).toBe(1);
    expect(a[12]).toBe(0);
  });

  it("an unpainted paint layer counts as nothing yet: the image stays whole", () => {
    expect(compositeMasks([createPaintLayer(emptyBitmap(16, 8))], 16, 8).every((v) => v === 0)).toBe(true);
    expect(compositeMasks([{ ...createPaintLayer(emptyBitmap(4, 4)), bitmap: undefined }], 16, 8).every((v) => v === 1)).toBe(true);
  });

  it("is resampled when the mask is a different size", () => {
    const layer = createPaintLayer(painted(8, 4, (x) => (x < 4 ? 255 : 0)));
    const a = layerAlpha(layer, 32, 16);
    expect(a[2]).toBe(1);
    expect(a[30]).toBe(0);
    expect(a.length).toBe(32 * 16);
  });

  it("opacity, invert and mode apply to it like to a shape", () => {
    const bitmap = painted(8, 8, () => 255);
    expect(layerAlpha({ ...createPaintLayer(bitmap), opacity: 0.5 }, 8, 8)[0]).toBeCloseTo(0.5);
    expect(layerAlpha({ ...createPaintLayer(bitmap), invert: true }, 8, 8)[0]).toBe(0);
    const base = createPaintLayer(bitmap);
    const hole = createPaintLayer(painted(8, 8, (x) => (x < 4 ? 255 : 0)), { mode: "subtract" });
    const m = compositeMasks([base, hole], 8, 8);
    expect(m[1]).toBe(0);
    expect(m[6]).toBe(1);
  });

  it("feather blurs a paint layer's edge", () => {
    const bitmap = painted(32, 32, (x) => (x < 16 ? 255 : 0));
    const hard = layerAlpha(createPaintLayer(bitmap), 32, 32);
    const soft = layerAlpha({ ...createPaintLayer(bitmap), feather: 0.25 }, 32, 32);
    expect(hard[16 * 32 + 17]).toBe(0);
    expect(soft[16 * 32 + 17]).toBeGreaterThan(0.05);
    expect(soft[16 * 32 + 14]).toBeLessThan(1);
    for (const v of soft) {
      expect(v).toBeGreaterThanOrEqual(-1e-6);
      expect(v).toBeLessThanOrEqual(1 + 1e-6);
    }
  });
});

describe("raster helpers", () => {
  it("boxBlur keeps a flat field flat and spreads an edge", () => {
    const flat = new Float32Array(16 * 16).fill(0.5);
    boxBlur(flat, 16, 16, 3);
    expect(flat.every((v) => Math.abs(v - 0.5) < 1e-5)).toBe(true);
    const edge = new Float32Array(16 * 16);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) edge[y * 16 + x] = 1;
    boxBlur(edge, 16, 16, 2);
    expect(edge[8 * 16 + 7]).toBeLessThan(1);
    expect(edge[8 * 16 + 8]).toBeGreaterThan(0);
  });

  it("resampleBitmap at the same size is exact", () => {
    const out = resampleBitmap(Uint8Array.from([0, 255, 51, 102]), 2, 2, 2, 2);
    [0, 1, 0.2, 0.4].forEach((v, i) => expect(out[i]).toBeCloseTo(v, 6));
  });
});
