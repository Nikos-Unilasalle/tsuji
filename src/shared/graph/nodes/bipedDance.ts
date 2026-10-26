import * as THREE from "three";
import { NodeDefinition } from "../types";
import { SocketDef, toBoolean } from "../sockets";
import { growingSockets } from "../dynamicInputs";
import { numberInput } from "./object";
import { HumanSkeleton, solveHuman } from "../ik/skeletons";
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
 * it — and lets go over the same after.
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
  /** The next move to hit, and in how many beats; null with none. */
  next: { lane: number; inBeats: number; mirror: boolean } | null;
}

const GHOST_COLOR = 0x67e8f9;

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

/** How much a move holds at `beat` (in the loop): eased in over `snap` beats up to its start, out over `snap` after its end. */
export function moveWeight(move: DanceMove, beat: number, loopBeats: number, snap: number): number {
  const s = Math.max(1e-3, snap);
  const ease = (t: number) => {
    const c = Math.max(0, Math.min(1, t));
    return c * c * (3 - 2 * c);
  };
  // The loop wraps: a move near the end eases in from the start of the next round too.
  let best = 0;
  for (const shift of [-loopBeats, 0, loopBeats]) {
    const b = beat - shift;
    const w = ease((b - (move.start - s)) / s) * ease((move.start + move.length + s - b) / s);
    best = Math.max(best, w);
  }
  return best;
}

interface WiredPose {
  controls: THREE.Vector3[];
  pelvisRotation: THREE.Quaternion;
  mask: PoseMask;
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
    out[Number(m[1])] = { controls, pelvisRotation, mask: poseMask(controls, rest, H, pelvisRotation) };
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
  return { controls: flipPose(p.controls), pelvisRotation: flip(p.pelvisRotation), mask: { controls: swap(p.mask.controls), pelvisTurn: p.mask.pelvisTurn } };
}

const UPPER: readonly number[] = [CONTROL.head, ...CONTROL.hand, ...CONTROL.elbowPole];

const FIXED_INPUTS: SocketDef[] = [
  { id: "skeleton", label: "Skeleton", type: "geometry", owns: true },
  { id: "bpm", label: "BPM", type: "value" },
  { id: "energy", label: "Energy", type: "value" },
  { id: "groove", label: "Groove", type: "value" },
  { id: "influence", label: "Influence", type: "value" },
];
const poseSocket = (i: number): SocketDef => ({ id: `pose${i}`, label: `Pose ${i + 1}`, type: "list" });

