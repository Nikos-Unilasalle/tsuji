/**
 * Formulas as people write them — `2x² - 3x + 1`, `3sin x`, `(x+1)(x-1)`,
 * `√(1 - x²)`, `|x|`, `(cos t, sin t, t/4)` — compiled once into plain
 * closures, so a surface sampled ten thousand times a frame costs ten
 * thousand function calls, not ten thousand parses. No `eval`: a formula can
 * only ever compute numbers.
 *
 * Accepted on top of the usual operators: implicit multiplication (`2x`,
 * `2(x+1)`, `(a)(b)`, `x y`), a function applied without brackets to the
 * term that follows (`sin x`, `sinx` when `sinx` is not a name of its own —
 * `sin x²` is sin(x²)), `^` right-associative with `-x^2 = -(x^2)`,
 * comparisons with `?:` and `if(c, a, b)`, `|x|`, and the typography a
 * formula pasted from a document comes with (× ÷ · − √ π τ ² ³).
 *
 * `ln` is the natural log and `log` the decimal one, as taught in France;
 * `log(x, b)` takes any base.
 */

export class ExpressionError extends Error {
  constructor(message: string, readonly position: number) {
    super(message);
  }
}

export interface CompiledExpression {
  source: string;
  /** Names the formula reads, in order of first use. */
  variables: string[];
  /** How many numbers it yields: 1 for a plain formula, N for a tuple `(a, b, c)`. */
  dimension: number;
  /** Writes the result into `out` (length `dimension`). Missing variables read as 0. */
  evaluate(scope: Record<string, number>, out?: number[]): number[];
}

type Fn = (scope: Record<string, number>) => number;

const mul = (a: Fn, b: Fn): Fn => (s) => a(s) * b(s);

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2, phi: (1 + Math.sqrt(5)) / 2 };

function factorial(n: number): number {
  if (!(n >= 0) || n > 170) return n > 170 ? Infinity : NaN;
  let r = 1;
  for (let i = 2; i <= Math.floor(n); i++) r *= i;
  return r;
}

const FUNCTIONS: Record<string, { min: number; max: number; fn: (...a: number[]) => number }> = {
  sin: { min: 1, max: 1, fn: Math.sin },
  cos: { min: 1, max: 1, fn: Math.cos },
  tan: { min: 1, max: 1, fn: Math.tan },
  asin: { min: 1, max: 1, fn: Math.asin },
  acos: { min: 1, max: 1, fn: Math.acos },
  atan: { min: 1, max: 1, fn: Math.atan },
  arcsin: { min: 1, max: 1, fn: Math.asin },
  arccos: { min: 1, max: 1, fn: Math.acos },
  arctan: { min: 1, max: 1, fn: Math.atan },
  atan2: { min: 2, max: 2, fn: Math.atan2 },
  sec: { min: 1, max: 1, fn: (x) => 1 / Math.cos(x) },
  csc: { min: 1, max: 1, fn: (x) => 1 / Math.sin(x) },
  cot: { min: 1, max: 1, fn: (x) => 1 / Math.tan(x) },
  sinh: { min: 1, max: 1, fn: Math.sinh },
  cosh: { min: 1, max: 1, fn: Math.cosh },
  tanh: { min: 1, max: 1, fn: Math.tanh },
  sqrt: { min: 1, max: 1, fn: Math.sqrt },
  cbrt: { min: 1, max: 1, fn: Math.cbrt },
  abs: { min: 1, max: 1, fn: Math.abs },
  exp: { min: 1, max: 1, fn: Math.exp },
  ln: { min: 1, max: 1, fn: Math.log },
  log: { min: 1, max: 2, fn: (x, b) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)) },
  log2: { min: 1, max: 1, fn: Math.log2 },
  log10: { min: 1, max: 1, fn: Math.log10 },
  floor: { min: 1, max: 1, fn: Math.floor },
  ceil: { min: 1, max: 1, fn: Math.ceil },
  round: { min: 1, max: 1, fn: Math.round },
  sign: { min: 1, max: 1, fn: Math.sign },
  frac: { min: 1, max: 1, fn: (x) => x - Math.floor(x) },
  min: { min: 1, max: Infinity, fn: Math.min },
  max: { min: 1, max: Infinity, fn: Math.max },
  pow: { min: 2, max: 2, fn: Math.pow },
  hypot: { min: 1, max: Infinity, fn: Math.hypot },
  mod: { min: 2, max: 2, fn: (a, b) => a - b * Math.floor(a / b) },
  clamp: { min: 3, max: 3, fn: (x, lo, hi) => Math.min(hi, Math.max(lo, x)) },
  lerp: { min: 3, max: 3, fn: (a, b, t) => a + (b - a) * t },
  fact: { min: 1, max: 1, fn: factorial },
};

