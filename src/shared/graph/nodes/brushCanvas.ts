import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { getCurveNodePose } from "../curvePoseStore";
import { parseColorHex } from "./greasePencil";
import {
  BRUSH_FIELDS,
  BRUSH_NAMES,
  BrushFillMode,
  BrushScene,
  asCurveList,
  buildBrushPaths,
} from "../../three/brushScene";
import { brushEngineAvailable } from "../../three/brushEngine";
import { BrushTextureCache } from "../../three/brushTextureCache";

// Watercolor fills cost tens of milliseconds each; a node only repaints
// when something that changes pixels changed (see BrushTextureCache).
const brushCanvasCache = createNodeCache<BrushTextureCache>((c) => c.dispose());

const RESOLUTIONS: Record<string, [number, number]> = {
  "1024x1024": [1024, 1024],
  "2048x2048": [2048, 2048],
  "1920x1080": [1920, 1080],
  "1080x1920": [1080, 1920],
  "1280x720": [1280, 720],
  "512x512": [512, 512],
};

// p5.brush's built-in brushes are tuned for a ~200px-wide canvas; its README
// recommends scaleBrushes(3) at 600px, i.e. one unit per 200px.
const BRUSH_SCALE_REFERENCE = 200;

function num(input: unknown, param: unknown, fallback: number): number {
  const n = Number(input !== undefined ? input : param);
  return Number.isFinite(n) ? n : fallback;
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function buildBrushCanvasScene(
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
  ctx: { time: number; step: number; currentFrame?: number; inputSources?: ReadonlyMap<string, string> },
): BrushScene {
  const [width, height] = RESOLUTIONS[String(params.resolution)] ?? RESOLUTIONS["1024x1024"];

  const sourceId = ctx.inputSources?.get("curves");
  const pose = sourceId ? getCurveNodePose(sourceId) : undefined;
  const center = params.frameCenter instanceof THREE.Vector3 ? params.frameCenter : new THREE.Vector3();
  const paths = buildBrushPaths(
    asCurveList(inputs.curves),
    {
      mode: params.frameMode === "fixed" ? "fixed" : "auto",
      margin: num(undefined, params.frameMargin, 0.1),
      center,
      size: Math.max(1e-3, num(undefined, params.frameSize, 10)),
    },
    width,
    height,
    pose,
  );

  // Boil: re-seed every N frames — the hand-redrawn shimmer of traditional
  // animation, where no two drawings of a held pose are identical.
  const boil = Math.max(0, Math.round(num(inputs.boil, params.boil, 0)));
  const baseSeed = Math.round(num(inputs.seed, params.seed, 1));
  const frame = ctx.currentFrame ?? ctx.step;
  const seed = boil > 0 ? baseSeed + Math.floor(frame / boil) : baseSeed;

  const strokeColor = parseColorHex(inputs.strokeColor ?? params.strokeColor, "#2f2a26");
  const fillColor = parseColorHex(inputs.fillColor ?? params.fillColor, "#3b6fb6");
  const fillMode = pick<BrushFillMode>(params.fillMode, ["none", "watercolor", "wash"], "watercolor");
  const randomBleedDir = params.bleedRandomDirection !== false;

  return {
    width,
    height,
    background: params.transparent ? null : parseColorHex(params.background, "#f6f1e8"),
    seed,
    brushScale: (Math.min(width, height) / BRUSH_SCALE_REFERENCE) * Math.max(0.05, num(undefined, params.brushScale, 1)),
    field: pick(params.field, BRUSH_FIELDS, "none"),
    fieldTime: ctx.time * num(undefined, params.fieldSpeed, 0),
    wiggle: Math.max(0, num(undefined, params.wiggle, 0)),
    curvature: clamp01(num(undefined, params.curvature, 0.5)),
    useStrokeColors: Boolean(params.useStrokeColors),
    stroke: {
      enabled: params.strokeEnabled !== false,
      brush: pick(params.strokeBrush, BRUSH_NAMES, "2B"),
      color: strokeColor,
      weight: Math.max(0.01, num(inputs.strokeWeight, params.strokeWeight, 1.5)),
    },
    fill: {
      mode: fillMode,
      color: fillColor,
      opacity: Math.max(1, Math.min(255, num(inputs.fillOpacity, params.fillOpacity, 120))),
      bleed: clamp01(num(inputs.bleed, params.bleed, 0.25)),
      bleedDirection: params.bleedDirection === "in" ? "in" : "out",
      bleedAngle: randomBleedDir ? null : num(undefined, params.bleedAngle, 0),
      texture: clamp01(num(undefined, params.fillTexture, 0.4)),
      border: clamp01(num(undefined, params.fillBorder, 0.4)),
      scatter: params.fillScatter !== false,
    },
    hatch: {
      enabled: Boolean(params.hatchEnabled),
      brush: pick(params.hatchBrush, BRUSH_NAMES, "rotring"),
      color: parseColorHex(params.hatchColor, "#2f2a26"),
      weight: Math.max(0.01, num(undefined, params.hatchWeight, 0.8)),
      distance: Math.max(1, num(undefined, params.hatchDistance, 8)),
      angle: num(undefined, params.hatchAngle, 45),
      rand: clamp01(num(undefined, params.hatchRand, 0.1)),
      gradient: clamp01(num(undefined, params.hatchGradient, 0)),
    },
    paths,
  };
}

const WATERCOLOR_LOOKS: Record<string, Record<string, unknown>> = {
  soft: { fillMode: "watercolor", fillOpacity: 90, bleed: 0.2, bleedDirection: "out", fillTexture: 0.3, fillBorder: 0.25, fillScatter: true },
  wet: { fillMode: "watercolor", fillOpacity: 70, bleed: 0.55, bleedDirection: "out", fillTexture: 0.6, fillBorder: 0.5, fillScatter: true },
  granulated: { fillMode: "watercolor", fillOpacity: 140, bleed: 0.1, bleedDirection: "in", fillTexture: 0.9, fillBorder: 0.3, fillScatter: true },
  ink: { fillMode: "watercolor", fillOpacity: 200, bleed: 0.05, bleedDirection: "in", fillTexture: 0.15, fillBorder: 0.8, fillScatter: false },
};

export const BRUSH_CANVAS_NODE: NodeDefinition = {
  type: "texture/brush-canvas",
  label: "Brush Canvas (p5.brush)",
  category: "texture",
  inputs: [
    { id: "curves", label: "Curves", type: "curve" },
    { id: "strokeColor", label: "Stroke Color", type: "color" },
    { id: "fillColor", label: "Fill Color", type: "color" },
    { id: "strokeWeight", label: "Stroke Weight", type: "value" },
    { id: "fillOpacity", label: "Fill Opacity", type: "value" },
    { id: "bleed", label: "Bleed", type: "value" },
    { id: "seed", label: "Seed", type: "value" },
    { id: "boil", label: "Boil (frames)", type: "value" },
  ],
  outputs: [{ id: "texture", label: "Texture", type: "texture" }],
  defaultParams: {
    resolution: "1024x1024",
    background: "#f6f1e8",
    transparent: false,
    frameMode: "auto",
    frameMargin: 0.1,
    frameCenter: new THREE.Vector3(0, 0, 0),
    frameSize: 10,
    seed: 1,
    boil: 0,
    brushScale: 1,
    curvature: 0.5,
    strokeEnabled: true,
    strokeBrush: "2B",
    strokeColor: "#2f2a26",
    strokeWeight: 1.5,
    useStrokeColors: false,
    fillMode: "watercolor",
    watercolorLook: "custom",
    fillColor: "#3b6fb6",
    fillOpacity: 120,
    bleed: 0.25,
    bleedDirection: "out",
    bleedRandomDirection: true,
    bleedAngle: 0,
    fillTexture: 0.4,
    fillBorder: 0.4,
    fillScatter: true,
    hatchEnabled: false,
    hatchBrush: "rotring",
    hatchColor: "#2f2a26",
    hatchWeight: 0.8,
    hatchDistance: 8,
    hatchAngle: 45,
    hatchRand: 0.1,
    hatchGradient: 0,
    field: "none",
    fieldSpeed: 0,
    wiggle: 0,
  },
  paramFields: [
    { id: "resolution", label: "Resolution", kind: "select", options: Object.keys(RESOLUTIONS) },
    { id: "background", label: "Paper", kind: "color" },
    { id: "transparent", label: "Transparent", kind: "boolean" },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
    { id: "boil", label: "Boil (frames, 0 = off)", kind: "number", step: 1 },
    { id: "brushScale", label: "Brush Scale", kind: "number", step: 0.1 },
    { id: "curvature", label: "Curvature", kind: "number", step: 0.05 },

    { id: "frameMode", label: "Framing", kind: "select", options: ["auto", "fixed"], group: "Frame" },
    { id: "frameMargin", label: "Margin", kind: "number", step: 0.01, percent: true, group: "Frame" },
    { id: "frameCenter", label: "Center", kind: "vector", group: "Frame" },
    { id: "frameSize", label: "Width (world units)", kind: "number", step: 0.5, group: "Frame" },

    { id: "strokeEnabled", label: "Stroke", kind: "boolean", group: "Stroke" },
    { id: "strokeBrush", label: "Brush", kind: "select", options: [...BRUSH_NAMES], group: "Stroke" },
    { id: "strokeColor", label: "Color", kind: "color", group: "Stroke" },
    { id: "strokeWeight", label: "Weight", kind: "number", step: 0.1, group: "Stroke" },
    { id: "useStrokeColors", label: "Use Grease Pencil Colors", kind: "boolean", group: "Stroke" },

    {
      id: "fillMode",
      label: "Fill",
      kind: "select",
      options: ["none", "watercolor", "wash"],
      optionLabels: ["None", "Watercolor", "Flat Wash"],
      group: "Watercolor",
    },
    {
      id: "watercolorLook",
      label: "Look",
      kind: "select",
      options: ["custom", ...Object.keys(WATERCOLOR_LOOKS)],
      optionLabels: ["Custom", "Soft Wash", "Wet Bleed", "Granulated", "Ink Blot"],
      presets: WATERCOLOR_LOOKS,
      group: "Watercolor",
    },
    { id: "fillColor", label: "Pigment", kind: "color", group: "Watercolor" },
    { id: "fillOpacity", label: "Opacity (0-255)", kind: "number", step: 5, group: "Watercolor" },
    { id: "bleed", label: "Bleed", kind: "number", step: 0.05, group: "Watercolor" },
    { id: "bleedDirection", label: "Bleed Direction", kind: "select", options: ["out", "in"], group: "Watercolor" },
    { id: "bleedRandomDirection", label: "Random Wash Direction", kind: "boolean", group: "Watercolor" },
    { id: "bleedAngle", label: "Wash Angle (°)", kind: "number", step: 5, group: "Watercolor" },
    { id: "fillTexture", label: "Texture", kind: "number", step: 0.05, group: "Watercolor" },
    { id: "fillBorder", label: "Edge Darkening", kind: "number", step: 0.05, group: "Watercolor" },
    { id: "fillScatter", label: "Edge Scatter", kind: "boolean", group: "Watercolor" },

    { id: "hatchEnabled", label: "Hatch", kind: "boolean", group: "Hatch" },
    { id: "hatchBrush", label: "Brush", kind: "select", options: [...BRUSH_NAMES], group: "Hatch" },
    { id: "hatchColor", label: "Color", kind: "color", group: "Hatch" },
    { id: "hatchWeight", label: "Weight", kind: "number", step: 0.1, group: "Hatch" },
    { id: "hatchDistance", label: "Spacing (px)", kind: "number", step: 1, group: "Hatch" },
    { id: "hatchAngle", label: "Angle (°)", kind: "number", step: 5, group: "Hatch" },
    { id: "hatchRand", label: "Randomness", kind: "number", step: 0.05, group: "Hatch" },
    { id: "hatchGradient", label: "Gradient", kind: "number", step: 0.05, group: "Hatch" },

    { id: "field", label: "Vector Field", kind: "select", options: [...BRUSH_FIELDS], group: "Flow" },
    { id: "fieldSpeed", label: "Field Speed", kind: "number", step: 0.1, group: "Flow" },
    { id: "wiggle", label: "Hand Wiggle", kind: "number", step: 0.5, group: "Flow" },
  ],
  evaluate: (inputs, params, ctx) => {
    if (!brushEngineAvailable()) return { texture: null };

    let cache = brushCanvasCache.get(ctx.nodeId);
    if (!cache) {
      cache = new BrushTextureCache();
      brushCanvasCache.set(ctx.nodeId, cache);
    }
    const frameKey = ctx.isPlaying ? ctx.currentFrame : undefined;
    return { texture: cache.resolve(buildBrushCanvasScene(inputs, params, ctx), frameKey) };
  },
};
