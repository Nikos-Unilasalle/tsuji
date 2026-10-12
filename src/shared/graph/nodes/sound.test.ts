import { describe, expect, it } from "vitest";
import { anchoredClipPosition, AUDIO_PLAYER_NODE } from "./sound";
import { EvalContext } from "../types";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "audio-test" };

describe("AUDIO_PLAYER_NODE", () => {
  it("publishes its URL and start frame as sockets", () => {
    // The waveform strip reads both through the graph — reading them out of the
    // audio store's module cache is what left the strip blank after a reload.
    expect(AUDIO_PLAYER_NODE.outputs.map((o) => o.id)).toEqual(
      expect.arrayContaining(["url", "duration", "startFrame"]),
    );
  });

  it("stays trigger-driven by default, so existing graphs are untouched", () => {
    expect(AUDIO_PLAYER_NODE.defaultParams.startFrame).toBe(-1);
    const res = AUDIO_PLAYER_NODE.evaluate({}, AUDIO_PLAYER_NODE.defaultParams, {
      ...CTX,
      nodeId: "audio-legacy",
      currentFrame: 42,
      fps: 30,
    });
    expect(res.startFrame).toBe(-1);
  });

  it("echoes the frame it is anchored to", () => {
    const res = AUDIO_PLAYER_NODE.evaluate(
      {},
      { ...AUDIO_PLAYER_NODE.defaultParams, startFrame: 90 },
      { ...CTX, nodeId: "audio-anchored", currentFrame: 120, fps: 30 },
    );
    expect(res.startFrame).toBe(90);
  });

  it("takes the anchor from a wired socket over the param", () => {
    const res = AUDIO_PLAYER_NODE.evaluate(
      { startFrame: 12 },
      { ...AUDIO_PLAYER_NODE.defaultParams, startFrame: 90 },
      { ...CTX, nodeId: "audio-wired", currentFrame: 0, fps: 30 },
    );
    expect(res.startFrame).toBe(12);
  });

  it("rounds a fractional anchor to a whole frame", () => {
    const res = AUDIO_PLAYER_NODE.evaluate(
      { startFrame: 12.7 },
      AUDIO_PLAYER_NODE.defaultParams,
      { ...CTX, nodeId: "audio-frac", currentFrame: 0, fps: 30 },
    );
    expect(res.startFrame).toBe(13);
  });
});

describe("anchoredClipPosition", () => {
  it("enters the clip at Start in Clip, then follows the timeline", () => {
    // frame 30 is where the clip starts; the file's second 8 plays there
    expect(anchoredClipPosition(30, 30, 30, 8, 50, false)).toEqual({ playing: true, target: 8 });
    expect(anchoredClipPosition(60, 30, 30, 8, 50, false)).toEqual({ playing: true, target: 9 });
  });

  it("is silent before the start frame and after the end of a non-looping clip", () => {
    expect(anchoredClipPosition(10, 30, 30, 0, 5, false).playing).toBe(false);
    expect(anchoredClipPosition(30 + 30 * 6, 30, 30, 0, 5, false).playing).toBe(false);
  });

  it("wraps inside the file when looping", () => {
    expect(anchoredClipPosition(30 + 30 * 7, 30, 30, 0, 5, true)).toEqual({ playing: true, target: 2 });
  });
});
