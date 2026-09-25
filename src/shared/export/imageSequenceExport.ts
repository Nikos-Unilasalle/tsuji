import { save as dialogSave } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { isTauri } from "../isTauri";
import type { ViewportExportHandle } from "../three/Viewport";
import { SimpleZipBuilder } from "./zip";

export interface SequenceExportOptions {
  totalFrames: number;
  fps: number;
  onProgress?: (framesDone: number, totalFrames: number) => void;
  isCancelled?: () => boolean;
}

/**
 * Captures the viewport frame by frame as lossless PNGs and bundles them
 * into a single uncompressed ZIP archive.
 *
 * This completely avoids browser/system codec dependencies (such as WebKitGTK's
 * GStreamer backend on Linux or lack of VP9/H.264 profiles), producing clean,
 * sequentially numbered PNGs (frame_0001.png, frame_0002.png, ...) ready for
 * Blender, After Effects, DaVinci Resolve, or CLI stitching via FFmpeg:
 *
 *   ffmpeg -framerate 30 -i frame_%04d.png -c:v libx264 -pix_fmt yuv420p output.mp4
 */
type PngEncoder = { encode: (index: number, source: HTMLCanvasElement) => Promise<Uint8Array>; dispose: () => void; parallelism: number };

/**
 * PNG encoding (~1s for an 1800px frame) dwarfs rendering one, so frames are
 * encoded in a pool of workers (OffscreenCanvas) while the next ones render.
 * Webviews without OffscreenCanvas in workers fall back to the main thread's
 * `toBlob`, still overlapped with rendering.
 */
function createPngEncoder(): PngEncoder {
  const cores = navigator.hardwareConcurrency || 4;
  const canUseWorkers =
    typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap !== "undefined";

  if (canUseWorkers) {
    try {
      const size = Math.max(2, Math.min(8, cores - 1));
      const workers = Array.from(
        { length: size },
        () => new Worker(new URL("./pngEncodeWorker.ts", import.meta.url), { type: "module" }),
      );
      const pending = new Map<number, { resolve: (b: Uint8Array) => void; reject: (e: Error) => void }>();
      for (const worker of workers) {
        worker.onmessage = (e: MessageEvent<{ id: number; buffer?: ArrayBuffer; error?: string }>) => {
          const job = pending.get(e.data.id);
          if (!job) return;
          pending.delete(e.data.id);
          if (e.data.buffer) job.resolve(new Uint8Array(e.data.buffer));
          else job.reject(new Error(e.data.error ?? "PNG encoding failed"));
        };
      }
      let next = 0;
      return {
        parallelism: size,
        encode: async (index, source) => {
          const bitmap = await createImageBitmap(source);
          const worker = workers[next++ % workers.length];
          return new Promise<Uint8Array>((resolve, reject) => {
            pending.set(index, { resolve, reject });
            worker.postMessage({ id: index, bitmap }, [bitmap]);
          });
        },
        dispose: () => workers.forEach((w) => w.terminate()),
      };
    } catch {
      // Fall through to the main-thread encoder.
    }
  }

  return {
    parallelism: Math.max(2, Math.min(6, cores - 1)),
    encode: (index, source) => {
      const snapshot = document.createElement("canvas");
      snapshot.width = source.width;
      snapshot.height = source.height;
      snapshot.getContext("2d")?.drawImage(source, 0, 0);
      return new Promise<Blob>((resolve, reject) => {
        snapshot.toBlob((b) => (b ? resolve(b) : reject(new Error(`Failed to encode PNG for frame ${index + 1}`))), "image/png");
      })
        .then((blob) => blob.arrayBuffer())
        .then((buffer) => new Uint8Array(buffer));
    },
    dispose: () => {},
  };
}

export async function exportPngSequence(
  handle: ViewportExportHandle,
  opts: SequenceExportOptions,
): Promise<Blob> {
  const canvas = handle.getCanvas();
  if (!canvas) throw new Error("Export viewport has no canvas yet");

  const encoder = createPngEncoder();
  const inFlight = new Set<Promise<void>>();
  const encoded: Uint8Array[] = [];
  let done = 0;
  let captured = 0;

  try {
    for (let i = 0; i < opts.totalFrames; i++) {
      if (opts.isCancelled?.()) break;

      await handle.captureFrame(i, opts.fps);
      captured = i + 1;

      // encode() snapshots the canvas before returning control, so the next frame can overwrite it.
      const job = encoder.encode(i, canvas).then((bytes) => {
        encoded[i] = bytes;
        done += 1;
        opts.onProgress?.(done, opts.totalFrames);
      });
      inFlight.add(job);
      const settle = () => inFlight.delete(job);
      job.then(settle, settle);
      if (inFlight.size >= encoder.parallelism) await Promise.race(inFlight);
      // Yield a macrotask so UI updates stay responsive
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all(inFlight);
  } finally {
    encoder.dispose();
  }

  const zip = new SimpleZipBuilder();
  for (let i = 0; i < captured; i++) {
    zip.addFile(`frame_${String(i + 1).padStart(4, "0")}.png`, encoded[i]);
  }
  return zip.buildBlob();
}

/**
 * Saves an exported ZIP file via the native save dialog (Tauri) or browser download.
 */
export async function saveZipBlob(blob: Blob, suggestedFilename: string): Promise<string | null> {
  if (!isTauri()) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = suggestedFilename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return suggestedFilename;
  }

  const filePath = await dialogSave({
    defaultPath: suggestedFilename,
    filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
  });
  if (!filePath) return null;

  const buffer = new Uint8Array(await blob.arrayBuffer());
  await writeFile(filePath, buffer);
  const parts = filePath.split(/[\/\\]/);
  return parts[parts.length - 1] || suggestedFilename;
}
