/**
 * Wavetable synthesizer inspired by Shrub / Serum:
 *
 *   wavetables   pure procedurally generated multi-frame wavetables (64 frames × 2048 samples each),
 *                interpolated in 2D (time & wavetable position) with zero external sample assets:
 *                - "analog": pure sine → warm triangle → rich saw → square / PWM
 *                - "formant": vocal vowel formant morph (/a/ → /o/ → /u/ → /e/ → /i/)
 *                - "spectral": metallic / inharmonic partial morph for cyber timbres and bells
 *                - "sub_crush": pure deep sub → tanh-saturated harmonic foldback for thick bass
 *   sub osc      dedicated phase-locked sub-oscillator (-1 or -2 octaves) for massive, tectonic low-end
 *   unison       1–7 detuned sub-oscillators with phase dispersal for lush, wide supersaws and pads
 *   filter       24 dB / 4-pole style resonant SVF (lowpass, bandpass, highpass) with non-linear analog drive (tanh)
 *   envelope     ADSR with filter envelope modulation depth
 *   glide        legato portamento with pitch ramp
 *
 * Pure arithmetic over typed arrays, deterministic, allocation-free in render loop, compatible with AudioWorklet
 * and offline video export.
 */
import { midiToHz } from "./fm";
import { glide as glideStep } from "./mix";

const FRAME_SIZE = 2048;
const NUM_FRAMES = 16;

export type WavetableType = "analog" | "formant" | "spectral" | "sub_crush";
export type FilterType = "lowpass" | "bandpass" | "highpass" | "off";

export interface WavetablePatch {
  table: WavetableType;
  /** 0–1: position in the wavetable morph. */
  wtPos: number;
  /** 0–1: sub-oscillator level. */
  sub: number;
  /** 1 or 2 octaves down. */
  subOctave: 1 | 2;
  /** 1–7 unison voices per note. */
  unison: number;
  /** Detune spread in cents (0–50). */
  detune: number;
  filterType: FilterType;
  /** Filter cutoff in Hz (20–20000). */
  cutoff: number;
  /** Resonance / Q (0–0.98). */
  resonance: number;
  /** Non-linear analog drive / saturation (0–3). */
  drive: number;
  /** Filter envelope modulation depth (-1 to 1). */
  filterEnv: number;
  /** Seconds. */
  attack: number;
  decay: number;
  /** 0–1. */
  sustain: number;
  release: number;
}

const TABLES: Record<WavetableType, Float32Array> = {
  analog: new Float32Array(NUM_FRAMES * FRAME_SIZE),
  formant: new Float32Array(NUM_FRAMES * FRAME_SIZE),
  spectral: new Float32Array(NUM_FRAMES * FRAME_SIZE),
  sub_crush: new Float32Array(NUM_FRAMES * FRAME_SIZE),
};

// ── Generate Procedural Wavetables ──────────────────────────────────────────

