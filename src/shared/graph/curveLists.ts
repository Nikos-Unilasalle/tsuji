import * as THREE from "three";
import { curveStrokeMeta, DrawingPlane, dominantPlane, planeCoords } from "../three/brushScene";

/**
 * Helpers shared by the nodes that treat curves as drawing strokes: Ridge
 * Layers, Strata Hatch, Scatter on Curves, Ink Stroke and Curve Fill.
 *
 * A "stack" is a list of curves meant to be read together — the nested
 * outlines of one mountain, say. Nodes that produce several pass a list of
 * stacks (a list of lists); every consumer also accepts a flat list or a
 * single curve, which it reads as one stack.
 */

export type Curve3 = THREE.Curve<THREE.Vector3>;

function isCurve(value: unknown): value is Curve3 {
  return value instanceof THREE.Curve;
}

export function flattenCurves(...inputs: unknown[]): Curve3[] {
  const out: Curve3[] = [];
  const visit = (value: unknown, depth: number) => {
    if (isCurve(value)) out.push(value);
    else if (Array.isArray(value) && depth < 4) for (const item of value) visit(item, depth + 1);
  };
  for (const input of inputs) visit(input, 0);
  return out;
}

export function curveStacks(input: unknown): Curve3[][] {
  if (isCurve(input)) return [[input]];
  if (!Array.isArray(input)) return [];
  if (input.some(Array.isArray)) {
    return input.map((item) => flattenCurves(item)).filter((stack) => stack.length > 0);
  }
  const flat = flattenCurves(input);
  return flat.length > 0 ? [flat] : [];
}

/** A smooth curve through `points`, whose parameter runs evenly from point to point. */
export function polylineCurve(points: THREE.Vector3[], closed = false): THREE.CatmullRomCurve3 {
  return new THREE.CatmullRomCurve3(points, closed, "catmullrom", 0.5);
}

const MIN_SAMPLES = 16;
const MAX_SAMPLES = 400;

/**
 * Points along a curve, dense enough for a stroke outline. A CatmullRom's
 * own control points already say how detailed it is; any other curve is
 * sampled by length.
 */
export function strokeSamples(curve: Curve3, spacing = 0.04): THREE.Vector3[] {
  if (curve instanceof THREE.CatmullRomCurve3) {
    const n = Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, curve.points.length * 2));
    return curve.getPoints(n - 1);
  }
  const length = curve.getLength();
  const n = Number.isFinite(length) ? Math.round(length / Math.max(1e-3, spacing)) : MIN_SAMPLES;
  return curve.getSpacedPoints(Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, n)) - 1);
}

/** FNV-1a over a few samples of every curve: equal curves give equal strings, cheaply. */
export function curvesSignature(curves: Curve3[]): string {
  let h = 0x811c9dc5;
  const mix = (n: number) => {
    h ^= Math.round(n * 1000) | 0;
    h = Math.imul(h, 0x01000193);
  };
  const probe = new THREE.Vector3();
  for (const curve of curves) {
    if (curve instanceof THREE.CatmullRomCurve3) {
      for (const p of curve.points) {
        mix(p.x);
        mix(p.y);
        mix(p.z);
      }
      mix(curve.closed ? 1 : 0);
    } else {
      for (let i = 0; i <= 8; i++) {
        curve.getPoint(i / 8, probe);
        mix(probe.x);
        mix(probe.y);
        mix(probe.z);
      }
    }
    mix(0.4242);
  }
  return `${curves.length}:${(h >>> 0).toString(16)}`;
}

export function vectorsSignature(values: unknown): string {
  if (!Array.isArray(values)) return "";
  return values
    .map((v) =>
      v instanceof THREE.Vector3
        ? `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`
        : Number.isFinite(Number(v))
          ? Number(v).toFixed(4)
          : "_",
    )
    .join(";");
}

/**
 * Drawing planes, per curve. A curve drawn on the ground (2D mode, Grease
 * Pencil on the floor, a Curve Primitive) lies in XZ; a front-view drawing in
 * XY. Nodes that build flat ink from curves work in the curve's own plane,
 * with the same orientation Brush Canvas uses (see brushScene.ts): `u` right,
 * `v` up as the plane is normally looked at, `w` towards the viewer.
 */
export function curvePlane(points: THREE.Vector3[]): DrawingPlane {
  return dominantPlane(points);
}

export function toPlane(plane: DrawingPlane, p: THREE.Vector3): [number, number, number] {
  const [u, v] = planeCoords(plane, p);
  const w = plane === "xz" ? p.y : plane === "yz" ? p.x : p.z;
  return [u, v, w];
}

export function fromPlane(plane: DrawingPlane, u: number, v: number, w: number): THREE.Vector3 {
  if (plane === "xz") return new THREE.Vector3(u, w, -v);
  if (plane === "yz") return new THREE.Vector3(w, v, -u);
  return new THREE.Vector3(u, v, w);
}

export interface PressureSamples {
  points: THREE.Vector3[];
  pressures: number[];
  length: number;
}

function pressureAt(pressures: number[] | undefined, t: number): number {
  if (!pressures || pressures.length === 0) return 1;
  const f = Math.max(0, Math.min(1, t)) * (pressures.length - 1);
  const i = Math.floor(f);
  const a = pressures[i] ?? 1;
  const b = pressures[Math.min(pressures.length - 1, i + 1)] ?? a;
  const p = a + (b - a) * (f - i);
  return Number.isFinite(p) ? p : 1;
}

/**
 * A curve sampled evenly along its length, with the pressure a drawn stroke
 * recorded at each sample. Pressures are stored per recorded point, i.e.
 * along the curve's parameter, which runs faster where the pen moved faster —
 * so each is read at the parameter its arc-length position falls on.
 */
export function samplePressure(curve: Curve3, spacing: number): PressureSamples | null {
  const length = curve.getLength();
  if (!Number.isFinite(length) || length <= 1e-6) return null;
  const count = Math.max(8, Math.min(600, Math.round(length / Math.max(1e-4, spacing))));
  const recorded = curveStrokeMeta.get(curve)?.pressures;
  const points: THREE.Vector3[] = [];
  const pressures: number[] = [];
  for (let i = 0; i <= count; i++) {
    const t = curve.getUtoTmapping(i / count, 0);
    points.push(curve.getPoint(t));
    pressures.push(pressureAt(recorded, t));
  }
  return { points, pressures, length };
}

/** Curves plus the pressures they carry beside them — both are part of what counts as "the same drawing". */
export function strokesSignature(curves: Curve3[]): string {
  return `${curvesSignature(curves)}|${curves.map((c) => (curveStrokeMeta.get(c)?.pressures ?? []).map((p) => p.toFixed(3)).join(",")).join(";")}`;
}
