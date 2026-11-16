/**
 * Pure generative granular synthesizer (Pulsar synthesis & stochastic particle clouds):
 *
 *   zero samples  pure mathematical generation: every grain is synthesized on the fly from micro-waveforms:
 *                 - "pulsar": pure harmonic micro-sine burst
 *                 - "chirp": exponential frequency-swept micro-chirp for swirling, metallic/liquid motion
 *                 - "formant": resonant acoustic formant pulse
 *                 - "micro_fm": 2-operator frequency-modulated micro-burst for mineral, glassy textures
 *                 - "noise": resonant stochastic burst
 *   cloud engine  stochastic grain emission (Poisson cloud with controllable density & spray):
 *                 - density: 2–350 grains/second per voice
 *                 - grainSize: 5–300 ms duration with smooth Hann windowing
 *                 - spray: stochastic time jitter (0 = periodic pulsar stream, 1 = dense organic cloud)
 *                 - pitchSpray: microtonal pitch scatter in cents for shimmering celestial choruses
 *   sub drone     dedicated continuous phase-locked sub-oscillator for oceanic low-end weight
 *   filter        resonant Cytomic SVF with envelope modulation
 *   ADSR          ambient swells or percussive swarms
 *
 * Fully deterministic: seeded pseudo-random generator per voice guarantees identical offline render output.
 */
import { midiToHz } from "./fm";
import { glide as glideStep } from "./mix";

export type GrainSource = "pulsar" | "chirp" | "formant" | "micro_fm" | "noise";
export type GranularFilterType = "lowpass" | "bandpass" | "highpass" | "off";

export interface GranularPatch {
  grainSource: GrainSource;
  /** Emission rate in grains per second (2–350). */
  density: number;
  /** Grain duration in seconds (0.005–0.3). */
  grainSize: number;
  /** 0–1: timing jitter / Poisson spray. */
  spray: number;
  /** Microtonal pitch scatter in cents (0–120). */
  pitchSpray: number;
  /** Secondary resonant / formant frequency in Hz (100–6000). */
  formantFreq: number;
  /** 0–1: level of continuous sub-drone fundamental. */
  subLevel: number;
  filterType: GranularFilterType;
  /** Filter cutoff in Hz (20–20000). */
  cutoff: number;
  /** Filter resonance (0–0.98). */
  resonance: number;
  /** Filter envelope modulation depth (-1 to 1). */
  filterEnv: number;
  /** Seconds. */
  attack: number;
  decay: number;
  /** 0–1. */
  sustain: number;
  release: number;
}

export const GRANULAR_PRESETS: Record<string, GranularPatch> = {
  "Abyssal Drone": {
    grainSource: "chirp",
    density: 120,
    grainSize: 0.14,
    spray: 0.6,
    pitchSpray: 12,
    formantFreq: 300,
    subLevel: 0.85,
    filterType: "lowpass",
    cutoff: 480,
    resonance: 0.35,
    filterEnv: 0.2,
    attack: 0.4,
    decay: 1.5,
    sustain: 0.9,
    release: 1.2,
  },
  "Solar Wind": {
    grainSource: "micro_fm",
    density: 160,
    grainSize: 0.05,
    spray: 0.85,
    pitchSpray: 45,
    formantFreq: 2400,
    subLevel: 0.2,
    filterType: "bandpass",
    cutoff: 2200,
    resonance: 0.45,
    filterEnv: 0.1,
    attack: 0.2,
    decay: 1.0,
    sustain: 0.75,
    release: 0.8,
  },
  "Crystal Cloud": {
    grainSource: "pulsar",
    density: 90,
    grainSize: 0.08,
    spray: 0.5,
    pitchSpray: 25,
    formantFreq: 3200,
    subLevel: 0.15,
    filterType: "lowpass",
    cutoff: 5500,
    resonance: 0.25,
    filterEnv: 0.3,
    attack: 0.5,
    decay: 1.2,
    sustain: 0.8,
    release: 1.5,
  },
  "Sub Nebula": {
    grainSource: "pulsar",
    density: 45,
    grainSize: 0.16,
    spray: 0.4,
    pitchSpray: 8,
    formantFreq: 400,
    subLevel: 0.95,
    filterType: "lowpass",
    cutoff: 750,
    resonance: 0.2,
    filterEnv: 0.15,
    attack: 0.1,
    decay: 0.8,
    sustain: 0.9,
    release: 0.8,
  },
  "Tectonic Swarm": {
    grainSource: "formant",
    density: 75,
    grainSize: 0.06,
    spray: 0.9,
    pitchSpray: 60,
    formantFreq: 650,
    subLevel: 0.6,
    filterType: "lowpass",
    cutoff: 1200,
    resonance: 0.5,
    filterEnv: 0.4,
    attack: 0.02,
    decay: 0.5,
    sustain: 0.7,
    release: 0.5,
  },
};

export const GRANULAR_PRESET_NAMES = Object.keys(GRANULAR_PRESETS);

