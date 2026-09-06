import { describe, expect, test, vi } from "vitest";
import { exportPngSequence } from "./imageSequenceExport";
import type { ViewportExportHandle } from "../three/Viewport";

describe("exportPngSequence", () => {
  test("captures every frame and bundles into a zip blob", async () => {
    const fakeCanvas = {
      toBlob: vi.fn((cb: (blob: Blob | null) => void) => {
        cb(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }));
      }),
    } as unknown as HTMLCanvasElement;

    const captureFrame = vi.fn().mockResolvedValue(undefined);
    const handle: ViewportExportHandle = {
      getCanvas: () => fakeCanvas,
      captureFrame,
    };

    const progressUpdates: number[] = [];
    const zipBlob = await exportPngSequence(handle, {
      totalFrames: 3,
      fps: 30,
      onProgress: (done) => progressUpdates.push(done),
    });

    expect(captureFrame).toHaveBeenCalledTimes(3);
    expect(progressUpdates).toEqual([1, 2, 3]);
    expect(zipBlob.type).toBe("application/zip");
    expect(zipBlob.size).toBeGreaterThan(0);
  });
});
