import * as THREE from "three";
import { createNodeCache } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { clearMeshWarning, collectMeshes, warnMeshRequired } from "../meshRequired";
import { toBoolean } from "../sockets";
import { numberInput } from "./object";
import { asVector3 } from "./transform";
import {
  boneRotations,
  buildBones,
  computeSkinWeights,
  PosedBones,
  poseBones,
  readRig,
  RigData,
  SkinBone,
  SkinBounds,
  SkinWeights,
  skinVertices,
} from "../ik/skinning";
import { applyPaintLayer, cloneSkin, jointWeight, mirrorJoints, mirrorSkinWeights, mirrorVertices, PaintLayer, readPaintLayer, VertexMirror } from "../ik/weightPaint";
import { applyWeightTargets, mapKey, mirrorTargets, parseMapKey, readTargets, StoredTarget, storeTarget, toBytes, WeightTargets } from "../ik/weightMaps";
import { getTexturePaintState } from "./texturePaint";
import { rasterizeVertexValues, sampleMapValues } from "./pointsInfluence";
import { clearPaintCanvas, createPaintCanvas, restorePaintCanvas, serializePaintCanvas } from "../../three/texturePainter";
import { syncCanvasTexture } from "../../three/layeredTexture";
import { disposeGeometryBvh, getBoundsTree, initBvhRaycast } from "../../three/bvh";

/**
 * Skin: binds a mesh to any rig and deforms it as the rig moves.
 *
 * "Any rig" means anything that publishes joints with parents (every Rig node
 * does, on its geometry's `userData.rig`), or a plain list of joint positions
 * wired into Joints — a chain unless a Parents list says otherwise. Skin does
 * not care how the rig was posed, and the mesh may be procedural or imported.
 *
 * Binding (the weights) happens once, at the rest pose, and is redone only
 * when something it depends on changes: the mesh's geometry, the rest joints,
 * or the weight settings. Moving the mesh afterwards moves the skinned result
 * as a whole, on top of the rig; Re-bind (toggle it) weighs it again from where
 * it stands. Each frame is then just a blend of the bone matrices, either on
 * the CPU (the result is a real, deformed geometry other nodes can read) or on
 * the GPU (a SkinnedMesh: free at any size, but downstream nodes see the rest
 * shape). Auto picks the GPU for big meshes.
 *
 * Weights are painted by hand on the surface, like Points Influence: one
 * grayscale map per joint on the mesh's UVs (`weightMaps`), white all of the
 * joint, black none, starting from the joint's weights when one begins.
 * Compute reads the maps under the vertices into `weightTargets`, which is
 * what skinning uses (see weightMaps.ts); a stroke alone changes nothing
 * downstream. L → R and R → L copy one side's maps onto the other, joint to
 * counterpart ("Left Knee" to "Right Knee"), across the rig's centre plane
 * (x = 0 in its own space). Changing the paint does not weigh the mesh again.
 * Files painted per vertex before (`weightPaint`) still apply, under the maps.
 */

type Mode = "CPU" | "GPU";

/** Vertices above which Auto skins on the GPU. */
const GPU_VERTICES = 20_000;

interface BoundMesh {
  source: THREE.Mesh;
  output: THREE.Mesh;
  /** The mesh's matrix when it was weighed: what the bones' rest space sees of it. */
  frame: THREE.Matrix4;
  /** The automatic weights. */
  auto: SkinWeights;
  /** What skinning uses: the automatic weights with the paint applied. */
  skin: SkinWeights;
  /** Per-vertex paint from files of before the weight maps. */
  layer: PaintLayer;
  /** Computed weight maps, joint -> byte per vertex. */
  targets: WeightTargets;
  /** Each vertex's counterpart across the rig's centre plane, worked out the first time it is needed. */
  mirror?: VertexMirror;
  /** Output position/normal versions last synced from the source; the source may be an animated deformer. */
  syncedPosition: number;
  syncedNormal: number;
  // CPU skinning
  basePositions?: Float32Array;
  baseNormals?: Float32Array | null;
  // GPU skinning
  gpuBones?: THREE.Bone[];
  /** Weight overlay for the selected joint, drawn on top of the skinned mesh while Show Weights is on. */
  heat?: { mesh: THREE.Mesh; joint: number; version: string };
  /** What the weight brush raycasts: the shape shown, frozen, with its own BVH (see skinPaintTargets). */
  proxy?: { mesh: THREE.Mesh; stamp: string };
}

interface SkinState {
  key?: string;
  mode?: Mode;
  meshes?: BoundMesh[];
  bones?: SkinBone[];
  object?: THREE.Object3D;
  posed?: PosedBones;
  bounds?: SkinBounds;
  /** Rest joints taken from the live pose, for rigs given as a plain Joints list. */
  snapshot?: THREE.Vector3[];
  snapshotKey?: string;
  /** The rig object this node hid, to show it again when it is switched back or the node goes. */
  hiddenRig?: THREE.Object3D;
  parents?: number[];
  /** The `weightPaint` and `weightTargets` params last applied, by identity. */
  paintRaw?: unknown;
  targetsRaw?: unknown;
  /** Bumped whenever the painted weights change, so the overlay redraws. */
  paintVersion?: number;
  /** Each joint's counterpart, and the bind space back to the rig's own (where x = 0 is its centre plane). */
  jointMirror?: number[];
  mirrorSpace?: THREE.Matrix4;
  /** Bind To "connected": the pose taken when the rig was connected, until the node's params carry it. */
  captured?: { key: string; pose: THREE.Vector3[] };
  /** The stored `bindPose` last read, by identity, and what it reads as. */
  bindRaw?: unknown;
  bindParsed?: THREE.Vector3[];
}

function removeProxy(bound: BoundMesh) {
  if (!bound.proxy) return;
  disposeGeometryBvh(bound.proxy.mesh.geometry);
  bound.proxy = undefined;
}

function removeHeat(bound: BoundMesh) {
  if (!bound.heat) return;
  bound.heat.mesh.removeFromParent();
  bound.heat.mesh.geometry.dispose();
  (bound.heat.mesh.material as THREE.Material).dispose();
  bound.heat = undefined;
}

function showRigAgain(state: SkinState) {
  if (state.hiddenRig) state.hiddenRig.visible = true;
  state.hiddenRig = undefined;
}

function disposeState(state: SkinState) {
  // Geometries are this node's own clones; materials belong to upstream nodes.
  state.meshes?.forEach((bound) => {
    removeHeat(bound);
    removeProxy(bound);
    bound.output.geometry.dispose();
    if (bound.output instanceof THREE.SkinnedMesh) bound.output.skeleton.dispose();
  });
  state.meshes = undefined;
  state.object = undefined;
  state.key = undefined;
}

