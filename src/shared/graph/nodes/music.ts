import { createNodeCache } from "../nodeCaches";
import { isExportAudioCapturing, recordMusicFrame } from "../../audio/exportAudioCapture";
import { growingSockets } from "../dynamicInputs";
import { NodeDefinition, ParamFieldDef } from "../types";
import { numberInput } from "./object";
import { MusicEngineHandle, musicEngineFor, releaseMusicEngine } from "../../music/engine/bridge";
import {
  DEFAULT_FX,
  MusicDescription,
  MusicValue,
  TrackDescription,
  clockOf,
  isTrack,
  sequenceOf,
} from "../../music/engine/description";
import { FmOperatorPatch, FmPatch } from "../../music/dsp/fm";
import { FM_PRESETS, FM_PRESET_NAMES, fmPreset, fmVoicePreset } from "../../music/dsp/presets";
import { fmAlgorithm } from "../../music/dsp/algorithms";
import { ARP_MODES, ARP_RATES, ArpMode, ArpRate, ArpSettings, DEFAULT_ARP } from "../../music/seq/arp";
import { CHORD_NAMES, ChordName } from "../../music/seq/chords";
import { parsePattern } from "../../music/seq/notation";
import { FELUCCA_PHRASES, phraseSteps } from "../../music/seq/phrases";
import { Cell, Clock, Sequence, notesSoundingAt, notesStartingIn, stepAt, transposeSequence } from "../../music/seq/sequencer";

/**
 * The music nodes (see docs/music-nodes-mvp.md). Every one of them describes; only Music Out plays.
 *
 *   Clock → Pattern → (Arp) → FM Voice / Drum Kit → Music Out
 *                                      └→ Note Probe → anything in the scene
 *
 * All of them pass one socket type, `music`, carrying a clock, a sequence or a track (description.ts). A node reads
 * the shape it wants from it: a Pattern takes its clock from whatever is wired in, a voice takes the sequence, Music
 * Out takes tracks — and a bare sequence wired straight into Music Out plays on the default electric piano.
 */

const DEFAULT_CLOCK: Clock = { bpm: 120, swing: 0, stepsPerBeat: 4 };
/** Note Probe reads the sequence at this rate: any rate gives the same steps and notes, this one avoids rounding. */
const PROBE_RATE = 48_000;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// ── Clock ──────────────────────────────────────────────────────────────────

export const MUSIC_CLOCK_NODE: NodeDefinition = {
  type: "music/clock",
  label: "Clock",
  category: "music",
  pure: true,
  inputs: [
    { id: "bpm", label: "BPM", type: "value" },
    { id: "swing", label: "Swing", type: "value" },
  ],
  outputs: [
    { id: "clock", label: "Clock", type: "music" },
    { id: "bpm", label: "BPM", type: "value" },
  ],
  defaultParams: { bpm: 120, swing: 0, stepsPerBeat: "4" },
  paramFields: [
    { id: "bpm", label: "BPM", kind: "number", step: 1 },
    { id: "swing", label: "Swing (0 straight – 1 = 75/25)", kind: "number", step: 0.05 },
    {
      id: "stepsPerBeat",
      label: "Steps per Beat",
      kind: "select",
      options: ["2", "3", "4", "6", "8"],
      optionLabels: ["2 (eighths)", "3 (eighth triplets)", "4 (sixteenths)", "6 (sixteenth triplets)", "8 (32nds)"],
    },
  ],
  evaluate: (inputs, params) => {
    const clock: Clock = {
      bpm: clamp(numberInput(inputs.bpm, params.bpm, 120), 20, 400),
      swing: clamp(numberInput(inputs.swing, params.swing, 0), 0, 1),
      stepsPerBeat: clamp(Math.round(Number(params.stepsPerBeat) || 4), 1, 16),
    };
    const out: MusicValue = { kind: "clock", clock };
    return { clock: out, bpm: clock.bpm };
  },
};

// ── Pattern ────────────────────────────────────────────────────────────────

