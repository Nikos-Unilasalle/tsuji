import * as THREE from "three";
import { EvalContext, NodeDefinition, ParamFieldDef } from "../types";
import { SocketDef } from "../sockets";
import { growingSockets } from "../dynamicInputs";
import type { HumanSkeleton } from "../ik/skeletons";
import { evaluateKeyframeValue } from "../evaluate";
import { createNodeCache } from "../nodeCaches";
import { NATIVE_TRANSFORM_PARAM_FIELDS, numberInput } from "./object";
import { toBoolean } from "../sockets";
import { footPivot, FootRoll, solveHuman } from "../ik/skeletons";
import { publishRig } from "../ik/skinning";
import { idleSwayOffset } from "../ik/bipedStyle";
import { boneMatrices, bonesOf, drawEmpty, HumanRigData, motionClock, parentsOf, placeGroup, TRANSFORM_DEFAULTS, viewFor } from "./rig";
import { armWave, BodyMetrics, bodyMetrics, GaitSolution, GaitStyle, GRAVITY, NATURAL_STYLE, pelvisMotion, preferredSpeed, solveGait, strideSink, wantsToRun } from "../ik/gaitModel";
import { GAIT_PRESET_KEYS, GAIT_PRESETS, GaitMode, GaitPresetKey, presetStyle } from "../ik/gaitPresets";
import { BipedGaitState, createBipedGait, stepBipedGait } from "../ik/bipedGait";
import { blendPose, HumanPose, readHumanPose, readPoseList, turnQuaternion } from "../ik/humanPose";
import { readRouteMarks } from "../ik/route";
import { marksWithWalkSpeeds, readSavedWalks, routeWalkSchedule } from "./bipedWalks";
import { holdRoutePose, readRoutePoints, routeBodyAt, RouteHandleContext, routeGuides, routeHandleContext, routeHandlePatch, routePlanFor } from "./bipedRoute";
import { armPose, buildGaitGuides, GAIT_HANDLE_AXES, HANDLE_COLORS, GaitHandleContext, gaitHandlePatch, handleContextFor } from "./bipedHandles";

/**
 * Biped Motion: walks (or runs) a Human Skeleton from equations — see
 * gaitModel.ts for the physics, bipedGait.ts for the feet, bipedHandles.ts
 * for the viewport handles that edit it.
 *
 * Every style parameter is relative to the natural gait of the wired
 * skeleton: its hip height sets the stride and cadence (Froude scaling), its
 * hip width the step width and sway, its arm length the hand's arc. So a
 * fresh node already walks right for whatever proportions it is given, and
 * the presets carry over to any body.
 *
 * Locomotion:
 * - **Follow** — the body goes where the node's pose puts it (its transform,
 *   a gizmo drag, a Follow Path upstream); the gait reads the speed, turn
 *   rate and acceleration off that motion.
 * - **Drive** — the node walks itself forward at Speed, turning at Turn Rate.
 * - **In Place** — the same, on a treadmill: the body stays put, the feet
 *   slide back under it (loops, game cycles).
 *
 * Clock: on the Timeline (the default) the walk is a function of the frame —
 * replayed in fixed steps from frame 0 and kept frame by frame, so scrubbing,
 * looping and exporting all give the same walk (see runTimeline). Live runs on
 * the wall clock instead, like Polypede Motion, and keeps walking while paused:
 * for dragging the body around by hand. Either resets with Reset Simulations.
 */

const STYLE_KEYS = Object.keys(NATURAL_STYLE) as (keyof GaitStyle)[];

const FIXED_INPUTS: SocketDef[] = [
  { id: "skeleton", label: "Skeleton", type: "geometry", owns: true },
  { id: "matrix", label: "Matrix", type: "matrix" },
  { id: "speed", label: "Speed (m/s)", type: "value" },
  { id: "turnRate", label: "Turn Rate (°/s)", type: "value" },
  { id: "influence", label: "Influence", type: "value" },
];
const poseSocket = (i: number): SocketDef => ({ id: `pose${i}`, label: `Pose ${i + 1}`, type: "list" });
const LOCOMOTION = ["follow", "drive", "inPlace", "route"] as const;
type Locomotion = (typeof LOCOMOTION)[number];

interface BipedState {
  key: string;
  epoch: number;
  gait: BipedGaitState;
  lastTime: number | null;
  clock: "wall" | "graph";
  prevPos: THREE.Vector3 | null;
  prevForward: THREE.Vector3 | null;
  prevTime: number;
  velocity: THREE.Vector3;
  yawRate: number;
  forwardSpeed: number;
  accel: number;
  running: boolean;
  runBlend: number;
  /** Eases 0 (standing) ↔ 1 (in stride): the gait's pelvis and arm motion fade in and out with it. */
  motion: number;
  drop: number;
  /** Drive / In Place: where the walk has taken the body, in the node's own space. */
  rootPos: THREE.Vector3;
  rootYaw: number;
  rootMatrix: THREE.Matrix4;
}

const bipedStates = createNodeCache<Map<string, BipedState>>();

/** What the viewport reads to place the handles and fill the HUD. */
const handleContexts = createNodeCache<GaitHandleContext>();
const routeContexts = createNodeCache<RouteHandleContext>();

/** Which handles the viewport shows: the route's, or the gait's. */
function handleSetOf(params: Record<string, unknown>): "gait" | "route" {
  if (params.handleSet === "gait" || params.handleSet === "route") return params.handleSet;
  return params.locomotion === "route" ? "route" : "gait";
}

export function readGaitStyle(params: Record<string, unknown>): GaitStyle {
  const style = { ...NATURAL_STYLE };
  for (const key of STYLE_KEYS) style[key] = numberInput(undefined, params[key], NATURAL_STYLE[key]);
  return style;
}

const presetParams = Object.fromEntries(
  GAIT_PRESET_KEYS.map((key) => [key, { ...presetStyle(key), gait: GAIT_PRESETS[key].gait, speed: GAIT_PRESETS[key].speed }]),
);

