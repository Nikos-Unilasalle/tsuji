/**
 * Arpeggiator: turns a chord (or any group of notes) into a sequence of single notes. Pure: which note comes i-th
 * depends on the notes, the mode and i only — "random" draws from a seeded hash, so the export plays what the
 * preview played.
 */
import { hash01 } from "./hash";

export const ARP_MODES = ["up", "down", "updown", "downup", "played", "random"] as const;
export type ArpMode = (typeof ARP_MODES)[number];

export const ARP_RATES = ["1/4", "1/8", "1/16", "1/32", "1/64"] as const;
export type ArpRate = (typeof ARP_RATES)[number];

export interface ArpSettings {
  mode: ArpMode;
  rate: ArpRate;
  /** Triplets: three notes in the time of two. */
  triplet: boolean;
  /** 1–4: the notes are repeated this many octaves up. */
  octaves: number;
  /** 0.1–1: how much of each arp step a note sounds. */
  gate: number;
  /** "grid": the notes fall on the clock's grid, whenever the chord started. "retrigger": the arp restarts with each chord. */
  sync: "grid" | "retrigger";
}

export const DEFAULT_ARP: ArpSettings = { mode: "up", rate: "1/16", triplet: false, octaves: 1, gate: 0.8, sync: "grid" };

/** Length of one arp step, in beats (a beat is a quarter note). */
export function arpStepBeats(rate: ArpRate, triplet: boolean): number {
  const denom = Number(rate.split("/")[1]);
  return (4 / denom) * (triplet ? 2 / 3 : 1);
}

/** The notes the arp walks over: the chord in its played order, repeated `octaves` times an octave apart. */
export function arpPool(notes: readonly number[], octaves: number): number[] {
  const n = Math.max(1, Math.min(4, Math.round(octaves)));
  const pool: number[] = [];
  for (let o = 0; o < n; o++) for (const note of notes) pool.push(note + 12 * o);
  return pool;
}

/**
 * The i-th note of the arpeggio over `played` (already extended by arpPool). `seed` only matters for "random":
 * the sequencer passes the step the chord was triggered on, so each chord draws its own sequence.
 */
export function arpNote(played: readonly number[], mode: ArpMode, i: number, seed: number): number {
  const L = played.length;
  if (L === 0) return NaN;
  if (L === 1) return played[0];
  const sorted = mode === "played" || mode === "random" ? played : [...played].sort((a, b) => a - b);
  switch (mode) {
    case "up":
    case "played":
      return sorted[i % L];
    case "down":
      return sorted[L - 1 - (i % L)];
    case "updown":
    case "downup": {
      // Up then down without repeating the ends: 0 1 2 3 2 1 | 0 1 2 …
      const period = 2 * L - 2;
      const k = i % period;
      const idx = k < L ? k : period - k;
      return mode === "updown" ? sorted[idx] : sorted[L - 1 - idx];
    }
    case "random":
      return played[Math.floor(hash01(seed, i, 0x41525021) * L)];
  }
}