function initWavetables(): void {
  // 1. Analog: Sine (frame 0) -> Triangle (frame 4) -> Saw (frame 8) -> Square (frame 12) -> Pulse 12.5% (frame 15)
  for (let f = 0; f < NUM_FRAMES; f++) {
    const t = f / (NUM_FRAMES - 1);
    const offset = f * FRAME_SIZE;
    for (let i = 0; i < FRAME_SIZE; i++) {
      const phase = i / FRAME_SIZE;
      const sin = Math.sin(2 * Math.PI * phase);
      const tri = phase < 0.25 ? 4 * phase : phase < 0.75 ? 2 - 4 * phase : 4 * phase - 4;
      const saw = 2 * (phase - Math.floor(phase + 0.5));
      const sqr = phase < 0.5 ? 1 : -1;
      const pulseWidth = 0.5 - 0.35 * Math.max(0, (t - 0.75) / 0.25);
      const pulse = phase < pulseWidth ? 1 : -1;

      let s = 0;
      if (t < 0.25) {
        const u = t / 0.25;
        s = (1 - u) * sin + u * tri;
      } else if (t < 0.5) {
        const u = (t - 0.25) / 0.25;
        s = (1 - u) * tri + u * saw;
      } else if (t < 0.75) {
        const u = (t - 0.5) / 0.25;
        s = (1 - u) * saw + u * sqr;
      } else {
        const u = (t - 0.75) / 0.25;
        s = (1 - u) * sqr + u * pulse;
      }
      TABLES.analog[offset + i] = s;
    }
  }

  // 2. Formant: 5 acoustic vowels /a/ -> /o/ -> /u/ -> /e/ -> /i/
  const VOWELS = [
    [800, 1200, 2500], // /a/
    [500, 900, 2500],  // /o/
    [350, 700, 2400],  // /u/
    [500, 1800, 2600], // /e/
    [300, 2300, 3000], // /i/
  ];
  for (let f = 0; f < NUM_FRAMES; f++) {
    const t = f / (NUM_FRAMES - 1);
    const vPos = t * (VOWELS.length - 1);
    const v0 = Math.floor(vPos);
    const v1 = Math.min(VOWELS.length - 1, v0 + 1);
    const vFrac = vPos - v0;
    const f1 = (1 - vFrac) * VOWELS[v0][0] + vFrac * VOWELS[v1][0];
    const f2 = (1 - vFrac) * VOWELS[v0][1] + vFrac * VOWELS[v1][1];
    const f3 = (1 - vFrac) * VOWELS[v0][2] + vFrac * VOWELS[v1][2];

    const offset = f * FRAME_SIZE;
    let max = 0;
    for (let i = 0; i < FRAME_SIZE; i++) {
      const phase = i / FRAME_SIZE;
      let s = 0;
      // Additive series shaped by 3 formant resonance peaks
      for (let h = 1; h <= 32; h++) {
        const freq = h * 130;
        const dist1 = (freq - f1) / 120;
        const dist2 = (freq - f2) / 180;
        const dist3 = (freq - f3) / 250;
        const gain = Math.exp(-dist1 * dist1) * 1.0 + Math.exp(-dist2 * dist2) * 0.7 + Math.exp(-dist3 * dist3) * 0.4;
        s += gain * Math.sin(2 * Math.PI * h * phase);
      }
      TABLES.formant[offset + i] = s;
      if (Math.abs(s) > max) max = Math.abs(s);
    }
    if (max > 1e-4) {
      for (let i = 0; i < FRAME_SIZE; i++) TABLES.formant[offset + i] /= max;
    }
  }

  // 3. Spectral: inharmonic golden ratio partials morphing into high resonant chime
  for (let f = 0; f < NUM_FRAMES; f++) {
    const t = f / (NUM_FRAMES - 1);
    const offset = f * FRAME_SIZE;
    let max = 0;
    for (let i = 0; i < FRAME_SIZE; i++) {
      const phase = i / FRAME_SIZE;
      let s = 0;
      for (let h = 1; h <= 16; h++) {
        const ratio = h + t * Math.sin(h * 1.618);
        const amp = 1 / Math.pow(h, 0.8 + 0.6 * (1 - t));
        s += amp * Math.sin(2 * Math.PI * ratio * phase);
      }
      TABLES.spectral[offset + i] = s;
      if (Math.abs(s) > max) max = Math.abs(s);
    }
    if (max > 1e-4) {
      for (let i = 0; i < FRAME_SIZE; i++) TABLES.spectral[offset + i] /= max;
    }
  }

  // 4. Sub Crush: Pure heavy fundamental progressing to saturated wavefolded bass
  for (let f = 0; f < NUM_FRAMES; f++) {
    const t = f / (NUM_FRAMES - 1);
    const offset = f * FRAME_SIZE;
    const drive = 1 + t * 6;
    for (let i = 0; i < FRAME_SIZE; i++) {
      const phase = i / FRAME_SIZE;
      const clean = Math.sin(2 * Math.PI * phase) + 0.3 * t * Math.sin(4 * Math.PI * phase);
      const shaped = Math.tanh(clean * drive);
      TABLES.sub_crush[offset + i] = shaped;
    }
  }
}

initWavetables();

// ── Wavetable Sample Lookup ────────────────────────────────────────────────

export function sampleWavetable(table: WavetableType, wtPos: number, phase: number): number {
  const data = TABLES[table] ?? TABLES.analog;
  const p = Math.max(0, Math.min(1, wtPos)) * (NUM_FRAMES - 1);
  const f0 = p | 0;
  const f1 = f0 < NUM_FRAMES - 1 ? f0 + 1 : f0;
  const fFrac = p - f0;

  const ph = phase - Math.floor(phase);
  const s = ph * FRAME_SIZE;
  const i0 = s | 0;
  const i1 = (i0 + 1) % FRAME_SIZE;
  const sFrac = s - i0;

  const o0 = f0 * FRAME_SIZE;
  const o1 = f1 * FRAME_SIZE;

  const val0 = data[o0 + i0] + sFrac * (data[o0 + i1] - data[o0 + i0]);
  const val1 = data[o1 + i0] + sFrac * (data[o1 + i1] - data[o1 + i0]);

  return val0 + fFrac * (val1 - val0);
}

