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
    out[i] = Math.max(-1, Math.min(1, e));
  }
  return out;
}
