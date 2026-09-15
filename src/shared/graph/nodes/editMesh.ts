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
import { asVector3, composeNativeMatrix, preserveModifierUserData } from "./transform";
import {
  QuadMesh,
  QuadMeshShading,
  createQuadBox,
  quadMeshToBufferGeometry,
  bufferGeometryToQuadMesh,
} from "../quadMesh";

export const EDIT_MESH_RESEED_ACTION = "edit-mesh/reseed";
export const EDIT_MESH_EXTRUDE_ACTION = "edit-mesh/extrude";
export const EDIT_MESH_INSET_ACTION = "edit-mesh/inset";
export const EDIT_MESH_UNWRAP_UVS_ACTION = "edit-mesh/unwrap-uvs";
export const EDIT_MESH_DELETE_FACES_ACTION = "edit-mesh/delete-faces";
export const EDIT_MESH_SEPARATE_FACES_ACTION = "edit-mesh/separate-faces";

interface EditMeshState {
  mesh?: THREE.Mesh;
  lastQuadMesh?: string;
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
 * A content fingerprint of the edited mesh, because identity cannot be used
 * here and equality would be a full deep compare every frame.
 *
 * The cache used to hold `cloneQuadMesh(quadMesh)` and then test
 * `state.lastQuadMesh === quadMesh` — a clone is never identical to what it
 * was cloned from, so the comparison was false every single time and the
 * geometry was rebuilt (and re-uploaded to the GPU) on every frame, 30 out of
 * 30 at rest. It cost nothing visible and broke nothing, which is exactly why
 * it lasted; it also made every rigid body downstream reset itself, back when
 * physics keyed on geometry identity.
 *
 * Positions are quantised to 1e-5 rather than hashed as floats: the viewport
 * writes them back from a drag, and a bit of float noise below what a pixel
 * can express should not force a rebuild. Face UVs are in the hash because
 * Recalculate UVs changes nothing else, and leaving them out made that button
 * do nothing.
 */
function quadMeshSignature(mesh: QuadMesh): string {
  let hash = 0x811c9dc5;
  const mix = (n: number) => {
    hash = Math.imul(hash ^ (n | 0), 16777619) >>> 0;
  };

  for (const [x, y, z] of mesh.positions) {
    mix(Math.round(x * 1e5));
    mix(Math.round(y * 1e5));
    mix(Math.round(z * 1e5));
  }
  for (const face of mesh.faces) {
    mix(face.length);
    for (const index of face) mix(index);
  }
  if (mesh.faceUVs) {
    for (const face of mesh.faceUVs) {
      for (const [u, v] of face) {
        mix(Math.round(u * 1e5));
        mix(Math.round(v * 1e5));
      }
    }
  }
  return `${mesh.positions.length}:${mesh.faces.length}:${hash.toString(36)}`;
}

/**
 * This node owns a Pivot Offset of its own, and a node that has one
 * legitimately replaces the source's — but only once it has actually been
 * set. Left at its default of (0, 0, 0) it used to erase whatever the source
 * carried, so inserting an Edit Mesh silently moved the pivot marker, the
 * gizmo anchor and every downstream node's idea of the pivot back to the
 * object's origin.
 */
function pivotParams(params: Record<string, unknown>, mesh: THREE.Mesh): Record<string, unknown> {
  const own = asVector3(params.pivot, new THREE.Vector3());
  if (own.lengthSq() > 1e-9) return params;
  const inherited = mesh.userData?.pivot;
  return inherited ? { ...params, pivot: inherited } : params;
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
    const signature = quadMeshSignature(quadMesh);

    if (
      state.mesh &&
      state.lastQuadMesh === signature &&
      state.lastShading === shadeMode &&
      isSameSourceGeom
    ) {
      applyEditMeshPose(state.mesh, inputObj, srcMesh, inputs.matrix, params, ctx.nodeId);
      applyEditMeshMaterial(state.mesh, srcMesh, inputs.material, texParams);
      return primitiveOutputs(state.mesh, pivotParams(params, state.mesh));
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

    state.lastQuadMesh = signature;
    state.lastShading = shadeMode;
    state.sourceGeometry = srcGeom ?? null;

    return primitiveOutputs(state.mesh, pivotParams(params, state.mesh));
  },
};
