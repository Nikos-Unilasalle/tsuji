import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { RIG_HUMAN_NODE } from "./rig";
import { RIG_BIPED_DANCE_NODE, moveAt, moveWeight, nextMove, readMoves, type DanceInfo } from "./bipedDance";
import { diceChoreography } from "./danceDice";
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

describe("next move and ghost", () => {
  const moves = readMoves([{ lane: 0, start: 4, length: 2 }, { lane: 1, start: 12, length: 1 }]);

  it("finds the next move round the loop", () => {
    expect(nextMove(moves, 1, 16)).toMatchObject({ inBeats: 3, move: { lane: 0 } });
    expect(nextMove(moves, 4, 16)).toMatchObject({ inBeats: 8, move: { lane: 1 } });
    expect(nextMove(moves, 14 + 16, 16)).toMatchObject({ inBeats: 6, move: { lane: 0 } });
    expect(nextMove([], 3, 16)).toBeNull();
  });

  it("tells the grid what comes next, skipping lanes with nothing wired", () => {
    const info = dance("bd-next", 0, { bpm: 120, moves: [{ lane: 1, start: 2, length: 1 }, { lane: 0, start: 6, length: 1 }] }, { pose0: cheer }).__danceInfo;
    expect(info.next).toEqual({ lane: 0, inBeats: 6, mirror: false });
  });

  it("draws the ghost of the next pose as a helper, and none without moves", () => {
    const ghostBones = (o: Out) => {
      const ghost = o.geometry.children.find((c) => c.userData.nodeId === "bd-ghost#ghost");
      let count = 0;
      ghost?.traverse((c) => {
        if (c instanceof THREE.InstancedMesh && c.visible) {
          count += c.count;
          expect(c.userData.isHelper).toBe(true);
        }
      });
      return count;
    };
    expect(ghostBones(dance("bd-ghost", 0, { moves: [{ lane: 0, start: 4, length: 2 }] }, { pose0: cheer }))).toBeGreaterThan(10);
    expect(ghostBones(dance("bd-ghost", 0, { moves: [] }, { pose0: cheer }))).toBe(0);
    expect(ghostBones(dance("bd-ghost", 0, { moves: [{ lane: 0, start: 4, length: 2 }], showGhost: false }, { pose0: cheer }))).toBe(0);
  });
});

describe("Dice", () => {
  it("rolls the same dance from the same seed, another from another", () => {
    expect(diceChoreography([0, 1], 16, 3)).toEqual(diceChoreography([0, 1], 16, 3));
    expect(diceChoreography([0, 1], 16, 3)).not.toEqual(diceChoreography([0, 1], 16, 4));
  });

  it("keeps every move in the loop, on a wired lane, one at a time", () => {
    for (let seed = 1; seed <= 200; seed++) {
      for (const loop of [4, 8, 16, 32]) {
        const moves = diceChoreography([0, 2], loop, seed).sort((a, b) => a.start - b.start);
        moves.forEach((m, i) => {
          expect([0, 2]).toContain(m.lane);
          expect(m.start).toBeGreaterThanOrEqual(0);
          expect(m.length).toBeGreaterThanOrEqual(1);
          expect(m.start + m.length).toBeLessThanOrEqual(loop);
          if (i > 0) expect(m.start).toBeGreaterThanOrEqual(moves[i - 1].start + moves[i - 1].length);
        });
      }
    }
  });

  it("rolls something most of the time, and nothing with no pose wired", () => {
    const filled = Array.from({ length: 50 }, (_, s) => diceChoreography([0], 16, s + 1).length > 0).filter(Boolean).length;
    expect(filled).toBeGreaterThan(45);
    expect(diceChoreography([], 16, 1)).toEqual([]);
  });
});

describe("Biped Dance live", () => {
  it("throws a pose on its Hit, on the next beat, and holds it while held", () => {
    const params = { bpm: 120, groove: 0, energy: 0, quantize: "1" };
    const id = "bd-live";
    // Frame 17 is beat 1.13 (15 frames a beat): the hit lands on beat 2.
    dance(id, 0, params, { pose0: cheer, hit0: 0 });
    const hit = dance(id, 17, params, { pose0: cheer, hit0: 1 });
    expect(hit.__danceInfo.live).toMatchObject([{ lane: 0, start: 2, end: null }]);
    const up = controlsOf(dance(id, 50, params, { pose0: cheer, hit0: 1 }));
    expect(up[CONTROL.hand[0]].y).toBeGreaterThan(skeleton.relaxedControls[CONTROL.hand[0]].y + 0.3 * H);
    // Let go at beat 7: gone by beat 9.
    dance(id, 105, params, { pose0: cheer, hit0: 0 });
    const down = controlsOf(dance(id, 135, params, { pose0: cheer, hit0: 0 }));
    expect(down[CONTROL.hand[0]].distanceTo(skeleton.relaxedControls[CONTROL.hand[0]])).toBeLessThan(1e-6);
  });

  it("mirrors a live hit while Mirror is high", () => {
    const wave = [...POSE_PRESETS.wave.build(skeleton), new THREE.Vector3()];
    const params = { bpm: 120, groove: 0, energy: 0, quantize: "0" };
    dance("bd-live-m", 0, params, { pose0: wave, hit0: 0 });
    dance("bd-live-m", 3, params, { pose0: wave, hit0: 1, mirror: 1 });
    const c = controlsOf(dance("bd-live-m", 20, params, { pose0: wave, hit0: 1, mirror: 0 }));
    expect(c[CONTROL.hand[0]].y).toBeGreaterThan(c[CONTROL.hand[1]].y + 0.2 * H);
  });

  it("puts a Hit socket beside every Pose socket", () => {
    const sockets = RIG_BIPED_DANCE_NODE.dynamicInputs!([{ id: "c", fromNode: "p", fromSocket: "pose", toNode: "d", toSocket: "pose0" }]).map((s) => s.id);
    expect(sockets.slice(-4)).toEqual(["pose0", "hit0", "pose1", "hit1"]);
    expect(sockets).toContain("mirror");
  });
});
