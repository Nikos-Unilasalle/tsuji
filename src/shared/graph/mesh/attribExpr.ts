import { signedNoise3, fbmNoise3, curlNoise3, hashRandom } from "./attribNoise";

/*
 * The formula language of Attribute Expression (the "wrangle"): the syntax of
 * math/expression — `2x`, `sin x`, `-x^2 = -(x^2)`, `c ? a : b`, `|x|`,
 * × ÷ − π ² pasted from a document — extended with 3-vectors, because every
 * interesting attribute (P, N, Cd, uv, velocities) is one.
 *
 * Decision §5.4 of docs/parametric-modeling-plan.md: one formula per written
 * attribute, no multi-line VEX. So this is still an *expression* language:
 * no statements, no loops, no assignment inside a formula.
 *
 * Values are a number or a vec3. Types are known when compiling (the node
 * tells the compiler which names are vectors), so every operator is resolved
 * once and a formula becomes a tree of closures that runs per element with no
 * parsing, no dictionary lookups and no allocation: variables live at fixed
 * offsets in one Float64Array (the "env"), and every vector-valued node of
 * the tree owns a 3-slot buffer it overwrites and returns. A node's buffer is
 * read by its parent right away and never by anything else, so reusing it on
 * the next element (or the next call) is safe.
 *
 * Vector rules, GLSL-like: arithmetic is componentwise, a number mixed with a
 * vector is broadcast (`2 * P`, `P + 1`), `^` raises each component,
 * `.x .y .z` (or `.r .g .b`, `.u .v`) read one component, `(a, b, c)` and
 * `vec(a, b, c)` build one, `|v|` is its length. Comparisons and logic want
 * numbers — comparing vectors is ambiguous, so it is an error that says so.
 */

export type ExprKind = "float" | "vec3";

export class AttribExprError extends Error {
  constructor(message: string, readonly position: number) {
    super(message);
  }
}

/** Where a variable lives in the env and what it holds. */
export interface VarSlot {
  kind: ExprKind;
  offset: number;
}

type F = (e: Float64Array) => number;
type V = (e: Float64Array) => Float64Array;
type C = { kind: "float"; f: F } | { kind: "vec3"; v: V };

export interface CompiledAttribExpr {
  source: string;
  kind: ExprKind;
  /** Variable names the formula reads, in order of first use. */
  variables: string[];
  /** Writes 1 (float) or 3 (vec3) numbers into `out` at `at`. */
  evaluate(env: Float64Array, out: Float64Array | number[], at?: number): void;
}

// ---------------------------------------------------------------- tokens

type Token =
  | { kind: "num"; value: number; pos: number }
  | { kind: "name"; value: string; pos: number }
  | { kind: "op"; value: string; pos: number }
  | { kind: "end"; pos: number };

const OPERATORS = ["<=", ">=", "==", "!=", "&&", "||", "+", "-", "*", "/", "%", "^", "(", ")", ",", "<", ">", "?", ":", "!", "|", "."];

