import * as THREE from "three";
import { NodeDefinition, NodeInstance, ParamFieldDef } from "../types";
import { createNodeCache } from "../nodeCaches";
import {
  bindPassInputs,
  createGpuPassState,
  disposeGpuPassState,
  ensurePassTarget,
  GpuPassState,
  outputSizeFields,
  renderPass,
  resolveOutputSize,
} from "../gpuTexture";
import {
  asTileablePattern,
  MAX_TILEABLE_OCTAVES,
  TILEABLE_DEFAULT_FREQUENCY,
  TILEABLE_PATTERN_LABELS,
  TILEABLE_PATTERNS,
  TileablePattern,
  tileFrequency,
} from "../../math/tileableNoise";
import {
  createTileableMaterial,
  createTileableVolumeState,
  disposeTileableVolumeState,
  setTileableUniforms,
  TileableGpuSettings,
  tileableSignature,
  TileableVolumeState,
  updateTileableVolume,
} from "../../three/tileableNoiseGpu";

/**
 * Tileable Noise — sebh/TileableVolumeNoise as nodes: Perlin, Worley,
 * Perlin-Worley and the GPU Pro 7 cloud textures, periodic on every axis.
 *
 * The 2D node is a Z slice of the 3D one. Z is periodic too, so sweeping it
 * over one unit (Loop Speed) is an animation that loops with no seam — the
 * texture tiles in space *and* in time.
 */

const OUTPUT_MODES = ["packed", "channels"];
const OUTPUT_MODE_LABELS = ["Packed (grayscale)", "Channels (RGBA)"];

const num = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const isCloud = (pattern: TileablePattern) => pattern === "cloud-shape" || pattern === "cloud-detail";

/** Picking a pattern also loads the base frequency it was tuned at. */
const PATTERN_PRESETS = Object.fromEntries(TILEABLE_PATTERNS.map((p) => [p, { frequency: TILEABLE_DEFAULT_FREQUENCY[p] }]));

function noiseFields(instance: NodeInstance): ParamFieldDef[] {
  const pattern = asTileablePattern(instance.params.pattern);
  return [
    {
      id: "pattern",
      label: "Pattern",
      kind: "select",
      options: [...TILEABLE_PATTERNS],
      optionLabels: TILEABLE_PATTERNS.map((p) => TILEABLE_PATTERN_LABELS[p]),
      presets: PATTERN_PRESETS,
    },
    { id: "channels", label: "Output", kind: "select", options: OUTPUT_MODES, optionLabels: OUTPUT_MODE_LABELS },
    { id: "frequency", label: "Frequency (cells per tile)", kind: "number", step: 1 },
    ...(isCloud(pattern)
      ? []
      : [
          { id: "octaves", label: "Octaves", kind: "number" as const, step: 1 },
          { id: "gain", label: "Gain (per octave)", kind: "number" as const, step: 0.05 },
        ]),
    { id: "seed", label: "Seed", kind: "number", step: 1 },
    { id: "invert", label: "Invert", kind: "boolean" },
  ];
}

function readSettings(inputs: Record<string, unknown>, params: Record<string, unknown>): TileableGpuSettings {
  const pattern = asTileablePattern(params.pattern);
  const f = tileFrequency(inputs.frequency ?? params.frequency, TILEABLE_DEFAULT_FREQUENCY[pattern]);
  return {
    pattern,
    frequency: [f, f, f],
    channels: String(params.channels) === "channels",
    octaves: Math.max(1, Math.min(MAX_TILEABLE_OCTAVES, Math.round(num(inputs.octaves ?? params.octaves, 3)))),
    gain: Math.max(0, Math.min(1, num(inputs.gain ?? params.gain, 0.5))),
    seed: Math.max(0, Math.min(65535, Math.round(num(inputs.seed ?? params.seed, 0)))),
    invert: params.invert === true || Number(params.invert) === 1,
  };
}

const SHARED_INPUTS = [
  { id: "frequency", label: "Frequency", type: "value" as const },
  { id: "octaves", label: "Octaves", type: "value" as const },
  { id: "gain", label: "Gain", type: "value" as const },
  { id: "seed", label: "Seed", type: "value" as const },
];

const SHARED_DEFAULTS = { pattern: "perlin-worley", channels: "packed", frequency: 4, octaves: 3, gain: 0.5, seed: 0, invert: false };

// ---------------------------------------------------------------- 2D

