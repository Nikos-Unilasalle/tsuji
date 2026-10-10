import { MapMesh } from "./mesh";
import { fbm2D } from "./noise2d";

export interface ElevationParams {
  seed: number;
  /** Noise frequency across the whole map. */
  scale: number;
  octaves: number;
  /** 0 = noise only, 1 = ridged mountain chains dominate. */
  ridges: number;
  /** Height multiplier for land. */
  mountains: number;
  /** 0 = continent filling the square, 1 = island surrounded by ocean. */
  island: number;
  /** Raising it floods more land. Elevation 0 is the shoreline. */
  seaLevel: number;
  /** Painted bias in [0, 1] at a map position (0.5 = no change). */
  paint?: (x: number, y: number) => number;
  /** How strongly paint pushes the terrain, in elevation units. */
  paintStrength: number;
  /** Land is raised to this power: above 1 flattens lowlands and leaves only a few high peaks, as in mapgen4. */
  lowlands: number;
  /** How deep the open sea gets, 0..1; it deepens smoothly with distance from the coast. */
  oceanDepth: number;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Elevation per point in [-1, 1]; the shoreline is exactly 0, so a flat water
 * plane at Y = 0 sits on it whatever the other settings are.
 */
export function generateElevation(mesh: MapMesh, p: ElevationParams): Float32Array {
  const out = new Float32Array(mesh.numPoints);
  const seed = Math.round(p.seed);
  for (let i = 0; i < mesh.numPoints; i++) {
    const x = mesh.points[i * 2];
    const y = mesh.points[i * 2 + 1];
    const h = fbm2D(x * p.scale, y * p.scale, seed, p.octaves) * 0.5 + 0.5;
    const ridge = 1 - Math.abs(fbm2D(x * p.scale * 0.6 + 7.3, y * p.scale * 0.6 - 3.1, seed + 77, 3));
    const raw = h * (1 - p.ridges) + h * ridge * ridge * p.ridges * 1.6;
    let e = (raw - p.seaLevel) * p.mountains;

    const d = Math.min(1, Math.hypot(2 * x - 1, 2 * y - 1) / Math.SQRT2 * 1.15);
    e -= p.island * smoothstep(0.3, 1, d) * 1.4;

    if (p.paint) e += (p.paint(x, y) - 0.5) * 2 * p.paintStrength;
    e = Math.max(-1, Math.min(1, e));
    out[i] = e > 0 ? Math.pow(e, Math.max(0.2, p.lowlands)) : e;
  }
  shapeOcean(mesh, out, p.oceanDepth);
  return out;
}

/**
 * The sea floor is rebuilt from distance to the coast rather than left as
 * whatever the noise gave: a shallow shelf that falls away smoothly, which is
 * what makes mapgen4's ocean read as a clean gradient instead of blotches.
 * Land is untouched, and so is the shoreline at exactly 0.
 */
function shapeOcean(mesh: MapMesh, elevation: Float32Array, depth: number): void {
  const n = mesh.numPoints;
  const dist = new Float32Array(n).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (elevation[i] > 0) {
      dist[i] = 0;
      queue.push(i);
    }
  }
  // No land at all: leave the noise alone rather than inventing a bottomless ocean.
  if (queue.length === 0) return;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    for (let k = mesh.adjStart[i]; k < mesh.adjStart[i + 1]; k++) {
      const j = mesh.adjList[k];
      if (dist[j] >= 0) continue;
      dist[j] = dist[i] + 1;
      queue.push(j);
    }
  }
  // Hops to map distance: one hop is about one point spacing.
  const reach = 0.12;
  for (let i = 0; i < n; i++) {
    if (elevation[i] > 0) continue;
    const d = dist[i] * mesh.spacing;
    elevation[i] = -Math.max(0.02, depth * (1 - Math.exp(-d / reach)));
  }
}
