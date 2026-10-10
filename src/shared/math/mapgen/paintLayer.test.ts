import { describe, expect, it } from "vitest";
import { PAINT_NEUTRAL, applyDab, createPaintGrid, decodePaint, encodePaint } from "./paintLayer";

const dab = { x: 0.5, y: 0.5, radius: 0.2, strength: 1, falloff: "smooth" as const };
const S = 64;

describe("paint layer", () => {
  it("starts neutral and raise/lower move it in opposite directions", () => {
    const g = createPaintGrid(S);
    expect(g.every((v) => v === PAINT_NEUTRAL)).toBe(true);
    const mid = 32 * S + 32;
    applyDab(g, S, { ...dab, tool: "raise" });
    expect(g[mid]).toBeGreaterThan(PAINT_NEUTRAL);
    const h = createPaintGrid(S);
    applyDab(h, S, { ...dab, tool: "lower" });
    expect(h[mid]).toBeLessThan(PAINT_NEUTRAL);
    const inv = createPaintGrid(S);
    applyDab(inv, S, { ...dab, tool: "raise", invert: true });
    expect(inv[mid]).toBeCloseTo(h[mid], 6);
  });

  it("only touches cells inside the radius", () => {
    const g = createPaintGrid(S);
    applyDab(g, S, { ...dab, tool: "raise", radius: 0.1 });
    expect(g[2 * S + 2]).toBe(PAINT_NEUTRAL);
    expect(g[32 * S + 32]).toBeGreaterThan(PAINT_NEUTRAL);
  });

  it("maps map-y to grid row (row 0 is y = 0)", () => {
    const g = createPaintGrid(S);
    applyDab(g, S, { ...dab, tool: "raise", x: 0.5, y: 0.1, radius: 0.05 });
    expect(g[Math.floor(0.1 * S) * S + 32]).toBeGreaterThan(PAINT_NEUTRAL);
    expect(g[Math.floor(0.9 * S) * S + 32]).toBe(PAINT_NEUTRAL);
  });

  it("clamps to [0, 1] and clips at the map edge without throwing", () => {
    const g = createPaintGrid(S);
    for (let i = 0; i < 100; i++) applyDab(g, S, { ...dab, tool: "raise", x: 0, y: 0, strength: 1 });
    expect(Math.max(...g)).toBeLessThanOrEqual(1);
    expect(applyDab(g, S, { ...dab, tool: "raise", x: 5, y: 5 })).toBe(false);
  });

  it("erase returns paint to neutral and smooth softens a spike", () => {
    const g = createPaintGrid(S);
    for (let i = 0; i < 10; i++) applyDab(g, S, { ...dab, tool: "raise" });
    const peak = g[32 * S + 32];
    for (let i = 0; i < 30; i++) applyDab(g, S, { ...dab, tool: "erase" });
    expect(Math.abs(g[32 * S + 32] - PAINT_NEUTRAL)).toBeLessThan(Math.abs(peak - PAINT_NEUTRAL));

    const h = createPaintGrid(S);
    h[32 * S + 32] = 1;
    applyDab(h, S, { ...dab, tool: "smooth", radius: 0.1 });
    expect(h[32 * S + 32]).toBeLessThan(1);
    expect(h[32 * S + 33]).toBeGreaterThan(PAINT_NEUTRAL);
  });

  it("round-trips through the saved string, keeping neutral exactly neutral", () => {
    const g = createPaintGrid(S);
    expect(encodePaint(g)).toBe("");
    applyDab(g, S, { ...dab, tool: "raise" });
    applyDab(g, S, { ...dab, tool: "lower", x: 0.1, y: 0.9, radius: 0.1 });
    const data = encodePaint(g);
    expect(data.length).toBeGreaterThan(0);
    expect(data.length).toBeLessThan(S * S);
    const back = decodePaint(data, S);
    for (let i = 0; i < g.length; i++) expect(back[i]).toBeCloseTo(g[i], 2);
    expect(back[0]).toBe(PAINT_NEUTRAL);
  });

  it("decodes garbage and wrong sizes to a blank grid", () => {
    expect(decodePaint("not base64 !!", S).every((v) => v === PAINT_NEUTRAL)).toBe(true);
    const g = createPaintGrid(S);
    applyDab(g, S, { ...dab, tool: "raise" });
    expect(decodePaint(encodePaint(g), S * 2).every((v) => v === PAINT_NEUTRAL)).toBe(true);
    expect(decodePaint(undefined, S).length).toBe(S * S);
  });
});
