import * as THREE from "three";
import { IkEffector, IkJoint, IkPole, IkRig, solveFabrik } from "./fabrik";

/**
 * The two skeletons the Rig nodes build: a human and a polypede (any number
 * of leg pairs). Both live in their own space with +Y up, facing +Z, the
 * character's left on +X and the ground at y = 0 — the node's transform
 * places that space in the world.
 */

const DEG = Math.PI / 180;

export interface Skeleton {
  rig: IkRig;
  names: string[];
}

// ---------------------------------------------------------------------------
// Human

export interface HumanParams {
  height: number;
  torso: number;
  arms: number;
  legs: number;
  shoulderWidth: number;
  hipWidth: number;
  spineSegments: number;
}

export const HUMAN_DEFAULTS: HumanParams = {
  height: 1.8,
  torso: 1,
  arms: 1,
  legs: 1,
  shoulderWidth: 1,
  hipWidth: 1,
  spineSegments: 3,
};

/** The human's control points, in `pointsList` order. */
export const HUMAN_CONTROLS = [
  "Pelvis",
  "Head",
  "Left Hand",
  "Right Hand",
  "Left Foot",
  "Right Foot",
  "Left Elbow Pole",
  "Right Elbow Pole",
  "Left Knee Pole",
  "Right Knee Pole",
] as const;

export interface HumanSkeleton extends Skeleton {
  /** Joint index per role. */
  joint: {
    pelvis: number;
    chest: number;
    head: number;
    hand: [number, number];
    elbow: [number, number];
    foot: [number, number];
    knee: [number, number];
  };
  /** Control points of the rest pose, in HUMAN_CONTROLS order. */
  restControls: THREE.Vector3[];
}

/**
 * Proportions are fractions of the height (roughly anthropometric), each
 * scaled by its own multiplier. The rest pose is an A-pose with the elbows
 * bent slightly back and the knees slightly forward — toward their poles — so
 * the solver starts with a bend to work from.
 */
export function buildHumanSkeleton(input: Partial<HumanParams> = {}): HumanSkeleton {
  const p = { ...HUMAN_DEFAULTS, ...input };
  const H = Math.max(0.01, p.height);
  const segments = Math.max(1, Math.min(8, Math.round(p.spineSegments)));

  const joints: IkJoint[] = [];
  const rest: THREE.Vector3[] = [];
  const names: string[] = [];
  const add = (name: string, parent: number, at: THREE.Vector3, rigid = false) => {
    joints.push({ parent, rigid });
    rest.push(at);
    names.push(name);
    return joints.length - 1;
  };

  const ankleY = 0.04 * H;
  const thigh = 0.245 * H * p.legs;
  const shin = 0.245 * H * p.legs;
  // Knees bent forward by this much at rest, thigh and shin at the same angle,
  // so the ankle lands straight below the hip.
  const kneeBend = 6 * DEG;
  const hipY = ankleY + (thigh + shin) * Math.cos(kneeBend);
  const pelvisY = hipY + 0.03 * H;
  const spineLength = 0.26 * H * p.torso;
  const chestY = pelvisY + spineLength;

  const pelvis = add("Pelvis", -1, new THREE.Vector3(0, pelvisY, 0));
  let chest = pelvis;
  for (let i = 1; i <= segments; i++) {
    chest = add(i === segments ? "Chest" : `Spine ${i}`, chest, new THREE.Vector3(0, pelvisY + (spineLength * i) / segments, 0));
  }
  const neck = add("Neck", chest, new THREE.Vector3(0, chestY + 0.05 * H * p.torso, 0));
  const head = add("Head", neck, new THREE.Vector3(0, chestY + 0.13 * H * p.torso, 0));

  const upperArm = 0.17 * H * p.arms;
  const forearm = 0.155 * H * p.arms;
  const armAngle = 22 * DEG; // A-pose: arms this far out from hanging straight down
  const elbowBend = 12 * DEG;
  const hand: [number, number] = [0, 0];
  const elbow: [number, number] = [0, 0];
  for (const [s, side] of [[0, 1], [1, -1]] as const) {
    const label = s === 0 ? "Left" : "Right";
    const shoulderAt = new THREE.Vector3(side * 0.11 * H * p.shoulderWidth, chestY, 0);
    const shoulder = add(`${label} Shoulder`, chest, shoulderAt, true);
    const down = new THREE.Vector3(side * Math.sin(armAngle), -Math.cos(armAngle), 0);
    const elbowAt = shoulderAt.clone().addScaledVector(down, upperArm);
    // Forearm swings forward by the bend, so the elbow points back.
    const foreDir = down.clone().applyAxisAngle(down.clone().cross(new THREE.Vector3(0, 0, 1)).normalize(), elbowBend);
    elbow[s] = add(`${label} Elbow`, shoulder, elbowAt);
    hand[s] = add(`${label} Hand`, elbow[s], elbowAt.clone().addScaledVector(foreDir, forearm));
  }

  const foot: [number, number] = [0, 0];
  const knee: [number, number] = [0, 0];
  for (const [s, side] of [[0, 1], [1, -1]] as const) {
    const label = s === 0 ? "Left" : "Right";
    const hipAt = new THREE.Vector3(side * 0.09 * H * p.hipWidth, hipY, 0);
    const hip = add(`${label} Hip`, pelvis, hipAt, true);
    const kneeAt = hipAt.clone().add(new THREE.Vector3(0, -Math.cos(kneeBend) * thigh, Math.sin(kneeBend) * thigh));
    knee[s] = add(`${label} Knee`, hip, kneeAt);
    foot[s] = add(`${label} Foot`, knee[s], kneeAt.clone().add(new THREE.Vector3(0, -Math.cos(kneeBend) * shin, -Math.sin(kneeBend) * shin)));
  }

  const poleReach = 0.3 * H;
  const restControls = [
    rest[pelvis].clone(),
    rest[head].clone(),
    rest[hand[0]].clone(),
    rest[hand[1]].clone(),
    rest[foot[0]].clone(),
    rest[foot[1]].clone(),
    rest[elbow[0]].clone().add(new THREE.Vector3(0, 0, -poleReach)),
    rest[elbow[1]].clone().add(new THREE.Vector3(0, 0, -poleReach)),
    rest[knee[0]].clone().add(new THREE.Vector3(0, 0, poleReach)),
    rest[knee[1]].clone().add(new THREE.Vector3(0, 0, poleReach)),
  ];

  return {
    rig: { joints, rest },
    names,
    joint: { pelvis, chest, head, hand, elbow, foot, knee },
    restControls,
  };
}

