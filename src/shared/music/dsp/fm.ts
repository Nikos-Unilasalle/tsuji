/**
 * 4-operator FM synth — the sample-rate core of the music engine (see docs/music-nodes-mvp.md).
 *
 * Pure arithmetic over typed arrays, no allocation once built, no Web Audio: the same code runs in the AudioWorklet
 * (live), in an offline render (export) and in vitest. Everything that changes over time — envelopes, the smoothing
 * of levels, the fade of a stolen voice — is a per-sample recurrence, so the samples do not depend on how the caller
 * cuts the render into blocks: one call of 1000 samples and ten of 100 give the same output, bit for bit.
 */
import { fmAlgorithm, routingOf } from "./algorithms";
import { glide } from "./mix";

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

export const midiToHz = (note: number) => 440 * Math.pow(2, (note - 69) / 12);

export interface FmOperatorPatch {
  /** Frequency as a multiple of the note's. */
  ratio: number;
  /** Fine tuning, in cents. */
  detune: number;
  /** 0–1. On a carrier the loudness, on a modulator the depth (1 = MOD_DEPTH turns of phase). */
  level: number;
  /** 0–1: how much the note's velocity scales this operator. 0 = not at all. */
  velocitySens: number;
  /** Seconds. */
  attack: number;
  decay: number;
  /** 0–1. */
  sustain: number;
  release: number;
}

export interface FmPatch {
  /** 1–8, see algorithms.ts. */
  algorithm: number;
  /** 0–1: self-modulation of operator 4. */
  feedback: number;
  /** Operators 1–4. */
  ops: [FmOperatorPatch, FmOperatorPatch, FmOperatorPatch, FmOperatorPatch];
}

const OPS = 4;
/** Phase deviation, in turns, of a modulator at level 1 (a modulation index of 4π: bright, not yet noise). */
const MOD_DEPTH = 2;
/** Operator 4's self-modulation at feedback 1, in turns. */
const MAX_FEEDBACK = 0.25;
/** Time a stolen voice takes to fade out before its new note starts. */
const STEAL_SECONDS = 0.002;
/** Levels and feedback reach a new value in this time instead of jumping to it (no zipper noise). */
const SMOOTH_SECONDS = 0.005;
/** An envelope below this (−120 dB) is silent: snapped to 0, so no denormal ever reaches the sample loop. */
const SILENT = 1e-6;
/** Shared, smoothed values are computed for this many samples at a time. */
const CHUNK = 128;

const IDLE = 0;
const ATTACK = 1;
const DECAY = 2;
const RELEASE = 3;

/** A time in seconds → the per-sample coefficient of a one-pole that covers 99 % of the way in that time. */
function coefFor(seconds: number, sampleRate: number): number {
  return 1 - Math.exp(-4.6 / Math.max(1, seconds * sampleRate));
}

export class FmSynth {
  readonly voices: number;
  private readonly sampleRate: number;
  private readonly smooth: number;

  // Patch, per operator.
  private ratioMul = new Float64Array(OPS);
  private levelTarget = new Float64Array(OPS);
  private levelNow = new Float64Array(OPS);
  private velSens = new Float64Array(OPS);
  private attackStep = new Float64Array(OPS);
  private decayCoef = new Float64Array(OPS);
  private sustain = new Float64Array(OPS);
  private releaseCoef = new Float64Array(OPS);
  /** 1 on a carrier, MOD_DEPTH on a modulator: what an operator's output means downstream. */
  private outScale = new Float64Array(OPS);
  private matrix = new Float32Array(16);
  private carrierGain = new Float32Array(OPS);
  private feedbackTarget = 0;
  private feedbackNow = 0;
  private patchSet = false;

  // Per voice.
  private note: Float64Array;
  private velocity: Float64Array;
  private age: Float64Array;
  private active: Uint8Array;
  private held: Uint8Array;
  /** Output gain of the voice: 1, or falling to 0 while it is stolen. */
  private gain: Float64Array;
  private fadeStep: Float64Array;
  /** The note a stolen voice plays once faded out, or −1. */
  private pendingNote: Float64Array;
  private pendingVelocity: Float64Array;
  private pendingHeld: Uint8Array;

