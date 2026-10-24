import * as THREE from "three";

/**
 * A walker's route: a smooth path on the ground through the points the user
 * set, and marks along it — walk or run from here, stop here (and hold a
 * pose) — turned into a timetable. Where the body is at any time is a pure
 * function of the route, so the timeline can be scrubbed anywhere.
 *
 * The timing is planned, not keyed: each stretch has a target speed (the
 * walk or run its mark asks for), slowed in tight bends so the sideways
 * acceleration v²/R stays under LATERAL, and reached by accelerating and
 * braking at a human rate — speeding up from a stop, slowing into one. A stop
 * on a corner turns on the spot during its hold.
 *
 * Lengths are in the route's own units, speeds in units per second.
 */

export type RouteMarkKind = "walk" | "run" | "stop";

export interface RouteMark {
  kind: RouteMarkKind;
  /** Along the route, 0..1 of its length. */
  at: number;
  /** Walk / run: target speed, m/s (0 or missing: the node's walk speed, or the run preset's). */
  speed?: number;
  /** Stop: seconds held. */
  hold?: number;
  /** Stop: pose held — "" none, "wired" the pose wired into the node, or a pose preset key. */
  pose?: string;
  /** Stop: the pose takes the legs too (they will slide into it); otherwise only the upper body. */
  whole?: boolean;
}

/** Sideways acceleration a walker accepts in a bend, m/s². */
const LATERAL = 1.6;
const DS_TARGET = 0.02;
/** Seconds a stop's pose takes to come in, and to go again before leaving. */
export const POSE_EASE = 0.5;

export interface RouteCurve {
  length: number;
  /** Position and unit tangent at arc length `s`. */
  at(s: number): { position: THREE.Vector3; tangent: THREE.Vector3 };
}

export function buildRouteCurve(points: THREE.Vector3[]): RouteCurve | null {
  const pts = points.filter((p) => p && Number.isFinite(p.x + p.y + p.z)).map((p) => new THREE.Vector3(p.x, 0, p.z));
  const distinct = pts.filter((p, i) => i === 0 || p.distanceTo(pts[i - 1]) > 1e-6);
  if (distinct.length < 2) return null;
  const curve = new THREE.CatmullRomCurve3(distinct, false, "centripetal");
  const length = curve.getLength();
  if (!(length > 1e-6)) return null;
  return {
    length,
    at(s) {
      const u = Math.max(0, Math.min(1, s / length));
      const t = curve.getUtoTmapping(u, u * length);
      const tangent = curve.getTangent(t).setY(0);
      if (tangent.lengthSq() < 1e-12) tangent.set(0, 0, 1);
      return { position: curve.getPoint(t), tangent: tangent.normalize() };
    },
  };
}

export interface RoutePlan {
  curve: RouteCurve;
  /** Seconds from setting off to standing at the end. */
  duration: number;
  /** When each mark is reached (the order of `marks` as given), seconds. */
  markTimes: number[];
  sample(time: number): RouteSample;
}

export interface RouteSample {
  s: number;
  position: THREE.Vector3;
  /** Facing, unit, on the ground. */
  heading: THREE.Vector3;
  speed: number;
  /** The stop being held (index into the marks), or -1. */
  holding: number;
  /** 0..1: how far into the held pose, eased in after arriving and out before leaving. */
  poseWeight: number;
}

export interface RouteSpeeds {
  walk: number;
  run: number;
}

/** Accelerating and braking, units/s², for a target speed of `v` units/s: brisker the faster the gait. */
const accelFor = (v: number) => Math.min(4, 0.8 + 0.5 * v);

