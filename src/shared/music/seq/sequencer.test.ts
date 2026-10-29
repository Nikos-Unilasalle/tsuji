import { describe, expect, it } from "vitest";
import { ArpSettings, DEFAULT_ARP } from "./arp";
import { Cell, Clock, NoteEvent, Sequence, notesSoundingAt, notesStartingIn, stepAt, stepSample } from "./sequencer";

const SR = 48_000;
const CLOCK_120: Clock = { bpm: 120, swing: 0, stepsPerBeat: 4 };
const STEP = 6000; // a sixteenth at 120 BPM, 48 kHz

function seqOf(cells: Record<number, Cell>, opts: { length?: number; clock?: Clock; arp?: ArpSettings; seed?: number } = {}): Sequence {
  const length = opts.length ?? 16;
  const steps: (Cell | null)[] = Array.from({ length }, (_, i) => cells[i] ?? null);
  return { clock: opts.clock ?? CLOCK_120, pattern: { length, steps }, arp: opts.arp ?? null, seed: opts.seed };
}

/** Everything from sample 0 to `to`, read block by block as the engine will. */
function collect(seq: Sequence, to: number, block = 128): NoteEvent[] {
  const out: NoteEvent[] = [];
  for (let s = 0; s < to; s += block) out.push(...notesStartingIn(seq, SR, s, Math.min(to, s + block)));
  return out;
}

const pick = (e: NoteEvent) => [e.on, e.off, e.note];

describe("clock", () => {
  it("puts a sixteenth at 6000 samples at 120 BPM", () => {
    expect([0, 1, 2, 16].map((g) => stepSample(CLOCK_120, SR, g))).toEqual([0, 6000, 12000, 96000]);
  });

  it("does not drift at a tempo that does not divide the sample rate", () => {
    const c: Clock = { bpm: 137, swing: 0, stepsPerBeat: 4 };
    expect(stepSample(c, SR, 548)).toBe(2_880_000); // 137 beats = 60 s
    expect(stepSample(c, SR, 548 * 10)).toBe(28_800_000);
  });

  it("delays each second step by half a step at full swing, a quarter at half swing", () => {
    expect(stepSample({ ...CLOCK_120, swing: 1 }, SR, 1)).toBe(9000);
    expect(stepSample({ ...CLOCK_120, swing: 0.5 }, SR, 3)).toBe(19500);
    expect(stepSample({ ...CLOCK_120, swing: 1 }, SR, 2)).toBe(12000); // even steps stay put
  });

  it("finds the step under a sample, swing included", () => {
    const sw = { ...CLOCK_120, swing: 1 };
    expect(stepAt(CLOCK_120, SR, 5999)).toBe(0);
    expect(stepAt(CLOCK_120, SR, 6000)).toBe(1);
    expect(stepAt(sw, SR, 8999)).toBe(0);
    expect(stepAt(sw, SR, 9000)).toBe(1);
    expect(stepAt(CLOCK_120, SR, -1)).toBe(-1);
  });
});

describe("tracker semantics", () => {
  it("holds a note until the next note, an OFF, or its own length", () => {
    const seq = seqOf({ 0: { note: 60 }, 4: { note: 62 }, 6: { note: "off" }, 8: { note: 64, length: 1 } });
    expect(collect(seq, 16 * STEP).map(pick)).toEqual([
      [0, 4 * STEP, 60],
      [4 * STEP, 6 * STEP, 62],
      [8 * STEP, 9 * STEP, 64],
    ]);
  });

  it("loops the pattern, a lone note lasting until it comes round again", () => {
    const seq = seqOf({ 0: { note: 60 } });
    expect(collect(seq, 33 * STEP).map(pick)).toEqual([
      [0, 16 * STEP, 60],
      [16 * STEP, 32 * STEP, 60],
      [32 * STEP, 48 * STEP, 60],
    ]);
  });

  it("looks for a note's end across the loop", () => {
    const seq = seqOf({ 2: { note: 60 }, 12: { note: 62 } });
    const [, second] = collect(seq, 16 * STEP);
    expect(pick(second)).toEqual([12 * STEP, 18 * STEP, 62]);
  });

  it("uses each cell's velocity, 0.8 by default", () => {
    const seq = seqOf({ 0: { note: 60 }, 1: { note: 62, velocity: 0.3 } });
    expect(collect(seq, 2 * STEP).map((e) => e.velocity)).toEqual([0.8, 0.3]);
  });
});

