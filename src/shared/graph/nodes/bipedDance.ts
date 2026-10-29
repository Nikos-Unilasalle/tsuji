import * as THREE from "three";
import { NodeDefinition } from "../types";
import { SocketDef, toBoolean } from "../sockets";
import { growingSockets } from "../dynamicInputs";
import { createNodeCache } from "../nodeCaches";
import { createLiveState, LiveMove, LiveState, stepLive } from "./danceLive";
import { numberInput } from "./object";
import { HumanSkeleton, solveHuman, turnHead } from "../ik/skeletons";
import { publishRig } from "../ik/skinning";
import { boneMatrices, bonesOf, drawEmpty, HumanRigData, parentsOf, viewFor } from "./rig";
import { CONTROL, flipPose, HumanPose, poseMask, PoseMask, readHumanPose, readPoseList, turnQuaternion } from "../ik/humanPose";
import { GROOVE_PRESET_KEYS, GROOVE_PRESETS, GroovePresetKey, grooveControls } from "../ik/danceGroove";

/**
 * Biped Dance: a body grooving on a tempo — the pelvis bouncing and swaying,
 * shoulders, head, hands and feet on the beat (see danceGroove.ts) — with
 * poses dropped on the beat grid. A pose carries only what it moved from the
 * natural stance (see poseMask): arms raised leave the feet stepping.
 *
 * The choreography is `moves`: each one a wired pose (Pose 1, Pose 2…) held
 * from a beat for some beats, mirrored or not, round and round every Loop
 * beats. A move hits on its beat — the body gets there over the Snap before
 * it — and lets go over the Release after. A move close behind another goes
 * straight from the one pose to the next, never back through the groove.
 *
 * The head turns on its neck: the groove nods and looks around, and a pose
 * reaching out with one hand looks where that hand goes.
 *
 * Everything is a function of the frame, so a dance scrubs and exports the
 * same; Groove's drift (the human, never quite the same twice) included.
 */

export interface DanceMove {
  /** Which wired pose: 0 for Pose 1. */
  lane: number;
  /** In beats from the loop's start. */
  start: number;
  /** In beats. */
  length: number;
  mirror?: boolean;
}

export interface DanceInfo {
  /** Beats since the start (swing not applied), and where in the loop. */
  beat: number;
  loopBeats: number;
  /** Which lanes have a pose wired in, by index. */
  lanes: boolean[];
  bpm: number;
  /** Moves played live, in beats from the start (see danceLive.ts). */
  live: LiveMove[];
  /** The next move to hit, and in how many beats; null with none. */
  next: { lane: number; inBeats: number; mirror: boolean } | null;
}

const GHOST_COLOR = 0x67e8f9;
/** Live moves count from the start, never round a loop: a span no dance reaches. */
const LIVE_SPAN = 1e9;

/**
 * The next pose's ghost: a see-through cyan body inside the dancer's group,
 * a helper — drawn in the editor, left out of the render.
 */
function drawGhost(nodeId: string, group: THREE.Group, positions: THREE.Vector3[] | null, skeleton: HumanSkeleton | null, thickness: number) {
  const ghost = viewFor(`${nodeId}#ghost`);
  if (ghost.group.parent !== group) group.add(ghost.group);
  if (!positions || !skeleton) {
    drawEmpty(ghost);
    return;
  }
  ghost.update({ positions, bones: bonesOf(skeleton.rig), thickness: thickness * 0.8, color: GHOST_COLOR, jointRadius: thickness });
  ghost.group.traverse((child) => {
    // Only the bones and balls: the view also holds a body sphere it keeps hidden, which the helper flag would bring up.
    if (!(child instanceof THREE.InstancedMesh)) return;
    child.userData.isHelper = true;
    // Clicked, the ghost picks the dancer.
    child.userData.nodeId = nodeId;
    child.castShadow = false;
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      if (material.transparent) continue;
      material.transparent = true;
      material.opacity = 0.35;
      material.depthWrite = false;
      material.needsUpdate = true;
    }
  });
}