/** Typography from documents and keyboards onto the plain operators (as math/expression does). */
function normalise(src: string): string {
  return src
    .replace(/[×·∙⋅]/g, "*")
    .replace(/÷/g, "/")
    .replace(/[−–]/g, "-")
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/≠/g, "!=")
    .replace(/π/g, "pi")
    .replace(/τ/g, "tau")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/√/g, " sqrt ");
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // A number — but `.x` after a name is component access, not `.5`.
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new AttribExprError(`Unexpected "${c}"`, i);
      // `1.x` is not a thing; `2.` followed by a letter reads as 2 then `.x`.
      let text = m[0];
      if (text.endsWith(".") && /[A-Za-z_]/.test(src[i + text.length] ?? "")) text = text.slice(0, -1);
      tokens.push({ kind: "num", value: Number(text), pos: i });
      i += text.length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      tokens.push({ kind: "name", value: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (c === "@") {
      // Houdini habit: `@P`, `@Cd` — the @ is optional here.
      i++;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new AttribExprError(`Unexpected "${c}"`, i);
    tokens.push({ kind: "op", value: op, pos: i });
    i += op.length;
  }
  tokens.push({ kind: "end", pos: src.length });
  return tokens;
}

/**
 * The names a formula may read as variables (identifiers not called with
 * brackets and not a component after a dot), so the caller can declare only
 * those — reading every attribute of a mesh to run `P.y * 2` would be waste.
 * Never throws: a formula that does not tokenize just yields what it can.
 */
export function scanNames(source: string): string[] {
  let tokens: Token[];
  try {
    tokens = tokenize(normalise(source));
  } catch {
    return [];
  }
  const out: string[] = [];
  tokens.forEach((t, k) => {
    if (t.kind !== "name") return;
    const prev = tokens[k - 1];
    if (prev && prev.kind === "op" && prev.value === ".") return;
    const next = tokens[k + 1];
    if (next && next.kind === "op" && next.value === "(" && t.value in FUNCTIONS) return;
    if (!out.includes(t.value)) out.push(t.value);
  });
  return out;
}

// ---------------------------------------------------------------- lifting helpers

const isVec = (c: C): c is { kind: "vec3"; v: V } => c.kind === "vec3";
const num = (f: F): C => ({ kind: "float", f });
const vec = (v: V): C => ({ kind: "vec3", v });

function asFloat(c: C, what: string, pos: number): F {
  if (isVec(c)) throw new AttribExprError(`${what} needs a number, got a vector (use .x, length() …)`, pos);
  return c.f;
}

/** A number broadcast to a vector, or the vector itself. */
function asVec(c: C): V {
  if (isVec(c)) return c.v;
  const f = c.f;
  const out = new Float64Array(3);
  return (e) => {
    const s = f(e);
    out[0] = s;
    out[1] = s;
    out[2] = s;
    return out;
  };
}

/** A scalar function applied to a number or to each component of a vector. */
function map1(c: C, fn: (x: number) => number): C {
  if (!isVec(c)) {
    const f = c.f;
    return num((e) => fn(f(e)));
  }
  const v = c.v;
  const out = new Float64Array(3);
  return vec((e) => {
    const a = v(e);
    out[0] = fn(a[0]);
    out[1] = fn(a[1]);
    out[2] = fn(a[2]);
    return out;
  });
}

/** A binary scalar function, broadcast componentwise when either side is a vector. */
function map2(a: C, b: C, fn: (x: number, y: number) => number): C {
  if (!isVec(a) && !isVec(b)) {
    const fa = a.f, fb = b.f;
    return num((e) => fn(fa(e), fb(e)));
  }
  const out = new Float64Array(3);
  // Specialised paths keep the common `P * 2` from broadcasting into a temp vector.
  if (isVec(a) && !isVec(b)) {
    const va = a.v, fb = b.f;
    return vec((e) => {
      const x = va(e);
      const s = fb(e);
      out[0] = fn(x[0], s);
      out[1] = fn(x[1], s);
      out[2] = fn(x[2], s);
      return out;
    });
  }
  if (!isVec(a) && isVec(b)) {
    const fa = a.f, vb = b.v;
    return vec((e) => {
      const s = fa(e);
      const y = vb(e);
      out[0] = fn(s, y[0]);
      out[1] = fn(s, y[1]);
      out[2] = fn(s, y[2]);
      return out;
    });
  }
  const va = asVec(a), vb = asVec(b);
  return vec((e) => {
    const x = va(e);
    const y = vb(e);
    out[0] = fn(x[0], y[0]);
    out[1] = fn(x[1], y[1]);
    out[2] = fn(x[2], y[2]);
    return out;
  });
}

/** An n-ary scalar function, componentwise when any argument is a vector. */
function mapN(args: C[], fn: (...x: number[]) => number): C {
  if (args.length === 1) return map1(args[0], (x) => fn(x));
  if (args.length === 2) return map2(args[0], args[1], (x, y) => fn(x, y));
  if (!args.some(isVec)) {
    const fs = args.map((a) => (a as { f: F }).f);
    const buf = new Array<number>(fs.length);
    return num((e) => {
      for (let k = 0; k < fs.length; k++) buf[k] = fs[k](e);
      return fn(...buf);
    });
  }
  const vs = args.map(asVec);
  const out = new Float64Array(3);
  const comps: Float64Array[] = new Array(vs.length);
  const buf = new Array<number>(vs.length);
  return vec((e) => {
    // Each argument's buffer belongs to that argument's own node, so holding
    // all of them at once is fine.
    for (let k = 0; k < vs.length; k++) comps[k] = vs[k](e);
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < vs.length; k++) buf[k] = comps[k][c];
      out[c] = fn(...buf);
    }
    return out;
  });
}