const MAX_GRAINS_PER_VOICE = 16;
const IDLE = 0;
const ATTACK = 1;
const DECAY = 2;
const RELEASE = 3;
const STEAL = 4;
const SILENT = 1e-6;

interface Grain {
  active: boolean;
  phase: number;
  phaseInc: number;
  envPhase: number;
  envInc: number;
  chirpRate: number;
  formantPhase: number;
  formantInc: number;
  fmModPhase: number;
  fmModInc: number;
}

interface Voice {
  note: number;
  hz: number;
  targetHz: number;
  glideStep: number;
  velocity: number;
  state: number;
  age: number;
  env: number;
  subPhase: number;
  // Grain trigger timer
  samplesUntilNextGrain: number;
  grains: Grain[];
  // PRNG state for this voice (LCG)
  rngState: number;
  // Filter state
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

/** Fast deterministic PRNG (Linear Congruential Generator). Returns 0..1. */
function nextRandom(voice: Voice): number {
  voice.rngState = (voice.rngState * 1664525 + 1013904223) >>> 0;
  return voice.rngState / 4294967296;
}

export class GranularSynth {
  readonly voices: number;
  private readonly sampleRate: number;
  private v: Voice[];
  private patch: GranularPatch;
  private ageCounter = 0;

  // Smoothed patch params
  private cutoffNow = 1000;
  private cutoffTarget = 1000;
  private densityNow = 80;
  private densityTarget = 80;
  private smoothCoef = 0.01;

  constructor(voices = 4, sampleRate = 48_000) {
    this.voices = Math.max(1, Math.min(8, voices));
    this.sampleRate = sampleRate;
    this.smoothCoef = coefFor(0.005, sampleRate);
    this.patch = { ...GRANULAR_PRESETS["Abyssal Drone"] };
    this.cutoffNow = this.patch.cutoff;
    this.cutoffTarget = this.patch.cutoff;
    this.densityNow = this.patch.density;
    this.densityTarget = this.patch.density;

    this.v = Array.from({ length: this.voices }, (_, idx) => ({
      note: -1,
      hz: 440,
      targetHz: 440,
      glideStep: 0,
      velocity: 0,
      state: IDLE,
      age: 0,
      env: 0,
      subPhase: 0,
      samplesUntilNextGrain: 0,
      grains: Array.from({ length: MAX_GRAINS_PER_VOICE }, () => ({
        active: false,
        phase: 0,
        phaseInc: 0,
        envPhase: 0,
        envInc: 0,
        chirpRate: 1,
        formantPhase: 0,
        formantInc: 0,
        fmModPhase: 0,
        fmModInc: 0,
      })),
      rngState: (idx + 1) * 2654435761 >>> 0,
      s1: 0,
      s2: 0,
      stealGain: 1,
      newNote: -1,
      newVel: 0,
    }));
  }

  setPatch(patch: GranularPatch): void {
    this.patch = { ...patch };
    this.cutoffTarget = Math.max(20, Math.min(20000, patch.cutoff));
    this.densityTarget = Math.max(2, Math.min(350, patch.density));
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
    voice.samplesUntilNextGrain = 0;
    voice.s1 = 0;
    voice.s2 = 0;
    voice.stealGain = 1;

    for (const g of voice.grains) g.active = false;
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
    for (let i = 0; i < this.voices; i++) {
      if (this.v[i].state === IDLE) return i;
    }
    for (let i = 0; i < this.voices; i++) {
      if (this.v[i].state === RELEASE && this.v[i].age < oldest) {
        oldest = this.v[i].age;
        best = i;
      }
    }
    if (oldest < Infinity) return best;
    for (let i = 0; i < this.voices; i++) {
      if (this.v[i].age < oldest) {
        oldest = this.v[i].age;
        best = i;
      }
    }
    return best;
  }

  private spawnGrain(voice: Voice): void {
    // Find free grain slot
    let freeGrain: Grain | null = null;
    for (const g of voice.grains) {
      if (!g.active) {
        freeGrain = g;
        break;
      }
    }
    if (!freeGrain) return; // Pool full

    // Calculate pitch scatter
    const pitchRand = (nextRandom(voice) * 2 - 1) * this.patch.pitchSpray;
    const grainHz = voice.hz * Math.pow(2, pitchRand / 1200);

    // Duration with slight jitter
    const durRand = 1 + (nextRandom(voice) * 0.4 - 0.2);
    const duration = Math.max(0.005, this.patch.grainSize * durRand);

    freeGrain.active = true;
    freeGrain.phase = nextRandom(voice); // Random start phase avoids clicks on emission
    freeGrain.phaseInc = grainHz / this.sampleRate;
    freeGrain.envPhase = 0;
    freeGrain.envInc = 1 / (duration * this.sampleRate);

    // Chirp sweep
    freeGrain.chirpRate = 1 + nextRandom(voice) * 1.5;

    // Formant
    const fHz = Math.max(50, Math.min(8000, this.patch.formantFreq * (0.8 + 0.4 * nextRandom(voice))));
    freeGrain.formantPhase = 0;
    freeGrain.formantInc = fHz / this.sampleRate;

    // Micro FM
    freeGrain.fmModPhase = 0;
    freeGrain.fmModInc = (grainHz * 2.0) / this.sampleRate;
  }

