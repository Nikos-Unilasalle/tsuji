import * as THREE from "three";
import { NodeDefinition, ParamFieldDef } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import {
  COMMON_MATERIAL_PARAM_FIELDS,
  COMMON_PRIMITIVE_OUTPUTS,
  applyMaterialParams,
  extractMaterialParams,
  extractTextureParams,
  primitiveOutputs,
} from "./object";
import { composeNativeMatrix } from "./transform";
import {
  TerrainGridConfig,
  TerrainResolution,
  createTerrainGeometry,
  getTexturePixels,
  parseResolution,
  updateTerrainHeightsAndNormals,
} from "../../three/terrainEngine";
import { TerrainBrushFalloff, TerrainBrushTool } from "../../three/terrainSculpt";

interface TerrainNodeState {
  mesh: THREE.Mesh;
  geometry: THREE.PlaneGeometry;
  material: THREE.MeshStandardMaterial;
  configSignature: string;
  textureVersion: number;
  heightmapTexture: THREE.Texture | null;
  heightmapPixels: { data: Uint8ClampedArray | Uint8Array | Float32Array; width: number; height: number } | null;
  sculptOffsets: Record<number, number>;
  outputTexture: THREE.DataTexture | null;
}

const terrainCache = createNodeCache<TerrainNodeState>((s) => {
  if (s.outputTexture) s.outputTexture.dispose();
  if (s.geometry) s.geometry.dispose();
  if (s.material) s.material.dispose();
  if (s.mesh) disposeObject3D(s.mesh);
});

function syncOutputHeightmap(
  state: TerrainNodeState,
  cols: number,
  rows: number,
  heights: Float32Array,
): THREE.DataTexture {
  const vertexCount = cols * rows;
  if (!state.outputTexture || state.outputTexture.image.width !== cols || state.outputTexture.image.height !== rows) {
    if (state.outputTexture) state.outputTexture.dispose();
    const data = new Float32Array(vertexCount * 4);
    state.outputTexture = new THREE.DataTexture(data, cols, rows, THREE.RGBAFormat, THREE.FloatType);
    state.outputTexture.minFilter = THREE.NearestFilter;
    state.outputTexture.magFilter = THREE.NearestFilter;
    state.outputTexture.wrapS = THREE.ClampToEdgeWrapping;
    state.outputTexture.wrapT = THREE.ClampToEdgeWrapping;
  }
  const data = state.outputTexture.image.data as Float32Array;
  for (let i = 0; i < vertexCount; i++) {
    data[i * 4] = heights[i];
    data[i * 4 + 1] = 0;
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 1.0;
  }
  state.outputTexture.needsUpdate = true;
  return state.outputTexture;
}

export const TERRAIN_RESOLUTION_OPTIONS: TerrainResolution[] = ["32x32", "64x64", "128x128", "256x256"];
export const TERRAIN_BRUSH_TOOLS: TerrainBrushTool[] = ["sculpt", "smooth", "flatten", "noise", "erode"];
export const TERRAIN_BRUSH_FALLOFFS: TerrainBrushFalloff[] = ["smooth", "linear", "sphere", "flat"];

const TERRAIN_PARAM_FIELDS: ParamFieldDef[] = [
  { id: "width", label: "Width (X)", kind: "number", step: 1, group: "Dimensions" },
  { id: "depth", label: "Depth (Z)", kind: "number", step: 1, group: "Dimensions" },
  {
    id: "resolution",
    label: "Resolution",
    kind: "select",
    options: [...TERRAIN_RESOLUTION_OPTIONS],
    group: "Dimensions",
  },
  { id: "heightScale", label: "Height Amplitude", kind: "number", step: 0.5, group: "Relief" },
  { id: "heightOffset", label: "Height Offset (Y)", kind: "number", step: 0.5, group: "Relief" },
  { id: "slopeShading", label: "Auto Slope Shading (Grass/Rock/Snow)", kind: "boolean", group: "Shading" },
  { id: "flatShading", label: "Flat Shading (Low-Poly)", kind: "boolean", group: "Shading" },
  { id: "wireframe", label: "Wireframe", kind: "boolean", group: "Shading" },
  {
    id: "brushTool",
    label: "Brush Tool",
    kind: "select",
    options: [...TERRAIN_BRUSH_TOOLS],
    group: "Sculpt Palette",
  },
  { id: "brushSize", label: "Brush Radius", kind: "number", step: 0.5, group: "Sculpt Palette" },
  { id: "brushStrength", label: "Brush Strength", kind: "number", step: 0.05, group: "Sculpt Palette" },
  {
    id: "brushFalloff",
    label: "Brush Falloff",
    kind: "select",
    options: [...TERRAIN_BRUSH_FALLOFFS],
    group: "Sculpt Palette",
  },
  { id: "visible", label: "Visible", kind: "boolean", group: "Transform" },
  { id: "location", label: "Location", kind: "vector", group: "Transform" },
  { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true, group: "Transform" },
  { id: "scale", label: "Scale", kind: "vector", group: "Transform" },
  ...COMMON_MATERIAL_PARAM_FIELDS,
];

