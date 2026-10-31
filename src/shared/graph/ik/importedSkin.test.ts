import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { canonicalBoneName, findSkinnedMesh, fitHumanParams, importSkinWeights, mapImportedBones, readImportedSkeleton } from "./importedSkin";
import { buildHumanSkeleton } from "./skeletons";
import { RIG_HUMAN_NODE } from "../nodes/rig";
import { SKIN_NODE } from "../nodes/skin";
import { readRig } from "./skinning";
import { EvalContext } from "../types";

const ctx = (nodeId: string): EvalContext => ({ time: 0, step: 0, nodeId });

/** A Mixamo-named skeleton standing where a Human Skeleton of these proportions has its joints, and a box skinned to it. */
function mixamoModel(offset = new THREE.Vector3(0.3, 0, -0.2)) {
  const human = buildHumanSkeleton({ height: 1.6, legs: 1.1, arms: 0.9, shoulderWidth: 1.2, spineSegments: 3 });
  const at = (name: string) => human.rig.rest[human.names.indexOf(name)].clone().add(offset);
  const spec: [string, string | null, THREE.Vector3][] = [["mixamorigHips", null, at("Pelvis")]];
  const chest = at("Chest");
  spec.push(["mixamorigSpine", "mixamorigHips", at("Spine 1")], ["mixamorigSpine1", "mixamorigSpine", at("Spine 2")], ["mixamorigSpine2", "mixamorigSpine1", chest.clone().add(new THREE.Vector3(0, -0.03, 0))]);
  spec.push(["mixamorigNeck", "mixamorigSpine2", at("Neck")], ["mixamorigHead", "mixamorigNeck", at("Head")], ["mixamorigHeadTop_End", "mixamorigHead", new THREE.Vector3(0, 1.6, 0).add(offset)]);
  for (const Side of ["Left", "Right"]) {
    const x = Side === "Left" ? 1 : -1;
    spec.push(
      [`mixamorig${Side}Shoulder`, "mixamorigSpine2", chest.clone().add(new THREE.Vector3(0.04 * x, 0, 0))],
      [`mixamorig${Side}Arm`, `mixamorig${Side}Shoulder`, at(`${Side} Shoulder`)],
      [`mixamorig${Side}ForeArm`, `mixamorig${Side}Arm`, at(`${Side} Elbow`)],
      [`mixamorig${Side}Hand`, `mixamorig${Side}ForeArm`, at(`${Side} Hand`)],
      [`mixamorig${Side}HandMiddle4`, `mixamorig${Side}Hand`, at(`${Side} Fingers`)],
      [`mixamorig${Side}UpLeg`, "mixamorigHips", at(`${Side} Hip`)],
      [`mixamorig${Side}Leg`, `mixamorig${Side}UpLeg`, at(`${Side} Knee`)],
      [`mixamorig${Side}Foot`, `mixamorig${Side}Leg`, at(`${Side} Foot`)],
      [`mixamorig${Side}ToeBase`, `mixamorig${Side}Foot`, at(`${Side} Ball`)],
      [`mixamorig${Side}Toe_End`, `mixamorig${Side}ToeBase`, at(`${Side} Toes`)],
    );
  }
  const bones = new Map<string, THREE.Bone>();
  const world = new Map<string, THREE.Vector3>();
  for (const [name, parent, p] of spec) {
    const bone = new THREE.Bone();
    bone.name = name;
    world.set(name, p);
    bone.position.copy(parent ? p.clone().sub(world.get(parent)!) : p);
    if (parent) bones.get(parent)!.add(bone);
    bones.set(name, bone);
  }
  // A thin box along the left arm, all on the upper arm, and one on the left thigh.
  const geometry = new THREE.BoxGeometry(0.05, 0.05, 0.05);
  const count = geometry.attributes.position.count;
  const index = [...bones.keys()].indexOf("mixamorigLeftArm");
  geometry.translate(...world.get("mixamorigLeftArm")!.clone().lerp(world.get("mixamorigLeftForeArm")!, 0.5).toArray());
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Array(count).fill(0).flatMap(() => [index, 0, 0, 0]), 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Array(count).fill(0).flatMap(() => [1, 0, 0, 0]), 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
  const root = new THREE.Group();
  root.add(mesh, bones.get("mixamorigHips")!);
  root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([...bones.values()]));
  return { root, mesh, human, world, offset };
}

