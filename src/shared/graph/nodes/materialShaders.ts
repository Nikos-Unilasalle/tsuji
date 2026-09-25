import * as THREE from "three";
import { createNodeCache } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { asColor, numberInput } from "./object";
import { toBoolean } from "../sockets";
import {
  createHologramMaterial,
  createLiquidMetalMaterial,
  createCelShadeMaterial,
  createIridescentMaterial,
  createWireframePulseMaterial,
} from "../../three/shaders/creativeShaders";

const toBool = (val: unknown, fallback: boolean): boolean => {
  if (val === undefined || val === null) return fallback;
  return Boolean(val);
};

// Node caches to reuse ShaderMaterial per node instance and avoid shader recompilations
const hologramCache = createNodeCache<THREE.ShaderMaterial>((m) => m.dispose());
const liquidMetalCache = createNodeCache<THREE.ShaderMaterial>((m) => m.dispose());
const celShadeCache = createNodeCache<THREE.ShaderMaterial>((m) => m.dispose());
const iridescentCache = createNodeCache<THREE.ShaderMaterial>((m) => m.dispose());
const wireframePulseCache = createNodeCache<THREE.ShaderMaterial>((m) => m.dispose());

/** 1. Cyberpunk Hologram Material Node */
export const MATERIAL_HOLOGRAM_NODE: NodeDefinition = {
  type: "material/hologram",
  label: "Hologram (Cyberpunk)",
  category: "material",
  inputs: [
    { id: "color", label: "Neon Color", type: "color" },
    { id: "rimColor", label: "Rim Color", type: "color" },
    { id: "scanlinesFrequency", label: "Scanlines Freq", type: "value" },
    { id: "scanlinesSpeed", label: "Scanlines Speed", type: "value" },
    { id: "fresnelPower", label: "Fresnel Rim", type: "value" },
    { id: "glitchStrength", label: "Glitch Strength", type: "value" },
    { id: "glitchFrequency", label: "Glitch Freq", type: "value" },
    { id: "flickerIntensity", label: "Flicker Intensity", type: "value" },
    { id: "stripeSharpness", label: "Stripe Sharpness", type: "value" },
    { id: "noiseIntensity", label: "CRT Noise", type: "value" },
    { id: "opacity", label: "Opacity", type: "value" },
    { id: "enableScanlines", label: "Enable Scanlines", type: "value" },
    { id: "enableGlitch", label: "Enable Glitch", type: "value" },
    { id: "enableNoise", label: "Enable Noise", type: "value" },
    { id: "enableFlicker", label: "Enable Flicker", type: "value" },
  ],
  outputs: [{ id: "material", label: "Material", type: "material" }],
  defaultParams: {
    color: new THREE.Color(0x00f3ff),
    rimColor: new THREE.Color(0xff00d4),
    scanlinesFrequency: 20.0,
    scanlinesSpeed: 2.0,
    fresnelPower: 2.5,
    glitchStrength: 0.05,
    glitchFrequency: 12.0,
    flickerIntensity: 0.2,
    stripeSharpness: 0.5,
    noiseIntensity: 0.15,
    opacity: 0.85,
    enableScanlines: true,
    enableGlitch: true,
    enableNoise: true,
    enableFlicker: true,
  },
  paramFields: [
    { id: "color", label: "Neon Color", kind: "color" },
    { id: "rimColor", label: "Rim Color (Secondary)", kind: "color" },
    { id: "scanlinesFrequency", label: "Scanlines Freq", kind: "number", step: 1.0 },
    { id: "scanlinesSpeed", label: "Scanlines Speed", kind: "number", step: 0.2 },
    { id: "fresnelPower", label: "Fresnel Rim", kind: "number", step: 0.2 },
    { id: "glitchStrength", label: "Glitch Strength", kind: "number", step: 0.01 },
    { id: "glitchFrequency", label: "Glitch Freq", kind: "number", step: 1.0 },
    { id: "flickerIntensity", label: "Flicker Intensity", kind: "number", step: 0.05 },
    { id: "stripeSharpness", label: "Stripe Sharpness", kind: "number", step: 0.1 },
    { id: "noiseIntensity", label: "CRT Noise", kind: "number", step: 0.05 },
    { id: "opacity", label: "Opacity", kind: "number", step: 0.05 },
    { id: "enableScanlines", label: "Enable Scanlines", kind: "boolean" },
    { id: "enableGlitch", label: "Enable Glitch", kind: "boolean" },
    { id: "enableNoise", label: "Enable Noise", kind: "boolean" },
    { id: "enableFlicker", label: "Enable Flicker", kind: "boolean" },
  ],
  evaluate: (inputs, params, ctx) => {
    let mat = hologramCache.get(ctx.nodeId);
    if (!mat) {
      mat = createHologramMaterial();
      (mat as any).__isSharedCustom = true;
      hologramCache.set(ctx.nodeId, mat);
    }

    const color = asColor(inputs.color, asColor(params.color, new THREE.Color(0x00f3ff)));
    const rimColor = asColor(inputs.rimColor, asColor(params.rimColor, new THREE.Color(0xff00d4)));
    mat.uniforms.color.value.copy(color);
    mat.uniforms.rimColor.value.copy(rimColor);
    mat.uniforms.scanlinesFrequency.value = numberInput(inputs.scanlinesFrequency, params.scanlinesFrequency, 20.0);
    mat.uniforms.scanlinesSpeed.value = numberInput(inputs.scanlinesSpeed, params.scanlinesSpeed, 2.0);
    mat.uniforms.fresnelPower.value = numberInput(inputs.fresnelPower, params.fresnelPower, 2.5);
    mat.uniforms.glitchStrength.value = numberInput(inputs.glitchStrength, params.glitchStrength, 0.05);
    mat.uniforms.glitchFrequency.value = numberInput(inputs.glitchFrequency, params.glitchFrequency, 12.0);
    mat.uniforms.flickerIntensity.value = numberInput(inputs.flickerIntensity, params.flickerIntensity, 0.2);
    mat.uniforms.stripeSharpness.value = numberInput(inputs.stripeSharpness, params.stripeSharpness, 0.5);
    mat.uniforms.noiseIntensity.value = numberInput(inputs.noiseIntensity, params.noiseIntensity, 0.15);
    mat.uniforms.opacity.value = Math.max(0, Math.min(1, numberInput(inputs.opacity, params.opacity, 0.85)));
    mat.uniforms.enableScanlines.value = toBool(inputs.enableScanlines !== undefined ? inputs.enableScanlines : params.enableScanlines, true) ? 1.0 : 0.0;
    mat.uniforms.enableGlitch.value = toBool(inputs.enableGlitch !== undefined ? inputs.enableGlitch : params.enableGlitch, true) ? 1.0 : 0.0;
    mat.uniforms.enableNoise.value = toBool(inputs.enableNoise !== undefined ? inputs.enableNoise : params.enableNoise, true) ? 1.0 : 0.0;
    mat.uniforms.enableFlicker.value = toBool(inputs.enableFlicker !== undefined ? inputs.enableFlicker : params.enableFlicker, true) ? 1.0 : 0.0;
    mat.uniforms.time.value = ctx.time ?? 0;

    return {
      material: {
        customMaterial: mat,
        color,
        opacity: mat.uniforms.opacity.value,
      },
    };
  },
};

