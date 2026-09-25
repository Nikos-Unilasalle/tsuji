import * as THREE from "three";
import { createNodeCache } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { asColor, numberInput } from "./object";
import {
  createThermalMaterial,
  createXRayMaterial,
  createEnergyShieldMaterial,
  createStylizedFireMaterial,
  createMiyazakiCloudMaterial,
} from "../../three/shaders/creativeShadersVol2";

const thermalCache = createNodeCache<THREE.ShaderMaterial>((m) => m.dispose());
const xrayCache = createNodeCache<THREE.ShaderMaterial>((m) => m.dispose());
const shieldCache = createNodeCache<THREE.ShaderMaterial>((m) => m.dispose());
const stylizedFireCache = createNodeCache<THREE.ShaderMaterial>((m) => m.dispose());
const miyazakiCloudCache = createNodeCache<THREE.ShaderMaterial>((m) => m.dispose());

function toBool(val: unknown, fallback: boolean): boolean {
  if (val === undefined || val === null) return fallback;
  return Boolean(val);
}

/** 1. Thermal / Infrared Camera Material Node */
export const MATERIAL_THERMAL_NODE: NodeDefinition = {
  type: "material/thermal",
  label: "Thermal Vision (FLIR)",
  category: "material",
  inputs: [
    { id: "coldColor", label: "Cold Color", type: "color" },
    { id: "hotColor", label: "Hot Color", type: "color" },
    { id: "heatScale", label: "Heat Scale", type: "value" },
    { id: "minTemp", label: "Min Temp", type: "value" },
    { id: "maxTemp", label: "Max Temp", type: "value" },
    { id: "distortion", label: "Heat Shimmer", type: "value" },
    { id: "shimmerSpeed", label: "Shimmer Speed", type: "value" },
    { id: "enableDistortion", label: "Enable Distortion", type: "value" },
    { id: "invert", label: "Invert (White Hot)", type: "value" },
  ],
  outputs: [{ id: "material", label: "Material", type: "material" }],
  defaultParams: {
    coldColor: new THREE.Color(0x05051a),
    hotColor: new THREE.Color(0xffffff),
    heatScale: 1.5,
    minTemp: 0.1,
    maxTemp: 0.9,
    distortion: 0.2,
    shimmerSpeed: 1.5,
    enableDistortion: true,
    invert: false,
  },
  paramFields: [
    { id: "coldColor", label: "Cold Color", kind: "color" },
    { id: "hotColor", label: "Hot Color", kind: "color" },
    { id: "heatScale", label: "Heat Scale", kind: "number", step: 0.1 },
    { id: "minTemp", label: "Min Temp", kind: "number", step: 0.05 },
    { id: "maxTemp", label: "Max Temp", kind: "number", step: 0.05 },
    { id: "enableDistortion", label: "Enable Distortion", kind: "boolean" },
    { id: "distortion", label: "Heat Shimmer", kind: "number", step: 0.05 },
    { id: "shimmerSpeed", label: "Shimmer Speed", kind: "number", step: 0.1 },
    { id: "invert", label: "Invert (White Hot)", kind: "boolean" },
  ],
  evaluate: (inputs, params, ctx) => {
    let mat = thermalCache.get(ctx.nodeId);
    if (!mat) {
      mat = createThermalMaterial();
      (mat as any).__isSharedCustom = true;
      thermalCache.set(ctx.nodeId, mat);
    }

    const coldColor = asColor(inputs.coldColor, asColor(params.coldColor, new THREE.Color(0x05051a)));
    const hotColor = asColor(inputs.hotColor, asColor(params.hotColor, new THREE.Color(0xffffff)));

    mat.uniforms.coldColor.value.copy(coldColor);
    mat.uniforms.hotColor.value.copy(hotColor);
    mat.uniforms.heatScale.value = numberInput(inputs.heatScale, params.heatScale, 1.5);
    mat.uniforms.minTemp.value = numberInput(inputs.minTemp, params.minTemp, 0.1);
    mat.uniforms.maxTemp.value = numberInput(inputs.maxTemp, params.maxTemp, 0.9);
    mat.uniforms.distortion.value = numberInput(inputs.distortion, params.distortion, 0.2);
    mat.uniforms.shimmerSpeed.value = numberInput(inputs.shimmerSpeed, params.shimmerSpeed, 1.5);
    mat.uniforms.enableDistortion.value = toBool(inputs.enableDistortion !== undefined ? inputs.enableDistortion : params.enableDistortion, true) ? 1.0 : 0.0;
    mat.uniforms.invert.value = toBool(inputs.invert !== undefined ? inputs.invert : params.invert, false) ? 1.0 : 0.0;
    mat.uniforms.time.value = ctx.time ?? 0;

    return {
      material: {
        customMaterial: mat,
        color: hotColor,
      },
    };
  },
};

