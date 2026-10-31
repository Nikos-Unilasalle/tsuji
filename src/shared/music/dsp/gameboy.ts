/**
 * A Game Boy sound channel, LSDJ-style — no samples, the DMG's own four voices:
 *
 *   pulse  a square with a duty of 12.5, 25, 50 or 75 % (and, as channel 1, a frequency sweep)
 *   wave   32 steps of 4 bits, drawn as 32 hex digits (0 = bottom, F = top)
 *   noise  a 15-bit (or 7-bit, metallic) LFSR clocked at one of the DMG's rates
 *   kit    drums the way Game Boy music makes them: a kick and toms from a pulse swept down, snare, clap and hats
 *          from the noise — on the General MIDI drum notes, like the Drum Kit (36 kick, 38 snare, 42 hat…)
 *
 * What makes it sound like the machine: the 4-bit volume envelope (0–15, a step up or down every n / 64 s), the
 * sweep (every n / 128 s the 11-bit frequency register moves by itself >> shift), pitches rounded to that 11-bit
 * register, a wave that is not smoothed and the DMG's high-pass on the output. Two liberties: a note-off fades over
 * `release` (the hardware cuts, which clicks), and a track may have more than one voice, for chords.
 *
 * Pure like fm.ts: per-sample, no allocation in render, the output does not depend on block sizes.
 */
import { midiToHz } from "./fm";

export type GbChannel = "pulse" | "wave" | "noise" | "kit";

export interface GbPatch {
  channel: GbChannel;
  /** Pulse: 0.125, 0.25, 0.5 or 0.75. */
  duty: number;
  /** Wave: 32 hex digits, one 4-bit step each. */
  wave: string;
  /** Noise: the 7-bit LFSR (a metallic, pitched buzz) instead of the 15-bit one (hiss). */
  noiseShort: boolean;
  /** The volume a note starts at, 0–15 (scaled by its velocity). */
  volume: number;
  /** −7 … 7: the volume moves a step every |n| / 64 s, down (−) or up (+); 0 holds it. */
  envelope: number;
  /** Pulse: −7 … 7: every |n| / 128 s the pitch moves down (−) or up (+) by the register >> sweepShift; 0, none. */
  sweep: number;
  /** 1–7: how big each sweep step is (1 is an octave and more, 7 a hair). */
  sweepShift: number;
  /** Seconds a note-off takes to fade (0.005: the hardware's cut, without the click). */
  release: number;
}

export const DEFAULT_GB_PATCH: GbPatch = {
  channel: "pulse",
  duty: 0.5,
  wave: "0123456789ABCDEFFEDCBA9876543210",
  noiseShort: false,
  volume: 13,
  envelope: 0,
  sweep: 0,
  sweepShift: 3,
  release: 0.005,
};

export const GB_DUTIES = [0.125, 0.25, 0.5, 0.75] as const;

/** A wave's 32 hex digits → 32 levels in −1 … 1 (a digit missing or unreadable is 8, the middle). */
export function parseWave(text: string): Float32Array {
  const out = new Float32Array(32);
  const digits = String(text ?? "").replace(/[^0-9a-f]/gi, "");
  for (let i = 0; i < 32; i++) {
    const d = i < digits.length ? parseInt(digits[i], 16) : 8;
    out[i] = d / 7.5 - 1;
  }
  return out;
}

/** The DMG's noise clocks: 524288 Hz / r / 2^(s+1), r = 0.5 for 0 and 1–7, s = 0–13. Sorted. */
const NOISE_RATES: number[] = (() => {
  const set = new Set<number>();
  for (let r = 0; r < 8; r++) for (let s = 0; s < 14; s++) set.add(524288 / (r === 0 ? 0.5 : r) / 2 ** (s + 1));
  return [...set].sort((a, b) => a - b);
})();

/** A note on the noise channel → the DMG rate nearest its pitch × 32 (as LSDJ's noise keys go up the rates). */
export function noiseRateFor(note: number): number {
  const want = Math.log(midiToHz(note) * 32);
  let best = NOISE_RATES[0];
  for (const r of NOISE_RATES) if (Math.abs(Math.log(r) - want) < Math.abs(Math.log(best) - want)) best = r;
  return best;
}

