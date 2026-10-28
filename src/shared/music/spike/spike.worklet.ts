/**
 * Step 0 of the music nodes (docs/music-nodes-mvp.md): does an AudioWorklet running the pure FM core load and keep up,
 * in Vite and in Tauri's WKWebView? Plays a Cmaj9 arpeggio on the electric piano patch, scheduled to the sample;
 * "stress" adds the MVP's worst case (3 tracks × 8 voices × 4 operators, all sounding) and reports what a block costs.
 *
 * Loaded with `?worker&url`, so Vite bundles it (and the DSP core) into one script in dev and in the build alike.
 */
import { EPIANO_PATCH, FmSynth } from "../dsp/fm";
import { Mixer } from "../dsp/mix";
import { worstCaseSynths } from "../dsp/worstCase";

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

/** Wall clock in ms: performance.now() where the scope has it (Chrome does not), Date.now() otherwise. */
const hasPerformance = typeof (globalThis as { performance?: Performance }).performance?.now === "function";
const now = hasPerformance ? () => performance.now() : () => Date.now();

class SpikeProcessor extends AudioWorkletProcessor {
  private lead = new FmSynth(8, sampleRate);
  private mixer = new Mixer(sampleRate);
  private stress: FmSynth[] = [];
  private scratch = new Float32Array(128);
  private stepSamples = Math.round((60 / BPM / 4) * sampleRate); // 1/16
  private nextStep = -1;
  private step = 0;
  private lastNote = -1;
  private blocks = 0;
  private renderMs = 0;
  private maxMs = 0;
  private lastReport = 0;
  private peak = 0;

  constructor() {
    super();
    this.lead.setPatch(EPIANO_PATCH);
    this.mixer.addChannel(this.lead, { level: 0.8, pan: 0, mute: false });
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data?.type === "stress") this.setStress(Boolean(e.data.on));
    };
    this.port.postMessage({ type: "ready", sampleRate, hasPerformance, calibration: this.calibrate() });
  }

  private stressOn = false;

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

    // Render up to each note-on inside the block, so every note starts on its exact sample.
    if (this.nextStep < 0) this.nextStep = currentFrame;
    let s = 0;
    while (s < n) {
      const due = this.nextStep - currentFrame;
      if (due <= s) {
        if (this.lastNote >= 0) this.lead.noteOff(this.lastNote);
        this.lastNote = 60 + ARP[this.step % ARP.length];
        this.lead.noteOn(this.lastNote, 0.75);
        this.step++;
        this.nextStep += this.stepSamples;
        continue;
      }
      const until = due < n ? due : n;
      this.mixer.render(left, right, s, until - s);
      if (this.scratch.length < n) this.scratch = new Float32Array(n);
      this.scratch.fill(0, s, until);
      for (const synth of this.stress) synth.render(this.scratch, s, until - s);
      s = until;
    }

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
        voices: this.lead.activeVoices() + this.stress.reduce((a, x) => a + x.activeVoices(), 0),
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
