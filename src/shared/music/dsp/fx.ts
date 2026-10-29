/**
 * The send effects of the music mixer: a dub delay and a reverb (see mix.ts). Each track sends to them by its own
 * amount; the "throws" of dub — one snare, one skank chord into the echo — are a track with a high send playing only
 * the hits to throw.
 *
 * Pure per-sample DSP like the rest of the engine: no Web Audio, the same output whatever the block size.
 */

/** A one-pole low-pass, per sample. */
function onePole(cutoffHz: number, sampleRate: number): number {
  return 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
}

export interface DelaySettings {
  /** Seconds (the engine sets it from the tempo: a dotted eighth by default). */
  time: number;
  /** 0–0.95: how much of each repeat comes round again. */
  feedback: number;
  /** 0–1: the repeats' brightness — dark at 0, open at 1. Each one is darker than the last, as on a tape echo. */
  tone: number;
  /** Return level, 0–1. */
  level: number;
}

/**
 * Dub delay, ping-pong: two lines crossing — what comes in echoes on the left, that echo on the right, and back, each
 * repeat filtered on its way round (low-pass for the tape's darkening, high-pass so the lows do not pile up).
 */
export class DubDelay {
  private readonly sr: number;
  private bufL: Float32Array;
  private bufR: Float32Array;
  private write = 0;
  private lp = 0;
  private hp = 0;
  private lpCoef: number;
  private readonly hpCoef: number;
  private delaySamples = 1;
  private feedback = 0.45;
  private level = 0.6;

  constructor(sampleRate: number, maxSeconds = 2.5) {
    this.sr = sampleRate;
    const len = Math.ceil(maxSeconds * sampleRate) + 2;
    this.bufL = new Float32Array(len);
    this.bufR = new Float32Array(len);
    this.lpCoef = onePole(2500, sampleRate);
    this.hpCoef = onePole(180, sampleRate);
  }

  set(s: DelaySettings): void {
    this.delaySamples = Math.min(this.bufL.length - 2, Math.max(1, Math.round(s.time * this.sr)));
    this.feedback = Math.min(0.95, Math.max(0, s.feedback));
    this.level = Math.min(1.5, Math.max(0, s.level));
    this.lpCoef = onePole(600 + 7000 * Math.min(1, Math.max(0, s.tone)), this.sr);
  }

  /** Adds the echoes of `send[0..n)` into left/right[start..start+n). */
  process(send: Float32Array, left: Float32Array, right: Float32Array, start: number, n: number): void {
    const len = this.bufL.length;
    for (let i = 0; i < n; i++) {
      let r = this.write - this.delaySamples;
      if (r < 0) r += len;
      const outL = this.bufL[r];
      const outR = this.bufR[r];
      // The right line's repeat, darker and thinner, goes back round into the left line.
      this.lp += (outR - this.lp) * this.lpCoef;
      this.hp += (this.lp - this.hp) * this.hpCoef;
      this.bufL[this.write] = send[i] + (this.lp - this.hp) * this.feedback;
      this.bufR[this.write] = outL;
      this.write = this.write + 1 === len ? 0 : this.write + 1;
      left[start + i] += outL * this.level;
      right[start + i] += outR * this.level;
    }
  }
}

export interface ReverbSettings {
  /** 0–1: the room, from a small spring to a hall. */
  size: number;
  /** 0–1: how much the highs die faster than the lows. */
  damp: number;
  /** Return level, 0–1. */
  level: number;
}

const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];
const STEREO_SPREAD = 23;

class Comb {
  private buf: Float32Array;
  private i = 0;
  private store = 0;
  constructor(size: number) {
    this.buf = new Float32Array(size);
  }
  tick(x: number, feedback: number, damp: number): number {
    const y = this.buf[this.i];
    this.store = y * (1 - damp) + this.store * damp;
    this.buf[this.i] = x + this.store * feedback;
    if (++this.i === this.buf.length) this.i = 0;
    return y;
  }
}

class Allpass {
  private buf: Float32Array;
  private i = 0;
  constructor(size: number) {
    this.buf = new Float32Array(size);
  }
  tick(x: number): number {
    const b = this.buf[this.i];
    this.buf[this.i] = x + b * 0.5;
    if (++this.i === this.buf.length) this.i = 0;
    return b - x;
  }
}

/** A Freeverb-style reverb (Jezar's public-domain design): eight combs and four all-passes a side. */
export class Reverb {
  private combsL: Comb[];
  private combsR: Comb[];
  private apsL: Allpass[];
  private apsR: Allpass[];
  private feedback = 0.84;
  private damp = 0.3;
  private level = 0.3;

  constructor(sampleRate: number) {
    const k = sampleRate / 44_100;
    this.combsL = COMBS.map((c) => new Comb(Math.round(c * k)));
    this.combsR = COMBS.map((c) => new Comb(Math.round((c + STEREO_SPREAD) * k)));
    this.apsL = ALLPASSES.map((a) => new Allpass(Math.round(a * k)));
    this.apsR = ALLPASSES.map((a) => new Allpass(Math.round((a + STEREO_SPREAD) * k)));
  }

  set(s: ReverbSettings): void {
    this.feedback = 0.7 + 0.28 * Math.min(1, Math.max(0, s.size));
    this.damp = 0.4 * Math.min(1, Math.max(0, s.damp));
    this.level = Math.min(1.5, Math.max(0, s.level));
  }

  /** Adds the reverb of `send[0..n)` into left/right[start..start+n). */
  process(send: Float32Array, left: Float32Array, right: Float32Array, start: number, n: number): void {
    const fb = this.feedback;
    const damp = this.damp;
    for (let i = 0; i < n; i++) {
      const x = send[i] * 0.015;
      let l = 0;
      let r = 0;
      for (let c = 0; c < this.combsL.length; c++) {
        l += this.combsL[c].tick(x, fb, damp);
        r += this.combsR[c].tick(x, fb, damp);
      }
      for (let a = 0; a < this.apsL.length; a++) {
        l = this.apsL[a].tick(l);
        r = this.apsR[a].tick(r);
      }
      left[start + i] += l * this.level;
      right[start + i] += r * this.level;
    }
  }
}