/** 2. X-Ray & Radiology Scanner Material Node */
export const MATERIAL_XRAY_NODE: NodeDefinition = {
  type: "material/xray",
  label: "X-Ray / Radiology",
  category: "material",
  inputs: [
    { id: "color", label: "Tint Color", type: "color" },
    { id: "coreColor", label: "Core Density Color", type: "color" },
    { id: "edgeIntensity", label: "Edge Intensity", type: "value" },
    { id: "interiorOpacity", label: "Interior Opacity", type: "value" },
    { id: "rimPower", label: "Rim Power", type: "value" },
    { id: "noiseIntensity", label: "Noise Intensity", type: "value" },
    { id: "enableGrain", label: "Enable Film Grain", type: "value" },
  ],
  outputs: [{ id: "material", label: "Material", type: "material" }],
  defaultParams: {
    color: new THREE.Color(0x38bdf8),
    coreColor: new THREE.Color(0x0e2a47),
    edgeIntensity: 2.0,
    interiorOpacity: 0.15,
    rimPower: 2.0,
    noiseIntensity: 0.1,
    enableGrain: true,
  },
  paramFields: [
    { id: "color", label: "Tint Color", kind: "color" },
    { id: "coreColor", label: "Core Density Color", kind: "color" },
    { id: "edgeIntensity", label: "Edge Intensity", kind: "number", step: 0.2 },
    { id: "interiorOpacity", label: "Interior Opacity", kind: "number", step: 0.05 },
    { id: "rimPower", label: "Rim Power", kind: "number", step: 0.2 },
    { id: "enableGrain", label: "Enable Film Grain", kind: "boolean" },
    { id: "noiseIntensity", label: "Noise Intensity", kind: "number", step: 0.02 },
  ],
  evaluate: (inputs, params, ctx) => {
    let mat = xrayCache.get(ctx.nodeId);
    if (!mat) {
      mat = createXRayMaterial();
      (mat as any).__isSharedCustom = true;
      xrayCache.set(ctx.nodeId, mat);
    }

    const color = asColor(inputs.color, asColor(params.color, new THREE.Color(0x38bdf8)));
    const coreColor = asColor(inputs.coreColor, asColor(params.coreColor, new THREE.Color(0x0e2a47)));

    mat.uniforms.color.value.copy(color);
    mat.uniforms.coreColor.value.copy(coreColor);
    mat.uniforms.edgeIntensity.value = numberInput(inputs.edgeIntensity, params.edgeIntensity, 2.0);
    mat.uniforms.interiorOpacity.value = numberInput(inputs.interiorOpacity, params.interiorOpacity, 0.15);
    mat.uniforms.rimPower.value = numberInput(inputs.rimPower, params.rimPower, 2.0);
    mat.uniforms.noiseIntensity.value = numberInput(inputs.noiseIntensity, params.noiseIntensity, 0.1);
    mat.uniforms.enableGrain.value = toBool(inputs.enableGrain !== undefined ? inputs.enableGrain : params.enableGrain, true) ? 1.0 : 0.0;

    return {
      material: {
        customMaterial: mat,
        color,
      },
    };
  },
};

