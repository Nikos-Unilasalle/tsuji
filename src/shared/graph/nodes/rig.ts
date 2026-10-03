import * as THREE from "three";
import { NodeDefinition, ParamFieldDef } from "../types";
import { createNodeCache } from "../nodeCaches";
import { asVector3, composeNativeMatrix } from "./transform";
import { NATIVE_TRANSFORM_PARAM_FIELDS, numberInput } from "./object";
import { TOGGLE_POINTS_KEYFRAME_ACTION } from "./curve";
import { toBoolean } from "../sockets";
import {
  buildHumanSkeleton,
  buildPolypedeSkeleton,
  HUMAN_CONTROLS,
  HUMAN_DEFAULTS,
  HumanParams,
  HumanSkeleton,
  POLYPEDE_DEFAULTS,
  PolypedeParams,
  PolypedeSkeleton,
  solveHuman,
  solvePolypede,
} from "../ik/skeletons";
import { createSkeletonView, SkeletonView } from "../ik/skeletonView";
import { createGait, GAIT_DEFAULTS, GaitParams, GaitState, polypedeNeighbors, stepGait } from "../ik/polypedeGait";
import { boneLengths, IkRig } from "../ik/fabrik";

/**
 * Rig nodes: FABRIK inverse kinematics on two ready-made skeletons — a human
 * posed by its controls, and a polypede walked by Polypede Motion. Skeletons
 * only, nothing deforms a mesh yet; Joints / Bones outputs let objects be
 * attached to them.
 */

const views = createNodeCache<SkeletonView>((view) => view.dispose());

function viewFor(nodeId: string): SkeletonView {
  let view = views.get(nodeId);
  if (!view) {
    view = createSkeletonView(nodeId);
    view.group.matrixAutoUpdate = false;
    views.set(nodeId, view);
  }
  return view;
}

/**
 * The node's pose: its own location/rotation/scale over whatever is wired into
 * Matrix — except while the viewport gizmo is dragging it, when the group
 * already carries the dragged pose and the graph must not fight it.
 */
function placeGroup(group: THREE.Group, inputs: Record<string, unknown>, params: Record<string, unknown>, nodeId: string, liveEditNodeId?: string | null) {
  if (nodeId !== liveEditNodeId) {
    group.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
  }
  group.matrixWorldNeedsUpdate = true;
}

function bonesOf(rig: IkRig): [number, number][] {
  return rig.joints.flatMap((j, i) => (j.parent >= 0 ? [[j.parent, i] as [number, number]] : []));
}

/** World matrix per bone: at the parent joint, +Y down the bone, unit scale. */
function boneMatrices(rig: IkRig, world: THREE.Vector3[]): THREE.Matrix4[] {
  const up = new THREE.Vector3(0, 1, 0);
  return bonesOf(rig).map(([a, b]) => {
    const dir = world[b].clone().sub(world[a]);
    const q = dir.lengthSq() > 1e-18 ? new THREE.Quaternion().setFromUnitVectors(up, dir.normalize()) : new THREE.Quaternion();
    return new THREE.Matrix4().compose(world[a], q, new THREE.Vector3(1, 1, 1));
  });
}

const TRANSFORM_DEFAULTS = {
  visible: 1,
  location: new THREE.Vector3(0, 0, 0),
  rotation: new THREE.Vector3(0, 0, 0),
  scale: new THREE.Vector3(1, 1, 1),
  showPivot: false,
  pivot: new THREE.Vector3(0, 0, 0),
  inheritRotation: "parent",
  inheritScale: "parent",
};

const DISPLAY_FIELDS: ParamFieldDef[] = [
  { id: "boneThickness", label: "Bone Thickness", kind: "number", step: 0.005, group: "Display" },
  { id: "boneColor", label: "Bone Color", kind: "color", group: "Display" },
];

const SOLVER_FIELDS: ParamFieldDef[] = [
  { id: "iterations", label: "Max Iterations", kind: "number", step: 1, group: "Solver" },
  { id: "tolerance", label: "Tolerance", kind: "number", step: 0.0001, group: "Solver" },
];

const solverOptions = (params: Record<string, unknown>) => ({
  maxIterations: Math.max(1, Math.min(200, Math.round(numberInput(undefined, params.iterations, 24)))),
  tolerance: Math.max(1e-6, numberInput(undefined, params.tolerance, 1e-4)),
});

// ---------------------------------------------------------------------------
// Human Skeleton

/** Socket id per control, in HUMAN_CONTROLS order. */
const HUMAN_CONTROL_SOCKETS = [
  "pelvis",
  "head",
  "leftHand",
  "rightHand",
  "leftFoot",
  "rightFoot",
  "leftElbowPole",
  "rightElbowPole",
  "leftKneePole",
  "rightKneePole",
];

