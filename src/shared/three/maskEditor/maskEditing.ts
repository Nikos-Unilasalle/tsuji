import { MaskPoint, ellipsePoints, point, rectPoints } from "../../graph/maskShapes";

/**
 * The edits the Roto Mask editor makes to a path, as pure functions on its
 * points: nothing here knows about pointers, cameras or React, so what a drag
 * does to a shape is testable without any of them.
 */

type Vec = { x: number; y: number };

const EPSILON = 1e-9;

/** Whether a point's handles are opposite each other along one line — the mark of a smooth point. */
export function isSmooth(p: MaskPoint): boolean {
  const a = Math.hypot(p.ix, p.iy);
  const b = Math.hypot(p.ox, p.oy);
  if (a < EPSILON || b < EPSILON) return false;
  const cross = (p.ix * p.oy - p.iy * p.ox) / (a * b);
  const dot = (p.ix * p.ox + p.iy * p.oy) / (a * b);
  return Math.abs(cross) < 1e-3 && dot < 0;
}

/**
 * Drags one handle of point `i` to offset `to` (from the point). A smooth
 * point keeps its handles in line: the other one turns to stay opposite but
 * keeps its own length. `breakTangent` (Alt) moves just the one handle.
 */
export function moveHandle(
  points: readonly MaskPoint[],
  i: number,
  which: "in" | "out",
  to: Vec,
  breakTangent = false,
): MaskPoint[] {
  const next = points.map((p) => ({ ...p }));
  const p = next[i];
  const wasSmooth = isSmooth(points[i]);
  if (which === "out") {
    p.ox = to.x;
    p.oy = to.y;
  } else {
    p.ix = to.x;
    p.iy = to.y;
  }
  if (breakTangent || !wasSmooth) return next;

  const length = Math.hypot(to.x, to.y);
  if (length < EPSILON) return next;
  const other = which === "out" ? Math.hypot(points[i].ix, points[i].iy) : Math.hypot(points[i].ox, points[i].oy);
  const ux = -to.x / length;
  const uy = -to.y / length;
  if (which === "out") {
    p.ix = ux * other;
    p.iy = uy * other;
  } else {
    p.ox = ux * other;
    p.oy = uy * other;
  }
  return next;
}

/** Moves the listed points by (dx, dy); their handles go with them, being offsets. */
export function translatePoints(points: readonly MaskPoint[], indices: ReadonlySet<number>, dx: number, dy: number): MaskPoint[] {
  return points.map((p, i) => (indices.has(i) ? { ...p, x: p.x + dx, y: p.y + dy } : { ...p }));
}

/** The shape without the listed points, or null when fewer than three would be left (it is no shape any more). */
export function deletePoints(points: readonly MaskPoint[], indices: ReadonlySet<number>): MaskPoint[] | null {
  const kept = points.filter((_, i) => !indices.has(i)).map((p) => ({ ...p }));
  return kept.length >= 3 ? kept : null;
}

/** Selected indices after deleting some points: those that stay, renumbered. */
export function reindexAfterDelete(count: number, deleted: ReadonlySet<number>, selected: ReadonlySet<number>): Set<number> {
  const out = new Set<number>();
  let shift = 0;
  for (let i = 0; i < count; i++) {
    if (deleted.has(i)) shift++;
    else if (selected.has(i)) out.add(i - shift);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Pen                                                                        */
/* -------------------------------------------------------------------------- */

/** The next point of a pen shape: a corner to begin with, which dragging then pulls a smooth handle out of. */
export function penAdd(draft: readonly MaskPoint[], at: Vec): MaskPoint[] {
  return [...draft.map((p) => ({ ...p })), point(at.x, at.y)];
}

/**
 * Dragging while the pen button is down pulls the last point's out-handle
 * toward the pointer, and its in-handle the opposite way: click-drag makes a
 * smooth point, a plain click a corner.
 */
export function penDrag(draft: readonly MaskPoint[], to: Vec): MaskPoint[] {
  if (draft.length === 0) return [];
  const next = draft.map((p) => ({ ...p }));
  const last = next[next.length - 1];
  last.ox = to.x - last.x;
  last.oy = to.y - last.y;
  last.ix = -last.ox;
  last.iy = -last.oy;
  return next;
}

/* -------------------------------------------------------------------------- */
/* Ellipse and rectangle                                                      */
/* -------------------------------------------------------------------------- */

export interface ShapeDragOptions {
  /** Draw from the centre out (Alt). */
  fromCenter?: boolean;
  /** A square or circle *as seen on the surface* (Shift). */
  constrain?: boolean;
  /** World width / height of the UV square: a circle in UV is an ellipse on a wide image unless this is allowed for. */
  aspect: number;
}

/** The two corners of a drag, adjusted for Shift (equal world sides) and Alt (anchored at the centre). */
export function dragBox(a: Vec, b: Vec, options: ShapeDragOptions): { x0: number; y0: number; x1: number; y1: number } {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  const aspect = options.aspect > 0 ? options.aspect : 1;
  if (options.constrain) {
    // World lengths are |dx|·aspect and |dy|; equalise them, keeping each sign.
    const side = Math.max(Math.abs(dx) * aspect, Math.abs(dy));
    dx = Math.sign(dx || 1) * (side / aspect);
    dy = Math.sign(dy || 1) * side;
  }
  return options.fromCenter
    ? { x0: a.x - dx, y0: a.y - dy, x1: a.x + dx, y1: a.y + dy }
    : { x0: a.x, y0: a.y, x1: a.x + dx, y1: a.y + dy };
}

export function shapeFromDrag(kind: "ellipse" | "rect", a: Vec, b: Vec, options: ShapeDragOptions): MaskPoint[] {
  const { x0, y0, x1, y1 } = dragBox(a, b, options);
  if (kind === "rect") return rectPoints(x0, y0, x1, y1);
  return ellipsePoints((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2);
}

/** A drag too small to be a shape (a click) is none. */
export function isTinyDrag(a: Vec, b: Vec, pixelsPerUv: Vec, minPixels = 4): boolean {
  return Math.abs(b.x - a.x) * pixelsPerUv.x < minPixels || Math.abs(b.y - a.y) * pixelsPerUv.y < minPixels;
}
