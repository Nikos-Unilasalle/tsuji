import * as THREE from "three";
import type { PolyMesh } from "./quadMesh";
import { setAttribute, setGroup } from "./mesh/polyAttributes";
import { curveIsClosed, safeLength, type Curve3 } from "./curveAttributes";

/*
 * Pure polyline geometry behind the curve operation nodes (curveOps.ts):
 * reading any curve as a polyline, resampling, trimming, filleting,
 * offsetting in a plane, chaining mesh edges, and sweeping a profile along a
 * path into a PolyMesh. Nothing here touches the node graph, so each piece
 * is tested on its own (curveKernel.test.ts).
 *
 * A polyline is a list of points plus `closed`; a closed one does NOT repeat
 * its first point at the end — the closing span is implied. Arc lengths are
 * cumulative: `cum[i]` is the distance from point 0 to point i, and a closed
 * polyline has one more entry, `cum[n]`, its full perimeter.
 */

export type V3 = THREE.Vector3;

export interface Polyline {
  points: V3[];
  closed: boolean;
  /** The source curve's parameter at each point (for reading its attributes). */
  params: number[];
}

const EPS = 1e-9;

// ---------------------------------------------------------------- curves ⇄ polylines

const isLinePiece = (c: unknown): c is THREE.LineCurve3 => c instanceof THREE.LineCurve3;

/** A curve made only of straight pieces: its corners are its points, exactly. */
export function isPolylineCurve(curve: Curve3): boolean {
  if (curve instanceof THREE.LineCurve3) return true;
  return curve instanceof THREE.CurvePath && curve.curves.length > 0 && curve.curves.every(isLinePiece);
}

/**
 * Any curve as a polyline. Straight-piece curves give their corners (nothing
 * lost); anything else is sampled evenly by length — `samples` spans, or a
 * count that follows the curve's own detail.
 */
export function curveToPolyline(curve: Curve3, samples?: number): Polyline {
  const closed = curveIsClosed(curve);
  if (isPolylineCurve(curve) && !(samples && samples > 0)) {
    const pieces = curve instanceof THREE.CurvePath ? (curve.curves as THREE.LineCurve3[]) : [curve as THREE.LineCurve3];
    const pts = [pieces[0].v1.clone(), ...pieces.map((p) => p.v2.clone())];
    const lens = [0];
    let acc = 0;
    for (const p of pieces) lens.push((acc += p.v1.distanceTo(p.v2)));
    const total = acc > EPS ? acc : 1;
    let params = lens.map((l) => l / total);
    let points = pts;
    if (closed && points.length > 1 && points[0].distanceTo(points[points.length - 1]) <= Math.max(1e-7, acc * 1e-6)) {
      points = points.slice(0, -1);
      params = params.slice(0, -1);
    }
    return dedupe({ points, closed, params });
  }
  const spans = Math.max(2, Math.min(4096, Math.round(samples && samples > 0 ? samples : autoSamples(curve))));
  const points: V3[] = [];
  const params: number[] = [];
  const count = closed ? spans : spans + 1;
  const length = safeLength(curve);
  for (let i = 0; i < count; i++) {
    const u = i / spans;
    const t = length > EPS ? curve.getUtoTmapping(u, 0) : u;
    const p = curve.getPoint(Math.min(1, Math.max(0, t)));
    if (!p || !isFiniteV(p)) continue;
    points.push(p.clone());
    params.push(t);
  }
  return dedupe({ points, closed, params });
}

function autoSamples(curve: Curve3): number {
  if (curve instanceof THREE.CatmullRomCurve3) return Math.max(16, (curve.points.length - (curve.closed ? 0 : 1)) * 12);
  if (curve instanceof THREE.CurvePath) return Math.max(16, curve.curves.reduce((n: number, c) => n + (isLinePiece(c) ? 1 : 16), 0));
  return 64;
}

const isFiniteV = (p: V3) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

/** Drops consecutive coincident points (and a closing duplicate): zero-length spans have no direction. */
export function dedupe(line: Polyline): Polyline {
  const points: V3[] = [];
  const params: number[] = [];
  line.points.forEach((p, i) => {
    if (!isFiniteV(p)) return;
    if (points.length && points[points.length - 1].distanceToSquared(p) < 1e-18) return;
    points.push(p);
    params.push(line.params[i] ?? 0);
  });
  if (line.closed && points.length > 1 && points[0].distanceToSquared(points[points.length - 1]) < 1e-18) {
    points.pop();
    params.pop();
  }
  return { points, closed: line.closed && points.length >= 3, params };
}