const humanSkeletons = createNodeCache<{ key: string; skeleton: HumanSkeleton }>();

function humanParams(params: Record<string, unknown>): HumanParams {
  const n = (id: keyof HumanParams) => numberInput(undefined, params[id], HUMAN_DEFAULTS[id]);
  return {
    height: Math.max(0.05, n("height")),
    torso: Math.max(0.05, n("torso")),
    arms: Math.max(0.05, n("arms")),
    legs: Math.max(0.05, n("legs")),
    shoulderWidth: Math.max(0, n("shoulderWidth")),
    hipWidth: Math.max(0, n("hipWidth")),
    spineSegments: Math.max(1, Math.min(8, Math.round(n("spineSegments")))),
    jointLimits: params.jointLimits === undefined ? 1 : toBoolean(params.jointLimits) ? 1 : 0,
    kneeBend: n("kneeBend"),
    elbowBend: n("elbowBend"),
    hipForward: n("hipForward"),
    hipBack: n("hipBack"),
    hipSide: n("hipSide"),
    shoulderRange: n("shoulderRange"),
    spineBend: n("spineBend"),
    neckBend: n("neckBend"),
  };
}

const HUMAN_LIMIT_FIELDS: ParamFieldDef[] = [
  { id: "jointLimits", label: "Joint Limits", kind: "boolean", group: "Joint Limits" },
  { id: "kneeBend", label: "Knee Bend (°)", kind: "number", step: 5, group: "Joint Limits" },
  { id: "elbowBend", label: "Elbow Bend (°)", kind: "number", step: 5, group: "Joint Limits" },
  { id: "hipForward", label: "Hip Forward (°)", kind: "number", step: 5, group: "Joint Limits" },
  { id: "hipBack", label: "Hip Back (°)", kind: "number", step: 5, group: "Joint Limits" },
  { id: "hipSide", label: "Hip Side (°)", kind: "number", step: 5, group: "Joint Limits" },
  { id: "shoulderRange", label: "Shoulder Range (°)", kind: "number", step: 5, group: "Joint Limits" },
  { id: "spineBend", label: "Spine Bend (°)", kind: "number", step: 5, group: "Joint Limits" },
  { id: "neckBend", label: "Neck Bend (°)", kind: "number", step: 5, group: "Joint Limits" },
];

/**
 * Human skeleton, posed by FABRIK from ten controls: pelvis (the root), head,
 * hands and feet as targets, and a pole per elbow and knee to choose which way
 * they bend. The controls are the node's `pointsList` — dragged as handles in
 * the viewport when the node is selected, keyframable like a curve's points —
 * in the skeleton's own space, so they follow it when it moves. An empty list
 * is the rest pose, which keeps following the proportions until a control is
 * first moved; the Reset icon goes back to it.
 *
 * A wired control socket overrides its handle, in world space: a target
 * stays put when the skeleton moves, as an IK target should.
 *
 * Arm Pull is how much the hands drag the chest along against the head — 0
 * leaves the torso to the head alone, 1 lets a hand pull as hard as the head.
 */