const skinStates = createNodeCache<SkinState>((state) => {
  showRigAgain(state);
  disposeState(state);
});

interface ResolvedRig {
  parents: number[];
  rest: THREE.Vector3[];
  /** The pose to bind at when connecting (RigData.bind). */
  bind?: THREE.Vector3[];
  pose: THREE.Vector3[];
  /** Rig space -> world, now. */
  matrix: THREE.Matrix4;
  /** What rest joints are in, for the cache key. */
  restKey: string;
  names?: string[];
  twist?: number[];
}

const flatten = (points: THREE.Vector3[]) => points.map((p) => `${Math.round(p.x * 1e6)},${Math.round(p.y * 1e6)},${Math.round(p.z * 1e6)}`).join(";");

/** A rig node's rest joints are one array for as long as its proportions hold; flatten them once. */
const restKeys = new WeakMap<THREE.Vector3[], string>();

const keyOf = (points: THREE.Vector3[]) => {
  let key = restKeys.get(points);
  if (key === undefined) {
    key = flatten(points);
    restKeys.set(points, key);
  }
  return key;
};

/** A short, stable digest of a string (FNV-1a), for keys kept in params. */
function digest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Bind poses Skin nodes took when their rig was connected, waiting to be
 * written into their params (`bindPose`, `bindKey`) — or, when a rig or mesh
 * was disconnected, the cleared ones. The editor takes them after each
 * evaluation and stores them outside the undo history: they record what the
 * connection itself did, so undoing the connection undoes them too.
 */
const bindRequests = new Map<string, Record<string, unknown>>();

export function consumeSkinBindRequests(): { nodeId: string; params: Record<string, unknown> }[] {
  const out = [...bindRequests].map(([nodeId, params]) => ({ nodeId, params }));
  bindRequests.clear();
  return out;
}

/** App.tsx's onAction id for Compute: see computeSkinWeightTargets. */
export const SKIN_COMPUTE_ACTION = "skin-compute-weights";

/** The Recompute button's action: see skinReweighParams. */
export const SKIN_REWEIGH_ACTION = "skin-reweigh";

/** The params that make a Skin weigh its mesh again from scratch (the automatic weights; the paint stays on top). */
export function skinReweighParams(params: Record<string, unknown>): Record<string, unknown> {
  return { reweigh: (Math.round(Number(params.reweigh)) || 0) + 1 };
}

const bindToConnected = (params: Record<string, unknown>) => params.bindTo === "connected";

/** A Skin left without a rig or a mesh forgets the pose it was bound at, so connecting again takes the pose then. */
function forgetBindPose(nodeId: string, params: Record<string, unknown>, state: SkinState | undefined, capturing?: boolean) {
  if (state) state.captured = undefined;
  if (!bindToConnected(params) || capturing) return;
  if ((Array.isArray(params.bindPose) && params.bindPose.length > 0) || params.bindKey) bindRequests.set(nodeId, { bindPose: [], bindKey: "" });
}

/**
 * The joints a mesh is bound at. Bind To "rest": the rig's rest pose. Bind To
 * "connected": the pose the rig had when it was connected (its RigData.bind,
 * else its pose), so connecting moves nothing — kept in the params once the
 * editor has stored it, taken again when the rig changes shape or proportions
 * or Re-bind is toggled.
 */
function bindJoints(params: Record<string, unknown>, rig: ResolvedRig, state: SkinState, nodeId: string, capturing?: boolean): THREE.Vector3[] {
  if (!bindToConnected(params)) return rig.rest;
  const key = digest(`${rig.parents.join(",")}|${rig.restKey}|${toBoolean(params.rebind)}`);
  if (state.bindRaw !== params.bindPose) {
    state.bindRaw = params.bindPose;
    state.bindParsed = Array.isArray(params.bindPose) ? params.bindPose.map((p) => asVector3(p, new THREE.Vector3()).clone()) : [];
  }
  const stored = state.bindParsed ?? [];
  if (stored.length === rig.rest.length && params.bindKey === key && stored.every((p) => Number.isFinite(p.x + p.y + p.z))) return stored;
  if (!state.captured || state.captured.key !== key) state.captured = { key, pose: (rig.bind ?? rig.pose).map((p) => p.clone()) };
  // Stored exactly: binding again from the params must give the very weights bound now.
  if (!capturing) bindRequests.set(nodeId, { bindPose: state.captured.pose.map((p) => ({ x: p.x, y: p.y, z: p.z })), bindKey: key });
  return state.captured.pose;
}

function resolveRig(inputs: Record<string, unknown>, state: SkinState): ResolvedRig | null {
  const data: RigData | null = readRig(inputs.rig);
  if (data) {
    let restKey = restKeys.get(data.rest);
    if (restKey === undefined) {
      restKey = flatten(data.rest);
      restKeys.set(data.rest, restKey);
    }
    const bind = data.bind && data.bind.length === data.rest.length ? data.bind : undefined;
    return { parents: data.parents, rest: data.rest, pose: data.pose, matrix: data.matrix, restKey, names: data.names, twist: data.twist, bind };
  }

  if (!Array.isArray(inputs.joints) || inputs.joints.length === 0) return null;
  const zero = new THREE.Vector3();
  const pose = inputs.joints.map((j) => asVector3(j, zero).clone());
  const parents = Array.isArray(inputs.parents) && inputs.parents.length === pose.length
    ? inputs.parents.map((p) => Math.round(Number(p)))
    : pose.map((_, i) => i - 1);

  let rest: THREE.Vector3[];
  if (Array.isArray(inputs.restJoints) && inputs.restJoints.length === pose.length) {
    rest = inputs.restJoints.map((j) => asVector3(j, zero).clone());
  } else {
    // No rest given: the pose the rig had when binding started is the rest.
    const shape = `${pose.length}|${parents.join(",")}`;
    if (!state.snapshot || state.snapshotKey !== shape) {
      state.snapshot = pose.map((p) => p.clone());
      state.snapshotKey = shape;
    }
    rest = state.snapshot;
  }
  return { parents, rest, pose, matrix: new THREE.Matrix4(), restKey: flatten(rest) };
}

/** Blue (none) through green to red (all): how much of a vertex follows the joint. */
function heatColor(w: number, out: Float32Array, at: number) {
  const t = Math.max(0, Math.min(1, w));
  out[at] = Math.min(1, Math.max(0, (t - 0.5) * 3));
  out[at + 1] = t < 0.5 ? t * 2 : Math.max(0, 1 - (t - 0.5) * 1.6);
  out[at + 2] = Math.max(0, 1 - t * 2.4);
}

/**
 * The weight overlay: the same skinned geometry (positions shared, so it deforms with the mesh,
 * on the CPU or on the GPU's skeleton) painted by how much each vertex follows `joint`.
 * `joint` -1 removes it.
 */
