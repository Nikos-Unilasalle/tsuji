import * as THREE from "three";
import { IkEffector, IkJoint, IkLimit, IkPole, IkRig, solveFabrik } from "./fabrik";

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
  /** Neck length ×: how high the head sits on the shoulders. */
  neck: number;
  /** Head size ×: neck joint to the top of the head. */
  headSize: number;
  /** Hand length × (wrist to fingertips). */
  hands: number;
  /** Rest pose of the arms, in degrees out from hanging straight down: 22 is an A-pose, 90 a T-pose. */
  armAngle: number;
  /** Rest pose of the legs, in degrees out to the side from straight down: what Skin binds to, like armAngle. */
  legAngle: number;
  spineSegments: number;
  /** Joint limits on (1) or off (0). The angles below are in degrees. */
  jointLimits: number;
  /** Knee: furthest the shin folds back from the thigh's line. */
  kneeBend: number;
  /** Elbow: furthest the forearm folds from the upper arm's line. */
  elbowBend: number;
  /** Hip: thigh swing forward, backward and out to the side, from hanging straight down. */
  hipForward: number;
  hipBack: number;
  hipSide: number;
  /** Shoulder: cone around pointing out to the side (slightly forward). */
  shoulderRange: number;
  /** Whole spine, shared between its segments; neck and head share neckBend. */
  spineBend: number;
  neckBend: number;
}

export const HUMAN_DEFAULTS: HumanParams = {
  height: 1.8,
  torso: 1,
  arms: 1,
  legs: 1,
  shoulderWidth: 1,
  hipWidth: 1,
  neck: 1,
  headSize: 1,
  hands: 1,
  armAngle: 90,
  legAngle: 0,
  spineSegments: 3,
  jointLimits: 1,
  kneeBend: 150,
  elbowBend: 145,
  hipForward: 120,
  hipBack: 30,
  hipSide: 45,
  shoulderRange: 110,
  spineBend: 60,
  neckBend: 70,
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
    hip: [number, number];
    /** Fingertips: the end of the hand bone, swung about the wrist by SolveOptions.wrists. */
    fingers: [number, number];
  };
  /** Control points of the rest pose, in HUMAN_CONTROLS order. */
  restControls: THREE.Vector3[];
  /**
   * The rest controls standing naturally — arms hanging (HANGING_ARM_ANGLE),
   * legs straight down — whatever the rest arm and leg angles: what a walk
   * is built from.
   */
  relaxedControls: THREE.Vector3[];
  /** The joints of that same natural stance. */
  relaxedRest: THREE.Vector3[];
}

/** Arms hanging loose, in degrees out from straight down: the A-pose a walk swings its arms from. */
export const HANGING_ARM_ANGLE = 22;

