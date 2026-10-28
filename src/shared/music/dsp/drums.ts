/**
 * Synthesised drum kit — no samples, a few lines of DSP per sound. Notes follow the General MIDI drum map, so a
 * pattern written for any drum machine lands on the right sound:
 *
 *   36 kick · 38 snare · 39 clap · 42 closed hat · 46 open hat · 45 low tom · 50 high tom
 *
 * Each sound is one voice, struck again on its next hit (as on an 808). A closed hat chokes the open one. Pure like
 * fm.ts: the noise is a seeded generator stepped per sample, so the output does not depend on block sizes.
 */

export const DRUM_NOTES = { kick: 36, snare: 38, clap: 39, hat: 42, openhat: 46, tomlow: 45, tomhigh: 50 } as const;
export type DrumName = keyof typeof DRUM_NOTES;
const SOUNDS = Object.keys(DRUM_NOTES) as DrumName[];
const BY_NOTE = new Map<number, number>(SOUNDS.map((s, i) => [DRUM_NOTES[s], i]));

export interface DrumSettings {
  /** Semitones: retunes every pitched part of the kit. */
  tune: number;
  /** Scales every decay: 0.5 = tight, 2 = long. */
  decay: number;
}

/** −80 dB: a hit is over once its envelope is below this. */
const SILENT = 1e-4;

export class DrumSynth {
  /** One voice per sound. */
  readonly voices = SOUNDS.length;
  private readonly sr: number;
  private t = new Float64Array(SOUNDS.length);
  private vel = new Float64Array(SOUNDS.length);
  private active = new Uint8Array(SOUNDS.length);
  private phase = new Float64Array(SOUNDS.length);
  /** One-pole filter states for the noises. */
  private lp = new Float64Array(SOUNDS.length);
  private hp = new Float64Array(SOUNDS.length);
  private noise = 0x9e3779b9;
  private tune = 1;
  private decay = 1;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
  }

  setSettings(s: DrumSettings): void {
    this.tune = Math.pow(2, Math.max(-24, Math.min(24, s.tune)) / 12);
    this.decay = Math.max(0.1, Math.min(4, s.decay));
  }

  noteOn(note: number, velocity: number): number {
    const i = BY_NOTE.get(Math.round(note));
    if (i === undefined) return -1;
    this.t[i] = 0;
    this.vel[i] = Math.min(1, Math.max(0, velocity));
    this.active[i] = 1;
    this.phase[i] = 0;
    if (SOUNDS[i] === "hat") this.active[SOUNDS.indexOf("openhat")] = 0; // choke
    return i;
  }

  /** Drums are one-shots: a note-off changes nothing. */
  noteOff(_note: number): void {}

  allNotesOff(): void {}

  activeVoices(): number {
    let n = 0;
    for (let i = 0; i < SOUNDS.length; i++) n += this.active[i];
    return n;
  }

  /** White noise in [−1, 1), xorshift32. */
  private white(): number {
    let x = this.noise;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.noise = x >>> 0;
    return this.noise / 2147483648 - 1;
  }

  /** Adds the kit's mono output to out[start .. start + n). */
  render(out: Float32Array, start: number, n: number): void {
    const sr = this.sr;
    const tune = this.tune;
    const dk = this.decay;
    const hpCoef = 1 - Math.exp((-2 * Math.PI * 7000) / sr);
    const bpCoef = 1 - Math.exp((-2 * Math.PI * 1800) / sr);
    for (let s = start; s < start + n; s++) {
      // One noise sample per output sample, whatever is playing: the sequence does not depend on which drums hit.
      const w = this.white();
      let mix = 0;
      for (let i = 0; i < SOUNDS.length; i++) {
        if (!this.active[i]) continue;
        const sec = this.t[i] / sr;
        let x = 0;
        let env = 0;
        switch (SOUNDS[i]) {
          case "kick": {
            const f = (48 + 110 * Math.exp(-sec / 0.035)) * tune;
            this.phase[i] += f / sr;
            env = Math.exp(-sec / (0.32 * dk));
            const click = w * Math.exp(-sec / 0.0015) * 0.3;
            // A touch of drive keeps the kick audible on small speakers.
            x = Math.tanh(1.6 * Math.sin(2 * Math.PI * this.phase[i])) * env + click;
            break;
          }
          case "snare": {
            this.phase[i] += (185 * tune) / sr;
            this.hp[i] += (w - this.hp[i]) * bpCoef;
            const noise = w - this.hp[i];
            env = Math.exp(-sec / (0.16 * dk));
            x = Math.sin(2 * Math.PI * this.phase[i]) * Math.exp(-sec / (0.06 * dk)) * 0.5 + noise * env * 0.7;
            break;
          }
          case "clap": {
            this.lp[i] += (w - this.lp[i]) * bpCoef;
            const band = w - this.lp[i];
            // Three quick bursts, then the tail.
            const burst = Math.max(Math.exp(-sec / 0.005), Math.exp(-Math.max(0, sec - 0.011) / 0.005) * (sec >= 0.011 ? 1 : 0), Math.exp(-Math.max(0, sec - 0.022) / 0.005) * (sec >= 0.022 ? 1 : 0));
            env = Math.max(burst, Math.exp(-sec / (0.13 * dk)) * 0.6);
            x = band * env * 0.9;
            break;
          }
          case "hat":
          case "openhat": {
            this.hp[i] += (w - this.hp[i]) * hpCoef;
            const hiss = w - this.hp[i];
            env = Math.exp(-sec / ((SOUNDS[i] === "hat" ? 0.035 : 0.28) * dk));
            x = hiss * env * 0.5;
            break;
          }
          case "tomlow":
          case "tomhigh": {
            const base = SOUNDS[i] === "tomlow" ? 95 : 150;
            this.phase[i] += (base * tune * (1 + 0.5 * Math.exp(-sec / 0.05))) / sr;
            env = Math.exp(-sec / (0.28 * dk));
            x = Math.sin(2 * Math.PI * this.phase[i]) * env * 0.8;
            break;
          }
        }
        if (this.phase[i] >= 1) this.phase[i] -= Math.floor(this.phase[i]);
        mix += x * this.vel[i];
        this.t[i]++;
        if (env < SILENT && this.t[i] > sr * 0.03) {
          this.active[i] = 0;
          this.lp[i] = this.hp[i] = 0;
        }
      }
      out[s] += mix;
    }
  }
}

/** A drum name (kick, snare…) for a GM note, or null. */
export function drumNameOf(note: number): DrumName | null {
  const i = BY_NOTE.get(Math.round(note));
  return i === undefined ? null : SOUNDS[i];
}
