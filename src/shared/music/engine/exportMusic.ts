/**
 * The music in a frame-exact video export (step 6, docs/music-nodes-mvp.md).
 *
 * While the exporter captures frames, each Music Out records, per output frame, what it would hand its engine live:
 * the description and where the playhead puts the song (exportAudioCapture.ts keeps them, beside the Audio Players'
 * clips). After the last frame, this replays them through the same EngineCore the AudioWorklet runs, frame by frame
 * — each frame's samples rendered after that frame's description and playhead are applied — so the soundtrack is the
 * song the preview plays, sample-aligned with the video by construction. The engine keeps its own exact clock and
 * only jumps where the playhead does (a timeline that loops inside the export, a canvas change), as live.
 */
import { EngineCore } from "./core";
import type { MusicDescription } from "./description";

export interface MusicFrame {
  /** The output frame (export clock). */
  frame: number;
  desc: MusicDescription;
  /** Where the playhead puts the song at this frame, in seconds (negative before Music Out's Start Frame). */
  songTime: number;
  playing: boolean;
}

/** Where output frame f begins, in samples — rounded per frame, so frames never drift from the samples. */
const frameStart = (f: number, fps: number, sampleRate: number) => Math.round((f * sampleRate) / fps);

/**
 * One Music Out's frames → its stereo soundtrack, `totalFrames / fps` seconds long. A frame missing from the capture
 * keeps the last one's settings and lets the song run on.
 */
export function renderMusicFrames(frames: readonly MusicFrame[], totalFrames: number, fps: number, sampleRate: number): [Float32Array, Float32Array] {
  const length = Math.max(1, Math.ceil((totalFrames / fps) * sampleRate));
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const byFrame = new Map(frames.map((f) => [f.frame, f]));
  const engine = new EngineCore(sampleRate);
  // Half a frame: the rounding of frames to samples never counts as a jump, a real one always does.
  const tolerance = sampleRate / fps / 2;
  let lastDesc: MusicDescription | null = null;
  for (let f = 0; f < totalFrames; f++) {
    const mf = byFrame.get(f);
    if (mf) {
      if (mf.desc !== lastDesc) {
        engine.describe(mf.desc);
        lastDesc = mf.desc;
      }
      engine.follow(mf.playing, Math.max(0, Math.round(mf.songTime * sampleRate)), tolerance);
    }
    const s0 = frameStart(f, fps, sampleRate);
    const s1 = Math.min(length, frameStart(f + 1, fps, sampleRate));
    if (s1 > s0) engine.render(left, right, s0, s1 - s0);
  }
  // The last frame's own samples run to the buffer's end (its length was rounded up).
  const tail = frameStart(totalFrames, fps, sampleRate);
  if (tail < length) engine.render(left, right, tail, length - tail);
  return [left, right];
}

/** Every Music Out's soundtrack summed; null when no Music Out played during the export. */
export function renderExportMusic(perNode: readonly (readonly MusicFrame[])[], totalFrames: number, fps: number, sampleRate: number): [Float32Array, Float32Array] | null {
  if (perNode.length === 0) return null;
  let mix: [Float32Array, Float32Array] | null = null;
  for (const frames of perNode) {
    const [l, r] = renderMusicFrames(frames, totalFrames, fps, sampleRate);
    if (!mix) mix = [l, r];
    else
      for (let i = 0; i < l.length; i++) {
        mix[0][i] += l[i];
        mix[1][i] += r[i];
      }
  }
  return mix;
}