  // Per voice × operator, index v * 4 + k.
  private phase: Float64Array;
  private env: Float64Array;
  private stage: Uint8Array;
  /** Operator 4's last two outputs, averaged for its feedback (as the DX does — it keeps high feedback stable). */
  private fbPrev1: Float64Array;
  private fbPrev2: Float64Array;

  private noteCounter = 0;
  // Scratch.
  private levelBuf = new Float64Array(OPS * CHUNK);
  private feedbackBuf = new Float64Array(CHUNK);
  private outs = new Float64Array(OPS);
  private inc = new Float64Array(OPS);
  private velScale = new Float64Array(OPS);

  constructor(voices: number, sampleRate: number) {
    this.voices = voices;
    this.sampleRate = sampleRate;
    this.smooth = coefFor(SMOOTH_SECONDS, sampleRate);
    this.note = new Float64Array(voices);
    this.velocity = new Float64Array(voices);
    this.age = new Float64Array(voices);
    this.active = new Uint8Array(voices);
    this.held = new Uint8Array(voices);
    this.gain = new Float64Array(voices);
    this.fadeStep = new Float64Array(voices);
    this.pendingNote = new Float64Array(voices).fill(-1);
    this.pendingVelocity = new Float64Array(voices);
    this.pendingHeld = new Uint8Array(voices);
    this.phase = new Float64Array(voices * OPS);
    this.env = new Float64Array(voices * OPS);
    this.stage = new Uint8Array(voices * OPS);
    this.fbPrev1 = new Float64Array(voices);
    this.fbPrev2 = new Float64Array(voices);
  }

  /**
   * Takes effect at once for everything but the operator levels and the feedback, which glide there in
   * SMOOTH_SECONDS — except on the first patch, which they start from.
   */
  setPatch(patch: FmPatch): void {
    const sr = this.sampleRate;
    const { matrix, carrierGain } = routingOf(fmAlgorithm(patch.algorithm));
    this.matrix = matrix;
    this.carrierGain = carrierGain;
    for (let k = 0; k < OPS; k++) {
      const op = patch.ops[k];
      this.ratioMul[k] = Math.max(0, op.ratio) * Math.pow(2, op.detune / 1200);
      this.levelTarget[k] = Math.min(1, Math.max(0, op.level));
      this.velSens[k] = Math.min(1, Math.max(0, op.velocitySens));
      this.attackStep[k] = 1 / Math.max(1, op.attack * sr);
      this.decayCoef[k] = coefFor(op.decay, sr);
      this.sustain[k] = Math.min(1, Math.max(0, op.sustain));
      this.releaseCoef[k] = coefFor(op.release, sr);
      this.outScale[k] = carrierGain[k] > 0 ? 1 : MOD_DEPTH;
    }
    this.feedbackTarget = Math.min(1, Math.max(0, patch.feedback)) * MAX_FEEDBACK;
    if (!this.patchSet) {
      this.levelNow.set(this.levelTarget);
      this.feedbackNow = this.feedbackTarget;
      this.patchSet = true;
    }
  }

  /** Plays a note (MIDI number, fractional allowed) and returns the voice it went to. */
  noteOn(note: number, velocity: number): number {
    const vel = Math.min(1, Math.max(0, velocity));
    const age = ++this.noteCounter;
    // The same note again: retrigger its voice from where its envelopes are, no click, no second voice.
    for (let v = 0; v < this.voices; v++) {
      if (this.active[v] && this.pendingNote[v] < 0 && this.note[v] === note) {
        this.velocity[v] = vel;
        this.held[v] = 1;
        this.age[v] = age;
        for (let k = 0; k < OPS; k++) this.stage[v * OPS + k] = ATTACK;
        return v;
      }
    }
    for (let v = 0; v < this.voices; v++) {
      if (!this.active[v]) {
        this.start(v, note, vel, 1);
        this.age[v] = age;
        return v;
      }
    }
    // Steal: the oldest released voice, else the oldest held one; never one already being stolen.
    let pick = -1;
    for (const wantReleased of [true, false]) {
      for (let v = 0; v < this.voices; v++) {
        if (this.pendingNote[v] >= 0 || (wantReleased && this.held[v])) continue;
        if (pick < 0 || this.age[v] < this.age[pick]) pick = v;
      }
      if (pick >= 0) break;
    }
    if (pick < 0) pick = 0; // every voice is mid-steal: take over the first one's pending note
    this.pendingNote[pick] = note;
    this.pendingVelocity[pick] = vel;
    this.pendingHeld[pick] = 1;
    this.fadeStep[pick] = -1 / Math.max(1, STEAL_SECONDS * this.sampleRate);
    this.age[pick] = age;
    return pick;
  }

