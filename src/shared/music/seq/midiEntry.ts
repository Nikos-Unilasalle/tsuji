import type { DrumName } from "../dsp/drums";
import { CHORD_NAMES, ChordName, chordNotes } from "./chords";
import { DRUM_LANES, setCell, toggleDrum, writeNote } from "./patternEdit";
import type { Cell } from "./sequencer";

/**
 * A MIDI keyboard (an Arturia MiniLab…) typing into a Pattern, step by step as a tracker does: the notes struck
 * together land on the cursor's step, then the cursor moves on. Pure, for PatternHud and the tests.
 */

/** Notes struck within this long of the first are one chord (or, on a drum pattern, hits on one step). */
export const CHORD_WINDOW_MS = 60;

const sameSet = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i]);

/**
 * The chord a set of notes spells, as the pattern names chords: its root, name, inversion and spread — or null when
 * none of the chords the sequencer knows sounds exactly these notes.
 */
export function recognizeChord(notes: readonly number[]): { root: number; chord: ChordName; inversion: number; spread: boolean } | null {
  const want = [...new Set(notes)].sort((a, b) => a - b);
  if (want.length < 2) return null;
  for (const spread of [false, true]) {
    for (const chord of CHORD_NAMES) {
      const size = chordNotes(0, chord).length;
      if (size !== want.length) continue;
      for (let inversion = 0; inversion < size; inversion++) {
        // The root is one of the notes, or an octave or two below one (an inversion lifts the lowest notes).
        for (const n of want) {
          for (const root of [n, n - 12, n - 24]) {
            if (root < 0) continue;
            const got = chordNotes(root, chord, inversion, spread).sort((a, b) => a - b);
            if (sameSet(got, want)) return { root, chord, inversion, spread };
          }
        }
      }
    }
  }
  return null;
}

/**
 * The cell the notes struck together write: one note takes the HUD's brush (its chord too, as a typed letter does);
 * several are a named chord when they spell one, else the lowest note with the others added — the voicing as played.
 * Velocity is the hardest note's.
 */
export function cellFromNotes(notes: readonly number[], velocity: number, brush: Partial<Cell> = {}): Cell {
  const sorted = [...new Set(notes)].sort((a, b) => a - b);
  const v = Math.round(Math.max(0.01, Math.min(1, velocity)) * 100) / 100;
  if (sorted.length === 1) return writeNote([null], 0, sorted[0], { ...brush, velocity: v })[0]!;
  // The voicing is the one played: the brush's chord settings do not come with it.
  const rest: Partial<Cell> = { ...brush };
  delete rest.chord;
  delete rest.inversion;
  delete rest.spread;
  delete rest.add;
  delete rest.addVelocity;
  const named = recognizeChord(sorted);
  const cell: Cell = named
    ? { ...rest, note: named.root, chord: named.chord, inversion: named.inversion || undefined, spread: named.spread || undefined }
    : { ...rest, note: sorted[0], add: sorted.slice(1) };
  cell.velocity = v;
  return writeNote([null], 0, cell.note as number, cell)[0]!;
}

/** The MiniLab's pads (and most pad controllers'): channel 10, notes 36 up, pad 1 first. */
export function padIndex(channel: number, note: number): number | null {
  return channel === 9 && note >= 36 && note < 44 ? note - 36 : null;
}

/** General MIDI drum notes, by family, onto the kit's seven sounds. */
const GM_FAMILY: Record<number, DrumName> = {
  35: "kick", 36: "kick",
  37: "snare", 38: "snare", 40: "snare",
  39: "clap",
  42: "hat", 44: "hat",
  46: "openhat", 49: "openhat", 51: "openhat", 52: "openhat", 55: "openhat", 57: "openhat", 59: "openhat",
  41: "tomlow", 43: "tomlow", 45: "tomlow", 47: "tomlow",
  48: "tomhigh", 50: "tomhigh",
};

/**
 * What a note does on a drum pattern: pads 1–7 strike the kit's sounds in lane order (kick, snare, clap, hat, open
 * hat, low tom, high tom) and pad 8 is a rest (the cursor moves on, nothing written); keys strike their General MIDI
 * drum, by family. Null for a note that is no drum.
 */
export function drumForMidi(channel: number, note: number): DrumName | "rest" | null {
  const pad = padIndex(channel, note);
  if (pad !== null) return pad < DRUM_LANES.length ? DRUM_LANES[pad] : "rest";
  return GM_FAMILY[note] ?? null;
}

/**
 * What a pad does on a melodic pattern, where notes come from the keys: 1 an OFF, 2 a rest, 3 clears the step, 4 steps
 * back; the others nothing.
 */
export type PadAction = "off" | "rest" | "clear" | "back";
export function melodicPadAction(pad: number): PadAction | null {
  return (["off", "rest", "clear", "back"] as const)[pad] ?? null;
}

/** The notes struck at one step so far: the pattern as it was before them, so each new note rewrites the step whole. */
export interface EntryGroup {
  step: number;
  base: readonly (Cell | null)[];
  notes: number[];
  velocity: number;
  /** Drum pattern: the sounds struck, with their velocities. */
  hits: [DrumName, number][];
  startedAt: number;
}

/** The pattern with a group's notes written at its step. */
export function applyGroup(group: EntryGroup, brush: Partial<Cell>, drums: boolean): (Cell | null)[] {
  if (drums) {
    let cells = [...group.base];
    for (const [drum, v] of group.hits) cells = toggleDrum(cells, group.step, drum, Math.round(v * 100) / 100);
    return cells;
  }
  return setCell(group.base, group.step, cellFromNotes(group.notes, group.velocity, brush));
}