/**
 * Proportions are fractions of the height (roughly anthropometric), each
 * scaled by its own multiplier. The rest pose is a T-pose (or, with Arm Angle,
 * any other: 22 is an A-pose) with the elbows bent slightly back and the knees slightly forward — toward their poles — so
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
  // Legs spread by the rest leg angle, feet still on the ground: the hips come down.
  const legAngle = Math.max(0, Math.min(60, p.legAngle)) * DEG;
  const hipY = ankleY + (thigh + shin) * Math.cos(kneeBend) * Math.cos(legAngle);
  const pelvisY = hipY + 0.03 * H;
  const spineLength = 0.26 * H * p.torso;
  const chestY = pelvisY + spineLength;

  const pelvis = add("Pelvis", -1, new THREE.Vector3(0, pelvisY, 0));
  let chest = pelvis;
  for (let i = 1; i <= segments; i++) {
    chest = add(i === segments ? "Chest" : `Spine ${i}`, chest, new THREE.Vector3(0, pelvisY + (spineLength * i) / segments, 0));
  }
  const neckY = chestY + 0.05 * H * p.torso * Math.max(0.05, p.neck);
  const neck = add("Neck", chest, new THREE.Vector3(0, neckY, 0));
  const head = add("Head", neck, new THREE.Vector3(0, neckY + 0.08 * H * p.torso * Math.max(0.05, p.headSize), 0));

  const upperArm = 0.17 * H * p.arms;
  const forearm = 0.155 * H * p.arms;
  const armAngle = Math.max(0, Math.min(150, p.armAngle)) * DEG; // arms this far out from hanging straight down
  // Bent a little so the solver has a side to bend to; less in a T-pose, where the arm is meant to read straight.
  const elbowBend = (12 - 8 * Math.min(1, Math.max(0, (armAngle / DEG - 22) / 68))) * DEG;
  const hand: [number, number] = [0, 0];
  const elbow: [number, number] = [0, 0];
  const shoulder: [number, number] = [0, 0];
  for (const [s, side] of [[0, 1], [1, -1]] as const) {
    const label = s === 0 ? "Left" : "Right";
    const shoulderAt = new THREE.Vector3(side * 0.11 * H * p.shoulderWidth, chestY, 0);
    shoulder[s] = add(`${label} Shoulder`, chest, shoulderAt, true);
    const down = new THREE.Vector3(side * Math.sin(armAngle), -Math.cos(armAngle), 0);
    const elbowAt = shoulderAt.clone().addScaledVector(down, upperArm);
    // Forearm swings forward by the bend, so the elbow points back.
    const foreDir = down.clone().applyAxisAngle(down.clone().cross(new THREE.Vector3(0, 0, 1)).normalize(), elbowBend);
    elbow[s] = add(`${label} Elbow`, shoulder[s], elbowAt);
    hand[s] = add(`${label} Hand`, elbow[s], elbowAt.clone().addScaledVector(foreDir, forearm));
  }

  const foot: [number, number] = [0, 0];
  const knee: [number, number] = [0, 0];
  const hip: [number, number] = [0, 0];
  for (const [s, side] of [[0, 1], [1, -1]] as const) {
    const label = s === 0 ? "Left" : "Right";
    const hipAt = new THREE.Vector3(side * 0.09 * H * p.hipWidth, hipY, 0);
    hip[s] = add(`${label} Hip`, pelvis, hipAt, true);
    // Swung out about the forward axis, toward its own side.
    const out = (v: THREE.Vector3) => v.applyAxisAngle(new THREE.Vector3(0, 0, 1), side * legAngle);
    const kneeAt = hipAt.clone().add(out(new THREE.Vector3(0, -Math.cos(kneeBend) * thigh, Math.sin(kneeBend) * thigh)));
    knee[s] = add(`${label} Knee`, hip[s], kneeAt);
    foot[s] = add(`${label} Foot`, knee[s], kneeAt.clone().add(out(new THREE.Vector3(0, -Math.cos(kneeBend) * shin, -Math.sin(kneeBend) * shin))));
  }

  const poleReach = 0.3 * H;
  // Hands last, so the joints of skeletons made before them keep their indices (Skin's per-joint settings).
  const fingers: [number, number] = [0, 0];
  for (const s of [0, 1] as const) {
    const along = rest[hand[s]].clone().sub(rest[elbow[s]]).normalize();
    fingers[s] = add(`${s === 0 ? "Left" : "Right"} Fingers`, hand[s], rest[hand[s]].clone().addScaledVector(along, 0.1 * H * p.arms * Math.max(0.05, p.hands)));
  }

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
    rig: { joints, rest, limits: p.jointLimits ? humanLimits(p, rest, { pelvis, chest, neck, head, hand, elbow, shoulder, foot, knee, hip }) : undefined },
    names,
    joint: { pelvis, chest, head, hand, elbow, foot, knee, hip, fingers },
    restControls,
    ...relaxedStance(p, restControls, rest),
  };
}

function relaxedStance(p: HumanParams, restControls: THREE.Vector3[], rest: THREE.Vector3[]) {
  if (Math.abs(p.armAngle - HANGING_ARM_ANGLE) < 1e-6 && p.legAngle <= 1e-6) return { relaxedControls: restControls, relaxedRest: rest };
  const relaxed = buildHumanSkeleton({ ...p, armAngle: HANGING_ARM_ANGLE, legAngle: 0 });
  return { relaxedControls: relaxed.restControls, relaxedRest: relaxed.rig.rest };
}

/**
 * Anatomical limits, all satisfied by the rest pose: knees and elbows are
 * hinges off their upper bone (the pole picks the side), hips an elliptical
 * cone tilted forward so a leg swings further forward than back, shoulders a
 * cone around pointing out, and the spine and neck share their bend between
 * their joints.
 */