/** 3. Hexagonal Energy Shield Material Node */
export const MATERIAL_ENERGY_SHIELD_NODE: NodeDefinition = {
  type: "material/energy-shield",
  label: "Energy Shield (Hex)",
  category: "material",
  inputs: [
    { id: "shieldColor", label: "Shield Color", type: "color" },
    { id: "gridColor", label: "Hex Grid Color", type: "color" },
    { id: "hexScale", label: "Hex Scale", type: "value" },
    { id: "edgeSharpness", label: "Edge Sharpness", type: "value" },
    { id: "fresnelPower", label: "Fresnel Power", type: "value" },
    { id: "pulseSpeed", label: "Pulse Speed", type: "value" },
    { id: "pulseIntensity", label: "Pulse Intensity", type: "value" },
    { id: "enableGrid", label: "Enable Hex Grid", type: "value" },
    { id: "enablePulse", label: "Enable Pulse Wave", type: "value" },
  ],
  outputs: [{ id: "material", label: "Material", type: "material" }],
  defaultParams: {
    shieldColor: new THREE.Color(0x00f3ff),
    gridColor: new THREE.Color(0xec4899),
    hexScale: 12.0,
    edgeSharpness: 0.85,
    fresnelPower: 2.5,
    pulseSpeed: 2.5,
    pulseIntensity: 1.5,
    enableGrid: true,
    enablePulse: true,
  },
  paramFields: [
    { id: "shieldColor", label: "Shield Color", kind: "color" },
    { id: "gridColor", label: "Hex Grid Color", kind: "color" },
    { id: "enableGrid", label: "Enable Hex Grid", kind: "boolean" },
    { id: "hexScale", label: "Hex Scale", kind: "number", step: 1.0 },
    { id: "edgeSharpness", label: "Edge Sharpness", kind: "number", step: 0.02 },
    { id: "fresnelPower", label: "Fresnel Power", kind: "number", step: 0.2 },
    { id: "enablePulse", label: "Enable Pulse Wave", kind: "boolean" },
    { id: "pulseSpeed", label: "Pulse Speed", kind: "number", step: 0.2 },
    { id: "pulseIntensity", label: "Pulse Intensity", kind: "number", step: 0.2 },
  ],
  evaluate: (inputs, params, ctx) => {
    let mat = shieldCache.get(ctx.nodeId);
    if (!mat) {
      mat = createEnergyShieldMaterial();
      (mat as any).__isSharedCustom = true;
      shieldCache.set(ctx.nodeId, mat);
    }

    const shieldColor = asColor(inputs.shieldColor, asColor(params.shieldColor, new THREE.Color(0x00f3ff)));
    const gridColor = asColor(inputs.gridColor, asColor(params.gridColor, new THREE.Color(0xec4899)));

    mat.uniforms.shieldColor.value.copy(shieldColor);
    mat.uniforms.gridColor.value.copy(gridColor);
    mat.uniforms.hexScale.value = numberInput(inputs.hexScale, params.hexScale, 12.0);
    mat.uniforms.edgeSharpness.value = numberInput(inputs.edgeSharpness, params.edgeSharpness, 0.85);
    mat.uniforms.fresnelPower.value = numberInput(inputs.fresnelPower, params.fresnelPower, 2.5);
    mat.uniforms.pulseSpeed.value = numberInput(inputs.pulseSpeed, params.pulseSpeed, 2.5);
    mat.uniforms.pulseIntensity.value = numberInput(inputs.pulseIntensity, params.pulseIntensity, 1.5);
    mat.uniforms.enableGrid.value = toBool(inputs.enableGrid !== undefined ? inputs.enableGrid : params.enableGrid, true) ? 1.0 : 0.0;
    mat.uniforms.enablePulse.value = toBool(inputs.enablePulse !== undefined ? inputs.enablePulse : params.enablePulse, true) ? 1.0 : 0.0;
    mat.uniforms.time.value = ctx.time ?? 0;

    return {
      material: {
        customMaterial: mat,
        color: shieldColor,
      },
    };
  },
};

