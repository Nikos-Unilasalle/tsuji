import * as THREE from "three";
import { NodeDefinition, ParamFieldDef } from "../types";
import { createNodeCache } from "../nodeCaches";
import { NATIVE_TRANSFORM_PARAM_FIELDS, numberInput } from "./object";
import { toBoolean } from "../sockets";
import { solveHuman } from "../ik/skeletons";
import { publishRig } from "../ik/skinning";
import { idleSwayOffset } from "../ik/bipedStyle";
import { boneMatrices, bonesOf, drawEmpty, HumanRigData, motionClock, parentsOf, placeGroup, TRANSFORM_DEFAULTS, viewFor } from "./rig";
import { armWave, BodyMetrics, bodyMetrics, GaitSolution, GaitStyle, GRAVITY, NATURAL_STYLE, pelvisMotion, preferredSpeed, solveGait, strideSink, wantsToRun } from "../ik/gaitModel";
import { GAIT_PRESET_KEYS, GAIT_PRESETS, GaitMode, GaitPresetKey, presetStyle } from "../ik/gaitPresets";
import { BipedGaitState, createBipedGait, stepBipedGait } from "../ik/bipedGait";
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
 * Real time like Polypede Motion: the feet are state, per viewport, reset by
 * Reset Simulations or when the skeleton changes.
 */

