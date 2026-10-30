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
  // The step's velocity is every note's.
  if ("velocity" in patch) delete next.addVelocity;
  return setCell(cells, i, next);
}

/** The drum sounds struck at step i. */
export function drumsAt(cell: Cell | null): Set<number> {
  if (!cell || cell.note === "off") return new Set();
  return new Set([cell.note, ...(cell.add ?? [])]);
}

/** How hard `note` is struck at this step (0.8 when the step does not say); null if the step does not play it. */
export function hitVelocity(cell: Cell | null, note: number): number | null {
  if (!cell || cell.note === "off") return null;
  const base = cell.velocity ?? 0.8;
  if (cell.note === note) return base;
  const k = cell.add?.indexOf(note) ?? -1;
  return k < 0 ? null : (cell.addVelocity?.[k] ?? base);
}

/** Step i's drums written back from their velocities, in kit order — so the same hits always read the same (kick+hat,
 * never hat+kick); the rest of the step (length, ratchet…) is kept. */
function withHits(cells: readonly (Cell | null)[], i: number, hits: Map<number, number>): (Cell | null)[] {
  if (hits.size === 0) return setCell(cells, i, null);
  const ordered: number[] = DRUM_LANES.map((d) => DRUM_NOTES[d]).filter((n) => hits.has(n));
  for (const n of hits.keys()) if (!ordered.includes(n)) ordered.push(n);
  const old = cells[i] && cells[i]!.note !== "off" ? cells[i]! : null;
  const cell: Cell = { ...(old ?? {}), note: ordered[0] };
  delete cell.add;
  delete cell.addVelocity;
  delete cell.velocity;
  const v0 = hits.get(ordered[0])!;
  if (Math.abs(v0 - 0.8) > 1e-9) cell.velocity = v0;
  if (ordered.length > 1) {
    cell.add = ordered.slice(1);
    const own = cell.add.map((n) => hits.get(n)!);
    if (own.some((v) => Math.abs(v - v0) > 1e-9)) cell.addVelocity = own;
  }
  return setCell(cells, i, cell);
}

function hitsAt(cell: Cell | null): Map<number, number> {
  const hits = new Map<number, number>();
  for (const n of drumsAt(cell)) hits.set(n, hitVelocity(cell, n)!);
  return hits;
}

/** Adds or takes away one drum at step i; a new hit is struck at `velocity` (the step's, when not given), the other
 * hits keep theirs. */
export function toggleDrum(cells: readonly (Cell | null)[], i: number, drum: DrumName, velocity?: number): (Cell | null)[] {
  const note = DRUM_NOTES[drum];
  const hits = hitsAt(cells[i]);
  if (hits.has(note)) hits.delete(note);
  else hits.set(note, velocity ?? (cells[i] && cells[i]!.note !== "off" ? (cells[i]!.velocity ?? 0.8) : 0.8));
  return withHits(cells, i, hits);
}

/** Changes how hard one note of step i is struck, the step's other notes as they are; nothing if the step lacks it. */
export function setHitVelocity(cells: readonly (Cell | null)[], i: number, note: number, velocity: number): (Cell | null)[] {
  const hits = hitsAt(cells[i]);
  if (!hits.has(note)) return [...cells];
  hits.set(note, velocity);
  return withHits(cells, i, hits);
}

/** The cursor moved by `by` steps, wrapping round the pattern. */
export function moveCursor(cursor: number, by: number, length: number): number {
  return (((cursor + by) % length) + length) % length;
}

/** Changes the pattern's length, keeping the steps it has: longer pads with empty steps, shorter cuts. */
export function resize(cells: readonly (Cell | null)[], length: number): (Cell | null)[] {
  return Array.from({ length }, (_, i) => cells[i] ?? null);
}

const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

/** The note made sharp — or, already a sharp, made natural again (C → C#, C# → C). */
export function toggleSharp(note: number): number {
  const n = BLACK_KEYS.has(((note % 12) + 12) % 12) ? note - 1 : note + 1;
  return Math.min(127, Math.max(0, n));
}

/** For each step, the step whose note is still sounding there because of its length (`~N`), or -1. */
export function heldBy(cells: readonly (Cell | null)[]): number[] {
  const out = cells.map(() => -1);
  cells.forEach((c, i) => {
    if (!c || c.note === "off" || !c.length) return;
    for (let k = i + 1; k < Math.min(cells.length, i + Math.round(c.length)); k++) {
      if (cells[k]) break;
      out[k] = i;
    }
  });
  return out;
}

/** A note from step a to step b (either order), held for the steps between: the note already at the first step keeps
 * its pitch and settings, an empty step or an OFF gets `note` with the brush. */
export function spanNote(cells: readonly (Cell | null)[], a: number, b: number, note: number, brush: Partial<Cell> = {}): (Cell | null)[] {
  const from = Math.min(a, b);
  const len = Math.abs(b - a) + 1;
  const c = cells[from];
  const base = c && c.note !== "off" ? cells : writeNote(cells, from, note, brush);
  return editCell(base, from, { length: len > 1 ? len : undefined });
}
