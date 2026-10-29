/**
 * What the Pattern HUD does to a pattern, kept out of the component so it can be tested: the tracker keyboard, writing
 * and clearing cells, toggling drum hits. Everything works on the cells as parsed from the node's `steps` text and
 * returns new cells; the HUD writes them back with formatPattern (notation.ts), so a pattern edited in the HUD and
 * one typed by hand are the same text.
 */
import { DRUM_NOTES, DrumName } from "../dsp/drums";
import type { Cell } from "./sequencer";

/**
 * The keyboard writes notes by their names: A B C D E F G (by the character typed, so on any layout), Shift or a #
 * right after for the sharp, and a digit right after for the note's octave — typing C 4, F # 3, A 2 writes the notes
 * the way the pattern text spells them.
 */
const LETTER_SEMITONES: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** The note a letter names in `octave` (C4 = 60), sharp or not; null if the key is no note letter. */
export function noteForLetter(key: string, octave: number, sharp = false): number | null {
  const s = LETTER_SEMITONES[key.toLowerCase()];
  if (s === undefined || key.length !== 1) return null;
  const note = (octave + 1) * 12 + s + (sharp ? 1 : 0);
  return note >= 0 && note <= 127 ? note : null;
}

/** The same note in another octave. */
export function withOctave(note: number, octave: number): number | null {
  const n = (octave + 1) * 12 + (((note % 12) + 12) % 12);
  return n >= 0 && n <= 127 ? n : null;
}

/** Keys that write an OFF: X (KAWA's) and O. */
export const OFF_LETTERS = new Set(["x", "o"]);

/** In the drum view, each sound's initial strikes it: Kick Snare Clap Hat Open hat, L(ow) and T(op) tom. */
export const DRUM_LETTERS: Record<string, DrumName> = {
  k: "kick",
  s: "snare",
  c: "clap",
  h: "hat",
  o: "openhat",
  l: "tomlow",
  t: "tomhigh",
};

export const DRUM_LANES: DrumName[] = ["kick", "snare", "clap", "hat", "openhat", "tomlow", "tomhigh"];

export function setCell(cells: readonly (Cell | null)[], i: number, cell: Cell | null): (Cell | null)[] {
  return cells.map((c, k) => (k === i ? cell : c));
}

/** Writes a note at step i; the "brush" (chord, velocity…) the HUD is set to comes with it. */
export function writeNote(cells: readonly (Cell | null)[], i: number, note: number, brush: Partial<Cell> = {}): (Cell | null)[] {
  const cell: Cell = { note };
  for (const [k, v] of Object.entries(brush)) if (v !== undefined && v !== null && v !== false) (cell as unknown as Record<string, unknown>)[k] = v;
  return setCell(cells, i, cell);
}

/** Changes some of a note cell's settings (an OFF or an empty step stays as it is); undefined takes one away. */
export function editCell(cells: readonly (Cell | null)[], i: number, patch: Partial<Cell>): (Cell | null)[] {
  const c = cells[i];
  if (!c || c.note === "off") return [...cells];
  const next: Cell = { ...c };
  for (const [k, v] of Object.entries(patch) as [keyof Cell, unknown][]) {
    if (v === undefined || v === null || v === false || v === 0) delete next[k];
    else (next as unknown as Record<string, unknown>)[k] = v;
  }
  return setCell(cells, i, next);
}

/** The drum sounds struck at step i. */
export function drumsAt(cell: Cell | null): Set<number> {
  if (!cell || cell.note === "off") return new Set();
  return new Set([cell.note, ...(cell.add ?? [])]);
}

/** Adds or takes away one drum at step i; the rest of the step (velocity, ratchet…) is kept. */
export function toggleDrum(cells: readonly (Cell | null)[], i: number, drum: DrumName): (Cell | null)[] {
  const note = DRUM_NOTES[drum];
  const hits = drumsAt(cells[i]);
  if (hits.has(note)) hits.delete(note);
  else hits.add(note);
  if (hits.size === 0) return setCell(cells, i, null);
  // Kept in kit order, so the same hits always read the same: kick+hat, never hat+kick.
  const ordered = DRUM_LANES.map((d) => DRUM_NOTES[d]).filter((n) => hits.has(n));
  const old = cells[i] && cells[i]!.note !== "off" ? cells[i]! : null;
  const cell: Cell = { ...(old ?? {}), note: ordered[0] };
  if (ordered.length > 1) cell.add = ordered.slice(1);
  else delete cell.add;
  return setCell(cells, i, cell);
}

/** The cursor moved by `by` steps, wrapping round the pattern. */
export function moveCursor(cursor: number, by: number, length: number): number {
  return (((cursor + by) % length) + length) % length;
}

/** Changes the pattern's length, keeping the steps it has: longer pads with empty steps, shorter cuts. */
export function resize(cells: readonly (Cell | null)[], length: number): (Cell | null)[] {
  return Array.from({ length }, (_, i) => cells[i] ?? null);
}
