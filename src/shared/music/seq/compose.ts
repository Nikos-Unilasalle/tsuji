/**
 * Composition tools working on whole phrases rather than one cell at a time — pure, seeded, like the rest of seq/:
 *
 * - events: a pattern read as notes and rests with their durations, and written back (the common ground of the rest);
 * - motif transforms: retrograde, inversion, augmentation / diminution, sequence (the motif repeated, moved);
 * - markov: a chain learned from a phrase, improvising in its style;
 * - progression: Roman numerals (I vi ii7 V7, V/V, bVII…) or a functional random walk, to chords;
 * - voice leading: each chord re-voiced to move the fewest semitones from the last, within a range.
 */
import { ChordName, chordNotes } from "./chords";
import { hash01 } from "./hash";
import { ScaleSpec, degreeNote, degreeOf, snapNote, stackedChord, scaleSpec } from "./scales";
import type { Cell } from "./sequencer";

// ── Events ─────────────────────────────────────────────────────────────────

/** A note (its cell) or a rest (null), from `start` for `dur` steps. */
export interface Ev {
  start: number;
  dur: number;
  cell: Cell | null;
}

/**
 * One loop of a pattern as events, back to back from step 0 to L. A note lasts to the next cell, or its own length
 * (then a rest); an OFF starts a rest; the silence before the first cell is a rest.
 */
export function eventsOf(steps: readonly (Cell | null)[], length = steps.length): Ev[] {
  const L = Math.max(1, length);
  const at: number[] = [];
  for (let i = 0; i < L; i++) if (steps[i]) at.push(i);
  const out: Ev[] = [];
  if (at.length === 0) return [{ start: 0, dur: L, cell: null }];
  if (at[0] > 0) out.push({ start: 0, dur: at[0], cell: null });
  at.forEach((p, k) => {
    const next = k + 1 < at.length ? at[k + 1] : L;
    const c = steps[p]!;
    if (c.note === "off") {
      out.push({ start: p, dur: next - p, cell: null });
      return;
    }
    const len = c.length && c.length > 0 ? Math.min(next - p, Math.max(1, Math.round(c.length))) : next - p;
    const { length: _len, ...cell } = c;
    out.push({ start: p, dur: len, cell });
    if (len < next - p) out.push({ start: p + len, dur: next - p - len, cell: null });
  });
  // Neighbouring rests are one rest.
  return out.reduce<Ev[]>((acc, e) => {
    const last = acc[acc.length - 1];
    if (last && !last.cell && !e.cell) last.dur += e.dur;
    else acc.push({ ...e });
    return acc;
  }, []);
}

/** Events laid back on steps: a note's cell where it starts, an OFF where a rest starts (a held note would go on). */
export function stepsOf(events: readonly Ev[], length: number): (Cell | null)[] {
  const L = Math.max(1, length);
  const steps: (Cell | null)[] = new Array(L).fill(null);
  for (const e of events) {
    if (e.start < 0 || e.start >= L || steps[e.start]) continue;
    steps[e.start] = e.cell ? { ...e.cell } : { note: "off" };
  }
  return steps;
}

/** Back-to-back events: each starts where the last ended. */
function relay(events: readonly Ev[]): Ev[] {
  let t = 0;
  return events.map((e) => {
    const out = { ...e, start: t };
    t += e.dur;
    return out;
  });
}

/** Every pitch of a cell through f: a chord is kept as a chord when f only moves it, spelled out as notes otherwise. */
export function mapCell(c: Cell, f: (n: number) => number, rigid: boolean): Cell {
  if (c.note === "off") return c;
  if (rigid || !c.chord) {
    const out: Cell = { ...c, note: f(c.note) };
    if (c.add) out.add = c.add.map(f);
    return out;
  }
  const tones = [...chordNotes(c.note, c.chord, c.inversion ?? 0, c.spread ?? false), ...(c.add ?? [])].map(f);
  const { inversion: _i, spread: _s, addVelocity: _v, ...rest } = c;
  return { ...rest, note: tones[0], chord: null, add: tones.slice(1) };
}

const clampNote = (n: number) => Math.min(127, Math.max(0, n));

// ── Motif transforms ───────────────────────────────────────────────────────

