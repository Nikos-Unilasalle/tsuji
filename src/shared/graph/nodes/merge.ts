import * as THREE from "three";
import { growingSockets } from "../dynamicInputs";
import { NodeDefinition, ParamFieldDef } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import {
  applyMaterialParams,
  COMMON_MATERIAL_PARAM_FIELDS,
  COMMON_PRIMITIVE_OUTPUTS,
  extractMaterialParams,
  extractTextureParams,
  inheritSourceMaterial,
  primitiveOutputs,
} from "./object";
import { composeNativeMatrix } from "./transform";

const INPUT_PREFIX = "in";

/**
 * Same GPU-resource-cache pattern as object.ts's meshCache — the group
 * needs to be the SAME THREE.Group across frames, not a fresh one every
 * evaluation, so the viewport can hold a stable reference to it.
 *
 * Only the group is this node's: its children are the upstream nodes' own
 * objects (or clones sharing their geometry and materials), so dropping the
 * node lets go of them rather than disposing them out from under their owners.
 */
const groupCache = createNodeCache<THREE.Group>((group) => group.clear());

/**
 * The override material's owner. Merge doesn't own its children's materials —
 * each belongs to the node that made it, and may be shared further (a
 * modifier borrowing its source's, both halves of a Separate) — so the
 * override is built once on this node's own mesh and handed to every child,
 * rather than edited into each child's material in place.
 */
const overrideCache = createNodeCache<THREE.Mesh>(disposeObject3D);

function getOverrideHolder(nodeId: string): THREE.Mesh {
  let holder = overrideCache.get(nodeId);
  if (!holder) {
    holder = new THREE.Mesh();
    overrideCache.set(nodeId, holder);
  }
  return holder;
}

function getGroup(nodeId: string): THREE.Group {
  const existing = groupCache.get(nodeId);
  if (existing) return existing;
  const group = new THREE.Group();
  groupCache.set(nodeId, group);
  return group;
}

const MATERIAL_INPUTS = [
  { id: "material", label: "Material", type: "material" as const },
  { id: "texture", label: "Texture Map", type: "texture" as const },
  { id: "normal", label: "Normal Map", type: "texture" as const },
  { id: "uvScale", label: "UV Scale", type: "vector" as const },
  { id: "uvOffset", label: "UV Offset", type: "vector" as const },
];

const TRANSFORM_PARAM_FIELDS: ParamFieldDef[] = [
  { id: "visible", label: "Visible", kind: "boolean", group: "Transform" },
  { id: "location", label: "Location", kind: "vector", group: "Transform" },
  { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true, group: "Transform" },
  { id: "scale", label: "Scale", kind: "vector", group: "Transform" },
];

const MATERIAL_PARAM_FIELDS: ParamFieldDef[] = [
  { id: "overrideMaterials", label: "Override Materials", kind: "boolean", group: "Material" },
  ...COMMON_MATERIAL_PARAM_FIELDS,
  { id: "uvScaleX", label: "UV Scale X (Tile)", kind: "number", step: 0.1, group: "Material" },
  { id: "uvScaleY", label: "UV Scale Y (Tile)", kind: "number", step: 0.1, group: "Material" },
  { id: "uvOffsetX", label: "UV Offset X", kind: "number", step: 0.05, group: "Material" },
  { id: "uvOffsetY", label: "UV Offset Y", kind: "number", step: 0.05, group: "Material" },
];

/**
 * Fans any number of Geometry inputs into one Geometry output — a
 * THREE.Group holding all of them — so a scene can carry more than one
 * object into Render, which still only takes a single Geometry input;
 * Merge is what combines multiple objects down to that one socket.
 * Inputs grow dynamically: wiring the last empty "In N" socket adds a new
 * empty one below it (see dynamicInputs.ts), so there's always exactly one
 * free socket to drag the next connection into.
 *
 * The group owns a native pose (location/rotation/scale + matrix input) so
 * the viewport gizmo can move/rotate/scale the whole set at once, and its
 * material params/texture/normal inputs are pushed onto every descendant
 * mesh — replacing all materials in one go — as soon as "Override Materials"
 * is enabled or any material/texture/normal socket is wired.
 */
export const MERGE_NODE: NodeDefinition = {
  type: "structure/merge",
  label: "Merge",
  category: "structure",
  inputs: [
    { id: "visible", label: "Visible", type: "value" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    ...MATERIAL_INPUTS,
    { id: `${INPUT_PREFIX}0`, label: "In 1", type: "geometry", owns: true },
  ],
  dynamicInputs: (connections) => [
    { id: "visible", label: "Visible", type: "value" as const },
    { id: "matrix", label: "Matrix", type: "matrix" as const },
    ...MATERIAL_INPUTS,
    ...growingSockets(connections, INPUT_PREFIX, (i) => ({
      id: `${INPUT_PREFIX}${i}`,
      label: `In ${i + 1}`,
      type: "geometry",
      owns: true,
    })),
  ],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: {
    visible: 1,
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    overrideMaterials: 0,
    color: new THREE.Color(0xffffff),
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 1.0,
    shadeless: 0,
    roughness: 0.4,
    metalness: 0.1,
    wireframe: 0,
    opacity: 1.0,
    uvScaleX: 1,
    uvScaleY: 1,
    uvOffsetX: 0,
    uvOffsetY: 0,
  },
  dynamicParamFields: () => [...TRANSFORM_PARAM_FIELDS, ...MATERIAL_PARAM_FIELDS],
  evaluate: (inputs, params, ctx) => {
    const group = getGroup(ctx.nodeId);
    group.clear();
    group.userData.nodeId = ctx.nodeId;

    for (const [key, value] of Object.entries(inputs)) {
      if (!key.startsWith(INPUT_PREFIX)) continue;
      if (value instanceof THREE.Object3D) {
        // group.add() re-parents the object (it reassigns value.parent). When
        // the same output wires into two consumers, the second group.add would
        // silently rip it out of the first — so if it is already parented
        // somewhere else, hand this Merge its own clone and keep the socket's
        // `owns` promise for every consumer instead of just the last one.
        group.add(value.parent && value.parent !== group ? value.clone(true) : value);
      }
    }

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      group.matrixAutoUpdate = false;
      group.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    // Reach in and rewrite every child's material when asked — either the
    // "Override Materials" toggle is on, or a material/texture/normal socket
    // is wired (connecting one is itself an explicit "replace these" intent).
    // Otherwise the grouped objects keep the materials their own nodes gave
    // them, so a bare Merge stays transparent.
    const shouldOverride =
      Boolean(params.overrideMaterials) ||
      ctx.connectedInputs?.has("material") ||
      ctx.connectedInputs?.has("texture") ||
      ctx.connectedInputs?.has("normal");
    if (shouldOverride) {
      const matParams = extractMaterialParams(inputs, params);
      const texParams = extractTextureParams(inputs, params, ctx.nodeId);
      const holder = getOverrideHolder(ctx.nodeId);
      applyMaterialParams(holder, matParams, THREE.FrontSide, texParams);
      group.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) inheritSourceMaterial(mesh, holder.material);
      });
    }

    return primitiveOutputs(group);
  },
};
