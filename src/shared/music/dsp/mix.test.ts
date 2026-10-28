import { describe, expect, it } from "vitest";
import { MonoSource, Mixer, panGains, softClip } from "./mix";

const SR = 48_000;

/** A constant signal: easy to read gains off. */
const dc = (value: number): MonoSource => ({
  render(out, start, n) {
    for (let i = start; i < start + n; i++) out[i] += value;
  },
});

function renderStereo(mixer: Mixer, n: number, block = 128): [Float32Array, Float32Array] {
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let s = 0; s < n; s += block) mixer.render(l, r, s, Math.min(block, n - s));
  return [l, r];
}

describe("panGains", () => {
  it("is full on one side and silent on the other at a hard pan, −3 dB each at the centre", () => {
    expect(panGains(1, -1)).toEqual([1, 0]);
    expect(panGains(1, 1)).toEqual([0, 1]);
    const [l, r] = panGains(1, 0);
    expect(l).toBeCloseTo(Math.SQRT1_2, 12);
    expect(r).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it("keeps the power constant across the field", () => {
    for (let p = -1; p <= 1; p += 0.1) {
      const [l, r] = panGains(1, p);
      expect(l * l + r * r).toBeCloseTo(1, 9);
    }
  });
});

describe("softClip", () => {
  it("is transparent below the knee, bounded by 1 and never decreasing above it", () => {
    for (const x of [0, 0.3, -0.7, 0.8]) expect(softClip(x)).toBe(x);
    let prev = softClip(0.8);
    for (let x = 0.81; x < 20; x += 0.37) {
      const y = softClip(x);
      expect(y).toBeGreaterThanOrEqual(prev);
      expect(y).toBeLessThanOrEqual(1);
      expect(softClip(-x)).toBe(-y);
      prev = y;
    }
  });
});

describe("Mixer", () => {
  it("pans and levels each channel and sums them", () => {
    const m = new Mixer(SR);
    m.addChannel("a", dc(0.2), { level: 1, pan: -1, mute: false });
    m.addChannel("b", dc(0.1), { level: 0.5, pan: 1, mute: false });
    const [l, r] = renderStereo(m, 256);
    expect(l[255]).toBeCloseTo(0.2, 6);
    expect(r[255]).toBeCloseTo(0.05, 6);
  });

  it("glides to a new level instead of jumping, and mutes to exact silence", () => {
    const m = new Mixer(SR);
    m.addChannel("a", dc(0.5), { level: 1, pan: -1, mute: false });
    renderStereo(m, 256);
    m.setChannel("a", { level: 1, pan: -1, mute: true });
    const [l] = renderStereo(m, 4800);
    expect(l[0]).toBeGreaterThan(0.45); // not cut at once
    expect(l[600]).toBeLessThan(1e-5); // −100 dB within 12.5 ms
    expect(l[1500]).toBe(0); // and exactly 0 once the glide lands, ~22 ms
  });

  it("removes a channel", () => {
    const m = new Mixer(SR);
    m.addChannel("a", dc(0.5), { level: 1, pan: -1, mute: false });
    m.removeChannel("a");
    expect(m.hasChannel("a")).toBe(false);
    expect(renderStereo(m, 128)[0].every((x) => x === 0)).toBe(true);
  });

  it("renders the same samples whatever the block size", () => {
    const run = (block: number) => {
      const m = new Mixer(SR);
      m.addChannel("a", dc(0.3));
      m.addChannel("b", dc(-0.2), { level: 0.7, pan: 0.4, mute: false });
      const out: number[] = [];
      const go = (n: number) => {
        const [l, r] = renderStereo(m, n, block);
        out.push(...l, ...r);
      };
      go(1000);
      m.setChannel("a", { level: 0.2, pan: -0.8, mute: false });
      m.setMaster(1.5);
      go(1000);
      return out;
    };
    const ref = run(128);
    expect(run(37)).toEqual(ref);
    expect(run(500)).toEqual(ref);
  });
});
