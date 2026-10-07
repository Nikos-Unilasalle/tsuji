import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { createPRNG } from "../../math/random";
import { valueNoise3 } from "../../math/valueNoise";
import { Curve3, polylineCurve, vectorsSignature } from "../curveLists";
import { DEFAULT_PROFILE_POINTS, evalProfileCurve, ProfilePoint } from "../profileCurve";
import { composeNativeMatrix } from "./transform";
import { COMMON_DEFAULT_PARAMS, NATIVE_TRANSFORM_PARAM_FIELDS } from "./object";

function num(input: unknown, param: unknown, fallback: number): number {
  const n = Number(input !== undefined ? input : param);
  return Number.isFinite(n) ? n : fallback;
}

function int(input: unknown, param: unknown, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(num(input, param, fallback))));
}

/* -------------------------------------------------------------------------- */
/* Silhouette Layers (type id curve/ridge-layers, kept for saved files)       */
/* -------------------------------------------------------------------------- */

const ENVELOPES = ["arch", "bell", "dome", "none", "curve"] as const;
type Envelope = (typeof ENVELOPES)[number];

const NOISE_SPACES = ["relative", "world"] as const;

/**
 * Named shapes for the node, each just a set of the generic settings below.
 * Peak, Mesa, Long Range and Water Line are the four Shan Shui landforms
 * this node began as; they are presets now, not code.
 */
const SHAPE_PRESETS: Record<string, Record<string, unknown>> = {
  peak: { envelope: "arch", noiseSpace: "relative", noiseOffset: 10, layerDrift: 0.15, clipTop: false },
  plateau: { envelope: "bell", noiseSpace: "relative", noiseOffset: 10, layerDrift: 0.1, clipTop: true, chop: 0.3 },
  range: { envelope: "dome", noiseSpace: "world", noiseOffset: 0, layerDrift: 0.3, clipTop: false },
  flat: { envelope: "none", noiseSpace: "world", noiseOffset: 0, layerDrift: 0.5, clipTop: false, shrink: 0 },
};

/**
 * Files saved before the node was generic carry only `profile`, which stood
 * for a fixed formula. Spell that formula out in today's settings. Two
 * profiles also bent shared values: the plateau's bell peaked at twice the
 * height (so height doubles and its clip halves to match), and the long
 * range read its noise at half the frequency.
 */
function upgradeRidgeParams(params: Record<string, unknown>): Record<string, unknown> {
  if ("envelope" in params) return params;
  const profile = String(params.profile ?? "peak");
  const preset = SHAPE_PRESETS[profile] ?? SHAPE_PRESETS.peak;
  const out: Record<string, unknown> = { ...params, ...preset, profile: profile in SHAPE_PRESETS ? profile : "peak" };
  if (profile === "plateau") {
    out.height = num(undefined, params.height, 3) * 2;
    out.chop = num(undefined, params.chop, 0.55) / 2;
  }
  if (profile === "range") out.frequency = num(undefined, params.frequency, 1) * 0.5;
  return out;
}

interface RidgeOutput {
  stacks: Curve3[][];
  outlines: Curve3[];
  layers: Curve3[];
  count: number;
}

interface RidgeState {
  signature?: string;
  value?: RidgeOutput;
  preview: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
}

const ridgeCache = createNodeCache<RidgeState>((s) => {
  s.preview.geometry.dispose();
  s.preview.material.dispose();
});

/** Same grey as a Curve Primitive's preview line — an editing aid, hidden in the camera/output view. */
const PREVIEW_COLOR = 0x9ca3af;

function ridgeState(nodeId: string): RidgeState {
  let state = ridgeCache.get(nodeId);
  if (!state) {
    const preview = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: PREVIEW_COLOR }));
    preview.matrixAutoUpdate = false;
    preview.userData.nodeId = nodeId;
    preview.userData.isHelper = true;
    state = { preview };
    ridgeCache.set(nodeId, state);
  }
  return state;
}

