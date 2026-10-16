import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { RIG_SKELETON_NODE } from "./skeleton";
import { SKIN_NODE } from "./skin";
import { OBJECT_CYLINDER_NODE } from "./object";
import { EvalContext } from "../types";

const ctx = (nodeId: string): EvalContext => ({ time: 0, step: 0, nodeId });
const v = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z);
const params = (extra: Record<string, unknown> = {}) => ({ ...RIG_SKELETON_NODE.defaultParams, ...extra });
const arm = { pointsList: [v(0, 0), v(0, 1), v(0, 2)], parents: [-1, 0, 1], names: ["Root", "Mid", "Tip"] };

describe("Skeleton node", () => {
  it("starts as a single joint and still reports a rig", () => {
    const out = RIG_SKELETON_NODE.evaluate({}, params(), ctx("sk-default"));
    expect((out.joints as THREE.Vector3[]).length).toBe(1);
    expect((out.bones as THREE.Matrix4[]).length).toBe(0);
    const rig = (out.geometry as THREE.Object3D).userData.rig;
    expect(rig.parents).toEqual([-1]);
    expect(rig.names).toEqual(["Joint 1"]);
  });

  it("builds the rig it is given: joints in world space, a bone matrix per bone, its transform applied", () => {
    const out = RIG_SKELETON_NODE.evaluate({}, params({ ...arm, location: v(5, 0, 0) }), ctx("sk-arm"));
    const joints = out.joints as THREE.Vector3[];
    expect(joints.map((j) => j.x)).toEqual([5, 5, 5]);
    expect((out.bones as THREE.Matrix4[]).length).toBe(2);
    expect((out.geometry as THREE.Object3D).userData.rig.parents).toEqual([-1, 0, 1]);
  });

  it("survives a list of joints that is empty or has bad parents", () => {
    expect((RIG_SKELETON_NODE.evaluate({}, params({ pointsList: [], parents: [], names: [] }), ctx("sk-empty")).joints as unknown[]).length).toBe(1);
    const out = RIG_SKELETON_NODE.evaluate({}, params({ pointsList: [v(0, 0), v(0, 1)], parents: [1, 0] }), ctx("sk-loop"));
    expect((out.geometry as THREE.Object3D).userData.rig.parents.filter((p: number) => p < 0).length).toBe(1);
  });

  it("keeps its rest in Pose mode, so moving the joints poses it instead of redrawing it", () => {
    const rest = arm.pointsList.map((p) => p.clone());
    const posed = [v(0, 0), v(0, 1), v(1, 1)];
    const edit = RIG_SKELETON_NODE.evaluate({}, params({ ...arm, pointsList: posed }), ctx("sk-edit"));
    expect((edit.geometry as THREE.Object3D).userData.rig.rest[2].x).toBe(1);
    const pose = RIG_SKELETON_NODE.evaluate({}, params({ ...arm, pointsList: posed, mode: "Pose", restPoints: rest }), ctx("sk-pose"));
    const data = (pose.geometry as THREE.Object3D).userData.rig;
    expect(data.rest[2].x).toBe(0);
    expect(data.pose[2].x).toBe(1);
  });

  it("takes its pose from a wired list", () => {
    const out = RIG_SKELETON_NODE.evaluate({ pose: [v(0, 0), v(0, 1), v(2, 1)] }, params(arm), ctx("sk-driven"));
    expect((out.geometry as THREE.Object3D).userData.rig.pose[2].x).toBe(2);
    expect((out.geometry as THREE.Object3D).userData.rig.rest[2].x).toBe(0);
  });

  it("deforms a mesh through Skin like any other rig", () => {
    const rest = arm.pointsList.map((p) => p.clone());
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2, 8, 20).translate(0, 1, 0), new THREE.MeshStandardMaterial());
    const rigRest = RIG_SKELETON_NODE.evaluate({}, params({ ...arm, mode: "Pose", restPoints: rest }), ctx("sk-skin")).geometry;
    const skin = (rig: unknown) => SKIN_NODE.evaluate({ geometry: mesh, rig }, { ...SKIN_NODE.defaultParams, mode: "CPU" }, ctx("sk-skin-node")).geometry as THREE.Mesh;
    skin(rigRest);
    const bent = RIG_SKELETON_NODE.evaluate({}, params({ ...arm, pointsList: [v(0, 0), v(0, 1), v(-1, 1)], mode: "Pose", restPoints: rest }), ctx("sk-skin")).geometry;
    const xs = Array.from(skin(bent).geometry.attributes.position.array as Float32Array).filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBeLessThan(-0.7);
  });

  it("bends the demo's tube only because it has rings to bend", () => {
    const rest = arm.pointsList.map((p) => p.clone());
    const tube = (heightSegments: number, id: string) =>
      OBJECT_CYLINDER_NODE.evaluate({}, { ...OBJECT_CYLINDER_NODE.defaultParams, heightSegments, location: v(0, 1, 0), scale: v(0.2, 2, 0.2) }, ctx(id)).geometry as THREE.Mesh;
    const bentWidth = (mesh: THREE.Mesh, id: string) => {
      const restRig = RIG_SKELETON_NODE.evaluate({}, params({ ...arm, mode: "Pose", restPoints: rest }), ctx(`${id}-rig`)).geometry;
      const skin = (rig: unknown) => SKIN_NODE.evaluate({ geometry: mesh, rig }, { ...SKIN_NODE.defaultParams, mode: "CPU", bindSpace: "World" }, ctx(id)).geometry as THREE.Mesh;
      skin(restRig);
      const bent = RIG_SKELETON_NODE.evaluate({}, params({ ...arm, pointsList: [v(0, 0), v(0, 1), v(-1, 1)], mode: "Pose", restPoints: rest }), ctx(`${id}-rig`)).geometry;
      const xs = Array.from(skin(bent).geometry.attributes.position.array as Float32Array).filter((_, i) => i % 3 === 0);
      return Math.min(...xs);
    };
    // Two rings: top and bottom each follow one bone's end, the middle is all there is to bend.
    expect(bentWidth(tube(40, "ring-40"), "ring-40")).toBeLessThan(-0.6);
    expect(bentWidth(tube(1, "ring-1"), "ring-1")).toBeGreaterThan(bentWidth(tube(40, "ring-40b"), "ring-40b"));
  });
});
