/**
 * The sequencer: a clock and a tracker pattern in, notes dated to the sample out (see docs/music-nodes-mvp.md).
 *
 * Pure, like the DSP core. Nothing is "played" here and no state is kept: every question — which notes start in this
 * block, which are sounding at this sample — is answered from the sequence and the sample number alone. Seeking,
 * looping the timeline, rendering an export from frame 0: all the same call.
 *
 * Time: sample 0 is step 0 of the song. Times are computed exactly (floating) and rounded to a sample only when a note
 * is emitted, so nothing drifts: at 137 BPM, step 548 (137 beats) lands on sample 2 880 000 exactly at 48 kHz.
 *
 * Tracker semantics: a note sounds until the next triggering cell of the same track (another note, or OFF), or for
 * its own `length` in steps if it has one. The pattern loops; a note's end is looked for across the loop.
 *
 * Expansion order for each triggering cell: note + chord → inversion / spread → arpeggio → effects.
 */
import { ArpSettings, arpNote, arpPool, arpStepBeats } from "./arp";
import { ChordName, chordNotes } from "./chords";
import { hash01 } from "./hash";
import type { BankLayout } from "./order";

export interface Clock {
  bpm: number;
  /** 0 = straight, 1 = the strongest: each second step is played half a step late (75 / 25). */
  swing: number;
  /** Steps per beat: 4 makes a step a sixteenth note. */
  stepsPerBeat: number;
}

export type CellFx =
  /** Glide from the previous note over value × 10 ms. */
  | { type: "GLD"; value: number }
  /** Ratchet: the note is struck `value` times (2–8) inside its step. */
  | { type: "RTG"; value: number }
  /** Chance: the cell plays with a probability of value %; seeded, so every run plays the same. */
  | { type: "CHN"; value: number }
  /** Delay: the note comes value / 16 of a step late (0–15) — a hand that is not a machine. */
  | { type: "DLY"; value: number };

export interface Cell {
  /** A MIDI note (the chord's root), or "off" to end the note sounding. */
  note: number | "off";
  chord?: ChordName | null;
  /** More notes struck with it (kick+hat on a drum track, a voicing of your own on a synth). */
  add?: number[];
  inversion?: number;
  spread?: boolean;
  /** 0–1, 0.8 when left out. */
  velocity?: number;
  /** The velocity of each `add` note when they are not all struck as hard as `note` (a soft hat on a loud kick). */
  addVelocity?: number[];
  /** In steps. When left out, the note lasts until the next note or OFF. */
  length?: number;
  fx?: CellFx | null;
}

export interface Pattern {
  /** 16, 32 or 64. */
  length: number;
  /** Index = step; null (or past the end) = empty. */
  steps: (Cell | null)[];
}

export interface Sequence {
  clock: Clock;
  pattern: Pattern;
  arp?: ArpSettings | null;
  /** Makes two tracks with the same pattern draw their chances differently. */
  seed?: number;
  /** A bank of patterns laid end to end along an order list (order.ts): `pattern` is the whole song; this says which
   * numbered pattern is where. The sequencer does not read it. */
  bank?: BankLayout;
}

export interface NoteEvent {
  /** Sample of the note-on. */
  on: number;
  /** Sample of the note-off, after `on`. When an off and an on share a sample, the off comes first. */
  off: number;
  note: number;
  velocity: number;
  /** The global step (counted from the song's start) of the cell that played it. */
  step: number;
  /** For a glide: the note to start from, and the time to reach `note`. */
  glideFrom?: number;
  glideSeconds?: number;
}

/** The sequence with every note moved by `semitones` (OFFs and empty steps as they are), kept in MIDI range. */
export function transposeSequence(seq: Sequence, semitones: number): Sequence {
  if (!semitones) return seq;
  const move = (n: number) => Math.min(127, Math.max(0, n + semitones));
  const steps = seq.pattern.steps.map((c) =>
    !c || c.note === "off" ? c : { ...c, note: move(c.note), ...(c.add ? { add: c.add.map(move) } : {}) },
  );
  return { ...seq, pattern: { ...seq.pattern, steps } };
}

const DEFAULT_VELOCITY = 0.8;
const CHANCE_SALT = 0x43484e;
const RATCHET_GATE = 0.75;

function stepLength(clock: Clock, sampleRate: number): number {
  return (60 * sampleRate) / (Math.max(1, clock.bpm) * Math.max(1, clock.stepsPerBeat));
}

/** Exact (unrounded) start of global step g, swing included. */
export function stepTime(clock: Clock, sampleRate: number, g: number): number {
  const swing = Math.min(1, Math.max(0, clock.swing));
  return (g + (g % 2 === 1 ? swing * 0.5 : 0)) * stepLength(clock, sampleRate);
}

/** The sample global step g starts on. */
export function stepSample(clock: Clock, sampleRate: number, g: number): number {
  return Math.round(stepTime(clock, sampleRate, g));
}

/** The global step under a time (in samples): the last one started at or before it; −1 before the song. */
export function stepAt(clock: Clock, sampleRate: number, t: number): number {
  if (t < 0) return -1;
  let g = Math.floor(t / stepLength(clock, sampleRate));
  // Swing only ever delays a step, so the floor is right or one too far.
  if (stepTime(clock, sampleRate, g) > t) g--;
  return g;
}

