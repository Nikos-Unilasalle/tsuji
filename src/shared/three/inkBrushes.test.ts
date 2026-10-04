import { describe, expect, test, vi } from "vitest";

const added = new Map<string, Record<string, unknown>>();
vi.mock("p5.brush/standalone", () => ({
  add: (name: string, params: Record<string, unknown>) => {
    added.set(name, params);
  },
}));

import { INK_BRUSH_NAMES, registerInkBrushes } from "./inkBrushes";
import { BRUSH_NAMES } from "./brushScene";
import { P5_GREASE_BRUSH_LABELS, P5_GREASE_BRUSH_TYPES } from "../graph/nodes/greasePencilP5";

/** Records what a tip draws: the strokes and fills it makes, and in which grey. */
function recordingSurface() {
  const marks: string[] = [];
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    beginPath() {},
    ellipse() {},
    moveTo() {},
    lineTo() {},
    fill() {
      marks.push(`fill ${ctx.fillStyle}`);
    },
    stroke() {
      marks.push(`stroke ${ctx.strokeStyle}`);
    },
  };
  return { marks, surface: { drawingContext: ctx } as never };
}

describe("ink brushes", () => {
  test("every ink brush is offered wherever p5.brush brushes are, with a label in the Grease Pencil menu", () => {
    for (const name of INK_BRUSH_NAMES) expect(BRUSH_NAMES).toContain(name);
    const labelled = new Set(P5_GREASE_BRUSH_LABELS.map(([type]) => type));
    for (const type of P5_GREASE_BRUSH_TYPES) expect(labelled.has(type)).toBe(true);
  });

  test("they press with the stroke's own pressure, turn with the stroke and add no blob at the ends", () => {
    registerInkBrushes();
    for (const name of INK_BRUSH_NAMES) {
      const params = added.get(name)!;
      expect(params.type).toBe("custom");
      expect(params.rotate).toBe("natural");
      expect(params.markerTip).toBe(false);
      expect(params.pressure).toEqual([1, 1]);
    }
  });

  test("a tip is bristles in dark ink, and the same bristles every time", () => {
    registerInkBrushes();
    const tip = added.get("sumi")!.tip as (surface: unknown) => void;
    const a = recordingSurface();
    const b = recordingSurface();
    tip(a.surface);
    tip(b.surface);
    expect(a.marks.filter((m) => m.startsWith("stroke")).length).toBeGreaterThan(40);
    expect(a.marks).toEqual(b.marks);
    const dry = recordingSurface();
    (added.get("sumi-dry")!.tip as (surface: unknown) => void)(dry.surface);
    expect(dry.marks.some((m) => m.startsWith("fill"))).toBe(false);
  });
});
