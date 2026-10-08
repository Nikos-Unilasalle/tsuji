import { MaskBitmap, isValidBitmap } from "./maskBitmap";

/**
 * The data behind a Roto Mask: closed Bézier shapes in UV space, and painted
 * layers (a soft-edged brush on a bitmap) beside them in the same stack.
 *
 * UV, not pixels, so a mask is independent of the resolution it is rasterised
 * at and follows the image wherever it is drawn: (0,0) is the image's bottom
 * left, (1,1) its top right, matching a plane's own UVs. Every shape — pen,
 * ellipse, rectangle, freehand — is stored the same way, as a closed Bézier
 * path, so there is exactly one thing to rasterise, edit and keyframe.
 */

export const MASK_MODES = ["add", "subtract", "intersect", "difference"] as const;
export type MaskMode = (typeof MASK_MODES)[number];

/**
 * One point of a path. `ix, iy` and `ox, oy` are the in and out tangent handles,
 * as offsets from the point (zero = a corner with no handle on that side).
 */
export interface MaskPoint {
  x: number;
  y: number;
  ix: number;
  iy: number;
  ox: number;
  oy: number;
}

export interface MaskLayer {
  id: string;
  name: string;
  /** "shape" is a Bézier outline (`points`); "paint" is a brushed bitmap (`bitmap`). Absent means shape. */
  kind?: "shape" | "paint";
  /** The painted pixels, for a paint layer. */
  bitmap?: MaskBitmap;
  /** How this layer combines with the ones below it, After Effects style. */
  mode: MaskMode;
  opacity: number;
  invert: boolean;
  /** Width of the soft edge, as a fraction of the image's long side. Centred on the outline. */
  feather: number;
  /** Grows (+) or shrinks (−) the shape, as a fraction of the image's long side. */
  expansion: number;
  visible: boolean;
  points: MaskPoint[];
}

/** Circle approximation constant for cubic Béziers: 4/3·(√2 − 1). */
export const KAPPA = 0.5522847498;

export const point = (x: number, y: number, ix = 0, iy = 0, ox = 0, oy = 0): MaskPoint => ({ x, y, ix, iy, ox, oy });

export function ellipsePoints(cx: number, cy: number, rx: number, ry: number): MaskPoint[] {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  // Counter-clockwise from the right-most point.
  return [
    point(cx + rx, cy, 0, -ky, 0, ky),
    point(cx, cy + ry, kx, 0, -kx, 0),
    point(cx - rx, cy, 0, ky, 0, -ky),
    point(cx, cy - ry, -kx, 0, kx, 0),
  ];
}

export function rectPoints(x0: number, y0: number, x1: number, y1: number): MaskPoint[] {
  const [a, b] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [c, d] = [Math.min(y0, y1), Math.max(y0, y1)];
  return [point(a, c), point(b, c), point(b, d), point(a, d)];
}

/** Catmull-Rom tangents through the given points: a smooth closed curve that passes through each. */
export function smoothPoints(points: readonly { x: number; y: number }[], closed = true): MaskPoint[] {
  const n = points.length;
  return points.map((p, i) => {
    const prev = points[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = points[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const tx = (next.x - prev.x) / 6;
    const ty = (next.y - prev.y) / 6;
    const end = !closed && (i === 0 || i === n - 1);
    return point(p.x, p.y, end ? 0 : -tx, end ? 0 : -ty, end ? 0 : tx, end ? 0 : ty);
  });
}

/** Perpendicular distance from `p` to the segment a–b. */
function distanceToSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Ramer–Douglas–Peucker: the fewest points that stay within `tolerance` of the stroke. */
export function simplifyStroke(points: readonly { x: number; y: number }[], tolerance: number): { x: number; y: number }[] {
  if (points.length <= 2) return points.map((p) => ({ x: p.x, y: p.y }));
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = lo + 1; i < hi; i++) {
      const d = distanceToSegment(points[i], points[lo], points[hi]);
      if (d > worstDistance) {
        worst = i;
        worstDistance = d;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([lo, worst], [worst, hi]);
    }
  }
  return points.filter((_, i) => keep[i]).map((p) => ({ x: p.x, y: p.y }));
}

/**
 * A hand-drawn stroke as a smooth closed shape: thinned to the points that
 * matter, then given Catmull-Rom tangents. Fewer than three points is no shape.
 */
export function freehandPoints(stroke: readonly { x: number; y: number }[], tolerance = 0.004): MaskPoint[] {
  let simple = simplifyStroke(stroke, tolerance);
  // The stroke is closed implicitly: a last point sitting on the first is redundant.
  if (simple.length > 3) {
    const first = simple[0];
    const last = simple[simple.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < tolerance * 2) simple = simple.slice(0, -1);
  }
  return simple.length >= 3 ? smoothPoints(simple, true) : [];
}

/* -------------------------------------------------------------------------- */
/* Bézier maths                                                               */
/* -------------------------------------------------------------------------- */

type Vec = { x: number; y: number };

export interface BezierSegment {
  p0: Vec;
  c1: Vec;
  c2: Vec;
  p1: Vec;
}

/** The cubic from point `i` to the next one around the closed path. */
export function segmentAt(points: readonly MaskPoint[], i: number): BezierSegment {
  const a = points[i];
  const b = points[(i + 1) % points.length];
  return {
    p0: { x: a.x, y: a.y },
    c1: { x: a.x + a.ox, y: a.y + a.oy },
    c2: { x: b.x + b.ix, y: b.y + b.iy },
    p1: { x: b.x, y: b.y },
  };
}

export function bezierAt(s: BezierSegment, t: number): Vec {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * s.p0.x + w1 * s.c1.x + w2 * s.c2.x + w3 * s.p1.x,
    y: w0 * s.p0.y + w1 * s.c1.y + w2 * s.c2.y + w3 * s.p1.y,
  };
}