function syncHeat(meshes: BoundMesh[], joint: number, version: string) {
  for (const bound of meshes) {
    if (joint < 0) {
      removeHeat(bound);
      continue;
    }
    if (bound.heat && bound.heat.joint === joint && bound.heat.version === version) continue;
    removeHeat(bound);
    const source = bound.output.geometry;
    const count = source.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let v = 0; v < count; v++) heatColor(jointWeight(bound.skin, v, joint), colors, v * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", source.attributes.position);
    if (source.index) geometry.setIndex(source.index);
    if (source.attributes.skinIndex) geometry.setAttribute("skinIndex", source.attributes.skinIndex);
    if (source.attributes.skinWeight) geometry.setAttribute("skinWeight", source.attributes.skinWeight);
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const skinned = bound.output instanceof THREE.SkinnedMesh ? bound.output : null;
    let mesh: THREE.Mesh;
    if (skinned) {
      const overlay = new THREE.SkinnedMesh(geometry, material);
      overlay.bindMode = THREE.DetachedBindMode;
      overlay.bind(skinned.skeleton, new THREE.Matrix4());
      mesh = overlay;
    } else {
      mesh = new THREE.Mesh(geometry, material);
    }
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    mesh.userData.skinHeat = true;
    bound.output.add(mesh);
    bound.heat = { mesh, joint, version };
  }
}

/** A stored per-joint list: numbers where set, undefined where the joint has no setting of its own. */
function numberList(raw: unknown): (number | undefined)[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v)));
}

/**
 * Show Rig off hides the rig object wired into Rig, and puts it back when the
 * option is switched on again, another rig is wired, or this node goes.
 */
function hideRig(state: SkinState, rigObject: unknown, show: boolean) {
  const target = rigObject instanceof THREE.Object3D ? rigObject : undefined;
  if (state.hiddenRig && state.hiddenRig !== target) showRigAgain(state);
  if (!target) return;
  if (show) {
    if (state.hiddenRig === target) showRigAgain(state);
    return;
  }
  target.visible = false;
  state.hiddenRig = target;
}

function frameOf(raw: THREE.Object3D, mesh: THREE.Mesh, matrix: unknown): THREE.Matrix4 {
  if (matrix instanceof THREE.Matrix4 && raw === mesh) return matrix.clone();
  mesh.updateMatrixWorld(true);
  return mesh.matrixWorld.clone();
}

const usesShaderMaterial = (mesh: THREE.Mesh) =>
  (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).some((m) => (m as THREE.ShaderMaterial)?.isShaderMaterial);

function chooseMode(requested: string, sources: THREE.Mesh[]): Mode {
  // A custom shader knows nothing of skinning: it would draw the rest pose.
  if (requested === "CPU" || sources.some(usesShaderMaterial)) return "CPU";
  if (requested === "GPU") return "GPU";
  const vertices = sources.reduce((sum, mesh) => sum + (mesh.geometry.attributes.position?.count ?? 0), 0);
  return vertices >= GPU_VERTICES ? "GPU" : "CPU";
}

/** Four strongest influences per vertex, for the GPU, renormalised. */
function gpuAttributes(skin: SkinWeights, vertexCount: number) {
  const indices = new Uint16Array(vertexCount * 4);
  const weights = new Float32Array(vertexCount * 4);
  writeGpuWeights(skin, indices, weights);
  return { indices, weights };
}

function writeGpuWeights(skin: SkinWeights, indices: Uint16Array, weights: Float32Array, vertices?: Iterable<number>) {
  const take = Math.min(4, skin.influences);
  const all = function* () {
    for (let v = 0; v < indices.length / 4; v++) yield v;
  };
  for (const v of vertices ?? all()) {
    let total = 0;
    for (let k = 0; k < take; k++) total += skin.weights[v * skin.influences + k];
    for (let k = 0; k < take; k++) {
      indices[v * 4 + k] = skin.indices[v * skin.influences + k];
      weights[v * 4 + k] = total > 0 ? skin.weights[v * skin.influences + k] / total : 0;
    }
  }
}

/** After the painted weights of `vertices` (all when omitted) changed: the GPU's copy and the overlay follow. */
function weightsChanged(bound: BoundMesh, vertices?: number[]) {
  const geometry = bound.output.geometry;
  const skinIndex = geometry.attributes.skinIndex as THREE.BufferAttribute | undefined;
  const skinWeight = geometry.attributes.skinWeight as THREE.BufferAttribute | undefined;
  if (skinIndex && skinWeight) {
    writeGpuWeights(bound.skin, skinIndex.array as Uint16Array, skinWeight.array as Float32Array, vertices);
    skinIndex.needsUpdate = true;
    skinWeight.needsUpdate = true;
  }
  const heat = bound.heat;
  if (!heat) return;
  const color = heat.mesh.geometry.attributes.color as THREE.BufferAttribute;
  const colors = color.array as Float32Array;
  if (vertices) for (const v of vertices) heatColor(jointWeight(bound.skin, v, heat.joint), colors, v * 3);
  else for (let v = 0; v < color.count; v++) heatColor(jointWeight(bound.skin, v, heat.joint), colors, v * 3);
  color.needsUpdate = true;
}

function makeOutput(source: THREE.Mesh, geometry: THREE.BufferGeometry, mode: Mode, skin: SkinWeights, boneCount: number): { output: THREE.Mesh; gpuBones?: THREE.Bone[] } {
  if (mode === "CPU") return { output: new THREE.Mesh(geometry, source.material) };
  const vertexCount = geometry.attributes.position.count;
  const { indices, weights } = gpuAttributes(skin, vertexCount);
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(indices, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weights, 4));
  const gpuBones = Array.from({ length: boneCount }, () => {
    const bone = new THREE.Bone();
    bone.matrixAutoUpdate = false;
    bone.matrixWorldAutoUpdate = false;
    return bone;
  });
  const skeleton = new THREE.Skeleton(gpuBones, gpuBones.map(() => new THREE.Matrix4()));
  const output = new THREE.SkinnedMesh(geometry, source.material);
  // Skinned in the mesh's own space; the mesh's matrix then places the result.
  output.bindMode = THREE.DetachedBindMode;
  output.bind(skeleton, new THREE.Matrix4());
  // The skinned shape is not what the geometry's bounds describe.
  output.frustumCulled = false;
  return { output, gpuBones };
}

