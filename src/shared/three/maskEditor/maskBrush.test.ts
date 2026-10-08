import { describe, expect, it } from "vitest";
import { brushFalloff, stampBrush, strokeBrush, toBytes, toWorking } from "./maskBrush";

const W = 64;
const H = 64;
const soft = { radius: 10, hardness: 0, flow: 1, erase: false };

describe("brushFalloff", () => {
  it("is full at the centre and nothing at the rim, for a soft brush", () => {
    expect(brushFalloff(0, 10, 0)).toBe(1);
    expect(brushFalloff(10.6, 10, 0)).toBe(0);
    expect(brushFalloff(9.9, 10, 0)).toBeLessThan(0.05);
  });

  it("eases down monotonically", () => {
    let prev = 2;
    for (let d = 0; d <= 10; d += 0.5) {
      const v = brushFalloff(d, 10, 0);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
  });

  it("hardness holds the core at full strength", () => {
    expect(brushFalloff(4, 10, 0.5)).toBe(1);
    expect(brushFalloff(7.5, 10, 0.5)).toBeLessThan(1);
    expect(brushFalloff(7.5, 10, 0.5)).toBeGreaterThan(0);
  });

  it("a fully hard brush has a crisp edge a pixel wide", () => {
    expect(brushFalloff(9, 10, 1)).toBe(1);
    expect(brushFalloff(11, 10, 1)).toBe(0);
  });

  it("harder is never softer", () => {
    for (const d of [3, 5, 7, 9]) expect(brushFalloff(d, 10, 0.8)).toBeGreaterThanOrEqual(brushFalloff(d, 10, 0.2));
  });
});

describe("stampBrush", () => {
  it("paints a soft dab, strongest in the middle", () => {
    const data = new Float32Array(W * H);
    stampBrush(data, W, H, 32.5, 32.5, soft);
    expect(data[32 * W + 32]).toBeGreaterThan(250);
    expect(data[32 * W + 38]).toBeGreaterThan(0);
    expect(data[32 * W + 38]).toBeLessThan(data[32 * W + 34]);
    expect(data[32 * W + 50]).toBe(0);
  });

  it("is round, not elliptical", () => {
    const data = new Float32Array(W * H);
    stampBrush(data, W, H, 32.5, 32.5, soft);
    expect(data[32 * W + 38]).toBeCloseTo(data[38 * W + 32], 3);
  });

  it("flow scales what one dab adds, and dabs build up", () => {
    const data = new Float32Array(W * H);
    const half = { ...soft, flow: 0.5 };
    stampBrush(data, W, H, 32.5, 32.5, half);
    expect(data[32 * W + 32]).toBeCloseTo(127.5, 0);
    stampBrush(data, W, H, 32.5, 32.5, half);
    expect(data[32 * W + 32]).toBeCloseTo(191.25, 0);
  });

  it("the eraser takes it away", () => {
    const data = new Float32Array(W * H).fill(255);
    stampBrush(data, W, H, 32.5, 32.5, { ...soft, erase: true });
    expect(data[32 * W + 32]).toBeLessThan(5);
    expect(data[0]).toBe(255);
  });

  it("never goes outside 0..255", () => {
    const data = new Float32Array(W * H);
    for (let i = 0; i < 20; i++) stampBrush(data, W, H, 32.5, 32.5, soft);
    expect(Math.max(...data)).toBeLessThanOrEqual(255);
    const erase = new Float32Array(W * H).fill(255);
    for (let i = 0; i < 20; i++) stampBrush(erase, W, H, 32.5, 32.5, { ...soft, erase: true });
    expect(Math.min(...erase)).toBeGreaterThanOrEqual(0);
  });

  it("clips at the edges, and a dab wholly off the bitmap is nothing", () => {
    const data = new Float32Array(W * H);
    expect(stampBrush(data, W, H, 1, 1, soft)).not.toBeNull();
    expect(data[0]).toBeGreaterThan(200);
    expect(stampBrush(data, W, H, -50, -50, soft)).toBeNull();
    expect(stampBrush(data, W, H, 500, 20, soft)).toBeNull();
  });

  it("reports what it touched", () => {
    const data = new Float32Array(W * H);
    const dirty = stampBrush(data, W, H, 20.5, 30.5, soft)!;
    expect(dirty.x0).toBeLessThanOrEqual(10);
    expect(dirty.x1).toBeGreaterThanOrEqual(30);
    expect(dirty.y0).toBeLessThanOrEqual(20);
  });
});

describe("strokeBrush", () => {
  it("a fast drag is one unbroken line", () => {
    const data = new Float32Array(W * H);
    strokeBrush(data, W, H, { x: 5, y: 32.5 }, { x: 58, y: 32.5 }, soft);
    for (let x = 8; x <= 55; x++) expect(data[32 * W + x]).toBeGreaterThan(200);
  });

  it("is not darker where it is drawn slowly", () => {
    const hard = { ...soft, hardness: 1, flow: 0.4 };
    const fast = new Float32Array(W * H);
    strokeBrush(fast, W, H, { x: 10, y: 32.5 }, { x: 54, y: 32.5 }, hard);
    const slow = new Float32Array(W * H);
    let at = { x: 10, y: 32.5 };
    for (let x = 14; x <= 54; x += 4) {
      strokeBrush(slow, W, H, at, { x, y: 32.5 }, hard);
      at = { x, y: 32.5 };
    }
    // The same path in many short segments paints the same amount, within the spacing's own ripple.
    expect(slow[32 * W + 32]).toBeCloseTo(fast[32 * W + 32], -1);
  });

  it("with no start it is a single dab", () => {
    const data = new Float32Array(W * H);
    expect(strokeBrush(data, W, H, null, { x: 32.5, y: 32.5 }, soft)).not.toBeNull();
    expect(data[32 * W + 32]).toBeGreaterThan(250);
  });

  it("converts to bytes and back", () => {
    const bytes = toBytes(Float32Array.from([-5, 0.4, 127.5, 255.4, 999]));
    expect(Array.from(bytes)).toEqual([0, 0, 128, 255, 255]);
    expect(Array.from(toWorking(Uint8Array.from([1, 2])))).toEqual([1, 2]);
  });
});

describe("what a stroke costs to keep", () => {
  it("a long soft stroke on a 1024² mask encodes small, and an empty one tiny", async () => {
    const { encodeBytes } = await import("../../graph/maskBitmap");
    const w = 1024;
    const h = 1024;
    const data = new Float32Array(w * h);
    strokeBrush(data, w, h, { x: 100, y: 200 }, { x: 900, y: 700 }, { radius: 60, hardness: 0.3, flow: 1, erase: false });
    const encoded = encodeBytes(toBytes(data));
    // Params are cloned into every undo step and saved with the project, so this is the figure that matters.
    expect(encoded.length).toBeLessThan(400_000);
    expect(encodeBytes(new Uint8Array(w * h)).length).toBeLessThan(16);
  });
});
