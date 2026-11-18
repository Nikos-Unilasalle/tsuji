/**
 * Real-time viseme detection from an audio stream.
 *
 * Began as a port of wawa-lipsync 0.0.2 (MIT, © Wawa Sensei, https://github.com/wass08/wawa-lipsync), which classifies
 * vowels by comparing a handful of fixed frequency bands. Measured on recorded speech that rule answered "E" for four
 * frames in five whatever was said: it fires whenever energy falls from one band to the next, and the spectrum of every
 * voice falls with frequency. So the detection is now phonetic, the way speech is told apart in the textbooks:
 *
 *  - vowels by their first two formants (F1 ≈ how open the jaw is, F2 ≈ how far forward the tongue is and how spread
 *    the lips are), found as the peaks of an LPC envelope and matched to the nearest vowel;
 *  - fricatives (s, ch, f) by how much of the energy sits in the hiss above 2.5 kHz, and where;
 *  - closed lips (m, b, p) by the nasal murmur: voiced, but nearly all of it below 500 Hz;
 *  - silence against a noise floor and the recent peak, both adaptive, so a quiet room and a loud one behave alike.
 *
 * Reads the analyser's time-domain samples, not its byte spectrum: the formant estimate needs the waveform, and the
 * analyser's own spectrum smoothing would smear every consonant across several frames.
 *
 * The output vocabulary is still the 15 Oculus / Ready Player Me visemes, so rigs made for wawa-lipsync keep working.
 */

export const VISEMES = [
  "viseme_sil",
  "viseme_PP",
  "viseme_FF",
  "viseme_TH",
  "viseme_DD",
  "viseme_kk",
  "viseme_CH",
  "viseme_SS",
  "viseme_nn",
  "viseme_RR",
  "viseme_aa",
  "viseme_E",
  "viseme_I",
  "viseme_O",
  "viseme_U",
] as const;

export type Viseme = (typeof VISEMES)[number];

export interface LipsyncFeatures {
  /** RMS of the frame, 0..1 full scale. */
  rms: number;
  /** 0..1 loudness for display and driving things: the RMS against the recent peak. */
  volume: number;
  /** Spectral centroid in Hz over 100 Hz – 8 kHz. */
  centroid: number;
  /** Share of the energy above 2.5 kHz. */
  highRatio: number;
  /** Share of the energy below 500 Hz. */
  lowRatio: number;
  /** First three formants in Hz, 0 when none was found. */
  f1: number;
  f2: number;
  f3: number;
}

/**
 * Where each vowel sits in the F1 / F2 plane (French reference values, adult male; women and children read higher and
 * land on the same vowels, since the match is on ratios), and the mouth that makes it. Several vowels share a mouth:
 * what the face shows is jaw opening and lip shape, not the tongue.
 */
const VOWELS: { f1: number; f2: number; viseme: Viseme }[] = [
  { f1: 290, f2: 2150, viseme: "viseme_I" }, // i
  { f1: 380, f2: 2050, viseme: "viseme_E" }, // é
  { f1: 520, f2: 1800, viseme: "viseme_E" }, // è
  { f1: 640, f2: 1350, viseme: "viseme_aa" }, // a
  { f1: 720, f2: 1150, viseme: "viseme_aa" }, // â, English "ah"
  { f1: 500, f2: 950, viseme: "viseme_O" }, // o ouvert
  { f1: 380, f2: 780, viseme: "viseme_O" }, // o fermé
  { f1: 420, f2: 1450, viseme: "viseme_O" }, // eu
  { f1: 290, f2: 720, viseme: "viseme_U" }, // ou
];

/**
 * Nearest vowel to a formant set, in log frequency so a 100 Hz miss counts more at F1 than at F2. F1 weighs double: it
 * is the jaw, the most visible part of a mouth shape. F3 settles the one pair F1 and F2 cannot tell apart, i from the
 * French u ("pipi" / "pupu"): rounding the lips drags F3 down next to F2.
 */
