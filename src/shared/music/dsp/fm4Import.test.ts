import { describe, expect, it } from "vitest";
import { FM4_RAW_PRESETS, fm4PresetName, fm4Time, fromFm4 } from "./fm4Import";
import { FmSynth } from "./fm";

const find = (name: string) => FM4_RAW_PRESETS.find((p) => p.name === name)!;

describe("fm4Time", () => {
  it("runs from 1 ms to 10 s, exponentially", () => {
    expect(fm4Time(0)).toBeCloseTo(0.001, 9);
    expect(fm4Time(127)).toBeCloseTo(10, 9);
    expect(fm4Time(63.5)).toBeCloseTo(0.1, 9);
  });
});

describe("fromFm4", () => {
  it("converts Felucca's E.PIANO: two stacks (algorithm 5), ratios, carriers on the ADSR, modulators on MODDEC", () => {
    const { patch, voices, transpose } = fromFm4(find("E.PIANO"));
    expect(patch.algorithm).toBe(5);
    expect(patch.ops.map((o) => o.ratio)).toEqual([1, 1, 1, 16]); // R4 = 14 is an index: the table's 16
    // Carriers 1 and 3.
    expect(patch.ops[0]).toMatchObject({ level: 0.5, attack: 0, sustain: 40 / 127 });
    expect(patch.ops[0].decay).toBeCloseTo(fm4Time(80), 12);
    // Modulators 2 and 4: INDEX 70.
    expect(patch.ops[1].level).toBeCloseTo(70 / 127, 12);
    expect(patch.ops[1]).toMatchObject({ attack: 0, sustain: 0.25 });
    expect(patch.ops[3].decay).toBeCloseTo(fm4Time(55), 12);
    expect(patch.feedback).toBe(0);
    expect([voices, transpose]).toEqual([8, 0]);
  });

  it("halves the two modulators an operator shares in algorithms 2, 3 and 4", () => {
    const funk = fromFm4(find("FUNK KEY")).patch; // ALG 3 → algorithm 4: operators 2 and 3 feed operator 1
    expect(funk.algorithm).toBe(4);
    expect(funk.ops[1].level).toBeCloseTo(90 / 127 / 2, 12);
    expect(funk.ops[2].level).toBeCloseTo(90 / 127 / 2, 12);
    expect(funk.ops[3].level).toBeCloseTo(90 / 127, 12); // operator 4 feeds operator 3 alone
  });

  it("makes MONO sounds one voice and keeps SLOOP's transposition", () => {
    expect(fromFm4(find("FM BASS"))).toMatchObject({ voices: 1, transpose: -24 });
    expect(fromFm4(find("GLOCKEN")).transpose).toBe(12);
  });

  it("scales feedback to ours and clamps the strongest", () => {
    expect(fromFm4(find("BASS")).patch.feedback).toBeGreaterThan(0);
    expect(fromFm4(find("CLAV")).patch.feedback).toBe(1);
  });

  it("gives every preset a patch that plays, finite and bounded", () => {
    for (const raw of FM4_RAW_PRESETS) {
      const { patch, voices } = fromFm4(raw);
      const s = new FmSynth(voices, 48_000);
      s.setPatch(patch);
      s.noteOn(60, 1);
      const out = new Float32Array(24_000);
      s.render(out, 0, out.length);
      const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      expect(peak, raw.name).toBeGreaterThan(0.01);
      expect(peak, raw.name).toBeLessThan(1.5);
      expect(out.every(Number.isFinite), raw.name).toBe(true);
    }
  });

  it("lists every preset under a unique name, source first", () => {
    const names = FM4_RAW_PRESETS.map(fm4PresetName);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("SLOOP · RHODES");
    expect(names).toContain("Felucca · E.PIANO");
    expect(names).toHaveLength(29); // 8 Felucca + 21 SLOOP (its MARIMBA is Felucca's)
  });
});