/** 2. Liquid Metal & Domain Warping Material Node */
export const MATERIAL_LIQUID_METAL_NODE: NodeDefinition = {
  type: "material/liquid-metal",
  label: "Liquid Metal (Warp)",
  category: "material",
  inputs: [
    { id: "baseColor", label: "Base Color", type: "color" },
    { id: "reflectionColor", label: "Reflection Color", type: "color" },
    { id: "specularColor", label: "Specular Color", type: "color" },
    { id: "warpScale", label: "Warp Scale", type: "value" },
    { id: "warpIntensity", label: "Warp Intensity", type: "value" },
    { id: "speed", label: "Fluid Speed", type: "value" },
    { id: "viscosity", label: "Viscosity", type: "value" },
    { id: "roughness", label: "Roughness", type: "value" },
    { id: "metalness", label: "Metalness", type: "value" },
    { id: "iridescence", label: "Perlescent Sheen", type: "value" },
    { id: "fresnelPower", label: "Fresnel Rim", type: "value" },
    { id: "enableDisplacement", label: "Enable Displacement", type: "value" },
  ],
  outputs: [{ id: "material", label: "Material", type: "material" }],
  defaultParams: {
    baseColor: new THREE.Color(0xd0d8e8),
    reflectionColor: new THREE.Color(0xffffff),
    specularColor: new THREE.Color(0xffffff),
    warpScale: 2.5,
    warpIntensity: 1.0,
    speed: 0.8,
    viscosity: 1.2,
    roughness: 0.15,
    metalness: 0.8,
    iridescence: 0.3,
    fresnelPower: 3.0,
    enableDisplacement: true,
  },
  paramFields: [
    { id: "baseColor", label: "Base Color", kind: "color" },
    { id: "reflectionColor", label: "Reflection Color", kind: "color" },
    { id: "specularColor", label: "Specular Color", kind: "color" },
    { id: "warpScale", label: "Warp Scale", kind: "number", step: 0.2 },
    { id: "warpIntensity", label: "Warp Intensity", kind: "number", step: 0.1 },
    { id: "speed", label: "Fluid Speed", kind: "number", step: 0.1 },
    { id: "viscosity", label: "Viscosity", kind: "number", step: 0.1 },
    { id: "roughness", label: "Roughness", kind: "number", step: 0.02 },
    { id: "metalness", label: "Metalness", kind: "number", step: 0.05 },
    { id: "iridescence", label: "Perlescent Sheen", kind: "number", step: 0.05 },
    { id: "fresnelPower", label: "Fresnel Rim", kind: "number", step: 0.2 },
    { id: "enableDisplacement", label: "Enable Displacement", kind: "boolean" },
  ],
  evaluate: (inputs, params, ctx) => {
    let mat = liquidMetalCache.get(ctx.nodeId);
    if (!mat) {
      mat = createLiquidMetalMaterial();
      (mat as any).__isSharedCustom = true;
      liquidMetalCache.set(ctx.nodeId, mat);
    }

    const baseColor = asColor(inputs.baseColor, asColor(params.baseColor, new THREE.Color(0xd0d8e8)));
    const reflectionColor = asColor(inputs.reflectionColor, asColor(params.reflectionColor, new THREE.Color(0xffffff)));
    const specularColor = asColor(inputs.specularColor, asColor(params.specularColor, new THREE.Color(0xffffff)));

    mat.uniforms.baseColor.value.copy(baseColor);
    mat.uniforms.reflectionColor.value.copy(reflectionColor);
    mat.uniforms.specularColor.value.copy(specularColor);
    mat.uniforms.warpScale.value = numberInput(inputs.warpScale, params.warpScale, 2.5);
    mat.uniforms.warpIntensity.value = numberInput(inputs.warpIntensity, params.warpIntensity, 1.0);
    mat.uniforms.speed.value = numberInput(inputs.speed, params.speed, 0.8);
    mat.uniforms.viscosity.value = numberInput(inputs.viscosity, params.viscosity, 1.2);
    mat.uniforms.roughness.value = numberInput(inputs.roughness, params.roughness, 0.15);
    mat.uniforms.metalness.value = numberInput(inputs.metalness, params.metalness, 0.8);
    mat.uniforms.iridescence.value = numberInput(inputs.iridescence, params.iridescence, 0.3);
    mat.uniforms.fresnelPower.value = numberInput(inputs.fresnelPower, params.fresnelPower, 3.0);
    mat.uniforms.enableDisplacement.value = toBool(inputs.enableDisplacement !== undefined ? inputs.enableDisplacement : params.enableDisplacement, true) ? 1.0 : 0.0;
    mat.uniforms.time.value = ctx.time ?? 0;

    return {
      material: {
        customMaterial: mat,
        color: baseColor,
        roughness: mat.uniforms.roughness.value,
      },
    };
  },
};