// ── Presets ────────────────────────────────────────────────────────────────

export const WAVETABLE_PRESETS: Record<string, WavetablePatch> = {
  "Deep Sub": {
    table: "sub_crush",
    wtPos: 0.2,
    sub: 0.9,
    subOctave: 2,
    unison: 1,
    detune: 0,
    filterType: "lowpass",
    cutoff: 380,
    resonance: 0.2,
    drive: 1.2,
    filterEnv: 0.3,
    attack: 0.005,
    decay: 0.4,
    sustain: 0.85,
    release: 0.15,
  },
  "Shrub Saw": {
    table: "analog",
    wtPos: 0.55,
    sub: 0.4,
    subOctave: 1,
    unison: 5,
    detune: 18,
    filterType: "lowpass",
    cutoff: 2400,
    resonance: 0.3,
    drive: 0.6,
    filterEnv: 0.4,
    attack: 0.005,
    decay: 0.5,
    sustain: 0.7,
    release: 0.25,
  },
  "Reese Bass": {
    table: "analog",
    wtPos: 0.5,
    sub: 0.6,
    subOctave: 1,
    unison: 3,
    detune: 12,
    filterType: "lowpass",
    cutoff: 800,
    resonance: 0.35,
    drive: 1.4,
    filterEnv: 0.2,
    attack: 0.01,
    decay: 0.3,
    sustain: 0.9,
    release: 0.2,
  },
  "Vocal Drone": {
    table: "formant",
    wtPos: 0.4,
    sub: 0.3,
    subOctave: 1,
    unison: 3,
    detune: 8,
    filterType: "bandpass",
    cutoff: 1600,
    resonance: 0.5,
    drive: 0.4,
    filterEnv: 0.1,
    attack: 0.4,
    decay: 1.2,
    sustain: 0.8,
    release: 0.8,
  },
  "Celestial Pad": {
    table: "formant",
    wtPos: 0.7,
    sub: 0.2,
    subOctave: 1,
    unison: 5,
    detune: 22,
    filterType: "lowpass",
    cutoff: 3500,
    resonance: 0.2,
    drive: 0.2,
    filterEnv: 0.2,
    attack: 0.6,
    decay: 1.5,
    sustain: 0.85,
    release: 1.2,
  },
  "Cyber Pluck": {
    table: "spectral",
    wtPos: 0.35,
    sub: 0.2,
    subOctave: 1,
    unison: 2,
    detune: 10,
    filterType: "lowpass",
    cutoff: 4500,
    resonance: 0.4,
    drive: 0.8,
    filterEnv: 0.7,
    attack: 0.002,
    decay: 0.28,
    sustain: 0.0,
    release: 0.2,
  },
};

export const WAVETABLE_PRESET_NAMES = Object.keys(WAVETABLE_PRESETS);

// ── Voice & Synth Engine ───────────────────────────────────────────────────

const IDLE = 0;
const ATTACK = 1;
const DECAY = 2;
const RELEASE = 3;
const STEAL = 4;

const SILENT = 1e-6;
const MAX_UNISON = 7;

interface Voice {
  note: number;
  hz: number;
  targetHz: number;
  glideStep: number;
  velocity: number;
  state: number;
  age: number;
  env: number;
  // Sub-oscillator phase
  subPhase: number;
  // Unison phases
  phases: Float64Array;
  // Filter state (SVF)
  s1: number;
  s2: number;
  // Steal crossfade
  stealGain: number;
  newNote: number;
  newVel: number;
}

function coefFor(seconds: number, sampleRate: number): number {
  return 1 - Math.exp(-4.6 / Math.max(1, seconds * sampleRate));
}

export class WavetableSynth {
  readonly voices: number;
  private readonly sampleRate: number;
  private v: Voice[];
  private patch: WavetablePatch;
  private ageCounter = 0;

  // Smoothed patch params
  private wtPosNow = 0;
  private wtPosTarget = 0;
  private cutoffNow = 1000;
  private cutoffTarget = 1000;
  private driveNow = 0;
  private driveTarget = 0;
  private smoothCoef = 0.01;

