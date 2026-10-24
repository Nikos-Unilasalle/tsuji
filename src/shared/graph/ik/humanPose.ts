import * as THREE from "three";
import type { HumanSkeleton } from "./skeletons";

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
  /** Where the skeleton's space sits in the world. */
  matrix: THREE.Matrix4;
}

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

/** `a` toward `b` by a weight per control (0 keeps `a`), and the pelvis turn by `pelvisWeight`. */
export function blendPose(
  a: { controls: THREE.Vector3[]; pelvisRotation: THREE.Quaternion },
  b: { controls: THREE.Vector3[]; pelvisRotation: THREE.Quaternion },
  weight: (index: number) => number,
  pelvisWeight: number,
): { controls: THREE.Vector3[]; pelvisRotation: THREE.Quaternion } {
  const clamp = (w: number) => (Number.isFinite(w) ? Math.max(0, Math.min(1, w)) : 0);
  return {
    controls: a.controls.map((c, i) => c.clone().lerp(b.controls[i] ?? c, clamp(weight(i)))),
    pelvisRotation: a.pelvisRotation.clone().slerp(b.pelvisRotation, clamp(pelvisWeight)),
  };
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