function cellAt(seq: Sequence, g: number): Cell | null {
  const L = Math.max(1, Math.round(seq.pattern.length));
  const i = ((g % L) + L) % L;
  return seq.pattern.steps[i] ?? null;
}

/** Whether step g triggers: a note that passes its chance, or an OFF. */
function triggers(seq: Sequence, g: number): boolean {
  const c = cellAt(seq, g);
  if (!c) return false;
  if (c.note === "off") return true;
  if (c.fx?.type === "CHN") return hash01(g, seq.seed ?? 0, CHANCE_SALT) < c.fx.value / 100;
  return true;
}

function playsNote(seq: Sequence, g: number): boolean {
  return triggers(seq, g) && cellAt(seq, g)!.note !== "off";
}

/** How late a cell's note comes: its DLY, in samples (exact). */
function delayOf(seq: Sequence, sampleRate: number, cell: Cell | null): number {
  if (cell?.fx?.type !== "DLY") return 0;
  return (Math.min(15, Math.max(0, cell.fx.value)) / 16) * stepLength(seq.clock, sampleRate);
}

/**
 * The pattern positions holding a cell, in order — so that finding the next or the last trigger costs the cells on the
 * way, not the empty steps: a whole song in one pattern (thousands of steps, long silences) stays cheap to read once
 * per audio block. Kept per pattern object, which a description reuses until it changes.
 */
const cellIndex = new WeakMap<Pattern, Int32Array>();

function filledPositions(seq: Sequence): Int32Array {
  let idx = cellIndex.get(seq.pattern);
  if (!idx) {
    const L = Math.max(1, Math.round(seq.pattern.length));
    const out: number[] = [];
    for (let i = 0; i < L; i++) if (seq.pattern.steps[i]) out.push(i);
    idx = Int32Array.from(out);
    cellIndex.set(seq.pattern, idx);
  }
  return idx;
}

/** The first index in the sorted positions holding a value ≥ p. */
function lowerBound(a: Int32Array, p: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < p) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The first step after g (up to g + L − 1) that triggers, or −1. */
function nextTrigger(seq: Sequence, g: number): number {
  const L = Math.max(1, Math.round(seq.pattern.length));
  const idx = filledPositions(seq);
  if (idx.length === 0) return -1;
  const base = g - (((g % L) + L) % L); // the loop g is in starts here
  let i = lowerBound(idx, g - base + 1);
  for (let n = 0; n < idx.length; n++, i++) {
    const wrap = i >= idx.length ? 1 : 0;
    const k = base + idx[i - wrap * idx.length] + wrap * L;
    if (k >= g + L) return -1;
    if (triggers(seq, k)) return k;
  }
  return -1;
}

/** Exact end of the note triggered at g0: the next trigger, or its own length (from its note-on), or a full loop. */
function endTime(seq: Sequence, sampleRate: number, g0: number): number {
  const L = Math.max(1, Math.round(seq.pattern.length));
  const { clock } = seq;
  const next = nextTrigger(seq, g0);
  let end = stepTime(clock, sampleRate, next >= 0 ? next : g0 + L);
  const cell = cellAt(seq, g0);
  const len = cell?.length;
  if (len !== undefined && len > 0) end = Math.min(end, stepTime(clock, sampleRate, g0) + delayOf(seq, sampleRate, cell) + len * stepLength(clock, sampleRate));
  return end;
}

/** The last step at or before g that triggers (searched back one loop), or −1. */
function lastTrigger(seq: Sequence, g: number): number {
  if (g < 0) return -1;
  const L = Math.max(1, Math.round(seq.pattern.length));
  const idx = filledPositions(seq);
  if (idx.length === 0) return -1;
  const base = g - (((g % L) + L) % L);
  let i = lowerBound(idx, g - base + 1) - 1; // the last position ≤ g's
  for (let n = 0; n < idx.length; n++, i--) {
    const wrap = i < 0 ? 1 : 0;
    const k = base + idx[i + wrap * idx.length] - wrap * L;
    if (k < 0 || k <= g - L) return -1;
    if (triggers(seq, k)) return k;
  }
  return -1;
}

/**
 * Every note the cell at g0 plays, with its note-on in [from, to) (samples). The window lets a long arpeggio be read
 * one block at a time without listing the whole of it.
 */
