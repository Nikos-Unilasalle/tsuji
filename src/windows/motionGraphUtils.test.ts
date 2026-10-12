import { describe, expect, it } from "vitest";
import {
  bezierApproximating,
  bezierFromHandle,
  bezierHandlePositions,
  buildChannels,
  channelColor,
  DEFAULT_BEZIER,
  fitValueView,
  formatTick,
  makeNormalizer,
  makeValueAxis,
  niceTicks,
  sampleSegment,
  zoomValueView,
} from "./motionGraphUtils";
import { computeSegmentEasing } from "../shared/graph/evaluate";
import { Graph, Keyframe } from "../shared/graph/types";

function graphWith(keyframes: Graph["keyframes"]): Graph {
  return {
    nodes: [{ id: "n1", type: "transform", position: { x: 0, y: 0 }, params: {} }],
    connections: [],
    keyframes,
  };
}

const key = (frame: number, value: unknown, extra: Partial<Keyframe> = {}): Keyframe => ({
  frame,
  value,
  ...extra,
});

describe("buildChannels", () => {
  it("keeps numeric tracks and drops the rest", () => {
    const graph = graphWith({
      n1: {
        "location.x": [key(0, 0), key(10, 5)],
        label: [key(0, "hello")],
      },
    });
    const channels = buildChannels(graph, ["n1"]);
    expect(channels.map((c) => c.paramKey)).toEqual(["location.x"]);
    expect(channels[0].min).toBe(0);
    expect(channels[0].max).toBe(5);
  });

  it("sorts keys by frame regardless of how they were stored", () => {
    const graph = graphWith({ n1: { opacity: [key(20, 1), key(0, 0), key(10, 0.5)] } });
    const [channel] = buildChannels(graph, ["n1"]);
    expect(channel.keys.map((k) => k.frame)).toEqual([0, 10, 20]);
  });

  it("prefixes labels only when more than one node is open", () => {
    const graph = graphWith({ n1: { opacity: [key(0, 0), key(5, 1)] } });
    expect(buildChannels(graph, ["n1"])[0].label).toBe("opacity");
    expect(buildChannels(graph, ["n1", "n2"])[0].label).toContain("opacity");
    expect(buildChannels(graph, ["n1", "n2"])[0].label).toContain("·");
  });

  it("ignores a node with no keyframes at all", () => {
    expect(buildChannels(graphWith({}), ["n1"])).toEqual([]);
  });
});

describe("channelColor", () => {
  it("colours vector components like the axes they are", () => {
    expect(channelColor("location.x")).toBe(channelColor("scale.x"));
    expect(channelColor("location.x")).not.toBe(channelColor("location.y"));
  });

  it("is stable for an arbitrary param", () => {
    expect(channelColor("intensity")).toBe(channelColor("intensity"));
  });
});

describe("value axis", () => {
  it("round-trips a value through pixels", () => {
    const axis = makeValueAxis({ center: 5, halfSpan: 10 }, 200);
    for (const v of [-5, 0, 5, 12.5]) {
      expect(axis.toValue(axis.toY(v))).toBeCloseTo(v, 6);
    }
  });

  it("puts the view centre at the middle of the panel", () => {
    const height = 200;
    const axis = makeValueAxis({ center: 3, halfSpan: 4 }, height);
    expect(axis.toY(3)).toBeCloseTo(height / 2, 6);
  });

  it("survives a degenerate height without producing NaN", () => {
    const axis = makeValueAxis({ center: 0, halfSpan: 1 }, 0);
    expect(Number.isFinite(axis.toY(1))).toBe(true);
    expect(Number.isFinite(axis.unitsPerPixel)).toBe(true);
  });
});

describe("fitValueView", () => {
  it("frames a spread with margin", () => {
    const view = fitValueView([0, 10]);
    expect(view.center).toBeCloseTo(5);
    expect(view.halfSpan).toBeGreaterThan(5);
  });

  it("gives a flat track a usable window instead of zero height", () => {
    const view = fitValueView([500, 500]);
    expect(view.center).toBe(500);
    expect(view.halfSpan).toBeGreaterThan(0);
  });

  it("falls back to the default view for no data", () => {
    expect(fitValueView([]).halfSpan).toBeGreaterThan(0);
    expect(fitValueView([NaN, Infinity]).halfSpan).toBeGreaterThan(0);
  });
});

describe("zoomValueView", () => {
  it("keeps the anchored value under the cursor", () => {
    const before = { center: 0, halfSpan: 10 };
    const after = zoomValueView(before, 0.5, 7);
    const axisBefore = makeValueAxis(before, 300);
    const axisAfter = makeValueAxis(after, 300);
    expect(axisAfter.toY(7)).toBeCloseTo(axisBefore.toY(7), 6);
  });
});

describe("niceTicks", () => {
  it("lands on round numbers", () => {
    const ticks = niceTicks(0, 10, 5);
    expect(ticks.length).toBeGreaterThan(2);
    for (const t of ticks) expect(Number.isFinite(t)).toBe(true);
    expect(ticks).toContain(5);
  });

  it("does not drift off the ladder over many steps", () => {
    const ticks = niceTicks(0, 1, 10);
    for (const t of ticks) {
      expect(Math.abs(t * 100 - Math.round(t * 100))).toBeLessThan(1e-6);
    }
  });

  it("returns nothing for an empty or inverted range", () => {
    expect(niceTicks(5, 5)).toEqual([]);
    expect(niceTicks(10, 0)).toEqual([]);
    expect(niceTicks(NaN, 1)).toEqual([]);
  });
});

