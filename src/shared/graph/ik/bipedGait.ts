import * as THREE from "three";
import { GaitSolution, STANCE_AHEAD, stancePitch, strikePhase, swingAlong, swingHeight, swingPitch } from "./gaitModel";

/**
 * The biped's feet, driven by a stride phase rather than chased by the body.
 *
 * One clock, `phase` 0..1, runs at the cadence the gait model gives for the
 * current speed. Each foot strikes at its own point of it (left at 0, right
 * half a cycle later) and stays down for the duty factor, then swings. That
 * is what makes it a walk and not a shuffle: the double support, the flight
 * of a run and the rhythm all come out of the same two numbers the equations
 * produce, not out of thresholds.
 *
 * Where a swinging foot lands is decided all through the swing, not at
 * lift-off (Raibert's placement): under where the hip will be 40% into the
 * coming stance (STANCE_AHEAD) — the body's position then, predicted from its velocity
 * and turn rate — so speeding up, slowing down, side-stepping and turning all
 * just move the landing spot.
 *
 * Stopping: below the gait's stop speed the clock keeps going only while
 * there is something to settle — a foot in the air, or one not under its hip
 * — and a foot already there sits its turn out instead of stepping in place.
 * Once both are down and home the clock stops, in double support.
 *
 * Each foot also says how it rolls — its pitch through the stance and the
 * swing (see stancePitch) and the way it points, kept from when it landed —
 * while its position stays the ankle of a flat foot: the caller rolls it
 * (footPivot), so the heel can rise over a ball that stays put.
 *
 * World space throughout; lengths in the solution are multiplied by `unit`.
 */

export interface BipedFoot {
  planted: THREE.Vector3;
  liftOff: THREE.Vector3;
  target: THREE.Vector3;
  inSwing: boolean;
  /** This swing stays on the ground: the foot was already where it would land. */
  skip: boolean;
  /** Swing progress 0..1 while in the air, stance progress 0..1 while down. */
  progress: number;
  /** Where the foot points: the body's forward when it last landed. */
  heading: THREE.Vector3;
}

export interface BipedGaitState {
  phase: number;
  feet: [BipedFoot, BipedFoot];
  standing: boolean;
}

export interface BipedGaitFrame {
  /** Each foot's home now: under its hip, on the ground, at the current step width. */
  homes: [THREE.Vector3, THREE.Vector3];
  /** Centre the homes turn about (the body's ground point). */
  pivot: THREE.Vector3;
  up: THREE.Vector3;
  /** World units per second. */
  velocity: THREE.Vector3;
  /** Radians per second about `up`. */
  yawRate: number;
  /** The walk at this speed. */
  sol: GaitSolution;
  /** The slow walk settling steps are taken with. */
  settle: GaitSolution;
  /** World units per skeleton unit. */
  unit: number;
  legLength: number;
  limp: number;
  dt: number;
  /** The body's forward, flat on the ground: where a landing foot points. Missing, a foot keeps pointing where it did. */
  forward?: THREE.Vector3;
}

export interface BipedFootPose {
  position: THREE.Vector3;
  inSwing: boolean;
  /** As BipedFoot.progress. */
  progress: number;
  /** Where the foot is headed (or stands). */
  target: THREE.Vector3;
  /** Its roll: + heel up, − toes up (radians). */
  pitch: number;
  /** Where it points. */
  heading: THREE.Vector3;
}

export interface BipedGaitResult {
  feet: [BipedFootPose, BipedFootPose];
  /** The solution the feet actually moved by this frame (the settling one when stopping). */
  active: GaitSolution;
  standing: boolean;
}

export function createBipedGait(homes: THREE.Vector3[], forward = new THREE.Vector3(0, 0, 1)): BipedGaitState {
  const foot = (h: THREE.Vector3): BipedFoot => ({ planted: h.clone(), liftOff: h.clone(), target: h.clone(), inSwing: false, skip: false, progress: 0, heading: forward.clone() });
  // Starts in double support just after the left foot struck: both feet down.
  return { phase: 0.02, feet: [foot(homes[0]), foot(homes[1])], standing: true };
}


const frac = (x: number) => x - Math.floor(x);
const smooth = (t: number) => {
  const u = Math.max(0, Math.min(1, t));
  return u * u * (3 - 2 * u);
};

function flat(v: THREE.Vector3, up: THREE.Vector3): THREE.Vector3 {
  return v.addScaledVector(up, -v.dot(up));
}

function flatDistance(a: THREE.Vector3, b: THREE.Vector3, up: THREE.Vector3): number {
  return flat(a.clone().sub(b), up).length();
}

/** Foot `side`'s stance share of the cycle: a limp cuts the right one short. */
function dutyOf(sol: GaitSolution, side: 0 | 1, limp: number): number {
  return Math.max(0.2, sol.duty - (side === 1 ? 0.1 * Math.max(0, Math.min(1, limp)) : 0));
}