describe("imported skin", () => {
  it("reads the bones where they were when the weights were painted, and their names", () => {
    const { root, world } = mixamoModel();
    const mesh = findSkinnedMesh(root)!;
    const skeleton = readImportedSkeleton(mesh);
    skeleton.names.forEach((n, i) => expect(skeleton.positions[i].distanceTo(world.get(n)!)).toBeLessThan(1e-5));
    expect(skeleton.parents[skeleton.names.indexOf("mixamorigLeftLeg")]).toBe(skeleton.names.indexOf("mixamorigLeftUpLeg"));
    expect(canonicalBoneName("Armature|mixamorig:LeftToe_End")).toBe("lefttoeend");
  });

  it("fits a Human Skeleton onto a Mixamo skeleton", () => {
    const { mesh, world } = mixamoModel();
    const fit = fitHumanParams(readImportedSkeleton(mesh), mesh.matrixWorld)!;
    expect(fit).not.toBeNull();
    const rig = readRig(RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams, ...fit, spineSegments: 3 }, ctx("fit-human")).geometry)!;
    const joint = (name: string) => (rig.bind ?? rig.rest)[rig.names!.indexOf(name)].clone().applyMatrix4(rig.matrix);
    const pairs: [string, string][] = [
      ["Left Shoulder", "mixamorigLeftArm"], ["Left Elbow", "mixamorigLeftForeArm"], ["Left Hand", "mixamorigLeftHand"],
      ["Left Hip", "mixamorigLeftUpLeg"], ["Left Knee", "mixamorigLeftLeg"], ["Left Foot", "mixamorigLeftFoot"],
      ["Right Hand", "mixamorigRightHand"], ["Neck", "mixamorigNeck"], ["Head", "mixamorigHead"],
    ];
    for (const [human, mixamo] of pairs) expect(joint(human).distanceTo(world.get(mixamo)!)).toBeLessThan(0.04);
    expect(fit.bindArmAngle).toBe(90);
  });

  it("gives up on a skeleton without Mixamo limbs", () => {
    expect(fitHumanParams({ names: ["Root", "Bone"], parents: [-1, 0], positions: [new THREE.Vector3(), new THREE.Vector3(0, 1, 0)] })).toBeNull();
  });

  it("hands each file bone to the Human Skeleton bone that moves the same part, and adds up the ones that share one", () => {
    const { mesh } = mixamoModel(new THREE.Vector3());
    const skeleton = readImportedSkeleton(mesh);
    const fit = fitHumanParams(skeleton, mesh.matrixWorld)!;
    const rig = readRig(RIG_HUMAN_NODE.evaluate({}, { ...RIG_HUMAN_NODE.defaultParams, ...fit }, ctx("map-human")).geometry)!;
    const joints = (rig.bind ?? rig.rest).map((p) => p.clone().applyMatrix4(rig.matrix));
    const map = mapImportedBones(skeleton, skeleton.positions, { parents: rig.parents, joints, names: rig.names });
    const to = (bone: string) => rig.names![map[skeleton.names.indexOf(bone)]];
    expect(to("mixamorigLeftArm")).toBe("Left Elbow");
    expect(to("mixamorigLeftForeArm")).toBe("Left Hand");
    expect(to("mixamorigLeftHandMiddle4")).toBe("Left Fingers");
    expect(to("mixamorigRightUpLeg")).toBe("Right Knee");
    expect(to("mixamorigHips")).toBe("Pelvis");
    expect(["Spine 1", "Spine 2", "Chest", "Neck"]).toContain(to("mixamorigSpine1"));

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
    geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([0, 1, 2, 3], 4));
    geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([0.4, 0.3, 0.2, 0.1], 4));
    const weights = importSkinWeights(geometry, [5, 5, 7, 9], 2)!;
    expect(Array.from(weights.indices)).toEqual([5, 7]);
    expect(weights.weights[0]).toBeCloseTo(0.7 / 0.9);
    expect(weights.weights[1]).toBeCloseTo(0.2 / 0.9);
  });

  it("skins with the file's weights: a part on the upper arm follows the Skin's upper arm", () => {
    const { root, mesh } = mixamoModel(new THREE.Vector3());
    const fit = fitHumanParams(readImportedSkeleton(mesh), mesh.matrixWorld)!;
    const params = { ...RIG_HUMAN_NODE.defaultParams, ...fit };
    const restOut = RIG_HUMAN_NODE.evaluate({}, params, ctx("file-human"));
    const controls = (restOut.__controlPoints as THREE.Vector3[]).map((p) => p.clone());
    // Left hand straight down: the upper arm swings about the shoulder.
    controls[2] = controls[2].clone().set(controls[2].x * 0.3, controls[0].y - 0.2, controls[2].z);
    const skin = (weightsFrom: string, id: string) => {
      SKIN_NODE.evaluate({ geometry: root, rig: RIG_HUMAN_NODE.evaluate({}, params, ctx("file-human")).geometry }, { ...SKIN_NODE.defaultParams, mode: "CPU", bindTo: "rest", weightsFrom }, ctx(id));
      const out = SKIN_NODE.evaluate({ geometry: root, rig: RIG_HUMAN_NODE.evaluate({}, { ...params, pointsList: controls }, ctx("file-human")).geometry }, { ...SKIN_NODE.defaultParams, mode: "CPU", bindTo: "rest", weightsFrom }, ctx(id)).geometry as THREE.Object3D;
      const part = out instanceof THREE.Mesh ? out : (out.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh);
      part.geometry.computeBoundingBox();
      return part.geometry.boundingBox!.getCenter(new THREE.Vector3());
    };
    const before = mesh.geometry.boundingBox ?? (mesh.geometry.computeBoundingBox(), mesh.geometry.boundingBox!);
    const fromFile = skin("file", "file-skin");
    // The box sat halfway along the T-posed upper arm; with the arm down it is well below the shoulder.
    expect(fromFile.y).toBeLessThan(before.getCenter(new THREE.Vector3()).y - 0.1);
  });
});
