import * as THREE from "three";
import { getAudioContext } from "../../audio/audioStore";
import { LipsyncAnalyzer, VISEMES, Viseme } from "../../audio/lipsync";
import { createNodeCache } from "../nodeCaches";
import { NodeDefinition } from "../types";

/**
 * Each viseme reduced to three mouth gestures, so a lip sync can drive anything that takes a
 * number — a metaball's carve, a scale, a light — not only a rig with viseme shape keys.
 * Open: the jaw drops. Wide: the lips stretch sideways. Round: the lips purse forward.
 */
const MOUTH_SHAPE: Record<Viseme, { open: number; wide: number; round: number }> = {
  viseme_sil: { open: 0, wide: 0, round: 0 },
  viseme_PP: { open: 0, wide: 0, round: 0.2 },
  viseme_FF: { open: 0.15, wide: 0.3, round: 0 },
  viseme_TH: { open: 0.2, wide: 0.3, round: 0 },
  viseme_DD: { open: 0.3, wide: 0.4, round: 0 },
  viseme_kk: { open: 0.35, wide: 0.3, round: 0 },
  viseme_CH: { open: 0.25, wide: 0, round: 0.7 },
  viseme_SS: { open: 0.15, wide: 0.7, round: 0 },
  viseme_nn: { open: 0.2, wide: 0.3, round: 0 },
  viseme_RR: { open: 0.3, wide: 0, round: 0.5 },
  viseme_aa: { open: 1, wide: 0.3, round: 0 },
  viseme_E: { open: 0.6, wide: 0.8, round: 0 },
  viseme_I: { open: 0.45, wide: 1, round: 0 },
  viseme_O: { open: 0.8, wide: 0, round: 0.8 },
  viseme_U: { open: 0.4, wide: 0, round: 1 },
};

interface LipsyncState {
  analyser: AnalyserNode;
  detector: LipsyncAnalyzer;
  weights: number[];
  connected: Set<AudioNode>;
  lastMs: number;
}

const lipsyncCache = createNodeCache<LipsyncState>((state) => {
  try {
    state.analyser.disconnect();
  } catch {}
  for (const source of state.connected) {
    try {
      source.disconnect(state.analyser);
    } catch {}
  }
});

function getOrCreateLipsync(nodeId: string): LipsyncState | null {
  const existing = lipsyncCache.get(nodeId);
  if (existing) return existing;
  const ctx = getAudioContext();
  if (!ctx) return null;
  const analyser = ctx.createAnalyser();
  // The detector reads the newest 1024 samples (~21 ms): short enough to catch a consonant, long enough for a formant.
  analyser.fftSize = 1024;
  const state: LipsyncState = {
    analyser,
    detector: new LipsyncAnalyzer(analyser),
    weights: VISEMES.map(() => 0),
    connected: new Set(),
    lastMs: 0,
  };
  lipsyncCache.set(nodeId, state);
  return state;
}

function audioSourceOf(input: unknown): AudioNode | null {
  if (!input || typeof input !== "object") return null;
  const { gainNode, sourceNode } = input as { gainNode?: unknown; sourceNode?: unknown };
  if (typeof AudioNode === "undefined") return null;
  if (gainNode instanceof AudioNode) return gainNode;
  if (sourceNode instanceof AudioNode) return sourceNode;
  return null;
}

const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

const SILENT = {
  viseme: "viseme_sil",
  index: 0,
  weights: VISEMES.map(() => 0),
  open: 0,
  wide: 0,
  round: 0,
  volume: 0,
};

/**
 * Lip Sync — reads speech from an audio source and says which mouth shape is being made, live.
 * Open / Wide / Round are plain 0..1 values for driving anything; `Weights` holds the 15 visemes
 * (the Oculus / Ready Player Me set) for an avatar's own shape keys through Morph Targets, or a
 * List Item. Detection is by formants and fricative hiss (see audio/lipsync.ts).
 */
