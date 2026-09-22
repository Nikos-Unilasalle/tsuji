import { describe, expect, it } from "vitest";
import {
  buildPolylinePoints,
  buildShapePoints,
  densifyShapePoints,
  rectCorners,
  snapAngle,
} from "./strokeShapes";
import {
  carveStrokesWithLasso,
  deleteStrokes,
  pointInPolygon,
  selectStrokesInLasso,
  translateStrokes,
} from "./strokeLasso";
import {
  computeFillRegion,
  createFillGrid,
  dilateGrid,
  floodFill,
  rasterizePolyline,
  simplifyContour,
  traceRegionContour,
} from "./strokeFill";
import { GreaseStroke, KeyframeDrawing, StrokePoint } from "../graph/nodes/greasePencil";

describe("strokeShapes", () => {
  it("snaps a line to 15° increments under constrain", () => {
    const snapped = snapAngle({ x: 0, y: 0 }, { x: 100, y: 8 });
    expect(snapped.y).toBeCloseTo(0, 6);
    expect(snapped.x).toBeCloseTo(Math.hypot(100, 8), 6);
  });

  it("builds a line of exactly two points", () => {
    expect(buildShapePoints("line", { x: 0, y: 0 }, { x: 10, y: 5 })).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 5 },
    ]);
  });

  it("draws a line from the centre when fromCenter is set", () => {
    const [a, b] = buildShapePoints("line", { x: 0, y: 0 }, { x: 10, y: 0 }, { fromCenter: true });
    expect(a).toEqual({ x: -10, y: 0 });
    expect(b).toEqual({ x: 10, y: 0 });
  });

  it("closes a rectangle back on its first corner", () => {
    const pts = buildShapePoints("rect", { x: 0, y: 0 }, { x: 10, y: 4 });
    expect(pts).toHaveLength(5);
    expect(pts[0]).toEqual(pts[4]);
    expect(pts[2]).toEqual({ x: 10, y: 4 });
  });

  it("forces a square when constrained", () => {
    const { minX, maxX, minY, maxY } = rectCorners({ x: 0, y: 0 }, { x: 40, y: 10 }, { constrain: true });
    expect(maxX - minX).toBeCloseTo(maxY - minY);
  });

  it("centres a rectangle on the anchor with fromCenter", () => {
    const { minX, maxX, minY, maxY } = rectCorners({ x: 0, y: 0 }, { x: 10, y: 5 }, { fromCenter: true });
    expect(minX).toBe(-10);
    expect(maxX).toBe(10);
    expect(minY).toBe(-5);
    expect(maxY).toBe(5);
  });

  it("builds a closed ellipse inscribed in the drag box", () => {
    const pts = buildShapePoints("ellipse", { x: 0, y: 0 }, { x: 100, y: 50 }, { segments: 40 });
    expect(pts).toHaveLength(41);
    expect(pts[0].x).toBeCloseTo(pts[40].x);
    expect(pts[0].y).toBeCloseTo(pts[40].y);
    for (const p of pts) {
      const nx = (p.x - 50) / 50;
      const ny = (p.y - 25) / 25;
      expect(nx * nx + ny * ny).toBeCloseTo(1, 5);
    }
  });

  it("makes a circle under constrain", () => {
    const pts = buildShapePoints("ellipse", { x: 0, y: 0 }, { x: 100, y: 20 }, { constrain: true, segments: 24 });
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    expect(w).toBeCloseTo(h, 5);
  });

  it("builds an arc that starts and ends on the drag corners", () => {
    const pts = buildShapePoints("arc", { x: 0, y: 0 }, { x: 100, y: 100 }, { segments: 16 });
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1].x).toBeCloseTo(100);
    expect(pts[pts.length - 1].y).toBeCloseTo(100);
    // Mid-arc bulges away from the straight chord.
    const mid = pts[8];
    expect(Math.abs(mid.x - mid.y)).toBeGreaterThan(10);
  });

  it("flips the arc bulge to the other side of the chord", () => {
    const a = buildShapePoints("arc", { x: 0, y: 0 }, { x: 100, y: 100 }, { segments: 16 })[8];
    const b = buildShapePoints("arc", { x: 0, y: 0 }, { x: 100, y: 100 }, { segments: 16, flip: true })[8];
    expect(Math.sign(a.x - a.y)).toBe(-Math.sign(b.x - b.y));
  });

  it("builds a polyline preview through the committed vertices plus the cursor", () => {
    const verts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    expect(buildPolylinePoints(verts, { x: 10, y: 10 })).toHaveLength(3);
    expect(buildPolylinePoints(verts)).toHaveLength(2);
    expect(buildPolylinePoints([], { x: 1, y: 1 })).toEqual([{ x: 1, y: 1 }]);
  });

  it("densifies sparse outlines to a maximum spacing", () => {
    const out = densifyShapePoints(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      10,
    );
    expect(out).toHaveLength(11);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].x - out[i - 1].x).toBeLessThanOrEqual(10.001);
    }
  });
});

