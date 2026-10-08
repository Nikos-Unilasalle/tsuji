import { describe, expect, it } from "vitest";
import {
  deletePoints,
  dragBox,
  isSmooth,
  isTinyDrag,
  moveHandle,
  penAdd,
  penDrag,
  reindexAfterDelete,
  shapeFromDrag,
  translatePoints,
} from "./maskEditing";
import { ellipsePoints, point, rectPoints, smoothPoints } from "../../graph/maskShapes";

describe("isSmooth", () => {
  it("opposite handles on one line are smooth; corners and bent ones are not", () => {
    expect(isSmooth(point(0, 0, -1, 0, 1, 0))).toBe(true);
    expect(isSmooth(point(0, 0, -1, -1, 2, 2))).toBe(true);
    expect(isSmooth(point(0, 0))).toBe(false);
    expect(isSmooth(point(0, 0, -1, 0, 0, 1))).toBe(false);
    expect(isSmooth(point(0, 0, 0, 0, 1, 0))).toBe(false);
  });

  it("every point of an ellipse is smooth", () => {
    expect(ellipsePoints(0.5, 0.5, 0.3, 0.2).every(isSmooth)).toBe(true);
  });
});

describe("moveHandle", () => {
  const smooth = () => [point(0, 0, -1, 0, 2, 0), point(1, 0), point(1, 1)];

  it("keeps a smooth point smooth: the other handle turns opposite, keeping its length", () => {
    const next = moveHandle(smooth(), 0, "out", { x: 0, y: 3 });
    expect(next[0].ox).toBe(0);
    expect(next[0].oy).toBe(3);
    expect(next[0].ix).toBeCloseTo(0);
    expect(next[0].iy).toBeCloseTo(-1);
    expect(isSmooth(next[0])).toBe(true);
  });

  it("Alt breaks the tangent: only the dragged handle moves", () => {
    const next = moveHandle(smooth(), 0, "out", { x: 0, y: 3 }, true);
    expect(next[0].ix).toBe(-1);
    expect(next[0].iy).toBe(0);
    expect(isSmooth(next[0])).toBe(false);
  });

  it("a point that was already broken stays so", () => {
    const broken = [point(0, 0, -1, 0, 0, 2), point(1, 0), point(1, 1)];
    const next = moveHandle(broken, 0, "in", { x: -3, y: 0 });
    expect(next[0].ox).toBe(0);
    expect(next[0].oy).toBe(2);
  });

  it("dragging the in-handle works the same way round", () => {
    const next = moveHandle(smooth(), 0, "in", { x: 0, y: -4 });
    expect(next[0].ox).toBeCloseTo(0);
    expect(next[0].oy).toBeCloseTo(2);
  });

  it("does not mutate its input", () => {
    const original = smooth();
    moveHandle(original, 0, "out", { x: 5, y: 5 });
    expect(original[0].ox).toBe(2);
  });
});

describe("translate and delete", () => {
  it("moves only the chosen points, handles included", () => {
    const moved = translatePoints(smoothPoints([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]), new Set([1]), 0.5, 0.25);
    expect(moved[1].x).toBeCloseTo(1.5);
    expect(moved[1].y).toBeCloseTo(0.25);
    expect(moved[0].x).toBe(0);
  });

  it("deleting leaves a shape, or null when too few remain", () => {
    expect(deletePoints(rectPoints(0, 0, 1, 1), new Set([0]))).toHaveLength(3);
    expect(deletePoints(rectPoints(0, 0, 1, 1), new Set([0, 1]))).toBeNull();
  });

  it("selection indices follow the points that stay", () => {
    expect([...reindexAfterDelete(5, new Set([1, 3]), new Set([0, 2, 4]))].sort()).toEqual([0, 1, 2]);
    expect(reindexAfterDelete(3, new Set([0]), new Set([0])).size).toBe(0);
  });
});

describe("pen", () => {
  it("a click adds a corner", () => {
    const draft = penAdd([], { x: 0.2, y: 0.3 });
    expect(draft).toHaveLength(1);
    expect(draft[0]).toEqual(point(0.2, 0.3));
  });

  it("dragging pulls a smooth point out of the last click", () => {
    const draft = penDrag(penAdd(penAdd([], { x: 0, y: 0 }), { x: 0.5, y: 0.5 }), { x: 0.7, y: 0.5 });
    expect(draft[1].ox).toBeCloseTo(0.2);
    expect(draft[1].oy).toBeCloseTo(0);
    expect(draft[1].ix).toBeCloseTo(-0.2);
    expect(isSmooth(draft[1])).toBe(true);
    // The earlier point is left alone.
    expect(draft[0]).toEqual(point(0, 0));
  });

  it("dragging with nothing placed does nothing", () => {
    expect(penDrag([], { x: 1, y: 1 })).toEqual([]);
  });
});

describe("ellipse and rectangle", () => {
  it("drag corner to corner", () => {
    const box = dragBox({ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.5 }, { aspect: 1 });
    expect(box).toEqual({ x0: 0.2, y0: 0.2, x1: 0.6, y1: 0.5 });
  });

  it("Alt anchors the centre", () => {
    const box = dragBox({ x: 0.5, y: 0.5 }, { x: 0.7, y: 0.6 }, { aspect: 1, fromCenter: true });
    expect(box.x0).toBeCloseTo(0.3);
    expect(box.y0).toBeCloseTo(0.4);
    expect(box.x1).toBeCloseTo(0.7);
    expect(box.y1).toBeCloseTo(0.6);
  });

  it("Shift makes a circle on the surface, not in UV: on a 2:1 image the UV width is half the UV height", () => {
    const box = dragBox({ x: 0, y: 0 }, { x: 0.4, y: 0.1 }, { aspect: 2, constrain: true });
    // World width = du · 2, world height = dv: equal means du = dv / 2.
    expect((box.x1 - box.x0) * 2).toBeCloseTo(box.y1 - box.y0);
    expect(box.y1 - box.y0).toBeCloseTo(0.8);
  });

  it("keeps the direction of a drag up and to the left", () => {
    const box = dragBox({ x: 0.5, y: 0.5 }, { x: 0.3, y: 0.2 }, { aspect: 1, constrain: true });
    expect(box.x1).toBeLessThan(box.x0);
    expect(box.y1).toBeLessThan(box.y0);
  });

  it("builds an ellipse centred in the box, or a rectangle", () => {
    const ellipse = shapeFromDrag("ellipse", { x: 0.2, y: 0.2 }, { x: 0.6, y: 0.4 }, { aspect: 1 });
    expect(ellipse).toHaveLength(4);
    expect(ellipse[0].x).toBeCloseTo(0.6);
    expect(ellipse[0].y).toBeCloseTo(0.3);
    const rect = shapeFromDrag("rect", { x: 0.6, y: 0.4 }, { x: 0.2, y: 0.2 }, { aspect: 1 });
    expect(rect.map((p) => [p.x, p.y])).toEqual([[0.2, 0.2], [0.6, 0.2], [0.6, 0.4], [0.2, 0.4]]);
  });

  it("a click is not a drag", () => {
    expect(isTinyDrag({ x: 0.5, y: 0.5 }, { x: 0.5001, y: 0.5 }, { x: 800, y: 600 })).toBe(true);
    expect(isTinyDrag({ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.6 }, { x: 800, y: 600 })).toBe(false);
  });
});