export const MOTIF_OPS = ["retrograde", "inversion", "retrograde inversion", "augmentation", "diminution", "sequence", "rotation"] as const;
export type MotifOp = (typeof MOTIF_OPS)[number];

export interface MotifSettings {
  op: MotifOp;
  /** Inversion: the mirror note (NaN: the first note). */
  axis: number;
  /** Sequence: how many copies, and the move from one to the next (semitones, or degrees with a scale). */
  repeats: number;
  interval: number;
  /** Rotation: steps. Augmentation / diminution: the factor (2 = twice as long / as fast). */
  amount: number;
  /** With a scale, inversion and sequence move by its degrees (a tonal answer, not an exact one). */
  scale: ScaleSpec | null;
}

function firstNote(events: readonly Ev[]): number | null {
  for (const e of events) if (e.cell && e.cell.note !== "off") return e.cell.note;
  return null;
}

/** A phrase transformed; returns the new steps (its length may change). */
export function transformMotif(steps: readonly (Cell | null)[], length: number, s: MotifSettings): (Cell | null)[] {
  const L = Math.max(1, length);
  const events = eventsOf(steps, L);
  const sc = s.scale;
  const invert = (evs: Ev[]) => {
    const axis = Number.isFinite(s.axis) ? s.axis : (firstNote(evs) ?? 60);
    const f = sc
      ? (n: number) => {
          const a = degreeOf(sc, snapNote(sc, axis));
          return clampNote(degreeNote(sc, 2 * a - degreeOf(sc, snapNote(sc, n))));
        }
      : (n: number) => clampNote(2 * axis - n);
    return evs.map((e) => (e.cell ? { ...e, cell: mapCell(e.cell, f, false) } : e));
  };
  switch (s.op) {
    case "retrograde":
      return stepsOf(relay([...events].reverse()), L);
    case "inversion":
      return stepsOf(invert(events), L);
    case "retrograde inversion":
      return stepsOf(relay(invert([...events].reverse())), L);
    case "augmentation":
    case "diminution": {
      const k = Math.max(1, s.amount);
      const f = s.op === "augmentation" ? k : 1 / k;
      const out = Math.max(1, Math.min(16384, Math.round(L * f)));
      return stepsOf(
        events.map((e) => ({ ...e, start: Math.round(e.start * f), dur: Math.max(1, Math.round(e.dur * f)) })),
        out,
      );
    }
    case "sequence": {
      const n = Math.max(1, Math.min(16, Math.round(s.repeats)));
      const out: Ev[] = [];
      for (let r = 0; r < n; r++) {
        const by = r * s.interval;
        const f = sc ? (x: number) => clampNote(degreeNote(sc, degreeOf(sc, snapNote(sc, x)) + by)) : (x: number) => clampNote(x + by);
        for (const e of events) out.push({ ...e, start: e.start + r * L, cell: e.cell ? mapCell(e.cell, f, !sc) : null });
      }
      return stepsOf(out, Math.min(16384, L * n));
    }
    case "rotation": {
      const k = ((Math.round(s.amount) % L) + L) % L;
      return Array.from({ length: L }, (_, i) => steps[(i - k + L) % L] ?? null);
    }
  }
}

// ── Markov ─────────────────────────────────────────────────────────────────

export interface MarkovSettings {
  /** 1–4: how many past events choose the next. */
  order: number;
  /** Steps to fill. */
  length: number;
  /** "both": notes and durations learned together; "pitch": the source's rhythm kept, only the notes learned. */
  learn: "both" | "pitch";
  /** 0–1: the chance to forget part of the past and draw from a shorter memory — more surprises. */
  novelty: number;
  seed: number;
}

const MARKOV_SALT = 0x4d4b56;