/** The DMG's 11-bit frequency register for a pitch: pulse = 131072 / (2048 − x) Hz, wave half that. */
const REGISTER_BASE = { pulse: 131072, wave: 65536 } as const;

/** The frequency the register makes of `hz` (rounded to it), or `hz` itself below what the register reaches. */
export function registerHz(hz: number, channel: "pulse" | "wave"): number {
  const base = REGISTER_BASE[channel];
  const x = Math.round(2048 - base / hz);
  return x < 0 || x > 2047 ? hz : base / (2048 - x);
}

/** The kit: each drum note's sound, a patch and the note it plays. */
const KIT: Record<number, { patch: Partial<GbPatch>; note: number }> = {
  36: { patch: { channel: "pulse", duty: 0.5, volume: 15, envelope: -2, sweep: -1, sweepShift: 1 }, note: 72 }, // kick
  38: { patch: { channel: "noise", volume: 14, envelope: -2 }, note: 84 }, // snare
  39: { patch: { channel: "noise", volume: 12, envelope: -1 }, note: 79 }, // clap
  42: { patch: { channel: "noise", volume: 9, envelope: -1 }, note: 110 }, // hat
  46: { patch: { channel: "noise", volume: 9, envelope: -4 }, note: 108 }, // open hat
  45: { patch: { channel: "pulse", duty: 0.5, volume: 15, envelope: -3, sweep: -2, sweepShift: 2 }, note: 62 }, // low tom
  50: { patch: { channel: "pulse", duty: 0.5, volume: 15, envelope: -3, sweep: -2, sweepShift: 2 }, note: 69 }, // high tom
};
const OPEN_HAT = 46;
const CLOSED_HAT = 42;

/** Each voice at full volume (15) peaks here: a few of them sit with an FM voice. */
const AMP = 0.45;
/** The DMG's output capacitor: a high-pass a little under 40 Hz, which also takes a thin duty's offset away. */
const HP_HZ = 35;
const CHUNK = 128;
/** The noise LFSR is stepped at most this many times a sample (its fastest rates are averaged). */
const MAX_LFSR_STEPS = 64;

const LEVELS = 15;

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

export class GbSynth {
  readonly voices: number;
  private readonly sr: number;
  private patch: GbPatch = DEFAULT_GB_PATCH;
  private wave = parseWave(DEFAULT_GB_PATCH.wave);
  /** Per voice: the patch it plays (the track's, or a kit sound's). */
  private vPatch: GbPatch[];
  private note: Float64Array;
  private pitch: Float64Array;
  private pitchStep: Float64Array;
  private phase: Float64Array;
  private inc: Float64Array;
  private vol: Int32Array;
  private envLeft: Float64Array;
  private xreg: Int32Array;
  private sweepLeft: Float64Array;
  /** The sweep has moved the register: the pitch is the register's now, a glide no longer retunes it. */
  private swept: Uint8Array;
  private lfsr: Int32Array;
  private noiseAcc: Float64Array;
  private noiseInc: Float64Array;
  private noiseOut: Float64Array;
  private gain: Float64Array;
  private relStep: Float64Array;
  private velocity: Float64Array;
  private active: Uint8Array;
  private held: Uint8Array;
  private age: Float64Array;
  private counter = 0;
  private buf = new Float32Array(CHUNK);
  private hpX = 0;
  private hpY = 0;
  private hpA: number;

  constructor(voices: number, sampleRate: number) {
    this.voices = Math.max(1, Math.round(voices));
    this.sr = sampleRate;
    const n = this.voices;
    this.vPatch = Array.from({ length: n }, () => DEFAULT_GB_PATCH);
    this.note = new Float64Array(n);
    this.pitch = new Float64Array(n);
    this.pitchStep = new Float64Array(n);
    this.phase = new Float64Array(n);
    this.inc = new Float64Array(n);
    this.vol = new Int32Array(n);
    this.envLeft = new Float64Array(n);
    this.xreg = new Int32Array(n);
    this.sweepLeft = new Float64Array(n);
    this.swept = new Uint8Array(n);
    this.lfsr = new Int32Array(n);
    this.noiseAcc = new Float64Array(n);
    this.noiseInc = new Float64Array(n);
    this.noiseOut = new Float64Array(n);
    this.gain = new Float64Array(n);
    this.relStep = new Float64Array(n);
    this.velocity = new Float64Array(n);
    this.active = new Uint8Array(n);
    this.held = new Uint8Array(n);
    this.age = new Float64Array(n);
    this.hpA = Math.exp((-2 * Math.PI * HP_HZ) / sampleRate);
  }

