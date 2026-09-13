import * as THREE from "three";
import { NodeDefinition } from "../types";
import { toBoolean } from "../sockets";
import { asColor, numberInput } from "./object";

export interface PostProcessConfig {
  type: string;
  nodeId: string;
  params: Record<string, unknown>;
}

/**
 * The effect chain is built by each node appending itself to whatever arrived
 * on its `effect` input, so the wire order *is* the pass order. Exported for
 * postprocessingFilm.ts, which holds the same kind of node in another file.
 */
export function accumulateEffect(inputs: Record<string, unknown>, config: PostProcessConfig): PostProcessConfig[] {
  const upstream = Array.isArray(inputs.effect) ? (inputs.effect as PostProcessConfig[]) : [];
  return [...upstream, config];
}

/** Bloom Post-Processing Node */
export const POSTPROCESS_BLOOM_NODE: NodeDefinition = {
  type: "postprocess/bloom",
  label: "Bloom",
  category: "postprocess",
  inputs: [
    { id: "effect", label: "Post-Process", type: "postprocess" },
    { id: "strength", label: "Strength", type: "value" },
    { id: "radius", label: "Radius", type: "value" },
    { id: "threshold", label: "Threshold", type: "value" },
  ],
  outputs: [{ id: "effect", label: "Post-Process", type: "postprocess" }],
  defaultParams: { strength: 1.5, radius: 0.4, threshold: 0.85 },
  paramFields: [
    { id: "strength", label: "Strength", kind: "number", step: 0.1 },
    { id: "radius", label: "Radius", kind: "number", step: 0.05 },
    { id: "threshold", label: "Threshold", kind: "number", step: 0.05 },
  ],
  evaluate: (inputs, params, ctx) => {
    const strength = Math.max(0, numberInput(inputs.strength, params.strength, 1.5));
    const radius = Math.max(0, numberInput(inputs.radius, params.radius, 0.4));
    const threshold = Math.max(0, Math.min(1, numberInput(inputs.threshold, params.threshold, 0.85)));

    const effectList = accumulateEffect(inputs, {
      type: "bloom",
      nodeId: ctx.nodeId,
      params: { strength, radius, threshold },
    });

    return { effect: effectList };
  },
};