export function planRoute(points: THREE.Vector3[], marks: RouteMark[], speeds: RouteSpeeds): RoutePlan | null {
  const curve = buildRouteCurve(points);
  if (!curve) return null;
  const n = Math.max(2, Math.min(20000, Math.ceil(curve.length / DS_TARGET)));
  const ds = curve.length / n;
  const valid = marks.map((m, i) => ({ m, i, s: Math.max(0, Math.min(1, Number(m.at) || 0)) * curve.length })).sort((a, b) => a.s - b.s);

  // Target speed per sample: the latest walk/run mark behind it, capped in bends.
  const target = new Float64Array(n + 1);
  const stopAt = new Map<number, number>();
  let speed = speeds.walk;
  let mi = 0;
  const samples = Array.from({ length: n + 1 }, (_, k) => curve.at(k * ds));
  for (let k = 0; k <= n; k++) {
    const s = k * ds;
    while (mi < valid.length && valid[mi].s <= s + ds / 2) {
      const { m, i } = valid[mi];
      if (m.kind === "walk") speed = Number(m.speed) > 0 ? Number(m.speed) : speeds.walk;
      else if (m.kind === "run") speed = Number(m.speed) > 0 ? Number(m.speed) : speeds.run;
      else if (!stopAt.has(k)) stopAt.set(k, i);
      mi++;
    }
    let cap = speed;
    if (k > 0 && k < n) {
      const turn = samples[k - 1].tangent.angleTo(samples[k + 1].tangent);
      if (turn > 1e-6) cap = Math.min(cap, Math.sqrt(LATERAL * ((2 * ds) / turn)));
    }
    target[k] = Math.max(0, cap);
  }
  // Standing at both ends and at every stop.
  target[0] = 0;
  target[n] = 0;
  for (const k of stopAt.keys()) target[k] = 0;

  const v = Float64Array.from(target);
  for (let k = 1; k <= n; k++) v[k] = Math.min(v[k], Math.sqrt(v[k - 1] ** 2 + 2 * accelFor(target[k]) * ds));
  for (let k = n - 1; k >= 0; k--) v[k] = Math.min(v[k], Math.sqrt(v[k + 1] ** 2 + 2 * accelFor(target[k]) * ds));

  // Time at each sample; a stop's hold sits between its arrival (tIn) and departure (tOut).
  const tIn = new Float64Array(n + 1);
  const tOut = new Float64Array(n + 1);
  const markTimes = marks.map(() => 0);
  for (let k = 0; k <= n; k++) {
    if (k > 0) {
      const avg = (v[k - 1] + v[k]) / 2;
      tIn[k] = tOut[k - 1] + ds / Math.max(avg, 1e-3);
    }
    const stop = stopAt.get(k);
    tOut[k] = tIn[k] + (stop !== undefined ? Math.max(0, Number(marks[stop].hold ?? 1.5) || 0) : 0);
  }
  for (const { i, s } of valid) markTimes[i] = tIn[Math.min(n, Math.round(s / ds))];

  const headingAt = (k: number) => samples[k].tangent.clone();
  const sample = (time: number): RouteSample => {
    const t = Math.max(0, time);
    // Last sample reached by `t`.
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tIn[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    const k = lo;
    const stop = stopAt.get(k);
    if (t <= tOut[k] || k === n) {
      // Standing on sample k: at a stop, the end, or the very start.
      const holdLen = tOut[k] - tIn[k];
      const into = t - tIn[k];
      let heading = headingAt(k);
      let poseWeight = 0;
      if (stop !== undefined && holdLen > 0) {
        // A stop on a corner turns on the spot over the second half of its hold.
        const before = headingAt(Math.max(0, k - 1));
        const after = headingAt(Math.min(n, k + 1));
        const turn = smoothstep((into - holdLen / 2) / Math.max(1e-6, holdLen / 2));
        heading = slerpHeading(before, after, turn);
        if (marks[stop].pose) {
          const ease = Math.min(POSE_EASE, holdLen / 2);
          poseWeight = Math.min(smoothstep(into / ease), smoothstep((holdLen - into) / ease));
        }
      }
      return { s: k * ds, position: samples[k].position.clone(), heading, speed: 0, holding: stop ?? -1, poseWeight };
    }
    const span = Math.max(1e-9, tIn[k + 1] - tOut[k]);
    // Constant acceleration across the sample: s within it from v0 and v1.
    const u = (t - tOut[k]) / span;
    const v0 = v[k];
    const v1 = v[k + 1];
    const frac = v0 + v1 > 1e-9 ? (v0 * u + 0.5 * (v1 - v0) * u * u) / ((v0 + v1) / 2) : u;
    const s = (k + Math.max(0, Math.min(1, frac))) * ds;
    const at = curve.at(s);
    return { s, position: at.position, heading: at.tangent, speed: v0 + (v1 - v0) * u, holding: -1, poseWeight: 0 };
  };

  return { curve, duration: tOut[n], markTimes, sample };
}

function smoothstep(x: number): number {
  const u = Math.max(0, Math.min(1, x));
  return u * u * (3 - 2 * u);
}

function slerpHeading(a: THREE.Vector3, b: THREE.Vector3, t: number): THREE.Vector3 {
  const ya = Math.atan2(a.x, a.z);
  let d = Math.atan2(b.x, b.z) - ya;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const y = ya + d * t;
  return new THREE.Vector3(Math.sin(y), 0, Math.cos(y));
}

/** The body's place on the route at `time`, as a matrix in the route's space: on the curve, facing along it. */
export function routeMatrix(sample: RouteSample): THREE.Matrix4 {
  const yaw = Math.atan2(sample.heading.x, sample.heading.z);
  return new THREE.Matrix4().makeRotationY(yaw).setPosition(sample.position);
}

/** Where along the route (0..1) a point lies — the nearest point of the curve. */
export function projectOnRoute(curve: RouteCurve, point: THREE.Vector3): number {
  const n = Math.max(20, Math.min(4000, Math.ceil(curve.length / 0.05)));
  let best = 0;
  let bestD = Infinity;
  for (let k = 0; k <= n; k++) {
    const d = curve.at((k / n) * curve.length).position.distanceToSquared(new THREE.Vector3(point.x, 0, point.z));
    if (d < bestD) {
      bestD = d;
      best = k / n;
    }
  }
  return best;
}

/** A first route for a node switched to Route: an S bend, about 9 m. */
export const DEFAULT_ROUTE = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 3), new THREE.Vector3(2, 0, 6), new THREE.Vector3(2, 0, 9)];

export function readRouteMarks(value: unknown): RouteMark[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === "object")
    .map((m) => ({
      kind: m.kind === "run" || m.kind === "stop" ? m.kind : "walk",
      at: Math.max(0, Math.min(1, Number(m.at) || 0)),
      speed: Number(m.speed) || 0,
      hold: Number.isFinite(Number(m.hold)) ? Number(m.hold) : 1.5,
      pose: typeof m.pose === "string" ? m.pose : "",
      whole: Boolean(m.whole),
    }));
}
