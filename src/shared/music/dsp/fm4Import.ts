/**
 * Factory sounds of the FM-1 firmwares' DIGITAL engine — four sine operators, the same eight Yamaha 4-op algorithms
 * as ours, feedback on operator 4 — taken as their authors wrote them and converted to FmPatch.
 *
 * Sources (GPL-3.0-only, as tsuji):
 *   - Felucca, by Leo Kuroshita / Hügelton Instruments — https://github.com/hugelton/Felucca
 *     firmware/src/fm4_convert.c, DIGITAL_PRESETS
 *   - SLOOP, by isod89, built on Felucca — https://github.com/isod89/sloop-fm1
 *     firmware/src/eng_digital.c, DIGITAL_PRESETS
 *
 * Their model is simpler than ours: one modulation INDEX for every modulator, shaped by a modulator envelope that
 * starts at full and decays (MODDEC) towards 25 %, and one amplitude ADSR on the whole voice. Values are 0–127; a time
 * is 1 ms × 10000^(v / 127) (1 ms … 10 s), reached at 99 % as our envelopes are (gen_tables.py). The conversion:
 *
 *   - algorithm ALG + 1; ratios from their table (.5 1 2 … 12 14 16), operator 1 at 1;
 *   - each modulator: level INDEX / 127 (INDEX 127 = 2 turns of phase in both engines), halved where two modulators
 *     feed one operator (they average those, we add them), instant attack, decay MODDEC towards 0.25;
 *   - each carrier: the amplitude ADSR, at level 0.5 (their carriers are full-scale sines, "6 dB below the others");
 *   - feedback: theirs reaches 2 turns at 127, ours 0.25 turns at 1 times operator 4's level, so it is scaled and
 *     clamped at 1 — the strongest presets (CLAV, BRASS) are a little tamer here;
 *   - MONO → one voice; SLOOP's transposition (XP P_TRANS) kept; their LFO, glide, filter envelope and effect sends
 *     are not, tsuji has none of those yet.
 */
import { fmAlgorithm } from "./algorithms";
import type { FmOperatorPatch, FmPatch } from "./fm";

export interface Fm4Raw {
  source: "Felucca" | "SLOOP";
  name: string;
  /** ALG (0–7), R2, R3, R4 (indices in RATIOS), INDEX, MODDEC, FDBK. */
  e: [number, number, number, number, number, number, number];
  /** ATK DEC SUS REL, 0–127. */
  env: [number, number, number, number];
  mono: 0 | 1;
  /** Semitones (SLOOP's XP(P_TRANS)). */
  transpose?: number;
}

export const FM4_RATIOS = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16];

/** Their time curve: value 0–127 → seconds, 1 ms to 10 s. */
export function fm4Time(v: number): number {
  return 0.001 * Math.pow(10000, Math.min(127, Math.max(0, v)) / 127);
}

/** The algorithms (1-based) where two modulators share one operator, which theirs averages. */
const AVERAGED: Record<number, number[]> = { 2: [2, 3], 3: [1, 3], 4: [1, 2] };
const OUR_MAX_FEEDBACK_TURNS = 0.25;
const THEIR_MAX_TURNS = 2;

export interface Fm4Converted {
  patch: FmPatch;
  voices: number;
  transpose: number;
}

export function fromFm4(raw: Fm4Raw): Fm4Converted {
  const [alg, r2, r3, r4, index, modDecay, feedback] = raw.e;
  const [atk, dec, sus, rel] = raw.env;
  const algorithm = (alg & 7) + 1;
  const carriers = new Set(fmAlgorithm(algorithm).carriers);
  const ratios = [1, FM4_RATIOS[r2 % 15], FM4_RATIOS[r3 % 15], FM4_RATIOS[r4 % 15]];
  const halved = new Set(AVERAGED[algorithm] ?? []);
  const modLevel = index / 127;
  const release = fm4Time(rel);
  const ops = ratios.map((ratio, k): FmOperatorPatch => {
    if (carriers.has(k)) {
      return {
        ratio,
        detune: 0,
        level: 0.5,
        velocitySens: 0.7,
        attack: atk > 0 ? fm4Time(atk) : 0,
        decay: fm4Time(dec),
        sustain: sus / 127,
        release,
      };
    }
    return {
      ratio,
      detune: 0,
      level: halved.has(k) ? modLevel / 2 : modLevel,
      velocitySens: 0.25,
      attack: 0,
      decay: fm4Time(modDecay),
      sustain: 0.25,
      release,
    };
  }) as FmPatch["ops"];
  // Their feedback is a pure sine of operator 4; ours goes through its level: divide it back out.
  const op4Level = Math.max(0.05, ops[3].level);
  const fbTurns = (feedback / 127) * THEIR_MAX_TURNS;
  return {
    patch: { algorithm, feedback: Math.min(1, fbTurns / (OUR_MAX_FEEDBACK_TURNS * op4Level)), ops },
    voices: raw.mono ? 1 : 8,
    transpose: raw.transpose ?? 0,
  };
}