export const RIG_HUMAN_NODE: NodeDefinition = {
  type: "rig/human",
  label: "Human Skeleton",
  category: "rig",
  inputs: [
    { id: "matrix", label: "Matrix", type: "matrix" },
    ...HUMAN_CONTROL_SOCKETS.map((id, i) => ({ id, label: HUMAN_CONTROLS[i], type: "vector" as const })),
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "joints", label: "Joints", type: "list" },
    { id: "bones", label: "Bone Matrices", type: "list" },
  ],
  defaultParams: {
    ...TRANSFORM_DEFAULTS,
    ...HUMAN_DEFAULTS,
    armPull: 0.3,
    iterations: 24,
    tolerance: 0.0001,
    boneThickness: 0.022,
    boneColor: new THREE.Color(0x9a5b2e),
    showControls: true,
    pointsList: [],
  },
  paramFields: [
    ...NATIVE_TRANSFORM_PARAM_FIELDS,
    { id: "height", label: "Height", kind: "number", step: 0.05, group: "Proportions" },
    { id: "torso", label: "Torso ×", kind: "number", step: 0.05, group: "Proportions" },
    { id: "arms", label: "Arms ×", kind: "number", step: 0.05, group: "Proportions" },
    { id: "legs", label: "Legs ×", kind: "number", step: 0.05, group: "Proportions" },
    { id: "shoulderWidth", label: "Shoulder Width ×", kind: "number", step: 0.05, group: "Proportions" },
    { id: "hipWidth", label: "Hip Width ×", kind: "number", step: 0.05, group: "Proportions" },
    { id: "spineSegments", label: "Spine Segments", kind: "number", step: 1, group: "Proportions" },
    ...HUMAN_LIMIT_FIELDS,
    { id: "armPull", label: "Arm Pull on Torso", kind: "number", step: 0.05, group: "Solver" },
    ...SOLVER_FIELDS,
    { id: "showControls", label: "Show Controls", kind: "boolean", group: "Display" },
    ...DISPLAY_FIELDS,
    { id: "pointsKeyframeButton", label: "Keyframe controls at frame", kind: "button", action: TOGGLE_POINTS_KEYFRAME_ACTION, group: "Animation" },
  ],
  reset: { params: ["pointsList"] },
  evaluate: (inputs, params, ctx) => {
    const hp = humanParams(params);
    const key = JSON.stringify(hp);
    let cached = humanSkeletons.get(ctx.nodeId);
    if (!cached || cached.key !== key) {
      cached = { key, skeleton: buildHumanSkeleton(hp) };
      humanSkeletons.set(ctx.nodeId, cached);
    }
    const skeleton = cached.skeleton;

    const view = viewFor(ctx.nodeId);
    const group = view.group;
    placeGroup(group, inputs, params, ctx.nodeId, ctx.liveEditNodeId);
    const toLocal = group.matrix.clone().invert();

    const stored = Array.isArray(params.pointsList) ? params.pointsList : [];
    const controls = skeleton.restControls.map((rest, i) => {
      const socket = HUMAN_CONTROL_SOCKETS[i];
      if (ctx.connectedInputs?.has(socket) && inputs[socket] !== undefined) {
        return asVector3(inputs[socket], rest).clone().applyMatrix4(toLocal);
      }
      return stored.length === HUMAN_CONTROLS.length ? asVector3(stored[i], rest).clone() : rest.clone();
    });

    const positions = solveHuman(skeleton, controls, { armPull: numberInput(undefined, params.armPull, 0.3), ...solverOptions(params) });

    const H = hp.height;
    const thickness = Math.max(0, numberInput(undefined, params.boneThickness, 0.022));
    const showControls = params.showControls === undefined ? true : toBoolean(params.showControls);
    const { joint } = skeleton;
    view.update({
      positions,
      bones: bonesOf(skeleton.rig),
      thickness,
      color: params.boneColor instanceof THREE.Color ? params.boneColor : new THREE.Color(String(params.boneColor ?? "#9a5b2e")),
      jointRadius: thickness * 1.3,
      targets: showControls ? controls.slice(0, 6) : [],
      poles: showControls
        ? [
            { at: controls[6], joint: positions[joint.elbow[0]] },
            { at: controls[7], joint: positions[joint.elbow[1]] },
            { at: controls[8], joint: positions[joint.knee[0]] },
            { at: controls[9], joint: positions[joint.knee[1]] },
          ]
        : [],
      markerSize: 0.03 * H,
    });
    const rigData: HumanRigData = {
      skeleton,
      key,
      thickness,
      color: params.boneColor instanceof THREE.Color ? params.boneColor : new THREE.Color(String(params.boneColor ?? "#9a5b2e")),
      armPull: numberInput(undefined, params.armPull, 0.3),
      solver: solverOptions(params),
    };
    group.userData.humanRig = rigData;

    group.updateMatrixWorld(true);
    const world = positions.map((p) => p.clone().applyMatrix4(group.matrix));
    return {
      geometry: group,
      matrix: group.matrix.clone(),
      joints: world,
      bones: boneMatrices(skeleton.rig, world),
      // Not a socket: the controls the viewport draws handles for while the
      // stored list is still empty (see Viewport.tsx's curve handles).
      __controlPoints: controls,
    };
  },
};

/** What a Human Skeleton hands Biped Motion, on its geometry's userData. */
export interface HumanRigData {
  skeleton: HumanSkeleton;
  key: string;
  thickness: number;
  color: THREE.Color;
  armPull: number;
  solver: { maxIterations: number; tolerance: number };
}

// ---------------------------------------------------------------------------
// Polypede Skeleton

/** What a Polypede Skeleton hands Polypede Motion, on its geometry's userData. */
export interface PolypedeRigData {
  skeleton: PolypedeSkeleton;
  key: string;
  thickness: number;
  color: THREE.Color;
}

const polypedeSkeletons = createNodeCache<{ key: string; skeleton: PolypedeSkeleton }>();

