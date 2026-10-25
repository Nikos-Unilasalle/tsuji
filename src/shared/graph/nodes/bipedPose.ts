import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { numberInput } from "./object";
import { asVector3 } from "./transform";
import { toBoolean } from "../sockets";
import { TOGGLE_POINTS_KEYFRAME_ACTION } from "./curve";
import { HumanSkeleton, solveHuman } from "../ik/skeletons";
import { publishRig } from "../ik/skinning";
import { boneMatrices, bonesOf, drawEmpty, HumanRigData, parentsOf, viewFor } from "./rig";
import { blendPose, CONTROL, editPoseList, wigglePose, HumanPose, POSE_REGIONS, readHumanPose, readPoseList, turnQuaternion } from "../ik/humanPose";

/**
 * Biped Pose: a hand-made pose laid over whatever human is wired in — a Human
 * Skeleton at rest, a Biped Motion's walk, another Biped Pose — by its
 * Influence. Animate the influence 0 → 100 % → 0 and the walker stops, holds
 * the pose and walks on; keep it partial and the pose only leans on the walk.
 * Body, Arms and Legs scale the influence per region, so a pose can take the
 * arms alone (hands in pockets while walking) and leave the walking legs be.
 * Wiggle keeps a held pose alive — breathing, shifting its weight, its head
 * and hands drifting — with the feet left planted (see wigglePose).
 *
 * The pose is edited with handles on the body while the node is selected —
 * dragged to move a control, turned with the rotate gizmo to swing a limb
 * about its joint (the pelvis handle turns the hips) — and stored as the
 * node's `pointsList`: the ten controls in the body's own space, then the
 * pelvis turn. Keyframe it like a curve's points. Empty is the natural stance.
 */

interface PoseContext {
  skeleton: HumanSkeleton;
  /** The skeleton as this pose alone puts it — what limbs swing about. */
  joints: THREE.Vector3[];
  controls: THREE.Vector3[];
}

const contexts = createNodeCache<PoseContext>();

/** Handle colours by role, as on the HUD's key. */
export const POSE_HANDLE_COLORS = [0x22d3ee, 0xa78bfa, 0xf472b6, 0xf472b6, 0xf97316, 0xf97316, 0xfacc15, 0xfacc15, 0xfacc15, 0xfacc15];

const regionOf = (index: number): "body" | "arms" | "legs" =>
  (POSE_REGIONS.arms as readonly number[]).includes(index) ? "arms" : (POSE_REGIONS.legs as readonly number[]).includes(index) ? "legs" : "body";