/** The move that hits next after `beat` (going round the loop), and how many beats away. */
export function nextMove(moves: DanceMove[], beat: number, loopBeats: number): { move: DanceMove; inBeats: number } | null {
  const inLoop = ((beat % loopBeats) + loopBeats) % loopBeats;
  let best: { move: DanceMove; inBeats: number } | null = null;
  for (const move of moves) {
    let d = (((move.start - inLoop) % loopBeats) + loopBeats) % loopBeats;
    if (d < 1e-9) d = loopBeats;
    if (!best || d < best.inBeats) best = { move, inBeats: d };
  }
  return best;
}

export const DANCE_MAX_LOOP = 64;

export function readMoves(value: unknown): DanceMove[] {
  if (!Array.isArray(value)) return [];
  const out: DanceMove[] = [];
  for (const m of value) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>;
    const lane = Math.round(Number(o.lane));
    const start = Number(o.start);
    const length = Number(o.length);
    if (!(lane >= 0) || !Number.isFinite(start) || !(length > 0)) continue;
    out.push({ lane, start, length, mirror: Boolean(o.mirror) });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** When a move comes in and lets go, in beats (in the loop): weight 0 up to inStart, 1 from inEnd to outStart, 0 from outEnd. */
export interface MoveWindow {
  inStart: number;
  inEnd: number;
  outStart: number;
  outEnd: number;
}

/** Smootherstep: no jolt where a transition sets off or lands. */
const ease = (t: number) => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * c * (c * (c * 6 - 15) + 10);
};
const ramp = (b: number, from: number, to: number) => (to - from < 1e-9 ? (b >= to ? 1 : 0) : ease((b - from) / (to - from)));

/**
 * Each move's window: in over `snap` up to its start, out over `release`
 * after its end — but a move following another closer than that takes over
 * from it directly, the one going as the other comes over the same beats
 * (the whole gap, at least the snap), so their weights always add to one.
 */
export function moveWindows(moves: DanceMove[], loopBeats: number, snap: number, release: number): MoveWindow[] {
  const s = Math.max(1e-3, snap);
  const r = Math.max(1e-3, release);
  const out = moves.map((m) => ({ inStart: m.start - s, inEnd: m.start, outStart: m.start + m.length, outEnd: m.start + m.length + r }));
  const order = moves.map((_, i) => i).sort((a, b) => moves[a].start - moves[b].start);
  order.forEach((bi, k) => {
    const ai = order[(k - 1 + order.length) % order.length];
    const a = moves[ai];
    const b = moves[bi];
    // The first move's forerunner is the last one, a round earlier.
    const wrap = k === 0 ? loopBeats : 0;
    const gap = b.start - (a.start + a.length - wrap);
    if (gap < -1e-9 || gap >= s + r) return;
    const span = Math.min(Math.max(s, gap), gap + a.length);
    out[bi].inStart = b.start - span;
    out[ai].outStart = b.start - span + wrap;
    out[ai].outEnd = b.start + wrap;
  });
  return out;
}

/** How much a move holds at `beat` (in the loop): eased in over `snap` beats up to its start, out over `snap` after its end, or over its `window`. */
export function moveWeight(move: DanceMove, beat: number, loopBeats: number, snap: number, window?: MoveWindow): number {
  const s = Math.max(1e-3, snap);
  const w = window ?? { inStart: move.start - s, inEnd: move.start, outStart: move.start + move.length, outEnd: move.start + move.length + s };
  // The loop wraps: a move near the end eases in from the start of the next round too.
  let total = 0;
  for (const shift of [-loopBeats, 0, loopBeats]) {
    const b = beat - shift;
    total += ramp(b, w.inStart, w.inEnd) * (1 - ramp(b, w.outStart, w.outEnd));
  }
  return Math.min(1, total);
}

interface WiredPose {
  controls: THREE.Vector3[];
  pelvisRotation: THREE.Quaternion;
  mask: PoseMask;
  /** Where the head turns in this pose (see turnHead), and how much the pose has a say over it (0..1). */
  look: THREE.Vector3;
  lookMask: number;
}

const smooth = (t: number) => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
};

/**
 * Where a pose looks: at the hand it reaches out with, when one hand went
 * well further than the other and up past the chest; chin up when both hands
 * go up over the head.
 */