export const SKIN_NODE: NodeDefinition = {
  type: "rig/skin",
  label: "Skin",
  category: "rig",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "rig", label: "Rig", type: "geometry" },
    { id: "joints", label: "Joints", type: "list" },
    { id: "restJoints", label: "Rest Joints", type: "list" },
    { id: "parents", label: "Parents", type: "list" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "amount", label: "Amount", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    amount: 1,
    bindSpace: "Rig",
    mode: "Auto",
    influences: 4,
    falloff: 4,
    smooth: 2,
    prune: 0.001,
    smoothStrength: 0.5,
    boneHops: 0,
    mirrorWeights: "off",
    // Bumped by Recompute: weighs the mesh again, as it is now, keeping the paint and the bind pose.
    reweigh: 0,
    stretch: false,
    rebind: false,
    showRig: true,
    // Files from before Bind To bind at the rest pose, as they always did; new nodes at the pose when connected.
    bindTo: "rest",
    bindPose: [],
    bindKey: "",
    // Weight painting, in the viewport, on the selected joint's map: on while weightPaintMode is.
    weightPaintMode: false,
    brushTool: "paint",
    brushValue: 1,
    brushSize: 24,
    brushOpacity: 1,
    brushHardness: 0.5,
    usePressure: true,
    pressureTarget: "both",
    resolution: 1024,
    // "mesh:joint" -> the painted map (PNG data URL), and what Compute read from it: see weightMaps.ts.
    weightMaps: {},
    weightTargets: {},
    // Per-vertex corrections from files of before the maps: see weightPaint.ts.
    weightPaint: [],
    showWeights: false,
    selectedJoint: -1,
    // Per joint, by index, missing = 1: how strongly it pulls (0 switches it off) and how far it reaches.
    jointStrength: [],
    jointRadius: [],
  },
  // A Skin made now binds where the rig stands when it is connected: connecting moves nothing.
  newNodeParams: { bindTo: "connected" },
  paramFields: [
    { id: "amount", label: "Amount", kind: "number", step: 0.05, group: "Skin" },
    { id: "bindSpace", label: "Bind Space", kind: "select", options: ["Rig", "World"], group: "Skin" },
    {
      id: "bindTo",
      label: "Bind To",
      kind: "select",
      options: ["connected", "rest"],
      optionLabels: ["Pose when connected (nothing moves)", "Rest pose of the rig"],
      group: "Skin",
    },
    { id: "mode", label: "Skinning", kind: "select", options: ["Auto", "CPU", "GPU"], group: "Skin" },
    { id: "stretch", label: "Stretch Bones", kind: "boolean", group: "Skin" },
    { id: "showRig", label: "Show Rig", kind: "boolean", group: "Skin" },
    { id: "showWeights", label: "Show Weights of Joint", kind: "boolean", group: "Weights" },
    { id: "influences", label: "Max Influences", kind: "number", step: 1, group: "Weights" },
    { id: "falloff", label: "Falloff", kind: "number", step: 0.5, group: "Weights" },
    { id: "smooth", label: "Smooth Weights", kind: "number", step: 1, group: "Weights" },
    { id: "prune", label: "Ignore Weights Below (share)", kind: "number", step: 0.01, group: "Weights" },
    { id: "smoothStrength", label: "Smooth Strength (0..1)", kind: "number", step: 0.05, group: "Weights" },
    { id: "boneHops", label: "Bone Reach (steps through the skeleton, 0 = all)", kind: "number", step: 1, group: "Weights" },
    {
      id: "mirrorWeights",
      label: "Mirror Weights",
      kind: "select",
      options: ["off", "left", "right"],
      optionLabels: ["Off", "Left side onto right", "Right side onto left"],
      group: "Weights",
    },
    { id: "reweighButton", label: "Recompute weights", kind: "button", action: SKIN_REWEIGH_ACTION, group: "Weights" },
    { id: "rebind", label: "Re-bind to the current pose (toggle)", kind: "boolean", group: "Weights" },
    {
      id: "weightPaintNote",
      label:
        "Paint in the viewport (Paint in the Skin bar): each joint has its own map, white all of the joint, black none, starting from its weights. "
        + "Compute to give the mesh what is painted. The mesh needs UVs.",
      kind: "note",
      group: "Weight Paint",
    },
    { id: "computeWeights", label: "Compute", kind: "button", action: SKIN_COMPUTE_ACTION, group: "Weight Paint" },
    { id: "weightPaintMode", label: "Paint Weights", kind: "boolean", group: "Weight Paint" },
    { id: "resolution", label: "Map Resolution", kind: "select", options: ["512", "1024", "2048"], group: "Weight Paint" },
    {
      id: "brushTool",
      label: "Tool",
      kind: "select",
      options: ["paint", "erase", "smooth", "fill"],
      optionLabels: ["Paint", "Erase", "Smooth", "Fill"],
      group: "Weight Paint",
    },
    { id: "brushValue", label: "Weight", kind: "number", step: 0.05, group: "Weight Paint" },
    { id: "brushSize", label: "Size (map px)", kind: "number", step: 1, group: "Weight Paint" },
    { id: "brushOpacity", label: "Opacity", kind: "number", step: 0.05, group: "Weight Paint" },
    { id: "brushHardness", label: "Hardness", kind: "number", step: 0.05, group: "Weight Paint" },
    { id: "usePressure", label: "Stylus Pressure", kind: "boolean", group: "Weight Paint" },
  ],
  evaluate: (inputs, params, ctx) => {
    const raw = inputs.geometry;
    if (!(raw instanceof THREE.Object3D)) {
      if (raw) warnMeshRequired(ctx.nodeId, "Skin", null);
      forgetBindPose(ctx.nodeId, params, skinStates.get(ctx.nodeId), ctx.capturing);
      return { geometry: raw, matrix: (raw as any)?.matrix };
    }
    const sources = collectMeshes(raw);
    if (sources.length === 0) {
      warnMeshRequired(ctx.nodeId, "Skin", raw);
      forgetBindPose(ctx.nodeId, params, skinStates.get(ctx.nodeId), ctx.capturing);
      return { geometry: raw, matrix: (raw as any)?.matrix };
    }
    clearMeshWarning(ctx.nodeId);

    let state = skinStates.get(ctx.nodeId);
    if (!state) {
      state = {};
      skinStates.set(ctx.nodeId, state);
    }
    const rig = resolveRig(inputs, state);
    hideRig(state, inputs.rig, toBoolean(params.showRig ?? true));
    raw.updateMatrixWorld(true);
    const frames = sources.map((mesh) => frameOf(raw, mesh, inputs.matrix));
    if (!rig || rig.rest.length === 0) {
      forgetBindPose(ctx.nodeId, params, state, ctx.capturing);
      return { geometry: raw, matrix: frames[0] };
    }
    const bind = bindJoints(params, rig, state, ctx.nodeId, ctx.capturing);

    // Bones are posed in one of two spaces. Rig: the rig's own space — the
    // mesh is modelled around the rig's origin, and the rig's transform then
    // carries it, so it follows a rig that is moved or walks. World: the mesh
    // is placed over the rig where it stands now, and stays put in the world.
    const rigSpace = String(params.bindSpace ?? "Rig") !== "World";
    const mode = chooseMode(String(params.mode ?? "Auto"), sources);
    const influences = Math.max(1, Math.min(8, Math.round(numberInput(undefined, params.influences, 4))));
    const falloff = Math.max(0.1, numberInput(undefined, params.falloff, 4));
    const smooth = Math.max(0, Math.min(20, Math.round(numberInput(undefined, params.smooth, 2))));
    const strength = numberList(params.jointStrength);
    const radius = numberList(params.jointRadius);
    const weightOptions = {
      influences,
      falloff,
      smooth,
      strength,
      radius,
      prune: Math.max(0, Math.min(0.5, numberInput(undefined, params.prune, 0.001))),
      smoothStrength: Math.max(0, Math.min(1, numberInput(undefined, params.smoothStrength, 0.5))),
      boneHops: Math.max(0, Math.min(8, Math.round(numberInput(undefined, params.boneHops, 0)))),
    };
    const mirrorWeights = params.mirrorWeights === "left" || params.mirrorWeights === "right" ? params.mirrorWeights : "off";

    const key = [
      sources.map((m) => `${m.geometry.uuid}:${m.geometry.attributes.position?.count ?? 0}:${m.geometry.getIndex()?.count ?? -1}`).join("|"),
      rig.parents.join(","),
      keyOf(bind),
      `${rigSpace}|${mode}|${influences}|${falloff}|${smooth}|${toBoolean(params.rebind)}`,
      JSON.stringify([strength, radius, weightOptions.prune, weightOptions.smoothStrength, weightOptions.boneHops, mirrorWeights, params.reweigh ?? 0]),
    ].join("#");

    if (state.key !== key || !state.meshes || !state.bones) {
      disposeState(state);
      const restInSpace = rigSpace ? bind : bind.map((p) => p.clone().applyMatrix4(rig.matrix));
      const bones = buildBones(rig.parents, restInSpace);
      state.bones = bones;
      state.mode = mode;
      state.jointMirror = mirrorJoints(rig.rest, rig.names);
      state.mirrorSpace = rigSpace ? new THREE.Matrix4() : rig.matrix.clone().invert();
      state.meshes = sources.map((source, i) => {
        const geometry = source.geometry.clone();
        const position = geometry.attributes.position as THREE.BufferAttribute;
        const normal = geometry.attributes.normal as THREE.BufferAttribute | undefined;
        const auto = computeSkinWeights(position.array, source.geometry.getIndex()?.array ?? null, frames[i], bones, weightOptions);
        // The paint goes on below; until then the automatic weights.
        const skin = cloneSkin(auto);
        // Material and shadow flags are taken from the source every frame, below.
        const { output, gpuBones } = makeOutput(source, geometry, mode, skin, bones.length);
        const bound: BoundMesh = {
          source,
          output,
          frame: frames[i],
          auto,
          skin,
          layer: new Map(),
          targets: new Map(),
          syncedPosition: (source.geometry.attributes.position as THREE.BufferAttribute).version,
          syncedNormal: (source.geometry.attributes.normal as THREE.BufferAttribute | undefined)?.version ?? 0,
          gpuBones,
        };
        if (mode === "CPU") {
          bound.basePositions = new Float32Array(position.array as Float32Array);
          bound.baseNormals = normal ? new Float32Array(normal.array as Float32Array) : null;
        }
        if (mirrorWeights !== "off") {
          // One side's weights, mirrored onto the other: before the paint, which stays as painted.
          const atRig = bindPositions(bound, state!.mirrorSpace);
          bound.mirror = mirrorVertices(atRig);
          mirrorSkinWeights(auto, atRig, bound.mirror, state!.jointMirror!, mirrorWeights);
          skin.indices.set(auto.indices);
          skin.weights.set(auto.weights);
          weightsChanged(bound);
        }
        return bound;
      });
      state.key = key;
      state.parents = rig.parents.slice();
      state.paintRaw = undefined;
      state.targetsRaw = undefined;
      state.posed = undefined;
      state.bounds = { min: new THREE.Vector3(), max: new THREE.Vector3() };
    }

    const { bones, meshes } = state;
    if (state.paintRaw === undefined || state.paintRaw !== params.weightPaint || state.targetsRaw !== params.weightTargets) {
      state.paintRaw = params.weightPaint ?? null;
      state.targetsRaw = params.weightTargets;
      meshes.forEach((bound, i) => {
        const vertexCount = bound.auto.indices.length / bound.auto.influences;
        bound.layer = readPaintLayer(params.weightPaint, i, vertexCount);
        bound.targets = readTargets(params.weightTargets, i, vertexCount);
        const painted = cloneSkin(bound.auto);
        applyPaintLayer(bound.auto, bound.layer, state!.parents!, painted);
        applyWeightTargets(painted, bound.targets, state!.parents!, bound.skin);
        weightsChanged(bound);
      });
      state.paintVersion = (state.paintVersion ?? 0) + 1;
    }
    syncWeightMaps(ctx.nodeId, params);
    const bonePose = rigSpace ? rig.pose : rig.pose.map((p) => p.clone().applyMatrix4(rig.matrix));
    const options = { stretch: toBoolean(params.stretch), amount: Math.max(0, Math.min(1, numberInput(inputs.amount, params.amount, 1))) };
    const turns = boneRotations(bones, bonePose, rig.twist);

    for (const bound of meshes) {
      const sourcePosition = bound.source.geometry.attributes.position as THREE.BufferAttribute | undefined;
      const sourceNormal = bound.source.geometry.attributes.normal as THREE.BufferAttribute | undefined;
      const outPosition = bound.output.geometry.attributes.position as THREE.BufferAttribute;
      const outNormal = bound.output.geometry.attributes.normal as THREE.BufferAttribute | undefined;

      // The source's node may swap its material (Shadeless, a wired Material,
      // Transmission) and dispose the old one: show the one it carries now.
      const { output, source } = bound;
      output.material = source.material;
      output.castShadow = source.castShadow;
      output.receiveShadow = source.receiveShadow;
      output.renderOrder = source.renderOrder;

      // The source may be another deformer's output, rewritten in place every
      // frame: follow it when (and only when) it says it changed.
      const positionsChanged = !!sourcePosition && sourcePosition.version !== bound.syncedPosition && sourcePosition.array.length === outPosition.array.length;
      const normalsChanged = !!sourceNormal && !!outNormal && sourceNormal.version !== bound.syncedNormal && sourceNormal.array.length === outNormal.array.length;
      if (positionsChanged) {
        bound.syncedPosition = sourcePosition!.version;
        if (bound.basePositions) bound.basePositions.set(sourcePosition!.array as Float32Array);
        else {
          (outPosition.array as Float32Array).set(sourcePosition!.array as Float32Array);
          outPosition.needsUpdate = true;
        }
      }
      if (normalsChanged) {
        bound.syncedNormal = sourceNormal!.version;
        if (bound.baseNormals) bound.baseNormals.set(sourceNormal!.array as Float32Array);
        else {
          (outNormal!.array as Float32Array).set(sourceNormal!.array as Float32Array);
          outNormal!.needsUpdate = true;
        }
      }

      state.posed = poseBones(bones, bonePose, bound.frame, options, state.posed, turns);
      if (bound.basePositions) {
        const bounds = state.bounds!;
        skinVertices(
          outPosition.array as Float32Array,
          bound.basePositions,
          bound.skin,
          state.posed.pos,
          outNormal && bound.baseNormals ? { out: outNormal.array as Float32Array, base: bound.baseNormals, mats: state.posed.nrm } : undefined,
          bounds,
        );
        outPosition.needsUpdate = true;
        if (outNormal) outNormal.needsUpdate = true;
        // Bounds straight from the skinning pass, no second walk over the vertices.
        const geometry = bound.output.geometry;
        geometry.boundingBox = (geometry.boundingBox ?? new THREE.Box3()).set(bounds.min, bounds.max);
        geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(geometry.boundingSphere ?? new THREE.Sphere());
      } else if (bound.gpuBones) {
        const p = state.posed.pos;
        bound.gpuBones.forEach((bone, i) => {
          const o = i * 12;
          bone.matrixWorld.set(p[o], p[o + 1], p[o + 2], p[o + 3], p[o + 4], p[o + 5], p[o + 6], p[o + 7], p[o + 8], p[o + 9], p[o + 10], p[o + 11], 0, 0, 0, 1);
        });
      }
    }

    // Single mesh: the mesh itself. Several: a Group of them.
    const single = raw instanceof THREE.Mesh && meshes.length === 1;
    if (!state.object) {
      if (single) {
        state.object = meshes[0].output;
      } else {
        const group = new THREE.Group();
        for (const bound of meshes) group.add(bound.output);
        state.object = group;
      }
    }
    // Rig space: the rig's matrix places what was skinned around its origin.
    // The mesh's current matrix, not the one it was weighed at: moving the
    // mesh afterwards moves the whole skinned result.
    const place = (frame: THREE.Matrix4) => (rigSpace ? rig.matrix.clone().multiply(frame) : frame.clone());
    meshes.forEach((bound, i) => {
      const target = bound.output;
      target.matrixAutoUpdate = false;
      target.matrix.copy(place(frames[i]));
      target.matrix.decompose(target.position, target.quaternion, target.scale);
      target.matrixWorldNeedsUpdate = true;
    });

    // Joints the viewport lets one pick to edit their influence, where the rig stands now.
    const worldJoints = rig.pose.map((p) => p.clone().applyMatrix4(rig.matrix));
    const selected = Math.round(numberInput(undefined, params.selectedJoint, -1));
    // While painting, the viewport shows the joint's map instead.
    const heat = toBoolean(params.showWeights) && !toBoolean(params.weightPaintMode) && !ctx.capturing && selected >= 0 && selected < rig.pose.length;
    syncHeat(meshes, heat ? selected : -1, `${state.key}|${state.paintVersion}`);
    state.object.userData = {
      ...raw.userData,
      nodeId: ctx.nodeId,
      skinEdit: { joints: worldJoints, names: rig.names, parents: rig.parents, selected, mirror: state.jointMirror },
    };
    return { geometry: state.object, matrix: single ? meshes[0].output.matrix : place(frames[0]) };
  },
};

