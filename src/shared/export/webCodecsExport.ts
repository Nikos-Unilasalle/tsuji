import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type OutputFormat,
  type VideoCodec,
} from "mediabunny";
import {
  beginExportAudioCapture,
  endExportAudioCapture,
  renderSegments,
  setExportAudioFrame,
} from "../audio/exportAudioCapture";
import type { ViewportExportHandle } from "../three/Viewport";
import type { VideoExportOptions } from "./videoExport";

/**
 * True when this webview can run the frame-exact encoder at all. Codec support is probed later, against the real size.
 */
export function supportsWebCodecsExport(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined" && typeof OfflineAudioContext !== "undefined";
}

/**
 * MP4 when the webview can encode a codec MP4 carries, WebM otherwise — the same preference as the MediaRecorder path,
 * but decided by `VideoEncoder.isConfigSupported` for the actual export size instead of a mime-type guess.
 */
async function pickFormat(width: number, height: number): Promise<{ format: OutputFormat; codec: VideoCodec } | null> {
  const bitrate = 12_000_000;
  const mp4 = new Mp4OutputFormat({ fastStart: "in-memory" });
  const mp4Codec = await getFirstEncodableVideoCodec(["avc", "hevc", "vp9", "av1"], { width, height, bitrate });
  if (mp4Codec) return { format: mp4, codec: mp4Codec };
  const webm = new WebMOutputFormat();
  const webmCodec = await getFirstEncodableVideoCodec(["vp9", "vp8", "av1"], { width, height, bitrate });
  return webmCodec ? { format: webm, codec: webmCodec } : null;
}

/**
 * How many samples of silence this platform's AAC encoder puts in front of the audio (its "priming" — 2112 on macOS
 * and Chrome, but not guaranteed). WebCodecs doesn't report it and Mediabunny writes the timestamps it's given, so an
 * uncompensated file plays its sound ~44 ms late. Measured once: encode a click, decode it, see where it lands.
 */
let aacDelayCache: Promise<number> | null = null;
function measureAacDelay(sampleRate: number, numberOfChannels: number): Promise<number> {
  return (aacDelayCache ??= (async () => {
    if (typeof AudioEncoder === "undefined" || typeof AudioDecoder === "undefined") return 0;
    const codec = "mp4a.40.2";
    const chunks: EncodedAudioChunk[] = [];
    let description: AllowSharedBufferSource | undefined;
    const encoder = new AudioEncoder({
      output: (chunk, meta) => {
        chunks.push(chunk);
        description ??= meta?.decoderConfig?.description;
      },
      error: () => {},
    });
    encoder.configure({ codec, sampleRate, numberOfChannels, bitrate: 128_000 });
    const length = sampleRate / 4;
    const clickAt = Math.round(sampleRate / 10);
    const pcm = new Float32Array(length * numberOfChannels);
    for (let c = 0; c < numberOfChannels; c++) pcm[c * length + clickAt] = 1;
    encoder.encode(new AudioData({ format: "f32-planar", sampleRate, numberOfFrames: length, numberOfChannels, timestamp: 0, data: pcm }));
    await encoder.flush();
    encoder.close();

    const decoded: Float32Array[] = [];
    const decoder = new AudioDecoder({
      output: (data) => {
        const ch = new Float32Array(data.numberOfFrames);
        data.copyTo(ch, { planeIndex: 0, format: "f32-planar" });
        decoded.push(ch);
        data.close();
      },
      error: () => {},
    });
    decoder.configure({ codec, sampleRate, numberOfChannels, description });
    chunks.forEach((c) => decoder.decode(c));
    await decoder.flush();
    decoder.close();

    let peak = -1;
    let peakValue = 0;
    let i = 0;
    for (const block of decoded) for (const v of block) {
      if (Math.abs(v) > peakValue) [peak, peakValue] = [i, Math.abs(v)];
      i++;
    }
    return peak > clickAt ? peak - clickAt : 0;
  })().catch(() => 0));
}