/**
 * A curve through `points` with straight spans: a CurvePath of LineCurve3,
 * closed by an explicit last span. CurvePath parameterises by length, so
 * getPoint(t) is t of the way along — and Curve to Mesh's worker can rebuild
 * it from toJSON, and getPoints returns exactly the corners.
 */
export function makePolylineCurve(points: readonly V3[], closed: boolean): THREE.CurvePath<THREE.Vector3> {
  const path = new THREE.CurvePath<THREE.Vector3>();
  const pts = points.filter((p, i) => i === 0 || p.distanceToSquared(points[i - 1]) >= 1e-18);
  if (pts.length === 1) {
    path.add(new THREE.LineCurve3(pts[0].clone(), pts[0].clone()));
    return path;
  }
  for (let i = 0; i + 1 < pts.length; i++) path.add(new THREE.LineCurve3(pts[i].clone(), pts[i + 1].clone()));
  if (closed && pts.length >= 3 && pts[0].distanceToSquared(pts[pts.length - 1]) >= 1e-18) {
    path.add(new THREE.LineCurve3(pts[pts.length - 1].clone(), pts[0].clone()));
  }
  return path;
}

export function cumulativeLengths(points: readonly V3[], closed: boolean): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + points[i].distanceTo(points[i - 1]));
  if (closed && points.length > 1) cum.push(cum[points.length - 1] + points[0].distanceTo(points[points.length - 1]));
  return cum;
}

export function polylineLength(points: readonly V3[], closed: boolean): number {
  const cum = cumulativeLengths(points, closed);
  return cum[cum.length - 1] ?? 0;
}

/** The point `s` along the polyline (clamped to its length). */
export function pointAtLength(points: readonly V3[], _closed: boolean, cum: readonly number[], s: number): V3 {
  const n = points.length;
  if (n === 0) return new THREE.Vector3();
  if (n === 1) return points[0].clone();
  const total = cum[cum.length - 1];
  const x = Math.max(0, Math.min(total, Number.isFinite(s) ? s : 0));
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= x) lo = mid;
    else hi = mid;
  }
  const a = points[lo % n];
  const b = points[hi % n];
  const span = cum[hi] - cum[lo];
  return a.clone().lerp(b, span > EPS ? (x - cum[lo]) / span : 0);
}

/** Linear interpolation of per-point values (`params`) at arc length `s` — closing span blends back to the first. */
export function valueAtLength(values: readonly number[], closed: boolean, cum: readonly number[], s: number, wrapValue?: number): number {
  const n = values.length;
  if (n === 0) return 0;
  if (n === 1) return values[0];
  const total = cum[cum.length - 1];
  const x = Math.max(0, Math.min(total, Number.isFinite(s) ? s : 0));
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= x) lo = mid;
    else hi = mid;
  }
  const a = values[lo % n];
  const b = closed && hi === n ? (wrapValue ?? values[0]) : values[hi % n];
  const span = cum[hi] - cum[lo];
  return span > EPS ? a + (b - a) * ((x - cum[lo]) / span) : a;
}

// ---------------------------------------------------------------- resample / trim

export interface ArcPoints {
  points: V3[];
  /** Arc length along the source polyline of each output point. */
  at: number[];
}

/**
 * Points evenly spaced along a polyline. By count: `count` points (an open
 * line keeps both ends; a closed one spreads them round the loop). By
 * spacing: the nearest whole number of equal spans to `spacing`, so the
 * spacing is exactly even rather than leaving a short last span.
 */
export function resamplePolyline(
  points: readonly V3[],
  closed: boolean,
  opts: { count?: number; spacing?: number },
): ArcPoints {
  const cum = cumulativeLengths(points, closed);
  const total = cum[cum.length - 1] ?? 0;
  if (points.length < 2 || total <= EPS) return { points: points.slice(0, 1).map((p) => p.clone()), at: points.length ? [0] : [] };
  let spans: number;
  if (opts.spacing !== undefined) {
    const spacing = Math.max(total / 100000, Math.abs(opts.spacing) || total);
    spans = Math.max(closed ? 3 : 1, Math.round(total / spacing));
  } else {
    const count = Math.max(closed ? 3 : 2, Math.round(opts.count ?? 2));
    spans = closed ? count : count - 1;
  }
  spans = Math.min(100000, spans);
  const out: V3[] = [];
  const at: number[] = [];
  const count = closed ? spans : spans + 1;
  for (let i = 0; i < count; i++) {
    const s = (total * i) / spans;
    out.push(pointAtLength(points, closed, cum, s));
    at.push(s);
  }
  return { points: out, at };
}

