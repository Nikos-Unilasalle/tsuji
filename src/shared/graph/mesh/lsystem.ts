import type { PolyMesh } from "../quadMesh";
import { setAttribute } from "./polyAttributes";

/*
 * L-systems (phase 9): string rewriting, then a 3-D turtle that reads the
 * result, then tubes along what it drew.
 *
 * Rules are text, one per line — `F=FF+[+F-F-F]-[-F+F+F]` (or `F -> ...`).
 * Every symbol of the current string is rewritten in parallel each
 * iteration; symbols without a rule stay as they are. Each symbol remembers
 * the iteration that wrote it (its *generation*), so the trunk of a plant
 * (generation 0..1) and its newest twigs can be told apart downstream.
 *
 * Turtle alphabet (Prusinkiewicz & Lindenmayer, The Algorithmic Beauty of
 * Plants, ch. 1.5):
 *   F G   move forward, drawing        f g   move forward, not drawing
 *   + −   yaw left / right (about Up)  & ^   pitch down / up (about Left)
 *   \ /   roll left / right (Heading)  |     turn around (yaw 180°)
 *   [ ]   push / pop the turtle         !     thinner (radius × width scale)
 * Anything else is ignored by the turtle (variables like X, A, B).
 *
 * The turtle starts at the origin heading +Y (up), Left = −X, Up = +Z, so a
 * classic 2-D L-system draws in the XY plane, growing upward.
 */

export type Vec3 = [number, number, number];

export function parseRules(text: string): { rules: Map<string, string>; errors: string[] } {
  const rules = new Map<string, string>();
  const errors: string[] = [];
  const lines = String(text ?? "").split(/\r?\n|;/);
  lines.forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) return;
    const m = /^(\S)\s*(?:->|=|→)\s*(.*)$/.exec(line);
    if (!m) {
      errors.push(`line ${i + 1}: expected "X=replacement"`);
      return;
    }
    rules.set(m[1], m[2].replace(/\s+/g, ""));
  });
  return { rules, errors };
}

export interface Expansion {
  symbols: string;
  /** Per symbol, the iteration that produced it (0 = the axiom). */
  generation: Uint16Array;
  /** Iterations actually applied (fewer when the length cap stopped it). */
  iterations: number;
  truncated: boolean;
}

/** Rewrites the axiom `iterations` times, stopping before the string passes `maxLength`. */
export function expandLSystem(axiom: string, rules: Map<string, string>, iterations: number, maxLength = 2_000_000): Expansion {
  let symbols = String(axiom ?? "").replace(/\s+/g, "");
  let generation = new Uint16Array(symbols.length);
  const n = Math.max(0, Math.min(64, Math.floor(Number.isFinite(iterations) ? iterations : 0)));
  let done = 0;
  for (let it = 1; it <= n; it++) {
    // Measure first: building a 50 MB string just to throw it away is the hang this cap exists for.
    let length = 0;
    for (let i = 0; i < symbols.length; i++) length += rules.get(symbols[i])?.length ?? 1;
    if (length > maxLength) return { symbols, generation, iterations: done, truncated: true };
    const parts: string[] = [];
    const gen = new Uint16Array(length);
    let k = 0;
    for (let i = 0; i < symbols.length; i++) {
      const ch = symbols[i];
      const rep = rules.get(ch);
      if (rep === undefined) {
        parts.push(ch);
        gen[k++] = generation[i];
      } else {
        parts.push(rep);
        for (let j = 0; j < rep.length; j++) gen[k++] = it;
      }
    }
    symbols = parts.join("");
    generation = gen;
    done = it;
  }
  return { symbols, generation, iterations: done, truncated: false };
}

export interface TurtleOptions {
  /** Turn angle, degrees. */
  angle: number;
  step: number;
  /** Step length multiplier per bracket depth (branches get shorter). */
  stepScale: number;
  /** Radius multiplier per bracket depth and per `!`. */
  widthScale: number;
  /** ± random degrees added to every turn. */
  jitter: number;
  seed: number;
  maxSegments: number;
}

export interface TurtleResult {
  points: Vec3[];
  /** Bracket depth at each point. */
  depth: number[];
  /** Generation of the symbol that drew each point (a chain start takes its first segment's). */
  generation: number[];
  /** Radius factor at each point (widthScale^depth × `!`s). */
  width: number[];
  /** Polylines, as point indices. A branch's first point is shared with its parent. */
  chains: number[][];
  segments: number;
  truncated: boolean;
}

