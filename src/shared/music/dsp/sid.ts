/**
 * A Commodore 64 SID voice — the MOS 6581 / 8580, GoatTracker-style — in DSP:
 *
 *   waveforms  triangle, sawtooth, pulse (12-bit width) and noise (the 23-bit LFSR, clocked 16 times a cycle as the
 *              chip's bit 19 does), several at once combined as the chip does (their bits ANDed)
 *   ring / sync  the triangle ring-modulated, or the oscillator hard-synced, by a second oscillator: on the chip that
 *              is the neighbouring voice; here it is the voice's own, at `ringRatio` of its pitch (sync: the voice
 *              runs at `syncRatio` × the note, restarted at the note's)
 *   ADSR       0–15 each, on the chip's own rates (2 ms … 8 s attack, 6 ms … 24 s decay and release), the decay and
 *              release on its piecewise exponential curve
 *   filter     resonant low / band / high-pass (any mix), cutoff 0–2047 and resonance 0–15: the 8580's even curve,
 *              or the 6581's — a curve that bunches at the bottom and a drive before it, the "dirty" one
 *   PWM        the pulse width moving by itself, `pwSpeed` a tick, back and forth between `pwLow` and `pwHigh`
 *
 * Macros (macros.ts), one value a tick — GoatTracker's tables: wave (control bytes in hex: 41 pulse, 21 saw, 11
 * triangle, 81 noise, + 04 ring, + 02 sync; the low bit is the gate — 40 lets the note go; once the note is let go,
 * the macro's gate bits no longer strike it again), arpeggio (semitones; 128 + n plays the absolute note n, as
 * GoatTracker's $81… do), pulse (width 0–4095), cutoff (0–2047) and pitch (cents). A drum is a wave macro: 81 41 40,
 * noise then pulse.
 *
 * Pure like fm.ts: per-sample, no allocation in render, the output does not depend on block sizes.
 */
import { midiToHz } from "./fm";
import { DEFAULT_TICK_RATE, Macro, macroNext, macroRelease, parseMacro } from "./macros";

export type SidModel = "6581" | "8580";

export interface SidPatch {
  /** The control byte's waveform bits: 0x10 triangle, 0x20 saw, 0x40 pulse, 0x80 noise; 0x04 ring, 0x02 sync. */
  waveform: number;
  /** 0–4095 (2048: a square). */
  pulseWidth: number;
  /** PWM: width units a tick, back and forth between pwLow and pwHigh; 0, none. */
  pwSpeed: number;
  pwLow: number;
  pwHigh: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  /** The ring modulator's pitch, × the note's. */
  ringRatio: number;
  /** With sync: the voice's pitch × the note's (above 1), restarted at the note's own. */
  syncRatio: number;
  filter: boolean;
  lowPass: boolean;
  bandPass: boolean;
  highPass: boolean;
  /** 0–2047. */
  cutoff: number;
  /** 0–15. */
  resonance: number;
  model: SidModel;
  /** 0–15: the chip's master volume. */
  volume: number;
  macroWave: string;
  macroArp: string;
  macroPulse: string;
  macroCutoff: string;
  macroPitch: string;
  /** Macro ticks a second: 50 for a PAL C64. */
  tickRate: number;
}

export const DEFAULT_SID_PATCH: SidPatch = {
  waveform: 0x40,
  pulseWidth: 2048,
  pwSpeed: 0,
  pwLow: 256,
  pwHigh: 3840,
  attack: 0,
  decay: 9,
  sustain: 10,
  release: 6,
  ringRatio: 1.5,
  syncRatio: 2,
  filter: false,
  lowPass: true,
  bandPass: false,
  highPass: false,
  cutoff: 1024,
  resonance: 4,
  model: "6581",
  volume: 15,
  macroWave: "",
  macroArp: "",
  macroPulse: "",
  macroCutoff: "",
  macroPitch: "",
  tickRate: 50,
};

const TRI = 0x10;
const SAW = 0x20;
const PULSE = 0x40;
const NOISE = 0x80;
const RING = 0x04;
const SYNC = 0x02;
const GATE = 0x01;

/** The PAL C64's clock, in cycles a second. */
const CLOCK = 985248;
/** Cycles between envelope steps, by rate 0–15 (reSID's table). */
const RATE_CYCLES = [9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251];

