import { describe, expect, it } from "vitest";
import { MUSIC_ORDER_NODE, MUSIC_PATTERN_NODE, patternCells } from "../../graph/nodes/music";
import { orderOf, sequenceOf } from "../engine/description";
import { compactPattern, formatPattern, parsePattern, stepWords } from "./notation";
import { bankLayout, isBank, joinBank, parseOrder, positionAt, splitBank } from "./order";
import { notesStartingIn } from "./sequencer";

const ORDER = { list: [0, 1, 0, 2], lengths: [], length: 4 };

describe("order list", () => {
  it("reads a bank, with | between its patterns", () => {
    expect(isBank("C4 . | D4")).toBe(true);
    expect(isBank("C4 . D4")).toBe(false);
    expect(splitBank("C4 . | D4 . |  | E4")).toEqual(["C4 .", "D4 .", "", "E4"]);
    expect(joinBank(["C4 .", "", "E4"])).toBe("C4 . | . | E4");
  });

  it("reads pattern numbers, skipping anything else", () => {
    expect(parseOrder("00 01, 2;3 x 4")).toEqual([0, 1, 2, 3, 4]);
  });

  it("spells out .*N as N empty steps", () => {
    expect(stepWords("C4 .*3 D4")).toEqual(["C4", ".", ".", ".", "D4"]);
    expect(formatPattern(parsePattern("C4 .*2 off", 4))).toBe("C4 . . off");
    expect(compactPattern("C4 . . . . . D4 . . .")).toBe("C4 .*5 D4 . . .");
  });

  it("lays a bank out along the order, every number as long as the order says", () => {
    const { cells, bank } = patternCells("C4 . . . . . | D4 | E4 . . .", 16, ORDER);
    // 0 is cut to 4, 1 padded to 4.
    expect(formatPattern(cells)).toBe("C4 . . . D4 . . . C4 . . . E4 . . .");
    expect(bank!.starts).toEqual([0, 4, 8, 12]);
    expect(positionAt(bank!, 9)).toEqual({ position: 2, pattern: 0, row: 1 });
    expect(positionAt(bank!, 17)).toEqual({ position: 0, pattern: 0, row: 1 }); // the song loops
  });

  it("gives a number its own length, and silence to a number the bank lacks", () => {
    const { cells } = patternCells("C4 | D4", 16, { list: [1, 3, 0], lengths: [2, 0, 0, 3], length: 1 });
    expect(formatPattern(cells)).toBe("D4 . . . C4 .");
  });

  it("plays a bank with no order once through, each pattern at least Length long", () => {
    const { cells, bank } = patternCells("C4 | D4 . . . . .", 4, null);
    expect(formatPattern(cells)).toBe("C4 . . . D4 . . . . .");
    expect(bank!.list).toEqual([0, 1]);
    expect(bankLayout([1, 6], 4, null).lengths).toEqual([4, 6]);
  });

  it("leaves a single pattern as it was", () => {
    expect(patternCells("C4 . D4", 4, null)).toEqual({ cells: parsePattern("C4 . D4", 4), bank: null });
  });

  it("goes from Clock through Order List to the Pattern, whose notes ring across the joins", () => {
    const clock = { kind: "clock", clock: { bpm: 120, swing: 0, stepsPerBeat: 4 } };
    const ordered = MUSIC_ORDER_NODE.evaluate({ clock }, { order: "1 0 1", length: "2", lengths: "" }, {} as never).clock;
    expect(orderOf(ordered)).toEqual({ list: [1, 0, 1], lengths: [], length: 2 });
    const seq = sequenceOf(
      MUSIC_PATTERN_NODE.evaluate({ clock: ordered }, { ...MUSIC_PATTERN_NODE.defaultParams, steps: "C4 . | E4 .", length: "16" }, {} as never).sequence,
    )!;
    expect(seq.pattern.length).toBe(6);
    const notes = notesStartingIn(seq, 48_000, 0, 6 * 6000);
    expect(notes.map((n) => [n.note, n.step])).toEqual([
      [64, 0],
      [60, 2],
      [64, 4],
    ]);
    // E4 sounds until C4 comes in.
    expect(notes[0].off).toBe(notes[1].on);
  });
});
