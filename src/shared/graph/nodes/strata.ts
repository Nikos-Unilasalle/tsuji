import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { createPRNG } from "../../math/random";
import { valueNoise3 } from "../../math/valueNoise";
import { Curve3, curvePlane, curveStacks, curvesSignature, fromPlane, polylineCurve, toPlane } from "../curveLists";
import { asVector3 } from "./transform";

function num(input: unknown, param: unknown, fallback: number): number {
  const n = Number(input !== undefined ? input : param);
  return Number.isFinite(n) ? n : fallback;
}

function int(input: unknown, param: unknown, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(num(input, param, fallback))));
}

interface Cached<T> {
  signature: string;
  value: T;
}

/* -------------------------------------------------------------------------- */
/* Strata Hatch                                                               */
/* -------------------------------------------------------------------------- */

const DISTRIBUTIONS = ["edges", "inner", "center", "uniform"] as const;

function distribution(kind: string, rng: () => number): number {
  if (kind === "uniform") return rng();
  if (kind === "center") return 1 / 3 + rng() / 3;
  if (kind === "inner") return rng() > 0.5 ? 0.1 + 0.4 * rng() : 0.9 - 0.4 * rng();
  return rng() > 0.5 ? rng() / 3 : 2 / 3 + rng() / 3;
}

const hatchCache = createNodeCache<Cached<Curve3[]>>();

/**
 * Short strokes threaded between the layers of each stack, following their
 * shape — the texture strokes that model a Shan Shui mountain's folds. A
 * stroke's position across the stack is interpolated between two adjacent
 * layers, and its jitter fades from sketchy at the outer layer to calm at the
 * inner ones.
 */
