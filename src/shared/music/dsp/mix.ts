/**
 * Stereo mixer for the music engine: each channel is a mono source (an FmSynth, a drum kit…) with a level, a pan, a
 * mute and two sends — to the dub delay and to the reverb (fx.ts), whose returns come back into the mix; the master
 * has a level and a soft clip. Pure, like fm.ts: levels, pans and sends glide per sample, so the output does not
 * depend on how the render is cut into blocks.
 */
import { DelaySettings, DubDelay, Reverb, ReverbSettings } from "./fx";

export interface MonoSource {
  /** Adds its output to out[start .. start + n). */
  render(out: Float32Array, start: number, n: number): void;
}

export interface ChannelSettings {
  /** 0–1 (more is allowed, up to 2). */
  level: number;
  /** −1 (left) to 1 (right). */
  pan: number;
  mute: boolean;
  /** 0–1: how much goes to the dub delay, after the level (a muted channel sends nothing). */
  delaySend?: number;
  /** 0–1: how much goes to the reverb, after the level. */
  reverbSend?: number;
}

export interface MixerFx {
  delay: DelaySettings;
  reverb: ReverbSettings;
}

const CHUNK = 128;
const SMOOTH_SECONDS = 0.005;

/**
 * One sample of a one-pole glide, landing exactly on the target once within 1e-9 of it. Per sample, never per block:
 * that keeps the output independent of where the caller cuts its blocks.
 */
export function glide(now: number, target: number, coef: number): number {
  const next = now + (target - now) * coef;
  return Math.abs(target - next) < 1e-9 ? target : next;
}

interface Channel {
  source: MonoSource;
  targetL: number;
  targetR: number;
  nowL: number;
  nowR: number;
  targetDelay: number;
  targetReverb: number;
  nowDelay: number;
  nowReverb: number;
  /** Metering since the last takeMeters(): the loudest post-fader sample, and the sum of squares over `count` samples. */
  peak: number;
  sumSq: number;
  count: number;
}

/** A channel's (or one side of the master's) level since the last reading: linear peak and RMS. */
export interface MeterReading {
  peak: number;
  rms: number;
}

export interface MixerMeters {
  channels: Record<string, MeterReading>;
  /** After the master level and the soft clip. */
  left: MeterReading;
  right: MeterReading;
  /** Samples the master pushed past ±1 before the soft clip bent them: the console's CLIP lamp. */
  clipped: number;
}

/** Constant-power pan: the centre is −3 dB on each side, a hard pan full on one side and silent on the other. */
export function panGains(level: number, pan: number): [number, number] {
  const a = ((Math.min(1, Math.max(-1, pan)) + 1) * Math.PI) / 4;
  // cos(π/2) is 6e-17, not 0: a hard pan must leave the other side truly silent.
  const l = a >= Math.PI / 2 - 1e-12 ? 0 : Math.cos(a);
  const r = a <= 1e-12 ? 0 : Math.sin(a);
  return [level * l, level * r];
}

const KNEE = 0.8;

/** Transparent below ±0.8, then bends smoothly (same slope at the knee) towards ±1 — never clips hard. */
export function softClip(x: number): number {
  const a = Math.abs(x);
  if (a <= KNEE) return x;
  const y = KNEE + (1 - KNEE) * Math.tanh((a - KNEE) / (1 - KNEE));
  return x < 0 ? -y : y;
}

const sendOf = (v: number | undefined) => Math.min(1, Math.max(0, v ?? 0));

export class Mixer {
  private readonly smooth: number;
  private channels = new Map<string, Channel>();
  private mono = new Float32Array(CHUNK);
  private masterTarget = 1;
  private masterNow = 1;
  private delay: DubDelay;
  private reverb: Reverb;
  private delayBus = new Float32Array(CHUNK);
  private reverbBus = new Float32Array(CHUNK);
  private master = { peakL: 0, peakR: 0, sumL: 0, sumR: 0, count: 0, clipped: 0 };

  constructor(sampleRate: number) {
    this.smooth = 1 - Math.exp(-4.6 / Math.max(1, SMOOTH_SECONDS * sampleRate));
    this.delay = new DubDelay(sampleRate);
    this.reverb = new Reverb(sampleRate);
    this.setFx({ delay: { time: 0.5, feedback: 0.45, tone: 0.5, level: 0.6 }, reverb: { size: 0.6, damp: 0.5, level: 0.35 } });
  }

  setFx(fx: MixerFx): void {
    this.delay.set(fx.delay);
    this.reverb.set(fx.reverb);
  }

  /** Adds a channel, or replaces the one with this id. Channels mix in the order they were first added. */
  addChannel(id: string, source: MonoSource, settings: ChannelSettings = { level: 1, pan: 0, mute: false }): void {
    const [l, r] = this.gainsOf(settings);
    const d = sendOf(settings.delaySend);
    const v = sendOf(settings.reverbSend);
    this.channels.set(id, { source, targetL: l, targetR: r, nowL: l, nowR: r, targetDelay: d, targetReverb: v, nowDelay: d, nowReverb: v, peak: 0, sumSq: 0, count: 0 });
  }

