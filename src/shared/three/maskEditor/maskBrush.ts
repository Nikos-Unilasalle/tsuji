/**
 * The soft brush a Roto Mask paints with, on a Float32 working buffer (0..255).
 *
 * Floats while painting, bytes only when stored: a low-flow stamp adds a
 * fraction of a level, which a byte buffer would round away, and a soft
 * brush's outer falloff is exactly those fractions.
 */

export interface BrushSettings {
  /** Radius in bitmap pixels. */
  radius: number;
  /** 0 = a soft falloff from the centre out, 1 = a hard edge. The "contour progressif". */
  hardness: number;
  /** How much one stamp adds, 0..1. */
  flow: number;
  /** Take paint away instead of adding it. */
  erase: boolean;
}

/** Brush strength at `distance` from its centre: full inside the hard core, easing to nothing at the rim. */
export function brushFalloff(distance: number, radius: number, hardness: number): number {
  if (distance >= radius + 0.5) return 0;
  const core = radius * Math.max(0, Math.min(1, hardness));
  if (hardness >= 0.999) return Math.max(0, Math.min(1, radius - distance + 0.5));
  if (distance <= core) return 1;
  const t = (distance - core) / Math.max(1e-6, radius - core);
  if (t >= 1) return 0;
  const s = t * t * (3 - 2 * t);
  return 1 - s;
}

export interface DirtyRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One stamp of the brush centred on (cx, cy). Returns the pixels touched, or null if it fell off the bitmap. */
export function stampBrush(data: Float32Array, w: number, h: number, cx: number, cy: number, s: BrushSettings): DirtyRect | null {
  const r = Math.max(0.5, s.radius);
  const x0 = Math.max(0, Math.floor(cx - r - 1));
  const x1 = Math.min(w - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1));
  const y1 = Math.min(h - 1, Math.ceil(cy + r + 1));
  if (x1 < x0 || y1 < y0) return null;
  const flow = Math.max(0, Math.min(1, s.flow));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // Pixel centres, so a stamp at an integer + 0.5 is symmetric.
      const a = brushFalloff(Math.hypot(x + 0.5 - cx, y + 0.5 - cy), r, s.hardness) * flow;
      if (a <= 0) continue;
      const i = y * w + x;
      data[i] = s.erase ? data[i] * (1 - a) : data[i] + (255 - data[i]) * a;
    }
  }
  return { x0, y0, x1, y1 };
}

/**
 * A stroke from `from` to `to`: stamps spaced a fraction of the radius apart,
 * so a fast drag is a continuous line and a slow one is not darker for it.
 * `from` null is just the first dab.
 */
export function strokeBrush(
  data: Float32Array,
  w: number,
  h: number,
  from: { x: number; y: number } | null,
  to: { x: number; y: number },
  s: BrushSettings,
): DirtyRect | null {
  let dirty: DirtyRect | null = null;
  const add = (r: DirtyRect | null) => {
    if (!r) return;
    dirty = dirty
      ? { x0: Math.min(dirty.x0, r.x0), y0: Math.min(dirty.y0, r.y0), x1: Math.max(dirty.x1, r.x1), y1: Math.max(dirty.y1, r.y1) }
      : r;
  };
  if (!from) {
    add(stampBrush(data, w, h, to.x, to.y, s));
    return dirty;
  }
  const spacing = Math.max(1, s.radius * 0.12);
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(length / spacing));
  // The start of the segment was stamped by the previous one.
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    add(stampBrush(data, w, h, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, s));
  }
  return dirty;
}

/** A bitmap's bytes as the editor's float working copy. */
export function toWorking(bytes: Uint8Array): Float32Array {
  return Float32Array.from(bytes);
}

/** The working copy back to bytes. */
export function toBytes(data: Float32Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(data[i])));
  return out;
}