export const STRATA_HATCH_NODE: NodeDefinition = {
  type: "curve/strata-hatch",
  label: "Strata Hatch",
  category: "curve",
  inputs: [
    { id: "stacks", label: "Stacks (List of Lists)", type: "list" },
    { id: "count", label: "Strokes per Stack", type: "value" },
    { id: "seed", label: "Seed", type: "value" },
  ],
  outputs: [
    { id: "curves", label: "Strokes (List)", type: "list" },
    { id: "count", label: "Count", type: "value" },
  ],
  defaultParams: { count: 200, length: 0.2, jitter: 0.3, distribution: "edges", resolution: 50, seed: 0 },
  paramFields: [
    { id: "count", label: "Strokes per Stack", kind: "number", step: 10 },
    { id: "length", label: "Max Length (of a layer)", kind: "number", step: 0.05, percent: true },
    { id: "jitter", label: "Jitter", kind: "number", step: 0.05 },
    {
      id: "distribution",
      label: "Placement",
      kind: "select",
      options: [...DISTRIBUTIONS],
      optionLabels: ["Flanks", "Inner Slopes", "Centre", "Anywhere"],
    },
    { id: "resolution", label: "Samples per Layer", kind: "number", step: 5 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const stacks = curveStacks(inputs.stacks);
    const count = int(inputs.count, params.count, 200, 0, 5000);
    const length = Math.max(0, Math.min(1, num(undefined, params.length, 0.2)));
    const jitter = Math.max(0, num(undefined, params.jitter, 0.3));
    const kind = String(params.distribution ?? "edges");
    const resolution = int(undefined, params.resolution, 50, 3, 400);
    const seed = Math.round(num(inputs.seed, params.seed, 0));

    const signature = JSON.stringify([curvesSignature(stacks.flat()), stacks.map((s) => s.length), count, length, jitter, kind, resolution, seed]);
    const hit = hatchCache.get(ctx.nodeId);
    if (hit && hit.signature === signature) return { curves: hit.value, count: hit.value.length };

    const curves: Curve3[] = [];
    stacks.forEach((stack, m) => {
      const rng = createPRNG(seed * 7919 + m * 104729 + 7);
      const noiseSeed = seed * 5.3 + m * 2.71;
      const sampled = stack.map((c) => c.getPoints(resolution - 1));
      const plane = curvePlane(sampled[0]);
      const top = sampled.length - 1;
      for (let i = 0; i < count; i++) {
        const mid = Math.floor(distribution(kind, rng) * resolution);
        const half = Math.floor(rng() * resolution * length);
        const start = Math.max(0, Math.min(resolution, mid - half));
        const end = Math.max(0, Math.min(resolution, mid + half));
        const layer = top > 0 ? (i / count) * top : 0;
        const lo = Math.floor(layer);
        const hi = Math.min(top, Math.ceil(layer));
        const f = layer - lo;
        const amplitude = jitter / (layer + 1);
        const points: THREE.Vector3[] = [];
        for (let j = start; j < end; j++) {
          const [u, v, w] = toPlane(plane, sampled[lo][j].clone().lerp(sampled[hi][j], f));
          points.push(
            fromPlane(
              plane,
              u + amplitude * (valueNoise3(u * 100, j * 0.5, noiseSeed) - 0.47),
              v + amplitude * (valueNoise3(v * 100, j * 0.5, noiseSeed + 1) - 0.47),
              w,
            ),
          );
        }
        if (points.length >= 2) curves.push(polylineCurve(points));
      }
    });
    hatchCache.set(ctx.nodeId, { signature, value: curves });
    return { curves, count: curves.length };
  },
};

/* -------------------------------------------------------------------------- */
/* Scatter on Curves                                                          */
/* -------------------------------------------------------------------------- */

interface ScatterOutput {
  points: THREE.Vector3[];
  scales: number[];
}

const scatterCache = createNodeCache<Cached<ScatterOutput>>();

/**
 * Picks spots along curves for something to grow on: every curve is sampled
 * at a fixed number of points, and a sample survives only where a noise mask
 * lets it, inside a band of relative height, and on the chosen layers — the
 * rules Shan Shui uses to put trees on ridges, on summits, and in clumps
 * down the slopes.
 */
export const SCATTER_ON_CURVES_NODE: NodeDefinition = {
  type: "curve/scatter",
  label: "Scatter on Curves",
  category: "curve",
  inputs: [
    { id: "curves", label: "Curves / Stacks (List)", type: "list" },
    { id: "seed", label: "Seed", type: "value" },
  ],
  outputs: [
    { id: "points", label: "Points", type: "list" },
    { id: "scales", label: "Scales (List)", type: "list" },
    { id: "count", label: "Count", type: "value" },
  ],
  defaultParams: {
    resolution: 50,
    layerMin: 0,
    layerMax: 99,
    endsOnly: false,
    everyOther: false,
    maskScaleAlong: 0.1,
    maskScaleAcross: 0.1,
    maskPower: 3,
    threshold: 0.1,
    heightMin: 0,
    heightMax: 1,
    minNeighbors: 0,
    neighborRadius: 0.3,
    offset: new THREE.Vector3(0, 0, 0),
    scaleMin: 1,
    scaleMax: 1,
    seed: 0,
  },
  paramFields: [
    { id: "resolution", label: "Samples per Curve", kind: "number", step: 5 },
    { id: "layerMin", label: "First Layer", kind: "number", step: 1, group: "Where" },
    { id: "layerMax", label: "Last Layer", kind: "number", step: 1, group: "Where" },
    { id: "endsOnly", label: "Curve Ends Only", kind: "boolean", group: "Where" },
    { id: "everyOther", label: "Every Other Sample", kind: "boolean", group: "Where" },
    { id: "heightMin", label: "Min Height (relative)", kind: "number", step: 0.05, percent: true, group: "Where" },
    { id: "heightMax", label: "Max Height (relative)", kind: "number", step: 0.05, percent: true, group: "Where" },
    { id: "maskScaleAlong", label: "Mask Scale Along", kind: "number", step: 0.01, group: "Noise Mask" },
    { id: "maskScaleAcross", label: "Mask Scale Across Layers", kind: "number", step: 0.01, group: "Noise Mask" },
    { id: "maskPower", label: "Mask Power", kind: "number", step: 1, group: "Noise Mask" },
    { id: "threshold", label: "Threshold", kind: "number", step: 0.005, group: "Noise Mask" },
    { id: "minNeighbors", label: "Min Neighbours (clumping)", kind: "number", step: 1, group: "Clumping" },
    { id: "neighborRadius", label: "Neighbour Radius", kind: "number", step: 0.05, group: "Clumping" },
    { id: "offset", label: "Offset", kind: "vector", group: "Output" },
    { id: "scaleMin", label: "Scale Min", kind: "number", step: 0.05, group: "Output" },
    { id: "scaleMax", label: "Scale Max", kind: "number", step: 0.05, group: "Output" },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const stacks = curveStacks(inputs.curves);
    const resolution = int(undefined, params.resolution, 50, 2, 1000);
    const layerMin = int(undefined, params.layerMin, 0, 0, 1e6);
    const layerMax = int(undefined, params.layerMax, 99, 0, 1e6);
    const endsOnly = Boolean(params.endsOnly);
    const everyOther = Boolean(params.everyOther);
    const along = num(undefined, params.maskScaleAlong, 0.1);
    const across = num(undefined, params.maskScaleAcross, 0.1);
    const power = Math.max(0.01, num(undefined, params.maskPower, 3));
    const threshold = num(undefined, params.threshold, 0.1);
    const heightMin = num(undefined, params.heightMin, 0);
    const heightMax = num(undefined, params.heightMax, 1);
    const minNeighbors = int(undefined, params.minNeighbors, 0, 0, 1000);
    const radius = Math.max(0, num(undefined, params.neighborRadius, 0.3));
    const offset = asVector3(params.offset, new THREE.Vector3());
    const scaleMin = num(undefined, params.scaleMin, 1);
    const scaleMax = num(undefined, params.scaleMax, 1);
    const seed = Math.round(num(inputs.seed, params.seed, 0));

    const signature = JSON.stringify([
      curvesSignature(stacks.flat()), stacks.map((s) => s.length), resolution, layerMin, layerMax, endsOnly, everyOther,
      along, across, power, threshold, heightMin, heightMax, minNeighbors, radius, offset.toArray(), scaleMin, scaleMax, seed,
    ]);
    const hit = scatterCache.get(ctx.nodeId);
    if (hit && hit.signature === signature) return { ...hit.value, count: hit.value.points.length };

    const rng = createPRNG(seed * 7919 + 3);
    const points: THREE.Vector3[] = [];
    stacks.forEach((stack, m) => {
      const outer = stack[0].getPoints(resolution - 1);
      // Height is read in the stack's own drawing plane: up the screen of a
      // front view, away from the viewer of a ground drawing.
      const plane = curvePlane(outer);
      const up = (p: THREE.Vector3) => toPlane(plane, p)[1];
      let base = Infinity;
      let top = -Infinity;
      for (const p of outer) {
        base = Math.min(base, up(p));
        top = Math.max(top, up(p));
      }
      const span = Math.max(1e-6, top - base);
      const noiseSeed = seed * 3.9 + m * 1.7;
      const candidates: THREE.Vector3[] = [];
      for (let i = layerMin; i <= Math.min(layerMax, stack.length - 1); i++) {
        const samples = i === 0 ? outer : stack[i].getPoints(resolution - 1);
        for (let j = 0; j < samples.length; j++) {
          if (endsOnly && j !== 0 && j !== samples.length - 1) continue;
          if (everyOther && j % 2 === 0) continue;
          if (Math.pow(valueNoise3(i * across, j * along, noiseSeed), power) >= threshold) continue;
          const rel = (up(samples[j]) - base) / span;
          if (rel < heightMin || rel > heightMax) continue;
          candidates.push(samples[j]);
        }
      }
      const r2 = radius * radius;
      for (const c of candidates) {
        if (minNeighbors > 0) {
          let near = 0;
          for (const other of candidates) if (other !== c && other.distanceToSquared(c) < r2) near++;
          if (near < minNeighbors) continue;
        }
        points.push(c.clone().add(offset));
      }
    });
    const scales = points.map(() => scaleMin + (scaleMax - scaleMin) * rng());
    const value = { points, scales };
    scatterCache.set(ctx.nodeId, { signature, value });
    return { ...value, count: points.length };
  },
};