function polypedeParams(params: Record<string, unknown>): PolypedeParams {
  const n = (id: keyof PolypedeParams) => numberInput(undefined, params[id], POLYPEDE_DEFAULTS[id]);
  return {
    legPairs: Math.max(1, Math.min(16, Math.round(n("legPairs")))),
    legSegments: Math.max(1, Math.min(8, Math.round(n("legSegments")))),
    legLength: Math.max(0.01, n("legLength")),
    bodyRadius: Math.max(0, n("bodyRadius")),
    bodyHeight: Math.max(0, n("bodyHeight")),
    reach: Math.max(0, n("reach")),
    sideArc: Math.max(0, Math.min(180, n("sideArc"))),
    kneeHeight: n("kneeHeight"),
    jointLimits: params.jointLimits === undefined ? 1 : toBoolean(params.jointLimits) ? 1 : 0,
    jointBend: n("jointBend"),
    hipSwing: n("hipSwing"),
  };
}

function drawPolypede(view: SkeletonView, skeleton: PolypedeSkeleton, positions: THREE.Vector3[], thickness: number, color: THREE.Color, circles?: { center: THREE.Vector3; radius: number }[]) {
  view.update({
    positions,
    bones: bonesOf(skeleton.rig).filter(([a]) => a !== 0),
    thickness,
    color,
    jointRadius: thickness * 1.2,
    body: { center: positions[0], radius: skeleton.bodyRadius },
    circles,
  });
}

/**
 * A body and `Leg Pairs` × 2 legs of `Leg Segments` bones each, standing at
 * rest — the feet on a circle of `Reach` around the body, the knees arched up
 * toward a pole `Knee Height` above it. Wire it into Polypede Motion to walk
 * it; on its own it just stands where its transform puts it.
 */