/** Typography from documents and keyboards, mapped onto the plain operators. */
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
    .replace(/φ/g, "phi")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/√/g, " sqrt ");
}

type Token =
  | { kind: "num"; value: number; pos: number }
  | { kind: "name"; value: string; pos: number }
  | { kind: "op"; value: string; pos: number }
  | { kind: "end"; pos: number };

const OPERATORS = ["<=", ">=", "==", "!=", "&&", "||", "+", "-", "*", "/", "%", "^", "(", ")", ",", "<", ">", "?", ":", "!", "|"];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new ExpressionError(`Unexpected "${c}"`, i);
      tokens.push({ kind: "num", value: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if (/[\p{L}_]/u.test(c)) {
      const m = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(src.slice(i))!;
      tokens.push({ kind: "name", value: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExpressionError(`Unexpected "${c}"`, i);
    tokens.push({ kind: "op", value: op, pos: i });
    i += op.length;
  }
  tokens.push({ kind: "end", pos: src.length });
  return tokens;
}

/**
 * Splits a run of letters nobody declared into names that are known —
 * `xy` into x·y, `sinx` into sin x — longest first. Undeclared and
 * unsplittable, it stays one name and is reported as unknown.
 */
function splitName(name: string, known: (n: string) => boolean): string[] | null {
  if (known(name)) return [name];
  for (let cut = name.length - 1; cut > 0; cut--) {
    const head = name.slice(0, cut);
    if (!known(head)) continue;
    const rest = splitName(name.slice(cut), known);
    if (rest) return [head, ...rest];
  }
  return null;
}

class Parser {
  private i = 0;
  readonly used: string[] = [];

  constructor(private tokens: Token[], private variables: Set<string> | null) {}

  private peek(): Token { return this.tokens[this.i]; }
  private next(): Token { return this.tokens[this.i++]; }
  private isOp(v: string): boolean { const t = this.peek(); return t.kind === "op" && t.value === v; }
  private expect(v: string): void {
    const t = this.next();
    if (t.kind !== "op" || t.value !== v) throw new ExpressionError(t.kind === "end" ? `Missing "${v}"` : `Expected "${v}"`, t.pos);
  }

  private known = (n: string): boolean => n in FUNCTIONS || n in CONSTANTS || (this.variables ? this.variables.has(n) : n.length === 1);

  /** Top level: a single formula, or a comma tuple with or without brackets. */
  parseTop(): Fn[] {
    const parts = [this.parseTernary()];
    while (this.isOp(",")) { this.next(); parts.push(this.parseTernary()); }
    const end = this.peek();
    if (end.kind !== "end") throw new ExpressionError(end.kind === "op" && end.value === ")" ? `Unmatched ")"` : `Unexpected "${"value" in end ? end.value : ""}"`, end.pos);
    return parts;
  }

  private parseTernary(): Fn {
    const cond = this.parseOr();
    if (!this.isOp("?")) return cond;
    this.next();
    const a = this.parseTernary();
    this.expect(":");
    const b = this.parseTernary();
    return (s) => (cond(s) ? a(s) : b(s));
  }

  private parseOr(): Fn {
    let left = this.parseAnd();
    while (this.isOp("||")) { this.next(); const l = left, r = this.parseAnd(); left = (s) => (l(s) || r(s) ? 1 : 0); }
    return left;
  }

  private parseAnd(): Fn {
    let left = this.parseCompare();
    while (this.isOp("&&")) { this.next(); const l = left, r = this.parseCompare(); left = (s) => (l(s) && r(s) ? 1 : 0); }
    return left;
  }

  private parseCompare(): Fn {
    const left = this.parseAdd();
    const t = this.peek();
    if (t.kind !== "op" || !["<", "<=", ">", ">=", "==", "!="].includes(t.value)) return left;
    this.next();
    const right = this.parseAdd();
    switch (t.value) {
      case "<": return (s) => (left(s) < right(s) ? 1 : 0);
      case "<=": return (s) => (left(s) <= right(s) ? 1 : 0);
      case ">": return (s) => (left(s) > right(s) ? 1 : 0);
      case ">=": return (s) => (left(s) >= right(s) ? 1 : 0);
      case "==": return (s) => (Math.abs(left(s) - right(s)) < 1e-12 ? 1 : 0);
      default: return (s) => (Math.abs(left(s) - right(s)) >= 1e-12 ? 1 : 0);
    }
  }

  private parseAdd(): Fn {
    let left = this.parseMul();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next() as { value: string };
      const l = left, r = this.parseMul();
      left = op.value === "+" ? (s) => l(s) + r(s) : (s) => l(s) - r(s);
    }
    return left;
  }

  /** Whether the next token can start a factor — what makes `2x` and `(a)(b)` products. */
  private startsFactor(): boolean {
    const t = this.peek();
    return t.kind === "num" || t.kind === "name" || (t.kind === "op" && (t.value === "(" || t.value === "|"));
  }

  private parseMul(): Fn {
    let left = this.parseUnary();
    for (;;) {
      if (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
        const op = (this.next() as { value: string }).value;
        const l = left, r = this.parseUnary();
        left = op === "*" ? (s) => l(s) * r(s) : op === "/" ? (s) => l(s) / r(s) : (s) => { const b = r(s); return l(s) - b * Math.floor(l(s) / b); };
      } else if (this.startsFactor() && !(this.isOp("|") && this.inAbs > 0)) {
        const l = left, r = this.parseUnary();
        left = (s) => l(s) * r(s);
      } else {
        return left;
      }
    }
  }

  private parseUnary(): Fn {
    if (this.isOp("-")) { this.next(); const v = this.parseUnary(); return (s) => -v(s); }
    if (this.isOp("+")) { this.next(); return this.parseUnary(); }
    if (this.isOp("!")) { this.next(); const v = this.parseUnary(); return (s) => (v(s) ? 0 : 1); }
    return this.parsePower();
  }

  private parsePower(): Fn {
    const base = this.parsePostfix();
    if (!this.isOp("^")) return base;
    this.next();
    const exp = this.parseUnary();
    return (s) => Math.pow(base(s), exp(s));
  }

  private parsePostfix(): Fn {
    let v = this.parsePrimary();
    // `n!` — but not the `!` of `!=`, which the tokenizer already took whole.
    while (this.isOp("!")) { this.next(); const inner = v; v = (s) => factorial(inner(s)); }
    return v;
  }

  private inAbs = 0;

  private parsePrimary(): Fn {
    const t = this.next();
    if (t.kind === "num") { const value = t.value; return () => value; }
    if (t.kind === "op" && t.value === "(") {
      const inner = this.parseTernary();
      if (this.isOp(",")) throw new ExpressionError("A list in brackets is only allowed as the whole formula, e.g. (cos t, sin t)", this.peek().pos);
      this.expect(")");
      return inner;
    }
    if (t.kind === "op" && t.value === "|") {
      this.inAbs++;
      const inner = this.parseTernary();
      this.inAbs--;
      this.expect("|");
      return (s) => Math.abs(inner(s));
    }
    if (t.kind === "name") return this.parseName(t.value, t.pos);
    if (t.kind === "end") throw new ExpressionError("The formula ends too early", t.pos);
    throw new ExpressionError(`Unexpected "${t.value}"`, t.pos);
  }

  private parseName(raw: string, pos: number): Fn {
    const parts = splitName(raw, this.known);
    if (!parts) throw new ExpressionError(`Unknown name "${raw}"`, pos);
    // A split name: rebuild as a product, the last part taking any call or argument.
    let acc: Fn | null = null;
    for (let k = 0; k < parts.length; k++) {
      const part = parts[k];
      const last = k === parts.length - 1;
      if (part in FUNCTIONS && !last) {
        // `sinx`: the function takes the rest of the split name as its argument.
        const rest = parts.slice(k + 1);
        const restFn = this.productOf(rest, pos);
        const def = FUNCTIONS[part];
        const call: Fn = (s) => def.fn(restFn(s));
        return acc ? mul(acc, call) : call;
      }
      let f: Fn;
      if (part in FUNCTIONS) f = this.parseCall(part, pos);
      else if (part in CONSTANTS) { const c = CONSTANTS[part]; f = () => c; }
      else {
        if (!this.used.includes(part)) this.used.push(part);
        f = (s) => s[part] ?? 0;
      }
      acc = acc ? mul(acc, f) : f;
    }
    return acc!;
  }

  private productOf(parts: string[], pos: number): Fn {
    const fns = parts.map((p) => {
      if (p in CONSTANTS) { const c = CONSTANTS[p]; return () => c; }
      if (p in FUNCTIONS) throw new ExpressionError(`"${p}" needs an argument`, pos);
      if (!this.used.includes(p)) this.used.push(p);
      return (s: Record<string, number>) => s[p] ?? 0;
    });
    return (s) => fns.reduce((acc, f) => acc * f(s), 1);
  }

  /** `f(a, b)`, or `f x` — a function applied to the factor that follows. */
  private parseCall(name: string, pos: number): Fn {
    const def = FUNCTIONS[name];
    if (this.isOp("(")) {
      this.next();
      const args: Fn[] = [];
      if (!this.isOp(")")) {
        args.push(this.parseTernary());
        while (this.isOp(",")) { this.next(); args.push(this.parseTernary()); }
      }
      this.expect(")");
      if (name === "if") return this.ifCall(args, pos);
      if (args.length < def.min || args.length > def.max) {
        throw new ExpressionError(`${name} takes ${def.min === def.max ? def.min : `${def.min} to ${def.max === Infinity ? "any number of" : def.max}`} argument${def.max === 1 ? "" : "s"}`, pos);
      }
      if (args.length === 1) { const a = args[0]; return (s) => def.fn(a(s)); }
      if (args.length === 2) { const [a, b] = args; return (s) => def.fn(a(s), b(s)); }
      return (s) => def.fn(...args.map((a) => a(s)));
    }
    if (def.min > 1) throw new ExpressionError(`${name} needs brackets: ${name}(…)`, pos);
    if (!this.startsFactor() && !this.isOp("-")) throw new ExpressionError(`"${name}" needs an argument`, pos);
    const arg = this.parseTightProduct();
    return (s) => def.fn(arg(s));
  }

  /**
   * The argument of a function written without brackets: `sin x²` is
   * sin(x²) and `sin 2x` is sin(2x) — the implicit product that follows,
   * up to an explicit operator or the next function (`sin x cos x`).
   */
  private parseTightProduct(): Fn {
    let v = this.parseUnary();
    while (this.startsFactor() && !this.nextIsFunction() && !(this.isOp("|") && this.inAbs > 0)) {
      const l = v, r = this.parseUnary();
      v = (s) => l(s) * r(s);
    }
    return v;
  }

  private nextIsFunction(): boolean {
    const t = this.peek();
    if (t.kind !== "name") return false;
    const parts = splitName(t.value, this.known);
    return !!parts && parts[0] in FUNCTIONS;
  }

  private ifCall(args: Fn[], pos: number): Fn {
    if (args.length !== 3) throw new ExpressionError("if takes 3 arguments: if(condition, then, else)", pos);
    const [c, a, b] = args;
    return (s) => (c(s) ? a(s) : b(s));
  }
}

// `if` behaves like a function to the parser, with its own arity check.
FUNCTIONS.if = { min: 3, max: 3, fn: () => NaN };

/**
 * Compiles a formula. `variables` lists the names it may read; letters run
 * together are split into them (`xy` → x·y). Left out, any single letter is
 * a variable. Throws ExpressionError, with the position, on a mistake.
 */
export function compileExpression(source: string, variables?: string[]): CompiledExpression {
  const text = normalise(source);
  if (!text.trim()) throw new ExpressionError("The formula is empty", 0);
  // A tuple written with its brackets — (cos t, sin t) — is the same tuple without them.
  const trimmed = text.trim();
  const unwrapped = trimmed.startsWith("(") && trimmed.endsWith(")") && isOneGroup(trimmed) && hasTopLevelComma(trimmed.slice(1, -1)) ? trimmed.slice(1, -1) : text;
  const parser = new Parser(tokenize(unwrapped), variables ? new Set(variables) : null);
  const parts = parser.parseTop();
  return {
    source,
    variables: parser.used,
    dimension: parts.length,
    evaluate(scope, out = new Array(parts.length)) {
      for (let k = 0; k < parts.length; k++) out[k] = parts[k](scope);
      return out;
    },
  };
}

function isOneGroup(s: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") { depth--; if (depth === 0 && i < s.length - 1) return false; }
  }
  return depth === 0;
}

function hasTopLevelComma(s: string): boolean {
  let depth = 0;
  for (const c of s) {
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) return true;
  }
  return false;
}
