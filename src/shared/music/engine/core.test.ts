import { describe, expect, it } from "vitest";
import { FmOperatorPatch, FmPatch } from "../dsp/fm";
import { DEFAULT_ARP } from "../seq/arp";
import { Cell, Sequence } from "../seq/sequencer";
import { EngineCore } from "./core";
import { MusicDescription, TrackDescription } from "./description";

const SR = 48_000;
const STEP = 6000; // a sixteenth at 120 BPM

const op = (level: number, extra: Partial<FmOperatorPatch> = {}): FmOperatorPatch => ({
  ratio: 1,
  detune: 0,
  level,
  velocitySens: 0,
  attack: 0,
  decay: 1,
  sustain: 1,
  release: 0.02,
  ...extra,
});
/** A plain sine with an instant attack: the first non-zero sample is the note-on. */
const SINE: FmPatch = { algorithm: 1, feedback: 0, ops: [op(0.5), op(0), op(0), op(0)] };
/** Soft edges, to hear (well, measure) clicks. */
const PAD: FmPatch = { algorithm: 1, feedback: 0, ops: [op(0.5, { attack: 0.01, release: 0.05 }), op(0), op(0), op(0)] };

function seqOf(cells: Record<number, Cell>, length = 16): Sequence {
  return {
    clock: { bpm: 120, swing: 0, stepsPerBeat: 4 },
    pattern: { length, steps: Array.from({ length }, (_, i) => cells[i] ?? null) },
  };
}

function track(id: string, seq: Sequence, patch: FmPatch = SINE, extra: Partial<TrackDescription> = {}): TrackDescription {
  return { id, kind: "fm", voices: 8, patch, seq, level: 1, pan: -1, mute: false, ...extra };
}

const desc = (...tracks: TrackDescription[]): MusicDescription => ({ tracks, master: 1 });

/** Renders n samples in blocks; returns the left channel. */
function run(engine: EngineCore, n: number, block = 128): Float32Array {
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let s = 0; s < n; s += block) engine.render(l, r, s, Math.min(block, n - s));
  return l;
}

const firstSound = (x: Float32Array) => x.findIndex((v) => v !== 0);
function maxStep(x: Float32Array): number {
  let m = 0;
  for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
}

describe("EngineCore — scheduling", () => {
  it("strikes each note on its exact sample", () => {
    const e = new EngineCore(SR);
    e.describe(desc(track("a", seqOf({ 4: { note: 69 } }))));
    e.play(0);
    expect(firstSound(run(e, 6 * STEP))).toBe(4 * STEP);
  });

  it("renders the same samples whatever the block size", () => {
    const go = (block: number) => {
      const e = new EngineCore(SR);
      e.describe(
        desc(
          track("chords", { ...seqOf({ 0: { note: 60, chord: "maj7" }, 8: { note: 57, chord: "min7" } }), arp: { ...DEFAULT_ARP, mode: "updown", octaves: 2 } }, PAD),
          track("bass", seqOf({ 0: { note: 36 }, 6: { note: 43, fx: { type: "GLD", value: 10 } }, 12: { note: 40, fx: { type: "RTG", value: 3 } } }), SINE, { pan: 0.3 }),
        ),
      );
      e.play(0);
      return run(e, 40 * STEP, block);
    };
    const ref = go(128);
    expect(go(37)).toEqual(ref);
    expect(go(2048)).toEqual(ref);
  });

  it("ends notes on time: an OFF frees the voice after its release", () => {
    const e = new EngineCore(SR);
    e.describe(desc(track("a", seqOf({ 0: { note: 60 }, 2: { note: "off" } }))));
    e.play(0);
    run(e, 2 * STEP + 100);
    expect(e.activeVoices()).toBe(1); // releasing
    run(e, STEP);
    expect(e.activeVoices()).toBe(0);
  });
});

