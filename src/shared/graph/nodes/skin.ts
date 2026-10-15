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
 */

type Mode = "CPU" | "GPU";

/** Vertices above which Auto skins on the GPU. */
const GPU_VERTICES = 20_000;

interface BoundMesh {
  source: THREE.Mesh;
  output: THREE.Mesh;
  /** The mesh's matrix when it was weighed: what the bones' rest space sees of it. */
  frame: THREE.Matrix4;
  skin: SkinWeights;
  /** Output position/normal versions last synced from the source; the source may be an animated deformer. */
  syncedPosition: number;
  syncedNormal: number;
  // CPU skinning
  basePositions?: Float32Array;
  baseNormals?: Float32Array | null;
  // GPU skinning
  gpuBones?: THREE.Bone[];
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
}

function disposeState(state: SkinState) {
  // Geometries are this node's own clones; materials belong to upstream nodes.
  state.meshes?.forEach((bound) => {
    bound.output.geometry.dispose();
    if (bound.output instanceof THREE.SkinnedMesh) bound.output.skeleton.dispose();
  });
  state.meshes = undefined;
  state.object = undefined;
  state.key = undefined;
}

const skinStates = createNodeCache<SkinState>(disposeState);

interface ResolvedRig {
  parents: number[];
  rest: THREE.Vector3[];
  pose: THREE.Vector3[];
  /** Rig space -> world, now. */
  matrix: THREE.Matrix4;
  /** What rest joints are in, for the cache key. */
  restKey: string;
}

const flatten = (points: THREE.Vector3[]) => points.map((p) => `${Math.round(p.x * 1e6)},${Math.round(p.y * 1e6)},${Math.round(p.z * 1e6)}`).join(";");

/** A rig node's rest joints are one array for as long as its proportions hold; flatten them once. */
const restKeys = new WeakMap<THREE.Vector3[], string>();

