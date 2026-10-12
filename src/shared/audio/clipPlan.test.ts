import { describe, expect, it } from "vitest";
import { clipDrift, planClip } from "./clipPlan";

const base = { fps: 30, startFrame: 30, clipStart: 0, clipEnd: 0, clipLength: 10, loop: false, rate: 1 };

describe("planClip", () => {
  it("is silent before the start frame, and starts at the in point", () => {
    expect(planClip({ ...base, frame: 10 }).active).toBe(false);
    expect(planClip({ ...base, frame: 30, clipStart: 4 })).toMatchObject({ active: true, offset: 4 });
  });

  it("follows the timeline from the in point", () => {
    const p = planClip({ ...base, frame: 90, clipStart: 4 });
    expect(p.offset).toBeCloseTo(6);
    expect(p.remaining).toBeCloseTo(4);
  });

  it("stops at the out point", () => {
    expect(planClip({ ...base, frame: 30 + 30 * 3, clipStart: 4, clipEnd: 7 }).active).toBe(false);
    const before = planClip({ ...base, frame: 30 + 30 * 2, clipStart: 4, clipEnd: 7 });
    expect(before.active).toBe(true);
    expect(before.remaining).toBeCloseTo(1);
  });

  it("an out point past the file, or none, means the end of the file", () => {
    expect(planClip({ ...base, frame: 30, clipEnd: 99 }).outPoint).toBe(10);
    expect(planClip({ ...base, frame: 30, clipEnd: 0 }).outPoint).toBe(10);
  });

  it("loops the in→out region", () => {
    const p = planClip({ ...base, frame: 30 + 30 * 7, clipStart: 4, clipEnd: 7, loop: true });
    expect(p.active).toBe(true);
    expect(p.offset).toBeCloseTo(4 + (7 % 3));
    expect(p.remaining).toBeNull();
  });

  it("returns to the in point when the timeline wraps back before the start frame, then plays again", () => {
    expect(planClip({ ...base, frame: 0, startFrame: 0, clipStart: 2 }).offset).toBe(2);
    expect(planClip({ ...base, frame: 200, startFrame: 0, clipStart: 2 }).offset).toBeCloseTo(2 + 200 / 30);
    expect(planClip({ ...base, frame: 0, startFrame: 0, clipStart: 2 }).offset).toBe(2);
  });

  it("speed scales how fast the file advances", () => {
    expect(planClip({ ...base, frame: 60, rate: 2 }).offset).toBeCloseTo(2);
  });

  it("is silent while the file has not loaded or the region is empty", () => {
    expect(planClip({ ...base, frame: 60, clipLength: 0 }).active).toBe(false);
    expect(planClip({ ...base, frame: 60, clipStart: 5, clipEnd: 5 }).active).toBe(false);
  });
});

describe("clipDrift", () => {
  it("is the plain difference without a loop", () => {
    expect(clipDrift(5.1, 5, 0, 10, false)).toBeCloseTo(0.1);
  });
  it("sees a just-wrapped looped source as close, not a region away", () => {
    expect(clipDrift(4.02, 6.98, 4, 7, true)).toBeCloseTo(0.04);
    expect(clipDrift(6.98, 4.02, 4, 7, true)).toBeCloseTo(-0.04);
  });
});