const STYLE_KEYS = Object.keys(NATURAL_STYLE) as (keyof GaitStyle)[];
const LOCOMOTION = ["follow", "drive", "inPlace"] as const;
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
  { id: "heelLift", label: "Heel Lift × (push-off)", kind: "number", step: 0.1, group: "Steps" },
  { id: "kneeOut", label: "Knees Out (°)", kind: "number", step: 2, group: "Steps" },
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
  inputs: [
    { id: "skeleton", label: "Skeleton", type: "geometry", owns: true },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "speed", label: "Speed (m/s)", type: "value" },
    { id: "turnRate", label: "Turn Rate (°/s)", type: "value" },
  ],
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
    locomotion: "follow",
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
    {
      id: "locomotion",
      label: "Locomotion",
      kind: "select",
      options: [...LOCOMOTION],
      optionLabels: ["Follow the body's motion", "Drive: walk forward on its own", "In Place (treadmill)"],
      group: "Gait",
    },
    { id: "speed", label: "Speed (m/s, Drive · In Place)", kind: "number", step: 0.1, group: "Gait" },
    { id: "turnRate", label: "Turn Rate (°/s, Drive)", kind: "number", step: 5, group: "Gait" },
    { id: "gait", label: "Gait", kind: "select", options: ["auto", "walk", "run"], optionLabels: ["Auto (walk, run past the transition)", "Always walk", "Always run"], group: "Gait" },
    { id: "transitionFroude", label: "Walk → Run at Froude", kind: "number", step: 0.05, group: "Gait" },
    ...STYLE_FIELDS,
    { id: "showGuides", label: "Show Gait Handles & Guides", kind: "boolean", group: "Display" },
    { id: "showCircles", label: "Show Footprints", kind: "boolean", group: "Display" },
    { id: "showControls", label: "Show IK Controls", kind: "boolean", group: "Display" },
  ],
  upgradeParams,
  paramHandleAxes: (index) => GAIT_HANDLE_AXES[index] ?? ["x", "y", "z"],
  paramHandles: (index, position, params, nodeId) => {
    const context = handleContexts.get(nodeId);
    return context ? gaitHandlePatch(context, index, position, readGaitStyle(params)) : null;
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
    const base = dragging && driven && previous && locomotion === "drive" ? group.matrix.clone().multiply(previous.rootMatrix.clone().invert()) : group.matrix.clone();

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
    const { now, clock } = motionClock(ctx);
    const stateKey = `${data.key}|${locomotion}`;
    let state = previous;
    if (!state || state.key !== stateKey || state.epoch !== epoch) {
      state = {
        key: stateKey,
        epoch,
        gait: createBipedGait([0, 1].map((s) => new THREE.Vector3(rc[4 + s].x, ankleY, 0).applyMatrix4(base))),
        lastTime: null,
        clock,
        prevPos: null,
        prevForward: null,
        prevTime: now,
        velocity: new THREE.Vector3(),
        yawRate: 0,
        forwardSpeed: 0,
        accel: 0,
        running: false,
        runBlend: params.gait === "run" ? 1 : 0,
        motion: 0,
        drop: -1,
        rootPos: new THREE.Vector3(),
        rootYaw: 0,
        rootMatrix: new THREE.Matrix4(),
      };
      sessions.set(sessionKey, state);
    }
    if (state.clock !== clock) {
      state.clock = clock;
      state.lastTime = null;
    }
    // Clamped: a tab in the background or a stalled frame must not take a whole stride at once.
    const dt = state.lastTime === null ? 0 : Math.max(0, Math.min(0.1, now - state.lastTime));
    state.lastTime = now;

    const baseScale = new THREE.Vector3().setFromMatrixScale(base);
    const unit = Math.max(1e-6, (baseScale.x + baseScale.y + baseScale.z) / 3);
    const driveSpeed = numberInput(inputs.speed, params.speed, 1.3);
    const turnRate = (numberInput(inputs.turnRate, params.turnRate, 0) * Math.PI) / 180;

    // The body the gait walks: the node's pose, or that pose carried along by the walk itself.
    if (driven && dt > 0) {
      state.rootYaw += turnRate * dt;
      state.rootPos.add(new THREE.Vector3(Math.sin(state.rootYaw), 0, Math.cos(state.rootYaw)).multiplyScalar((driveSpeed / unit) * dt));
    }
    state.rootMatrix.makeRotationY(state.rootYaw).setPosition(state.rootPos);
    const body = driven ? base.clone().multiply(state.rootMatrix) : base.clone();
    const display = locomotion === "inPlace" ? base.clone() : body;
    group.matrix.copy(display);
    group.matrixWorldNeedsUpdate = true;

    const up = new THREE.Vector3(0, 1, 0).transformDirection(body);
    const forward = new THREE.Vector3(0, 0, 1).transformDirection(body);
    const bodyPos = new THREE.Vector3().setFromMatrixPosition(body);
    measureMotion(state, bodyPos, forward, up, now, unit, driven ? { speed: driveSpeed, yawRate: turnRate } : null);

    // Walk or run, eased over a few tenths of a second.
    const mode: GaitMode = params.gait === "walk" || params.gait === "run" ? params.gait : "auto";
    const speedSk = state.velocity.length() / unit;
    const froude = (speedSk * speedSk * unit) / (GRAVITY * metrics.hipHeight);
    state.running = mode === "auto" ? wantsToRun(froude, numberInput(undefined, params.transitionFroude, 0.5), state.running) : mode === "run";
    state.runBlend += ((state.running ? 1 : 0) - state.runBlend) * Math.min(1, dt * 5);

    const sol = solveGait(metrics, style, speedSk, state.runBlend, unit);
    const settle = solveGait(metrics, style, Math.sqrt((0.05 * GRAVITY * metrics.hipHeight) / unit), 0, unit);

    const homesLocal = [0, 1].map((s) => new THREE.Vector3((s === 0 ? 1 : -1) * (sol.stepWidth / 2), ankleY, 0));
    const homes = homesLocal.map((h) => h.clone().applyMatrix4(body)) as [THREE.Vector3, THREE.Vector3];
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
    });
    state.motion += ((stepped.standing ? 0 : 1) - state.motion) * Math.min(1, dt * (stepped.standing ? 2.5 : 4));
    const active = stepped.active;

    const toLocal = body.clone().invert();
    const feet = stepped.feet.map((f) => f.position.clone().applyMatrix4(toLocal));
    const phase = state.gait.phase;

    const pose = composePose({ skeleton: data, metrics, style, sol: active, state, feet, phase, now, dt, speedSk, unit });
    const positions = solveHuman(skeleton, pose.controls, { armPull: data.armPull, ...data.solver, pelvisRotation: pose.pelvisRotation });

    // Handles and guides at a reference speed: the walk as it is now, or the one it would be at its usual pace.
    const refSpeed = driven ? Math.abs(driveSpeed) / unit : Math.max(speedSk, preferredSpeed(metrics) / Math.sqrt(unit));
    const refSol = solveGait(metrics, style, refSpeed, state.runBlend, unit);
    const handleContext = handleContextFor(skeleton, metrics, style, refSol, unit);
    handleContexts.set(ctx.nodeId, handleContext);
    const showGuides = params.showGuides === undefined ? true : toBoolean(params.showGuides);

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
      paths: showGuides ? buildGaitGuides(handleContext, positions[joint.pelvis], positions[joint.head]) : [],
      knobs: showGuides ? handleContext.handles.map((at, i) => ({ at, color: HANDLE_COLORS[i] })) : [],
      knobRadius: 0.022 * metrics.height,
    });

    publishRig(group, parentsOf(skeleton.rig), skeleton.rig.rest, positions, display, skeleton.names);
    group.updateMatrixWorld(true);
    const world = positions.map((p) => p.clone().applyMatrix4(display));
    return {
      geometry: group,
      matrix: display.clone(),
      feet: feet.map((f) => f.clone().applyMatrix4(display)),
      joints: world,
      bones: boneMatrices(skeleton.rig, world),
      phase,
      gaitSpeed: speedSk * unit,
      // Not sockets: the viewport's gait handles (positions in the body's space) and the HUD readout.
      __controlPoints: showGuides ? handleContext.handles : [],
      __gaitInfo: gaitInfo(active, sol.froude, stepped.standing, state, metrics, unit, locomotion),
    };
  },
};