/** What a joint's influence is set to now (1 and 1 when untouched). */
export function readJointInfluence(params: Record<string, unknown>, joint: number): { strength: number; radius: number } {
  return { strength: numberList(params.jointStrength)[joint] ?? 1, radius: numberList(params.jointRadius)[joint] ?? 1 };
}

/**
 * The params to write to change one joint's influence, the others left as
 * they were. A value back at 1 is stored as unset, so an untouched joint
 * leaves nothing in the saved file.
 */
export function withJointInfluence(params: Record<string, unknown>, joint: number, change: { strength?: number; radius?: number }, mirror = -1): Record<string, unknown> {
  const put = (raw: unknown, value: number | undefined) => {
    const list: (number | null)[] = numberList(raw).map((v) => v ?? null);
    for (const j of mirror >= 0 ? [joint, mirror] : [joint]) {
      while (list.length <= j) list.push(null);
      if (value !== undefined) list[j] = Math.abs(value - 1) < 1e-9 ? null : value;
    }
    while (list.length > 0 && list[list.length - 1] === null) list.pop();
    return list;
  };
  return {
    ...(change.strength !== undefined ? { jointStrength: put(params.jointStrength, change.strength) } : {}),
    ...(change.radius !== undefined ? { jointRadius: put(params.jointRadius, change.radius) } : {}),
  };
}