/** 4. Stylized Cartoon Flame Material Node (SDF & Smooth Boolean) */
export const MATERIAL_STYLIZED_FIRE_NODE: NodeDefinition = {
  type: "material/stylized_fire",
  label: "Stylized Flame (SDF)",
  category: "material",
  inputs: [
    { id: "smoothness", label: "Smoothness (k)", type: "value" },
    { id: "colorSoftness", label: "Color Softness", type: "value" },
    { id: "enableCore", label: "Show Core", type: "value" },
    { id: "enableInner", label: "Show Inner", type: "value" },
    { id: "enableDark", label: "Show Shadow", type: "value" },
    { id: "enableOutline", label: "Show Outline", type: "value" },
    { id: "flameWidth", label: "Flame Width", type: "value" },
    { id: "flameHeight", label: "Flame Height", type: "value" },
    { id: "waveSpeed", label: "Wave Speed", type: "value" },
    { id: "waveFrequency", label: "Wave Freq", type: "value" },
    { id: "waveAmplitude", label: "Wave Amp", type: "value" },
    { id: "bubbleSpeed", label: "Bubble Speed", type: "value" },
    { id: "bubbleScale", label: "Bubble Scale", type: "value" },
    { id: "internalHoles", label: "Internal Holes", type: "value" },
    { id: "coreSize", label: "Core Size", type: "value" },
    { id: "coreOffsetY", label: "Core Offset Y", type: "value" },
    { id: "coreBaseMask", label: "Core Masking", type: "value" },
    { id: "baseCurvature", label: "Base Curvature (Y)", type: "value" },
    { id: "outlineWidth", label: "Outline Width", type: "value" },
    { id: "coreColor", label: "Core Color", type: "color" },
    { id: "innerColor", label: "Inner Color", type: "color" },
    { id: "bodyColor", label: "Body Color", type: "color" },
    { id: "darkColor", label: "Shadow Color", type: "color" },
    { id: "outlineColor", label: "Outline Color", type: "color" },
  ],
  outputs: [{ id: "material", label: "Material", type: "material" }],
  defaultParams: {
    smoothness: 0.18,
    colorSoftness: 0.02,
    enableCore: true,
    enableInner: true,
    enableDark: true,
    enableOutline: true,
    flameWidth: 0.38,
    flameHeight: 0.82,
    waveSpeed: 2.8,
    waveFrequency: 3.2,
    waveAmplitude: 0.12,
    bubbleSpeed: 2.0,
    bubbleScale: 0.22,
    internalHoles: 0.65,
    coreSize: 0.45,
    coreOffsetY: -0.04,
    coreBaseMask: 0.9,
    baseCurvature: 1.0,
    outlineWidth: 0.018,
    coreColor: new THREE.Color(0xfffde0),
    innerColor: new THREE.Color(0xffcc00),
    bodyColor: new THREE.Color(0xff5500),
    darkColor: new THREE.Color(0xa82000),
    outlineColor: new THREE.Color(0x1a0500),
  },
  paramFields: [
    { id: "smoothness", label: "Smoothness (k)", kind: "number", step: 0.01 },
    { id: "colorSoftness", label: "Color Softness / Feather", kind: "number", step: 0.01 },
    { id: "enableCore", label: "Show Core (White)", kind: "boolean" },
    { id: "enableInner", label: "Show Inner (Yellow)", kind: "boolean" },
    { id: "enableDark", label: "Show Shadow (Amber)", kind: "boolean" },
    { id: "enableOutline", label: "Show Outline (Contour)", kind: "boolean" },
    { id: "flameWidth", label: "Flame Width", kind: "number", step: 0.02 },
    { id: "flameHeight", label: "Flame Height", kind: "number", step: 0.02 },
    { id: "baseCurvature", label: "Base Curvature (Y)", kind: "number", step: 0.05 },
    { id: "waveSpeed", label: "Wave Speed", kind: "number", step: 0.1 },
    { id: "waveFrequency", label: "Wave Freq", kind: "number", step: 0.1 },
    { id: "waveAmplitude", label: "Wave Amp", kind: "number", step: 0.01 },
    { id: "bubbleSpeed", label: "Bubble Speed", kind: "number", step: 0.1 },
    { id: "bubbleScale", label: "Bubble Scale", kind: "number", step: 0.02 },
    { id: "internalHoles", label: "Internal Holes", kind: "number", step: 0.05 },
    { id: "coreSize", label: "Core Size", kind: "number", step: 0.02 },
    { id: "coreOffsetY", label: "Core Offset Y", kind: "number", step: 0.01 },
    { id: "coreBaseMask", label: "Core Bottom Masking", kind: "number", step: 0.05 },
    { id: "outlineWidth", label: "Outline Width", kind: "number", step: 0.002 },
    { id: "coreColor", label: "Core Color", kind: "color" },
    { id: "innerColor", label: "Inner Color", kind: "color" },
    { id: "bodyColor", label: "Body Color", kind: "color" },
    { id: "darkColor", label: "Shadow Color", kind: "color" },
    { id: "outlineColor", label: "Outline Color", kind: "color" },
  ],
  evaluate: (inputs, params, ctx) => {
    let mat = stylizedFireCache.get(ctx.nodeId);
    if (!mat) {
      mat = createStylizedFireMaterial();
      (mat as any).__isSharedCustom = true;
      stylizedFireCache.set(ctx.nodeId, mat);
    }

    mat.uniforms.smoothness.value = numberInput(inputs.smoothness, params.smoothness, 0.18);
    mat.uniforms.colorSoftness.value = Math.max(0.0, numberInput(inputs.colorSoftness, params.colorSoftness, 0.02));
    mat.uniforms.enableCore.value = toBool(inputs.enableCore !== undefined ? inputs.enableCore : params.enableCore, true) ? 1.0 : 0.0;
    mat.uniforms.enableInner.value = toBool(inputs.enableInner !== undefined ? inputs.enableInner : params.enableInner, true) ? 1.0 : 0.0;
    mat.uniforms.enableDark.value = toBool(inputs.enableDark !== undefined ? inputs.enableDark : params.enableDark, true) ? 1.0 : 0.0;
    mat.uniforms.enableOutline.value = toBool(inputs.enableOutline !== undefined ? inputs.enableOutline : params.enableOutline, true) ? 1.0 : 0.0;

    mat.uniforms.flameWidth.value = numberInput(inputs.flameWidth, params.flameWidth, 0.38);
    mat.uniforms.flameHeight.value = numberInput(inputs.flameHeight, params.flameHeight, 0.82);
    mat.uniforms.baseCurvature.value = numberInput(inputs.baseCurvature, params.baseCurvature, 1.0);
    mat.uniforms.waveSpeed.value = numberInput(inputs.waveSpeed, params.waveSpeed, 2.8);
    mat.uniforms.waveFrequency.value = numberInput(inputs.waveFrequency, params.waveFrequency, 3.2);
    mat.uniforms.waveAmplitude.value = numberInput(inputs.waveAmplitude, params.waveAmplitude, 0.12);
    mat.uniforms.bubbleSpeed.value = numberInput(inputs.bubbleSpeed, params.bubbleSpeed, 2.0);
    mat.uniforms.bubbleScale.value = numberInput(inputs.bubbleScale, params.bubbleScale, 0.22);
    mat.uniforms.internalHoles.value = numberInput(inputs.internalHoles, params.internalHoles, 0.65);
    mat.uniforms.coreSize.value = numberInput(inputs.coreSize, params.coreSize, 0.45);
    mat.uniforms.coreOffsetY.value = numberInput(inputs.coreOffsetY, params.coreOffsetY, -0.04);
    mat.uniforms.coreBaseMask.value = numberInput(inputs.coreBaseMask, params.coreBaseMask, 0.9);
    mat.uniforms.outlineWidth.value = numberInput(inputs.outlineWidth, params.outlineWidth, 0.018);

    const coreColor = asColor(inputs.coreColor, asColor(params.coreColor, new THREE.Color(0xfffde0)));
    const innerColor = asColor(inputs.innerColor, asColor(params.innerColor, new THREE.Color(0xffcc00)));
    const bodyColor = asColor(inputs.bodyColor, asColor(params.bodyColor, new THREE.Color(0xff5500)));
    const darkColor = asColor(inputs.darkColor, asColor(params.darkColor, new THREE.Color(0xa82000)));
    const outlineColor = asColor(inputs.outlineColor, asColor(params.outlineColor, new THREE.Color(0x1a0500)));

    mat.uniforms.coreColor.value.copy(coreColor);
    mat.uniforms.innerColor.value.copy(innerColor);
    mat.uniforms.bodyColor.value.copy(bodyColor);
    mat.uniforms.darkColor.value.copy(darkColor);
    mat.uniforms.outlineColor.value.copy(outlineColor);
    mat.uniforms.time.value = ctx.time ?? 0;

    return {
      material: {
        customMaterial: mat,
        color: bodyColor,
      },
    };
  },
};