/** 3. Cel-Shading & Halftone Comic Material Node */
export const MATERIAL_CEL_SHADE_NODE: NodeDefinition = {
  type: "material/cel-shade",
  label: "Cel-Shading (Toon / BD)",
  category: "material",
  inputs: [
    { id: "color", label: "Color", type: "color" },
    { id: "shadowColor", label: "Shadow Color", type: "color" },
    { id: "halftoneDotColor", label: "Halftone Dot Color", type: "color" },
    { id: "bands", label: "Bands (Levels)", type: "value" },
    { id: "bandSoftness", label: "Band Softness", type: "value" },
    { id: "halftone", label: "Halftone Dots", type: "value" },
    { id: "halftoneScale", label: "Halftone Scale", type: "value" },
    { id: "rimColor", label: "Rim Color", type: "color" },
    { id: "rimPower", label: "Rim Power", type: "value" },
    { id: "specularHardness", label: "Specular Hardness", type: "value" },
    { id: "specularStrength", label: "Specular Strength", type: "value" },
    { id: "enableHalftone", label: "Enable Halftone", type: "value" },
    { id: "enableRim", label: "Enable Rim Light", type: "value" },
    { id: "enableSpecular", label: "Enable Specular", type: "value" },
  ],
  outputs: [{ id: "material", label: "Material", type: "material" }],
  defaultParams: {
    color: new THREE.Color(0xff4444),
    shadowColor: new THREE.Color(0x1a0525),
    halftoneDotColor: new THREE.Color(0x1a0525),
    bands: 3.0,
    bandSoftness: 0.02,
    halftone: 1,
    halftoneScale: 8.0,
    rimColor: new THREE.Color(0xffffff),
    rimPower: 3.0,
    specularHardness: 32.0,
    specularStrength: 1.0,
    enableHalftone: true,
    enableRim: true,
    enableSpecular: true,
  },
  paramFields: [
    { id: "color", label: "Color", kind: "color" },
    { id: "shadowColor", label: "Shadow Color", kind: "color" },
    { id: "halftoneDotColor", label: "Halftone Dot Color", kind: "color" },
    { id: "bands", label: "Bands (Levels)", kind: "number", step: 1.0 },
    { id: "bandSoftness", label: "Band Softness", kind: "number", step: 0.01 },
    { id: "enableHalftone", label: "Enable Halftone", kind: "boolean" },
    { id: "halftoneScale", label: "Halftone Scale", kind: "number", step: 1.0 },
    { id: "enableRim", label: "Enable Rim", kind: "boolean" },
    { id: "rimColor", label: "Rim Color", kind: "color" },
    { id: "rimPower", label: "Rim Power", kind: "number", step: 0.5 },
    { id: "enableSpecular", label: "Enable Specular", kind: "boolean" },
    { id: "specularHardness", label: "Specular Hardness", kind: "number", step: 4.0 },
    { id: "specularStrength", label: "Specular Strength", kind: "number", step: 0.1 },
  ],
  evaluate: (inputs, params, ctx) => {
    let mat = celShadeCache.get(ctx.nodeId);
    if (!mat) {
      mat = createCelShadeMaterial();
      (mat as any).__isSharedCustom = true;
      celShadeCache.set(ctx.nodeId, mat);
    }

    const color = asColor(inputs.color, asColor(params.color, new THREE.Color(0xff4444)));
    const shadowColor = asColor(inputs.shadowColor, asColor(params.shadowColor, new THREE.Color(0x1a0525)));
    const halftoneDotColor = asColor(inputs.halftoneDotColor, asColor(params.halftoneDotColor, new THREE.Color(0x1a0525)));
    const rimColor = asColor(inputs.rimColor, asColor(params.rimColor, new THREE.Color(0xffffff)));

    mat.uniforms.color.value.copy(color);
    mat.uniforms.shadowColor.value.copy(shadowColor);
    mat.uniforms.halftoneDotColor.value.copy(halftoneDotColor);
    mat.uniforms.rimColor.value.copy(rimColor);
    mat.uniforms.bands.value = numberInput(inputs.bands, params.bands, 3.0);
    mat.uniforms.bandSoftness.value = numberInput(inputs.bandSoftness, params.bandSoftness, 0.02);
    mat.uniforms.halftone.value = toBoolean(inputs.halftone !== undefined ? inputs.halftone : params.halftone) ? 1.0 : 0.0;
    mat.uniforms.halftoneScale.value = numberInput(inputs.halftoneScale, params.halftoneScale, 8.0);
    mat.uniforms.rimPower.value = numberInput(inputs.rimPower, params.rimPower, 3.0);
    mat.uniforms.specularHardness.value = numberInput(inputs.specularHardness, params.specularHardness, 32.0);
    mat.uniforms.specularStrength.value = numberInput(inputs.specularStrength, params.specularStrength, 1.0);
    mat.uniforms.enableHalftone.value = toBool(inputs.enableHalftone !== undefined ? inputs.enableHalftone : params.enableHalftone, true) ? 1.0 : 0.0;
    mat.uniforms.enableRim.value = toBool(inputs.enableRim !== undefined ? inputs.enableRim : params.enableRim, true) ? 1.0 : 0.0;
    mat.uniforms.enableSpecular.value = toBool(inputs.enableSpecular !== undefined ? inputs.enableSpecular : params.enableSpecular, true) ? 1.0 : 0.0;

    return {
      material: {
        customMaterial: mat,
        color,
      },
    };
  },
};