const fmod = (a: number, b: number) => a - b * Math.floor(a / b);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const smoothstep = (e0: number, e1: number, x: number) => {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

function lengthOf(c: C): F {
  if (!isVec(c)) {
    const f = c.f;
    return (e) => Math.abs(f(e));
  }
  const v = c.v;
  return (e) => {
    const a = v(e);
    return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  };
}

// ---------------------------------------------------------------- functions

interface FnDef {
  min: number;
  max: number;
  help: string;
  build(args: C[], pos: number): C;
}

const unary = (fn: (x: number) => number, help: string): FnDef => ({ min: 1, max: 1, help, build: ([a]) => map1(a, fn) });
const nary = (min: number, max: number, fn: (...x: number[]) => number, help: string): FnDef => ({ min, max, help, build: (args) => mapN(args, fn) });

/** Seed offsets so noise(p) and noise(p, 2) look unrelated. */
const seedOffset = (s: number) => [s * 31.7, s * 17.3, s * 47.1];

function noiseArgs(args: C[], pos: number): { p: V; seed: F } {
  const p = asVec(args[0]);
  const seed = args[1] ? asFloat(args[1], "the seed", pos) : () => 0;
  return { p, seed };
}

const FUNCTIONS: Record<string, FnDef> = {
  sin: unary(Math.sin, "sin(x)"),
  cos: unary(Math.cos, "cos(x)"),
  tan: unary(Math.tan, "tan(x)"),
  asin: unary(Math.asin, "asin(x)"),
  acos: unary(Math.acos, "acos(x)"),
  atan: unary(Math.atan, "atan(x)"),
  sinh: unary(Math.sinh, "sinh(x)"),
  cosh: unary(Math.cosh, "cosh(x)"),
  tanh: unary(Math.tanh, "tanh(x)"),
  sqrt: unary(Math.sqrt, "sqrt(x)"),
  cbrt: unary(Math.cbrt, "cbrt(x)"),
  abs: unary(Math.abs, "abs(x)"),
  exp: unary(Math.exp, "exp(x)"),
  ln: unary(Math.log, "ln(x)"),
  log2: unary(Math.log2, "log2(x)"),
  log10: unary(Math.log10, "log10(x)"),
  floor: unary(Math.floor, "floor(x)"),
  ceil: unary(Math.ceil, "ceil(x)"),
  round: unary(Math.round, "round(x)"),
  sign: unary(Math.sign, "sign(x)"),
  fract: unary((x) => x - Math.floor(x), "fract(x)"),
  frac: unary((x) => x - Math.floor(x), "frac(x)"),
  radians: unary((x) => (x * Math.PI) / 180, "radians(deg)"),
  degrees: unary((x) => (x * 180) / Math.PI, "degrees(rad)"),
  log: nary(1, 2, (x, b) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)), "log(x[, base])"),
  atan2: nary(2, 2, Math.atan2, "atan2(y, x)"),
  pow: nary(2, 2, Math.pow, "pow(x, y)"),
  mod: nary(2, 2, fmod, "mod(x, y)"),
  min: nary(2, Infinity, Math.min, "min(a, b, …)"),
  max: nary(2, Infinity, Math.max, "max(a, b, …)"),
  clamp: nary(3, 3, clamp, "clamp(x, lo, hi)"),
  mix: nary(3, 3, (a, b, t) => a + (b - a) * t, "mix(a, b, t)"),
  lerp: nary(3, 3, (a, b, t) => a + (b - a) * t, "lerp(a, b, t)"),
  step: nary(2, 2, (edge, x) => (x < edge ? 0 : 1), "step(edge, x)"),
  smoothstep: nary(3, 3, smoothstep, "smoothstep(e0, e1, x)"),
  fit: nary(5, 5, (x, a, b, c, d) => (a === b ? c : c + ((clamp(x, Math.min(a, b), Math.max(a, b)) - a) / (b - a)) * (d - c)), "fit(x, omin, omax, nmin, nmax)"),
  length: { min: 1, max: 1, help: "length(v)", build: ([a]) => num(lengthOf(a)) },
  distance: {
    min: 2,
    max: 2,
    help: "distance(a, b)",
    build: ([a, b]) => num(lengthOf(map2(a, b, (x, y) => x - y))),
  },
  dot: {
    min: 2,
    max: 2,
    help: "dot(a, b)",
    build: ([a, b]) => {
      if (!isVec(a) && !isVec(b)) return map2(a, b, (x, y) => x * y);
      const va = asVec(a), vb = asVec(b);
      return num((e) => {
        const x = va(e);
        const x0 = x[0], x1 = x[1], x2 = x[2];
        const y = vb(e);
        return x0 * y[0] + x1 * y[1] + x2 * y[2];
      });
    },
  },
  cross: {
    min: 2,
    max: 2,
    help: "cross(a, b)",
    build: ([a, b]) => {
      const va = asVec(a), vb = asVec(b);
      const out = new Float64Array(3);
      return vec((e) => {
        const x = va(e);
        const x0 = x[0], x1 = x[1], x2 = x[2];
        const y = vb(e);
        out[0] = x1 * y[2] - x2 * y[1];
        out[1] = x2 * y[0] - x0 * y[2];
        out[2] = x0 * y[1] - x1 * y[0];
        return out;
      });
    },
  },
  normalize: {
    min: 1,
    max: 1,
    help: "normalize(v)",
    build: ([a]) => {
      if (!isVec(a)) return map1(a, Math.sign);
      const v = a.v;
      const out = new Float64Array(3);
      return vec((e) => {
        const x = v(e);
        const l = Math.sqrt(x[0] * x[0] + x[1] * x[1] + x[2] * x[2]);
        // A zero vector stays zero instead of becoming NaN.
        const k = l > 1e-20 ? 1 / l : 0;
        out[0] = x[0] * k;
        out[1] = x[1] * k;
        out[2] = x[2] * k;
        return out;
      });
    },
  },
  vec: {
    min: 1,
    max: 3,
    help: "vec(x, y, z) or vec(s)",
    build: (args, pos) => {
      if (args.length === 1) return vec(asVec(args[0]));
      if (args.length === 2) throw new AttribExprError("vec takes 1 or 3 arguments", pos);
      return tupleOf(args, pos);
    },
  },
  noise: {
    min: 1,
    max: 2,
    help: "noise(p[, seed]) → -1…1",
    build: (args, pos) => {
      const { p, seed } = noiseArgs(args, pos);
      return num((e) => {
        const x = p(e);
        const o = seedOffset(seed(e));
        return signedNoise3(x[0] + o[0], x[1] + o[1], x[2] + o[2]);
      });
    },
  },
  fbm: {
    min: 1,
    max: 3,
    help: "fbm(p[, octaves[, seed]]) → -1…1",
    build: (args, pos) => {
      const p = asVec(args[0]);
      const oct = args[1] ? asFloat(args[1], "octaves", pos) : () => 4;
      const seed = args[2] ? asFloat(args[2], "the seed", pos) : () => 0;
      return num((e) => {
        const x = p(e);
        const o = seedOffset(seed(e));
        return fbmNoise3(x[0] + o[0], x[1] + o[1], x[2] + o[2], oct(e));
      });
    },
  },
  vnoise: {
    min: 1,
    max: 2,
    help: "vnoise(p[, seed]) → vector of 3 unrelated noises",
    build: (args, pos) => {
      const { p, seed } = noiseArgs(args, pos);
      const out = new Float64Array(3);
      return vec((e) => {
        const x = p(e);
        const o = seedOffset(seed(e));
        out[0] = signedNoise3(x[0] + o[0], x[1] + o[1], x[2] + o[2]);
        out[1] = signedNoise3(x[0] + o[0] + 113.5, x[1] + o[1] + 71.2, x[2] + o[2] + 19.9);
        out[2] = signedNoise3(x[0] + o[0] - 57.3, x[1] + o[1] + 141.7, x[2] + o[2] - 88.1);
        return out;
      });
    },
  },
  curl: {
    min: 1,
    max: 2,
    help: "curl(p[, seed]) → divergence-free vector",
    build: (args, pos) => {
      const { p, seed } = noiseArgs(args, pos);
      const out = new Float64Array(3);
      return vec((e) => {
        const x = p(e);
        const o = seedOffset(seed(e));
        curlNoise3(x[0] + o[0], x[1] + o[1], x[2] + o[2], out);
        return out;
      });
    },
  },
  rand: {
    min: 1,
    max: 2,
    help: "rand(x[, seed]) → 0…1",
    build: (args, pos) => {
      const seed = args[1] ? asFloat(args[1], "the seed", pos) : () => 0;
      const a = args[0];
      if (!isVec(a)) {
        const f = a.f;
        return num((e) => hashRandom(f(e), seed(e)));
      }
      const v = a.v;
      return num((e) => {
        const x = v(e);
        const s = seed(e);
        return hashRandom(x[0], hashRandom(x[1], hashRandom(x[2], s) * 1e6) * 1e6);
      });
    },
  },
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2, phi: (1 + Math.sqrt(5)) / 2, true: 1, false: 0 };

