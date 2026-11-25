import * as THREE from "three";

/*
 * Per-control-point attributes on a curve (radius, tilt, any float) — what
 * Blender keeps on a spline's points and Houdini on a curve's points.
 *
 * A `curve` socket carries a bare THREE.Curve, and dozens of nodes read it
 * through `instanceof CatmullRomCurve3`, `.points`, `toJSON()` and the
 * geometry worker's curveFromJSON. Subclassing every curve type to add a
 * field would break all of that, so the attributes live BESIDE the curve, in
 * a WeakMap keyed by the curve object: nodes that don't know about them see
 * exactly the curve they always saw, and the values die with the curve.
 *
 * A track is a list of values at knots along the curve's own parameter `t`
 * (the one getPoint takes), ascending in [0, 1] — normally one knot per
 * control point. Reading between knots is linear; on a closed curve the last
 * knot blends back into the first over the closing span.
 *
 * Curves are immutable once handed downstream, so a node that sets an
 * attribute makes a new curve of the same shape (cloneCurveShape) and tags
 * that one — never the input.
 */

export type Curve3 = THREE.Curve<THREE.Vector3>;

export interface CurveAttributeTrack {
  /** Curve parameter of each value, ascending, in [0, 1]. */
  knots: number[];
  values: number[];
  /** The last knot interpolates back to the first across t = 1. */
  closed: boolean;
}

export type CurveAttributeMap = Readonly<Record<string, CurveAttributeTrack>>;

/** What a curve without the attribute reads: Blender's defaults. */
export const CURVE_ATTRIBUTE_DEFAULTS: Readonly<Record<string, number>> = { radius: 1, tilt: 0 };

const store = new WeakMap<Curve3, CurveAttributeMap>();
const EMPTY: CurveAttributeMap = Object.freeze({});

export function curveAttributeDefault(name: string): number {
  return CURVE_ATTRIBUTE_DEFAULTS[name] ?? 0;
}

export function getCurveAttributes(curve: Curve3 | null | undefined): CurveAttributeMap {
  return (curve && store.get(curve)) || EMPTY;
}

export function hasCurveAttribute(curve: Curve3 | null | undefined, name: string): boolean {
  return Boolean(curve && store.get(curve)?.[name]);
}

export function curveAttributeNames(curve: Curve3 | null | undefined): string[] {
  return Object.keys(getCurveAttributes(curve));
}

/**
 * Attaches attributes to a curve the caller has just built. Tracks are
 * sanitised (finite values, knots clamped and sorted) so a reader never has
 * to be defensive. Returns the curve for chaining.
 */
export function attachCurveAttributes(curve: Curve3, attributes: Record<string, CurveAttributeTrack>): Curve3 {
  const clean: Record<string, CurveAttributeTrack> = {};
  for (const [name, track] of Object.entries(attributes)) {
    const t = sanitizeTrack(track);
    if (t) clean[name] = t;
  }
  if (Object.keys(clean).length) store.set(curve, Object.freeze(clean));
  else store.delete(curve);
  return curve;
}

function sanitizeTrack(track: CurveAttributeTrack | undefined): CurveAttributeTrack | null {
  if (!track || !Array.isArray(track.knots) || !Array.isArray(track.values)) return null;
  const n = Math.min(track.knots.length, track.values.length);
  const pairs: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const k = Number(track.knots[i]);
    const v = Number(track.values[i]);
    if (!Number.isFinite(k)) continue;
    pairs.push([Math.max(0, Math.min(1, k)), Number.isFinite(v) ? v : 0]);
  }
  if (pairs.length === 0) return null;
  pairs.sort((a, b) => a[0] - b[0]);
  return { knots: pairs.map((p) => p[0]), values: pairs.map((p) => p[1]), closed: Boolean(track.closed) };
}

