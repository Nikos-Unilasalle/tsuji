import { describe, expect, it } from "vitest";
import { MUSIC_SID_NODE } from "../../graph/nodes/music";
import { DEFAULT_SID_PATCH, SID_PRESETS, SID_PRESET_NAMES, SidPatch, SidSynth, sidCutoffHz } from "./sid";

const SR = 48_000;

function render(patch: Partial<SidPatch>, seconds: number, play: (s: SidSynth) => void, block = 128, voices = 1, offAt?: number): Float32Array {
  const s = new SidSynth(voices, SR);
  s.setPatch({ ...DEFAULT_SID_PATCH, ...patch });
  play(s);
  const out = new Float32Array(Math.round(seconds * SR));
  const off = offAt === undefined ? Infinity : Math.round(offAt * SR);
  for (let i = 0; i < out.length; i += block) {
    if (i <= off && off < i + block) s.allNotesOff();
    s.render(out, i, Math.min(block, out.length - i));
  }
  return out;
}

const rms = (x: Float32Array, from = 0, to = x.length) => Math.sqrt(x.subarray(Math.round(from), Math.round(to)).reduce((a, v) => a + v * v, 0) / Math.max(1, to - from));
/** How bright: the energy of the sample-to-sample changes over the energy. */
const brightness = (x: Float32Array, from: number, to: number) => {
  let d = 0;
  for (let i = from + 1; i < to; i++) d += (x[i] - x[i - 1]) ** 2;
  return Math.sqrt(d / (to - from)) / Math.max(1e-9, rms(x, from, to));
};
function hz(x: Float32Array, from: number, to: number): number {
  let n = 0;
  for (let i = Math.round(from * SR) + 1; i < to * SR; i++) if (x[i - 1] < 0 && x[i] >= 0) n++;
  return n / (to - from);
}

