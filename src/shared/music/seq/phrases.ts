/**
 * Felucca's factory phrases (SAVE > PHRASES on the FM-1), loadable into a Pattern.
 *
 * Source (GPL-3.0-only, as tsuji): Felucca, by Leo Kuroshita / Hügelton Instruments —
 * https://github.com/hugelton/Felucca, firmware/src/engines.c, PATTERNS. The three phrases for its slice engine
 * (CHOP, STUTTER, SLICES) are left out: tsuji has no sampler yet.
 *
 * Theirs: 16 steps of absolute MIDI notes (0 = rest), each with flags 1 accent, 2 slide, 4 tie (holds the previous
 * note), a step's note lasting one step otherwise. Ours (notation.ts): the note with its length (~n, the step and
 * the ties after it), velocity 1 on an accent and 0.75 without, and a slide as a glide into the next note (GLD6,
 * 60 ms, a 303's slide).
 */
import { noteName } from "./notation";

export interface FeluccaPhrase {
  name: string;
  /** What it was written for, from the source's comments. */
  hint: string;
  note: number[];
  flags: number[];
}

const T_ = 4;

export const FELUCCA_PHRASES: FeluccaPhrase[] = [
  { name: "ACID", hint: "acid line", note: [45, 45, 57, 45, 0, 48, 45, 55, 45, 0, 57, 52, 45, 48, 0, 50], flags: [1, 0, 2, 0, 0, 0, 1, 2, 0, 0, 1, 0, 0, 2, 0, 1] },
  { name: "OFFBEAT", hint: "bass", note: [0, 36, 0, 36, 0, 36, 0, 48, 0, 36, 0, 36, 0, 39, 0, 43], flags: [0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0] },
  { name: "MELODY", hint: "pluck", note: [60, 0, 67, 0, 72, 67, 0, 64, 62, 0, 69, 0, 74, 69, 0, 67], flags: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] },
  { name: "LEAD", hint: "lead", note: [72, 0, 0, 74, 0, 0, 76, 0, 79, 0, 76, 0, 74, 0, 0, 0], flags: [1, T_, 0, 2, T_, 0, 0, 0, 1, 0, 2, 0, 0, T_, T_, 0] },
  { name: "PAD", hint: "long notes", note: [60, 0, 0, 0, 0, 0, 0, 0, 57, 0, 0, 0, 55, 0, 0, 0], flags: [0, T_, T_, T_, T_, T_, T_, 0, 0, T_, T_, 0, 0, T_, T_, 0] },
  { name: "KEYS", hint: "offbeat stabs", note: [0, 0, 60, 0, 0, 63, 0, 0, 0, 0, 60, 0, 0, 65, 0, 63], flags: [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0] },
  { name: "BELL", hint: "sparse", note: [72, 0, 0, 79, 0, 0, 84, 0, 0, 0, 76, 0, 0, 0, 0, 0], flags: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: "SUB", hint: "low, held", note: [36, 0, 0, 0, 0, 0, 0, 36, 0, 0, 34, 0, 0, 0, 0, 0], flags: [1, T_, T_, T_, 0, 0, 0, 0, 0, 0, 0, T_, T_, T_, 0, 0] },
  { name: "BEAT", hint: "drums (GM)", note: [36, 42, 42, 42, 38, 42, 36, 42, 36, 42, 42, 36, 38, 42, 46, 42], flags: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] },
  { name: "ARP", hint: "16ths up a C minor arpeggio", note: [48, 51, 55, 60, 63, 67, 72, 75, 48, 51, 55, 60, 63, 67, 72, 75], flags: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0] },
];

/** A Felucca phrase as a Pattern's steps text. */
export function phraseSteps(p: FeluccaPhrase): string {
  const words: string[] = [];
  let glideNext = false;
  for (let i = 0; i < p.note.length; i++) {
    const n = p.note[i];
    if (n <= 0) {
      words.push(".");
      continue;
    }
    let ties = 0;
    // A tie holds the note on through the next steps (on rests; a tied note step would be a new note in ours).
    while (i + 1 + ties < p.note.length && p.flags[i + 1 + ties] & T_ && p.note[i + 1 + ties] <= 0) ties++;
    let w = noteName(n);
    w += p.flags[i] & 1 ? "@1" : "@0.75";
    w += `~${1 + ties}`;
    if (glideNext) w += "!GLD6";
    glideNext = (p.flags[i] & 2) !== 0;
    words.push(w);
  }
  return words.join(" ");
}
