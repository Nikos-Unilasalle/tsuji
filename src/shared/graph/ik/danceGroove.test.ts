import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { RIG_HUMAN_NODE } from "../nodes/rig";
import { HumanSkeleton, solveHuman } from "./skeletons";
import { CONTROL } from "./humanPose";
import { footwork, GROOVE_PRESET_KEYS, GROOVE_PRESETS, grooveControls, NATURAL_GROOVE, swingBeat } from "./danceGroove";

const human = RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams }, { time: 0, step: 0, nodeId: "dg-human" }).geometry as THREE.Object3D;
const skeleton = human.userData.humanRig.skeleton as HumanSkeleton;
const rest = skeleton.relaxedControls;
const H = rest[CONTROL.head].y;
const at = (key: keyof typeof GROOVE_PRESETS, beat: number, settings = NATURAL_GROOVE, time = beat / 2) =>
  grooveControls(rest, H, beat, time, GROOVE_PRESETS[key].style, settings);

describe("dance groove", () => {
  it("stands still with no energy and no steps", () => {
    const g = at("sway", 1.3, { ...NATURAL_GROOVE, energy: 0 });
    g.controls.forEach((c, i) => expect(c.distanceTo(rest[i])).toBeLessThan(1e-12));
    expect(g.pelvisRotation.angleTo(new THREE.Quaternion())).toBeLessThan(1e-12);
  });

  it("comes round every eight beats, without groove", () => {
    for (const key of GROOVE_PRESET_KEYS) {
      for (const b of [0, 0.3, 1.7, 2.5]) {
        const a = at(key, b).controls;
        const c = at(key, b + 8).controls;
        a.forEach((p, i) => expect(p.distanceTo(c[i])).toBeLessThan(1e-9));
      }
    }
  });

  it("bounces down on the beat", () => {
    const on = at("bounce", 4).controls[CONTROL.pelvis].y;
    const off = at("bounce", 4.5).controls[CONTROL.pelvis].y;
    expect(on).toBeLessThan(off - 0.02 * H);
  });

  it("plants every foot on the beat, and never slides one that is not stepping", () => {
    for (const key of GROOVE_PRESET_KEYS) {
      for (let b = 0; b < 8; b++) {
        const g = at(key, b).controls;
        for (const s of [0, 1]) expect(g[CONTROL.foot[s]].y).toBeCloseTo(rest[CONTROL.foot[s]].y, 9);
      }
    }
    // Step-Touch: on its way out, the right foot moves and the left stays put.
    const a = at("stepTouch", -0.4).controls;
    const b = at("stepTouch", -0.1).controls;
    expect(a[CONTROL.foot[1]].distanceTo(b[CONTROL.foot[1]])).toBeGreaterThan(0.01);
    expect(a[CONTROL.foot[0]].distanceTo(b[CONTROL.foot[0]])).toBeLessThan(1e-12);
  });

  it("walks the step-touch out and back, the pelvis between the feet", () => {
    const steps = GROOVE_PRESETS.stepTouch.style.steps;
    expect(footwork(steps, 0).offset[1].x).toBeCloseTo(-0.12, 9);
    expect(footwork(steps, 1).offset[0].x).toBeCloseTo(-0.12, 9);
    expect(footwork(steps, 3).offset.every((o) => o.length() < 1e-9)).toBe(true);
    expect(at("stepTouch", 1.5).controls[CONTROL.pelvis].x).toBeCloseTo(rest[CONTROL.pelvis].x - 0.12 * H, 2);
  });

  it("alternates the hands", () => {
    const g = at("disco", 0.5).controls;
    const dy = (s: number) => g[CONTROL.hand[s]].y - rest[CONTROL.hand[s]].y;
    expect(dy(0) * dy(1)).toBeLessThan(0);
  });

  it("swings the off-beat late, and keeps the beat", () => {
    expect(swingBeat(2.5, 0)).toBe(2.5);
    expect(swingBeat(2, 1)).toBe(2);
    expect(swingBeat(2 + 0.5 + 1 / 6, 1)).toBeCloseTo(2.5, 9);
    expect(swingBeat(2.5, 1)).toBeLessThan(2.5);
  });

  it("lets Groove loosen the body, a little, but not lift the planted feet", () => {
    const tight = at("bounce", 2.25).controls;
    const loose = at("bounce", 2.25, { ...NATURAL_GROOVE, groove: 1, seed: 4 }, 7.3).controls;
    const moved = Math.max(...tight.map((c, i) => c.distanceTo(loose[i])));
    expect(moved).toBeGreaterThan(0.001);
    expect(moved).toBeLessThan(0.1 * H);
    expect(loose[CONTROL.foot[0]].y).toBeCloseTo(tight[CONTROL.foot[0]].y, 9);
  });

  it("gives every preset a pose the body can reach, feet on their marks", () => {
    for (const key of GROOVE_PRESET_KEYS) {
      for (let b = 0; b < 8; b += 0.25) {
        const g = at(key, b, { ...NATURAL_GROOVE, groove: 1 });
        const joints = solveHuman(skeleton, g.controls, { pelvisRotation: g.pelvisRotation });
        expect(joints.every((j) => Number.isFinite(j.x + j.y + j.z))).toBe(true);
        for (const s of [0, 1]) expect(joints[skeleton.joint.foot[s]].distanceTo(g.controls[CONTROL.foot[s]])).toBeLessThan(0.03);
      }
    }
  });
});
