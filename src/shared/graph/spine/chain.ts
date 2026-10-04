/**
 * Spine chains — the "procedural spine" from Nagomi's koi (see
 * docs/how-it-works.md in github.com/msk1039/nagomi): a chain of points where
 * the head goes wherever it is told and every point behind it follows the one
 * in front at a fixed distance. The trailing path is what makes a turn read as
 * a body bending through it rather than a stick rotating.
 *
 * The wave is *not* stored in the chain. It is added on the way out
 * (`wavedSpine`), so the follow constraint always works on the clean path the
 * head actually took; folding the wave back in would make each frame's
 * sideways offset drag the next frame's chain sideways, and the body would
 * crab across the water.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ChainSet {
  count: number;
  segments: number;
  /** Chain points, `segments` per chain, 3 numbers each, head first. */
  points: Float64Array;
  /** Swim phase per chain, radians — only advanced when no Phases list is wired. */
  phase: Float64Array;
  /** Smoothed head speed per chain, world units per second. */
  speed: Float64Array;
  prevHead: Float64Array;
}

export const WAVE_AXES = ["Side to Side", "Up and Down", "Off"] as const;
export type WaveAxis = (typeof WAVE_AXES)[number];

export interface WaveParams {
  axis: WaveAxis;
  /** Peak swing as a fraction of the chain length, where the envelope is 1. */
  amplitude: number;
  /** Waves along the chain at once. */
  wavelength: number;
  /** Beats per second (at reference speed when speed-driven). */
  frequency: number;
  /** Scale swing and beat with how fast the head moves, so a still chain idles and a fast one thrashes. */
  speedDriven: boolean;
  /** The head speed at which amplitude and frequency are as set. */
  refSpeed: number;
}

export function createChainSet(): ChainSet {
  return { count: 0, segments: 0, points: new Float64Array(0), phase: new Float64Array(0), speed: new Float64Array(0), prevHead: new Float64Array(0) };
}

/** Lays chain `i` out straight behind its head, against `heading` (or -X with none). */
export function seedChain(set: ChainSet, i: number, head: Vec3, heading: Vec3 | null, length: number): void {
  let hx = heading?.x ?? 1, hy = heading?.y ?? 0, hz = heading?.z ?? 0;
  const hl = Math.hypot(hx, hy, hz);
  if (hl < 1e-9) { hx = 1; hy = 0; hz = 0; } else { hx /= hl; hy /= hl; hz /= hl; }
  const n = set.segments;
  const seg = n > 1 ? length / (n - 1) : 0;
  const base = i * n * 3;
  for (let k = 0; k < n; k++) {
    set.points[base + k * 3] = head.x - hx * seg * k;
    set.points[base + k * 3 + 1] = head.y - hy * seg * k;
    set.points[base + k * 3 + 2] = head.z - hz * seg * k;
  }
  set.prevHead[i * 3] = head.x;
  set.prevHead[i * 3 + 1] = head.y;
  set.prevHead[i * 3 + 2] = head.z;
  set.speed[i] = 0;
}

/**
 * Resizes to `count` chains of `segments` points. Existing chains survive a
 * count change (a flock growing by one shouldn't re-straighten every fish);
 * a change of segment count re-seeds everything, since the old points no
 * longer mean the same place along the body.
 */
export function resizeChains(set: ChainSet, count: number, segments: number, seed: (i: number) => void): void {
  if (segments !== set.segments) {
    set.segments = segments;
    set.points = new Float64Array(count * segments * 3);
    set.phase = new Float64Array(count);
    set.speed = new Float64Array(count);
    set.prevHead = new Float64Array(count * 3);
    set.count = count;
    for (let i = 0; i < count; i++) seed(i);
    return;
  }
  if (count === set.count) return;
  const old = set;
  const points = new Float64Array(count * segments * 3);
  points.set(old.points.subarray(0, Math.min(old.points.length, points.length)));
  const phase = new Float64Array(count);
  phase.set(old.phase.subarray(0, Math.min(old.count, count)));
  const speed = new Float64Array(count);
  speed.set(old.speed.subarray(0, Math.min(old.count, count)));
  const prevHead = new Float64Array(count * 3);
  prevHead.set(old.prevHead.subarray(0, Math.min(old.prevHead.length, prevHead.length)));
  const before = set.count;
  set.points = points;
  set.phase = phase;
  set.speed = speed;
  set.prevHead = prevHead;
  set.count = count;
  for (let i = before; i < count; i++) seed(i);
}

/**
 * Moves chain `i`'s head to `head` and drags the rest after it: each point is
 * pulled to exactly one segment behind the one in front, and a joint may bend
 * at most `maxBend` radians, so a hairpin turn curls the body instead of
 * folding it flat on itself.
 */