/**
 * The part of a polyline between arc lengths `s0` and `s1` (s0 ≤ s1 after
 * clamping), keeping every corner in between. On a closed polyline a range
 * that wraps past the end (s1 > total) continues round from the start, so a
 * trim window can slide round a loop.
 */
export function trimPolyline(points: readonly V3[], closed: boolean, s0: number, s1: number): ArcPoints {
  const cum = cumulativeLengths(points, closed);
  const total = cum[cum.length - 1] ?? 0;
  if (points.length < 2 || total <= EPS) return { points: points.slice(0, 1).map((p) => p.clone()), at: points.length ? [0] : [] };
  let a = Number.isFinite(s0) ? s0 : 0;
  let b = Number.isFinite(s1) ? s1 : total;
  if (b < a) [a, b] = [b, a];
  if (closed) {
    const shift = Math.floor(a / total) * total;
    a -= shift;
    b = Math.min(b - shift, a + total);
  } else {
    a = Math.max(0, Math.min(total, a));
    b = Math.max(0, Math.min(total, b));
  }
  const out: V3[] = [pointAtLength(points, closed, cum, a)];
  const outAt: number[] = [a];
  const laps = closed ? 2 : 1;
  for (let lap = 0; lap < laps; lap++) {
    for (let i = 0; i < points.length; i++) {
      const s = cum[i] + lap * total;
      if (s > a + EPS && s < b - EPS) {
        out.push(points[i % points.length].clone());
        outAt.push(s);
      }
    }
  }
  if (b - a > EPS) {
    out.push(pointAtLength(points, closed, cum, b > total && closed ? b - total : b));
    outAt.push(b);
  }
  return { points: out, at: outAt };
}

// ---------------------------------------------------------------- fillet

export interface MappedPoints {
  points: V3[];
  /** Index of the source point each output point came from. */
  source: number[];
}

/**
 * Rounds the corners of a polyline with circular arcs of `radius`, each made
 * of `segments` spans — Blender's Fillet Curve (Poly mode). An arc starts
 * and ends where it meets the two straight spans tangentially; when the
 * spans are too short for the radius, the arc shrinks to fit (half of each
 * span, or all of a span that ends at an open end) instead of overshooting,
 * which is Blender's "Limit Radius". Open ends never move. Works in 3D: each
 * corner is rounded in the plane of its own two spans.
 */
export function filletPolyline(points: readonly V3[], closed: boolean, radius: number, segments: number): MappedPoints {
  const n = points.length;
  const r = Math.max(0, Number.isFinite(radius) ? radius : 0);
  const segs = Math.max(1, Math.min(256, Math.round(Number.isFinite(segments) ? segments : 1)));
  const copy = (): MappedPoints => ({ points: points.map((p) => p.clone()), source: points.map((_, i) => i) });
  if (n < 3 || r <= EPS) return copy();
  const out: V3[] = [];
  const source: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const isEnd = !closed && (i === 0 || i === n - 1);
    if (isEnd) {
      out.push(points[i].clone());
      source.push(i);
      continue;
    }
    const prevI = (i - 1 + n) % n;
    const nextI = (i + 1) % n;
    const p = points[i];
    a.subVectors(points[prevI], p);
    b.subVectors(points[nextI], p);
    const la = a.length();
    const lb = b.length();
    if (la <= EPS || lb <= EPS) {
      out.push(p.clone());
      source.push(i);
      continue;
    }
    a.divideScalar(la);
    b.divideScalar(lb);
    const alpha = Math.acos(Math.max(-1, Math.min(1, a.dot(b))));
    // Straight through (nothing to round) or folding straight back (no arc fits).
    if (alpha > Math.PI - 1e-5 || alpha < 1e-5) {
      out.push(p.clone());
      source.push(i);
      continue;
    }
    const half = alpha / 2;
    let d = r / Math.tan(half);
    const maxA = !closed && prevI === 0 ? la : la / 2;
    const maxB = !closed && nextI === n - 1 ? lb : lb / 2;
    d = Math.min(d, maxA, maxB);
    const rEff = d * Math.tan(half);
    const start = p.clone().addScaledVector(a, d);
    const end = p.clone().addScaledVector(b, d);
    const bis = a.clone().add(b).normalize();
    const center = p.clone().addScaledVector(bis, rEff / Math.sin(half));
    const ca = start.clone().sub(center);
    const cb = end.clone().sub(center);
    const phi = Math.PI - alpha;
    const sinPhi = Math.sin(phi);
    for (let k = 0; k <= segs; k++) {
      const f = k / segs;
      const q =
        sinPhi > 1e-9
          ? center
              .clone()
              .addScaledVector(ca, Math.sin((1 - f) * phi) / sinPhi)
              .addScaledVector(cb, Math.sin(f * phi) / sinPhi)
          : start.clone().lerp(end, f);
      out.push(q);
      source.push(i);
    }
  }
  return dedupeMapped({ points: out, source }, closed);
}