export const LIPSYNC_NODE: NodeDefinition = {
  type: "sound/lipsync",
  label: "Lip Sync",
  category: "sound",
  inputs: [
    { id: "audio", label: "Audio In", type: "any" },
    { id: "attack", label: "Attack (s)", type: "value" },
    { id: "release", label: "Release (s)", type: "value" },
  ],
  outputs: [
    { id: "viseme", label: "Viseme", type: "text" },
    { id: "index", label: "Viseme Index", type: "value" },
    { id: "weights", label: "Weights (15)", type: "list" },
    { id: "open", label: "Open", type: "value" },
    { id: "wide", label: "Wide", type: "value" },
    { id: "round", label: "Round", type: "value" },
    { id: "volume", label: "Volume", type: "value" },
  ],
  defaultParams: { attack: 0.04, release: 0.12 },
  paramFields: [
    { id: "attack", label: "Attack — how fast a shape forms (s)", kind: "number", step: 0.01 },
    { id: "release", label: "Release — how fast it lets go (s)", kind: "number", step: 0.01 },
    {
      id: "visemeNote",
      label: "Weights follow: sil PP FF TH DD kk CH SS nn RR aa E I O U",
      kind: "note",
    },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getOrCreateLipsync(ctx.nodeId);
    if (!state) return { ...SILENT, weights: [...SILENT.weights] };

    const source = audioSourceOf(inputs.audio);
    if (source && !state.connected.has(source)) {
      for (const old of state.connected) {
        try {
          old.disconnect(state.analyser);
        } catch {}
      }
      state.connected.clear();
      try {
        source.connect(state.analyser);
        state.connected.add(source);
      } catch {}
    }

    const now = nowMs();
    const dt = state.lastMs > 0 ? Math.min(0.25, (now - state.lastMs) / 1000) : 1 / 60;
    state.lastMs = now;

    const viseme = state.connected.size > 0 ? state.detector.process() : "viseme_sil";
    const attack = Math.max(0.001, Number(inputs.attack ?? params.attack) || 0.04);
    const release = Math.max(0.001, Number(inputs.release ?? params.release) || 0.12);
    const riseK = 1 - Math.exp(-dt / attack);
    const fallK = 1 - Math.exp(-dt / release);

    let open = 0;
    let wide = 0;
    let round = 0;
    VISEMES.forEach((v, i) => {
      const target = v === viseme ? 1 : 0;
      const w = state.weights[i];
      state.weights[i] = w + (target - w) * (target > w ? riseK : fallK);
      open += state.weights[i] * MOUTH_SHAPE[v].open;
      wide += state.weights[i] * MOUTH_SHAPE[v].wide;
      round += state.weights[i] * MOUTH_SHAPE[v].round;
    });

    return {
      viseme,
      index: VISEMES.indexOf(viseme),
      weights: [...state.weights],
      open: Math.min(1, open),
      wide: Math.min(1, wide),
      round: Math.min(1, round),
      volume: state.detector.features?.volume ?? 0,
    };
  },
};

const DEFAULT_SHAPE_NAMES = VISEMES.join(", ");

/**
 * Morph Targets — sets a model's shape keys (blend shapes) by name from a list of weights:
 * Weights[i] goes to the i-th name. Every mesh under the input that has a key of that name
 * gets it, so a glTF avatar split into head, teeth and tongue moves as one.
 *
 * Writes the influences on the incoming meshes rather than a copy: they are runtime pose, like a
 * bone's rotation, which the loader never sets — and cloning a skinned avatar to own them would
 * hand every downstream node a different object each time the weights moved.
 */
export const MORPH_TARGETS_NODE: NodeDefinition = {
  type: "object/morph-targets",
  label: "Morph Targets",
  category: "object",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "weights", label: "Weights", type: "list" },
    { id: "strength", label: "Strength", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matched", label: "Matched Keys", type: "value" },
  ],
  defaultParams: { names: DEFAULT_SHAPE_NAMES, strength: 1 },
  paramFields: [
    { id: "names", label: "Shape key names, comma-separated (default: the 15 visemes)", kind: "text" },
    { id: "strength", label: "Strength", kind: "number", step: 0.05 },
  ],
  evaluate: (inputs, params) => {
    const root = inputs.geometry;
    if (!(root instanceof THREE.Object3D)) return { geometry: undefined, matched: 0 };

    const names = String(params.names ?? DEFAULT_SHAPE_NAMES)
      .split(",")
      .map((s) => s.trim());
    const weights = Array.isArray(inputs.weights) ? inputs.weights : [];
    const rawStrength = Number(inputs.strength ?? params.strength);
    const strength = Number.isFinite(rawStrength) ? rawStrength : 1;

    const matchedNames = new Set<string>();
    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const dict = child.morphTargetDictionary;
      const influences = child.morphTargetInfluences;
      if (!dict || !influences) return;
      names.forEach((name, i) => {
        const slot = dict[name];
        if (slot === undefined || !name) return;
        const w = Number(weights[i]);
        influences[slot] = Number.isFinite(w) ? w * strength : 0;
        matchedNames.add(name);
      });
    });

    return { geometry: root, matched: matchedNames.size };
  },
};
