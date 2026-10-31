/**
 * Macros: what makes a chip instrument a tracker instrument. A macro is a sequence of values, one per tick (a tick is
 * 1 / tickRate s, 60 by default as in Furnace and DefleMask, 50 for a PAL C64), started by each note: a volume that
 * falls step by step, an arpeggio that cycles 0 4 7, a duty or a waveform that changes on the second frame…
 * LSDJ's tables, GoatTracker's wave and pulse tables and Furnace's macros are all this.
 *
 * Written as text, a value a word, with two marks (Furnace's):
 *
 *   15 13 11 | 10 9 9 10 / 6 3 0
 *
 *   |  the loop: past the end, the macro goes back here
 *   /  the release: while the note is held, the macro does not go past it (it loops back to `|` when that is before
 *      it, else holds its last value before it); the note-off sends it on, from there to the end
 *
 * Without either mark the macro runs once and keeps its last value. Values are numbers (hex with $ or 0x).
 *
 * Pure: a MacroState is stepped once a tick and holds no time of its own.
 */

export interface Macro {
  values: number[];
  /** Index the macro loops back to past its end, or −1. */
  loop: number;
  /** Index the note-off sends it to (it stops short of it while held), or −1. */
  release: number;
}

const MAX_MACRO = 256;

/** A macro's text → the macro; null for text with no value (no macro). `hex`: bare words are hex (a wave macro's). */
export function parseMacro(text: unknown, hex = false): Macro | null {
  const values: number[] = [];
  let loop = -1;
  let release = -1;
  for (const raw of String(text ?? "").split(/[\s,]+/)) {
    if (raw === "") continue;
    // A mark may stick to a value: "|10", "9/".
    for (const part of raw.split(/(?=[|/])|(?<=[|/])/)) {
      if (part === "|") loop = values.length;
      else if (part === "/") release = values.length;
      else if (values.length < MAX_MACRO) {
        const m = /^(-?)(\$|0x)?([0-9a-f]+)$/i.exec(part);
        if (!m) continue;
        const v = parseInt(m[3], hex || m[2] ? 16 : 10);
        if (Number.isFinite(v)) values.push(m[1] ? -v : v);
      }
    }
  }
  if (values.length === 0) return null;
  return { values, loop: loop >= values.length ? -1 : loop, release: release >= values.length || release <= 0 ? -1 : release };
}

/** The position after `pos` (−1: not started) in a macro, the note held or not. */
export function macroNext(m: Macro, pos: number, held: boolean): number {
  let p = pos + 1;
  const end = m.values.length;
  if (held && m.release > 0 && p >= m.release) {
    // Held: stay before the release — looping when the loop is before it, else on its last value.
    return m.loop >= 0 && m.loop < m.release ? m.loop : m.release - 1;
  }
  // Past the end: loop, unless the loop is in the held part the note has left.
  if (p >= end) p = m.loop >= 0 && (m.release <= 0 || m.loop >= m.release) ? m.loop : end - 1;
  return p;
}

/** Where a released note's macro goes: on to the release point, if it has not passed it yet. */
export function macroRelease(m: Macro, pos: number): number {
  return m.release > 0 && pos < m.release ? m.release : pos;
}

/** Whether the macro, released, has nothing left to do: on its last value, not looping. */
export function macroDone(m: Macro, pos: number): boolean {
  return pos === m.values.length - 1 && (m.loop < 0 || (m.release > 0 && m.loop < m.release));
}

/** Ticks a second: 60 (NTSC, Furnace's default), 50 (PAL: a C64, a European Game Boy song). */
export const DEFAULT_TICK_RATE = 60;