function dedupeMapped(m: MappedPoints, closed: boolean): MappedPoints {
  const points: V3[] = [];
  const source: number[] = [];
  m.points.forEach((p, i) => {
    if (points.length && points[points.length - 1].distanceToSquared(p) < 1e-18) return;
    points.push(p);
    source.push(m.source[i]);
  });
  if (closed && points.length > 1 && points[0].distanceToSquared(points[points.length - 1]) < 1e-18) {
    points.pop();
    source.pop();
  }
  return { points, source };
}

// ---------------------------------------------------------------- planes

/**
 * The normal of the plane a set of points lies closest to. A closed outline
 * uses Newell's method, which also says which way it winds (the normal is
 * the one the loop turns counter-clockwise about). Otherwise — or when the
 * loop encloses no area — the least-squares plane through the points, the
 * sign chosen so the largest component is positive (up, for a curve drawn
 * on the ground). A straight line has no plane: the one containing world Y
 * (or Z, for a vertical line) is used.
 */
export function bestFitNormal(points: readonly V3[], closed: boolean): V3 {
  const n = points.length;
  if (closed && n >= 3) {
    const nn = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const q = points[(i + 1) % n];
      nn.x += (p.y - q.y) * (p.z + q.z);
      nn.y += (p.z - q.z) * (p.x + q.x);
      nn.z += (p.x - q.x) * (p.y + q.y);
    }
    const scale = Math.max(EPS, extent(points) ** 2);
    if (nn.length() > scale * 1e-6) return nn.normalize();
  }
  const c = new THREE.Vector3();
  for (const p of points) c.add(p);
  c.divideScalar(Math.max(1, n));
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of points) {
    const x = p.x - c.x, y = p.y - c.y, z = p.z - c.z;
    xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
  }
  const detX = yy * zz - yz * yz;
  const detY = xx * zz - xz * xz;
  const detZ = xx * yy - xy * xy;
  const maxDet = Math.max(detX, detY, detZ);
  const scale = Math.max(EPS, (xx + yy + zz) ** 2);
  let normal: V3;
  if (maxDet > scale * 1e-9) {
    if (maxDet === detX) normal = new THREE.Vector3(detX, xz * yz - xy * zz, xy * yz - xz * yy);
    else if (maxDet === detY) normal = new THREE.Vector3(xz * yz - xy * zz, detY, xy * xz - yz * xx);
    else normal = new THREE.Vector3(xy * yz - xz * yy, xy * xz - yz * xx, detZ);
    normal.normalize();
  } else {
    const dir = n >= 2 ? points[n - 1].clone().sub(points[0]) : new THREE.Vector3(1, 0, 0);
    if (dir.lengthSq() < EPS) dir.set(1, 0, 0);
    dir.normalize();
    const up = Math.abs(dir.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    normal = up.addScaledVector(dir, -up.dot(dir)).normalize();
  }
  const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
  const major = ay >= ax && ay >= az ? normal.y : az >= ax ? normal.z : normal.x;
  if (major < 0) normal.negate();
  return normal;
}

function extent(points: readonly V3[]): number {
  const box = new THREE.Box3().setFromPoints(points as V3[]);
  return box.isEmpty() ? 0 : box.getSize(new THREE.Vector3()).length();
}

/** Two unit axes spanning the plane of `normal`, (u, v, normal) right-handed. */
export function planeAxes(normal: V3): { u: V3; v: V3 } {
  // Near-horizontal planes take u along world X (v then runs along -Z, as
  // curveLists' toPlane reads the ground); others take u = Y × normal, which
  // is world X for a curve drawn facing +Z.
  const u =
    Math.abs(normal.y) < 0.9
      ? new THREE.Vector3(0, 1, 0).cross(normal).normalize()
      : new THREE.Vector3(1, 0, 0).addScaledVector(normal, -normal.x).normalize();
  const v = normal.clone().cross(u).normalize();
  return { u, v };
}

// ---------------------------------------------------------------- offset 2D

export type OffsetJoin = "miter" | "round" | "bevel";

export interface OffsetOptions {
  join?: OffsetJoin;
  /** Miter length over offset distance beyond which a miter becomes a bevel. */
  miterLimit?: number;
  /** Spans per 90° of a round join. */
  roundSegments?: number;
  /** Plane normal; best-fit when omitted. */
  normal?: V3;
}

