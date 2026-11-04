import { describe, expect, it } from "vitest";
import { songForm } from "../music/seq/form";

const lane = (s: string) => [...s].map((c) => c === "x");

describe("songForm", () => {
  it("letters sections, a part entering over the others staying in the same section, a return getting its letter back", () => {
    const masks = [lane("xxxx....xxxx"), lane("xxxx....xxxx"), lane(".xxx........"), lane("....xxxx....")];
    expect(songForm(masks, 12).map((f) => `${f.letter}:${f.from}-${f.to}`)).toEqual(["A:0-4", "B:4-8", "A′:8-12"]);
  });
  it("gives silence no letter, and an identical return the same letter", () => {
    const masks = [lane("xx..xx"), lane("..xx..")];
    expect(songForm(masks, 6).map((f) => f.letter)).toEqual(["A", "B", "A"]);
    expect(songForm([lane("x..x")], 4).map((f) => `${f.letter}:${f.from}`)).toEqual(["A:0", "A:3"]);
  });
});
