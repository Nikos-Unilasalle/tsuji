import * as THREE from "three";
import type { HumanSkeleton } from "../ik/skeletons";
import { armWave, BodyMetrics, GaitSolution, GaitStyle, pelvisMotion, STANCE_AHEAD, swingAlong, swingHeight } from "../ik/gaitModel";

/**
 * Biped Motion's viewport interface: six handles, each standing where the
 * quantity it edits shows on the body, and the coloured guides that draw the
 * walk they shape — so the gait is designed by grabbing the walk itself.
 *
 * | handle | where                         | drag                                  |
 * |--------|-------------------------------|---------------------------------------|
 * | Stride | front of the left foot's loop | forward/back: stride                  |
 * | Lift   | top of the foot's swing arc   | up/down: foot lift                    |
 * | Width  | the right foot's home         | sideways: step width                  |
 * | Pelvis | corner of the pelvis's path   | sideways: sway · up/down: bob         |
 * | Head   | the head                      | forward/back: lean · up/down: crouch  |
 * | Arm    | the left hand's front swing   | swing: arm swing · in/out: elbow bend |
 *
 * All in the body's own space at a reference speed (see Biped Motion), and
 * every drag is turned back into the relative style params — a handle never
 * writes an absolute that would stop following the skeleton's proportions.
 */

export const GAIT_HANDLES = ["Stride", "Foot Lift", "Step Width", "Pelvis Sway & Bob", "Lean & Crouch", "Arm Swing & Elbow"] as const;
/** The body axes each handle's drag reads (X left, Y up, Z forward); the others would do nothing. */
export const GAIT_HANDLE_AXES: ("x" | "y" | "z")[][] = [["z"], ["y"], ["x"], ["x", "y"], ["y", "z"], ["y", "z"]];
export const GUIDE_COLORS = { foot: 0xf97316, width: 0xfacc15, pelvis: 0x22d3ee, arm: 0xf472b6, lean: 0xa78bfa } as const;
/** One per GAIT_HANDLES entry: the colour of the guide it shapes. */
export const HANDLE_COLORS = [GUIDE_COLORS.foot, GUIDE_COLORS.foot, GUIDE_COLORS.width, GUIDE_COLORS.pelvis, GUIDE_COLORS.lean, GUIDE_COLORS.arm];

/** The pelvis path is drawn this many times its real size, or a 2 cm sway would be invisible. */
const PELVIS_MAGNIFY = 4;
const DEG = Math.PI / 180;

export interface GaitHandleContext {
  handles: THREE.Vector3[];
  sol: GaitSolution;
  style: GaitStyle;
  metrics: BodyMetrics;
  /** Each edited quantity at a multiplier of 1 (or, for lean, the part physics adds). */
  auto: { stride: number; clearance: number; stepWidth: number; sway: number; bob: number; armAngle: number; physicalLean: number };
  ankleY: number;
  headRest: THREE.Vector3;
  pelvisRest: THREE.Vector3;
  shoulderRest: THREE.Vector3;
  anchor: THREE.Vector3;
}

const ratio = (value: number, multiplier: number, fallback: number) => (Math.abs(multiplier) > 0.02 ? value / multiplier : fallback);

/** A two-bone arm from `shoulder`, `alpha` forward of hanging, the elbow flexed by `flex`, held out by `abduct`. */
function armChain(metrics: BodyMetrics, shoulder: THREE.Vector3, side: number, alpha: number, flex: number, abduct: number) {
  const dir = (a: number, out: number) => new THREE.Vector3(side * Math.sin(out) * Math.cos(a), -Math.cos(out) * Math.cos(a), Math.sin(a));
  const elbow = shoulder.clone().addScaledVector(dir(alpha, abduct), metrics.upperArm);
  const hand = elbow.clone().addScaledVector(dir(alpha + flex, abduct * 0.8), metrics.armLength - metrics.upperArm);
  return { hand, elbow };
}

const restFlex = 8 * DEG;
const flexOf = (sol: GaitSolution, swing: number, motion: number) => restFlex + (sol.elbowFlex - restFlex) * motion + 0.5 * Math.max(0, swing);

/** The arm the gait swings: forward by `swing` on top of Arms Forward, elbow flexing as it comes forward. */
export function armPose(metrics: BodyMetrics, style: GaitStyle, sol: GaitSolution, shoulder: THREE.Vector3, side: number, swing: number, motion: number, extraSpread = 0) {
  const alpha = style.armForward * DEG + swing;
  const flex = flexOf(sol, swing, motion);
  return { ...armChain(metrics, shoulder, side, alpha, flex, (10 + style.armSpread) * DEG + extraSpread), alpha, flex };
}

