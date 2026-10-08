import { describe, expect, it } from "vitest";
import {
  KAPPA,
  bezierAt,
  closestOnPath,
  createLayer,
  ellipsePoints,
  flattenPath,
  freehandPoints,
  insertPoint,
  isCorner,
  rectPoints,
  sanitizeLayers,
  segmentAt,
  simplifyStroke,
  smoothPoints,
  toggleSmooth,
} from "./maskShapes";

describe("shapes", () => {
  it("an ellipse's Bézier stays on its outline", () => {
    const points = ellipsePoints(0.5, 0.5, 0.3, 0.2);
    expect(points).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      const s = segmentAt(points, i);
      for (const t of [0.25, 0.5, 0.75]) {
        const p = bezierAt(s, t);
        const r = ((p.x - 0.5) / 0.3) ** 2 + ((p.y - 0.5) / 0.2) ** 2;
        // The four-arc approximation is good to a fraction of a percent.
        expect(Math.sqrt(r)).toBeGreaterThan(0.995);
        expect(Math.sqrt(r)).toBeLessThan(1.005);
      }
    }
    expect(KAPPA).toBeCloseTo(0.5523, 3);
  });

  it("a rectangle is four corners with no handles, whichever way it was dragged", () => {
    const points = rectPoints(0.8, 0.9, 0.2, 0.1);
    expect(points.map((p) => [p.x, p.y])).toEqual([
      [0.2, 0.1],
      [0.8, 0.1],
      [0.8, 0.9],
      [0.2, 0.9],
    ]);
    expect(points.every(isCorner)).toBe(true);
  });

  it("a straight-sided path flattens to exactly its corners", () => {
    expect(flattenPath(rectPoints(0, 0, 1, 1), 10, 20)).toEqual([0, 0, 10, 0, 10, 20, 0, 20]);
  });

  it("a curved path flattens to many short pieces, all on the curve's side of the box", () => {
    const flat = flattenPath(ellipsePoints(0.5, 0.5, 0.4, 0.4), 100, 100);
    expect(flat.length / 2).toBeGreaterThan(40);
    for (let i = 0; i < flat.length; i += 2) {
      expect(Math.hypot(flat[i] - 50, flat[i + 1] - 50)).toBeGreaterThan(39);
      expect(Math.hypot(flat[i] - 50, flat[i + 1] - 50)).toBeLessThan(41);
    }
  });

  it("smoothPoints passes through every input and has collinear tangents", () => {
    const points = smoothPoints([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]);
    expect(points.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    for (const p of points) {
      expect(p.ix).toBeCloseTo(-p.ox);
      expect(p.iy).toBeCloseTo(-p.oy);
    }
  });
});

describe("editing", () => {
  it("inserting a point does not change the shape", () => {
    const original = ellipsePoints(0.5, 0.5, 0.3, 0.3);
    const grown = insertPoint(original, 1, 0.37);
    expect(grown).toHaveLength(5);
    const before = flattenPath(original, 1, 1);
    const after = flattenPath(grown, 1, 1);
    // Every point of the new outline lies on the old one (within flattening error).
    const radii = [];
    for (let i = 0; i < after.length; i += 2) radii.push(Math.hypot(after[i] - 0.5, after[i + 1] - 0.5));
    expect(Math.min(...radii)).toBeGreaterThan(0.298);
    expect(Math.max(...radii)).toBeLessThan(0.302);
    expect(before.length).toBeGreaterThan(0);
  });

  it("closestOnPath finds the segment, the parameter and the distance", () => {
    const square = rectPoints(0, 0, 1, 1);
    const hit = closestOnPath(square, { x: 0.5, y: -0.1 })!;
    expect(hit.segment).toBe(0);
    expect(hit.t).toBeCloseTo(0.5, 1);
    expect(hit.distance).toBeCloseTo(0.1, 2);
    expect(closestOnPath([], { x: 0, y: 0 })).toBeNull();
  });

  it("distance is measured with the aspect, so a wide image is not skewed", () => {
    const square = rectPoints(0, 0, 1, 1);
    // 0.1 above the top edge in v is 0.1 × height pixels, not 0.1 × width.
    const hit = closestOnPath(square, { x: 0.5, y: 1.1 }, 1000, 100)!;
    expect(hit.distance).toBeCloseTo(10, 0);
  });

  it("toggleSmooth turns a corner smooth and back", () => {
    const square = rectPoints(0, 0, 1, 1);
    const smooth = toggleSmooth(square, 0);
    expect(isCorner(smooth[0])).toBe(false);
    expect(smooth[0].ix).toBeCloseTo(-smooth[0].ox);
    expect(isCorner(smooth[1])).toBe(true);
    expect(isCorner(toggleSmooth(smooth, 0)[0])).toBe(true);
  });
});

describe("freehand", () => {
  it("simplifyStroke drops points that sit on the line", () => {
    const line = Array.from({ length: 50 }, (_, i) => ({ x: i / 49, y: 0 }));
    expect(simplifyStroke(line, 0.001)).toHaveLength(2);
  });

  it("keeps the corners of a bent stroke", () => {
    const bent = [
      ...Array.from({ length: 20 }, (_, i) => ({ x: i / 19, y: 0 })),
      ...Array.from({ length: 20 }, (_, i) => ({ x: 1, y: (i + 1) / 20 })),
    ];
    const simple = simplifyStroke(bent, 0.001);
    expect(simple).toHaveLength(3);
  });

  it("a circle drawn by hand becomes a smooth closed shape", () => {
    const stroke = Array.from({ length: 80 }, (_, i) => ({
      x: 0.5 + 0.3 * Math.cos((i / 80) * Math.PI * 2),
      y: 0.5 + 0.3 * Math.sin((i / 80) * Math.PI * 2),
    }));
    const points = freehandPoints(stroke, 0.004);
    expect(points.length).toBeGreaterThanOrEqual(6);
    expect(points.length).toBeLessThan(40);
    expect(points.every((p) => !isCorner(p))).toBe(true);
  });

  it("a scribble too short to be a shape is nothing", () => {
    expect(freehandPoints([{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }])).toEqual([]);
  });
});

describe("sanitizeLayers", () => {
  it("fills in defaults and clamps what is out of range", () => {
    const [layer] = sanitizeLayers([
      { id: "a", mode: "bogus", opacity: 7, feather: -1, expansion: 9, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] },
    ]);
    expect(layer.mode).toBe("add");
    expect(layer.opacity).toBe(1);
    expect(layer.feather).toBe(0);
    expect(layer.expansion).toBe(0.5);
    expect(layer.visible).toBe(true);
    expect(layer.points[0]).toEqual({ x: 0, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 });
  });

  it("drops junk, and gives clashing ids new ones", () => {
    const layers = sanitizeLayers([null, 4, { id: "x", points: [{ x: "a" }, { x: 0, y: 0 }] }, { id: "x" }]);
    expect(layers).toHaveLength(2);
    expect(layers[0].points).toHaveLength(1);
    expect(new Set(layers.map((l) => l.id)).size).toBe(2);
  });

  it("anything that is not a list is no layers", () => {
    expect(sanitizeLayers(undefined)).toEqual([]);
    expect(sanitizeLayers("nope")).toEqual([]);
  });

  it("createLayer gives every layer its own id", () => {
    expect(createLayer([]).id).not.toBe(createLayer([]).id);
  });
});
