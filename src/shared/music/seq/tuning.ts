/**
 * Tunings: how a key is heard. A sequence may carry one (Sequence.tuning); the sequencer passes every note it emits
 * through `tunedPitch`, so the voices receive fractional MIDI notes — and every voice plays those as they are
 * (midiToHz is continuous; a Game Boy channel then rounds them to its 11-bit register, a chip's own grit).
 *
 * A tuning is a set of pitches repeating every `period` cents (1200 an octave, 1901.96 the Bohlen-Pierce tritave),
 * and a way to lay it on the keys:
 * - "retune": the twelve keys keep their names, each sounds at its pitch in the system — just intonation's pure
 *   thirds, meantone's sweet ones, a 24-EDO quarter tone under a .5 note. With exactly twelve steps a period of an
 *   octave, key k plays step k; otherwise each key goes to the system's nearest pitch.
 * - "steps": each key is the next step of the system, whatever its size — 19-EDO's 19 steps on 19 keys, an octave
 *   from C4 to G5.
 *
 * The root key (60 = C4 + its pitch class) sounds at its usual pitch: A stays 440 Hz in 12-TET, and every system
 * shares its root with it.
 */

export interface Tuning {
  /** Cents of each step above the root, ascending, the first 0 — one period's worth. */
  steps: number[];
  /** Cents of the period, after which the steps repeat. */
  period: number;
  map: "retune" | "steps";
  /** The MIDI key that sounds at its 12-TET pitch and is step 0. */
  root: number;
  /** Cents added to every note. */
  offset?: number;
}

const cents = (ratio: number) => 1200 * Math.log2(ratio);
const ratios = (rs: number[][]) => rs.map(([a, b]) => cents(a / b));
/** The pitch classes a chain of fifths reaches, from k = first to first + 11, as cents within the octave, by key. */
function fifthsChain(fifth: number, first: number): number[] {
  const out = new Array<number>(12).fill(0);
  for (let k = first; k < first + 12; k++) {
    const pc = (((7 * k) % 12) + 12) % 12;
    out[pc] = (((k * fifth) % 1200) + 1200) % 1200;
  }
  return out;
}
const edo = (n: number, period = 1200) => Array.from({ length: n }, (_, i) => (i * period) / n);

export interface TuningSystem {
  steps: number[];
  period: number;
}

/** The systems the Tuning node offers by name. "EDO" and "custom" are made from their own params. */
export const TUNING_SYSTEMS: Record<string, TuningSystem> = {
  "12-TET": { steps: edo(12), period: 1200 },
  "Just (5-limit)": { steps: ratios([[1, 1], [16, 15], [9, 8], [6, 5], [5, 4], [4, 3], [45, 32], [3, 2], [8, 5], [5, 3], [9, 5], [15, 8]]), period: 1200 },
  "Just (7-limit)": { steps: ratios([[1, 1], [16, 15], [9, 8], [7, 6], [5, 4], [4, 3], [7, 5], [3, 2], [8, 5], [5, 3], [7, 4], [15, 8]]), period: 1200 },
  Pythagorean: { steps: fifthsChain(cents(3 / 2), -5), period: 1200 },
  "Meantone (¼-comma)": { steps: fifthsChain(cents(5) / 4, -3), period: 1200 },
  "Werckmeister III": { steps: [0, 90.225, 192.18, 294.135, 390.225, 498.045, 588.27, 696.09, 792.18, 888.27, 996.09, 1092.18], period: 1200 },
  "Harmonic series 8–15": { steps: ratios([[8, 8], [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8], [15, 8]]), period: 1200 },
  "Slendro (gamelan)": { steps: [0, 231, 474, 717, 955], period: 1200 },
  "Pelog (gamelan)": { steps: [0, 120, 270, 540, 670, 785, 950], period: 1200 },
  "Bohlen-Pierce": { steps: edo(13, cents(3)), period: cents(3) },
};

export const TUNING_SYSTEM_NAMES = [...Object.keys(TUNING_SYSTEMS), "EDO", "custom"];

export function edoSystem(n: number): TuningSystem {
  const k = Math.max(1, Math.min(311, Math.round(n)));
  return { steps: edo(k), period: 1200 };
}

/**
 * A scale written by hand or pasted from a Scala .scl file: values in cents (with a dot: 386.31) or ratios (5/4, or
 * a whole number: 2), the last one the period — "9/8 5/4 4/3 3/2 5/3 15/8 2/1". A .scl's description line, its
 * count line and its ! comments are skipped. Null if there is not one usable value.
 */
export function parseScala(text: string): TuningSystem | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("!"));
  let words: string[];
  const count = lines.length >= 2 ? Number(lines[1]) : NaN;
  if (lines.length >= 3 && Number.isInteger(count) && lines.length - 2 >= count) {
    // A .scl file: description, count, then one value per line (anything after the value is a comment).
    words = lines.slice(2, 2 + count).map((l) => l.split(/\s+/)[0]);
  } else words = lines.join(" ").split(/[\s,;]+/).filter((w) => w !== "");
  const values: number[] = [];
  for (const w of words) {
    let c = NaN;
    if (w.includes(".")) c = Number(w);
    else if (w.includes("/")) {
      const [a, b] = w.split("/").map(Number);
      if (a > 0 && b > 0) c = cents(a / b);
    } else if (Number(w) > 0) c = cents(Number(w));
    if (Number.isFinite(c) && c > 0) values.push(c);
  }
  if (values.length === 0) return null;
  const period = values[values.length - 1];
  const steps = [0, ...values.slice(0, -1).filter((c) => c < period)].sort((a, b) => a - b);
  return { steps, period };
}

/** The tuning's pitch of a degree k (any integer), in cents above the root. */
function degreeCents(t: Tuning, k: number): number {
  const n = t.steps.length;
  const period = Math.floor(k / n);
  return period * t.period + t.steps[k - period * n];
}

/** The fractional MIDI note a key (or a fractional note, a maqam's .5) sounds at under the tuning. */
export function tunedPitch(t: Tuning | null | undefined, note: number): number {
  if (!t || t.steps.length === 0 || !(t.period > 0)) return note;
  const offset = (t.offset ?? 0) / 100;
  const d = note - t.root;
  let c: number;
  if (t.map === "steps") {
    const k = Math.floor(d);
    const a = degreeCents(t, k);
    c = a + (d - k) * (degreeCents(t, k + 1) - a);
  } else if (t.steps.length === 12 && Math.abs(t.period - 1200) < 1e-6) {
    const k = Math.floor(d + 1e-9);
    c = degreeCents(t, k) + (d - k) * 100;
  } else {
    // The nearest pitch of the system to the 12-TET one.
    const want = d * 100;
    const n = t.steps.length;
    const k0 = Math.floor(want / t.period) * n;
    c = degreeCents(t, k0);
    for (let k = k0 - 1; k <= k0 + n; k++) {
      const ck = degreeCents(t, k);
      if (Math.abs(ck - want) < Math.abs(c - want) - 1e-9) c = ck;
    }
  }
  return t.root + c / 100 + offset;
}