/**
 * Offsets a (roughly) planar polyline within its plane — Houdini's PolyExpand
 * 2D / Blender's 2D offset. Positive `distance` goes outward on a closed
 * outline (whichever way it winds) and to the right of travel, seen from the
 * plane normal, on an open one. Outer corners get the chosen join; inner
 * corners meet at the intersection of the two offset spans. Each point keeps
 * its own height off the plane, so a slightly warped outline stays warped.
 *
 * Limitation: no self-intersection cleanup. An inward offset larger than a
 * feature's half-width folds over itself, as PolyExpand does without its
 * clean-up stage.
 */
export function offsetPolyline2D(points: readonly V3[], closed: boolean, distance: number, opts: OffsetOptions = {}): MappedPoints {
  const n = points.length;
  const dist = Number.isFinite(distance) ? distance : 0;
  if (n < 2 || Math.abs(dist) <= EPS) return { points: points.map((p) => p.clone()), source: points.map((_, i) => i) };
  const normal = opts.normal && opts.normal.lengthSq() > EPS ? opts.normal.clone().normalize() : bestFitNormal(points, closed);
  const { u, v } = planeAxes(normal);
  const P = points.map((p) => [p.dot(u), p.dot(v)] as [number, number]);
  // Newell's normal makes a closed loop wind CCW in (u, v); one handed in may not.
  let side = 1;
  if (closed && n >= 3) {
    let area = 0;
    for (let i = 0; i < n; i++) {
      const [x0, y0] = P[i];
      const [x1, y1] = P[(i + 1) % n];
      area += x0 * y1 - x1 * y0;
    }
    if (area < 0) side = -1;
  }
  const d = dist * side;
  const spanCount = closed ? n : n - 1;
  const dirs: [number, number][] = [];
  for (let i = 0; i < spanCount; i++) {
    const [x0, y0] = P[i];
    const [x1, y1] = P[(i + 1) % n];
    const len = Math.hypot(x1 - x0, y1 - y0);
    dirs.push(len > EPS ? [(x1 - x0) / len, (y1 - y0) / len] : [0, 0]);
  }
  // A span with no length in the plane (vertical, or a duplicate) borrows its neighbour's direction.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < spanCount; i++) {
      if (dirs[i][0] !== 0 || dirs[i][1] !== 0) continue;
      const nb = dirs[(i - 1 + spanCount) % spanCount];
      const na = dirs[(i + 1) % spanCount];
      dirs[i] = nb[0] !== 0 || nb[1] !== 0 ? nb : na;
    }
  }
  const normalOf = (dir: [number, number]): [number, number] => [dir[1], -dir[0]];
  const join = opts.join ?? "miter";
  const miterLimit = Math.max(1, opts.miterLimit ?? 4);
  const roundSegs = Math.max(1, Math.round(opts.roundSegments ?? 4));
  const out: V3[] = [];
  const source: number[] = [];
  const emit = (i: number, ox: number, oy: number) => {
    out.push(points[i].clone().addScaledVector(u, ox).addScaledVector(v, oy));
    source.push(i);
  };
  for (let i = 0; i < n; i++) {
    const inI = closed ? (i - 1 + spanCount) % spanCount : i - 1;
    const outI = closed ? i % spanCount : i;
    const hasIn = inI >= 0 && inI < spanCount;
    const hasOut = outI < spanCount && (closed || i < n - 1);
    if (!hasIn || !hasOut) {
      const m = normalOf(dirs[hasIn ? inI : outI] ?? [1, 0]);
      emit(i, m[0] * d, m[1] * d);
      continue;
    }
    const d1 = dirs[inI];
    const d2 = dirs[outI];
    const m1 = normalOf(d1);
    const m2 = normalOf(d2);
    const cross = d1[0] * d2[1] - d1[1] * d2[0];
    const dot = m1[0] * m2[0] + m1[1] * m2[1];
    if (Math.abs(cross) < 1e-9 && dot > 0) {
      emit(i, m1[0] * d, m1[1] * d);
      continue;
    }
    // Left turn with the offset to the right (or right turn, offset left) opens a gap: an outer corner.
    const outer = cross > 0 === d > 0;
    const denom = 1 + dot;
    const miterOk = denom > 1e-9 && Math.sqrt(2 / denom) <= miterLimit;
    if (!outer) {
      if (denom > 1e-6) emit(i, ((m1[0] + m2[0]) / denom) * d, ((m1[1] + m2[1]) / denom) * d);
      else {
        emit(i, m1[0] * d, m1[1] * d);
        emit(i, m2[0] * d, m2[1] * d);
      }
      continue;
    }
    if (join === "miter" && miterOk) {
      emit(i, ((m1[0] + m2[0]) / denom) * d, ((m1[1] + m2[1]) / denom) * d);
    } else if (join === "round") {
      const a1 = Math.atan2(m1[1], m1[0]);
      let a2 = Math.atan2(m2[1], m2[0]);
      let delta = a2 - a1;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      a2 = a1 + delta;
      const steps = Math.max(1, Math.ceil((Math.abs(delta) / (Math.PI / 2)) * roundSegs));
      for (let k = 0; k <= steps; k++) {
        const a = a1 + (delta * k) / steps;
        emit(i, Math.cos(a) * d, Math.sin(a) * d);
      }
    } else {
      emit(i, m1[0] * d, m1[1] * d);
      emit(i, m2[0] * d, m2[1] * d);
    }
  }
  return dedupeMapped({ points: out, source }, closed);
}

