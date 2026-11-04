/**
 * Algorithmic pattern makers: each turns a few numbers into a tracker pattern (cells), purely — the same settings
 * give the same notes on every run, the export plays what the preview played.
 *
 * - euclid: k hits spread as evenly as can be over n steps (Toussaint's Euclidean rhythms: E(3,8) the tresillo).
 * - shiftRegister: a looping random melody that mutates — a bit register whose last bit comes back in front, flipped
 *   now and then (the "Turing Machine" of modular synths). Never flipped, it loops; always, it never repeats.
 * - tonnetz: a chord progression walked on Riemann's Tonnetz, one P / L / R move per chord, voiced so that each chord
 *   moves the fewest semitones from the last.
 */
import { CHORDS } from "./chords";
import { hash01 } from "./hash";
import { ScaleSpec, degreeNote, degreeOf, snapNote } from "./scales";
import type { Cell } from "./sequencer";

// ── Euclid ─────────────────────────────────────────────────────────────────

/** Which of n steps hit, for k hits, turned `rotation` steps later. The first hit is on step 0 before rotation. */
export function euclid(k: number, n: number, rotation = 0): boolean[] {
  const N = Math.max(1, Math.round(n));
  const K = Math.max(0, Math.min(N, Math.round(k)));
  const base = Array.from({ length: N }, (_, i) => (i * K) % N < K);
  const r = ((Math.round(rotation) % N) + N) % N;
  return base.map((_, i) => base[(i - r + N) % N]);
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
export const lcm = (a: number, b: number) => (a / gcd(a, b)) * b;

// ── Shift Register ─────────────────────────────────────────────────────────

export interface ShiftRegisterSettings {
  /** Register length, 2–16: the loop's length in steps while nothing flips. */
  bits: number;
  /** 0–1: the chance, at each step, that the bit coming back is flipped. */
  change: number;
  /** 0–1: how many steps play a note. Drawn from the register itself, so the rhythm loops with the melody. */
  density: number;
  /** Steps in the pattern: the evolution heard before it all starts over. */
  length: number;
  scale: ScaleSpec;
  /** The lowest note (snapped into the scale) and how many scale degrees above it the melody may reach. */
  low: number;
  range: number;
  /** In steps; 0: until the next note. */
  gate: number;
  velocity: number;
  seed: number;
}

const FLIP_SALT = 0x464c4950;
const GATE_SALT = 0x47415445;

export function shiftRegister(s: ShiftRegisterSettings): (Cell | null)[] {
  const bits = Math.max(2, Math.min(16, Math.round(s.bits)));
  const mask = (1 << bits) - 1;
  const top = bits - 1;
  // Up to 8 bits make the pitch, as on the module (its DAC reads the register's last 8).
  const pitchBits = Math.min(8, bits);
  const pitchMask = (1 << pitchBits) - 1;
  let reg = Math.floor(hash01(s.seed, 0, 0x52454731) * (mask + 1)) & mask;
  if (reg === 0) reg = 1;
  const low = degreeOf(s.scale, snapNote(s.scale, s.low, "up"));
  const range = Math.max(1, Math.round(s.range));
  const out: (Cell | null)[] = [];
  for (let i = 0; i < s.length; i++) {
    let b = (reg >> top) & 1;
    if (hash01(i, s.seed, FLIP_SALT) < s.change) b ^= 1;
    reg = ((reg << 1) | b) & mask;
    if (hash01(reg, s.seed, GATE_SALT) >= s.density) {
      out.push(null);
      continue;
    }
    const v = (reg & pitchMask) / pitchMask;
    const note = degreeNote(s.scale, low + Math.min(range, Math.floor(v * (range + 1))));
    const cell: Cell = { note, velocity: s.velocity };
    if (s.gate > 0) cell.length = s.gate;
    out.push(cell);
  }
  return out;
}

// ── Tonnetz ────────────────────────────────────────────────────────────────

export type Triad = { root: number; minor: boolean };
export const TONNETZ_MOVES = ["P", "L", "R", "S", "N", "H"] as const;
export type TonnetzMove = (typeof TONNETZ_MOVES)[number];

const pc = (n: number) => ((n % 12) + 12) % 12;

/**
 * One neo-Riemannian move. P, L and R swap one note by a semitone or a tone and keep two (each is its own undo);
 * S, N and H are their classic compounds: Slide (C → C♯m), Nebenverwandt (RLP: C → Fm), hexatonic pole (LPL: C → A♭m).
 */
export function tonnetzMove(t: Triad, m: TonnetzMove): Triad {
  switch (m) {
    case "P":
      return { root: t.root, minor: !t.minor };
    case "R":
      return t.minor ? { root: pc(t.root + 3), minor: false } : { root: pc(t.root - 3), minor: true };
    case "L":
      return t.minor ? { root: pc(t.root - 4), minor: false } : { root: pc(t.root + 4), minor: true };
    case "S":
      return t.minor ? { root: pc(t.root - 1), minor: false } : { root: pc(t.root + 1), minor: true };
    case "N":
      return tonnetzMove(tonnetzMove(tonnetzMove(t, "R"), "L"), "P");
    case "H":
      return tonnetzMove(tonnetzMove(tonnetzMove(t, "L"), "P"), "L");
  }
}

/** A path as written: "P L R" or "PLR" (one move each), "LP" groups with a space ("LP R": two chords). "." holds. */
export function parseTonnetzPath(text: string): TonnetzMove[][] {
  const groups = text.trim().toUpperCase().split(/[\s,]+/).filter((w) => w !== "");
  // Letters run together with no space at all ("PLRL"): one move per chord.
  const words = groups.length === 1 && groups[0].length > 1 && !groups[0].includes(".") ? groups[0].split("") : groups;
  return words.map((w) => (w === "." ? [] : w.split("").filter((c): c is TonnetzMove => (TONNETZ_MOVES as readonly string[]).includes(c))));
}

/** A seeded walk of `count` chords: each a P, L or R move, never straight back the way it came. */
export function randomTonnetzPath(count: number, seed: number): TonnetzMove[][] {
  const out: TonnetzMove[][] = [];
  let last: TonnetzMove | null = null;
  const basic: TonnetzMove[] = ["P", "L", "R"];
  for (let i = 0; i < count; i++) {
    const options = basic.filter((m) => m !== last);
    const m = options[Math.floor(hash01(i, seed, 0x544f4e4e) * options.length)];
    out.push([m]);
    last = m;
  }
  return out;
}

/** The triad's notes voiced near `center`: of every octave and inversion, the one closest to `prev` (or to center). */
export function voiceTriad(t: Triad, prev: number[] | null, center: number): { root: number; inversion: number; notes: number[] } {
  const iv = t.minor ? CHORDS.min : CHORDS.maj;
  let best = { root: 0, inversion: 0, notes: [] as number[], cost: Infinity };
  for (let octave = -2; octave <= 2; octave++) {
    const root = t.root + 12 * (Math.floor(center / 12) + octave);
    for (let inv = 0; inv < 3; inv++) {
      let notes = iv.map((x) => root + x);
      for (let k = 0; k < inv; k++) notes = [...notes.slice(1), notes[0] + 12];
      const mean = notes.reduce((a, b) => a + b, 0) / notes.length;
      // With nothing to lead from: root position, its root nearest the center. Else motion first, and a pull toward
      // the center that keeps a long walk from drifting off the keyboard.
      const cost = prev ? notes.reduce((a, n, i) => a + Math.abs(n - prev[i]), 0) + 0.35 * Math.abs(mean - center) : Math.abs(root - center) + 100 * inv;
      if (cost < best.cost) best = { root, inversion: inv, notes, cost };
    }
  }
  return best;
}
