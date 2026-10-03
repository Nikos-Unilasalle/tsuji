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
import { IkRig } from "../ik/fabrik";

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
  };
}

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

export const RIG_NODES: NodeDefinition[] = [RIG_HUMAN_NODE, RIG_POLYPEDE_NODE, RIG_POLYPEDE_MOTION_NODE];
