import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { EvalContext } from "../types";
import { NOISE_PEAKS_NODE, SCATTER_AROUND_NODE, findNoisePeaks, NoisePeakOptions } from "./noisePeaks";

const ctx = (nodeId: string): EvalContext => ({ time: 0, step: 0, nodeId });

const base: NoisePeakOptions = {
  domain: "line",
  plane: "xz",
  min: 0,
  max: 48,
  depthMin: -5,
  depthMax: 5,
  frequency: 0.15,
  octaves: 2,
  threshold: 0.5,
  minDistance: 4,
  invert: false,
  periodic: true,
  seed: 3,
  resolution: 400,
};

describe("findNoisePeaks", () => {
  test("peaks sit inside the domain, above the threshold, no two closer than Min Distance", () => {
    const peaks = findNoisePeaks(base);
    expect(peaks.length).toBeGreaterThan(1);
    for (const p of peaks) {
      expect(p.a).toBeGreaterThanOrEqual(0);
      expect(p.a).toBeLessThan(48);
      expect(p.strength).toBeGreaterThanOrEqual(0);
    }
    for (let i = 0; i < peaks.length; i++) {
      for (let j = i + 1; j < peaks.length; j++) {
        const d = Math.abs(peaks[i].a - peaks[j].a);
        expect(Math.min(d, 48 - d)).toBeGreaterThanOrEqual(4);
      }
    }
  });

  test("periodic: the field is the same at both ends, so shifting the window by its width finds the same peaks", () => {
    const a = findNoisePeaks(base).map((p) => p.a);
    const b = findNoisePeaks({ ...base, min: 48, max: 96 }).map((p) => p.a - 48);
    expect(b).toEqual(a.map((x) => expect.closeTo(x, 6)));
  });

  test("troughs are where the peaks are not", () => {
    const peaks = findNoisePeaks(base);
    const troughs = findNoisePeaks({ ...base, invert: true });
    expect(troughs.length).toBeGreaterThan(0);
    for (const t of troughs) for (const p of peaks) expect(Math.abs(t.a - p.a)).toBeGreaterThan(0.5);
  });

  test("an area has peaks spread over both axes", () => {
    const peaks = findNoisePeaks({ ...base, domain: "area", minDistance: 3 });
    expect(new Set(peaks.map((p) => Math.round(p.b))).size).toBeGreaterThan(1);
  });
});

describe("NOISE_PEAKS_NODE", () => {
  test("points at the peaks, placed from Origin, with their strengths", () => {
    const out = NOISE_PEAKS_NODE.evaluate({}, { ...NOISE_PEAKS_NODE.defaultParams, origin: new THREE.Vector3(0, 2, -1) }, ctx("np-a"));
    const points = out.points as THREE.Vector3[];
    expect(points.length).toBe(out.count);
    expect(points.every((p) => p.y === 2 && p.z === -1)).toBe(true);
    expect((out.strengths as number[]).length).toBe(points.length);
  });

  test("an empty domain gives nothing, no throw", () => {
    expect(NOISE_PEAKS_NODE.evaluate({}, { ...NOISE_PEAKS_NODE.defaultParams, min: 5, max: 5 }, ctx("np-b")).count).toBe(0);
  });
});

describe("SCATTER_AROUND_NODE", () => {
  const centres = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(20, 0, 0)];

  test("Count points around each centre, within Spread", () => {
    const out = SCATTER_AROUND_NODE.evaluate({ points: centres }, SCATTER_AROUND_NODE.defaultParams, ctx("sa-a"));
    const points = out.points as THREE.Vector3[];
    expect(points).toHaveLength(16);
    points.forEach((p, i) => {
      const c = centres[(out.clusters as number[])[i]];
      expect(Math.abs(p.x - c.x)).toBeLessThanOrEqual(4);
      expect(Math.abs(p.z - c.z)).toBeLessThanOrEqual(4);
    });
  });

  test("layered: one point per row along the axis, Layer saying which row", () => {
    const out = SCATTER_AROUND_NODE.evaluate(
      { points: [centres[0]] },
      { ...SCATTER_AROUND_NODE.defaultParams, count: 4, layeredAlong: "z" },
      ctx("sa-b"),
    );
    const layers = out.layers as number[];
    const points = out.points as THREE.Vector3[];
    layers.forEach((l, k) => {
      expect(l).toBeGreaterThanOrEqual(k / 4);
      expect(l).toBeLessThan((k + 1) / 4);
      expect(points[k].z).toBeCloseTo(l * 8 - 4);
    });
  });

  test("a Counts list sets each cluster's size", () => {
    const out = SCATTER_AROUND_NODE.evaluate({ points: centres, counts: [2, 5] }, SCATTER_AROUND_NODE.defaultParams, ctx("sa-c"));
    expect(out.clusters).toEqual([0, 0, 1, 1, 1, 1, 1]);
  });

  test("deterministic, and nothing wired gives nothing", () => {
    const a = SCATTER_AROUND_NODE.evaluate({ points: centres }, SCATTER_AROUND_NODE.defaultParams, ctx("sa-d"));
    const b = SCATTER_AROUND_NODE.evaluate({ points: centres }, SCATTER_AROUND_NODE.defaultParams, ctx("sa-e"));
    expect((a.points as THREE.Vector3[]).map((p) => p.toArray())).toEqual((b.points as THREE.Vector3[]).map((p) => p.toArray()));
    expect(SCATTER_AROUND_NODE.evaluate({}, SCATTER_AROUND_NODE.defaultParams, ctx("sa-f")).count).toBe(0);
  });
});
