import * as THREE from "three";
import { NodeDefinition, ParamFieldDef } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import {
  COMMON_MATERIAL_PARAM_FIELDS,
  COMMON_PRIMITIVE_INPUTS,
  COMMON_PRIMITIVE_OUTPUTS,
  applyMaterialParams,
  extractMaterialParams,
  extractTextureParams,
  primitiveOutputs,
} from "./object";
import { composeNativeMatrix } from "./transform";
import {
  SculptMeshData,
  SculptPrimitiveKind,
  buildAdjacency,
  buildBasePrimitive,
  computeVertexNormals,
  syncBufferGeometry,
} from "../../three/sculptMesh";
import { SculptBrushTool } from "../../three/sculptEngine";
import { BrushFalloff } from "../../three/brushFalloff";

interface SculptNodeState {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  meshData: SculptMeshData;
  adjacency: number[][];
  /** Identity of the params.sculptMesh object last synced — cheap ref-check so a re-evaluate that didn't touch sculpting doesn't rebuild adjacency. */
  lastSculptMeshParam: unknown;
  primitiveSignature: string;
}

const sculptCache = createNodeCache<SculptNodeState>((s) => {
  if (s.geometry) s.geometry.dispose();
  if (s.material) s.material.dispose();
  if (s.mesh) disposeObject3D(s.mesh);
});

export const SCULPT_PRIMITIVE_OPTIONS: SculptPrimitiveKind[] = ["sphere", "cube", "plane"];
export const SCULPT_BRUSH_TOOLS: SculptBrushTool[] = [
  "draw",
  "clay",
  "inflate",
  "smooth",
  "pinch",
  "crease",
  "flatten",
  "grab",
  "mask",
];
export const SCULPT_BRUSH_FALLOFFS: BrushFalloff[] = ["smooth", "linear", "sphere", "flat"];

const SCULPT_PARAM_FIELDS: ParamFieldDef[] = [
  { id: "primitive", label: "Primitive", kind: "select", options: [...SCULPT_PRIMITIVE_OPTIONS], group: "Base Mesh" },
  { id: "size", label: "Size", kind: "number", step: 0.1, group: "Base Mesh" },
  { id: "baseResolution", label: "Base Resolution", kind: "number", step: 1, group: "Base Mesh" },
  { id: "wireframe", label: "Wireframe", kind: "boolean", group: "Base Mesh" },
  { id: "brushTool", label: "Brush Tool", kind: "select", options: [...SCULPT_BRUSH_TOOLS], group: "Sculpt Palette" },
  { id: "brushSize", label: "Brush Radius", kind: "number", step: 0.02, group: "Sculpt Palette" },
  { id: "brushStrength", label: "Brush Strength", kind: "number", step: 0.05, group: "Sculpt Palette" },
  { id: "brushFalloff", label: "Brush Falloff", kind: "select", options: [...SCULPT_BRUSH_FALLOFFS], group: "Sculpt Palette" },
  { id: "symmetryX", label: "Symmetry X", kind: "boolean", group: "Sculpt Palette" },
  { id: "symmetryY", label: "Symmetry Y", kind: "boolean", group: "Sculpt Palette" },
  { id: "symmetryZ", label: "Symmetry Z", kind: "boolean", group: "Sculpt Palette" },
  { id: "visible", label: "Visible", kind: "boolean", group: "Transform" },
  { id: "location", label: "Location", kind: "vector", group: "Transform" },
  { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true, group: "Transform" },
  { id: "scale", label: "Scale", kind: "vector", group: "Transform" },
  ...COMMON_MATERIAL_PARAM_FIELDS,
];

interface SerializedSculptMesh {
  positions: number[];
  indices: number[];
  mask?: number[];
}

function toSculptMeshData(serialized: SerializedSculptMesh, adjacencyOut: { current: number[][] | null }): SculptMeshData {
  const positions = new Float32Array(serialized.positions);
  const indices = new Uint32Array(serialized.indices);
  const mask = serialized.mask ? new Float32Array(serialized.mask) : undefined;
  adjacencyOut.current = buildAdjacency(indices, positions.length / 3);
  // Normals are recomputed by the caller once adjacency/positions are final —
  // a placeholder here is fine, it's overwritten before first render.
  return { positions, normals: new Float32Array(positions.length), indices, mask };
}

