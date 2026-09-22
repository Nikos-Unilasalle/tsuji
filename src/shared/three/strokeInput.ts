/**
 * Tablet / stylus input pipeline for the Grease Pencil tools.
 *
 * Three concerns live here, all in screen space, before anything is projected
 * into the scene:
 *
 * 1. Sampling — browsers coalesce pointer moves down to one event per frame,
 *    which throws away most of the samples a 200+ Hz tablet (XP-PEN, Wacom)
 *    actually reports. `collectPointerSamples` unpacks `getCoalescedEvents()`
 *    so fast strokes keep their real trajectory instead of being rebuilt from
 *    a handful of widely spaced points.
 * 2. Pressure — hardware pressure is used verbatim for pen input, shaped by a
 *    user pressure curve; velocity-simulated pressure is reserved for devices
 *    that report none (mouse, plain touch).
 * 3. Stabilization — a Krita-style smoothing stage (none / basic / weighted /
 *    stabilizer) that removes hand tremor without the corner-cutting lag of a
 *    plain exponential filter on the projected 3D position.
 */

export type StabilizerMode = "none" | "basic" | "weighted" | "stabilizer";

export interface PointerSample {
  /** Client-space coordinates (same frame as PointerEvent.clientX/Y). */
  x: number;
  y: number;
  /** Raw hardware pressure in [0..1]; 0 when the device reports none. */
  pressure: number;
  tiltX: number;
  tiltY: number;
  /** Pen barrel rotation in degrees, when supported. */
  twist: number;
  time: number;
  pointerType: string;
  /** True when the sample comes from a pressure-capable stylus. */
  isPen: boolean;
}

type CoalescableEvent = PointerEvent & {
  getCoalescedEvents?: () => PointerEvent[];
};

function toSample(e: PointerEvent, fallbackTime: number): PointerSample {
  const pointerType = e.pointerType || "mouse";
  const isPen = pointerType === "pen";
  return {
    x: e.clientX,
    y: e.clientY,
    // Mouse buttons report a constant 0.5: treat that as "no pressure data".
    pressure: isPen ? e.pressure : 0,
    tiltX: e.tiltX ?? 0,
    tiltY: e.tiltY ?? 0,
    twist: (e as PointerEvent & { twist?: number }).twist ?? 0,
    time: e.timeStamp || fallbackTime,
    pointerType,
    isPen,
  };
}

/**
 * Expands a pointer event into every sample the device actually produced.
 *
 * Returns at least one sample (the event itself) so callers can treat the
 * result uniformly whether or not the browser exposes coalesced events.
 */
export function collectPointerSamples(e: PointerEvent, now = performance.now()): PointerSample[] {
  const src = e as CoalescableEvent;
  let raw: PointerEvent[] | null = null;
  if (typeof src.getCoalescedEvents === "function") {
    try {
      const coalesced = src.getCoalescedEvents();
      if (coalesced && coalesced.length > 0) raw = coalesced;
    } catch {
      raw = null;
    }
  }
  if (!raw) return [toSample(e, now)];
  return raw.map((ev) => toSample(ev, now));
}

export interface PressureCurveOptions {
  /**
   * Curve exponent. 1 = linear, < 1 makes light touches thicker (soft),
   * > 1 makes the pen require more force before widening (hard).
   */
  gamma?: number;
  /** Output pressure at zero input force. */
  min?: number;
  /** Output pressure at full input force. */
  max?: number;
}

/** Maps raw hardware pressure through the user's sensitivity curve. */
export function applyPressureCurve(raw: number, opts: PressureCurveOptions = {}): number {
  const gamma = Math.max(0.2, Math.min(4, opts.gamma ?? 1));
  const min = Math.max(0, Math.min(1, opts.min ?? 0.05));
  const max = Math.max(min + 0.01, Math.min(1, opts.max ?? 1));
  const t = Math.max(0, Math.min(1, raw));
  return min + (max - min) * Math.pow(t, gamma);
}

/**
 * Resolves the pressure for one sample.
 *
 * Pen samples use hardware pressure through the curve. Everything else falls
 * back to velocity simulation, which is what gives mouse strokes their
 * calligraphic taper.
 */