/** 4. Iridescent & Thin-Film Interference Material Node */
export const MATERIAL_IRIDESCENT_NODE: NodeDefinition = {
  type: "material/iridescent",
  label: "Iridescent (Thin Film)",
  category: "material",
  inputs: [
    { id: "baseColor", label: "Base Color", type: "color" },
    { id: "specularColor", label: "Specular Color", type: "color" },
    { id: "filmThickness", label: "Film Thickness (nm)", type: "value" },
    { id: "refractiveIndex", label: "Refractive Index", type: "value" },
    { id: "boost", label: "Rainbow Boost", type: "value" },
    { id: "roughness", label: "Roughness", type: "value" },
    { id: "rippleSpeed", label: "Ripple Speed", type: "value" },
    { id: "rippleFrequency", label: "Ripple Frequency", type: "value" },
    { id: "rainbowMix", label: "Rainbow Mix", type: "value" },
  ],
  outputs: [{ id: "material", label: "Material", type: "material" }],
  defaultParams: {
    baseColor: new THREE.Color(0x222226),
    specularColor: new THREE.Color(0xffffff),
    filmThickness: 450.0,
    refractiveIndex: 1.45,
    boost: 1.5,
    roughness: 0.2,
    rippleSpeed: 0.5,
    rippleFrequency: 6.28,
    rainbowMix: 0.75,
  },
  paramFields: [
    { id: "baseColor", label: "Base Color", kind: "color" },
    { id: "specularColor", label: "Specular Color", kind: "color" },
    { id: "filmThickness", label: "Film Thickness (nm)", kind: "number", step: 25.0 },
    { id: "refractiveIndex", label: "Refractive Index", kind: "number", step: 0.05 },
    { id: "boost", label: "Rainbow Boost", kind: "number", step: 0.1 },
    { id: "roughness", label: "Roughness", kind: "number", step: 0.02 },
    { id: "rippleSpeed", label: "Ripple Speed", kind: "number", step: 0.1 },
    { id: "rippleFrequency", label: "Ripple Frequency", kind: "number", step: 0.5 },
    { id: "rainbowMix", label: "Rainbow Mix", kind: "number", step: 0.05 },
  ],
  evaluate: (inputs, params, ctx) => {
    let mat = iridescentCache.get(ctx.nodeId);
    if (!mat) {
      mat = createIridescentMaterial();
      (mat as any).__isSharedCustom = true;
      iridescentCache.set(ctx.nodeId, mat);
    }

    const baseColor = asColor(inputs.baseColor, asColor(params.baseColor, new THREE.Color(0x222226)));
    const specularColor = asColor(inputs.specularColor, asColor(params.specularColor, new THREE.Color(0xffffff)));

    mat.uniforms.baseColor.value.copy(baseColor);
    mat.uniforms.specularColor.value.copy(specularColor);
    mat.uniforms.filmThickness.value = numberInput(inputs.filmThickness, params.filmThickness, 450.0);
    mat.uniforms.refractiveIndex.value = numberInput(inputs.refractiveIndex, params.refractiveIndex, 1.45);
    mat.uniforms.boost.value = numberInput(inputs.boost, params.boost, 1.5);
    mat.uniforms.roughness.value = numberInput(inputs.roughness, params.roughness, 0.2);
    mat.uniforms.rippleSpeed.value = numberInput(inputs.rippleSpeed, params.rippleSpeed, 0.5);
    mat.uniforms.rippleFrequency.value = numberInput(inputs.rippleFrequency, params.rippleFrequency, 6.28);
    mat.uniforms.rainbowMix.value = numberInput(inputs.rainbowMix, params.rainbowMix, 0.75);
    mat.uniforms.time.value = ctx.time ?? 0;

    return {
      material: {
        customMaterial: mat,
        color: baseColor,
        roughness: mat.uniforms.roughness.value,
      },
    };
  },
};

