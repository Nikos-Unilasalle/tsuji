/**
 * Adaptive just intonation: each chord retuned, while it sounds, to pure ratios over its own root — the beatless
 * thirds and fifths of a choir or a string quartet, which no fixed tuning gives in every key. The Adaptive JI node
 * marks a cell (Cell.ji: the root it found, the limit, whether to stay centred); the sequencer moves each of the
 * cell's notes by the cents here as it emits them.
 *
 * Retuning chord by chord drifts: the C of C major and the C of A minor are not the same pitch in just intonation.
 * "Centred" keeps each chord's average pitch where 12-TET has it, so the song never wanders off — the trick of
 * adaptive tuning systems (Hermode's): the chord is pure inside, the whole stays put.
 */

export interface AdaptiveJi {
  /** The pitch class (0–11) the ratios are counted from. */
  root: number;
  /** 5: thirds and fifths (5/4, 6/5, 3/2); 7: the harmonic seventh too (7/4, 7/6). */
  limit: 5 | 7;
  center: boolean;
}

/** Cents a 12-TET interval (semitones above the root, 0–11) moves to its pure ratio. */
const JI5 = [0, 11.73, 3.91, 15.64, -13.69, -1.96, -9.78, 1.96, 13.69, -15.64, 17.6, -11.73];
const JI7 = [0, 11.73, 3.91, -33.13, -13.69, -1.96, -17.49, 1.96, 13.69, -15.64, -31.17, -11.73];

export function jiCents(ji: AdaptiveJi, note: number): number {
  const d = ((Math.round(note - ji.root) % 12) + 12) % 12;
  return (ji.limit === 7 ? JI7 : JI5)[d];
}

/** How far each note of a chord moves, in semitones (centred: their mean is 0). */
export function jiOffsets(ji: AdaptiveJi, notes: readonly number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (notes.length === 0) return out;
  const cents = notes.map((n) => jiCents(ji, n));
  const mean = ji.center ? cents.reduce((a, b) => a + b, 0) / cents.length : 0;
  notes.forEach((n, i) => out.set(n, (cents[i] - mean) / 100));
  return out;
}

/**
 * The root under which a set of pitch classes is simplest — the one whose intervals to the others are the plainest
 * ratios (a fifth, a third…): the C of C E G, the A of A C E, the G of G B D F.
 */
export function bestRoot(pcs: readonly number[]): number {
  // How simple each interval above a root is (lower: simpler ratio).
  const COMPLEXITY = [0, 6, 4, 2, 2, 3, 7, 1, 3, 3, 4, 5];
  let best = pcs[0] ?? 0;
  let bestScore = Infinity;
  for (const r of pcs) {
    const score = pcs.reduce((a, p) => a + COMPLEXITY[((Math.round(p - r) % 12) + 12) % 12], 0);
    if (score < bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return ((Math.round(best) % 12) + 12) % 12;
}