export function poseLook(controls: THREE.Vector3[], rest: THREE.Vector3[], H: number): { look: THREE.Vector3; mask: number } {
  const head = controls[CONTROL.head];
  const reach = CONTROL.hand.map((h) => controls[h].distanceTo(rest[h]) / H);
  const raised = CONTROL.hand.map((h) => smooth((controls[h].y - (head.y - 0.35 * H)) / (0.15 * H)));
  const lead = reach[0] >= reach[1] ? 0 : 1;
  const one = smooth((reach[lead] - reach[1 - lead] - 0.05) / 0.2) * raised[lead];
  const to = controls[CONTROL.hand[lead]].clone().sub(head);
  const clamp = (v: number, lim: number) => Math.max(-lim, Math.min(lim, v));
  const look = new THREE.Vector3(
    clamp(-Math.atan2(to.y, Math.hypot(to.x, to.z)), 0.45) * 0.6 * one,
    clamp(Math.atan2(to.x, to.z), 1) * 0.7 * one,
    0,
  );
  const both = Math.min(raised[0], raised[1]) * smooth((Math.min(...CONTROL.hand.map((h) => controls[h].y)) - head.y) / (0.1 * H));
  look.x -= 0.25 * both;
  return { look, mask: Math.max(one, both) };
}

function wiredPoses(inputs: Record<string, unknown>, rest: THREE.Vector3[], H: number): (WiredPose | null)[] {
  const out: (WiredPose | null)[] = [];
  for (const [key, value] of Object.entries(inputs)) {
    const m = /^pose(\d+)$/.exec(key);
    if (!m) continue;
    if (!Array.isArray(value) || value.length < 10) {
      out[Number(m[1])] = null;
      continue;
    }
    const { controls, turn } = readPoseList(value, rest);
    const pelvisRotation = turnQuaternion(turn);
    const { look, mask: lookMask } = poseLook(controls, rest, H);
    out[Number(m[1])] = { controls, pelvisRotation, mask: poseMask(controls, rest, H, pelvisRotation), look, lookMask };
  }
  return Array.from(out, (p) => p ?? null);
}

function mirrored(p: WiredPose): WiredPose {
  const flip = (q: THREE.Quaternion) => new THREE.Quaternion(q.x, -q.y, -q.z, q.w);
  const swap = (w: number[]) => {
    const out = w.slice();
    for (const [l, r] of [CONTROL.hand, CONTROL.foot, CONTROL.elbowPole, CONTROL.kneePole]) [out[l], out[r]] = [w[r], w[l]];
    return out;
  };
  return {
    controls: flipPose(p.controls),
    pelvisRotation: flip(p.pelvisRotation),
    mask: { controls: swap(p.mask.controls), pelvisTurn: p.mask.pelvisTurn },
    look: new THREE.Vector3(p.look.x, -p.look.y, -p.look.z),
    lookMask: p.lookMask,
  };
}

const UPPER: readonly number[] = [CONTROL.head, ...CONTROL.hand, ...CONTROL.elbowPole];

const FIXED_INPUTS: SocketDef[] = [
  { id: "skeleton", label: "Skeleton", type: "geometry", owns: true },
  { id: "bpm", label: "BPM", type: "value" },
  { id: "energy", label: "Energy", type: "value" },
  { id: "groove", label: "Groove", type: "value" },
  { id: "head", label: "Head Turns", type: "value" },
  { id: "influence", label: "Influence", type: "value" },
];
const poseSocket = (i: number): SocketDef => ({ id: `pose${i}`, label: `Pose ${i + 1}`, type: "list" });
const hitSocket = (i: number): SocketDef => ({ id: `hit${i}`, label: `Hit ${i + 1}`, type: "value" });
const MIRROR_SOCKET: SocketDef = { id: "mirror", label: "Mirror (live)", type: "value" };
const liveStates = createNodeCache<LiveState>();
const QUANTIZE = ["0", "0.25", "0.5", "1", "2"];