/** A new phrase in the style of the given ones. Empty sources give an empty pattern. */
export function markov(sources: readonly (readonly Ev[])[], s: MarkovSettings): (Cell | null)[] {
  const L = Math.max(1, Math.min(16384, Math.round(s.length)));
  const pitchOnly = s.learn === "pitch";
  const keyOf = (e: Ev) => JSON.stringify(pitchOnly ? [e.cell] : [e.cell, e.dur]);
  const vocab = new Map<string, Ev>();
  const seqs = sources
    .map((evs) => evs.filter((e) => !pitchOnly || e.cell))
    .filter((evs) => evs.length > 0)
    .map((evs) =>
      evs.map((e) => {
        const k = keyOf(e);
        if (!vocab.has(k)) vocab.set(k, e);
        return k;
      }),
    );
  if (seqs.length === 0) return new Array(L).fill(null);
  const order = Math.max(1, Math.min(4, Math.round(s.order)));
  // Counts for every context of length 0..order, each source read as a loop so no context is a dead end.
  const table = new Map<string, Map<string, number>>();
  for (const q of seqs) {
    for (let i = 0; i < q.length; i++) {
      for (let k = 0; k <= order; k++) {
        const ctx = Array.from({ length: k }, (_, j) => q[(((i - k + j) % q.length) + q.length) % q.length]).join("|");
        let m = table.get(`${k}:${ctx}`);
        if (!m) table.set(`${k}:${ctx}`, (m = new Map()));
        m.set(q[i], (m.get(q[i]) ?? 0) + 1);
      }
    }
  }
  const rhythm = pitchOnly ? sources.flat().map((e) => e) : [];
  const history: string[] = [];
  // Starting where a source starts, so the first notes sound like a beginning.
  const first = seqs[Math.floor(hash01(s.seed, 0, MARKOV_SALT) * seqs.length)];
  const out: Ev[] = [];
  let t = 0;
  for (let i = 0; t < L && i < 16384; i++) {
    let key: string;
    if (i < Math.min(order, first.length)) key = first[i];
    else {
      let k = Math.min(order, history.length);
      if (k > 0 && hash01(i, s.seed, MARKOV_SALT + 1) < s.novelty) k = Math.floor(hash01(i, s.seed, MARKOV_SALT + 2) * k);
      let m: Map<string, number> | undefined;
      for (; k >= 0 && !m; k--) m = table.get(`${k}:${history.slice(history.length - k).join("|")}`);
      const entries = [...m!.entries()];
      const total = entries.reduce((a, [, c]) => a + c, 0);
      let x = hash01(i, s.seed, MARKOV_SALT + 3) * total;
      key = entries[entries.length - 1][0];
      for (const [k2, c] of entries) {
        if ((x -= c) < 0) {
          key = k2;
          break;
        }
      }
    }
    history.push(key);
    const e = vocab.get(key)!;
    if (pitchOnly) {
      // The source's rhythm, event by event: its rests as they were, the notes the chain's.
      let r = rhythm[out.length % rhythm.length];
      while (!r.cell && t < L) {
        out.push({ start: t, dur: r.dur, cell: null });
        t += r.dur;
        r = rhythm[out.length % rhythm.length];
      }
      out.push({ start: t, dur: r.dur, cell: e.cell });
      t += r.dur;
    } else {
      out.push({ start: t, dur: e.dur, cell: e.cell });
      t += e.dur;
    }
  }
  return stepsOf(out, L);
}

// ── Progression ────────────────────────────────────────────────────────────

const MAJOR_DEGREES = [0, 2, 4, 5, 7, 9, 11];
const MINOR_DEGREES = [0, 2, 3, 5, 7, 8, 10];
const NUMERAL_DEGREE: Record<string, number> = { i: 0, ii: 1, iii: 2, iv: 3, v: 4, vi: 5, vii: 6 };

export interface ProgressionChord {
  /** Semitones above the key's root. */
  root: number;
  chord: ChordName;
  /** In chord lengths. */
  beats: number;
}

