/**
 * How a Biped Motion's gait changes with its Speed, 0..1: 0 stands still
 * (arms just hanging loose and swaying a little), 0.5 is the walk the node's
 * own parameters describe, 1 is a run.
 *
 * Every field is a multiplier on the walk value the node's parameters give, so
 * at 0.5 they are all 1 and the gait is exactly what it always was; the user's
 * own tuning of stride, bob or arm swing stays the walk, and idle and run are
 * measured from it.
 */
export interface BipedStyle {
  /** Stride: the circle around each foot's home. */
  stepRadius: number;
  stepDuration: number;
  stepHeight: number;
  /** Feet left behind step even with the other in the air at this many radii: low lets both leave the ground, as in a run. */
  urgency: number;
  armSwing: number;
  pelvisBob: number;
  hipSway: number;
  lean: number;
  /** Hands lifted by this much of the height, the forearms flexed of a run. */
  armLift: number;
  /** Loose, slow sway of the hands when standing, in the height's fractions; fades out as the walk begins. */
  idleSway: number;
}

const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** [idle, walk, run] values, blended piecewise through the walk. */
function across(speed: number, idle: number, walk: number, run: number): number {
  return speed < 0.5 ? lerp(idle, walk, smooth(speed * 2)) : lerp(walk, run, smooth((speed - 0.5) * 2));
}

export function bipedStyle(rawSpeed: number): BipedStyle {
  const speed = clamp01(Number.isFinite(rawSpeed) ? rawSpeed : 0.5);
  return {
    stepRadius: across(speed, 2.4, 1, 1.7),
    stepDuration: across(speed, 1.4, 1, 0.6),
    stepHeight: across(speed, 0.5, 1, 1.6),
    urgency: across(speed, 2.4, 2.4, 1.05),
    armSwing: across(speed, 0, 1, 1.8),
    pelvisBob: across(speed, 0, 1, 2.2),
    hipSway: across(speed, 0, 1, 0.8),
    lean: across(speed, 0, 1, 2.2),
    armLift: across(speed, 0, 0, 0.07),
    idleSway: 1 - smooth(clamp01(speed / 0.35)),
  };
}

/** Hand sway while standing: slow, opposite hands in opposite phase. Zero stride, so it never fights the walk's swing. */
export function idleSwayOffset(time: number, hand: 0 | 1, amplitude: number): number {
  const phase = hand === 0 ? 0 : Math.PI * 0.8;
  return amplitude * (Math.sin(2 * Math.PI * 0.32 * time + phase) + 0.35 * Math.sin(2 * Math.PI * 0.71 * time + phase * 1.7));
}
