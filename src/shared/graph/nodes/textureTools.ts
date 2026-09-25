import * as THREE from "three";
import { EvalContext, NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { ColorRamp, DEFAULT_COLOR_RAMP, sampleColorRamp } from "../colorRamp";
import { evalProfileCurve, ProfilePoint } from "../profileCurve";
import {
  bindPassInputs,
  createGpuPassState,
  createPassMaterial,
  disposeGpuPassState,
  ensurePassTarget,
  GpuPassState,
  OUTPUT_SIZE_INHERIT,
  outputSizeFields,
  renderPass,
  resolveOutputSize,
  textureRevision,
  textureSize,
  updateLut,
} from "../gpuTexture";

/**
 * Texture Tools — per-pixel filters (Blur, Levels, Mix, …), all run as GPU
 * fragment passes into render targets at a real output size (by default the
 * input's own size, so a 1920×1080 source stays 1920×1080). Only re-rendered
 * when an input's pixels or a param actually changed.
 */

const SRGB = THREE.SRGBColorSpace;
const LINEAR = THREE.LinearSRGBColorSpace;

const SIZE_DEFAULTS = { size: OUTPUT_SIZE_INHERIT, width: 1920, height: 1080 };

const asTexture = (v: unknown): THREE.Texture | null => (v instanceof THREE.Texture ? v : null);

/** An input is only usable once its pixels exist (an Image Texture still loading has no size yet). */
const usable = (t: THREE.Texture | null): THREE.Texture | null => (t && textureSize(t) ? t : null);

function stateFor(cache: Map<string, GpuPassState>, nodeId: string): GpuPassState {
  let state = cache.get(nodeId);
  if (!state) {
    state = createGpuPassState();
    cache.set(nodeId, state);
  }
  return state;
}

interface FilterRun {
  ctx: EvalContext;
  cache: Map<string, GpuPassState>;
  body: string;
  extraUniforms?: () => Record<string, THREE.IUniform>;
  inputs: (THREE.Texture | null)[];
  params: Record<string, unknown>;
  colorSpace: THREE.ColorSpace;
  /** Every value the shader output depends on besides the inputs' pixels. */
  signature: unknown[];
  setUniforms?: (material: THREE.ShaderMaterial, state: GpuPassState) => void;
}

/** Single-pass filter: returns the output texture, or null without a renderer (tests, headless evaluate). */
function runFilter(run: FilterRun): THREE.Texture | null {
  const renderer = run.ctx.renderer;
  if (!renderer) return null;
  const inputs = run.inputs.map(usable);
  const [width, height] = resolveOutputSize(run.params, inputs);
  const state = stateFor(run.cache, run.ctx.nodeId);
  const target = (state.targets.out = ensurePassTarget(state.targets.out, width, height, run.colorSpace));
  const sig = JSON.stringify([run.signature, target.texture.uuid, inputs.map(textureRevision)]);
  if (state.signatures.get(renderer) !== sig) {
    const material = (state.materials.main ??= createPassMaterial(run.body, run.extraUniforms?.()));
    bindPassInputs(material, inputs);
    run.setUniforms?.(material, state);
    renderPass(renderer, material, target);
    state.signatures.set(renderer, sig);
  }
  return target.texture;
}

const num = (inputValue: unknown, paramValue: unknown, fallback: number): number => {
  const v = inputValue !== undefined ? Number(inputValue) : Number(paramValue);
  return Number.isFinite(v) ? v : fallback;
};

// ---------------------------------------------------------------- Mix

const MIX_MODES = ["mix", "add", "multiply", "screen", "overlay", "subtract", "difference", "darken", "lighten"];
const mixCache = createNodeCache<GpuPassState>(disposeGpuPassState);

/** Same blend formulas as Blender's Mix Color node. A missing A or B reads as flat white. */
export const TEXTURE_MIX_NODE: NodeDefinition = {
  type: "texture/mix",
  label: "Mix Texture",
  category: "textureTools",
  inputs: [
    { id: "textureA", label: "Texture A", type: "texture" },
    { id: "textureB", label: "Texture B", type: "texture" },
    { id: "factor", label: "Factor", type: "value" },
    { id: "factorTexture", label: "Factor (Texture)", type: "texture" },
  ],
  outputs: [{ id: "texture", label: "Texture", type: "texture" }],
  defaultParams: { blendMode: "mix", factor: 0.5, ...SIZE_DEFAULTS },
  dynamicParamFields: (instance) => [
    { id: "blendMode", label: "Blend Mode", kind: "select", options: MIX_MODES },
    { id: "factor", label: "Factor (fallback)", kind: "number", step: 0.05 },
    ...outputSizeFields(instance.params),
  ],
  evaluate: (inputs, params, ctx) => {
    const mode = Math.max(0, MIX_MODES.indexOf(String(params.blendMode || "mix")));
    const factor = Math.max(0, Math.min(1, num(inputs.factor, params.factor, 0.5)));
    const texture = runFilter({
      ctx,
      cache: mixCache,
      params,
      inputs: [asTexture(inputs.textureA), asTexture(inputs.textureB), asTexture(inputs.factorTexture)],
      colorSpace: SRGB,
      signature: [mode, factor],
      extraUniforms: () => ({ mode: { value: 0 }, factor: { value: 0.5 } }),
      setUniforms: (m) => {
        m.uniforms.mode.value = mode;
        m.uniforms.factor.value = factor;
      },
      body: /* glsl */ `
        uniform float mode;
        uniform float factor;
        vec3 blendOp(vec3 a, vec3 b) {
          if (mode < 0.5) return b;
          if (mode < 1.5) return a + b;
          if (mode < 2.5) return a * b;
          if (mode < 3.5) return 1.0 - (1.0 - a) * (1.0 - b);
          if (mode < 4.5) return mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, a));
          if (mode < 5.5) return a - b;
          if (mode < 6.5) return abs(a - b);
          if (mode < 7.5) return min(a, b);
          return max(a, b);
        }
        vec4 process(vec2 uv) {
          vec3 a = hA > 0.5 ? readA(uv).rgb : vec3(1.0);
          vec3 b = hB > 0.5 ? readB(uv).rgb : vec3(1.0);
          float t = hC > 0.5 ? luma(readC(uv).rgb) : factor;
          return vec4(clamp(a + (blendOp(a, b) - a) * t, 0.0, 1.0), 1.0);
        }`,
    });
    return { texture };
  },
};

// ---------------------------------------------------------------- Math

const MATH_OPS = ["add", "subtract", "multiply", "divide", "min", "max", "power", "abs", "invert", "less-than", "greater-than"];
const mathCache = createNodeCache<GpuPassState>(disposeGpuPassState);

/** Per-pixel arithmetic on one or two textures; "luminance" collapses both to grayscale first. Less/Greater Than output 1 where A < B (A > B), else 0 — B acting as a per-pixel threshold. */
export const TEXTURE_MATH_NODE: NodeDefinition = {
  type: "texture/math",
  label: "Texture Math",
  category: "textureTools",
  inputs: [
    { id: "textureA", label: "Texture A", type: "texture" },
    { id: "textureB", label: "Texture B", type: "texture" },
  ],
  outputs: [{ id: "texture", label: "Texture", type: "texture" }],
  defaultParams: { op: "add", channelMode: "rgb", ...SIZE_DEFAULTS },
  dynamicParamFields: (instance) => [
    { id: "op", label: "Operation", kind: "select", options: MATH_OPS },
    { id: "channelMode", label: "Channel Mode", kind: "select", options: ["rgb", "luminance"] },
    ...outputSizeFields(instance.params),
  ],
  evaluate: (inputs, params, ctx) => {
    const op = Math.max(0, MATH_OPS.indexOf(String(params.op || "add")));
    const lum = String(params.channelMode || "rgb") === "luminance" ? 1 : 0;
    const texture = runFilter({
      ctx,
      cache: mathCache,
      params,
      inputs: [asTexture(inputs.textureA), asTexture(inputs.textureB)],
      colorSpace: LINEAR,
      signature: [op, lum],
      extraUniforms: () => ({ op: { value: 0 }, lum: { value: 0 } }),
      setUniforms: (m) => {
        m.uniforms.op.value = op;
        m.uniforms.lum.value = lum;
      },
      body: /* glsl */ `
        uniform float op;
        uniform float lum;
        vec3 apply(vec3 a, vec3 b) {
          if (op < 0.5) return a + b;
          if (op < 1.5) return a - b;
          if (op < 2.5) return a * b;
          if (op < 3.5) return vec3(b.x == 0.0 ? 0.0 : a.x / b.x, b.y == 0.0 ? 0.0 : a.y / b.y, b.z == 0.0 ? 0.0 : a.z / b.z);
          if (op < 4.5) return min(a, b);
          if (op < 5.5) return max(a, b);
          if (op < 6.5) return pow(max(a, 0.0), b);
          if (op < 7.5) return abs(a);
          if (op < 8.5) return 1.0 - a;
          if (op < 9.5) return vec3(lessThan(a, b));
          return vec3(greaterThan(a, b));
        }
        vec4 process(vec2 uv) {
          vec3 a = hA > 0.5 ? readA(uv).rgb : vec3(1.0);
          vec3 b = hB > 0.5 ? readB(uv).rgb : vec3(1.0);
          if (lum > 0.5) { a = vec3(luma(a)); b = vec3(luma(b)); }
          return vec4(apply(a, b), 1.0);
        }`,
    });
    return { texture };
  },
};

// ---------------------------------------------------------------- Mask

const MASK_OPS = ["and", "or", "subtract", "xor"];
const MASK_CHANNELS = ["luminance", "r", "g", "b", "a"];
const maskCache = createNodeCache<GpuPassState>(disposeGpuPassState);

/** "Extract" pulls one channel of A out as a grayscale mask; "Combine" boolean-combines it with B's luminance. */
export const TEXTURE_MASK_NODE: NodeDefinition = {
  type: "texture/mask",
  label: "Mask",
  category: "textureTools",
  inputs: [
    { id: "textureA", label: "Texture A", type: "texture" },
    { id: "textureB", label: "Texture B (Combine)", type: "texture" },
  ],
  outputs: [{ id: "mask", label: "Mask", type: "texture" }],
  defaultParams: { mode: "extract", channel: "luminance", op: "and", invert: false, ...SIZE_DEFAULTS },
  dynamicParamFields: (instance) => {
    const mode = String(instance.params.mode || "extract");
    return [
      { id: "mode", label: "Mode", kind: "select", options: ["extract", "combine"] },
      ...(mode === "extract"
        ? [{ id: "channel", label: "Channel", kind: "select" as const, options: MASK_CHANNELS }]
        : [{ id: "op", label: "Operation", kind: "select" as const, options: MASK_OPS }]),
      { id: "invert", label: "Invert", kind: "boolean" },
      ...outputSizeFields(instance.params),
    ];
  },
  evaluate: (inputs, params, ctx) => {
    const combine = String(params.mode || "extract") === "combine" ? 1 : 0;
    const channel = Math.max(0, MASK_CHANNELS.indexOf(String(params.channel || "luminance")));
    const op = Math.max(0, MASK_OPS.indexOf(String(params.op || "and")));
    const invert = params.invert ? 1 : 0;
    const mask = runFilter({
      ctx,
      cache: maskCache,
      params,
      inputs: [asTexture(inputs.textureA), combine ? asTexture(inputs.textureB) : null],
      colorSpace: LINEAR,
      signature: [combine, channel, op, invert],
      extraUniforms: () => ({ combine: { value: 0 }, channel: { value: 0 }, op: { value: 0 }, invert: { value: 0 } }),
      setUniforms: (m) => {
        m.uniforms.combine.value = combine;
        m.uniforms.channel.value = channel;
        m.uniforms.op.value = op;
        m.uniforms.invert.value = invert;
      },
      body: /* glsl */ `
        uniform float combine;
        uniform float channel;
        uniform float op;
        uniform float invert;
        vec4 process(vec2 uv) {
          vec4 a = hA > 0.5 ? readA(uv) : vec4(1.0);
          float v = channel < 0.5 ? luma(a.rgb) : channel < 1.5 ? a.r : channel < 2.5 ? a.g : channel < 3.5 ? a.b : a.a;
          if (combine > 0.5) {
            float b = hB > 0.5 ? luma(readB(uv).rgb) : 1.0;
            v = op < 0.5 ? min(v, b) : op < 1.5 ? max(v, b) : op < 2.5 ? max(0.0, v - b) : abs(v - b);
          }
          if (invert > 0.5) v = 1.0 - v;
          return vec4(vec3(v), 1.0);
        }`,
    });
    return { mask };
  },
};

// ---------------------------------------------------------------- Map Range

const mapRangeCache = createNodeCache<GpuPassState>(disposeGpuPassState);

export const TEXTURE_MAP_RANGE_NODE: NodeDefinition = {
  type: "texture/map-range",
  label: "Map Range",
  category: "textureTools",
  inputs: [{ id: "texture", label: "Texture", type: "texture" }],
  outputs: [{ id: "texture", label: "Texture", type: "texture" }],
  defaultParams: { channelMode: "rgb", inMin: 0, inMax: 1, outMin: 0, outMax: 1, clamp: true, ...SIZE_DEFAULTS },
  dynamicParamFields: (instance) => [
    { id: "channelMode", label: "Channel Mode", kind: "select", options: ["rgb", "luminance"] },
    { id: "inMin", label: "In Min", kind: "number", step: 0.05 },
    { id: "inMax", label: "In Max", kind: "number", step: 0.05 },
    { id: "outMin", label: "Out Min", kind: "number", step: 0.05 },
    { id: "outMax", label: "Out Max", kind: "number", step: 0.05 },
    { id: "clamp", label: "Clamp", kind: "boolean" },
    ...outputSizeFields(instance.params),
  ],
  evaluate: (inputs, params, ctx) => {
    const lum = String(params.channelMode || "rgb") === "luminance" ? 1 : 0;
    const range = new THREE.Vector4(num(undefined, params.inMin, 0), num(undefined, params.inMax, 1), num(undefined, params.outMin, 0), num(undefined, params.outMax, 1));
    const clampOn = (params.clamp ?? true) ? 1 : 0;
    const texture = runFilter({
      ctx,
      cache: mapRangeCache,
      params,
      inputs: [asTexture(inputs.texture)],
      colorSpace: LINEAR,
      signature: [lum, range.toArray(), clampOn],
      extraUniforms: () => ({ lum: { value: 0 }, range: { value: new THREE.Vector4() }, clampOn: { value: 1 } }),
      setUniforms: (m) => {
        m.uniforms.lum.value = lum;
        (m.uniforms.range.value as THREE.Vector4).copy(range);
        m.uniforms.clampOn.value = clampOn;
      },
      body: /* glsl */ `
        uniform float lum;
        uniform vec4 range;
        uniform float clampOn;
        vec3 remap(vec3 v) {
          float span = range.y - range.x;
          vec3 t = span == 0.0 ? vec3(0.0) : (v - range.x) / span;
          if (clampOn > 0.5) t = clamp(t, 0.0, 1.0);
          return range.z + t * (range.w - range.z);
        }
        vec4 process(vec2 uv) {
          vec4 a = readA(uv);
          vec3 v = lum > 0.5 ? vec3(luma(a.rgb)) : a.rgb;
          return vec4(remap(v), a.a);
        }`,
    });
    return { texture };
  },
};

// ---------------------------------------------------------------- Blur

const BLUR_MAX_TAPS = 48;
const BLUR_MAX_RADIUS = 250;
const blurCache = createNodeCache<GpuPassState>(disposeGpuPassState);

const BLUR_BODY = /* glsl */ `
  uniform vec2 dir;
  uniform float radius;
  uniform float gaussian;
  vec4 process(vec2 uv) {
    if (radius < 0.5) return readA(uv);
    // Past ${BLUR_MAX_TAPS} taps per side the samples spread out and lean on
    // bilinear filtering — keeps a 250px radius as cheap as a 48px one.
    float taps = min(radius, ${BLUR_MAX_TAPS}.0);
    float stepPx = radius / taps;
    float sigma = max(radius * 0.5, 0.5);
    vec4 sum = vec4(0.0);
    float wsum = 0.0;
    for (int i = -${BLUR_MAX_TAPS}; i <= ${BLUR_MAX_TAPS}; i++) {
      float fi = float(i);
      if (abs(fi) > taps) continue;
      float x = fi * stepPx;
      float w = gaussian > 0.5 ? exp(-(x * x) / (2.0 * sigma * sigma)) : 1.0;
      sum += readA(uv + dir * x) * w;
      wsum += w;
    }
    return sum / wsum;
  }`;

/** Separable blur, radius in output pixels — the same number means the same softness at any resolution. */
export const TEXTURE_BLUR_NODE: NodeDefinition = {
  type: "texture/blur",
  label: "Blur",
  category: "textureTools",
  inputs: [
    { id: "texture", label: "Texture", type: "texture" },
    { id: "radius", label: "Radius", type: "value" },
  ],
  outputs: [{ id: "texture", label: "Texture", type: "texture" }],
  defaultParams: { mode: "gaussian", radius: 8, ...SIZE_DEFAULTS },
  dynamicParamFields: (instance) => [
    { id: "mode", label: "Mode", kind: "select", options: ["box", "gaussian"] },
    { id: "radius", label: "Radius (px, fallback)", kind: "number", step: 1 },
    ...outputSizeFields(instance.params),
  ],
  evaluate: (inputs, params, ctx) => {
    const renderer = ctx.renderer;
    if (!renderer) return { texture: null };
    const source = usable(asTexture(inputs.texture));
    const gaussian = String(params.mode || "gaussian") === "gaussian" ? 1 : 0;
    const radius = Math.max(0, Math.min(BLUR_MAX_RADIUS, num(inputs.radius, params.radius, 0)));
    const [width, height] = resolveOutputSize(params, [source]);

    const state = stateFor(blurCache, ctx.nodeId);
    const out = (state.targets.out = ensurePassTarget(state.targets.out, width, height, SRGB));
    const scratch = (state.targets.scratch = ensurePassTarget(state.targets.scratch, width, height, LINEAR, false));
    const sig = JSON.stringify([gaussian, radius, out.texture.uuid, textureRevision(source)]);
    if (state.signatures.get(renderer) !== sig) {
      const extra = () => ({ dir: { value: new THREE.Vector2() }, radius: { value: 0 }, gaussian: { value: 1 } });
      const h = (state.materials.h ??= createPassMaterial(BLUR_BODY, extra()));
      const v = (state.materials.v ??= createPassMaterial(BLUR_BODY, extra()));
      for (const m of [h, v]) {
        m.uniforms.radius.value = radius;
        m.uniforms.gaussian.value = gaussian;
      }
      bindPassInputs(h, [source]);
      (h.uniforms.dir.value as THREE.Vector2).set(1 / width, 0);
      renderPass(renderer, h, scratch);
      bindPassInputs(v, [scratch.texture]);
      (v.uniforms.dir.value as THREE.Vector2).set(0, 1 / height);
      renderPass(renderer, v, out);
      state.signatures.set(renderer, sig);
    }
    return { texture: out.texture };
  },
};

// ---------------------------------------------------------------- Color Ramp

const colorRampCache = createNodeCache<GpuPassState>(disposeGpuPassState);

function rampSignature(ramp: ColorRamp): string {
  return JSON.stringify({
    i: ramp.interpolation,
    s: ramp.stops.map((s) => [s.position, s.color instanceof THREE.Color ? s.color.getHexString() : s.color]),
  });
}

const LUT_LOOKUP = /* glsl */ `
  vec4 lut(sampler2D t, float v) { return texture2D(t, vec2((clamp(v, 0.0, 1.0) * 255.0 + 0.5) / 256.0, 0.5)); }
`;

/** Maps a texture's luminance through a Blender-style color ramp. */
export const TEXTURE_COLOR_RAMP_NODE: NodeDefinition = {
  type: "texture/color-ramp",
  label: "Color Ramp",
  category: "textureTools",
  inputs: [{ id: "texture", label: "Texture", type: "texture" }],
  outputs: [{ id: "texture", label: "Texture", type: "texture" }],
  defaultParams: { ramp: DEFAULT_COLOR_RAMP, ...SIZE_DEFAULTS },
  dynamicParamFields: (instance) => [{ id: "ramp", label: "Ramp", kind: "color_ramp" }, ...outputSizeFields(instance.params)],
  evaluate: (inputs, params, ctx) => {
    const ramp = params.ramp && typeof params.ramp === "object" ? (params.ramp as ColorRamp) : DEFAULT_COLOR_RAMP;
    const rampSig = rampSignature(ramp);
    const texture = runFilter({
      ctx,
      cache: colorRampCache,
      params,
      inputs: [asTexture(inputs.texture)],
      colorSpace: SRGB,
      signature: [rampSig],
      extraUniforms: () => ({ ramp: { value: null } }),
      setUniforms: (m, state) => {
        const data = new Uint8Array(256 * 4);
        const rgb = { r: 0, g: 0, b: 0 };
        for (let i = 0; i < 256; i++) {
          // THREE.Color stores linear values; the pass works on display-referred (sRGB) ones.
          sampleColorRamp(ramp, i / 255).getRGB(rgb, SRGB);
          data[i * 4] = Math.round(rgb.r * 255);
          data[i * 4 + 1] = Math.round(rgb.g * 255);
          data[i * 4 + 2] = Math.round(rgb.b * 255);
          data[i * 4 + 3] = 255;
        }
        m.uniforms.ramp.value = updateLut(state, "ramp", data);
      },
      body: /* glsl */ `
        uniform sampler2D ramp;
        ${LUT_LOOKUP}
        vec4 process(vec2 uv) {
          vec4 a = readA(uv);
          return vec4(lut(ramp, luma(a.rgb)).rgb, a.a);
        }`,
    });
    return { texture };
  },
};

// ---------------------------------------------------------------- Combine / Separate RGB

const combineCache = createNodeCache<GpuPassState>(disposeGpuPassState);

/** Packs up to 4 grayscale textures (read by luminance) into R/G/B/A. Missing channels read 0 (alpha: 1). */
export const TEXTURE_COMBINE_RGB_NODE: NodeDefinition = {
  type: "texture/combine-rgb",
  label: "Combine RGB",
  category: "textureTools",
  inputs: [
    { id: "r", label: "R", type: "texture" },
    { id: "g", label: "G", type: "texture" },
    { id: "b", label: "B", type: "texture" },
    { id: "a", label: "A", type: "texture" },
  ],
  outputs: [{ id: "texture", label: "Texture", type: "texture" }],
  defaultParams: { ...SIZE_DEFAULTS },
  dynamicParamFields: (instance) => outputSizeFields(instance.params),
  evaluate: (inputs, params, ctx) => {
    const texture = runFilter({
      ctx,
      cache: combineCache,
      params,
      inputs: [asTexture(inputs.r), asTexture(inputs.g), asTexture(inputs.b), asTexture(inputs.a)],
      colorSpace: LINEAR,
      signature: [],
      body: /* glsl */ `
        vec4 process(vec2 uv) {
          return vec4(
            hA > 0.5 ? luma(readA(uv).rgb) : 0.0,
            hB > 0.5 ? luma(readB(uv).rgb) : 0.0,
            hC > 0.5 ? luma(readC(uv).rgb) : 0.0,
            hD > 0.5 ? luma(readD(uv).rgb) : 1.0);
        }`,
    });
    return { texture };
  },
};

const separateCache = createNodeCache<GpuPassState>(disposeGpuPassState);
const SEPARATE_CHANNELS = ["r", "g", "b", "a"] as const;

export const TEXTURE_SEPARATE_RGB_NODE: NodeDefinition = {
  type: "texture/separate-rgb",
  label: "Separate RGB",
  category: "textureTools",
  inputs: [{ id: "texture", label: "Texture", type: "texture" }],
  outputs: [
    { id: "r", label: "R", type: "texture" },
    { id: "g", label: "G", type: "texture" },
    { id: "b", label: "B", type: "texture" },
    { id: "a", label: "A", type: "texture" },
  ],
  defaultParams: { ...SIZE_DEFAULTS },
  dynamicParamFields: (instance) => outputSizeFields(instance.params),
  evaluate: (inputs, params, ctx) => {
    const renderer = ctx.renderer;
    if (!renderer) return { r: null, g: null, b: null, a: null };
    const source = usable(asTexture(inputs.texture));
    const [width, height] = resolveOutputSize(params, [source]);
    const state = stateFor(separateCache, ctx.nodeId);
    const targets = SEPARATE_CHANNELS.map((c) => (state.targets[c] = ensurePassTarget(state.targets[c], width, height, LINEAR)));
    const sig = JSON.stringify([targets.map((t) => t.texture.uuid), textureRevision(source)]);
    if (state.signatures.get(renderer) !== sig) {
      const material = (state.materials.main ??= createPassMaterial(
        /* glsl */ `
          uniform float channel;
          vec4 process(vec2 uv) {
            if (hA < 0.5) return vec4(vec3(channel > 2.5 ? 1.0 : 0.0), 1.0);
            vec4 a = readA(uv);
            float v = channel < 0.5 ? a.r : channel < 1.5 ? a.g : channel < 2.5 ? a.b : a.a;
            return vec4(vec3(v), 1.0);
          }`,
        { channel: { value: 0 } },
      ));
      bindPassInputs(material, [source]);
      targets.forEach((target, i) => {
        material.uniforms.channel.value = i;
        renderPass(renderer, material, target);
      });
      state.signatures.set(renderer, sig);
    }
    return { r: targets[0].texture, g: targets[1].texture, b: targets[2].texture, a: targets[3].texture };
  },
};

// ---------------------------------------------------------------- Threshold

const thresholdCache = createNodeCache<GpuPassState>(disposeGpuPassState);

/** Steps luminance to 0/1 at a cutoff, with an optional smoothstep edge width. */
export const TEXTURE_THRESHOLD_NODE: NodeDefinition = {
  type: "texture/threshold",
  label: "Threshold",
  category: "textureTools",
  inputs: [
    { id: "texture", label: "Texture", type: "texture" },
    { id: "cutoff", label: "Cutoff", type: "value" },
  ],
  outputs: [{ id: "mask", label: "Mask", type: "texture" }],
  defaultParams: { cutoff: 0.5, smoothing: 0, invert: false, ...SIZE_DEFAULTS },
  dynamicParamFields: (instance) => [
    { id: "cutoff", label: "Cutoff (fallback)", kind: "number", step: 0.05 },
    { id: "smoothing", label: "Smoothing (soft edge width)", kind: "number", step: 0.01 },
    { id: "invert", label: "Invert", kind: "boolean" },
    ...outputSizeFields(instance.params),
  ],
  evaluate: (inputs, params, ctx) => {
    const cutoff = Math.max(0, Math.min(1, num(inputs.cutoff, params.cutoff, 0.5)));
    const smoothing = Math.max(0, num(undefined, params.smoothing, 0));
    const invert = params.invert ? 1 : 0;
    const mask = runFilter({
      ctx,
      cache: thresholdCache,
      params,
      inputs: [asTexture(inputs.texture)],
      colorSpace: LINEAR,
      signature: [cutoff, smoothing, invert],
      extraUniforms: () => ({ cutoff: { value: 0.5 }, smoothing: { value: 0 }, invert: { value: 0 } }),
      setUniforms: (m) => {
        m.uniforms.cutoff.value = cutoff;
        m.uniforms.smoothing.value = smoothing;
        m.uniforms.invert.value = invert;
      },
      body: /* glsl */ `
        uniform float cutoff;
        uniform float smoothing;
        uniform float invert;
        vec4 process(vec2 uv) {
          float l = luma(readA(uv).rgb);
          float halfW = smoothing * 0.5;
          float v = halfW <= 1e-6 ? step(cutoff, l) : smoothstep(cutoff - halfW, cutoff + halfW, l);
          if (invert > 0.5) v = 1.0 - v;
          return vec4(vec3(v), 1.0);
        }`,
    });
    return { mask };
  },
};

// ---------------------------------------------------------------- Invert

const invertCache = createNodeCache<GpuPassState>(disposeGpuPassState);

export const TEXTURE_INVERT_NODE: NodeDefinition = {
  type: "texture/invert",
  label: "Invert",
  category: "textureTools",
  inputs: [
    { id: "texture", label: "Texture", type: "texture" },
    { id: "factor", label: "Factor", type: "value" },
  ],
  outputs: [{ id: "texture", label: "Texture", type: "texture" }],
  defaultParams: { factor: 1, ...SIZE_DEFAULTS },
  dynamicParamFields: (instance) => [
    { id: "factor", label: "Factor (fallback)", kind: "number", step: 0.05 },
    ...outputSizeFields(instance.params),
  ],
  evaluate: (inputs, params, ctx) => {
    const factor = Math.max(0, Math.min(1, num(inputs.factor, params.factor, 1)));
    const texture = runFilter({
      ctx,
      cache: invertCache,
      params,
      inputs: [asTexture(inputs.texture)],
      colorSpace: SRGB,
      signature: [factor],
      extraUniforms: () => ({ factor: { value: 1 } }),
      setUniforms: (m) => {
        m.uniforms.factor.value = factor;
      },
      body: /* glsl */ `
        uniform float factor;
        vec4 process(vec2 uv) {
          vec4 a = readA(uv);
          return vec4(mix(a.rgb, 1.0 - a.rgb, factor), a.a);
        }`,
    });
    return { texture };
  },
};

// ---------------------------------------------------------------- Levels

const levelsCache = createNodeCache<GpuPassState>(disposeGpuPassState);

/** Photoshop-style Levels: input black/white + gamma, then output black/white. */
export const TEXTURE_LEVELS_NODE: NodeDefinition = {
  type: "texture/levels",
  label: "Levels",
  category: "textureTools",
  inputs: [{ id: "texture", label: "Texture", type: "texture" }],
  outputs: [{ id: "texture", label: "Texture", type: "texture" }],
  defaultParams: { inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1, ...SIZE_DEFAULTS },
  dynamicParamFields: (instance) => [
    { id: "inBlack", label: "Input Black", kind: "number", step: 0.01 },
    { id: "inWhite", label: "Input White", kind: "number", step: 0.01 },
    { id: "gamma", label: "Gamma", kind: "number", step: 0.05 },
    { id: "outBlack", label: "Output Black", kind: "number", step: 0.01 },
    { id: "outWhite", label: "Output White", kind: "number", step: 0.01 },
    ...outputSizeFields(instance.params),
  ],
  evaluate: (inputs, params, ctx) => {
    const levels = new THREE.Vector4(num(undefined, params.inBlack, 0), num(undefined, params.inWhite, 1), num(undefined, params.outBlack, 0), num(undefined, params.outWhite, 1));
    const gamma = Math.max(0.01, num(undefined, params.gamma, 1));
    const texture = runFilter({
      ctx,
      cache: levelsCache,
      params,
      inputs: [asTexture(inputs.texture)],
      colorSpace: SRGB,
      signature: [levels.toArray(), gamma],
      extraUniforms: () => ({ levels: { value: new THREE.Vector4() }, gamma: { value: 1 } }),
      setUniforms: (m) => {
        (m.uniforms.levels.value as THREE.Vector4).copy(levels);
        m.uniforms.gamma.value = gamma;
      },
      body: /* glsl */ `
        uniform vec4 levels;
        uniform float gamma;
        vec4 process(vec2 uv) {
          vec4 a = readA(uv);
          float span = levels.y - levels.x;
          vec3 t = span == 0.0 ? vec3(0.0) : clamp((a.rgb - levels.x) / span, 0.0, 1.0);
          t = pow(t, vec3(1.0 / gamma));
          return vec4(levels.z + t * (levels.w - levels.z), a.a);
        }`,
    });
    return { texture };
  },
};

// ---------------------------------------------------------------- Hue / Saturation / Value

const hsvCache = createNodeCache<GpuPassState>(disposeGpuPassState);

export const TEXTURE_HUE_SAT_VAL_NODE: NodeDefinition = {
  type: "texture/hue-sat-val",
  label: "Hue/Saturation/Value",
  category: "textureTools",
  inputs: [
    { id: "texture", label: "Texture", type: "texture" },
    { id: "hue", label: "Hue Shift (°)", type: "value" },
    { id: "saturation", label: "Saturation", type: "value" },
    { id: "value", label: "Value", type: "value" },
  ],
  outputs: [{ id: "texture", label: "Texture", type: "texture" }],
  defaultParams: { hue: 0, saturation: 1, value: 1, ...SIZE_DEFAULTS },
  dynamicParamFields: (instance) => [
    { id: "hue", label: "Hue Shift (° fallback)", kind: "number", step: 5 },
    { id: "saturation", label: "Saturation (fallback)", kind: "number", step: 0.05 },
    { id: "value", label: "Value (fallback)", kind: "number", step: 0.05 },
    ...outputSizeFields(instance.params),
  ],
  evaluate: (inputs, params, ctx) => {
    const hsv = new THREE.Vector3(
      num(inputs.hue, params.hue, 0) / 360,
      Math.max(0, num(inputs.saturation, params.saturation, 1)),
      Math.max(0, num(inputs.value, params.value, 1)),
    );
    const texture = runFilter({
      ctx,
      cache: hsvCache,
      params,
      inputs: [asTexture(inputs.texture)],
      colorSpace: SRGB,
      signature: [hsv.toArray()],
      extraUniforms: () => ({ hsvAdjust: { value: new THREE.Vector3() } }),
      setUniforms: (m) => {
        (m.uniforms.hsvAdjust.value as THREE.Vector3).copy(hsv);
      },
      body: /* glsl */ `
        uniform vec3 hsvAdjust;
        vec3 rgb2hsv(vec3 c) {
          vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
          vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
          vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
          float d = q.x - min(q.w, q.y);
          float e = 1.0e-10;
          return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
        }
        vec3 hsv2rgb(vec3 c) {
          vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
          return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
        }
        vec4 process(vec2 uv) {
          vec4 a = readA(uv);
          vec3 hsv = rgb2hsv(a.rgb);
          hsv.x = fract(hsv.x + hsvAdjust.x);
          hsv.y = clamp(hsv.y * hsvAdjust.y, 0.0, 1.0);
          hsv.z = max(0.0, hsv.z * hsvAdjust.z);
          return vec4(hsv2rgb(hsv), a.a);
        }`,
    });
    return { texture };
  },
};

// ---------------------------------------------------------------- RGB Curves

const IDENTITY_CURVE_POINTS: ProfilePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];
const curvesCache = createNodeCache<GpuPassState>(disposeGpuPassState);