export function classifyVowel(f1: number, f2: number, f3 = 0): Viseme {
  let best: Viseme = "viseme_aa";
  let bestD = Infinity;
  for (const v of VOWELS) {
    const d1 = Math.log(f1 / v.f1);
    const d2 = Math.log(f2 / v.f2);
    const d = 2 * d1 * d1 + d2 * d2;
    if (d < bestD) {
      bestD = d;
      best = v.viseme;
    }
  }
  if (best === "viseme_I" && f3 > 0 && f3 - f2 < 400) return "viseme_U";
  return best;
}

/** LPC coefficients a[1..order] (a[0] = 1) of a windowed frame, by autocorrelation and Levinson–Durbin. */
export function lpc(frame: Float64Array, order: number): Float64Array | null {
  const r = new Float64Array(order + 1);
  for (let lag = 0; lag <= order; lag++) {
    let s = 0;
    for (let i = lag; i < frame.length; i++) s += frame[i] * frame[i - lag];
    r[lag] = s;
  }
  if (!(r[0] > 1e-12)) return null;
  r[0] *= 1.0001; // a touch of white-noise correction keeps the recursion stable on very tonal frames
  const a = new Float64Array(order + 1);
  a[0] = 1;
  let err = r[0];
  const tmp = new Float64Array(order + 1);
  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / err;
    tmp.set(a);
    for (let j = 1; j < i; j++) a[j] = tmp[j] + k * tmp[i - j];
    a[i] = k;
    err *= 1 - k * k;
    if (!(err > 0)) return null;
  }
  return a;
}

/**
 * Formants from the roots of the LPC polynomial: each complex pole pair is a resonance, its angle the frequency and its
 * distance from the unit circle the bandwidth. Unlike picking peaks off the envelope, this keeps F1 and F2 apart when
 * they sit close together — which they do in every rounded vowel (o, ou) — instead of merging them into one bump.
 * Returns resonances narrow enough to be formants, in rising frequency.
 */
export function lpcFormants(a: Float64Array, sampleRate: number): number[] {
  const p = a.length - 1;
  // Durand–Kerner on z^p + a1 z^(p-1) + … + ap, from the usual non-symmetric starting ring.
  const re = new Float64Array(p);
  const im = new Float64Array(p);
  for (let i = 0; i < p; i++) {
    const ang = (2 * Math.PI * i) / p + 0.4;
    re[i] = 0.9 * Math.cos(ang);
    im[i] = 0.9 * Math.sin(ang);
  }
  for (let iter = 0; iter < 60; iter++) {
    let moved = 0;
    for (let i = 0; i < p; i++) {
      // Horner: value of the polynomial at root i.
      let vr = 1;
      let vi = 0;
      for (let k = 1; k <= p; k++) {
        const nr = vr * re[i] - vi * im[i] + a[k];
        vi = vr * im[i] + vi * re[i];
        vr = nr;
      }
      let dr = 1;
      let di = 0;
      for (let j = 0; j < p; j++) {
        if (j === i) continue;
        const xr = re[i] - re[j];
        const xi = im[i] - im[j];
        const nr = dr * xr - di * xi;
        di = dr * xi + di * xr;
        dr = nr;
      }
      const den = dr * dr + di * di || 1e-30;
      const qr = (vr * dr + vi * di) / den;
      const qi = (vi * dr - vr * di) / den;
      re[i] -= qr;
      im[i] -= qi;
      moved = Math.max(moved, Math.abs(qr) + Math.abs(qi));
    }
    if (moved < 1e-9) break;
  }
  const out: number[] = [];
  for (let i = 0; i < p; i++) {
    if (im[i] <= 0) continue;
    const r = Math.hypot(re[i], im[i]);
    const freq = (Math.atan2(im[i], re[i]) * sampleRate) / (2 * Math.PI);
    const bandwidth = (-Math.log(r) * sampleRate) / Math.PI;
    if (freq > 180 && bandwidth > 0 && bandwidth < 500) out.push(freq);
  }
  return out.sort((x, y) => x - y);
}

