/**
 * Stereo mixer for the music engine: each channel is a mono source (an FmSynth, a drum kit…) with a level, a pan and
 * a mute; the master has a level and a soft clip. Pure, like fm.ts: levels and pans glide per sample, so the output
 * does not depend on how the render is cut into blocks.
 */

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

export class Mixer {
  private readonly smooth: number;
  private channels = new Map<string, Channel>();
  private mono = new Float32Array(CHUNK);
  private masterTarget = 1;
  private masterNow = 1;

  constructor(sampleRate: number) {
    this.smooth = 1 - Math.exp(-4.6 / Math.max(1, SMOOTH_SECONDS * sampleRate));
  }

  /** Adds a channel, or replaces the one with this id. Channels mix in the order they were first added. */
  addChannel(id: string, source: MonoSource, settings: ChannelSettings = { level: 1, pan: 0, mute: false }): void {
    const [l, r] = this.gainsOf(settings);
    this.channels.set(id, { source, targetL: l, targetR: r, nowL: l, nowR: r });
  }

  setChannel(id: string, settings: ChannelSettings): void {
    const ch = this.channels.get(id);
    if (!ch) return;
    [ch.targetL, ch.targetR] = this.gainsOf(settings);
  }

  removeChannel(id: string): void {
    this.channels.delete(id);
  }

  hasChannel(id: string): boolean {
    return this.channels.has(id);
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
    for (const ch of this.channels.values()) {
      this.mono.fill(0, 0, m);
      ch.source.render(this.mono, 0, m);
      let gl = ch.nowL;
      let gr = ch.nowR;
      for (let i = 0; i < m; i++) {
        gl = glide(gl, ch.targetL, sc);
        gr = glide(gr, ch.targetR, sc);
        const x = this.mono[i];
        left[s0 + i] += x * gl;
        right[s0 + i] += x * gr;
      }
      ch.nowL = gl;
      ch.nowR = gr;
    }
    let g = this.masterNow;
    for (let i = 0; i < m; i++) {
      g = glide(g, this.masterTarget, sc);
      left[s0 + i] = softClip(left[s0 + i] * g);
      right[s0 + i] = softClip(right[s0 + i] * g);
    }
    this.masterNow = g;
  }
}