const scratch = new THREE.Vector3();

/** Where `bound`'s vertices were bound, in the rig's own space: what L → R and R → L mirror across. */
function bindPositions(bound: BoundMesh, mirrorSpace = new THREE.Matrix4()): Float32Array {
  const position = bound.source.geometry.attributes.position as THREE.BufferAttribute;
  const toRig = mirrorSpace.clone().multiply(bound.frame);
  const out = new Float32Array(position.count * 3);
  for (let v = 0; v < position.count; v++) {
    scratch.fromBufferAttribute(position, v).applyMatrix4(toRig);
    out[v * 3] = scratch.x;
    out[v * 3 + 1] = scratch.y;
    out[v * 3 + 2] = scratch.z;
  }
  return out;
}

/** The meshes a Skin node shows, for the weight brush to hit; empty when it has bound nothing. */
export function skinPaintMeshes(nodeId: string): THREE.Mesh[] {
  return skinStates.get(nodeId)?.meshes?.map((bound) => bound.output) ?? [];
}

/** A cheap fingerprint of the bone pose, so a proxy is rebuilt when the shape shown changed, not every evaluation. */
function poseStamp(state: SkinState, bound: BoundMesh): string {
  const pos = state.posed?.pos;
  let sum = 0;
  if (pos) for (let i = 0; i < pos.length; i++) sum += pos[i] * ((i % 97) + 1);
  return `${state.key}|${bound.syncedPosition}|${sum.toFixed(5)}`;
}

/**
 * What the weight brush raycasts, one per bound mesh in the same order as
 * skinPaintMeshes: a mesh with the shape shown now (skinned, on the CPU or
 * the GPU), its UVs, and a BVH — the brush walks the surface every few
 * pixels, and a plain raycast of a character costs milliseconds each. A copy,
 * so the output's own geometry never carries an index that the next pose
 * would make stale. Rebuilt when the pose changes; with `keep` (mid-stroke)
 * left as it is.
 */