describe("strokeLasso", () => {
  const pt = (x: number, z: number): StrokePoint => ({ x, y: 0, z, pressure: 0.6 });
  // Screen projection for the tests: x/z map straight to screen x/y.
  const project = (p: StrokePoint) => ({ x: p.x, y: p.z });

  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  const frames = (strokes: GreaseStroke[]): KeyframeDrawing[] => [{ frame: 0, strokes }];

  it("tests point containment, including on concave lassos", () => {
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, square)).toBe(false);
    expect(pointInPolygon({ x: 5, y: 5 }, square.slice(0, 2))).toBe(false);
  });

  it("selects strokes that merely touch the lasso, and those fully inside", () => {
    const strokes: GreaseStroke[] = [
      { id: "in", points: [pt(2, 2), pt(4, 4)] },
      { id: "half", points: [pt(5, 5), pt(50, 50)] },
      { id: "out", points: [pt(40, 40), pt(60, 60)] },
    ];
    expect(selectStrokesInLasso(strokes, square, project)).toEqual(["in", "half"]);
    expect(selectStrokesInLasso(strokes, square, project, "enclose")).toEqual(["in"]);
  });

  it("translates only the selected strokes", () => {
    const input = frames([
      { id: "a", points: [pt(0, 0), pt(1, 0)] },
      { id: "b", points: [pt(5, 5)] },
    ]);
    const out = translateStrokes(input, 0, ["a"], { x: 10, y: 0, z: 2 });
    expect(out[0].strokes[0].points[0]).toMatchObject({ x: 10, y: 0, z: 2 });
    expect(out[0].strokes[1].points[0]).toMatchObject({ x: 5, z: 5 });
    expect(translateStrokes(input, 0, [], { x: 1, y: 1, z: 1 })).toBe(input);
  });

  it("deletes selected strokes and leaves the frames alone otherwise", () => {
    const input = frames([
      { id: "a", points: [pt(0, 0)] },
      { id: "b", points: [pt(1, 1)] },
    ]);
    expect(deleteStrokes(input, 0, ["a"])[0].strokes.map((s) => s.id)).toEqual(["b"]);
    expect(deleteStrokes(input, 0, ["zzz"])).toBe(input);
  });

  it("carves the lasso region out of a stroke crossing it", () => {
    const input = frames([{ id: "line", points: [pt(-5, 5), pt(0, 5), pt(5, 5), pt(15, 5), pt(20, 5)] }]);
    const out = carveStrokesWithLasso(input, 0, square, project);
    const strokes = out[0].strokes;
    expect(strokes).toHaveLength(2);
    expect(strokes[0].points[strokes[0].points.length - 1].x).toBeLessThanOrEqual(0.01);
    expect(strokes[1].points[0].x).toBeGreaterThanOrEqual(9.99);
  });

  it("punches a hole in a filled shape that contains the lasso", () => {
    const outline = [pt(-50, -50), pt(50, -50), pt(50, 50), pt(-50, 50)];
    const input = frames([{ id: "blob", points: outline, fill: true, closed: true }]);
    const localHole = [pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10)];
    const out = carveStrokesWithLasso(input, 0, square, project, localHole);
    const carved = out[0].strokes[0];
    expect(carved.fill).toBe(true);
    expect(carved.holes).toHaveLength(1);
    expect(carved.holes?.[0]).toHaveLength(4);
  });

  it("ignores a degenerate lasso", () => {
    const input = frames([{ id: "a", points: [pt(0, 0), pt(1, 1)] }]);
    expect(carveStrokesWithLasso(input, 0, square.slice(0, 2), project)).toBe(input);
    expect(selectStrokesInLasso(input[0].strokes, [], project)).toEqual([]);
  });
});