describe("chords", () => {
  it("plays every note of the chord together", () => {
    const seq = seqOf({ 0: { note: 60, chord: "min7" }, 8: { note: "off" } });
    expect(collect(seq, 16 * STEP).map(pick)).toEqual([
      [0, 8 * STEP, 60],
      [0, 8 * STEP, 63],
      [0, 8 * STEP, 67],
      [0, 8 * STEP, 70],
    ]);
  });

  it("strikes added notes with the cell, without doubling a chord note", () => {
    const seq = seqOf({ 0: { note: 60, chord: "maj", add: [67, 71] } });
    expect(collect(seq, STEP).map((e) => e.note)).toEqual([60, 64, 67, 71]);
  });

  it("applies the inversion and the spread", () => {
    const seq = seqOf({ 0: { note: 60, chord: "maj7", inversion: 1, spread: true } });
    expect(collect(seq, STEP).map((e) => e.note)).toEqual([64, 71, 79, 84]);
  });
});

describe("arpeggio", () => {
  const chord = { 0: { note: 60, chord: "maj" as const }, 8: { note: "off" as const } };

  it("turns a held chord into sixteenths, up", () => {
    const seq = seqOf(chord, { arp: DEFAULT_ARP });
    const notes = collect(seq, 16 * STEP);
    expect(notes.map((e) => e.note)).toEqual([60, 64, 67, 60, 64, 67, 60, 64]);
    expect(notes.map((e) => e.on)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => i * STEP));
    expect(notes[0].off).toBe(0.8 * STEP); // gate
  });

  it("follows the rate, triplets and octaves", () => {
    expect(collect(seqOf(chord, { arp: { ...DEFAULT_ARP, rate: "1/8" } }), 16 * STEP)).toHaveLength(4);
    expect(collect(seqOf(chord, { arp: { ...DEFAULT_ARP, rate: "1/8", triplet: true } }), 16 * STEP)).toHaveLength(6);
    const two = collect(seqOf(chord, { arp: { ...DEFAULT_ARP, octaves: 2 } }), 16 * STEP);
    expect(two.map((e) => e.note)).toEqual([60, 64, 67, 72, 76, 79, 60, 64]);
  });

  it("never lets an arp note outlast its chord", () => {
    const seq = seqOf({ 0: { note: 60, chord: "maj" }, 1: { note: "off" } }, { arp: { ...DEFAULT_ARP, rate: "1/4", gate: 1 } });
    expect(collect(seq, 4 * STEP).map(pick)).toEqual([[0, STEP, 60]]);
  });

  it("lands on the grid in grid sync, restarts with the chord in retrigger sync", () => {
    const clock = { ...CLOCK_120, swing: 1 }; // step 1 starts at 1.5 steps
    const cells = { 1: { note: 60, chord: "maj" as const }, 4: { note: "off" as const } }; // step 4 is even: not swung
    const grid = collect(seqOf(cells, { clock, arp: DEFAULT_ARP }), 8 * STEP).map((e) => e.on);
    expect(grid).toEqual([1.5, 2, 3].map((x) => x * STEP));
    const retrig = collect(seqOf(cells, { clock, arp: { ...DEFAULT_ARP, sync: "retrigger" } }), 8 * STEP).map((e) => e.on);
    expect(retrig).toEqual([1.5, 2.5, 3.5].map((x) => x * STEP));
  });
});

describe("effects", () => {
  it("ratchets: n strikes inside the step, the last one held to the note's end", () => {
    const seq = seqOf({ 0: { note: 60, fx: { type: "RTG", value: 4 } }, 4: { note: "off" } });
    const q = STEP / 4;
    expect(collect(seq, 8 * STEP).map(pick)).toEqual([
      [0, 0.75 * q, 60],
      [q, 1.75 * q, 60],
      [2 * q, 2.75 * q, 60],
      [3 * q, 4 * STEP, 60],
    ]);
  });

  it("glides from the previous note, the chord moving in parallel", () => {
    const seq = seqOf({ 0: { note: 60 }, 4: { note: 67, chord: "maj", fx: { type: "GLD", value: 10 } } });
    const glided = collect(seq, 8 * STEP).filter((e) => e.step === 4);
    expect(glided.map((e) => [e.note, e.glideFrom, e.glideSeconds])).toEqual([
      [67, 60, 0.1],
      [71, 64, 0.1],
      [74, 67, 0.1],
    ]);
  });

  it("delays a note by sixteenths of a step, its length counted from where it starts", () => {
    const seq = seqOf({ 0: { note: 60, fx: { type: "DLY", value: 4 }, length: 0.5 }, 2: { note: 62 } });
    expect(collect(seq, 4 * STEP).map(pick)).toEqual([
      [STEP / 4, STEP / 4 + STEP / 2, 60],
      [2 * STEP, 16 * STEP, 62], // held round the loop to its own step
    ]);
  });

  it("plays a chance cell about as often as it says, the same way every run", () => {
    const seq = seqOf({ 0: { note: 60, fx: { type: "CHN", value: 50 } } }, { length: 1, seed: 3 });
    const a = collect(seq, 400 * STEP, 4096);
    expect(a.length).toBeGreaterThan(160);
    expect(a.length).toBeLessThan(240);
    expect(collect(seq, 400 * STEP, 4096)).toEqual(a);
    expect(collect({ ...seq, seed: 4 }, 400 * STEP, 4096)).not.toEqual(a);
  });

  it("lets a skipped chance cell leave the previous note sounding", () => {
    // seed 0: step 1's chance of 0 % never fires, so 60 holds on to step 2.
    const seq = seqOf({ 0: { note: 60 }, 1: { note: 62, fx: { type: "CHN", value: 0 } }, 2: { note: "off" } });
    expect(collect(seq, 4 * STEP).map(pick)).toEqual([[0, 2 * STEP, 60]]);
  });
});

