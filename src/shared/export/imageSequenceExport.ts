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
export async function exportPngSequence(
  handle: ViewportExportHandle,
  opts: SequenceExportOptions,
): Promise<Blob> {
  const canvas = handle.getCanvas();
  if (!canvas) throw new Error("Export viewport has no canvas yet");

  const zip = new SimpleZipBuilder();

  for (let i = 0; i < opts.totalFrames; i++) {
    if (opts.isCancelled?.()) break;

    await handle.captureFrame(i, opts.fps);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error(`Failed to encode PNG for frame ${i + 1}`));
      }, "image/png");
    });

    const buffer = new Uint8Array(await blob.arrayBuffer());
    const frameIndexStr = String(i + 1).padStart(4, "0");
    zip.addFile(`frame_${frameIndexStr}.png`, buffer);

    opts.onProgress?.(i + 1, opts.totalFrames);
    // Yield a macrotask so UI updates stay responsive
    await new Promise((r) => setTimeout(r, 0));
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