export function resolveSamplePressure(
  sample: PointerSample,
  prev: PointerSample | null,
  curve: PressureCurveOptions = {},
  simulate = true,
): number {
  if (sample.isPen && sample.pressure > 0.0005) {
    return applyPressureCurve(sample.pressure, curve);
  }
  if (!simulate) return applyPressureCurve(0.6, curve);
  if (!prev) return 0.65;

  const dist = Math.hypot(sample.x - prev.x, sample.y - prev.y);
  const dt = Math.max(1, sample.time - prev.time);
  const speed = dist / dt; // px/ms — ~0.05 slow, 3.0+ fast
  const factor = Math.exp(-speed * 0.85);
  return Math.max(0.18, Math.min(1, 0.2 + 0.85 * factor));
}

export interface PressureTracker {
  /** Pressure for the next sample, in stroke order. */
  next(sample: PointerSample, prev: PointerSample | null): number;
  /** True once any sample in this stroke carried real hardware pressure. */
  usedHardware(): boolean;
}

/**
 * Stateful pressure resolver for one stroke.
 *
 * Raw velocity simulation is unusable on its own at the end of a stroke: the
 * hand always decelerates before lifting, so the last samples read as "very
 * slow" and the naive `exp(-speed)` mapping jumps them to full pressure. That
 * is the spear-head blob artists see on stroke ends. Two guards fix it:
 *
 * - speed is low-pass filtered, so one slow sample cannot swing the width;
 * - pressure may rise only gradually (falling is unrestricted), so a genuine
 *   flick still thins out instantly while a deceleration cannot re-inflate the
 *   line over the handful of samples a lift-off lasts.
 *
 * Hardware pressure bypasses both — a stylus already reports the truth.
 */
export function createPressureTracker(curve: PressureCurveOptions = {}): PressureTracker {
  let speedEma: number | null = null;
  let last: number | null = null;
  let sawHardware = false;

  // Per-sample limits. Tablets report 100–250 Hz, so a real press-down still
  // reaches full width in well under 100 ms.
  const MAX_RISE = 0.04;

  return {
    usedHardware: () => sawHardware,
    next(sample, prev) {
      if (sample.isPen && sample.pressure > 0.0005) {
        sawHardware = true;
        last = applyPressureCurve(sample.pressure, curve);
        return last;
      }
      if (!prev) {
        last = 0.65;
        return last;
      }

      const dist = Math.hypot(sample.x - prev.x, sample.y - prev.y);
      const dt = Math.max(1, sample.time - prev.time);
      const speed = dist / dt; // px/ms — ~0.05 slow, 3.0+ fast
      speedEma = speedEma === null ? speed : speedEma * 0.65 + speed * 0.35;

      const factor = Math.exp(-speedEma * 0.85);
      const target = Math.max(0.18, Math.min(1, 0.2 + 0.85 * factor));

      const next = last === null ? target : Math.min(target, last + MAX_RISE);
      last = next;
      return next;
    },
  };
}

/**
 * Pen tilt expressed as a unit direction plus a 0..1 inclination, for chisel
 * and calligraphy brushes. Returns null when the device reports no tilt.
 */
export function tiltToBrushAngle(sample: PointerSample): { angle: number; inclination: number } | null {
  if (!sample.isPen) return null;
  if (sample.tiltX === 0 && sample.tiltY === 0) return null;
  const angle = Math.atan2(sample.tiltY, sample.tiltX);
  const inclination = Math.min(1, Math.hypot(sample.tiltX, sample.tiltY) / 90);
  return { angle, inclination };
}

export interface Point2 {
  x: number;
  y: number;
}

export interface Stabilizer {
  mode: StabilizerMode;
  /** Resets the filter and anchors it at the stroke's first sample. */
  begin(p: Point2): Point2;
  /**
   * Feeds one raw sample, returning the stabilized position to draw at.
   *
   * `speed` (px per ms) relaxes the filter on fast motion — see the
   * speed-adaptive note on {@link createStabilizer}.
   */
  push(p: Point2, speed?: number): Point2;
  /**
   * Krita-style "finish line": on pen-up, drains the lag by walking the
   * stabilized position the rest of the way to the real cursor.
   */
  finish(p: Point2): Point2[];
}

