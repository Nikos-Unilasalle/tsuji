import { describe, expect, it } from "vitest";
import { parsePattern } from "./notation";
import { FELUCCA_PHRASES, phraseSteps } from "./phrases";

const phrase = (name: string) => FELUCCA_PHRASES.find((p) => p.name === name)!;

describe("Felucca phrases", () => {
  it("turns accents into velocity and every note into a one-step note", () => {
    expect(phraseSteps(phrase("MELODY")).split(" ").slice(0, 4)).toEqual(["C4@1~1", ".", "G4@0.75~1", "."]);
  });

  it("holds a note over its ties", () => {
    const pad = phraseSteps(phrase("PAD")).split(" ");
    expect(pad[0]).toBe("C4@0.75~7");
    expect(pad[8]).toBe("A3@0.75~3");
    expect(pad[12]).toBe("G3@0.75~3");
  });

  it("glides into the note after a slide", () => {
    const acid = phraseSteps(phrase("ACID")).split(" ");
    // Step 3 (A3 = 57) slides: step 4 (A2 = 45) glides from it.
    expect(acid[2]).toBe("A3@0.75~1");
    expect(acid[3]).toBe("A2@0.75~1!GLD6");
  });

  it("reads back as 16 cells, every phrase", () => {
    for (const p of FELUCCA_PHRASES) {
      const cells = parsePattern(phraseSteps(p), 16);
      expect(cells.filter((c) => c !== null).length, p.name).toBe(p.note.filter((n) => n > 0).length);
    }
  });
});