  setPatch(patch: GbPatch): void {
    this.patch = patch;
    this.wave = parseWave(patch.wave);
    // Voices keep the patch they started with until their next note, except a track's own (not a kit sound's).
    if (patch.channel !== "kit") for (let v = 0; v < this.voices; v++) if (this.vPatch[v].channel !== "kit") this.vPatch[v] = patch;
  }

  noteOn(note: number, velocity: number, glide?: { from: number; seconds: number }): number {
    let patch = this.patch;
    let played = note;
    if (patch.channel === "kit") {
      const k = Math.round(note);
      const kit = KIT[k];
      if (!kit) return -1;
      patch = { ...DEFAULT_GB_PATCH, release: this.patch.release, ...kit.patch };
      played = kit.note;
      glide = undefined;
      // A closed hat chokes the open one.
      if (k === CLOSED_HAT) for (let v = 0; v < this.voices; v++) if (this.active[v] && this.note[v] === OPEN_HAT) this.active[v] = 0;
    }
    const age = ++this.counter;
    let pick = -1;
    for (let v = 0; v < this.voices && pick < 0; v++) if (this.active[v] && this.note[v] === note) pick = v;
    for (let v = 0; v < this.voices && pick < 0; v++) if (!this.active[v]) pick = v;
    if (pick < 0) {
      // The oldest released voice, else the oldest one.
      for (const wantReleased of [true, false]) {
        for (let v = 0; v < this.voices; v++) {
          if (wantReleased && this.held[v]) continue;
          if (pick < 0 || this.age[v] < this.age[pick]) pick = v;
        }
        if (pick >= 0) break;
      }
    }
    this.start(pick, note, played, patch, Math.min(1, Math.max(0, velocity)), glide);
    this.age[pick] = age;
    return pick;
  }

  noteOff(note: number): void {
    for (let v = 0; v < this.voices; v++) if (this.active[v] && this.held[v] && this.note[v] === note) this.release(v);
  }

  allNotesOff(): void {
    for (let v = 0; v < this.voices; v++) if (this.active[v] && this.held[v]) this.release(v);
  }

  activeVoices(): number {
    let n = 0;
    for (let v = 0; v < this.voices; v++) n += this.active[v];
    return n;
  }

  private release(v: number): void {
    this.held[v] = 0;
    this.relStep[v] = 1 / Math.max(1, this.vPatch[v].release * this.sr);
  }

  /** A note on voice v: a free voice starts from phase 0; a voice playing on keeps its phase (no click), like the DMG's. */
  private start(v: number, note: number, played: number, patch: GbPatch, vel: number, glide?: { from: number; seconds: number }): void {
    if (!this.active[v]) this.phase[v] = 0;
    this.vPatch[v] = patch;
    this.note[v] = note;
    this.velocity[v] = vel;
    this.active[v] = 1;
    this.held[v] = 1;
    this.gain[v] = 1;
    this.relStep[v] = 0;
    const samples = glide ? glide.seconds * this.sr : 0;
    if (glide && samples >= 1 && glide.from !== note) {
      this.pitch[v] = glide.from + (played - note);
      this.pitchStep[v] = (note - glide.from) / samples;
    } else {
      this.pitch[v] = played;
      this.pitchStep[v] = 0;
    }
    const vol = Math.round(Math.min(LEVELS, Math.max(0, patch.volume)) * vel);
    this.vol[v] = vel > 0 ? Math.max(1, vol) : 0;
    this.envLeft[v] = this.envPeriod(patch);
    this.sweepLeft[v] = this.sweepPeriod(patch);
    this.swept[v] = 0;
    this.lfsr[v] = 0x7fff;
    this.noiseAcc[v] = 0;
    this.noiseOut[v] = 1;
    this.noiseInc[v] = noiseRateFor(played) / this.sr;
    const ch = patch.channel === "wave" ? "wave" : "pulse";
    this.xreg[v] = Math.round(2048 - REGISTER_BASE[ch] / midiToHz(this.pitch[v]));
    this.retune(v);
  }

