import { describe, expect, it } from "vitest";
import { EPIANO_PATCH, FmOperatorPatch, FmPatch, FmSynth, midiToHz, sineTurns } from "./fm";
import { worstCaseSynths } from "./worstCase";

const SR = 48_000;
const A4 = 69;

const op = (ratio: number, level: number, extra: Partial<FmOperatorPatch> = {}): FmOperatorPatch => ({
  ratio,
  detune: 0,
  level,
  velocitySens: 0,
  attack: 0,
  decay: 1,
  sustain: 1,
  release: 0.01,
  ...extra,
});

const patch = (algorithm: number, ops: FmOperatorPatch[], feedback = 0): FmPatch => ({
  algorithm,
  feedback,
  ops: ops as FmPatch["ops"],
});

function render(synth: FmSynth, samples: number, block = 128): Float32Array {
  const out = new Float32Array(samples);
  for (let s = 0; s < samples; s += block) synth.render(out, s, Math.min(block, samples - s));
  return out;
}

/** Amplitude of one frequency in a signal (Goertzel), normalised so a unit sine reads ≈ 1. */
function amplitudeAt(x: Float32Array, hz: number): number {
  const w = (2 * Math.PI * hz) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s0 = x[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (2 * Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2)) / x.length;
}

function maxStep(x: Float32Array, from = 1, to = x.length): number {
  let m = 0;
  for (let i = Math.max(1, from); i < to; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
}

function synthWith(p: FmPatch, voices = 8): FmSynth {
  const s = new FmSynth(voices, SR);
  s.setPatch(p);
  return s;
}

describe("sineTurns", () => {
  it("matches Math.sin within the table's interpolation error", () => {
    for (let p = -2; p < 2; p += 0.0137) expect(Math.abs(sineTurns(p) - Math.sin(2 * Math.PI * p))).toBeLessThan(2e-6);
  });
});

describe("FmSynth — tone and routing", () => {
  it("plays a pure carrier at the note's frequency", () => {
    const s = synthWith(patch(1, [op(1, 1), op(1, 0), op(1, 0), op(1, 0)]));
    s.noteOn(A4, 1);
    const out = render(s, SR);
    let crossings = 0;
    for (let i = 1; i < out.length; i++) if (out[i - 1] < 0 && out[i] >= 0) crossings++;
    expect(Math.abs(crossings - 440)).toBeLessThanOrEqual(1);
    expect(amplitudeAt(out, 440)).toBeGreaterThan(0.95);
  });

  it("detunes in cents", () => {
    const s = synthWith(patch(1, [op(1, 1, { detune: 1200 }), op(1, 0), op(1, 0), op(1, 0)]));
    s.noteOn(A4, 1);
    const out = render(s, SR);
    expect(amplitudeAt(out, 880)).toBeGreaterThan(0.95);
    expect(amplitudeAt(out, 440)).toBeLessThan(0.01);
  });

  it("hears operator 4 when it is a carrier (algorithm 8) and not when it modulates (algorithm 7)", () => {
    const ops = [op(1, 1), op(2, 1), op(3, 1), op(5, 1)];
    const all = synthWith(patch(8, ops));
    all.noteOn(A4, 1);
    const a8 = render(all, SR);
    for (const r of [1, 2, 3, 5]) expect(amplitudeAt(a8, 440 * r)).toBeGreaterThan(0.2);

    const seven = synthWith(patch(7, [op(1, 1), op(2, 1), op(3, 1), op(5, 0)]));
    seven.noteOn(A4, 1);
    const a7 = render(seven, SR);
    for (const r of [1, 2, 3]) expect(amplitudeAt(a7, 440 * r)).toBeGreaterThan(0.3);
    expect(amplitudeAt(a7, 440 * 5)).toBeLessThan(0.001);
  });

  it("a modulator adds sidebands to its carrier", () => {
    const quiet = synthWith(patch(1, [op(1, 1), op(1, 0), op(1, 0), op(1, 0)]));
    const bright = synthWith(patch(1, [op(1, 1), op(1, 0.3), op(1, 0), op(1, 0)]));
    quiet.noteOn(A4, 1);
    bright.noteOn(A4, 1);
    expect(amplitudeAt(render(quiet, SR), 880)).toBeLessThan(0.001);
    expect(amplitudeAt(render(bright, SR), 880)).toBeGreaterThan(0.1);
  });

  it("scales by velocity as much as velocitySens says", () => {
    const level = (sens: number, vel: number) => {
      const s = synthWith(patch(1, [op(1, 1, { velocitySens: sens }), op(1, 0), op(1, 0), op(1, 0)]));
      s.noteOn(A4, vel);
      return amplitudeAt(render(s, SR / 2), 440);
    };
    expect(level(1, 0.5) / level(1, 1)).toBeCloseTo(0.5, 3);
    expect(level(0, 0.5) / level(0, 1)).toBeCloseTo(1, 6);
  });

  it("stays finite at full feedback on every algorithm", () => {
    for (let a = 1; a <= 8; a++) {
      const s = synthWith(patch(a, [op(1, 1), op(1.5, 1), op(2, 1), op(3.5, 1)], 1));
      for (const n of [24, 60, 96]) s.noteOn(n, 1);
      const out = render(s, SR / 4);
      for (const x of out) expect(Number.isFinite(x) && Math.abs(x) <= 3).toBe(true);
    }
  });
});

describe("FmSynth — envelopes", () => {
  it("frees a voice after its release and leaves exact zeros, not denormals", () => {
    const s = synthWith(EPIANO_PATCH);
    s.noteOn(60, 1);
    render(s, SR / 4);
    s.noteOff(60);
    render(s, SR * 6);
    expect(s.isActive(0)).toBe(false);
    const after = render(s, 1000);
    expect(after.every((x) => x === 0)).toBe(true);
  });

  it("ends a percussive voice by itself when the carrier decays to a sustain of 0", () => {
    const s = synthWith(patch(1, [op(1, 1, { sustain: 0, decay: 0.05 }), op(1, 0), op(1, 0), op(1, 0)]));
    s.noteOn(60, 1);
    render(s, SR);
    expect(s.isActive(0)).toBe(false);
  });

  it("glides an operator level instead of jumping to it", () => {
    const p = patch(1, [op(1, 0), op(1, 0), op(1, 0), op(1, 0)]);
    const s = synthWith(p);
    s.noteOn(A4, 1);
    render(s, 4800);
    s.setPatch(patch(1, [op(1, 1), op(1, 0), op(1, 0), op(1, 0)]));
    const out = render(s, 4800);
    // A jump would start at full amplitude; the glide starts near 0 and reaches it within 5 ms.
    expect(Math.abs(out[0])).toBeLessThan(0.02);
    expect(amplitudeAt(out.subarray(480), 440)).toBeGreaterThan(0.9);
  });
});

describe("FmSynth — voices", () => {
  it("gives each new note a free voice, and a repeated note its own voice again", () => {
    const s = synthWith(EPIANO_PATCH);
    const v = [60, 64, 67].map((n) => s.noteOn(n, 1));
    expect(new Set(v).size).toBe(3);
    expect(s.noteOn(64, 0.5)).toBe(v[1]);
    expect(s.activeVoices()).toBe(3);
  });

  it("steals the oldest released voice first, then the oldest held one", () => {
    const s = synthWith(patch(1, [op(1, 1, { release: 5 }), op(1, 0), op(1, 0), op(1, 0)]), 4);
    const voice = [60, 62, 64, 65].map((n) => s.noteOn(n, 1));
    s.noteOff(64);
    expect(s.noteOn(70, 1)).toBe(voice[2]); // the released one, although 60 is older
    expect(s.noteOn(71, 1)).toBe(voice[0]); // then the oldest held
    expect(s.voiceNote(voice[0])).toBe(71);
  });

  it("fades a stolen voice out over 2 ms instead of cutting it", () => {
    const s = synthWith(patch(1, [op(1, 1), op(1, 0), op(1, 0), op(1, 0)]), 1);
    s.noteOn(A4, 1);
    render(s, 1000);
    s.noteOn(A4 + 12, 1);
    const out = render(s, 1000);
    // A 440 Hz sine of amplitude 1 moves up to 0.058 per sample, 880 Hz up to 0.115; a cut would jump by up to 1.
    expect(maxStep(out)).toBeLessThan(0.13);
    expect(s.voiceNote(0)).toBe(A4 + 12);
    expect(amplitudeAt(out.subarray(200), 880)).toBeGreaterThan(0.9);
  });

  it("releases a stolen voice's new note if it was let go during the fade", () => {
    const s = synthWith(patch(1, [op(1, 1), op(1, 0), op(1, 0), op(1, 0)]), 1);
    s.noteOn(60, 1);
    render(s, 100);
    s.noteOn(72, 1);
    s.noteOff(72);
    render(s, SR);
    expect(s.isActive(0)).toBe(false);
  });

  it("frees the voice a note-off lets go, and only that one", () => {
    const s = synthWith(patch(1, [op(1, 1, { release: 0.01 }), op(1, 0), op(1, 0), op(1, 0)]));
    s.noteOn(60, 1);
    s.noteOn(64, 1);
    s.noteOff(60);
    render(s, SR / 2);
    expect(s.activeVoices()).toBe(1);
    s.allNotesOff();
    render(s, SR / 2);
    expect(s.activeVoices()).toBe(0);
  });
});

describe("FmSynth — glide", () => {
  it("starts at the glide's note and reaches its own in the glide's time", () => {
    const s = synthWith(patch(1, [op(1, 1), op(1, 0), op(1, 0), op(1, 0)]));
    s.noteOn(A4 + 12, 1, { from: A4, seconds: 0.1 });
    const out = render(s, SR / 2);
    const start = out.subarray(0, 480); // the first 10 ms: still near 440
    const end = out.subarray(SR / 4); // well past 100 ms: 880
    expect(amplitudeAt(start, 440 * Math.pow(2, 0.5 / 12))).toBeGreaterThan(amplitudeAt(start, 880));
    expect(amplitudeAt(end, 880)).toBeGreaterThan(0.95);
    expect(maxStep(out)).toBeLessThan(0.13); // a slide, not a jump
  });

  it("glides on a stolen voice's new note too", () => {
    const s = synthWith(patch(1, [op(1, 1), op(1, 0), op(1, 0), op(1, 0)]), 1);
    s.noteOn(48, 1);
    render(s, 1000);
    s.noteOn(A4 + 12, 1, { from: A4, seconds: 0.05 });
    render(s, SR / 4);
    expect(amplitudeAt(render(s, SR / 4), 880)).toBeGreaterThan(0.95);
  });
});

describe("FmSynth — determinism", () => {
  it("renders the same samples whatever the block size, through chords, steals and patch changes", () => {
    const play = (block: number) => {
      const s = synthWith(EPIANO_PATCH, 4);
      const out: number[] = [];
      const run = (n: number) => out.push(...render(s, n, block));
      [60, 64, 67, 71].forEach((n) => s.noteOn(n, 0.8));
      run(3000);
      s.noteOn(74, 1); // steals
      s.noteOff(64);
      run(2500);
      s.setPatch({ ...EPIANO_PATCH, algorithm: 2, feedback: 0.6 });
      run(2500);
      s.allNotesOff();
      run(4000);
      return out;
    };
    const ref = play(128);
    expect(play(128)).toEqual(ref);
    expect(play(37)).toEqual(ref);
    expect(play(1000)).toEqual(ref);
  });

  it("converts MIDI notes to Hz", () => {
    expect(midiToHz(69)).toBe(440);
    expect(midiToHz(81)).toBeCloseTo(880, 9);
    expect(midiToHz(60)).toBeCloseTo(261.6256, 3);
  });
});

/**
 * Worst case of the MVP budget: 3 FM tracks × 8 voices × 4 operators, every voice sounding. Skipped by plain
 * `npm test`; run with TSUJI_MUSIC_BENCH=1 npx vitest run src/shared/music/dsp/fm.test.ts
 */
describe.skipIf(!process.env.TSUJI_MUSIC_BENCH)("FmSynth budget", () => {
  it("renders 96 operators well inside a 128-sample block", () => {
    const synths = worstCaseSynths(SR);
    const block = new Float32Array(128);
    const run = (blocks: number) => {
      for (let i = 0; i < blocks; i++) for (const s of synths) s.render(block, 0, 128);
    };
    run(2000); // JIT warm-up
    const blocks = 20_000;
    const t0 = performance.now();
    run(blocks);
    const ms = (performance.now() - t0) / blocks;
    const budget = (128 / SR) * 1000;
    expect(synths.every((s) => s.activeVoices() === 8)).toBe(true);
    console.log(`96 ops: ${(ms * 1000).toFixed(1)} µs per block of ${(budget * 1000).toFixed(0)} µs → ${((ms / budget) * 100).toFixed(1)} % of one core`);
    expect(ms).toBeLessThan(budget / 2);
  });
});