const STYLE_FIELDS: ParamFieldDef[] = [
  { id: "stride", label: "Stride ×", kind: "number", step: 0.05, group: "Steps" },
  { id: "contact", label: "Ground Contact ± (duty factor)", kind: "number", step: 0.02, group: "Steps" },
  { id: "stepWidth", label: "Step Width × (0 = one line)", kind: "number", step: 0.05, group: "Steps" },
  { id: "clearance", label: "Foot Lift ×", kind: "number", step: 0.05, group: "Steps" },
  { id: "swingPeak", label: "Lift Timing (0 early · 1 late)", kind: "number", step: 0.05, group: "Steps" },
  { id: "kneeOut", label: "Knees Out (°)", kind: "number", step: 2, group: "Steps" },
  { id: "heelStrike", label: "Heel Strike × (toes up landing, − on the ball)", kind: "number", step: 0.1, group: "Feet" },
  { id: "heelLift", label: "Heel Lift × (push-off)", kind: "number", step: 0.1, group: "Feet" },
  { id: "heelTime", label: "Heel Up Time × (share of stance)", kind: "number", step: 0.1, group: "Feet" },
  { id: "toeBend", label: "Toe Bend Max (°)", kind: "number", step: 5, group: "Feet" },
  { id: "limp", label: "Limp (right leg)", kind: "number", step: 0.05, group: "Steps" },
  { id: "crouch", label: "Crouch (share of hip height)", kind: "number", step: 0.02, group: "Pelvis" },
  { id: "bob", label: "Vertical Bob ×", kind: "number", step: 0.05, group: "Pelvis" },
  { id: "sway", label: "Side Sway ×", kind: "number", step: 0.05, group: "Pelvis" },
  { id: "pelvisTurn", label: "Pelvis Rotation ×", kind: "number", step: 0.1, group: "Pelvis" },
  { id: "pelvisDrop", label: "Hip Drop ×", kind: "number", step: 0.1, group: "Pelvis" },
  { id: "lean", label: "Lean (°)", kind: "number", step: 1, group: "Torso & Arms" },
  { id: "leanResponse", label: "Lean into Speed & Turns ×", kind: "number", step: 0.1, group: "Torso & Arms" },
  { id: "headStabilize", label: "Head Stabilize (0..1)", kind: "number", step: 0.05, group: "Torso & Arms" },
  { id: "armSwing", label: "Arm Swing ×", kind: "number", step: 0.05, group: "Torso & Arms" },
  { id: "armBend", label: "Elbow Bend (0..1)", kind: "number", step: 0.05, group: "Torso & Arms" },
  { id: "armForward", label: "Arms Forward (°)", kind: "number", step: 5, group: "Torso & Arms" },
  { id: "armSpread", label: "Arms Out (°)", kind: "number", step: 2, group: "Torso & Arms" },
];

/** Params of the gait before it was modelled: the reactive circle walk's keys, with their old defaults. */
const LEGACY = { stepRadius: 0.26, stepDuration: 0.34, stepHeight: 0.12, overshoot: 0.8, stanceWidth: 1, pelvisBob: 0.03, maxPelvisDrop: 0.08, toeOff: 0.08, hipSway: 0.035 };

function upgradeParams(params: Record<string, unknown>): Record<string, unknown> {
  if (!Object.keys(LEGACY).some((k) => k in params)) return params;
  const old = (k: keyof typeof LEGACY) => numberInput(undefined, params[k], LEGACY[k]);
  const next: Record<string, unknown> = { ...params };
  for (const k of Object.keys(LEGACY)) delete next[k];
  next.stride = old("stepRadius") / LEGACY.stepRadius;
  next.clearance = old("stepHeight") / LEGACY.stepHeight;
  next.stepWidth = old("stanceWidth");
  next.bob = old("pelvisBob") / LEGACY.pelvisBob;
  next.sway = old("hipSway") / LEGACY.hipSway;
  next.heelLift = old("toeOff") / LEGACY.toeOff;
  // Arm Swing was hand travel per metre of stride (0.6), Lean metres per m/s (0.08), Speed a 0..1 style.
  next.armSwing = numberInput(undefined, params.armSwing, 0.6) / 0.6;
  next.leanResponse = numberInput(undefined, params.lean, 0.08) / 0.08;
  next.lean = 0;
  next.gait = numberInput(undefined, params.speed, 0.5) >= 0.85 ? "run" : "auto";
  next.speed = 1.3;
  return next;
}

