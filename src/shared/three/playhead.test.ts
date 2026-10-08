import { describe, expect, it } from "vitest";
import { advancePlayhead, IDLE_PLAYHEAD, PlayheadInput, PlayheadState } from "./playhead";

const BASE: PlayheadInput = {
  driving: true,
  playing: true,
  totalFrames: 100,
  incomingFrame: 0,
  fps: 30,
  clockTime: 0,
};

/**
 * Plays a sequence of clock readings through, feeding each result back as the
 * next incoming frame — what React does once the report has committed.
 */
function play(times: number[], input: Partial<PlayheadInput> = {}) {
  let state: PlayheadState = IDLE_PLAYHEAD;
  let incoming = input.incomingFrame ?? BASE.incomingFrame;
  const frames: number[] = [];
  for (const clockTime of times) {
    const out = advancePlayhead(state, { ...BASE, ...input, incomingFrame: incoming, clockTime });
    state = out.state;
    incoming = out.frame;
    frames.push(out.frame);
  }
  return { frames, state };
}

describe("advancePlayhead", () => {
  it("advances one frame per 1/fps of render clock", () => {
    // The whole point: the frame a render sees is a function of that render's
    // own clock, so two consecutive renders a frame apart never land on the
    // same one — which is what left keyframed motion with no velocity to blur.
    const { frames } = play([0, 1 / 30, 2 / 30, 3 / 30]);
    expect(frames).toEqual([0, 1, 2, 3]);
  });

  it("holds the frame across renders faster than the frame rate", () => {
    // 60Hz renders on a 30fps timeline: pairs of renders share a frame, and
    // that is correct — the timeline genuinely has not moved on.
    const { frames } = play([0, 1 / 60, 2 / 60, 3 / 60, 4 / 60]);
    expect(frames).toEqual([0, 0, 1, 1, 2]);
  });

  it("floors rather than rounds, so no frame is served early", () => {
    // Rounding would reach frame 1 at half its duration, making the first
    // frame half as long as every other one.
    const { frames } = play([0, 0.6 / 30, 0.99 / 30, 1 / 30]);
    expect(frames).toEqual([0, 0, 0, 1]);
  });

  it("counts from where playback began, not from the raw clock", () => {
    // The render clock is the session's, free-running since load; starting
    // playback at frame 40 with the clock already at 12.5s must not jump.
    const { frames } = play([12.5, 12.5 + 1 / 30, 12.5 + 2 / 30], { incomingFrame: 40 });
    expect(frames).toEqual([40, 41, 42]);
  });

  it("re-anchors on a scrub instead of overriding it", () => {
    let state: PlayheadState = IDLE_PLAYHEAD;
    let out = advancePlayhead(state, { ...BASE, incomingFrame: 0, clockTime: 0 });
    state = out.state;
    out = advancePlayhead(state, { ...BASE, incomingFrame: out.frame, clockTime: 2 / 30 });
    state = out.state;
    expect(out.frame).toBe(2);

    // The user drags the playhead to 80 while it plays. That frame did not
    // come from us, so it wins and becomes the new anchor.
    out = advancePlayhead(state, { ...BASE, incomingFrame: 80, clockTime: 3 / 30 });
    state = out.state;
    expect(out.frame).toBe(80);

    // ...and playback carries on from there rather than snapping back.
    out = advancePlayhead(state, { ...BASE, incomingFrame: out.frame, clockTime: 5 / 30 });
    expect(out.frame).toBe(82);
  });

  it("wraps at the end of the timeline", () => {
    const { frames } = play([0, 1 / 30, 2 / 30], { incomingFrame: 98, totalFrames: 100 });
    expect(frames).toEqual([98, 99, 0]);
  });

  it("never steps over the last frame, however slow the renders", () => {
    // Renders 5 frames apart: 95 → 100 would wrap straight to 0 and anything
    // cued on frame 99 (a Go To Canvas chaining a film) would never fire.
    const { frames } = play([0, 5 / 30, 10 / 30, 15 / 30], { incomingFrame: 90, totalFrames: 100 });
    expect(frames).toEqual([90, 95, 99, 5]);
  });

  it("holds the last frame for a single render, then wraps on time", () => {
    // The hold costs one render, not the clock: the wrap lands where the
    // anchor says, so the timeline stays in step with the audio.
    const { frames } = play([0, 12 / 30, 13 / 30, 14 / 30], { incomingFrame: 90, totalFrames: 100 });
    expect(frames).toEqual([90, 99, 3, 4]);
  });

  it("shows the last frame once per loop, even when a render skips a whole loop", () => {
    const { frames } = play([0, 30 / 30, 31 / 30], { incomingFrame: 0, totalFrames: 10 });
    expect(frames).toEqual([0, 9, 1]);
  });

  it("never runs backwards when the clock does", () => {
    // tickClock re-anchors its epoch on pause/resume, so the reading it hands
    // out can step back. Modulo on a negative would land near the timeline's
    // end, reading as a jump to the wrong place.
    let state = advancePlayhead(IDLE_PLAYHEAD, { ...BASE, incomingFrame: 10, clockTime: 5 }).state;
    const out = advancePlayhead(state, { ...BASE, incomingFrame: 10, clockTime: 4 });
    expect(out.frame).toBe(10);
  });

  it.each([
    ["not driving", { driving: false }],
    ["paused", { playing: false }],
    ["no timeline", { totalFrames: 0 }],
    ["keyframes off", { incomingFrame: -1 }],
    ["no frame rate", { fps: 0 }],
  ])("follows the incoming frame and drops the anchor when %s", (_label, override) => {
    const incoming = (override as Partial<PlayheadInput>).incomingFrame ?? 7;
    const out = advancePlayhead(
      { anchor: { clockTime: 0, frame: 0 }, lastReported: 0 },
      { ...BASE, incomingFrame: incoming, clockTime: 99, ...override },
    );
    expect(out.frame).toBe(incoming);
    expect(out.state).toEqual(IDLE_PLAYHEAD);
  });

  it("takes a fresh anchor after a pause, so the clock elapsed while paused is not replayed", () => {
    let state = advancePlayhead(IDLE_PLAYHEAD, { ...BASE, incomingFrame: 10, clockTime: 0 }).state;
    // Paused for a while — the anchor is dropped.
    state = advancePlayhead(state, { ...BASE, playing: false, incomingFrame: 10, clockTime: 5 }).state;
    expect(state).toEqual(IDLE_PLAYHEAD);

    // Resuming re-anchors on the current reading rather than counting the
    // five seconds that went by paused.
    const resumed = advancePlayhead(state, { ...BASE, incomingFrame: 10, clockTime: 5 });
    expect(resumed.frame).toBe(10);
    const next = advancePlayhead(resumed.state, { ...BASE, incomingFrame: 10, clockTime: 5 + 1 / 30 });
    expect(next.frame).toBe(11);
  });
});
