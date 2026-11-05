import { describe, expect, it } from "vitest";
import type { KeyframeStore } from "../../graph/types";
import { clearAutomation, isAutomated, writeAutomation } from "./automation";

const frames = (s: KeyframeStore, p = "level") => s.v?.[p]?.map((k) => [k.frame, k.value]);

describe("console automation", () => {
  it("anchors the past at the value before the gesture, then writes each frame", () => {
    let s = writeAutomation({}, { nodeId: "v", param: "level", frame: 10, value: 0.5, since: null, before: 0.8 });
    expect(frames(s)).toEqual([
      [0, 0.8],
      [9, 0.8],
      [10, 0.5],
    ]);
    s = writeAutomation(s, { nodeId: "v", param: "level", frame: 11, value: 0.4, since: 10, before: 0.8 });
    s = writeAutomation(s, { nodeId: "v", param: "level", frame: 12, value: 0.6, since: 11, before: 0.8 });
    expect(frames(s)).toEqual([
      [0, 0.8],
      [9, 0.8],
      [10, 0.5],
      [11, 0.4],
      [12, 0.6],
    ]);
    expect(isAutomated(s, "v", "level")).toBe(true);
    expect(isAutomated(s, "v", "pan")).toBe(false);
  });

  it("overwrites what the playhead passes over while held, and keeps what comes after", () => {
    let s: KeyframeStore = { v: { level: [0, 20, 40].map((frame) => ({ frame, value: 1 })) } };
    s = writeAutomation(s, { nodeId: "v", param: "level", frame: 15, value: 0.2, since: null, before: 1 });
    s = writeAutomation(s, { nodeId: "v", param: "level", frame: 25, value: 0.3, since: 15, before: 1 });
    expect(frames(s)).toEqual([
      [0, 1],
      [14, 1],
      [15, 0.2],
      [25, 0.3],
      [40, 1],
    ]);
  });

  it("rewrites the same frame when a move lands twice in it", () => {
    let s = writeAutomation({}, { nodeId: "v", param: "level", frame: 5, value: 0.5, since: null, before: 1 });
    s = writeAutomation(s, { nodeId: "v", param: "level", frame: 5, value: 0.3, since: 5, before: 1 });
    expect(frames(s)).toEqual([
      [0, 1],
      [4, 1],
      [5, 0.3],
    ]);
  });

  it("keeps only the ends of a straight stretch", () => {
    let s = writeAutomation({}, { nodeId: "v", param: "level", frame: 1, value: 0, since: null, before: 0 });
    for (let f = 2; f <= 10; f++) s = writeAutomation(s, { nodeId: "v", param: "level", frame: f, value: (f - 1) / 10, since: f - 1, before: 0 });
    expect(frames(s)).toEqual([
      [0, 0],
      [1, 0],
      [10, 0.9],
    ]);
  });

  it("clears a voice's console automation and nothing else", () => {
    const s: KeyframeStore = { v: { level: [{ frame: 0, value: 1 }], transpose: [{ frame: 0, value: 2 }] }, w: { pan: [{ frame: 0, value: 0 }] } };
    expect(clearAutomation(s, "v")).toEqual({ v: { transpose: [{ frame: 0, value: 2 }] }, w: s.w });
    expect(clearAutomation(s, "w")).toEqual({ v: s.v });
  });
});