  setChannel(id: string, settings: ChannelSettings): void {
    const ch = this.channels.get(id);
    if (!ch) return;
    [ch.targetL, ch.targetR] = this.gainsOf(settings);
    ch.targetDelay = sendOf(settings.delaySend);
    ch.targetReverb = sendOf(settings.reverbSend);
  }

  removeChannel(id: string): void {
    this.channels.delete(id);
  }

  hasChannel(id: string): boolean {
    return this.channels.has(id);
  }

  /**
   * What each channel and the master played since the last call (then starts over): for the Mixing Console's meters.
   * Channels are metered post-fader and pan-independent (constant power), so a muted channel reads silence.
   */
  takeMeters(): MixerMeters {
    const channels: Record<string, MeterReading> = {};
    for (const [id, ch] of this.channels) {
      channels[id] = { peak: ch.peak, rms: ch.count > 0 ? Math.sqrt(ch.sumSq / ch.count) : 0 };
      ch.peak = 0;
      ch.sumSq = 0;
      ch.count = 0;
    }
    const m = this.master;
    const n = Math.max(1, m.count);
    const out: MixerMeters = { channels, left: { peak: m.peakL, rms: Math.sqrt(m.sumL / n) }, right: { peak: m.peakR, rms: Math.sqrt(m.sumR / n) }, clipped: m.clipped };
    this.master = { peakL: 0, peakR: 0, sumL: 0, sumR: 0, count: 0, clipped: 0 };
    return out;
  }

  setMaster(level: number): void {
    this.masterTarget = Math.min(2, Math.max(0, level));
  }

  private gainsOf(s: ChannelSettings): [number, number] {
    return s.mute ? [0, 0] : panGains(Math.min(2, Math.max(0, s.level)), s.pan);
  }

  /** Writes (does not add) the mix to left/right[start .. start + n). */
  render(left: Float32Array, right: Float32Array, start: number, n: number): void {
    for (let off = 0; off < n; off += CHUNK) this.renderChunk(left, right, start + off, Math.min(CHUNK, n - off));
  }

  private renderChunk(left: Float32Array, right: Float32Array, s0: number, m: number): void {
    const sc = this.smooth;
    left.fill(0, s0, s0 + m);
    right.fill(0, s0, s0 + m);
    this.delayBus.fill(0, 0, m);
    this.reverbBus.fill(0, 0, m);
    for (const ch of this.channels.values()) {
      this.mono.fill(0, 0, m);
      ch.source.render(this.mono, 0, m);
      let gl = ch.nowL;
      let gr = ch.nowR;
      let gd = ch.nowDelay;
      let gv = ch.nowReverb;
      const sends = gd !== 0 || gv !== 0 || ch.targetDelay !== 0 || ch.targetReverb !== 0;
      let peak = 0;
      let sumSq = 0;
      for (let i = 0; i < m; i++) {
        gl = glide(gl, ch.targetL, sc);
        gr = glide(gr, ch.targetR, sc);
        const x = this.mono[i];
        const a = x < 0 ? -x : x;
        if (a > peak) peak = a;
        sumSq += x * x;
        left[s0 + i] += x * gl;
        right[s0 + i] += x * gr;
        if (sends) {
          gd = glide(gd, ch.targetDelay, sc);
          gv = glide(gv, ch.targetReverb, sc);
          // Post-level, constant power: what the channel plays, whatever its pan.
          const post = x * Math.sqrt(gl * gl + gr * gr);
          this.delayBus[i] += post * gd;
          this.reverbBus[i] += post * gv;
        }
      }
      // The meter, post-fader at the chunk's gain (constant power, whatever the pan): cheap, and within a chunk of exact.
      const g2 = gl * gl + gr * gr;
      const gm = Math.sqrt(g2);
      if (peak * gm > ch.peak) ch.peak = peak * gm;
      ch.sumSq += sumSq * g2;
      ch.count += m;
      ch.nowL = gl;
      ch.nowR = gr;
      ch.nowDelay = gd;
      ch.nowReverb = gv;
    }
    // The returns, into the mix before the master.
    this.delay.process(this.delayBus, left, right, s0, m);
    this.reverb.process(this.reverbBus, left, right, s0, m);
    let g = this.masterNow;
    const mt = this.master;
    for (let i = 0; i < m; i++) {
      g = glide(g, this.masterTarget, sc);
      const xl = left[s0 + i] * g;
      const xr = right[s0 + i] * g;
      if (xl > 1 || xl < -1 || xr > 1 || xr < -1) mt.clipped++;
      const l = softClip(xl);
      const r = softClip(xr);
      left[s0 + i] = l;
      right[s0 + i] = r;
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > mt.peakL) mt.peakL = al;
      if (ar > mt.peakR) mt.peakR = ar;
      mt.sumL += l * l;
      mt.sumR += r * r;
    }
    mt.count += m;
    this.masterNow = g;
  }
}
