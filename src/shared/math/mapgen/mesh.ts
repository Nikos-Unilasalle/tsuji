import Delaunator from "delaunator";
import { createPRNG } from "../random";

/**
 * The point graph every later stage works on: a Poisson-disk point set in the
 * unit square, its Delaunay triangulation, and a CSR neighbour table. Points
 * are the "cells" of the map — elevation, moisture, flow and biome are all one
 * value per point, interpolated over triangles only when rasterised.
 */
export interface MapMesh {
  seed: number;
  spacing: number;
  numPoints: number;
  /** x,y pairs in [0, 1]. */
  points: Float32Array;
  /** Triangle corner indices, three per triangle. */
  triangles: Uint32Array;
  /** CSR neighbour table: neighbours of i are adjList[adjStart[i] .. adjStart[i + 1]). */
  adjStart: Uint32Array;
  adjList: Uint32Array;
  /** 1 for the points on the outer edge of the square. */
  isBoundary: Uint8Array;
}

export const MIN_SPACING = 0.004;
export const MAX_SPACING = 0.1;

/** Bridson's Poisson-disk sampling on [lo, hi]². */
function poissonDisk(rng: () => number, lo: number, hi: number, r: number): [number, number][] {
  const cell = r / Math.SQRT2;
  const span = hi - lo;
  const gw = Math.max(1, Math.ceil(span / cell));
  const grid = new Int32Array(gw * gw).fill(-1);
  const pts: [number, number][] = [];
  const active: number[] = [];
  const gi = (v: number): number => Math.min(gw - 1, Math.max(0, Math.floor((v - lo) / cell)));

  const accept = (x: number, y: number): boolean => {
    const cx = gi(x);
    const cy = gi(y);
    for (let j = Math.max(0, cy - 2); j <= Math.min(gw - 1, cy + 2); j++) {
      for (let i = Math.max(0, cx - 2); i <= Math.min(gw - 1, cx + 2); i++) {
        const k = grid[j * gw + i];
        if (k < 0) continue;
        const dx = pts[k][0] - x;
        const dy = pts[k][1] - y;
        if (dx * dx + dy * dy < r * r) return false;
      }
    }
    return true;
  };
  const add = (x: number, y: number): void => {
    grid[gi(y) * gw + gi(x)] = pts.length;
    active.push(pts.length);
    pts.push([x, y]);
  };

  add(lo + rng() * span, lo + rng() * span);
  while (active.length > 0) {
    const ai = Math.floor(rng() * active.length);
    const [px, py] = pts[active[ai]];
    let found = false;
    for (let t = 0; t < 24; t++) {
      const a = rng() * Math.PI * 2;
      const d = r * (1 + rng());
      const x = px + Math.cos(a) * d;
      const y = py + Math.sin(a) * d;
      if (x < lo || x > hi || y < lo || y > hi || !accept(x, y)) continue;
      add(x, y);
      found = true;
      break;
    }
    if (!found) {
      active[ai] = active[active.length - 1];
      active.pop();
    }
  }
  return pts;
}

export function generateMesh(seed: number, spacing: number): MapMesh {
  const r = Math.min(MAX_SPACING, Math.max(MIN_SPACING, spacing));
  const rng = createPRNG(Math.round(seed));

  // Evenly spaced ring on the square's edge so the triangulation fills it exactly.
  const edgeN = Math.max(2, Math.round(1 / r));
  const pts: [number, number][] = [];
  for (let i = 0; i < edgeN; i++) {
    const t = i / edgeN;
    pts.push([t, 0], [1, t], [1 - t, 1], [0, 1 - t]);
  }
  const numBoundary = pts.length;
  pts.push(...poissonDisk(rng, r * 0.8, 1 - r * 0.8, r));

  const n = pts.length;
  const points = new Float32Array(n * 2);
  pts.forEach(([x, y], i) => {
    points[i * 2] = x;
    points[i * 2 + 1] = y;
  });
  const isBoundary = new Uint8Array(n);
  isBoundary.fill(1, 0, numBoundary);

  const del = new Delaunator(points);
  const triangles = Uint32Array.from(del.triangles);
  const halfedges = del.halfedges;

  // Each undirected edge once: the lower-index halfedge, or an unpaired hull edge.
  const degree = new Uint32Array(n);
  for (let e = 0; e < triangles.length; e++) {
    if (halfedges[e] !== -1 && halfedges[e] < e) continue;
    degree[triangles[e]]++;
    degree[triangles[e % 3 === 2 ? e - 2 : e + 1]]++;
  }
  const adjStart = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) adjStart[i + 1] = adjStart[i] + degree[i];
  const adjList = new Uint32Array(adjStart[n]);
  const fill = adjStart.slice(0, n);
  for (let e = 0; e < triangles.length; e++) {
    if (halfedges[e] !== -1 && halfedges[e] < e) continue;
    const a = triangles[e];
    const b = triangles[e % 3 === 2 ? e - 2 : e + 1];
    adjList[fill[a]++] = b;
    adjList[fill[b]++] = a;
  }

  return { seed, spacing: r, numPoints: n, points, triangles, adjStart, adjList, isBoundary };
}