/**
 * Creates a stroke stabilizer.
 *
 * - `none`: raw input, lowest latency, best for short hatching.
 * - `basic`: light exponential filter that removes tablet digitizer jitter.
 * - `weighted`: linear-weighted moving average over a window; visible lag,
 *   good for confident long lines.
 * - `stabilizer`: pull-string / lazy-brush. The drawn point trails the cursor
 *   by a radius, which is what makes long smooth curves easy — the strongest
 *   mode and the one most tablet users expect.
 *
 * All modes are **speed-adaptive**: smoothing is at full strength when the pen
 * crawls (that is when hand tremor shows) and fades out as the pen accelerates
 * (that is when lag and lost detail show). Krita does the same thing with its
 * "smoothing at min/max speed" pair. Without it, a filter tuned to steady a
 * slow contour line will visibly trail — and shorten — a fast flick.
 *
 * @param strength Normalized 0..1 intensity.
 */
export function createStabilizer(mode: StabilizerMode, strength: number): Stabilizer {
  const s = Math.max(0, Math.min(1, strength));
  const window = Math.max(2, Math.round(3 + s * 10));
  const radius = 2 + s * 26; // px, pull-string lag distance
  const history: Point2[] = [];
  let current: Point2 | null = null;

  // Speed at which stabilization has fully relaxed, in px/ms. A deliberate
  // contour line runs under ~0.3; a flick runs well past 2.
  const FULL_SPEED = 2.0;
  const relax = (speed: number) => {
    if (!(speed > 0)) return 1;
    return Math.max(0.1, 1 - Math.min(1, speed / FULL_SPEED) * 0.9);
  };

  const weightedAverage = (): Point2 => {
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let i = 0; i < history.length; i++) {
      // Newest samples weigh most, so the brush still tracks intent.
      const w = i + 1;
      sx += history[i].x * w;
      sy += history[i].y * w;
      sw += w;
    }
    return { x: sx / sw, y: sy / sw };
  };

  return {
    mode,
    begin(p) {
      history.length = 0;
      history.push({ ...p });
      current = { ...p };
      return { ...p };
    },
    push(p, speed = 0) {
      if (mode === "none" || !current) {
        current = { ...p };
        return { ...p };
      }

      const k = relax(speed); // 1 = full smoothing, 0.1 = nearly raw

      if (mode === "basic") {
        const alpha = 1 - s * 0.55 * k; // 1.0 (off) .. 0.45
        current = {
          x: current.x + (p.x - current.x) * alpha,
          y: current.y + (p.y - current.y) * alpha,
        };
        return { ...current };
      }

      if (mode === "weighted") {
        history.push({ ...p });
        if (history.length > window) history.shift();
        const avg = weightedAverage();
        // Fast motion leans back toward the raw sample so flicks keep their
        // real extent instead of being averaged short.
        current = {
          x: p.x + (avg.x - p.x) * k,
          y: p.y + (avg.y - p.y) * k,
        };
        return { ...current };
      }

      // stabilizer / pull-string
      const pullRadius = radius * k;
      const dx = p.x - current.x;
      const dy = p.y - current.y;
      const dist = Math.hypot(dx, dy);
      if (dist > pullRadius) {
        const move = dist - pullRadius;
        current = {
          x: current.x + (dx / dist) * move,
          y: current.y + (dy / dist) * move,
        };
      }
      history.push({ ...current });
      if (history.length > window) history.shift();
      const avg = weightedAverage();
      // Blend the averaged position back in to knock out residual stepping,
      // again only as far as the current speed allows.
      const blend = 0.5 * k;
      current = {
        x: current.x * (1 - blend) + avg.x * blend,
        y: current.y * (1 - blend) + avg.y * blend,
      };
      return { ...current };
    },
    finish(p) {
      const out: Point2[] = [];
      if (mode === "none" || !current) return out;

      const gap = Math.hypot(p.x - current.x, p.y - current.y);
      // Nothing meaningful left to drain: emitting a fan of near-coincident
      // points here is what used to leave an ink blob at the stroke end.
      if (gap < 2) {
        current = { ...p };
        return out;
      }

      // One point per ~2px, so the tail has the same sample density as the
      // rest of the stroke instead of piling up.
      const steps = Math.max(2, Math.min(12, Math.round(gap / 2)));
      const from = { ...current };
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        // Ease out so the tail decelerates into the release point.
        const e = 1 - (1 - t) * (1 - t);
        out.push({ x: from.x + (p.x - from.x) * e, y: from.y + (p.y - from.y) * e });
      }
      current = { ...p };
      return out;
    },
  };
}
