/**
 * The music engine's AudioWorklet: EngineCore (core.ts) on the audio thread. The page tells it what to play
 * ("describe", only when the description changed) and where the playhead is ("follow", every frame); it answers with
 * its own state a few times a second.
 *
 * Loaded with `?worker&url` (see bridge.ts), so Vite bundles it and the DSP core into one script.
 */
import { EngineCore } from "./core";
import { LoudnessMeter } from "../dsp/loudness";
import type { MusicDescription, PreviewSound } from "./description";

// The AudioWorkletGlobalScope, which TypeScript's DOM lib leaves out.
declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

export type EngineMessage =
  | { type: "describe"; desc: MusicDescription }
  /**
   * `wanted`: the song sample the playhead was on at context time `at`. The engine adds the time the message took to
   * arrive, so the frame loop's latency does not count as drift.
   */
  | { type: "follow"; playing: boolean; wanted: number; at: number; tolerance: number }
  | { type: "preview"; sound: PreviewSound; note: number; velocity: number };

export interface EngineState {
  type: "state";
  playing: boolean;
  /** Song sample… */
  position: number;
  /** …at this context time. */
  at: number;
  voices: number;
  /** Times the engine had to jump to the playhead (see EngineCore.jumps). */
  jumps: number;
}

/** The meters, fast enough for a needle to move (see the Mixing Console). */
export interface EngineMeters {
  type: "meters";
  /** Context time of the reading. */
  at: number;
  /** Per track id: [peak, rms], linear, post-fader. */
  channels: Record<string, [number, number]>;
  /** The master after the soft clip: [peakL, peakR, rmsL, rmsR]. */
  master: [number, number, number, number];
  /** Samples the master pushed past ±1 since the last reading. */
  clipped: number;
  /** BS.1770 loudness of the master, in LUFS: momentary, short-term, integrated (since the transport last started). */
  lufs: [number, number, number];
}

const REPORT_SECONDS = 0.25;
const METER_SECONDS = 1 / 40;

class MusicEngineProcessor extends AudioWorkletProcessor {
  private core = new EngineCore(sampleRate);
  private lastReport = -Infinity;
  private lastMeters = -Infinity;
  private loudness = new LoudnessMeter(sampleRate);
  private wasPlaying = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<EngineMessage>) => {
      const m = e.data;
      if (m.type === "describe") this.core.describe(m.desc);
      else if (m.type === "preview") this.core.previewNote(m.sound, m.note, m.velocity);
      else if (m.type === "follow") {
        const late = m.playing ? Math.max(0, currentTime - m.at) * sampleRate : 0;
        this.core.follow(m.playing, m.wanted + late, m.tolerance);
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [left, right] = outputs[0];
    if (!left) return true;
    const r = right ?? new Float32Array(left.length);
    this.core.render(left, r, 0, left.length);
    // A new run measures from scratch: the integrated loudness is the song's from where Play was pressed.
    if (this.core.isPlaying && !this.wasPlaying) this.loudness.reset();
    this.wasPlaying = this.core.isPlaying;
    if (this.core.isPlaying) this.loudness.process(left, r, 0, left.length);
    if (currentTime - this.lastMeters >= METER_SECONDS) {
      this.lastMeters = currentTime;
      const m = this.core.takeMeters();
      const channels: Record<string, [number, number]> = {};
      for (const id in m.channels) channels[id] = [m.channels[id].peak, m.channels[id].rms];
      const l = this.loudness.reading();
      const meters: EngineMeters = {
        type: "meters",
        at: currentTime,
        channels,
        master: [m.left.peak, m.right.peak, m.left.rms, m.right.rms],
        clipped: m.clipped,
        lufs: [l.momentary, l.shortTerm, l.integrated],
      };
      this.port.postMessage(meters);
    }
    if (currentTime - this.lastReport >= REPORT_SECONDS) {
      this.lastReport = currentTime;
      const state: EngineState = { type: "state", playing: this.core.isPlaying, position: this.core.position, at: currentTime, voices: this.core.activeVoices(), jumps: this.core.jumps };
      this.port.postMessage(state);
    }
    return true;
  }
}

registerProcessor("tsuji-music-engine", MusicEngineProcessor);
