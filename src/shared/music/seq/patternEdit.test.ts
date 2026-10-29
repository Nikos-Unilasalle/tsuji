import { describe, expect, it } from "vitest";
import { DRUM_NOTES } from "../dsp/drums";
import { formatPattern, parsePattern } from "./notation";
import { drumsAt, editCell, moveCursor, noteForLetter, resize, toggleDrum, withOctave, writeNote } from "./patternEdit";

describe("note letters", () => {
  it("names the notes in the keyboard's octave, C4 = 60, either case", () => {
    expect(noteForLetter("c", 4)).toBe(60);
    expect(noteForLetter("A", 4)).toBe(69);
    expect(noteForLetter("b", 3)).toBe(59);
    expect(noteForLetter("g", 2)).toBe(43);
  });

  it("sharpens", () => {
    expect(noteForLetter("f", 3, true)).toBe(54);
    expect(noteForLetter("b", 3, true)).toBe(60); // B# is C
  });

  it("ignores other keys and notes out of MIDI range", () => {
    expect(noteForLetter("h", 4)).toBe(null);
    expect(noteForLetter("Enter", 4)).toBe(null);
    expect(noteForLetter("a", 9)).toBe(null); // A9 = 129; G9 = 127 is the top note
  });

  it("moves a note to another octave, keeping its name", () => {
    expect(withOctave(61, 2)).toBe(37);
    expect(withOctave(60, 10)).toBe(null);
  });
});

describe("cells", () => {
  const cells = () => parsePattern("C4:maj7 . off .", 4);

  it("writes a note with the brush", () => {
    expect(formatPattern(writeNote(cells(), 1, 57, { chord: "min7", inversion: 1, velocity: 0.6 }))).toBe("C4:maj7 A3:min7/1@0.6 off .");
    expect(formatPattern(writeNote(cells(), 3, 62, { chord: null, spread: false }))).toBe("C4:maj7 . off D4");
  });

  it("edits a note's settings, and leaves OFFs and empty steps alone", () => {
    expect(formatPattern(editCell(cells(), 0, { chord: "min", fx: { type: "RTG", value: 3 } }))).toBe("C4:min!RTG3 . off .");
    expect(formatPattern(editCell(cells(), 0, { chord: undefined }))).toBe("C4 . off .");
    expect(formatPattern(editCell(cells(), 2, { chord: "min" }))).toBe("C4:maj7 . off .");
    expect(formatPattern(editCell(cells(), 1, { chord: "min" }))).toBe("C4:maj7 . off .");
  });

  it("toggles drums on a step, in kit order, keeping the step's settings", () => {
    let c = parsePattern(". hat@0.5", 2);
    c = toggleDrum(c, 0, "snare");
    c = toggleDrum(c, 0, "kick");
    expect(formatPattern(c, { drums: true })).toBe("kick+snare hat@0.5");
    c = toggleDrum(c, 1, "kick");
    expect(formatPattern(c, { drums: true })).toBe("kick+snare kick+hat@0.5");
    c = toggleDrum(c, 0, "kick");
    c = toggleDrum(c, 0, "snare");
    expect(formatPattern(c, { drums: true })).toBe(". kick+hat@0.5");
    expect(drumsAt(c[1])).toEqual(new Set([DRUM_NOTES.kick, DRUM_NOTES.hat]));
  });

  it("wraps the cursor and resizes", () => {
    expect(moveCursor(15, 1, 16)).toBe(0);
    expect(moveCursor(2, -16, 16)).toBe(2);
    expect(moveCursor(0, -1, 32)).toBe(31);
    expect(resize(cells(), 6)).toHaveLength(6);
    expect(formatPattern(resize(cells(), 2))).toBe("C4:maj7 .");
  });
});
