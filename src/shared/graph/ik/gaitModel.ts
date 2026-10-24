import type { HumanSkeleton } from "./skeletons";
import { boneLengths } from "./fabrik";

/**
 * The biped gait as equations: what a human of these proportions does at this
 * speed. Everything a Biped Motion draws comes out of `solveGait` — stride,
 * cadence, how long each foot stays down, how high it lifts, how the pelvis
 * rises, sways, turns and drops, how far the arms swing — and every one of
 * those is the physical value times a style multiplier, so a style of all 1s
 * is the natural walk (or run) of *this* skeleton, auto-tuned from its
 * proportions, and the user only ever says "more" or "less" than natural.
 *
 * The laws, all in SI units with g = 9.81:
 *
 * - **Froude number** Fr = v² / (g·h), h the hip height. Dynamically similar
 *   walkers (a child, an adult, a giant) move alike at the same Fr; people
 *   break into a run near Fr ≈ 0.5 (Alexander 1989).
 * - **Stride** λ = 2.3·h·Fr^0.3 (Alexander 1976, "relative stride"), the
 *   same law for walk and run. Cadence follows: f = v / λ strides per second.
 * - **Duty factor** β, the share of the stride a foot is on the ground:
 *   ≈ 0.66 for a slow walk down to 0.6 for a brisk one (double support
 *   is β − 0.5), under 0.5 in a run (≈ 0.42 jogging to 0.34 sprinting) —
 *   which is what leaves both feet in the air.
 * - **Vertical bob**, walking, is the inverted pendulum: the hip vaults over
 *   the stance leg, rising L·(1 − cos θ) with sin θ = step / 2L, about two
 *   thirds of which survives the knee's flexion (Saunders' determinants).
 *   Running it is a spring: lowest at mid-stance, the flight's parabola
 *   g·t²/8 on top of the leg's compression.
 * - **Lateral sway** is the linear inverted pendulum: over a step of Ts
 *   seconds and width w the pelvis swings w/2·(1 − 1/cosh(ω₀·Ts/2)),
 *   ω₀ = √(g/h) — about 2 cm for an adult walk, less the faster the steps.
 * - **Lean** into acceleration atan(a/g), and into a turn atan(v·ω/g).
 */

export const GRAVITY = 9.81;
const DEG = Math.PI / 180;

/** What the skeleton's proportions say about how it walks. Skeleton units (metres at scale 1). */
export interface BodyMetrics {
  height: number;
  /** Hip joint above the ground at rest: the h of the Froude number and the stride law. */
  hipHeight: number;
  /** Thigh + shin. */
  legLength: number;
  /** Between the two hip joints. */
  hipWidth: number;
  /** Shoulder to wrist. */
  armLength: number;
  upperArm: number;
  /** Not modelled by the skeleton (it ends at the ankle): the anthropometric 0.15 of the height. */
  footLength: number;
  /** Pelvis to head, the lever a lean turns. */
  trunkLength: number;
}

export function bodyMetrics(skeleton: HumanSkeleton): BodyMetrics {
  const { rig, joint } = skeleton;
  const rest = rig.rest;
  const lengths = boneLengths(rig);
  const height = Math.max(0.05, skeleton.restControls[1].y);
  const elbowL = joint.elbow[0];
  const legLength = lengths[joint.knee[0]] + lengths[joint.foot[0]];
  return {
    height,
    hipHeight: Math.max(0.02, rest[joint.hip[0]].y),
    legLength: Math.max(0.02, legLength),
    hipWidth: Math.abs(rest[joint.hip[0]].x - rest[joint.hip[1]].x),
    armLength: lengths[elbowL] + lengths[joint.hand[0]],
    upperArm: lengths[elbowL],
    footLength: 0.15 * height,
    trunkLength: Math.max(0.02, rest[joint.head].y - rest[joint.pelvis].y),
  };
}

/**
 * How this walker differs from a natural one. Every "×" is a multiplier on the
 * physical value (1 = natural); the rest are offsets from natural (0).
 */
