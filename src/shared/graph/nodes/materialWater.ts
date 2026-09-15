import * as THREE from "three";
import { createNodeCache } from "../nodeCaches";
import { NodeDefinition, ParamFieldDef } from "../types";
import { asColor, numberInput } from "./object";
import { asVector3 } from "./transform";
import { createStylizedWaterMaterial } from "../../three/shaders/waterShader";

const waterMatCache = createNodeCache<THREE.ShaderMaterial>((m) => m.dispose());

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function remapClamp(value: number, low: number, high: number, toLow: number, toHigh: number): number {
  if (high === low) return toLow;
  return toLow + clamp01((value - low) / (high - low)) * (toHigh - toLow);
}

const WATER_PARAM_FIELDS: ParamFieldDef[] = [
  { id: "surfaceElevation", label: "Surface Elevation (Y)", kind: "number", step: 0.1, group: "Terrain & Shore" },
  { id: "depthElevation", label: "Depth Elevation (Y)", kind: "number", step: 0.1, group: "Terrain & Shore" },
  { id: "terrainWidth", label: "Terrain Width (X)", kind: "number", step: 1, group: "Terrain & Shore" },
  { id: "terrainDepth", label: "Terrain Depth (Z)", kind: "number", step: 1, group: "Terrain & Shore" },
  { id: "terrainCenter", label: "Terrain Center", kind: "vector", group: "Terrain & Shore" },
  { id: "shoreFoamWidth", label: "Shore Foam Width", kind: "number", step: 0.01, group: "Terrain & Shore" },
  { id: "shoreFoamWobble", label: "Shore Foam Wobble", kind: "number", step: 0.05, group: "Terrain & Shore" },

  { id: "ripplesCount", label: "Ripples per Shore", kind: "number", step: 1, group: "Ripples" },
  { id: "ripplesReach", label: "Reach (world units)", kind: "number", step: 0.1, group: "Ripples" },
  { id: "ripplesNoiseFrequency", label: "Noise Frequency", kind: "number", step: 0.01, group: "Ripples" },
  { id: "ripplesNoiseOffset", label: "Noise Offset", kind: "number", step: 0.001, group: "Ripples" },
  { id: "ripplesShoreRange", label: "Shore Range", kind: "number", step: 0.01, group: "Ripples" },
  { id: "ripplesSpeed", label: "Speed", kind: "number", step: 0.01, group: "Ripples" },
  { id: "ripplesFalloff", label: "Slope Falloff", kind: "number", step: 0.05, group: "Ripples" },
  { id: "ripplesSegmentFrequency", label: "Segment Frequency", kind: "number", step: 0.05, group: "Ripples" },
  { id: "ripplesSegmentGap", label: "Segment Gaps (0-1)", kind: "number", step: 0.05, group: "Ripples" },

  { id: "iceNoiseFrequency", label: "Ice Noise Frequency", kind: "number", step: 0.01, group: "Ice" },

  { id: "splashesNoiseFrequency", label: "Noise Frequency", kind: "number", step: 0.01, group: "Splashes" },
  { id: "splashesTimeFrequency", label: "Time Frequency", kind: "number", step: 0.1, group: "Splashes" },
  { id: "splashesThickness", label: "Thickness", kind: "number", step: 0.01, group: "Splashes" },
  { id: "splashesEdgeAttenuationLow", label: "Edge Attenuation Low", kind: "number", step: 0.01, group: "Splashes" },
  { id: "splashesEdgeAttenuationHigh", label: "Edge Attenuation High", kind: "number", step: 0.01, group: "Splashes" },

  { id: "temperature", label: "Temperature (°C)", kind: "number", step: 0.5, group: "Weather" },
  { id: "rain", label: "Rain (0-1)", kind: "number", step: 0.05, group: "Weather" },

  { id: "sandColor", label: "Sand Color", kind: "color", group: "Colors" },
  { id: "shallowColor", label: "Shallow Color", kind: "color", group: "Colors" },
  { id: "deepColor", label: "Deep Color", kind: "color", group: "Colors" },
  { id: "detailsColor", label: "Details Color", kind: "color", group: "Colors" },
  { id: "sandStop", label: "Sand Stop", kind: "number", step: 0.01, group: "Colors" },
  { id: "shallowStop", label: "Shallow Stop", kind: "number", step: 0.01, group: "Colors" },
  { id: "deepStop", label: "Deep Stop", kind: "number", step: 0.01, group: "Colors" },
  { id: "waterTint", label: "Water Tint (0 = details only)", kind: "number", step: 0.05, group: "Colors" },
  { id: "edgeFade", label: "Shore Edge Fade", kind: "number", step: 0.05, group: "Colors" },
  { id: "detailsShadowStrength", label: "Foam Shadow", kind: "number", step: 0.05, group: "Colors" },
  { id: "detailsShadowOffset", label: "Foam Shadow Offset", kind: "vector", group: "Colors" },
  { id: "detailsShadowColor", label: "Foam Shadow Tint", kind: "color", group: "Colors" },
];