/** Function names and one-line signatures, for the node's help line. */
export const ATTRIB_EXPR_FUNCTIONS: readonly string[] = Object.values(FUNCTIONS).map((d) => d.help);

function tupleOf(args: C[], pos: number): C {
  if (args.length !== 3) throw new AttribExprError(`A vector has 3 components, got ${args.length}`, pos);
  const fs = args.map((a, k) => asFloat(a, `Component ${k + 1} of a vector`, pos));
  const [fx, fy, fz] = fs;
  const out = new Float64Array(3);
  return vec((e) => {
    out[0] = fx(e);
    out[1] = fy(e);
    out[2] = fz(e);
    return out;
  });
}

// ---------------------------------------------------------------- parser + compiler

const COMPONENTS: Record<string, number> = { x: 0, y: 1, z: 2, r: 0, g: 1, b: 2, u: 0, v: 1, w: 2 };

class Compiler {
  private i = 0;
  private inAbs = 0;
  readonly used: string[] = [];

  constructor(private tokens: Token[], private vars: Readonly<Record<string, VarSlot>>) {}

  private peek(): Token {
    return this.tokens[this.i];
  }
  private next(): Token {
    return this.tokens[this.i++];
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return t.kind === "op" && t.value === v;
  }
  private expect(v: string): void {
    const t = this.next();
    if (t.kind !== "op" || t.value !== v) throw new AttribExprError(t.kind === "end" ? `Missing "${v}"` : `Expected "${v}"`, t.pos);
  }
  private isVar(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.vars, name);
  }

  parseTop(): C {
    const c = this.parseTernary();
    const end = this.peek();
    if (end.kind !== "end") {
      if (end.kind === "op" && end.value === ")") throw new AttribExprError(`Unmatched ")"`, end.pos);
      if (end.kind === "op" && end.value === ",") throw new AttribExprError("A vector needs brackets: (x, y, z) or vec(x, y, z)", end.pos);
      throw new AttribExprError(`Unexpected "${"value" in end ? end.value : ""}"`, end.pos);
    }
    return c;
  }

  private parseTernary(): C {
    const condPos = this.peek().pos;
    const cond = this.parseOr();
    if (!this.isOp("?")) return cond;
    this.next();
    const fc = asFloat(cond, "A condition", condPos);
    const a = this.parseTernary();
    this.expect(":");
    const b = this.parseTernary();
    if (!isVec(a) && !isVec(b)) {
      const fa = a.f, fb = b.f;
      return num((e) => (fc(e) ? fa(e) : fb(e)));
    }
    const va = asVec(a), vb = asVec(b);
    return vec((e) => (fc(e) ? va(e) : vb(e)));
  }

  private parseOr(): C {
    let left = this.parseAnd();
    while (this.isOp("||")) {
      const pos = this.next().pos;
      const l = asFloat(left, "||", pos);
      const r = asFloat(this.parseAnd(), "||", pos);
      left = num((e) => (l(e) || r(e) ? 1 : 0));
    }
    return left;
  }

  private parseAnd(): C {
    let left = this.parseCompare();
    while (this.isOp("&&")) {
      const pos = this.next().pos;
      const l = asFloat(left, "&&", pos);
      const r = asFloat(this.parseCompare(), "&&", pos);
      left = num((e) => (l(e) && r(e) ? 1 : 0));
    }
    return left;
  }

  private parseCompare(): C {
    const left = this.parseAdd();
    const t = this.peek();
    if (t.kind !== "op" || !["<", "<=", ">", ">=", "==", "!="].includes(t.value)) return left;
    this.next();
    const right = this.parseAdd();
    const l = asFloat(left, `"${t.value}"`, t.pos);
    const r = asFloat(right, `"${t.value}"`, t.pos);
    switch (t.value) {
      case "<":
        return num((e) => (l(e) < r(e) ? 1 : 0));
      case "<=":
        return num((e) => (l(e) <= r(e) ? 1 : 0));
      case ">":
        return num((e) => (l(e) > r(e) ? 1 : 0));
      case ">=":
        return num((e) => (l(e) >= r(e) ? 1 : 0));
      case "==":
        return num((e) => (Math.abs(l(e) - r(e)) < 1e-9 ? 1 : 0));
      default:
        return num((e) => (Math.abs(l(e) - r(e)) >= 1e-9 ? 1 : 0));
    }
  }

  private parseAdd(): C {
    let left = this.parseMul();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.next() as { value: string }).value;
      const right = this.parseMul();
      left = op === "+" ? add(left, right) : sub(left, right);
    }
    return left;
  }

  /** Whether the next token can start a factor — what makes `2x`, `2 P` and `(a)(b)` products. */
  private startsFactor(): boolean {
    const t = this.peek();
    return t.kind === "num" || t.kind === "name" || (t.kind === "op" && (t.value === "(" || (t.value === "|" && this.inAbs === 0)));
  }

  private parseMul(): C {
    let left = this.parseUnary();
    for (;;) {
      if (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
        const op = (this.next() as { value: string }).value;
        const right = this.parseUnary();
        left = op === "*" ? mulC(left, right) : op === "/" ? map2(left, right, (x, y) => x / y) : map2(left, right, fmod);
      } else if (this.startsFactor()) {
        left = mulC(left, this.parseUnary());
      } else {
        return left;
      }
    }
  }

  private parseUnary(): C {
    if (this.isOp("-")) {
      this.next();
      return map1(this.parseUnary(), (x) => -x);
    }
    if (this.isOp("+")) {
      this.next();
      return this.parseUnary();
    }
    if (this.isOp("!")) {
      const pos = this.next().pos;
      const f = asFloat(this.parseUnary(), `"!"`, pos);
      return num((e) => (f(e) ? 0 : 1));
    }
    return this.parsePower();
  }

  private parsePower(): C {
    const base = this.parsePostfix();
    if (!this.isOp("^")) return base;
    this.next();
    const exp = this.parseUnary(); // right-associative, and 2^-1 works
    return map2(base, exp, Math.pow);
  }

  private parsePostfix(): C {
    let c = this.parsePrimary();
    while (this.isOp(".")) {
      const dot = this.next();
      const t = this.next();
      if (t.kind !== "name" || !(t.value in COMPONENTS)) throw new AttribExprError(`After "." write x, y or z`, dot.pos);
      if (!isVec(c)) throw new AttribExprError(`.${t.value} reads a vector component, but this is a number`, dot.pos);
      const v = c.v;
      const k = COMPONENTS[t.value];
      c = num((e) => v(e)[k]);
    }
    return c;
  }

  private parsePrimary(): C {
    const t = this.next();
    if (t.kind === "num") {
      const value = t.value;
      return num(() => value);
    }
    if (t.kind === "op" && t.value === "(") {
      const items = [this.parseTernary()];
      while (this.isOp(",")) {
        this.next();
        items.push(this.parseTernary());
      }
      this.expect(")");
      return items.length === 1 ? items[0] : tupleOf(items, t.pos);
    }
    if (t.kind === "op" && t.value === "|") {
      this.inAbs++;
      const inner = this.parseTernary();
      this.inAbs--;
      this.expect("|");
      return isVec(inner) ? num(lengthOf(inner)) : map1(inner, Math.abs);
    }
    if (t.kind === "name") return this.parseName(t.value, t.pos);
    if (t.kind === "end") throw new AttribExprError("The formula ends too early", t.pos);
    throw new AttribExprError(`Unexpected "${t.value}"`, t.pos);
  }

  private parseName(name: string, pos: number): C {
    const called = this.isOp("(");
    // A variable wins unless it is called: the edge attribute `length` and
    // the function `length(v)` can both appear in one formula.
    if (this.isVar(name) && !(called && name in FUNCTIONS)) return this.variable(name);
    if (name in FUNCTIONS) return this.parseCall(name, pos);
    if (name in CONSTANTS) {
      const c = CONSTANTS[name];
      return num(() => c);
    }
    throw new AttribExprError(`Unknown name "${name}"`, pos);
  }

  private variable(name: string): C {
    if (!this.used.includes(name)) this.used.push(name);
    const slot = this.vars[name];
    const o = slot.offset;
    if (slot.kind === "float") return num((e) => e[o]);
    const out = new Float64Array(3);
    return vec((e) => {
      out[0] = e[o];
      out[1] = e[o + 1];
      out[2] = e[o + 2];
      return out;
    });
  }

  private parseCall(name: string, pos: number): C {
    const def = FUNCTIONS[name];
    if (this.isOp("(")) {
      this.next();
      const args: C[] = [];
      if (!this.isOp(")")) {
        args.push(this.parseTernary());
        while (this.isOp(",")) {
          this.next();
          args.push(this.parseTernary());
        }
      }
      this.expect(")");
      if (args.length < def.min || args.length > def.max) {
        const n = def.min === def.max ? `${def.min}` : def.max === Infinity ? `${def.min} or more` : `${def.min} to ${def.max}`;
        throw new AttribExprError(`${name} takes ${n} argument${def.max === 1 ? "" : "s"}: ${def.help}`, pos);
      }
      return def.build(args, pos);
    }
    // `sin x`, `sin 2x`, `sqrt x²` — a one-argument function applied to the tight product that follows.
    if (def.min > 1) throw new AttribExprError(`${name} needs brackets: ${def.help}`, pos);
    if (!this.startsFactor() && !this.isOp("-")) throw new AttribExprError(`"${name}" needs an argument: ${def.help}`, pos);
    return def.build([this.parseTightProduct()], pos);
  }

  private parseTightProduct(): C {
    let c = this.parseUnary();
    while (this.startsFactor() && !this.nextIsFunction()) c = mulC(c, this.parseUnary());
    return c;
  }

  private nextIsFunction(): boolean {
    const t = this.peek();
    return t.kind === "name" && t.value in FUNCTIONS && !this.isVar(t.value);
  }
}

