/**
 * Where the timeline playhead is, counted off the clock the viewport renders
 * on rather than off a timer of its own.
 *
 * Keyframed motion only moves when the frame number changes. With the playhead
 * advanced by an outside `setInterval`, two consecutive renders could land on
 * the same frame — and motion blur's velocity buffer compares each render with
 * the one before it, so those duplicate renders measured no movement and came
 * out sharp. That is why a keyframed scene barely blurred while a
 * Time-node-driven one, already running on the render clock, always did.
 *
 * Kept out of the component so the anchoring rules below can be tested; the
 * viewport owns only the refs it threads through here.
 */

export interface PlayheadAnchor {
  /** Render-clock reading when this anchor was taken. */
  clockTime: number;
  /** Timeline frame at that instant. */
  frame: number;
}

export interface PlayheadState {
  anchor: PlayheadAnchor | null;
  /**
   * The last frame handed out. What separates a frame coming back round from
   * React after our own report from one set by something else — a scrub, a
   * jump to a marker — which has to re-anchor rather than be overridden.
   */
  lastReported: number | null;
  /**
   * The last frame handed out, not wrapped round the timeline — which loop
   * it was in as well as where. See the last-frame rule in advancePlayhead.
   */
  lastRaw?: number;
}

export interface PlayheadInput {
  /** Whether this viewport is the one driving (visible, given an onFrameChange). */
  driving: boolean;
  playing: boolean;
  /** Timeline length; 0 when there is no timeline to run. */
  totalFrames: number;
  /** The frame currently arriving from outside. Negative when keyframes are off. */
  incomingFrame: number;
  fps: number;
  /** The render clock, in seconds. */
  clockTime: number;
}

export interface PlayheadResult {
  frame: number;
  state: PlayheadState;
}

export const IDLE_PLAYHEAD: PlayheadState = { anchor: null, lastReported: null };

export function advancePlayhead(state: PlayheadState, input: PlayheadInput): PlayheadResult {
  const { driving, playing, totalFrames, incomingFrame, fps, clockTime } = input;

  // Not driving — paused, hidden, keyframes off, or simply not the chosen
  // viewport. Follow the incoming frame and drop the anchor, so the next play
  // takes a fresh one from wherever the playhead has been left.
  if (!driving || !playing || totalFrames <= 0 || incomingFrame < 0 || !(fps > 0)) {
    return { frame: incomingFrame, state: IDLE_PLAYHEAD };
  }

  // A frame that is not the one we last handed out came from somewhere else.
  const external = state.lastReported !== null && incomingFrame !== state.lastReported;
  if (state.anchor === null || external) {
    return {
      frame: incomingFrame,
      state: { anchor: { clockTime, frame: incomingFrame }, lastReported: incomingFrame, lastRaw: incomingFrame },
    };
  }

  // Never negative: a clock that went backwards (a rewind, a re-anchored
  // epoch) would otherwise run the playhead backwards through the modulo and
  // land on a frame near the end of the timeline.
  const elapsed = Math.max(0, clockTime - state.anchor.clockTime);
  // Floor, not round: a frame is reached only once its whole duration has
  // actually elapsed, or the first one lasts half as long as every other and
  // the timeline creeps ahead of the audio.
  //
  // The nudge is for floating point, and it matters more than it looks.
  // Subtracting two clock readings rarely lands on an exact multiple of the
  // frame duration — 12.5 + 1/30 - 12.5 comes back as 0.9999999999999858
  // frames — so a bare floor drops that frame and serves the previous one
  // again. A repeated frame is exactly the duplicate render this whole
  // mechanism exists to remove, and it would have reappeared at random.
  const raw = state.anchor.frame + Math.floor(elapsed * fps + 1e-6);

  // A loop never steps over its last frame. A render slower than the
  // timeline skips frames, and skipping that one silently drops whatever is
  // cued on it — a Go To Canvas handing a chained film on to its next
  // canvas would miss, and the chapter would loop instead. So the render
  // that crosses the end shows the last frame; the next one wraps, still on
  // the anchor's clock, so nothing drifts.
  const last = totalFrames - 1;
  const prevRaw = state.lastRaw ?? state.anchor.frame;
  const prevLoop = Math.floor(prevRaw / totalFrames);
  if (Math.floor(raw / totalFrames) > prevLoop && prevRaw % totalFrames !== last) {
    return { frame: last, state: { anchor: state.anchor, lastReported: last, lastRaw: prevLoop * totalFrames + last } };
  }

  const frame = raw % totalFrames;
  return { frame, state: { anchor: state.anchor, lastReported: frame, lastRaw: raw } };
}
