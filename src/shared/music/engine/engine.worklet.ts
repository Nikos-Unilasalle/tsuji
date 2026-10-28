/**
 * The music engine's AudioWorklet: EngineCore (core.ts) on the audio thread. The page tells it what to play
 * ("describe", only when the description changed) and where the playhead is ("follow", every frame); it answers with
 * its own state a few times a second.
 *
 * Loaded with `?worker&url` (see bridge.ts), so Vite bundles it and the DSP core into one script.
 */
import { EngineCore } from "./core";
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

const REPORT_SECONDS = 0.25;

class MusicEngineProcessor extends AudioWorkletProcessor {
  private core = new EngineCore(sampleRate);
  private lastReport = -Infinity;

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
    if (currentTime - this.lastReport >= REPORT_SECONDS) {
      this.lastReport = currentTime;
      const state: EngineState = { type: "state", playing: this.core.isPlaying, position: this.core.position, at: currentTime, voices: this.core.activeVoices(), jumps: this.core.jumps };
      this.port.postMessage(state);
    }
    return true;
  }
}

registerProcessor("tsuji-music-engine", MusicEngineProcessor);