/** Smoothed velocity, turn rate and forward acceleration of the body, or exactly the driven ones. */
function measureMotion(
  state: BipedState,
  pos: THREE.Vector3,
  forward: THREE.Vector3,
  up: THREE.Vector3,
  now: number,
  unit: number,
  driven: { speed: number; yawRate: number } | null,
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
  if (elapsed < 1 / 30) return;
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
  phase: number;
  now: number;
  dt: number;
  speedSk: number;
  unit: number;
}

/** The ten IK controls and the pelvis's turn for this instant of the stride, in the body's space. */
function composePose({ skeleton: data, metrics, style, sol, state, feet, phase, now, dt, speedSk, unit }: PoseInput) {
  const skeleton = data.skeleton;
  const { joint, rig } = skeleton;
  const rc = skeleton.relaxedControls;
  const h = metrics.hipHeight;
  const motion = state.motion;
  const g = GRAVITY / unit;

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
  // A planted foot still out of reach lifts its heel, as a trailing foot does.
  for (const s of [0, 1]) {
    if (state.gait.feet[s].inSwing) continue;
    feet[s].y += Math.min(0.5 * metrics.footLength, shortfall(s, hips[s].y - sink));
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
  return { controls, pelvisRotation };
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
    phase: state.gait.phase,
    /** Each foot in the air (a settling foot sitting its turn out counts as down). */
    swing: state.gait.feet.map((f) => f.inSwing && !f.skip),
    hipHeight: metrics.hipHeight * unit,
    preferredSpeed: preferredSpeed(metrics) * Math.sqrt(unit),
  };
}

export type BipedGaitInfo = ReturnType<typeof gaitInfo>;

/** Params a preset writes, at the speed matching this body's hip height (m). */
export function bipedPresetParams(key: GaitPresetKey, hipHeight?: number): Record<string, unknown> {
  const params: Record<string, unknown> = { ...presetParams[key], preset: key };
  if (hipHeight && hipHeight > 0) params.speed = Math.round(GAIT_PRESETS[key].speed * Math.sqrt(hipHeight / 0.95) * 100) / 100;
  return params;
}