export function followChain(set: ChainSet, i: number, head: Vec3, length: number, maxBend: number): void {
  const n = set.segments;
  const p = set.points;
  const base = i * n * 3;
  const seg = n > 1 ? length / (n - 1) : 0;
  const cosMax = Math.cos(Math.max(0, Math.min(Math.PI, maxBend)));
  p[base] = head.x;
  p[base + 1] = head.y;
  p[base + 2] = head.z;
  // Backward direction of the previous segment, for the bend limit.
  let bx = 0, by = 0, bz = 0;
  for (let k = 1; k < n; k++) {
    const a = base + (k - 1) * 3;
    const b = base + k * 3;
    let dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
    let len = Math.hypot(dx, dy, dz);
    if (len < 1e-9) {
      if (k > 1) { dx = bx; dy = by; dz = bz; } else { dx = -1; dy = 0; dz = 0; }
      len = 1;
    }
    dx /= len; dy /= len; dz /= len;
    if (k > 1) {
      const dot = dx * bx + dy * by + dz * bz;
      if (dot < cosMax) {
        const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
        const t = maxBend / angle;
        const sinA = Math.sin(angle);
        if (sinA > 1e-6) {
          const wa = Math.sin((1 - t) * angle) / sinA;
          const wb = Math.sin(t * angle) / sinA;
          dx = bx * wa + dx * wb; dy = by * wa + dy * wb; dz = bz * wa + dz * wb;
          const l = Math.hypot(dx, dy, dz) || 1;
          dx /= l; dy /= l; dz /= l;
        } else {
          dx = bx; dy = by; dz = bz;
        }
      }
    }
    p[b] = p[a] + dx * seg;
    p[b + 1] = p[a + 1] + dy * seg;
    p[b + 2] = p[a + 2] + dz * seg;
    bx = dx; by = dy; bz = dz;
  }
}

/** Measures how fast chain `i`'s head moved this frame, smoothed so one jerky frame doesn't spike the tail. */
export function trackSpeed(set: ChainSet, i: number, head: Vec3, dt: number): void {
  if (dt <= 0) return;
  const b = i * 3;
  const d = Math.hypot(head.x - set.prevHead[b], head.y - set.prevHead[b + 1], head.z - set.prevHead[b + 2]);
  set.prevHead[b] = head.x;
  set.prevHead[b + 1] = head.y;
  set.prevHead[b + 2] = head.z;
  set.speed[i] += (d / dt - set.speed[i]) * Math.min(1, dt * 6);
}

/** How hard the chain works at this speed: never quite still, more than double when sprinting. */
export function effort(speed: number, wave: WaveParams): number {
  if (!wave.speedDriven) return 1;
  const s = wave.refSpeed > 0 ? speed / wave.refSpeed : 1;
  return Math.max(0.25, Math.min(2.2, 0.25 + 0.75 * s));
}

export function advancePhase(set: ChainSet, i: number, dt: number, wave: WaveParams): void {
  set.phase[i] = (set.phase[i] + dt * Math.PI * 2 * wave.frequency * effort(set.speed[i], wave)) % (Math.PI * 200);
}

/**
 * Chain `i` with the wave applied, written to `out` (3 per point). The swing
 * travels head to tail; `envelope` (one value per point, 0-1) says how much
 * of it each point takes — a fish's grows toward the tail, a flag's toward
 * the free end, a caterpillar's is even. Side to Side swings in the
 * horizontal plane; Up and Down swings square to that and to the chain.
 */
export function wavedSpine(set: ChainSet, i: number, length: number, phase: number, wave: WaveParams, envelope: Float64Array, out: Float64Array): void {
  const n = set.segments;
  const p = set.points;
  const base = i * n * 3;
  const amp = wave.axis === "Off" ? 0 : wave.amplitude * length * effort(set.speed[i], wave);
  let sx = 1, sz = 0;
  for (let k = 0; k < n; k++) {
    const b = base + k * 3;
    out[k * 3] = p[b];
    out[k * 3 + 1] = p[b + 1];
    out[k * 3 + 2] = p[b + 2];
    if (amp === 0) continue;
    // Direction along the chain at this point, toward the head.
    const a0 = k > 0 ? b - 3 : b;
    const a1 = k > 0 ? b : b + 3;
    let fx = p[a0] - p[a1], fy = p[a0 + 1] - p[a1 + 1], fz = p[a0 + 2] - p[a1 + 2];
    const fl = Math.hypot(fx, fy, fz);
    if (fl > 1e-9) { fx /= fl; fy /= fl; fz /= fl; } else { fx = 1; fy = 0; fz = 0; }
    // Sideways stays horizontal; a chain pointing straight up keeps the last good one.
    const hl = Math.hypot(fx, fz);
    if (hl > 1e-6) { sx = -fz / hl; sz = fx / hl; }
    const u = n > 1 ? k / (n - 1) : 0;
    const swing = amp * (envelope[k] ?? 1) * Math.sin(phase - Math.PI * 2 * wave.wavelength * u);
    if (wave.axis === "Side to Side") {
      out[k * 3] += sx * swing;
      out[k * 3 + 2] += sz * swing;
    } else {
      // up = side × forward
      out[k * 3] += -sz * fy * swing;
      out[k * 3 + 1] += (sz * fx - sx * fz) * swing;
      out[k * 3 + 2] += sx * fy * swing;
    }
  }
}