function resolveRig(inputs: Record<string, unknown>, state: SkinState): ResolvedRig | null {
  const data: RigData | null = readRig(inputs.rig);
  if (data) {
    let restKey = restKeys.get(data.rest);
    if (restKey === undefined) {
      restKey = flatten(data.rest);
      restKeys.set(data.rest, restKey);
    }
    return { parents: data.parents, rest: data.rest, pose: data.pose, matrix: data.matrix, restKey };
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
  const take = Math.min(4, skin.influences);
  for (let v = 0; v < vertexCount; v++) {
    let total = 0;
    for (let k = 0; k < take; k++) total += skin.weights[v * skin.influences + k];
    for (let k = 0; k < take; k++) {
      indices[v * 4 + k] = skin.indices[v * skin.influences + k];
      weights[v * 4 + k] = total > 0 ? skin.weights[v * skin.influences + k] / total : 0;
    }
  }
  return { indices, weights };
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
    stretch: false,
    rebind: false,
  },
  paramFields: [
    { id: "amount", label: "Amount", kind: "number", step: 0.05, group: "Skin" },
    { id: "bindSpace", label: "Bind Space", kind: "select", options: ["Rig", "World"], group: "Skin" },
    { id: "mode", label: "Skinning", kind: "select", options: ["Auto", "CPU", "GPU"], group: "Skin" },
    { id: "stretch", label: "Stretch Bones", kind: "boolean", group: "Skin" },
    { id: "influences", label: "Max Influences", kind: "number", step: 1, group: "Weights" },
    { id: "falloff", label: "Falloff", kind: "number", step: 0.5, group: "Weights" },
    { id: "smooth", label: "Smooth Weights", kind: "number", step: 1, group: "Weights" },
    { id: "rebind", label: "Re-bind (toggle)", kind: "boolean", group: "Weights" },
  ],
  evaluate: (inputs, params, ctx) => {
    const raw = inputs.geometry;
    if (!(raw instanceof THREE.Object3D)) {
      if (raw) warnMeshRequired(ctx.nodeId, "Skin", null);
      return { geometry: raw, matrix: (raw as any)?.matrix };
    }
    const sources = collectMeshes(raw);
    if (sources.length === 0) {
      warnMeshRequired(ctx.nodeId, "Skin", raw);
      return { geometry: raw, matrix: (raw as any)?.matrix };
    }
    clearMeshWarning(ctx.nodeId);

    let state = skinStates.get(ctx.nodeId);
    if (!state) {
      state = {};
      skinStates.set(ctx.nodeId, state);
    }
    const rig = resolveRig(inputs, state);
    raw.updateMatrixWorld(true);
    const frames = sources.map((mesh) => frameOf(raw, mesh, inputs.matrix));
    if (!rig || rig.rest.length === 0) return { geometry: raw, matrix: frames[0] };

    // Bones are posed in one of two spaces. Rig: the rig's own space — the
    // mesh is modelled around the rig's origin, and the rig's transform then
    // carries it, so it follows a rig that is moved or walks. World: the mesh
    // is placed over the rig where it stands now, and stays put in the world.
    const rigSpace = String(params.bindSpace ?? "Rig") !== "World";
    const mode = chooseMode(String(params.mode ?? "Auto"), sources);
    const influences = Math.max(1, Math.min(8, Math.round(numberInput(undefined, params.influences, 4))));
    const falloff = Math.max(0.1, numberInput(undefined, params.falloff, 4));
    const smooth = Math.max(0, Math.min(20, Math.round(numberInput(undefined, params.smooth, 2))));

    const key = [
      sources.map((m) => `${m.geometry.uuid}:${m.geometry.attributes.position?.count ?? 0}:${m.geometry.getIndex()?.count ?? -1}`).join("|"),
      rig.parents.join(","),
      rig.restKey,
      `${rigSpace}|${mode}|${influences}|${falloff}|${smooth}|${toBoolean(params.rebind)}`,
    ].join("#");

    if (state.key !== key || !state.meshes || !state.bones) {
      disposeState(state);
      const restInSpace = rigSpace ? rig.rest : rig.rest.map((p) => p.clone().applyMatrix4(rig.matrix));
      const bones = buildBones(rig.parents, restInSpace);
      state.bones = bones;
      state.mode = mode;
      state.meshes = sources.map((source, i) => {
        const geometry = source.geometry.clone();
        const position = geometry.attributes.position as THREE.BufferAttribute;
        const normal = geometry.attributes.normal as THREE.BufferAttribute | undefined;
        const skin = computeSkinWeights(position.array, source.geometry.getIndex()?.array ?? null, frames[i], bones, { influences, falloff, smooth });
        const { output, gpuBones } = makeOutput(source, geometry, mode, skin, bones.length);
        output.castShadow = source.castShadow;
        output.receiveShadow = source.receiveShadow;
        output.renderOrder = source.renderOrder;
        const bound: BoundMesh = {
          source,
          output,
          frame: frames[i],
          skin,
          syncedPosition: (source.geometry.attributes.position as THREE.BufferAttribute).version,
          syncedNormal: (source.geometry.attributes.normal as THREE.BufferAttribute | undefined)?.version ?? 0,
          gpuBones,
        };
        if (mode === "CPU") {
          bound.basePositions = new Float32Array(position.array as Float32Array);
          bound.baseNormals = normal ? new Float32Array(normal.array as Float32Array) : null;
        }
        return bound;
      });
      state.key = key;
      state.posed = undefined;
      state.bounds = { min: new THREE.Vector3(), max: new THREE.Vector3() };
    }

    const { bones, meshes } = state;
    const bonePose = rigSpace ? rig.pose : rig.pose.map((p) => p.clone().applyMatrix4(rig.matrix));
    const options = { stretch: toBoolean(params.stretch), amount: Math.max(0, Math.min(1, numberInput(inputs.amount, params.amount, 1))) };
    const turns = boneRotations(bones, bonePose);

    for (const bound of meshes) {
      const sourcePosition = bound.source.geometry.attributes.position as THREE.BufferAttribute | undefined;
      const sourceNormal = bound.source.geometry.attributes.normal as THREE.BufferAttribute | undefined;
      const outPosition = bound.output.geometry.attributes.position as THREE.BufferAttribute;
      const outNormal = bound.output.geometry.attributes.normal as THREE.BufferAttribute | undefined;

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
    state.object.userData = { ...raw.userData, nodeId: ctx.nodeId };
    return { geometry: state.object, matrix: single ? meshes[0].output.matrix : place(frames[0]) };
  },
};
