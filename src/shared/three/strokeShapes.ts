/**
 * Screen-space generators for the Grease Pencil shape tools.
 *
 * Every shape is produced as a plain list of client-space points, which the
 * viewport then feeds through the same projection path as a freehand stroke.
 * Keeping them in screen space is what makes the modifiers behave the way an
 * artist expects — a "square" is square on screen, whatever the camera is
 * doing — and it keeps this module free of Three.js and unit-testable.
 */

export type ShapeKind = "line" | "rect" | "ellipse" | "arc";

export interface ShapePoint {
  x: number;
  y: number;
}

export interface ShapeOptions {
  /** Shift: snap the line angle, force a square / circle. */
  constrain?: boolean;
  /** Alt/Ctrl: treat the anchor as the shape's centre instead of a corner. */
  fromCenter?: boolean;
  /** Mirror an arc's bulge to the other side of its chord. */
  flip?: boolean;
  /** Override the segment count used for curved shapes. */
  segments?: number;
}

/** Snaps a direction to the nearest multiple of `stepDeg` degrees. */
export function snapAngle(from: ShapePoint, to: ShapePoint, stepDeg = 15): ShapePoint {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { ...to };
  const step = (stepDeg * Math.PI) / 180;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: from.x + Math.cos(angle) * len, y: from.y + Math.sin(angle) * len };
}

/** Rectangle corners implied by a drag, honouring square / centre modifiers. */
export function rectCorners(
  a: ShapePoint,
  b: ShapePoint,
  opts: ShapeOptions = {},
): { minX: number; minY: number; maxX: number; maxY: number } {
  let dx = b.x - a.x;
  let dy = b.y - a.y;

  if (opts.constrain) {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * size;
    dy = Math.sign(dy || 1) * size;
  }

  if (opts.fromCenter) {
    return {
      minX: a.x - Math.abs(dx),
      maxX: a.x + Math.abs(dx),
      minY: a.y - Math.abs(dy),
      maxY: a.y + Math.abs(dy),
    };
  }
  return {
    minX: Math.min(a.x, a.x + dx),
    maxX: Math.max(a.x, a.x + dx),
    minY: Math.min(a.y, a.y + dy),
    maxY: Math.max(a.y, a.y + dy),
  };
}

/**
 * Builds the point list for a shape drag from `a` to `b`.
 *
 * Closed shapes repeat their first point at the end so the ribbon builder
 * closes the outline cleanly.
 */
export function buildShapePoints(
  kind: ShapeKind,
  a: ShapePoint,
  b: ShapePoint,
  opts: ShapeOptions = {},
): ShapePoint[] {
  switch (kind) {
    case "line": {
      const end = opts.constrain ? snapAngle(a, b) : b;
      const start = opts.fromCenter ? { x: a.x - (end.x - a.x), y: a.y - (end.y - a.y) } : a;
      // Two points is enough: the ribbon builder resamples along the segment.
      return [start, end];
    }

    case "rect": {
      const { minX, minY, maxX, maxY } = rectCorners(a, b, opts);
      return [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
        { x: minX, y: minY },
      ];
    }

    case "ellipse": {
      const { minX, minY, maxX, maxY } = rectCorners(a, b, opts);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      let rx = (maxX - minX) / 2;
      let ry = (maxY - minY) / 2;
      if (opts.constrain) {
        const r = Math.max(rx, ry);
        rx = r;
        ry = r;
      }
      // Segment count follows the on-screen size so small circles stay cheap
      // and large ones stay round.
      const segments = opts.segments ?? Math.max(24, Math.min(160, Math.round((rx + ry) * 0.6)));
      const pts: ShapePoint[] = [];
      for (let i = 0; i <= segments; i++) {
        const t = (i / segments) * Math.PI * 2;
        pts.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry });
      }
      return pts;
    }

    case "arc": {
      // A quarter-ellipse spanning the drag box, like Blender's arc tool: the
      // curve leaves `a` along one axis and arrives at `b` along the other.
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const segments = opts.segments ?? Math.max(16, Math.min(120, Math.round((Math.abs(dx) + Math.abs(dy)) * 0.5)));
      const pts: ShapePoint[] = [];
      for (let i = 0; i <= segments; i++) {
        const t = (i / segments) * (Math.PI / 2);
        // flip swaps which axis the curve departs along, mirroring the bulge.
        const u = opts.flip ? 1 - Math.cos(t) : Math.sin(t);
        const v = opts.flip ? Math.sin(t) : 1 - Math.cos(t);
        pts.push({ x: a.x + dx * u, y: a.y + dy * v });
      }
      return pts;
    }

    default:
      return [a, b];
  }
}

/**
 * Point list for a polyline in progress: the committed vertices, plus the
 * segment to the live cursor when one is given.
 */
export function buildPolylinePoints(vertices: ShapePoint[], cursor?: ShapePoint | null): ShapePoint[] {
  if (vertices.length === 0) return cursor ? [cursor] : [];
  return cursor ? [...vertices, cursor] : [...vertices];
}

/**
 * Densifies a sparse shape outline so the drawing plane projection samples it
 * often enough — a two-point line projected onto a curved surface would
 * otherwise cut straight through it.
 */
export function densifyShapePoints(points: ShapePoint[], maxSpacing: number): ShapePoint[] {
  if (points.length < 2 || !(maxSpacing > 0)) return points;
  const out: ShapePoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(dist / maxSpacing));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}
