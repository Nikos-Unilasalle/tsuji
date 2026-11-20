import * as THREE from "three";
import type { P2 } from "../voronoi2d";
import { pointInPolygon } from "../voronoi2d";

/**
 * Helpers shared by the plane-tessellation nodes (Voronoi 2D, Poisson Disk 2D,
 * Height from Lines): which plane they work in, and reading curves / point
 * lists off a socket.
 */

export const PLANES = ["XY", "XZ", "YZ"] as const;
export type Plane = (typeof PLANES)[number];

export const PLANE_FIELD = {
  id: "plane",
  label: "Plane (the third axis is height)",
  kind: "select" as const,
  options: [...PLANES],
  optionLabels: ["XY (height Z)", "XZ (height Y)", "YZ (height X)"],
};

export function asPlane(v: unknown): Plane {
  return (PLANES as readonly string[]).includes(String(v)) ? (v as Plane) : "XY";
}

export function to2(p: THREE.Vector3, plane: Plane): P2 {
  if (plane === "XZ") return [p.x, p.z];
  if (plane === "YZ") return [p.y, p.z];
  return [p.x, p.y];
}

export function heightOf(p: THREE.Vector3, plane: Plane): number {
  if (plane === "XZ") return p.y;
  if (plane === "YZ") return p.x;
  return p.z;
}

export function to3(p: P2, h: number, plane: Plane): THREE.Vector3 {
  if (plane === "XZ") return new THREE.Vector3(p[0], h, p[1]);
  if (plane === "YZ") return new THREE.Vector3(h, p[0], p[1]);
  return new THREE.Vector3(p[0], p[1], h);
}

export function axisIndex(plane: Plane): 0 | 1 | 2 {
  return plane === "XZ" ? 1 : plane === "YZ" ? 0 : 2;
}

export function asVec(v: unknown): THREE.Vector3 | null {
  if (v instanceof THREE.Vector3) return v;
  if (v && typeof v === "object" && "x" in v && "y" in v) {
    const o = v as { x: unknown; y: unknown; z?: unknown };
    const x = Number(o.x);
    const y = Number(o.y);
    const z = Number(o.z ?? 0);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) return new THREE.Vector3(x, y, z);
  }
  return null;
}

export function isCurve(v: unknown): v is THREE.Curve<THREE.Vector3> {
  return v instanceof THREE.Curve;
}

/** A closed outline sampled off a curve, without the repeated end point a closed curve returns. */
export function sampleOutline(curve: unknown, samples: number): THREE.Vector3[] {
  if (!isCurve(curve)) return [];
  const pts = curve.getSpacedPoints(Math.max(8, Math.round(samples)));
  if (pts.length > 2 && pts[0].distanceToSquared(pts[pts.length - 1]) < 1e-12) pts.pop();
  return pts;
}

/** Polylines from a list holding curves, point lists, or one flat point list. */
export function readPolylines(value: unknown, curveSamples: number): THREE.Vector3[][] {
  if (isCurve(value)) return [value.getSpacedPoints(Math.max(2, curveSamples))];
  if (!Array.isArray(value)) return [];
  if (value.length > 0 && asVec(value[0])) {
    const pts = value.map(asVec).filter((p): p is THREE.Vector3 => p !== null);
    return pts.length >= 2 ? [pts] : [];
  }
  const out: THREE.Vector3[][] = [];
  for (const item of value) {
    if (isCurve(item)) out.push(item.getSpacedPoints(Math.max(2, curveSamples)));
    else if (Array.isArray(item)) {
      const pts = item.map(asVec).filter((p): p is THREE.Vector3 => p !== null);
      if (pts.length >= 2) out.push(pts);
    }
  }
  return out;
}