/** F1, F2 and F3 from formant candidates; 0 where the frame has none in range. */
export function pickFormants(candidates: number[]): { f1: number; f2: number; f3: number } {
  const f1 = candidates.find((f) => f >= 200 && f <= 1000) ?? 0;
  if (!f1) return { f1: 0, f2: 0, f3: 0 };
  const f2 = candidates.find((f) => f > f1 + 100 && f >= 550 && f <= 3000) ?? 0;
  const f3 = f2 ? (candidates.find((f) => f > f2 + 150 && f <= 4000) ?? 0) : 0;
  return { f1, f2, f3 };
}

/** In-place radix-2 FFT; length must be a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < half; j++) {
        const wr = Math.cos(ang * j);
        const wi = Math.sin(ang * j);
        const xr = re[i + j + half] * wr - im[i + j + half] * wi;
        const xi = re[i + j + half] * wi + im[i + j + half] * wr;
        re[i + j + half] = re[i + j] - xr;
        im[i + j + half] = im[i + j] - xi;
        re[i + j] += xr;
        im[i + j] += xi;
      }
    }
  }
}

const FRAME = 1024;
/** Where vowels centre in running speech for a mid-pitched voice (log Hz); measured, not the vowel table's own mean, since speech spends more time on front vowels. */
const REF_LOG_F1 = Math.log(430);
const REF_LOG_F2 = Math.log(1550);
/** How far a voice may be rescaled toward the table: a child's voice and a deep one, not further. */
const MAX_SPEAKER_SHIFT = Math.log(1.25);
const LPC_RATE = 11025;
const LPC_ORDER = 12;

/** The part of an AnalyserNode the detector reads, so a test can hand it plain samples. */
export interface SampleSource {
  readonly fftSize: number;
  readonly context: { readonly sampleRate: number };
  getFloatTimeDomainData(array: Float32Array<ArrayBuffer>): void;
}

export class LipsyncAnalyzer {
  viseme: Viseme = "viseme_sil";
  features: LipsyncFeatures | null = null;
  private readonly samples: Float32Array<ArrayBuffer>;
  private readonly sampleRate: number;
  private readonly hann: Float64Array;
  private noiseFloor = 0.002;
  private peak = 0.02;
  /** Running mean of log F1 / log F2 over clear vowels: where this voice sits, see `classify`. */
  private logF1 = REF_LOG_F1;
  private logF2 = REF_LOG_F2;
  private pending: Viseme = "viseme_sil";
  private pendingFrames = 0;

