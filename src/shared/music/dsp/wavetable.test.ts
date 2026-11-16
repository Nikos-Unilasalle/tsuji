import { describe, expect, it } from "vitest";
import { WAVETABLE_PRESETS, WavetableSynth, sampleWavetable } from "./wavetable";

const SR = 48_000;

function render(synth: WavetableSynth, samples: number, block = 128): Float32Array {
  const out = new Float32Array(samples);
  for (let s = 0; s < samples; s += block) synth.render(out, s, Math.min(block, samples - s));
  return out;
}

describe("sampleWavetable", () => {
  it("interpolates smoothly and stays bounded across all tables and positions", () => {
    const tables = ["analog", "formant", "spectral", "sub_crush"] as const;
    for (const t of tables) {
      for (let pos = 0; pos <= 1; pos += 0.25) {
        for (let ph = 0; ph < 1; ph += 0.1) {
          const s = sampleWavetable(t, pos, ph);
          expect(Number.isFinite(s)).toBe(true);
          expect(Math.abs(s)).toBeLessThanOrEqual(1.05);
        }
      }
    }
  });
});

describe("WavetableSynth", () => {
  it("renders finite and bounded sound for all presets", () => {
    for (const [name, patch] of Object.entries(WAVETABLE_PRESETS)) {
      const synth = new WavetableSynth(4, SR);
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
    const synth = new WavetableSynth(2, SR);
    synth.setPatch({ ...WAVETABLE_PRESETS["Deep Sub"], release: 0.01 });
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
    const s1 = new WavetableSynth(4, SR);
    const s2 = new WavetableSynth(4, SR);
    s1.setPatch(WAVETABLE_PRESETS["Shrub Saw"]);
    s2.setPatch(WAVETABLE_PRESETS["Shrub Saw"]);

    s1.noteOn(48, 0.8);
    s2.noteOn(48, 0.8);

    const r1 = render(s1, 1000, 1000);
    const r2 = render(s2, 1000, 100);

    for (let i = 0; i < 1000; i++) {
      expect(Math.abs(r1[i] - r2[i])).toBeLessThan(1e-5);
    }
  });

  it("handles voice stealing gracefully without clicks or NaNs", () => {
    const synth = new WavetableSynth(1, SR); // Mono
    synth.setPatch(WAVETABLE_PRESETS["Reese Bass"]);

    synth.noteOn(36, 1);
    render(synth, 256);

    // Steal with a new note
    synth.noteOn(48, 1);
    const out = render(synth, 512);

    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      if (i > 0) {
        expect(Math.abs(out[i] - out[i - 1])).toBeLessThan(0.5); // No massive click
      }
    }
  });
});