describe("EngineCore — transport", () => {
  const chord = () => desc(track("a", seqOf({ 0: { note: 60, chord: "maj" }, 12: { note: "off" } }), PAD));

  it("starts nothing new while paused, and lets the tails ring out", () => {
    const e = new EngineCore(SR);
    e.describe(chord());
    e.play(0);
    run(e, STEP);
    e.pause();
    const tail = run(e, SR / 2);
    expect(tail[0]).not.toBe(0); // not cut
    expect(tail[tail.length - 1]).toBe(0);
    expect(e.activeVoices()).toBe(0);
    expect(e.position).toBe(STEP); // the clock stopped with the transport
  });

  it("starts the notes already sounding at a seek's target, without a click", () => {
    const e = new EngineCore(SR);
    e.describe(chord());
    e.play(0);
    const before = run(e, STEP);
    e.seek(6 * STEP); // mid-chord
    const after = run(e, STEP);
    expect(e.activeVoices()).toBe(3);
    // Three sines of 0.5 move by up to 0.064 a sample on their own; a cut or a restart from 0 would jump by ~1.
    expect(maxStep(Float32Array.from([...before, ...after]))).toBeLessThan(0.1);
  });

  it("does not strike a note twice when a seek lands on its note-on", () => {
    const e = new EngineCore(SR);
    e.describe(desc(track("a", seqOf({ 4: { note: 60 } }), SINE, { voices: 1 })));
    e.play(0);
    run(e, STEP);
    e.seek(4 * STEP);
    const x = run(e, 100);
    expect(firstSound(x)).toBe(0);
    expect(e.activeVoices()).toBe(1);
  });

  it("follows the playhead: keeps its own clock within the tolerance, jumps past it, loops back", () => {
    const e = new EngineCore(SR);
    e.describe(chord());
    const tol = 0.08 * SR;
    e.follow(true, 0, tol);
    expect(e.isPlaying).toBe(true);
    run(e, 1000);
    e.follow(true, 1600, tol); // a frame's coarse step ahead: stay on the engine's clock
    expect(e.position).toBe(1000);
    e.follow(true, 30_000, tol); // a seek
    expect(e.position).toBe(30_000);
    e.follow(true, 0, tol); // the timeline looped
    expect(e.position).toBe(0);
    e.follow(false, 0, tol);
    expect(e.isPlaying).toBe(false);
  });
});

describe("EngineCore — descriptions", () => {
  const a = () => track("a", seqOf({ 0: { note: 60 } }), PAD);

  it("changes nothing when the same description comes again", () => {
    const once = new EngineCore(SR);
    once.describe(desc(a()));
    once.play(0);
    const ref = run(once, 4 * STEP);
    const again = new EngineCore(SR);
    again.describe(desc(a()));
    again.play(0);
    const out: number[] = [];
    for (let i = 0; i < 4; i++) {
      again.describe(desc(a())); // every frame, as the graph does
      out.push(...run(again, STEP));
    }
    expect(out).toEqual([...ref]);
  });

  it("releases a removed track's voices and drops it", () => {
    const e = new EngineCore(SR);
    e.describe(desc(a(), track("b", seqOf({ 0: { note: 67 } }), PAD)));
    e.play(0);
    run(e, STEP);
    expect(e.activeVoices()).toBe(2);
    e.describe(desc(a()));
    run(e, SR / 2);
    expect(e.activeVoices()).toBe(1);
  });

  it("lets go of a held note the edited pattern no longer has", () => {
    const e = new EngineCore(SR);
    e.describe(desc(a()));
    e.play(0);
    run(e, STEP);
    e.describe(desc({ ...a(), seq: seqOf({ 8: { note: 72 } }) }));
    run(e, SR / 4);
    expect(e.activeVoices()).toBe(0);
  });

  it("keeps a held note the edited pattern still holds", () => {
    const e = new EngineCore(SR);
    e.describe(desc(a()));
    e.play(0);
    run(e, STEP);
    e.describe(desc({ ...a(), seq: seqOf({ 0: { note: 60 }, 8: { note: 72 } }) }));
    run(e, SR / 4);
    expect(e.activeVoices()).toBe(1);
  });

  it("mutes and pans through the mixer", () => {
    const e = new EngineCore(SR);
    e.describe(desc({ ...a(), mute: true }));
    e.play(0);
    expect(run(e, 2 * STEP).every((x) => x === 0)).toBe(true);
  });
});
