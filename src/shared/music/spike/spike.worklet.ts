/**
 * Step 0 of the music nodes (docs/music-nodes-mvp.md): does an AudioWorklet running the pure FM core load and keep up,
 * in Vite and in Tauri's WKWebView? Plays two sequenced tracks — an arpeggiated chord progression and a gliding bass —
 * through the mixer, every note-on and note-off on its exact sample (a first sketch of the step 3 engine); "stress"
 * adds the MVP's worst case (3 tracks × 8 voices × 4 operators, all sounding) and reports what a block costs.
 *
 * Loaded with `?worker&url`, so Vite bundles it (and the DSP core) into one script in dev and in the build alike.
 */
import { EPIANO_PATCH, FmSynth } from "../dsp/fm";
import { Mixer } from "../dsp/mix";
import { worstCaseSynths } from "../dsp/worstCase";
import { DEFAULT_ARP } from "../seq/arp";
import { Clock, NoteEvent, Sequence, notesStartingIn } from "../seq/sequencer";

// The AudioWorkletGlobalScope, which TypeScript's DOM lib leaves out.
declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

const CLOCK: Clock = { bpm: 112, swing: 0.3, stepsPerBeat: 4 };

/** Cmaj7 – Am7 – Fmaj7 – G7, one bar each, arpeggiated up and down over two octaves. */
const CHORDS: Sequence = {
  clock: CLOCK,
  pattern: {
    length: 64,
    steps: Object.assign(Array<null>(64).fill(null), {
      0: { note: 60, chord: "maj7" },
      16: { note: 57, chord: "min7", inversion: 1 },
      32: { note: 53, chord: "maj7", inversion: 1 },
      48: { note: 55, chord: "7" },
    }),
  },
  arp: { ...DEFAULT_ARP, mode: "updown", octaves: 2, gate: 0.6 },
};

/** The roots an octave and a half down, gliding into each new bar, with a ratchet before the turnaround. */
const BASS: Sequence = {
  clock: CLOCK,
  pattern: {
    length: 64,
    steps: Object.assign(Array<null>(64).fill(null), {
      0: { note: 36, velocity: 1 },
      10: { note: 43, velocity: 0.6 },
      16: { note: 33, fx: { type: "GLD", value: 12 } },
      26: { note: 40, velocity: 0.6 },
      32: { note: 29, fx: { type: "GLD", value: 12 } },
      42: { note: 36, velocity: 0.6 },
      48: { note: 31, fx: { type: "GLD", value: 12 } },
      60: { note: 31, fx: { type: "RTG", value: 3 } },
      63: { note: "off" },
    }),
  },
};

interface Track {
  synth: FmSynth;
  seq: Sequence;
  /** Notes started and not yet ended: their note-off, as a song sample. */
  offs: { at: number; note: number }[];
}

/** Wall clock in ms: performance.now() where the scope has it (Chrome does not), Date.now() otherwise. */
const hasPerformance = typeof (globalThis as { performance?: Performance }).performance?.now === "function";
const now = hasPerformance ? () => performance.now() : () => Date.now();

class SpikeProcessor extends AudioWorkletProcessor {
  private tracks: Track[] = [];
  private mixer = new Mixer(sampleRate);
  /** The song's sample 0, in the context's frames. */
  private origin = -1;
  private stress: FmSynth[] = [];
  private scratch = new Float32Array(128);
  private blocks = 0;
  private renderMs = 0;
  private maxMs = 0;
  private lastReport = 0;
  private peak = 0;

  constructor() {
    super();
    for (const [seq, pan, level] of [
      [CHORDS, -0.35, 0.7],
      [BASS, 0.2, 0.9],
    ] as const) {
      const synth = new FmSynth(8, sampleRate);
      synth.setPatch(EPIANO_PATCH);
      this.mixer.addChannel(synth, { level, pan, mute: false });
      this.tracks.push({ synth, seq, offs: [] });
    }
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

    // What the sequencer has for this block: note-ons, and the note-offs of notes already playing. Offs first on a
    // shared sample, so a note that ends where it starts again is let go before it is struck.
    if (this.origin < 0) this.origin = currentFrame;
    const t = currentFrame - this.origin;
    const due: { at: number; off: boolean; track: Track; e: NoteEvent | null; note: number }[] = [];
    for (const track of this.tracks) {
      for (const e of notesStartingIn(track.seq, sampleRate, t, t + n)) due.push({ at: e.on - t, off: false, track, e, note: e.note });
      for (const o of track.offs) if (o.at < t + n) due.push({ at: o.at - t, off: true, track, e: null, note: o.note });
      track.offs = track.offs.filter((o) => o.at >= t + n);
    }
    due.sort((a, b) => a.at - b.at || Number(b.off) - Number(a.off));

    // Render up to each event, so every note starts and ends on its exact sample.
    let s = 0;
    let k = 0;
    while (s < n) {
      while (k < due.length && due[k].at <= s) {
        const d = due[k++];
        if (d.off) d.track.synth.noteOff(d.note);
        else {
          const e = d.e!;
          d.track.synth.noteOn(e.note, e.velocity, e.glideFrom === undefined ? undefined : { from: e.glideFrom, seconds: e.glideSeconds ?? 0 });
          if (e.off < t + n) insertSorted(due, k, { at: e.off - t, off: true, track: d.track, e: null, note: e.note });
          else d.track.offs.push({ at: e.off, note: e.note });
        }
      }
      const until = k < due.length ? Math.min(n, due[k].at) : n;
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
        voices: this.tracks.reduce((a, x) => a + x.synth.activeVoices(), 0) + this.stress.reduce((a, x) => a + x.activeVoices(), 0),
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

/** Puts an event into the (sorted) list at or after index `from`, offs before ons on the same sample. */
function insertSorted<T extends { at: number; off: boolean }>(list: T[], from: number, item: T): void {
  let i = from;
  while (i < list.length && (list[i].at < item.at || (list[i].at === item.at && list[i].off))) i++;
  list.splice(i, 0, item);
}

registerProcessor("tsuji-music-spike", SpikeProcessor);