export const TERRAIN_NODE: NodeDefinition = {
  type: "object/terrain",
  label: "Terrain",
  category: "object",
  inputs: [
    { id: "heightmap", label: "Height Map", type: "texture" },
    { id: "material", label: "Material", type: "material" },
    { id: "texture", label: "Texture Map", type: "texture" },
    { id: "normal", label: "Normal Map", type: "texture" },
    { id: "roughnessMap", label: "Roughness Map", type: "texture" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "visible", label: "Visible", type: "value" },
  ],
  outputs: [
    ...COMMON_PRIMITIVE_OUTPUTS,
    { id: "heightmap", label: "Heightmap", type: "texture" },
  ],
  defaultParams: {
    width: 40,
    depth: 40,
    resolution: "128x128",
    heightScale: 6,
    heightOffset: 0,
    slopeShading: true,
    flatShading: false,
    wireframe: false,
    brushTool: "sculpt",
    brushSize: 4,
    brushStrength: 0.5,
    brushFalloff: "smooth",
    sculptOffsets: {},
    visible: 1,
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    color: new THREE.Color(0x3a7d44),
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 1.0,
    shadeless: false,
    roughness: 0.8,
    metalness: 0.1,
    opacity: 1.0,
  },
  paramFields: TERRAIN_PARAM_FIELDS,
  evaluate: (inputs, params, ctx) => {
    const width = Math.max(1, Number(params.width ?? 40));
    const depth = Math.max(1, Number(params.depth ?? 40));
    const resolutionStr = String(params.resolution ?? "128x128");
    const { segmentsX, segmentsZ } = parseResolution(resolutionStr);
    const heightScale = Math.max(0, Number(params.heightScale ?? 6));
    const heightOffset = Number(params.heightOffset ?? 0);
    const slopeShading = Boolean(params.slopeShading ?? true);
    const flatShading = Boolean(params.flatShading ?? false);
    const wireframe = Boolean(params.wireframe ?? false);

    const config: TerrainGridConfig = {
      width,
      depth,
      segmentsX,
      segmentsZ,
      heightScale,
      heightOffset,
      slopeShading,
      flatShading,
    };

    const inputHeightmap = inputs.heightmap instanceof THREE.Texture ? inputs.heightmap : null;
    const currentTexVersion = inputHeightmap ? inputHeightmap.version ?? 0 : 0;

    let sculptOffsets: Record<number, number> = {};
    if (params.sculptOffsets && typeof params.sculptOffsets === "object") {
      sculptOffsets = params.sculptOffsets as Record<number, number>;
    }

    const configSignature = `${width}|${depth}|${segmentsX}x${segmentsZ}|${heightScale}|${heightOffset}|${slopeShading}|${flatShading}|${wireframe}|${inputHeightmap?.uuid ?? "none"}`;

    let state = terrainCache.get(ctx.nodeId);

    if (!state) {
      const geometry = createTerrainGeometry(width, depth, segmentsX, segmentsZ);
      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.8,
        metalness: 0.1,
        flatShading,
        wireframe,
        vertexColors: slopeShading,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.nodeId = ctx.nodeId;
      mesh.userData.isTerrain = true;

      const heightmapPixels = inputHeightmap ? getTexturePixels(inputHeightmap) : null;
      const initialHeights = updateTerrainHeightsAndNormals(geometry, config, heightmapPixels, sculptOffsets);

      state = {
        mesh,
        geometry,
        material,
        configSignature,
        textureVersion: currentTexVersion,
        heightmapTexture: inputHeightmap,
        heightmapPixels,
        sculptOffsets,
        outputTexture: null,
      };
      syncOutputHeightmap(state, segmentsX + 1, segmentsZ + 1, initialHeights);
      terrainCache.set(ctx.nodeId, state);
    } else {
      // Re-create geometry if grid dimensions or segment counts changed
      const currentGridSig = `${width}|${depth}|${segmentsX}x${segmentsZ}`;
      const prevGridSig = state.configSignature.split("|").slice(0, 3).join("|");

      if (currentGridSig !== prevGridSig) {
        state.geometry.dispose();
        state.geometry = createTerrainGeometry(width, depth, segmentsX, segmentsZ);
        state.mesh.geometry = state.geometry;
      }

      // Check if heightmap pixels need refresh
      if (state.heightmapTexture !== inputHeightmap || state.textureVersion !== currentTexVersion) {
        state.heightmapTexture = inputHeightmap;
        state.textureVersion = currentTexVersion;
        state.heightmapPixels = inputHeightmap ? getTexturePixels(inputHeightmap) : null;
      }

      state.sculptOffsets = sculptOffsets;

      // Update heights and normals if config, pixels or offsets changed
      if (state.configSignature !== configSignature || state.textureVersion !== currentTexVersion) {
        state.configSignature = configSignature;
        state.material.flatShading = flatShading;
        state.material.wireframe = wireframe;
        state.material.vertexColors = slopeShading;
        state.material.needsUpdate = true;
        const updatedHeights = updateTerrainHeightsAndNormals(state.geometry, config, state.heightmapPixels, sculptOffsets);
        syncOutputHeightmap(state, segmentsX + 1, segmentsZ + 1, updatedHeights);
      }
    }

    // Attach terrain metadata to mesh.userData for interactive Viewport raycast & sculpt
    state.mesh.userData.terrainConfig = config;
    state.mesh.userData.heightmapPixels = state.heightmapPixels;
    state.mesh.userData.sculptOffsets = state.sculptOffsets;

    // Apply materials and textures
    const matParams = extractMaterialParams(inputs, params);
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);
    applyMaterialParams(state.mesh, matParams, THREE.FrontSide, texParams);

    // Apply native transform
    if (ctx.nodeId !== ctx.liveEditNodeId) {
      state.mesh.matrixAutoUpdate = false;
      state.mesh.matrix.copy(
        composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params),
      );
    }

    const outputs = primitiveOutputs(state.mesh, params);
    return {
      ...outputs,
      heightmap: state.outputTexture ?? state.heightmapTexture ?? null,
    };
  },
};
