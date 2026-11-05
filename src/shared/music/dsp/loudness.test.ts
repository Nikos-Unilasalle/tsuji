import { describe, expect, it } from "vitest";
import { LoudnessMeter } from "./loudness";

const SR = 48_000;

function sine(freq: number, amp: number, seconds: number): Float32Array {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return x;
}

describe("LoudnessMeter (BS.1770)", () => {
  it("reads a full-scale 997 Hz sine in one channel at −3.01 LUFS, the standard's own check", () => {
    const m = new LoudnessMeter(SR);
    const l = sine(997, 1, 4);
    const r = new Float32Array(l.length);
    for (let s = 0; s < l.length; s += 128) m.process(l, r, s, Math.min(128, l.length - s));
    const { momentary, shortTerm, integrated } = m.reading();
    expect(momentary).toBeCloseTo(-3.01, 1);
    expect(shortTerm).toBeCloseTo(-3.01, 1);
    expect(integrated).toBeCloseTo(-3.01, 1);
  });

  it("gates silence out of the integrated loudness, and starts over on reset", () => {
    const m = new LoudnessMeter(SR);
    const tone = sine(997, 0.1, 3);
    const quiet = new Float32Array(tone.length);
    m.process(tone, tone, 0, tone.length);
    const loud = m.reading().integrated;
    m.process(quiet, quiet, 0, quiet.length);
    // Three seconds of silence leave it where the tone put it (within the blocks that straddle the cut).
    expect(Math.abs(m.reading().integrated - loud)).toBeLessThan(0.5);
    expect(m.reading().momentary).toBeLessThan(-70);
    m.reset();
    expect(m.reading().integrated).toBe(-Infinity);
  });
});
