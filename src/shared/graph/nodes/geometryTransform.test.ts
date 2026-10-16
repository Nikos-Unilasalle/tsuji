import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { GEOMETRY_TRANSFORM_NODE } from "./instance";
import { EvalContext } from "../types";

function objectAt(x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry());
  mesh.matrixAutoUpdate = false;
  mesh.matrix.makeTranslation(x, y, z);
  return mesh;
}

function worldPose(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  let mesh: THREE.Object3D | null = null;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) mesh = o;
  });
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  (mesh as unknown as THREE.Object3D).matrixWorld.decompose(position, quaternion, new THREE.Vector3());
  return { position, angle: (2 * Math.acos(Math.min(1, Math.abs(quaternion.w))) * 180) / Math.PI };
}

function run(inputs: Record<string, unknown>, wired: string[], params: Record<string, unknown> = {}) {
  const ctx: EvalContext = { time: 0, step: 0, nodeId: `gt-${Math.random()}`, connectedInputs: new Set(["geometry", ...wired]) };
  return GEOMETRY_TRANSFORM_NODE.evaluate(inputs, { ...GEOMETRY_TRANSFORM_NODE.defaultParams, ...params }, ctx).geometry as THREE.Object3D;
}

describe("Geometry Transform", () => {
  it("turns an object about its own origin, not the world's", () => {
    const out = run({ geometry: objectAt(3, 0.5, 0), rotation: new THREE.Vector3(0, Math.PI / 2, 0) }, ["rotation"]);
    const pose = worldPose(out);
    expect(pose.position.distanceTo(new THREE.Vector3(3, 0.5, 0))).toBeLessThan(1e-9);
    expect(pose.angle).toBeCloseTo(90, 6);
  });

  it("reads a wired Rotation vector as radians and the Rot X/Y/Z numbers as degrees", () => {
    expect(worldPose(run({ geometry: objectAt(0, 0, 0), rotation: new THREE.Vector3(0, Math.PI / 2, 0) }, ["rotation"])).angle).toBeCloseTo(90, 6);
    expect(worldPose(run({ geometry: objectAt(0, 0, 0), rotY: 90 }, ["rotY"])).angle).toBeCloseTo(90, 6);
    expect(worldPose(run({ geometry: objectAt(0, 0, 0) }, [], { rotY: 45 })).angle).toBeCloseTo(45, 6);
  });

  it("moves along the object's own axes", () => {
    const tipped = objectAt(3, 0, 0);
    tipped.matrix.multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
    const pose = worldPose(run({ geometry: tipped, posY: 1 }, ["posY"]));
    // The object's own Y points along world -X once tipped 90° about Z.
    expect(pose.position.distanceTo(new THREE.Vector3(2, 0, 0))).toBeLessThan(1e-9);
  });
});