describe("strokeFill", () => {
  it("rasterizes a polyline into the occupancy grid", () => {
    const grid = createFillGrid(10, 10);
    rasterizePolyline(grid, [
      { x: 0, y: 5 },
      { x: 9, y: 5 },
    ]);
    for (let x = 0; x < 10; x++) expect(grid.cells[5 * 10 + x]).toBe(1);
    expect(grid.cells[0]).toBe(0);
  });

  it("flood fills an enclosed region without leaking", () => {
    const grid = createFillGrid(20, 20);
    rasterizePolyline(grid, [
      { x: 4, y: 4 },
      { x: 15, y: 4 },
      { x: 15, y: 15 },
      { x: 4, y: 15 },
      { x: 4, y: 4 },
    ]);
    const res = floodFill(grid, 10, 10);
    expect(res.leaked).toBe(false);
    expect(res.count).toBeGreaterThan(50);
    expect(res.region[10 * 20 + 10]).toBe(1);
    expect(res.region[0]).toBe(0);
  });

  it("reports a leak when the boundary has a gap", () => {
    const grid = createFillGrid(20, 20);
    // Same box, but the right wall stops short.
    rasterizePolyline(grid, [
      { x: 4, y: 4 },
      { x: 15, y: 4 },
    ]);
    rasterizePolyline(grid, [
      { x: 15, y: 4 },
      { x: 15, y: 9 },
    ]);
    rasterizePolyline(grid, [
      { x: 4, y: 15 },
      { x: 15, y: 15 },
    ]);
    rasterizePolyline(grid, [
      { x: 4, y: 4 },
      { x: 4, y: 15 },
    ]);
    expect(floodFill(grid, 10, 10).leaked).toBe(true);
  });

  it("closes small gaps by dilation so the fill holds", () => {
    const grid = createFillGrid(24, 24);
    rasterizePolyline(grid, [
      { x: 4, y: 4 },
      { x: 18, y: 4 },
      { x: 18, y: 18 },
      { x: 4, y: 18 },
      { x: 4, y: 8 },
    ]);
    // 4-cell gap on the left wall.
    expect(floodFill(grid, 11, 11).leaked).toBe(true);
    expect(floodFill(dilateGrid(grid, 2), 11, 11).leaked).toBe(false);
  });

  it("returns nothing when the seed lands on a stroke", () => {
    const grid = createFillGrid(10, 10);
    rasterizePolyline(grid, [
      { x: 0, y: 5 },
      { x: 9, y: 5 },
    ]);
    expect(floodFill(grid, 5, 5).count).toBe(0);
  });

  it("traces a contour that wraps the filled region", () => {
    const region = new Uint8Array(10 * 10);
    for (let y = 3; y <= 6; y++) for (let x = 3; x <= 6; x++) region[y * 10 + x] = 1;
    const contour = traceRegionContour(region, 10, 10);
    expect(contour.length).toBeGreaterThan(3);
    for (const p of contour) {
      expect(p.x).toBeGreaterThanOrEqual(3);
      expect(p.x).toBeLessThanOrEqual(6);
      expect(p.y).toBeGreaterThanOrEqual(3);
      expect(p.y).toBeLessThanOrEqual(6);
    }
  });

  it("simplifies a contour down to its corners", () => {
    const line: { x: number; y: number }[] = [];
    for (let i = 0; i <= 20; i++) line.push({ x: i, y: 0 });
    for (let i = 1; i <= 20; i++) line.push({ x: 20, y: i });
    const simple = simplifyContour(line, 0.5);
    expect(simple.length).toBeLessThanOrEqual(4);
    expect(simple[0]).toEqual({ x: 0, y: 0 });
    expect(simple[simple.length - 1]).toEqual({ x: 20, y: 20 });
  });

  it("computes a fill outline inside a hand-drawn box", () => {
    const box = [
      { x: 100, y: 100 },
      { x: 300, y: 100 },
      { x: 300, y: 260 },
      { x: 100, y: 260 },
      { x: 100, y: 100 },
    ];
    const res = computeFillRegion({
      boundaries: [box],
      seed: { x: 200, y: 180 },
      bounds: { minX: 50, minY: 50, maxX: 350, maxY: 310 },
      cellSize: 2,
    });
    expect(res.leaked).toBe(false);
    expect(res.contour).not.toBeNull();
    const xs = (res.contour as { x: number }[]).map((p) => p.x);
    const ys = (res.contour as { y: number }[]).map((p) => p.y);
    expect(Math.min(...xs)).toBeGreaterThan(95);
    expect(Math.max(...xs)).toBeLessThan(305);
    expect(Math.min(...ys)).toBeGreaterThan(95);
    expect(Math.max(...ys)).toBeLessThan(265);
  });

  it("refuses to fill an open region and says it leaked", () => {
    const openBox = [
      { x: 100, y: 100 },
      { x: 300, y: 100 },
      { x: 300, y: 200 },
    ];
    const res = computeFillRegion({
      boundaries: [openBox],
      seed: { x: 200, y: 150 },
      bounds: { minX: 50, minY: 50, maxX: 350, maxY: 310 },
      cellSize: 2,
    });
    expect(res.leaked).toBe(true);
    expect(res.contour).toBeNull();
  });
});
