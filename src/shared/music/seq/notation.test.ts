import { describe, expect, it } from "vitest";
import { formatPattern, noteName, parseCell, parseNote, parsePattern } from "./notation";

describe("parseNote", () => {
  it("reads pitch names with C4 = 60, tracker style too", () => {
    expect(parseNote("C4")).toBe(60);
    expect(parseNote("c-4")).toBe(60);
    expect(parseNote("A4")).toBe(69);
    expect(parseNote("F#3")).toBe(54);
    expect(parseNote("Bb2")).toBe(46);
    expect(parseNote("C-1")).toBe(24);
  });

  it("reads MIDI numbers and drum names, and refuses the rest", () => {
    expect(parseNote("72")).toBe(72);
    expect(parseNote("kick")).toBe(36);
    expect(parseNote("HAT")).toBe(42);
    expect(parseNote("H4")).toBe(null);
    expect(parseNote("200")).toBe(null);
    expect(parseNote("toString")).toBe(null);
  });

  it("names notes back", () => {
    expect(noteName(60)).toBe("C4");
    expect(noteName(70)).toBe("A#4");
    expect(noteName(24)).toBe("C1");
  });
});

describe("parseCell", () => {
  it("reads empty steps and OFF", () => {
    for (const w of [".", "-", "---", ""]) expect(parseCell(w)).toBe(null);
    expect(parseCell("off")).toEqual({ note: "off" });
  });

  it("reads every modifier, in any order", () => {
    expect(parseCell("A3:min7/1^@0.6~2!GLD12")).toEqual({
      note: 57,
      chord: "min7",
      inversion: 1,
      spread: true,
      velocity: 0.6,
      length: 2,
      fx: { type: "GLD", value: 12 },
    });
    expect(parseCell("C4!rtg3@1:maj")).toEqual({ note: 60, fx: { type: "RTG", value: 3 }, velocity: 1, chord: "maj" });
    expect(parseCell("tomhigh@0.4~0.3!DLY3")).toEqual({ note: 50, velocity: 0.4, length: 0.3, fx: { type: "DLY", value: 3 } });
  });

  it("joins notes struck together with +", () => {
    expect(parseCell("kick+hat+nope")).toEqual({ note: 36, add: [42] });
    expect(parseCell("C4+E4+B4:maj")).toEqual({ note: 60, add: [64, 71], chord: "maj" });
  });

  it("drops what it cannot read and keeps the rest", () => {
    expect(parseCell("C4:jazz")).toEqual({ note: 60 });
    expect(parseCell("C4!XYZ3")).toEqual({ note: 60 });
    expect(parseCell("nope")).toBe(null);
  });
});

describe("parsePattern / formatPattern", () => {
  it("pads or cuts to the pattern's length", () => {
    expect(parsePattern("C4 . E4", 4)).toEqual([{ note: 60 }, null, { note: 64 }, null]);
    expect(parsePattern("C4 D4 E4 F4", 2)).toHaveLength(2);
    expect(parsePattern("", 3)).toEqual([null, null, null]);
  });

  it("round-trips", () => {
    const text = "C4:maj7 . . off A3:min7/1@0.6 . kick~2 G3:7^!CHN50";
    expect(formatPattern(parsePattern(text, 8))).toBe("C4:maj7 . . off A3:min7/1@0.6 . C2~2 G3:7^!CHN50");
    expect(formatPattern(parsePattern("kick . snare hat", 4), { drums: true })).toBe("kick . snare hat");
    expect(formatPattern(parsePattern("kick+hat C4+E4+B4@0.5", 2), { drums: true })).toBe("kick+hat C4+E4+B4@0.5");
  });
});
