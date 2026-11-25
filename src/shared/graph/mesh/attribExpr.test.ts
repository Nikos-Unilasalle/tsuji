import { describe, expect, it } from "vitest";
import { AttribExprError, compileAttribExpr, evalAttribExpr, layoutVariables, scanNames } from "./attribExpr";
import { curlNoise3, fbmNoise3, hashRandom, signedNoise3 } from "./attribNoise";

const ev = evalAttribExpr;
const vec = (v: unknown) => (v as number[]).map((x) => Math.round(x * 1e9) / 1e9);

function errorOf(src: string, scope: Record<string, number | number[]> = {}): AttribExprError {
  try {
    ev(src, scope);
  } catch (e) {
    if (e instanceof AttribExprError) return e;
    throw e;
  }
  throw new Error(`no error for ${src}`);
}

describe("attribExpr — scalars", () => {
  it("precedence and associativity", () => {
    expect(ev("1 + 2 * 3")).toBe(7);
    expect(ev("(1 + 2) * 3")).toBe(9);
    expect(ev("2 ^ 3 ^ 2")).toBe(512);
    expect(ev("-2 ^ 2")).toBe(-4);
    expect(ev("2 ^ -1")).toBe(0.5);
    expect(ev("10 - 4 - 3")).toBe(3);
    expect(ev("7 % 3")).toBe(1);
    expect(ev("-7 % 3")).toBe(2);
  });
  it("implicit multiplication and bracketless functions", () => {
    expect(ev("2x", { x: 3 })).toBe(6);
    expect(ev("2(x + 1)", { x: 3 })).toBe(8);
    expect(ev("sin x", { x: 0.5 })).toBeCloseTo(Math.sin(0.5));
    expect(ev("sin 2x", { x: 0.5 })).toBeCloseTo(Math.sin(1));
    expect(ev("2π")).toBeCloseTo(Math.PI * 2);
    expect(ev("x²", { x: 3 })).toBe(9);
    expect(ev("3 × 4 ÷ 2")).toBe(6);
  });
  it("comparisons, logic and ternary", () => {
    expect(ev("x > 1 ? 10 : 20", { x: 2 })).toBe(10);
    expect(ev("x > 1 ? 10 : 20", { x: 0 })).toBe(20);
    expect(ev("x > 0 && x < 1", { x: 0.5 })).toBe(1);
    expect(ev("x < 0 || x > 1", { x: 0.5 })).toBe(0);
    expect(ev("!x", { x: 0 })).toBe(1);
    expect(ev("x == 0.5", { x: 0.5 })).toBe(1);
    expect(ev("a ? b ? 1 : 2 : 3", { a: 1, b: 0 })).toBe(2);
  });
  it("functions", () => {
    expect(ev("clamp(5, 0, 1)")).toBe(1);
    expect(ev("mix(0, 10, 0.25)")).toBe(2.5);
    expect(ev("fract(2.75)")).toBe(0.75);
    expect(ev("mod(-1, 4)")).toBe(3);
    expect(ev("min(3, 1, 2)")).toBe(1);
    expect(ev("max(3, 1, 2)")).toBe(3);
    expect(ev("pow(2, 10)")).toBe(1024);
    expect(ev("sign(-3)")).toBe(-1);
    expect(ev("floor(1.7) + ceil(1.2)")).toBe(3);
    expect(ev("abs(-2) + |-3|")).toBe(5);
    expect(ev("smoothstep(0, 1, 0.5)")).toBe(0.5);
    expect(ev("fit(5, 0, 10, 0, 1)")).toBe(0.5);
    expect(ev("step(0.5, 0.7)")).toBe(1);
  });
  it("constants", () => {
    expect(ev("pi")).toBeCloseTo(Math.PI);
    expect(ev("true + false")).toBe(1);
  });
});

