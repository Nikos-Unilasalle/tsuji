import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { composeNativeMatrix } from "./transform";
import {
  TexturePaintTool,
  createPaintCanvas,
  restorePaintCanvas,
} from "../../three/texturePainter";
import {
  LayeredTextureState,
  applyTextureToGeometry,
  syncCanvasTexture,
  syncLayeredMaterial,
} from "../../three/layeredTexture";

export interface TexturePaintState extends LayeredTextureState {
  /** Single painted canvas — this node has no layer stack. */
  canvas?: HTMLCanvasElement;
  targetMesh?: THREE.Mesh;
  lastDataUrl?: string;
  lastBaseColor?: string;
}

const texturePaintCache = createNodeCache<TexturePaintState>((s) => {
  s.texture?.dispose();
  s.material?.dispose();
  if (s.group) disposeObject3D(s.group);
});

export function getTexturePaintState(nodeId: string): TexturePaintState {
  let state = texturePaintCache.get(nodeId);
  if (!state) {
    state = { group: new THREE.Group() };
    texturePaintCache.set(nodeId, state);
  }
  if (!state.group) state.group = new THREE.Group();
  return state;
}

export const TEXTURE_PAINT_NODE: NodeDefinition = {
  type: "texture/paint",
  label: "Texture Paint",
  category: "texture",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "baseTexture", label: "Base Texture", type: "texture" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "visible", label: "Visible", type: "value" },
  ],
  outputs: [
    { id: "texture", label: "Texture", type: "texture" },
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    resolution: 1024,
    baseColor: "#ffffff",
    brushTool: "paint" as TexturePaintTool,
    brushColor: "#38bdf8",
    brushSize: 24,
    brushOpacity: 1.0,
    brushHardness: 0.5,
    symmetryX: false,
    usePressure: true,
    pressureTarget: "both",
    textureData: "",
    visible: 1,
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    roughness: 0.5,
    metalness: 0.0,
  },
  dynamicParamFields: () => [
    {
      id: "resolution",
      label: "Resolution",
      kind: "select",
      options: ["512", "1024", "2048"],
    },
    { id: "baseColor", label: "Base Color", kind: "color" },
    {
      id: "brushTool",
      label: "Active Tool",
      kind: "select",
      options: ["paint", "erase", "smooth", "eyedropper", "fill"],
    },
    { id: "brushColor", label: "Brush Color", kind: "color" },
    { id: "brushSize", label: "Brush Size", kind: "number", step: 1 },
    { id: "brushOpacity", label: "Brush Opacity", kind: "number", step: 0.05 },
    { id: "brushHardness", label: "Brush Hardness", kind: "number", step: 0.05 },
    { id: "symmetryX", label: "Mirror X", kind: "boolean" },
    { id: "usePressure", label: "Stylus Pressure", kind: "boolean" },
    {
      id: "pressureTarget",
      label: "Pressure Affects",
      kind: "select",
      options: ["both", "size", "opacity", "none"],
    },
    { id: "visible", label: "Visible", kind: "boolean" },
    { id: "location", label: "Location", kind: "vector" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true },
    { id: "scale", label: "Scale", kind: "vector" },
    { id: "roughness", label: "Roughness", kind: "number", step: 0.05 },
    { id: "metalness", label: "Metalness", kind: "number", step: 0.05 },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getTexturePaintState(ctx.nodeId);
    const res = Math.max(64, Math.min(4096, Number(params.resolution) || 1024));
    const baseColor = String(params.baseColor || "#ffffff");
    const dataUrl = String(params.textureData || "");

    // Initialize or resize backing canvas
    if (!state.canvas || state.lastRes !== res || state.lastBaseColor !== baseColor) {
      state.canvas = createPaintCanvas(res, res, baseColor);
      state.lastRes = res;
      state.lastBaseColor = baseColor;
      state.texture = syncCanvasTexture(state.texture, state.canvas, THREE.SRGBColorSpace);

      // If a baseTexture is provided and canvas is newly initialized, draw it on the canvas
      const baseTex = inputs.baseTexture instanceof THREE.Texture ? inputs.baseTexture : null;
      if (baseTex && baseTex.image && !dataUrl) {
        const ctx2d = state.canvas.getContext("2d");
        try {
          ctx2d?.drawImage(baseTex.image, 0, 0, res, res);
          state.texture.needsUpdate = true;
        } catch {
          // Cross-origin image or empty
        }
      }
    }

    // Restore from saved project texture data if it changed (e.g. undo/redo or file reload)
    if (dataUrl && dataUrl !== state.lastDataUrl && state.canvas) {
      state.lastDataUrl = dataUrl;
      restorePaintCanvas(state.canvas, dataUrl, () => {
        if (state.texture) state.texture.needsUpdate = true;
      });
    }

    if (!state.texture && state.canvas) {
      state.texture = syncCanvasTexture(state.texture, state.canvas, THREE.SRGBColorSpace);
    }

    syncLayeredMaterial(state, params, { roughness: 0.5, metalness: 0.0 });

    // Process Geometry input & pass-through
    const group = state.group!;
    group.clear();
    group.userData.nodeId = ctx.nodeId;

    const isVisible = inputs.visible !== undefined ? Boolean(inputs.visible) : Boolean(params.visible ?? true);
    group.visible = isVisible;

    const matrix = composeNativeMatrix(
      inputs.matrix,
      params.location,
      params.rotation,
      params.scale,
      params,
    );

    const inputGeom = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    applyTextureToGeometry(
      inputGeom,
      state.texture ?? null,
      state.material!,
      ctx.nodeId,
      "isTexturePaintTarget",
    );

    return {
      texture: state.texture ?? null,
      geometry: inputGeom ?? group,
      matrix,
    };
  },
};