/** Where foot `side` should land to be under the hip `ahead` seconds from now (Raibert). */
function placement(frame: BipedGaitFrame, side: 0 | 1, ahead: number): THREE.Vector3 {
  const home = frame.homes[side];
  const offset = home.clone().sub(frame.pivot).applyAxisAngle(frame.up, frame.yawRate * ahead);
  const target = frame.pivot.clone().add(offset).addScaledVector(flat(frame.velocity.clone(), frame.up), ahead);
  // Never further from the hip than a leg's stride reaches.
  const reach = 0.95 * frame.legLength * frame.unit;
  const away = flat(target.clone().sub(home), frame.up);
  if (away.length() > reach) target.copy(home).add(away.setLength(reach));
  return target;
}

export function stepBipedGait(state: BipedGaitState, frame: BipedGaitFrame): BipedGaitResult {
  const { up, unit, limp } = frame;
  const dt = Math.max(0, frame.dt);
  const tol = Math.max(0.035 * frame.legLength, 0.18 * frame.sol.stepWidth) * unit;

  // Teleports (a looping timeline, a reset pose): put the feet straight home.
  frame.homes.forEach((home, s) => {
    const foot = state.feet[s];
    if (flatDistance(foot.inSwing ? foot.liftOff : foot.planted, home, up) > 3 * frame.legLength * unit) {
      foot.planted.copy(home);
      foot.liftOff.copy(home);
      foot.target.copy(home);
      foot.inSwing = false;
      if (frame.forward) foot.heading.copy(frame.forward);
    }
  });

  const turning = Math.abs(frame.yawRate) * 0.5 * frame.sol.stepWidth;
  const moving = frame.sol.speed + turning > frame.sol.stopSpeed;
  const unsettled = state.feet.some((foot, s) => foot.inSwing || flatDistance(foot.planted, frame.homes[s], up) > tol);
  const sol = moving ? frame.sol : frame.settle;
  let frequency = moving ? frame.sol.frequency : unsettled ? frame.settle.frequency : 0;
  if (moving && turning > frame.sol.speed) frequency = Math.max(frequency, frame.settle.frequency);

  // A foot about to come up but already left far behind hurries the clock along.
  const reach = 0.7 * frame.legLength * unit;
  for (const s of [0, 1] as const) {
    const foot = state.feet[s];
    if (foot.inSwing) continue;
    const behind = flatDistance(foot.planted, frame.homes[s], up);
    if (behind > reach) frequency = Math.max(frequency, frame.settle.frequency) * (1 + 2 * Math.min(2, behind / reach - 1));
  }

  state.standing = frequency === 0;
  state.phase = frac(state.phase + frequency * dt);

  const poses = ([0, 1] as const).map((s): BipedFootPose => {
    const foot = state.feet[s];
    const duty = dutyOf(sol, s, limp);
    const local = frac(state.phase - strikePhase(s, limp));
    const swinging = local >= duty;
    const period = sol.frequency > 1e-6 ? 1 / sol.frequency : 1;

    if (swinging && !foot.inSwing) {
      foot.inSwing = true;
      foot.liftOff.copy(foot.planted);
      const first = placement(frame, s, (1 - duty) * period + duty * period * STANCE_AHEAD);
      foot.skip = !moving && flatDistance(first, foot.planted, up) < tol;
    } else if (!swinging && foot.inSwing) {
      foot.inSwing = false;
      if (!foot.skip) {
        foot.planted.copy(foot.target);
        if (frame.forward) foot.heading.copy(frame.forward);
      }
    }

    if (!foot.inSwing) {
      foot.progress = local / duty;
      foot.target.copy(foot.planted);
      // Heel strike, rolled flat, then the heel up over the ball at push-off.
      return { position: foot.planted.clone(), inSwing: false, progress: foot.progress, target: foot.planted.clone(), pitch: stancePitch(sol, foot.progress), heading: foot.heading.clone() };
    }

    const u = (local - duty) / (1 - duty);
    foot.progress = u;
    if (foot.skip) {
      foot.target.copy(foot.planted);
      return { position: foot.planted.clone(), inSwing: false, progress: u, target: foot.planted.clone(), pitch: 0, heading: foot.heading.clone() };
    }
    foot.target.copy(placement(frame, s, (1 - u) * (1 - duty) * period + duty * period * STANCE_AHEAD));
    const along = swingAlong(u, sol.runBlend, duty);
    const position = foot.liftOff.clone().lerp(foot.target, along);
    // A runner's heel folds up toward the buttock as the thigh comes through, before the foot reaches forward.
    const kick = 0.5 * sol.clearance * unit * sol.runBlend * Math.sin(Math.PI * Math.min(1, u / 0.65));
    position.addScaledVector(up, sol.clearance * unit * swingHeight(u, sol.swingPeak) + kick);
    // Turning toward where it will land: the body's forward by the time it does.
    const heading = frame.forward ? foot.heading.clone().lerp(frame.forward, smooth(u / 0.6)) : foot.heading.clone();
    if (heading.lengthSq() < 1e-12) heading.copy(foot.heading);
    return { position, inSwing: true, progress: u, target: foot.target.clone(), pitch: swingPitch(sol, u), heading: heading.normalize() };
  }) as [BipedFootPose, BipedFootPose];

  return { feet: poses, active: sol, standing: state.standing };
}