/** The chord of one numeral (V7, ii°, bVII, V/V, iiø7, IVmaj7:2), or null if it is not one. */
export function parseNumeral(word: string, minor: boolean): ProgressionChord | null {
  let w = word.trim();
  let beats = 1;
  const len = /:(\d+(?:\.\d+)?)$/.exec(w);
  if (len) {
    beats = Math.max(0.25, Number(len[1]));
    w = w.slice(0, len.index);
  }
  const [main, target] = w.split("/");
  const one = (text: string, minorKey: boolean): { root: number; upper: boolean; suffix: string } | null => {
    const m = /^([b#♭♯]*)([ivIV]+)(.*)$/.exec(text);
    if (!m) return null;
    const numeral = m[2].toLowerCase();
    if (!(numeral in NUMERAL_DEGREE)) return null;
    const acc = [...m[1]].reduce((a, c) => a + (c === "#" || c === "♯" ? 1 : -1), 0);
    const degrees = minorKey ? MINOR_DEGREES : MAJOR_DEGREES;
    return { root: degrees[NUMERAL_DEGREE[numeral]] + acc, upper: m[2] === m[2].toUpperCase(), suffix: m[3] };
  };
  const head = one(main, minor);
  if (!head) return null;
  let root = head.root;
  if (target !== undefined) {
    // V/V: the chord's numeral read in the key of the target (tonicized as major, or minor for a lower-case target).
    const t = one(target, minor);
    if (!t) return null;
    const inTarget = one(main, !t.upper);
    if (!inTarget) return null;
    root = t.root + inTarget.root;
  }
  const s = head.suffix.replace(/^(maj|M|Δ)7?$/, "maj7");
  let chord: ChordName;
  if (s === "maj7") chord = "maj7";
  else if (/^(ø|ø7|m7b5|h7?)$/.test(s)) chord = "m7b5";
  else if (/^(°7|o7|dim7)$/.test(s)) chord = "dim7";
  else if (/^(°|o|dim)$/.test(s)) chord = "dim";
  else if (/^(\+|aug)$/.test(s)) chord = "aug";
  else if (s === "7") chord = head.upper ? "7" : "min7";
  else if (s === "9") chord = "9";
  else if (/^sus4?$/.test(s)) chord = "sus";
  else if (s === "sus2") chord = "sus2";
  else if (s === "") chord = head.upper ? "maj" : "min";
  else return null;
  return { root: ((root % 12) + 12) % 12, chord, beats };
}

const ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii"];
const LOWER_CHORDS = new Set(["min", "min7", "dim", "dim7", "m7b5"]);
const SUFFIX: Partial<Record<ChordName, string>> = { dim: "°", dim7: "°7", m7b5: "ø7", maj7: "maj7", "7": "7", min7: "7", aug: "+", "9": "9", sus: "sus", sus2: "sus2" };

/**
 * A chord as a numeral in the key (the inverse of parseNumeral, length aside): its degree in the key's scale — or the
 * one above, flattened, for a chromatic root (bVI, bII) — upper case for a major-third chord, with its suffix. Null for
 * a chord no numeral says (a minor 7th on an upper-case numeral, say).
 */
export function numeralOf(root: number, chord: ChordName, minor: boolean): string | null {
  const degrees = minor ? MINOR_DEGREES : MAJOR_DEGREES;
  const pc = ((Math.round(root) % 12) + 12) % 12;
  let d = degrees.indexOf(pc);
  let acc = "";
  if (d < 0) {
    d = degrees.findIndex((x) => x === pc + 1);
    acc = "b";
    if (d < 0) {
      d = degrees.findIndex((x) => x === pc - 1);
      acc = "#";
    }
    if (d < 0) return null;
  }
  const upper = !LOWER_CHORDS.has(chord);
  const word = `${acc}${upper ? ROMAN[d].toUpperCase() : ROMAN[d]}${SUFFIX[chord] ?? ""}`;
  const back = parseNumeral(word, minor);
  return back && back.root === pc && back.chord === chord ? word : null;
}

/** A numeral's degree in the key (0 = I … 6 = vii), and whether it is chromatic (an accidental or a /target). */
export function numeralDegree(word: string): { degree: number; chromatic: boolean } | null {
  const w = word.trim().replace(/:\d+(?:\.\d+)?$/, "");
  const [main, target] = w.split("/");
  const m = /^([b#♭♯]*)([ivIV]+)/.exec(main);
  if (!m || !(m[2].toLowerCase() in NUMERAL_DEGREE)) return null;
  return { degree: NUMERAL_DEGREE[m[2].toLowerCase()], chromatic: m[1] !== "" || target !== undefined };
}

export function parseProgression(text: string, minor: boolean): ProgressionChord[] {
  return text
    .split(/[\s,|\-–]+/)
    .filter((w) => w !== "")
    .map((w) => parseNumeral(w, minor))
    .filter((c): c is ProgressionChord => !!c);
}

/** Where each degree tends to go (classical practice: tonic → predominant → dominant → tonic), with weights. */
export const FUNCTION_MOVES: Record<number, Record<number, number>> = {
  0: { 3: 3, 4: 3, 5: 2, 1: 2, 2: 1 },
  1: { 4: 4, 6: 1, 3: 1 },
  2: { 5: 3, 3: 2 },
  3: { 4: 4, 0: 2, 1: 2, 6: 1 },
  4: { 0: 5, 5: 2, 3: 1 },
  5: { 1: 3, 3: 3, 4: 1, 2: 1 },
  6: { 0: 4, 2: 1 },
};

/**
 * A seeded walk of `count` chords along the usual functional paths. `tension` 0–1 flattens the odds toward the rarer
 * moves (and now and then any degree); `cadence` ends it V → I. Chords are the key's own, triads or sevenths — in
 * minor, V and vii are made from the harmonic minor, as they are in practice.
 */
export function randomProgression(count: number, minor: boolean, sevenths: boolean, tension: number, cadence: boolean, seed: number): ProgressionChord[] {
  const n = Math.max(1, Math.round(count));
  const degrees: number[] = [0];
  for (let i = 1; i < n; i++) {
    const prev = degrees[i - 1];
    if (cadence && i === n - 1) {
      degrees.push(0);
      continue;
    }
    if (cadence && i === n - 2 && n >= 3) {
      degrees.push(4);
      continue;
    }
    if (hash01(i, seed, 0x50524f31) < tension * 0.25) {
      degrees.push(Math.floor(hash01(i, seed, 0x50524f32) * 7));
      continue;
    }
    const moves = Object.entries(FUNCTION_MOVES[prev]).map(([d, w]) => [Number(d), Math.pow(w, 1 - Math.min(1, Math.max(0, tension)))] as const);
    const total = moves.reduce((a, [, w]) => a + w, 0);
    let x = hash01(i, seed, 0x50524f33) * total;
    let pick = moves[moves.length - 1][0];
    for (const [d, w] of moves) {
      if ((x -= w) < 0) {
        pick = d;
        break;
      }
    }
    degrees.push(pick);
  }
  const natural = scaleSpec(minor ? "minor" : "major", 0);
  const harmonic = scaleSpec("harmonic minor", 0);
  return degrees.map((d) => {
    const s = minor && (d === 4 || d === 6) ? harmonic : natural;
    const root = degreeNote(s, d);
    const { chord } = stackedChord(s, root, sevenths ? 4 : 3);
    return { root, chord: chord ?? (sevenths ? "7" : "maj"), beats: 1 };
  });
}

// ── Voice leading ──────────────────────────────────────────────────────────

export interface VoicingSettings {
  /** How many notes each chord gets (its tones doubled or thinned); 0: as many as it has. */
  voices: number;
  low: number;
  high: number;
}

/** The chord's pitch classes, root first. */
function pitchClasses(c: Cell): number[] {
  if (c.note === "off") return [];
  const tones = [...chordNotes(c.note, c.chord, 0, false), ...(c.add ?? [])];
  const pcs: number[] = [];
  for (const n of tones) {
    const pc = ((n % 12) + 12) % 12;
    if (!pcs.some((x) => Math.abs(x - pc) < 1e-6)) pcs.push(pc);
  }
  return pcs;
}

/** The voicing of `pcs` in [low, high] closest to `prev` (or, first, a close one around the middle). */
export function voiceChord(pcs: readonly number[], prev: readonly number[] | null, s: VoicingSettings): number[] {
  if (pcs.length === 0) return [];
  const V = Math.max(1, Math.min(6, Math.round(s.voices) || pcs.length));
  let tones = [...pcs];
  // Too many tones: drop the fifth first (it adds the least), then the root (a pianist's rootless voicing).
  while (tones.length > V) {
    const fifth = tones.findIndex((p, i) => i > 0 && Math.abs(((p - tones[0] + 12) % 12) - 7) < 1e-6);
    tones.splice(fifth >= 0 ? fifth : 0, 1);
  }
  for (let i = 0; tones.length < V; i++) tones.push(pcs[i % pcs.length]);
  const low = Math.min(s.low, s.high - 12);
  const high = Math.max(s.high, low + 12);
  const center = (low + high) / 2;
  const options = tones.map((pc) => {
    const out: number[] = [];
    for (let n = pc + 12 * Math.ceil((low - pc) / 12); n <= high; n += 12) out.push(n);
    return out;
  });
  let best: number[] = [];
  let bestCost = Infinity;
  const pick: number[] = [];
  const walk = (i: number) => {
    if (i === tones.length) {
      const v = [...pick].sort((a, b) => a - b);
      for (let k = 1; k < v.length; k++) if (Math.abs(v[k] - v[k - 1]) < 1e-6) return; // no unisons
      if (v[v.length - 1] - v[0] > 24) return;
      const mean = v.reduce((a, b) => a + b, 0) / v.length;
      const span = v[v.length - 1] - v[0];
      let cost = 0.15 * Math.abs(mean - center) + 0.05 * span;
      if (prev && prev.length === v.length) cost += v.reduce((a, n, k) => a + Math.abs(n - prev[k]), 0);
      else if (prev && prev.length > 0) cost += Math.abs(mean - prev.reduce((a, b) => a + b, 0) / prev.length) * v.length;
      else cost += span * 0.3;
      if (cost < bestCost) {
        bestCost = cost;
        best = v;
      }
      return;
    }
    for (const n of options[i]) {
      pick.push(n);
      walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  return best.length ? best : tones.map((pc) => pc + 12 * Math.round((center - pc) / 12)).sort((a, b) => a - b);
}

/** Every chord cell re-voiced (as its notes: chord null, `add` the upper ones), and a bass of their roots. */
export function voiceLead(steps: readonly (Cell | null)[], s: VoicingSettings): { voiced: (Cell | null)[]; bass: (Cell | null)[] } {
  let prev: number[] | null = null;
  const voiced: (Cell | null)[] = [];
  const bass: (Cell | null)[] = [];
  const bassLow = Math.min(s.low, s.high - 12) - 24;
  for (const c of steps) {
    if (!c || c.note === "off") {
      voiced.push(c);
      bass.push(c);
      continue;
    }
    const pcs = pitchClasses(c);
    const v = voiceChord(pcs, prev, s);
    prev = v;
    const { inversion: _i, spread: _s, addVelocity: _a, add: _add, ...rest } = c;
    voiced.push({ ...rest, note: v[0], chord: null, add: v.slice(1) });
    const pc = pcs[0];
    bass.push({ ...rest, note: pc + 12 * Math.ceil((bassLow - pc) / 12), chord: null });
  }
  return { voiced, bass };
}

// ── Contour ────────────────────────────────────────────────────────────────

export interface ContourSettings {
  steps: number;
  scale: ScaleSpec;
  low: number;
  /** Scale degrees above `low` the highest value reaches. */
  range: number;
  /** "every": a note on every step; "change": only when the note changes (a held note otherwise). */
  rhythm: "every" | "change";
  invert: boolean;
  velocity: number;
}

/** Numbers → a melody: resampled to `steps`, min..max spread over the range's scale degrees. */
export function contourMelody(values: readonly number[], s: ContourSettings, velocities?: readonly number[]): (Cell | null)[] {
  const N = Math.max(1, Math.min(16384, Math.round(s.steps)));
  const vals = values.filter(Number.isFinite);
  if (vals.length === 0) return new Array(N).fill(null);
  const sample = (arr: readonly number[], i: number) => {
    if (arr.length === 1) return arr[0];
    const x = (i / Math.max(1, N - 1)) * (arr.length - 1);
    const k = Math.min(arr.length - 2, Math.floor(x));
    return arr[k] + (x - k) * (arr[k + 1] - arr[k]);
  };
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const base = degreeOf(s.scale, snapNote(s.scale, s.low, "up"));
  const range = Math.max(0, Math.round(s.range));
  const out: (Cell | null)[] = [];
  let last: number | null = null;
  for (let i = 0; i < N; i++) {
    let u = max > min ? (sample(vals, i) - min) / (max - min) : 0.5;
    if (s.invert) u = 1 - u;
    const note = clampNote(degreeNote(s.scale, base + Math.round(u * range)));
    if (s.rhythm === "change" && note === last) {
      out.push(null);
      continue;
    }
    last = note;
    const vel = velocities && velocities.length ? Math.min(1, Math.max(0, sample(velocities, i))) : s.velocity;
    out.push({ note, velocity: vel });
  }
  return out;
}