export const RIG_POLYPEDE_NODE: NodeDefinition = {
  type: "rig/polypede",
  label: "Polypede Skeleton",
  category: "rig",
  inputs: [{ id: "matrix", label: "Matrix", type: "matrix" }],
  outputs: [
    { id: "geometry", label: "Skeleton", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    ...TRANSFORM_DEFAULTS,
    ...POLYPEDE_DEFAULTS,
    boneThickness: 0.03,
    boneColor: new THREE.Color(0x9a5b2e),
  },
  paramFields: [
    ...NATIVE_TRANSFORM_PARAM_FIELDS,
    { id: "legPairs", label: "Leg Pairs", kind: "number", step: 1, group: "Body" },
    { id: "legSegments", label: "Leg Segments", kind: "number", step: 1, group: "Body" },
    { id: "legLength", label: "Leg Length", kind: "number", step: 0.05, group: "Body" },
    { id: "bodyRadius", label: "Body Radius", kind: "number", step: 0.02, group: "Body" },
    { id: "bodyHeight", label: "Body Height", kind: "number", step: 0.05, group: "Body" },
    { id: "reach", label: "Foot Reach", kind: "number", step: 0.05, group: "Body" },
    { id: "sideArc", label: "Leg Spread (°)", kind: "number", step: 5, group: "Body" },
    { id: "kneeHeight", label: "Knee Height", kind: "number", step: 0.05, group: "Body" },
    { id: "jointLimits", label: "Joint Limits", kind: "boolean", group: "Joint Limits" },
    { id: "jointBend", label: "Joint Bend (°)", kind: "number", step: 5, group: "Joint Limits" },
    { id: "hipSwing", label: "Hip Swing (°)", kind: "number", step: 5, group: "Joint Limits" },
    ...DISPLAY_FIELDS,
  ],
  evaluate: (inputs, params, ctx) => {
    const pp = polypedeParams(params);
    const key = JSON.stringify(pp);
    let cached = polypedeSkeletons.get(ctx.nodeId);
    if (!cached || cached.key !== key) {
      cached = { key, skeleton: buildPolypedeSkeleton(pp) };
      polypedeSkeletons.set(ctx.nodeId, cached);
    }
    const skeleton = cached.skeleton;
    const thickness = Math.max(0, numberInput(undefined, params.boneThickness, 0.03));
    const color = params.boneColor instanceof THREE.Color ? params.boneColor : new THREE.Color(String(params.boneColor ?? "#9a5b2e"));

    const view = viewFor(ctx.nodeId);
    placeGroup(view.group, inputs, params, ctx.nodeId, ctx.liveEditNodeId);
    drawPolypede(view, skeleton, skeleton.rig.rest, thickness, color);
    const data: PolypedeRigData = { skeleton, key, thickness, color };
    view.group.userData.polypedeRig = data;
    return { geometry: view.group, matrix: view.group.matrix.clone() };
  },
};

// ---------------------------------------------------------------------------
// Polypede Motion

interface MotionState {
  key: string;
  epoch: number;
  gait: GaitState;
  lastTime: number | null;
  clock: "wall" | "graph";
}

/** Per node, per evaluating session: two viewports must not both advance one walk. */
const motionStates = createNodeCache<Map<string, MotionState>>();

/**
 * Real time, on purpose: live, the walk runs on the wall clock, so the
 * polypede keeps walking while it is dragged around with the timeline paused.
 * A captured export frame uses graph time instead, so the video gets exactly
 * the frames it asked for.
 */
function motionClock(ctx: { time: number; capturing?: boolean }): { now: number; clock: "wall" | "graph" } {
  if (ctx.capturing) return { now: ctx.time, clock: "graph" };
  return { now: (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000, clock: "wall" };
}

/**
 * Walks a Polypede Skeleton with the circle technique (see polypedeGait.ts):
 * the body goes wherever this node's pose puts it — its own transform, so it
 * can be dragged with the gizmo, over whatever matrix is wired in — and each
 * foot stays planted until its home has left its circle, then steps ahead.
 *
 * Runs in real time, not replayed from frame 0: the feet are state, kept per
 * viewport, reset by Reset Simulations or when the skeleton changes shape.
 */
export const RIG_POLYPEDE_MOTION_NODE: NodeDefinition = {
  type: "rig/polypede-motion",
  label: "Polypede Motion",
  category: "rig",
  inputs: [
    { id: "skeleton", label: "Skeleton", type: "geometry", owns: true },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Body Matrix", type: "matrix" },
    { id: "feet", label: "Feet", type: "list" },
    { id: "joints", label: "Joints", type: "list" },
    { id: "bones", label: "Bone Matrices", type: "list" },
  ],
  defaultParams: {
    ...TRANSFORM_DEFAULTS,
    ...GAIT_DEFAULTS,
    showCircles: false,
    iterations: 24,
    tolerance: 0.0001,
  },
  paramFields: [
    ...NATIVE_TRANSFORM_PARAM_FIELDS,
    { id: "stepRadius", label: "Step Radius", kind: "number", step: 0.02, group: "Gait" },
    { id: "stepDuration", label: "Step Duration (s)", kind: "number", step: 0.02, group: "Gait" },
    { id: "stepHeight", label: "Step Height", kind: "number", step: 0.02, group: "Gait" },
    { id: "overshoot", label: "Step Overshoot", kind: "number", step: 0.05, group: "Gait" },
    { id: "showCircles", label: "Show Step Circles", kind: "boolean", group: "Display" },
    ...SOLVER_FIELDS,
  ],
  evaluate: (inputs, params, ctx) => {
    const view = viewFor(ctx.nodeId);
    const group = view.group;
    placeGroup(group, inputs, params, ctx.nodeId, ctx.liveEditNodeId);
    const body = group.matrix.clone();

    const source = inputs.skeleton instanceof THREE.Object3D ? inputs.skeleton : null;
    const data = source?.userData.polypedeRig as PolypedeRigData | undefined;
    if (!data) {
      drawEmpty(view);
      return { geometry: group, matrix: body, feet: [], joints: [], bones: [] };
    }
    const { skeleton } = data;

    const homes = skeleton.legs.map((leg) => leg.restFoot.clone().applyMatrix4(body));
    const up = new THREE.Vector3(0, 1, 0).transformDirection(body);

    let sessions = motionStates.get(ctx.nodeId);
    if (!sessions) {
      sessions = new Map();
      motionStates.set(ctx.nodeId, sessions);
    }
    const sessionKey = `${ctx.sessionId ?? ""}|${ctx.evalScope ?? ""}`;
    const epoch = ctx.simulationEpoch ?? 0;
    const { now, clock } = motionClock(ctx);
    let state = sessions.get(sessionKey);
    if (!state || state.key !== data.key || state.epoch !== epoch) {
      state = { key: data.key, epoch, gait: createGait(homes), lastTime: null, clock };
      sessions.set(sessionKey, state);
    }
    if (state.clock !== clock) {
      state.clock = clock;
      state.lastTime = null;
    }
    // Clamped: a tab in the background or a stalled frame should not make a
    // whole stride happen in one go.
    const dt = state.lastTime === null ? 0 : Math.max(0, Math.min(0.1, now - state.lastTime));
    state.lastTime = now;

    const gaitParams: GaitParams = {
      stepRadius: Math.max(0.001, numberInput(undefined, params.stepRadius, GAIT_DEFAULTS.stepRadius)),
      stepDuration: Math.max(0.01, numberInput(undefined, params.stepDuration, GAIT_DEFAULTS.stepDuration)),
      stepHeight: numberInput(undefined, params.stepHeight, GAIT_DEFAULTS.stepHeight),
      overshoot: numberInput(undefined, params.overshoot, GAIT_DEFAULTS.overshoot),
    };
    const pairs = skeleton.legs.length / 2;
    const feetWorld = stepGait(state.gait, homes, up, polypedeNeighbors(pairs), gaitParams, dt);

    const toLocal = body.clone().invert();
    const feetLocal = feetWorld.map((f) => f.clone().applyMatrix4(toLocal));
    const positions = solvePolypede(skeleton, feetLocal, solverOptions(params));

    const scale = new THREE.Vector3().setFromMatrixScale(body);
    const localRadius = gaitParams.stepRadius / Math.max(1e-6, Math.max(scale.x, scale.z));
    const circles = toBoolean(params.showCircles)
      ? skeleton.legs.map((leg) => ({ center: leg.restFoot, radius: localRadius }))
      : undefined;
    drawPolypede(view, skeleton, positions, data.thickness, data.color, circles);

    group.updateMatrixWorld(true);
    const world = positions.map((p) => p.clone().applyMatrix4(body));
    return {
      geometry: group,
      matrix: body,
      feet: feetWorld,
      joints: world,
      bones: boneMatrices(skeleton.rig, world),
    };
  },
};

function drawEmpty(view: SkeletonView) {
  view.update({ positions: [], bones: [], thickness: 0, color: 0xffffff, jointRadius: 0 });
}

// ---------------------------------------------------------------------------
// Biped Motion

interface BipedState {
  key: string;
  epoch: number;
  gait: GaitState;
  lastTime: number | null;
  clock: "wall" | "graph";
  prevBody: THREE.Vector3 | null;
  /** Clock reading prevBody was taken at. */
  prevBodyTime: number;
  /** Smoothed speed along the body's forward axis, world units per second. */
  speed: number;
  /** Smoothed pelvis drop. */
  drop: number;
}

const bipedStates = createNodeCache<Map<string, BipedState>>();

export const BIPED_DEFAULTS = {
  stepRadius: 0.26,
  stepDuration: 0.34,
  stepHeight: 0.12,
  overshoot: 0.8,
  stanceWidth: 1,
  pelvisBob: 0.03,
  maxPelvisDrop: 0.08,
  toeOff: 0.08,
  hipSway: 0.035,
  armSwing: 0.6,
  lean: 0.08,
};

/**
 * Walks a Human Skeleton, the biped counterpart of Polypede Motion: the body
 * goes where this node's pose puts it (its own transform, draggable with the
 * gizmo, over whatever matrix is wired in) and the feet follow with the
 * circle technique — each planted until its home leaves its circle, then one
 * step ahead, never both in the air unless the body outruns them. On top:
 *
 * - **Pelvis** drops just enough for both feet to stay within reach of the
 *   hips — up to Max Pelvis Drop — bobs up while a foot swings through, and
 *   sways over the foot it is standing on. Past that, a foot left far behind
 *   lifts its heel (Toe Off) rather than crouching the whole body.
 * - **Arms** swing against the legs: a hand goes forward with the opposite
 *   foot, by Arm Swing × that foot's stride.
 * - **Lean**: the head goes forward with speed, Lean metres per m/s.
 * - **Poles** ride along — elbows behind, knees ahead of their own foot — so
 *   the knees keep pointing where the foot is going, including on turns.
 *
 * The skeleton's joint limits apply. Real time, like Polypede Motion.
 */
export const RIG_BIPED_MOTION_NODE: NodeDefinition = {
  type: "rig/biped-motion",
  label: "Biped Motion",
  category: "rig",
  inputs: [
    { id: "skeleton", label: "Skeleton", type: "geometry", owns: true },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Body Matrix", type: "matrix" },
    { id: "feet", label: "Feet", type: "list" },
    { id: "joints", label: "Joints", type: "list" },
    { id: "bones", label: "Bone Matrices", type: "list" },
  ],
  defaultParams: {
    ...TRANSFORM_DEFAULTS,
    ...BIPED_DEFAULTS,
    showCircles: false,
    showControls: false,
  },
  paramFields: [
    ...NATIVE_TRANSFORM_PARAM_FIELDS,
    { id: "stepRadius", label: "Step Radius", kind: "number", step: 0.02, group: "Gait" },
    { id: "stepDuration", label: "Step Duration (s)", kind: "number", step: 0.02, group: "Gait" },
    { id: "stepHeight", label: "Step Height", kind: "number", step: 0.01, group: "Gait" },
    { id: "overshoot", label: "Step Overshoot", kind: "number", step: 0.05, group: "Gait" },
    { id: "stanceWidth", label: "Stance Width ×", kind: "number", step: 0.05, group: "Gait" },
    { id: "pelvisBob", label: "Pelvis Bob", kind: "number", step: 0.005, group: "Body" },
    { id: "maxPelvisDrop", label: "Max Pelvis Drop", kind: "number", step: 0.01, group: "Body" },
    { id: "toeOff", label: "Toe Off (heel lift)", kind: "number", step: 0.01, group: "Body" },
    { id: "hipSway", label: "Hip Sway", kind: "number", step: 0.005, group: "Body" },
    { id: "armSwing", label: "Arm Swing", kind: "number", step: 0.05, group: "Body" },
    { id: "lean", label: "Lean (m per m/s)", kind: "number", step: 0.01, group: "Body" },
    { id: "showCircles", label: "Show Step Circles", kind: "boolean", group: "Display" },
    { id: "showControls", label: "Show Controls", kind: "boolean", group: "Display" },
  ],
  evaluate: (inputs, params, ctx) => {
    const view = viewFor(ctx.nodeId);
    const group = view.group;
    placeGroup(group, inputs, params, ctx.nodeId, ctx.liveEditNodeId);
    const body = group.matrix.clone();

    const source = inputs.skeleton instanceof THREE.Object3D ? inputs.skeleton : null;
    const data = source?.userData.humanRig as HumanRigData | undefined;
    if (!data) {
      drawEmpty(view);
      return { geometry: group, matrix: body, feet: [], joints: [], bones: [] };
    }
    const { skeleton } = data;
    const rc = skeleton.restControls;
    const num = (id: keyof typeof BIPED_DEFAULTS) => numberInput(undefined, params[id], BIPED_DEFAULTS[id]);

    const width = Math.max(0, num("stanceWidth"));
    const restFeet = [rc[4], rc[5]].map((f) => new THREE.Vector3(f.x * width, f.y, f.z));
    const homes = restFeet.map((f) => f.clone().applyMatrix4(body));
    const up = new THREE.Vector3(0, 1, 0).transformDirection(body);

    let sessions = bipedStates.get(ctx.nodeId);
    if (!sessions) {
      sessions = new Map();
      bipedStates.set(ctx.nodeId, sessions);
    }
    const sessionKey = `${ctx.sessionId ?? ""}|${ctx.evalScope ?? ""}`;
    const epoch = ctx.simulationEpoch ?? 0;
    const { now, clock } = motionClock(ctx);
    const stateKey = `${data.key}|${width}`;
    let state = sessions.get(sessionKey);
    if (!state || state.key !== stateKey || state.epoch !== epoch) {
      state = { key: stateKey, epoch, gait: createGait(homes), lastTime: null, clock, prevBody: null, prevBodyTime: now, speed: 0, drop: -1 };
      sessions.set(sessionKey, state);
    }
    if (state.clock !== clock) {
      state.clock = clock;
      state.lastTime = null;
    }
    const dt = state.lastTime === null ? 0 : Math.max(0, Math.min(0.1, now - state.lastTime));
    state.lastTime = now;

    const gaitParams: GaitParams = {
      stepRadius: Math.max(0.001, num("stepRadius")),
      stepDuration: Math.max(0.01, num("stepDuration")),
      stepHeight: num("stepHeight"),
      overshoot: num("overshoot"),
      // Wait for the other foot rather than hop, until the stride would tear.
      urgency: 2.4,
      // Past this a leg cannot reach its foot anyway: put it back under the body.
      snap: 3.5,
    };
    const feetWorld = stepGait(state.gait, homes, up, [[1], [0]], gaitParams, dt);
    const toLocal = body.clone().invert();
    const feet = feetWorld.map((f) => f.clone().applyMatrix4(toLocal));

    // Speed along the body's own forward axis, smoothed, in skeleton units.
    const bodyPos = new THREE.Vector3().setFromMatrixPosition(body);
    const forward = new THREE.Vector3(0, 0, 1).transformDirection(body);
    const scale = new THREE.Vector3().setFromMatrixScale(body);
    const unit = Math.max(1e-6, (scale.x + scale.y + scale.z) / 3);
    // Measured over at least a thirtieth of a second: the graph can be
    // evaluated more than once per displayed frame, and a whole frame's
    // movement over a near-zero wall-clock gap reads as a huge speed.
    const elapsed = now - state.prevBodyTime;
    if (!state.prevBody || elapsed > 0.5 || elapsed < 0) {
      state.prevBody = bodyPos;
      state.prevBodyTime = now;
    } else if (elapsed >= 1 / 30) {
      const v = bodyPos.clone().sub(state.prevBody).dot(forward) / elapsed;
      // Faster than anyone walks is a jump (the timeline looping, a teleport): start over.
      if (Math.abs(v) / unit > 10) state.speed = 0;
      else state.speed += (v - state.speed) * Math.min(1, elapsed * 5);
      state.prevBody = bodyPos;
      state.prevBodyTime = now;
    }
    const speed = state.speed / unit;

    // Pelvis drop: just enough for both feet to be within reach of the hips,
    // up to the maximum; how far each foot is short of reach after that.
    const lengths = boneLengths(skeleton.rig);
    const height = rc[1].y;
    const hips = [0, 1].map((s) => skeleton.rig.rest[skeleton.joint.hip[s]]);
    const reaches = [0, 1].map((s) => (lengths[skeleton.joint.knee[s]] + lengths[skeleton.joint.foot[s]]) * 0.985);
    /** How far the hip at `hipY` sits above the highest point foot s could be reached from. */
    const shortfall = (s: number, hipY: number) => {
      const flat = Math.hypot(hips[s].x - feet[s].x, hips[s].z - feet[s].z);
      const vertical = flat >= reaches[s] ? 0 : Math.sqrt(reaches[s] ** 2 - flat ** 2);
      return Math.max(0, hipY - (feet[s].y + vertical));
    };
    const targetDrop = Math.min(Math.max(0, num("maxPelvisDrop")), Math.max(shortfall(0, hips[0].y), shortfall(1, hips[1].y)));
    state.drop = state.drop < 0 || dt === 0 ? targetDrop : state.drop + (targetDrop - state.drop) * Math.min(1, dt * 12);
    // A planted foot still out of reach lifts its heel, as a trailing foot does.
    for (const s of [0, 1]) {
      if (state.gait.legs[s].stepping) continue;
      feet[s].y += Math.min(Math.max(0, num("toeOff")), shortfall(s, hips[s].y - state.drop));
    }

    // Bob and sway while a foot is in the air, over the foot standing.
    let bob = 0;
    let sway = 0;
    state.gait.legs.forEach((leg, s) => {
      if (!leg.stepping) return;
      const lift = Math.sin(Math.PI * Math.min(1, leg.t));
      bob = Math.max(bob, lift * num("pelvisBob"));
      sway += lift * num("hipSway") * Math.sign(restFeet[1 - s].x || 1);
    });
    const delta = new THREE.Vector3(sway, bob - state.drop, 0);
    const lean = Math.max(-0.3, Math.min(0.3, num("lean") * speed)) * (height / 1.7);
    // Clamped to a real stride, so a foot left somewhere odd (a jump, a reload)
    // cannot fling the arms — and, through Arm Pull, the torso — along with it.
    const maxStride = 2 * gaitParams.stepRadius / unit;
    const stride = (s: number) => Math.max(-maxStride, Math.min(maxStride, feet[s].z - restFeet[s].z));
    const armSwing = num("armSwing");

    const controls = [
      rc[0].clone().add(delta),
      rc[1].clone().add(delta).add(new THREE.Vector3(0, 0, lean)),
      rc[2].clone().add(delta).add(new THREE.Vector3(0, 0, armSwing * stride(1) + lean * 0.5)),
      rc[3].clone().add(delta).add(new THREE.Vector3(0, 0, armSwing * stride(0) + lean * 0.5)),
      feet[0],
      feet[1],
      rc[6].clone().add(delta),
      rc[7].clone().add(delta),
      rc[8].clone().add(delta).add(new THREE.Vector3(feet[0].x - restFeet[0].x, 0, stride(0))),
      rc[9].clone().add(delta).add(new THREE.Vector3(feet[1].x - restFeet[1].x, 0, stride(1))),
    ];
    const positions = solveHuman(skeleton, controls, { armPull: data.armPull, ...data.solver });

    const showControls = toBoolean(params.showControls);
    const { joint } = skeleton;
    view.update({
      positions,
      bones: bonesOf(skeleton.rig),
      thickness: data.thickness,
      color: data.color,
      jointRadius: data.thickness * 1.3,
      targets: showControls ? controls.slice(0, 6) : [],
      poles: showControls
        ? [
            { at: controls[6], joint: positions[joint.elbow[0]] },
            { at: controls[7], joint: positions[joint.elbow[1]] },
            { at: controls[8], joint: positions[joint.knee[0]] },
            { at: controls[9], joint: positions[joint.knee[1]] },
          ]
        : [],
      markerSize: 0.03 * height,
      circles: toBoolean(params.showCircles)
        ? restFeet.map((f) => ({ center: new THREE.Vector3(f.x, 0.001, f.z), radius: gaitParams.stepRadius / unit }))
        : undefined,
    });

    group.updateMatrixWorld(true);
    const world = positions.map((p) => p.clone().applyMatrix4(body));
    return { geometry: group, matrix: body, feet: feetWorld, joints: world, bones: boneMatrices(skeleton.rig, world) };
  },
};

export const RIG_NODES: NodeDefinition[] = [RIG_HUMAN_NODE, RIG_POLYPEDE_NODE, RIG_POLYPEDE_MOTION_NODE, RIG_BIPED_MOTION_NODE];
