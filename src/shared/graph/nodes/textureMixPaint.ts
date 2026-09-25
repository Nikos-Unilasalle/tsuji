import * as THREE from "three";
import { Connection, NodeDefinition, NodeInstance } from "../types";
import { SocketDef } from "../sockets";
import { growingSockets } from "../dynamicInputs";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { composeNativeMatrix } from "./transform";
import {
  TextureMixFalloff,
  TextureMixTool,
  ensureSplatBuffer,
  renderSplatMapPreview,
} from "../../three/textureMixEngine";
import { restoreSplatAuto } from "../../three/splatSerialization";
import {
  LayeredTextureState,
  applyTextureToGeometry,
  compositeLayersAuto,
  disposeLayeredTexture,
  ensureLayeredCanvases,
  layersSignature,
  layerNames,
  resolveLayers,
  syncCanvasTexture,
  syncLayeredMaterial,
} from "../../three/layeredTexture";
import { createPaintCanvas } from "../../three/texturePainter";

export type TextureMixPaintState = LayeredTextureState;

const textureMixCache = createNodeCache<TextureMixPaintState>((s) => {
  disposeLayeredTexture(s);
  if (s.group) disposeObject3D(s.group);
});

export function getTextureMixPaintState(nodeId: string): TextureMixPaintState {
  let state = textureMixCache.get(nodeId);
  if (!state) {
    state = { group: new THREE.Group() };
    textureMixCache.set(nodeId, state);
  }
  if (!state.group) state.group = new THREE.Group();
  return state;
}

const TEXTURE_PREFIX = "texture";

function textureSockets(connections: Connection[]): SocketDef[] {
  return growingSockets(connections, TEXTURE_PREFIX, (i) => ({
    id: `${TEXTURE_PREFIX}${i}`,
    label: `Texture ${i + 1}`,
    type: "texture",
  }));
}