describe("attribExpr — vectors", () => {
  const P = [1, 2, 3];
  it("component access and construction", () => {
    expect(ev("P.y", { P })).toBe(2);
    expect(ev("P.x + P.z", { P })).toBe(4);
    expect(ev("Cd.r", { Cd: [0.1, 0.2, 0.3] })).toBe(0.1);
    expect(ev("(1, 2, 3)")).toEqual([1, 2, 3]);
    expect(ev("vec(1, 2, 3).z")).toBe(3);
    expect(ev("vec(2)")).toEqual([2, 2, 2]);
    expect(ev("(P.z, P.y, P.x)", { P })).toEqual([3, 2, 1]);
  });
  it("broadcast arithmetic", () => {
    expect(ev("P * 2", { P })).toEqual([2, 4, 6]);
    expect(ev("2P", { P })).toEqual([2, 4, 6]);
    expect(ev("P + 1", { P })).toEqual([2, 3, 4]);
    expect(ev("1 - P", { P })).toEqual([0, -1, -2]);
    expect(ev("P / 2", { P })).toEqual([0.5, 1, 1.5]);
    expect(ev("-P", { P })).toEqual([-1, -2, -3]);
    expect(ev("P * P", { P })).toEqual([1, 4, 9]);
    expect(ev("P ^ 2", { P })).toEqual([1, 4, 9]);
    expect(ev("P + N * 0.5", { P, N: [0, 2, 0] })).toEqual([1, 3, 3]);
  });
  it("vector functions", () => {
    expect(ev("length(P)", { P: [3, 4, 0] })).toBe(5);
    expect(ev("|P|", { P: [3, 4, 0] })).toBe(5);
    expect(ev("dot(P, N)", { P, N: [1, 1, 1] })).toBe(6);
    expect(ev("cross((1,0,0), (0,1,0))")).toEqual([0, 0, 1]);
    expect(vec(ev("normalize(P)", { P: [0, 3, 4] }))).toEqual([0, 0.6, 0.8]);
    expect(ev("normalize(vec(0))")).toEqual([0, 0, 0]);
    expect(ev("distance(P, (1, 2, 4))", { P })).toBe(1);
    expect(ev("abs((-1, 2, -3))")).toEqual([1, 2, 3]);
    expect(ev("max(P, 2)", { P })).toEqual([2, 2, 3]);
    expect(ev("clamp(P, 1.5, 2.5)", { P })).toEqual([1.5, 2, 2.5]);
    expect(ev("mix(vec(0), P, 0.5)", { P })).toEqual([0.5, 1, 1.5]);
    expect(ev("floor(P / 2)", { P })).toEqual([0, 1, 1]);
  });
  it("ternary mixes a number and a vector by broadcasting", () => {
    expect(ev("P.x > 0 ? P : 0", { P })).toEqual([1, 2, 3]);
    expect(ev("P.x < 0 ? P : 0", { P })).toEqual([0, 0, 0]);
  });
  it("noise, curl and rand", () => {
    const n = ev("noise(P)", { P }) as number;
    expect(n).toBeGreaterThanOrEqual(-1);
    expect(n).toBeLessThanOrEqual(1);
    expect(ev("noise(P)", { P })).toBe(n);
    expect(ev("noise(P, 1)", { P })).not.toBe(n);
    expect((ev("curl(P)", { P }) as number[]).length).toBe(3);
    const r = ev("rand(id)", { id: 5 }) as number;
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
    expect(ev("rand(id)", { id: 5 })).toBe(r);
    expect(ev("rand(id, 2)", { id: 5 })).not.toBe(r);
    expect(ev("rand(id)", { id: 6 })).not.toBe(r);
    expect(typeof ev("rand(P)", { P })).toBe("number");
    expect(typeof ev("fbm(P, 3)", { P })).toBe("number");
  });
  it("a variable named like a function is read unless called", () => {
    expect(ev("length + length((3, 4, 0))", { length: 1 })).toBe(6);
  });
});