export const RIG_BIPED_MOTION_NODE: NodeDefinition = {
  type: "rig/biped-motion",
  label: "Biped Motion",
  category: "rig",
  inputs: [...FIXED_INPUTS, poseSocket(0)],
  // As many poses as are wired: each a Biped Pose's Pose output, for a route stop to hold.
  dynamicInputs: (connections) => [...FIXED_INPUTS, ...growingSockets(connections, "pose", poseSocket)],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Body Matrix", type: "matrix" },
    { id: "feet", label: "Feet", type: "list" },
    { id: "joints", label: "Joints", type: "list" },
    { id: "bones", label: "Bone Matrices", type: "list" },
    { id: "phase", label: "Stride Phase", type: "value" },
    { id: "gaitSpeed", label: "Speed (m/s)", type: "value" },
  ],
  defaultParams: {
    ...TRANSFORM_DEFAULTS,
    preset: "natural",
    influence: 1,
    clock: "timeline",
    locomotion: "follow",
    route: [],
    routeMarks: [],
    myWalks: [],
    runSpeed: 2.8,
    handleSet: "auto",
    speed: 1.3,
    turnRate: 0,
    gait: "auto",
    transitionFroude: 0.5,
    ...NATURAL_STYLE,
    showGuides: true,
    showCircles: false,
    showControls: false,
  },
  paramFields: [
    ...NATIVE_TRANSFORM_PARAM_FIELDS,
    {
      id: "preset",
      label: "Preset",
      kind: "select",
      options: [...GAIT_PRESET_KEYS, "custom"],
      optionLabels: [...GAIT_PRESET_KEYS.map((k) => GAIT_PRESETS[k].label), "Custom"],
      presets: presetParams,
      group: "Gait",
    },
    { id: "influence", label: "Influence (over the pose wired in)", kind: "number", step: 0.05, percent: true, group: "Gait" },
    {
      id: "locomotion",
      label: "Locomotion",
      kind: "select",
      options: [...LOCOMOTION],
      optionLabels: ["Follow the body's motion", "Drive: walk forward on its own", "In Place (treadmill)", "Route: walk the route drawn in the viewport"],
      group: "Gait",
    },
    {
      id: "clock",
      label: "Clock",
      kind: "select",
      options: ["timeline", "live"],
      optionLabels: ["Timeline: replayed from frame 0, scrub and export exactly", "Live: real time, walks while paused (drag the body around)"],
      group: "Gait",
    },
    { id: "speed", label: "Speed (m/s, Drive · In Place)", kind: "number", step: 0.1, group: "Gait" },
    { id: "turnRate", label: "Turn Rate (°/s, Drive)", kind: "number", step: 5, group: "Gait" },
    { id: "runSpeed", label: "Run Speed (m/s, Route)", kind: "number", step: 0.1, group: "Gait" },
    {
      id: "handleSet",
      label: "Handles",
      kind: "select",
      options: ["auto", "gait", "route"],
      optionLabels: ["Auto (the route's in Route, else the gait's)", "Gait", "Route"],
      group: "Display",
    },
    { id: "gait", label: "Gait", kind: "select", options: ["auto", "walk", "run"], optionLabels: ["Auto (walk, run past the transition)", "Always walk", "Always run"], group: "Gait" },
    { id: "transitionFroude", label: "Walk → Run at Froude", kind: "number", step: 0.05, group: "Gait" },
    ...STYLE_FIELDS,
    { id: "showGuides", label: "Show Gait Handles & Guides", kind: "boolean", group: "Display" },
    { id: "showCircles", label: "Show Footprints", kind: "boolean", group: "Display" },
    { id: "showControls", label: "Show IK Controls", kind: "boolean", group: "Display" },
  ],
  upgradeParams,
  paramHandleAxes: (index, params) => (handleSetOf(params) === "route" ? ["x", "z"] : (GAIT_HANDLE_AXES[index] ?? ["x", "y", "z"])),
  paramHandles: (index, position, params, nodeId) => {
    if (handleSetOf(params) === "route") {
      const route = routeContexts.get(nodeId);
      return route ? routeHandlePatch(route, index, position) : null;
    }
    const context = handleContexts.get(nodeId);
    const patch = context ? gaitHandlePatch(context, index, position, readGaitStyle(params)) : null;
    // Tweaking a saved walk keeps it selected, so ↻ can update it.
    if (patch && String(params.preset ?? "").startsWith("mine:")) delete patch.preset;
    return patch;
  },
  evaluate: (inputs, params, ctx) => {
    const view = viewFor(ctx.nodeId);
    const group = view.group;
    const locomotion: Locomotion = LOCOMOTION.includes(params.locomotion as Locomotion) ? (params.locomotion as Locomotion) : "follow";
    const driven = locomotion !== "follow";

    let sessions = bipedStates.get(ctx.nodeId);
    if (!sessions) {
      sessions = new Map();
      bipedStates.set(ctx.nodeId, sessions);
    }
    const sessionKey = `${ctx.sessionId ?? ""}|${ctx.evalScope ?? ""}`;
    const previous = sessions.get(sessionKey);
    // While the gizmo drags a driven body, the group carries base × root: take the root back off.
    const dragging = ctx.nodeId === ctx.liveEditNodeId;
    placeGroup(group, inputs, params, ctx.nodeId, ctx.liveEditNodeId);
    const base = dragging && previous && (locomotion === "drive" || locomotion === "route") ? group.matrix.clone().multiply(previous.rootMatrix.clone().invert()) : group.matrix.clone();

    const source = inputs.skeleton instanceof THREE.Object3D ? inputs.skeleton : null;
    const data = source?.userData.humanRig as HumanRigData | undefined;
    if (!data) {
      drawEmpty(view);
      handleContexts.delete(ctx.nodeId);
      return { geometry: group, matrix: base, feet: [], joints: [], bones: [], phase: 0, gaitSpeed: 0 };
    }
    const { skeleton } = data;
    const rc = skeleton.relaxedControls;
    const metrics = bodyMetrics(skeleton);
    const style = readGaitStyle(params);
    const ankleY = rc[4].y;

    const epoch = ctx.simulationEpoch ?? 0;
    const cfg: AdvanceConfig = {
      data,
      metrics,
      style,
      locomotion,
      mode: params.gait === "walk" || params.gait === "run" ? params.gait : "auto",
      transitionFroude: numberInput(undefined, params.transitionFroude, 0.5),
    };
    const driveSpeed = numberInput(inputs.speed, params.speed, 1.3);
    const turnRate = (numberInput(inputs.turnRate, params.turnRate, 0) * Math.PI) / 180;
    const frame = ctx.currentFrame ?? -1;
    const fps = Number(ctx.fps) > 0 ? Number(ctx.fps) : 0;
    const onTimeline = params.clock !== "live" && frame >= 0 && fps > 0;

    // Route: the body is wherever the planned route has it at this time — a pure function of it.
    const baseScale = new THREE.Vector3().setFromMatrixScale(base);
    const baseUnit = Math.max(1e-6, (baseScale.x + baseScale.y + baseScale.z) / 3);
    const routePoints = readRoutePoints(params.route);
    const routeMarks = readRouteMarks(params.routeMarks);
    // Walk / Run marks may hand over to another walk — a preset or one saved on the node — whose speed they take unless they set one.
    const savedWalks = readSavedWalks(params.myWalks);
    const hipWorld = metrics.hipHeight * baseUnit;
    const plannedMarks = marksWithWalkSpeeds(routeMarks, savedWalks, hipWorld).map((m) => ({ ...m, speed: (Number(m.speed) || 0) / baseUnit }));
    const plan =
      locomotion === "route"
        ? routePlanFor(ctx.nodeId, routePoints, plannedMarks, Math.abs(driveSpeed) / baseUnit, Math.abs(numberInput(undefined, params.runSpeed, 2.8)) / baseUnit)
        : null;
    const walkAt = plan ? routeWalkSchedule(routeMarks, plan.markTimes, style, savedWalks, hipWorld) : null;
    const routeInput = (time: number): FrameInput => {
      const at = routeBodyAt(plan!, time);
      const walk = walkAt!(time);
      return { base, speed: at.sample.speed * baseUnit, turnRate: at.yawRate, root: at.matrix, style: walk.style, styleKey: walk.key };
    };
    const routeTime = onTimeline ? frame / fps : ctx.time;
    const input: FrameInput = plan ? routeInput(routeTime) : { base, speed: driveSpeed, turnRate };
    const routeNow = plan ? plan.sample(routeTime) : null;
    let out: AdvanceOut;
    let state: BipedState;
    let now: number;
    if (onTimeline) {
      const routeKey = plan ? JSON.stringify([routePoints.map((p) => [p.x, p.z]), routeMarks, driveSpeed, params.runSpeed, savedWalks]) : "";
      const simKey = `${data.key}|${locomotion}|${fps}|${JSON.stringify(style)}|${cfg.mode}|${cfg.transitionFroude}|${epoch}|${routeKey}`;
      const estimate = plan ? (j: number) => routeInput(j / fps) : estimateInput(ctx, params, input);
      const run = runTimeline(ctx.nodeId, `${ctx.sessionId ?? ""}|${ctx.evalScope ?? ""}`, simKey, frame, fps, input, cfg, estimate);
      out = run.out;
      state = run.state;
      now = frame / fps;
    } else {
      const live = motionClock(ctx);
      now = live.now;
      const stateKey = `${data.key}|${locomotion}`;
      state = previous && previous.key === stateKey && previous.epoch === epoch ? previous : createState(stateKey, epoch, base, rc, ankleY, now, live.clock, params.gait === "run");
      sessions.set(sessionKey, state);
      if (state.clock !== live.clock) {
        state.clock = live.clock;
        state.lastTime = null;
      }
      // Clamped: a tab in the background or a stalled frame must not take a whole stride at once.
      const dt = state.lastTime === null ? 0 : Math.max(0, Math.min(0.1, now - state.lastTime));
      state.lastTime = now;
      out = advance(state, input, cfg, dt, now, 1 / 30);
    }
    const { body, display, sol, stepped, speedSk, unit } = out;
    const active = stepped.active;
    const phase = state.gait.phase;
    group.matrix.copy(display);
    group.matrixWorldNeedsUpdate = true;
    const toLocal = body.clone().invert();

    const gaitPose = out.gaitPose;
    // Influence: how much of the walk goes over the pose wired in (a Human Skeleton's, or a Biped Pose's).
    const influence = Math.max(0, Math.min(1, numberInput(inputs.influence, params.influence, 1)));
    const upstream = readHumanPose(source) ?? { controls: skeleton.relaxedControls, pelvisRotation: new THREE.Quaternion() };
    const walked = influence >= 1 ? gaitPose : blendPose(upstream, gaitPose, () => influence, influence);
    // A stop on the route holding a pose eases into it and out again.
    const pose =
      routeNow && routeNow.holding >= 0
        ? holdRoutePose(ctx.nodeId, skeleton, data.key, walked, readHumanPose(source), wiredPoses(inputs, skeleton), routeMarks[routeNow.holding], routeNow.poseWeight)
        : walked;
    const positions = solveHuman(skeleton, pose.controls, { armPull: data.armPull, ...data.solver, pelvisRotation: pose.pelvisRotation, feet: pose.feet });

    // Handles and guides at a reference speed: the walk as it is now, or the one it would be at its usual pace.
    const refSpeed = driven ? Math.abs(driveSpeed) / unit : Math.max(speedSk, preferredSpeed(metrics) / Math.sqrt(unit));
    const refSol = solveGait(metrics, style, refSpeed, state.runBlend, unit);
    const handleContext = handleContextFor(skeleton, metrics, style, refSol, unit);
    handleContexts.set(ctx.nodeId, handleContext);
    const showGuides = params.showGuides === undefined ? true : toBoolean(params.showGuides);
    const routeHandles = handleSetOf(params) === "route";
    const routeContext = routeHandles ? routeHandleContext(routePoints, routeMarks, plan ?? routePlanFor(ctx.nodeId, routePoints, routeMarks, 1, 1), base, display) : null;
    if (routeContext) routeContexts.set(ctx.nodeId, routeContext);
    else routeContexts.delete(ctx.nodeId);
    const routeDrawn = routeContext && showGuides ? routeGuides(routeContext, routeNow?.s ?? 0) : null;

    const showControls = toBoolean(params.showControls);
    const { joint } = skeleton;
    view.update({
      positions,
      bones: bonesOf(skeleton.rig),
      thickness: data.thickness,
      color: data.color,
      jointRadius: data.thickness * 1.3,
      targets: showControls ? pose.controls.slice(0, 6) : [],
      poles: showControls
        ? [
            { at: pose.controls[6], joint: positions[joint.elbow[0]] },
            { at: pose.controls[7], joint: positions[joint.elbow[1]] },
            { at: pose.controls[8], joint: positions[joint.knee[0]] },
            { at: pose.controls[9], joint: positions[joint.knee[1]] },
          ]
        : [],
      markerSize: 0.03 * metrics.height,
      circles: toBoolean(params.showCircles)
        ? stepped.feet.map((f) => {
            const at = f.target.clone().applyMatrix4(toLocal);
            return { center: new THREE.Vector3(at.x, 0.002, at.z), radius: 0.045 * metrics.height };
          })
        : undefined,
      paths: routeDrawn ? routeDrawn.paths : showGuides ? buildGaitGuides(handleContext, positions[joint.pelvis], positions[joint.head]) : [],
      knobs: routeDrawn ? routeDrawn.knobs : showGuides ? handleContext.handles.map((at, i) => ({ at, color: HANDLE_COLORS[i] })) : [],
      // Route balls are seen across the whole route, not up close on the body: sized to it.
      knobRadius: routeDrawn && routeContext?.plan ? Math.max(0.022 * metrics.height, routeContext.plan.curve.length * 0.008) : 0.022 * metrics.height,
    });

    publishRig(group, parentsOf(skeleton.rig), skeleton.rig.rest, positions, display, skeleton.names);
    group.userData.humanRig = data;
    group.userData.humanPose = { controls: pose.controls, pelvisRotation: pose.pelvisRotation, feet: pose.feet, matrix: display.clone() } satisfies HumanPose;
    group.updateMatrixWorld(true);
    const world = positions.map((p) => p.clone().applyMatrix4(display));
    return {
      geometry: group,
      matrix: display.clone(),
      feet: [pose.controls[4], pose.controls[5]].map((f) => f.clone().applyMatrix4(display)),
      joints: world,
      bones: boneMatrices(skeleton.rig, world),
      phase,
      gaitSpeed: speedSk * unit,
      // Not sockets: the viewport's gait handles (positions in the body's space) and the HUD readout.
      __controlPoints: !showGuides ? [] : routeContext ? routeContext.handles : handleContext.handles,
      __gaitInfo: {
        ...gaitInfo(active, sol.froude, stepped.standing, state, metrics, unit, locomotion),
        poseInputs: wiredPoses(inputs, skeleton).map((p) => p !== null),
        route: plan
          ? {
              at: plan.curve.length > 0 ? (routeNow?.s ?? 0) / plan.curve.length : 0,
              length: plan.curve.length * baseUnit,
              duration: plan.duration,
              markTimes: plan.markTimes,
              holding: routeNow?.holding ?? -1,
              time: routeTime,
            }
          : null,
      },
    };
  },
};


