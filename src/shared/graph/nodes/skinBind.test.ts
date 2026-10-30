import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";
import { consumeSkinBindRequests, SKIN_NODE } from "./skin";
import { RIG_HUMAN_NODE } from "./rig";
import { RIG_BIPED_MOTION_NODE } from "./bipedMotion";
import { newNodeParams } from "../cloneGraph";
import { CONTROL } from "../ik/humanPose";
import { EvalContext } from "../types";

const ctx = (nodeId: string): EvalContext => ({ time: 0, step: 0, nodeId });
const body = () => new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.9, 0.5, 6, 30, 6).translate(0, 0.95, 0.05), new THREE.MeshStandardMaterial());
const positionsOf = (mesh: unknown) => Array.from((mesh as THREE.Mesh).geometry.attributes.position.array as Float32Array);
const maxMove = (a: number[], b: number[]) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

/** A Human Skeleton fitted by hand: its head and a foot dragged off their rest. */
function fittedRig(nodeId: string, headZ = 0.05, footY = 0.03) {
  const rest = (RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams }, ctx(nodeId)).__controlPoints as THREE.Vector3[]).map((p) => p.clone());
  rest[CONTROL.head].z += headZ;
  rest[CONTROL.foot[0]].y += footY;
  return RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams, pointsList: rest }, ctx(nodeId)).geometry;
}

describe("Skin Bind To: the pose when connected", () => {
  beforeEach(() => consumeSkinBindRequests());

  it("is what a new Skin does; Skins from older files keep binding at rest", () => {
    expect(newNodeParams(SKIN_NODE).bindTo).toBe("connected");
    expect(SKIN_NODE.defaultParams.bindTo).toBe("rest");
  });

  it("moves nothing when a posed skeleton is connected, then follows it as it is posed further", () => {
    const mesh = body();
    const base = positionsOf(mesh);
    const params = { ...newNodeParams(SKIN_NODE), mode: "CPU" };
    const bound = SKIN_NODE.evaluate({ geometry: mesh, rig: fittedRig("bind-rig") }, params, ctx("bind-a")).geometry;
    expect(maxMove(positionsOf(bound), base)).toBeLessThan(1e-5);
    // At rest instead, the same skeleton pulls the mesh.
    const atRest = SKIN_NODE.evaluate({ geometry: mesh, rig: fittedRig("bind-rig") }, { ...SKIN_NODE.defaultParams, mode: "CPU" }, ctx("bind-b")).geometry;
    expect(maxMove(positionsOf(atRest), base)).toBeGreaterThan(0.01);

    // The editor keeps the pose taken in the node's params.
    const requests = consumeSkinBindRequests();
    expect(requests.map((r) => r.nodeId)).toEqual(["bind-a"]);
    const stored: Record<string, unknown> = { ...params, ...requests[0].params };
    expect((stored.bindPose as unknown[]).length).toBe(24);

    // Posed further, from what was stored: the mesh moves now, and nothing more is asked for.
    const moved = SKIN_NODE.evaluate({ geometry: mesh, rig: fittedRig("bind-rig", 0.2) }, stored, ctx("bind-a")).geometry;
    expect(maxMove(positionsOf(moved), base)).toBeGreaterThan(0.01);
    expect(consumeSkinBindRequests()).toEqual([]);
    // A fresh session (a file opened again) binds at the stored pose, not at the one shown now.
    const reopened = SKIN_NODE.evaluate({ geometry: body(), rig: fittedRig("bind-rig", 0.2) }, stored, ctx("bind-a2")).geometry;
    expect(maxMove(positionsOf(reopened), positionsOf(moved))).toBeLessThan(1e-5);
  });

  it("forgets the pose when the rig is disconnected, and takes the new one when connected again", () => {
    const mesh = body();
    const params = { ...newNodeParams(SKIN_NODE), mode: "CPU" };
    SKIN_NODE.evaluate({ geometry: mesh, rig: fittedRig("bind-rig2") }, params, ctx("bind-c"));
    const stored = { ...params, ...consumeSkinBindRequests()[0].params };
    SKIN_NODE.evaluate({ geometry: mesh }, stored, ctx("bind-c"));
    const cleared = consumeSkinBindRequests();
    expect(cleared[0].params).toEqual({ bindPose: [], bindKey: "" });
    const again = SKIN_NODE.evaluate({ geometry: mesh, rig: fittedRig("bind-rig2", 0.2) }, { ...stored, ...cleared[0].params }, ctx("bind-c")).geometry;
    expect(maxMove(positionsOf(again), positionsOf(mesh))).toBeLessThan(1e-5);
  });

  it("binds a walk at the skeleton it walks, not at the stride it happens to be in", () => {
    const mesh = body();
    const human = fittedRig("bind-walk-rig");
    const walk = (f: number) =>
      RIG_BIPED_MOTION_NODE.evaluate({ skeleton: human }, { ...RIG_BIPED_MOTION_NODE.defaultParams, locomotion: "inPlace" }, { ...ctx("bind-walk"), time: f / 30, step: f, currentFrame: f, fps: 30 }).geometry;
    const params = { ...newNodeParams(SKIN_NODE), mode: "CPU" };
    const viaWalk = SKIN_NODE.evaluate({ geometry: mesh, rig: walk(20) }, params, ctx("bind-d")).geometry;
    const viaHuman = SKIN_NODE.evaluate({ geometry: body(), rig: human }, params, ctx("bind-e")).geometry;
    // Bound at the Human Skeleton's pose either way: through the walk the mesh shows the walk, off its fitted pose.
    const fitted = consumeSkinBindRequests();
    expect(fitted).toHaveLength(2);
    expect(fitted[0].params.bindPose).toEqual(fitted[1].params.bindPose);
    expect(maxMove(positionsOf(viaWalk), positionsOf(viaHuman))).toBeGreaterThan(0.01);
  });
});
