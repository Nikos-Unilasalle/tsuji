/**
 * Where a sound anchored to the timeline should be, as a pure function of the playhead.
 *
 * A clip has an in point and an out point inside its file (seconds; out 0 = the end of the file) and sits on the
 * timeline from `startFrame`. At any frame it is either silent or at one offset in the file — the whole sync story is
 * "make the speaker agree with this", so it is kept free of Web Audio and easy to test.
 */
export interface ClipPlanInput {
  /** The playhead, in frames. */
  frame: number;
  fps: number;
  /** The timeline frame where the clip begins. */
  startFrame: number;
  /** In point: the second of the file that plays at `startFrame`. */
  clipStart: number;
  /** Out point (s). 0 or less = the end of the file. */
  clipEnd: number;
  /** The file's length (s); 0 while it has not loaded. */
  clipLength: number;
  /** Repeat the in→out region for as long as the timeline runs. */
  loop: boolean;
  /** Playback speed. The clip advances `rate` seconds of file per second of timeline. */
  rate: number;
}

export interface ClipPlan {
  /** Sounding at this frame? */
  active: boolean;
  /** Position in the file (s) the sound should be at. */
  offset: number;
  /** Seconds of file left before the out point; null when looping (it never ends). */
  remaining: number | null;
  /** The in and out points actually used (s), clamped to the file. */
  inPoint: number;
  outPoint: number;
}

const SILENT: ClipPlan = { active: false, offset: 0, remaining: null, inPoint: 0, outPoint: 0 };

export function planClip(input: ClipPlanInput): ClipPlan {
  const { frame, fps, startFrame, clipLength, loop } = input;
  if (!(fps > 0) || !(clipLength > 0)) return SILENT;
  const inPoint = Math.min(Math.max(0, input.clipStart), clipLength);
  const outPoint = input.clipEnd > 0 ? Math.min(input.clipEnd, clipLength) : clipLength;
  const region = outPoint - inPoint;
  const silent = { ...SILENT, inPoint, outPoint };
  if (!(region > 0) || frame < 0 || frame < startFrame) return silent;

  const rate = input.rate > 0 ? input.rate : 1;
  const elapsed = ((frame - startFrame) / fps) * rate;
  if (loop) return { active: true, offset: inPoint + (elapsed % region), remaining: null, inPoint, outPoint };
  if (elapsed >= region) return silent;
  return { active: true, offset: inPoint + elapsed, remaining: region - elapsed, inPoint, outPoint };
}

/**
 * How far a running source is from where the plan wants it, taking a looped region's wrap into account (a source that has
 * just wrapped and a plan that has not yet — or the other way round — are close, not a region apart).
 */
export function clipDrift(actual: number, wanted: number, inPoint: number, outPoint: number, loop: boolean): number {
  const raw = actual - wanted;
  const region = outPoint - inPoint;
  if (!loop || !(region > 0)) return raw;
  const wrapped = ((raw % region) + region) % region;
  return wrapped > region / 2 ? wrapped - region : wrapped;
}
