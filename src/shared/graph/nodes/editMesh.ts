import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { findFirstMesh } from "../meshRequired";
import {
  applyMaterialParams,
  clearAppliedMaterialSignature,
  materialParamsFromValue,
  primitiveOutputs,
  extractTextureParams,
  TextureParams,
  MaterialParams,
  NATIVE_TRANSFORM_PARAM_FIELDS,
  inheritSourceMaterial,
} from "./object";
import { composeNativeMatrix, preserveModifierUserData } from "./transform";
import {
  QuadMesh,
  QuadMeshShading,
  createQuadBox,
  quadMeshToBufferGeometry,
  bufferGeometryToQuadMesh,
  cloneQuadMesh,
} from "../quadMesh";

export const EDIT_MESH_RESEED_ACTION = "edit-mesh/reseed";
export const EDIT_MESH_EXTRUDE_ACTION = "edit-mesh/extrude";
export const EDIT_MESH_INSET_ACTION = "edit-mesh/inset";
export const EDIT_MESH_UNWRAP_UVS_ACTION = "edit-mesh/unwrap-uvs";
export const EDIT_MESH_DELETE_FACES_ACTION = "edit-mesh/delete-faces";
export const EDIT_MESH_SEPARATE_FACES_ACTION = "edit-mesh/separate-faces";

interface EditMeshState {
  mesh?: THREE.Mesh;
  lastQuadMesh?: QuadMesh;
  lastShading?: string;
  sourceGeometry?: THREE.BufferGeometry | null;
}

const editMeshCache = createNodeCache<EditMeshState>((s) => {
  if (s.mesh) disposeObject3D(s.mesh);
});

function getState(cache: typeof editMeshCache, nodeId: string): EditMeshState {
  let state = cache.get(nodeId);
  if (!state) {
    state = {};
    cache.set(nodeId, state);
  }
  return state;
}

function applyEditMeshMaterial(
  mesh: THREE.Mesh,
  srcMesh: THREE.Mesh | null,
  materialInput: unknown,
  texParams?: TextureParams,
) {
  const matParams = materialParamsFromValue(materialInput);
  if (matParams) {
    applyMaterialParams(mesh, matParams, THREE.DoubleSide, texParams);
    delete (mesh.material as any).__isDefaultClay;
    delete (mesh.material as any).__isSharedFromSrc;
    return;
  }

  // If texture sockets (Texture, Normal, Roughness) are connected directly
  if (texParams && (texParams.activeDiffuse || texParams.activeNormal || texParams.activeRoughness)) {
    const baseParams: MaterialParams = {
      color: new THREE.Color(0xffffff),
      emissive: new THREE.Color(0x000000),
      emissiveIntensity: 1.0,
      shadeless: false,
      roughness: 0.5,
      metalness: 0.05,
      wireframe: false,
      opacity: 1.0,
      transmission: 0,
      thickness: 0.5,
    };
    applyMaterialParams(mesh, baseParams, THREE.DoubleSide, texParams);
    delete (mesh.material as any).__isDefaultClay;
    delete (mesh.material as any).__isSharedFromSrc;
    return;
  }

  if (srcMesh && srcMesh.material instanceof THREE.Material) {
    inheritSourceMaterial(mesh, srcMesh.material);
    clearAppliedMaterialSignature(mesh);
    (mesh.material as any).__isSharedFromSrc = true;
    delete (mesh.material as any).__isDefaultClay;
    return;
  }

  // Fallback: Default neutral clay material without any textures
  const defaultParams: MaterialParams = {
    color: new THREE.Color(0xcccccc),
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 1.0,
    shadeless: false,
    roughness: 0.5,
    metalness: 0.05,
    wireframe: false,
    opacity: 1.0,
    transmission: 0,
    thickness: 0.5,
  };
  applyMaterialParams(mesh, defaultParams, THREE.DoubleSide, undefined);
  (mesh.material as any).__isDefaultClay = true;
  delete (mesh.material as any).__isSharedFromSrc;
}

/**
 * The frame this node's own pose is composed on top of: the source mesh's
 * world matrix (when a Geometry is wired) followed by whatever the Matrix
 * socket carries.
 *
 * matrixWorld, not matrix: for a mesh nested under a posed wrapper group (an
 * OBJ Model bakes its pose onto the group) the mesh's own .matrix is identity.
 */
export function editMeshPoseParent(
  inputObj: THREE.Object3D | null,
  srcMesh: THREE.Mesh | null,
  wiredMatrix: unknown,
): THREE.Matrix4 {
  const parent = new THREE.Matrix4();
  if (inputObj && srcMesh) {
    inputObj.updateMatrixWorld(true);
    parent.copy(srcMesh.matrixWorld);
  }
  if (wiredMatrix instanceof THREE.Matrix4) parent.multiply(wiredMatrix);
  return parent;
}

/**
 * The node's final matrix: that parent frame, with this node's own
 * location/rotation/scale/pivot and the two inherit modes as the local pose on
 * top of it, exactly as a primitive's native pose works. With the default
 * identity pose this is the source's matrixWorld verbatim — the behaviour Edit
 * Mesh had before it owned a pose.
 */
function composeEditMeshMatrix(
  inputObj: THREE.Object3D | null,
  srcMesh: THREE.Mesh | null,
  wiredMatrix: unknown,
  params: Record<string, unknown>,
): { parent: THREE.Matrix4; matrix: THREE.Matrix4 } {
  const parent = editMeshPoseParent(inputObj, srcMesh, wiredMatrix);
  return {
    parent,
    matrix: composeNativeMatrix(parent, params.location, params.rotation, params.scale, params),
  };
}