function humanLimits(
  p: HumanParams,
  rest: THREE.Vector3[],
  j: {
    pelvis: number;
    chest: number;
    neck: number;
    head: number;
    hand: number[];
    elbow: number[];
    shoulder: number[];
    foot: number[];
    knee: number[];
    hip: number[];
  },
): IkLimit[] {
  const deg = (d: number) => Math.max(0, d) * DEG;
  const dir = (from: number, to: number) => rest[to].clone().sub(rest[from]).normalize();
  const limits: IkLimit[] = [];

  const spine: number[] = [];
  for (let i = j.chest; i > j.pelvis; i--) spine.push(i);
  for (const i of spine) limits.push({ joint: i, axis: new THREE.Vector3(0, 1, 0), maxAngle: deg(p.spineBend) / spine.length });
  limits.push({ joint: j.neck, axis: new THREE.Vector3(0, 1, 0), maxAngle: deg(p.neckBend) / 2 });
  limits.push({ joint: j.head, axis: dir(j.chest, j.neck), maxAngle: deg(p.neckBend) / 2 });

  const tilt = (deg(p.hipForward) - deg(p.hipBack)) / 2;
  for (const s of [0, 1]) {
    const side = s === 0 ? 1 : -1;
    limits.push({ joint: j.foot[s], axis: dir(j.hip[s], j.knee[s]), maxAngle: deg(p.kneeBend) });
    limits.push({ joint: j.hand[s], axis: dir(j.shoulder[s], j.elbow[s]), maxAngle: deg(p.elbowBend) });
    limits.push({
      joint: j.knee[s],
      axis: new THREE.Vector3(0, -Math.cos(tilt), Math.sin(tilt)),
      maxAngle: (deg(p.hipForward) + deg(p.hipBack)) / 2,
      // Never tighter than the rest pose's own spread, or a skeleton would start outside its limits.
      side: { axis: new THREE.Vector3(1, 0, 0), maxAngle: deg(Math.max(p.hipSide, Math.min(60, p.legAngle) + 5)) },
    });
    limits.push({ joint: j.elbow[s], axis: new THREE.Vector3(side, 0, 0.35).normalize(), maxAngle: deg(p.shoulderRange) });
  }
  return limits;
}

export interface SolveOptions {
  /** How much the hands drag the chest along, against the head (weight 1). */
  armPull?: number;
  tolerance?: number;
  maxIterations?: number;
  /** Turns the pelvis — and the hips riding on it — about itself: a walk's pelvic rotation, list and tilt. */
  pelvisRotation?: THREE.Quaternion;
  /** Left and right wrist, in degrees: see WristTurn. Missing: the hand straight on with the forearm. */
  wrists?: WristTurn[];
}

/**
 * A wrist's turn, degrees. `flex` folds the hand the way the elbow folds the
 * forearm (− extends it back), `side` tips it sideways, toward the thumb for +
 * (the same way on both hands). Kept to a wrist's range.
 */
export interface WristTurn {
  flex: number;
  side: number;
}

export const WRIST_LIMITS = { flex: [-70, 80], side: [-25, 35] } as const;

/** Each hand's fingertips placed off its wrist: along the forearm, turned by the wrist. */
function placeHands(skeleton: HumanSkeleton, positions: THREE.Vector3[], poles: THREE.Vector3[], wrists: WristTurn[] | undefined) {
  const { joint, rig } = skeleton;
  for (const s of [0, 1] as const) {
    const tip = joint.fingers[s];
    const wrist = positions[joint.hand[s]];
    const elbow = positions[joint.elbow[s]];
    const length = rig.rest[tip].distanceTo(rig.rest[joint.hand[s]]);
    const fore = wrist.clone().sub(elbow);
    if (fore.lengthSq() < 1e-12) fore.copy(rig.rest[joint.hand[s]]).sub(rig.rest[joint.elbow[s]]);
    fore.normalize();
    // The plane the elbow bends in: toward its pole. The wrist flexes in it, and tips across it.
    const toPole = poles[s].clone().sub(elbow);
    toPole.addScaledVector(fore, -toPole.dot(fore));
    if (toPole.lengthSq() < 1e-12) toPole.set(0, 0, -1).addScaledVector(fore, fore.z);
    toPole.normalize();
    const hinge = fore.clone().cross(toPole).normalize();
    const turn = wrists?.[s];
    const clamp = (v: number, [lo, hi]: readonly [number, number]) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);
    const flex = (clamp(Number(turn?.flex), WRIST_LIMITS.flex) * Math.PI) / 180;
    const side = (clamp(Number(turn?.side), WRIST_LIMITS.side) * Math.PI) / 180;
    // Away from the pole, as the forearm folds; sideways mirrored so + is the same way on both hands.
    const dir = fore.clone().applyAxisAngle(hinge, -flex).applyAxisAngle(toPole, (s === 0 ? 1 : -1) * side);
    positions[tip].copy(wrist).addScaledVector(dir, length);
  }
}

/**
 * Poses the human for its controls (HUMAN_CONTROLS order; missing ones fall
 * back to rest). The whole rest pose is first carried to the pelvis control,
 * which is the root and stays exactly there.
 */