const F = (name: string, e: Fm4Raw["e"], env: Fm4Raw["env"], mono: 0 | 1 = 0): Fm4Raw => ({ source: "Felucca", name, e, env, mono });
const S = (name: string, e: Fm4Raw["e"], env: Fm4Raw["env"], mono: 0 | 1 = 0, transpose?: number): Fm4Raw => ({ source: "SLOOP", name, e, env, mono, transpose });

/** As written in the sources (the 8th E value, unused, left out). SLOOP's MARIMBA is Felucca's, listed once. */
export const FM4_RAW_PRESETS: Fm4Raw[] = [
  // Felucca
  F("E.PIANO", [4, 1, 1, 14, 70, 55, 0], [0, 80, 40, 60]),
  F("BELL", [4, 8, 1, 4, 90, 70, 0], [0, 95, 0, 85]),
  F("BASS", [0, 1, 1, 1, 48, 40, 8], [0, 60, 70, 25], 1),
  F("BRASS", [0, 1, 1, 1, 70, 40, 20], [40, 70, 100, 40]),
  F("ORGAN", [7, 2, 3, 4, 0, 0, 0], [2, 60, 127, 20]),
  F("PAD", [5, 2, 1, 3, 40, 90, 10], [80, 90, 110, 95]),
  F("MARIMBA", [4, 4, 1, 1, 60, 30, 0], [0, 80, 0, 60]),
  F("FUNK KEY", [3, 1, 3, 5, 90, 25, 20], [0, 45, 30, 30]),
  // SLOOP
  S("RHODES", [4, 1, 1, 14, 26, 35, 0], [0, 85, 35, 55]),
  S("DX RHODES", [4, 1, 1, 14, 85, 45, 0], [0, 82, 40, 55]),
  S("WURLI", [4, 1, 2, 3, 62, 35, 8], [0, 75, 30, 45]),
  S("CLAV", [3, 1, 3, 5, 90, 25, 20], [0, 58, 34, 18]),
  S("M1 PIANO", [4, 1, 2, 13, 74, 30, 12], [0, 86, 30, 48]),
  S("AFRO KEYS", [4, 1, 1, 7, 40, 50, 0], [0, 82, 40, 60]),
  S("TRAP BELL", [4, 8, 1, 4, 80, 70, 0], [0, 92, 0, 70]),
  S("MUSIC BOX", [4, 4, 3, 9, 45, 75, 0], [0, 90, 0, 75]),
  S("KALIMBA", [4, 4, 1, 6, 52, 24, 0], [0, 78, 0, 58]),
  S("PLUGG BELL", [4, 3, 1, 4, 56, 60, 0], [0, 90, 0, 82]),
  S("GLASS PAD", [4, 2, 1, 5, 34, 100, 0], [62, 92, 112, 92]),
  S("FM BASS", [0, 1, 1, 1, 34, 40, 8], [0, 60, 70, 25], 1, -24),
  S("STEEL DRUM", [4, 2, 2, 2, 45, 45, 0], [0, 88, 0, 66]),
  S("GLOCKEN", [4, 5, 1, 8, 40, 60, 0], [0, 95, 0, 85], 0, 12),
  S("CELESTA", [4, 2, 1, 4, 30, 50, 0], [0, 84, 0, 70], 0, 12),
  S("XYLOPHONE", [4, 4, 3, 3, 70, 18, 0], [0, 77, 0, 58], 0, 12),
  S("HARP", [4, 1, 1, 2, 45, 30, 10], [0, 92, 0, 80]),
  S("BASS GTR", [4, 1, 1, 2, 40, 30, 6], [0, 76, 40, 22], 1, -24),
  S("TUBE BELL", [4, 6, 1, 13, 50, 90, 0], [0, 100, 0, 90]),
  S("FM PLUCK", [4, 2, 1, 3, 70, 15, 0], [0, 78, 0, 54]),
  S("FM GRAND", [4, 1, 2, 12, 60, 40, 10], [0, 90, 20, 60]),
];

/** "SLOOP · RHODES": the name the FM Voice lists it under, source first. */
export const fm4PresetName = (raw: Fm4Raw) => `${raw.source} · ${raw.name}`;
