import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { RIG_HUMAN_NODE } from "./rig";
import { EvalContext } from "../types";
import { buildHumanSkeleton, HUMAN_DEFAULTS, solveHuman, wristDirection, wristTurnToward } from "../ik/skeletons";

const ctx = (nodeId: string): EvalContext => ({ time: 0, step: 0, nodeId });
const turnAbout = (axis: THREE.Vector3, deg: number) => new THREE.Quaternion().setFromAxisAngle(axis.clone().normalize(), (deg * Math.PI) / 180);

describe("Human Skeleton rotate handles", () => {
  it("finds back the wrist turn a hand points with", () => {
    const skeleton = buildHumanSkeleton(HUMAN_DEFAULTS);
    const joints = solveHuman(skeleton, skeleton.restControls);
    for (const s of [0, 1] as const) {
      const pole = skeleton.restControls[6 + s];
      for (const turn of [{ flex: 30, side: 10 }, { flex: -45, side: -20 }, { flex: 0, side: 0 }]) {
        const back = wristTurnToward(skeleton, joints, pole, s, wristDirection(skeleton, joints, pole, s, turn));
        expect(back.flex).toBeCloseTo(turn.flex, 4);
        expect(back.side).toBeCloseTo(turn.side, 4);
      }
    }
  });

  it("turns a hand at its wrist, from the turn the drag began with", () => {
    const params = { ...RIG_HUMAN_NODE.defaultParams, leftWristFlex: 10 };
    const before = RIG_HUMAN_NODE.evaluate({}, params, ctx("rot-hand")).__controlPoints as THREE.Vector3[];
    const patch = RIG_HUMAN_NODE.paramHandles!(2, before[2], params, "rot-hand", turnAbout(new THREE.Vector3(1, 0, 0), 20))!;
    expect(Object.keys(patch).sort()).toEqual(["leftWristFlex", "leftWristSide"]);
    const moved = Math.abs(Number(patch.leftWristFlex) - 10) + Math.abs(Number(patch.leftWristSide));
    expect(moved).toBeGreaterThan(5);
    // The same drag again, after the pose re-solved with it, lands in the same place.
    RIG_HUMAN_NODE.evaluate({}, { ...params, ...patch }, ctx("rot-hand"));
    const again = RIG_HUMAN_NODE.paramHandles!(2, before[2], params, "rot-hand", turnAbout(new THREE.Vector3(1, 0, 0), 20))!;
    expect(Number(again.leftWristFlex)).toBeCloseTo(Number(patch.leftWristFlex), 4);
    expect(Number(again.leftWristSide)).toBeCloseTo(Number(patch.leftWristSide), 4);
  });

  it("turns the hips with the pelvis handle", () => {
    const params = { ...RIG_HUMAN_NODE.defaultParams };
    const rest = RIG_HUMAN_NODE.evaluate({}, params, ctx("rot-hips"));
    expect(RIG_HUMAN_NODE.paramHandleRotates!(0)).toBe(true);
    const patch = RIG_HUMAN_NODE.paramHandles!(0, (rest.__controlPoints as THREE.Vector3[])[0], params, "rot-hips", turnAbout(new THREE.Vector3(0, 1, 0), 30))!;
    const turn = patch.hipsTurn as THREE.Vector3;
    expect(turn.y).toBeCloseTo(30, 4);
    const turned = RIG_HUMAN_NODE.evaluate({}, { ...params, ...patch }, ctx("rot-hips"));
    const restJoints = rest.joints as THREE.Vector3[];
    const joints = turned.joints as THREE.Vector3[];
    expect(joints.some((j, i) => j.distanceTo(restJoints[i]) > 0.02)).toBe(true);
    const pose = (turned.geometry as THREE.Object3D).userData.humanPose;
    expect((pose.pelvisRotation as THREE.Quaternion).angleTo(new THREE.Quaternion())).toBeCloseTo(Math.PI / 6, 4);
  });
});
