import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { createPRNG, randomGaussian } from "../../math/random";
import { valueNoise3 } from "../../math/valueNoise";
import { vectorsSignature } from "../curveLists";
import { asVector3 } from "./transform";

function num(input: unknown, param: unknown, fallback: number): number {
  const n = Number(input !== undefined ? input : param);
  return Number.isFinite(n) ? n : fallback;
}

interface Cached<T> {
  signature: string;
  value: T;
}

/* -------------------------------------------------------------------------- */
/* Noise Peaks                                                                */
/* -------------------------------------------------------------------------- */

export interface NoisePeakOptions {
  domain: "line" | "area";
  plane: "xy" | "xz";
  min: number;
  max: number;
  depthMin: number;
  depthMax: number;
  frequency: number;
  octaves: number;
  threshold: number;
  minDistance: number;
  invert: boolean;
  periodic: boolean;
  seed: number;
  resolution: number;
}

/**
 * The noise field, normalised to roughly 0-1. Periodic along the first axis:
 * the noise is read around a circle whose circumference is the domain's
 * width, so the field — and every peak in it — repeats exactly at the
 * domain's ends, which is what a looping scroll needs.
 */
function fieldAt(o: NoisePeakOptions, a: number, b: number): number {
  const width = Math.max(1e-6, o.max - o.min);
  let x: number;
  let y: number;
  if (o.periodic) {
    const r = (width * o.frequency) / (2 * Math.PI);
    const angle = ((a - o.min) / width) * Math.PI * 2;
    x = r * Math.cos(angle);
    y = r * Math.sin(angle);
  } else {
    x = a * o.frequency;
    y = 0;
  }
  const z = b * o.frequency + o.seed * 7.31;
  const octaves = Math.max(1, Math.min(6, Math.round(o.octaves)));
  const v = valueNoise3(x, y, z, octaves, 0.5) / (1 - Math.pow(0.5, octaves));
  return o.invert ? 1 - v : v;
}

export interface Peak {
  a: number;
  b: number;
  strength: number;
}

/**
 * Local maxima of the field above the threshold, strongest first, thinned so
 * no two are closer than Min Distance (wrapping around in periodic mode).
 */
export function findNoisePeaks(o: NoisePeakOptions): Peak[] {
  const width = o.max - o.min;
  const steps = Math.max(8, Math.min(4000, Math.round(o.resolution)));
  const step = width / steps;
  const rows = o.domain === "area" ? Math.max(1, Math.round((o.depthMax - o.depthMin) / step)) : 0;
  const grid: number[][] = [];
  for (let j = 0; j <= rows; j++) {
    const b = o.domain === "area" ? o.depthMin + (j * (o.depthMax - o.depthMin)) / Math.max(1, rows) : 0;
    const row: number[] = [];
    for (let i = 0; i < steps; i++) row.push(fieldAt(o, o.min + i * step, b));
    grid.push(row);
  }
  const at = (i: number, j: number) => {
    if (j < 0 || j > rows) return -Infinity;
    if (o.periodic) return grid[j][((i % steps) + steps) % steps];
    return i < 0 || i >= steps ? -Infinity : grid[j][i];
  };
  const candidates: Peak[] = [];
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i < steps; i++) {
      const v = grid[j][i];
      if (v < o.threshold) continue;
      let isMax = true;
      for (let dj = -1; dj <= 1 && isMax; dj++) {
        for (let di = -1; di <= 1; di++) {
          if ((di || dj) && at(i + di, j + dj) > v) {
            isMax = false;
            break;
          }
        }
      }
      if (!isMax) continue;
      const b = o.domain === "area" ? o.depthMin + (j * (o.depthMax - o.depthMin)) / Math.max(1, rows) : 0;
      candidates.push({ a: o.min + i * step, b, strength: (v - o.threshold) / Math.max(1e-6, 1 - o.threshold) });
    }
  }
  candidates.sort((p, q) => q.strength - p.strength || p.a - q.a);
  const kept: Peak[] = [];
  const d2 = o.minDistance * o.minDistance;
  for (const c of candidates) {
    const near = kept.some((k) => {
      let da = Math.abs(k.a - c.a);
      if (o.periodic) da = Math.min(da, width - da);
      return da * da + (k.b - c.b) ** 2 < d2;
    });
    if (!near) kept.push(c);
  }
  return kept.sort((p, q) => p.a - q.a || p.b - q.b);
}

const peaksCache = createNodeCache<Cached<{ points: THREE.Vector3[]; strengths: number[] }>>();

