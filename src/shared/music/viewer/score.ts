/**
 * The Music Viewer's score: every note the song plays, in seconds, per track — gathered once from the tracks Music
 * Out mixes, so the picture (draw.ts) is a pure function of time: the same in the 3D view and in a video export.
 */
import type { TrackDescription } from "../engine/description";
import { notesStartingIn } from "../seq/sequencer";

export interface ViewerTrack {
  name: string;
  /** Percussion: drawn as hits (rings, sparks), not as pitches. */
  drums: boolean;
  /** The voice's level: a quiet part draws fainter. */
  level: number;
}

export interface ViewerNote {
  track: number;
  on: number;
  off: number;
  pitch: number;
  velocity: number;
}

/** A section of the song's form (see SectionsHud's songForm), in seconds. */
export interface ViewerSection {
  from: number;
  to: number;
  letter: string;
}

export interface ViewerScore {
  tracks: ViewerTrack[];
  /** Sorted by onset. */
  notes: ViewerNote[];
  /** The longest note, so a window search knows how far back a note still sounding can have started. */
  longest: number;
  duration: number;
  bpm: number;
  stepsPerBeat: number;
  /** The pitched notes' range. */
  lo: number;
  hi: number;
  form: ViewerSection[];
}

const RATE = 48_000;

export function isPercussion(t: TrackDescription): boolean {
  return t.kind === "drums" || (t.kind === "gb" && (t.gb.channel === "noise" || t.gb.channel === "kit"));
}

/** The score of `seconds` of the song, from the tracks as Music Out gathers them (muted ones left out). */
export function buildScore(tracks: readonly { desc: TrackDescription; name: string }[], seconds: number, form: ViewerSection[] = []): ViewerScore {
  const out: ViewerTrack[] = [];
  const notes: ViewerNote[] = [];
  let lo = Infinity;
  let hi = -Infinity;
  let longest = 0;
  const end = Math.max(1, Math.round(seconds * RATE));
  for (const { desc, name } of tracks) {
    if (desc.mute) continue;
    const drums = isPercussion(desc);
    const k = out.push({ name, drums, level: desc.level }) - 1;
    for (const e of notesStartingIn(desc.seq, RATE, 0, end)) {
      const on = e.on / RATE;
      const off = Math.max(on + 0.04, e.off / RATE);
      notes.push({ track: k, on, off, pitch: e.note, velocity: Math.min(1, e.velocity) });
      longest = Math.max(longest, off - on);
      if (!drums) {
        lo = Math.min(lo, e.note);
        hi = Math.max(hi, e.note);
      }
    }
  }
  notes.sort((a, b) => a.on - b.on || a.track - b.track);
  const clock = tracks[0]?.desc.seq.clock;
  if (!Number.isFinite(lo)) [lo, hi] = [48, 84];
  return { tracks: out, notes, longest, duration: seconds, bpm: clock?.bpm ?? 120, stepsPerBeat: clock?.stepsPerBeat ?? 4, lo, hi: Math.max(hi, lo + 12), form };
}

/** The first note starting at or after `t` (binary search on the sorted onsets). */
export function firstAt(notes: readonly ViewerNote[], t: number): number {
  let a = 0;
  let b = notes.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (notes[m].on < t) a = m + 1;
    else b = m;
  }
  return a;
}