describe("SID voice", () => {
  it("plays a sawtooth at the note's pitch", () => {
    const x = render({ waveform: 0x20, attack: 0, sustain: 15 }, 1, (s) => s.noteOn(57, 1));
    expect(hz(x, 0.1, 1)).toBeCloseTo(220, -1);
  });

  it("attacks and decays on the chip's rates", () => {
    // Attack 5: 220 cycles a step × 255 ≈ 57 ms to the top.
    const x = render({ waveform: 0x10, attack: 5, decay: 4, sustain: 4 }, 1, (s) => s.noteOn(60, 1));
    const early = rms(x, 0, 0.01 * SR);
    const top = rms(x, 0.05 * SR, 0.07 * SR);
    const held = rms(x, 0.8 * SR, SR);
    expect(early).toBeLessThan(top * 0.4);
    // Down to the sustain (4 of 15) and held there.
    expect(held / top).toBeGreaterThan(0.15);
    expect(held / top).toBeLessThan(0.4);
  });

  it("releases, then frees the voice", () => {
    const s = new SidSynth(1, SR);
    s.setPatch({ ...DEFAULT_SID_PATCH, waveform: 0x20, release: 2 });
    s.noteOn(60, 1);
    const out = new Float32Array(SR);
    s.render(out, 0, SR / 4);
    s.noteOff(60);
    s.render(out, SR / 4, (SR * 3) / 4);
    expect(s.activeVoices()).toBe(0);
  });

  it("filters: a low cutoff darkens, the 6581 differently from the 8580", () => {
    const open = render({ waveform: 0x20, sustain: 15 }, 0.3, (s) => s.noteOn(48, 1));
    const low = render({ waveform: 0x20, sustain: 15, filter: true, cutoff: 200 }, 0.3, (s) => s.noteOn(48, 1));
    expect(brightness(low, 4800, 14400)).toBeLessThan(brightness(open, 4800, 14400) * 0.5);
    expect(sidCutoffHz(1024, "6581")).not.toBeCloseTo(sidCutoffHz(1024, "8580"), -2);
    expect(sidCutoffHz(0, "8580")).toBeLessThan(sidCutoffHz(2047, "8580"));
  });

  it("combines waveforms, ring-modulates and syncs", () => {
    const tri = render({ waveform: 0x10, sustain: 15 }, 0.2, (s) => s.noteOn(60, 1));
    const ring = render({ waveform: 0x14, sustain: 15, ringRatio: 2.41 }, 0.2, (s) => s.noteOn(60, 1));
    const sync = render({ waveform: 0x22, sustain: 15, syncRatio: 2.6 }, 0.2, (s) => s.noteOn(60, 1));
    const both = render({ waveform: 0x30, sustain: 15 }, 0.2, (s) => s.noteOn(60, 1));
    for (const x of [ring, sync, both]) expect(rms(x)).toBeGreaterThan(0.02);
    expect(Array.from(ring.subarray(2000, 2100))).not.toEqual(Array.from(tri.subarray(2000, 2100)));
    // Synced, the voice still repeats at the note's pitch.
    expect(hz(sync, 0.05, 0.2)).toBeGreaterThan(200);
  });

  it("moves the pulse width by itself (PWM)", () => {
    const x = render({ waveform: 0x40, sustain: 15, pulseWidth: 400, pwSpeed: 200, pwLow: 400, pwHigh: 3600 }, 0.5, (s) => s.noteOn(60, 1));
    // The share of time high changes as the width sweeps.
    const high = (from: number, to: number) => x.subarray(from, to).filter((v) => v > 0).length / (to - from);
    expect(Math.abs(high(0, 2400) - high(12000, 14400))).toBeGreaterThan(0.2);
  });

  it("plays a drum from its wave macro, and its gate-off ends it", () => {
    const { patch } = SID_PRESETS.Kick;
    const s = new SidSynth(1, SR);
    s.setPatch(patch);
    s.noteOn(48, 1);
    const out = new Float32Array(SR);
    s.render(out, 0, SR);
    expect(rms(out, 0, 4800)).toBeGreaterThan(0.02);
    expect(s.activeVoices()).toBe(0);
  });

  it("sounds the same whatever the block size", () => {
    const patch = { waveform: 0x40, pwSpeed: 64, filter: true, cutoff: 700, resonance: 8, macroArp: "| 0 4 7", macroCutoff: "| 400 800 1200" };
    const play = (s: SidSynth) => {
      s.noteOn(60, 0.9, { from: 55, seconds: 0.05 });
      s.noteOn(64, 0.7);
    };
    const a = render(patch, 0.3, play, 128, 2);
    const b = render(patch, 0.3, play, 37, 2);
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it("has presets that all sound, and a node that reads them", () => {
    for (const name of SID_PRESET_NAMES) {
      const { patch, voices } = SID_PRESETS[name];
      const x = render(patch, 0.4, (s) => s.noteOn(48, 1), 128, voices);
      expect(rms(x), name).toBeGreaterThan(0.005);
      let finite = true;
      for (const v of x) if (!Number.isFinite(v) || Math.abs(v) > 2) finite = false;
      expect(finite, name).toBe(true);
    }
    const seq = { kind: "sequence", seq: { clock: { bpm: 120, swing: 0, stepsPerBeat: 4 }, pattern: { length: 1, steps: [{ note: 60 }] } } };
    const params = { ...MUSIC_SID_NODE.defaultParams, ...MUSIC_SID_NODE.upgradeParams!({ preset: "Ring Bell" }) };
    const track = MUSIC_SID_NODE.evaluate({ sequence: seq, cutoff: 300 }, params, { nodeId: "sid" } as never).track as { kind: string; sid: SidPatch };
    expect(track.kind).toBe("sid");
    expect(track.sid.waveform).toBe(0x14);
    expect(track.sid.cutoff).toBe(300);
    expect(track.sid.ringRatio).toBeCloseTo(2.41);
  });
});
