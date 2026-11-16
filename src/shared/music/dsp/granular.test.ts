import { describe, expect, it } from "vitest";
import { GRANULAR_PRESETS, GranularSynth } from "./granular";

const SR = 48_000;

function render(synth: GranularSynth, samples: number, block = 128): Float32Array {
  const out = new Float32Array(samples);
  for (let s = 0; s < samples; s += block) synth.render(out, s, Math.min(block, samples - s));
  return out;
}

describe("GranularSynth", () => {
  it("renders finite and bounded sound for all presets", () => {
    for (const [name, patch] of Object.entries(GRANULAR_PRESETS)) {
      const synth = new GranularSynth(4, SR);
      synth.setPatch(patch);
      synth.noteOn(48, 0.8);
      const out = render(synth, Math.round(SR * 0.5));
      let max = 0;
      for (let i = 0; i < out.length; i++) {
        expect(Number.isFinite(out[i]), `Preset ${name} sample ${i} is finite`).toBe(true);
        if (Math.abs(out[i]) > max) max = Math.abs(out[i]);
      }
      expect(max, `Preset ${name} produced sound`).toBeGreaterThan(0.01);
      expect(max, `Preset ${name} is bounded`).toBeLessThan(3.0);
    }
  });

  it("handles voice allocation, release and falls silent", () => {
    const synth = new GranularSynth(2, SR);
    synth.setPatch({ ...GRANULAR_PRESETS["Abyssal Drone"], release: 0.01 });
    expect(synth.activeVoices()).toBe(0);

    synth.noteOn(36, 1);
    expect(synth.activeVoices()).toBe(1);

    synth.noteOn(48, 1);
    expect(synth.activeVoices()).toBe(2);

    synth.noteOff(36);
    synth.noteOff(48);
    // Render past the release
    render(synth, SR * 0.1);
    expect(synth.activeVoices()).toBe(0);

    const silent = render(synth, 256);
    for (let i = 0; i < silent.length; i++) {
      expect(silent[i]).toBe(0);
    }
  });

  it("is deterministic regardless of block size", () => {
    const s1 = new GranularSynth(2, SR);
    const s2 = new GranularSynth(2, SR);
    s1.setPatch(GRANULAR_PRESETS["Abyssal Drone"]);
    s2.setPatch(GRANULAR_PRESETS["Abyssal Drone"]);

    s1.noteOn(48, 0.8);
    s2.noteOn(48, 0.8);

    const r1 = render(s1, 1000, 1000);
    const r2 = render(s2, 1000, 100);

    for (let i = 0; i < 1000; i++) {
      expect(Math.abs(r1[i] - r2[i])).toBeLessThan(1e-5);
    }
  });

  it("handles voice stealing gracefully without clicks or NaNs", () => {
    const synth = new GranularSynth(1, SR); // Mono
    synth.setPatch(GRANULAR_PRESETS["Solar Wind"]);

    synth.noteOn(36, 1);
    render(synth, 256);

    // Steal with a new note
    synth.noteOn(48, 1);
    const out = render(synth, 512);

    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      if (i > 0) {
        expect(Math.abs(out[i] - out[i - 1])).toBeLessThan(0.5);
      }
    }
  });
});
