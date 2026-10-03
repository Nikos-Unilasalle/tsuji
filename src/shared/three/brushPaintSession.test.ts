import { describe, expect, test } from "vitest";
import { brushPaintSample, buildPaintScene, endBrushPaint, isBrushPaintTool } from "./brushPaintSession";
import { applyPaintStroke } from "./texturePainter";
import { texturePaintP5Style } from "../graph/nodes/texturePaint";

const STYLE = {
  brush: "2B",
  color: "#335588",
  size: 24,
  opacity: 1,
  bleed: 0.3,
  texture: 0.5,
  border: 0.4,
  symmetryX: false,
};

const POINTS: Array<[number, number, number]> = [
  [100, 100, 1],
  [200, 120, 0.5],
  [180, 220, 0.8],
];

describe("brushPaintSession", () => {
  test("only the p5 tools are routed to the session", () => {
    expect(isBrushPaintTool("brush")).toBe(true);
    expect(isBrushPaintTool("watercolor")).toBe(true);
    expect(isBrushPaintTool("paint")).toBe(false);
  });

  test("watercolor fills a closed region without an outline", () => {
    const scene = buildPaintScene("watercolor", STYLE, POINTS, 1024, 1024, 7);
    expect(scene.fill.mode).toBe("watercolor");
    expect(scene.stroke.enabled).toBe(false);
    expect(scene.paths[0].closed).toBe(true);
    expect(scene.background).toBeNull();
  });

  test("brush strokes an open path with the chosen brush", () => {
    const scene = buildPaintScene("brush", STYLE, POINTS, 1024, 1024, 7);
    expect(scene.fill.mode).toBe("none");
    expect(scene.stroke).toMatchObject({ enabled: true, brush: "2B", color: "#335588" });
    expect(scene.stroke.weight).toBeGreaterThan(0);
    expect(scene.paths[0].closed).toBe(false);
  });

  test("Mirror X adds a reflected copy of the path", () => {
    const scene = buildPaintScene("brush", { ...STYLE, symmetryX: true }, POINTS, 1000, 1000, 7);
    expect(scene.paths).toHaveLength(2);
    expect(scene.paths[1].points[0][0]).toBe(900);
  });

  test("headless sampling is a no-op rather than a throw", () => {
    const canvas = {} as HTMLCanvasElement;
    expect(brushPaintSample(canvas, "brush", STYLE, 1, 1, 1, true)).toBe(false);
    expect(endBrushPaint(canvas)).toBe(false);
  });

  test("applyPaintStroke routes the p5 tools away from the stamp brushes", () => {
    const canvas = { width: 64, height: 64, getContext: () => ({}) } as unknown as HTMLCanvasElement;
    expect(() =>
      applyPaintStroke(canvas, {
        tool: "watercolor",
        color: "#ff0000",
        radius: 10,
        opacity: 1,
        hardness: 0.5,
        uv: { x: 0.5, y: 0.5 },
      }),
    ).not.toThrow();
  });

  test("Texture Paint p5 settings are clamped and validated", () => {
    expect(texturePaintP5Style({ p5Brush: "bogus", watercolorBleed: 4, watercolorTexture: "x" })).toEqual({
      brush: "2B",
      bleed: 1,
      texture: 0.5,
      border: 0.4,
    });
  });
});
