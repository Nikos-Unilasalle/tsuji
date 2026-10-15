import * as THREE from "three";
import { createNodeCache } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { clearMeshWarning, collectMeshes, warnMeshRequired } from "../meshRequired";
import { toBoolean } from "../sockets";
import { numberInput } from "./object";
import { asVector3 } from "./transform";
import {
  buildBones,
  computeSkinWeights,
  PosedBones,
  poseBones,
  readRig,
  RigData,
  SkinBone,
  SkinWeights,
  skinNormals,
  skinPositions,
} from "../ik/skinning";

/**
 * Skin: binds a mesh to any rig and deforms it as the rig moves.
 *
 * "Any rig" means anything that publishes joints with parents (every Rig node
 * does, on its geometry's `userData.rig`), or a plain list of joint positions
 * wired into Joints — a chain unless a Parents list says otherwise. Skin does
 * not care how the rig was posed, and the mesh may be procedural or imported.
 *
 * Binding happens once, at the rest pose, and is redone only when something it
 * depends on changes (the mesh, the rest joints, the weight settings, or the
 * mesh's own matrix). Each frame after that is a blend of the bone matrices.
 */

interface BoundMesh {
  source: THREE.Mesh;
  output: THREE.Mesh;
  /** The undeformed vertices every frame starts from, re-synced from the source. */
  basePositions: Float32Array;
  baseNormals: Float32Array | null;
  frame: THREE.Matrix4;
  skin: SkinWeights;
}

interface SkinState {
  key?: string;
  meshes?: BoundMesh[];
  bones?: SkinBone[];
  object?: THREE.Object3D;
  posed?: PosedBones;
  /** Rest joints taken from the live pose, for rigs given as a plain Joints list. */
  snapshot?: THREE.Vector3[];
  snapshotKey?: string;
}

