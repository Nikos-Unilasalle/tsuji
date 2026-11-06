/**
 * Fit a melody to a chord grid: each note moved onto the chord sounding under it (Tonnetz Walk, Progression, Voice
 * Leading or a written Pattern of chords), the way the Scale node moves it into one fixed scale.
 *
 * - The chord at a step is the last chord cell at or before it, the grid looping (the first steps, before any chord,
 *   take the loop's last one). An OFF does not end the harmony.
 * - The two sequences are lined up by beats, so a melody in 16ths over chords written in 8ths still meets them.
 * - Chord tones: the chord's notes and `add`s, as pitch classes. Passing notes: a scale the chord lives in — its
 *   pentatonic, or its mode (major → ionian, minor → dorian, 7 → mixolydian, m7♭5 → locrian, aug → whole tone…).
 *
 * Pure: steps in, steps out.
 */
import { CHORDS, ChordName, chordNotes } from "./chords";
import { SCALES, ScaleName, ScaleSpec, SnapMode, snapNote } from "./scales";
import { Cell } from "./sequencer";

const EPS = 1e-6;
const mod12 = (x: number) => ((x % 12) + 12) % 12;

export type FitMode = "tones" | "strong" | "scale";
export type PassingNotes = "pentatonic" | "modes" | "chromatic";

export interface FitSettings {
  /** tones: every note on a chord tone. strong: strong steps and the first note under each chord on a chord tone, the
   * others in the chord's scale. scale: every note in the chord's scale. */
  mode: FitMode;
  passing: PassingNotes;
  snap: SnapMode;
  /** In the melody's steps: 4 = every beat of 16ths is strong. 0 = only the first note under each chord. */
  strongEvery: number;
  /** A note the same as the one before it becomes a rest: the note before holds on. */
  tieRepeats: boolean;
}

export interface ChordAt {
  /** The chord's root, a pitch class. */
  root: number;
  /** Its tones as intervals above the root, 0 first, ascending, within the octave. */
  tones: number[];
  /** The scale passing notes are taken from, on the same root. */
  scale: readonly number[];
}

const PENTATONICS: ScaleName[] = ["major pentatonic", "minor pentatonic"];
const MODES: ScaleName[] = [
  "major",
  "dorian",
  "mixolydian",
  "minor",
  "lydian",
  "phrygian",
  "harmonic minor",
  "melodic minor",
  "locrian",
  "whole tone",
  "octatonic (Messiaen 2)",
];

const KNOWN: readonly (readonly number[])[] = (Object.keys(CHORDS) as ChordName[]).map((c) => [...new Set(CHORDS[c].map(mod12))].sort((a, b) => a - b));

function intervalsOver(root: number, pcs: readonly number[]): number[] {
  const iv: number[] = [];
  for (const p of pcs) {
    const d = mod12(p - root);
    if (!iv.some((x) => Math.abs(x - d) < EPS)) iv.push(d);
  }
  return iv.sort((a, b) => a - b);
}

const sameSet = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < EPS);
const contains = (scale: readonly number[], tones: readonly number[]) => tones.every((t) => scale.some((s) => Math.abs(s - t) < EPS));

/** The chord a cell strikes: its root found among its notes (a voiced chord's lowest note is not always its root). */
export function chordOfCell(c: Cell, passing: PassingNotes): ChordAt | null {
  if (c.note === "off") return null;
  const notes = [...chordNotes(c.note, c.chord, c.inversion ?? 0, c.spread ?? false), ...(c.add ?? [])];
  const pcs = notes.map(mod12);
  let root = mod12(c.note);
  if (!c.chord) {
    for (const r of pcs) {
      const iv = intervalsOver(r, pcs);
      if (KNOWN.some((k) => sameSet(k, iv))) {
        root = r;
        break;
      }
    }
  }
  const tones = intervalsOver(root, pcs);
  const candidates = passing === "pentatonic" ? [...PENTATONICS, ...MODES] : passing === "modes" ? MODES : [];
  const name = candidates.find((n) => contains(SCALES[n], tones));
  return { root, tones, scale: name ? SCALES[name] : SCALES.chromatic };
}

/** The chord sounding at each step of the grid (null only when the grid holds no chord at all). */
export function chordTimeline(steps: readonly (Cell | null)[], passing: PassingNotes): (ChordAt | null)[] {
  const L = steps.length;
  const at: (ChordAt | null)[] = steps.map((c) => (c ? chordOfCell(c, passing) : null));
  let last: ChordAt | null = null;
  for (let i = L - 1; i >= 0 && !last; i--) last = at[i];
  if (!last) return new Array(L).fill(null);
  const out: (ChordAt | null)[] = [];
  for (let i = 0; i < L; i++) {
    if (at[i]) last = at[i];
    out.push(last);
  }
  return out;
}

const spec = (root: number, steps: readonly number[]): ScaleSpec => ({ root, steps });

/**
 * The melody fitted to the chords. `chordAt(i)` is the chord under the melody's step i (null: the note is kept).
 * A cell's chord and `add`s move with its note, by the same interval.
 */
export function fitToChords(steps: readonly (Cell | null)[], chordAt: (i: number) => ChordAt | null, s: FitSettings): (Cell | null)[] {
  const out: (Cell | null)[] = [];
  let prevChord: ChordAt | null = null;
  let lastNote: number | null = null;
  let changed = true;
  for (let i = 0; i < steps.length; i++) {
    const chord = chordAt(i);
    if (chord !== prevChord) changed = true;
    prevChord = chord;
    const c = steps[i];
    if (!c || c.note === "off" || !chord) {
      if (c) lastNote = null;
      out.push(c);
      continue;
    }
    const strong = changed || (s.strongEvery > 0 && i % s.strongEvery === 0);
    const onTone = s.mode === "tones" || (s.mode === "strong" && strong);
    const note = Math.min(127, Math.max(0, snapNote(spec(chord.root, onTone ? chord.tones : chord.scale), c.note, s.snap)));
    changed = false;
    if (s.tieRepeats && lastNote !== null && Math.abs(note - lastNote) < EPS) {
      out.push(null);
      continue;
    }
    lastNote = note;
    const d = note - c.note;
    out.push(d === 0 ? c : { ...c, note, ...(c.add ? { add: c.add.map((n) => n + d) } : {}) });
  }
  return out;
}
