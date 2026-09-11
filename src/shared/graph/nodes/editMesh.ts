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
} from "./object";
import { preserveModifierUserData } from "./transform";
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
    mesh.material = srcMesh.material;
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
  },
  paramFields: [
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
      if (inputObj && srcMesh) {
        inputObj.updateMatrixWorld(true);
        state.mesh.matrixAutoUpdate = false;
        state.mesh.matrix.copy(srcMesh.matrixWorld);
        preserveModifierUserData(state.mesh, inputObj, srcMesh, ctx.nodeId);
      } else {
        state.mesh.matrixAutoUpdate = true;
        state.mesh.matrix.identity();
        state.mesh.position.set(0, 0, 0);
        state.mesh.quaternion.identity();
        state.mesh.scale.set(1, 1, 1);
        state.mesh.userData = { nodeId: ctx.nodeId };
      }
      applyEditMeshMaterial(state.mesh, srcMesh, inputs.material, texParams);
      return primitiveOutputs(state.mesh);
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

    if (inputObj && srcMesh) {
      inputObj.updateMatrixWorld(true);
      state.mesh.matrixAutoUpdate = false;
      state.mesh.matrix.copy(srcMesh.matrixWorld);
      preserveModifierUserData(state.mesh, inputObj, srcMesh, ctx.nodeId);
    } else {
      state.mesh.matrixAutoUpdate = true;
      state.mesh.matrix.identity();
      state.mesh.position.set(0, 0, 0);
      state.mesh.quaternion.identity();
      state.mesh.scale.set(1, 1, 1);
      state.mesh.userData = { nodeId: ctx.nodeId };
    }

    state.mesh.userData.nodeId = ctx.nodeId;
    state.lastQuadMesh = quadMesh;
    state.lastShading = shadeMode;
    state.sourceGeometry = srcGeom ?? null;

    return primitiveOutputs(state.mesh);
  },
};
