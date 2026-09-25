import { save as dialogSave } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { getAudioExportStream } from "../audio/audioStore";
import { isTauri } from "../graph/storage";
import type { ViewportExportHandle } from "../three/Viewport";

/**
 * MP4 first, WebM as the universal fallback. `MediaRecorder` can't be told
 * "give me MP4 or fail" — it silently no-ops on an unsupported mimeType — so
 * every candidate has to be probed with `isTypeSupported` and the first hit
 * wins. WebKit (Tauri's webview on macOS) supports `video/mp4` directly;
 * Chromium-based webviews (Windows/Linux) generally don't, so those exports
 * land as WebM instead — same content, container the platform can actually
 * produce, rather than pretending every platform can write MP4 today.
 */
const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

export function pickSupportedMimeType(): string {
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? "video/webm";
}

export function mimeToExtension(mime: string): string {
  return mime.startsWith("video/mp4") ? "mp4" : "webm";
}

export interface VideoExportOptions {
  totalFrames: number;
  fps: number;
  /** Roughly how much of the bitrate budget to spend — higher is better quality, bigger files. */
  videoBitsPerSecond?: number;
  onProgress?: (framesDone: number, totalFrames: number) => void;
  /** Polled between frames; return true to stop early (partial file is still returned). */
  isCancelled?: () => boolean;
  /**
   * Merge the graph's live audio into the recording (default true). The audio
   * runs on real time while the frames are rendered one by one, so it stays in
   * sync only as long as the export holds its 1/fps pace — set false for a
   * heavy scene where a silent video beats a drifting soundtrack.
   */
  includeAudio?: boolean;
}

/**
 * Drives a `ViewportExportHandle` through every frame of the animation and
 * returns the encoded video as a Blob.
 *
 * Frames are captured in "manual" mode — `canvas.captureStream(0)` emits
 * nothing on its own, only when `track.requestFrame()` is called — so the
 * output's frame timing comes from `captureFrame`'s deterministic clock
 * override, not from whatever cadence the encoder or the browser's real-time
 * scheduler would otherwise pick. That's what makes this an accurate
 * frame-by-frame render rather than a screen recording of the live preview.
 */
export async function exportVideo(
  handle: ViewportExportHandle,
  opts: VideoExportOptions,
): Promise<Blob> {
  const canvas = handle.getCanvas();
  if (!canvas) throw new Error("Export viewport has no canvas yet");
  if (typeof (canvas as any).captureStream !== "function") {
    throw new Error("This browser/webview can't capture a canvas as a video stream");
  }

  // The export canvas takes its final size from the first rendered frame (the
  // Render node's resolution, or a 2D texture's native size). Render one
  // before opening the stream: an encoder started at the placeholder size
  // doesn't survive the resolution change.
  await handle.captureFrame(0, opts.fps);

  const stream = (canvas as HTMLCanvasElement & { captureStream(fps: number): MediaStream }).captureStream(opts.fps);
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };

  // The graph's sound nodes feed a shared bus (audioStore's getAudioOutput),
  // which also runs into a MediaStreamDestination — merging its track here is
  // what puts audio in the file. Skipped when the graph makes no sound at all,
  // so a silent project doesn't get a pointless empty track. Note that the
  // audio is captured in real time while the frames are not, so it only lines
  // up when the export keeps its 1/fps pace; a scene too heavy to render at
  // rate will drift, which is why it can be turned off.
  let audioTrack: MediaStreamTrack | null = null;
  if (opts.includeAudio !== false) {
    const audioStream = getAudioExportStream();
    audioTrack = audioStream?.getAudioTracks()[0] ?? null;
    if (audioTrack) stream.addTrack(audioTrack);
  }

  const mimeType = pickSupportedMimeType();
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: opts.videoBitsPerSecond ?? 12_000_000,
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = (e) => reject((e as any).error ?? new Error("MediaRecorder error"));
  });

  recorder.start();

  // Pace the loop to the target fps and wait a real frame's worth between
  // captures. captureFrame() hands a freshly-rendered canvas to the
  // MediaRecorder, which encodes on its own schedule; a `setTimeout(0)` lets
  // the encoder *start* but makes no guarantee the frame is actually consumed
  // before the next one overwrites the canvas — dropping/duplicating frames,
  // worst on busy VP9/WebM encoders. Pacing on real time (1/fps per frame) is
  // the only reliable way to keep the stream frame-accurate.
  const frameIntervalMs = 1000 / opts.fps;

  for (let i = 0; i < opts.totalFrames; i++) {
    if (opts.isCancelled?.()) break;

    const frameCapturedAt = Date.now();
    await handle.captureFrame(i, opts.fps);
    // requestFrame() is the "manual" captureStream mode's own API — it forces
    // an immediate frame to be handed to the recorder rather than waiting for
    // its next automatic tick.
    track.requestFrame?.();
    opts.onProgress?.(i + 1, opts.totalFrames);

    const elapsed = Date.now() - frameCapturedAt;
    const remain = frameIntervalMs - elapsed;
    if (remain > 0) {
      await new Promise((r) => setTimeout(r, remain));
    } else {
      // Logging/encode time already exceeded the frame budget; yield a
      // macrotask so the recorder's pipeline can at least flush the frame.
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  recorder.stop();
  await stopped;
  // Stop the canvas track, but only *detach* the audio one: its MediaStreamTrack
  // belongs to the shared MediaStreamDestination, and stopping it would leave
  // every later export silent.
  if (audioTrack) stream.removeTrack(audioTrack);
  stream.getTracks().forEach((t) => t.stop());

  return new Blob(chunks, { type: mimeType });
}

/**
 * Save an exported video via the native save dialog (Tauri) or a browser
 * download (dev/web) — same isTauri() split storage.ts already uses for
 * project files. Returns the saved filename, or null if the user cancelled.
 */
export async function saveVideoBlob(blob: Blob, suggestedFilename: string): Promise<string | null> {
  const extension = mimeToExtension(blob.type);

  if (!isTauri()) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = suggestedFilename;
    a.click();
    // Revoking synchronously races the browser's own read of the blob — the
    // download silently fails on a large file in several engines. One turn of
    // the event loop plus a grace period is enough for the fetch to start.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return suggestedFilename;
  }

  const filePath = await dialogSave({
    defaultPath: suggestedFilename,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  });
  if (!filePath) return null;

  const buffer = new Uint8Array(await blob.arrayBuffer());
  await writeFile(filePath, buffer);
  const parts = filePath.split(/[\/\\]/);
  return parts[parts.length - 1] || suggestedFilename;
}
