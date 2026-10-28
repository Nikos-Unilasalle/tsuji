import { describe, expect, it } from "vitest";
import { CHORDS, CHORD_NAMES, chordNotes, isChordName } from "./chords";

const C4 = 60;

describe("chordNotes", () => {
  it("builds the six core chords from one root", () => {
    expect(chordNotes(C4, "maj")).toEqual([60, 64, 67]);
    expect(chordNotes(C4, "min")).toEqual([60, 63, 67]);
    expect(chordNotes(C4, "7")).toEqual([60, 64, 67, 70]);
    expect(chordNotes(C4, "9")).toEqual([60, 64, 67, 70, 74]);
    expect(chordNotes(C4, "sus")).toEqual([60, 65, 67]);
    expect(chordNotes(C4, "dim")).toEqual([60, 63, 66]);
  });

  it("has the extra chords", () => {
    expect(chordNotes(C4, "maj7")).toEqual([60, 64, 67, 71]);
    expect(chordNotes(C4, "min7")).toEqual([60, 63, 67, 70]);
    expect(chordNotes(C4, "sus2")).toEqual([60, 62, 67]);
    expect(chordNotes(C4, "dim7")).toEqual([60, 63, 66, 69]);
    expect(chordNotes(C4, "aug")).toEqual([60, 64, 68]);
    expect(CHORD_NAMES).toHaveLength(11);
    expect(CHORD_NAMES.slice(0, 6)).toEqual(["maj", "min", "7", "9", "sus", "dim"]);
    expect(new Set(CHORD_NAMES)).toEqual(new Set(Object.keys(CHORDS)));
  });

  it("plays the root alone without a chord", () => {
    expect(chordNotes(C4, null)).toEqual([60]);
    expect(chordNotes(C4, undefined, 2, true)).toEqual([60]);
  });

  it("inverts by moving the lowest notes up an octave", () => {
    expect(chordNotes(C4, "maj", 1)).toEqual([64, 67, 72]);
    expect(chordNotes(C4, "maj", 2)).toEqual([67, 72, 76]);
    expect(chordNotes(C4, "7", 3)).toEqual([70, 72, 76, 79]);
    // No more inversions than the chord has notes minus one.
    expect(chordNotes(C4, "maj", 9)).toEqual(chordNotes(C4, "maj", 2));
  });

  it("spreads by moving every second note up an octave", () => {
    expect(chordNotes(C4, "maj7", 0, true)).toEqual([60, 76, 67, 83]);
  });

  it("recognises chord names", () => {
    expect(isChordName("min7")).toBe(true);
    expect(isChordName("toString")).toBe(false);
    expect(isChordName(7)).toBe(false);
  });
});