  render(out: Float32Array, start: number, n: number): void {
    const attackStep = 1 / Math.max(1, this.patch.attack * this.sampleRate);
    const decayCoef = coefFor(this.patch.decay, this.sampleRate);
    const releaseCoef = coefFor(this.patch.release, this.sampleRate);
    const sustain = this.patch.sustain;
    const subLevel = this.patch.subLevel;
    const filterType = this.patch.filterType;
    const grainSource = this.patch.grainSource;
    const spray = this.patch.spray;

    for (let i = 0; i < n; i++) {
      this.cutoffNow = glideStep(this.cutoffNow, this.cutoffTarget, this.smoothCoef);
      this.densityNow = glideStep(this.densityNow, this.densityTarget, this.smoothCoef);

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

        // Check grain emission timer
        if (voice.samplesUntilNextGrain <= 0) {
          this.spawnGrain(voice);
          // Calculate interval to next grain
          const meanInterval = this.sampleRate / Math.max(1, this.densityNow);
          // Poisson/stochastic jitter
          const jitter = spray > 0 ? (nextRandom(voice) * 2 - 1) * spray * 0.8 : 0;
          voice.samplesUntilNextGrain = Math.max(1, Math.round(meanInterval * (1 + jitter)));
        } else {
          voice.samplesUntilNextGrain--;
        }

        // Sum active grains
        let grainSum = 0;
        let activeCount = 0;
        for (const g of voice.grains) {
          if (!g.active) continue;

          // Hann window: 0.5 * (1 - cos(2pi * t))
          const env = 0.5 * (1 - Math.cos(2 * Math.PI * g.envPhase));

          let val = 0;
          if (grainSource === "pulsar") {
            val = Math.sin(2 * Math.PI * g.phase);
            g.phase += g.phaseInc;
          } else if (grainSource === "chirp") {
            // Sweep frequency from 1 to chirpRate over grain duration
            const curInc = g.phaseInc * (1 + (g.chirpRate - 1) * g.envPhase);
            val = Math.sin(2 * Math.PI * g.phase);
            g.phase += curInc;
          } else if (grainSource === "formant") {
            // Formant resonance damped sinusoid
            const formantVal = Math.sin(2 * Math.PI * g.formantPhase);
            val = formantVal * Math.exp(-3 * g.envPhase);
            g.formantPhase += g.formantInc;
          } else if (grainSource === "micro_fm") {
            // 2-Op micro FM
            const mod = Math.sin(2 * Math.PI * g.fmModPhase);
            val = Math.sin(2 * Math.PI * g.phase + 2.0 * mod);
            g.phase += g.phaseInc;
            g.fmModPhase += g.fmModInc;
          } else if (grainSource === "noise") {
            // High-frequency stochastic impulse
            val = nextRandom(voice) * 2 - 1;
          }

          grainSum += val * env;
          activeCount++;

          g.envPhase += g.envInc;
          if (g.envPhase >= 1) g.active = false;
        }

        // Normalize grain cloud amplitude
        let cloudSignal = activeCount > 0 ? (grainSum / Math.sqrt(Math.max(1, activeCount))) * 0.7 : 0;

        // Continuous Sub-drone fundamental
        if (subLevel > 0) {
          voice.subPhase += (voice.hz * 0.5) / this.sampleRate;
          voice.subPhase -= Math.floor(voice.subPhase);
          const subSine = Math.sin(2 * Math.PI * voice.subPhase);
          cloudSignal += subSine * subLevel * 0.8;
        }

        // Apply voice envelope & velocity
        cloudSignal *= voice.env * voice.velocity * voice.stealGain;

        // Resonant Filter (Cytomic SVF)
        if (filterType !== "off") {
          const envMod = voice.env * this.patch.filterEnv * 4;
          const fc = Math.max(20, Math.min(0.45 * this.sampleRate, this.cutoffNow * Math.pow(2, envMod)));
          const q = 0.707 + Math.min(0.98, Math.max(0, this.patch.resonance)) * 8;
          const g = Math.tan((Math.PI * fc) / this.sampleRate);
          const k = 1 / q;

          const a1 = 1 / (1 + g * (g + k));
          const a2 = g * a1;
          const a3 = g * a2;
          const v3 = cloudSignal - voice.s2;
          const v1 = a1 * voice.s1 + a2 * v3;
          const v2 = voice.s2 + a2 * voice.s1 + a3 * v3;
          voice.s1 = 2 * v1 - voice.s1;
          voice.s2 = 2 * v2 - voice.s2;

          if (filterType === "lowpass") cloudSignal = v2;
          else if (filterType === "bandpass") cloudSignal = v1;
          else if (filterType === "highpass") cloudSignal = cloudSignal - k * v1 - v2;
        }

        sampleSum += cloudSignal;
      }

      out[start + i] += sampleSum * 0.5;
    }
  }
}