  private envPeriod(p: GbPatch): number {
    const n = Math.min(7, Math.abs(Math.round(p.envelope)));
    return n === 0 ? Infinity : (n / 64) * this.sr;
  }

  private sweepPeriod(p: GbPatch): number {
    const n = Math.min(7, Math.abs(Math.round(p.sweep)));
    return n === 0 || p.channel !== "pulse" ? Infinity : (n / 128) * this.sr;
  }

  /** The phase increment from the pitch — or from the register, once a sweep has moved it. */
  private retune(v: number, fromRegister = false): void {
    const p = this.vPatch[v];
    if (p.channel === "noise") return;
    const ch = p.channel === "wave" ? "wave" : "pulse";
    const hz = fromRegister ? REGISTER_BASE[ch] / (2048 - this.xreg[v]) : registerHz(midiToHz(this.pitch[v]), ch);
    this.inc[v] = hz / this.sr;
  }

  render(out: Float32Array, start: number, n: number): void {
    for (let off = 0; off < n; off += CHUNK) this.renderChunk(out, start + off, Math.min(CHUNK, n - off));
  }

  private renderChunk(out: Float32Array, s0: number, m: number): void {
    const buf = this.buf;
    buf.fill(0, 0, m);
    for (let v = 0; v < this.voices; v++) {
      if (!this.active[v]) continue;
      const p = this.vPatch[v];
      const ch = p.channel;
      const duty = ch === "pulse" ? Math.min(0.875, Math.max(0.125, p.duty)) : 0.5;
      const up = p.envelope > 0;
      const sweepUp = p.sweep > 0;
      const shift = Math.min(7, Math.max(1, Math.round(p.sweepShift)));
      const short = p.noiseShort;
      const wave = this.wave;
      const envPeriod = this.envPeriod(p);
      const sweepPeriod = this.sweepPeriod(p);
      for (let i = 0; i < m; i++) {
        // Glide.
        if (this.pitchStep[v] !== 0) {
          let q = this.pitch[v] + this.pitchStep[v];
          if ((this.pitchStep[v] > 0 && q >= this.note[v]) || (this.pitchStep[v] < 0 && q <= this.note[v])) {
            q = this.note[v];
            this.pitchStep[v] = 0;
          }
          this.pitch[v] = q;
          if (!this.swept[v]) this.retune(v);
        }
        // Volume envelope.
        if (--this.envLeft[v] <= 0) {
          this.envLeft[v] += envPeriod;
          this.vol[v] = Math.min(LEVELS, Math.max(0, this.vol[v] + (up ? 1 : -1)));
        }
        // Sweep: the register moves by itself >> shift; past 2047 the channel stops, as on the DMG.
        if (--this.sweepLeft[v] <= 0 && this.xreg[v] >= 0) {
          this.sweepLeft[v] += sweepPeriod;
          const x = this.xreg[v];
          const nx = x + (sweepUp ? 1 : -1) * (x >> shift);
          if (nx > 2047) {
            this.vol[v] = 0;
          } else {
            this.xreg[v] = nx;
            this.swept[v] = 1;
            this.retune(v, true);
          }
        }
        let x = 0;
        if (ch === "noise") {
          this.noiseAcc[v] += this.noiseInc[v];
          if (this.noiseAcc[v] >= 1) {
            let steps = Math.floor(this.noiseAcc[v]);
            this.noiseAcc[v] -= steps;
            if (steps > MAX_LFSR_STEPS) steps = MAX_LFSR_STEPS;
            let l = this.lfsr[v];
            let sum = 0;
            for (let k = 0; k < steps; k++) {
              const bit = (l ^ (l >> 1)) & 1;
              l = (l >> 1) | (bit << 14);
              if (short) l = (l & ~(1 << 6)) | (bit << 6);
              sum += l & 1 ? -1 : 1;
            }
            this.lfsr[v] = l;
            this.noiseOut[v] = sum / steps;
          }
          x = this.noiseOut[v];
        } else {
          const dt = this.inc[v];
          let t = this.phase[v] + dt;
          if (t >= 1) t -= Math.floor(t);
          this.phase[v] = t;
          if (ch === "wave") x = wave[Math.min(31, Math.floor(t * 32))];
          else {
            let u = t - duty;
            if (u < 0) u += 1;
            x = (t < duty ? 1 : -1) + blep(t, dt) - blep(u, dt);
          }
        }
        let g = this.gain[v];
        if (this.relStep[v] !== 0) {
          g -= this.relStep[v];
          if (g <= 0) {
            g = 0;
            this.active[v] = 0;
          }
          this.gain[v] = g;
        }
        buf[i] += x * (this.vol[v] / LEVELS) * AMP * g;
        // Faded to nothing: the envelope at 0 going down (or a sweep run out) is the end of the note.
        if (this.vol[v] === 0 && !up) this.active[v] = 0;
        if (!this.active[v]) break;
      }
    }
    // The output capacitor.
    const a = this.hpA;
    let px = this.hpX;
    let py = this.hpY;
    for (let i = 0; i < m; i++) {
      const xi = buf[i];
      py = a * (py + xi - px);
      px = xi;
      out[s0 + i] += py;
    }
    this.hpX = px;
    this.hpY = py;
  }
}

