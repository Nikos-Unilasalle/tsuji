import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { buildBones, computeSkinWeights, SkinWeights } from "./skinning";
import { buildHumanSkeleton } from "./skeletons";
import { mirrorJoints, mirrorSkinWeights, mirrorVertices } from "./weightPaint";
import { RIG_HUMAN_NODE } from "../nodes/rig";
import { SKIN_NODE, skinReweighParams } from "../nodes/skin";
import { EvalContext } from "../types";

const skeleton = buildHumanSkeleton();
const bones = buildBones(skeleton.rig.joints.map((j) => j.parent), skeleton.rig.rest);
const joint = (name: string) => skeleton.names.indexOf(name);
const weightOf = (skin: SkinWeights, v: number, j: number) => {
  let w = 0;
  for (let k = 0; k < skin.influences; k++) if (skin.indices[v * skin.influences + k] === j) w += skin.weights[v * skin.influences + k];
  return w;
};
const used = (skin: SkinWeights, v: number) => {
  let n = 0;
  for (let k = 0; k < skin.influences; k++) if (skin.weights[v * skin.influences + k] > 0) n++;
  return n;
};
/** A vertex on the inner left thigh, close to the right one. */
const thigh = new Float32Array([0.06, 0.7, 0.02]);
const base = { influences: 4, falloff: 2, smooth: 0 };

describe("automatic weight options", () => {
  it("Bone Reach keeps a vertex to the bones next to its nearest one", () => {
    const all = computeSkinWeights(thigh, null, new THREE.Matrix4(), bones, base);
    const near = computeSkinWeights(thigh, null, new THREE.Matrix4(), bones, { ...base, boneHops: 1 });
    expect(weightOf(all, 0, joint("Right Knee"))).toBeGreaterThan(0.01);
    expect(weightOf(near, 0, joint("Right Knee"))).toBe(0);
    expect(weightOf(near, 0, joint("Left Knee"))).toBeGreaterThan(weightOf(all, 0, joint("Left Knee")));
  });

  it("Ignore Weights Below drops the weak bones, never the strongest", () => {
    const all = computeSkinWeights(thigh, null, new THREE.Matrix4(), bones, base);
    const pruned = computeSkinWeights(thigh, null, new THREE.Matrix4(), bones, { ...base, prune: 0.3 });
    expect(used(pruned, 0)).toBeLessThan(used(all, 0));
    expect(used(computeSkinWeights(thigh, null, new THREE.Matrix4(), bones, { ...base, prune: 0.5 }), 0)).toBeGreaterThanOrEqual(1);
    // The default is the old fixed threshold.
    expect(computeSkinWeights(thigh, null, new THREE.Matrix4(), bones, { ...base, prune: 0.001 })).toEqual(all);
  });

  it("Smooth Strength 0 leaves the weights as smoothing found them, 0.5 is the old smoothing", () => {
    const geometry = new THREE.CylinderGeometry(0.06, 0.06, 0.9, 8, 18).translate(0.09, 0.45, 0);
    const pos = geometry.attributes.position.array;
    const index = geometry.getIndex()!.array;
    const close = (a: SkinWeights, b: SkinWeights) => {
      expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
      a.weights.forEach((w, i) => expect(w).toBeCloseTo(b.weights[i], 5));
    };
    close(computeSkinWeights(pos, index, new THREE.Matrix4(), bones, { ...base, smooth: 3, smoothStrength: 0 }), computeSkinWeights(pos, index, new THREE.Matrix4(), bones, { ...base, smooth: 0 }));
    expect(computeSkinWeights(pos, index, new THREE.Matrix4(), bones, { ...base, smooth: 3, smoothStrength: 0.5 })).toEqual(
      computeSkinWeights(pos, index, new THREE.Matrix4(), bones, { ...base, smooth: 3 }),
    );
  });

  it("Mirror Weights copies one side onto the other, joints swapped", () => {
    // Two legs, the right one slightly off (within the 1% the pairing allows): unmirrored, their weights differ.
    const legs = [0.09, -0.093].flatMap((x) => [x, 0.3, 0.01, x, 0.6, 0.0]);
    const positions = new Float32Array(legs);
    const skin = computeSkinWeights(positions, null, new THREE.Matrix4(), bones, base);
    const mirror = mirrorVertices(positions);
    expect(weightOf(skin, 2, joint("Right Knee"))).not.toBeCloseTo(weightOf(skin, 0, joint("Left Knee")), 4);
    mirrorSkinWeights(skin, positions, mirror, mirrorJoints(skeleton.rig.rest, skeleton.names), "left");
    for (const [l, r] of [[0, 2], [1, 3]]) {
      for (const name of ["Knee", "Foot", "Hip"]) expect(weightOf(skin, r, joint(`Right ${name}`))).toBeCloseTo(weightOf(skin, l, joint(`Left ${name}`)), 6);
    }
  });
});

describe("Skin: recompute weights", () => {
  const ctx = (nodeId: string): EvalContext => ({ time: 0, step: 0, nodeId });

  it("weighs a mesh edited in place again, on the button", () => {
    const rig = RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams }, ctx("rw-rig")).geometry;
    const controls = skeleton.restControls.map((v) => v.clone());
    controls[3].add(new THREE.Vector3(0, 0.4, 0.3));
    const posed = RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams, pointsList: controls }, ctx("rw-rig2")).geometry;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4, 4, 4, 4).translate(0, 1.0, 0), new THREE.MeshStandardMaterial());
    const params = { ...SKIN_NODE.defaultParams, mode: "CPU" };
    SKIN_NODE.evaluate({ geometry: mesh, rig }, params, ctx("rw"));
    // The box moved onto the right hand, in place: same geometry, same vertex count.
    mesh.geometry.translate(-0.9, 0.5, 0);
    mesh.geometry.attributes.position.needsUpdate = true;
    const stale = SKIN_NODE.evaluate({ geometry: mesh, rig: posed }, params, ctx("rw")).geometry as THREE.Mesh;
    const staleY = Array.from(stale.geometry.attributes.position.array as Float32Array);
    const fresh = SKIN_NODE.evaluate({ geometry: mesh, rig: posed }, { ...params, ...skinReweighParams(params) }, ctx("rw")).geometry as THREE.Mesh;
    const freshY = Array.from(fresh.geometry.attributes.position.array as Float32Array);
    expect(skinReweighParams({ reweigh: 2 })).toEqual({ reweigh: 3 });
    expect(freshY.some((v, i) => Math.abs(v - staleY[i]) > 0.05)).toBe(true);
  });
});
