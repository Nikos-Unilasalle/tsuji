import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { RIG_HUMAN_NODE } from "./rig";
import { RIG_BIPED_POSE_NODE } from "./bipedPose";
import { RIG_BIPED_MOTION_NODE } from "./bipedMotion";
import { EvalContext } from "../types";
import { HumanSkeleton, solveHuman } from "../ik/skeletons";
import { CONTROL, flipPose, mirrorPose, POSE_PRESET_KEYS, POSE_PRESETS, readHumanPose, swingControls } from "../ik/humanPose";

const ctx = (nodeId: string, extra: Partial<EvalContext> = {}): EvalContext => ({ time: 0, step: 0, nodeId, ...extra });
const humanGeometry = RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams }, ctx("bp-human")).geometry as THREE.Object3D;
const skeleton = humanGeometry.userData.humanRig.skeleton as HumanSkeleton;

type Out = Record<string, unknown> & { joints: THREE.Vector3[]; geometry: THREE.Object3D; __controlPoints: THREE.Vector3[] };
const pose = (id: string, params: Record<string, unknown>, source: THREE.Object3D = humanGeometry, extra: Partial<EvalContext> = {}) =>
  RIG_BIPED_POSE_NODE.evaluate({ skeleton: source }, { ...RIG_BIPED_POSE_NODE.defaultParams, ...params }, ctx(id, extra)) as Out;

const cheer = POSE_PRESETS.cheer.build(skeleton);

describe("pose tools", () => {
  it("mirrors one side onto the other and flips the whole pose", () => {
    const wave = POSE_PRESETS.wave.build(skeleton);
    const sym = mirrorPose(wave, "right");
    expect(sym[CONTROL.hand[0]].x).toBeCloseTo(-wave[CONTROL.hand[1]].x, 9);
    expect(sym[CONTROL.hand[0]].y).toBeCloseTo(wave[CONTROL.hand[1]].y, 9);
    const flipped = flipPose(wave);
    expect(flipped[CONTROL.hand[0]].y).toBeCloseTo(wave[CONTROL.hand[1]].y, 9);
    expect(flipPose(flipped).map((c) => c.toArray())).toEqual(wave.map((c) => c.toArray()));
  });

  it("swings a hand about its shoulder: the hand keeps its distance, the other controls stay", () => {
    const joints = solveHuman(skeleton, skeleton.relaxedControls);
    const shoulder = joints[skeleton.rig.joints[skeleton.joint.elbow[0]].parent];
    const turned = swingControls(skeleton, joints, skeleton.relaxedControls, CONTROL.hand[0], new THREE.Quaternion().setFromEuler(new THREE.Euler(-1, 0, 0)))!;
    expect(turned[CONTROL.hand[0]].distanceTo(shoulder)).toBeCloseTo(skeleton.relaxedControls[CONTROL.hand[0]].distanceTo(shoulder), 9);
    expect(turned[CONTROL.hand[0]].z).toBeGreaterThan(skeleton.relaxedControls[CONTROL.hand[0]].z + 0.1);
    expect(turned[CONTROL.foot[0]].distanceTo(skeleton.relaxedControls[CONTROL.foot[0]])).toBeLessThan(1e-9);
  });

  it("builds every preset within reach of the skeleton", () => {
    for (const key of POSE_PRESET_KEYS) {
      const controls = POSE_PRESETS[key].build(skeleton);
      const joints = solveHuman(skeleton, controls);
      for (const s of [0, 1]) {
        expect(joints[skeleton.joint.hand[s]].distanceTo(controls[CONTROL.hand[s]])).toBeLessThan(0.08);
        expect(joints[skeleton.joint.foot[s]].distanceTo(controls[CONTROL.foot[s]])).toBeLessThan(0.08);
      }
    }
  });
});