/** Master curve plus per-channel curves; defaults are identity so dropping the node changes nothing. */
export const TEXTURE_RGB_CURVES_NODE: NodeDefinition = {
  type: "texture/rgb-curves",
  label: "RGB Curves",
  category: "textureTools",
  inputs: [{ id: "texture", label: "Texture", type: "texture" }],
  outputs: [{ id: "texture", label: "Texture", type: "texture" }],
  defaultParams: {
    curveMaster: [...IDENTITY_CURVE_POINTS],
    curveR: [...IDENTITY_CURVE_POINTS],
    curveG: [...IDENTITY_CURVE_POINTS],
    curveB: [...IDENTITY_CURVE_POINTS],
    ...SIZE_DEFAULTS,
  },
  dynamicParamFields: (instance) => [
    { id: "curveMaster", label: "Master", kind: "curve_profile" },
    { id: "curveR", label: "Red", kind: "curve_profile" },
    { id: "curveG", label: "Green", kind: "curve_profile" },
    { id: "curveB", label: "Blue", kind: "curve_profile" },
    ...outputSizeFields(instance.params),
  ],
  evaluate: (inputs, params, ctx) => {
    const curve = (v: unknown) => (Array.isArray(v) ? (v as ProfilePoint[]) : IDENTITY_CURVE_POINTS);
    const curves = [curve(params.curveR), curve(params.curveG), curve(params.curveB), curve(params.curveMaster)];
    const texture = runFilter({
      ctx,
      cache: curvesCache,
      params,
      inputs: [asTexture(inputs.texture)],
      colorSpace: SRGB,
      signature: [curves],
      extraUniforms: () => ({ curves: { value: null } }),
      setUniforms: (m, state) => {
        const data = new Uint8Array(256 * 4);
        curves.forEach((c, channel) => {
          for (let v = 0; v < 256; v++) {
            data[v * 4 + channel] = Math.round(Math.max(0, Math.min(1, evalProfileCurve(c, v / 255))) * 255);
          }
        });
        m.uniforms.curves.value = updateLut(state, "curves", data);
      },
      body: /* glsl */ `
        uniform sampler2D curves;
        ${LUT_LOOKUP}
        vec4 process(vec2 uv) {
          vec4 a = readA(uv);
          vec3 c = vec3(lut(curves, a.r).r, lut(curves, a.g).g, lut(curves, a.b).b);
          return vec4(lut(curves, c.r).a, lut(curves, c.g).a, lut(curves, c.b).a, a.a);
        }`,
    });
    return { texture };
  },
};

