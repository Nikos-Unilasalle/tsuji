import { describe, expect, it } from "vitest";
import { planClip } from "./clipPlan";
import { buildSegments, type ClipFrame } from "./exportAudioCapture";

const fps = 30;
const bufA = { duration: 10 } as AudioBuffer;
const bufB = { duration: 10 } as AudioBuffer;

function frames(range: [number, number], opts: { startFrame?: number; loop?: boolean; buffer?: AudioBuffer; timeline?: (f: number) => number } = {}): ClipFrame[] {
  const out: ClipFrame[] = [];
  for (let f = range[0]; f < range[1]; f++) {
    const t = opts.timeline ? opts.timeline(f) : f;
    const plan = planClip({ frame: t, fps, startFrame: opts.startFrame ?? 0, clipStart: 0, clipEnd: 0, clipLength: 10, loop: opts.loop ?? false, rate: 1 });
    out.push({ frame: f, buffer: opts.buffer ?? bufA, plan, rate: 1, loop: opts.loop ?? false, level: 1, pan: 0 });
  }
  return out;
}

describe("buildSegments", () => {
  it("keeps a steady clip as one segment", () => {
    const segs = buildSegments(frames([0, 90]), fps);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ startFrame: 0, endFrame: 90, offset: 0 });
    expect(segs[0].levels).toHaveLength(90);
  });

  it("starts where the clip becomes audible", () => {
    const segs = buildSegments(frames([0, 60], { startFrame: 20 }), fps);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ startFrame: 20, endFrame: 60, offset: 0 });
  });

  it("splits on a timeline jump (Go To Canvas restart)", () => {
    const segs = buildSegments(frames([0, 60], { timeline: (f) => (f < 30 ? f : f - 30) }), fps);
    expect(segs.map((s) => [s.startFrame, s.endFrame, s.offset])).toEqual([
      [0, 30, 0],
      [30, 60, 0],
    ]);
  });

  it("does not split a looping clip at its wrap", () => {
    const segs = buildSegments(frames([0, 600], { loop: true }), fps);
    expect(segs).toHaveLength(1);
  });

  it("splits on a change of file", () => {
    const segs = buildSegments([...frames([0, 10]), ...frames([10, 20], { buffer: bufB })], fps);
    expect(segs).toHaveLength(2);
    expect(segs[1].buffer).toBe(bufB);
  });

  it("splits on a missing frame", () => {
    const all = frames([0, 20]).filter((f) => f.frame !== 10);
    expect(buildSegments(all, fps)).toHaveLength(2);
  });
});
