import { describe, expect, it } from "vitest";
import { Macro, macroDone, macroNext, macroRelease, parseMacro } from "./macros";

/** The values a macro plays over `ticks` ticks, released after `releaseAt` (never, by default). */
function run(m: Macro, ticks: number, releaseAt = Infinity): number[] {
  const out: number[] = [];
  let pos = -1;
  for (let t = 0; t < ticks; t++) {
    if (t === releaseAt) pos = macroRelease(m, pos) - 1;
    pos = macroNext(m, pos, t < releaseAt);
    out.push(m.values[pos]);
  }
  return out;
}

describe("macros", () => {
  it("reads values, a loop and a release, hex where asked", () => {
    expect(parseMacro("15 13 | 10 9 / 6 0")).toEqual({ values: [15, 13, 10, 9, 6, 0], loop: 2, release: 4 });
    expect(parseMacro("0 |4 7")).toEqual({ values: [0, 4, 7], loop: 1, release: -1 });
    expect(parseMacro("81 41 $40", true)!.values).toEqual([0x81, 0x41, 0x40]);
    expect(parseMacro("-12 0x10")!.values).toEqual([-12, 16]);
    expect(parseMacro("  ")).toBeNull();
  });

  it("runs once and keeps its last value", () => {
    expect(run(parseMacro("3 2 1")!, 5)).toEqual([3, 2, 1, 1, 1]);
  });

  it("loops from the loop mark", () => {
    expect(run(parseMacro("0 | 4 7")!, 6)).toEqual([0, 4, 7, 4, 7, 4]);
  });

  it("holds before the release while the note is held, then goes on", () => {
    const m = parseMacro("15 12 / 6 0")!;
    expect(run(m, 6, 4)).toEqual([15, 12, 12, 12, 6, 0]);
    expect(macroDone(m, 3)).toBe(true);
  });

  it("loops the held part, and leaves it on the release", () => {
    const m = parseMacro("15 | 13 11 / 5 0")!;
    expect(run(m, 8, 5)).toEqual([15, 13, 11, 13, 11, 5, 0, 0]);
  });

  it("loops after the release too", () => {
    const m = parseMacro("10 / 5 | 3 4")!;
    expect(run(m, 7, 2)).toEqual([10, 10, 5, 3, 4, 3, 4]);
  });
});