/** 5. Miyazaki Cloud Material Node (Studio Ghibli Style) */
export const MATERIAL_MIYAZAKI_CLOUD_NODE: NodeDefinition = {
  type: "material/miyazaki_cloud",
  label: "Miyazaki Cloud (Ghibli)",
  category: "material",
  inputs: [
    { id: "seed", label: "Seed", type: "value" },
    { id: "cumulusHeight", label: "Cumulus Height", type: "value" },
    { id: "cloudWidth", label: "Cloud Width", type: "value" },
    { id: "baseFlatness", label: "Base Flatness", type: "value" },
    { id: "puffiness", label: "Puffiness", type: "value" },
    { id: "detail", label: "Micro-Puffs Detail", type: "value" },
    { id: "sunAngle", label: "Sun Angle (deg)", type: "value" },
    { id: "sunElevation", label: "Sun Elevation", type: "value" },
    { id: "shadowIntensity", label: "Shadow Intensity", type: "value" },
    { id: "bandSoftness", label: "Band Softness", type: "value" },
    { id: "edgeSharpness", label: "Edge Sharpness", type: "value" },
    { id: "outlineWidth", label: "Outline Width", type: "value" },
    { id: "highlightColor", label: "Highlight Color", type: "color" },
    { id: "bodyColor", label: "Body Color", type: "color" },
    { id: "shadowColor", label: "Shadow Color", type: "color" },
    { id: "deepShadowColor", label: "Deep Shadow Color", type: "color" },
    { id: "outlineColor", label: "Outline Color", type: "color" },
    { id: "enableHighlight", label: "Show Highlight Rim", type: "value" },
    { id: "enableDeepShadow", label: "Show Deep Shadow", type: "value" },
    { id: "enableOutline", label: "Show Outline", type: "value" },
    { id: "enablePuffs", label: "Show Puff Clusters", type: "value" },
  ],
  outputs: [{ id: "material", label: "Material", type: "material" }],
  defaultParams: {
    seed: 0.0,
    cumulusHeight: 1.0,
    cloudWidth: 1.0,
    baseFlatness: 0.75,
    puffiness: 1.2,
    detail: 1.0,
    sunAngle: 55.0,
    sunElevation: 0.75,
    shadowIntensity: 0.85,
    bandSoftness: 0.03,
    edgeSharpness: 0.012,
    outlineWidth: 0.012,
    highlightColor: new THREE.Color(0xfffeee),
    bodyColor: new THREE.Color(0xf6f0dd),
    shadowColor: new THREE.Color(0xb7c7c5),
    deepShadowColor: new THREE.Color(0x7a8da8),
    outlineColor: new THREE.Color(0x566575),
    enableHighlight: true,
    enableDeepShadow: true,
    enableOutline: false,
    enablePuffs: true,
  },
  paramFields: [
    { id: "seed", label: "Seed", kind: "number", step: 1.0 },
    { id: "cumulusHeight", label: "Cumulus Height", kind: "number", step: 0.05 },
    { id: "cloudWidth", label: "Cloud Width", kind: "number", step: 0.05 },
    { id: "baseFlatness", label: "Base Flatness", kind: "number", step: 0.05 },
    { id: "puffiness", label: "Puffiness", kind: "number", step: 0.05 },
    { id: "detail", label: "Micro-Puffs Detail", kind: "number", step: 0.05 },
    { id: "sunAngle", label: "Sun Angle (°)", kind: "number", step: 5.0 },
    { id: "sunElevation", label: "Sun Elevation", kind: "number", step: 0.05 },
    { id: "shadowIntensity", label: "Shadow Intensity", kind: "number", step: 0.05 },
    { id: "bandSoftness", label: "Band Softness", kind: "number", step: 0.005 },
    { id: "edgeSharpness", label: "Edge Sharpness", kind: "number", step: 0.002 },
    { id: "enableHighlight", label: "Show Sunlit Rim", kind: "boolean" },
    { id: "enableDeepShadow", label: "Show Deep Shadow", kind: "boolean" },
    { id: "enablePuffs", label: "Show Puff Detail", kind: "boolean" },
    { id: "enableOutline", label: "Show Outline", kind: "boolean" },
    { id: "outlineWidth", label: "Outline Width", kind: "number", step: 0.002 },
    { id: "highlightColor", label: "Highlight Color", kind: "color" },
    { id: "bodyColor", label: "Body Color", kind: "color" },
    { id: "shadowColor", label: "Shadow Color", kind: "color" },
    { id: "deepShadowColor", label: "Deep Shadow Color", kind: "color" },
    { id: "outlineColor", label: "Outline Color", kind: "color" },
  ],
  evaluate: (inputs, params, ctx) => {
    let mat = miyazakiCloudCache.get(ctx.nodeId);
    if (!mat) {
      mat = createMiyazakiCloudMaterial();
      (mat as any).__isSharedCustom = true;
      miyazakiCloudCache.set(ctx.nodeId, mat);
    }

    mat.uniforms.seed.value = numberInput(inputs.seed, params.seed, 0.0);
    mat.uniforms.cumulusHeight.value = Math.max(0.2, numberInput(inputs.cumulusHeight, params.cumulusHeight, 1.0));
    mat.uniforms.cloudWidth.value = Math.max(0.2, numberInput(inputs.cloudWidth, params.cloudWidth, 1.0));
    mat.uniforms.baseFlatness.value = Math.min(1.0, Math.max(0.0, numberInput(inputs.baseFlatness, params.baseFlatness, 0.75)));
    mat.uniforms.puffiness.value = Math.max(0.0, numberInput(inputs.puffiness, params.puffiness, 1.2));
    mat.uniforms.detail.value = Math.max(0.0, numberInput(inputs.detail, params.detail, 1.0));
    mat.uniforms.sunAngle.value = numberInput(inputs.sunAngle, params.sunAngle, 55.0);
    mat.uniforms.sunElevation.value = numberInput(inputs.sunElevation, params.sunElevation, 0.75);
    mat.uniforms.shadowIntensity.value = numberInput(inputs.shadowIntensity, params.shadowIntensity, 0.85);
    mat.uniforms.bandSoftness.value = Math.max(0.001, numberInput(inputs.bandSoftness, params.bandSoftness, 0.03));
    mat.uniforms.edgeSharpness.value = Math.max(0.001, numberInput(inputs.edgeSharpness, params.edgeSharpness, 0.012));
    mat.uniforms.outlineWidth.value = Math.max(0.0, numberInput(inputs.outlineWidth, params.outlineWidth, 0.012));

    mat.uniforms.enableHighlight.value = toBool(inputs.enableHighlight !== undefined ? inputs.enableHighlight : params.enableHighlight, true) ? 1.0 : 0.0;
    mat.uniforms.enableDeepShadow.value = toBool(inputs.enableDeepShadow !== undefined ? inputs.enableDeepShadow : params.enableDeepShadow, true) ? 1.0 : 0.0;
    mat.uniforms.enableOutline.value = toBool(inputs.enableOutline !== undefined ? inputs.enableOutline : params.enableOutline, false) ? 1.0 : 0.0;
    mat.uniforms.enablePuffs.value = toBool(inputs.enablePuffs !== undefined ? inputs.enablePuffs : params.enablePuffs, true) ? 1.0 : 0.0;

    const highlightColor = asColor(inputs.highlightColor, asColor(params.highlightColor, new THREE.Color(0xfffeee)));
    const bodyColor = asColor(inputs.bodyColor, asColor(params.bodyColor, new THREE.Color(0xf6f0dd)));
    const shadowColor = asColor(inputs.shadowColor, asColor(params.shadowColor, new THREE.Color(0xb7c7c5)));
    const deepShadowColor = asColor(inputs.deepShadowColor, asColor(params.deepShadowColor, new THREE.Color(0x7a8da8)));
    const outlineColor = asColor(inputs.outlineColor, asColor(params.outlineColor, new THREE.Color(0x566575)));

    mat.uniforms.highlightColor.value.copy(highlightColor);
    mat.uniforms.bodyColor.value.copy(bodyColor);
    mat.uniforms.shadowColor.value.copy(shadowColor);
    mat.uniforms.deepShadowColor.value.copy(deepShadowColor);
    mat.uniforms.outlineColor.value.copy(outlineColor);

    return {
      material: {
        customMaterial: mat,
        color: bodyColor,
      },
    };
  },
};