  noteOff(note: number): void {
    for (let v = 0; v < this.voices; v++) {
      if (!this.active[v]) continue;
      if (this.pendingNote[v] === note) this.pendingHeld[v] = 0;
      else if (this.pendingNote[v] < 0 && this.held[v] && this.note[v] === note) this.release(v);
    }
  }

  allNotesOff(): void {
    for (let v = 0; v < this.voices; v++) {
      if (!this.active[v]) continue;
      this.pendingHeld[v] = 0;
      if (this.pendingNote[v] < 0) this.release(v);
    }
  }

  isActive(voice: number): boolean {
    return this.active[voice] === 1;
  }

  /** The note a voice plays (or will play, once a steal's fade is over), or −1 when the voice is free. */
  voiceNote(voice: number): number {
    if (!this.active[voice]) return -1;
    return this.pendingNote[voice] >= 0 ? this.pendingNote[voice] : this.note[voice];
  }

  activeVoices(): number {
    let n = 0;
    for (let v = 0; v < this.voices; v++) n += this.active[v];
    return n;
  }

  private start(v: number, note: number, vel: number, held: number): void {
    this.note[v] = note;
    this.velocity[v] = vel;
    this.active[v] = 1;
    this.held[v] = 1;
    this.gain[v] = 1;
    this.fadeStep[v] = 0;
    this.pendingNote[v] = -1;
    this.fbPrev1[v] = this.fbPrev2[v] = 0;
    for (let k = 0; k < OPS; k++) {
      // Phases from 0 ("key sync"): a note sounds the same whatever played before it, which a seek re-render needs.
      this.phase[v * OPS + k] = 0;
      this.env[v * OPS + k] = 0;
      this.stage[v * OPS + k] = ATTACK;
    }
    if (!held) this.release(v);
  }

  private release(v: number): void {
    this.held[v] = 0;
    for (let k = 0; k < OPS; k++) if (this.stage[v * OPS + k] !== IDLE) this.stage[v * OPS + k] = RELEASE;
  }

  /** Adds the synth's mono output to out[start .. start + n). */
  render(out: Float32Array, start: number, n: number): void {
    if (!this.patchSet) return;
    for (let off = 0; off < n; off += CHUNK) this.renderChunk(out, start + off, Math.min(CHUNK, n - off));
  }