// ---------------------------------------------------------------- To Normal / To Roughness

const toNormalCache = createNodeCache<GpuPassState>(disposeGpuPassState);

/** Tangent-space normal map from a texture's luminance, via central differences. */
export const TEXTURE_TO_NORMAL_NODE: NodeDefinition = {
  type: "texture/to_normal",
  label: "Texture to Normal",
  category: "textureTools",
  inputs: [{ id: "texture", label: "Texture", type: "texture" }],
  outputs: [{ id: "normal", label: "Normal Map", type: "texture" }],
  defaultParams: { strength: 1, ...SIZE_DEFAULTS },
  dynamicParamFields: (instance) => [
    { id: "strength", label: "Strength", kind: "number", step: 0.1 },
    ...outputSizeFields(instance.params),
  ],
  evaluate: (inputs, params, ctx) => {
    const strength = Math.max(0, num(undefined, params.strength, 1));
    const normal = runFilter({
      ctx,
      cache: toNormalCache,
      params,
      inputs: [asTexture(inputs.texture)],
      colorSpace: LINEAR,
      signature: [strength],
      extraUniforms: () => ({ strength: { value: 1 } }),
      setUniforms: (m) => {
        m.uniforms.strength.value = strength;
      },
      body: /* glsl */ `
        uniform float strength;
        float heightAt(vec2 uv) { return luma(texture2D(tA, fract(uv)).rgb); }
        vec4 process(vec2 uv) {
          if (hA < 0.5) return vec4(0.5, 0.5, 1.0, 1.0);
          float dx = (heightAt(uv + vec2(texelA.x, 0.0)) - heightAt(uv - vec2(texelA.x, 0.0))) * 0.5;
          float dy = (heightAt(uv + vec2(0.0, texelA.y)) - heightAt(uv - vec2(0.0, texelA.y))) * 0.5;
          vec3 n = normalize(vec3(-dx * strength, -dy * strength, 1.0));
          return vec4(n * 0.5 + 0.5, 1.0);
        }`,
    });
    return { normal };
  },
};