export const TEXTURE_MIX_PAINT_NODE: NodeDefinition = {
  type: "texture/mix-paint",
  label: "Texture Mix",
  category: "textureTools",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "visible", label: "Visible", type: "value" },
    { id: "texture0", label: "Texture 1 (Base)", type: "texture" },
  ],
  dynamicInputs: (connections) => [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "visible", label: "Visible", type: "value" },
    ...textureSockets(connections),
  ],
  outputs: [
    { id: "texture", label: "Texture", type: "texture" },
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "splatMap", label: "Splat Map", type: "texture" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    resolution: 1024,
    activeLayer: 0,
    brushTool: "paint" as TextureMixTool,
    brushSize: 32,
    brushStrength: 0.8,
    brushFalloff: "smooth" as TextureMixFalloff,
    usePressure: true,
    pressureTarget: "both",
    // Per-layer texture tiling, in repeats across the composited map.
    uvScale0: 1,
    uvScale1: 1,
    uvScale2: 1,
    uvScale3: 1,
    splatData: "",
    visible: 1,
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    roughness: 0.6,
    metalness: 0.0,
  },
  dynamicParamFields: (instance: NodeInstance) => {
    const params = instance?.params ?? {};

    // How many layers this instance actually has, from the texture sockets
    // that were wired (the evaluator grows one spare slot past the last one).
    const layerCount = Math.max(
      1,
      Object.keys(params).reduce((max, key) => {
        if (!key.startsWith("uvScale")) return max;
        const idx = parseInt(key.slice("uvScale".length), 10);
        return Number.isNaN(idx) ? max : Math.max(max, idx + 1);
      }, 4),
    );

    const layerOptions = Array.from({ length: layerCount }, (_, i) => String(i));
    const names = layerNames(params, layerCount);

    // One name + one tiling control per layer, together in a "Layers" group
    // so the stack reads as a stack. `uvScale{i}` was read by the compositor
    // from the start but exposed nowhere, so tiling was unreachable.
    const layerFields = Array.from({ length: layerCount }, (_, i) => [
      {
        id: `layerName${i}`,
        label: `${i + 1}. Name`,
        kind: "text" as const,
        group: "Layers",
      },
      {
        id: `uvScale${i}`,
        label: `${i + 1}. Tiling`,
        kind: "number" as const,
        step: 0.25,
        group: "Layers",
      },
    ]).flat();

    return [
      {
        id: "resolution",
        label: "Resolution",
        kind: "select",
        options: ["512", "1024", "2048"],
      },
      {
        id: "activeLayer",
        label: "Painting On",
        kind: "select",
        options: layerOptions,
        optionLabels: names,
      },
      {
        id: "brushTool",
        label: "Brush Tool",
        kind: "select",
        options: ["paint", "erase", "smooth", "fill"],
      },
      { id: "brushSize", label: "Brush Radius", kind: "number", step: 1 },
      { id: "brushStrength", label: "Brush Strength", kind: "number", step: 0.05 },
      {
        id: "brushFalloff",
        label: "Brush Falloff",
        kind: "select",
        options: ["smooth", "linear", "flat"],
      },
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
      ...layerFields,
    ];
  },
  evaluate: (inputs, params, ctx) => {
    const state = getTextureMixPaintState(ctx.nodeId);
    const res = Math.max(64, Math.min(2048, Number(params.resolution) || 1024));

    const layers = resolveLayers(inputs, params, {
      prefix: TEXTURE_PREFIX,
      minLayers: 1,
      maxLayers: 16,
      bitmapSize: Math.min(512, res),
    });
    const layerCount = Math.max(1, layers.length);
    // The viewport brush recomposites mid-stroke and reads these.
    state.layers = layers;
    state.layerCount = layerCount;

    // Initialize or reallocate splat buffer
    if (!state.splatBuffer || state.lastRes !== res || state.lastLayerCount !== layerCount) {
      state.splatBuffer = ensureSplatBuffer(state.splatBuffer, res, res, layerCount);
      state.lastRes = res;
      state.lastLayerCount = layerCount;
    }

    // Restore from saved splatData if present and changed. PNG payloads
    // decode asynchronously, so the buffer is swapped in when it lands and the
    // splat version is bumped to make the next evaluation re-composite.
    const splatData = String(params.splatData || "");
    if (splatData && splatData !== state.lastSplatData) {
      state.lastSplatData = splatData;
      restoreSplatAuto(splatData, res, res, layerCount, (restored) => {
        if (!restored) return;
        state.splatBuffer = restored;
        state.splatVersion = (state.splatVersion ?? 0) + 1;
      });
    }

    ensureLayeredCanvases(state, res, createPaintCanvas);

    // Compositing is ~1M pixels x layerCount. The graph re-evaluates every
    // node every frame, so it only runs when something it depends on moved —
    // including the splat version, which the brush bumps as it paints.
    const signature = JSON.stringify({
      res,
      layerCount,
      layers: layersSignature(layers),
      splatVersion: state.splatVersion ?? 0,
      splatData: splatData.length,
    });

    if (state.lastSignature !== signature) {
      state.lastSignature = signature;

      if (state.splatBuffer) {
        state.texture = compositeLayersAuto(state, layers, {
          renderer: ctx.renderer,
          res,
          layerCount,
        }) ?? undefined;
      }
      if (state.splatCanvas && state.splatBuffer) {
        renderSplatMapPreview(state.splatCanvas, state.splatBuffer, res, res, layerCount);
        state.splatTexture = syncCanvasTexture(state.splatTexture, state.splatCanvas, THREE.LinearSRGBColorSpace);
      }
    }

    syncLayeredMaterial(state, params, { roughness: 0.6, metalness: 0.0 });

    // Geometry passthrough
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
      "isTextureMixTarget",
    );

    return {
      texture: state.texture ?? null,
      geometry: inputGeom ?? group,
      splatMap: state.splatTexture ?? null,
      matrix,
    };
  },
};