describe("Biped Pose node", () => {
  it("passes the wired pose through at 0 % and takes its own at 100 %", () => {
    const upstream = readHumanPose(humanGeometry)!;
    const none = pose("bp-0", { pointsList: cheer, influence: 0 });
    expect(readHumanPose(none.geometry)!.controls.map((c) => c.toArray())).toEqual(upstream.controls.map((c) => c.toArray()));
    const full = pose("bp-1", { pointsList: cheer, influence: 1 });
    const hand = full.joints[skeleton.joint.hand[0]];
    expect(hand.y).toBeGreaterThan(upstream.controls[CONTROL.head].y);
    const half = readHumanPose(pose("bp-half", { pointsList: cheer, influence: 0.5 }).geometry)!;
    expect(half.controls[CONTROL.hand[0]].y).toBeCloseTo((upstream.controls[CONTROL.hand[0]].y + cheer[CONTROL.hand[0]].y) / 2, 9);
  });

  it("weighs body regions apart: arms only leaves the legs to the pose wired in", () => {
    const crouch = POSE_PRESETS.crouch.build(skeleton);
    const out = readHumanPose(pose("bp-arms", { pointsList: crouch, body: 0, legs: 0 }).geometry)!;
    const upstream = readHumanPose(humanGeometry)!;
    expect(out.controls[CONTROL.pelvis].distanceTo(upstream.controls[CONTROL.pelvis])).toBeLessThan(1e-9);
    expect(out.controls[CONTROL.foot[0]].distanceTo(upstream.controls[CONTROL.foot[0]])).toBeLessThan(1e-9);
    expect(out.controls[CONTROL.hand[0]].distanceTo(crouch[CONTROL.hand[0]])).toBeLessThan(1e-9);
  });

  it("solos at 100 % while editing, whatever the influence", () => {
    const out = readHumanPose(pose("bp-solo", { pointsList: cheer, influence: 0, solo: true }).geometry)!;
    expect(out.controls[CONTROL.hand[0]].distanceTo(cheer[CONTROL.hand[0]])).toBeLessThan(1e-9);
  });

  it("stacks on a walking Biped Motion and follows its body", () => {
    let walk: THREE.Object3D | null = null;
    let last: Out | null = null;
    for (let f = 0; f <= 60; f++) {
      const params = { ...RIG_BIPED_MOTION_NODE.defaultParams, locomotion: "drive", speed: 1.3 };
      walk = RIG_BIPED_MOTION_NODE.evaluate({ skeleton: humanGeometry }, params, ctx("bp-walk", { time: f / 60, capturing: true, sessionId: "t" })).geometry as THREE.Object3D;
      last = pose("bp-over-walk", { pointsList: cheer, arms: 1, legs: 0, body: 0 }, walk);
    }
    const walkPose = readHumanPose(walk)!;
    expect(last!.geometry.matrix.equals(walkPose.matrix)).toBe(true);
    const out = readHumanPose(last!.geometry)!;
    expect(out.controls[CONTROL.foot[0]].distanceTo(walkPose.controls[CONTROL.foot[0]])).toBeLessThan(1e-9);
    expect(out.controls[CONTROL.hand[0]].distanceTo(cheer[CONTROL.hand[0]])).toBeLessThan(1e-9);
  });

  it("edits the pose from its handles: a drag moves a control, a turn of the pelvis turns the hips", () => {
    pose("bp-edit", {});
    const moved = RIG_BIPED_POSE_NODE.paramHandles!(CONTROL.hand[0], new THREE.Vector3(0.5, 1.5, 0.3), { pointsList: [] }, "bp-edit")!;
    const list = moved.pointsList as THREE.Vector3[];
    expect(list.length).toBe(11);
    expect(list[CONTROL.hand[0]].toArray()).toEqual([0.5, 1.5, 0.3]);
    const turned = RIG_BIPED_POSE_NODE.paramHandles!(CONTROL.pelvis, new THREE.Vector3(), { pointsList: list }, "bp-edit", new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.4, 0)))!;
    expect((turned.pointsList as THREE.Vector3[])[10].y).toBeCloseTo(0.4, 6);
    const hips = pose("bp-edit", { pointsList: turned.pointsList }).joints;
    const across = hips[skeleton.joint.hip[0]].clone().sub(hips[skeleton.joint.hip[1]]);
    expect(Math.abs(across.z)).toBeGreaterThan(0.05);
  });

  it("stands empty without a skeleton", () => {
    expect(RIG_BIPED_POSE_NODE.evaluate({}, { ...RIG_BIPED_POSE_NODE.defaultParams }, ctx("bp-empty")).joints).toEqual([]);
  });
});

