import type { PolyMesh } from "../quadMesh";
import {
  ATTR_DOMAINS,
  attributeType,
  domainSize,
  listGroups,
  readAttribute,
  type AttrDomain,
} from "./polyAttributes";
import { promoteMask } from "./promote";

/*
 * Group expressions — what a modifier's Group field accepts.
 *
 *   (empty) or *          every element
 *   top                   the group (bool attribute) "top"
 *   top border            union (space-separated, like Houdini)
 *   top | border          union
 *   top & !border         intersection, negation
 *   a ^ b                 exclusive or
 *   ( ... )               grouping
 *   rim_*                 every group whose name matches the wildcard
 *   12   3-8   0-20:2     element indices, ranges, ranges with a step
 *   @P.y>0.5              ad-hoc test on any attribute (component .x .y .z,
 *   @piece==2               or .r .g .b; operators == != < > <= >=)
 *   @weight               non-zero attribute value
 *
 * A name that only exists on another domain is promoted (a point group used
 * on faces selects the faces whose points are all in it — see promote.ts).
 * An unknown name selects nothing and is reported in `unknown`, so the node
 * can say so instead of silently doing nothing.
 *
 * Precedence, loosest first: union (| or space), ^, &, !.
 */

type Node =
  | { kind: "all" }
  | { kind: "name"; pattern: string }
  | { kind: "range"; from: number; to: number; step: number }
  | { kind: "test"; attr: string; component: number; op: string | null; value: number }
  | { kind: "not"; a: Node }
  | { kind: "and" | "or" | "xor"; a: Node; b: Node };

export class GroupExprError extends Error {}

type Token = { t: "op"; v: string } | { t: "name"; v: string } | { t: "range"; from: number; to: number; step: number } | { t: "test"; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s|,/.test(ch)) {
      i++;
      continue;
    }
    if ("()&|^!".includes(ch)) {
      out.push({ t: "op", v: ch });
      i++;
      continue;
    }
    if (ch === "@") {
      const m = /^@([A-Za-z_][A-Za-z0-9_]*)(\.[xyzrgb])?\s*(==|!=|<=|>=|<|>|=)?\s*(-?\d*\.?\d+(?:e-?\d+)?)?/.exec(src.slice(i));
      if (!m) throw new GroupExprError(`bad attribute test at "${src.slice(i)}"`);
      out.push({ t: "test", v: m[0] });
      i += m[0].length;
      continue;
    }
    if (/\d/.test(ch)) {
      const m = /^(\d+)(?:-(\d+))?(?::(\d+))?/.exec(src.slice(i))!;
      const from = Number(m[1]);
      const to = m[2] !== undefined ? Number(m[2]) : from;
      const step = m[3] !== undefined ? Math.max(1, Number(m[3])) : 1;
      out.push({ t: "range", from: Math.min(from, to), to: Math.max(from, to), step });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_*]/.test(ch)) {
      const m = /^[A-Za-z0-9_*]+/.exec(src.slice(i))!;
      out.push({ t: "name", v: m[0] });
      i += m[0].length;
      continue;
    }
    throw new GroupExprError(`unexpected "${ch}"`);
  }
  return out;
}

function parseTest(text: string): Node {
  const m = /^@([A-Za-z_][A-Za-z0-9_]*)(\.[xyzrgb])?\s*(==|!=|<=|>=|<|>|=)?\s*(-?\d*\.?\d+(?:e-?\d+)?)?$/.exec(text.trim())!;
  const comp = m[2] ? "xyzrgb".indexOf(m[2][1]) % 3 : -1;
  const op = m[3] ? (m[3] === "=" ? "==" : m[3]) : null;
  if (op && m[4] === undefined) throw new GroupExprError(`missing value after ${op}`);
  return { kind: "test", attr: m[1], component: comp, op, value: m[4] !== undefined ? Number(m[4]) : 0 };
}

export function parseGroupExpr(source: string): Node {
  const tokens = tokenize(source);
  if (tokens.length === 0) return { kind: "all" };
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.t === "op" && (peek() as { v: string }).v === v;
  const startsTerm = () => {
    const tk = peek();
    if (!tk) return false;
    if (tk.t !== "op") return true;
    return tk.v === "(" || tk.v === "!";
  };

  const parseUnion = (): Node => {
    let left = parseXor();
    for (;;) {
      if (isOp("|")) {
        pos++;
        left = { kind: "or", a: left, b: parseXor() };
      } else if (startsTerm()) {
        left = { kind: "or", a: left, b: parseXor() };
      } else return left;
    }
  };
  const parseXor = (): Node => {
    let left = parseAnd();
    while (isOp("^")) {
      pos++;
      left = { kind: "xor", a: left, b: parseAnd() };
    }
    return left;
  };
  const parseAnd = (): Node => {
    let left = parseUnary();
    while (isOp("&")) {
      pos++;
      left = { kind: "and", a: left, b: parseUnary() };
    }
    return left;
  };
  const parseUnary = (): Node => {
    if (isOp("!")) {
      pos++;
      return { kind: "not", a: parseUnary() };
    }
    const tk = peek();
    if (!tk) throw new GroupExprError("expression ends too early");
    if (tk.t === "op") {
      if (tk.v === "(") {
        pos++;
        const inner = parseUnion();
        if (!isOp(")")) throw new GroupExprError("missing )");
        pos++;
        return inner;
      }
      throw new GroupExprError(`unexpected "${tk.v}"`);
    }
    pos++;
    if (tk.t === "range") return { kind: "range", from: tk.from, to: tk.to, step: tk.step };
    if (tk.t === "test") return parseTest(tk.v);
    if (tk.v === "*") return { kind: "all" };
    return { kind: "name", pattern: tk.v };
  };

  const node = parseUnion();
  if (pos < tokens.length) throw new GroupExprError(`unexpected "${(tokens[pos] as { v?: string }).v ?? "?"}"`);
  return node;
}