/** The decay and release slow down as the level falls: the chip's piecewise exponential. */
function expDivider(level: number): number {
  if (level >= 93) return 1;
  if (level >= 54) return 2;
  if (level >= 26) return 4;
  if (level >= 14) return 8;
  if (level >= 6) return 16;
  return 30;
}

/** The cutoff register (0–2047) → Hz, the model's curve. */
export function sidCutoffHz(cutoff: number, model: SidModel): number {
  const c = Math.min(2047, Math.max(0, cutoff)) / 2047;
  return model === "8580" ? 30 + c * 11970 : 220 * Math.pow(18000 / 220, Math.pow(c, 1.25));
}

const ATTACK = 0;
const DECAY = 1;
const RELEASE = 2;

/** Each voice at full level peaks around here: a few of them sit with the other voices. */
const AMP = 0.38;
const CHUNK = 128;

interface SidMacros {
  wave: Macro | null;
  arp: Macro | null;
  pulse: Macro | null;
  cutoff: Macro | null;
  pitch: Macro | null;
}
const MACRO_KEYS = ["wave", "arp", "pulse", "cutoff", "pitch"] as const;
const N_MACROS = MACRO_KEYS.length;
const parsed = new WeakMap<SidPatch, SidMacros>();
function macrosOf(p: SidPatch): SidMacros {
  let m = parsed.get(p);
  if (!m) {
    m = {
      wave: parseMacro(p.macroWave, true),
      arp: parseMacro(p.macroArp),
      pulse: parseMacro(p.macroPulse),
      cutoff: parseMacro(p.macroCutoff),
      pitch: parseMacro(p.macroPitch),
    };
    parsed.set(p, m);
  }
  return m;
}