const toRoughnessCache = createNodeCache<GpuPassState>(disposeGpuPassState);

/** Roughness from luminance: darker reads rougher (or the reverse when inverted), contrast spreads mid-tones. */
export const TEXTURE_TO_ROUGHNESS_NODE: NodeDefinition = {
  type: "texture/to_roughness",
  label: "Texture to Roughness",
  category: "textureTools",
  inputs: [{ id: "texture", label: "Texture", type: "texture" }],
  outputs: [{ id: "roughness", label: "Roughness Map", type: "texture" }],
  defaultParams: { invert: false, contrast: 1, minRoughness: 0, maxRoughness: 1, ...SIZE_DEFAULTS },
  dynamicParamFields: (instance) => [
    { id: "invert", label: "Invert", kind: "boolean" },
    { id: "contrast", label: "Contrast", kind: "number", step: 0.1 },
    { id: "minRoughness", label: "Min Roughness", kind: "number", step: 0.05 },
    { id: "maxRoughness", label: "Max Roughness", kind: "number", step: 0.05 },
    ...outputSizeFields(instance.params),
  ],
  evaluate: (inputs, params, ctx) => {
    const invert = params.invert ? 1 : 0;
    const contrast = Math.max(0, num(undefined, params.contrast, 1));
    const lo = Math.max(0, Math.min(1, num(undefined, params.minRoughness, 0)));
    const hi = Math.max(0, Math.min(1, num(undefined, params.maxRoughness, 1)));
    const range = new THREE.Vector2(Math.min(lo, hi), Math.max(lo, hi));
    const roughness = runFilter({
      ctx,
      cache: toRoughnessCache,
      params,
      inputs: [asTexture(inputs.texture)],
      colorSpace: LINEAR,
      signature: [invert, contrast, range.toArray()],
      extraUniforms: () => ({ invert: { value: 0 }, contrast: { value: 1 }, range: { value: new THREE.Vector2() } }),
      setUniforms: (m) => {
        m.uniforms.invert.value = invert;
        m.uniforms.contrast.value = contrast;
        (m.uniforms.range.value as THREE.Vector2).copy(range);
      },
      body: /* glsl */ `
        uniform float invert;
        uniform float contrast;
        uniform vec2 range;
        vec4 process(vec2 uv) {
          float l = luma(readA(uv).rgb);
          if (invert > 0.5) l = 1.0 - l;
          l = clamp((l - 0.5) * contrast + 0.5, 0.0, 1.0);
          return vec4(vec3(range.x + l * (range.y - range.x)), 1.0);
        }`,
    });
    return { roughness };
  },
};