// ---------------------------------------------------------------------------
// One step of the walk, and the timeline that replays it

/** What drives the body at one frame: the node's own pose (the body in Follow), and the Drive speed and turn. */
interface FrameInput {
  base: THREE.Matrix4;
  speed: number;
  /** Radians per second. */
  turnRate: number;
  /** Route: the body's place in the node's space, given rather than integrated. */
  root?: THREE.Matrix4;
  /** Route: the walk at this moment, when a mark has handed over to another; `styleKey` names it for comparison. */
  style?: GaitStyle;
  styleKey?: string;
}

interface AdvanceConfig {
  data: HumanRigData;
  metrics: BodyMetrics;
  style: GaitStyle;
  locomotion: Locomotion;
  mode: GaitMode;
  transitionFroude: number;
}

interface AdvanceOut {
  body: THREE.Matrix4;
  display: THREE.Matrix4;
  sol: GaitSolution;
  stepped: ReturnType<typeof stepBipedGait>;
  feet: THREE.Vector3[];
  gaitPose: { controls: THREE.Vector3[]; pelvisRotation: THREE.Quaternion; feet?: FootRoll[] };
  speedSk: number;
  unit: number;
}

function createState(key: string, epoch: number, base: THREE.Matrix4, rc: THREE.Vector3[], ankleY: number, now: number, clock: "wall" | "graph", running: boolean): BipedState {
  return {
    key,
    epoch,
    gait: createBipedGait(
      [0, 1].map((s) => new THREE.Vector3(rc[4 + s].x, ankleY, 0).applyMatrix4(base)),
      new THREE.Vector3(0, 0, 1).transformDirection(base),
    ),
    lastTime: null,
    clock,
    prevPos: null,
    prevForward: null,
    prevTime: now,
    velocity: new THREE.Vector3(),
    yawRate: 0,
    forwardSpeed: 0,
    accel: 0,
    running,
    runBlend: running ? 1 : 0,
    motion: 0,
    drop: -1,
    rootPos: new THREE.Vector3(),
    rootYaw: 0,
    rootMatrix: new THREE.Matrix4(),
  };
}

