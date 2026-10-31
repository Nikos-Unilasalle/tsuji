import { describe, expect, it } from "vitest";
import { MUSIC_GAMEBOY_NODE } from "../../graph/nodes/music";
import { DEFAULT_GB_PATCH, GB_PRESETS, GB_PRESET_NAMES, GbPatch, GbSynth, noiseRateFor, parseWave, registerHz } from "./gameboy";

const SR = 48_000;

function render(patch: Partial<GbPatch>, seconds: number, play: (s: GbSynth) => void, block = 128, voices = 1): Float32Array {
  const s = new GbSynth(voices, SR);
  s.setPatch({ ...DEFAULT_GB_PATCH, ...patch });
  play(s);
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i += block) s.render(out, i, Math.min(block, out.length - i));
  return out;
}

/** Upward zero crossings a second, over [from, to) seconds. */
function hz(x: Float32Array, from: number, to: number): number {
  let n = 0;
  for (let i = Math.round(from * SR) + 1; i < to * SR; i++) if (x[i - 1] < 0 && x[i] >= 0) n++;
  return n / (to - from);
}

const rms = (x: Float32Array, from = 0, to = x.length) => Math.sqrt(x.subarray(from, to).reduce((a, v) => a + v * v, 0) / Math.max(1, to - from));

describe("Game Boy voice", () => {
  it("plays a pulse at the note's pitch, rounded to the 11-bit register", () => {
    expect(registerHz(440, "pulse")).toBeCloseTo(131072 / (2048 - 1750), 6);
    expect(registerHz(40, "pulse")).toBe(40); // below what the register reaches: as asked
    const x = render({ duty: 0.5 }, 1, (s) => s.noteOn(69, 1));
    expect(hz(x, 0.1, 1)).toBeCloseTo(registerHz(440, "pulse"), -1);
  });

  it("plays the wave an octave's register lower, its 32 steps as drawn", () => {
    expect(Array.from(parseWave("0F"))).toEqual([-1, 1, ...Array(30).fill(Math.fround(8 / 7.5 - 1))]);
    const x = render({ channel: "wave", wave: "FFFFFFFFFFFFFFFF0000000000000000" }, 1, (s) => s.noteOn(57, 1));
    expect(hz(x, 0.1, 1)).toBeCloseTo(registerHz(220, "wave"), -1);
  });

  it("fades a note out on its envelope, then frees the voice", () => {
    const s = new GbSynth(1, SR);
    s.setPatch({ ...DEFAULT_GB_PATCH, volume: 15, envelope: -1 });
    s.noteOn(60, 1);
    const out = new Float32Array(SR);
    s.render(out, 0, SR / 8);
    const early = rms(out, 0, SR / 8);
    s.render(out, SR / 8, (SR * 7) / 8);
    // 15 steps of 1/64 s: silent after a quarter of a second.
    expect(rms(out, SR / 2, SR)).toBeLessThan(early * 0.01);
    expect(s.activeVoices()).toBe(0);
  });

  it("sweeps a pulse down by itself", () => {
    const x = render({ volume: 15, sweep: -2, sweepShift: 4 }, 0.6, (s) => s.noteOn(81, 1));
    expect(hz(x, 0.4, 0.6)).toBeLessThan(hz(x, 0, 0.03) * 0.8);
  });

  it("makes noise at a DMG rate, the 7-bit one buzzing", () => {
    expect(noiseRateFor(84)).toBeGreaterThan(noiseRateFor(60));
    const long = render({ channel: "noise" }, 0.2, (s) => s.noteOn(84, 1));
    const short = render({ channel: "noise", noiseShort: true }, 0.2, (s) => s.noteOn(84, 1));
    expect(rms(long)).toBeGreaterThan(0.05);
    expect(rms(short)).toBeGreaterThan(0.05);
    expect(Array.from(long.subarray(4000, 4100))).not.toEqual(Array.from(short.subarray(4000, 4100)));
  });

  it("plays the kit on the drum notes, and nothing on the others", () => {
    for (const note of [36, 38, 39, 42, 45, 46, 50]) expect(rms(render({ channel: "kit" }, 0.1, (s) => s.noteOn(note, 1), 128, 3))).toBeGreaterThan(0.02);
    expect(rms(render({ channel: "kit" }, 0.1, (s) => s.noteOn(60, 1), 128, 3))).toBe(0);
  });

  it("sounds the same whatever the block size", () => {
    const play = (s: GbSynth) => {
      s.noteOn(64, 0.8, { from: 60, seconds: 0.05 });
      s.noteOn(67, 0.6);
    };
    const a = render({ duty: 0.25, envelope: -3, sweep: 1, sweepShift: 6 }, 0.3, play, 128, 2);
    const b = render({ duty: 0.25, envelope: -3, sweep: 1, sweepShift: 6 }, 0.3, play, 37, 2);
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it("fades on a note-off instead of clicking", () => {
    const s = new GbSynth(1, SR);
    s.setPatch({ ...DEFAULT_GB_PATCH, release: 0.01 });
    s.noteOn(60, 1);
    const out = new Float32Array(SR / 10);
    s.render(out, 0, 2400);
    s.noteOff(60);
    s.render(out, 2400, out.length - 2400);
    expect(s.activeVoices()).toBe(0);
    // Only the output capacitor's tail is left.
    expect(rms(out, 3400, out.length)).toBeLessThan(rms(out, 0, 2400) * 0.01);
  });

  it("has presets that all sound, and a node that reads them", () => {
    for (const name of GB_PRESET_NAMES) {
      const { patch, voices } = GB_PRESETS[name];
      const note = patch.channel === "kit" ? 38 : 60;
      expect(rms(render(patch, 0.3, (s) => s.noteOn(note, 1), 128, voices)), name).toBeGreaterThan(0.01);
    }
    const seq = { kind: "sequence", seq: { clock: { bpm: 120, swing: 0, stepsPerBeat: 4 }, pattern: { length: 1, steps: [{ note: 60 }] } } };
    const params = { ...MUSIC_GAMEBOY_NODE.defaultParams, ...MUSIC_GAMEBOY_NODE.upgradeParams!({ preset: "Wave · Saw" }) };
    const track = MUSIC_GAMEBOY_NODE.evaluate({ sequence: seq, duty: 1 }, params, { nodeId: "gb" } as never).track as { kind: string; voices: number; gb: GbPatch };
    expect(track.kind).toBe("gb");
    expect(track.gb.channel).toBe("wave");
    expect(track.gb.wave).toBe(GB_PRESETS["Wave · Saw"].patch.wave);
    expect(track.gb.duty).toBe(0.25);
  });
});