export function skinPaintTargets(nodeId: string, keep = false): THREE.Mesh[] {
  const state = skinStates.get(nodeId);
  if (!state?.meshes) return [];
  // The BVH raycast; the app installs it at start, this only makes sure.
  initBvhRaycast();
  return state.meshes.map((bound) => {
    const { output } = bound;
    const stamp = poseStamp(state, bound);
    if (!bound.proxy || (!keep && bound.proxy.stamp !== stamp)) {
      removeProxy(bound);
      const shown = output.geometry;
      const count = shown.attributes.position.count;
      const positions = new Float32Array(count * 3);
      const skinned = output instanceof THREE.SkinnedMesh ? output : null;
      if (skinned) {
        skinned.skeleton.update();
        for (let v = 0; v < count; v++) {
          skinned.getVertexPosition(v, scratch);
          positions[v * 3] = scratch.x;
          positions[v * 3 + 1] = scratch.y;
          positions[v * 3 + 2] = scratch.z;
        }
      } else {
        positions.set(shown.attributes.position.array as Float32Array);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      if (shown.attributes.uv) geometry.setAttribute("uv", shown.attributes.uv);
      if (shown.index) geometry.setIndex(shown.index);
      getBoundsTree(geometry);
      const mesh = new THREE.Mesh(geometry);
      mesh.matrixAutoUpdate = false;
      bound.proxy = { mesh, stamp };
    }
    const mesh = bound.proxy.mesh;
    output.updateWorldMatrix(true, false);
    mesh.matrix.copy(output.matrixWorld);
    mesh.matrixWorld.copy(output.matrixWorld);
    return mesh;
  });
}

// ---------------------------------------------------------------------------
// Weight maps

/** Where Texture Paint keeps one map's canvas: the node's id and the map's key. */
export const skinMapStateKey = (nodeId: string, mesh: number, joint: number) => `${nodeId}#${mapKey(mesh, joint)}`;

/** Maps being painted that the params do not carry yet, per node: they must not be redrawn from the weights under the brush. */
const paintedMaps = new Map<string, Set<string>>();
/** The weights each map not yet painted was drawn from, so it is drawn again only when they change. */
const drawnFrom = new Map<string, string>();

const mapResolution = (params: Record<string, unknown>) => Math.max(64, Math.min(4096, Number(params.resolution) || 1024));
const storedMaps = (params: Record<string, unknown>): Record<string, string> =>
  params.weightMaps && typeof params.weightMaps === "object" ? (params.weightMaps as Record<string, string>) : {};
const storedTargets = (params: Record<string, unknown>): Record<string, StoredTarget> =>
  params.weightTargets && typeof params.weightTargets === "object" ? (params.weightTargets as Record<string, StoredTarget>) : {};

/** The canvas (made or resized as needed) one map is painted on. Null outside a browser. */
function mapCanvas(stateKey: string, res: number) {
  if (typeof document === "undefined") return null;
  const state = getTexturePaintState(stateKey);
  if (!state.canvas || state.lastRes !== res) {
    state.canvas = createPaintCanvas(res, res, "#000000");
    state.lastRes = res;
    state.lastDataUrl = undefined;
    drawnFrom.delete(stateKey);
    // Data, not colour: no sRGB decode, so the shader reads the value painted.
    state.texture = syncCanvasTexture(state.texture, state.canvas, THREE.NoColorSpace);
  }
  return state;
}

/** Brings the canvases of the stored maps in line with the params: a reload, an undo, a Clear. */
function syncWeightMaps(nodeId: string, params: Record<string, unknown>) {
  const maps = storedMaps(params);
  const res = mapResolution(params);
  for (const [key, dataUrl] of Object.entries(maps)) {
    const at = parseMapKey(key);
    if (!at) continue;
    const stateKey = skinMapStateKey(nodeId, at.mesh, at.joint);
    const state = mapCanvas(stateKey, res);
    if (!state || state.lastDataUrl === dataUrl) continue;
    state.lastDataUrl = dataUrl;
    paintedMaps.get(nodeId)?.delete(stateKey);
    restorePaintCanvas(state.canvas!, dataUrl, () => {
      if (state.texture) state.texture.needsUpdate = true;
    });
  }
  // A map gone from the params after it was stored (undo, Clear) is drawn from the weights again.
  const painting = paintedMaps.get(nodeId);
  if (painting) {
    for (const stateKey of painting) {
      const key = stateKey.slice(nodeId.length + 1);
      if (!(key in maps) && getTexturePaintState(stateKey).lastDataUrl) {
        painting.delete(stateKey);
        getTexturePaintState(stateKey).lastDataUrl = undefined;
        drawnFrom.delete(stateKey);
      }
    }
  }
}

/** The weights of `joint` on one bound mesh now, per vertex. */
function jointValues(bound: BoundMesh, joint: number): Float32Array {
  const count = bound.skin.indices.length / bound.skin.influences;
  const values = new Float32Array(count);
  for (let v = 0; v < count; v++) values[v] = jointWeight(bound.skin, v, joint);
  return values;
}

function drawValues(stateKey: string, bound: BoundMesh, values: ArrayLike<number>): boolean {
  const state = getTexturePaintState(stateKey);
  const uv = bound.source.geometry.attributes.uv;
  const ctx2d = state.canvas?.getContext("2d", { willReadFrequently: true });
  if (!state.canvas || !uv || !ctx2d) return false;
  const image = ctx2d.createImageData(state.canvas.width, state.canvas.height);
  rasterizeVertexValues(image.data, image.width, image.height, uv, values, bound.source.geometry.getIndex()?.array ?? null);
  ctx2d.putImageData(image, 0, 0);
  if (state.texture) state.texture.needsUpdate = true;
  return true;
}

/**
 * The map of `joint` on bound mesh `mesh`, ready to show or paint: its stored
 * painting, or, for a joint not painted yet, drawn from its weights now. With
 * `paint`, a stroke is about to land on it: from then on it is the painting.
 * Returns the Texture Paint key of its canvas; null when the mesh has no UVs.
 */
export function skinWeightMap(nodeId: string, params: Record<string, unknown>, mesh: number, joint: number, paint = false): string | null {
  const skin = skinStates.get(nodeId);
  const bound = skin?.meshes?.[mesh];
  if (!skin || !bound || !bound.source.geometry.attributes.uv || joint < 0 || joint >= (skin.parents?.length ?? 0)) return null;
  const stateKey = skinMapStateKey(nodeId, mesh, joint);
  const state = mapCanvas(stateKey, mapResolution(params));
  if (!state) return null;
  const painting = paintedMaps.get(nodeId) ?? new Set<string>();
  paintedMaps.set(nodeId, painting);
  if (!(mapKey(mesh, joint) in storedMaps(params)) && !painting.has(stateKey)) {
    const from = `${skin.key}|${skin.paintVersion}`;
    if (drawnFrom.get(stateKey) !== from && drawValues(stateKey, bound, jointValues(bound, joint))) drawnFrom.set(stateKey, from);
  }
  if (paint) painting.add(stateKey);
  return stateKey;
}

/** `weightMaps` with every map painted since the params last carried it written in. */
export function skinWeightMapsParams(nodeId: string, params: Record<string, unknown>): Record<string, unknown> | null {
  const painting = paintedMaps.get(nodeId);
  if (!painting || painting.size === 0) return null;
  const maps = { ...storedMaps(params) };
  for (const stateKey of painting) {
    const state = getTexturePaintState(stateKey);
    if (!state.canvas) continue;
    const dataUrl = serializePaintCanvas(state.canvas);
    // Already what the canvas shows: no decoding it back over the canvas.
    state.lastDataUrl = dataUrl;
    maps[stateKey.slice(nodeId.length + 1)] = dataUrl;
  }
  return { weightMaps: maps };
}

/** What every map of the node reads under the vertices of its mesh. */
function readMaps(nodeId: string, params: Record<string, unknown>, skin: SkinState): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const keys = new Set(Object.keys(storedMaps(params)));
  for (const stateKey of paintedMaps.get(nodeId) ?? []) keys.add(stateKey.slice(nodeId.length + 1));
  for (const key of keys) {
    const at = parseMapKey(key);
    const bound = at ? skin.meshes?.[at.mesh] : undefined;
    const canvas = at ? getTexturePaintState(skinMapStateKey(nodeId, at.mesh, at.joint)).canvas : undefined;
    const geometry = bound?.source.geometry;
    const ctx2d = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !geometry?.attributes.uv || !ctx2d) continue;
    const { data } = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
    out.set(key, toBytes(sampleMapValues(data, canvas.width, canvas.height, geometry.attributes.uv, geometry.attributes.position)));
  }
  return out;
}

