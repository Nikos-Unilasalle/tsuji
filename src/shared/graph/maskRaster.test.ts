import { describe, expect, it } from "vitest";
import { compositeMasks, distanceTransform, fillPolygon, layerAlpha, maskToRgba } from "./maskRaster";
import { createLayer, ellipsePoints, rectPoints } from "./maskShapes";

const W = 64;
const H = 48;
const at = (a: Float32Array, x: number, y: number) => a[y * W + x];

describe("fillPolygon", () => {
  it("fills a pixel-aligned rectangle exactly", () => {
    const c = fillPolygon([10, 10, 30, 10, 30, 20, 10, 20], W, H);
    expect(at(c, 20, 15)).toBe(1);
    expect(at(c, 9, 15)).toBe(0);
    expect(at(c, 30, 15)).toBe(0);
    expect(at(c, 20, 20)).toBe(0);
    let area = 0;
    for (const v of c) area += v;
    expect(area).toBeCloseTo(200, 3);
  });

  it("anti-aliases a half-covered pixel", () => {
    const c = fillPolygon([10.5, 10, 30, 10, 30, 20, 10.5, 20], W, H);
    expect(at(c, 10, 15)).toBeCloseTo(0.5, 2);
  });

  it("covers area proportional to the shape, either winding direction", () => {
    const ccw = fillPolygon([10, 10, 30, 10, 20, 30], W, H);
    const cw = fillPolygon([10, 10, 20, 30, 30, 10], W, H);
    let a = 0;
    let b = 0;
    for (let i = 0; i < ccw.length; i++) {
      a += ccw[i];
      b += cw[i];
    }
    expect(a).toBeCloseTo(0.5 * 20 * 20, 0);
    expect(b).toBeCloseTo(a, 3);
  });

  it("keeps whatever lies inside the image of a shape that runs off it", () => {
    const c = fillPolygon([-20, -20, 100, -20, 100, 100, -20, 100], W, H);
    expect(at(c, 0, 0)).toBe(1);
    expect(at(c, W - 1, H - 1)).toBe(1);
  });

  it("fewer than three points is empty", () => {
    expect(fillPolygon([1, 1, 5, 5], W, H).every((v) => v === 0)).toBe(true);
  });
});

describe("distanceTransform", () => {
  it("measures Euclidean distance to the nearest set pixel", () => {
    const on = new Uint8Array(W * H);
    on[20 * W + 20] = 1;
    const d = distanceTransform(on, W, H);
    expect(d[20 * W + 20]).toBe(0);
    expect(d[20 * W + 23]).toBeCloseTo(3, 5);
    expect(d[24 * W + 23]).toBeCloseTo(5, 5);
  });

  it("an empty image is far from everything, without NaN", () => {
    const d = distanceTransform(new Uint8Array(W * H), W, H);
    expect(Number.isNaN(d[0])).toBe(false);
    expect(d[0]).toBeGreaterThan(1e6);
  });
});

describe("layerAlpha", () => {
  const box = () => createLayer(rectPoints(0.25, 0.25, 0.75, 0.75));

  it("a hard shape is solid inside and clear outside", () => {
    const a = layerAlpha(box(), W, H);
    expect(at(a, W / 2, H / 2)).toBe(1);
    expect(at(a, 2, 2)).toBe(0);
  });

  it("feather softens the edge, centred on the outline", () => {
    const hard = layerAlpha(box(), W, H);
    const soft = layerAlpha({ ...box(), feather: 0.2 }, W, H);
    const edgeX = Math.round(0.25 * W);
    // Right on the outline it is about half; further out it is partly lit where the hard one is black.
    expect(at(soft, edgeX, H / 2)).toBeGreaterThan(0.3);
    expect(at(soft, edgeX, H / 2)).toBeLessThan(0.7);
    expect(at(soft, edgeX - 4, H / 2)).toBeGreaterThan(at(hard, edgeX - 4, H / 2));
    expect(at(soft, edgeX + 4, H / 2)).toBeLessThan(1);
    // Deep inside and far outside are untouched.
    expect(at(soft, W / 2, H / 2)).toBeCloseTo(1, 3);
    expect(at(soft, 0, 0)).toBeCloseTo(0, 3);
  });

  it("is monotonic across the feather, never overshooting", () => {
    const soft = layerAlpha({ ...box(), feather: 0.25 }, W, H);
    let prev = -1;
    for (let x = 0; x <= W / 2; x++) {
      const v = at(soft, x, H / 2);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-6);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
  });

  it("positive expansion grows the shape, negative shrinks it", () => {
    const sum = (a: Float32Array) => a.reduce((s, v) => s + v, 0);
    const base = sum(layerAlpha(box(), W, H));
    expect(sum(layerAlpha({ ...box(), expansion: 0.05 }, W, H))).toBeGreaterThan(base * 1.1);
    expect(sum(layerAlpha({ ...box(), expansion: -0.05 }, W, H))).toBeLessThan(base * 0.9);
  });

  it("opacity scales it and invert flips it", () => {
    const half = layerAlpha({ ...box(), opacity: 0.5 }, W, H);
    expect(at(half, W / 2, H / 2)).toBeCloseTo(0.5, 5);
    const flipped = layerAlpha({ ...box(), invert: true }, W, H);
    expect(at(flipped, W / 2, H / 2)).toBe(0);
    expect(at(flipped, 1, 1)).toBe(1);
  });
});

