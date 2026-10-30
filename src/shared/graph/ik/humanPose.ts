import * as THREE from "three";
import type { FootRoll, HumanSkeleton } from "./skeletons";

/**
 * A human pose as the rig nodes pass it along: the ten IK controls
 * (HUMAN_CONTROLS order) in the skeleton's own space, plus how the pelvis is
 * turned. Human Skeleton, Biped Motion and Biped Pose each publish theirs on
 * their geometry's `userData.humanPose`, so they can be stacked — every one
 * blending its own pose over the one wired in, by its influence.
 */
export interface HumanPose {
  controls: THREE.Vector3[];
  pelvisRotation: THREE.Quaternion;
  /** How each foot meets the ground, where something animates it (a walk); missing, the automatic roll. */
  feet?: (FootRoll | undefined)[];
  /** Where the skeleton's space sits in the world. */
  matrix: THREE.Matrix4;
}

type PoseParts = { controls: THREE.Vector3[]; pelvisRotation: THREE.Quaternion; feet?: (FootRoll | undefined)[] };

export const CONTROL = {
  pelvis: 0,
  head: 1,
  hand: [2, 3],
  foot: [4, 5],
  elbowPole: [6, 7],
  kneePole: [8, 9],
} as const;

/** Which controls each body region of a Biped Pose blends. */
export const POSE_REGIONS = {
  body: [CONTROL.pelvis, CONTROL.head],
  arms: [...CONTROL.hand, ...CONTROL.elbowPole],
  legs: [...CONTROL.foot, ...CONTROL.kneePole],
} as const;

export function readHumanPose(source: unknown): HumanPose | null {
  if (!(source instanceof THREE.Object3D)) return null;
  const pose = source.userData.humanPose as HumanPose | undefined;
  return pose && Array.isArray(pose.controls) && pose.controls.length === 10 ? pose : null;
}

/**
 * `a` toward `b` by a weight per control (0 keeps `a`), and the pelvis turn by
 * `pelvisWeight`. Each foot's roll goes with its foot control; a pose with no
 * roll stands for the automatic one, so a walk's roll fades out as a pose
 * without one takes the feet over.
 */
export function blendPose(a: PoseParts, b: PoseParts, weight: (index: number) => number, pelvisWeight: number): PoseParts {
  const clamp = (w: number) => (Number.isFinite(w) ? Math.max(0, Math.min(1, w)) : 0);
  const feet = blendFeet(a.feet, b.feet, (s) => clamp(weight(CONTROL.foot[s])));
  return {
    controls: a.controls.map((c, i) => c.clone().lerp(b.controls[i] ?? c, clamp(weight(i)))),
    pelvisRotation: a.pelvisRotation.clone().slerp(b.pelvisRotation, clamp(pelvisWeight)),
    ...(feet ? { feet } : {}),
  };
}

/**
 * Two feet's rolls mixed, `k` of the way to `b`'s. Each is the automatic roll
 * moved toward its own by its weight, so the mix is too: the weights add up,
 * the pitches and directions average by what each brings.
 */
export function blendFeet(a: PoseParts["feet"], b: PoseParts["feet"], k: (side: 0 | 1) => number): FootRoll[] | undefined {
  if (!a?.some(Boolean) && !b?.some(Boolean)) return undefined;
  return ([0, 1] as const).map((s) => {
    const share = (roll: FootRoll | undefined, by: number) => (roll ? Math.max(0, Math.min(1, Number.isFinite(roll.weight) ? Number(roll.weight) : 1)) * by : 0);
    const fa = a?.[s];
    const fb = b?.[s];
    const wa = share(fa, 1 - k(s));
    const wb = share(fb, k(s));
    const total = wa + wb;
    if (total <= 1e-9) return { pitch: 0, weight: 0 };
    const pitch = ((fa?.pitch ?? 0) * wa + (fb?.pitch ?? 0) * wb) / total;
    const forward = new THREE.Vector3();
    if (fa?.forward) forward.addScaledVector(fa.forward, wa);
    if (fb?.forward) forward.addScaledVector(fb.forward, wb);
    const bends = [fa?.maxToeBend, fb?.maxToeBend].filter((x): x is number => Number.isFinite(x));
    return {
      pitch,
      weight: Math.min(1, total),
      ...(forward.lengthSq() > 1e-12 ? { forward: forward.normalize() } : {}),
      ...(bends.length > 0 ? { maxToeBend: Math.min(...bends) } : {}),
    };
  });
}

