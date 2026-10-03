import { describe, expect, test } from "vitest";
import * as THREE from "three";
import { EvalContext } from "../types";
import { BRUSH_CANVAS_NODE, buildBrushCanvasScene } from "./brushCanvas";
import { strokesToCurves } from "./greasePencil";
import { brushSceneSignature, buildBrushPaths, computeFrameTransform } from "../../three/brushScene";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "test" };

function square(size: number): THREE.CatmullRomCurve3 {
  return new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(-size, -size, 0),
      new THREE.Vector3(size, -size, 0),
      new THREE.Vector3(size, size, 0),
      new THREE.Vector3(-size, size, 0),
    ],
    true,
  );
}

const AUTO_FRAME = { mode: "auto" as const, margin: 0.1, center: new THREE.Vector3(), size: 10 };

describe("BRUSH_CANVAS_NODE", () => {
  test("headless evaluation returns no texture instead of throwing", () => {
    expect(BRUSH_CANVAS_NODE.evaluate({}, BRUSH_CANVAS_NODE.defaultParams, CTX)).toEqual({ texture: null });
  });

  test("unconnected inputs build a finite, empty scene", () => {
    const scene = buildBrushCanvasScene({}, BRUSH_CANVAS_NODE.defaultParams, CTX);
    expect(scene.paths).toEqual([]);
    expect(scene.width).toBe(1024);
    expect(Number.isFinite(scene.brushScale)).toBe(true);
    expect(scene.fill.mode).toBe("watercolor");
  });

  test("garbage params fall back to safe values", () => {
    const scene = buildBrushCanvasScene(
      { curves: [square(1)] },
      { resolution: "nope", strokeBrush: "bogus", field: "bogus", bleed: 9, fillOpacity: -4, hatchDistance: 0 },
      CTX,
    );
    expect(scene.width).toBe(1024);
    expect(scene.stroke.brush).toBe("2B");
    expect(scene.field).toBe("none");
    expect(scene.fill.bleed).toBe(1);
    expect(scene.fill.opacity).toBeGreaterThanOrEqual(1);
    expect(scene.hatch.distance).toBeGreaterThanOrEqual(1);
  });

  test("boil re-seeds every N frames and holds in between", () => {
    const params = { ...BRUSH_CANVAS_NODE.defaultParams, boil: 3, seed: 10 };
    const at = (step: number) => buildBrushCanvasScene({}, params, { ...CTX, step }).seed;
    expect(at(0)).toBe(at(2));
    expect(at(3)).not.toBe(at(2));
  });
});

describe("brushScene", () => {
  test("auto framing fits content inside the margin", () => {
    const paths = buildBrushPaths([square(2)], AUTO_FRAME, 1000, 1000);
    expect(paths).toHaveLength(1);
    for (const [x, y] of paths[0].points) {
      expect(x).toBeGreaterThanOrEqual(99);
      expect(x).toBeLessThanOrEqual(901);
      expect(y).toBeGreaterThanOrEqual(99);
      expect(y).toBeLessThanOrEqual(901);
    }
  });

  test("world +y maps to canvas up", () => {
    const t = computeFrameTransform([], { ...AUTO_FRAME, mode: "fixed", size: 10 }, 1000, 1000);
    const yTop = t.offsetY - 5 * t.scale;
    expect(yTop).toBeCloseTo(0);
  });

  test("closed paths drop the duplicated end point", () => {
    const [path] = buildBrushPaths([square(1)], AUTO_FRAME, 512, 512);
    const [ax, ay] = path.points[0];
    const [bx, by] = path.points[path.points.length - 1];
    expect(Math.hypot(ax - bx, ay - by)).toBeGreaterThan(0.5);
    expect(path.closed).toBe(true);
  });

  test("Grease Pencil pressure and colour reach the brush path", () => {
    const curves = strokesToCurves([
      {
        id: "s",
        color: "#ff0000",
        points: [
          { x: 0, y: 0, z: 0, pressure: 0.2 },
          { x: 5, y: 0, z: 0, pressure: 1 },
        ],
      },
    ]);
    const [path] = buildBrushPaths(curves, AUTO_FRAME, 512, 512);
    expect(path.color).toBe("#ff0000");
    expect(path.points[0][2]).toBeCloseTo(0.2, 1);
    expect(path.points[path.points.length - 1][2]).toBeCloseTo(1, 1);
  });

  test("degenerate curves are skipped, never NaN", () => {
    const dot = new THREE.CatmullRomCurve3([new THREE.Vector3(1, 1, 0), new THREE.Vector3(1, 1, 0)]);
    expect(buildBrushPaths([dot], AUTO_FRAME, 512, 512)).toEqual([]);
  });

  test("signature is stable for identical input and changes with geometry", () => {
    const params = BRUSH_CANVAS_NODE.defaultParams;
    const a = brushSceneSignature(buildBrushCanvasScene({ curves: [square(1)] }, params, CTX));
    const b = brushSceneSignature(buildBrushCanvasScene({ curves: [square(1)] }, params, CTX));
    const c = brushSceneSignature(buildBrushCanvasScene({ curves: [square(1), square(0.5)] }, params, CTX));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("a curve lying in XZ is framed from above, not as a flat line", () => {
    const ring = new THREE.CatmullRomCurve3(
      [0, 1, 2, 3].map((i) => new THREE.Vector3(Math.cos((i * Math.PI) / 2), 0, Math.sin((i * Math.PI) / 2))),
      true,
    );
    const [path] = buildBrushPaths([ring], AUTO_FRAME, 1000, 1000);
    const ys = path.points.map(([, y]) => y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(500);
  });
});
