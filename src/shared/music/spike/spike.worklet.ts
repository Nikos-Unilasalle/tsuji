/**
 * The music engine's test bench (dev only, see spikePanel.ts): the engine core playing the two demo tracks from the
 * song's start, and "stress" adding the MVP's worst case (3 tracks × 8 voices × 4 operators, all sounding) to report
 * what a block costs. Step 0 asked whether a worklet running the pure DSP core loads and keeps up in Vite and in
 * Tauri's WKWebView; it now runs the real engine.
 *
 * Loaded with `?worker&url`, so Vite bundles it and the DSP core into one script in dev and in the build alike.
 */
import { FmSynth } from "../dsp/fm";
import { worstCaseSynths } from "../dsp/worstCase";
import { DEMO_TRACKS } from "../demo";
import { EngineCore } from "../engine/core";

// The AudioWorkletGlobalScope, which TypeScript's DOM lib leaves out.
declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

/** Wall clock in ms: performance.now() where the scope has it (Chrome does not), Date.now() otherwise. */
const hasPerformance = typeof (globalThis as { performance?: Performance }).performance?.now === "function";
const now = hasPerformance ? () => performance.now() : () => Date.now();

class SpikeProcessor extends AudioWorkletProcessor {
  private engine = new EngineCore(sampleRate);
  private stress: FmSynth[] = [];
  private stressOn = false;
  private scratch = new Float32Array(128);
  private blocks = 0;
  private renderMs = 0;
  private maxMs = 0;
  private lastReport = 0;
  private peak = 0;

  constructor() {
    super();
    this.engine.describe({ tracks: DEMO_TRACKS, master: 1 });
    this.engine.play(0);
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data?.type === "stress") this.setStress(Boolean(e.data.on));
    };
    this.port.postMessage({ type: "ready", sampleRate, hasPerformance, calibration: this.calibrate() });
  }

  private setStress(on: boolean): void {
    this.stressOn = on;
    // Rendered and thrown away: a CPU load, not music.
    this.stress = on ? worstCaseSynths(sampleRate) : [];
    this.blocks = this.renderMs = this.maxMs = 0;
  }

  /**
   * Cost of one worst-case block, timed over many blocks so Date.now()'s 1 ms grain does not matter. Runs on this
   * very thread and JIT, before any sound is due.
   */
  private calibrate(): { usPerBlock: number; loadPercent: number } {
    const synths = worstCaseSynths(sampleRate);
    const out = new Float32Array(128);
    for (let i = 0; i < 300; i++) for (const s of synths) s.render(out, 0, 128);
    const n = 3000;
    const t0 = now();
    for (let i = 0; i < n; i++) for (const s of synths) s.render(out, 0, 128);
    const us = ((now() - t0) / n) * 1000;
    return { usPerBlock: us, loadPercent: (us / ((128 / sampleRate) * 1e6)) * 100 };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const t0 = now();
    const [left, right = left] = outputs[0];
    const n = left.length;
    this.engine.render(left, right, 0, n);
    if (this.scratch.length < n) this.scratch = new Float32Array(n);
    this.scratch.fill(0);
    for (const synth of this.stress) synth.render(this.scratch, 0, n);

    for (let i = 0; i < n; i++) {
      const a = Math.abs(left[i]);
      if (a > this.peak) this.peak = a;
    }

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
        stress: this.stressOn,
        voices: this.engine.activeVoices() + this.stress.reduce((a, x) => a + x.activeVoices(), 0),
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
