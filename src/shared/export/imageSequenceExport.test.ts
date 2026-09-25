import { afterEach, describe, expect, test, vi } from "vitest";
import { exportPngSequence } from "./imageSequenceExport";
import type { ViewportExportHandle } from "../three/Viewport";

/** A canvas stand-in whose toBlob encodes the frame index it was last drawn with, after `delays[index]` ms. */
function fakeCanvasFactory(delays: number[]) {
  let current = 0;
  const source = { width: 4, height: 4 } as unknown as HTMLCanvasElement;
  const createElement = () => {
    let drawn = -1;
    return {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => (drawn = current), clearRect: () => {} }),
      toBlob: (cb: (blob: Blob | null) => void) => {
        const index = drawn;
        setTimeout(() => cb(new Blob([new Uint8Array([137, 80, 78, 71, index])], { type: "image/png" })), delays[index] ?? 0);
      },
    };
  };
  return { source, createElement, setFrame: (i: number) => (current = i) };
}

describe("exportPngSequence", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("captures every frame and bundles them into a zip in frame order, even when encodes finish out of order", async () => {
    const fake = fakeCanvasFactory([30, 0, 10]);
    vi.stubGlobal("document", { createElement: fake.createElement });

    const captureFrame = vi.fn(async (i: number) => {
      fake.setFrame(i);
    });
    const handle: ViewportExportHandle = { getCanvas: () => fake.source, captureFrame };

    const progressUpdates: number[] = [];
    const zipBlob = await exportPngSequence(handle, {
      totalFrames: 3,
      fps: 30,
      onProgress: (done) => progressUpdates.push(done),
    });

    expect(captureFrame).toHaveBeenCalledTimes(3);
    expect(progressUpdates).toEqual([1, 2, 3]);
    expect(zipBlob.type).toBe("application/zip");

    // Each fake PNG ends with its frame index; they must appear as frame_0001..0003 in order.
    const bytes = new Uint8Array(await zipBlob.arrayBuffer());
    const text = new TextDecoder("latin1").decode(bytes);
    const order = ["frame_0001.png", "frame_0002.png", "frame_0003.png"].map((name) => {
      const at = text.indexOf(name) + name.length;
      return bytes[at + 4];
    });
    expect(order).toEqual([0, 1, 2]);
  });
});
