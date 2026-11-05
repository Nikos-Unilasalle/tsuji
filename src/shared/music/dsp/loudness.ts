/**
 * Loudness as ITU-R BS.1770 / EBU R128 measures it, for the Mixing Console: K-weighting (a high shelf for the head,
 * then a high-pass), mean square per 100 ms, and from those
 * - momentary loudness (the last 400 ms),
 * - short-term loudness (the last 3 s),
 * - integrated loudness (the whole run, gated: blocks under −70 LUFS are dropped, then those 10 LU under the mean).
 * Pure, like the rest of dsp/: the same numbers whatever the block size.
 */

/** A biquad in direct form I. */
class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  constructor(
    private b0: number,
    private b1: number,
    private b2: number,
    private a1: number,
    private a2: number,
  ) {}
  step(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** The two K-weighting stages at any sample rate (the BS.1770 analog prototypes, as libebur128 derives them). */
function kWeighting(sampleRate: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf = new Biquad((Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + K / Q + K * K;
  const highPass = new Biquad(1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
  return [shelf, highPass];
}

const lufsOf = (meanSquare: number) => (meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity);

export interface LoudnessReading {
  momentary: number;
  shortTerm: number;
  integrated: number;
}

export class LoudnessMeter {
  private readonly blockLength: number;
  private filters: [Biquad, Biquad][];
  /** The 100 ms block being filled: the channels' summed squares, and its sample count. */
  private acc = 0;
  private filled = 0;
  /** Every finished 100 ms block's mean square (left + right), oldest first. */
  private blocks: number[] = [];
  /** 400 ms gating blocks' mean squares, for the integrated loudness (one per 100 ms, overlapping by 75 %). */
  private gating: number[] = [];

  constructor(private readonly sampleRate: number) {
    this.blockLength = Math.max(1, Math.round(sampleRate / 10));
    this.filters = [kWeighting(sampleRate), kWeighting(sampleRate)];
  }

  /** Starts over: a new run (the transport started) measures from silence. */
  reset(): void {
    this.filters = [kWeighting(this.sampleRate), kWeighting(this.sampleRate)];
    this.acc = 0;
    this.filled = 0;
    this.blocks = [];
    this.gating = [];
  }

  process(left: Float32Array, right: Float32Array, start: number, n: number): void {
    const [fl, fr] = this.filters;
    for (let i = start; i < start + n; i++) {
      const l = fl[1].step(fl[0].step(left[i]));
      const r = fr[1].step(fr[0].step(right[i]));
      this.acc += l * l + r * r;
      if (++this.filled === this.blockLength) {
        this.blocks.push(this.acc / this.blockLength);
        this.acc = 0;
        this.filled = 0;
        if (this.blocks.length >= 4) this.gating.push(this.mean(4));
        // Only the last 3 s are read back, besides the gating blocks.
        if (this.blocks.length > 60) this.blocks.splice(0, this.blocks.length - 30);
      }
    }
  }

  /** The mean square of the last `count` 100 ms blocks (fewer at the start). */
  private mean(count: number): number {
    const k = Math.min(count, this.blocks.length);
    if (k === 0) return 0;
    let s = 0;
    for (let i = this.blocks.length - k; i < this.blocks.length; i++) s += this.blocks[i];
    return s / k;
  }

  reading(): LoudnessReading {
    return { momentary: lufsOf(this.mean(4)), shortTerm: lufsOf(this.mean(30)), integrated: this.integrated() };
  }

  private integrated(): number {
    const absolute = 10 ** ((-70 + 0.691) / 10);
    const above = this.gating.filter((z) => z > absolute);
    if (above.length === 0) return -Infinity;
    const relative = (above.reduce((a, b) => a + b, 0) / above.length) * 10 ** (-10 / 10);
    const kept = above.filter((z) => z > relative);
    return lufsOf(kept.reduce((a, b) => a + b, 0) / Math.max(1, kept.length));
  }
}