/** A preset: the patch, and how many voices it wants (a swell for chords; everything else, the DMG's one). */
export interface GbPreset {
  patch: GbPatch;
  voices: number;
}

const gb = (p: Partial<GbPatch>, voices = 1): GbPreset => ({ patch: { ...DEFAULT_GB_PATCH, ...p }, voices });

export const GB_PRESETS: Record<string, GbPreset> = {
  "Pulse 50 · Lead": gb({ duty: 0.5, volume: 13 }),
  "Pulse 25 · Lead": gb({ duty: 0.25, volume: 13 }),
  "Pulse 12.5 · Thin": gb({ duty: 0.125, volume: 12 }),
  "Pulse 25 · Pluck": gb({ duty: 0.25, volume: 15, envelope: -2 }),
  "Pulse 50 · Bass": gb({ duty: 0.5, volume: 15 }),
  "Pulse 12.5 · Swell": gb({ duty: 0.125, volume: 2, envelope: 3, release: 0.15 }, 3),
  "Sweep · Laser": gb({ duty: 0.5, volume: 15, envelope: -1, sweep: -1, sweepShift: 3 }),
  "Sweep · Rise": gb({ duty: 0.25, volume: 13, sweep: 2, sweepShift: 5 }),
  "Wave · Bass": gb({ channel: "wave", wave: "0123456789ABCDEFFEDCBA9876543210", volume: 15 }),
  "Wave · Sine": gb({ channel: "wave", wave: "89ACDEEFFFEEDCA98653211000112356", volume: 15 }),
  "Wave · Saw": gb({ channel: "wave", wave: "00112233445566778899AABBCCDDEEFF", volume: 14 }),
  "Wave · Organ": gb({ channel: "wave", wave: "8ADEFFDCBAAAAA988765555543200125", volume: 14 }),
  "Wave · Square": gb({ channel: "wave", wave: "FFFFFFFFFFFFFFFF0000000000000000", volume: 12 }),
  "Noise · Hiss": gb({ channel: "noise", volume: 12, envelope: -2 }),
  "Noise · Metal": gb({ channel: "noise", noiseShort: true, volume: 11, envelope: -3 }),
  "Kit · DMG Drums": gb({ channel: "kit", volume: 15 }, 3),
};

export const GB_PRESET_NAMES = Object.keys(GB_PRESETS);

export function gbPreset(name: unknown): GbPreset {
  return GB_PRESETS[String(name)] ?? GB_PRESETS["Pulse 50 · Lead"];
}