function cloneState(s: BipedState): BipedState {
  return {
    ...s,
    gait: {
      phase: s.gait.phase,
      standing: s.gait.standing,
      feet: s.gait.feet.map((f) => ({ ...f, planted: f.planted.clone(), liftOff: f.liftOff.clone(), target: f.target.clone(), heading: f.heading.clone() })) as BipedGaitState["feet"],
    },
    prevPos: s.prevPos?.clone() ?? null,
    prevForward: s.prevForward?.clone() ?? null,
    velocity: s.velocity.clone(),
    rootPos: s.rootPos.clone(),
    rootMatrix: s.rootMatrix.clone(),
  };
}

/**
 * Moves the walk on by `dt` seconds for this frame's input: the body (carried
 * by the walk itself in Drive / In Place), its measured motion, walk or run,
 * the feet, and the pose they give. `minSample` is the shortest gap motion is
 * measured over (live, the graph can run twice in one displayed frame).
 */
function advance(state: BipedState, input: FrameInput, cfg: AdvanceConfig, dt: number, now: number, minSample: number): AdvanceOut {
  const { data, metrics, locomotion } = cfg;
  const style = input.style ?? cfg.style;
  const { skeleton } = data;
  const rc = skeleton.relaxedControls;
  const ankleY = rc[4].y;
  const driven = locomotion !== "follow";
  const base = input.base;
  const baseScale = new THREE.Vector3().setFromMatrixScale(base);
  const unit = Math.max(1e-6, (baseScale.x + baseScale.y + baseScale.z) / 3);

  // The body the gait walks: the node's pose, or that pose carried along by the walk itself.
  if (input.root) {
    state.rootMatrix.copy(input.root);
  } else if (driven && dt > 0) {
    state.rootYaw += input.turnRate * dt;
    state.rootPos.add(new THREE.Vector3(Math.sin(state.rootYaw), 0, Math.cos(state.rootYaw)).multiplyScalar((input.speed / unit) * dt));
  }
  if (!input.root) state.rootMatrix.makeRotationY(state.rootYaw).setPosition(state.rootPos);
  const body = driven ? base.clone().multiply(state.rootMatrix) : base.clone();
  const display = locomotion === "inPlace" ? base.clone() : body;

  const up = new THREE.Vector3(0, 1, 0).transformDirection(body);
  const forward = new THREE.Vector3(0, 0, 1).transformDirection(body);
  const bodyPos = new THREE.Vector3().setFromMatrixPosition(body);
  measureMotion(state, bodyPos, forward, up, now, unit, driven ? { speed: input.speed, yawRate: input.turnRate } : null, minSample);

  // Walk or run, eased over a few tenths of a second.
  const speedSk = state.velocity.length() / unit;
  const froude = (speedSk * speedSk * unit) / (GRAVITY * metrics.hipHeight);
  state.running = cfg.mode === "auto" ? wantsToRun(froude, cfg.transitionFroude, state.running) : cfg.mode === "run";
  state.runBlend += ((state.running ? 1 : 0) - state.runBlend) * Math.min(1, dt * 5);

  const sol = solveGait(metrics, style, speedSk, state.runBlend, unit);
  const settle = solveGait(metrics, style, Math.sqrt((0.05 * GRAVITY * metrics.hipHeight) / unit), 0, unit);

  const homes = [0, 1].map((s) => new THREE.Vector3((s === 0 ? 1 : -1) * (sol.stepWidth / 2), ankleY, 0).applyMatrix4(body)) as [THREE.Vector3, THREE.Vector3];
  const stepped = stepBipedGait(state.gait, {
    homes,
    pivot: new THREE.Vector3(0, ankleY, 0).applyMatrix4(body),
    up,
    velocity: state.velocity,
    yawRate: state.yawRate,
    sol,
    settle,
    unit,
    legLength: metrics.legLength,
    limp: style.limp,
    dt,
    forward: forward.clone().addScaledVector(up, -forward.dot(up)).normalize(),
  });
  state.motion += ((stepped.standing ? 0 : 1) - state.motion) * Math.min(1, dt * (stepped.standing ? 2.5 : 4));

  const toLocal = body.clone().invert();
  const feet = stepped.feet.map((f) => f.position.clone().applyMatrix4(toLocal));
  const rolls = stepped.feet.map((f) => ({ pitch: f.pitch, heading: f.heading.clone().transformDirection(toLocal).setY(0) }));
  const gaitPose = composePose({ skeleton: data, metrics, style, sol: stepped.active, state, feet, rolls, phase: state.gait.phase, now, dt, speedSk, unit });
  return { body, display, sol, stepped, feet, gaitPose, speedSk, unit };
}

