/**
 * Step 0 of the music nodes (docs/music-nodes-mvp.md): does an AudioWorklet running the pure FM core load and keep up,
 * in Vite and in Tauri's WKWebView? Plays a Cmaj9 arpeggio on a 2-op patch, scheduled to the sample; "stress" adds
 * the MVP's worst case (3 tracks × 8 voices × 4 operators, all sounding) and reports what a block costs.
 *
 * Loaded with `?worker&url`, so Vite bundles it (and fm.ts) into one script in dev and in the build alike.
 */
import { FmBank, SPIKE_PATCH } from "../dsp/fm";

// The AudioWorkletGlobalScope, which TypeScript's DOM lib leaves out.
declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

const BPM = 120;
/** Cmaj9 over two octaves, in semitones from C4. */
const ARP = [0, 4, 7, 11, 14, 12, 16, 19, 23, 26];
const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** Wall clock in ms: performance.now() where the scope has it (Chrome does not), Date.now() otherwise. */
const hasPerformance = typeof (globalThis as { performance?: Performance }).performance?.now === "function";
const now = hasPerformance ? () => performance.now() : () => Date.now();

class SpikeProcessor extends AudioWorkletProcessor {
  private lead = new FmBank(6, 2, sampleRate);
  private stress: FmBank[] = [];
  private stepSamples = Math.round((60 / BPM / 4) * sampleRate); // 1/16
  private nextStep = -1;
  private step = 0;
  private mix = new Float32Array(128);
  private blocks = 0;
  private renderMs = 0;
  private maxMs = 0;
  private lastReport = 0;
  private peak = 0;

  constructor() {
    super();
    this.lead.setPatch(SPIKE_PATCH);
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data?.type === "stress") this.setStress(Boolean(e.data.on));
    };
    this.port.postMessage({ type: "ready", sampleRate, hasPerformance, calibration: this.calibrate() });
  }

  private setStress(on: boolean): void {
    this.stress = on
      ? [0, 1, 2].map(() => {
          const b = new FmBank(8, 4, sampleRate);
          b.setPatch({ ...SPIKE_PATCH, ops: [...SPIKE_PATCH.ops, ...SPIKE_PATCH.ops] });
          // Held forever, at a level that keeps the speakers safe: this is a CPU load, not music.
          for (let v = 0; v < 8; v++) b.noteOn(v, 55 * (v + 1), 0.004);
          return b;
        })
      : [];
    this.blocks = this.renderMs = this.maxMs = 0;
  }

  /**
   * Cost of one worst-case block, timed over many blocks so Date.now()'s 1 ms grain does not matter. Runs on this
   * very thread and JIT, before any sound is due.
   */
  private calibrate(): { usPerBlock: number; loadPercent: number } {
    const banks = [0, 1, 2].map(() => {
      const b = new FmBank(8, 4, sampleRate);
      b.setPatch(SPIKE_PATCH);
      for (let v = 0; v < 8; v++) b.noteOn(v, 110 * (v + 1), 0.5);
      return b;
    });
    const out = new Float32Array(128);
    for (let i = 0; i < 300; i++) for (const b of banks) b.render(out, 0, 128);
    const n = 3000;
    const t0 = now();
    for (let i = 0; i < n; i++) for (const b of banks) b.render(out, 0, 128);
    const us = ((now() - t0) / n) * 1000;
    return { usPerBlock: us, loadPercent: (us / ((128 / sampleRate) * 1e6)) * 100 };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const t0 = now();
    const out = outputs[0];
    const n = out[0].length;
    if (this.mix.length !== n) this.mix = new Float32Array(n);
    const mix = this.mix;
    mix.fill(0);

    // Render up to each note-on inside the block, so every note starts on its exact sample.
    if (this.nextStep < 0) this.nextStep = currentFrame;
    let s = 0;
    while (s < n) {
      const due = this.nextStep - currentFrame;
      const until = due > s && due < n ? due : n;
      if (due <= s) {
        const voice = this.step % 6;
        this.lead.noteOn(voice, midiHz(60 + ARP[this.step % ARP.length]), 0.7);
        this.lead.noteOff((voice + 3) % 6);
        this.step++;
        this.nextStep += this.stepSamples;
        continue;
      }
      this.lead.render(mix, s, until - s);
      for (const b of this.stress) b.render(mix, s, until - s);
      s = until;
    }

    for (const ch of out) ch.set(mix);
    for (let i = 0; i < n; i++) if (Math.abs(mix[i]) > this.peak) this.peak = Math.abs(mix[i]);

    if (hasPerformance) {
      const ms = now() - t0;
      this.renderMs += ms;
      if (ms > this.maxMs) this.maxMs = ms;
    }
    this.blocks++;
    if (currentFrame - this.lastReport >= sampleRate) {
      this.lastReport = currentFrame;
      this.port.postMessage({
        type: "stats",
        stress: this.stress.length > 0,
        blocks: this.blocks,
        avgUs: hasPerformance ? (this.renderMs / this.blocks) * 1000 : null,
        maxUs: hasPerformance ? this.maxMs * 1000 : null,
        budgetUs: (n / sampleRate) * 1e6,
        peak: this.peak,
      });
      this.peak = 0;
    }
    return true;
  }
}

registerProcessor("tsuji-music-spike", SpikeProcessor);