export interface GaitStyle {
  /** Stride × the stride law. Longer strides at the same speed mean a slower cadence. */
  stride: number;
  /** Added to the duty factor: + keeps the feet down longer (a careful, gliding walk), − bouncier. */
  contact: number;
  /** Step width ×: 0 puts the feet on one line (a catwalk), below 0 crosses them. */
  stepWidth: number;
  /** Foot clearance × — how high the ankle lifts mid-swing. */
  clearance: number;
  /** Where in the swing the foot is highest, 0..1 (0.4: early, as the knee folds). */
  swingPeak: number;
  /** Heel lift at push-off ×: high is a tiptoe, 0 a flat-footed shuffle. */
  heelLift: number;
  /** Knees turned out, degrees (− in). */
  kneeOut: number;
  /** Pelvis lowered by this share of the hip height: a sneak, a Groucho walk. */
  crouch: number;
  /** Vertical bob ×. */
  bob: number;
  /** Lateral sway ×. */
  sway: number;
  /** Pelvic rotation × (turning about the vertical with each stride). */
  pelvisTurn: number;
  /** Pelvic list × (the swing side's hip dropping). */
  pelvisDrop: number;
  /** Trunk leaned forward by this many degrees (− back) on top of the physical lean. */
  lean: number;
  /** Physical lean × — into acceleration, into turns, a runner's forward pitch. */
  leanResponse: number;
  /** Share of the bob the head cancels, 0..1. */
  headStabilize: number;
  /** Arm swing ×. */
  armSwing: number;
  /** Elbows bent further, 0..1 of the way to 90° more. */
  armBend: number;
  /** Arms held forward, degrees from hanging (a zombie's 80). */
  armForward: number;
  /** Arms held out from the body, degrees. */
  armSpread: number;
  /** Limp, 0..1: the right foot's stance shortened, the body dipping onto the left. */
  limp: number;
}

export const NATURAL_STYLE: GaitStyle = {
  stride: 1,
  contact: 0,
  stepWidth: 1,
  clearance: 1,
  swingPeak: 0.4,
  heelLift: 1,
  kneeOut: 0,
  crouch: 0,
  bob: 1,
  sway: 1,
  pelvisTurn: 1,
  pelvisDrop: 1,
  lean: 0,
  leanResponse: 1,
  headStabilize: 0.5,
  armSwing: 1,
  armBend: 0,
  armForward: 0,
  armSpread: 0,
  limp: 0,
};

