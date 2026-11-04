/**
 * Scales: which pitches a melody may use. A table of data — one line adds a scale — and the few operations the
 * Scale node and the generators (Shift Register…) need: snap a note into the scale, walk it by degrees, stack thirds.
 *
 * Intervals are semitones from the root, within the octave, ascending, 0 first. They may be fractional: a maqam's
 * neutral third is 3.5, a quarter tone flat of the minor third's neighbour. Every voice plays fractional MIDI notes
 * (dsp/fm.ts midiToHz), so a quarter tone needs nothing more than a .5.
 */
import { CHORDS, ChordName } from "./chords";

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  "harmonic minor": [0, 2, 3, 5, 7, 8, 11],
  "melodic minor": [0, 2, 3, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  "major pentatonic": [0, 2, 4, 7, 9],
  "minor pentatonic": [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  "whole tone": [0, 2, 4, 6, 8, 10],
  "octatonic (Messiaen 2)": [0, 1, 3, 4, 6, 7, 9, 10],
  "Messiaen 3": [0, 2, 3, 4, 6, 7, 8, 10, 11],
  "phrygian dominant (hijaz)": [0, 1, 4, 5, 7, 8, 10],
  "double harmonic": [0, 1, 4, 5, 7, 8, 11],
  "hungarian minor": [0, 2, 3, 6, 7, 8, 11],
  hirajoshi: [0, 2, 3, 7, 8],
  "in-sen": [0, 1, 5, 7, 10],
  iwato: [0, 1, 5, 6, 10],
  ryukyu: [0, 4, 5, 7, 11],
  "pelog (12-tone)": [0, 1, 3, 7, 8],
  "maqam rast ¼": [0, 2, 3.5, 5, 7, 9, 10.5],
  "maqam bayati ¼": [0, 1.5, 3, 5, 7, 8, 10],
  "maqam saba ¼": [0, 1.5, 3, 4, 7, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
} as const satisfies Record<string, readonly number[]>;

export type ScaleName = keyof typeof SCALES;
export const SCALE_NAMES = Object.keys(SCALES) as ScaleName[];
export const PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function isScaleName(name: unknown): name is ScaleName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(SCALES, name);
}

/** A scale on a root: `root` a pitch class (0 = C, may be fractional), `steps` the intervals. */
export interface ScaleSpec {
  root: number;
  steps: readonly number[];
}

export function scaleSpec(name: unknown, root: number): ScaleSpec {
  return { root: ((root % 12) + 12) % 12, steps: SCALES[isScaleName(name) ? name : "major"] };
}

const EPS = 1e-6;

/** The scale degree a note is on, counted from the root of octave 0 (MIDI 0–11) — or a fraction between two. */
function position(s: ScaleSpec, note: number): { octave: number; within: number } {
  const d = note - s.root;
  const octave = Math.floor(d / 12 + EPS);
  return { octave, within: d - 12 * octave };
}

/** The MIDI note of degree k (any integer: 7 in a 7-note scale is the root an octave up). */
export function degreeNote(s: ScaleSpec, k: number): number {
  const n = s.steps.length;
  const octave = Math.floor(k / n);
  return s.root + 12 * octave + s.steps[k - octave * n];
}

/** The degree a note sits on, or the nearest one below it. */
export function degreeOf(s: ScaleSpec, note: number): number {
  const { octave, within } = position(s, note);
  let i = 0;
  for (let k = 0; k < s.steps.length; k++) if (s.steps[k] <= within + EPS) i = k;
  return octave * s.steps.length + i;
}

export type SnapMode = "nearest" | "up" | "down";

/** The note moved into the scale: to the nearest scale tone (a tie goes down), or the next one up or down. */
export function snapNote(s: ScaleSpec, note: number, mode: SnapMode = "nearest"): number {
  const below = degreeNote(s, degreeOf(s, note));
  if (Math.abs(below - note) < EPS) return below;
  const above = degreeNote(s, degreeOf(s, note) + 1);
  if (mode === "up") return above;
  if (mode === "down") return below;
  return above - note < note - below - EPS ? above : below;
}

export function inScale(s: ScaleSpec, note: number): boolean {
  return Math.abs(snapNote(s, note) - note) < EPS;
}

/**
 * The chord the scale builds on a note of it, stacking every other degree: 3 notes a triad, 4 a seventh. A chord the
 * chord table knows comes back by name (so inversions and the arp treat it as any written chord); any other — a
 * pentatonic's stacked "thirds", a maqam's neutral ones — as its notes.
 */
export function stackedChord(s: ScaleSpec, root: number, size: 3 | 4): { chord: ChordName | null; notes: number[] } {
  const k = degreeOf(s, root);
  const notes = [0, 2, 4, 6].slice(0, size).map((j) => degreeNote(s, k + j));
  const intervals = notes.map((n) => n - notes[0]);
  for (const [name, iv] of Object.entries(CHORDS) as [ChordName, readonly number[]][]) {
    if (iv.length === intervals.length && iv.every((x, i) => Math.abs(x - intervals[i]) < EPS)) return { chord: name, notes };
  }
  return { chord: null, notes };
}