/** The arm angle and elbow flex that put the left hand at `p` (Gauss–Newton on armChain). */
function invertArm(metrics: BodyMetrics, shoulder: THREE.Vector3, abduct: number, p: THREE.Vector3, alpha0: number, flex0: number) {
  let alpha = alpha0;
  let flex = flex0;
  const at = (a: number, f: number) => armChain(metrics, shoulder, 1, a, f, abduct).hand;
  for (let k = 0; k < 20; k++) {
    const e = p.clone().sub(at(alpha, flex));
    if (e.lengthSq() < 1e-12) break;
    const da = at(alpha + 1e-4, flex).sub(at(alpha, flex)).divideScalar(1e-4);
    const df = at(alpha, flex + 1e-4).sub(at(alpha, flex)).divideScalar(1e-4);
    // 2×2 normal equations, damped.
    const a11 = da.dot(da) + 1e-6;
    const a12 = da.dot(df);
    const a22 = df.dot(df) + 1e-6;
    const b1 = da.dot(e);
    const b2 = df.dot(e);
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-12) break;
    alpha += (a22 * b1 - a12 * b2) / det;
    flex = Math.max(0, Math.min(Math.PI * 0.95, flex + (a11 * b2 - a12 * b1) / det));
  }
  return { alpha, flex };
}

