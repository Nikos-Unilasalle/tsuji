/**
 * Chords from one root note: a pattern cell holds `C-4 min7` and the sequencer plays C, E♭, G, B♭.
 * A table of data, not code — one line adds a chord.
 */

export const CHORDS = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  "7": [0, 4, 7, 10],
  "9": [0, 4, 7, 10, 14],
  sus: [0, 5, 7],
  dim: [0, 3, 6],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  sus2: [0, 2, 7],
  dim7: [0, 3, 6, 9],
  aug: [0, 4, 8],
} as const satisfies Record<string, readonly number[]>;

export type ChordName = keyof typeof CHORDS;

/**
 * In the order they are offered (and numbered, for a wired chord input). Spelled out: Object.keys would put "7" and
 * "9" first, integer-like keys always come first in JavaScript.
 */
export const CHORD_NAMES: ChordName[] = ["maj", "min", "7", "9", "sus", "dim", "maj7", "min7", "sus2", "dim7", "aug"];

export function isChordName(name: unknown): name is ChordName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(CHORDS, name);
}

/**
 * The notes of a chord, in the order they are stacked: the chord's own intervals, after the inversion. Lowest first
 * unless spread moved some up; an arpeggio's "played" mode keeps this order, the others sort it.
 *
 * - inversion k (0–3) moves the k lowest notes up an octave: C maj, 1st inversion = E G C.
 * - spread opens the voicing: every second note goes up an octave, C E G B → C E′ G B′ (heard as C G E′ B′).
 */
export function chordNotes(root: number, chord: ChordName | null | undefined, inversion = 0, spread = false): number[] {
  const intervals: readonly number[] = chord ? CHORDS[chord] : [0];
  let notes = intervals.map((i) => root + i);
  const inv = Math.max(0, Math.min(notes.length - 1, Math.round(inversion)));
  for (let k = 0; k < inv; k++) notes = [...notes.slice(1), notes[0] + 12];
  if (spread && notes.length > 2) notes = notes.map((n, i) => (i % 2 === 1 ? n + 12 : n));
  return notes;
}
