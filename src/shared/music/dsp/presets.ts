/**
 * Factory FM sounds for the FM Voice node. Operator 1 is listed first; see algorithms.ts for what each algorithm
 * routes where.
 */
import { EPIANO_PATCH, FmOperatorPatch, FmPatch } from "./fm";

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
  /** Chip-like square-ish tone: a carrier modulated at its own pitch, hard. */
  Chip: {
    algorithm: 1,
    feedback: 0,
    ops: [op(1, 0.5, 0.001, 0.2, 0.7, 0.05, 0), op(1, 0.45, 0.001, 1, 1, 0.05, 0), op(1, 0, 0.001, 1, 1, 0.05, 0), op(1, 0, 0.001, 1, 1, 0.05, 0)],
  },
} as const satisfies Record<string, FmPatch>;

export type FmPresetName = keyof typeof FM_PRESETS;
export const FM_PRESET_NAMES = Object.keys(FM_PRESETS) as FmPresetName[];

export function fmPreset(name: unknown): FmPatch {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(FM_PRESETS, name)
    ? (FM_PRESETS[name as FmPresetName] as FmPatch)
    : EPIANO_PATCH;
}