/** Compute: the maps read into `weightTargets` (and the maps painted since, stored). Null when the node has bound nothing. */
export function computeSkinWeightTargets(nodeId: string, params: Record<string, unknown>): Record<string, unknown> | null {
  const skin = skinStates.get(nodeId);
  if (!skin?.meshes) return null;
  const targets: Record<string, StoredTarget> = {};
  for (const [key, bytes] of readMaps(nodeId, params, skin)) targets[key] = storeTarget(bytes);
  return { ...(skinWeightMapsParams(nodeId, params) ?? {}), weightTargets: targets };
}

/**
 * L → R (from "left") or R → L: every painted joint's map copied onto the
 * other side, mirrored, joint to counterpart — the maps redrawn and computed
 * at once. Null when the node has bound nothing.
 */
export function mirrorSkinWeightMaps(nodeId: string, params: Record<string, unknown>, from: "left" | "right"): Record<string, unknown> | null {
  const skin = skinStates.get(nodeId);
  if (!skin?.meshes || !skin.jointMirror) return null;
  const read = readMaps(nodeId, params, skin);
  const maps = { ...storedMaps(params) };
  const targets = { ...storedTargets(params) };
  skin.meshes.forEach((bound, mesh) => {
    const own: WeightTargets = new Map();
    for (const [key, bytes] of read) {
      const at = parseMapKey(key)!;
      if (at.mesh === mesh) own.set(at.joint, bytes);
    }
    if (own.size === 0) return;
    const positions = bindPositions(bound, skin.mirrorSpace);
    bound.mirror ??= mirrorVertices(positions);
    const mirrored = mirrorTargets(own, (j, v) => jointWeight(bound.skin, v, j), positions, bound.mirror, skin.jointMirror!, from);
    for (const [joint, bytes] of mirrored) {
      const key = mapKey(mesh, joint);
      targets[key] = storeTarget(bytes);
      const stateKey = skinWeightMap(nodeId, params, mesh, joint);
      if (!stateKey) continue;
      const values = Float32Array.from(bytes, (b) => b / 255);
      if (!drawValues(stateKey, bound, values)) continue;
      const state = getTexturePaintState(stateKey);
      const dataUrl = serializePaintCanvas(state.canvas!);
      state.lastDataUrl = dataUrl;
      paintedMaps.get(nodeId)?.delete(stateKey);
      maps[key] = dataUrl;
    }
  });
  return { weightMaps: maps, weightTargets: targets };
}

/** Whether `joint` (and its counterpart, when given) has a map, painted or computed. */
export function hasJointMap(params: Record<string, unknown>, joint: number, mirror = -1): boolean {
  const joints = new Set(mirror >= 0 ? [joint, mirror] : [joint]);
  return [...Object.keys(storedMaps(params)), ...Object.keys(storedTargets(params))].some((key) => joints.has(parseMapKey(key)?.joint ?? -1));
}

/**
 * Clear, in Paint mode: `joint`'s map painted 0 everywhere, on every mesh,
 * like any stroke — the mesh only gets it at the next Compute.
 */
export function clearJointMap(nodeId: string, params: Record<string, unknown>, joint: number): Record<string, unknown> | null {
  const skin = skinStates.get(nodeId);
  if (!skin?.meshes || joint < 0) return null;
  skin.meshes.forEach((_, mesh) => {
    const stateKey = skinWeightMap(nodeId, params, mesh, joint, true);
    const state = stateKey ? getTexturePaintState(stateKey) : null;
    if (!state?.canvas) return;
    clearPaintCanvas(state.canvas, "#000000");
    if (state.texture) state.texture.needsUpdate = true;
  });
  return skinWeightMapsParams(nodeId, params);
}

/** `joint` (every joint at -1) back to its automatic weights — its maps and what Compute read from them gone. */
export function withoutJointMap(nodeId: string, params: Record<string, unknown>, joint: number): Record<string, unknown> {
  const keep = (key: string) => joint >= 0 && parseMapKey(key)?.joint !== joint;
  const painting = paintedMaps.get(nodeId);
  if (painting) {
    for (const stateKey of [...painting]) if (!keep(stateKey.slice(nodeId.length + 1))) painting.delete(stateKey);
  }
  for (const key of Object.keys(storedMaps(params))) if (!keep(key)) drawnFrom.delete(`${nodeId}#${key}`);
  return {
    weightMaps: Object.fromEntries(Object.entries(storedMaps(params)).filter(([key]) => keep(key))),
    weightTargets: Object.fromEntries(Object.entries(storedTargets(params)).filter(([key]) => keep(key))),
    ...(joint < 0 ? { weightPaint: [] } : {}),
  };
}
