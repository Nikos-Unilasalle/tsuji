import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { LATEX_NODE } from "./latex";
import { EvalContext } from "../types";
import { typeset } from "../../math/latex";

const ctx = (nodeId: string): EvalContext => ({ nodeId, time: 0, step: 0 });
const params = (o: Record<string, unknown> = {}) => ({ ...(LATEX_NODE.defaultParams as Record<string, unknown>), ...o });

describe("typeset", () => {
  test("one glyph per symbol, each knowing its character", () => {
    const chars = typeset("e^{i\\pi}+1=0").glyphs.map((g) => g.char);
    expect(chars).toEqual(["𝑒", "𝑖", "𝜋", "+", "1", "=", "0"]);
  });

  test("y is up: a superscript sits above the baseline, a fraction straddles it", () => {
    const sup = typeset("x^2").glyphs.find((g) => g.char === "2")!;
    expect(sup.box.minY).toBeGreaterThan(0.2);
    const frac = typeset("\\frac{a}{b}");
    expect(frac.glyphs.map((g) => g.char)).toContain("rule");
    const a = frac.glyphs.find((g) => g.char === "𝑎")!, b = frac.glyphs.find((g) => g.char === "𝑏")!;
    expect(a.box.minY).toBeGreaterThan(b.box.maxY);
  });

  test("letters keep their holes", () => {
    const o = typeset("o").glyphs[0];
    expect(o.shapes[0].holes.length).toBe(1);
  });

  test("a TeX mistake is reported, not drawn", () => {
    const bad = typeset("\\frac{a}{");
    expect(bad.error).toMatch(/close brace/i);
    expect(bad.glyphs).toEqual([]);
  });
});

describe("LATEX_NODE", () => {
  test("draws the formula at the given size, centred on its anchor", () => {
    const out = LATEX_NODE.evaluate({}, params({ tex: "x^2", size: 2 }), ctx("tex-a"));
    const mesh = out.geometry as THREE.Mesh;
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox!;
    // x² is about 0.9 em wide; at 2 units per em, about 1.8 wide, centred.
    expect(box.max.x - box.min.x).toBeGreaterThan(1.5);
    expect(box.max.x - box.min.x).toBeLessThan(2.1);
    expect(box.min.x + box.max.x).toBeCloseTo(0, 6);
    expect(box.min.y + box.max.y).toBeCloseTo(0, 6);
  });

  test("At places it in math coordinates through a Space", () => {
    const space = new THREE.Matrix4().makeTranslation(10, 0, 0).multiply(new THREE.Matrix4().makeScale(2, 2, 2));
    const out = LATEX_NODE.evaluate({ space, at: new THREE.Vector3(1, 1, 0) }, params({ tex: "x" }), ctx("tex-b"));
    const p = new THREE.Vector3().setFromMatrixPosition((out.geometry as THREE.Mesh).matrix);
    expect(p.toArray()).toEqual([12, 2, 0]);
  });

  test("Drawn reveals the glyphs left to right", () => {
    const all = LATEX_NODE.evaluate({}, params({ tex: "abcd", progress: 1 }), ctx("tex-c")).count;
    const half = LATEX_NODE.evaluate({}, params({ tex: "abcd", progress: 0.5 }), ctx("tex-d")).count;
    expect(all).toBe(4);
    expect(half).toBe(2);
  });

  test("Curves hands on every outline, holes included", () => {
    const out = LATEX_NODE.evaluate({}, params({ tex: "o" }), ctx("tex-e"));
    expect((out.curves as unknown[]).length).toBe(2);
  });

  test("the panel shows the TeX error", () => {
    const fields = LATEX_NODE.dynamicParamFields!({ id: "t", type: "math/latex", position: { x: 0, y: 0 }, params: params({ tex: "\\frac{a}{" }) });
    expect(fields[0]).toMatchObject({ kind: "note", tone: "warn" });
  });

  test("unchanged formula keeps the same geometry", () => {
    const a = (LATEX_NODE.evaluate({}, params(), ctx("tex-f")).geometry as THREE.Mesh).geometry;
    const b = (LATEX_NODE.evaluate({}, params(), ctx("tex-f")).geometry as THREE.Mesh).geometry;
    expect(b).toBe(a);
  });

  test("On Top draws over everything", () => {
    const mesh = LATEX_NODE.evaluate({}, params({ onTop: true }), ctx("tex-top")).geometry as THREE.Mesh;
    expect((mesh.material as THREE.Material).depthTest).toBe(false);
    expect(mesh.renderOrder).toBeGreaterThan(0);
    const normal = LATEX_NODE.evaluate({}, params({ onTop: false }), ctx("tex-top")).geometry as THREE.Mesh;
    expect((normal.material as THREE.Material).depthTest).toBe(true);
  });
});