export function expandStep(seq: Sequence, sampleRate: number, g0: number, from = -Infinity, to = Infinity): NoteEvent[] {
  if (!playsNote(seq, g0)) return [];
  const cell = cellAt(seq, g0)!;
  const root = cell.note as number;
  const { clock } = seq;
  const notes = chordNotes(root, cell.chord, cell.inversion ?? 0, cell.spread ?? false);
  for (const n of cell.add ?? []) if (!notes.includes(n)) notes.push(n);
  const velocity = Math.min(1, Math.max(0, cell.velocity ?? DEFAULT_VELOCITY));
  // An added note struck harder or softer than the root keeps its own velocity (unless the chord already plays it).
  const ownVelocity = new Map<number, number>();
  cell.add?.forEach((n, k) => {
    const v = cell.addVelocity?.[k];
    if (v !== undefined && !ownVelocity.has(n)) ownVelocity.set(n, Math.min(1, Math.max(0, v)));
  });
  const chordSet = new Set(chordNotes(root, cell.chord, cell.inversion ?? 0, cell.spread ?? false));
  const velocityOf = (n: number) => (chordSet.has(n) ? velocity : (ownVelocity.get(n) ?? velocity));
  const onT = stepTime(clock, sampleRate, g0) + delayOf(seq, sampleRate, cell);
  const offT = endTime(seq, sampleRate, g0);
  const out: NoteEvent[] = [];
  const emit = (onX: number, offX: number, note: number, glide?: { from: number; seconds: number }) => {
    const on = Math.round(onX);
    const off = Math.round(offX);
    if (off <= on || on < from || on >= to) return;
    const e: NoteEvent = { on, off, note, velocity: velocityOf(note), step: g0 };
    if (glide) {
      e.glideFrom = glide.from;
      e.glideSeconds = glide.seconds;
    }
    out.push(e);
  };

  // Arpeggio: one note at a time over the chord, on the arp's own grid.
  if (seq.arp) {
    const arp = seq.arp;
    const A = arpStepBeats(arp.rate, arp.triplet) * (60 / Math.max(1, clock.bpm)) * sampleRate;
    const pool = arpPool(notes, arp.octaves);
    const gate = Math.min(1, Math.max(0.05, arp.gate));
    // t(i): the i-th arp note's time. In grid sync the first note sits on the chord's start and the next ones on the grid.
    let t: (i: number) => number;
    if (arp.sync === "retrigger") t = (i) => onT + i * A;
    else {
      const k0 = Math.ceil(onT / A - 1e-9);
      t = Math.abs(k0 * A - onT) < 1e-6 ? (i) => (k0 + i) * A : (i) => (i === 0 ? onT : (k0 + i - 1) * A);
    }
    const iFrom = Number.isFinite(from) ? Math.max(0, Math.floor((from - onT) / A) - 1) : 0;
    for (let i = iFrom; ; i++) {
      const ti = t(i);
      if (ti >= offT || ti >= to + 1) break;
      emit(ti, Math.min(ti + gate * A, offT), arpNote(pool, arp.mode, i, g0));
    }
    return out;
  }

  // Ratchet: the whole chord struck n times inside the step; the last strike sounds to the note's end.
  if (cell.fx?.type === "RTG") {
    const n = Math.max(2, Math.min(8, Math.round(cell.fx.value)));
    const d = (Math.min(offT, stepTime(clock, sampleRate, g0 + 1)) - onT) / n;
    for (let j = 0; j < n; j++) {
      const on = onT + j * d;
      const off = j === n - 1 ? offT : on + RATCHET_GATE * d;
      for (const note of notes) emit(on, off, note);
    }
    return out;
  }

  // Glide: from the previous note, the chord moving in parallel.
  let glideBy: number | null = null;
  let glideSeconds = 0;
  if (cell.fx?.type === "GLD") {
    const prev = lastTrigger(seq, g0 - 1);
    if (prev >= 0 && playsNote(seq, prev)) {
      glideBy = (cellAt(seq, prev)!.note as number) - root;
      glideSeconds = Math.max(0, cell.fx.value) * 0.01;
    }
  }
  for (const note of notes) emit(onT, offT, note, glideBy === null ? undefined : { from: note + glideBy, seconds: glideSeconds });
  return out;
}

const byOnThenNote = (a: NoteEvent, b: NoteEvent) => a.on - b.on || a.note - b.note;

/** Every note whose note-on falls in [from, to) (samples), in time order. */
export function notesStartingIn(seq: Sequence, sampleRate: number, from: number, to: number): NoteEvent[] {
  if (to <= from || to <= 0) return [];
  const { clock } = seq;
  const gFirst = Math.max(0, stepAt(clock, sampleRate, Math.max(0, from - 1)));
  const gLast = stepAt(clock, sampleRate, to + 1);
  const steps = new Set<number>();
  // The cell still sounding when the window opens: its arp notes or ratchet strikes may fall inside it.
  const active = lastTrigger(seq, gFirst);
  if (active >= 0) steps.add(active);
  for (let g = gFirst; g <= gLast; g++) if (triggers(seq, g)) steps.add(g);
  const out: NoteEvent[] = [];
  for (const g of steps) out.push(...expandStep(seq, sampleRate, g, from, to));
  return out.sort(byOnThenNote);
}

/** The notes sounding at a sample (on ≤ t < off): what the engine restarts after a seek, what Note Probe reads. */
export function notesSoundingAt(seq: Sequence, sampleRate: number, t: number): NoteEvent[] {
  const g = lastTrigger(seq, stepAt(seq.clock, sampleRate, t));
  if (g < 0) return [];
  return expandStep(seq, sampleRate, g, -Infinity, t + 1)
    .filter((e) => e.on <= t && t < e.off)
    .sort(byOnThenNote);
}
