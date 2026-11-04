import { describe, expect, it } from "vitest";
import { formatTokens, parseTokens } from "./ProgressionHud";
import { numeralDegree, numeralOf, parseNumeral, randomProgression } from "../music/seq/compose";
import { CHORD_NAMES } from "../music/seq/chords";

describe("Progression HUD", () => {
  it("reads and writes the numerals text, lengths kept", () => {
    const text = "i:12 iv VII:2 V7/V iiø7:0.5";
    expect(parseTokens(text)).toEqual([
      { num: "i", beats: 12 },
      { num: "iv", beats: 1 },
      { num: "VII", beats: 2 },
      { num: "V7/V", beats: 1 },
      { num: "iiø7", beats: 0.5 },
    ]);
    expect(formatTokens(parseTokens(text))).toBe(text);
  });

  it("names a chord as a numeral that reads back as the same chord, in both modes", () => {
    for (const minor of [false, true])
      for (let root = 0; root < 12; root++)
        for (const chord of CHORD_NAMES) {
          const w = numeralOf(root, chord, minor);
          if (w === null) continue;
          expect(parseNumeral(w, minor), `${root} ${chord} → ${w}`).toMatchObject({ root, chord });
        }
    expect(numeralOf(7, "maj", true)).toBe("V");
    expect(numeralOf(11, "dim", true)).toBe("#vii°");
    expect(numeralOf(8, "maj", false)).toBe("bVI");
    expect(numeralOf(2, "m7b5", true)).toBe("iiø7");
  });

  it("writes a random walk out whole", () => {
    for (const minor of [false, true])
      for (let seed = 0; seed < 20; seed++)
        for (const c of randomProgression(8, minor, seed % 2 === 0, 0.5, true, seed)) expect(numeralOf(c.root, c.chord, minor), `${c.root} ${c.chord}`).not.toBeNull();
  });

  it("knows a numeral's degree, and what is chromatic", () => {
    expect(numeralDegree("V7:2")).toEqual({ degree: 4, chromatic: false });
    expect(numeralDegree("V7/V")).toEqual({ degree: 4, chromatic: true });
    expect(numeralDegree("bVI")).toEqual({ degree: 5, chromatic: true });
    expect(numeralDegree("x")).toBeNull();
  });
});
