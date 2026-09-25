import * as THREE from "three";
import { Connection, NodeDefinition, NodeInstance } from "../types";
import { SocketDef } from "../sockets";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { composeNativeMatrix } from "./transform";
import { createPaintCanvas } from "../../three/texturePainter";
import {
  computeHeightSlopeWeights,
  ensureSplatBuffer,
  renderSplatMapPreview,
} from "../../three/textureMixEngine";
import {
  LayeredTextureState,
  applyTextureToGeometry,
  compositeLayersAuto,
  disposeLayeredTexture,
  ensureLayeredCanvases,
  geometryVersionKey,
  layersSignature,
  resolveLayers,
  syncCanvasTexture,
  syncLayeredMaterial,
} from "../../three/layeredTexture";

export const TEXTURE_PREFIX = "texture";

/** Param-button actions handled by the editor (see App's onParamAction). */
export const TOPOGRAPHY_PRESET_ACTION_PREFIX = "topographyPreset:";
export const TOPOGRAPHY_BAKE_ACTION = "topographyBakeToPaint";

/**
 * Terrain starting points.
 *
 * The node's thresholds are the real controls, and they stay visible — a
 * preset just fills them in with a coherent set, because "cliffs steeper than
 * 35°, peaks above 0.75" is a lot to invent from nothing the first time.
 */
export const TOPOGRAPHY_PRESETS: Record<string, Record<string, number>> = {
  alpine: {
    slopeAngle: 32,
    slopeBlend: 12,
    snowHeight: 0.62,
    snowBlend: 0.12,
    shoreHeight: 0.1,
    shoreBlend: 0.06,
    shoreLayer: -1,
    noiseAmount: 0.3,
    noiseFrequency: 7,
  },
  desert: {
    // No snow: the peak rule is pushed out of range rather than disabled, so
    // the picker still shows what it would use.
    slopeAngle: 45,
    slopeBlend: 20,
    snowHeight: 1.2,
    snowBlend: 0.05,
    shoreHeight: 0.25,
    shoreBlend: 0.18,
    shoreLayer: 3,
    noiseAmount: 0.45,
    noiseFrequency: 4,
  },
  coastal: {
    slopeAngle: 38,
    slopeBlend: 14,
    snowHeight: 0.9,
    snowBlend: 0.1,
    shoreHeight: 0.22,
    shoreBlend: 0.12,
    shoreLayer: 3,
    noiseAmount: 0.2,
    noiseFrequency: 9,
  },
};

export type TextureHeightSlopeState = LayeredTextureState;

const heightSlopeMixCache = createNodeCache<TextureHeightSlopeState>((s) => {
  disposeLayeredTexture(s);
  if (s.group) disposeObject3D(s.group);
});

export function getHeightSlopeMixState(nodeId: string): TextureHeightSlopeState {
  let state = heightSlopeMixCache.get(nodeId);
  if (!state) {
    state = { group: new THREE.Group() };
    heightSlopeMixCache.set(nodeId, state);
  }
  if (!state.group) state.group = new THREE.Group();
  return state;
}