export interface GroupEvalResult {
  mask: Uint8Array;
  /** Names the expression used that the mesh doesn't have. */
  unknown: string[];
  /** Parse error, if any (then `mask` selects everything, so a typo doesn't wipe the mesh). */
  error?: string;
}

const wildcardRegex = (pattern: string) => new RegExp("^" + pattern.replace(/\*/g, "[A-Za-z0-9_]*") + "$");

/**
 * Evaluates a group expression on one domain of a mesh. An empty expression
 * selects everything. A parse error selects everything too (and is reported):
 * half-typed expressions are the normal state of a text field being edited,
 * and wiping the geometry downstream at every keystroke would be hostile.
 */
export function evaluateGroup(mesh: PolyMesh, domain: AttrDomain, source: string | null | undefined): GroupEvalResult {
  const count = domainSize(mesh, domain);
  const text = String(source ?? "").trim();
  if (!text) return { mask: new Uint8Array(count).fill(1), unknown: [] };
  let tree: Node;
  try {
    tree = parseGroupExpr(text);
  } catch (e) {
    return { mask: new Uint8Array(count).fill(1), unknown: [], error: e instanceof Error ? e.message : String(e) };
  }
  const unknown = new Set<string>();

  const nameMask = (name: string): Uint8Array => {
    if (attributeType(mesh, domain, name)) return truthy(mesh, domain, name, count);
    for (const other of ATTR_DOMAINS) {
      if (other === domain || !attributeType(mesh, other, name)) continue;
      return promoteMask(mesh, other, domain, truthy(mesh, other, name, domainSize(mesh, other)));
    }
    unknown.add(name);
    return new Uint8Array(count);
  };

  const evalNode = (node: Node): Uint8Array => {
    switch (node.kind) {
      case "all":
        return new Uint8Array(count).fill(1);
      case "name": {
        if (!node.pattern.includes("*")) return nameMask(node.pattern);
        const re = wildcardRegex(node.pattern);
        const out = new Uint8Array(count);
        const names = new Set(listGroups(mesh).map((g) => g.name).filter((n) => re.test(n)));
        if (names.size === 0) unknown.add(node.pattern);
        for (const n of names) {
          const m = nameMask(n);
          for (let i = 0; i < count; i++) out[i] |= m[i];
        }
        return out;
      }
      case "range": {
        const out = new Uint8Array(count);
        for (let i = node.from; i <= node.to && i < count; i += node.step) out[i] = 1;
        return out;
      }
      case "test": {
        let on = domain;
        if (!attributeType(mesh, domain, node.attr)) {
          const other = ATTR_DOMAINS.find((d) => attributeType(mesh, d, node.attr));
          if (!other) {
            unknown.add("@" + node.attr);
            return new Uint8Array(count);
          }
          on = other;
        }
        const values = readAttribute(mesh, on, node.attr)!;
        const n = domainSize(mesh, on);
        const local = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          let v: number;
          if (node.component >= 0 && values.size > 1) v = values.values[i * values.size + Math.min(node.component, values.size - 1)];
          else if (values.size > 1) v = Math.hypot(values.values[i * 3], values.values[i * 3 + 1], values.values[i * 3 + 2]);
          else v = values.values[i];
          local[i] = compare(v, node.op, node.value) ? 1 : 0;
        }
        return on === domain ? local : promoteMask(mesh, on, domain, local);
      }
      case "not": {
        const a = evalNode(node.a);
        for (let i = 0; i < count; i++) a[i] = a[i] ? 0 : 1;
        return a;
      }
      default: {
        const a = evalNode(node.a);
        const b = evalNode(node.b);
        for (let i = 0; i < count; i++) {
          a[i] = node.kind === "and" ? a[i] & b[i] : node.kind === "or" ? a[i] | b[i] : a[i] ^ b[i];
        }
        return a;
      }
    }
  };

  return { mask: evalNode(tree), unknown: [...unknown] };
}

function compare(v: number, op: string | null, value: number): boolean {
  switch (op) {
    case null:
      return v !== 0;
    case "==":
      return Math.abs(v - value) < 1e-6;
    case "!=":
      return Math.abs(v - value) >= 1e-6;
    case "<":
      return v < value;
    case ">":
      return v > value;
    case "<=":
      return v <= value;
    case ">=":
      return v >= value;
    default:
      return false;
  }
}

function truthy(mesh: PolyMesh, domain: AttrDomain, name: string, count: number): Uint8Array {
  const values = readAttribute(mesh, domain, name);
  const out = new Uint8Array(count);
  if (!values) return out;
  for (let i = 0; i < count; i++) {
    let any = false;
    for (let c = 0; c < values.size; c++) if (values.values[i * values.size + c] !== 0) any = true;
    out[i] = any ? 1 : 0;
  }
  return out;
}

/** Indices of the selected elements. */
export function maskIndices(mask: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) out.push(i);
  return out;
}

/** True when the expression is valid. */
export function validateGroupExpr(source: string): string | null {
  try {
    parseGroupExpr(source);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