/** The outermost silhouette of every stack: the inner layers would bury the drawing in grey lines. */
function previewGeometry(stacks: THREE.Vector3[][][]): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const stack of stacks) {
    for (const layer of stack.slice(0, 1)) {
      for (let i = 1; i < layer.length; i++) {
        const a = layer[i - 1];
        const b = layer[i];
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

interface SilhouetteShape {
  envelope: Envelope;
  envelopeCurve: ProfilePoint[];
  frequency: number;
  /** Noise read across the shape (stretches with its width) or in world units (fixed size). */
  worldNoise: boolean;
  noiseOffset: number;
  /** How far the noise moves on from one layer to the next. */
  layerDrift: number;
  clipTop: boolean;
  /** Clip height, × height. */
  clip: number;
  shrink: number;
  drop: number;
}

/** The envelope's height at t (0-1 across the shape). */
function envelopeAt(shape: SilhouetteShape, t: number): number {
  const c = t - 0.5;
  if (shape.envelope === "arch") return Math.cos(c * Math.PI);
  if (shape.envelope === "bell") return (Math.cos(c * Math.PI * 2) + 1) / 2;
  if (shape.envelope === "dome") return Math.sqrt(Math.max(0, Math.sin(Math.PI * t)));
  if (shape.envelope === "curve") return evalProfileCurve(shape.envelopeCurve, t);
  return 1;
}

/**
 * One shape's nested outlines, outermost first, in the node's local space
 * (XY, a front view). Each layer is the envelope modulated by noise, shrunk
 * towards the middle and drifted slightly down, so the stack reads as one
 * form's folds rather than as concentric copies — a mountain's ridges, a
 * dune's crests, a crowd's skyline. With no envelope the noise is centred on
 * the baseline instead: a water line, a horizon, a strata band.
 */
function silhouetteStack(
  shape: SilhouetteShape,
  anchor: THREE.Vector3,
  width: number,
  height: number,
  layers: number,
  resolution: number,
  noiseSeed: number,
  rng: () => number,
): THREE.Vector3[][] {
  const stack: THREE.Vector3[][] = [];
  const span = shape.worldNoise ? width : Math.PI;
  let sink = 0;
  for (let j = 0; j < layers; j++) {
    sink += rng() * shape.drop;
    const p = 1 - (j / layers) * shape.shrink;
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < resolution; i++) {
      const t = i / (resolution - 1);
      const n = valueNoise3((t - 0.5) * span * shape.frequency + shape.noiseOffset, j * shape.layerDrift, noiseSeed);
      let y = shape.envelope === "none" ? (n - 0.47) * height * p : envelopeAt(shape, t) * n * height * p;
      if (shape.clipTop) y = Math.min(y, height * shape.clip);
      points.push(new THREE.Vector3(anchor.x + (t - 0.5) * width * p, anchor.y + y - sink, anchor.z));
    }
    stack.push(points);
  }
  return stack;
}

/**
 * Silhouette Layers — nested outlines of a shape, one stack per anchor: an
 * envelope (arch, bell, dome, a drawn curve, or none) modulated by noise,
 * repeated in layers that shrink and sink. Mountains, dunes, waves, cloud
 * banks, skylines, water lines. Shape Preset recalls named looks; every
 * setting it fills stays editable.
 */
export const RIDGE_LAYERS_NODE: NodeDefinition = {
  type: "curve/ridge-layers",
  label: "Silhouette Layers",
  category: "curve",
  inputs: [
    { id: "anchors", label: "Anchors (Vector List)", type: "list" },
    { id: "scales", label: "Scales (List)", type: "list" },
    { id: "width", label: "Width", type: "value" },
    { id: "height", label: "Height", type: "value" },
    { id: "seed", label: "Seed", type: "value" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "visible", label: "Visible", type: "value" },
  ],
  outputs: [
    { id: "stacks", label: "Stacks (List of Lists)", type: "list" },
    { id: "outlines", label: "Outlines (List)", type: "list" },
    { id: "layers", label: "All Layers (List)", type: "list" },
    { id: "count", label: "Count", type: "value" },
    { id: "geometry", label: "Curve Preview", type: "geometry" },
  ],
  defaultParams: {
    visible: COMMON_DEFAULT_PARAMS.visible,
    location: COMMON_DEFAULT_PARAMS.location,
    rotation: COMMON_DEFAULT_PARAMS.rotation,
    scale: COMMON_DEFAULT_PARAMS.scale,
    showPivot: COMMON_DEFAULT_PARAMS.showPivot,
    pivot: COMMON_DEFAULT_PARAMS.pivot,
    inheritRotation: COMMON_DEFAULT_PARAMS.inheritRotation,
    inheritScale: COMMON_DEFAULT_PARAMS.inheritScale,
    profile: "peak",
    ...SHAPE_PRESETS.peak,
    envelopeCurve: DEFAULT_PROFILE_POINTS,
    width: 5,
    height: 3,
    sizeJitter: 0.3,
    layers: 10,
    resolution: 50,
    frequency: 1,
    shrink: 1,
    drop: 0.03,
    chop: 0.55,
    seed: 0,
  },
  upgradeParams: upgradeRidgeParams,
  paramFields: [
    ...NATIVE_TRANSFORM_PARAM_FIELDS,
    {
      id: "profile",
      label: "Shape Preset",
      kind: "select",
      options: ["custom", ...Object.keys(SHAPE_PRESETS)],
      optionLabels: ["Custom", "Peak", "Mesa", "Long Range", "Water Line"],
      presets: SHAPE_PRESETS,
      group: "Shape",
    },
    {
      id: "envelope",
      label: "Envelope",
      kind: "select",
      options: [...ENVELOPES],
      optionLabels: ["Arch", "Bell", "Dome", "None", "Drawn Curve"],
      group: "Shape",
    },
    { id: "envelopeCurve", label: "Envelope Curve", kind: "curve_profile", group: "Shape" },
    { id: "width", label: "Width", kind: "number", step: 0.1, group: "Shape" },
    { id: "height", label: "Height", kind: "number", step: 0.1, group: "Shape" },
    { id: "sizeJitter", label: "Size Jitter", kind: "number", step: 0.05, percent: true, group: "Shape" },
    { id: "clipTop", label: "Clip the Top Flat", kind: "boolean", group: "Shape" },
    { id: "chop", label: "Clip Height", kind: "number", step: 0.05, group: "Shape" },
    { id: "seed", label: "Seed", kind: "number", step: 1, group: "Shape" },
    { id: "frequency", label: "Frequency", kind: "number", step: 0.1, group: "Noise" },
    {
      id: "noiseSpace",
      label: "Noise Scale",
      kind: "select",
      options: [...NOISE_SPACES],
      optionLabels: ["Across the Shape", "World Units"],
      group: "Noise",
    },
    { id: "noiseOffset", label: "Noise Offset", kind: "number", step: 0.1, group: "Noise" },
    { id: "layerDrift", label: "Noise Drift per Layer", kind: "number", step: 0.05, group: "Noise" },
    { id: "layers", label: "Layers", kind: "number", step: 1, group: "Layers" },
    { id: "resolution", label: "Points per Layer", kind: "number", step: 5, group: "Layers" },
    { id: "shrink", label: "Layer Shrink", kind: "number", step: 0.05, group: "Layers" },
    { id: "drop", label: "Layer Drop", kind: "number", step: 0.01, group: "Layers" },
  ],
  evaluate: (inputs, params, ctx) => {
    const envelope = (ENVELOPES as readonly string[]).includes(String(params.envelope)) ? (params.envelope as Envelope) : "arch";
    const shape: SilhouetteShape = {
      envelope,
      envelopeCurve: Array.isArray(params.envelopeCurve) ? (params.envelopeCurve as ProfilePoint[]) : DEFAULT_PROFILE_POINTS,
      frequency: num(undefined, params.frequency, 1),
      worldNoise: params.noiseSpace === "world",
      noiseOffset: num(undefined, params.noiseOffset, 10),
      layerDrift: num(undefined, params.layerDrift, 0.15),
      clipTop: Boolean(params.clipTop),
      clip: num(undefined, params.chop, 0.55),
      shrink: Math.max(0, Math.min(1, num(undefined, params.shrink, 1))),
      drop: num(undefined, params.drop, 0.03),
    };
    const anchors = Array.isArray(inputs.anchors)
      ? inputs.anchors.filter((a): a is THREE.Vector3 => a instanceof THREE.Vector3)
      : [new THREE.Vector3()];
    const scales = Array.isArray(inputs.scales) ? inputs.scales : [];
    const width = Math.max(0.01, num(inputs.width, params.width, 5));
    const height = num(inputs.height, params.height, 3);
    const jitter = Math.max(0, Math.min(1, num(undefined, params.sizeJitter, 0.3)));
    const layers = int(undefined, params.layers, 10, 1, 64);
    const resolution = int(undefined, params.resolution, 50, 3, 400);
    const seed = Math.round(num(inputs.seed, params.seed, 0));

    const state = ridgeState(ctx.nodeId);
    const pose = composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params);
    // While the gizmo drags this node the viewport owns the preview's matrix.
    if (ctx.nodeId !== ctx.liveEditNodeId) state.preview.matrix.copy(pose);

    const signature = JSON.stringify([
      vectorsSignature(anchors),
      vectorsSignature(scales),
      shape, width, height, jitter, layers, resolution, seed,
      pose.elements.map((e) => e.toFixed(6)).join(","),
    ]);
    if (state.value && state.signature === signature) return { ...state.value, geometry: state.preview };

    const local = anchors.map((anchor, m) => {
      const rng = createPRNG(seed * 7919 + m * 104729 + 1);
      const scale = Number.isFinite(Number(scales[m])) && scales[m] !== undefined ? Number(scales[m]) : 1;
      const w = width * scale * (1 + jitter * (rng() * 2 - 1));
      const h = height * scale * (1 + jitter * (rng() * 2 - 1));
      return silhouetteStack(shape, anchor, w, h, layers, resolution, seed * 13.7 + m * 3.17, rng);
    });
    // The curves leave in world space, the pose already applied — the way
    // Curve to Points bakes its curve's pose — so the hatching, scattering and
    // ink built from them downstream follow this node's gizmo with no pose of
    // their own to carry. The preview keeps the local points under the pose,
    // which is what lets the gizmo sit on it.
    const stacks = local.map((stack) => stack.map((points) => polylineCurve(points.map((p) => p.clone().applyMatrix4(pose)))));
    state.preview.geometry.dispose();
    state.preview.geometry = previewGeometry(local);
    const value: RidgeOutput = {
      stacks,
      outlines: stacks.map((s) => s[0]),
      layers: stacks.flat(),
      count: stacks.length,
    };
    state.signature = signature;
    state.value = value;
    return { ...value, geometry: state.preview };
  },
};