// ---------------------------------------------------------------- Procedural generators (GPU)

const GENERATOR_SIZE_DEFAULTS = { size: "1920 × 1080 (Full HD)", width: 1920, height: 1080 };

/**
 * 3D gradient noise + fBm with Blender's Noise Texture knobs: Detail is the
 * octave count above the first (fractional values blend in the next one),
 * Roughness the per-octave gain. Output is centered on 0.5.
 */
const NOISE_GLSL = /* glsl */ `
  vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return -1.0 + 2.0 * fract((p.xxy + p.yxx) * p.zyx);
  }
  float gnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float n000 = dot(hash33(i), f);
    float n100 = dot(hash33(i + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0));
    float n010 = dot(hash33(i + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0));
    float n110 = dot(hash33(i + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0));
    float n001 = dot(hash33(i + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0));
    float n101 = dot(hash33(i + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0));
    float n011 = dot(hash33(i + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0));
    float n111 = dot(hash33(i + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
      mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
      u.z);
  }
  float fbm(vec3 p, float detail, float roughness) {
    float sum = 0.0;
    float amp = 1.0;
    float norm = 0.0;
    float octaves = floor(detail);
    for (int i = 0; i <= 15; i++) {
      if (float(i) > octaves) break;
      sum += gnoise(p) * amp;
      norm += amp;
      amp *= roughness;
      p *= 2.0;
    }
    float rest = detail - octaves;
    float value = sum / norm;
    if (rest > 0.001) value = mix(value, (sum + gnoise(p) * amp) / (norm + amp), rest);
    return value * 0.5 + 0.5;
  }
  vec2 aspectCoords(vec2 uv, vec2 center) {
    return (uv - center) * vec2(outTexel.y / outTexel.x, 1.0);
  }
`;

