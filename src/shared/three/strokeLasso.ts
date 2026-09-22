/**
 * Lasso operations on Grease Pencil strokes: selection, transform and the
 * Carver (boolean subtraction of everything inside the lasso).
 *
 * All of them work on a screen-space polygon plus a projector that maps a
 * stroke point to screen space, so the caller owns the camera and this module
 * stays pure and testable.
 */

import { GreaseStroke, KeyframeDrawing, StrokePoint, resolveActiveDrawing } from "../graph/nodes/greasePencil";

export interface LassoPoint {
  x: number;
  y: number;
}

/** Maps a stroke point (drawing-local space) to screen space. */
export type PointProjector = (p: StrokePoint) => LassoPoint | null;

/**
 * Even-odd point-in-polygon test.
 *
 * Handles the self-intersecting polygons a freehand lasso produces the same
 * way every 2D editor does: crossings are counted, so a loop drawn over itself
 * leaves a hole rather than failing.
 */
export function pointInPolygon(p: LassoPoint, polygon: LassoPoint[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const straddles = a.y > p.y !== b.y > p.y;
    if (straddles && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Ids of the strokes the lasso touches. */
export function selectStrokesInLasso(
  strokes: GreaseStroke[],
  polygon: LassoPoint[],
  project: PointProjector,
  /** "touch" selects a stroke if any point is inside; "enclose" needs all of them. */
  mode: "touch" | "enclose" = "touch",
): string[] {
  if (polygon.length < 3) return [];
  const ids: string[] = [];

  for (const stroke of strokes) {
    if (!stroke.points || stroke.points.length === 0) continue;
    let anyIn = false;
    let allIn = true;
    for (const pt of stroke.points) {
      const s = project(pt);
      const inside = s ? pointInPolygon(s, polygon) : false;
      if (inside) anyIn = true;
      else allIn = false;
      if (mode === "touch" && anyIn) break;
    }
    if (mode === "touch" ? anyIn : allIn) ids.push(stroke.id);
  }

  return ids;
}

/** Offsets the given strokes by a delta in drawing-local space. */
export function translateStrokes(
  frames: KeyframeDrawing[],
  frameIndex: number,
  strokeIds: Iterable<string>,
  delta: { x: number; y: number; z: number },
): KeyframeDrawing[] {
  const ids = new Set(strokeIds);
  if (ids.size === 0) return frames;
  const drawing = resolveActiveDrawing(frames, frameIndex);
  if (!drawing) return frames;

  const moved = drawing.strokes.map((stroke) =>
    ids.has(stroke.id)
      ? {
          ...stroke,
          points: stroke.points.map((p) => ({ ...p, x: p.x + delta.x, y: p.y + delta.y, z: p.z + delta.z })),
        }
      : stroke,
  );

  return frames.map((f) => (f.frame === drawing.frame ? { ...f, strokes: moved } : f));
}

/** Removes the given strokes from the active drawing. */
export function deleteStrokes(
  frames: KeyframeDrawing[],
  frameIndex: number,
  strokeIds: Iterable<string>,
): KeyframeDrawing[] {
  const ids = new Set(strokeIds);
  if (ids.size === 0) return frames;
  const drawing = resolveActiveDrawing(frames, frameIndex);
  if (!drawing) return frames;
  const kept = drawing.strokes.filter((s) => !ids.has(s.id));
  if (kept.length === drawing.strokes.length) return frames;
  return frames.map((f) => (f.frame === drawing.frame ? { ...f, strokes: kept } : f));
}

/**
 * Carver: subtracts the lasso region from every stroke in the drawing.
 *
 * Open strokes are cut — the parts inside the lasso disappear and the parts
 * outside survive as separate strokes, with the cut landing on the lasso edge
 * rather than on the nearest sample. Filled strokes that merely *contain* the
 * lasso keep their outline and gain the lasso as a hole, which is what makes
 * the tool useful for punching a window out of a filled shape.
 */
export function carveStrokesWithLasso(
  frames: KeyframeDrawing[],
  frameIndex: number,
  polygon: LassoPoint[],
  project: PointProjector,
  /** Lasso polygon expressed in drawing-local space, for fill holes. */
  localPolygon?: StrokePoint[],
): KeyframeDrawing[] {
  if (polygon.length < 3) return frames;
  const drawing = resolveActiveDrawing(frames, frameIndex);
  if (!drawing) return frames;

  const isInside = (p: StrokePoint) => {
    const s = project(p);
    return s ? pointInPolygon(s, polygon) : false;
  };

  // Binary search for the crossing point between an outside and inside sample.
  const boundaryPoint = (outside: StrokePoint, inside: StrokePoint): StrokePoint => {
    let lo = 0;
    let hi = 1;
    const at = (t: number): StrokePoint => ({
      x: outside.x + (inside.x - outside.x) * t,
      y: outside.y + (inside.y - outside.y) * t,
      z: outside.z + (inside.z - outside.z) * t,
      pressure: outside.pressure + (inside.pressure - outside.pressure) * t,
    });
    for (let it = 0; it < 12; it++) {
      const mid = (lo + hi) * 0.5;
      if (isInside(at(mid))) hi = mid;
      else lo = mid;
    }
    return at(lo);
  };

  const next: GreaseStroke[] = [];
  let mutated = false;

  for (const stroke of drawing.strokes) {
    const pts = stroke.points;
    if (!pts || pts.length === 0) {
      mutated = true;
      continue;
    }

    const inside = pts.map(isInside);

    if (!inside.some(Boolean)) {
      // Untouched — unless it is a filled shape the lasso sits entirely
      // within, in which case the lasso becomes a hole in its fill.
      if (stroke.fill && localPolygon && localPolygon.length >= 3) {
        const holes = [...(stroke.holes ?? []), localPolygon.map((p) => ({ ...p }))];
        next.push({ ...stroke, holes });
        mutated = true;
      } else {
        next.push(stroke);
      }
      continue;
    }

    mutated = true;

    const runs: StrokePoint[][] = [];
    let run: StrokePoint[] | null = null;
    for (let i = 0; i < pts.length; i++) {
      if (!inside[i]) {
        if (!run) {
          run = [];
          if (i > 0) run.push(boundaryPoint(pts[i], pts[i - 1]));
        }
        run.push({ ...pts[i] });
      } else if (run) {
        run.push(boundaryPoint(pts[i - 1], pts[i]));
        runs.push(run);
        run = null;
      }
    }
    if (run) runs.push(run);

    for (let r = 0; r < runs.length; r++) {
      if (runs[r].length < 2) continue;
      next.push({
        ...stroke,
        closed: false,
        // A carved fragment of a filled shape is no longer a closed region.
        fill: false,
        holes: undefined,
        id: r === 0 ? stroke.id : `${stroke.id}_k${r}_${Math.random().toString(36).slice(2, 6)}`,
        points: runs[r],
      });
    }
  }

  if (!mutated) return frames;
  return frames.map((f) => (f.frame === drawing.frame ? { ...f, strokes: next } : f));
}
