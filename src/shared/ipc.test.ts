import { beforeAll, describe, expect, it } from "vitest";
import { emptyGraph } from "./graph/types";
import { GraphPayload, startReceiving } from "./ipc";

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("ipc camera updates (browser channel)", () => {
  beforeAll(() => {
    // The browser build's channel is only opened where there is a window.
    (globalThis as { window?: unknown }).window ??= globalThis;
  });

  it("moves the camera without rebuilding the graph", async () => {
    const received: GraphPayload[] = [];
    const stop = startReceiving((payload) => received.push(payload));
    // The editor window's side of the channel.
    const editor = new BroadcastChannel("tsuji_ipc");
    const pose = (x: number) => ({ position: [x, 0, 0], quaternion: [0, 0, 0, 1] });

    editor.postMessage({ event: "camera:update", pose: pose(1) });
    await nextTick();
    // Nothing to attach a pose to before the first graph arrives.
    expect(received).toHaveLength(0);

    const payload = { graph: emptyGraph(), epochMs: 0, calibratingNodeId: null, previewCamera: null };
    editor.postMessage({ event: "graph:update", payload });
    await nextTick();
    editor.postMessage({ event: "camera:update", pose: pose(4) });
    await nextTick();
    stop();
    editor.close();

    expect(received).toHaveLength(2);
    expect(received[1].graph).toBe(received[0].graph);
    expect(received[1].previewCamera?.position).toEqual([4, 0, 0]);
  });
});