/**
 * The path as a polyline of `[x, y, x, y, …]`, each coordinate scaled by
 * (`sx`, `sy`) — pass the raster size to get pixels. Segments are cut finely
 * enough that a curve's flat sides stay under about a pixel.
 */
export function flattenPath(points: readonly MaskPoint[], sx = 1, sy = 1): number[] {
  const out: number[] = [];
  const n = points.length;
  if (n < 2) return out;
  for (let i = 0; i < n; i++) {
    const s = segmentAt(points, i);
    const straight =
      points[i].ox === 0 && points[i].oy === 0 && points[(i + 1) % n].ix === 0 && points[(i + 1) % n].iy === 0;
    if (straight) {
      out.push(s.p0.x * sx, s.p0.y * sy);
      continue;
    }
    const length =
      Math.hypot((s.c1.x - s.p0.x) * sx, (s.c1.y - s.p0.y) * sy) +
      Math.hypot((s.c2.x - s.c1.x) * sx, (s.c2.y - s.c1.y) * sy) +
      Math.hypot((s.p1.x - s.c2.x) * sx, (s.p1.y - s.c2.y) * sy);
    const steps = Math.max(4, Math.min(128, Math.ceil(length / 3)));
    for (let k = 0; k < steps; k++) {
      const p = bezierAt(s, k / steps);
      out.push(p.x * sx, p.y * sy);
    }
  }
  return out;
}

/** Splits a cubic at `t` (de Casteljau): the two halves reproduce the original exactly. */
export function splitBezier(s: BezierSegment, t: number): [BezierSegment, BezierSegment] {
  const lerp = (a: Vec, b: Vec): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const ab = lerp(s.p0, s.c1);
  const bc = lerp(s.c1, s.c2);
  const cd = lerp(s.c2, s.p1);
  const abc = lerp(ab, bc);
  const bcd = lerp(bc, cd);
  const m = lerp(abc, bcd);
  return [
    { p0: s.p0, c1: ab, c2: abc, p1: m },
    { p0: m, c1: bcd, c2: cd, p1: s.p1 },
  ];
}

/**
 * Adds a point on segment `i` (between point `i` and the next) at parameter
 * `t`, without changing the shape: the segment is split, and the neighbours'
 * handles are pulled in to the new halves.
 */
export function insertPoint(points: readonly MaskPoint[], i: number, t: number): MaskPoint[] {
  const n = points.length;
  const [left, right] = splitBezier(segmentAt(points, i), Math.max(0.001, Math.min(0.999, t)));
  const a = points[i];
  const b = points[(i + 1) % n];
  const next = points.map((p) => ({ ...p }));
  next[i] = { ...a, ox: left.c1.x - a.x, oy: left.c1.y - a.y };
  const bi = (i + 1) % n;
  next[bi] = { ...b, ix: right.c2.x - b.x, iy: right.c2.y - b.y };
  const added = point(left.p1.x, left.p1.y, left.c2.x - left.p1.x, left.c2.y - left.p1.y, right.c1.x - right.p0.x, right.c1.y - right.p0.y);
  next.splice(i + 1, 0, added);
  return next;
}