describe("attribExpr — errors carry a position", () => {
  it("unknown names", () => {
    const e = errorOf("1 + foo");
    expect(e.message).toMatch(/Unknown name "foo"/);
    expect(e.position).toBe(4);
  });
  it("syntax", () => {
    expect(errorOf("(1 + 2").message).toMatch(/Missing "\)"/);
    expect(errorOf("1 +").message).toMatch(/ends too early/);
    expect(errorOf("1 )").message).toMatch(/Unmatched/);
    expect(errorOf("").message).toMatch(/empty/);
    expect(errorOf("1 # 2").position).toBe(2);
  });
  it("type mistakes", () => {
    expect(errorOf("P > 1", { P: [1, 2, 3] }).message).toMatch(/needs a number/);
    expect(errorOf("x.y", { x: 1 }).message).toMatch(/vector component/);
    expect(errorOf("P.q", { P: [1, 2, 3] }).message).toMatch(/x, y or z/);
    expect(errorOf("(1, 2)").message).toMatch(/3 components/);
    expect(errorOf("1, 2, 3").message).toMatch(/brackets/);
  });
  it("arity", () => {
    expect(errorOf("clamp(1, 2)").message).toMatch(/clamp takes 3/);
    expect(errorOf("pow 2").message).toMatch(/needs brackets/);
  });
});

describe("attribExpr — compile once, evaluate many", () => {
  it("is cached and reuses buffers safely", () => {
    const { vars, size } = layoutVariables([
      { name: "P", kind: "vec3" },
      { name: "id", kind: "float" },
    ]);
    const a = compileAttribExpr("normalize(P) * (id + 1) + cross(P, (0, 1, 0))", vars);
    expect(compileAttribExpr("normalize(P) * (id + 1) + cross(P, (0, 1, 0))", vars)).toBe(a);
    expect(a.kind).toBe("vec3");
    expect(a.variables).toEqual(["P", "id"]);
    const env = new Float64Array(size);
    const out = new Float64Array(6);
    env.set([1, 0, 0], vars.P.offset);
    env[vars.id.offset] = 0;
    a.evaluate(env, out, 0);
    env.set([0, 0, 2], vars.P.offset);
    env[vars.id.offset] = 1;
    a.evaluate(env, out, 3);
    expect(Array.from(out)).toEqual([1, 0, 1, -2, 0, 2]);
  });
  it("scanNames finds the variables, not the functions or components", () => {
    expect(scanNames("P + N * noise(P.y) + mass * length")).toEqual(["P", "N", "mass", "length"]);
    expect(scanNames("sin x")).toEqual(["sin", "x"]);
  });
});

describe("attribNoise", () => {
  it("is centred, bounded and deterministic", () => {
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (let i = 0; i < 2000; i++) {
      const v = signedNoise3(i * 0.37, i * 0.11, i * 0.73);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
      sum += v;
    }
    expect(lo).toBeGreaterThanOrEqual(-1);
    expect(hi).toBeLessThanOrEqual(1);
    expect(Math.abs(sum / 2000)).toBeLessThan(0.15);
    expect(fbmNoise3(0.3, 0.2, 0.1, 4)).toBe(fbmNoise3(0.3, 0.2, 0.1, 4));
    expect(Number.isFinite(fbmNoise3(NaN, 0, 0))).toBe(true);
    expect(hashRandom(1, 0)).not.toBe(hashRandom(2, 0));
  });
  it("curl is divergence free", () => {
    const h = 1e-2;
    const c = (x: number, y: number, z: number) => Array.from(curlNoise3(x, y, z));
    const p = [0.3, 0.7, 0.2];
    const div =
      (c(p[0] + h, p[1], p[2])[0] - c(p[0] - h, p[1], p[2])[0]) / (2 * h) +
      (c(p[0], p[1] + h, p[2])[1] - c(p[0], p[1] - h, p[2])[1]) / (2 * h) +
      (c(p[0], p[1], p[2] + h)[2] - c(p[0], p[1], p[2] - h)[2]) / (2 * h);
    const mag = Math.hypot(...c(p[0], p[1], p[2]));
    expect(Math.abs(div)).toBeLessThan(0.05 * Math.max(1, mag) + 0.05);
  });
});