describe("Biped Motion influence", () => {
  it("at 0 % leaves the pose wired in untouched", () => {
    let out: Record<string, unknown> = {};
    for (let f = 0; f <= 30; f++) {
      out = RIG_BIPED_MOTION_NODE.evaluate(
        { skeleton: humanGeometry },
        { ...RIG_BIPED_MOTION_NODE.defaultParams, locomotion: "drive", influence: 0 },
        ctx("bm-influence", { time: f / 60, capturing: true, sessionId: "t" }),
      );
    }
    const controls = readHumanPose(out.geometry)!.controls;
    readHumanPose(humanGeometry)!.controls.forEach((c, i) => expect(controls[i].distanceTo(c)).toBeLessThan(1e-9));
  });
});

describe("poses wired into Biped Motion", () => {
  it("grows a Pose input for every pose wired", () => {
    const sockets = (n: number) =>
      RIG_BIPED_MOTION_NODE.dynamicInputs!(Array.from({ length: n }, (_, i) => ({ id: `c${i}`, fromNode: `p${i}`, fromSocket: "pose", toNode: "m", toSocket: `pose${i}` })))
        .filter((s) => s.id.startsWith("pose"))
        .map((s) => s.label);
    expect(sockets(0)).toEqual(["Pose 1"]);
    expect(sockets(2)).toEqual(["Pose 1", "Pose 2", "Pose 3"]);
  });

  it("holds the pose wired into Pose 2 at a route stop", () => {
    const own = pose("bp-source", { pointsList: cheer }, humanGeometry, { connectedOutputs: new Set(["pose"]) });
    const list = own.pose as THREE.Vector3[];
    expect(list.length).toBe(11);
    // Used only as a source, it stands aside and out of the render.
    expect(own.geometry.matrix.elements[12]).toBeCloseTo(-1.2, 6);
    const route = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 6)];
    const marks = [{ kind: "stop", at: 0.5, hold: 2, pose: "input:1" }];
    const holding: Out[] = [];
    for (let f = 0; f <= 150; f++) {
      const out = RIG_BIPED_MOTION_NODE.evaluate(
        { skeleton: humanGeometry, pose1: list },
        { ...RIG_BIPED_MOTION_NODE.defaultParams, locomotion: "route", route, routeMarks: marks },
        ctx("bp-route-input", { time: f / 30, currentFrame: f, fps: 30, sessionId: "pi" }),
      ) as Out & { __gaitInfo: { route: { holding: number }; poseInputs: boolean[] } };
      if (out.__gaitInfo.route.holding === 0) holding.push(out);
      expect(out.__gaitInfo.poseInputs).toEqual([false, true]);
    }
    const held = holding[Math.floor(holding.length / 2)];
    expect(held).toBeDefined();
    expect(held.joints[skeleton.joint.hand[0]].y).toBeGreaterThan(held.joints[skeleton.joint.head].y);
  });
});

describe("rig objects in the output pane", () => {
  it("clone, as the camera / output view does with everything it draws", () => {
    const walk = RIG_BIPED_MOTION_NODE.evaluate(
      { skeleton: humanGeometry },
      { ...RIG_BIPED_MOTION_NODE.defaultParams },
      ctx("clone-walk", { time: 0, currentFrame: 0, fps: 30 }),
    ).geometry as THREE.Object3D;
    const posed = pose("clone-pose", { pointsList: cheer }, walk).geometry;
    for (const object of [humanGeometry, walk, posed]) {
      const copy = object.clone(true);
      expect(copy.children.length).toBe(object.children.length);
    }
    // The guides are still found on the original.
    expect(walk.userData.selectionGuides).toBeInstanceOf(THREE.Group);
  });
});