export const RIG_BIPED_DANCE_NODE: NodeDefinition = {
  type: "rig/biped-dance",
  label: "Biped Dance",
  category: "rig",
  inputs: [...FIXED_INPUTS, poseSocket(0)],
  dynamicInputs: (connections) => [...FIXED_INPUTS, ...growingSockets(connections, "pose", poseSocket)],
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
    swing: 0,
    seed: 0,
    influence: 1,
    loopBeats: 16,
    snap: 0.25,
    poseGroove: 0.3,
    offset: 0,
    moves: [],
    diceSeed: 0,
    showGhost: true,
  },
  paramFields: [
    { id: "preset", label: "Groove style", kind: "select", options: [...GROOVE_PRESET_KEYS], optionLabels: GROOVE_PRESET_KEYS.map((k) => GROOVE_PRESETS[k].label), group: "Groove" },
    { id: "bpm", label: "BPM", kind: "number", step: 1, group: "Groove" },
    { id: "energy", label: "Energy (0 still · 1 as styled · more wild)", kind: "number", step: 0.05, group: "Groove" },
    { id: "groove", label: "Groove (0 metronome · 1 human · more loose)", kind: "number", step: 0.05, group: "Groove" },
    { id: "swing", label: "Swing (0 straight · 1 triplet)", kind: "number", step: 0.05, group: "Groove" },
    { id: "seed", label: "Seed", kind: "number", step: 1, group: "Groove" },
    { id: "offset", label: "Start (beats: shifts the downbeat)", kind: "number", step: 0.25, group: "Groove" },
    { id: "influence", label: "Influence", kind: "number", step: 0.05, percent: true, group: "Choreography" },
    { id: "loopBeats", label: "Loop (beats)", kind: "number", step: 4, group: "Choreography" },
    { id: "snap", label: "Snap (beats to hit a pose)", kind: "number", step: 0.05, group: "Choreography" },
    { id: "poseGroove", label: "Groove kept in a held pose", kind: "number", step: 0.05, percent: true, group: "Choreography" },
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
      return { geometry: group, matrix: new THREE.Matrix4(), joints: [], bones: [], beat, __danceInfo: { beat, loopBeats, lanes: [], bpm, next: null } satisfies DanceInfo };
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
    const snap = Math.max(0.01, numberInput(undefined, params.snap, 0.25));
    const keep = Math.max(0, Math.min(1, numberInput(undefined, params.poseGroove, 0.3)));
    const influence = Math.max(0, Math.min(1, numberInput(inputs.influence, params.influence, 1)));
    const solver = { armPull: data.armPull, ...data.solver };

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
      // The moves over the groove, each by its own weight and only where its pose moved.
      for (const move of moves) {
        const w = moveWeight(move, inLoop, loopBeats, snap);
        if (w <= 0) continue;
        const p = move.mirror ? mirrored(poses[move.lane]!) : poses[move.lane]!;
        controls.forEach((c, i) => {
          const r = UPPER.includes(i) ? ride : null;
          const target = p.controls[i].clone();
          if (r) target.add(r).addScaledVector(offsets[i].clone().sub(r), keep);
          else target.addScaledVector(offsets[i], keep);
          c.lerp(target, w * p.mask.controls[i]);
        });
        const held = p.pelvisRotation.clone().multiply(new THREE.Quaternion().slerp(g.pelvisRotation, keep));
        pelvisRotation = pelvisRotation.slerp(held, w * p.mask.pelvisTurn);
      }
      const finalControls = upstream.controls.map((u, i) => u.clone().lerp(controls[i], influence));
      const finalRotation = upstream.pelvisRotation.clone().slerp(pelvisRotation, influence);
      return { controls: finalControls, pelvisRotation: finalRotation, positions: solveHuman(skeleton, finalControls, { ...solver, pelvisRotation: finalRotation }) };
    };

    const now = danceAt(beat, time);
    const finalControls = now.controls;
    const finalRotation = now.pelvisRotation;
    const positions = now.positions;
    view.update({
      positions,
      bones: bonesOf(skeleton.rig),
      thickness: data.thickness,
      color: data.color,
      jointRadius: data.thickness * 1.3,
      markerSize: 0.03 * H,
    });
    // The ghost: the body as it will be when the next move hits.
    const next = nextMove(moves, beat, loopBeats);
    const ghost = next && (params.showGhost === undefined || toBoolean(params.showGhost)) ? danceAt(beat + next.inBeats, time + (next.inBeats * 60) / bpm).positions : null;
    drawGhost(ctx.nodeId, group, ghost, skeleton, data.thickness);
    publishRig(group, parentsOf(skeleton.rig), skeleton.rig.rest, positions, group.matrix, skeleton.names);
    group.userData.humanRig = data;
    group.userData.humanPose = { controls: finalControls, pelvisRotation: finalRotation, matrix: group.matrix.clone() } satisfies HumanPose;
    group.updateMatrixWorld(true);
    const world = positions.map((p) => p.clone().applyMatrix4(group.matrix));
    return {
      geometry: group,
      matrix: group.matrix.clone(),
      joints: world,
      bones: boneMatrices(skeleton.rig, world),
      beat,
      // Not a socket: the beat grid's playhead and lanes (see DanceHud).
      __danceInfo: { beat, loopBeats, lanes: poses.map((p) => p !== null), bpm, next: next ? { lane: next.move.lane, inBeats: next.inBeats, mirror: Boolean(next.move.mirror) } : null } satisfies DanceInfo,
    };
  },
};

/** Whether a move is on `lane` at whole beat `cell` (for the grid). */
export function moveAt(moves: DanceMove[], lane: number, cell: number): number {
  return moves.findIndex((m) => m.lane === lane && cell >= m.start && cell < m.start + m.length);
}