/**
 * The walk on the timeline: a function of the frame, not of when it was
 * looked at. Simulated in steps of one frame from frame 0, the state after
 * each frame kept, so going back, looping or exporting replays exactly the
 * same walk; a frame is worked out from the one before it.
 *
 * What drives each frame is recorded as frames are seen. A frame not seen yet
 * is estimated (`estimate`) — exactly for Drive and In Place, whose speed and
 * turn come from the node's own params and keys, by interpolation for a body
 * moved upstream. When a frame is seen and was estimated differently,
 * everything after it is worked out again.
 */
interface TimelineSim {
  key: string;
  states: Map<number, { state: BipedState; input: FrameInput }>;
  seen: Map<number, FrameInput>;
}

const timelineSims = createNodeCache<Map<string, TimelineSim>>();
/** More than this many frames worked out at once (a jump far ahead) starts the walk over from the jump instead. */
const MAX_REPLAY = 6000;

function sameInput(a: FrameInput, b: FrameInput): boolean {
  if (Math.abs(a.speed - b.speed) > 1e-9 || Math.abs(a.turnRate - b.turnRate) > 1e-9) return false;
  if (Boolean(a.root) !== Boolean(b.root) || (a.root && !a.root.equals(b.root!))) return false;
  if ((a.styleKey ?? "") !== (b.styleKey ?? "")) return false;
  const x = a.base.elements;
  const y = b.base.elements;
  for (let i = 0; i < 16; i++) if (Math.abs(x[i] - y[i]) > 1e-7) return false;
  return true;
}

function runTimeline(
  nodeId: string,
  session: string,
  key: string,
  frame: number,
  fps: number,
  input: FrameInput,
  cfg: AdvanceConfig,
  estimate: (frame: number, seen: Map<number, FrameInput>) => FrameInput,
): { out: AdvanceOut; state: BipedState } {
  let sims = timelineSims.get(nodeId);
  if (!sims) {
    sims = new Map();
    timelineSims.set(nodeId, sims);
  }
  let sim = sims.get(session);
  if (!sim || sim.key !== key) {
    sim = { key, states: new Map(), seen: new Map() };
    sims.set(session, sim);
  }
  sim.seen.set(frame, { ...input, base: input.base.clone() });
  // Everything worked out from an estimate of this frame that turned out wrong goes.
  const kept = sim.states.get(frame);
  if (kept && !sameInput(kept.input, input)) {
    for (const f of [...sim.states.keys()]) if (f >= frame) sim.states.delete(f);
  }

  let from = frame - 1;
  while (from >= 0 && !sim.states.has(from)) from--;
  const rc = cfg.data.skeleton.relaxedControls;
  let state: BipedState;
  if (from < 0 || frame - from > MAX_REPLAY) {
    from = frame - 1 > MAX_REPLAY ? frame - 1 : -1;
    const start = from < 0 ? (frame === 0 ? input : estimate(0, sim.seen)) : input;
    state = createState(key, 0, start.base, rc, rc[4].y, (from + 1) / fps, "graph", cfg.mode === "run");
  } else {
    state = cloneState(sim.states.get(from)!.state);
  }
  let out: AdvanceOut | null = null;
  for (let j = from + 1; j <= frame; j++) {
    const at = j === frame ? input : sim.seen.get(j) ?? estimate(j, sim.seen);
    out = advance(state, at, cfg, j === from + 1 && from < 0 ? 0 : 1 / fps, j / fps, 0);
    sim.states.set(j, { state: cloneState(state), input: { ...at, base: at.base.clone() } });
  }
  return { out: out!, state };
}

/**
 * This node's input at a frame it has not been shown: speed and turn from its
 * own keys (a wired socket's value is only known where it was seen), the body
 * interpolated between the nearest frames seen.
 */
function estimateInput(ctx: EvalContext, params: Record<string, unknown>, current: FrameInput) {
  return (j: number, seen: Map<number, FrameInput>): FrameInput => {
    let before: number | null = null;
    let after: number | null = null;
    for (const f of seen.keys()) {
      if (f <= j && (before === null || f > before)) before = f;
      if (f >= j && (after === null || f < after)) after = f;
    }
    const a = before !== null ? seen.get(before)! : null;
    const b = after !== null ? seen.get(after)! : null;
    let base = current.base.clone();
    if (a && b && before !== after) base = lerpMatrix(a.base, b.base, (j - before!) / (after! - before!));
    else if (a ?? b) base = (a ?? b)!.base.clone();
    const keyed = (id: string, fallback: number) =>
      ctx.connectedInputs?.has(id) ? ((a ?? b)?.[id === "speed" ? "speed" : "turnRate"] ?? fallback) : Number(evaluateKeyframeValue(ctx.keyframes, ctx.nodeId, id, j, fallback));
    const speed = keyed("speed", numberInput(undefined, params.speed, 1.3));
    const turnDeg = ctx.connectedInputs?.has("turnRate") ? undefined : Number(evaluateKeyframeValue(ctx.keyframes, ctx.nodeId, "turnRate", j, numberInput(undefined, params.turnRate, 0)));
    const turnRate = turnDeg === undefined ? ((a ?? b)?.turnRate ?? current.turnRate) : (turnDeg * Math.PI) / 180;
    return { base, speed: Number.isFinite(speed) ? speed : current.speed, turnRate: Number.isFinite(turnRate) ? turnRate : current.turnRate };
  };
}

function lerpMatrix(a: THREE.Matrix4, b: THREE.Matrix4, t: number): THREE.Matrix4 {
  const pa = new THREE.Vector3(), qa = new THREE.Quaternion(), sa = new THREE.Vector3();
  const pb = new THREE.Vector3(), qb = new THREE.Quaternion(), sb = new THREE.Vector3();
  a.decompose(pa, qa, sa);
  b.decompose(pb, qb, sb);
  return new THREE.Matrix4().compose(pa.lerp(pb, t), qa.slerp(qb, t), sa.lerp(sb, t));
}