/** The closest point on the path to `p`: which segment, where along it, and how far. */
export function closestOnPath(
  points: readonly MaskPoint[],
  p: Vec,
  sx = 1,
  sy = 1,
): { segment: number; t: number; distance: number } | null {
  const n = points.length;
  if (n < 2) return null;
  let best: { segment: number; t: number; distance: number } | null = null;
  const STEPS = 24;
  for (let i = 0; i < n; i++) {
    const s = segmentAt(points, i);
    let prev = bezierAt(s, 0);
    for (let k = 1; k <= STEPS; k++) {
      const cur = bezierAt(s, k / STEPS);
      const dx = (cur.x - prev.x) * sx;
      const dy = (cur.y - prev.y) * sy;
      const len2 = dx * dx + dy * dy;
      const u = len2 > 0 ? Math.max(0, Math.min(1, (((p.x - prev.x) * sx) * dx + ((p.y - prev.y) * sy) * dy) / len2)) : 0;
      const distance = Math.hypot((p.x - (prev.x + (cur.x - prev.x) * u)) * sx, (p.y - (prev.y + (cur.y - prev.y) * u)) * sy);
      if (!best || distance < best.distance) best = { segment: i, t: (k - 1 + u) / STEPS, distance };
      prev = cur;
    }
  }
  return best;
}

/** Point is a corner when it has no handle at all, smooth otherwise. */
export const isCorner = (p: MaskPoint): boolean => p.ix === 0 && p.iy === 0 && p.ox === 0 && p.oy === 0;

/** Corner ⇄ smooth for point `i`: smooth ones get tangents from their neighbours, corners lose theirs. */
export function toggleSmooth(points: readonly MaskPoint[], i: number): MaskPoint[] {
  const next = points.map((p) => ({ ...p }));
  if (!isCorner(points[i])) {
    next[i] = { ...points[i], ix: 0, iy: 0, ox: 0, oy: 0 };
    return next;
  }
  const n = points.length;
  const prev = points[(i - 1 + n) % n];
  const following = points[(i + 1) % n];
  const tx = (following.x - prev.x) / 6;
  const ty = (following.y - prev.y) / 6;
  next[i] = { ...points[i], ix: -tx, iy: -ty, ox: tx, oy: ty };
  return next;
}

/* -------------------------------------------------------------------------- */
/* Layers                                                                     */
/* -------------------------------------------------------------------------- */

let layerCounter = 0;

export function newLayerId(): string {
  layerCounter += 1;
  return `m${Date.now().toString(36)}${layerCounter.toString(36)}`;
}

/** A painted layer, empty until brushed. `w × h` is the bitmap's size: the mask's own, so strokes are not resampled. */
export function createPaintLayer(bitmap: MaskBitmap, overrides: Partial<MaskLayer> = {}): MaskLayer {
  return createLayer([], { name: "Paint", kind: "paint", bitmap, ...overrides });
}

export const isPaintLayer = (layer: MaskLayer): boolean => layer.kind === "paint";

/** Whether a layer has anything to draw yet: a shape needs three points, a paint layer a bitmap. */
export function layerHasContent(layer: MaskLayer): boolean {
  return layer.kind === "paint" ? layer.bitmap !== undefined : layer.points.length >= 3;
}

export function createLayer(points: MaskPoint[], overrides: Partial<MaskLayer> = {}): MaskLayer {
  return {
    id: newLayerId(),
    name: "Mask",
    mode: "add",
    opacity: 1,
    invert: false,
    feather: 0,
    expansion: 0,
    visible: true,
    points,
    ...overrides,
  };
}

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function sanitizePoint(raw: unknown): MaskPoint | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const x = Number(r.x);
  const y = Number(r.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return point(x, y, num(r.ix, 0), num(r.iy, 0), num(r.ox, 0), num(r.oy, 0));
}

/**
 * Whatever a saved file or a half-edited param holds, as layers the rasteriser
 * can trust: bad points dropped, numbers finite and clamped, a layer with
 * fewer than three points kept (it is still being drawn) but flagged by its
 * point count alone.
 */
export function sanitizeLayers(raw: unknown): MaskLayer[] {
  if (!Array.isArray(raw)) return [];
  const used = new Set<string>();
  const out: MaskLayer[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    let id = typeof r.id === "string" && r.id ? r.id : newLayerId();
    while (used.has(id)) id = newLayerId();
    used.add(id);
    const points = Array.isArray(r.points) ? r.points.map(sanitizePoint).filter((p): p is MaskPoint => p !== null) : [];
    const paint = r.kind === "paint";
    out.push({
      id,
      ...(paint ? { kind: "paint" as const, ...(isValidBitmap(r.bitmap) ? { bitmap: { w: r.bitmap.w, h: r.bitmap.h, data: r.bitmap.data } } : {}) } : {}),
      name: typeof r.name === "string" && r.name ? r.name : paint ? "Paint" : "Mask",
      mode: (MASK_MODES as readonly string[]).includes(r.mode as string) ? (r.mode as MaskMode) : "add",
      opacity: Math.max(0, Math.min(1, num(r.opacity, 1))),
      invert: Boolean(r.invert),
      feather: Math.max(0, Math.min(0.5, num(r.feather, 0))),
      expansion: Math.max(-0.5, Math.min(0.5, num(r.expansion, 0))),
      visible: r.visible === undefined ? true : Boolean(r.visible),
      points,
    });
  }
  return out;
}