/**
 * Writes that matrix onto the output mesh and carries the source object's
 * metadata across. matrixAutoUpdate is forced off rather than copied from the
 * source: an OBJ-parsed mesh defaults to true, which would have three's own
 * render loop recompute (and wipe) this matrix next frame.
 */
function applyEditMeshPose(
  mesh: THREE.Mesh,
  inputObj: THREE.Object3D | null,
  srcMesh: THREE.Mesh | null,
  wiredMatrix: unknown,
  params: Record<string, unknown>,
  nodeId: string,
): void {
  const { parent, matrix } = composeEditMeshMatrix(inputObj, srcMesh, wiredMatrix, params);
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(matrix);
  if (inputObj && srcMesh) {
    preserveModifierUserData(mesh, inputObj, srcMesh, nodeId);
  } else {
    mesh.userData = {};
  }
  mesh.userData.nodeId = nodeId;
  // The gizmo solves `own pose = dragged world pose × parent⁻¹`, and for every
  // other native-pose node that parent is just whatever is wired into `matrix`
  // — which the viewport reads straight off the graph. This node's parent also
  // includes the *source geometry's* world matrix, invisible from the graph, so
  // it has to publish it or a drag solves against the identity and the mesh
  // jumps by exactly the source's pose the moment a handle is grabbed.
  mesh.userData.poseParent = parent;
}

/**
 * Edit Mesh node — comprehensive polygon / quad mesh editing node.
 * Supports box modeling workflow:
 * - Points and Faces selection modes
 * - Extrude, Inset, Loop Cut modeling operations
 * - Transform (loc/rot/scale) of selections around centroid
 * - Pure quad topology with no diagonal triangulation artifacts
 * - Shading options (auto, smooth, flat) and coherent UV unwrapping
 */
export const EDIT_MESH_NODE: NodeDefinition = {
  type: "modifier/edit-mesh",
  label: "Edit Mesh",
  category: "transform",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    // Same role as a primitive's Matrix socket: a parent pose applied
    // *outside* this node's own location/rotation/scale, composed on top of
    // the source geometry's world matrix when one is wired into Geometry.
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "material", label: "Material", type: "material" },
    { id: "texture", label: "Texture Map", type: "texture" },
    { id: "normal", label: "Normal Map", type: "texture" },
    { id: "roughnessMap", label: "Roughness Map", type: "texture" },
    { id: "uvScale", label: "UV Scale", type: "vector" },
    { id: "uvOffset", label: "UV Offset", type: "vector" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    meshData: null as QuadMesh | null,
    selectMode: "faces" as "points" | "faces",
    selectedPoints: [] as number[],
    selectedFaces: [0] as number[],
    activeTool: "select" as "select" | "extrude" | "loopcut" | "inset",
    shading: "auto" as QuadMeshShading,
    extrudeDistance: 0.5,
    insetRatio: 0.25,
    uvScale: [1, 1] as [number, number],
    uvOffset: [0, 0] as [number, number],
    // The same native pose every geometry node owns (see
    // NATIVE_TRANSFORM_PARAM_FIELDS / composeNativeMatrix). Defaults are the
    // identity, so an existing Edit Mesh keeps drawing at exactly the source
    // mesh's matrix as it did before it had a pose of its own.
    visible: 1,
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    showPivot: false,
    pivot: new THREE.Vector3(0, 0, 0),
    inheritRotation: "parent",
    inheritScale: "parent",
  },
  paramFields: [
    ...NATIVE_TRANSFORM_PARAM_FIELDS,
    {
      id: "shading",
      label: "Shading",
      kind: "select",
      options: ["auto", "smooth", "flat"],
    },
    {
      id: "unwrapButton",
      label: "Recalculate UVs",
      kind: "button",
      action: EDIT_MESH_UNWRAP_UVS_ACTION,
    },
  ],
  evaluate: (inputs, params, ctx) => {
    const inputObj = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    const srcMesh = inputObj ? findFirstMesh(inputObj) : null;
    const srcGeom = srcMesh?.geometry;

    let quadMesh: QuadMesh;
    if (params.meshData && typeof params.meshData === "object" && Array.isArray((params.meshData as QuadMesh).positions)) {
      quadMesh = params.meshData as QuadMesh;
    } else if (srcGeom) {
      quadMesh = bufferGeometryToQuadMesh(srcGeom);
    } else {
      quadMesh = createQuadBox(1, 1, 1);
    }

    const state = getState(editMeshCache, ctx.nodeId);
    const shadeMode = (params.shading as QuadMeshShading) || "auto";
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);

    const isSameSourceGeom = state.sourceGeometry === (srcGeom ?? null);

    if (
      state.mesh &&
      state.lastQuadMesh === quadMesh &&
      state.lastShading === shadeMode &&
      isSameSourceGeom
    ) {
      applyEditMeshPose(state.mesh, inputObj, srcMesh, inputs.matrix, params, ctx.nodeId);
      applyEditMeshMaterial(state.mesh, srcMesh, inputs.material, texParams);
      return primitiveOutputs(state.mesh, params);
    }

    const geometry = quadMeshToBufferGeometry(quadMesh, shadeMode);

    if (!state.mesh) {
      state.mesh = new THREE.Mesh(geometry);
      state.mesh.castShadow = true;
      state.mesh.receiveShadow = true;
    } else {
      state.mesh.geometry.dispose();
      state.mesh.geometry = geometry;
    }

    applyEditMeshMaterial(state.mesh, srcMesh, inputs.material, texParams);

    applyEditMeshPose(state.mesh, inputObj, srcMesh, inputs.matrix, params, ctx.nodeId);

    state.lastQuadMesh = cloneQuadMesh(quadMesh);
    state.lastShading = shadeMode;
    state.sourceGeometry = srcGeom ?? null;

    return primitiveOutputs(state.mesh, params);
  },
};