export interface SolveOptions {
  /** How much the hands drag the chest along, against the head (weight 1). */
  armPull?: number;
  tolerance?: number;
  maxIterations?: number;
}

/**
 * Poses the human for its controls (HUMAN_CONTROLS order; missing ones fall
 * back to rest). The whole rest pose is first carried to the pelvis control,
 * which is the root and stays exactly there.
 */
export function solveHuman(skeleton: HumanSkeleton, controls: THREE.Vector3[], options: SolveOptions = {}): THREE.Vector3[] {
  const c = skeleton.restControls.map((rest, i) => controls[i] ?? rest);
  const shift = c[0].clone().sub(skeleton.rig.rest[skeleton.joint.pelvis]);
  const start = skeleton.rig.rest.map((p) => p.clone().add(shift));
  const { joint } = skeleton;
  const armPull = Math.max(0, options.armPull ?? 0.3);
  const effectors: IkEffector[] = [
    { joint: joint.head, target: c[1] },
    { joint: joint.hand[0], target: c[2], weight: armPull },
    { joint: joint.hand[1], target: c[3], weight: armPull },
    { joint: joint.foot[0], target: c[4] },
    { joint: joint.foot[1], target: c[5] },
  ];
  const poles: IkPole[] = [
    { joint: joint.elbow[0], pole: c[6] },
    { joint: joint.elbow[1], pole: c[7] },
    { joint: joint.knee[0], pole: c[8] },
    { joint: joint.knee[1], pole: c[9] },
  ];
  return solveFabrik(skeleton.rig, effectors, {
    start,
    poles,
    tolerance: options.tolerance ?? 1e-4,
    maxIterations: options.maxIterations ?? 24,
  }).positions;
}

// ---------------------------------------------------------------------------
// Polypede

export interface PolypedeParams {
  legPairs: number;
  legSegments: number;
  legLength: number;
  bodyRadius: number;
  bodyHeight: number;
  /** Horizontal distance of the resting feet from the body's centre. */
  reach: number;
  /** Arc each side's legs are spread over, in degrees (centred on the side). */
  sideArc: number;
  /** Height of the knee poles above the body. */
  kneeHeight: number;
}

export const POLYPEDE_DEFAULTS: PolypedeParams = {
  legPairs: 4,
  legSegments: 3,
  legLength: 1.5,
  bodyRadius: 0.22,
  bodyHeight: 0.45,
  reach: 1.05,
  sideArc: 130,
  kneeHeight: 0.6,
};

export interface PolypedeLeg {
  /** Joint indices from hip to foot. */
  joints: number[];
  /** Resting foot position (rig space, on the ground). */
  restFoot: THREE.Vector3;
  /** Pole for the leg's intermediate joints (rig space). */
  pole: THREE.Vector3;
  side: 1 | -1;
  /** Position along its side, 0 at the front. */
  pair: number;
}

