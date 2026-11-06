import { describe, expect, it } from "vitest";
import { DRUM_NOTES } from "../dsp/drums";
import { applyGroup, cellFromNotes, drumForMidi, melodicPadAction, padIndex, recognizeChord } from "./midiEntry";
import { formatPattern } from "./notation";

describe("recognizeChord", () => {
  it("names root-position chords", () => {
    expect(recognizeChord([60, 64, 67])).toEqual({ root: 60, chord: "maj", inversion: 0, spread: false });
    expect(recognizeChord([67, 60, 63])).toEqual({ root: 60, chord: "min", inversion: 0, spread: false });
    expect(recognizeChord([62, 65, 69, 72])).toEqual({ root: 62, chord: "min7", inversion: 0, spread: false });
  });

  it("finds inversions: E G C is C major, first inversion", () => {
    expect(recognizeChord([64, 67, 72])).toEqual({ root: 60, chord: "maj", inversion: 1, spread: false });
    expect(recognizeChord([67, 72, 76])).toEqual({ root: 60, chord: "maj", inversion: 2, spread: false });
  });

  it("finds spread voicings", () => {
    // C E′ G: C maj spread (every second note up an octave).
    expect(recognizeChord([60, 67, 76])).toEqual({ root: 60, chord: "maj", inversion: 0, spread: true });
  });

  it("returns null for a single note or a cluster no chord spells", () => {
    expect(recognizeChord([60])).toBe(null);
    expect(recognizeChord([60, 61, 62])).toBe(null);
  });
});

describe("cellFromNotes", () => {
  it("one note takes the brush, chord and all, at the velocity played", () => {
    expect(cellFromNotes([62], 0.5, { chord: "min", length: 2 })).toEqual({ note: 62, chord: "min", length: 2, velocity: 0.5 });
  });

  it("several notes are the chord they spell, the brush's chord set aside", () => {
    expect(cellFromNotes([64, 67, 72], 0.9, { chord: "min7", spread: true })).toEqual({ note: 60, chord: "maj", inversion: 1, velocity: 0.9 });
  });

  it("an unnamed voicing is the lowest note with the others added", () => {
    expect(cellFromNotes([61, 60, 62], 1, {})).toEqual({ note: 60, add: [61, 62], velocity: 1 });
  });

  it("writes as the pattern text spells it", () => {
    expect(formatPattern([cellFromNotes([60, 64, 67], 0.8)])).toContain("maj");
  });
});

describe("drums from MIDI", () => {
  it("pads 1–7 on channel 10 are the kit's lanes, pad 8 a rest", () => {
    expect(padIndex(9, 36)).toBe(0);
    expect(padIndex(0, 36)).toBe(null);
    expect(drumForMidi(9, 36)).toBe("kick");
    expect(drumForMidi(9, 38)).toBe("clap");
    expect(drumForMidi(9, 42)).toBe("tomhigh");
    expect(drumForMidi(9, 43)).toBe("rest");
  });

  it("keys strike their General MIDI drum by family", () => {
    expect(drumForMidi(0, 38)).toBe("snare");
    expect(drumForMidi(0, 40)).toBe("snare");
    expect(drumForMidi(0, 44)).toBe("hat");
    expect(drumForMidi(0, 60)).toBe(null);
  });

  it("hits struck together land on one step, each at its own velocity", () => {
    const cells = applyGroup({ step: 1, base: [null, null], notes: [], velocity: 0, hits: [["kick", 1], ["hat", 0.5]], startedAt: 0 }, {}, true);
    expect(cells[1]).toEqual({ note: DRUM_NOTES.kick, velocity: 1, add: [DRUM_NOTES.hat], addVelocity: [0.5] });
  });
});

describe("melodic pads", () => {
  it("are OFF, rest, clear, back", () => {
    expect([0, 1, 2, 3, 4].map(melodicPadAction)).toEqual(["off", "rest", "clear", "back", null]);
  });
});