/**
 * Which parts of the body a pose actually carries: a weight per control, 0
 * where it is still at rest, 1 where it was moved, and the same for the pelvis
 * turn. Layered by these weights a pose with only its arms raised leaves the
 * feet to whatever moves them underneath (a dance, a walk).
 *
 * A limb counts as one: a hand moved brings its elbow pole along, a foot its
 * knee pole, or the IK would bend the limb against itself. The weight eases
 * in between `MASK_RANGE` (fractions of the body's height) rather than
 * switching, so the small drift of a wiggling pose neither pops in nor out.
 */
export interface PoseMask {
  controls: number[];
  pelvisTurn: number;
}

/** Below the first a control is at rest, beyond the second fully posed — as fractions of the body's height. */
export const MASK_RANGE = [0.01, 0.04] as const;
/** The same for the pelvis turn, in radians (~2° to ~8°). */
export const MASK_TURN_RANGE = [0.035, 0.14] as const;

const smoothstep = (lo: number, hi: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

export function poseMask(
  controls: THREE.Vector3[],
  rest: THREE.Vector3[],
  height: number,
  pelvisRotation: THREE.Quaternion = new THREE.Quaternion(),
): PoseMask {
  const H = Math.max(0.05, height);
  const moved = rest.map((r, i) => {
    const d = controls[i] ? controls[i].distanceTo(r) / H : 0;
    return Number.isFinite(d) ? smoothstep(MASK_RANGE[0], MASK_RANGE[1], d) : 0;
  });
  for (const s of [0, 1] as const) {
    for (const [end, pole] of [[CONTROL.hand[s], CONTROL.elbowPole[s]], [CONTROL.foot[s], CONTROL.kneePole[s]]]) {
      moved[end] = moved[pole] = Math.max(moved[end], moved[pole]);
    }
  }
  const angle = 2 * Math.acos(Math.min(1, Math.abs(pelvisRotation.w)));
  return { controls: moved, pelvisTurn: smoothstep(MASK_TURN_RANGE[0], MASK_TURN_RANGE[1], Number.isFinite(angle) ? angle : 0) };
}

/** Left and right swapped, as in a mirror: the whole pose flipped across the body's centre plane. */
export function flipPose(controls: THREE.Vector3[]): THREE.Vector3[] {
  const flipped = controls.map((c) => new THREE.Vector3(-c.x, c.y, c.z));
  for (const [l, r] of [CONTROL.hand, CONTROL.foot, CONTROL.elbowPole, CONTROL.kneePole]) {
    [flipped[l], flipped[r]] = [flipped[r], flipped[l]];
  }
  return flipped;
}

/** One side copied onto the other, mirrored; pelvis and head put on the centre line. */
export function mirrorPose(controls: THREE.Vector3[], from: "left" | "right"): THREE.Vector3[] {
  const out = controls.map((c) => c.clone());
  const src = from === "left" ? 0 : 1;
  for (const pair of [CONTROL.hand, CONTROL.foot, CONTROL.elbowPole, CONTROL.kneePole]) {
    const c = controls[pair[src]];
    out[pair[1 - src]] = new THREE.Vector3(-c.x, c.y, c.z);
  }
  out[CONTROL.pelvis].x = 0;
  out[CONTROL.head].x = 0;
  return out;
}

/**
 * Swinging a limb about its joint, as an animator rotates a bone: the hand and
 * its elbow pole turn about the shoulder, the foot and its knee pole about the
 * hip, the head about the neck. `joints` are the posed joint positions in the
 * same space. Returns null for a control that does not swing (the pelvis turns
 * the hips instead — see Biped Pose).
 */
export function swingControls(
  skeleton: HumanSkeleton,
  joints: THREE.Vector3[],
  controls: THREE.Vector3[],
  index: number,
  rotation: THREE.Quaternion,
): THREE.Vector3[] | null {
  const { joint, rig } = skeleton;
  const sideOf = (pair: readonly number[]): 0 | 1 | null => (pair[0] === index ? 0 : pair[1] === index ? 1 : null);
  let swing: { pivot: THREE.Vector3; moved: number[] } | null = null;
  const arm = sideOf(CONTROL.hand) ?? sideOf(CONTROL.elbowPole);
  const leg = sideOf(CONTROL.foot) ?? sideOf(CONTROL.kneePole);
  if (arm !== null) swing = { pivot: joints[rig.joints[joint.elbow[arm]].parent], moved: [CONTROL.hand[arm], CONTROL.elbowPole[arm]] };
  else if (leg !== null) swing = { pivot: joints[joint.hip[leg]], moved: [CONTROL.foot[leg], CONTROL.kneePole[leg]] };
  else if (index === CONTROL.head) swing = { pivot: joints[rig.joints[joint.head].parent], moved: [CONTROL.head] };
  if (!swing || !swing.pivot) return null;
  const out = controls.map((c) => c.clone());
  for (const i of swing.moved) out[i] = controls[i].clone().sub(swing.pivot).applyQuaternion(rotation).add(swing.pivot);
  return out;
}

// ---------------------------------------------------------------------------
// Presets

export interface PosePreset {
  label: string;
  hint: string;
  build: (skeleton: HumanSkeleton) => THREE.Vector3[];
}

/** Built from the skeleton's natural stance, in fractions of its height, so they fit any proportions. */
function poseFrom(skeleton: HumanSkeleton, edit: (c: THREE.Vector3[], k: PoseKit) => void): THREE.Vector3[] {
  const c = skeleton.relaxedControls.map((v) => v.clone());
  const rest = skeleton.relaxedRest;
  const { joint, rig } = skeleton;
  const H = Math.max(0.05, c[CONTROL.head].y);
  const shoulder = [0, 1].map((s) => rest[rig.joints[joint.elbow[s]].parent].clone());
  const hip = [0, 1].map((s) => rest[joint.hip[s]].clone());
  const arm = rest[joint.elbow[0]].distanceTo(shoulder[0]) + rest[joint.hand[0]].distanceTo(rest[joint.elbow[0]]);
  edit(c, { H, shoulder, hip, arm, chestY: rest[joint.chest].y, headY: c[CONTROL.head].y, pelvisY: c[CONTROL.pelvis].y });
  return c;
}

interface PoseKit {
  H: number;
  shoulder: THREE.Vector3[];
  hip: THREE.Vector3[];
  arm: number;
  chestY: number;
  headY: number;
  pelvisY: number;
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const sideX = (s: number) => (s === 0 ? 1 : -1);

export const POSE_PRESETS = {
  stand: { label: "Stand", hint: "Natural stance, arms hanging", build: (sk) => poseFrom(sk, () => {}) },
  tPose: {
    label: "T-Pose",
    hint: "Arms straight out to the sides",
    build: (sk) =>
      poseFrom(sk, (c, k) => {
        for (const s of [0, 1]) {
          c[CONTROL.hand[s]] = k.shoulder[s].clone().add(v(sideX(s) * k.arm * 0.99, 0, 0));
          c[CONTROL.elbowPole[s]] = k.shoulder[s].clone().add(v(sideX(s) * k.arm * 0.5, 0, -0.3 * k.H));
        }
      }),
  },
  handsOnHips: {
    label: "Hands on Hips",
    hint: "Fists on the hips, elbows out",
    build: (sk) =>
      poseFrom(sk, (c, k) => {
        for (const s of [0, 1]) {
          c[CONTROL.hand[s]] = v(sideX(s) * (Math.abs(k.hip[s].x) + 0.05 * k.H), k.pelvisY + 0.05 * k.H, 0.01 * k.H);
          c[CONTROL.elbowPole[s]] = v(sideX(s) * 0.45 * k.H, k.chestY - 0.1 * k.H, -0.1 * k.H);
        }
      }),
  },
  wave: {
    label: "Wave",
    hint: "Right hand raised beside the head",
    build: (sk) =>
      poseFrom(sk, (c, k) => {
        c[CONTROL.hand[1]] = v(-(Math.abs(k.shoulder[1].x) + 0.12 * k.H), k.headY + 0.03 * k.H, 0.04 * k.H);
        c[CONTROL.elbowPole[1]] = v(-0.45 * k.H, k.chestY - 0.15 * k.H, -0.05 * k.H);
        c[CONTROL.head].x -= 0.01 * k.H;
      }),
  },
  point: {
    label: "Point",
    hint: "Left arm pointing straight ahead",
    build: (sk) =>
      poseFrom(sk, (c, k) => {
        c[CONTROL.hand[0]] = k.shoulder[0].clone().add(v(-0.03 * k.H, 0.02 * k.H, k.arm * 0.98));
        c[CONTROL.elbowPole[0]] = k.shoulder[0].clone().add(v(0.05 * k.H, -0.3 * k.H, 0.1 * k.H));
        c[CONTROL.head].z += 0.02 * k.H;
      }),
  },
  armsCrossed: {
    label: "Arms Crossed",
    hint: "Forearms folded across the chest",
    build: (sk) =>
      poseFrom(sk, (c, k) => {
        c[CONTROL.hand[0]] = v(-0.07 * k.H, k.chestY - 0.07 * k.H, 0.11 * k.H);
        c[CONTROL.hand[1]] = v(0.07 * k.H, k.chestY - 0.09 * k.H, 0.12 * k.H);
        for (const s of [0, 1]) c[CONTROL.elbowPole[s]] = v(sideX(s) * 0.3 * k.H, k.chestY - 0.2 * k.H, 0);
      }),
  },
  think: {
    label: "Think",
    hint: "Right hand to the chin, left arm under it",
    build: (sk) =>
      poseFrom(sk, (c, k) => {
        c[CONTROL.hand[1]] = v(-0.02 * k.H, k.headY - 0.1 * k.H, 0.08 * k.H);
        c[CONTROL.hand[0]] = v(-0.06 * k.H, k.chestY - 0.13 * k.H, 0.1 * k.H);
        c[CONTROL.elbowPole[1]] = v(-0.2 * k.H, k.chestY - 0.25 * k.H, 0.1 * k.H);
        c[CONTROL.elbowPole[0]] = v(0.3 * k.H, k.chestY - 0.2 * k.H, 0);
        c[CONTROL.head].z += 0.03 * k.H;
      }),
  },
  cheer: {
    label: "Cheer",
    hint: "Both arms thrown up in a V",
    build: (sk) =>
      poseFrom(sk, (c, k) => {
        for (const s of [0, 1]) {
          c[CONTROL.hand[s]] = k.shoulder[s].clone().add(v(sideX(s) * k.arm * 0.45, k.arm * 0.88, 0.02 * k.H));
          c[CONTROL.elbowPole[s]] = k.shoulder[s].clone().add(v(sideX(s) * 0.3 * k.H, 0, -0.2 * k.H));
        }
        c[CONTROL.head].z -= 0.02 * k.H;
      }),
  },
  crouch: {
    label: "Crouch",
    hint: "Knees deep, hands resting on them",
    build: (sk) =>
      poseFrom(sk, (c, k) => {
        c[CONTROL.pelvis].y -= 0.2 * k.H;
        c[CONTROL.pelvis].z -= 0.06 * k.H;
        c[CONTROL.head].y -= 0.24 * k.H;
        c[CONTROL.head].z += 0.08 * k.H;
        for (const s of [0, 1]) {
          c[CONTROL.foot[s]].x = sideX(s) * (Math.abs(k.hip[s].x) + 0.02 * k.H);
          c[CONTROL.kneePole[s]] = v(sideX(s) * 0.12 * k.H, k.pelvisY, 0.4 * k.H);
          c[CONTROL.hand[s]] = v(sideX(s) * 0.11 * k.H, k.pelvisY - 0.2 * k.H, 0.2 * k.H);
        }
      }),
  },
  lunge: {
    label: "Lunge",
    hint: "Left foot forward, weight on it",
    build: (sk) =>
      poseFrom(sk, (c, k) => {
        c[CONTROL.pelvis].y -= 0.1 * k.H;
        c[CONTROL.head].y -= 0.1 * k.H;
        c[CONTROL.head].z += 0.05 * k.H;
        c[CONTROL.foot[0]].z += 0.3 * k.H;
        c[CONTROL.foot[1]].z -= 0.25 * k.H;
        c[CONTROL.kneePole[0]].z += 0.3 * k.H;
        c[CONTROL.hand[0]].z -= 0.08 * k.H;
        c[CONTROL.hand[1]].z += 0.08 * k.H;
      }),
  },
} satisfies Record<string, PosePreset>;

export type PosePresetKey = keyof typeof POSE_PRESETS;
export const POSE_PRESET_KEYS = Object.keys(POSE_PRESETS) as PosePresetKey[];

// ---------------------------------------------------------------------------
// Editing a stored pose from the viewport

/** A pose as a node stores it: the ten controls, then (Biped Pose only) the pelvis turn as Euler angles in radians. */
export function readPoseList(list: unknown, fallback: THREE.Vector3[]): { controls: THREE.Vector3[]; turn: THREE.Vector3 } {
  const raw = Array.isArray(list) ? list : [];
  const vec = (p: unknown, f: THREE.Vector3) => {
    if (p instanceof THREE.Vector3) return p.clone();
    if (p && typeof p === "object") {
      const o = p as { x?: unknown; y?: unknown; z?: unknown };
      const n = (x: unknown, d: number) => (Number.isFinite(Number(x)) ? Number(x) : d);
      return new THREE.Vector3(n(o.x, f.x), n(o.y, f.y), n(o.z, f.z));
    }
    return f.clone();
  };
  const stored = raw.length >= 10;
  return {
    controls: fallback.map((f, i) => (stored ? vec(raw[i], f) : f.clone())),
    turn: stored && raw.length > 10 ? vec(raw[10], new THREE.Vector3()) : new THREE.Vector3(),
  };
}

export const turnQuaternion = (turn: THREE.Vector3) => new THREE.Quaternion().setFromEuler(new THREE.Euler(turn.x, turn.y, turn.z, "YXZ"));

/**
 * The pose list after handle `index` is dropped at `position` — or, when the
 * gizmo rotated it by `rotation`, after its limb swung about its joint (the
 * pelvis turns instead, when `withTurn`). `controls` / `turn` are the pose as
 * it was when the drag began, `joints` the skeleton posed there.
 */
export function editPoseList(
  skeleton: HumanSkeleton,
  joints: THREE.Vector3[],
  controls: THREE.Vector3[],
  turn: THREE.Vector3,
  index: number,
  position: THREE.Vector3,
  rotation: THREE.Quaternion | undefined,
  withTurn: boolean,
): THREE.Vector3[] {
  let next = controls.map((c) => c.clone());
  let nextTurn = turn.clone();
  if (rotation && rotation.angleTo(new THREE.Quaternion()) > 1e-6) {
    if (index === CONTROL.pelvis && withTurn) {
      const e = new THREE.Euler().setFromQuaternion(rotation.clone().multiply(turnQuaternion(turn)), "YXZ");
      nextTurn = new THREE.Vector3(e.x, e.y, e.z);
    } else {
      next = swingControls(skeleton, joints, controls, index, rotation) ?? next;
    }
  } else if (index >= 0 && index < next.length) {
    next[index] = position.clone();
  }
  return withTurn ? [...next, nextTurn] : next;
}

// ---------------------------------------------------------------------------
// Wiggle: a held pose that still lives

export interface WiggleSettings {
  /** 0 frozen, 1 natural, above that restless. */
  amount: number;
  /** × the natural rates: 0.5 calm, 2 out of breath. */
  speed: number;
  /** × the breathing on its own. */
  breathing: number;
  /** Different seeds drift out of step with each other. */
  seed: number;
}

/** A slow, never-repeating wander in −1..1: three sines at rates that share no rhythm, phased by seed and channel. */
function drift(t: number, rate: number, seed: number, channel: number): number {
  const phase = (k: number) => {
    const x = Math.sin((seed + 1) * 12.9898 + channel * 78.233 + k * 37.719) * 43758.5453;
    return (x - Math.floor(x)) * Math.PI * 2;
  };
  const tau = Math.PI * 2 * rate * t;
  return (Math.sin(tau + phase(1)) + 0.5 * Math.sin(tau * 2.17 + phase(2)) + 0.25 * Math.sin(tau * 3.71 + phase(3))) / 1.75;
}

/**
 * The pose at `time` with the small movements of a body holding still: it
 * breathes (chest, head and hands rising ~15 times a minute), shifts its
 * weight (the pelvis wandering sideways), balances its head, and its hands
 * drift. The feet and knee poles do not move — nothing slides on the ground.
 * Amplitudes are for a 1.8 m body, scaled by the skeleton's height.
 */
export function wigglePose(controls: THREE.Vector3[], height: number, time: number, w: WiggleSettings): THREE.Vector3[] {
  const amount = Number.isFinite(w.amount) ? Math.max(0, w.amount) : 0;
  if (amount <= 0) return controls.map((c) => c.clone());
  const k = (Math.max(0.05, height) / 1.8) * amount;
  const t = time * (Number.isFinite(w.speed) ? Math.max(0, w.speed) : 1);
  const seed = Number.isFinite(w.seed) ? w.seed : 0;
  const breathing = Number.isFinite(w.breathing) ? Math.max(0, w.breathing) : 1;
  const out = controls.map((c) => c.clone());

  // Breathing: a rise and fall a little uneven from one breath to the next.
  const breath = 0.01 * k * breathing * (Math.sin(Math.PI * 2 * 0.25 * t + seed) + 0.25 * drift(t, 0.07, seed, 0));
  // Weight shifting from one leg to the other, slowly; the head follows the pelvis part of the way.
  const shift = 0.015 * k * drift(t, 0.1, seed, 1);
  out[CONTROL.pelvis].x += shift;
  out[CONTROL.pelvis].y += 0.2 * breath - 0.15 * Math.abs(shift);
  out[CONTROL.head].x += 0.4 * shift + 0.008 * k * drift(t, 0.3, seed, 2);
  out[CONTROL.head].y += breath;
  out[CONTROL.head].z += 0.008 * k * drift(t, 0.27, seed, 3);
  for (const s of [0, 1] as const) {
    const hand = out[CONTROL.hand[s]];
    hand.x += 0.4 * shift + 0.012 * k * drift(t, 0.18, seed, 4 + s * 3);
    hand.y += 0.6 * breath + 0.012 * k * drift(t, 0.15, seed, 5 + s * 3);
    hand.z += 0.012 * k * drift(t, 0.21, seed, 6 + s * 3);
    out[CONTROL.elbowPole[s]].y += 0.6 * breath;
  }
  return out;
}
