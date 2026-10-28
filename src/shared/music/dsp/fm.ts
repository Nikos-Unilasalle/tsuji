/**
 * FM voice bank — the sample-rate core of the music engine (see docs/music-nodes-mvp.md).
 *
 * Pure arithmetic over typed arrays, no allocation once built, no Web Audio: the same code runs in the AudioWorklet
 * (live), in an offline render (export) and in vitest. Two renders from the same state and the same calls give the
 * same samples, bit for bit.
 *
 * Spike shape: the operators form one stack — the last one modulates itself (feedback) and the next, down to
 * operator 0, the carrier. The MVP's 8 algorithms will replace the stack with a modulation table.
 */

const SINE_SIZE = 4096;
/** One extra point so the linear interpolation never wraps. */
const SINE = new Float32Array(SINE_SIZE + 1);
for (let i = 0; i <= SINE_SIZE; i++) SINE[i] = Math.sin((2 * Math.PI * i) / SINE_SIZE);

/** sin(2π·phase) for a phase in turns, any sign or size. */
export function sineTurns(phase: number): number {
  const p = (phase - Math.floor(phase)) * SINE_SIZE;
  const i = p | 0;
  const a = SINE[i];
  return a + (SINE[i + 1] - a) * (p - i);
}

export interface FmOperatorPatch {
  /** Frequency as a multiple of the note's. */
  ratio: number;
  /** Output level, 0–1. On a modulator it is the modulation depth in turns (1 = one full cycle). */
  level: number;
  /** Seconds. */
  attack: number;
  decay: number;
  /** 0–1. */
  sustain: number;
  release: number;
}

export interface FmPatch {
  /** ops[0] is the carrier; ops[ops.length - 1] modulates itself. */
  ops: FmOperatorPatch[];
  /** Self-modulation of the last operator, in turns. */
  feedback: number;
}

const STAGE_IDLE = 0;
const STAGE_ATTACK = 1;
const STAGE_DECAY = 2;
const STAGE_RELEASE = 3;

/** Below this an envelope in release is silent and the voice is skipped (≈ −90 dB). */
const SILENT = 3e-5;

export class FmBank {
  readonly voices: number;
  readonly opCount: number;
  private readonly sampleRate: number;

  // Per operator of the patch.
  private ratio: Float32Array;
  private level: Float32Array;
  private attackStep: Float32Array;
  private decayCoef: Float32Array;
  private sustain: Float32Array;
  private releaseCoef: Float32Array;
  private feedback = 0;

  // Per voice.
  private freq: Float32Array;
  private velocity: Float32Array;
  private active: Uint8Array;
  // Per voice × operator, index v * opCount + k.
  private phase: Float64Array;
  private env: Float32Array;
  private stage: Uint8Array;
  private prevOut: Float32Array;

  constructor(voices: number, opCount: number, sampleRate: number) {
    this.voices = voices;
    this.opCount = opCount;
    this.sampleRate = sampleRate;
    this.ratio = new Float32Array(opCount);
    this.level = new Float32Array(opCount);
    this.attackStep = new Float32Array(opCount);
    this.decayCoef = new Float32Array(opCount);
    this.sustain = new Float32Array(opCount);
    this.releaseCoef = new Float32Array(opCount);
    this.freq = new Float32Array(voices);
    this.velocity = new Float32Array(voices);
    this.active = new Uint8Array(voices);
    this.phase = new Float64Array(voices * opCount);
    this.env = new Float32Array(voices * opCount);
    this.stage = new Uint8Array(voices * opCount);
    this.prevOut = new Float32Array(voices * opCount);
  }

  /** A time constant in seconds → the per-sample coefficient that covers ~99 % of the way in that time. */
  private coef(seconds: number): number {
    return 1 - Math.exp(-4.6 / Math.max(1, seconds * this.sampleRate));
  }

  setPatch(patch: FmPatch): void {
    for (let k = 0; k < this.opCount; k++) {
      const op = patch.ops[k] ?? patch.ops[patch.ops.length - 1];
      this.ratio[k] = op.ratio;
      this.level[k] = op.level;
      this.attackStep[k] = 1 / Math.max(1, op.attack * this.sampleRate);
      this.decayCoef[k] = this.coef(op.decay);
      this.sustain[k] = op.sustain;
      this.releaseCoef[k] = this.coef(op.release);
    }
    this.feedback = patch.feedback;
  }

  noteOn(voice: number, freq: number, velocity: number): void {
    this.freq[voice] = freq;
    this.velocity[voice] = velocity;
    this.active[voice] = 1;
    const base = voice * this.opCount;
    for (let k = 0; k < this.opCount; k++) {
      this.stage[base + k] = STAGE_ATTACK;
      // A retrigger keeps the phase and the envelope where they are: no click.
    }
  }

  noteOff(voice: number): void {
    const base = voice * this.opCount;
    for (let k = 0; k < this.opCount; k++) {
      if (this.stage[base + k] !== STAGE_IDLE) this.stage[base + k] = STAGE_RELEASE;
    }
  }

  isActive(voice: number): boolean {
    return this.active[voice] === 1;
  }

  /** Adds the bank's mono output to out[start .. start + n). */
  render(out: Float32Array, start: number, n: number): void {
    const ops = this.opCount;
    const last = ops - 1;
    const invSr = 1 / this.sampleRate;
    for (let v = 0; v < this.voices; v++) {
      if (!this.active[v]) continue;
      const base = v * ops;
      const f = this.freq[v] * invSr;
      const vel = this.velocity[v];
      for (let s = start, end = start + n; s < end; s++) {
        let mod = this.feedback * this.prevOut[base + last];
        let x = 0;
        for (let k = last; k >= 0; k--) {
          const i = base + k;
          // Envelope.
          let e = this.env[i];
          const st = this.stage[i];
          if (st === STAGE_ATTACK) {
            e += this.attackStep[k];
            if (e >= 1) {
              e = 1;
              this.stage[i] = STAGE_DECAY;
            }
          } else if (st === STAGE_DECAY) {
            e += (this.sustain[k] - e) * this.decayCoef[k];
          } else if (st === STAGE_RELEASE) {
            e -= e * this.releaseCoef[k];
          }
          this.env[i] = e;
          // Oscillator.
          let p = this.phase[i] + f * this.ratio[k];
          if (p >= 1) p -= 1;
          this.phase[i] = p;
          x = sineTurns(p + mod) * e * this.level[k];
          this.prevOut[i] = x;
          mod = x;
        }
        out[s] += x * vel;
      }
      // The carrier decides when the voice is done.
      if (this.stage[base] === STAGE_RELEASE && this.env[base] < SILENT) {
        this.active[v] = 0;
        for (let k = 0; k < ops; k++) {
          this.stage[base + k] = STAGE_IDLE;
          this.env[base + k] = 0;
          this.prevOut[base + k] = 0;
        }
      }
    }
  }
}

/** A bright electric-piano-ish 2-op patch, the spike's test sound. */
export const SPIKE_PATCH: FmPatch = {
  ops: [
    { ratio: 1, level: 0.25, attack: 0.005, decay: 0.8, sustain: 0.4, release: 0.4 },
    { ratio: 2, level: 0.35, attack: 0.001, decay: 0.3, sustain: 0.15, release: 0.3 },
  ],
  feedback: 0.08,
};