describe("compositeMasks", () => {
  const left = () => createLayer(rectPoints(0, 0, 0.6, 1));
  const right = () => createLayer(rectPoints(0.4, 0, 1, 1));
  const px = (m: Float32Array, u: number) => at(m, Math.floor(u * W), H / 2);

  it("no layers leaves the image whole", () => {
    expect(compositeMasks([], W, H).every((v) => v === 1)).toBe(true);
    expect(compositeMasks([{ ...left(), visible: false }], W, H).every((v) => v === 1)).toBe(true);
  });

  it("a layer with fewer than three points does not count yet", () => {
    expect(compositeMasks([createLayer([])], W, H).every((v) => v === 1)).toBe(true);
  });

  it("add is the union", () => {
    const m = compositeMasks([left(), right()], W, H);
    expect(px(m, 0.2)).toBe(1);
    expect(px(m, 0.5)).toBe(1);
    expect(px(m, 0.8)).toBe(1);
  });

  it("subtract cuts the upper layer out of the lower", () => {
    const m = compositeMasks([left(), { ...right(), mode: "subtract" }], W, H);
    expect(px(m, 0.2)).toBe(1);
    expect(px(m, 0.5)).toBe(0);
    expect(px(m, 0.8)).toBe(0);
  });

  it("intersect keeps the overlap only", () => {
    const m = compositeMasks([left(), { ...right(), mode: "intersect" }], W, H);
    expect(px(m, 0.2)).toBe(0);
    expect(px(m, 0.5)).toBe(1);
    expect(px(m, 0.8)).toBe(0);
  });

  it("difference keeps where exactly one is", () => {
    const m = compositeMasks([left(), { ...right(), mode: "difference" }], W, H);
    expect(px(m, 0.2)).toBe(1);
    expect(px(m, 0.5)).toBe(0);
    expect(px(m, 0.8)).toBe(1);
  });

  it("a stack that opens with subtract starts from a full image: a hole", () => {
    const hole = createLayer(ellipsePoints(0.5, 0.5, 0.2, 0.3), { mode: "subtract" });
    const m = compositeMasks([hole], W, H);
    expect(px(m, 0.5)).toBe(0);
    expect(px(m, 0.05)).toBe(1);
  });

  it("order matters: a subtract above an add is not the same as below it", () => {
    const a = compositeMasks([left(), { ...right(), mode: "subtract" }], W, H);
    const b = compositeMasks([{ ...right(), mode: "subtract" }, left()], W, H);
    expect(px(a, 0.5)).toBe(0);
    expect(px(b, 0.5)).toBe(1);
  });

  it("two feathered edges meeting stay within 0..1", () => {
    const m = compositeMasks([{ ...left(), feather: 0.2 }, { ...right(), feather: 0.2 }], W, H);
    for (const v of m) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1.0000001);
    }
  });
});

describe("maskToRgba", () => {
  it("greys, opaque, clamped", () => {
    const rgba = maskToRgba(Float32Array.from([0, 0.5, 1, 2]));
    expect(Array.from(rgba)).toEqual([0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
  });

  it("reuses a buffer of the right size", () => {
    const target = new Uint8Array(8);
    expect(maskToRgba(Float32Array.from([1, 0]), target)).toBe(target);
  });
});