// ---------------------------------------------------------------- edge chains

export interface EdgeChain {
  verts: number[];
  closed: boolean;
}

/**
 * Orders a set of edges into polylines. Unlike bridge.ts's edgeChains,
 * branching is fine: a vertex where three or more edges meet ends every
 * chain that reaches it (Houdini's Polypath / Blender's Mesh to Curve both
 * split there), so a grid of edges becomes its separate runs. Pieces with no
 * end or junction become closed loops. Duplicate and degenerate edges are
 * ignored. Deterministic: chains start from the lowest vertex index.
 */
export function chainEdges(edges: ReadonlyArray<readonly [number, number]>): EdgeChain[] {
  const seenPair = new Set<string>();
  const list: [number, number][] = [];
  for (const [a, b] of edges) {
    if (a === b || !Number.isInteger(a) || !Number.isInteger(b)) continue;
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    list.push([a, b]);
  }
  const adj = new Map<number, { to: number; edge: number }[]>();
  list.forEach(([a, b], e) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push({ to: b, edge: e });
    adj.get(b)!.push({ to: a, edge: e });
  });
  for (const nbrs of adj.values()) nbrs.sort((x, y) => x.to - y.to);
  const used = new Uint8Array(list.length);
  const chains: EdgeChain[] = [];
  const isStop = (v: number) => adj.get(v)!.length !== 2;
  const walk = (start: number, first: { to: number; edge: number }): EdgeChain => {
    const verts = [start];
    let cur = first;
    for (;;) {
      used[cur.edge] = 1;
      verts.push(cur.to);
      if (cur.to === start) return { verts: verts.slice(0, -1), closed: true };
      if (isStop(cur.to)) return { verts, closed: false };
      const next = adj.get(cur.to)!.find((x) => !used[x.edge]);
      if (!next) return { verts, closed: false };
      cur = next;
    }
  };
  const vertsSorted = [...adj.keys()].sort((a, b) => a - b);
  for (const v of vertsSorted) {
    if (!isStop(v)) continue;
    for (const nb of adj.get(v)!) if (!used[nb.edge]) chains.push(walk(v, nb));
  }
  for (const v of vertsSorted) {
    for (const nb of adj.get(v)!) {
      if (used[nb.edge]) continue;
      const chain = walk(v, nb);
      // A two-edge "loop" is a doubled edge; it was deduplicated above, so a closed chain has ≥ 3 vertices.
      chains.push(chain.closed && chain.verts.length < 3 ? { verts: chain.verts, closed: false } : chain);
    }
  }
  return chains;
}

// ---------------------------------------------------------------- sweep

export interface Frame {
  t: V3;
  n: V3;
  b: V3;
}

/**
 * Rotation-minimising frames along a polyline (Wang et al.'s double
 * reflection): the profile doesn't spin about the path the way Frenet frames
 * do at inflections. The first normal is world up projected off the first
 * tangent (world Z when the path starts vertical), so a path drawn on the
 * ground sweeps a flat profile lying flat. On a closed path the twist left
 * over after one lap is spread evenly so the seam meets itself.
 */