export const RIG_BIPED_POSE_NODE: NodeDefinition = {
  type: "rig/biped-pose",
  label: "Biped Pose",
  category: "rig",
  inputs: [
    { id: "skeleton", label: "Skeleton", type: "geometry", owns: true },
    { id: "influence", label: "Influence", type: "value" },
    { id: "wiggle", label: "Wiggle", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Body Matrix", type: "matrix" },
    { id: "joints", label: "Joints", type: "list" },
    { id: "bones", label: "Bone Matrices", type: "list" },
    { id: "pose", label: "Pose", type: "list" },
  ],
  defaultParams: {
    influence: 1,
    body: 1,
    arms: 1,
    legs: 1,
    solo: false,
    wiggle: 0,
    wiggleSpeed: 1,
    breathing: 1,
    wiggleSeed: 0,
    previewAt: new THREE.Vector3(-1.2, 0, 0),
    showControls: true,
    pointsList: [],
  },
  paramFields: [
    { id: "influence", label: "Influence", kind: "number", step: 0.05, percent: true, group: "Pose" },
    { id: "body", label: "Body (pelvis, head)", kind: "number", step: 0.05, percent: true, group: "Pose" },
    { id: "arms", label: "Arms", kind: "number", step: 0.05, percent: true, group: "Pose" },
    { id: "legs", label: "Legs", kind: "number", step: 0.05, percent: true, group: "Pose" },
    { id: "solo", label: "Preview at 100 % while editing", kind: "boolean", group: "Pose" },
    { id: "wiggle", label: "Wiggle (0 still · 1 natural · more restless)", kind: "number", step: 0.1, group: "Wiggle" },
    { id: "wiggleSpeed", label: "Speed × (0.5 calm · 2 out of breath)", kind: "number", step: 0.1, group: "Wiggle" },
    { id: "breathing", label: "Breathing ×", kind: "number", step: 0.1, group: "Wiggle" },
    { id: "wiggleSeed", label: "Seed", kind: "number", step: 1, group: "Wiggle" },
    { id: "showControls", label: "Show Pose Handles", kind: "boolean", group: "Display" },
    { id: "previewAt", label: "Shown at, as a pose source (beside the skeleton)", kind: "vector", step: 0.1, group: "Display" },
    { id: "pointsKeyframeButton", label: "Keyframe pose at frame", kind: "button", action: TOGGLE_POINTS_KEYFRAME_ACTION, group: "Animation" },
  ],
  reset: { params: ["pointsList"] },
  paramHandleRotates: () => true,
  paramHandles: (index, position, params, nodeId, rotation) => {
    const context = contexts.get(nodeId);
    if (!context) return null;
    const { controls, turn } = readPoseList(params.pointsList, context.controls);
    return { pointsList: editPoseList(context.skeleton, context.joints, controls, turn, index, position, rotation, true) };
  },
  evaluate: (inputs, params, ctx) => {
    const view = viewFor(ctx.nodeId);
    const group = view.group;
    const source = inputs.skeleton instanceof THREE.Object3D ? inputs.skeleton : null;
    const data = source?.userData.humanRig as HumanRigData | undefined;
    if (!data) {
      drawEmpty(view);
      contexts.delete(ctx.nodeId);
      return { geometry: group, matrix: new THREE.Matrix4(), joints: [], bones: [], pose: [] };
    }
    const { skeleton } = data;
    const upstream = readHumanPose(source) ?? { controls: skeleton.relaxedControls, pelvisRotation: new THREE.Quaternion(), matrix: source!.matrix.clone() };
    // The body is wherever the pose wired in has it: this node only poses it. Used only as a
    // pose source (its Pose output wired into a Biped Motion, its body nowhere), it stands
    // aside as an editing preview, kept out of the render.
    const sourceOnly = ctx.connectedOutputs !== undefined && !ctx.connectedOutputs.has("geometry") && ctx.connectedOutputs.has("pose");
    group.matrix.copy(upstream.matrix);
    if (sourceOnly) group.matrix.premultiply(new THREE.Matrix4().makeTranslation(asVector3(params.previewAt, new THREE.Vector3(-1.2, 0, 0))));
    group.matrixWorldNeedsUpdate = true;

    const stored = readPoseList(params.pointsList, skeleton.relaxedControls);
    const own = { controls: stored.controls, pelvisRotation: turnQuaternion(stored.turn) };
    // Wiggle: the held pose breathing and shifting its weight, on the timeline's clock so it scrubs and exports the same.
    const H = Math.max(0.05, skeleton.relaxedControls[CONTROL.head].y);
    const wiggle = {
      amount: numberInput(inputs.wiggle, params.wiggle, 0),
      speed: numberInput(undefined, params.wiggleSpeed, 1),
      breathing: numberInput(undefined, params.breathing, 1),
      seed: numberInput(undefined, params.wiggleSeed, 0),
    };
    const time = (ctx.currentFrame ?? -1) >= 0 && Number(ctx.fps) > 0 ? (ctx.currentFrame as number) / Number(ctx.fps) : ctx.time;
    const wiggling = wiggle.amount > 0;
    const living = wiggling ? { controls: wigglePose(own.controls, H, time, wiggle), pelvisRotation: own.pelvisRotation } : own;
    const influence = toBoolean(params.solo) ? 1 : Math.max(0, Math.min(1, numberInput(inputs.influence, params.influence, 1)));
    const region = { body: numberInput(undefined, params.body, 1), arms: numberInput(undefined, params.arms, 1), legs: numberInput(undefined, params.legs, 1) };
    const pose = blendPose(upstream, living, (i) => influence * region[regionOf(i)], influence * region.body);

    const solver = { armPull: data.armPull, ...data.solver };
    const positions = solveHuman(skeleton, pose.controls, { ...solver, pelvisRotation: pose.pelvisRotation });
    // Limbs swing about the joints of the pose being edited, not of the blend.
    const ownJoints = influence >= 1 && !wiggling ? positions : solveHuman(skeleton, own.controls, { ...solver, pelvisRotation: own.pelvisRotation });
    contexts.set(ctx.nodeId, { skeleton, joints: ownJoints, controls: own.controls });

    const showControls = params.showControls === undefined ? true : toBoolean(params.showControls);
    const { joint } = skeleton;
    const poleJoint = [joint.elbow[0], joint.elbow[1], joint.knee[0], joint.knee[1]];
    view.update({
      positions,
      bones: bonesOf(skeleton.rig),
      thickness: data.thickness,
      color: data.color,
      jointRadius: data.thickness * 1.3,
      markerSize: 0.03 * H,
      knobs: showControls ? own.controls.map((at, i) => ({ at, color: POSE_HANDLE_COLORS[i] })) : [],
      knobRadius: 0.022 * H,
      paths: showControls ? own.controls.slice(6).map((at, k) => ({ points: [at, ownJoints[poleJoint[k]]], color: 0x8a7a2a })) : [],
    });

    // Previewing, the bones and joint balls become helpers: drawn in the editor, left out of the
    // render. Only those — the viewport shows every helper, and the view also holds meshes it keeps
    // hidden (a polypede's body sphere), which flagging would bring up.
    for (const child of group.children) {
      if (!(child instanceof THREE.InstancedMesh)) {
        // Undo a flag an earlier version put on everything.
        if ("helperOwn" in child.userData) child.userData.isHelper = child.userData.helperOwn;
        continue;
      }
      child.userData.helperOwn ??= Boolean(child.userData.isHelper);
      child.userData.isHelper = child.userData.helperOwn || sourceOnly;
    }
    publishRig(group, parentsOf(skeleton.rig), skeleton.rig.rest, positions, group.matrix, skeleton.names);
    group.userData.humanRig = data;
    group.userData.humanPose = { controls: pose.controls, pelvisRotation: pose.pelvisRotation, matrix: group.matrix.clone() } satisfies HumanPose;
    group.updateMatrixWorld(true);
    const world = positions.map((p) => p.clone().applyMatrix4(group.matrix));
    return {
      geometry: group,
      matrix: group.matrix.clone(),
      joints: world,
      bones: boneMatrices(skeleton.rig, world),
      // The pose itself — its own, not blended — for a Biped Motion to hold at a route stop.
      pose: [...living.controls.map((c) => c.clone()), stored.turn.clone()],
      // Not a socket: the pose's handles, in the body's space (see Viewport.tsx's param handles).
      __controlPoints: showControls ? own.controls : [],
    };
  },
};