/** The poses wired into Pose 1, Pose 2…, by index (null where nothing usable is wired). */
function wiredPoses(inputs: Record<string, unknown>, skeleton: HumanSkeleton) {
  const out: ({ controls: THREE.Vector3[]; pelvisRotation: THREE.Quaternion } | null)[] = [];
  for (const [key, value] of Object.entries(inputs)) {
    const m = /^pose(\d+)$/.exec(key);
    if (!m) continue;
    if (!Array.isArray(value) || value.length < 10) {
      out[Number(m[1])] = null;
      continue;
    }
    const { controls, turn } = readPoseList(value, skeleton.relaxedControls);
    out[Number(m[1])] = { controls, pelvisRotation: turnQuaternion(turn) };
  }
  return Array.from(out, (p) => p ?? null);
}

/** Smoothed velocity, turn rate and forward acceleration of the body, or exactly the driven ones. */
function measureMotion(
  state: BipedState,
  pos: THREE.Vector3,
  forward: THREE.Vector3,
  up: THREE.Vector3,
  now: number,
  unit: number,
  driven: { speed: number; yawRate: number } | null,
  minSample: number,
) {
  const flatForward = forward.clone().addScaledVector(up, -forward.dot(up)).normalize();
  const elapsed = now - state.prevTime;
  if (driven) {
    const v = driven.speed;
    if (elapsed > 1e-4) state.accel += ((v - state.forwardSpeed) / elapsed - state.accel) * Math.min(1, elapsed * 4);
    state.velocity.copy(flatForward).multiplyScalar(v);
    state.yawRate = driven.yawRate;
    state.forwardSpeed = v;
    state.prevTime = now;
    state.prevPos = pos.clone();
    state.prevForward = flatForward;
    return;
  }
  // Measured over at least a thirtieth of a second: the graph can be evaluated
  // more than once per displayed frame, and a whole frame's movement over a
  // near-zero wall-clock gap reads as a huge speed.
  if (!state.prevPos || !state.prevForward || elapsed > 0.5 || elapsed < 0) {
    state.prevPos = pos.clone();
    state.prevForward = flatForward;
    state.prevTime = now;
    return;
  }
  if (elapsed < minSample) return;
  const v = pos.clone().sub(state.prevPos).divideScalar(elapsed);
  v.addScaledVector(up, -v.dot(up));
  const k = Math.min(1, elapsed * 6);
  // Faster than anyone moves is a jump (the timeline looping, a teleport): start over.
  if (v.length() / unit > 12) {
    state.velocity.set(0, 0, 0);
    state.yawRate = 0;
    state.accel = 0;
  } else {
    state.velocity.lerp(v, k);
    const turn = Math.atan2(state.prevForward.clone().cross(flatForward).dot(up), state.prevForward.dot(flatForward)) / elapsed;
    state.yawRate += (turn - state.yawRate) * k;
    const fwd = state.velocity.dot(flatForward);
    state.accel += ((fwd - state.forwardSpeed) / elapsed - state.accel) * Math.min(1, elapsed * 3);
    state.forwardSpeed = fwd;
  }
  state.prevPos = pos.clone();
  state.prevForward = flatForward;
  state.prevTime = now;
}

interface PoseInput {
  skeleton: HumanRigData;
  metrics: BodyMetrics;
  style: GaitStyle;
  sol: GaitSolution;
  state: BipedState;
  feet: THREE.Vector3[];
  /** Each foot's roll from the gait, its heading in the body's space. */
  rolls: { pitch: number; heading: THREE.Vector3 }[];
  phase: number;
  now: number;
  dt: number;
  speedSk: number;
  unit: number;
}