export const SCULPT_NODE: NodeDefinition = {
  type: "object/sculpt",
  label: "Sculpt",
  category: "object",
  inputs: [...COMMON_PRIMITIVE_INPUTS],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: {
    primitive: "sphere",
    size: 2,
    baseResolution: 2,
    wireframe: false,
    brushTool: "draw",
    brushSize: 0.3,
    brushStrength: 0.3,
    brushFalloff: "smooth",
    symmetryX: false,
    symmetryY: false,
    symmetryZ: false,
    sculptMesh: null,
    visible: 1,
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    color: new THREE.Color(0xaaaaaa),
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 1.0,
    shadeless: false,
    roughness: 0.6,
    metalness: 0.0,
    opacity: 1.0,
  },
  paramFields: SCULPT_PARAM_FIELDS,
  evaluate: (inputs, params, ctx) => {
    const primitive = (params.primitive as SculptPrimitiveKind) || "sphere";
    const size = Math.max(0.01, Number(params.size ?? 2));
    const baseResolution = Math.max(0, Math.round(Number(params.baseResolution ?? 2)));
    const wireframe = Boolean(params.wireframe ?? false);
    const primitiveSignature = `${primitive}|${size}|${baseResolution}`;

    const serialized =
      params.sculptMesh && typeof params.sculptMesh === "object"
        ? (params.sculptMesh as SerializedSculptMesh)
        : null;
    const hasSculptData = Boolean(serialized && Array.isArray(serialized.positions) && serialized.positions.length > 0);

    let state = sculptCache.get(ctx.nodeId);

    if (!state) {
      const meshData = buildBasePrimitive(primitive, baseResolution, size);
      const adjacency = buildAdjacency(meshData.indices, meshData.positions.length / 3);
      const geometry = new THREE.BufferGeometry();
      syncBufferGeometry(geometry, meshData);
      const material = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 0.6, wireframe });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.nodeId = ctx.nodeId;
      mesh.userData.isSculpt = true;

      state = {
        mesh,
        geometry,
        material,
        meshData,
        adjacency,
        lastSculptMeshParam: params.sculptMesh,
        primitiveSignature,
      };
      sculptCache.set(ctx.nodeId, state);
    } else if (state.primitiveSignature !== primitiveSignature && !hasSculptData) {
      // Base shape/resolution changed and there's no sculpted data to
      // preserve — rebuild from scratch (same "signature changed" idiom
      // Terrain uses for its own grid rebuild).
      const meshData = buildBasePrimitive(primitive, baseResolution, size);
      state.meshData = meshData;
      state.adjacency = buildAdjacency(meshData.indices, meshData.positions.length / 3);
      syncBufferGeometry(state.geometry, meshData);
      state.primitiveSignature = primitiveSignature;
      state.lastSculptMeshParam = params.sculptMesh;
    } else if (hasSculptData && state.lastSculptMeshParam !== params.sculptMesh) {
      // A stroke was committed (or the graph was loaded/undone) — sync the
      // authoritative param data into the live mesh.
      const adjacencyOut: { current: number[][] | null } = { current: null };
      const meshData = toSculptMeshData(serialized as SerializedSculptMesh, adjacencyOut);
      meshData.normals = computeVertexNormals(meshData.positions, meshData.indices);
      state.meshData = meshData;
      state.adjacency = adjacencyOut.current ?? [];
      syncBufferGeometry(state.geometry, meshData);
      state.primitiveSignature = primitiveSignature;
      state.lastSculptMeshParam = params.sculptMesh;
    }

    state.material.wireframe = wireframe;
    state.mesh.userData.sculptMeshData = state.meshData;
    state.mesh.userData.sculptAdjacency = state.adjacency;
    state.mesh.userData.sculptPrimitiveSignature = state.primitiveSignature;

    const matParams = extractMaterialParams(inputs, params);
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);
    applyMaterialParams(state.mesh, matParams, THREE.FrontSide, texParams);

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      state.mesh.matrixAutoUpdate = false;
      state.mesh.matrix.copy(
        composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params),
      );
    }

    return primitiveOutputs(state.mesh, params);
  },
};