  constructor(readonly source: SampleSource) {
    this.samples = new Float32Array(source.fftSize);
    this.sampleRate = source.context.sampleRate;
    this.hann = new Float64Array(FRAME);
    for (let i = 0; i < FRAME; i++) this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));
  }

  /** Reads the latest samples and updates `viseme`. */
  process(): Viseme {
    this.source.getFloatTimeDomainData(this.samples);
    const n = Math.min(FRAME, this.samples.length);
    const frame = this.samples.subarray(this.samples.length - n);

    let sum = 0;
    for (let i = 0; i < n; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / n);

    // The floor follows quiet passages down at once and creeps up only slowly, so speech never becomes the floor.
    this.noiseFloor = rms < this.noiseFloor ? rms : this.noiseFloor * 1.002 + 1e-6;
    this.peak = Math.max(rms, this.peak * 0.995, 0.01);

    const spectral = this.spectrum(frame);
    const { f1, f2, f3 } = rms > 1e-4 ? this.formants(frame) : { f1: 0, f2: 0, f3: 0 };
    const features: LipsyncFeatures = { rms, volume: Math.min(1, rms / this.peak), ...spectral, f1, f2, f3 };
    this.features = features;
    return this.settle(this.classify(features));
  }

  private classify(f: LipsyncFeatures): Viseme {
    const gate = Math.max(0.003, this.noiseFloor * 3, this.peak * 0.05);
    if (f.rms < gate) return "viseme_sil";
    if (f.highRatio > 0.5) {
      if (f.centroid > 5200) return "viseme_SS";
      if (f.centroid > 3200) return f.rms < this.peak * 0.2 ? "viseme_FF" : "viseme_CH";
      return "viseme_FF";
    }
    // Lips shut on a voiced sound (m, b, the hum before a p): all low murmur, and much weaker than the vowels around it.
    if (f.lowRatio > 0.9 && f.rms < this.peak * 0.25) return "viseme_PP";
    if (f.f1) {
      // Voices differ by up to a quarter in their formants (vocal tract length): a deep voice's "a" sits where a
      // reference voice's "o" would. So the vowels are read relative to where this voice has been centring, learned
      // over the last seconds of clear vowels and capped so a run of one vowel cannot drag the scale too far.
      if (f.f2 && f.rms > this.peak * 0.35) {
        this.logF1 += (Math.log(f.f1) - this.logF1) * 0.01;
        this.logF2 += (Math.log(f.f2) - this.logF2) * 0.01;
      }
      const clamp = (x: number) => Math.max(-MAX_SPEAKER_SHIFT, Math.min(MAX_SPEAKER_SHIFT, x));
      const f1 = f.f1 * Math.exp(clamp(REF_LOG_F1 - this.logF1));
      const k2 = Math.exp(clamp(REF_LOG_F2 - this.logF2));
      if (f.f2) return classifyVowel(f1, f.f2 * k2, f.f3 * k2);
      // A lone resonance is F1 and F2 merged, which only happens when both are low: the back rounded vowels.
      return f1 < 360 ? "viseme_U" : f1 < 600 ? "viseme_O" : "viseme_aa";
    }
    return f.highRatio > 0.25 ? "viseme_DD" : "viseme_nn";
  }

  /**
   * A new viseme must hold for two frames before it shows: one stray frame between two vowels is a measurement, not a
   * mouth shape. Silence is let through at once, so a mouth closes as soon as the voice stops.
   */
  private settle(candidate: Viseme): Viseme {
    if (candidate === this.viseme) {
      this.pendingFrames = 0;
      return this.viseme;
    }
    if (candidate === this.pending) this.pendingFrames++;
    else {
      this.pending = candidate;
      this.pendingFrames = 1;
    }
    if (this.pendingFrames >= 2 || candidate === "viseme_sil") {
      this.viseme = candidate;
      this.pendingFrames = 0;
    }
    return this.viseme;
  }

  private spectrum(frame: Float32Array): { centroid: number; highRatio: number; lowRatio: number } {
    const n = frame.length;
    const re = new Float64Array(FRAME);
    const im = new Float64Array(FRAME);
    for (let i = 0; i < n; i++) re[i] = frame[i] * this.hann[i];
    fft(re, im);
    const binHz = this.sampleRate / FRAME;
    let total = 0;
    let low = 0;
    let high = 0;
    let weighted = 0;
    const top = Math.min(FRAME / 2, Math.floor(8000 / binHz));
    for (let i = Math.ceil(100 / binHz); i < top; i++) {
      const p = re[i] * re[i] + im[i] * im[i];
      const hz = i * binHz;
      total += p;
      weighted += p * hz;
      if (hz < 500) low += p;
      else if (hz >= 2500) high += p;
    }
    if (!(total > 0)) return { centroid: 0, highRatio: 0, lowRatio: 0 };
    return { centroid: weighted / total, highRatio: high / total, lowRatio: low / total };
  }

  private formants(frame: Float32Array): { f1: number; f2: number; f3: number } {
    // Down to ~11 kHz: formants live below 4 kHz, and a 12-pole model at 48 kHz would spend its poles on the hiss.
    const step = Math.max(1, Math.round(this.sampleRate / LPC_RATE));
    const rate = this.sampleRate / step;
    const m = Math.floor(frame.length / step);
    const x = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      let s = 0;
      for (let k = 0; k < step; k++) s += frame[i * step + k];
      x[i] = s / step;
    }
    // Pre-emphasis lifts the higher formants that the voice's natural tilt would bury, then a Hamming window.
    for (let i = m - 1; i > 0; i--) x[i] -= 0.9 * x[i - 1];
    for (let i = 0; i < m; i++) x[i] *= 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (m - 1));
    const a = lpc(x, LPC_ORDER);
    return a ? pickFormants(lpcFormants(a, rate)) : { f1: 0, f2: 0, f3: 0 };
  }
}