/** The pieces of a polyline inside a closed polygon, cut exactly at the outline; heights interpolate along. */
export function clipPolylineToOutline(line: THREE.Vector3[], outline: P2[], plane: Plane): THREE.Vector3[][] {
  const pieces: THREE.Vector3[][] = [];
  if (line.length === 0 || outline.length < 3) return pieces;
  let inside = pointInPolygon(to2(line[0], plane), outline);
  let current: THREE.Vector3[] = inside ? [line[0]] : [];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const p = line[i];
    const a2 = to2(a, plane);
    const b2 = to2(p, plane);
    const ts: number[] = [];
    for (let k = 0; k < outline.length; k++) {
      const c = outline[k];
      const d = outline[(k + 1) % outline.length];
      const den = (b2[0] - a2[0]) * (d[1] - c[1]) - (b2[1] - a2[1]) * (d[0] - c[0]);
      if (Math.abs(den) < 1e-15) continue;
      const t = ((c[0] - a2[0]) * (d[1] - c[1]) - (c[1] - a2[1]) * (d[0] - c[0])) / den;
      const u = ((c[0] - a2[0]) * (b2[1] - a2[1]) - (c[1] - a2[1]) * (b2[0] - a2[0])) / den;
      if (t > 0 && t <= 1 && u >= 0 && u < 1) ts.push(t);
    }
    ts.sort((x, y) => x - y);
    for (const t of ts) {
      const q = a.clone().lerp(p, t);
      if (inside) {
        current.push(q);
        if (current.length >= 2) pieces.push(current);
        current = [];
      } else current = [q];
      inside = !inside;
    }
    if (inside && current[current.length - 1] !== p && (current.length === 0 || current[current.length - 1].distanceToSquared(p) > 1e-18)) current.push(p);
  }
  if (inside && current.length >= 2) pieces.push(current);
  return pieces;
}

/** A cheap order-sensitive hash over numbers, for rebuild signatures of large point sets. */
export function hashNumbers(values: Iterable<number>, seed = 2166136261): number {
  let h = seed >>> 0;
  const buf = new Float64Array(1);
  const words = new Uint32Array(buf.buffer);
  for (const v of values) {
    buf[0] = v;
    h = Math.imul(h ^ words[0], 16777619) >>> 0;
    h = Math.imul(h ^ words[1], 16777619) >>> 0;
  }
  return h;
}

export function* vectorNumbers(lists: THREE.Vector3[][]): Generator<number> {
  for (const l of lists) {
    yield l.length;
    for (const p of l) {
      yield p.x;
      yield p.y;
      yield p.z;
    }
  }
}

/**
 * An affine squeeze along a direction, for anisotropic layouts: `fwd` divides
 * the component along `angleDeg` by `stretch`, `inv` undoes it. Laying points
 * out evenly in the squeezed space and mapping them back stretches every gap,
 * and every Voronoi cell, `stretch` times along that direction.
 */
export function makeStretch(stretch: number, angleDeg: number): { fwd: (p: P2) => P2; inv: (p: P2) => P2; identity: boolean } {
  const k = Number.isFinite(stretch) && stretch > 0 ? stretch : 1;
  const a = ((Number.isFinite(angleDeg) ? angleDeg : 0) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return {
    identity: Math.abs(k - 1) < 1e-9,
    fwd: ([x, y]) => {
      const u = (x * c + y * s) / k;
      const v = -x * s + y * c;
      return [u * c - v * s, u * s + v * c];
    },
    inv: ([x, y]) => {
      const u = (x * c + y * s) * k;
      const v = -x * s + y * c;
      return [u * c - v * s, u * s + v * c];
    },
  };
}

export const STRETCH_FIELDS = [
  { id: "stretch", label: "Stretch (cell elongation)", kind: "number" as const, step: 0.25 },
  { id: "stretchAngle", label: "Stretch Direction (° in the plane)", kind: "number" as const, step: 5 },
  { id: "stretchFollow", label: "Stretch Follows Guides (direction field)", kind: "boolean" as const },
];

export const GUIDES_INPUT = { id: "guides", label: "Direction Guides (curves / point lists)", type: "list" as const };