describe("formatTick", () => {
  it("scales precision with the step", () => {
    expect(formatTick(1.23456, 1)).toBe("1");
    expect(formatTick(1.23456, 0.01)).toBe("1.23");
  });

  it("never prints a negative zero", () => {
    expect(formatTick(-0.0001, 1)).toBe("0");
  });
});

describe("makeNormalizer", () => {
  it("maps a channel onto -1..1 and back", () => {
    const channel = { min: 100, max: 300 } as never;
    const norm = makeNormalizer(channel, true);
    expect(norm.forward(100)).toBeCloseTo(-1);
    expect(norm.forward(300)).toBeCloseTo(1);
    expect(norm.inverse(norm.forward(250))).toBeCloseTo(250);
  });

  it("is the identity when disabled or when the channel is flat", () => {
    const flat = { min: 7, max: 7 } as never;
    expect(makeNormalizer(flat, true).forward(7)).toBe(7);
    expect(makeNormalizer({ min: 0, max: 10 } as never, false).forward(4)).toBe(4);
  });
});

describe("sampleSegment", () => {
  it("starts and ends exactly on its keyframes", () => {
    const keys = [key(0, 0), key(10, 100, { easeIn: "smooth" })];
    const pts = sampleSegment(keys, 0, 16);
    expect(pts[0]).toEqual({ frame: 0, value: 0 });
    expect(pts[pts.length - 1].frame).toBeCloseTo(10);
    expect(pts[pts.length - 1].value).toBeCloseTo(100);
  });

  it("draws what the evaluator plays: the first segment arrives with the second key's easing", () => {
    // The opening key's own easing shapes nothing (see resolveSegmentEasing) — the graph must agree.
    const keys = [key(0, 0, { easeIn: "hold" }), key(10, 100, { easeIn: "linear" })];
    const mid = sampleSegment(keys, 0, 10).find((p) => p.frame === 5);
    expect(mid?.value).toBeCloseTo(50);
  });

  it("uses the arrival easing on later segments", () => {
    const keys = [key(0, 0), key(10, 100), key(20, 200, { easeIn: "linear" })];
    const mid = sampleSegment(keys, 1, 10).find((p) => p.frame === 15);
    expect(mid?.value).toBeCloseTo(150);
  });

  it("returns nothing past the end of the list", () => {
    expect(sampleSegment([key(0, 0)], 0, 8)).toEqual([]);
  });
});

describe("bezier handles", () => {
  it("round-trips a handle position back to control points", () => {
    const k1 = key(0, 0);
    const k2 = key(20, 10);
    const bezier: [number, number, number, number] = [0.25, 0.1, 0.75, 0.9];
    const handles = bezierHandlePositions(k1, k2, bezier);
    expect(bezierFromHandle(k1, k2, "out", handles.out, bezier)[0]).toBeCloseTo(0.25);
    expect(bezierFromHandle(k1, k2, "out", handles.out, bezier)[1]).toBeCloseTo(0.1);
    expect(bezierFromHandle(k1, k2, "in", handles.in, bezier)[2]).toBeCloseTo(0.75);
    expect(bezierFromHandle(k1, k2, "in", handles.in, bezier)[3]).toBeCloseTo(0.9);
  });

  it("clamps X into the segment but lets Y overshoot", () => {
    const k1 = key(0, 0);
    const k2 = key(10, 1);
    const out = bezierFromHandle(k1, k2, "out", { frame: 50, value: 2.5 }, DEFAULT_BEZIER);
    expect(out[0]).toBe(1);
    expect(out[1]).toBeCloseTo(2.5);
  });

  it("keeps the previous Y when the segment is flat", () => {
    const k1 = key(0, 4);
    const k2 = key(10, 4);
    const previous: [number, number, number, number] = [0.3, 0.7, 0.6, 0.2];
    const out = bezierFromHandle(k1, k2, "out", { frame: 5, value: 99 }, previous);
    expect(out[1]).toBe(0.7);
    expect(Number.isFinite(out[0])).toBe(true);
  });

  it("keeps the previous X when the segment has no duration", () => {
    const k1 = key(5, 0);
    const k2 = key(5, 10);
    const previous: [number, number, number, number] = [0.3, 0.7, 0.6, 0.2];
    expect(bezierFromHandle(k1, k2, "out", { frame: 5, value: 5 }, previous)[0]).toBe(0.3);
  });
});

describe("bezierApproximating", () => {
  it("reproduces the easing it was seeded from", () => {
    for (const easing of ["smooth", "linear"] as const) {
      const b = bezierApproximating(easing, undefined);
      for (const p of [0.25, 0.5, 0.75]) {
        const target = computeSegmentEasing(p, easing);
        const got = computeSegmentEasing(p, "bezier", undefined, b);
        expect(Math.abs(got - target)).toBeLessThan(0.03);
      }
    }
  });

  it("carries overshoot across, so a back easing stays a back easing", () => {
    const b = bezierApproximating("back", undefined);
    // The fitted control values must leave the 0..1 box for the overshoot to
    // survive the conversion at all.
    expect(Math.max(b[1], b[3])).toBeGreaterThan(1);
  });
});
