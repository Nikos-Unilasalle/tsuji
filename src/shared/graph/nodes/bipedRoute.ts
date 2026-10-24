import * as THREE from "three";
import { createNodeCache } from "../nodeCaches";
import { asVector3 } from "./transform";
import type { HumanSkeleton } from "../ik/skeletons";
import { blendPose, POSE_PRESETS, POSE_REGIONS, type PosePresetKey } from "../ik/humanPose";
import { DEFAULT_ROUTE, planRoute, projectOnRoute, routeMatrix, type RouteMark, type RoutePlan } from "../ik/route";

/**
 * Biped Motion's Route locomotion: the plan (see route.ts) cached per node,
 * the body it gives at a time, the pose held at a stop, and the route's
 * handles and guides in the viewport.
 *
 * The route lives in the node's own space — its transform places it — while
 * the handles are drawn in the walking body's space, so they are carried
 * across between the two.
 */

export const ROUTE_COLORS = { point: 0xe2e8f0, walk: 0x22c55e, run: 0xef4444, stop: 0xf8fafc, pose: 0xa78bfa, path: 0x38bdf8, done: 0x0369a1 } as const;

export function readRoutePoints(value: unknown): THREE.Vector3[] {
  const list = Array.isArray(value) ? value.map((p) => asVector3(p, new THREE.Vector3())) : [];
  return list.length >= 2 ? list : DEFAULT_ROUTE.map((p) => p.clone());
}

const plans = createNodeCache<{ key: string; plan: RoutePlan | null }>();

/** The node's route plan; speeds in the route's units per second. */
export function routePlanFor(nodeId: string, points: THREE.Vector3[], marks: RouteMark[], walk: number, run: number): RoutePlan | null {
  const key = JSON.stringify([points.map((p) => [p.x, p.z]), marks, walk, run]);
  const cached = plans.get(nodeId);
  if (cached && cached.key === key) return cached.plan;
  const plan = planRoute(points, marks, { walk, run });
  plans.set(nodeId, { key, plan });
  return plan;
}

/** The body on the route at `time`: its matrix in the node's space, its speed and turn rate. */
export function routeBodyAt(plan: RoutePlan, time: number) {
  const sample = plan.sample(time);
  const h = 1 / 60;
  const a = plan.sample(Math.max(0, time - h)).heading;
  const b = plan.sample(time + h).heading;
  let turn = Math.atan2(b.x, b.z) - Math.atan2(a.x, a.z);
  while (turn > Math.PI) turn -= 2 * Math.PI;
  while (turn < -Math.PI) turn += 2 * Math.PI;
  return { sample, matrix: routeMatrix(sample), yawRate: turn / (time > h ? 2 * h : h + Math.min(time, h)) };
}

const presetPoses = createNodeCache<Map<string, THREE.Vector3[]>>();

/**
 * The walk with the pose of the stop being held laid over it, by the stop's
 * eased weight: its preset, or the pose wired into the node. Upper body only
 * unless the stop says whole body — the planted feet stay put.
 */
export function holdRoutePose(
  nodeId: string,
  skeleton: HumanSkeleton,
  skeletonKey: string,
  walk: { controls: THREE.Vector3[]; pelvisRotation: THREE.Quaternion },
  wired: { controls: THREE.Vector3[]; pelvisRotation: THREE.Quaternion } | null,
  /** The poses wired into the node's Pose 1, Pose 2… inputs: a stop's "input:N". */
  inputs: ({ controls: THREE.Vector3[]; pelvisRotation: THREE.Quaternion } | null)[],
  mark: RouteMark | undefined,
  weight: number,
) {
  if (!mark?.pose || weight <= 0) return walk;
  let target: { controls: THREE.Vector3[]; pelvisRotation: THREE.Quaternion } | null = null;
  if (mark.pose === "wired") target = wired;
  else if (mark.pose.startsWith("input:")) target = inputs[Number(mark.pose.slice(6))] ?? null;
  else if (mark.pose in POSE_PRESETS) {
    let cache = presetPoses.get(nodeId);
    if (!cache) {
      cache = new Map();
      presetPoses.set(nodeId, cache);
    }
    const key = `${skeletonKey}|${mark.pose}`;
    let controls = cache.get(key);
    if (!controls) {
      controls = POSE_PRESETS[mark.pose as PosePresetKey].build(skeleton);
      cache.set(key, controls);
    }
    target = { controls, pelvisRotation: new THREE.Quaternion() };
  }
  if (!target) return walk;
  const legs = POSE_REGIONS.legs as readonly number[];
  return blendPose(walk, target, (i) => (legs.includes(i) && !mark.whole ? 0 : weight), mark.whole ? weight : 0);
}

