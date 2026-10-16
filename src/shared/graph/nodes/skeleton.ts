import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { asVector3 } from "./transform";
import { NATIVE_TRANSFORM_PARAM_FIELDS, numberInput } from "./object";
import { TOGGLE_POINTS_KEYFRAME_ACTION } from "./curve";
import { createSkeletonView, SkeletonView } from "../ik/skeletonView";
import { publishRig } from "../ik/skinning";
import { readSkeleton } from "../ik/skeletonEdit";
import { boneMatrices, DISPLAY_FIELDS, placeGroup, TRANSFORM_DEFAULTS } from "./rig";

/**
 * Skeleton: a rig you build yourself, joint by joint.
 *
 * It starts as a single joint. In the viewport the joints are handles — drag
 * them, add a child to the selected joint, split a bone, mirror, delete — and
 * every Skin node (or anything reading Joints / Bone Matrices) works with it
 * as with the ready-made skeletons.
 *
 * Edit mode: the joints are the rest pose. Pose mode: the rest pose is kept
 * (it is what Skin binds to) and moving the joints poses the rig, which is
 * what keyframes animate. A wired Pose list overrides the joints' own pose
 * in either mode, so another node can drive the rig.
 */

const views = createNodeCache<SkeletonView>((view) => view.dispose());

function viewFor(nodeId: string): SkeletonView {
  let view = views.get(nodeId);
  if (!view) {
    view = createSkeletonView(nodeId);
    view.group.matrixAutoUpdate = false;
    views.set(nodeId, view);
  }
  return view;
}

export const SKELETON_NODE_TYPE = "rig/skeleton";

export const RIG_SKELETON_NODE: NodeDefinition = {
  type: SKELETON_NODE_TYPE,
  label: "Skeleton",
  category: "rig",
  inputs: [
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "pose", label: "Pose", type: "list" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "joints", label: "Joints", type: "list" },
    { id: "bones", label: "Bone Matrices", type: "list" },
  ],
  defaultParams: {
    ...TRANSFORM_DEFAULTS,
    // One joint to start from; the viewport grows it.
    pointsList: [new THREE.Vector3(0, 0, 0)],
    parents: [-1],
    names: ["Joint 1"],
    mode: "Edit",
    restPoints: [],
    boneThickness: 0.02,
    boneColor: new THREE.Color(0x9a5b2e),
    jointSize: 0.035,
  },
  paramFields: [
    ...NATIVE_TRANSFORM_PARAM_FIELDS,
    { id: "mode", label: "Mode", kind: "select", options: ["Edit", "Pose"], group: "Rig" },
    { id: "jointSize", label: "Joint Size", kind: "number", step: 0.005, group: "Display" },
    ...DISPLAY_FIELDS,
    { id: "pointsKeyframeButton", label: "Keyframe joints at frame", kind: "button", action: TOGGLE_POINTS_KEYFRAME_ACTION, group: "Animation" },
  ],
  evaluate: (inputs, params, ctx) => {
    const data = readSkeleton(params);
    // Never empty: a skeleton with no joints has nothing to select, add to or draw.
    if (data.points.length === 0) {
      data.points.push(new THREE.Vector3());
      data.parents.push(-1);
      data.names.push("Joint 1");
    }
    const n = data.points.length;

    const editing = String(params.mode ?? "Edit") !== "Pose";
    const stored = Array.isArray(params.restPoints) ? params.restPoints : [];
    const rest = !editing && stored.length === n ? stored.map((p) => asVector3(p, new THREE.Vector3()).clone()) : data.points;
    const zero = new THREE.Vector3();
    const driven = Array.isArray(inputs.pose) && inputs.pose.length === n ? inputs.pose.map((p) => asVector3(p, zero).clone()) : null;
    const pose = driven ?? data.points;

    const view = viewFor(ctx.nodeId);
    const group = view.group;
    placeGroup(group, inputs, params, ctx.nodeId, ctx.liveEditNodeId);
    const thickness = Math.max(0, numberInput(undefined, params.boneThickness, 0.02));
    view.update({
      positions: pose,
      bones: data.parents.flatMap((p, i) => (p >= 0 ? [[p, i] as [number, number]] : [])),
      thickness,
      color: params.boneColor instanceof THREE.Color ? params.boneColor : new THREE.Color(String(params.boneColor ?? "#9a5b2e")),
      jointRadius: Math.max(0, numberInput(undefined, params.jointSize, 0.035)),
    });

    publishRig(group, data.parents, rest, pose, group.matrix, data.names);
    group.updateMatrixWorld(true);
    const world = pose.map((p) => p.clone().applyMatrix4(group.matrix));
    const rig = { joints: data.parents.map((parent) => ({ parent })), rest };
    return { geometry: group, matrix: group.matrix.clone(), joints: world, bones: boneMatrices(rig, world) };
  },
};