/**
 * Noise Peaks — points where a smooth noise field peaks, along a line (X) or
 * across an area (X and Y, or X and Z). Peaks come and go with the noise, so
 * points gather in some stretches and leave others empty, the way mountain
 * ranges, villages or groves do — the centres Shan Shui plans its massifs
 * around. Invert finds the troughs instead: the gaps between them.
 *
 * Periodic makes the field repeat across the width (Min to Max), so a strip
 * laid end to end, or a scroll that loops, shows no seam.
 */
export const NOISE_PEAKS_NODE: NodeDefinition = {
  type: "list/noise-peaks",
  label: "Noise Peaks",
  category: "list",
  inputs: [
    { id: "threshold", label: "Threshold", type: "value" },
    { id: "seed", label: "Seed", type: "value" },
  ],
  outputs: [
    { id: "points", label: "Points", type: "list" },
    { id: "strengths", label: "Strength (List, 0-1)", type: "list" },
    { id: "count", label: "Count", type: "value" },
  ],
  defaultParams: {
    domain: "line",
    plane: "xz",
    min: 0,
    max: 48,
    depthMin: -5,
    depthMax: 5,
    origin: new THREE.Vector3(0, 0, 0),
    frequency: 0.15,
    octaves: 2,
    threshold: 0.55,
    minDistance: 4,
    invert: false,
    periodic: true,
    resolution: 400,
    seed: 0,
  },
  paramFields: [
    {
      id: "domain",
      label: "Domain",
      kind: "select",
      options: ["line", "area"],
      optionLabels: ["Line (along X)", "Area"],
    },
    { id: "plane", label: "Area Plane", kind: "select", options: ["xz", "xy"], optionLabels: ["XZ (ground)", "XY (front)"] },
    { id: "min", label: "X Min", kind: "number", step: 1 },
    { id: "max", label: "X Max", kind: "number", step: 1 },
    { id: "depthMin", label: "Second Axis Min (area)", kind: "number", step: 1 },
    { id: "depthMax", label: "Second Axis Max (area)", kind: "number", step: 1 },
    { id: "origin", label: "Origin", kind: "vector" },
    { id: "frequency", label: "Frequency (per unit)", kind: "number", step: 0.01, group: "Noise" },
    { id: "octaves", label: "Octaves", kind: "number", step: 1, group: "Noise" },
    { id: "threshold", label: "Threshold", kind: "number", step: 0.01, group: "Noise" },
    { id: "invert", label: "Troughs Instead", kind: "boolean", group: "Noise" },
    { id: "periodic", label: "Periodic Across Width", kind: "boolean", group: "Noise" },
    { id: "seed", label: "Seed", kind: "number", step: 1, group: "Noise" },
    { id: "minDistance", label: "Min Distance", kind: "number", step: 0.5, group: "Spacing" },
    { id: "resolution", label: "Samples Across Width", kind: "number", step: 50, group: "Spacing" },
  ],
  evaluate: (inputs, params, ctx) => {
    const o: NoisePeakOptions = {
      domain: params.domain === "area" ? "area" : "line",
      plane: params.plane === "xy" ? "xy" : "xz",
      min: num(undefined, params.min, 0),
      max: num(undefined, params.max, 48),
      depthMin: num(undefined, params.depthMin, -5),
      depthMax: num(undefined, params.depthMax, 5),
      frequency: Math.max(1e-4, num(undefined, params.frequency, 0.15)),
      octaves: num(undefined, params.octaves, 2),
      threshold: num(inputs.threshold, params.threshold, 0.55),
      minDistance: Math.max(0, num(undefined, params.minDistance, 4)),
      invert: Boolean(params.invert),
      periodic: params.periodic !== false,
      seed: Math.round(num(inputs.seed, params.seed, 0)),
      resolution: num(undefined, params.resolution, 400),
    };
    if (o.max < o.min) [o.min, o.max] = [o.max, o.min];
    const origin = asVector3(params.origin, new THREE.Vector3());
    const signature = JSON.stringify([o, origin.toArray()]);
    const hit = peaksCache.get(ctx.nodeId);
    if (hit && hit.signature === signature) return { ...hit.value, count: hit.value.points.length };

    const peaks = o.max - o.min > 1e-6 ? findNoisePeaks(o) : [];
    const points = peaks.map((p) =>
      o.domain === "area" && o.plane === "xy"
        ? new THREE.Vector3(p.a, p.b, 0).add(origin)
        : new THREE.Vector3(p.a, 0, p.b).add(origin),
    );
    const value = { points, strengths: peaks.map((p) => p.strength) };
    peaksCache.set(ctx.nodeId, { signature, value });
    return { ...value, count: points.length };
  },
};