/** Everything the walk does at one speed, in skeleton units, seconds and radians. */
export interface GaitSolution {
  speed: number;
  froude: number;
  /** 0 walking, 1 running, in between while changing over. */
  runBlend: number;
  /** One full cycle, left foot down to left foot down again. */
  stride: number;
  stepLength: number;
  /** Strides per second. */
  frequency: number;
  /** Steps per minute, the number a coach counts. */
  cadence: number;
  duty: number;
  stanceTime: number;
  swingTime: number;
  /** Both feet in the air, each step (0 for a walk). */
  flightTime: number;
  /** Double support each step (0 for a run). */
  doubleSupport: number;
  /** Between the two feet's lines, while moving at this speed. */
  stepWidth: number;
  clearance: number;
  heelLift: number;
  swingPeak: number;
  /** Peak to peak. */
  bob: number;
  /** Out to one side. */
  sway: number;
  pelvisYaw: number;
  pelvisRoll: number;
  /** Trunk pitch forward, from speed and style (the acceleration lean is added live). */
  lean: number;
  /** Shoulder swing each way. */
  armAngle: number;
  elbowFlex: number;
  crouch: number;
  /** Below this the walker stops and settles rather than walks. */
  stopSpeed: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const finite = (x: number, fallback: number) => (Number.isFinite(x) ? x : fallback);

/** Speed at Froude number `fr` for this body. */
export function speedAtFroude(metrics: BodyMetrics, fr: number): number {
  return Math.sqrt(Math.max(0, fr) * GRAVITY * metrics.hipHeight);
}

/** The speed a walker of these proportions picks when nobody hurries it (Fr ≈ 0.18, 1.3 m/s for an adult). */
export function preferredSpeed(metrics: BodyMetrics): number {
  return speedAtFroude(metrics, 0.18);
}

/**
 * Walk or run, with hysteresis so a speed sitting on the line does not
 * flicker between them: `wasRunning` keeps the current one until Fr is
 * 0.06 past the transition.
 */
export function wantsToRun(froude: number, transition: number, wasRunning: boolean): boolean {
  return wasRunning ? froude > transition - 0.06 : froude > transition + 0.06;
}

/**
 * The gait at `speed` (skeleton units per second, any direction) for a body
 * and style, `runBlend` saying how far into a run it is (the caller eases it).
 * `units` is metres per skeleton unit, so a scaled-down skeleton is still
 * judged by real gravity.
 */
export function solveGait(metrics: BodyMetrics, style: GaitStyle, speed: number, runBlend: number, units = 1): GaitSolution {
  const h = metrics.hipHeight;
  const g = GRAVITY / Math.max(1e-6, units);
  const v = Math.abs(finite(speed, 0));
  const run = clamp(finite(runBlend, 0), 0, 1);
  const froude = (v * v) / (g * h);
  const omega0 = Math.sqrt(g / h);

  // Stride law, floored so a crawl still has a step, capped by what a leg reaches.
  const natural = 2.3 * h * Math.pow(Math.max(froude, 0.004), 0.3);
  const stride = clamp(natural * clamp(finite(style.stride, 1), 0.2, 3), 0.1 * h, lerp(2.3, 3.6, run) * h);
  const frequency = v / stride;
  const period = frequency > 1e-6 ? 1 / frequency : Infinity;

  const dutyWalk = 0.66 - 0.06 * Math.min(froude / 0.5, 1.5);
  const dutyRun = 0.42 - 0.08 * clamp((froude - 0.5) / 2, 0, 1);
  const duty = clamp(lerp(dutyWalk, dutyRun, run) + finite(style.contact, 0), 0.22, 0.85);
  const stepTime = period / 2;
  const stanceTime = duty * period;
  const swingTime = (1 - duty) * period;
  const stepLength = stride / 2;

  // Narrower as the walk quickens (the feet converge under the body), narrower still running.
  const moving = clamp(froude / 0.12, 0, 1);
  const widthShare = lerp(1, lerp(0.55, 0.3, run), moving * moving * (3 - 2 * moving));
  const stepWidth = metrics.hipWidth * widthShare * finite(style.stepWidth, 1);

  // A foot lifts properly from the first slow step, or a crawl would slide its feet.
  const stepping = clamp(froude / 0.01, 0, 1);
  const clearance =
    h * lerp(0.07 + 0.12 * Math.min(froude, 0.6), 0.16 + 0.06 * clamp(froude - 0.5, 0, 2), run) * stepping * clamp(finite(style.clearance, 1), 0, 5);
  const heelLift = metrics.footLength * Math.sin((15 + 20 * Math.min(froude, 1)) * DEG) * stepping * clamp(finite(style.heelLift, 1), 0, 5);

  const halfAngle = Math.asin(clamp(stepLength / (2 * metrics.legLength), 0, 0.95));
  const pendulum = 0.65 * metrics.legLength * (1 - Math.cos(halfAngle));
  const flight = Math.max(0, 0.5 - duty) * (Number.isFinite(period) ? period : 0);
  const spring = (g * flight * flight) / 8 + 0.07 * h * Math.min(1, froude);
  const bob = lerp(pendulum, spring, run) * clamp(finite(style.bob, 1), 0, 6);

  const lipm = Number.isFinite(stepTime) ? 1 - 1 / Math.cosh((omega0 * stepTime) / 2) : 1;
  const sway = (Math.abs(stepWidth) / 2) * lipm * moving * clamp(finite(style.sway, 1), 0, 8);

  const pelvisYaw = (3 + 5 * Math.min(froude / 0.5, 1.5)) * DEG * moving * clamp(finite(style.pelvisTurn, 1), 0, 6);
  const pelvisRoll = lerp(5, 3, run) * DEG * moving * clamp(finite(style.pelvisDrop, 1), 0, 6);
  const leanResponse = clamp(finite(style.leanResponse, 1), 0, 4);
  const lean = (finite(style.lean, 0) + leanResponse * (2 * Math.min(froude, 1) + run * (4 + 2 * clamp(froude - 0.5, 0, 2)))) * DEG;

  const armAngle = lerp(6 + 22 * Math.min(froude / 0.5, 1.4), 30 + 8 * clamp(froude - 0.5, 0, 2), run) * DEG * moving * clamp(finite(style.armSwing, 1), 0, 4);
  const elbowFlex = (lerp(15 + 10 * Math.min(froude, 1), 85, run) + 90 * clamp(finite(style.armBend, 0), 0, 1)) * DEG;

  return {
    speed: v,
    froude,
    runBlend: run,
    stride,
    stepLength,
    frequency,
    cadence: frequency * 120,
    duty,
    stanceTime,
    swingTime,
    flightTime: flight,
    doubleSupport: Math.max(0, duty - 0.5) * (Number.isFinite(period) ? period : 0),
    stepWidth,
    clearance,
    heelLift,
    swingPeak: clamp(finite(style.swingPeak, 0.4), 0.1, 0.9) - 0.1 * run,
    bob,
    sway,
    pelvisYaw,
    pelvisRoll,
    lean,
    armAngle,
    elbowFlex,
    crouch: clamp(finite(style.crouch, 0), -0.1, 0.45) * h,
    stopSpeed: 0.06 * Math.sqrt(g * h),
  };
}

/**
 * Share of the stance the foot lands ahead of the hip: a real foot strikes
 * nearer the hip than it leaves it (the foot's rocker carries the trailing
 * leg further back), and an ankle-only leg could not reach the heel-strike
 * of a symmetric one without the pelvis dropping.
 */
export const STANCE_AHEAD = 0.4;

/**
 * How far below its rest height the pelvis sits through the stride, so the
 * legs (`reach` from hip to ankle) still reach a foot striking STANCE_AHEAD
 * of the stance's travel in front and one leaving the rest of it behind —
 * the second on its raised heel. That is the knee flexion of a real stance;
 * the bob, which is lowest just there, is taken off it.
 */
export function strideSink(sol: GaitSolution, reach: number, hipAboveAnkle: number, lateral: number): number {
  const travel = sol.stride * sol.duty;
  const reachable = (ahead: number, raise: number) => {
    const flat = Math.hypot(ahead, lateral);
    return (flat >= reach ? 0 : Math.sqrt(reach * reach - flat * flat)) + raise;
  };
  const need = hipAboveAnkle - Math.min(reachable(travel * STANCE_AHEAD, 0), reachable(travel * (1 - STANCE_AHEAD), sol.heelLift));
  return Math.max(0, need - sol.bob / 2);
}

// ---------------------------------------------------------------------------
// Profiles over one cycle. `phase` is the stride's, 0..1, left foot striking at 0.

const TAU = Math.PI * 2;

/** Minimum-jerk 0 → 1: zero velocity and acceleration at both ends, how a hand (or a foot) is placed. */
export function minimumJerk(t: number): number {
  const u = clamp(t, 0, 1);
  return u * u * u * (10 - 15 * u + 6 * u * u);
}

/**
 * How far along its swing a foot is at swing progress `u`, 0 → 1. Walking it
 * leaves the ground at rest and is placed (minimum jerk). Running it is
 * already chasing the hip as the toe leaves — its world speed then is the
 * body's, a start slope of (1 − duty) in these units — or a leg left that
 * far behind could not fold its heel up under the buttock.
 */
export function swingAlong(u: number, runBlend: number, duty: number): number {
  const t = clamp(u, 0, 1);
  const start = clamp(runBlend, 0, 1) * (1 - duty);
  const hermite = start * (t - 2 * t * t + t * t * t) + t * t * (3 - 2 * t);
  return lerp(minimumJerk(t), hermite, clamp(runBlend, 0, 1));
}

/** Height of a swinging foot at swing progress `u`, peaking at `peak`, 0 at both ends. */
export function swingHeight(u: number, peak: number): number {
  const t = clamp(u, 0, 1);
  const p = clamp(peak, 0.05, 0.95);
  const warped = t < p ? 0.5 * (t / p) : 0.5 + 0.5 * ((t - p) / (1 - p));
  return Math.pow(Math.sin(Math.PI * warped), 1.3);
}

/** Phase of the stride where foot `side` (0 left, 1 right) strikes the ground. */
export function strikePhase(side: 0 | 1, limp: number): number {
  return side === 0 ? 0 : 0.5 - 0.12 * clamp(limp, 0, 1);
}

/**
 * Pelvis offsets at `phase`: up (bob about its mean), out toward the left
 * (sway, +X is the character's left), and its turn (yaw) and list (roll).
 * The bob peaks at each mid-stance walking and bottoms there running.
 */
export function pelvisMotion(sol: GaitSolution, phase: number, limp = 0) {
  const midLeft = sol.duty / 2;
  const walkBob = Math.cos(2 * TAU * (phase - midLeft));
  const bobWave = lerp(walkBob, -walkBob, sol.runBlend);
  // A limp drops the body onto the sound (left) leg as the bad one comes off the ground.
  const dip = clamp(limp, 0, 1) * 0.5 * sol.bob * Math.max(0, Math.cos(TAU * (phase - (strikePhase(1, limp) + sol.duty / 2))));
  return {
    up: (sol.bob / 2) * bobWave - dip,
    side: sol.sway * Math.cos(TAU * (phase - midLeft)),
    // The left hip forward as the left foot strikes.
    yaw: -sol.pelvisYaw * Math.cos(TAU * phase),
    // The left hip lowest halfway through the left foot's swing.
    roll: -sol.pelvisRoll * Math.cos(TAU * (phase - (sol.duty + 1) / 2)),
  };
}

/** How far forward the arm on `side` swings at `phase`, −1..1: against its own leg. */
export function armWave(phase: number, side: 0 | 1): number {
  const own = side === 0 ? Math.cos(TAU * phase) : -Math.cos(TAU * phase);
  return -own;
}
