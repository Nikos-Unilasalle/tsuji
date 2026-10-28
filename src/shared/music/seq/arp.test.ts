import { describe, expect, it } from "vitest";
import { ARP_MODES, ArpMode, arpNote, arpPool, arpStepBeats } from "./arp";

const C = [60, 64, 67];
const first = (mode: ArpMode, n: number, played = C, seed = 0) => Array.from({ length: n }, (_, i) => arpNote(played, mode, i, seed));

describe("arpNote", () => {
  it("walks up, down, up-down and down-up without repeating the ends", () => {
    expect(first("up", 7)).toEqual([60, 64, 67, 60, 64, 67, 60]);
    expect(first("down", 4)).toEqual([67, 64, 60, 67]);
    expect(first("updown", 9)).toEqual([60, 64, 67, 64, 60, 64, 67, 64, 60]);
    expect(first("downup", 5)).toEqual([67, 64, 60, 64, 67]);
  });

  it("keeps the played order in 'played' and sorts it in the others", () => {
    const spread = [60, 76, 67, 83];
    expect(first("played", 4, spread)).toEqual(spread);
    expect(first("up", 4, spread)).toEqual([60, 67, 76, 83]);
  });

  it("draws 'random' from the pool, the same way every time, differently for another seed", () => {
    const a = first("random", 64, C, 5);
    expect(a.every((n) => C.includes(n))).toBe(true);
    expect(new Set(a).size).toBe(3);
    expect(first("random", 64, C, 5)).toEqual(a);
    expect(first("random", 64, C, 6)).not.toEqual(a);
  });

  it("repeats a single note in every mode", () => {
    for (const mode of ARP_MODES) expect(first(mode, 3, [62])).toEqual([62, 62, 62]);
  });
});

describe("arpPool and arpStepBeats", () => {
  it("adds the octaves", () => {
    expect(arpPool(C, 2)).toEqual([60, 64, 67, 72, 76, 79]);
    expect(arpPool(C, 9)).toHaveLength(12); // at most 4 octaves
  });

  it("gives each rate its length in beats, triplets two thirds of it", () => {
    expect(arpStepBeats("1/4", false)).toBe(1);
    expect(arpStepBeats("1/16", false)).toBe(0.25);
    expect(arpStepBeats("1/64", false)).toBe(1 / 16);
    expect(arpStepBeats("1/8", true)).toBeCloseTo(1 / 3, 12);
  });
});