function blep(t: number, dt: number): number {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

export class SidSynth {
  readonly voices: number;
  private readonly sr: number;
  private patch: SidPatch = DEFAULT_SID_PATCH;
  private note: Float64Array;
  private pitch: Float64Array;
  private pitchStep: Float64Array;
  private phase: Float64Array;
  private modPhase: Float64Array;
  private inc: Float64Array;
  private modInc: Float64Array;
  private lfsr: Int32Array;
  private noiseOut: Float64Array;
  /** Noise clocks owed: 16 a cycle. */
  private noiseAcc: Float64Array;
  private env: Float64Array;
  private envAcc: Float64Array;
  private stage: Uint8Array;
  private control: Int32Array;
  private pw: Float64Array;
  private pwDir: Int8Array;
  private cutoff: Float64Array;
  private arpOff: Float64Array;
  private centsOff: Float64Array;
  private velocity: Float64Array;
  private tickLeft: Float64Array;
  private mPos: Int32Array;
  private mReleased: Uint8Array;
  private held: Uint8Array;
  private active: Uint8Array;
  private age: Float64Array;
  /** The filter (a TPT state-variable), its states and coefficients. */
  private ic1: Float64Array;
  private ic2: Float64Array;
  private fg: Float64Array;
  private fk: Float64Array;
  private counter = 0;

  constructor(voices: number, sampleRate: number) {
    this.voices = Math.max(1, Math.round(voices));
    this.sr = sampleRate;
    const n = this.voices;
    this.note = new Float64Array(n);
    this.pitch = new Float64Array(n);
    this.pitchStep = new Float64Array(n);
    this.phase = new Float64Array(n);
    this.modPhase = new Float64Array(n);
    this.inc = new Float64Array(n);
    this.modInc = new Float64Array(n);
    this.lfsr = new Int32Array(n);
    this.noiseOut = new Float64Array(n);
    this.noiseAcc = new Float64Array(n);
    this.env = new Float64Array(n);
    this.envAcc = new Float64Array(n);
    this.stage = new Uint8Array(n);
    this.control = new Int32Array(n);
    this.pw = new Float64Array(n);
    this.pwDir = new Int8Array(n);
    this.cutoff = new Float64Array(n);
    this.arpOff = new Float64Array(n);
    this.centsOff = new Float64Array(n);
    this.velocity = new Float64Array(n);
    this.tickLeft = new Float64Array(n);
    this.mPos = new Int32Array(n * N_MACROS);
    this.mReleased = new Uint8Array(n);
    this.held = new Uint8Array(n);
    this.active = new Uint8Array(n);
    this.age = new Float64Array(n);
    this.ic1 = new Float64Array(n);
    this.ic2 = new Float64Array(n);
    this.fg = new Float64Array(n);
    this.fk = new Float64Array(n);
  }

  setPatch(patch: SidPatch): void {
    this.patch = patch;
    const own = !macrosOf(patch).cutoff;
    for (let v = 0; v < this.voices; v++) {
      if (!this.active[v]) continue;
      if (own) this.cutoff[v] = patch.cutoff;
      this.setFilter(v);
    }
  }

  noteOn(note: number, velocity: number, glide?: { from: number; seconds: number }): number {
    const age = ++this.counter;
    let pick = -1;
    for (let v = 0; v < this.voices && pick < 0; v++) if (this.active[v] && this.note[v] === note) pick = v;
    for (let v = 0; v < this.voices && pick < 0; v++) if (!this.active[v]) pick = v;
    if (pick < 0) {
      for (const wantReleased of [true, false]) {
        for (let v = 0; v < this.voices; v++) {
          if (wantReleased && this.held[v]) continue;
          if (pick < 0 || this.age[v] < this.age[pick]) pick = v;
        }
        if (pick >= 0) break;
      }
    }
    this.start(pick, note, Math.min(1, Math.max(0, velocity)), glide);
    this.age[pick] = age;
    return pick;
  }

  noteOff(note: number): void {
    for (let v = 0; v < this.voices; v++) if (this.active[v] && this.held[v] && this.note[v] === note) this.gateOff(v);
  }

  allNotesOff(): void {
    for (let v = 0; v < this.voices; v++) if (this.active[v] && this.held[v]) this.gateOff(v);
  }

  activeVoices(): number {
    let n = 0;
    for (let v = 0; v < this.voices; v++) n += this.active[v];
    return n;
  }

  private gateOff(v: number): void {
    this.held[v] = 0;
    this.mReleased[v] = 1;
    this.stage[v] = RELEASE;
  }

  private start(v: number, note: number, vel: number, glide?: { from: number; seconds: number }): void {
    const p = this.patch;
    if (!this.active[v]) {
      // A free voice starts from silence and phase 0 (the gate, on a voice still sounding, attacks from where it is).
      this.phase[v] = 0;
      this.modPhase[v] = 0;
      this.env[v] = 0;
      this.ic1[v] = this.ic2[v] = 0;
    }
    this.note[v] = note;
    this.velocity[v] = vel;
    this.active[v] = 1;
    this.held[v] = 1;
    this.stage[v] = ATTACK;
    this.envAcc[v] = 0;
    const samples = glide ? glide.seconds * this.sr : 0;
    if (glide && samples >= 1 && glide.from !== note) {
      this.pitch[v] = glide.from;
      this.pitchStep[v] = (note - glide.from) / samples;
    } else {
      this.pitch[v] = note;
      this.pitchStep[v] = 0;
    }
    this.lfsr[v] = 0x7ffff8;
    this.noiseAcc[v] = 0;
    this.noiseOut[v] = 0;
    this.control[v] = (p.waveform & 0xfe) | GATE;
    this.pw[v] = Math.min(4095, Math.max(0, p.pulseWidth));
    this.pwDir[v] = 1;
    this.cutoff[v] = p.cutoff;
    this.arpOff[v] = 0;
    this.centsOff[v] = 0;
    this.mPos.fill(-1, v * N_MACROS, (v + 1) * N_MACROS);
    this.mReleased[v] = 0;
    this.tickLeft[v] = this.sr / Math.max(1, p.tickRate || DEFAULT_TICK_RATE);
    this.tick(v);
    this.retune(v);
    this.setFilter(v);
  }

  private retune(v: number): void {
    const p = this.patch;
    const hz = midiToHz(this.pitch[v] + this.arpOff[v] + this.centsOff[v] / 100);
    const sync = (this.control[v] & SYNC) !== 0;
    this.inc[v] = Math.min(0.49, (sync ? hz * Math.max(1, p.syncRatio) : hz) / this.sr);
    this.modInc[v] = Math.min(0.49, (sync ? hz : hz * Math.max(0.01, p.ringRatio)) / this.sr);
  }

  private setFilter(v: number): void {
    const p = this.patch;
    const fc = Math.min(0.45 * this.sr, sidCutoffHz(this.cutoff[v], p.model));
    const res = Math.min(15, Math.max(0, p.resonance));
    const q = 0.707 + res * (p.model === "8580" ? 0.2 : 0.25);
    this.fg[v] = Math.tan((Math.PI * fc) / this.sr);
    this.fk[v] = 1 / q;
  }

  /** One macro tick: the tables stepped, the PWM moved. */
  private tick(v: number): void {
    const p = this.patch;
    const m = macrosOf(p);
    const held = this.held[v] === 1;
    const released = this.mReleased[v] === 1;
    this.mReleased[v] = 0;
    let retune = false;
    let refilter = false;
    for (let k = 0; k < N_MACROS; k++) {
      const mac = m[MACRO_KEYS[k]];
      if (!mac) continue;
      const i = v * N_MACROS + k;
      if (released) this.mPos[i] = macroRelease(mac, this.mPos[i]) - 1;
      const pos = macroNext(mac, this.mPos[i], held);
      this.mPos[i] = pos;
      const x = mac.values[pos];
      if (k === 0) {
        // The control byte: its gate bit too (a 40 lets the note go, a 41 strikes it again) — while the note is held.
        const gate = (x & GATE) !== 0 && held;
        const was = (this.control[v] & GATE) !== 0;
        this.control[v] = x & 0xff;
        if (gate && !was) this.stage[v] = ATTACK;
        else if (!gate && was) this.stage[v] = RELEASE;
        retune = true;
      } else if (k === 1) {
        // 128 + n: the absolute note n.
        this.arpOff[v] = x >= 128 ? x - 128 - this.note[v] : x;
        retune = true;
      } else if (k === 2) this.pw[v] = Math.min(4095, Math.max(0, x));
      else if (k === 3) {
        this.cutoff[v] = Math.min(2047, Math.max(0, x));
        refilter = true;
      } else {
        this.centsOff[v] = x;
        retune = true;
      }
    }
    if (p.pwSpeed !== 0) {
      const lo = Math.min(p.pwLow, p.pwHigh);
      const hi = Math.max(p.pwLow, p.pwHigh);
      let w = this.pw[v] + this.pwDir[v] * Math.abs(p.pwSpeed);
      if (w >= hi) {
        w = hi;
        this.pwDir[v] = -1;
      } else if (w <= lo) {
        w = lo;
        this.pwDir[v] = 1;
      }
      this.pw[v] = w;
    }
    if (retune) this.retune(v);
    if (refilter) this.setFilter(v);
  }

  render(out: Float32Array, start: number, n: number): void {
    for (let off = 0; off < n; off += CHUNK) this.renderChunk(out, start + off, Math.min(CHUNK, n - off));
  }

  private renderChunk(out: Float32Array, s0: number, m: number): void {
    const p = this.patch;
    const sr = this.sr;
    const tickSamples = sr / Math.max(1, p.tickRate || DEFAULT_TICK_RATE);
    const atkStep = 1 / ((RATE_CYCLES[Math.min(15, Math.max(0, Math.round(p.attack)))] / CLOCK) * sr);
    const decBase = (RATE_CYCLES[Math.min(15, Math.max(0, Math.round(p.decay)))] / CLOCK) * sr;
    const relBase = (RATE_CYCLES[Math.min(15, Math.max(0, Math.round(p.release)))] / CLOCK) * sr;
    const sustainLevel = Math.min(15, Math.max(0, Math.round(p.sustain))) * 17;
    const master = (Math.min(15, Math.max(0, p.volume)) / 15) * AMP;
    const drive = p.model === "6581";
    for (let v = 0; v < this.voices; v++) {
      if (!this.active[v]) continue;
      for (let i = 0; i < m; i++) {
        if (--this.tickLeft[v] <= 0) {
          this.tickLeft[v] += tickSamples;
          this.tick(v);
        }
        if (this.pitchStep[v] !== 0) {
          let q = this.pitch[v] + this.pitchStep[v];
          if ((this.pitchStep[v] > 0 && q >= this.note[v]) || (this.pitchStep[v] < 0 && q <= this.note[v])) {
            q = this.note[v];
            this.pitchStep[v] = 0;
          }
          this.pitch[v] = q;
          this.retune(v);
        }

        // Envelope, on the chip's rates: a step every so many cycles, the decay and release slower as they fall.
        const st = this.stage[v];
        let e = this.env[v];
        if (st === ATTACK) {
          this.envAcc[v] += atkStep;
          while (this.envAcc[v] >= 1) {
            this.envAcc[v] -= 1;
            if (++e >= 255) {
              e = 255;
              this.stage[v] = DECAY;
              this.envAcc[v] = 0;
              break;
            }
          }
        } else {
          const base = st === DECAY ? decBase : relBase;
          const floor = st === DECAY ? sustainLevel : 0;
          if (e > floor) {
            this.envAcc[v] += 1 / (base * expDivider(e));
            while (this.envAcc[v] >= 1 && e > floor) {
              this.envAcc[v] -= 1;
              e--;
            }
          }
        }
        this.env[v] = e;
        // Decayed to a sustain of nothing: the note is over, held or not.
        if (e <= 0 && this.stage[v] !== ATTACK && (this.stage[v] === RELEASE || sustainLevel === 0)) {
          this.active[v] = 0;
          this.ic1[v] = this.ic2[v] = 0;
          break;
        }

        // Oscillators.
        const ctrl = this.control[v];
        const dt = this.inc[v];
        let t = this.phase[v] + dt;
        let mp = this.modPhase[v] + this.modInc[v];
        let wrapped = false;
        if (mp >= 1) {
          mp -= Math.floor(mp);
          wrapped = true;
        }
        if (ctrl & SYNC && wrapped) t = mp * (dt / this.modInc[v]);
        if (t >= 1) t -= Math.floor(t);
        // The noise is clocked 16 times a cycle (the accumulator's bit 19); the fastest averaged.
        this.noiseAcc[v] += dt * 16;
        if (this.noiseAcc[v] >= 1) {
          const steps = Math.min(64, Math.floor(this.noiseAcc[v]));
          this.noiseAcc[v] -= Math.floor(this.noiseAcc[v]);
          let l = this.lfsr[v];
          let sum = 0;
          for (let k = 0; k < steps; k++) {
            const bit = ((l >> 22) ^ (l >> 17)) & 1;
            l = ((l << 1) | bit) & 0x7fffff;
            // The chip's output: eight of the register's bits.
            const b = ((l >> 20) & 1) << 7 | ((l >> 18) & 1) << 6 | ((l >> 14) & 1) << 5 | ((l >> 11) & 1) << 4 | ((l >> 9) & 1) << 3 | ((l >> 5) & 1) << 2 | ((l >> 2) & 1) << 1 | (l & 1);
            sum += b / 127.5 - 1;
          }
          this.lfsr[v] = l;
          this.noiseOut[v] = sum / steps;
        }
        this.phase[v] = t;
        this.modPhase[v] = mp;

        const waves = ctrl & (TRI | SAW | PULSE | NOISE);
        const pwN = this.pw[v] / 4096;
        let x = 0;
        if (waves === TRI || waves === SAW || waves === PULSE || waves === NOISE) {
          if (waves === TRI) {
            x = t < 0.5 ? 4 * t - 1 : 3 - 4 * t;
            if (ctrl & RING && mp >= 0.5) x = -x;
          } else if (waves === SAW) x = 2 * t - 1 - blep(t, dt);
          else if (waves === PULSE) {
            let u = t - pwN;
            if (u < 0) u += 1;
            x = (t >= pwN ? 1 : -1) - blep(t, dt) + blep(u, dt);
          } else x = this.noiseOut[v];
        } else if (waves !== 0) {
          // Combined: the waveforms' 12-bit outputs ANDed, as the chip's DAC sees them.
          let bits = 0xfff;
          if (waves & TRI) {
            let tri = t < 0.5 ? 2 * t : 2 - 2 * t;
            if (ctrl & RING && mp >= 0.5) tri = 1 - tri;
            bits &= Math.round(tri * 4095);
          }
          if (waves & SAW) bits &= Math.round(t * 4095);
          if (waves & PULSE) bits &= t >= pwN ? 0xfff : 0;
          if (waves & NOISE) bits &= Math.round(((this.noiseOut[v] + 1) / 2) * 4095);
          x = bits / 2047.5 - 1;
        }
        x *= (e / 255) * this.velocity[v];

        if (p.filter) {
          const xin = drive ? Math.tanh(1.4 * x) / 1.4 : x;
          const g = this.fg[v];
          const k = this.fk[v];
          const a1 = 1 / (1 + g * (g + k));
          const a2 = g * a1;
          const a3 = g * a2;
          const v3 = xin - this.ic2[v];
          const v1 = a1 * this.ic1[v] + a2 * v3;
          const v2 = this.ic2[v] + a2 * this.ic1[v] + a3 * v3;
          this.ic1[v] = 2 * v1 - this.ic1[v];
          this.ic2[v] = 2 * v2 - this.ic2[v];
          let y = 0;
          if (p.lowPass) y += v2;
          if (p.bandPass) y += v1;
          if (p.highPass) y += xin - k * v1 - v2;
          x = y;
        }
        out[s0 + i] += x * master;
      }
    }
  }
}

/** A preset: the patch, and how many voices it wants (the chip has three; a track's voice is one of them). */
export interface SidPreset {
  patch: SidPatch;
  voices: number;
}

const sid = (p: Partial<SidPatch>, voices = 1): SidPreset => ({ patch: { ...DEFAULT_SID_PATCH, ...p }, voices });

export const SID_PRESETS: Record<string, SidPreset> = {
  "Saw Lead": sid({ waveform: SAW, attack: 0, decay: 9, sustain: 11, release: 6, filter: true, cutoff: 1300, resonance: 6, macroPitch: "0 0 0 0 0 0 0 0 | 0 10 20 10 0 -10 -20 -10" }),
  "Pulse PWM": sid({ waveform: PULSE, pulseWidth: 1024, pwSpeed: 48, pwLow: 400, pwHigh: 3600, attack: 0, decay: 8, sustain: 12, release: 7 }),
  "Hubbard Bass": sid({ waveform: PULSE, pulseWidth: 900, pwSpeed: 24, pwLow: 600, pwHigh: 2400, attack: 0, decay: 6, sustain: 9, release: 3, filter: true, cutoff: 600, resonance: 10, macroCutoff: "1500 1250 1000 850 750 650 600" }),
  "Triangle Flute": sid({ waveform: TRI, attack: 3, decay: 8, sustain: 12, release: 7, macroPitch: "0 0 0 0 0 0 0 0 0 0 | 0 8 15 8 0 -8 -15 -8" }),
  "Arp Chord": sid({ waveform: PULSE, pulseWidth: 1600, pwSpeed: 30, attack: 0, decay: 9, sustain: 10, release: 5, macroArp: "| 0 4 7" }),
  "Minor Arp": sid({ waveform: PULSE, pulseWidth: 1600, pwSpeed: 30, attack: 0, decay: 9, sustain: 10, release: 5, macroArp: "| 0 3 7" }),
  "Ring Bell": sid({ waveform: TRI | RING, ringRatio: 2.41, attack: 0, decay: 10, sustain: 0, release: 10 }),
  "Sync Lead": sid({ waveform: SAW | SYNC, syncRatio: 2.6, attack: 0, decay: 9, sustain: 11, release: 6, filter: true, cutoff: 1500, resonance: 3 }),
  "Filter Sweep Pad": sid({ waveform: SAW | PULSE, pulseWidth: 2048, attack: 8, decay: 8, sustain: 12, release: 10, filter: true, resonance: 9, macroCutoff: "| 300 400 500 600 700 800 900 1000 1100 1000 900 800 700 600 500 400" }, 3),
  "8580 Clean Saw": sid({ waveform: SAW, model: "8580", attack: 1, decay: 9, sustain: 12, release: 7, filter: true, cutoff: 1100, resonance: 5 }),
  "Kick": sid({ waveform: TRI, attack: 0, decay: 8, sustain: 0, release: 0, macroWave: "81 11 11 11 11 10", macroArp: "24 0 -7 -12 -15 -17" }),
  "Snare": sid({ waveform: NOISE, attack: 0, decay: 9, sustain: 0, release: 8, macroWave: "81 41 81 81 81 80", macroArp: "24 10 30 30 30 30" }),
  "Hat": sid({ waveform: NOISE, attack: 0, decay: 5, sustain: 0, release: 4, macroWave: "81 80", macroArp: "48 48" }),
  "Noise Zap": sid({ waveform: NOISE, attack: 0, decay: 10, sustain: 0, release: 8, macroArp: "36 30 24 18 12 6 0" }),
};

export const SID_PRESET_NAMES = Object.keys(SID_PRESETS);

export function sidPreset(name: unknown): SidPreset {
  return SID_PRESETS[String(name)] ?? SID_PRESETS["Saw Lead"];
}
