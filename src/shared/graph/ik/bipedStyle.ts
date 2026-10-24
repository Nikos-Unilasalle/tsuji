/** Speed styles for Polypede Motion, and the standing hand sway Biped Motion shares. */

const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** [idle, walk, run] values, blended piecewise through the walk. */
function across(speed: number, idle: number, walk: number, run: number): number {
  return speed < 0.5 ? lerp(idle, walk, smooth(speed * 2)) : lerp(walk, run, smooth((speed - 0.5) * 2));
}

/** Hand sway while standing: slow, opposite hands in opposite phase. Zero stride, so it never fights the walk's swing. */
export function idleSwayOffset(time: number, hand: 0 | 1, amplitude: number): number {
  const phase = hand === 0 ? 0 : Math.PI * 0.8;
  return amplitude * (Math.sin(2 * Math.PI * 0.32 * time + phase) + 0.35 * Math.sin(2 * Math.PI * 0.71 * time + phase * 1.7));
}

/**
 * How a Polypede Motion's gait changes with its Speed, 0..1: 0 is standing,
 * 0.5 the walk its parameters describe, 1 a scurry. Multipliers on the walk values, 1 at 0.5.
 */
export interface PolypedeStyle {
  stepRadius: number;
  stepDuration: number;
  stepHeight: number;
  /** Absolute, in step radii: how far a foot may be left behind before it steps with a neighbour still in the air. */
  urgency: number;
}

export function polypedeStyle(rawSpeed: number): PolypedeStyle {
  const speed = clamp01(Number.isFinite(rawSpeed) ? rawSpeed : 0.5);
  return {
    stepRadius: across(speed, 2.4, 1, 1.6),
    stepDuration: across(speed, 1.4, 1, 0.55),
    stepHeight: across(speed, 0.5, 1, 1.5),
    urgency: across(speed, 1.8, 1.8, 1.05),
  };
}
