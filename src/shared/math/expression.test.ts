import { describe, expect, test } from "vitest";
import { compileExpression, ExpressionError } from "./expression";

const VARS = ["x", "y", "z", "t", "a", "b", "c", "u", "v", "n", "theta", "θ", "r"];
const at = (src: string, scope: Record<string, number> = {}) => compileExpression(src, VARS).evaluate(scope);
const one = (src: string, scope: Record<string, number> = {}) => at(src, scope)[0];

describe("compileExpression", () => {
  test("arithmetic with the usual precedence", () => {
    expect(one("1 + 2 * 3")).toBe(7);
    expect(one("(1 + 2) * 3")).toBe(9);
    expect(one("2 ^ 3 ^ 2")).toBe(512);
    expect(one("-2^2")).toBe(-4);
    expect(one("2^-1")).toBe(0.5);
    expect(one("7 % 3")).toBe(1);
    expect(one("1e3 + .5")).toBe(1000.5);
  });

  test("variables, and what a formula reads", () => {
    const f = compileExpression("a*x^2 + b*x + c", VARS);
    expect(f.variables).toEqual(["a", "x", "b", "c"]);
    expect(f.evaluate({ a: 1, b: -3, c: 2, x: 2 })[0]).toBe(0);
  });

  test("implicit multiplication the way it is written by hand", () => {
    expect(one("2x", { x: 3 })).toBe(6);
    expect(one("2x²", { x: 3 })).toBe(18);
    expect(one("2(x+1)", { x: 3 })).toBe(8);
    expect(one("(x+1)(x-1)", { x: 3 })).toBe(8);
    expect(one("xy", { x: 2, y: 5 })).toBe(10);
    expect(one("3 x y", { x: 2, y: 5 })).toBe(30);
    expect(one("2pi")).toBeCloseTo(Math.PI * 2, 12);
  });

  test("functions with and without brackets", () => {
    expect(one("sin(x)", { x: 1 })).toBeCloseTo(Math.sin(1), 12);
    expect(one("sin x", { x: 1 })).toBeCloseTo(Math.sin(1), 12);
    expect(one("sinx", { x: 1 })).toBeCloseTo(Math.sin(1), 12);
    expect(one("3sin x", { x: 1 })).toBeCloseTo(3 * Math.sin(1), 12);
    expect(one("sin x²", { x: 2 })).toBeCloseTo(Math.sin(4), 12);
    expect(one("sin 2x", { x: 0.3 })).toBeCloseTo(Math.sin(0.6), 12);
    expect(one("sin x cos x", { x: 0.3 })).toBeCloseTo(Math.sin(0.3) * Math.cos(0.3), 12);
    expect(one("max(1, 5, 3)")).toBe(5);
    expect(one("atan2(1, 1)")).toBeCloseTo(Math.PI / 4, 12);
  });

  test("ln is natural, log is decimal, log(x, b) any base", () => {
    expect(one("ln e")).toBeCloseTo(1, 12);
    expect(one("log 1000")).toBeCloseTo(3, 12);
    expect(one("log(8, 2)")).toBeCloseTo(3, 12);
  });

  test("typography pasted from a document", () => {
    expect(one("2 × 3 ÷ 4")).toBe(1.5);
    expect(one("x² − 1", { x: 3 })).toBe(8);
    expect(one("√(1 − x²)", { x: 0.6 })).toBeCloseTo(0.8, 12);
    expect(one("√x", { x: 9 })).toBe(3);
    expect(one("π")).toBeCloseTo(Math.PI, 12);
    expect(one("cos θ", { θ: 0 })).toBe(1);
    expect(one("x³", { x: 2 })).toBe(8);
  });

  test("absolute value bars", () => {
    expect(one("|x|", { x: -3 })).toBe(3);
    expect(one("2|x - 1|", { x: -1 })).toBe(4);
    expect(one("|x| + |y|", { x: -1, y: -2 })).toBe(3);
  });

  test("conditions for piecewise functions", () => {
    expect(one("x < 0 ? -x : x", { x: -2 })).toBe(2);
    expect(one("if(x >= 1, 10, 20)", { x: 1 })).toBe(10);
    expect(one("x > 0 && x < 1", { x: 0.5 })).toBe(1);
    expect(one("x ≤ 2", { x: 2 })).toBe(1);
    expect(one("5!")).toBe(120);
  });

  test("a tuple gives a vector, with or without its brackets", () => {
    expect(compileExpression("(cos t, sin t, t/4)", VARS).dimension).toBe(3);
    const v = at("(cos t, sin t, t/4)", { t: Math.PI });
    expect(v[0]).toBeCloseTo(-1, 12);
    expect(v[1]).toBeCloseTo(0, 12);
    expect(v[2]).toBeCloseTo(Math.PI / 4, 12);
    expect(at("cos t, sin t", { t: 0 })).toEqual([1, 0]);
    // Brackets around a plain formula are only grouping.
    expect(compileExpression("(x + 1)", VARS).dimension).toBe(1);
    expect(compileExpression("(x+1)(x-1)", VARS).dimension).toBe(1);
  });

  test("mistakes are reported with where they are", () => {
    const fails = (src: string) => {
      try {
        compileExpression(src, VARS);
      } catch (e) {
        expect(e).toBeInstanceOf(ExpressionError);
        return (e as ExpressionError).message;
      }
      throw new Error(`"${src}" compiled`);
    };
    expect(fails("")).toMatch(/empty/);
    expect(fails("2 +")).toMatch(/ends too early/);
    expect(fails("(x + 1")).toMatch(/Missing "\)"/);
    expect(fails("x + 1)")).toMatch(/Unmatched/);
    expect(fails("foo(x)")).toMatch(/Unknown name "foo"/);
    expect(fails("2 $ 3")).toMatch(/Unexpected "\$"/);
    expect(fails("atan2(1)")).toMatch(/atan2 takes 2/);
    try { compileExpression("x + qq", VARS); } catch (e) { expect((e as ExpressionError).position).toBe(4); }
  });

  test("out-of-domain values come out as NaN, not as an exception", () => {
    expect(one("sqrt(-1)")).toBeNaN();
    expect(one("1/0")).toBe(Infinity);
    expect(one("ln 0")).toBe(-Infinity);
  });

  test("evaluation is fast enough for a dense surface", () => {
    const f = compileExpression("sin(x) * cos(y) + 0.1 x y", VARS);
    const scope = { x: 0, y: 0 };
    const out = [0];
    const start = performance.now();
    for (let i = 0; i < 200_000; i++) {
      scope.x = i * 1e-4;
      scope.y = i * 2e-4;
      f.evaluate(scope, out);
    }
    expect(performance.now() - start).toBeLessThan(500);
  });
});
