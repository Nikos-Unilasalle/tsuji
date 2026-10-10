import { MapMesh } from "./mesh";

export interface MoistureParams {
  /** Direction the wind blows towards, in degrees (0 = +X, 90 = +Y of the map). */
  windAngle: number;
  /** How much moisture the sea gives the air per cell it crosses. */
  evaporation: number;
  /** How much of the air's water falls when it is forced uphill. */
  rainShadow: number;
}

/**
 * Rainfall per point in [0, 1]. Air sweeps across the map along the wind,
 * picks up water over the sea, and drops it as it climbs — so windward slopes
 * are wet and the land behind a mountain range is dry.
 */
export function generateMoisture(mesh: MapMesh, elevation: Float32Array, p: MoistureParams): Float32Array {
  const n = mesh.numPoints;
  const a = (p.windAngle * Math.PI) / 180;
  const wx = Math.cos(a);
  const wy = Math.sin(a);
  const proj = new Float32Array(n);
  for (let i = 0; i < n; i++) proj[i] = mesh.points[i * 2] * wx + mesh.points[i * 2 + 1] * wy;

  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => proj[i] - proj[j] || i - j);
  const air = new Float32Array(n);
  const rain = new Float32Array(n);

  for (const i of order) {
    let inAir = 0;
    let inElev = 0;
    let up = 0;
    for (let k = mesh.adjStart[i]; k < mesh.adjStart[i + 1]; k++) {
      const j = mesh.adjList[k];
      if (proj[j] >= proj[i]) continue;
      inAir += air[j];
      inElev += elevation[j];
      up++;
    }
    // Nothing upwind: the edge of the map feeds in moderately damp air.
    const incoming = up > 0 ? inAir / up : 0.5;
    const upElev = up > 0 ? inElev / up : elevation[i];

    if (elevation[i] <= 0) {
      air[i] = Math.min(1, incoming + p.evaporation);
      rain[i] = 0;
    } else {
      const lift = Math.max(0, elevation[i] - upElev);
      const fall = Math.min(1, 0.08 + p.rainShadow * lift * 12);
      rain[i] = incoming * fall;
      air[i] = incoming - rain[i];
    }
  }

  // One smoothing pass, then normalise by a high percentile so a few wet peaks don't crush the rest.
  const smooth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = rain[i];
    let c = 1;
    for (let k = mesh.adjStart[i]; k < mesh.adjStart[i + 1]; k++) {
      sum += rain[mesh.adjList[k]];
      c++;
    }
    smooth[i] = sum / c;
  }
  // Blend absolute rainfall with its rank among land points: rank keeps every
  // biome band populated whatever the wind did, absolute keeps the wind visible.
  const landIdx: number[] = [];
  for (let i = 0; i < n; i++) if (elevation[i] > 0) landIdx.push(i);
  landIdx.sort((x, y) => smooth[x] - smooth[y] || x - y);
  const ref = landIdx.length > 0 ? smooth[landIdx[Math.floor(landIdx.length * 0.95)]] || 1 : 1;
  const out = new Float32Array(n);
  landIdx.forEach((i, rank) => {
    const r = landIdx.length > 1 ? rank / (landIdx.length - 1) : 0.5;
    out[i] = 0.6 * r + 0.4 * Math.min(1, smooth[i] / Math.max(ref, 1e-6));
  });
  for (let i = 0; i < n; i++) if (elevation[i] <= 0) out[i] = 1;
  return out;
}
