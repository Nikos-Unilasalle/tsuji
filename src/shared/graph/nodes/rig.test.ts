import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { RIG_HUMAN_NODE, RIG_POLYPEDE_MOTION_NODE, RIG_POLYPEDE_NODE } from "./rig";
import { EvalContext } from "../types";
import { HUMAN_CONTROLS } from "../ik/skeletons";

const ctx = (nodeId: string, extra: Partial<EvalContext> = {}): EvalContext => ({ time: 0, step: 0, nodeId, ...extra });

describe("Human Skeleton node", () => {
  it("stands at rest with no stored controls and reports them for the viewport handles", () => {
    const out = RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams }, ctx("human-rest"));
    expect(out.geometry).toBeInstanceOf(THREE.Group);
    const controls = out.__controlPoints as THREE.Vector3[];
    expect(controls.length).toBe(HUMAN_CONTROLS.length);
    const joints = out.joints as THREE.Vector3[];
    expect(joints.length).toBeGreaterThan(15);
    expect((out.bones as THREE.Matrix4[]).length).toBe(joints.length - 1);
  });

  it("follows a moved hand handle, in the skeleton's own space", () => {
    const rest = RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams }, ctx("human-a")).__controlPoints as THREE.Vector3[];
    const points = rest.map((p) => p.clone());
    points[2] = new THREE.Vector3(0.6, 1.4, 0.3);
    const location = new THREE.Vector3(5, 0, 0);
    const out = RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams, pointsList: points, location }, ctx("human-a"));
    const joints = out.joints as THREE.Vector3[];
    const reached = joints.some((j) => j.distanceTo(points[2].clone().add(location)) < 5e-3);
    expect(reached).toBe(true);
  });

  it("takes a wired control in world space", () => {
    const target = new THREE.Vector3(0.5, 1.2, 0.4);
    const out = RIG_HUMAN_NODE.evaluate(
      { leftHand: target },
      { ...RIG_HUMAN_NODE.defaultParams, location: new THREE.Vector3(0, 0, 0.2) },
      ctx("human-wired", { connectedInputs: new Set(["leftHand"]) }),
    );
    const joints = out.joints as THREE.Vector3[];
    expect(joints.some((j) => j.distanceTo(target) < 5e-3)).toBe(true);
  });
});

describe("Polypede nodes", () => {
  it("walks the body's pose with planted feet, on graph time when capturing", () => {
    const skeleton = RIG_POLYPEDE_NODE.evaluate({}, { ...RIG_POLYPEDE_NODE.defaultParams }, ctx("poly-skel")).geometry;
    expect((skeleton as THREE.Object3D).userData.polypedeRig).toBeDefined();

    const params = { ...RIG_POLYPEDE_MOTION_NODE.defaultParams };
    const run = (frame: number) =>
      RIG_POLYPEDE_MOTION_NODE.evaluate(
        { skeleton },
        { ...params, location: new THREE.Vector3(0, 0, frame / 60) },
        ctx("poly-motion", { time: frame / 60, capturing: true, sessionId: "test" }),
      );

    const first = run(0).feet as THREE.Vector3[];
    expect(first.length).toBe(8);
    // A little forward: still inside every circle, so no foot moves.
    const near = run(6).feet as THREE.Vector3[];
    near.forEach((f, i) => expect(f.distanceTo(first[i])).toBeLessThan(1e-9));
    // Far forward over a couple of seconds: every foot has stepped along.
    let feet: THREE.Vector3[] = near;
    for (let frame = 7; frame <= 180; frame++) feet = run(frame).feet as THREE.Vector3[];
    feet.forEach((f, i) => expect(f.z).toBeGreaterThan(first[i].z + 2));
  });

  it("stands empty without a skeleton", () => {
    const out = RIG_POLYPEDE_MOTION_NODE.evaluate({}, { ...RIG_POLYPEDE_MOTION_NODE.defaultParams }, ctx("poly-empty"));
    expect(out.feet).toEqual([]);
  });
});