export const TEXTURE_HEIGHT_SLOPE_MIX_NODE: NodeDefinition = {
  type: "texture/height-slope-mix",
  label: "Topography Texture Mix",
  category: "textureTools",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "texture0", label: "Texture 0 (Base / Flat)", type: "texture" },
    { id: "texture1", label: "Texture 1 (Slope / Cliff)", type: "texture" },
    { id: "texture2", label: "Texture 2 (Snow / Peak)", type: "texture" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "visible", label: "Visible", type: "value" },
  ],
  outputs: [
    { id: "texture", label: "Texture", type: "texture" },
    { id: "splatMap", label: "Splat Map", type: "texture" },
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    resolution: 1024,
    slopeAngle: 35,
    slopeBlend: 15,
    slopeLayer: 1,
    snowHeight: 0.75,
    snowBlend: 0.15,
    snowLayer: 2,
    shoreHeight: 0.15,
    shoreBlend: 0.1,
    shoreLayer: -1,
    baseLayer: 0,
    noiseAmount: 0.25,
    noiseFrequency: 6.0,
    // Per-layer texture tiling, in repeats across the baked map.
    uvScale0: 1,
    uvScale1: 1,
    uvScale2: 1,
    uvScale3: 1,
    visible: 1,
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    roughness: 0.7,
    metalness: 0.0,
  },
  dynamicInputs: (connections: Connection[]) => {
    const connSockets = new Set<string>();
    for (const c of connections) {
      if (c.toSocket && c.toSocket.startsWith(TEXTURE_PREFIX)) {
        connSockets.add(c.toSocket);
      }
    }

    let maxIdx = 2; // Default 3 textures (0: Flat, 1: Slope, 2: Snow)
    for (const s of connSockets) {
      const num = parseInt(s.slice(TEXTURE_PREFIX.length), 10);
      if (!isNaN(num) && num > maxIdx) {
        maxIdx = num;
      }
    }

    const inputs: SocketDef[] = [
      { id: "geometry", label: "Geometry", type: "geometry" },
    ];

    for (let i = 0; i <= maxIdx + 1; i++) {
      let label = `Texture ${i}`;
      if (i === 0) label += " (Flat / Grass)";
      else if (i === 1) label += " (Slope / Rock)";
      else if (i === 2) label += " (Snow / Peak)";
      else if (i === 3) label += " (Shore / Sand)";
      inputs.push({ id: `${TEXTURE_PREFIX}${i}`, label, type: "texture" });
    }

    inputs.push({ id: "matrix", label: "Matrix", type: "matrix" });
    inputs.push({ id: "visible", label: "Visible", type: "value" });
    return inputs;
  },
  dynamicParamFields: (instance: NodeInstance) => {
    const params = instance?.params ?? {};
    const layerCount = Math.max(
      3,
      Object.keys(params).reduce((max, key) => {
        if (!key.startsWith("uvScale")) return max;
        const idx = parseInt(key.slice("uvScale".length), 10);
        return Number.isNaN(idx) ? max : Math.max(max, idx + 1);
      }, 4),
    );

    // Per-layer name + tiling, kept together so the stack reads as a stack.
    const layerFields = Array.from({ length: layerCount }, (_, i) => [
      { id: `layerName${i}`, label: `${i + 1}. Name`, kind: "text" as const, group: "Layers" },
      { id: `uvScale${i}`, label: `${i + 1}. Tiling`, kind: "number" as const, step: 0.25, group: "Layers" },
    ]).flat();

    return [
      {
        id: "resolution",
        label: "Resolution",
        kind: "select",
        options: ["512", "1024", "2048"],
      },
      // A terrain preset writes the whole rule set at once. The individual
      // thresholds stay right below, so a preset is a starting point rather
      // than a mode to be stuck in.
      {
        id: "presetAlpine",
        label: "Preset: Alpine",
        kind: "button",
        action: TOPOGRAPHY_PRESET_ACTION_PREFIX + "alpine",
        group: "Presets",
      },
      {
        id: "presetDesert",
        label: "Preset: Desert",
        kind: "button",
        action: TOPOGRAPHY_PRESET_ACTION_PREFIX + "desert",
        group: "Presets",
      },
      {
        id: "presetCoastal",
        label: "Preset: Coastal",
        kind: "button",
        action: TOPOGRAPHY_PRESET_ACTION_PREFIX + "coastal",
        group: "Presets",
      },
      {
        id: "bakeToPaint",
        label: "Bake to a paintable Texture Mix",
        kind: "button",
        action: TOPOGRAPHY_BAKE_ACTION,
        group: "Presets",
      },

      // The altitude bands and the steepness threshold are one control: a bar
      // showing the real blend over the terrain's height, with the thresholds
      // as handles on it, plus a dial for the cliff angle. It replaces the ten
      // numeric fields that used to live here — none of which said what they
      // would look like.
      { id: "bands", label: "Altitude & steepness", kind: "topography_bands", group: "Rules" },
      { id: "noiseAmount", label: "Edge break-up", kind: "number", step: 0.05, percent: true, group: "Rules" },
      { id: "noiseFrequency", label: "Break-up scale", kind: "number", step: 0.5, group: "Rules" },

      { id: "roughness", label: "Roughness", kind: "number", step: 0.05 },
      { id: "metalness", label: "Metalness", kind: "number", step: 0.05 },
      ...layerFields,
      { id: "visible", label: "Visible", kind: "boolean" },
      { id: "location", label: "Location", kind: "vector" },
      { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true },
      { id: "scale", label: "Scale", kind: "vector" },
    ];
  },
  evaluate: (inputs, params, ctx) => {
    const state = getHeightSlopeMixState(ctx.nodeId);
    const res = Math.max(64, Math.min(2048, Number(params.resolution) || 1024));

    const layers = resolveLayers(inputs, params, {
      prefix: TEXTURE_PREFIX,
      minLayers: 3,
      maxLayers: 16,
      bitmapSize: Math.min(512, res),
    });
    const layerCount = Math.max(1, layers.length);
    state.layers = layers;
    state.layerCount = layerCount;

    ensureLayeredCanvases(state, res, createPaintCanvas);
    state.splatBuffer = ensureSplatBuffer(state.splatBuffer, res, res, layerCount);

    const inputGeom = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;

    // Compute signature to avoid redundant re-baking
    const signature = JSON.stringify({
      res,
      slopeAngle: params.slopeAngle,
      slopeBlend: params.slopeBlend,
      slopeLayer: params.slopeLayer,
      snowHeight: params.snowHeight,
      snowBlend: params.snowBlend,
      snowLayer: params.snowLayer,
      shoreHeight: params.shoreHeight,
      shoreBlend: params.shoreBlend,
      shoreLayer: params.shoreLayer,
      baseLayer: params.baseLayer,
      noiseAmount: params.noiseAmount,
      noiseFrequency: params.noiseFrequency,
      // Object3D.id never changes, so keying on it meant a terrain sculpted
      // in place kept its first bake forever. Attribute versions do move.
      geomVersion: geometryVersionKey(inputGeom),
      layers: layersSignature(layers),
      layerCount,
    });

    if (state.lastSignature !== signature) {
      state.lastSignature = signature;
      computeHeightSlopeWeights(state.splatBuffer, res, res, layerCount, inputGeom, {
        slopeAngle: Number(params.slopeAngle ?? 35),
        slopeBlend: Number(params.slopeBlend ?? 15),
        slopeLayer: Number(params.slopeLayer ?? 1),
        snowHeight: Number(params.snowHeight ?? 0.75),
        snowBlend: Number(params.snowBlend ?? 0.15),
        snowLayer: Number(params.snowLayer ?? 2),
        shoreHeight: Number(params.shoreHeight ?? 0.15),
        shoreBlend: Number(params.shoreBlend ?? 0.1),
        shoreLayer: Number(params.shoreLayer ?? -1),
        baseLayer: Number(params.baseLayer ?? 0),
        noiseAmount: Number(params.noiseAmount ?? 0.25),
        noiseFrequency: Number(params.noiseFrequency ?? 6.0),
      });

      if (state.splatBuffer) {
        state.texture = compositeLayersAuto(state, layers, {
          renderer: ctx.renderer,
          res,
          layerCount,
        }) ?? undefined;
      }
      if (state.splatCanvas) {
        renderSplatMapPreview(state.splatCanvas, state.splatBuffer, res, res, layerCount);
        state.splatTexture = syncCanvasTexture(state.splatTexture, state.splatCanvas, THREE.LinearSRGBColorSpace);
      }
    }

    syncLayeredMaterial(state, params, { roughness: 0.7, metalness: 0.0 });

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

    applyTextureToGeometry(inputGeom, state.texture ?? null, state.material!, ctx.nodeId);

    return {
      texture: state.texture ?? null,
      splatMap: state.splatTexture ?? null,
      geometry: inputGeom ?? group,
      matrix,
    };
  },
};