/** A track's value at parameter `t`. */
export function sampleTrack(track: CurveAttributeTrack, t: number): number {
  const { knots, values } = track;
  const n = knots.length;
  if (n === 0) return 0;
  if (n === 1) return values[0];
  const x = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  if (x <= knots[0]) {
    if (!track.closed) return values[0];
    // Wrap span before the first knot: from the last knot (shifted by -1) to the first.
    const span = knots[0] + (1 - knots[n - 1]);
    return span > 1e-12 ? lerp(values[n - 1], values[0], (x + 1 - knots[n - 1]) / span) : values[0];
  }
  if (x >= knots[n - 1]) {
    if (!track.closed) return values[n - 1];
    const span = knots[0] + (1 - knots[n - 1]);
    return span > 1e-12 ? lerp(values[n - 1], values[0], (x - knots[n - 1]) / span) : values[n - 1];
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (knots[mid] <= x) lo = mid;
    else hi = mid;
  }
  const span = knots[hi] - knots[lo];
  return span > 1e-12 ? lerp(values[lo], values[hi], (x - knots[lo]) / span) : values[hi];
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

/**
 * The value of a curve attribute at curve parameter `t` — interpolated
 * between control points, or the attribute's default (radius 1, tilt 0,
 * anything else 0) when the curve doesn't carry it.
 */
export function curvePointAttribute(curve: Curve3 | null | undefined, name: string, t: number): number {
  const track = curve ? store.get(curve)?.[name] : undefined;
  return track ? sampleTrack(track, t) : curveAttributeDefault(name);
}

/** True for a closed CatmullRom, a CurvePath set to autoClose, or any curve whose ends meet. */
export function curveIsClosed(curve: Curve3): boolean {
  if ((curve as THREE.CatmullRomCurve3).closed === true) return true;
  if ((curve as THREE.CurvePath<THREE.Vector3>).autoClose === true) return true;
  const a = curve.getPoint(0);
  const b = curve.getPoint(1);
  if (!a || !b) return false;
  const length = safeLength(curve);
  return length > 1e-9 && a.distanceTo(b) <= Math.max(1e-7, length * 1e-6);
}

export function safeLength(curve: Curve3): number {
  try {
    const l = curve.getLength();
    return Number.isFinite(l) ? l : 0;
  } catch {
    return 0;
  }
}

/**
 * The curve parameters of a curve's control points — where a track with one
 * value per control point puts its knots. For a closed curve the closing
 * point (which repeats the first) is not listed.
 *   - CurvePath: where each piece starts (and the last one ends), by length,
 *     which is how CurvePath.getPoint parameterises;
 *   - CatmullRom: evenly, i / (n - 1), or i / n closed (three's own spacing);
 *   - anything else: its two ends.
 */
export function curveControlParams(curve: Curve3): number[] {
  if (curve instanceof THREE.CatmullRomCurve3) {
    const n = curve.points.length;
    if (n <= 1) return [0];
    const denom = curve.closed ? n : n - 1;
    return Array.from({ length: n }, (_, i) => i / denom);
  }
  if (curve instanceof THREE.CurvePath) {
    const pieces = curve.curves as Curve3[];
    if (pieces.length === 0) return [0];
    const lens = curve.getCurveLengths();
    const total = lens[lens.length - 1] || 0;
    const out = [0];
    for (let i = 0; i < pieces.length - 1; i++) out.push(total > 0 ? lens[i] / total : (i + 1) / pieces.length);
    if (!curveIsClosed(curve)) out.push(1);
    return out;
  }
  return curveIsClosed(curve) ? [0] : [0, 1];
}

/**
 * A new curve object with the same shape as `curve`, for a node that only
 * changes attributes. Sub-curves and points are shared where three's own
 * classes allow it (nothing mutates a curve after it leaves its node); a
 * class this doesn't know is wrapped instead of cloned, because Curve.clone()
 * calls the constructor with no arguments — which leaves SaggedLineCurve3,
 * say, without its end points.
 */
export function cloneCurveShape(curve: Curve3): Curve3 {
  if (curve instanceof THREE.CatmullRomCurve3) {
    const c = new THREE.CatmullRomCurve3(curve.points.map((p) => p.clone()), curve.closed, curve.curveType, curve.tension);
    c.arcLengthDivisions = curve.arcLengthDivisions;
    return c;
  }
  if (curve instanceof THREE.CurvePath) {
    const path = new THREE.CurvePath<THREE.Vector3>();
    path.autoClose = curve.autoClose;
    for (const piece of curve.curves) path.add(piece as Curve3);
    path.arcLengthDivisions = curve.arcLengthDivisions;
    return path;
  }
  if (curve instanceof THREE.LineCurve3 || curve instanceof THREE.QuadraticBezierCurve3 || curve instanceof THREE.CubicBezierCurve3) {
    return curve.clone();
  }
  return new CurveView3(curve);
}

/**
 * A curve that is another curve: same points, same parameter. Only exists so
 * an unknown curve class can get attributes of its own without touching the
 * original. Its toJSON names the base, so a signature built from it changes
 * when the base does.
 */
export class CurveView3 extends THREE.Curve<THREE.Vector3> {
  constructor(readonly base: Curve3) {
    super();
    (this as { type: string }).type = "CurveView3";
    this.arcLengthDivisions = base.arcLengthDivisions;
  }

  getPoint(t: number, target: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    return target.copy(this.base.getPoint(t));
  }

  toJSON(): THREE.CurveJSON & { base: unknown } {
    return { ...super.toJSON(), base: this.base.toJSON() };
  }
}

/** The curve's attributes read at new knots — what a node that rebuilds a curve hands on. */
export function resampleAttributes(
  source: Curve3,
  /** Source parameter of each new knot. */
  sourceParams: readonly number[],
  /** Where those knots sit on the new curve. */
  knots: readonly number[],
  closed: boolean,
): Record<string, CurveAttributeTrack> {
  const out: Record<string, CurveAttributeTrack> = {};
  for (const [name, track] of Object.entries(getCurveAttributes(source))) {
    out[name] = { knots: [...knots], values: sourceParams.map((t) => sampleTrack(track, t)), closed };
  }
  return out;
}

/** A short fingerprint of a curve's attributes, for rebuild signatures. */
export function curveAttributesSignature(curve: Curve3 | null | undefined): string {
  const attrs = getCurveAttributes(curve);
  const names = Object.keys(attrs).sort();
  if (names.length === 0) return "";
  let h = 0x811c9dc5;
  const mix = (n: number) => {
    h ^= Math.round(n * 1e5) | 0;
    h = Math.imul(h, 0x01000193);
  };
  for (const name of names) {
    for (let i = 0; i < name.length; i++) mix(name.charCodeAt(i));
    const tr = attrs[name];
    mix(tr.closed ? 1 : 0);
    tr.knots.forEach((k, i) => {
      mix(k);
      mix(tr.values[i]);
    });
  }
  return `${names.join(",")}:${(h >>> 0).toString(36)}`;
}