const add = (a: C, b: C) => map2(a, b, (x, y) => x + y);
const sub = (a: C, b: C) => map2(a, b, (x, y) => x - y);
const mulC = (a: C, b: C) => map2(a, b, (x, y) => x * y);

// ---------------------------------------------------------------- public API

const cache = new Map<string, CompiledAttribExpr | AttribExprError>();

function varsKey(vars: Readonly<Record<string, VarSlot>>): string {
  return Object.keys(vars)
    .sort()
    .map((k) => `${k}:${vars[k].kind === "vec3" ? "v" : "f"}${vars[k].offset}`)
    .join(",");
}

/**
 * Compiles a formula against declared variables. Throws AttribExprError (with
 * the position in the formula) on a mistake. Cached by formula + variables,
 * so re-evaluating a node whose formula did not change compiles nothing.
 */
export function compileAttribExpr(source: string, vars: Readonly<Record<string, VarSlot>>): CompiledAttribExpr {
  const hit = cachedAttribExpr(source, vars);
  if (hit instanceof AttribExprError) throw hit;
  return hit;
}

/** Like compileAttribExpr but returns the error instead of throwing. */
export function cachedAttribExpr(source: string, vars: Readonly<Record<string, VarSlot>>): CompiledAttribExpr | AttribExprError {
  const key = `${varsKey(vars)}|${source}`;
  let hit = cache.get(key);
  if (!hit) {
    try {
      hit = build(source, vars);
    } catch (e) {
      hit = e instanceof AttribExprError ? e : new AttribExprError(e instanceof Error ? e.message : String(e), 0);
    }
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
    cache.set(key, hit);
  }
  return hit;
}

