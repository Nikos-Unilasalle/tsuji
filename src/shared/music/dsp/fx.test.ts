import { describe, expect, it } from "vitest";
import { DubDelay, Reverb } from "./fx";
import { MonoSource, Mixer } from "./mix";

const SR = 48_000;

/** One sample at 1, then silence. */
const impulse = (n: number) => {
  const x = new Float32Array(n);
  x[0] = 1;
  return x;
};

function run(fx: DubDelay | Reverb, send: Float32Array, block = 128): [Float32Array, Float32Array] {
  const l = new Float32Array(send.length);
  const r = new Float32Array(send.length);
  for (let s = 0; s < send.length; s += block) fx.process(send.subarray(s, Math.min(send.length, s + block)), l, r, s, Math.min(block, send.length - s));
  return [l, r];
}

const firstAbove = (x: Float32Array, t: number) => x.findIndex((v) => Math.abs(v) > t);
const energy = (x: Float32Array) => x.reduce((a, v) => a + v * v, 0);

describe("DubDelay", () => {
  it("echoes left after the delay time, then right after twice it, ping-pong", () => {
    const d = new DubDelay(SR);
    d.set({ time: 0.25, feedback: 0.5, tone: 1, level: 1 });
    const [l, r] = run(d, impulse(SR));
    expect(firstAbove(l, 0.5)).toBe(12_000);
    expect(firstAbove(r, 0.5)).toBe(24_000);
    // The next repeat comes back left, quieter and filtered.
    const third = l.subarray(35_000, 40_000);
    expect(energy(third)).toBeGreaterThan(0);
    expect(energy(third)).toBeLessThan(energy(l.subarray(11_000, 13_000)));
  });

  it("dies away with feedback below 1, and stays finite at the most", () => {
    const d = new DubDelay(SR);
    d.set({ time: 0.1, feedback: 0.95, tone: 0.5, level: 1 });
    const [l] = run(d, impulse(SR * 20));
    expect(l.every(Number.isFinite)).toBe(true);
    expect(energy(l.subarray(SR * 18))).toBeLessThan(energy(l.subarray(0, SR)) * 0.01);
  });

  it("gives the same echoes whatever the block size", () => {
    const make = () => {
      const d = new DubDelay(SR);
      d.set({ time: 0.31, feedback: 0.6, tone: 0.3, level: 0.8 });
      return d;
    };
    const send = impulse(SR);
    expect(run(make(), send, 37)).toEqual(run(make(), send, 128));
  });
});

describe("Reverb", () => {
  it("has a tail that decays, longer for a bigger room", () => {
    const tail = (size: number) => {
      const v = new Reverb(SR);
      v.set({ size, damp: 0.5, level: 1 });
      const [l] = run(v, impulse(SR * 3));
      expect(l.every(Number.isFinite)).toBe(true);
      return energy(l.subarray(SR, SR * 3));
    };
    expect(tail(0.9)).toBeGreaterThan(tail(0.2) * 2);
  });
});

describe("Mixer sends", () => {
  const click = (): MonoSource => {
    let done = false;
    return {
      render(out, start) {
        if (!done) out[start] += 1;
        done = true;
      },
    };
  };

  it("sends a channel to the delay by its own amount, and nothing when muted", () => {
    const echoAt = (settings: { mute: boolean; delaySend: number }) => {
      const m = new Mixer(SR);
      m.setFx({ delay: { time: 0.1, feedback: 0, tone: 1, level: 1 }, reverb: { size: 0.5, damp: 0.5, level: 0 } });
      m.addChannel("a", click(), { level: 0.5, pan: 0, ...settings });
      const l = new Float32Array(SR / 2);
      const r = new Float32Array(SR / 2);
      m.render(l, r, 0, l.length);
      return Math.abs(l[4800]);
    };
    expect(echoAt({ mute: false, delaySend: 1 })).toBeGreaterThan(0.3);
    expect(echoAt({ mute: false, delaySend: 0 })).toBe(0);
    expect(echoAt({ mute: true, delaySend: 1 })).toBe(0);
  });
});