  constructor(voices = 8, sampleRate = 48_000) {
    this.voices = Math.max(1, Math.min(16, voices));
    this.sampleRate = sampleRate;
    this.smoothCoef = coefFor(0.005, sampleRate);
    this.patch = { ...WAVETABLE_PRESETS["Deep Sub"] };
    this.wtPosNow = this.patch.wtPos;
    this.wtPosTarget = this.patch.wtPos;
    this.cutoffNow = this.patch.cutoff;
    this.cutoffTarget = this.patch.cutoff;
    this.driveNow = this.patch.drive;
    this.driveTarget = this.patch.drive;

    this.v = Array.from({ length: this.voices }, () => ({
      note: -1,
      hz: 440,
      targetHz: 440,
      glideStep: 0,
      velocity: 0,
      state: IDLE,
      age: 0,
      env: 0,
      subPhase: 0,
      phases: new Float64Array(MAX_UNISON),
      s1: 0,
      s2: 0,
      stealGain: 1,
      newNote: -1,
      newVel: 0,
    }));
  }

  setPatch(patch: WavetablePatch): void {
    this.patch = { ...patch };
    this.wtPosTarget = Math.max(0, Math.min(1, patch.wtPos));
    this.cutoffTarget = Math.max(20, Math.min(20000, patch.cutoff));
    this.driveTarget = Math.max(0, Math.min(3, patch.drive));
  }

  noteOn(note: number, velocity: number, glide?: { from: number; seconds: number }): number {
    const vIdx = this.pickVoice();
    const voice = this.v[vIdx];
    const targetHz = midiToHz(note);
    const startHz = glide && glide.seconds > 0 ? midiToHz(glide.from) : targetHz;

    if (voice.state !== IDLE && voice.env > SILENT) {
      voice.state = STEAL;
      voice.newNote = note;
      voice.newVel = velocity;
      voice.targetHz = targetHz;
      return vIdx;
    }

    this.startVoice(voice, note, velocity, startHz, targetHz, glide?.seconds ?? 0);
    return vIdx;
  }

  private startVoice(voice: Voice, note: number, velocity: number, startHz: number, targetHz: number, glideSec: number): void {
    voice.note = note;
    voice.velocity = velocity;
    voice.hz = startHz;
    voice.targetHz = targetHz;
    voice.glideStep = glideSec > 0 ? (targetHz - startHz) / (glideSec * this.sampleRate) : 0;
    voice.state = ATTACK;
    voice.env = 0;
    voice.age = ++this.ageCounter;
    voice.subPhase = 0;
    voice.s1 = 0;
    voice.s2 = 0;
    voice.stealGain = 1;

    // Disperse unison phases
    for (let u = 0; u < MAX_UNISON; u++) {
      voice.phases[u] = (u * 0.173) % 1;
    }
  }

  noteOff(note: number): void {
    for (const v of this.v) {
      if (v.note === note && (v.state === ATTACK || v.state === DECAY)) {
        v.state = RELEASE;
      }
    }
  }

  allNotesOff(): void {
    for (const v of this.v) {
      if (v.state !== IDLE) v.state = RELEASE;
    }
  }

  activeVoices(): number {
    return this.v.filter((v) => v.state !== IDLE).length;
  }

  private pickVoice(): number {
    let best = 0;
    let oldest = Infinity;
    // 1. Idle voice
    for (let i = 0; i < this.voices; i++) {
      if (this.v[i].state === IDLE) return i;
    }
    // 2. Oldest released voice
    for (let i = 0; i < this.voices; i++) {
      if (this.v[i].state === RELEASE && this.v[i].age < oldest) {
        oldest = this.v[i].age;
        best = i;
      }
    }
    if (oldest < Infinity) return best;
    // 3. Oldest playing voice
    for (let i = 0; i < this.voices; i++) {
      if (this.v[i].age < oldest) {
        oldest = this.v[i].age;
        best = i;
      }
    }
    return best;
  }