// ---------------------------------------------------------------------------
// Handles and guides

export interface RouteHandleContext {
  points: THREE.Vector3[];
  marks: RouteMark[];
  plan: RoutePlan | null;
  /** Node space → the drawn body's space, and back. */
  toDisplay: THREE.Matrix4;
  fromDisplay: THREE.Matrix4;
  handles: THREE.Vector3[];
}

const markColor = (m: RouteMark) => (m.kind === "run" ? ROUTE_COLORS.run : m.kind === "walk" ? ROUTE_COLORS.walk : m.pose ? ROUTE_COLORS.pose : ROUTE_COLORS.stop);

export function routeHandleContext(points: THREE.Vector3[], marks: RouteMark[], plan: RoutePlan | null, base: THREE.Matrix4, display: THREE.Matrix4): RouteHandleContext {
  const toDisplay = display.clone().invert().multiply(base);
  const fromDisplay = toDisplay.clone().invert();
  const handles = [
    ...points.map((p) => new THREE.Vector3(p.x, 0, p.z).applyMatrix4(toDisplay)),
    ...marks.map((m) => (plan ? plan.curve.at(m.at * plan.curve.length).position : new THREE.Vector3()).applyMatrix4(toDisplay)),
  ];
  return { points, marks, plan, toDisplay, fromDisplay, handles };
}

/** Params for route handle `index` dropped at `position` (in the drawn body's space). */
export function routeHandlePatch(c: RouteHandleContext, index: number, position: THREE.Vector3): Record<string, unknown> | null {
  const p = position.clone().applyMatrix4(c.fromDisplay);
  p.y = 0;
  if (index < c.points.length) {
    const route = c.points.map((q) => q.clone());
    route[index] = p;
    return { route };
  }
  const k = index - c.points.length;
  if (!c.plan || k < 0 || k >= c.marks.length) return null;
  const marks = c.marks.map((m) => ({ ...m }));
  marks[k].at = Math.round(projectOnRoute(c.plan.curve, p) * 10000) / 10000;
  return { routeMarks: marks };
}

/** The route drawn on the ground (walked part darker), ticks at the marks, and the handle balls. */
export function routeGuides(c: RouteHandleContext, walkedS: number) {
  const paths: { points: THREE.Vector3[]; color: number }[] = [];
  const knobs: { at: THREE.Vector3; color: number }[] = [];
  if (c.plan) {
    const { curve } = c.plan;
    const n = Math.max(16, Math.min(600, Math.ceil(curve.length / 0.1)));
    const lift = new THREE.Vector3(0, 0.01, 0);
    const walked: THREE.Vector3[] = [];
    const ahead: THREE.Vector3[] = [];
    for (let k = 0; k <= n; k++) {
      const s = (k / n) * curve.length;
      const at = curve.at(s).position.add(lift).applyMatrix4(c.toDisplay);
      (s <= walkedS ? walked : ahead).push(at);
      if (s <= walkedS && k < n && ((k + 1) / n) * curve.length > walkedS) ahead.push(at);
    }
    if (walked.length > 1) paths.push({ points: walked, color: ROUTE_COLORS.done });
    if (ahead.length > 1) paths.push({ points: ahead, color: ROUTE_COLORS.path });
    for (const m of c.marks) {
      const at = curve.at(m.at * curve.length).position;
      paths.push({ points: [at.clone().applyMatrix4(c.toDisplay), at.clone().add(new THREE.Vector3(0, 0.35, 0)).applyMatrix4(c.toDisplay)], color: markColor(m) });
    }
  }
  c.points.forEach((_, i) => knobs.push({ at: c.handles[i], color: ROUTE_COLORS.point }));
  c.marks.forEach((m, k) => knobs.push({ at: c.handles[c.points.length + k], color: markColor(m) }));
  return { paths, knobs };
}
