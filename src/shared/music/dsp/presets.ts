/**
 * Factory FM sounds for the FM Voice node. Operator 1 is listed first; see algorithms.ts for what each algorithm
 * routes where.
 */
import { EPIANO_PATCH, FmOperatorPatch, FmPatch } from "./fm";
import { FM4_RAW_PRESETS, fm4PresetName, fromFm4 } from "./fm4Import";

const op = (
  ratio: number,
  level: number,
  attack: number,
  decay: number,
  sustain: number,
  release: number,
  velocitySens = 0.5,
  detune = 0,
): FmOperatorPatch => ({ ratio, detune, level, velocitySens, attack, decay, sustain, release });

export const FM_PRESETS = {
  "E. Piano": EPIANO_PATCH,
  /** A round, punchy bass: a short bright stack over a sustained sine. */
  Bass: {
    algorithm: 1,
    feedback: 0.3,
    ops: [op(1, 0.7, 0.002, 0.4, 0.6, 0.12, 0.8), op(1, 0.35, 0.001, 0.15, 0.2, 0.1), op(2, 0.15, 0.001, 0.08, 0, 0.1), op(1, 0.1, 0.001, 0.1, 0, 0.1)],
  },
  /** A tubular bell: inharmonic ratios, long ringing tail. */
  Bell: {
    algorithm: 5,
    feedback: 0,
    ops: [op(1, 0.45, 0.001, 3, 0, 2.5, 0.8), op(3.5, 0.3, 0.001, 2, 0, 2), op(2, 0.3, 0.001, 2.5, 0, 2, 0.8), op(5.19, 0.2, 0.001, 1.2, 0, 1)],
  },
  /** A slow, warm pad: two detuned carriers sharing a gentle modulator. */
  Pad: {
    algorithm: 6,
    feedback: 0.1,
    ops: [op(1, 0.35, 0.6, 1.5, 0.8, 1.5, 0.3, -6), op(1, 0.35, 0.7, 1.5, 0.8, 1.5, 0.3, 6), op(2, 0.2, 0.8, 2, 0.7, 1.5, 0.3), op(1, 0.12, 0.9, 2, 0.6, 1.5)],
  },
  /** A buzzy mono-style lead: a full stack with strong feedback. */
  Lead: {
    algorithm: 1,
    feedback: 0.7,
    ops: [op(1, 0.55, 0.005, 0.3, 0.8, 0.15, 0.6), op(1, 0.3, 0.005, 0.4, 0.6, 0.2), op(1, 0.2, 0.005, 0.5, 0.5, 0.2), op(1, 0.25, 0.005, 0.5, 0.6, 0.2)],
  },
  /** Drawbars: four sine carriers at 1, 2, 3 and 4 times the note. */
  Organ: {
    algorithm: 8,
    feedback: 0,
    ops: [op(1, 0.8, 0.005, 1, 1, 0.05, 0), op(2, 0.6, 0.005, 1, 1, 0.05, 0), op(3, 0.4, 0.005, 1, 1, 0.05, 0), op(4, 0.35, 0.005, 1, 1, 0.05, 0)],
  },
  /** A plucked string: everything decays, the brightness first. */
  Pluck: {
    algorithm: 2,
    feedback: 0.2,
    ops: [op(1, 0.6, 0.001, 0.6, 0, 0.3, 0.8), op(1, 0.4, 0.001, 0.2, 0, 0.2, 0.8), op(3, 0.15, 0.001, 0.1, 0, 0.1), op(0.5, 0.1, 0.001, 0.3, 0, 0.2)],
  },
  /**
   * A melodica, the dub lead: a reedy stack (an octave-up modulator for the buzz, a little feedback for the breath)
   * that swells in and holds, with a touch of detune between the two lower operators.
   */
  Melodica: {
    algorithm: 1,
    feedback: 0.25,
    ops: [op(1, 0.5, 0.045, 1.2, 0.85, 0.18, 0.5), op(1, 0.32, 0.06, 1.5, 0.7, 0.2, 0.4, 7), op(2, 0.16, 0.05, 0.8, 0.5, 0.2, 0.3), op(1, 0.12, 0.08, 1, 0.6, 0.2)],
  },
  /** Chip-like square-ish tone: a carrier modulated at its own pitch, hard. */
  Chip: {
    algorithm: 1,
    feedback: 0,
    ops: [op(1, 0.5, 0.001, 0.2, 0.7, 0.05, 0), op(1, 0.45, 0.001, 1, 1, 0.05, 0), op(1, 0, 0.001, 1, 1, 0.05, 0), op(1, 0, 0.001, 1, 1, 0.05, 0)],
  },
} as const satisfies Record<string, FmPatch>;

export type FmPresetName = keyof typeof FM_PRESETS;

/** A preset as the FM Voice loads it: the patch, and how the voice plays it. */
export interface FmVoicePreset {
  patch: FmPatch;
  /** 1 for a mono sound. */
  voices: number;
  /** Semitones the voice moves its notes by. */
  transpose: number;
}

/** Ours first, then the FM-1 firmwares' (fm4Import.ts), listed as "Felucca · E.PIANO", "SLOOP · RHODES"… */
export const FM_VOICE_PRESETS: Record<string, FmVoicePreset> = {
  ...Object.fromEntries(Object.entries(FM_PRESETS).map(([name, patch]) => [name, { patch: patch as FmPatch, voices: 8, transpose: 0 }])),
  ...Object.fromEntries(FM4_RAW_PRESETS.map((raw) => [fm4PresetName(raw), fromFm4(raw)])),
};

export const FM_PRESET_NAMES = Object.keys(FM_VOICE_PRESETS);

export function fmVoicePreset(name: unknown): FmVoicePreset {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(FM_VOICE_PRESETS, name)
    ? FM_VOICE_PRESETS[name]
    : FM_VOICE_PRESETS["E. Piano"];
}

export function fmPreset(name: unknown): FmPatch {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(FM_VOICE_PRESETS, name) ? FM_VOICE_PRESETS[name].patch : EPIANO_PATCH;
}