export const MATERIAL_STYLIZED_WATER_NODE: NodeDefinition = {
  type: "material/stylized-water",
  label: "Stylized Water",
  category: "texture",
  inputs: [
    { id: "shoreMap", label: "Terrain Heightmap", type: "texture" },
    { id: "surfaceElevation", label: "Surface Elevation (Y)", type: "value" },
    { id: "depthElevation", label: "Depth Elevation (Y)", type: "value" },
    { id: "terrainWidth", label: "Terrain Width (X)", type: "value" },
    { id: "terrainDepth", label: "Terrain Depth (Z)", type: "value" },
    { id: "terrainCenter", label: "Terrain Center", type: "vector" },
    { id: "shoreFoamWidth", label: "Shore Foam Width", type: "value" },
    { id: "ripplesSpeed", label: "Ripples Speed", type: "value" },
    { id: "ripplesCount", label: "Ripples per Shore", type: "value" },
    { id: "ripplesReach", label: "Ripples Reach", type: "value" },
    { id: "temperature", label: "Temperature (°C)", type: "value" },
    { id: "rain", label: "Rain (0-1)", type: "value" },
    { id: "ripplesRatio", label: "Ripples Ratio (override)", type: "value" },
    { id: "iceRatio", label: "Ice Ratio (override)", type: "value" },
    { id: "splashesRatio", label: "Splashes Ratio (override)", type: "value" },
    { id: "sandColor", label: "Sand Color", type: "color" },
    { id: "shallowColor", label: "Shallow Color", type: "color" },
    { id: "deepColor", label: "Deep Color", type: "color" },
    { id: "detailsColor", label: "Details Color", type: "color" },
    { id: "waterTint", label: "Water Tint", type: "value" },
    { id: "edgeFade", label: "Shore Edge Fade", type: "value" },
    { id: "detailsShadowStrength", label: "Foam Shadow", type: "value" },
    { id: "ripplesSegmentGap", label: "Segment Gaps", type: "value" },
  ],
  outputs: [{ id: "material", label: "Material", type: "material" }],
  defaultParams: {
    surfaceElevation: 0,
    depthElevation: -1.2,
    terrainWidth: 40,
    terrainDepth: 40,
    terrainCenter: new THREE.Vector3(0, 0, 0),
    shoreFoamWidth: 0,
    shoreFoamWobble: 0.35,

    ripplesCount: 3,
    ripplesReach: 2.0,
    ripplesNoiseFrequency: 0.1,
    ripplesNoiseOffset: 0.345,
    ripplesShoreRange: 0.2,
    ripplesSpeed: 0.12,
    ripplesFalloff: 1.5,
    ripplesSegmentFrequency: 1.1,
    ripplesSegmentGap: 0.5,

    iceNoiseFrequency: 0.3,

    splashesNoiseFrequency: 0.33,
    splashesTimeFrequency: 6,
    splashesThickness: 0.3,
    splashesEdgeAttenuationLow: 0.14,
    splashesEdgeAttenuationHigh: 1,

    temperature: 18,
    rain: 0,

    sandColor: new THREE.Color(0xffa94e),
    shallowColor: new THREE.Color(0x5bc2b9),
    deepColor: new THREE.Color(0x13375f),
    detailsColor: new THREE.Color(0xffffff),
    sandStop: 0.1,
    shallowStop: 0.3,
    deepStop: 0.9,
    waterTint: 1,
    edgeFade: 0.35,
    detailsShadowStrength: 0.55,
    detailsShadowOffset: new THREE.Vector3(0.07, 0, 0.07),
    detailsShadowColor: new THREE.Color(0.55, 0.62, 0.72),
  },
  paramFields: WATER_PARAM_FIELDS,
  evaluate: (inputs, params, ctx) => {
    let mat = waterMatCache.get(ctx.nodeId);
    if (!mat) {
      mat = createStylizedWaterMaterial();
      (mat as unknown as { __isSharedCustom: boolean }).__isSharedCustom = true;
      waterMatCache.set(ctx.nodeId, mat);
    }
    const u = mat.uniforms;

    const shoreMap = inputs.shoreMap instanceof THREE.Texture ? inputs.shoreMap : null;
    u.shoreMap.value = shoreMap;
    u.hasShoreMap.value = shoreMap ? 1 : 0;
    const image = shoreMap?.image as { width?: number; height?: number } | undefined;
    u.shoreMapResolution.value.set(
      Math.max(1, Number(image?.width) || 128),
      Math.max(1, Number(image?.height) || 128),
    );

    const surfaceElevation = numberInput(inputs.surfaceElevation, params.surfaceElevation, 0);
    const depthElevation = numberInput(inputs.depthElevation, params.depthElevation, -1.2);
    u.surfaceElevation.value = surfaceElevation;
    // A zero-height water column would make the shore factor a divide-by-zero in the shader.
    u.depthElevation.value = depthElevation < surfaceElevation ? depthElevation : surfaceElevation - 0.001;

    u.terrainSize.value.set(
      Math.max(0.001, numberInput(inputs.terrainWidth, params.terrainWidth, 40)),
      Math.max(0.001, numberInput(inputs.terrainDepth, params.terrainDepth, 40)),
    );
    u.terrainCenter.value.copy(asVector3(inputs.terrainCenter, asVector3(params.terrainCenter, new THREE.Vector3())));

    u.shoreFoamWidth.value = Math.max(0, numberInput(inputs.shoreFoamWidth, params.shoreFoamWidth, 0));
    u.shoreFoamWobble.value = numberInput(undefined, params.shoreFoamWobble, 0.35);

    u.ripplesCount.value = Math.max(1, numberInput(inputs.ripplesCount, params.ripplesCount, 3));
    u.ripplesReach.value = Math.max(0.001, numberInput(inputs.ripplesReach, params.ripplesReach, 2.0));
    u.ripplesNoiseFrequency.value = numberInput(undefined, params.ripplesNoiseFrequency, 0.1);
    // Divides the ripple index in the shader, so it must never reach zero.
    const noiseOffset = numberInput(undefined, params.ripplesNoiseOffset, 0.345);
    u.ripplesNoiseOffset.value = Math.abs(noiseOffset) < 1e-4 ? 1e-4 : noiseOffset;
    u.ripplesShoreRange.value = numberInput(undefined, params.ripplesShoreRange, 0.2);
    u.ripplesSpeed.value = numberInput(inputs.ripplesSpeed, params.ripplesSpeed, 0.12);
    u.ripplesFalloff.value = numberInput(undefined, params.ripplesFalloff, 1.5);
    u.ripplesSegmentFrequency.value = numberInput(undefined, params.ripplesSegmentFrequency, 1.1);
    u.ripplesSegmentGap.value = clamp01(numberInput(inputs.ripplesSegmentGap, params.ripplesSegmentGap, 0.5));

    u.iceNoiseFrequency.value = numberInput(undefined, params.iceNoiseFrequency, 0.3);

    u.splashesNoiseFrequency.value = numberInput(undefined, params.splashesNoiseFrequency, 0.33);
    u.splashesTimeFrequency.value = numberInput(undefined, params.splashesTimeFrequency, 6);
    u.splashesThickness.value = numberInput(undefined, params.splashesThickness, 0.3);
    u.splashesEdgeAttenuationLow.value = numberInput(undefined, params.splashesEdgeAttenuationLow, 0.14);
    u.splashesEdgeAttenuationHigh.value = numberInput(undefined, params.splashesEdgeAttenuationHigh, 1);

    // Weather drives the three ratios exactly as WaterSurface.update() does, unless overridden.
    const temperature = numberInput(inputs.temperature, params.temperature, 18);
    const rain = clamp01(numberInput(inputs.rain, params.rain, 0));

    u.ripplesRatio.value = inputs.ripplesRatio !== undefined
      ? clamp01(numberInput(inputs.ripplesRatio, 1, 1))
      : remapClamp(temperature, 0, -3, 1, 0);
    u.iceRatio.value = inputs.iceRatio !== undefined
      ? clamp01(numberInput(inputs.iceRatio, 0, 0))
      : remapClamp(temperature, 0, -5, 0, 1);
    u.splashesRatio.value = inputs.splashesRatio !== undefined
      ? clamp01(numberInput(inputs.splashesRatio, 0, 0))
      : rain * rain;

    const sandColor = asColor(inputs.sandColor, asColor(params.sandColor, new THREE.Color(0xffa94e)));
    const shallowColor = asColor(inputs.shallowColor, asColor(params.shallowColor, new THREE.Color(0x5bc2b9)));
    const deepColor = asColor(inputs.deepColor, asColor(params.deepColor, new THREE.Color(0x13375f)));
    const detailsColor = asColor(inputs.detailsColor, asColor(params.detailsColor, new THREE.Color(0xffffff)));
    u.sandColor.value.copy(sandColor);
    u.shallowColor.value.copy(shallowColor);
    u.deepColor.value.copy(deepColor);
    u.detailsColor.value.copy(detailsColor);

    u.sandStop.value = clamp01(numberInput(undefined, params.sandStop, 0.1));
    u.shallowStop.value = clamp01(numberInput(undefined, params.shallowStop, 0.3));
    u.deepStop.value = clamp01(numberInput(undefined, params.deepStop, 0.9));

    const waterTint = clamp01(numberInput(inputs.waterTint, params.waterTint, 1));
    u.waterTint.value = waterTint;
    u.edgeFade.value = Math.max(0, numberInput(inputs.edgeFade, params.edgeFade, 0.35));
    u.detailsShadowStrength.value = clamp01(numberInput(inputs.detailsShadowStrength, params.detailsShadowStrength, 0.55));
    const shadowOffset = asVector3(params.detailsShadowOffset, new THREE.Vector3(0.07, 0, 0.07));
    u.detailsShadowOffset.value.set(shadowOffset.x, shadowOffset.z);
    u.detailsShadowColor.value.copy(asColor(params.detailsShadowColor, new THREE.Color(0.55, 0.62, 0.72)));

    u.time.value = ctx.time ?? 0;

    return {
      material: {
        customMaterial: mat,
        color: shallowColor,
        opacity: waterTint,
      },
    };
  },
};
