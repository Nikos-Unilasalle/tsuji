import { describe, expect, it } from "vitest";
import { DRUM_NOTES, DrumSynth, drumNameOf } from "./drums";

const SR = 48_000;

function hit(note: number, seconds = 1, settings = { tune: 0, decay: 1 }, block = 128): Float32Array {
  const d = new DrumSynth(SR);
  d.setSettings(settings);
  d.noteOn(note, 1);
  const out = new Float32Array(Math.round(SR * seconds));
  for (let s = 0; s < out.length; s += block) d.render(out, s, Math.min(block, out.length - s));
  return out;
}

const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const energy = (x: Float32Array) => x.reduce((a, v) => a + v * v, 0);

describe("DrumSynth", () => {
  it("sounds every sound of the kit, finite and bounded, and falls silent", () => {
    for (const note of Object.values(DRUM_NOTES)) {
      const d = new DrumSynth(SR);
      d.setSettings({ tune: 0, decay: 1 });
      d.noteOn(note, 1);
      const out = new Float32Array(SR * 3);
      d.render(out, 0, out.length);
      expect(peak(out)).toBeGreaterThan(0.05);
      expect(out.every((x) => Number.isFinite(x) && Math.abs(x) < 2)).toBe(true);
      expect(d.activeVoices()).toBe(0);
    }
  });

  it("ignores notes outside the kit", () => {
    const d = new DrumSynth(SR);
    expect(d.noteOn(61, 1)).toBe(-1);
    expect(d.activeVoices()).toBe(0);
  });

  it("lets the closed hat choke the open one", () => {
    const d = new DrumSynth(SR);
    d.setSettings({ tune: 0, decay: 1 });
    d.noteOn(DRUM_NOTES.openhat, 1);
    d.noteOn(DRUM_NOTES.hat, 1);
    expect(d.activeVoices()).toBe(1);
  });

  it("lengthens with decay and scales with velocity", () => {
    const short = energy(hit(DRUM_NOTES.kick, 1, { tune: 0, decay: 0.5 }));
    const long = energy(hit(DRUM_NOTES.kick, 1, { tune: 0, decay: 2 }));
    expect(long).toBeGreaterThan(short * 2);
    const soft = new DrumSynth(SR);
    soft.setSettings({ tune: 0, decay: 1 });
    soft.noteOn(DRUM_NOTES.snare, 0.5);
    const out = new Float32Array(SR / 4);
    soft.render(out, 0, out.length);
    expect(peak(out) / peak(hit(DRUM_NOTES.snare, 0.25))).toBeCloseTo(0.5, 6);
  });

  it("renders the same samples whatever the block size", () => {
    expect(hit(DRUM_NOTES.clap, 0.5, { tune: 0, decay: 1 }, 37)).toEqual(hit(DRUM_NOTES.clap, 0.5));
  });

  it("names the GM drum notes", () => {
    expect(drumNameOf(36)).toBe("kick");
    expect(drumNameOf(42)).toBe("hat");
    expect(drumNameOf(60)).toBe(null);
  });
});
