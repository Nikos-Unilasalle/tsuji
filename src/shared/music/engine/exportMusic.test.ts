import { afterEach, describe, expect, it } from "vitest";
import { beginExportAudioCapture, endExportAudioCaptureWithMusic, recordMusicFrame, setExportAudioFrame } from "../../audio/exportAudioCapture";
import { FmPatch } from "../dsp/fm";
import { Cell, Sequence } from "../seq/sequencer";
import { EngineCore } from "./core";
import { MusicDescription } from "./description";
import { MusicFrame, renderExportMusic, renderMusicFrames } from "./exportMusic";

const SR = 48_000;
const op = (level: number) => ({ ratio: 1, detune: 0, level, velocitySens: 0, attack: 0, decay: 1, sustain: 1, release: 0.05 });
const SINE: FmPatch = { algorithm: 1, feedback: 0, ops: [op(0.5), op(0), op(0), op(0)] };

function seqOf(cells: Record<number, Cell>, length = 16): Sequence {
  return { clock: { bpm: 120, swing: 0, stepsPerBeat: 4 }, pattern: { length, steps: Array.from({ length }, (_, i) => cells[i] ?? null) } };
}

const desc = (seq: Sequence): MusicDescription => ({ tracks: [{ id: "t", kind: "fm", voices: 8, patch: SINE, seq, level: 1, pan: -1, mute: false }], master: 1 });

/** What Music Out records over an export of `n` frames, the playhead at `songTime(f)`. */
function frames(d: MusicDescription, n: number, fps: number, songTime = (f: number) => f / fps): MusicFrame[] {
  return Array.from({ length: n }, (_, f) => ({ frame: f, desc: d, songTime: songTime(f), playing: songTime(f) >= 0 }));
}

/** The same song played straight through the engine, no frames. */
function direct(d: MusicDescription, seconds: number): Float32Array {
  const e = new EngineCore(SR);
  e.describe(d);
  e.play(0);
  const l = new Float32Array(Math.ceil(seconds * SR));
  const r = new Float32Array(l.length);
  for (let s = 0; s < l.length; s += 128) e.render(l, r, s, Math.min(128, l.length - s));
  return l;
}

const busy = () => seqOf({ 0: { note: 60, chord: "maj7" }, 3: { note: 67, fx: { type: "RTG", value: 3 } }, 6: { note: "off" }, 9: { note: 64, fx: { type: "GLD", value: 8 } } });

describe("renderMusicFrames", () => {
  it("is the song the engine plays, sample for sample, at 30 fps", () => {
    const d = desc(busy());
    const [l] = renderMusicFrames(frames(d, 90, 30), 90, 30, SR);
    expect([...l]).toEqual([...direct(d, 3)]);
  });

  it("does not drift at a frame rate that does not divide the sample rate", () => {
    const fps = 30000 / 1001; // 29.97: frames of 1601.6 samples
    const d = desc(busy());
    const n = 300;
    const [l] = renderMusicFrames(frames(d, n, fps), n, fps, SR);
    expect([...l]).toEqual([...direct(d, n / fps)]);
  });

  it("strikes a note on its sample", () => {
    const [l] = renderMusicFrames(frames(desc(seqOf({ 4: { note: 69 } })), 30, 30), 30, 30, SR);
    expect(l.findIndex((x) => x !== 0)).toBe(24_000); // step 4 at 120 BPM
  });

  it("stays silent before Music Out's start frame", () => {
    const start = 12; // the song starts 12 frames into the export
    const [l] = renderMusicFrames(frames(desc(seqOf({ 0: { note: 69 } })), 30, 30, (f) => (f - start) / 30), 30, 30, SR);
    expect(l.findIndex((x) => x !== 0)).toBe((start * SR) / 30);
  });

  it("jumps with a timeline that loops inside the export", () => {
    // A 1 s timeline exported for 2 s: the song starts over at frame 30.
    // A 2 s pattern, C then E then G: played straight, G sounds at 1 s; looped, C comes back there.
    const d = desc(seqOf({ 0: { note: 60 }, 4: { note: 64 }, 8: { note: 67 } }));
    const looped = renderMusicFrames(frames(d, 60, 30, (f) => (f % 30) / 30), 60, 30, SR)[0];
    const straight = renderMusicFrames(frames(d, 60, 30), 60, 30, SR)[0];
    expect([...looped.subarray(0, SR)]).toEqual([...straight.subarray(0, SR)]);
    const crossings = (x: Float32Array) => x.reduce((n, v, i) => n + (i > 0 && x[i - 1] < 0 && v >= 0 ? 1 : 0), 0);
    // Over the 0.25 s after the loop: C4 (262 Hz) when looped, G4 (392 Hz) straight.
    const window = (x: Float32Array) => x.subarray(SR + 1200, SR + 1200 + SR / 4);
    expect(crossings(window(looped)) / 0.25).toBeCloseTo(261.6, -1);
    expect(crossings(window(straight)) / 0.25).toBeCloseTo(392, -1);
  });

  it("sums several Music Outs, and gives nothing without one", () => {
    const d = desc(seqOf({ 0: { note: 69 } }));
    const one = renderMusicFrames(frames(d, 30, 30), 30, 30, SR)[0];
    const two = renderExportMusic([frames(d, 30, 30), frames(d, 30, 30)], 30, 30, SR)![0];
    expect(two[1000]).toBeCloseTo(2 * one[1000], 6);
    expect(renderExportMusic([], 30, 30, SR)).toBe(null);
  });
});

describe("the export's capture", () => {
  afterEach(() => endExportAudioCaptureWithMusic(30));

  it("keeps each Music Out's frames, in order, the last word per frame", () => {
    const d = desc(busy());
    beginExportAudioCapture();
    for (const f of [1, 0, 2]) {
      setExportAudioFrame(f);
      recordMusicFrame("out", { desc: d, songTime: f / 30, playing: true });
    }
    setExportAudioFrame(2);
    recordMusicFrame("out", { desc: d, songTime: 9, playing: false });
    const { music, segments } = endExportAudioCaptureWithMusic(30);
    expect(segments).toEqual([]);
    expect(music).toHaveLength(1);
    expect(music[0].map((m) => [m.frame, m.songTime])).toEqual([
      [0, 0],
      [1, 1 / 30],
      [2, 9],
    ]);
  });

  it("records nothing outside an export", () => {
    recordMusicFrame("out", { desc: desc(busy()), songTime: 0, playing: true });
    expect(endExportAudioCaptureWithMusic(30).music).toEqual([]);
  });
});