  private renderChunk(out: Float32Array, s0: number, m: number): void {
    const sc = this.smooth;
    // Shared smoothed values, per sample, before any voice reads them.
    for (let k = 0; k < OPS; k++) {
      let c = this.levelNow[k];
      const t = this.levelTarget[k];
      for (let i = 0; i < m; i++) {
        c = glide(c, t, sc);
        this.levelBuf[k * CHUNK + i] = c;
      }
      this.levelNow[k] = c;
    }
    {
      let c = this.feedbackNow;
      const t = this.feedbackTarget;
      for (let i = 0; i < m; i++) {
        c = glide(c, t, sc);
        this.feedbackBuf[i] = c;
      }
      this.feedbackNow = c;
    }

    const invSr = 1 / this.sampleRate;
    const M = this.matrix;
    const cg = this.carrierGain;
    const outs = this.outs;
    const inc = this.inc;
    const velScale = this.velScale;

    for (let v = 0; v < this.voices; v++) {
      if (!this.active[v]) continue;
      const base = v * OPS;
      let freq = midiToHz(this.note[v]) * invSr;
      for (let k = 0; k < OPS; k++) {
        inc[k] = freq * this.ratioMul[k];
        velScale[k] = (1 - this.velSens[k] + this.velSens[k] * this.velocity[v]) * this.outScale[k];
      }
      let g = this.gain[v];
      let fb1 = this.fbPrev1[v];
      let fb2 = this.fbPrev2[v];

      for (let i = 0; i < m; i++) {
        let mix = 0;
        for (let k = OPS - 1; k >= 0; k--) {
          const idx = base + k;
          // Envelope.
          let e = this.env[idx];
          const st = this.stage[idx];
          if (st === ATTACK) {
            e += this.attackStep[k];
            if (e >= 1) {
              e = 1;
              this.stage[idx] = DECAY;
            }
          } else if (st === DECAY) {
            e += (this.sustain[k] - e) * this.decayCoef[k];
            if (e < SILENT) {
              e = 0;
              this.stage[idx] = IDLE;
            }
          } else if (st === RELEASE) {
            e -= e * this.releaseCoef[k];
            if (e < SILENT) {
              e = 0;
              this.stage[idx] = IDLE;
            }
          }
          this.env[idx] = e;
          // Phase modulation from the operators above, or the feedback on operator 4.
          let mod = 0;
          if (k === OPS - 1) mod = this.feedbackBuf[i] * (fb1 + fb2) * 0.5;
          else for (let j = k + 1; j < OPS; j++) mod += M[k * 4 + j] * outs[j];
          let p = this.phase[idx] + inc[k];
          if (p >= 1) p -= Math.floor(p);
          this.phase[idx] = p;
          const x = e === 0 ? 0 : sineTurns(p + mod) * e * this.levelBuf[k * CHUNK + i] * velScale[k];
          outs[k] = x;
          mix += cg[k] * x;
        }
        fb2 = fb1;
        fb1 = outs[OPS - 1] / this.outScale[OPS - 1];
        out[s0 + i] += mix * g;

        // A stolen voice fades out, then starts its new note on the next sample.
        if (this.fadeStep[v] !== 0) {
          g += this.fadeStep[v];
          if (g <= 0) {
            this.start(v, this.pendingNote[v], this.pendingVelocity[v], this.pendingHeld[v]);
            g = 1;
            fb1 = fb2 = 0;
            freq = midiToHz(this.note[v]) * invSr;
            for (let k = 0; k < OPS; k++) {
              inc[k] = freq * this.ratioMul[k];
              velScale[k] = (1 - this.velSens[k] + this.velSens[k] * this.velocity[v]) * this.outScale[k];
            }
          }
        }
      }
      this.gain[v] = g;
      this.fbPrev1[v] = fb1;
      this.fbPrev2[v] = fb2;

      // Done once every carrier is silent (and no new note is waiting on this voice).
      if (this.pendingNote[v] < 0) {
        let sounding = false;
        for (let k = 0; k < OPS; k++) if (cg[k] > 0 && this.stage[base + k] !== IDLE) sounding = true;
        if (!sounding) {
          this.active[v] = 0;
          this.held[v] = 0;
          for (let k = 0; k < OPS; k++) {
            this.stage[base + k] = IDLE;
            this.env[base + k] = 0;
          }
        }
      }
    }
  }
}

const op = (ratio: number, level: number, attack: number, decay: number, sustain: number, release: number, velocitySens: number): FmOperatorPatch => ({
  ratio,
  detune: 0,
  level,
  velocitySens,
  attack,
  decay,
  sustain,
  release,
});

/** A bright electric piano: two 2-op stacks (algorithm 5), the upper one a bell an octave and a fifth up. */
export const EPIANO_PATCH: FmPatch = {
  algorithm: 5,
  feedback: 0.15,
  ops: [
    op(1, 0.5, 0.002, 1.2, 0.35, 0.5, 1),
    op(1, 0.22, 0.001, 0.6, 0.1, 0.4, 0.6),
    op(3, 0.18, 0.001, 0.4, 0, 0.3, 1),
    op(1, 0.12, 0.001, 0.25, 0, 0.2, 0.5),
  ],
};