const noise2dCache = createNodeCache<GpuPassState>(disposeGpuPassState);

export const TEXTURE_TILEABLE_NOISE_NODE: NodeDefinition = {
  type: "texture/tileable-noise",
  label: "Tileable Noise Texture",
  category: "texture",
  inputs: [
    ...SHARED_INPUTS,
    { id: "slice", label: "Slice (Z)", type: "value" },
    { id: "speed", label: "Loop Speed", type: "value" },
  ],
  outputs: [{ id: "texture", label: "Texture", type: "texture" }],
  defaultParams: { ...SHARED_DEFAULTS, slice: 0, speed: 0, size: "1024 × 1024", width: 1024, height: 1024 },
  dynamicParamFields: (instance) => [
    ...noiseFields(instance),
    { id: "slice", label: "Slice (Z, 0-1 wraps)", kind: "number", step: 0.01 },
    { id: "speed", label: "Loop Speed (loops per second)", kind: "number", step: 0.01 },
    ...outputSizeFields(instance.params, false),
  ],
  evaluate: (inputs, params, ctx) => {
    const renderer = ctx.renderer;
    if (!renderer) return { texture: null };
    const settings = readSettings(inputs, params);
    const [width, height] = resolveOutputSize(params, []);
    // Square cells on a non-square output: more of them across the long side, still a whole number so it tiles.
    settings.frequency[0] = tileFrequency((settings.frequency[1] * width) / height);
    const z = num(inputs.slice ?? params.slice, 0) + num(inputs.speed ?? params.speed, 0) * ctx.time;
    const wrappedZ = z - Math.floor(z);

    let state = noise2dCache.get(ctx.nodeId);
    if (!state) {
      state = createGpuPassState();
      noise2dCache.set(ctx.nodeId, state);
    }
    const target = (state.targets.out = ensurePassTarget(state.targets.out, width, height, THREE.LinearSRGBColorSpace));
    const signature = `${tileableSignature(settings)}|${wrappedZ}|${target.texture.uuid}`;
    if (state.signatures.get(renderer) !== signature) {
      const material = (state.materials.main ??= createTileableMaterial());
      bindPassInputs(material, []);
      setTileableUniforms(material, settings, wrappedZ);
      renderPass(renderer, material, target);
      state.signatures.set(renderer, signature);
    }
    return { texture: target.texture };
  },
};

// ---------------------------------------------------------------- 3D

const RESOLUTIONS = ["auto", "32", "64", "128", "256"];
const RESOLUTION_LABELS = ["Auto (by pattern)", "32³", "64³", "128³", "256³"];

/** The original's sizes: 128³ for the base shape, 32³ for erosion detail. */
export function volumeResolution(value: unknown, pattern: TileablePattern): number {
  const n = Number(value);
  if (RESOLUTIONS.includes(String(value)) && n > 0) return n;
  if (pattern === "cloud-shape") return 128;
  if (pattern === "cloud-detail") return 32;
  return 64;
}

const volumeCache = createNodeCache<TileableVolumeState>(disposeTileableVolumeState);

export const TEXTURE_TILEABLE_VOLUME_NODE: NodeDefinition = {
  type: "texture/tileable-volume",
  label: "Tileable Noise Volume (3D)",
  category: "texture",
  inputs: SHARED_INPUTS,
  outputs: [
    { id: "volume", label: "Volume (3D)", type: "texture" },
    { id: "ready", label: "Ready", type: "value" },
  ],
  defaultParams: { ...SHARED_DEFAULTS, pattern: "cloud-shape", resolution: "auto" },
  dynamicParamFields: (instance) => [
    ...noiseFields(instance),
    { id: "resolution", label: "Resolution", kind: "select", options: RESOLUTIONS, optionLabels: RESOLUTION_LABELS },
  ],
  evaluate: (inputs, params, ctx) => {
    const renderer = ctx.renderer;
    if (!renderer) return { volume: null, ready: 0 };
    const settings = readSettings(inputs, params);
    const size = volumeResolution(params.resolution, settings.pattern);
    let state = volumeCache.get(ctx.nodeId);
    if (!state) {
      state = createTileableVolumeState();
      volumeCache.set(ctx.nodeId, state);
    }
    const { texture, complete } = updateTileableVolume(renderer, state, settings, size);
    return { volume: texture, ready: complete ? 1 : 0 };
  },
};
