/**
 * Offline soundtrack for the frame-exact video export.
 *
 * Live audio runs on the AudioContext's real-time clock while an export renders frames one by one at whatever pace the
 * scene allows, so a recording of the speakers drifts as soon as a frame takes longer than 1/fps. Timeline-anchored
 * clips don't need the speakers at all: at every frame they are a pure function of the playhead (see clipPlan.ts). So
 * while an export runs, each Audio Player records what it *would* play at that output frame — buffer, plan, level, pan —
 * and once the last frame is in, the whole soundtrack is rebuilt in an OfflineAudioContext, sample-aligned with the
 * frames by construction.
 *
 * Only buffer-backed, frame-anchored clips are captured. Free-running sounds (Play / Trigger), synths and the microphone
 * have no timeline position to replay and are left out of the offline mix.
 */
import type { ClipPlan } from "./clipPlan";
import type { MusicFrame } from "../music/engine/exportMusic";
import { clipDrift } from "./clipPlan";

export interface ClipFrame {
  /** The output frame (export clock), not the timeline frame — Go To Canvas restarts the latter. */
  frame: number;
  buffer: AudioBuffer;
  plan: ClipPlan;
  rate: number;
  loop: boolean;
  level: number;
  pan: number;
}

/** One continuous run of a clip: a single buffer source in the offline mix. */
export interface ClipSegment {
  buffer: AudioBuffer;
  startFrame: number;
  /** Exclusive. */
  endFrame: number;
  offset: number;
  rate: number;
  loop: boolean;
  inPoint: number;
  outPoint: number;
  /** Level and pan at each frame of the segment, index 0 = startFrame. */
  levels: number[];
  pans: number[];
}

interface Capture {
  frame: number;
  /** nodeId → output frame → what the clip did there. A frame evaluated twice (decode retries) keeps the last word. */
  clips: Map<string, Map<number, ClipFrame>>;
  /** Music Out nodes (see music/engine/exportMusic.ts): nodeId → output frame → what it would have played. */
  music: Map<string, Map<number, MusicFrame>>;
}

let capture: Capture | null = null;

export function beginExportAudioCapture(): void {
  capture = { frame: 0, clips: new Map(), music: new Map() };
}

/** Called by the exporter right before it asks for output frame `frame`. */
export function setExportAudioFrame(frame: number): void {
  if (capture) capture.frame = frame;
}

export function isExportAudioCapturing(): boolean {
  return capture !== null;
}

/** Called by an anchored Audio Player while a captured frame is evaluated. */
export function recordClipFrame(nodeId: string, entry: Omit<ClipFrame, "frame">): void {
  if (!capture) return;
  let frames = capture.clips.get(nodeId);
  if (!frames) capture.clips.set(nodeId, (frames = new Map()));
  frames.set(capture.frame, { ...entry, frame: capture.frame });
}

/** Called by a Music Out while a captured frame is evaluated. */
export function recordMusicFrame(nodeId: string, entry: Omit<MusicFrame, "frame">): void {
  if (!capture) return;
  let frames = capture.music.get(nodeId);
  if (!frames) capture.music.set(nodeId, (frames = new Map()));
  frames.set(capture.frame, { ...entry, frame: capture.frame });
}

/** Ends the capture and returns its segments; empty when nothing anchored made a sound. */
export function endExportAudioCapture(fps: number): ClipSegment[] {
  return endExportAudioCaptureWithMusic(fps).segments;
}

/** Ends the capture: the clips' segments, and each Music Out's frames in frame order. */
export function endExportAudioCaptureWithMusic(fps: number): { segments: ClipSegment[]; music: MusicFrame[][] } {
  const done = capture;
  capture = null;
  if (!done) return { segments: [], music: [] };
  const segments: ClipSegment[] = [];
  for (const frames of done.clips.values()) {
    segments.push(...buildSegments([...frames.values()].sort((a, b) => a.frame - b.frame), fps));
  }
  const music = [...done.music.values()].map((frames) => [...frames.values()].sort((a, b) => a.frame - b.frame));
  return { segments, music };
}

/**
 * Groups a clip's frames into continuous runs. A run breaks on a silent or missing frame, a change of file, rate, loop
 * or region, or a jump in the file position larger than half a frame — a timeline loop or a canvas change, which is
 * where the live player would restart its source too.
 */
export function buildSegments(frames: ClipFrame[], fps: number): ClipSegment[] {
  const out: ClipSegment[] = [];
  let cur: ClipSegment | null = null;
  let prev: ClipFrame | null = null;
  const tolerance = 0.5 / fps;
  for (const f of frames) {
    if (!f.plan.active) {
      cur = null;
      prev = null;
      continue;
    }
    const continues =
      cur !== null &&
      prev !== null &&
      f.frame === prev.frame + 1 &&
      f.buffer === cur.buffer &&
      f.rate === cur.rate &&
      f.loop === cur.loop &&
      f.plan.inPoint === cur.inPoint &&
      f.plan.outPoint === cur.outPoint &&
      Math.abs(clipDrift(f.plan.offset, prev.plan.offset + f.rate / fps, cur.inPoint, cur.outPoint, cur.loop)) <= tolerance;
    if (continues && cur) {
      cur.endFrame = f.frame + 1;
      cur.levels.push(f.level);
      cur.pans.push(f.pan);
    } else {
      cur = {
        buffer: f.buffer,
        startFrame: f.frame,
        endFrame: f.frame + 1,
        offset: f.plan.offset,
        rate: f.rate,
        loop: f.loop,
        inPoint: f.plan.inPoint,
        outPoint: f.plan.outPoint,
        levels: [f.level],
        pans: [f.pan],
      };
      out.push(cur);
    }
    prev = f;
  }
  return out;
}

/**
 * Mixes the segments into a stereo AudioBuffer exactly `totalFrames / fps` seconds long — with the music's own
 * soundtrack (already rendered at this rate, from sample 0) when there is one.
 */
export async function renderSegments(
  segments: ClipSegment[],
  totalFrames: number,
  fps: number,
  sampleRate = 48_000,
  music: [Float32Array, Float32Array] | null = null,
): Promise<AudioBuffer> {
  const length = Math.max(1, Math.ceil((totalFrames / fps) * sampleRate));
  const ctx = new OfflineAudioContext(2, length, sampleRate);
  if (music) {
    const buffer = ctx.createBuffer(2, length, sampleRate);
    buffer.copyToChannel(music[0].subarray(0, length) as Float32Array<ArrayBuffer>, 0);
    buffer.copyToChannel(music[1].subarray(0, length) as Float32Array<ArrayBuffer>, 1);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  }
  for (const s of segments) {
    const t0 = s.startFrame / fps;
    const t1 = s.endFrame / fps;
    const source = ctx.createBufferSource();
    source.buffer = s.buffer;
    source.playbackRate.value = s.rate;
    if (s.loop) {
      source.loop = true;
      source.loopStart = s.inPoint;
      source.loopEnd = s.outPoint;
    }
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner();
    // Level and pan step once per frame, as they do live: the graph re-evaluates them every frame and nowhere between.
    s.levels.forEach((v, i) => gain.gain.setValueAtTime(v, t0 + i / fps));
    s.pans.forEach((v, i) => panner.pan.setValueAtTime(v, t0 + i / fps));
    source.connect(gain).connect(panner).connect(ctx.destination);
    source.start(t0, s.offset);
    source.stop(t1);
  }
  return ctx.startRendering();
}