/** 5. Wireframe Pulse & Glow Wave Material Node */
export const MATERIAL_WIREFRAME_PULSE_NODE: NodeDefinition = {
  type: "material/wireframe-pulse",
  label: "Wireframe Pulse",
  category: "material",
  inputs: [
    { id: "fillColor", label: "Fill Color", type: "color" },
    { id: "fillOpacity", label: "Fill Opacity", type: "value" },
    { id: "edgeColor", label: "Edge Color", type: "color" },
    { id: "edgeWidth", label: "Edge Width", type: "value" },
    { id: "pulseColor", label: "Pulse Color", type: "color" },
    { id: "pulseSpeed", label: "Pulse Speed", type: "value" },
    { id: "pulseLength", label: "Pulse Length", type: "value" },
    { id: "pulseFrequency", label: "Pulse Frequency", type: "value" },
    { id: "glowIntensity", label: "Glow Intensity", type: "value" },
    { id: "enableFill", label: "Enable Fill", type: "value" },
    { id: "enablePulse", label: "Enable Pulse", type: "value" },
  ],
  outputs: [{ id: "material", label: "Material", type: "material" }],
  defaultParams: {
    fillColor: new THREE.Color(0x06060c),
    fillOpacity: 0.3,
    edgeColor: new THREE.Color(0x00f3ff),
    edgeWidth: 1.5,
    pulseColor: new THREE.Color(0xff007f),
    pulseSpeed: 2.0,
    pulseLength: 1.2,
    pulseFrequency: 3.0,
    glowIntensity: 1.5,
    enableFill: true,
    enablePulse: true,
  },
  paramFields: [
    { id: "enableFill", label: "Enable Fill", kind: "boolean" },
    { id: "fillColor", label: "Fill Color", kind: "color" },
    { id: "fillOpacity", label: "Fill Opacity", kind: "number", step: 0.05 },
    { id: "edgeColor", label: "Edge Color", kind: "color" },
    { id: "edgeWidth", label: "Edge Width", kind: "number", step: 0.2 },
    { id: "enablePulse", label: "Enable Pulse", kind: "boolean" },
    { id: "pulseColor", label: "Pulse Color", kind: "color" },
    { id: "pulseSpeed", label: "Pulse Speed", kind: "number", step: 0.2 },
    { id: "pulseLength", label: "Pulse Length", kind: "number", step: 0.1 },
    { id: "pulseFrequency", label: "Pulse Frequency", kind: "number", step: 0.5 },
    { id: "glowIntensity", label: "Glow Intensity", kind: "number", step: 0.1 },
  ],
  evaluate: (inputs, params, ctx) => {
    let mat = wireframePulseCache.get(ctx.nodeId);
    if (!mat) {
      mat = createWireframePulseMaterial();
      (mat as any).__isSharedCustom = true;
      wireframePulseCache.set(ctx.nodeId, mat);
    }

    const fillColor = asColor(inputs.fillColor, asColor(params.fillColor, new THREE.Color(0x06060c)));
    const edgeColor = asColor(inputs.edgeColor, asColor(params.edgeColor, new THREE.Color(0x00f3ff)));
    const pulseColor = asColor(inputs.pulseColor, asColor(params.pulseColor, new THREE.Color(0xff007f)));

    mat.uniforms.fillColor.value.copy(fillColor);
    mat.uniforms.fillOpacity.value = numberInput(inputs.fillOpacity, params.fillOpacity, 0.3);
    mat.uniforms.edgeColor.value.copy(edgeColor);
    mat.uniforms.edgeWidth.value = numberInput(inputs.edgeWidth, params.edgeWidth, 1.5);
    mat.uniforms.pulseColor.value.copy(pulseColor);
    mat.uniforms.pulseSpeed.value = numberInput(inputs.pulseSpeed, params.pulseSpeed, 2.0);
    mat.uniforms.pulseLength.value = numberInput(inputs.pulseLength, params.pulseLength, 1.2);
    mat.uniforms.pulseFrequency.value = numberInput(inputs.pulseFrequency, params.pulseFrequency, 3.0);
    mat.uniforms.glowIntensity.value = numberInput(inputs.glowIntensity, params.glowIntensity, 1.5);
    mat.uniforms.enableFill.value = toBool(inputs.enableFill !== undefined ? inputs.enableFill : params.enableFill, true) ? 1.0 : 0.0;
    mat.uniforms.enablePulse.value = toBool(inputs.enablePulse !== undefined ? inputs.enablePulse : params.enablePulse, true) ? 1.0 : 0.0;
    mat.uniforms.time.value = ctx.time ?? 0;

    return {
      material: {
        customMaterial: mat,
        color: edgeColor,
      },
    };
  },
};