/** Vignette Post-Processing Node */
export const POSTPROCESS_VIGNETTE_NODE: NodeDefinition = {
  type: "postprocess/vignette",
  label: "Vignette",
  category: "postprocess",
  inputs: [
    { id: "effect", label: "Post-Process", type: "postprocess" },
    { id: "offset", label: "Offset", type: "value" },
    { id: "darkness", label: "Darkness", type: "value" },
  ],
  outputs: [{ id: "effect", label: "Post-Process", type: "postprocess" }],
  defaultParams: { offset: 1.0, darkness: 1.5 },
  paramFields: [
    { id: "offset", label: "Offset", kind: "number", step: 0.1 },
    { id: "darkness", label: "Darkness", kind: "number", step: 0.1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const offset = numberInput(inputs.offset, params.offset, 1.0);
    const darkness = numberInput(inputs.darkness, params.darkness, 1.5);

    const effectList = accumulateEffect(inputs, {
      type: "vignette",
      nodeId: ctx.nodeId,
      params: { offset, darkness },
    });

    return { effect: effectList };
  },
};

/** RGB Shift / Chromatic Aberration Post-Processing Node */
export const POSTPROCESS_RGB_SHIFT_NODE: NodeDefinition = {
  type: "postprocess/rgb-shift",
  label: "RGB Shift",
  category: "postprocess",
  inputs: [
    { id: "effect", label: "Post-Process", type: "postprocess" },
    { id: "amount", label: "Amount", type: "value" },
    { id: "angle", label: "Angle (°)", type: "value" },
  ],
  outputs: [{ id: "effect", label: "Post-Process", type: "postprocess" }],
  defaultParams: { amount: 0.005, angle: 0 },
  paramFields: [
    { id: "amount", label: "Amount", kind: "number", step: 0.001 },
    { id: "angle", label: "Angle (°)", kind: "number", step: 5 },
  ],
  evaluate: (inputs, params, ctx) => {
    const amount = numberInput(inputs.amount, params.amount, 0.005);
    const angle = numberInput(inputs.angle, params.angle, 0);

    const effectList = accumulateEffect(inputs, {
      type: "rgb-shift",
      nodeId: ctx.nodeId,
      params: { amount, angle: (angle * Math.PI) / 180 },
    });

    return { effect: effectList };
  },
};

/** Depth of Field Post-Processing Node */
export const POSTPROCESS_DOF_NODE: NodeDefinition = {
  type: "postprocess/dof",
  label: "Depth of Field",
  category: "postprocess",
  inputs: [
    { id: "effect", label: "Post-Process", type: "postprocess" },
    { id: "focus", label: "Focus Distance", type: "value" },
    { id: "aperture", label: "Aperture", type: "value" },
    { id: "maxblur", label: "Max Blur", type: "value" },
  ],
  outputs: [{ id: "effect", label: "Post-Process", type: "postprocess" }],
  defaultParams: { focus: 10.0, aperture: 0.025, maxblur: 0.01 },
  paramFields: [
    { id: "focus", label: "Focus Distance", kind: "number", step: 0.5 },
    { id: "aperture", label: "Aperture", kind: "number", step: 0.005 },
    { id: "maxblur", label: "Max Blur", kind: "number", step: 0.005 },
  ],
  evaluate: (inputs, params, ctx) => {
    const focus = Math.max(0.1, numberInput(inputs.focus, params.focus, 10.0));
    const aperture = Math.max(0, numberInput(inputs.aperture, params.aperture, 0.025));
    const maxblur = Math.max(0, numberInput(inputs.maxblur, params.maxblur, 0.01));

    const effectList = accumulateEffect(inputs, {
      type: "dof",
      nodeId: ctx.nodeId,
      params: { focus, aperture, maxblur },
    });

    return { effect: effectList };
  },
};

/**
 * Outline / Edge Detection Post-Processing Node.
 *
 * Without Geometry wired, the outline falls back to the *entire* Render
 * output (unchanged from before Geometry existed) — but that default is
 * only usable for a single isolated object. OutlinePass draws an edge at
 * the boundary of its selection, not around every individual mesh inside
 * it: two touching or overlapping "selected" objects (a character standing
 * on a floor, the ordinary case) merge into one region with no edge between
 * them, so the outline only ever appears at the outer silhouette of the
 * *whole scene* — often off-screen, or reduced to a thin line where the
 * combined shape happens to meet the background. That looked like the
 * effect doing nothing. Wiring Geometry in with just the object(s) meant to
 * be outlined restores the actual boundary they have with everything else.
 */
export const POSTPROCESS_OUTLINE_NODE: NodeDefinition = {
  type: "postprocess/outline",
  label: "Outline",
  category: "postprocess",
  inputs: [
    { id: "effect", label: "Post-Process", type: "postprocess" },
    { id: "geometry", label: "Geometry (target, defaults to whole render)", type: "geometry" },
    { id: "edgeColor", label: "Edge Color", type: "color" },
    { id: "edgeStrength", label: "Strength", type: "value" },
    { id: "edgeThickness", label: "Thickness", type: "value" },
  ],
  outputs: [{ id: "effect", label: "Post-Process", type: "postprocess" }],
  defaultParams: {
    edgeColor: new THREE.Color(0xffffff),
    edgeStrength: 3.0,
    edgeThickness: 1.0,
  },
  paramFields: [
    { id: "edgeColor", label: "Edge Color", kind: "color" },
    { id: "edgeStrength", label: "Strength", kind: "number", step: 0.5 },
    { id: "edgeThickness", label: "Thickness", kind: "number", step: 0.5 },
  ],
  evaluate: (inputs, params, ctx) => {
    const edgeColor = asColor(inputs.edgeColor, asColor(params.edgeColor, new THREE.Color(0xffffff)));
    const edgeStrength = numberInput(inputs.edgeStrength, params.edgeStrength, 3.0);
    const edgeThickness = numberInput(inputs.edgeThickness, params.edgeThickness, 1.0);
    // Not serialized — this config lives only for the current frame's
    // render, the same way Bloom/Vignette/etc. already carry live THREE
    // objects (edgeColor above) through this same params bag.
    const targetObject = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;

    const effectList = accumulateEffect(inputs, {
      type: "outline",
      nodeId: ctx.nodeId,
      params: { edgeColor, edgeStrength, edgeThickness, targetObject },
    });

    return { effect: effectList };
  },
};

/** Film Grain & Scanlines Post-Processing Node */
export const POSTPROCESS_FILM_GRAIN_NODE: NodeDefinition = {
  type: "postprocess/film-grain",
  label: "Film Grain",
  category: "postprocess",
  inputs: [
    { id: "effect", label: "Post-Process", type: "postprocess" },
    { id: "noiseIntensity", label: "Noise Intensity", type: "value" },
    { id: "scanlinesIntensity", label: "Scanlines Intensity", type: "value" },
    { id: "scanlinesCount", label: "Scanlines Count", type: "value" },
    { id: "grayscale", label: "Grayscale", type: "value" },
  ],
  outputs: [{ id: "effect", label: "Post-Process", type: "postprocess" }],
  defaultParams: {
    noiseIntensity: 0.35,
    scanlinesIntensity: 0.05,
    scanlinesCount: 2048,
    grayscale: 0,
  },
  paramFields: [
    { id: "noiseIntensity", label: "Noise Intensity", kind: "number", step: 0.05 },
    { id: "scanlinesIntensity", label: "Scanlines Intensity", kind: "number", step: 0.05 },
    { id: "scanlinesCount", label: "Scanlines Count", kind: "number", step: 128 },
    { id: "grayscale", label: "Grayscale", kind: "boolean" },
  ],
  evaluate: (inputs, params, ctx) => {
    const noiseIntensity = numberInput(inputs.noiseIntensity, params.noiseIntensity, 0.35);
    const scanlinesIntensity = numberInput(inputs.scanlinesIntensity, params.scanlinesIntensity, 0.05);
    const scanlinesCount = numberInput(inputs.scanlinesCount, params.scanlinesCount, 2048);
    const grayscale = toBoolean(inputs.grayscale !== undefined ? inputs.grayscale : params.grayscale ?? 0);

    const effectList = accumulateEffect(inputs, {
      type: "film-grain",
      nodeId: ctx.nodeId,
      params: { noiseIntensity, scanlinesIntensity, scanlinesCount, grayscale },
    });

    return { effect: effectList };
  },
};

/** Digital Glitch Post-Processing Node */
export const POSTPROCESS_GLITCH_NODE: NodeDefinition = {
  type: "postprocess/glitch",
  label: "Digital Glitch",
  category: "postprocess",
  inputs: [
    { id: "effect", label: "Post-Process", type: "postprocess" },
    { id: "active", label: "Active", type: "value" },
    { id: "wild", label: "Wild Mode", type: "value" },
  ],
  outputs: [{ id: "effect", label: "Post-Process", type: "postprocess" }],
  defaultParams: { active: 1, wild: 0 },
  paramFields: [
    { id: "active", label: "Active", kind: "boolean" },
    { id: "wild", label: "Wild Mode (Extreme)", kind: "boolean" },
  ],
  evaluate: (inputs, params, ctx) => {
    const active = toBoolean(inputs.active !== undefined ? inputs.active : params.active ?? 1);
    const wild = toBoolean(inputs.wild !== undefined ? inputs.wild : params.wild ?? 0);

    const effectList = accumulateEffect(inputs, {
      type: "glitch",
      nodeId: ctx.nodeId,
      params: { active, wild },
    });

    return { effect: effectList };
  },
};

/** Pixelate / Retro Mosaic Post-Processing Node */
export const POSTPROCESS_PIXELATE_NODE: NodeDefinition = {
  type: "postprocess/pixelate",
  label: "Pixelate / Mosaic",
  category: "postprocess",
  inputs: [
    { id: "effect", label: "Post-Process", type: "postprocess" },
    { id: "pixelSize", label: "Pixel Size", type: "value" },
  ],
  outputs: [{ id: "effect", label: "Post-Process", type: "postprocess" }],
  defaultParams: { pixelSize: 6.0 },
  paramFields: [{ id: "pixelSize", label: "Pixel Size (px)", kind: "number", step: 1 }],
  evaluate: (inputs, params, ctx) => {
    const pixelSize = Math.max(1, numberInput(inputs.pixelSize, params.pixelSize, 6.0));

    const effectList = accumulateEffect(inputs, {
      type: "pixelate",
      nodeId: ctx.nodeId,
      params: { pixelSize },
    });

    return { effect: effectList };
  },
};

/** Kaleidoscope Post-Processing Node */
export const POSTPROCESS_KALEIDOSCOPE_NODE: NodeDefinition = {
  type: "postprocess/kaleidoscope",
  label: "Kaleidoscope",
  category: "postprocess",
  inputs: [
    { id: "effect", label: "Post-Process", type: "postprocess" },
    { id: "sides", label: "Sides / Mirrors", type: "value" },
    { id: "angle", label: "Angle (°)", type: "value" },
  ],
  outputs: [{ id: "effect", label: "Post-Process", type: "postprocess" }],
  defaultParams: { sides: 6, angle: 0 },
  paramFields: [
    { id: "sides", label: "Sides / Mirrors", kind: "number", step: 1 },
    { id: "angle", label: "Angle (°)", kind: "number", step: 5 },
  ],
  evaluate: (inputs, params, ctx) => {
    const sides = Math.max(1, numberInput(inputs.sides, params.sides, 6));
    const angle = numberInput(inputs.angle, params.angle, 0);

    const effectList = accumulateEffect(inputs, {
      type: "kaleidoscope",
      nodeId: ctx.nodeId,
      params: { sides, angle: (angle * Math.PI) / 180 },
    });

    return { effect: effectList };
  },
};

/** Color Correction Post-Processing Node */
export const POSTPROCESS_COLOR_CORRECTION_NODE: NodeDefinition = {
  type: "postprocess/color-correction",
  label: "Color Correction",
  category: "postprocess",
  inputs: [
    { id: "effect", label: "Post-Process", type: "postprocess" },
    { id: "brightness", label: "Brightness", type: "value" },
    { id: "contrast", label: "Contrast", type: "value" },
    { id: "saturation", label: "Saturation", type: "value" },
  ],
  outputs: [{ id: "effect", label: "Post-Process", type: "postprocess" }],
  defaultParams: { brightness: 0.0, contrast: 1.0, saturation: 1.0 },
  paramFields: [
    { id: "brightness", label: "Brightness", kind: "number", step: 0.05 },
    { id: "contrast", label: "Contrast", kind: "number", step: 0.05 },
    { id: "saturation", label: "Saturation", kind: "number", step: 0.05 },
  ],
  evaluate: (inputs, params, ctx) => {
    const brightness = numberInput(inputs.brightness, params.brightness, 0.0);
    const contrast = numberInput(inputs.contrast, params.contrast, 1.0);
    const saturation = numberInput(inputs.saturation, params.saturation, 1.0);

    const effectList = accumulateEffect(inputs, {
      type: "color-correction",
      nodeId: ctx.nodeId,
      params: { brightness, contrast, saturation },
    });

    return { effect: effectList };
  },
};

/** FXAA Antialiasing Post-Processing Node */
export const POSTPROCESS_ANTIALIAS_NODE: NodeDefinition = {
  type: "postprocess/antialias",
  label: "FXAA Antialiasing",
  category: "postprocess",
  inputs: [
    { id: "effect", label: "Post-Process", type: "postprocess" },
    { id: "enabled", label: "Enabled", type: "value" },
  ],
  outputs: [{ id: "effect", label: "Post-Process", type: "postprocess" }],
  defaultParams: { enabled: 1 },
  paramFields: [{ id: "enabled", label: "Enabled", kind: "boolean" }],
  evaluate: (inputs, params, ctx) => {
    const enabled = toBoolean(inputs.enabled !== undefined ? inputs.enabled : params.enabled ?? 1);

    const effectList = accumulateEffect(inputs, {
      type: "antialias",
      nodeId: ctx.nodeId,
      params: { enabled },
    });

    return { effect: effectList };
  },
};

/**
 * Ambient Occlusion (GTAO) Post-Processing Node.
 *
 * Ground-Truth Ambient Occlusion — darkens crevices, corners and contact
 * points between meshes to fake the light they'd lose to nearby geometry,
 * same technique as threejs.org's webgl_postprocessing_gtao example. Reads
 * scene depth/normals, so it costs more than Bloom/Vignette; Samples trades
 * quality for that cost directly.
 *
 * View defaults to "multiply" — the AO term composited onto the render via
 * `mix(1, ao, blendIntensity)` under GL multiply blending (see
 * postProcessChain.ts's GTAOPass.OUTPUT.Default), the only one of GTAOPass's
 * OUTPUT modes that actually blends onto the scene; every other mode
 * (including "Denoise", easy to reach for since it sounds like the finished
 * result) *replaces* the frame with a flat grayscale AO map. "ao-only" and
 * "off" exist for debugging the effect itself, not for normal use.
 */
export const POSTPROCESS_AMBIENT_OCCLUSION_NODE: NodeDefinition = {
  type: "postprocess/ambient-occlusion",
  label: "Ambient Occlusion",
  category: "postprocess",
  inputs: [
    { id: "effect", label: "Post-Process", type: "postprocess" },
    { id: "radius", label: "Radius", type: "value" },
    { id: "blendIntensity", label: "Blend Intensity", type: "value" },
    { id: "thickness", label: "Thickness", type: "value" },
    { id: "samples", label: "Samples", type: "value" },
  ],
  outputs: [{ id: "effect", label: "Post-Process", type: "postprocess" }],
  defaultParams: {
    radius: 0.25,
    blendIntensity: 1.0,
    thickness: 1.0,
    distanceExponent: 1.0,
    samples: 16,
    screenSpaceRadius: false,
    view: "multiply",
  },
  paramFields: [
    { id: "view", label: "View", kind: "select", options: ["multiply", "ao-only", "off"] },
    { id: "radius", label: "Radius", kind: "number", step: 0.05 },
    // Not "intensity" — that id auto-groups under ParamPanel's Light Settings
    // bucket (see getGroupName), which reads wrong for a postprocess effect.
    { id: "blendIntensity", label: "Blend Intensity", kind: "number", step: 0.1 },
    { id: "thickness", label: "Thickness", kind: "number", step: 0.1 },
    { id: "distanceExponent", label: "Distance Exponent", kind: "number", step: 0.1 },
    { id: "samples", label: "Samples", kind: "number", step: 1 },
    { id: "screenSpaceRadius", label: "Screen-Space Radius (for far shots)", kind: "boolean" },
  ],
  evaluate: (inputs, params, ctx) => {
    const radius = Math.max(0.001, numberInput(inputs.radius, params.radius, 0.25));
    const blendIntensity = Math.max(0, numberInput(inputs.blendIntensity, params.blendIntensity, 1.0));
    const thickness = Math.max(0, numberInput(inputs.thickness, params.thickness, 1.0));
    const distanceExponent = Math.max(0.1, numberInput(undefined, params.distanceExponent, 1.0));
    const samples = Math.max(1, Math.round(numberInput(inputs.samples, params.samples, 16)));
    const screenSpaceRadius = toBoolean(params.screenSpaceRadius ?? 0);
    const view = ["multiply", "ao-only", "off"].includes(String(params.view)) ? String(params.view) : "multiply";

    const effectList = accumulateEffect(inputs, {
      type: "ao",
      nodeId: ctx.nodeId,
      params: { radius, blendIntensity, thickness, distanceExponent, samples, screenSpaceRadius, view },
    });

    return { effect: effectList };
  },
};

/** Fog & Atmospheric Post-Processing Node */
export const POSTPROCESS_FOG_NODE: NodeDefinition = {
  type: "postprocess/fog",
  label: "Fog / Atmosphere",
  category: "postprocess",
  inputs: [
    { id: "effect", label: "Post-Process", type: "postprocess" },
    { id: "color", label: "Color", type: "color" },
    { id: "density", label: "Density", type: "value" },
    { id: "near", label: "Near Distance", type: "value" },
    { id: "far", label: "Far Distance", type: "value" },
  ],
  outputs: [{ id: "effect", label: "Post-Process", type: "postprocess" }],
  defaultParams: {
    color: new THREE.Color(0x8899aa),
    mode: "linear",
    near: 1.0,
    far: 30.0,
    density: 0.02,
  },
  paramFields: [
    { id: "color", label: "Fog Color", kind: "color" },
    { id: "mode", label: "Fog Mode", kind: "select", options: ["linear", "exponential"] },
    { id: "near", label: "Near Distance", kind: "number", step: 0.5 },
    { id: "far", label: "Far Distance", kind: "number", step: 1.0 },
    { id: "density", label: "Exp Density", kind: "number", step: 0.005 },
  ],
  evaluate: (inputs, params, ctx) => {
    const color = asColor(inputs.color, asColor(params.color, new THREE.Color(0x8899aa)));
    const mode = String(params.mode || "linear");
    const near = Math.max(0, numberInput(inputs.near, params.near, 1.0));
    const far = Math.max(near + 0.1, numberInput(inputs.far, params.far, 30.0));
    const density = Math.max(0, numberInput(inputs.density, params.density, 0.02));

    const effectList = accumulateEffect(inputs, {
      type: "fog",
      nodeId: ctx.nodeId,
      params: { color, mode, near, far, density },
    });

    return { effect: effectList };
  },
};