function mulberry32(seed: number): () => number {
  let a = (Math.floor(seed * 9973) ^ 0x6d2b79f5) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rotates a and b (both ⟂ axis) by `rad` about axis, in place. */
function rotatePair(a: Vec3, b: Vec3, rad: number): void {
  const c = Math.cos(rad), s = Math.sin(rad);
  for (let k = 0; k < 3; k++) {
    const x = a[k], y = b[k];
    a[k] = x * c + y * s;
    b[k] = -x * s + y * c;
  }
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function interpretTurtle(expansion: Pick<Expansion, "symbols" | "generation">, opts: TurtleOptions): TurtleResult {
  const { symbols, generation } = expansion;
  const rad = ((Number.isFinite(opts.angle) ? opts.angle : 25) * Math.PI) / 180;
  const jitter = ((Number.isFinite(opts.jitter) ? Math.max(0, opts.jitter) : 0) * Math.PI) / 180;
  const baseStep = Number.isFinite(opts.step) ? opts.step : 1;
  const stepScale = Number.isFinite(opts.stepScale) && opts.stepScale > 0 ? opts.stepScale : 1;
  const widthScale = Number.isFinite(opts.widthScale) && opts.widthScale > 0 ? opts.widthScale : 1;
  const maxSegments = Math.max(0, Math.floor(opts.maxSegments));
  const rand = mulberry32(Number.isFinite(opts.seed) ? opts.seed : 0);
  const turn = () => rad + (jitter > 0 ? (rand() * 2 - 1) * jitter : 0);

  let pos: Vec3 = [0, 0, 0];
  let H: Vec3 = [0, 1, 0];
  let L: Vec3 = [-1, 0, 0];
  let U: Vec3 = [0, 0, 1];
  let depth = 0;
  let width = 1;
  let chain = -1;
  let point = -1;
  const stack: { pos: Vec3; H: Vec3; L: Vec3; U: Vec3; depth: number; width: number; chain: number; point: number }[] = [];
  const out: TurtleResult = { points: [], depth: [], generation: [], width: [], chains: [], segments: 0, truncated: false };
  const addPoint = (p: Vec3, gen: number) => {
    out.points.push(p);
    out.depth.push(depth);
    out.generation.push(gen);
    out.width.push(width);
    return out.points.length - 1;
  };

  for (let i = 0; i < symbols.length; i++) {
    const ch = symbols[i];
    switch (ch) {
      case "F":
      case "G": {
        if (out.segments >= maxSegments) {
          out.truncated = true;
          return out;
        }
        const len = baseStep * Math.pow(stepScale, depth);
        const next: Vec3 = [pos[0] + H[0] * len, pos[1] + H[1] * len, pos[2] + H[2] * len];
        if (chain < 0) {
          // A new polyline: from the branch point when the turtle stands on
          // one (so the branch skeleton stays connected), else a fresh point.
          const start = point >= 0 ? point : addPoint([...pos], generation[i]);
          out.chains.push([start]);
          chain = out.chains.length - 1;
        }
        point = addPoint(next, generation[i]);
        out.chains[chain].push(point);
        out.segments++;
        pos = next;
        break;
      }
      case "f":
      case "g": {
        const len = baseStep * Math.pow(stepScale, depth);
        pos = [pos[0] + H[0] * len, pos[1] + H[1] * len, pos[2] + H[2] * len];
        chain = -1;
        point = -1;
        break;
      }
      case "+":
        rotatePair(H, L, turn());
        break;
      case "-":
        rotatePair(H, L, -turn());
        break;
      case "&":
        // Pitch down: the heading dips away from Up.
        rotatePair(H, U, -turn());
        break;
      case "^":
        rotatePair(H, U, turn());
        break;
      case "\\":
        rotatePair(L, U, turn());
        break;
      case "/":
        rotatePair(L, U, -turn());
        break;
      case "|":
        rotatePair(H, L, Math.PI);
        break;
      case "!":
        width *= widthScale;
        break;
      case "[":
        stack.push({ pos: [...pos], H: [...H], L: [...L], U: [...U], depth, width, chain, point });
        depth++;
        width *= widthScale;
        chain = -1;
        break;
      case "]": {
        const s = stack.pop();
        if (!s) break; // an unbalanced ] is ignored rather than resetting the turtle
        pos = s.pos;
        H = s.H;
        L = s.L;
        U = s.U;
        depth = s.depth;
        width = s.width;
        chain = s.chain;
        point = s.point;
        break;
      }
      default:
        break;
    }
    // Re-orthonormalise now and then: thousands of turns drift the frame.
    if ((i & 255) === 255) {
      H = normalize(H);
      U = normalize([H[1] * L[2] - H[2] * L[1], H[2] * L[0] - H[0] * L[2], H[0] * L[1] - H[1] * L[0]]);
      L = normalize([U[1] * H[2] - U[2] * H[1], U[2] * H[0] - U[0] * H[2], U[0] * H[1] - U[1] * H[0]]);
    }
  }
  return out;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Any unit vector perpendicular to t. */
function perpendicular(t: Vec3): Vec3 {
  const ref: Vec3 = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalize(cross(t, ref));
}

/**
 * Tubes along the turtle's chains: one ring of `sides` points per chain
 * point, frames carried by parallel transport (no twisting at bends), quads
 * between rings, n-gon caps at both ends. Point attributes `depth`,
 * `generation` and `width` come from the turtle point each ring sits on.
 */
export function buildTubes(turtle: TurtleResult, opts: { radius: number; sides: number; caps: boolean }): PolyMesh {
  const sides = Math.max(3, Math.min(32, Math.round(opts.sides)));
  const radius = Math.max(0, Number.isFinite(opts.radius) ? opts.radius : 0);
  const positions: Vec3[] = [];
  const faces: number[][] = [];
  const depth: number[] = [];
  const generation: number[] = [];
  const width: number[] = [];
  for (const chain of turtle.chains) {
    if (chain.length < 2) continue;
    const pts = chain.map((i) => turtle.points[i]);
    const tangents: Vec3[] = pts.map((_, k) => {
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
      const t = sub(b, a);
      return Math.hypot(...t) > 1e-12 ? normalize(t) : [0, 1, 0];
    });
    let normal = perpendicular(tangents[0]);
    const base = positions.length;
    pts.forEach((p, k) => {
      if (k > 0) {
        // Parallel transport: strip the new tangent's component from the
        // previous normal; re-seed if the tube folds back on itself.
        const t = tangents[k];
        const n = sub(normal, t.map((c) => c * dot(normal, t)) as Vec3);
        normal = Math.hypot(...n) > 1e-6 ? normalize(n) : perpendicular(t);
      }
      const t = tangents[k];
      const binormal = cross(t, normal);
      const id = chain[k];
      const r = radius * turtle.width[id];
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        const c = Math.cos(a) * r, sn = Math.sin(a) * r;
        positions.push([p[0] + normal[0] * c + binormal[0] * sn, p[1] + normal[1] * c + binormal[1] * sn, p[2] + normal[2] * c + binormal[2] * sn]);
        depth.push(turtle.depth[id]);
        generation.push(turtle.generation[chain[Math.max(1, k)]]);
        width.push(turtle.width[id]);
      }
    });
    for (let k = 0; k + 1 < pts.length; k++) {
      const r0 = base + k * sides, r1 = base + (k + 1) * sides;
      for (let s = 0; s < sides; s++) {
        const s1 = (s + 1) % sides;
        faces.push([r0 + s, r0 + s1, r1 + s1, r1 + s]);
      }
    }
    if (opts.caps) {
      const first: number[] = [];
      const last: number[] = [];
      const lastRing = base + (pts.length - 1) * sides;
      for (let s = 0; s < sides; s++) {
        first.push(base + sides - 1 - s);
        last.push(lastRing + s);
      }
      faces.push(first, last);
    }
  }
  let mesh: PolyMesh = { positions, faces };
  mesh = setAttribute(mesh, "point", "depth", "int", depth);
  mesh = setAttribute(mesh, "point", "generation", "int", generation);
  mesh = setAttribute(mesh, "point", "width", "float", width);
  return mesh;
}

/** The turtle's drawing as loose edges (a wire skeleton), with the same point attributes. */
export function buildSkeleton(turtle: TurtleResult): PolyMesh {
  const edges: [number, number][] = [];
  for (const chain of turtle.chains)
    for (let k = 0; k + 1 < chain.length; k++) {
      const a = chain[k], b = chain[k + 1];
      if (a !== b) edges.push(a < b ? [a, b] : [b, a]);
    }
  let mesh: PolyMesh = { positions: turtle.points.map((p) => [...p] as Vec3), faces: [], edges };
  mesh = setAttribute(mesh, "point", "depth", "int", turtle.depth);
  mesh = setAttribute(mesh, "point", "generation", "int", turtle.generation);
  mesh = setAttribute(mesh, "point", "width", "float", turtle.width);
  return mesh;
}
