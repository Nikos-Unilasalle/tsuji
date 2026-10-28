import { describe, expect, it } from "vitest";
import { FmBank, FmPatch, SPIKE_PATCH, sineTurns } from "./fm";

const SR = 48_000;

/** A carrier alone, no modulation: a plain sine at the note. */
const PURE: FmPatch = {
  ops: [
    { ratio: 1, level: 1, attack: 0, decay: 1, sustain: 1, release: 0.01 },
    { ratio: 1, level: 0, attack: 0, decay: 1, sustain: 1, release: 0.01 },
  ],
  feedback: 0,
};

function renderSeconds(bank: FmBank, seconds: number, block = 128): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let s = 0; s < out.length; s += block) bank.render(out, s, Math.min(block, out.length - s));
  return out;
}

describe("sineTurns", () => {
  it("matches Math.sin within the table's interpolation error", () => {
    for (let p = -2; p < 2; p += 0.0137) expect(Math.abs(sineTurns(p) - Math.sin(2 * Math.PI * p))).toBeLessThan(2e-6);
  });
});

describe("FmBank", () => {
  it("plays a pure carrier at the note's frequency", () => {
    const bank = new FmBank(1, 2, SR);
    bank.setPatch(PURE);
    bank.noteOn(0, 440, 1);
    const out = renderSeconds(bank, 1);
    let crossings = 0;
    for (let i = 1; i < out.length; i++) if (out[i - 1] < 0 && out[i] >= 0) crossings++;
    expect(Math.abs(crossings - 440)).toBeLessThanOrEqual(1);
  });

  it("renders the same samples twice, whatever the block size", () => {
    const play = (block: number) => {
      const bank = new FmBank(4, 2, SR);
      bank.setPatch(SPIKE_PATCH);
      [261.63, 329.63, 392, 493.88].forEach((f, v) => bank.noteOn(v, f, 0.8));
      const a = renderSeconds(bank, 0.5, block);
      for (let v = 0; v < 4; v++) bank.noteOff(v);
      const b = renderSeconds(bank, 0.5, block);
      return [...a, ...b];
    };
    const ref = play(128);
    expect(play(128)).toEqual(ref);
    expect(play(37)).toEqual(ref);
  });

  it("stays finite and bounded, and frees voices after their release", () => {
    const bank = new FmBank(8, 4, SR);
    bank.setPatch({ ...SPIKE_PATCH, feedback: 0.9 });
    for (let v = 0; v < 8; v++) bank.noteOn(v, 55 * (v + 1), 1);
    const held = renderSeconds(bank, 0.5);
    for (const x of held) expect(Number.isFinite(x) && Math.abs(x) <= 8).toBe(true);
    for (let v = 0; v < 8; v++) bank.noteOff(v);
    renderSeconds(bank, 3);
    for (let v = 0; v < 8; v++) expect(bank.isActive(v)).toBe(false);
  });
});

/**
 * Worst case of the MVP budget: 3 FM tracks × 8 voices × 4 operators, every voice sounding. Skipped by plain
 * `npm test`; run with TSUJI_MUSIC_BENCH=1 npx vitest run src/shared/music/dsp/fm.test.ts
 */
describe.skipIf(!process.env.TSUJI_MUSIC_BENCH)("FmBank budget", () => {
  it("renders 96 operators well inside a 128-sample block", () => {
    const banks = [0, 1, 2].map(() => {
      const b = new FmBank(8, 4, SR);
      b.setPatch(SPIKE_PATCH);
      for (let v = 0; v < 8; v++) b.noteOn(v, 110 * (v + 1), 0.5);
      return b;
    });
    const block = new Float32Array(128);
    const run = (blocks: number) => {
      for (let i = 0; i < blocks; i++) for (const b of banks) b.render(block, 0, 128);
    };
    run(2000); // JIT warm-up
    const blocks = 20_000;
    const t0 = performance.now();
    run(blocks);
    const ms = (performance.now() - t0) / blocks;
    const budget = (128 / SR) * 1000;
    console.log(`96 ops: ${(ms * 1000).toFixed(1)} µs per block of ${(budget * 1000).toFixed(0)} µs → ${((ms / budget) * 100).toFixed(1)} % of one core`);
    expect(ms).toBeLessThan(budget / 2);
  });
});