/**
 * Frame-exact video export on WebCodecs, muxed by Mediabunny.
 *
 * Every frame is encoded with its own timestamp (`i / fps`), so the file's timing no longer depends on the render keeping
 * up with real time: a heavy scene simply takes longer to export, it doesn't drop, duplicate or drift. No 1/fps pacing
 * either — the loop only waits on the encoder's backpressure, so a light scene exports faster than real time.
 *
 * Audio comes from the offline capture (see exportAudioCapture.ts): timeline-anchored clips are replayed in an
 * OfflineAudioContext after the last frame, sample-aligned with the video. Free-running sounds aren't in it.
 *
 * Returns null when the webview can't encode any usable codec at this size — the caller falls back to MediaRecorder.
 */
export async function exportVideoWebCodecs(
  handle: ViewportExportHandle,
  opts: VideoExportOptions,
): Promise<Blob | null> {
  const canvas = handle.getCanvas();
  if (!canvas) throw new Error("Export viewport has no canvas yet");

  const includeAudio = opts.includeAudio !== false;
  if (includeAudio) beginExportAudioCapture();
  try {
    // First render sets the canvas to its final size (Render node resolution) — see exportVideo.
    setExportAudioFrame(0);
    await handle.captureFrame(0, opts.fps);

    const picked = await pickFormat(canvas.width, canvas.height);
    if (!picked) return null;
    const { format, codec } = picked;

    const output = new Output({ format, target: new BufferTarget() });
    const video = new CanvasSource(canvas, {
      codec,
      bitrate: opts.videoBitsPerSecond ?? 12_000_000,
      // Constant frame rate output: one keyframe every 2 s keeps seeking snappy in editors.
      keyFrameInterval: 2,
    });
    output.addVideoTrack(video, { frameRate: opts.fps });

    // The audio track has to be declared before start(), but its content only exists once every frame has been
    // evaluated. Mediabunny holds the video packets in memory until the audio catches up — fine with an in-memory target.
    const audioCodec = includeAudio
      ? await getFirstEncodableAudioCodec(format.getSupportedAudioCodecs(), { numberOfChannels: 2, sampleRate: 48_000 })
      : null;
    // No audio encoder here (older WebKit has VideoEncoder but no AudioEncoder): a silent file would be a regression
    // over MediaRecorder, which does carry the sound — hand over to it.
    if (includeAudio && !audioCodec) return null;
    const audio = audioCodec ? new AudioSampleSource({ codec: audioCodec, bitrate: 192_000 }) : null;
    if (audio) output.addAudioTrack(audio);

    await output.start();

    const duration = 1 / opts.fps;
    let framesDone = 0;
    for (let i = 0; i < opts.totalFrames; i++) {
      if (opts.isCancelled?.()) break;
      if (i > 0) {
        setExportAudioFrame(i);
        await handle.captureFrame(i, opts.fps);
      }
      await video.add(i * duration, duration);
      framesDone = i + 1;
      opts.onProgress?.(framesDone, opts.totalFrames);
    }
    video.close();

    if (audio) {
      const segments = endExportAudioCapture(opts.fps);
      // Always write the track once declared — an empty (silent) one is valid, a declared-but-missing one is not.
      const mix = await renderSegments(segments, Math.max(1, framesDone), opts.fps);
      // Start the audio early by the encoder's priming: Mediabunny turns the negative start into an edit list that
      // trims the priming off, so the first real sample plays at 0 and every clip lands on its frame.
      const delay = audioCodec === "aac" ? await measureAacDelay(mix.sampleRate, mix.numberOfChannels) : 0;
      for (const sample of AudioSample.fromAudioBuffer(mix, -delay / mix.sampleRate)) {
        await audio.add(sample);
        sample.close();
      }
      audio.close();
    }

    await output.finalize();
    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) throw new Error("Encoder produced no data");
    return new Blob([buffer], { type: format.mimeType });
  } finally {
    // Idempotent: an early return or a throw must not leave nodes recording into the next export.
    endExportAudioCapture(opts.fps);
  }
}
