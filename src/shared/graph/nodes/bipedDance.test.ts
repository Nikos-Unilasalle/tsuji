import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { RIG_HUMAN_NODE } from "./rig";
import { RIG_BIPED_DANCE_NODE, moveAt, moveWeight, readMoves, type DanceInfo } from "./bipedDance";
import { EvalContext } from "../types";
import { HumanSkeleton } from "../ik/skeletons";
import { CONTROL, POSE_PRESETS, readHumanPose } from "../ik/humanPose";

const ctx = (nodeId: string, frame: number): EvalContext => ({ time: frame / 30, step: frame, nodeId, currentFrame: frame, fps: 30 });
const human = RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams }, { time: 0, step: 0, nodeId: "bd-human" }).geometry as THREE.Object3D;
const skeleton = human.userData.humanRig.skeleton as HumanSkeleton;
const H = skeleton.relaxedControls[CONTROL.head].y;
// The Cheer pose, as a Biped Pose hands it on: ten controls and no pelvis turn.
const cheer = [...POSE_PRESETS.cheer.build(skeleton), new THREE.Vector3()];

type Out = Record<string, unknown> & { geometry: THREE.Object3D; beat: number; __danceInfo: DanceInfo };
const dance = (id: string, frame: number, params: Record<string, unknown> = {}, inputs: Record<string, unknown> = {}) =>
  RIG_BIPED_DANCE_NODE.evaluate({ skeleton: human, ...inputs }, { ...RIG_BIPED_DANCE_NODE.defaultParams, ...params }, ctx(id, frame)) as Out;
const controlsOf = (o: Out) => readHumanPose(o.geometry)!.controls;

describe("Biped Dance", () => {
  it("draws nothing, without throwing, when no skeleton is wired", () => {
    const out = RIG_BIPED_DANCE_NODE.evaluate({}, { ...RIG_BIPED_DANCE_NODE.defaultParams }, ctx("bd-empty", 10)) as Out;
    expect(out.joints).toEqual([]);
    expect(Number.isFinite(out.beat)).toBe(true);
  });

  it("counts beats from the tempo, on the frame", () => {
    // 120 BPM: two beats a second, 15 frames a beat at 30 fps.
    expect(dance("bd-beat", 45, { bpm: 120 }).beat).toBeCloseTo(3, 9);
    expect(dance("bd-beat", 45, { bpm: 120, offset: 1 }).beat).toBeCloseTo(4, 9);
  });

  it("grooves: the pelvis is lower on the beat than between", () => {
    const params = { bpm: 120, groove: 0 };
    const on = controlsOf(dance("bd-bounce", 60, params))[CONTROL.pelvis].y;
    const off = controlsOf(dance("bd-bounce", 67, params))[CONTROL.pelvis].y;
    expect(on).toBeLessThan(off);
  });

  it("scrubs the same: a frame gives the same body whenever it is evaluated", () => {
    const a = controlsOf(dance("bd-scrub", 77, { groove: 1 })).map((c) => c.clone());
    dance("bd-scrub", 12, { groove: 1 });
    const b = controlsOf(dance("bd-scrub", 77, { groove: 1 }));
    a.forEach((c, i) => expect(c.distanceTo(b[i])).toBeLessThan(1e-12));
  });

  it("holds a pose for its beats with the arms only, the feet still stepping", () => {
    // Step-Touch at 120 BPM; Cheer on beats 4–7 of the loop.
    const params = { bpm: 120, groove: 0, preset: "stepTouch", poseGroove: 0, moves: [{ lane: 0, start: 4, length: 4 }] };
    const inputs = { pose0: cheer };
    const held = controlsOf(dance("bd-hold", 5.5 * 15, params, inputs));
    const free = controlsOf(dance("bd-free", 5.5 * 15, { ...params, moves: [] }, inputs));
    // The hands are up where Cheer has them (carried along by the pelvis' bounce).
    const lift = held[CONTROL.hand[0]].y - free[CONTROL.hand[0]].y;
    expect(lift).toBeGreaterThan(0.3 * H);
    // The feet are exactly where the groove has them.
    for (const s of [0, 1]) expect(held[CONTROL.foot[s]].distanceTo(free[CONTROL.foot[s]])).toBeLessThan(1e-9);
    // Before the move, nothing of it.
    const before = controlsOf(dance("bd-hold", 2 * 15, params, inputs));
    const plain = controlsOf(dance("bd-free", 2 * 15, { ...params, moves: [] }, inputs));
    before.forEach((c, i) => expect(c.distanceTo(plain[i])).toBeLessThan(1e-9));
  });

  it("mirrors a move", () => {
    const wave = [...POSE_PRESETS.wave.build(skeleton), new THREE.Vector3()];
    const params = { bpm: 120, groove: 0, energy: 0, moves: [{ lane: 0, start: 0, length: 4, mirror: true }] };
    const c = controlsOf(dance("bd-mirror", 30, params, { pose0: wave }));
    // Wave raises the right hand; mirrored, the left.
    expect(c[CONTROL.hand[0]].y).toBeGreaterThan(c[CONTROL.hand[1]].y + 0.2 * H);
  });

  it("dances from the natural stance, laid over the pose wired in by its influence", () => {
    const rest = skeleton.relaxedControls;
    const still = controlsOf(dance("bd-still", 0, { energy: 0, groove: 0 }));
    still.forEach((c, i) => expect(c.distanceTo(rest[i])).toBeLessThan(1e-9));
    const bound = readHumanPose(human)!.controls;
    const off = controlsOf(dance("bd-off", 0, { energy: 0, groove: 0, influence: 0 }));
    off.forEach((c, i) => expect(c.distanceTo(bound[i])).toBeLessThan(1e-9));
  });

  it("reports the lanes wired, for the grid", () => {
    const info = dance("bd-info", 0, {}, { pose0: cheer, pose2: cheer }).__danceInfo;
    expect(info.lanes).toEqual([true, false, true]);
    expect(info.loopBeats).toBe(16);
  });
});

describe("dance moves", () => {
  it("reads only sound moves, in order", () => {
    expect(readMoves([{ lane: 0, start: 4, length: 2 }, { lane: -1, start: 0, length: 1 }, { lane: 1, start: 0, length: 0 }, null, { lane: 1, start: 1, length: 1 }])).toEqual([
      { lane: 1, start: 1, length: 1, mirror: false },
      { lane: 0, start: 4, length: 2, mirror: false },
    ]);
  });

  it("hits on its beat, eased in over the snap, and wraps round the loop", () => {
    const m = { lane: 0, start: 4, length: 2 };
    expect(moveWeight(m, 4, 16, 0.25)).toBe(1);
    expect(moveWeight(m, 3.875, 16, 0.25)).toBeCloseTo(0.5, 9);
    expect(moveWeight(m, 3.5, 16, 0.25)).toBe(0);
    expect(moveWeight(m, 6.25, 16, 0.25)).toBe(0);
    expect(moveWeight({ lane: 0, start: 0, length: 1 }, 15.875, 16, 0.25)).toBeCloseTo(0.5, 9);
  });

  it("finds the move under a cell", () => {
    const moves = readMoves([{ lane: 0, start: 2, length: 3 }]);
    expect(moveAt(moves, 0, 4)).toBe(0);
    expect(moveAt(moves, 0, 5)).toBe(-1);
    expect(moveAt(moves, 1, 3)).toBe(-1);
  });
});