const noiseCache = createNodeCache<GpuPassState>(disposeGpuPassState);

/** Noise Texture — Blender-style fBm, rendered on the GPU. Speed scrolls the 4th (W) axis over time so it evolves in place. */
export const TEXTURE_NOISE_NODE: NodeDefinition = {
  type: "texture/noise",
  label: "Noise Texture",
  category: "texture",
  inputs: [
    { id: "scale", label: "Scale", type: "value" },
    { id: "w", label: "W (evolution)", type: "value" },
  ],
  outputs: [{ id: "texture", label: "Texture", type: "texture" }],
  defaultParams: { scale: 5, detail: 2, roughness: 0.5, distortion: 0, w: 0, speed: 0, seed: 0, colorMode: "grayscale", ...GENERATOR_SIZE_DEFAULTS },
  dynamicParamFields: (instance) => [
    { id: "scale", label: "Scale (fallback)", kind: "number", step: 0.5 },
    { id: "detail", label: "Detail", kind: "number", step: 0.5 },
    { id: "roughness", label: "Roughness", kind: "number", step: 0.05 },
    { id: "distortion", label: "Distortion", kind: "number", step: 0.1 },
    { id: "w", label: "W (fallback)", kind: "number", step: 0.1 },
    { id: "speed", label: "Speed (W per second)", kind: "number", step: 0.05 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
    { id: "colorMode", label: "Output", kind: "select", options: ["grayscale", "color"] },
    ...outputSizeFields(instance.params, false),
  ],
  evaluate: (inputs, params, ctx) => {
    const scale = Math.max(0, num(inputs.scale, params.scale, 5));
    const detail = Math.max(0, Math.min(15, num(undefined, params.detail, 2)));
    const roughness = Math.max(0, Math.min(1, num(undefined, params.roughness, 0.5)));
    const distortion = num(undefined, params.distortion, 0);
    const w = num(inputs.w, params.w, 0) + num(undefined, params.speed, 0) * ctx.time;
    const seed = Math.round(num(undefined, params.seed, 0));
    const color = String(params.colorMode) === "color" ? 1 : 0;
    const texture = runFilter({
      ctx,
      cache: noiseCache,
      params,
      inputs: [],
      colorSpace: LINEAR,
      signature: [scale, detail, roughness, distortion, w, seed, color],
      extraUniforms: () => ({ noise: { value: new THREE.Vector4() }, extra: { value: new THREE.Vector3() } }),
      setUniforms: (m) => {
        (m.uniforms.noise.value as THREE.Vector4).set(scale, detail, roughness, distortion);
        (m.uniforms.extra.value as THREE.Vector3).set(w, seed, color);
      },
      body: /* glsl */ `
        uniform vec4 noise;
        uniform vec3 extra;
        ${NOISE_GLSL}
        vec4 process(vec2 uv) {
          vec3 p = vec3(aspectCoords(uv, vec2(0.5)) * noise.x + extra.y * 17.31, extra.x);
          if (noise.w != 0.0) {
            p += vec3(gnoise(p + 13.5), gnoise(p + 71.3), gnoise(p + 29.7)) * noise.w;
          }
          float r = fbm(p, noise.y, noise.z);
          if (extra.z < 0.5) return vec4(vec3(r), 1.0);
          return vec4(r, fbm(p + vec3(51.7, 3.1, 7.9), noise.y, noise.z), fbm(p + vec3(13.3, 97.1, 41.3), noise.y, noise.z), 1.0);
        }`,
    });
    return { texture };
  },
};

const WAVE_TYPES = ["bands", "rings"];
const WAVE_DIRECTIONS = ["x", "y", "diagonal"];
const WAVE_PROFILES = ["sine", "saw", "triangle"];
const waveCache = createNodeCache<GpuPassState>(disposeGpuPassState);

/**
 * Wave Texture — Blender's bands/rings with sine/saw/triangle profiles and
 * noise distortion. Rings are round regardless of output aspect and centered
 * on Center; Speed advances the phase over time (negative = rings travel outward).
 */
export const TEXTURE_WAVE_NODE: NodeDefinition = {
  type: "texture/wave",
  label: "Wave Texture",
  category: "texture",
  inputs: [
    { id: "scale", label: "Scale", type: "value" },
    { id: "phase", label: "Phase", type: "value" },
  ],
  outputs: [{ id: "texture", label: "Texture", type: "texture" }],
  defaultParams: {
    waveType: "rings",
    direction: "diagonal",
    profile: "sine",
    scale: 5,
    distortion: 0,
    detail: 2,
    detailScale: 1,
    roughness: 0.5,
    phase: 0,
    speed: 0,
    centerX: 0.5,
    centerY: 0.5,
    ...GENERATOR_SIZE_DEFAULTS,
  },
  dynamicParamFields: (instance) => {
    const bands = String(instance.params.waveType ?? "rings") === "bands";
    const distorted = Number(instance.params.distortion) !== 0;
    return [
      { id: "waveType", label: "Type", kind: "select", options: WAVE_TYPES },
      ...(bands
        ? [{ id: "direction", label: "Direction", kind: "select" as const, options: WAVE_DIRECTIONS }]
        : [
            { id: "centerX", label: "Center X (0-1)", kind: "number" as const, step: 0.05 },
            { id: "centerY", label: "Center Y (0-1)", kind: "number" as const, step: 0.05 },
          ]),
      { id: "profile", label: "Profile", kind: "select", options: WAVE_PROFILES },
      { id: "scale", label: "Scale (fallback)", kind: "number", step: 0.5 },
      { id: "distortion", label: "Distortion", kind: "number", step: 0.5 },
      ...(distorted
        ? [
            { id: "detail", label: "Detail", kind: "number" as const, step: 0.5 },
            { id: "detailScale", label: "Detail Scale", kind: "number" as const, step: 0.1 },
            { id: "roughness", label: "Detail Roughness", kind: "number" as const, step: 0.05 },
          ]
        : []),
      { id: "phase", label: "Phase Offset (fallback)", kind: "number", step: 0.1 },
      { id: "speed", label: "Speed (phase per second)", kind: "number", step: 0.1 },
      ...outputSizeFields(instance.params, false),
    ];
  },
  evaluate: (inputs, params, ctx) => {
    const rings = String(params.waveType ?? "rings") === "rings" ? 1 : 0;
    const direction = Math.max(0, WAVE_DIRECTIONS.indexOf(String(params.direction ?? "diagonal")));
    const profile = Math.max(0, WAVE_PROFILES.indexOf(String(params.profile ?? "sine")));
    const scale = num(inputs.scale, params.scale, 5);
    const distortion = num(undefined, params.distortion, 0);
    const detail = Math.max(0, Math.min(15, num(undefined, params.detail, 2)));
    const detailScale = num(undefined, params.detailScale, 1);
    const roughness = Math.max(0, Math.min(1, num(undefined, params.roughness, 0.5)));
    const phase = num(inputs.phase, params.phase, 0) + num(undefined, params.speed, 0) * ctx.time;
    const center = new THREE.Vector2(num(undefined, params.centerX, 0.5), num(undefined, params.centerY, 0.5));
    const texture = runFilter({
      ctx,
      cache: waveCache,
      params,
      inputs: [],
      colorSpace: LINEAR,
      signature: [rings, direction, profile, scale, distortion, detail, detailScale, roughness, phase, center.toArray()],
      extraUniforms: () => ({
        mode: { value: new THREE.Vector4() },
        shape: { value: new THREE.Vector4() },
        center: { value: new THREE.Vector2() },
        roughness: { value: 0.5 },
      }),
      setUniforms: (m) => {
        (m.uniforms.mode.value as THREE.Vector4).set(rings, direction, profile, phase);
        (m.uniforms.shape.value as THREE.Vector4).set(scale, distortion, detail, detailScale);
        (m.uniforms.center.value as THREE.Vector2).copy(center);
        m.uniforms.roughness.value = roughness;
      },
      body: /* glsl */ `
        uniform vec4 mode;
        uniform vec4 shape;
        uniform vec2 center;
        uniform float roughness;
        ${NOISE_GLSL}
        vec4 process(vec2 uv) {
          vec2 p = aspectCoords(uv, mode.x > 0.5 ? center : vec2(0.5)) * shape.x;
          float n;
          if (mode.x > 0.5) n = length(p) * 20.0;
          else if (mode.y < 0.5) n = p.x * 20.0;
          else if (mode.y < 1.5) n = p.y * 20.0;
          else n = (p.x + p.y) * 10.0;
          if (shape.y != 0.0) n += shape.y * (fbm(vec3(p * shape.w, 0.0), shape.z, roughness) * 2.0 - 1.0);
          n += mode.w;
          float v;
          if (mode.z < 0.5) v = 0.5 + 0.5 * sin(n - 1.5707963);
          else if (mode.z < 1.5) { n /= 6.2831853; v = n - floor(n); }
          else { n /= 6.2831853; v = abs(n - floor(n + 0.5)) * 2.0; }
          return vec4(vec3(v), 1.0);
        }`,
    });
    return { texture };
  },
};

// ---------------------------------------------------------------- Bloom

const bloomCache = createNodeCache<GpuPassState>(disposeGpuPassState);
const BLOOM_SCALES = [0.25, 0.5, 1];

const BLOOM_BRIGHT_BODY = /* glsl */ `
  uniform float threshold;
  vec4 process(vec2 uv) {
    // Four bilinear taps cover the 4×4 source texels behind each quarter-res texel.
    vec2 o = outTexel * 0.25;
    vec3 c = (readA(uv + vec2(-o.x, -o.y)).rgb + readA(uv + vec2(o.x, -o.y)).rgb
            + readA(uv + vec2(-o.x, o.y)).rgb + readA(uv + vec2(o.x, o.y)).rgb) * 0.25;
    return vec4(max(c - threshold, 0.0) / max(1.0 - threshold, 1e-3), 1.0);
  }`;

const BLOOM_COMPOSITE_BODY = /* glsl */ `
  uniform float intensity;
  uniform float glowOnly;
  vec4 process(vec2 uv) {
    vec4 base = readA(uv);
    vec3 glow = (readB(uv).rgb + readC(uv).rgb + readD(uv).rgb) / 3.0 * intensity;
    return glowOnly > 0.5 ? vec4(glow, 1.0) : vec4(base.rgb + glow, base.a);
  }`;

/**
 * Bloom — glow around everything brighter than Threshold: a bright pass at
 * quarter resolution, blurred at three radii (¼, ½ and all of Size) in
 * half-float targets so wide falloffs don't band, then added over the source.
 */
export const TEXTURE_BLOOM_NODE: NodeDefinition = {
  type: "texture/bloom",
  label: "Bloom",
  category: "textureTools",
  inputs: [
    { id: "texture", label: "Texture", type: "texture" },
    { id: "intensity", label: "Intensity", type: "value" },
  ],
  outputs: [{ id: "texture", label: "Texture", type: "texture" }],
  defaultParams: { threshold: 0.6, intensity: 1, radius: 80, glowOnly: false, ...SIZE_DEFAULTS },
  dynamicParamFields: (instance) => [
    { id: "threshold", label: "Threshold", kind: "number", step: 0.05 },
    { id: "intensity", label: "Intensity (fallback)", kind: "number", step: 0.1 },
    { id: "radius", label: "Size (px)", kind: "number", step: 5 },
    { id: "glowOnly", label: "Glow Only", kind: "boolean" },
    ...outputSizeFields(instance.params),
  ],
  evaluate: (inputs, params, ctx) => {
    const renderer = ctx.renderer;
    if (!renderer) return { texture: null };
    const source = usable(asTexture(inputs.texture));
    const threshold = Math.max(0, Math.min(0.999, num(undefined, params.threshold, 0.6)));
    const intensity = Math.max(0, num(inputs.intensity, params.intensity, 1));
    const radius = Math.max(0, Math.min(1000, num(undefined, params.radius, 80)));
    const glowOnly = params.glowOnly ? 1 : 0;
    const [width, height] = resolveOutputSize(params, [source]);
    const qw = Math.max(1, Math.round(width / 4));
    const qh = Math.max(1, Math.round(height / 4));

    const state = stateFor(bloomCache, ctx.nodeId);
    const quarter = (key: string) =>
      (state.targets[key] = ensurePassTarget(state.targets[key], qw, qh, LINEAR, false, THREE.HalfFloatType));
    const bright = quarter("bright");
    const scratch = quarter("scratch");
    const glows = BLOOM_SCALES.map((_, i) => quarter(`glow${i}`));
    const out = (state.targets.out = ensurePassTarget(state.targets.out, width, height, SRGB));

    const sig = JSON.stringify([threshold, intensity, radius, glowOnly, out.texture.uuid, bright.texture.uuid, textureRevision(source)]);
    if (state.signatures.get(renderer) !== sig) {
      const blurUniforms = () => ({ dir: { value: new THREE.Vector2() }, radius: { value: 0 }, gaussian: { value: 1 } });
      const brightMat = (state.materials.bright ??= createPassMaterial(BLOOM_BRIGHT_BODY, { threshold: { value: 0.6 } }));
      const blurH = (state.materials.blurH ??= createPassMaterial(BLUR_BODY, blurUniforms()));
      const blurV = (state.materials.blurV ??= createPassMaterial(BLUR_BODY, blurUniforms()));
      const composite = (state.materials.composite ??= createPassMaterial(BLOOM_COMPOSITE_BODY, {
        intensity: { value: 1 },
        glowOnly: { value: 0 },
      }));

      brightMat.uniforms.threshold.value = threshold;
      bindPassInputs(brightMat, [source]);
      renderPass(renderer, brightMat, bright);

      BLOOM_SCALES.forEach((scale, i) => {
        const r = Math.min(BLUR_MAX_RADIUS, (radius * scale) / 4);
        blurH.uniforms.radius.value = r;
        blurV.uniforms.radius.value = r;
        bindPassInputs(blurH, [bright.texture]);
        (blurH.uniforms.dir.value as THREE.Vector2).set(1 / qw, 0);
        renderPass(renderer, blurH, scratch);
        bindPassInputs(blurV, [scratch.texture]);
        (blurV.uniforms.dir.value as THREE.Vector2).set(0, 1 / qh);
        renderPass(renderer, blurV, glows[i]);
      });

      composite.uniforms.intensity.value = intensity;
      composite.uniforms.glowOnly.value = glowOnly;
      bindPassInputs(composite, [source, ...glows.map((g) => g.texture)]);
      renderPass(renderer, composite, out);
      state.signatures.set(renderer, sig);
    }
    return { texture: out.texture };
  },
};

// ---------------------------------------------------------------- Film Grain

const grainCache = createNodeCache<GpuPassState>(disposeGpuPassState);

/** Film Grain — soft value-noise grain in grain-sized cells, re-rolled every frame when Animated. */
export const TEXTURE_FILM_GRAIN_NODE: NodeDefinition = {
  type: "texture/film-grain",
  label: "Film Grain",
  category: "textureTools",
  inputs: [
    { id: "texture", label: "Texture", type: "texture" },
    { id: "amount", label: "Amount", type: "value" },
  ],
  outputs: [{ id: "texture", label: "Texture", type: "texture" }],
  defaultParams: { amount: 0.12, grainSize: 1.5, animated: true, monochrome: true, seed: 0, ...SIZE_DEFAULTS },
  dynamicParamFields: (instance) => [
    { id: "amount", label: "Amount (fallback)", kind: "number", step: 0.01 },
    { id: "grainSize", label: "Grain Size (px)", kind: "number", step: 0.25 },
    { id: "animated", label: "Animated", kind: "boolean" },
    { id: "monochrome", label: "Monochrome", kind: "boolean" },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
    ...outputSizeFields(instance.params),
  ],
  evaluate: (inputs, params, ctx) => {
    const amount = Math.max(0, num(inputs.amount, params.amount, 0.12));
    const grainSize = Math.max(0.5, num(undefined, params.grainSize, 1.5));
    const animated = params.animated ?? true;
    const frame = animated ? (ctx.currentFrame ?? ctx.step ?? 0) : 0;
    const seed = Math.round(num(undefined, params.seed, 0)) + (frame % 997);
    const mono = (params.monochrome ?? true) ? 1 : 0;
    const texture = runFilter({
      ctx,
      cache: grainCache,
      params,
      inputs: [asTexture(inputs.texture)],
      colorSpace: SRGB,
      signature: [amount, grainSize, seed, mono],
      extraUniforms: () => ({ grain: { value: new THREE.Vector4() } }),
      setUniforms: (m) => {
        (m.uniforms.grain.value as THREE.Vector4).set(amount, grainSize, seed, mono);
      },
      body: /* glsl */ `
        uniform vec4 grain;
        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        float vnoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
                     mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
        }
        vec4 process(vec2 uv) {
          vec4 c = readA(uv);
          vec2 p = uv / outTexel / grain.y + grain.z * vec2(37.13, 91.71);
          vec3 n = grain.w > 0.5 ? vec3(vnoise(p)) : vec3(vnoise(p), vnoise(p + 57.3), vnoise(p + 113.9));
          return vec4(c.rgb + (n - 0.5) * 2.0 * grain.x, c.a);
        }`,
    });
    return { texture };
  },
};
