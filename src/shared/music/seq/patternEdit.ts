/**
 * What the Pattern HUD does to a pattern, kept out of the component so it can be tested: the tracker keyboard, writing
 * and clearing cells, toggling drum hits. Everything works on the cells as parsed from the node's `steps` text and
 * returns new cells; the HUD writes them back with formatPattern (notation.ts), so a pattern edited in the HUD and
 * one typed by hand are the same text.
 */
import { DRUM_NOTES, DrumName } from "../dsp/drums";
import type { Cell } from "./sequencer";

/**
 * The tracker keyboard, by physical key (KeyboardEvent.code, so it is the same on QWERTY, AZERTY or anything else):
 * the bottom row is an octave from C, with the black keys on the row above it; the top row the octave above.
 *
 *    S D   G H J          2 3   5 6 7   9 0
 *   Z X C V B N M  ,     Q W E R T Y U I O P
 */
const KEY_SEMITONES: Record<string, number> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11, Comma: 12,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23,
  KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28,
};

/** The note a key plays with the keyboard's octave (C of `octave` on Z, so octave 4 puts C4 = 60 there), or null. */
export function noteForKey(code: string, octave: number): number | null {
  const s = KEY_SEMITONES[code];
  if (s === undefined) return null;
  const note = (octave + 1) * 12 + s;
  return note >= 0 && note <= 127 ? note : null;
}

/** Keys that write an OFF: 1 and the key left of it. */
export const OFF_KEYS = new Set(["Digit1", "Backquote", "IntlBackslash"]);

/** In the drum view, the bottom row strikes the kit, one key per sound. */
export const DRUM_KEYS: Record<string, DrumName> = {
  KeyZ: "kick",
  KeyX: "snare",
  KeyC: "clap",
  KeyV: "hat",
  KeyB: "openhat",
  KeyN: "tomlow",
  KeyM: "tomhigh",
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
