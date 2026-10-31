import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { buildHumanSkeleton, solveHuman } from "./skeletons";
import { mirrorJoints, mirrorPaint, mirrorVertices, PaintLayer } from "./weightPaint";
import { RIG_HUMAN_NODE } from "../nodes/rig";
import { RIG_BIPED_MOTION_NODE } from "../nodes/bipedMotion";
import { mirrorTargets, WeightTargets } from "./weightMaps";
import { EvalContext } from "../types";

const ctx = (nodeId: string): EvalContext => ({ time: 0, step: 0, nodeId });

describe("Torso Forward", () => {
  const base = buildHumanSkeleton();
  const ahead = buildHumanSkeleton({ torsoForward: 0.1 });
  const at = (sk: typeof base, name: string) => sk.rig.rest[sk.names.indexOf(name)];

  it("carries the chest, head and arms forward of a pelvis and legs that stay put", () => {
    for (const name of ["Chest", "Neck", "Head", "Left Shoulder", "Right Hand", "Left Fingers"]) {
      expect(at(ahead, name).z - at(base, name).z).toBeCloseTo(0.18, 6);
      expect(at(ahead, name).y).toBeCloseTo(at(base, name).y, 6);
    }
    for (const name of ["Pelvis", "Left Hip", "Right Knee", "Left Foot", "Right Toes"]) expect(at(ahead, name).distanceTo(at(base, name))).toBeLessThan(1e-9);
    expect(buildHumanSkeleton({ torsoForward: -0.1 }).rig.rest[ahead.joint.head].z).toBeCloseTo(-0.18, 6);
  });

  it("stands in its rest pose within its joint limits, and walks", () => {
    const solved = solveHuman(ahead, ahead.restControls);
    solved.forEach((p, i) => expect(p.distanceTo(ahead.rig.rest[i])).toBeLessThan(3e-3));
    const rig = RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams, torsoForward: 0.12 }, ctx("torso-rig")).geometry;
    const params = { ...RIG_BIPED_MOTION_NODE.defaultParams, locomotion: "drive", speed: 1.3 };
    for (let f = 0; f <= 40; f++) {
      const out = RIG_BIPED_MOTION_NODE.evaluate({ skeleton: rig }, params, { ...ctx("torso-walk"), time: f / 30, step: f, currentFrame: f, fps: 30 });
      const joints = out.joints as THREE.Vector3[];
      expect(joints.every((p) => Number.isFinite(p.x + p.y + p.z))).toBe(true);
      for (const s of [0, 1]) expect(joints[ahead.joint.foot[s]].distanceTo((out.feet as THREE.Vector3[])[s])).toBeLessThan(0.05);
    }
  });
});

describe("left ↔ right symmetry", () => {
  const skeleton = buildHumanSkeleton();

  it("pairs each joint with its counterpart, by name or else by position", () => {
    const byName = mirrorJoints(skeleton.rig.rest, skeleton.names);
    const name = (i: number) => skeleton.names[i];
    skeleton.names.forEach((n, i) => {
      expect(name(byName[i])).toBe(n.replace(/Left|Right/, (s) => (s === "Left" ? "Right" : "Left")));
    });
    // Unnamed joints: by where they stand.
    expect(mirrorJoints(skeleton.rig.rest)).toEqual(byName);
    expect(mirrorJoints([new THREE.Vector3(0, 1, 0), new THREE.Vector3(0.3, 0.5, 0), new THREE.Vector3(-0.3, 0.5, 0), new THREE.Vector3(0.9, 2, 0)])).toEqual([0, 2, 1, 3]);
  });

  it("copies a stroke across the centre onto the counterpart joint, seams included", () => {
    // A strip from x = -1 to 1, with a duplicated vertex at x = 0.5 (a seam).
    const xs = [-1, -0.5, 0, 0.5, 1, 0.5];
    const positions = xs.flatMap((x) => [x, 0, 0]);
    const mirror = mirrorVertices(positions);
    const layer: PaintLayer = new Map([[3, new Map([[1, 0.4], [2, 0.2]])]]);
    const written = mirrorPaint(layer, 3, [1, 2], mirror, [0, 1, 2, 7]);
    expect(written.sort()).toEqual([2, 3, 5]);
    expect(layer.get(7)?.get(3)).toBeCloseTo(0.4);
    expect(layer.get(7)?.get(5)).toBeCloseTo(0.4);
    expect(layer.get(7)?.get(2)).toBeCloseTo(0.2);
    // A joint on the centre line maps to itself: the stroke is mirrored onto its own other side.
    const own: PaintLayer = new Map([[0, new Map([[0, 0.3], [4, 0.1]])]]);
    mirrorPaint(own, 0, [0, 4], mirror, [0]);
    expect(own.get(0)?.get(4)).toBeCloseTo(0.3);
    expect(own.get(0)?.get(0)).toBeCloseTo(0.1);
  });

  it("copies one side's weight maps onto the other, joint to counterpart (L → R, R → L)", () => {
    // A strip from x = -1 to 1, with a duplicated vertex at x = -0.5 (a seam); left is +x.
    const xs = [-1, -0.5, 0, 0.5, 1, -0.5];
    const positions = xs.flatMap((x) => [x, 0, 0]);
    const mirror = mirrorVertices(positions);
    // Joint 1 the left knee, 2 the right, 0 the pelvis on the centre line.
    const jointMirror = [0, 2, 1];
    const targets: WeightTargets = new Map([
      [1, Uint8Array.from([0, 0, 50, 200, 255, 0])],
      [0, Uint8Array.from([10, 20, 30, 40, 50, 20])],
    ]);
    const current = (joint: number) => (joint === 2 ? 0.25 : 0);
    const toRight = mirrorTargets(targets, current, positions, mirror, jointMirror, "left");
    // The right knee takes the left knee's values, mirrored; on its own left side it keeps its weights.
    expect(Array.from(toRight.get(2)!)).toEqual([255, 200, 64, 64, 64, 200]);
    // The left knee keeps its left side and takes the right knee's on the right.
    expect(Array.from(toRight.get(1)!)).toEqual([64, 64, 50, 200, 255, 64]);
    // The pelvis maps onto itself: its left half mirrored over its right.
    expect(Array.from(toRight.get(0)!)).toEqual([50, 40, 30, 40, 50, 40]);
    const toLeft = mirrorTargets(targets, current, positions, mirror, jointMirror, "right");
    expect(Array.from(toLeft.get(0)!)).toEqual([10, 20, 30, 20, 10, 20]);
    });
});