function build(source: string, vars: Readonly<Record<string, VarSlot>>): CompiledAttribExpr {
  const text = normalise(source);
  if (!text.trim()) throw new AttribExprError("The formula is empty", 0);
  const compiler = new Compiler(tokenize(text), vars);
  const c = compiler.parseTop();
  if (isVec(c)) {
    const v = c.v;
    return {
      source,
      kind: "vec3",
      variables: compiler.used,
      evaluate(env, out, at = 0) {
        const r = v(env);
        out[at] = r[0];
        out[at + 1] = r[1];
        out[at + 2] = r[2];
      },
    };
  }
  const f = c.f;
  return {
    source,
    kind: "float",
    variables: compiler.used,
    evaluate(env, out, at = 0) {
      out[at] = f(env);
    },
  };
}

/**
 * Lays variables out in an env: each gets an offset (1 slot for a number,
 * 3 for a vector) in declaration order. Returns the slots and the env size.
 */
export function layoutVariables(decls: ReadonlyArray<{ name: string; kind: ExprKind }>): { vars: Record<string, VarSlot>; size: number } {
  const vars: Record<string, VarSlot> = {};
  let size = 0;
  for (const d of decls) {
    if (Object.prototype.hasOwnProperty.call(vars, d.name)) continue;
    vars[d.name] = { kind: d.kind, offset: size };
    size += d.kind === "vec3" ? 3 : 1;
  }
  return { vars, size };
}

/** One-shot evaluation, for tests and one-off use: scope values are numbers or [x, y, z]. */
export function evalAttribExpr(source: string, scope: Record<string, number | readonly number[]> = {}): number | [number, number, number] {
  const { vars, size } = layoutVariables(Object.entries(scope).map(([name, v]) => ({ name, kind: typeof v === "number" ? "float" : "vec3" })));
  const env = new Float64Array(size);
  for (const [name, v] of Object.entries(scope)) {
    const o = vars[name].offset;
    if (typeof v === "number") env[o] = v;
    else env.set([v[0] ?? 0, v[1] ?? 0, v[2] ?? 0], o);
  }
  const c = compileAttribExpr(source, vars);
  const out = new Float64Array(3);
  c.evaluate(env, out);
  return c.kind === "vec3" ? [out[0], out[1], out[2]] : out[0];
}
