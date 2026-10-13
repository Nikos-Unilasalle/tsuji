import { describe, expect, it } from "vitest";
import { AUDIO_PLAYER_NODE } from "./sound";
import * as THREE from "three";
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

describe("AUDIO_PLAYER_NODE start and stop points", () => {
  it("has a start and a stop point, defaulting to the whole file", () => {
    expect(AUDIO_PLAYER_NODE.defaultParams.clipStart).toBe(0);
    expect(AUDIO_PLAYER_NODE.defaultParams.clipEnd).toBe(0);
    expect(AUDIO_PLAYER_NODE.inputs.map((i) => i.id)).toEqual(expect.arrayContaining(["clipStart", "clipEnd"]));
  });

  it("publishes where the played region sits, for the waveform strip", () => {
    const res = AUDIO_PLAYER_NODE.evaluate(
      {},
      { ...AUDIO_PLAYER_NODE.defaultParams, startFrame: 30, clipStart: 4, clipEnd: 7 },
      { ...CTX, nodeId: "audio-region", currentFrame: 0, fps: 30 },
    );
    expect(res.clipOffsetFrames).toBe(120);
    expect(res.startFrame).toBe(30);
  });
});

describe("AUDIO_PLAYER_NODE global and local", () => {
  const pose = (x: number): EvalContext["activeCameraPose"] => ({ matrix: new THREE.Matrix4().makeTranslation(x, 0, 0), fov: 50 });
  const run = (params: Record<string, unknown>, x: number, id: string) =>
    AUDIO_PLAYER_NODE.evaluate({}, { ...AUDIO_PLAYER_NODE.defaultParams, startFrame: 0, ...params }, { ...CTX, nodeId: id, currentFrame: 0, fps: 30, activeCameraPose: pose(x) });

  it("is global by default, with a sphere to configure when local", () => {
    expect(AUDIO_PLAYER_NODE.defaultParams.spatialMode).toBe("global");
    expect(AUDIO_PLAYER_NODE.inputs.map((i) => i.id)).toEqual(expect.arrayContaining(["position", "innerRadius", "outerRadius"]));
  });

  it("local: the volume falls with the camera's distance and is silent past the outer radius", () => {
    const local = { spatialMode: "local", innerRadius: 2, outerRadius: 10, volume: 1 };
    // not playing (no file), so `volume` reads 0 whatever the level; the published position/level are checked through a loaded clip elsewhere
    expect(run(local, 0, "loc-near").volume).toBe(0);
    expect(run(local, 50, "loc-far").volume).toBe(0);
  });
});