/** The ten IK controls, the pelvis's turn and the feet's roll for this instant of the stride, in the body's space. */
function composePose({ skeleton: data, metrics, style, sol, state, feet, rolls, phase, now, dt, speedSk, unit }: PoseInput) {
  const skeleton = data.skeleton;
  const { joint, rig } = skeleton;
  const rc = skeleton.relaxedControls;
  const h = metrics.hipHeight;
  const motion = state.motion;
  const g = GRAVITY / unit;

  // The feet roll: the ankle of each flat foot moved by its pitch about the heel or the ball, which stay down.
  // Turned out with the knees; the roll eases in and out with the stride, so a body standing stands flat.
  const pitches = rolls.map((r) => r.pitch * motion);
  const headings = rolls.map((r, s) => {
    const h = r.heading.lengthSq() > 1e-12 ? r.heading.clone().normalize() : new THREE.Vector3(0, 0, 1);
    return h.applyAxisAngle(new THREE.Vector3(0, 1, 0), ((s === 0 ? 1 : -1) * style.kneeOut * Math.PI) / 180);
  });
  const roll = (s: number, pitch: number, from: number) => {
    const a = footPivot(metrics.foot, from);
    const b = footPivot(metrics.foot, pitch);
    feet[s].addScaledVector(headings[s], b.along - a.along).y += b.up - a.up;
    pitches[s] = pitch;
  };
  for (const s of [0, 1]) roll(s, pitches[s], 0);

  const pm = pelvisMotion(sol, phase, style.limp);
  // Turning: lean into the bend, by the angle a cyclist would (atan v·ω / g).
  const bank = Math.max(-0.5, Math.min(0.5, Math.atan((speedSk * state.yawRate) / g))) * style.leanResponse;
  const accelLean = Math.atan(state.accel / unit / g) * style.leanResponse;
  const lean = Math.max(-0.6, Math.min(0.9, sol.lean + accelLean * 0.6));

  // Pelvis drop: the crouch, and just enough for both feet to stay within the hips' reach.
  const reach = metrics.legLength * 0.985;
  const hips = [0, 1].map((s) => skeleton.relaxedRest[joint.hip[s]]);
  const shortfall = (s: number, hipY: number) => {
    const flat = Math.hypot(hips[s].x - feet[s].x, hips[s].z - feet[s].z);
    const vertical = flat >= reach ? 0 : Math.sqrt(reach ** 2 - flat ** 2);
    return Math.max(0, hipY - (feet[s].y + vertical));
  };
  // The stride's own sink, eased in with the motion, then whatever a foot left somewhere odd still needs.
  const strideDrop = strideSink(sol, reach, hips[0].y - rc[4].y, Math.abs(hips[0].x - sol.stepWidth / 2)) * motion;
  const targetDrop = strideDrop + Math.min(0.12 * h, Math.max(shortfall(0, hips[0].y - sol.crouch - strideDrop), shortfall(1, hips[1].y - sol.crouch - strideDrop)));
  state.drop = state.drop < 0 || dt === 0 ? targetDrop : state.drop + (targetDrop - state.drop) * Math.min(1, dt * 12);
  const sink = sol.crouch + state.drop;
  // A planted foot still out of reach lifts its heel, as a trailing foot does: further up onto its ball.
  for (const s of [0, 1]) {
    if (state.gait.feet[s].inSwing) continue;
    const need = Math.min(0.5 * metrics.footLength, shortfall(s, hips[s].y - sink));
    if (need > 1e-6) roll(s, pitchRaising(metrics, pitches[s], need), pitches[s]);
  }

  const pelvisDelta = new THREE.Vector3(pm.side * motion + Math.sin(bank) * 0.25 * h, pm.up * motion - sink, 0);
  // A foot in the air is kept within its leg's reach: better a slightly lower arc than a leg that cannot follow it.
  for (const s of [0, 1]) {
    if (!state.gait.feet[s].inSwing) continue;
    const hip = hips[s].clone().add(pelvisDelta);
    const away = feet[s].clone().sub(hip);
    if (away.length() > reach) feet[s].copy(hip.addScaledVector(away.normalize(), reach));
  }
  const pelvisRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, pm.yaw * motion, pm.roll * motion, "YXZ"));

  const trunk = metrics.trunkLength;
  const leanOffset = new THREE.Vector3(Math.sin(bank) * trunk, -trunk * (1 - Math.cos(lean)), Math.sin(lean) * trunk);
  const headDelta = pelvisDelta.clone().setY(pelvisDelta.y + pm.up * motion * -style.headStabilize).add(leanOffset);

  // Arms: a two-bone arm swung from the shoulder, against the legs, elbows flexing as they come forward.
  const hands: THREE.Vector3[] = [];
  const elbowPoles: THREE.Vector3[] = [];
  for (const s of [0, 1] as const) {
    const side = s === 0 ? 1 : -1;
    const elbow = joint.elbow[s];
    const shoulderRest = skeleton.relaxedRest[rig.joints[elbow].parent];
    const lift = (shoulderRest.y - skeleton.relaxedRest[joint.pelvis].y) / trunk;
    const shoulder = shoulderRest
      .clone()
      .add(pelvisDelta)
      .addScaledVector(leanOffset, lift)
      // The chest turns against the pelvis.
      .add(new THREE.Vector3(0, 0, -side * pm.yaw * motion * Math.abs(shoulderRest.x) * 0.8));
    const swing = armWave(phase, s) * sol.armAngle * motion;
    const { hand, elbow: elbowAt, alpha } = armPose(metrics, style, sol, shoulder, side, swing, motion, Math.abs(Math.sin(bank)) * 0.2);
    // Standing, the hands hang and drift a little.
    hand.z += idleSwayOffset(now, s, 0.045 * (metrics.height / 1.7) * (1 - motion));
    hands.push(hand);
    elbowPoles.push(elbowAt.clone().add(new THREE.Vector3(side * 0.05, -Math.sin(alpha), -Math.cos(alpha)).multiplyScalar(0.3 * metrics.height)));
  }

  const kneePoles = [0, 1].map((s) => {
    const side = s === 0 ? 1 : -1;
    const hip = skeleton.relaxedRest[joint.hip[s]].clone().add(pelvisDelta);
    const out = new THREE.Vector3(0, 0, 0.3 * metrics.height).applyAxisAngle(new THREE.Vector3(0, 1, 0), (side * style.kneeOut * Math.PI) / 180 + pm.yaw * motion);
    return hip.add(feet[s]).multiplyScalar(0.5).add(out);
  });

  const controls = [
    rc[0].clone().add(pelvisDelta),
    rc[1].clone().add(headDelta),
    hands[0],
    hands[1],
    feet[0],
    feet[1],
    elbowPoles[0],
    elbowPoles[1],
    kneePoles[0],
    kneePoles[1],
  ];
  const footRolls: FootRoll[] = [0, 1].map((s) => ({ pitch: pitches[s], forward: headings[s], maxToeBend: sol.toeBend }));
  return { controls, pelvisRotation, feet: footRolls };
}

/** The pitch above `from` (and at least flat) that raises the ankle `raise` higher on the ball. */
function pitchRaising(metrics: BodyMetrics, from: number, raise: number): number {
  const start = Math.max(0, from);
  const want = footPivot(metrics.foot, from).up + raise;
  let lo = start;
  let hi = (80 * Math.PI) / 180;
  if (footPivot(metrics.foot, hi).up <= want) return hi;
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) / 2;
    if (footPivot(metrics.foot, mid).up < want) lo = mid;
    else hi = mid;
  }
  return Math.max(start, hi);
}

function gaitInfo(sol: GaitSolution, froude: number, standing: boolean, state: BipedState, metrics: BodyMetrics, unit: number, locomotion: Locomotion) {
  return {
    locomotion,
    state: standing ? "Standing" : state.runBlend > 0.5 ? "Running" : "Walking",
    speed: sol.speed * unit,
    measuredSpeed: state.velocity.length(),
    froude,
    cadence: standing ? 0 : sol.cadence,
    stride: sol.stride * unit,
    duty: sol.duty,
    flightTime: sol.flightTime,
    doubleSupport: sol.doubleSupport,
    /** Toes up as the heel lands, and the foot's pitch as it leaves the ground (degrees). */
    heelStrike: (sol.heelStrike * 180) / Math.PI,
    toeOff: (sol.toeOff * 180) / Math.PI,
    phase: state.gait.phase,
    /** Each foot in the air (a settling foot sitting its turn out counts as down). */
    swing: state.gait.feet.map((f) => f.inSwing && !f.skip),
    hipHeight: metrics.hipHeight * unit,
    preferredSpeed: preferredSpeed(metrics) * Math.sqrt(unit),
  };
}

/** The route's progress, for the HUD: where along it (0..1), its length (m) and duration, when each mark is reached (s). */
export interface BipedRouteInfo {
  at: number;
  length: number;
  duration: number;
  markTimes: number[];
  holding: number;
  time: number;
}

export type BipedGaitInfo = ReturnType<typeof gaitInfo> & { route?: BipedRouteInfo | null; poseInputs?: boolean[] };

/** Params a preset writes, at the speed matching this body's hip height (m). */
export function bipedPresetParams(key: GaitPresetKey, hipHeight?: number): Record<string, unknown> {
  const params: Record<string, unknown> = { ...presetParams[key], preset: key };
  if (hipHeight && hipHeight > 0) params.speed = Math.round(GAIT_PRESETS[key].speed * Math.sqrt(hipHeight / 0.95) * 100) / 100;
  return params;
}
