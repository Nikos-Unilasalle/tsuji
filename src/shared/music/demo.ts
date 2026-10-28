/**
 * Two demo tracks: Cmaj7 – Am7 – Fmaj7 – G7 arpeggiated up and down over two octaves, and a bass that glides into
 * each bar with a ratchet before the turnaround. Played by the engine spike, and by Music Out's "Demo" switch until
 * the track nodes of step 4 exist.
 */
import { EPIANO_PATCH } from "./dsp/fm";
import type { TrackDescription } from "./engine/description";
import { DEFAULT_ARP } from "./seq/arp";
import type { Cell, Clock, Sequence } from "./seq/sequencer";

export const DEMO_CLOCK: Clock = { bpm: 112, swing: 0.3, stepsPerBeat: 4 };

function pattern(length: number, cells: Record<number, Cell>): Sequence["pattern"] {
  return { length, steps: Array.from({ length }, (_, i) => cells[i] ?? null) };
}

export const DEMO_CHORDS: Sequence = {
  clock: DEMO_CLOCK,
  pattern: pattern(64, {
    0: { note: 60, chord: "maj7" },
    16: { note: 57, chord: "min7", inversion: 1 },
    32: { note: 53, chord: "maj7", inversion: 1 },
    48: { note: 55, chord: "7" },
  }),
  arp: { ...DEFAULT_ARP, mode: "updown", octaves: 2, gate: 0.6 },
};

export const DEMO_BASS: Sequence = {
  clock: DEMO_CLOCK,
  pattern: pattern(64, {
    0: { note: 36, velocity: 1 },
    10: { note: 43, velocity: 0.6 },
    16: { note: 33, fx: { type: "GLD", value: 12 } },
    26: { note: 40, velocity: 0.6 },
    32: { note: 29, fx: { type: "GLD", value: 12 } },
    42: { note: 36, velocity: 0.6 },
    48: { note: 31, fx: { type: "GLD", value: 12 } },
    60: { note: 31, fx: { type: "RTG", value: 3 } },
    63: { note: "off" },
  }),
};

export const DEMO_TRACKS: TrackDescription[] = [
  { id: "demo:chords", kind: "fm", voices: 8, patch: EPIANO_PATCH, seq: DEMO_CHORDS, level: 0.7, pan: -0.35, mute: false },
  { id: "demo:bass", kind: "fm", voices: 8, patch: EPIANO_PATCH, seq: DEMO_BASS, level: 0.9, pan: 0.2, mute: false },
];