const CHORD_OVERRIDES = ["as written", ...CHORD_NAMES];

export const MUSIC_PATTERN_NODE: NodeDefinition = {
  type: "music/pattern",
  label: "Pattern",
  category: "music",
  pure: true,
  inputs: [
    { id: "clock", label: "Clock", type: "music" },
    { id: "transpose", label: "Transpose", type: "value" },
    { id: "chord", label: "Chord (0 as written, 1–11)", type: "value" },
    { id: "velocity", label: "Velocity ×", type: "value" },
  ],
  outputs: [{ id: "sequence", label: "Sequence", type: "music" }],
  defaultParams: {
    steps: "C4:maj7 . . . . . . . A3:min7/1 . . . . . . . F3:maj7/1 . . . . . . . G3:7 . . . . . . .",
    length: "32",
    transpose: 0,
    chord: "as written",
    velocity: 1,
    seed: 0,
  },
  paramFields: [
    {
      id: "steps",
      label: "Steps — one word per step: C4:maj7 . off A3:min7/1@0.6~2!GLD12 (kick snare hat… for drums)",
      kind: "text",
    },
    { id: "length", label: "Length", kind: "select", options: ["16", "32", "64"] },
    {
      id: "phrase",
      label: "Load Phrase (Felucca's factory phrases, by Leo Kuroshita / Hügelton — replaces the steps)",
      kind: "select",
      options: ["—", ...FELUCCA_PHRASES.map((p) => p.name)],
      optionLabels: ["—", ...FELUCCA_PHRASES.map((p) => `${p.name} · ${p.hint}`)],
      presets: Object.fromEntries(FELUCCA_PHRASES.map((p) => [p.name, { steps: phraseSteps(p), length: "16" }])),
    },
    { id: "transpose", label: "Transpose (semitones)", kind: "number", step: 1 },
    { id: "chord", label: "Force Chord", kind: "select", options: CHORD_OVERRIDES },
    { id: "velocity", label: "Velocity ×", kind: "number", step: 0.05 },
    { id: "seed", label: "Seed (chance, random arp)", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params) => {
    // Up to 16384: a whole song can be one long pattern (KAWA QUEST is 416 steps, a converted .mod thousands).
    const length = clamp(Math.round(Number(params.length) || 16), 1, 16384);
    const transpose = Math.round(numberInput(inputs.transpose, params.transpose, 0));
    const velScale = clamp(numberInput(inputs.velocity, params.velocity, 1), 0, 2);
    // A wired chord number picks from the list; unwired, the param's choice.
    const chordIndex = inputs.chord !== undefined ? Math.round(Number(inputs.chord)) : CHORD_OVERRIDES.indexOf(String(params.chord));
    const forced: ChordName | null = chordIndex >= 1 && chordIndex <= CHORD_NAMES.length ? CHORD_NAMES[chordIndex - 1] : null;

    const steps = parsePattern(String(params.steps ?? ""), length).map((c): Cell | null => {
      if (!c || c.note === "off") return c;
      const cell: Cell = { ...c, note: clamp(c.note + transpose, 0, 127) };
      if (forced) cell.chord = forced;
      if (velScale !== 1) cell.velocity = clamp((c.velocity ?? 0.8) * velScale, 0, 1);
      return cell;
    });
    const seq: Sequence = {
      clock: clockOf(inputs.clock) ?? DEFAULT_CLOCK,
      pattern: { length, steps },
      seed: Math.round(Number(params.seed) || 0),
    };
    const out: MusicValue = { kind: "sequence", seq };
    return { sequence: out };
  },
};

// ── Arp ────────────────────────────────────────────────────────────────────

export const MUSIC_ARP_NODE: NodeDefinition = {
  type: "music/arp",
  label: "Arp",
  category: "music",
  pure: true,
  inputs: [
    { id: "sequence", label: "Sequence", type: "music" },
    { id: "octaves", label: "Octaves", type: "value" },
    { id: "gate", label: "Gate", type: "value" },
    { id: "on", label: "On", type: "value" },
  ],
  outputs: [{ id: "sequence", label: "Sequence", type: "music" }],
  defaultParams: { on: true, mode: "up", rate: "1/16", triplet: false, octaves: 1, gate: 0.8, sync: "grid" },
  paramFields: [
    { id: "on", label: "On", kind: "boolean" },
    { id: "mode", label: "Mode", kind: "select", options: [...ARP_MODES], optionLabels: ["Up", "Down", "Up-Down", "Down-Up", "As Played", "Random"] },
    { id: "rate", label: "Rate", kind: "select", options: [...ARP_RATES] },
    { id: "triplet", label: "Triplets", kind: "boolean" },
    { id: "octaves", label: "Octaves (1–4)", kind: "number", step: 1 },
    { id: "gate", label: "Gate (0.1–1)", kind: "number", step: 0.05 },
    { id: "sync", label: "Sync", kind: "select", options: ["grid", "retrigger"], optionLabels: ["On the grid", "Restart with each chord"] },
  ],
  evaluate: (inputs, params) => {
    const seq = sequenceOf(inputs.sequence);
    if (!seq) return { sequence: null };
    const on = inputs.on !== undefined ? Number(inputs.on) > 0 : Boolean(params.on ?? true);
    if (!on) return { sequence: { kind: "sequence", seq: { ...seq, arp: null } } satisfies MusicValue };
    const arp: ArpSettings = {
      mode: (ARP_MODES as readonly string[]).includes(String(params.mode)) ? (params.mode as ArpMode) : DEFAULT_ARP.mode,
      rate: (ARP_RATES as readonly string[]).includes(String(params.rate)) ? (params.rate as ArpRate) : DEFAULT_ARP.rate,
      triplet: Boolean(params.triplet),
      octaves: clamp(Math.round(numberInput(inputs.octaves, params.octaves, 1)), 1, 4),
      gate: clamp(numberInput(inputs.gate, params.gate, 0.8), 0.05, 1),
      sync: params.sync === "retrigger" ? "retrigger" : "grid",
    };
    const out: MusicValue = { kind: "sequence", seq: { ...seq, arp } };
    return { sequence: out };
  },
};

// ── Sends (FM Voice, Drum Kit) ─────────────────────────────────────────────

const SEND_INPUTS = [
  { id: "delaySend", label: "Delay Send", type: "value" as const },
  { id: "reverbSend", label: "Reverb Send", type: "value" as const },
];
const SEND_FIELDS: ParamFieldDef[] = [
  { id: "delaySend", label: "Delay Send (dub echo, set on Music Out)", kind: "number", step: 0.05, group: "Sends" },
  { id: "reverbSend", label: "Reverb Send", kind: "number", step: 0.05, group: "Sends" },
];
function sendsOf(inputs: Record<string, unknown>, params: Record<string, unknown>) {
  return {
    delaySend: clamp(numberInput(inputs.delaySend, params.delaySend, 0), 0, 1),
    reverbSend: clamp(numberInput(inputs.reverbSend, params.reverbSend, 0), 0, 1),
  };
}

// ── FM Voice ───────────────────────────────────────────────────────────────

const OP_FIELDS: { key: keyof FmOperatorPatch; label: string; step: number }[] = [
  { key: "ratio", label: "Ratio", step: 0.5 },
  { key: "detune", label: "Detune (cents)", step: 1 },
  { key: "level", label: "Level", step: 0.05 },
  { key: "velocitySens", label: "Velocity Sensitivity", step: 0.1 },
  { key: "attack", label: "Attack (s)", step: 0.01 },
  { key: "decay", label: "Decay (s)", step: 0.05 },
  { key: "sustain", label: "Sustain", step: 0.05 },
  { key: "release", label: "Release (s)", step: 0.05 },
];

/** Everything a preset sets on the voice: its patch's flat params, and its voice count and transposition. */
function presetParams(name: string): Record<string, unknown> {
  const p = fmVoicePreset(name);
  return { ...patchParams(p.patch), voices: p.voices, transpose: p.transpose };
}

/** The flat params a patch is edited as: algorithm, feedback, op1_ratio … op4_release. */
function patchParams(p: FmPatch): Record<string, unknown> {
  const out: Record<string, unknown> = { algorithm: String(p.algorithm), feedback: p.feedback };
  p.ops.forEach((op, k) => OP_FIELDS.forEach((f) => (out[`op${k + 1}_${f.key}`] = op[f.key])));
  return out;
}

function patchFromParams(params: Record<string, unknown>, base: FmPatch): FmPatch {
  const ops = base.ops.map((op, k) => {
    const o = { ...op };
    for (const f of OP_FIELDS) o[f.key] = numberInput(undefined, params[`op${k + 1}_${f.key}`], op[f.key]);
    return o;
  }) as FmPatch["ops"];
  return {
    algorithm: clamp(Math.round(Number(params.algorithm) || base.algorithm), 1, 8),
    feedback: clamp(numberInput(undefined, params.feedback, base.feedback), 0, 1),
    ops,
  };
}

const OP_PARAM_FIELDS: ParamFieldDef[] = [0, 1, 2, 3].flatMap((k) =>
  OP_FIELDS.map((f) => ({ id: `op${k + 1}_${f.key}`, label: f.label, kind: "number" as const, step: f.step, group: `Operator ${k + 1}` })),
);

export const MUSIC_FM_VOICE_NODE: NodeDefinition = {
  type: "music/fm-voice",
  label: "FM Voice",
  category: "music",
  pure: true,
  inputs: [
    { id: "sequence", label: "Sequence", type: "music" },
    { id: "level", label: "Level", type: "value" },
    { id: "pan", label: "Pan", type: "value" },
    { id: "brightness", label: "Brightness ×", type: "value" },
    { id: "mute", label: "Mute", type: "value" },
    ...SEND_INPUTS,
  ],
  outputs: [{ id: "track", label: "Track", type: "music" }],
  defaultParams: { preset: "E. Piano", voices: 8, transpose: 0, level: 0.8, pan: 0, brightness: 1, mute: false, delaySend: 0, reverbSend: 0, ...patchParams(FM_PRESETS["E. Piano"]) },
  // A voice saved with a preset name but no operator settings (a hand-written or generated file) gets that preset's
  // settings, not the E. Piano defaults the missing keys would otherwise be filled with.
  upgradeParams: (params) => (params.preset !== undefined && params.op1_ratio === undefined ? { ...presetParams(String(params.preset)), ...params } : params),
  paramFields: [
    {
      id: "preset",
      label: "Preset (loads every setting below) — Felucca and SLOOP sounds after ours",
      kind: "select",
      options: FM_PRESET_NAMES,
      presets: Object.fromEntries(FM_PRESET_NAMES.map((n) => [n, presetParams(n)])),
    },
    { id: "level", label: "Level", kind: "number", step: 0.05 },
    { id: "pan", label: "Pan (−1 left, 1 right)", kind: "number", step: 0.1 },
    { id: "brightness", label: "Brightness × (scales the modulators)", kind: "number", step: 0.1 },
    { id: "voices", label: "Voices (1–16, 1 = mono)", kind: "number", step: 1 },
    { id: "transpose", label: "Transpose (semitones)", kind: "number", step: 1 },
    { id: "mute", label: "Mute", kind: "boolean" },
    ...SEND_FIELDS,
    {
      id: "algorithm",
      label: "Algorithm",
      kind: "select",
      options: ["1", "2", "3", "4", "5", "6", "7", "8"],
      optionLabels: ["1 · 4→3→2→1", "2 · (3+4)→2→1", "3 · (3→2)+4→1", "4 · (4→3)+2→1", "5 · 4→3, 2→1", "6 · 4→1,2,3", "7 · 4→3, 2, 1", "8 · 1, 2, 3, 4"],
      group: "Patch",
    },
    { id: "feedback", label: "Feedback (operator 4)", kind: "number", step: 0.05, group: "Patch" },
    ...OP_PARAM_FIELDS,
  ],
  evaluate: (inputs, params, ctx) => {
    const wired = sequenceOf(inputs.sequence);
    if (!wired) return { track: null };
    const seq = transposeSequence(wired, Math.round(Number(params.transpose) || 0));
    const patch = patchFromParams(params, fmPreset(params.preset));
    // Brightness scales what the modulators do (the timbre), leaving the carriers' loudness alone.
    const brightness = clamp(numberInput(inputs.brightness, params.brightness, 1), 0, 4);
    if (brightness !== 1) {
      const carriers = new Set(fmAlgorithm(patch.algorithm).carriers);
      patch.ops = patch.ops.map((op, k) => (carriers.has(k) ? op : { ...op, level: clamp(op.level * brightness, 0, 1) })) as FmPatch["ops"];
    }
    const track: TrackDescription = {
      id: ctx.nodeId,
      kind: "fm",
      voices: clamp(Math.round(Number(params.voices) || 8), 1, 16),
      patch,
      seq,
      level: clamp(numberInput(inputs.level, params.level, 0.8), 0, 2),
      pan: clamp(numberInput(inputs.pan, params.pan, 0), -1, 1),
      mute: inputs.mute !== undefined ? Number(inputs.mute) > 0 : Boolean(params.mute),
      ...sendsOf(inputs, params),
    };
    return { track };
  },
};

// ── Drum Kit ───────────────────────────────────────────────────────────────

export const MUSIC_DRUM_KIT_NODE: NodeDefinition = {
  type: "music/drum-kit",
  label: "Drum Kit",
  category: "music",
  pure: true,
  inputs: [
    { id: "sequence", label: "Sequence", type: "music" },
    { id: "level", label: "Level", type: "value" },
    { id: "pan", label: "Pan", type: "value" },
    { id: "tune", label: "Tune", type: "value" },
    { id: "decay", label: "Decay ×", type: "value" },
    { id: "mute", label: "Mute", type: "value" },
    ...SEND_INPUTS,
  ],
  outputs: [{ id: "track", label: "Track", type: "music" }],
  defaultParams: { level: 0.9, pan: 0, tune: 0, decay: 1, mute: false, delaySend: 0, reverbSend: 0 },
  paramFields: [
    {
      id: "help",
      label: "Pattern words: kick snare clap hat openhat tomlow tomhigh (or GM notes 36 38 39 42 46 45 50)",
      kind: "note",
    },
    { id: "level", label: "Level", kind: "number", step: 0.05 },
    { id: "pan", label: "Pan (−1 left, 1 right)", kind: "number", step: 0.1 },
    { id: "tune", label: "Tune (semitones)", kind: "number", step: 1 },
    { id: "decay", label: "Decay ×", kind: "number", step: 0.1 },
    { id: "mute", label: "Mute", kind: "boolean" },
    ...SEND_FIELDS,
  ],
  evaluate: (inputs, params, ctx) => {
    const seq = sequenceOf(inputs.sequence);
    if (!seq) return { track: null };
    const track: TrackDescription = {
      id: ctx.nodeId,
      kind: "drums",
      seq: { ...seq, arp: null },
      drums: { tune: clamp(numberInput(inputs.tune, params.tune, 0), -24, 24), decay: clamp(numberInput(inputs.decay, params.decay, 1), 0.1, 4) },
      level: clamp(numberInput(inputs.level, params.level, 0.9), 0, 2),
      pan: clamp(numberInput(inputs.pan, params.pan, 0), -1, 1),
      mute: inputs.mute !== undefined ? Number(inputs.mute) > 0 : Boolean(params.mute),
      ...sendsOf(inputs, params),
    };
    return { track };
  },
};

// ── Note Probe ─────────────────────────────────────────────────────────────

/**
 * Note Probe — what a sequence is playing right now, as values for the scene: computed from the sequence and the
 * playhead, not listened to, so it is exact and the same in an export.
 */
export const MUSIC_NOTE_PROBE_NODE: NodeDefinition = {
  type: "music/note-probe",
  label: "Note Probe",
  category: "music",
  inputs: [
    { id: "music", label: "Sequence / Track", type: "music" },
    { id: "startFrame", label: "Start Frame", type: "value" },
    { id: "decay", label: "Envelope Decay (s)", type: "value" },
  ],
  outputs: [
    { id: "gate", label: "Gate", type: "value" },
    { id: "trigger", label: "Trigger", type: "value" },
    { id: "pitch", label: "Pitch (MIDI)", type: "value" },
    { id: "pitch01", label: "Pitch 0–1", type: "value" },
    { id: "velocity", label: "Velocity", type: "value" },
    { id: "envelope", label: "Envelope", type: "value" },
    { id: "count", label: "Notes Sounding", type: "value" },
    { id: "step", label: "Step", type: "value" },
    { id: "notes", label: "Notes", type: "list" },
  ],
  defaultParams: { startFrame: 0, decay: 0.3 },
  paramFields: [
    { id: "startFrame", label: "Start Frame (match Music Out's)", kind: "number", step: 1 },
    { id: "decay", label: "Envelope Decay (s)", kind: "number", step: 0.05 },
  ],
  evaluate: (inputs, params, ctx) => {
    const seq = sequenceOf(inputs.music);
    const fps = Math.max(1, Number(ctx.fps) || 30);
    const startFrame = Math.round(numberInput(inputs.startFrame, params.startFrame, 0));
    const t = Math.round((((ctx.currentFrame ?? 0) - startFrame) / fps) * PROBE_RATE);
    const silent = { gate: 0, trigger: 0, pitch: 0, pitch01: 0, velocity: 0, envelope: 0, count: 0, step: -1, notes: [] as number[] };
    if (!seq || t < 0) return silent;
    const sounding = notesSoundingAt(seq, PROBE_RATE, t);
    // Struck since the previous frame: (t − one frame, t].
    const struck = notesStartingIn(seq, PROBE_RATE, t - Math.round(PROBE_RATE / fps) + 1, t + 1);
    const step = stepAt(seq.clock, PROBE_RATE, t);
    if (sounding.length === 0) return { ...silent, trigger: struck.length > 0 ? 1 : 0, step };
    const lowest = sounding[0];
    const latestOn = Math.max(...sounding.map((e) => e.on));
    const decay = Math.max(0.005, numberInput(inputs.decay, params.decay, 0.3));
    return {
      gate: 1,
      trigger: struck.length > 0 ? 1 : 0,
      pitch: lowest.note,
      pitch01: lowest.note / 127,
      velocity: Math.max(...sounding.map((e) => e.velocity)),
      envelope: Math.exp(-(t - latestOn) / PROBE_RATE / decay),
      count: sounding.length,
      step,
      notes: [...new Set(sounding.map((e) => e.note))],
    };
  },
};

// ── Music Out ──────────────────────────────────────────────────────────────

/**
 * Music Out — plays the music tracks wired into it, in step with the timeline.
 *
 * The graph describes, the engine plays: each frame this node gathers the track descriptions, hands them to its
 * AudioWorklet engine (posted only when they change), and tells it where the playhead is. The engine keeps its own
 * sample-exact clock and only jumps when the playhead is further than 80 ms away — a seek, a loop of the timeline —
 * so the frame rate never reaches the sound.
 *
 * The song's step 0 sits on Start Frame. Before it, and while the timeline is paused, nothing new is struck; what
 * was sounding rings out.
 */

const TRACK_PREFIX = "track";
const TOLERANCE_SECONDS = 0.08;

/**
 * The engines live in bridge.ts, by node id: this cache only lets a deleted node's engine go. Kept there, not here,
 * so that a hot reload of this file in dev finds the engine it had instead of leaving it connected and making another.
 */
const owned = createNodeCache<string>((nodeId) => releaseMusicEngine(nodeId));

function engineFor(nodeId: string): MusicEngineHandle {
  owned.set(nodeId, nodeId);
  return musicEngineFor(nodeId);
}

/** When an export last captured a frame: the live engine stays quiet meanwhile (as the Audio Player does). */
let lastCaptureAt = -Infinity;
const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
/** One render loop at a time drives an engine: whichever drove it last keeps it while it keeps driving. */
const drivers = new Map<string, { id: string; at: number }>();

/**
 * The tracks wired in, in socket order. A track wired twice plays twice, under its own id each time; a bare sequence
 * plays on the default electric piano.
 */
export function gatherTracks(inputs: Record<string, unknown>, nodeId = "out"): TrackDescription[] {
  const keys = Object.keys(inputs)
    .filter((k) => k.startsWith(TRACK_PREFIX))
    .sort((a, b) => Number(a.slice(TRACK_PREFIX.length)) - Number(b.slice(TRACK_PREFIX.length)));
  const tracks: TrackDescription[] = [];
  const used = new Map<string, number>();
  for (const k of keys) {
    const v = inputs[k];
    for (const item of Array.isArray(v) ? v : [v]) {
      let t: TrackDescription | null = null;
      if (isTrack(item)) t = item;
      else {
        const seq = sequenceOf(item);
        if (seq) t = { id: `${nodeId}:${k}`, kind: "fm", voices: 8, patch: fmPreset("E. Piano"), seq, level: 0.8, pan: 0, mute: false };
      }
      if (!t) continue;
      const n = used.get(t.id) ?? 0;
      used.set(t.id, n + 1);
      tracks.push(n === 0 ? t : { ...t, id: `${t.id}#${n + 1}` });
    }
  }
  return tracks;
}

/** What a Music Out hands its engine, from its inputs and params: the tracks, the master and the send effects. */
export function musicDescriptionOf(inputs: Record<string, unknown>, params: Record<string, unknown>, nodeId = "out"): MusicDescription {
  const num = (k: keyof typeof DEFAULT_FX) => numberInput(undefined, params[k], DEFAULT_FX[k]);
  return {
    tracks: gatherTracks(inputs, nodeId),
    master: clamp(numberInput(inputs.master, params.master, 0.8), 0, 2),
    fx: {
      delayBeats: clamp(num("delayBeats"), 0.0625, 4),
      delayFeedback: clamp(num("delayFeedback"), 0, 0.95),
      delayTone: clamp(num("delayTone"), 0, 1),
      delayLevel: clamp(num("delayLevel"), 0, 1.5),
      reverbSize: clamp(num("reverbSize"), 0, 1),
      reverbDamp: clamp(num("reverbDamp"), 0, 1),
      reverbLevel: clamp(num("reverbLevel"), 0, 1.5),
    },
  };
}

export const MUSIC_OUT_NODE: NodeDefinition = {
  type: "music/out",
  label: "Music Out",
  category: "music",
  inputs: [
    { id: "master", label: "Master", type: "value" },
    { id: "startFrame", label: "Start Frame", type: "value" },
    { id: `${TRACK_PREFIX}0`, label: "Track 1", type: "music" },
  ],
  dynamicInputs: (connections) => [
    { id: "master", label: "Master", type: "value" as const },
    { id: "startFrame", label: "Start Frame", type: "value" as const },
    ...growingSockets(connections, TRACK_PREFIX, (i) => ({ id: `${TRACK_PREFIX}${i}`, label: `Track ${i + 1}`, type: "music" })),
  ],
  outputs: [
    { id: "time", label: "Song Time (s)", type: "value" },
    { id: "beat", label: "Beat", type: "value" },
    { id: "step", label: "Step", type: "value" },
    { id: "playing", label: "Playing", type: "value" },
  ],
  defaultParams: { master: 0.8, startFrame: 0, ...DEFAULT_FX, delayBeats: String(DEFAULT_FX.delayBeats) },
  paramFields: [
    { id: "master", label: "Master", kind: "number", step: 0.05 },
    { id: "startFrame", label: "Start Frame (the song's first step)", kind: "number", step: 1 },
    {
      id: "delayBeats",
      label: "Delay Time",
      kind: "select",
      options: ["0.25", "0.5", "0.75", "1", "1.5", "2"],
      optionLabels: ["1/16", "1/8", "dotted 1/8 (dub)", "1/4", "dotted 1/4", "1/2"],
      group: "Dub FX (the voices' sends)",
    },
    { id: "delayFeedback", label: "Delay Feedback (0–0.95)", kind: "number", step: 0.05, group: "Dub FX (the voices' sends)" },
    { id: "delayTone", label: "Delay Tone (dark 0 – open 1)", kind: "number", step: 0.05, group: "Dub FX (the voices' sends)" },
    { id: "delayLevel", label: "Delay Return", kind: "number", step: 0.05, group: "Dub FX (the voices' sends)" },
    { id: "reverbSize", label: "Reverb Size (spring 0 – hall 1)", kind: "number", step: 0.05, group: "Dub FX (the voices' sends)" },
    { id: "reverbDamp", label: "Reverb Damping", kind: "number", step: 0.05, group: "Dub FX (the voices' sends)" },
    { id: "reverbLevel", label: "Reverb Return", kind: "number", step: 0.05, group: "Dub FX (the voices' sends)" },
  ],
  evaluate: (inputs, params, ctx) => {
    const fps = Math.max(1, Number(ctx.fps) || 30);
    const startFrame = Math.round(numberInput(inputs.startFrame, params.startFrame, 0));
    const desc = musicDescriptionOf(inputs, params, ctx.nodeId);
    const tracks = desc.tracks;

    // Where the playhead puts the song: a pure function of the frame, the same live and in an export.
    const frame = ctx.currentFrame ?? 0;
    const songTime = (frame - startFrame) / fps;
    const running = (ctx.isPlaying !== false || ctx.capturing === true) && songTime >= 0;
    const clock = tracks[0]?.seq.clock ?? DEFAULT_CLOCK;
    const beat = songTime * (clock.bpm / 60);

    const engine = engineFor(ctx.nodeId);
    const sr = engine.sampleRate;
    if (ctx.capturing) lastCaptureAt = nowMs();
    const yieldToExport = !ctx.capturing && nowMs() - lastCaptureAt < 400;
    const sessionId = ctx.sessionId ?? "main";
    const now = nowMs();
    const driver = drivers.get(ctx.nodeId);
    const taken = driver !== undefined && driver.id !== sessionId && now - driver.at < 300;
    if (!taken) drivers.set(ctx.nodeId, { id: sessionId, at: now });

    if (ctx.capturing && isExportAudioCapturing()) {
      // A frame-exact export: what this frame would play is recorded, and replayed offline through the same engine
      // after the last frame (music/engine/exportMusic.ts). The speakers stay out of it.
      recordMusicFrame(ctx.nodeId, { desc, songTime, playing: running });
      engine.follow(false, 0, 0);
      return { time: songTime, beat, step: songTime >= 0 ? stepAt(clock, sr, songTime * sr) : -1, playing: running ? 1 : 0 };
    }
    engine.describe(desc);
    if (ctx.capturing) {
      // The real-time fallback export (MediaRecorder) records the speakers: play along with its frames.
      engine.follow(running, Math.max(0, Math.round(songTime * sr)), TOLERANCE_SECONDS * sr);
    } else if (!yieldToExport && !taken) {
      engine.follow(running, Math.max(0, Math.round(songTime * sr)), TOLERANCE_SECONDS * sr);
    }

    return {
      time: songTime,
      beat,
      step: songTime >= 0 ? stepAt(clock, sr, songTime * sr) : -1,
      playing: running ? 1 : 0,
    };
  },
};