export function rotationMinimizingFrames(points: readonly V3[], closed: boolean): Frame[] {
  const n = points.length;
  if (n === 0) return [];
  const tangents: V3[] = points.map((_, i) => {
    const prev = closed ? points[(i - 1 + n) % n] : points[Math.max(0, i - 1)];
    const next = closed ? points[(i + 1) % n] : points[Math.min(n - 1, i + 1)];
    const t = next.clone().sub(prev);
    return t.lengthSq() > 1e-24 ? t.normalize() : new THREE.Vector3();
  });
  for (let i = 0; i < n; i++) {
    if (tangents[i].lengthSq() > 0) continue;
    const near = tangents.find((t) => t.lengthSq() > 0);
    tangents[i] = near ? near.clone() : new THREE.Vector3(1, 0, 0);
  }
  const t0 = tangents[0];
  const up = Math.abs(t0.y) < 0.999 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const n0 = up.addScaledVector(t0, -up.dot(t0)).normalize();
  const frames: Frame[] = [{ t: t0.clone(), n: n0, b: t0.clone().cross(n0).normalize() }];
  const transport = (from: Frame, p0: V3, p1: V3, t1: V3): V3 => {
    const v1 = p1.clone().sub(p0);
    const c1 = v1.dot(v1);
    if (c1 < 1e-24) return from.n.clone();
    const rL = from.n.clone().addScaledVector(v1, (-2 / c1) * v1.dot(from.n));
    const tL = from.t.clone().addScaledVector(v1, (-2 / c1) * v1.dot(from.t));
    const v2 = t1.clone().sub(tL);
    const c2 = v2.dot(v2);
    const r = c2 < 1e-24 ? rL : rL.addScaledVector(v2, (-2 / c2) * v2.dot(rL));
    return r.addScaledVector(t1, -r.dot(t1)).normalize();
  };
  for (let i = 1; i < n; i++) {
    const nn = transport(frames[i - 1], points[i - 1], points[i], tangents[i]);
    frames.push({ t: tangents[i].clone(), n: nn, b: tangents[i].clone().cross(nn).normalize() });
  }
  if (closed && n >= 3) {
    const back = transport(frames[n - 1], points[n - 1], points[0], tangents[0]);
    const angle = Math.atan2(back.clone().cross(frames[0].n).dot(tangents[0]), back.dot(frames[0].n));
    if (Number.isFinite(angle) && Math.abs(angle) > 1e-9) {
      for (let i = 1; i < n; i++) {
        const q = new THREE.Quaternion().setFromAxisAngle(frames[i].t, (angle * i) / n);
        frames[i].n.applyQuaternion(q);
        frames[i].b.applyQuaternion(q);
      }
    }
  }
  return frames;
}

export interface SweepRing {
  point: V3;
  /** Profile scale at this ring (radius × scale ramp). */
  scale: number;
  /** Rotation of the profile about the path, radians (tilt + twist). */
  angle: number;
  /** 0..1 along the path. */
  u: number;
}

export interface SweepOptions {
  rings: SweepRing[];
  pathClosed: boolean;
  /** Profile in its own 2D plane: x goes along the frame binormal, y along its normal. */
  profile: [number, number][];
  profileClosed: boolean;
  caps: boolean;
}

/**
 * Sweeps a 2D profile along a path into a PolyMesh: one ring of profile
 * points per path point, quads between rings, an n-gon cap at each open end
 * of a closed profile. Faces point outward for a profile wound
 * counter-clockwise (and are flipped for a clockwise one, so a profile
 * drawn either way gives the same solid). Writes face groups `side` and
 * `caps`, and point attributes `u` (along the path) and `v` (around the
 * profile), plus per-corner UVs from (u, v) so textures wrap without a seam
 * smear.
 */