/* -------------------------------------------------------------------------- */
/* Scatter Around                                                             */
/* -------------------------------------------------------------------------- */

interface ScatterAroundOutput {
  points: THREE.Vector3[];
  layers: number[];
  clusters: number[];
}

const AXES = ["none", "x", "y", "z"] as const;
const scatterAroundCache = createNodeCache<Cached<ScatterAroundOutput>>();

/**
 * Scatter Around — a cluster of points around each input point: Count per
 * point (or one count each, from the Counts list) spread within Spread on
 * every axis. With Layered Along set, a cluster's points are spaced evenly
 * along that axis instead of at random — one per layer, the way Shan Shui
 * stacks a massif's mountains row behind row — and Layer (0-1) says which
 * row each one is on, to set its height, depth or size downstream.
 */
export const SCATTER_AROUND_NODE: NodeDefinition = {
  type: "list/scatter-around",
  label: "Scatter Around",
  category: "list",
  inputs: [
    { id: "points", label: "Centres (Points)", type: "list" },
    { id: "counts", label: "Counts (List)", type: "list" },
    { id: "seed", label: "Seed", type: "value" },
  ],
  outputs: [
    { id: "points", label: "Points", type: "list" },
    { id: "layers", label: "Layer (List, 0-1)", type: "list" },
    { id: "clusters", label: "Cluster Index (List)", type: "list" },
    { id: "count", label: "Count", type: "value" },
  ],
  defaultParams: {
    count: 8,
    spread: new THREE.Vector3(4, 0, 4),
    distribution: "uniform",
    layeredAlong: "none",
    seed: 0,
  },
  paramFields: [
    { id: "count", label: "Count per Centre", kind: "number", step: 1 },
    { id: "spread", label: "Spread (half extent per axis)", kind: "vector" },
    {
      id: "distribution",
      label: "Distribution",
      kind: "select",
      options: ["uniform", "gaussian"],
      optionLabels: ["Uniform", "Gaussian (denser at the centre)"],
    },
    {
      id: "layeredAlong",
      label: "Layered Along",
      kind: "select",
      options: [...AXES],
      optionLabels: ["None (random)", "X", "Y", "Z"],
    },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const centres = Array.isArray(inputs.points)
      ? inputs.points.filter((p): p is THREE.Vector3 => p instanceof THREE.Vector3)
      : [];
    const counts = Array.isArray(inputs.counts) ? inputs.counts : [];
    const count = Math.max(0, Math.min(1000, Math.round(num(undefined, params.count, 8))));
    const spread = asVector3(params.spread, new THREE.Vector3(4, 0, 4));
    const gaussian = params.distribution === "gaussian";
    const layered = (AXES as readonly string[]).includes(String(params.layeredAlong)) ? String(params.layeredAlong) : "none";
    const seed = Math.round(num(inputs.seed, params.seed, 0));
    const signature = JSON.stringify([vectorsSignature(centres), vectorsSignature(counts), count, spread.toArray(), gaussian, layered, seed]);
    const hit = scatterAroundCache.get(ctx.nodeId);
    if (hit && hit.signature === signature) return { ...hit.value, count: hit.value.points.length };

    const points: THREE.Vector3[] = [];
    const layers: number[] = [];
    const clusters: number[] = [];
    const axisIndex = layered === "x" ? 0 : layered === "y" ? 1 : layered === "z" ? 2 : -1;
    centres.forEach((centre, c) => {
      const n = counts.length > 0 ? Math.max(0, Math.min(1000, Math.round(Number(counts[Math.min(c, counts.length - 1)]) || 0))) : count;
      const rng = createPRNG(seed * 7919 + c * 104729 + 17);
      const offset = () => (gaussian ? Math.max(-1, Math.min(1, randomGaussian(rng, 0, 0.4))) : rng() * 2 - 1);
      for (let k = 0; k < n; k++) {
        const o = [offset(), offset(), offset()];
        // Layered: evenly spaced rows across the spread, each jittered within its own row.
        const layer = n > 1 ? (k + 0.5 * rng()) / n : 0.5;
        if (axisIndex >= 0) o[axisIndex] = layer * 2 - 1;
        points.push(new THREE.Vector3(centre.x + o[0] * spread.x, centre.y + o[1] * spread.y, centre.z + o[2] * spread.z));
        layers.push(axisIndex >= 0 ? layer : rng());
        clusters.push(c);
      }
    });
    const value = { points, layers, clusters };
    scatterAroundCache.set(ctx.nodeId, { signature, value });
    return { ...value, count: points.length };
  },
};
