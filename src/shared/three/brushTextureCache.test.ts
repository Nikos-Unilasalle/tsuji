import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { BrushScene } from "./brushScene";

const renders: string[] = [];
vi.mock("./brushEngine", () => ({
  renderBrushScene: (_canvas: unknown, scene: BrushScene) => {
    renders.push(String(scene.seed));
    return true;
  },
}));

const { BrushTextureCache } = await import("./brushTextureCache");

function scene(seed: number, width = 64): BrushScene {
  const style = { enabled: false, brush: "2B", color: "#000", weight: 1 };
  return {
    width,
    height: 64,
    background: null,
    seed,
    brushScale: 1,
    field: "none",
    fieldTime: 0,
    wiggle: 0,
    curvature: 0.5,
    useStrokeColors: false,
    stroke: style,
    fill: {
      mode: "none",
      color: "#000",
      opacity: 100,
      bleed: 0,
      bleedDirection: "out",
      bleedAngle: null,
      texture: 0,
      border: 0,
      scatter: false,
    },
    hatch: { ...style, distance: 8, angle: 0, rand: 0, gradient: 0 },
    paths: [],
  };
}

describe("BrushTextureCache", () => {
  const realDocument = globalThis.document;
  beforeAll(() => {
    (globalThis as { document?: unknown }).document = { createElement: () => ({ width: 0, height: 0 }) };
  });
  afterAll(() => {
    (globalThis as { document?: unknown }).document = realDocument;
  });

  test("two evaluators alternating between two scenes paint each only once", () => {
    renders.length = 0;
    const cache = new BrushTextureCache();
    const a = cache.resolve(scene(1));
    const b = cache.resolve(scene(2));
    expect(cache.resolve(scene(1))).toBe(a);
    expect(cache.resolve(scene(2))).toBe(b);
    expect(renders).toEqual(["1", "2"]);
  });

  test("the least recently used scene is evicted and its texture reused", () => {
    renders.length = 0;
    const cache = new BrushTextureCache(2);
    const a = cache.resolve(scene(1));
    cache.resolve(scene(2));
    const c = cache.resolve(scene(3));
    expect(c).toBe(a);
    cache.resolve(scene(1));
    expect(renders).toEqual(["1", "2", "3", "1"]);
  });

  test("a size change gets a fresh texture", () => {
    const cache = new BrushTextureCache(1);
    const small = cache.resolve(scene(1, 64));
    const large = cache.resolve(scene(2, 128));
    expect(large).not.toBe(small);
  });

  test("while playing, every evaluation of one timeline frame shares a single repaint", () => {
    renders.length = 0;
    const cache = new BrushTextureCache();
    const first = cache.resolve(scene(1), 10);
    expect(cache.resolve(scene(2), 10)).toBe(first);
    cache.resolve(scene(3), 11);
    expect(renders).toEqual(["1", "3"]);
  });

  test("two playheads straddling a frame boundary don't evict each other", () => {
    renders.length = 0;
    const cache = new BrushTextureCache();
    const a96 = cache.resolve(scene(1), 96);
    const b97 = cache.resolve(scene(2), 97);
    expect(cache.resolve(scene(3), 96)).toBe(a96);
    expect(cache.resolve(scene(4), 97)).toBe(b97);
    expect(renders).toEqual(["1", "2"]);
  });

  test("a lagging playhead keeps its frame: the earliest frame is evicted, not the least recent", () => {
    renders.length = 0;
    const cache = new BrushTextureCache(2);
    cache.resolve(scene(1), 97);
    const f98 = cache.resolve(scene(2), 98);
    cache.resolve(scene(3), 97);
    cache.resolve(scene(4), 99);
    expect(cache.resolve(scene(5), 98)).toBe(f98);
    expect(renders).toEqual(["1", "2", "4"]);
  });
});