  render(out: Float32Array, start: number, n: number): void {
    const attackStep = 1 / Math.max(1, this.patch.attack * this.sampleRate);
    const decayCoef = coefFor(this.patch.decay, this.sampleRate);
    const releaseCoef = coefFor(this.patch.release, this.sampleRate);
    const sustain = this.patch.sustain;
    const unison = Math.max(1, Math.min(MAX_UNISON, Math.round(this.patch.unison)));
    const detuneSpread = this.patch.detune;
    const table = this.patch.table;
    const filterType = this.patch.filterType;
    const subVol = this.patch.sub;
    const subDiv = this.patch.subOctave === 2 ? 4 : 2;
    const unisonNorm = 1 / Math.sqrt(unison);

    for (let i = 0; i < n; i++) {
      // Smooth patch controls
      this.wtPosNow = glideStep(this.wtPosNow, this.wtPosTarget, this.smoothCoef);
      this.cutoffNow = glideStep(this.cutoffNow, this.cutoffTarget, this.smoothCoef);
      this.driveNow = glideStep(this.driveNow, this.driveTarget, this.smoothCoef);

      let sampleSum = 0;

      for (let v = 0; v < this.voices; v++) {
        const voice = this.v[v];
        if (voice.state === IDLE) continue;

        // Steal crossfade
        if (voice.state === STEAL) {
          voice.stealGain -= 1 / (0.002 * this.sampleRate);
          if (voice.stealGain <= 0) {
            this.startVoice(voice, voice.newNote, voice.newVel, voice.targetHz, voice.targetHz, 0);
          }
        }

        // Frequency glide
        if (voice.glideStep !== 0) {
          voice.hz += voice.glideStep;
          if ((voice.glideStep > 0 && voice.hz >= voice.targetHz) || (voice.glideStep < 0 && voice.hz <= voice.targetHz)) {
            voice.hz = voice.targetHz;
            voice.glideStep = 0;
          }
        }

        // Envelope
        if (voice.state === ATTACK) {
          voice.env += attackStep;
          if (voice.env >= 1) {
            voice.env = 1;
            voice.state = DECAY;
          }
        } else if (voice.state === DECAY) {
          voice.env = sustain + (voice.env - sustain) * (1 - decayCoef);
          if (voice.env <= sustain + SILENT) voice.env = sustain;
        } else if (voice.state === RELEASE) {
          voice.env *= 1 - releaseCoef;
          if (voice.env <= SILENT) {
            voice.env = 0;
            voice.state = IDLE;
            continue;
          }
        }

        // Unison oscillator sum
        let oscSum = 0;
        const baseHz = voice.hz;
        for (let u = 0; u < unison; u++) {
          const detuneFactor = unison > 1 ? (u - (unison - 1) / 2) / ((unison - 1) / 2) : 0;
          const uHz = baseHz * Math.pow(2, (detuneFactor * detuneSpread) / 1200);
          voice.phases[u] += uHz / this.sampleRate;
          voice.phases[u] -= Math.floor(voice.phases[u]);
          oscSum += sampleWavetable(table, this.wtPosNow, voice.phases[u]);
        }
        let voiceSignal = oscSum * unisonNorm;

        // Sub-oscillator (phase-locked sine)
        if (subVol > 0) {
          const subHz = baseHz / subDiv;
          voice.subPhase += subHz / this.sampleRate;
          voice.subPhase -= Math.floor(voice.subPhase);
          const subSample = Math.sin(2 * Math.PI * voice.subPhase);
          voiceSignal += subSample * subVol;
        }

        // Apply amplitude envelope & velocity
        voiceSignal *= voice.env * voice.velocity * voice.stealGain;

        // Filter & Drive
        if (filterType !== "off") {
          // Drive / analog saturation before filter
          let xin = voiceSignal;
          if (this.driveNow > 0) {
            xin = Math.tanh(xin * (1 + this.driveNow * 1.5));
          }

          // Filter envelope modulation
          const envMod = voice.env * this.patch.filterEnv * 4;
          const fc = Math.max(20, Math.min(0.45 * this.sampleRate, this.cutoffNow * Math.pow(2, envMod)));
          const q = 0.707 + Math.min(0.98, Math.max(0, this.patch.resonance)) * 8;
          const g = Math.tan((Math.PI * fc) / this.sampleRate);
          const k = 1 / q;

          const a1 = 1 / (1 + g * (g + k));
          const a2 = g * a1;
          const a3 = g * a2;
          const v3 = xin - voice.s2;
          const v1 = a1 * voice.s1 + a2 * v3;
          const v2 = voice.s2 + a2 * voice.s1 + a3 * v3;
          voice.s1 = 2 * v1 - voice.s1;
          voice.s2 = 2 * v2 - voice.s2;

          if (filterType === "lowpass") voiceSignal = v2;
          else if (filterType === "bandpass") voiceSignal = v1;
          else if (filterType === "highpass") voiceSignal = xin - k * v1 - v2;
        }

        sampleSum += voiceSignal;
      }

      out[start + i] += sampleSum * 0.45;
    }
  }
}