export function buildSweepMesh(opts: SweepOptions): PolyMesh {
  const { rings, profile } = opts;
  const pathClosed = opts.pathClosed && rings.length >= 3;
  const profileClosed = opts.profileClosed && profile.length >= 3;
  const m = profile.length;
  const R = rings.length;
  if (R < 2 || m < 2) return { positions: [], faces: [], shading: "auto" };

  const frames = rotationMinimizingFrames(rings.map((r) => r.point), pathClosed);
  let area = 0;
  for (let j = 0; j < m; j++) {
    const [x0, y0] = profile[j];
    const [x1, y1] = profile[(j + 1) % m];
    area += x0 * y1 - x1 * y0;
  }
  const flip = profileClosed && area < 0;

  const vLen = [0];
  for (let j = 1; j <= m; j++) {
    if (j === m && !profileClosed) break;
    const [x0, y0] = profile[j - 1];
    const [x1, y1] = profile[j % m];
    vLen.push(vLen[j - 1] + Math.hypot(x1 - x0, y1 - y0));
  }
  const vTotal = vLen[vLen.length - 1] || 1;
  const vOf = (j: number) => vLen[j] / vTotal;

  const positions: [number, number, number][] = [];
  const uAttr: number[] = [];
  const vAttr: number[] = [];
  const tmp = new THREE.Vector3();
  rings.forEach((ring, i) => {
    const f = frames[i];
    const c = Math.cos(ring.angle);
    const s = Math.sin(ring.angle);
    const k = Number.isFinite(ring.scale) ? ring.scale : 1;
    for (let j = 0; j < m; j++) {
      const [x, y] = profile[j];
      const px = (x * c - y * s) * k;
      const py = (x * s + y * c) * k;
      tmp.copy(ring.point).addScaledVector(f.b, px).addScaledVector(f.n, py);
      positions.push([fin(tmp.x), fin(tmp.y), fin(tmp.z)]);
      uAttr.push(ring.u);
      vAttr.push(vOf(j));
    }
  });

  const faces: number[][] = [];
  const faceUVs: [number, number][][] = [];
  const isCap: number[] = [];
  const idx = (i: number, j: number) => (i % R) * m + (j % m);
  const ringSpans = pathClosed ? R : R - 1;
  const profSpans = profileClosed ? m : m - 1;
  for (let i = 0; i < ringSpans; i++) {
    const u0 = rings[i].u;
    const u1 = i + 1 === R ? 1 : rings[i + 1].u;
    for (let j = 0; j < profSpans; j++) {
      const v0 = vOf(j);
      const v1 = j + 1 === m ? 1 : vOf(j + 1);
      let face = [idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)];
      let uvs: [number, number][] = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
      if (flip) {
        face = face.reverse();
        uvs = uvs.reverse();
      }
      faces.push(face);
      faceUVs.push(uvs);
      isCap.push(0);
    }
  }
  if (opts.caps && profileClosed && !pathClosed) {
    const capUV = (j: number): [number, number] => {
      const [x, y] = profile[j];
      return [x, y];
    };
    let start = Array.from({ length: m }, (_, j) => idx(0, j));
    let end = Array.from({ length: m }, (_, j) => idx(R - 1, m - 1 - j));
    let startUV = Array.from({ length: m }, (_, j) => capUV(j));
    let endUV = Array.from({ length: m }, (_, j) => capUV(m - 1 - j));
    if (flip) {
      start = start.reverse();
      end = end.reverse();
      startUV = startUV.reverse();
      endUV = endUV.reverse();
    }
    faces.push(start, end);
    faceUVs.push(startUV, endUV);
    isCap.push(1, 1);
  }

  let mesh: PolyMesh = { positions, faces, faceUVs, shading: "auto" };
  mesh = setAttribute(mesh, "point", "u", "float", uAttr);
  mesh = setAttribute(mesh, "point", "v", "float", vAttr);
  // `side`, not `sides`: `sides` is the built-in face attribute (corner
  // count), which setAttribute refuses to overwrite and which would shadow a
  // group of that name in every expression.
  mesh = setGroup(mesh, "face", "side", isCap.map((c) => 1 - c));
  mesh = setGroup(mesh, "face", "caps", isCap);
  return mesh;
}

const fin = (x: number) => (Number.isFinite(x) ? x : 0);

/** Built-in sweep profiles, counter-clockwise, radius / half-width 1. */
export function builtinProfile(kind: string, segments: number): { points: [number, number][]; closed: boolean } {
  if (kind === "square") return { points: [[1, -1], [1, 1], [-1, 1], [-1, -1]], closed: true };
  // Runs from +x to -x so a ribbon swept along a path on the ground faces up.
  if (kind === "flat") return { points: [[1, 0], [-1, 0]], closed: false };
  const n = Math.max(3, Math.min(256, Math.round(Number.isFinite(segments) ? segments : 12)));
  return {
    points: Array.from({ length: n }, (_, j) => {
      const a = (j / n) * Math.PI * 2;
      return [Math.cos(a), Math.sin(a)] as [number, number];
    }),
    closed: true,
  };
}

/** A curve's points as a 2D profile in its own best-fit plane (origin kept, so an offset profile sweeps off-centre). */
export function profileFromPolyline(line: Polyline): { points: [number, number][]; closed: boolean } {
  const normal = bestFitNormal(line.points, line.closed);
  // A profile drawn flat in XY (facing +Z) reads as-is: x → x, y → y.
  if (Math.abs(normal.z) >= Math.abs(normal.x) && Math.abs(normal.z) >= Math.abs(normal.y)) {
    return { points: line.points.map((p) => [p.x, p.y]), closed: line.closed };
  }
  const { u, v } = planeAxes(normal);
  return { points: line.points.map((p) => [p.dot(u), p.dot(v)]), closed: line.closed };
}