describe("long patterns", () => {
  it("finds notes across long silences and round the loop, a whole song in one pattern", () => {
    const L = 6000;
    const seq = seqOf({ 5: { note: 60 }, 3000: { note: "off" }, 5990: { note: 62, fx: { type: "CHN", value: 100 } } }, { length: L });
    // 60 holds from step 5 to the OFF at 3000; 62 from 5990 round the loop to 60's step 5 again.
    expect(notesSoundingAt(seq, SR, 1000 * STEP).map((e) => [e.note, e.on, e.off])).toEqual([[60, 5 * STEP, 3000 * STEP]]);
    expect(notesSoundingAt(seq, SR, 4000 * STEP)).toEqual([]);
    expect(notesSoundingAt(seq, SR, (L + 2) * STEP).map((e) => [e.note, e.on, e.off])).toEqual([[62, 5990 * STEP, (L + 5) * STEP]]);
    expect(notesStartingIn(seq, SR, (L + 5) * STEP, (L + 6) * STEP).map((e) => e.note)).toEqual([60]);
  });
});

describe("reading the sequence", () => {
  const busy = seqOf(
    {
      0: { note: 48, chord: "min7" },
      3: { note: 50, fx: { type: "RTG", value: 3 } },
      5: { note: 55, chord: "9", inversion: 2, fx: { type: "CHN", value: 70 } },
      9: { note: 57, fx: { type: "GLD", value: 8 } },
      13: { note: "off" },
    },
    { clock: { bpm: 133, swing: 0.6, stepsPerBeat: 4 }, seed: 11 },
  );

  it("gives the same notes whatever the block size", () => {
    const end = 40 * STEP;
    const ref = collect(busy, end, 128);
    expect(collect(busy, end, 37)).toEqual(ref);
    expect(collect(busy, end, 5000)).toEqual(ref);
    expect(notesStartingIn(busy, SR, 0, end)).toEqual(ref);
  });

  it("gives the same arpeggio whatever the block size", () => {
    const seq = { ...busy, arp: { ...DEFAULT_ARP, mode: "random" as const, rate: "1/32" as const, octaves: 2 } };
    const ref = collect(seq, 40 * STEP, 128);
    expect(collect(seq, 40 * STEP, 61)).toEqual(ref);
  });

  it("knows what is sounding at any sample", () => {
    const seq = seqOf({ 0: { note: 60, chord: "maj" }, 8: { note: "off" }, 12: { note: 72 } }, { length: 16 });
    expect(notesSoundingAt(seq, SR, 3 * STEP).map((e) => e.note)).toEqual([60, 64, 67]);
    expect(notesSoundingAt(seq, SR, 10 * STEP)).toEqual([]);
    expect(notesSoundingAt(seq, SR, 13 * STEP).map((e) => e.note)).toEqual([72]);
    expect(notesSoundingAt(seq, SR, 17 * STEP).map((e) => e.note)).toEqual([60, 64, 67]); // the next loop
    const arp = { ...seq, arp: DEFAULT_ARP };
    expect(notesSoundingAt(arp, SR, 2 * STEP + 10).map((e) => e.note)).toEqual([67]);
    expect(notesSoundingAt(arp, SR, 2 * STEP + 0.9 * STEP)).toEqual([]); // between two gated arp notes
  });
});