export function handleContextFor(skeleton: HumanSkeleton, metrics: BodyMetrics, style: GaitStyle, sol: GaitSolution, _unit: number): GaitHandleContext {
  const { rig, joint } = skeleton;
  const ankleY = skeleton.relaxedControls[4].y;
  const pelvisRest = skeleton.relaxedRest[joint.pelvis].clone();
  const headRest = skeleton.relaxedControls[1].clone();
  const shoulderRest = skeleton.relaxedRest[rig.joints[joint.elbow[0]].parent].clone();
  const h = metrics.hipHeight;
  const auto = {
    stride: ratio(sol.stride, style.stride, sol.stride),
    clearance: ratio(sol.clearance, style.clearance, 0.1 * h),
    stepWidth: ratio(sol.stepWidth, style.stepWidth, metrics.hipWidth * 0.55),
    sway: ratio(sol.sway, style.sway, 0.02 * h),
    bob: ratio(sol.bob, style.bob, 0.04 * h),
    armAngle: ratio(sol.armAngle, style.armSwing, 20 * DEG),
    physicalLean: sol.lean - style.lean * DEG,
  };
  const anchor = new THREE.Vector3(0, pelvisRest.y - sol.crouch, 0.45 * h);

  const travel = sol.stride * sol.duty;
  const front = travel * STANCE_AHEAD;
  const w = sol.stepWidth / 2;
  const peakZ = -(travel - front) + travel * swingAlong(sol.swingPeak, sol.runBlend, sol.duty);
  const lean = sol.lean;
  const trunk = metrics.trunkLength;
  const shoulder = shoulderRest.clone().add(new THREE.Vector3(0, -sol.crouch, 0));
  const arm = armPose(metrics, style, sol, shoulder, 1, sol.armAngle, 1);

  const handles = [
    new THREE.Vector3(w, ankleY, front),
    new THREE.Vector3(w, ankleY + sol.clearance, peakZ),
    new THREE.Vector3(-w, ankleY, 0),
    anchor.clone().add(new THREE.Vector3(sol.sway * PELVIS_MAGNIFY, (sol.bob / 2) * PELVIS_MAGNIFY, 0)),
    headRest.clone().add(new THREE.Vector3(0, -sol.crouch - trunk * (1 - Math.cos(lean)), trunk * Math.sin(lean))),
    arm.hand,
  ];
  return { handles, sol, style, metrics, auto, ankleY, headRest, pelvisRest, shoulderRest, anchor };
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const round = (x: number, step = 0.001) => Math.round(x / step) * step;

/** The params handle `index` dropped at `p` (body space) stands for. */
export function gaitHandlePatch(c: GaitHandleContext, index: number, p: THREE.Vector3, style: GaitStyle): Record<string, unknown> | null {
  const { sol, auto, metrics } = c;
  const h = metrics.hipHeight;
  switch (index) {
    case 0: {
      const stride = Math.max(0, p.z) / (STANCE_AHEAD * Math.max(0.05, sol.duty));
      return { stride: round(clamp(stride / Math.max(1e-6, auto.stride), 0.2, 3), 0.01), preset: "custom" };
    }
    case 1:
      return { clearance: round(clamp((p.y - c.ankleY) / Math.max(1e-6, auto.clearance), 0, 5), 0.01), preset: "custom" };
    case 2:
      return { stepWidth: round(clamp((-2 * p.x) / Math.max(1e-6, auto.stepWidth), -1, 4), 0.01), preset: "custom" };
    case 3: {
      const d = p.clone().sub(c.anchor).divideScalar(PELVIS_MAGNIFY);
      return {
        sway: round(clamp(d.x / Math.max(1e-6, auto.sway), 0, 8), 0.01),
        bob: round(clamp((2 * d.y) / Math.max(1e-6, auto.bob), 0, 6), 0.01),
        preset: "custom",
      };
    }
    case 4: {
      const trunk = metrics.trunkLength;
      const lean = Math.asin(clamp((p.z - c.headRest.z) / trunk, -0.9, 0.95));
      const crouch = c.headRest.y - trunk * (1 - Math.cos(lean)) - p.y;
      return {
        lean: round((lean - auto.physicalLean) / DEG, 0.5),
        crouch: round(clamp(crouch / h, -0.1, 0.45), 0.005),
        preset: "custom",
      };
    }
    case 5: {
      const shoulder = c.shoulderRest.clone().add(new THREE.Vector3(0, -sol.crouch, 0));
      const current = armPose(metrics, style, sol, shoulder, 1, sol.armAngle, 1);
      const { alpha, flex } = invertArm(metrics, shoulder, (10 + style.armSpread) * DEG, p, current.alpha, current.flex);
      const swing = alpha - style.armForward * DEG;
      const baseFlex = flexOf(sol, swing, 1) - 90 * DEG * clamp(style.armBend, 0, 1);
      return {
        armSwing: round(clamp(swing / Math.max(1e-6, auto.armAngle), 0, 4), 0.01),
        armBend: round(clamp((flex - baseFlex) / (90 * DEG), 0, 1), 0.01),
        preset: "custom",
      };
    }
    default:
      return null;
  }
}

/** The coloured guides of the walk, in the body's space. */
export function buildGaitGuides(c: GaitHandleContext, pelvis: THREE.Vector3, head: THREE.Vector3) {
  const { sol, style, metrics } = c;
  const N = 40;
  const travel = sol.stride * sol.duty;
  const front = travel * STANCE_AHEAD;
  const back = front - travel;
  const paths: { points: THREE.Vector3[]; color: number; closed?: boolean }[] = [];

  // Foot loops: the swing arc forward, the stance back along the ground with the heel coming up at the end.
  for (const side of [1, -1]) {
    const x = (side * sol.stepWidth) / 2;
    const loop: THREE.Vector3[] = [];
    for (let k = 0; k <= N; k++) {
      const u = k / N;
      const kick = 0.5 * sol.clearance * sol.runBlend * Math.sin(Math.PI * Math.min(1, u / 0.65));
      const y = Math.max(sol.clearance * swingHeight(u, sol.swingPeak), sol.heelLift * (1 - smoothstep(u / 0.3))) + kick;
      loop.push(new THREE.Vector3(x, c.ankleY + y, back + travel * swingAlong(u, sol.runBlend, sol.duty)));
    }
    for (let k = 1; k < N; k++) {
      const u = k / N;
      loop.push(new THREE.Vector3(x, c.ankleY + sol.heelLift * smoothstep((u - 0.6) / 0.4), front - travel * u));
    }
    paths.push({ points: loop, color: side > 0 ? GUIDE_COLORS.foot : 0x9a4a1a, closed: true });
  }

  paths.push({ points: [new THREE.Vector3(-sol.stepWidth / 2, c.ankleY, 0), new THREE.Vector3(sol.stepWidth / 2, c.ankleY, 0)], color: GUIDE_COLORS.width });

  // The pelvis's figure of eight, magnified, with its axes.
  const figure: THREE.Vector3[] = [];
  for (let k = 0; k < N * 2; k++) {
    const pm = pelvisMotion(sol, k / (N * 2), style.limp);
    figure.push(c.anchor.clone().add(new THREE.Vector3(pm.side * PELVIS_MAGNIFY, pm.up * PELVIS_MAGNIFY, 0)));
  }
  paths.push({ points: figure, color: GUIDE_COLORS.pelvis, closed: true });
  const span = 0.06 * metrics.hipHeight;
  paths.push({ points: [c.anchor.clone().add(new THREE.Vector3(-span, 0, 0)), c.anchor.clone().add(new THREE.Vector3(span, 0, 0))], color: 0x155e75 });
  paths.push({ points: [c.anchor.clone().add(new THREE.Vector3(0, -span, 0)), c.anchor.clone().add(new THREE.Vector3(0, span, 0))], color: 0x155e75 });

  // The left hand's arc over a stride.
  const shoulder = c.shoulderRest.clone().add(new THREE.Vector3(0, -sol.crouch, 0));
  const arc: THREE.Vector3[] = [];
  for (let k = 0; k <= N; k++) arc.push(armPose(metrics, style, sol, shoulder, 1, armWave(k / N, 0) * sol.armAngle, 1).hand);
  paths.push({ points: arc, color: GUIDE_COLORS.arm });
  paths.push({ points: [shoulder, c.handles[5]], color: GUIDE_COLORS.arm });

  // The trunk's line, and plumb from the pelvis for reference.
  paths.push({ points: [pelvis.clone(), head.clone()], color: GUIDE_COLORS.lean });
  paths.push({ points: [pelvis.clone(), pelvis.clone().add(new THREE.Vector3(0, metrics.trunkLength, 0))], color: 0x4c1d95 });
  return paths;
}

function smoothstep(t: number): number {
  const u = Math.max(0, Math.min(1, t));
  return u * u * (3 - 2 * u);
}