export function solveHuman(skeleton: HumanSkeleton, controls: THREE.Vector3[], options: SolveOptions = {}): THREE.Vector3[] {
  const c = skeleton.restControls.map((rest, i) => controls[i] ?? rest);
  const restPelvis = skeleton.rig.rest[skeleton.joint.pelvis];
  const turn = options.pelvisRotation;
  const start = skeleton.rig.rest.map((p) => {
    const offset = p.clone().sub(restPelvis);
    if (turn) offset.applyQuaternion(turn);
    return offset.add(c[0]);
  });
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
  const positions = solveFabrik(skeleton.rig, effectors, {
    start,
    poles,
    tolerance: options.tolerance ?? 1e-4,
    maxIterations: options.maxIterations ?? 24,
    rootRotation: turn,
  }).positions;
  placeHands(skeleton, positions, [c[6], c[7]], options.wrists);
  return positions;
}

/** How far a head turns, in radians: x the nod (+ down), y the look aside (+ to its left), z the tilt (+ toward its right shoulder). */
export const HEAD_TURN_LIMITS = { x: 0.7, y: 1.2, z: 0.5 } as const;

/**
 * The head turned on its neck after a solve: nodded and tilted about the neck
 * joint (the head joint moves, in place in `positions`), looked aside about
 * itself — which positions cannot carry, so it comes back as the head bone's
 * twist (see RigData.twist). The turn is the body's: forward is where the
 * shoulders face, so a twisted chest takes the head with it.
 */
export function turnHead(skeleton: HumanSkeleton, positions: THREE.Vector3[], turn: THREE.Vector3): { twist: number[]; face: THREE.Vector3 } {
  const { joint, rig } = skeleton;
  const head = joint.head;
  const neck = rig.joints[head].parent;
  const twist = positions.map(() => 0);
  const clamp = (v: number, lim: number) => (Number.isFinite(v) ? Math.max(-lim, Math.min(lim, v)) : 0);
  const pitch = clamp(turn.x, HEAD_TURN_LIMITS.x);
  const yaw = clamp(turn.y, HEAD_TURN_LIMITS.y);
  const roll = clamp(turn.z, HEAD_TURN_LIMITS.z);
  const length = rig.rest[head].distanceTo(rig.rest[neck]);
  const up = positions[head].clone().sub(positions[neck]);
  if (neck < 0 || length < 1e-9 || up.lengthSq() < 1e-18) return { twist, face: new THREE.Vector3(0, 0, 1) };
  up.normalize();
  // The body's frame at the neck: up the neck, forward square to the shoulders (the left one is +x at rest).
  const shoulder = (s: 0 | 1) => positions[rig.joints[joint.elbow[s]].parent];
  const across = shoulder(0).clone().sub(shoulder(1));
  const forward = across.clone().cross(up);
  if (forward.lengthSq() < 1e-12) forward.set(0, 0, 1);
  forward.addScaledVector(up, -forward.dot(up)).normalize();
  const side = up.clone().cross(forward);
  const body = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, up, forward));
  const look = body.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, "YXZ")));
  const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(look);
  positions[head].copy(positions[neck]).addScaledVector(dir, length);
  // The skin swings the head bone the shortest way onto `dir`; the twist is what is left to face `face`.
  const face = new THREE.Vector3(0, 0, 1).applyQuaternion(look);
  const restDir = rig.rest[head].clone().sub(rig.rest[neck]).normalize();
  const swung = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(restDir, dir));
  swung.addScaledVector(dir, -swung.dot(dir));
  const want = face.clone().addScaledVector(dir, -face.dot(dir));
  if (swung.lengthSq() > 1e-12 && want.lengthSq() > 1e-12) twist[head] = Math.atan2(swung.clone().cross(want).dot(dir), swung.dot(want));
  return { twist, face };
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
  /** Joint limits on (1) or off (0). */
  jointLimits: number;
  /** Degrees each leg joint may fold from the previous segment's line. */
  jointBend: number;
  /** Degrees the first segment may swing away from its rest direction. */
  hipSwing: number;
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
  jointLimits: 1,
  jointBend: 150,
  hipSwing: 75,
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
  const limits: IkLimit[] = [];
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
        // The first segment swings in a cone off the body; every later one is
        // a hinge off the segment before it, the pole choosing the side.
        const axis = arched[s === 1 ? 1 : s - 1].clone().sub(arched[s === 1 ? 0 : s - 2]).normalize();
        limits.push({ joint: joints.length - 1, axis, maxAngle: (s === 1 ? p.hipSwing : p.jointBend) * DEG });
      }
      legs.push({ joints: legJoints, restFoot: footAt, pole, side, pair });
    }
  }

  return { rig: { joints, rest, limits: p.jointLimits ? limits : undefined }, names, legs, bodyRadius };
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