function disposeState(state: SkinState) {
  // Geometries are this node's own clones; materials belong to upstream nodes.
  state.meshes?.forEach((bound) => bound.output.geometry.dispose());
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

function resolveRig(inputs: Record<string, unknown>, state: SkinState): ResolvedRig | null {
  const data: RigData | null = readRig(inputs.rig);
  if (data) return { parents: data.parents, rest: data.rest, pose: data.pose, matrix: data.matrix, restKey: flatten(data.rest) };

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
    influences: 4,
    falloff: 4,
    smooth: 2,
    stretch: false,
  },
  paramFields: [
    { id: "amount", label: "Amount", kind: "number", step: 0.05, group: "Skin" },
    { id: "bindSpace", label: "Bind Space", kind: "select", options: ["Rig", "World"], group: "Skin" },
    { id: "stretch", label: "Stretch Bones", kind: "boolean", group: "Skin" },
    { id: "influences", label: "Max Influences", kind: "number", step: 1, group: "Weights" },
    { id: "falloff", label: "Falloff", kind: "number", step: 0.5, group: "Weights" },
    { id: "smooth", label: "Smooth Weights", kind: "number", step: 1, group: "Weights" },
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
    const objectMatrix = frameOf(raw, sources[0], inputs.matrix);
    if (!rig || rig.rest.length === 0) return { geometry: raw, matrix: objectMatrix };

    raw.updateMatrixWorld(true);
    // Bones are posed in one of two spaces. Rig: the rig's own space — the
    // mesh is modelled around the rig's origin, and the rig's transform then
    // carries it, so it follows a rig that is moved or walks. World: the mesh
    // is placed over the rig where it stands now, and stays put in the world.
    const rigSpace = String(params.bindSpace ?? "Rig") !== "World";
    const frames = sources.map((mesh) => frameOf(raw, mesh, inputs.matrix));

    const influences = Math.max(1, Math.min(8, Math.round(numberInput(undefined, params.influences, 4))));
    const falloff = Math.max(0.1, numberInput(undefined, params.falloff, 4));
    const smooth = Math.max(0, Math.min(20, Math.round(numberInput(undefined, params.smooth, 2))));

    const key = [
      sources.map((m) => `${m.geometry.uuid}:${m.geometry.attributes.position?.count ?? 0}:${m.geometry.getIndex()?.count ?? -1}`).join("|"),
      frames.map((f) => f.elements.map((e) => Math.round(e * 1e5)).join(",")).join("|"),
      rig.parents.join(","),
      rig.restKey,
      `${rigSpace}|${influences}|${falloff}|${smooth}`,
    ].join("#");

    if (state.key !== key || !state.meshes || !state.bones) {
      disposeState(state);
      const restInSpace = rigSpace ? rig.rest : rig.rest.map((p) => p.clone().applyMatrix4(rig.matrix));
      const bones = buildBones(rig.parents, restInSpace);
      state.bones = bones;
      state.meshes = sources.map((source, i) => {
        const geometry = source.geometry.clone();
        const output = new THREE.Mesh(geometry, source.material);
        output.castShadow = source.castShadow;
        output.receiveShadow = source.receiveShadow;
        output.renderOrder = source.renderOrder;
        const position = geometry.attributes.position as THREE.BufferAttribute;
        const normal = geometry.attributes.normal as THREE.BufferAttribute | undefined;
        return {
          source,
          output,
          basePositions: new Float32Array(position.array as Float32Array),
          baseNormals: normal ? new Float32Array(normal.array as Float32Array) : null,
          frame: frames[i],
          skin: computeSkinWeights(position.array, source.geometry.getIndex()?.array ?? null, frames[i], bones, { influences, falloff, smooth }),
        };
      });
      state.key = key;
      state.posed = undefined;
    }

    const { bones, meshes } = state;
    const bonePose = rigSpace ? rig.pose : rig.pose.map((p) => p.clone().applyMatrix4(rig.matrix));
    const amount = Math.max(0, Math.min(1, numberInput(inputs.amount, params.amount, 1)));
    const stretch = toBoolean(params.stretch);

    for (const bound of meshes) {
      const sourcePosition = bound.source.geometry.attributes.position as THREE.BufferAttribute | undefined;
      const outPosition = bound.output.geometry.attributes.position as THREE.BufferAttribute;
      const upstream = sourcePosition?.array as Float32Array | undefined;
      // The source may be another deformer's output, moving every frame.
      if (upstream && upstream.length === bound.basePositions.length) bound.basePositions.set(upstream);

      state.posed = poseBones(bones, bonePose, bound.frame, { stretch, amount }, state.posed);
      skinPositions(outPosition.array as Float32Array, bound.basePositions, bound.skin, state.posed.pos);
      outPosition.needsUpdate = true;

      const outNormal = bound.output.geometry.attributes.normal as THREE.BufferAttribute | undefined;
      if (outNormal && bound.baseNormals) {
        const upstreamNormals = (bound.source.geometry.attributes.normal as THREE.BufferAttribute | undefined)?.array as Float32Array | undefined;
        if (upstreamNormals && upstreamNormals.length === bound.baseNormals.length) bound.baseNormals.set(upstreamNormals);
        skinNormals(outNormal.array as Float32Array, bound.baseNormals, bound.skin, state.posed.nrm);
        outNormal.needsUpdate = true;
      }
      bound.output.geometry.computeBoundingBox();
      bound.output.geometry.computeBoundingSphere();
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
    const place = (frame: THREE.Matrix4) => (rigSpace ? rig.matrix.clone().multiply(frame) : frame.clone());
    meshes.forEach((bound) => {
      const target = bound.output;
      target.matrixAutoUpdate = false;
      target.matrix.copy(place(bound.frame));
      target.matrix.decompose(target.position, target.quaternion, target.scale);
      target.matrixWorldNeedsUpdate = true;
    });
    state.object.userData = { ...raw.userData, nodeId: ctx.nodeId };
    return { geometry: state.object, matrix: single ? meshes[0].output.matrix : place(objectMatrix) };
  },
};
