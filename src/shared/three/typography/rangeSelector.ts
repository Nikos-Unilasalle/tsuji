/**
 * Range Selector Engine for Typography and List modulation in Tsuji.
 * Inspired by After Effects text animators (Range Selector & Wiggly Selector).
 */

export type RangeSelectorShape =
  | "smooth"
  | "linear"
  | "ramp_up"
  | "ramp_down"
  | "triangle"
  | "round"
  | "square"
  | "elastic"
  | "bounce";

export const RANGE_SELECTOR_SHAPES: RangeSelectorShape[] = [
  "smooth",
  "linear",
  "ramp_up",
  "ramp_down",
  "triangle",
  "round",
  "square",
  "elastic",
  "bounce",
];

export interface RangeSelectorOptions {
  /** Start point of the active selection (0 to 1). Default: 0 */
  start?: number;
  /** End point of the active selection (0 to 1). Default: 1 */
  end?: number;
  /** Global offset shifted along the text (-1 to 1). Default: 0 */
  offset?: number;
  /** Modulation falloff shape across the range. Default: 'smooth' */
  shape?: RangeSelectorShape;
  /** Whether to shuffle the order in which characters are affected. */
  randomize?: boolean;
  /** Integer seed for the random permutation order. */
  randomSeed?: number;
  /** Ease in for high values (-1 to 1). */
  easeHigh?: number;
  /** Ease in for low values (-1 to 1). */
  easeLow?: number;
  /** Procedural jitter / trembling amount (0 to 1). */
  wiggleAmount?: number;
  /** Wiggle frequency / speed multiplier. Default: 1 */
  wiggleSpeed?: number;
  /** Current evaluation time in seconds for continuous animations. */
  time?: number;
  /** Whether to invert the computed weights (1 - w). */
  invert?: boolean;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function smoothstep(min: number, max: number, value: number): number {
  const x = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return x * x * (3 - 2 * x);
}

export function bounceEaseOut(p: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  let x = p;
  if (x < 1 / d1) {
    return n1 * x * x;
  }
  if (x < 2 / d1) {
    return n1 * (x -= 1.5 / d1) * x + 0.75;
  }
  if (x < 2.5 / d1) {
    return n1 * (x -= 2.25 / d1) * x + 0.9375;
  }
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}

export function elasticEaseOut(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const c4 = (2 * Math.PI) / 3;
  return Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * c4) + 1;
}

/** Returns a deterministic shuffled permutation of [0, 1, ..., count - 1]. */
export function getShuffledPermutation(count: number, seed: number): number[] {
  const arr = Array.from({ length: count }, (_, i) => i);
  let s = Math.floor(seed) || 1337;
  for (let i = count - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) | 0;
    const rnd = Math.abs(s) % (i + 1);
    const tmp = arr[i];
    arr[i] = arr[rnd];
    arr[rnd] = tmp;
  }
  return arr;
}

/** Applies high and low easing curves (-1 to 1) to a normalized weight. */
function applyEasing(w: number, easeHigh = 0, easeLow = 0): number {
  if (easeHigh === 0 && easeLow === 0) return w;
  let val = w;
  if (easeLow !== 0) {
    const p = easeLow > 0 ? 1 + easeLow * 2 : 1 / (1 - easeLow * 2);
    if (val < 0.5) {
      val = Math.pow(val * 2, p) * 0.5;
    }
  }
  if (easeHigh !== 0) {
    const p = easeHigh > 0 ? 1 + easeHigh * 2 : 1 / (1 - easeHigh * 2);
    if (val >= 0.5) {
      val = 1 - Math.pow((1 - val) * 2, p) * 0.5;
    }
  }
  return clamp(val, 0, 1);
}

/**
 * Computes an array of weights (length = count) in [0, 1] based on range selector options.
 */
export function computeRangeWeights(count: number, options: RangeSelectorOptions = {}): number[] {
  if (count <= 0) return [];
  if (count === 1) {
    const w = clamp((options.end ?? 1) + (options.offset ?? 0), 0, 1);
    return [options.invert ? 1 - w : w];
  }

  const {
    start = 0,
    end = 1,
    offset = 0,
    shape = "smooth",
    randomize = false,
    randomSeed = 0,
    easeHigh = 0,
    easeLow = 0,
    wiggleAmount = 0,
    wiggleSpeed = 1,
    time = 0,
    invert = false,
  } = options;

  const weights = new Array<number>(count);

  let perm: number[] | null = null;
  if (randomize) {
    perm = getShuffledPermutation(count, randomSeed);
  }

  const s = start + offset;
  const e = end + offset;
  const range = e - s;

  for (let i = 0; i < count; i++) {
    // If randomized, lookup the item's virtual rank
    const effectiveIndex = perm ? perm[i] : i;
    const t = effectiveIndex / (count - 1);

    let w = 0;

    if (Math.abs(range) < 1e-6) {
      w = t <= s ? 1 : 0;
    } else if (range > 0) {
      const u = clamp((t - s) / range, 0, 1);
      switch (shape) {
        case "smooth":
          w = smoothstep(0, 1, u);
          break;
        case "linear":
        case "ramp_up":
          w = u;
          break;
        case "ramp_down":
          w = 1 - u;
          break;
        case "triangle":
          w = u < 0.5 ? 2 * u : 2 * (1 - u);
          break;
        case "round":
          w = Math.sin(u * Math.PI);
          break;
        case "square":
          w = t >= s && t <= e ? 1 : 0;
          break;
        case "elastic":
          w = t <= s ? 0 : t >= e ? 1 : elasticEaseOut(u);
          break;
        case "bounce":
          w = t <= s ? 0 : t >= e ? 1 : bounceEaseOut(u);
          break;
        default:
          w = smoothstep(0, 1, u);
      }
    } else {
      // Inverted range where start > end
      const u = clamp((t - e) / -range, 0, 1);
      switch (shape) {
        case "smooth":
          w = 1 - smoothstep(0, 1, u);
          break;
        case "linear":
        case "ramp_up":
          w = 1 - u;
          break;
        case "ramp_down":
          w = u;
          break;
        case "triangle":
          w = u < 0.5 ? 2 * u : 2 * (1 - u);
          break;
        case "round":
          w = Math.sin(u * Math.PI);
          break;
        case "square":
          w = t >= e && t <= s ? 1 : 0;
          break;
        case "elastic":
          w = t <= e ? 1 : t >= s ? 0 : 1 - elasticEaseOut(u);
          break;
        case "bounce":
          w = t <= e ? 1 : t >= s ? 0 : 1 - bounceEaseOut(u);
          break;
        default:
          w = 1 - smoothstep(0, 1, u);
      }
    }

    // Apply easing
    w = applyEasing(w, easeHigh, easeLow);

    // Procedural organic wiggle / jitter
    if (wiggleAmount > 0) {
      const noise =
        Math.sin(time * wiggleSpeed * 3.7 + effectiveIndex * 1.618) * 0.5 +
        Math.cos(time * wiggleSpeed * 5.3 + effectiveIndex * 2.718) * 0.5;
      w = clamp(w + noise * wiggleAmount, 0, 1);
    }

    weights[i] = invert ? 1 - w : w;
  }

  return weights;
}