export interface PolypedeSkeleton extends Skeleton {
  legs: PolypedeLeg[];
  bodyRadius: number;
}

/**
 * The body is joint 0, at `bodyHeight` above the origin. Each leg is a rigid
 * hip on the body's surface and `legSegments` equal bones down to a foot
 * resting on the ground at `reach` from the centre. Legs are ordered front to
 * back, left then right in each pair.
 *
 * The rest pose is itself solved: the leg starts straight out of the hip and
 * FABRIK, with the pole above, arches it onto its resting foot — which gives
 * exact bone lengths in a natural rest shape whatever the segment count.
 */
export function buildPolypedeSkeleton(input: Partial<PolypedeParams> = {}): PolypedeSkeleton {
  const p = { ...POLYPEDE_DEFAULTS, ...input };
  const pairs = Math.max(1, Math.min(16, Math.round(p.legPairs)));
  const segments = Math.max(1, Math.min(8, Math.round(p.legSegments)));
  const bodyRadius = Math.max(0, p.bodyRadius);
  const bodyHeight = Math.max(0, p.bodyHeight);
  const legLength = Math.max(0.01, p.legLength);
  const arc = Math.max(0, Math.min(180, p.sideArc)) * DEG;

  const joints: IkJoint[] = [{ parent: -1 }];
  const rest: THREE.Vector3[] = [new THREE.Vector3(0, bodyHeight, 0)];
  const names = ["Body"];
  const legs: PolypedeLeg[] = [];
  const body = rest[0];

  for (let pair = 0; pair < pairs; pair++) {
    // Angle from forward (+Z) toward the side, front leg first.
    const theta = Math.PI / 2 - arc / 2 + (arc * (pair + 0.5)) / pairs;
    for (const side of [1, -1] as const) {
      const dir = new THREE.Vector3(side * Math.sin(theta), 0, Math.cos(theta));
      const hipAt = body.clone().addScaledVector(dir, bodyRadius);
      // The foot cannot rest further than the leg reaches.
      const maxReach = Math.sqrt(Math.max(0, (legLength * 0.97) ** 2 - bodyHeight ** 2)) + bodyRadius;
      const footAt = dir.clone().multiplyScalar(Math.min(Math.max(bodyRadius, p.reach), maxReach));
      const pole = body.clone().addScaledVector(dir, bodyRadius + (footAt.length() - bodyRadius) * 0.45).add(new THREE.Vector3(0, p.kneeHeight, 0));

      // Straight leg out of the hip, then arched onto the resting foot.
      const segLength = legLength / segments;
      const straight: IkRig = { joints: [{ parent: -1 }], rest: [hipAt.clone()] };
      for (let s = 1; s <= segments; s++) {
        straight.joints.push({ parent: s - 1 });
        straight.rest.push(hipAt.clone().addScaledVector(dir, segLength * s));
      }
      const arched = solveFabrik(
        straight,
        [{ joint: segments, target: footAt }],
        { poles: Array.from({ length: segments - 1 }, (_, k) => ({ joint: k + 1, pole })), maxIterations: 60, tolerance: 1e-6 },
      ).positions;

      const label = `${side > 0 ? "Left" : "Right"} Leg ${pair + 1}`;
      const legJoints: number[] = [];
      joints.push({ parent: 0, rigid: true });
      rest.push(arched[0]);
      names.push(`${label} Hip`);
      legJoints.push(joints.length - 1);
      for (let s = 1; s <= segments; s++) {
        joints.push({ parent: joints.length - 1 });
        rest.push(arched[s]);
        names.push(s === segments ? `${label} Foot` : `${label} Joint ${s}`);
        legJoints.push(joints.length - 1);
      }
      legs.push({ joints: legJoints, restFoot: footAt, pole, side, pair });
    }
  }

  return { rig: { joints, rest }, names, legs, bodyRadius };
}

/**
 * Poses the polypede with its body at rest in rig space and each foot at
 * `feet[i]` (rig space; missing ones rest).
 */
export function solvePolypede(skeleton: PolypedeSkeleton, feet: THREE.Vector3[], options: SolveOptions = {}): THREE.Vector3[] {
  const effectors: IkEffector[] = skeleton.legs.map((leg, i) => ({
    joint: leg.joints[leg.joints.length - 1],
    target: feet[i] ?? leg.restFoot,
  }));
  const poles: IkPole[] = skeleton.legs.flatMap((leg) => leg.joints.slice(1, -1).map((joint) => ({ joint, pole: leg.pole })));
  return solveFabrik(skeleton.rig, effectors, {
    poles,
    tolerance: options.tolerance ?? 1e-4,
    maxIterations: options.maxIterations ?? 24,
  }).positions;
}