export const RIG_BIPED_DANCE_NODE: NodeDefinition = {
  type: "rig/biped-dance",
  label: "Biped Dance",
  category: "rig",
  inputs: [...FIXED_INPUTS, MIRROR_SOCKET, poseSocket(0), hitSocket(0)],
  // Each pose with its Hit beside it, for playing it live.
  dynamicInputs: (connections) => [...FIXED_INPUTS, MIRROR_SOCKET, ...growingSockets(connections, "pose", poseSocket).flatMap((p, i) => [p, hitSocket(i)])],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Body Matrix", type: "matrix" },
    { id: "joints", label: "Joints", type: "list" },
    { id: "bones", label: "Bone Matrices", type: "list" },
    { id: "beat", label: "Beat", type: "value" },
  ],
  defaultParams: {
    preset: "bounce",
    bpm: 110,
    energy: 1,
    groove: 0.4,
    head: 1,
    swing: 0,
    seed: 0,
    influence: 1,
    loopBeats: 16,
    snap: 0.4,
    release: 0.75,
    poseGroove: 0.3,
    offset: 0,
    moves: [],
    diceSeed: 0,
    quantize: "1",
    hitLength: 1,
    showGhost: true,
  },
  paramFields: [
    { id: "preset", label: "Groove style", kind: "select", options: [...GROOVE_PRESET_KEYS], optionLabels: GROOVE_PRESET_KEYS.map((k) => GROOVE_PRESETS[k].label), group: "Groove" },
    { id: "bpm", label: "BPM", kind: "number", step: 1, group: "Groove" },
    { id: "energy", label: "Energy (0 still · 1 as styled · more wild)", kind: "number", step: 0.05, group: "Groove" },
    { id: "groove", label: "Groove (0 metronome · 1 human · more loose)", kind: "number", step: 0.05, group: "Groove" },
    { id: "head", label: "Head turns (0 still · 1 as styled · more wild)", kind: "number", step: 0.05, group: "Groove" },
    { id: "swing", label: "Swing (0 straight · 1 triplet)", kind: "number", step: 0.05, group: "Groove" },
    { id: "seed", label: "Seed", kind: "number", step: 1, group: "Groove" },
    { id: "offset", label: "Start (beats: shifts the downbeat)", kind: "number", step: 0.25, group: "Groove" },
    { id: "influence", label: "Influence", kind: "number", step: 0.05, percent: true, group: "Choreography" },
    { id: "loopBeats", label: "Loop (beats)", kind: "number", step: 4, group: "Choreography" },
    { id: "snap", label: "Snap (beats to hit a pose)", kind: "number", step: 0.05, group: "Choreography" },
    { id: "release", label: "Release (beats to let a pose go)", kind: "number", step: 0.05, group: "Choreography" },
    { id: "poseGroove", label: "Groove kept in a held pose", kind: "number", step: 0.05, percent: true, group: "Choreography" },
    { id: "quantize", label: "Live hits land on (beats; 0 at once)", kind: "select", options: QUANTIZE, optionLabels: ["At once", "¼ beat", "½ beat", "The beat", "Every 2 beats"], group: "Live" },
    { id: "hitLength", label: "Hit Length (beats a tap holds)", kind: "number", step: 0.25, group: "Live" },
    { id: "showGhost", label: "Ghost of the next pose (editor only)", kind: "boolean", group: "Display" },
  ],
  evaluate: (inputs, params, ctx) => {
    const view = viewFor(ctx.nodeId);
    const group = view.group;
    const source = inputs.skeleton instanceof THREE.Object3D ? inputs.skeleton : null;
    const data = source?.userData.humanRig as HumanRigData | undefined;
    const bpm = Math.max(1, Math.min(400, numberInput(inputs.bpm, params.bpm, 110)));
    const loopBeats = Math.max(1, Math.min(DANCE_MAX_LOOP, Math.round(numberInput(undefined, params.loopBeats, 16))));
    const time = (ctx.currentFrame ?? -1) >= 0 && Number(ctx.fps) > 0 ? (ctx.currentFrame as number) / Number(ctx.fps) : ctx.time;
    const beat = (time * bpm) / 60 + numberInput(undefined, params.offset, 0);
    if (!data) {
      drawEmpty(view);
      drawGhost(ctx.nodeId, group, null, null, 0);
      return { geometry: group, matrix: new THREE.Matrix4(), joints: [], bones: [], beat, __danceInfo: { beat, loopBeats, lanes: [], bpm, live: [], next: null } satisfies DanceInfo };
    }
    const { skeleton } = data;
    const rest = skeleton.relaxedControls;
    const H = Math.max(0.05, rest[CONTROL.head].y);
    const upstream = readHumanPose(source) ?? { controls: rest, pelvisRotation: new THREE.Quaternion(), matrix: source!.matrix.clone() };
    group.matrix.copy(upstream.matrix);
    group.matrixWorldNeedsUpdate = true;

    const presetKey = (GROOVE_PRESET_KEYS as string[]).includes(String(params.preset)) ? (params.preset as GroovePresetKey) : "bounce";
    const settings = {
      energy: Math.max(0, numberInput(inputs.energy, params.energy, 1)),
      groove: Math.max(0, numberInput(inputs.groove, params.groove, 0.4)),
      swing: numberInput(undefined, params.swing, 0),
      seed: numberInput(undefined, params.seed, 0),
    };
    const poses = wiredPoses(inputs, rest, H);
    const moves = readMoves(params.moves).filter((m) => poses[m.lane]);
    const snap = Math.max(0.01, numberInput(undefined, params.snap, 0.4));
    const release = Math.max(0.01, numberInput(undefined, params.release, 0.75));
    const windows = moveWindows(moves, loopBeats, snap, release);
    const headAmount = Math.max(0, numberInput(inputs.head, params.head, 1));
    const keep = Math.max(0, Math.min(1, numberInput(undefined, params.poseGroove, 0.3)));
    const influence = Math.max(0, Math.min(1, numberInput(inputs.influence, params.influence, 1)));
    const solver = { armPull: data.armPull, ...data.solver };

    // Live: the Hit sockets throw their poses now, over the choreography.
    const liveKey = `${ctx.nodeId}|${ctx.sessionId ?? ""}|${ctx.evalScope ?? ""}`;
    const liveState = liveStates.get(liveKey) ?? createLiveState();
    liveStates.set(liveKey, liveState);
    const hits = poses.map((_, i) => toBoolean(inputs[`hit${i}`] ?? 0));
    const quantize = Math.max(0, Number(params.quantize ?? 1) || 0);
    const live = stepLive(liveState, hits, toBoolean(inputs.mirror ?? 0), beat, quantize, numberInput(undefined, params.hitLength, 1), snap).filter((m) => poses[m.lane]);

    /** The body at any beat: a pure function of it, so the ghost can look ahead. */
    const danceAt = (b: number, t: number) => {
      // Like Biped Motion, the dance starts from the natural stance; Influence lays it over the pose wired in.
      const g = grooveControls(rest, H, b, t, GROOVE_PRESETS[presetKey].style, settings);
      const inLoop = ((b % loopBeats) + loopBeats) % loopBeats;
      const offsets = g.controls.map((c, i) => c.clone().sub(rest[i]));
      // What carries the upper body along: a held arm still rides the pelvis as it bounces.
      const ride = offsets[CONTROL.pelvis];
      const controls = g.controls.map((c) => c.clone());
      let pelvisRotation = g.pelvisRotation.clone();
      const look = g.look.clone();
      /** Lays moves over the body, each by its weight and only where its pose moved; moves fading into each other share it. */
      const blend = (playing: { move: DanceMove; w: number }[]) => {
        const active = playing.filter((p) => p.w > 0).map(({ move, w }) => ({ p: move.mirror ? mirrored(poses[move.lane]!) : poses[move.lane]!, w }));
        if (active.length === 0) return;
        controls.forEach((c, i) => {
          const r = UPPER.includes(i) ? ride : null;
          const sum = new THREE.Vector3();
          let total = 0;
          for (const { p, w } of active) {
            const k = w * p.mask.controls[i];
            if (k <= 0) continue;
            const target = p.controls[i].clone();
            if (r) target.add(r).addScaledVector(offsets[i].clone().sub(r), keep);
            else target.addScaledVector(offsets[i], keep);
            sum.addScaledVector(target, k);
            total += k;
          }
          if (total > 0) c.lerp(sum.divideScalar(total), Math.min(1, total));
        });
        let held: THREE.Quaternion | null = null;
        let turnTotal = 0;
        for (const { p, w } of active) {
          const k = w * p.mask.pelvisTurn;
          if (k <= 0) continue;
          const q = p.pelvisRotation.clone().multiply(new THREE.Quaternion().slerp(g.pelvisRotation, keep));
          held = held ? held.slerp(q, k / (turnTotal + k)) : q;
          turnTotal += k;
        }
        if (held) pelvisRotation = pelvisRotation.slerp(held, Math.min(1, turnTotal));
        const lookSum = new THREE.Vector3();
        let lookTotal = 0;
        for (const { p, w } of active) {
          const k = w * Math.max(p.lookMask, p.mask.controls[CONTROL.head]);
          if (k <= 0) continue;
          lookSum.addScaledVector(p.look.clone().addScaledVector(g.look, keep), k);
          lookTotal += k;
        }
        if (lookTotal > 0) look.lerp(lookSum.divideScalar(lookTotal), Math.min(1, lookTotal));
      };
      blend(moves.map((move, i) => ({ move, w: moveWeight(move, inLoop, loopBeats, snap, windows[i]) })));
      // Live hits last, on top.
      blend(
        live.map((m) => {
          // The body sets off when the hit came (at most a Snap ahead), arriving a little late when that leaves too little.
          const inStart = Math.max(m.start - snap, Math.min(m.pressed ?? m.start - snap, m.start));
          const inEnd = Math.max(m.start, inStart + 0.5 * snap);
          // Still held: it lasts until a little past now.
          const outStart = Math.max(inEnd, m.end ?? Math.max(b, inEnd) + snap);
          const move = { lane: m.lane, start: m.start, length: outStart - m.start, mirror: m.mirror };
          return { move, w: moveWeight(move, b, LIVE_SPAN, snap, { inStart, inEnd, outStart, outEnd: outStart + release }) };
        }),
      );
      const finalControls = upstream.controls.map((u, i) => u.clone().lerp(controls[i], influence));
      const finalRotation = upstream.pelvisRotation.clone().slerp(pelvisRotation, influence);
      const positions = solveHuman(skeleton, finalControls, { ...solver, pelvisRotation: finalRotation });
      const head = turnHead(skeleton, positions, look.multiplyScalar(headAmount * influence));
      return { controls: finalControls, pelvisRotation: finalRotation, positions, twist: head.twist, face: head.face };
    };

    const now = danceAt(beat, time);
    const finalControls = now.controls;
    const finalRotation = now.pelvisRotation;
    const positions = now.positions;
    const neck = positions[skeleton.rig.joints[skeleton.joint.head].parent];
    view.update({
      positions,
      bones: bonesOf(skeleton.rig),
      thickness: data.thickness,
      color: data.color,
      jointRadius: data.thickness * 1.3,
      markerSize: 0.03 * H,
      // A nose, so the head turning shows on the bones too.
      face: { at: neck.clone().lerp(positions[skeleton.joint.head], 0.55), dir: now.face, length: 0.05 * H, radius: data.thickness * 1.2 },
    });
    // The ghost: the body as it will be when the next move hits.
    const next = nextMove(moves, beat, loopBeats);
    const ghost = next && (params.showGhost === undefined || toBoolean(params.showGhost)) ? danceAt(beat + next.inBeats, time + (next.inBeats * 60) / bpm).positions : null;
    drawGhost(ctx.nodeId, group, ghost, skeleton, data.thickness);
    publishRig(group, parentsOf(skeleton.rig), skeleton.rig.rest, positions, group.matrix, skeleton.names, now.twist);
    group.userData.humanRig = data;
    group.userData.humanPose = { controls: finalControls, pelvisRotation: finalRotation, matrix: group.matrix.clone() } satisfies HumanPose;
    group.updateMatrixWorld(true);
    const world = positions.map((p) => p.clone().applyMatrix4(group.matrix));
    return {
      geometry: group,
      matrix: group.matrix.clone(),
      joints: world,
      bones: boneMatrices(skeleton.rig, world, now.twist),
      beat,
      // Not a socket: the beat grid's playhead and lanes (see DanceHud).
      __danceInfo: { beat, loopBeats, lanes: poses.map((p) => p !== null), bpm, live: live.map((m) => ({ ...m })), next: next ? { lane: next.move.lane, inBeats: next.inBeats, mirror: Boolean(next.move.mirror) } : null } satisfies DanceInfo,
    };
  },
};

/** Whether a move is on `lane` at whole beat `cell` (for the grid). */
export function moveAt(moves: DanceMove[], lane: number, cell: number): number {
  return moves.findIndex((m) => m.lane === lane && cell >= m.start && cell < m.start + m.length);
}
