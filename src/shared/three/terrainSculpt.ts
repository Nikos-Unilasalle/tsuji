import * as THREE from "three";
import { TerrainGridConfig, updateTerrainHeightsAndNormals } from "./terrainEngine";

export type TerrainBrushTool = "sculpt" | "smooth" | "flatten" | "noise" | "erode";
export type TerrainBrushFalloff = "smooth" | "linear" | "sphere" | "flat";

export interface SculptStrokeParams {
  tool: TerrainBrushTool;
  falloff: TerrainBrushFalloff;
  radius: number;
  strength: number;
  invert: boolean;
  hitPoint: THREE.Vector3; // In terrain local coordinates
  targetHeight?: number;   // In terrain local coordinates (for flatten)
  deltaTime?: number;
}

export function calculateFalloff(distNorm: number, type: TerrainBrushFalloff): number {
  if (distNorm >= 1.0) return 0;
  if (distNorm <= 0) return 1;
  switch (type) {
    case "linear":
      return 1.0 - distNorm;
    case "sphere":
      return Math.sqrt(Math.max(0, 1.0 - distNorm * distNorm));
    case "flat":
      return 1.0;
    case "smooth":
    default:
      return (1.0 + Math.cos(Math.PI * distNorm)) * 0.5;
  }
}

function pseudoNoise(x: number, z: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453123;
  return s - Math.floor(s);
}

/**
 * Applies a sculpting brush stroke to terrain offsets.
 * Mutates sculptOffsets in place and updates the geometry buffers.
 */
export function applySculptStroke(
  geometry: THREE.BufferGeometry,
  config: TerrainGridConfig,
  heightmapPixels: { data: Uint8ClampedArray | Uint8Array | Float32Array; width: number; height: number } | null,
  sculptOffsets: Record<number, number>,
  stroke: SculptStrokeParams,
): void {
  const { width, depth, segmentsX, segmentsZ } = config;
  const cols = segmentsX + 1;
  const rows = segmentsZ + 1;

  const dx = width / segmentsX;
  const dz = depth / segmentsZ;
  const halfW = width * 0.5;
  const halfD = depth * 0.5;

  const cx = stroke.hitPoint.x;
  const cz = stroke.hitPoint.z;
  const r = Math.max(0.1, stroke.radius);

  // Compute bounding grid range touched by the brush
  const iMin = Math.max(0, Math.floor((cx - r + halfW) / dx));
  const iMax = Math.min(cols - 1, Math.ceil((cx + r + halfW) / dx));
  const jMin = Math.max(0, Math.floor((cz - r + halfD) / dz));
  const jMax = Math.min(rows - 1, Math.ceil((cz + r + halfD) / dz));

  if (iMin > iMax || jMin > jMax) return;

  const dt = stroke.deltaTime ?? 0.016;
  const rate = Math.min(2.0, dt * 60.0);
  const baseStrength = stroke.strength * rate;
  const posAttr = geometry.attributes.position as THREE.BufferAttribute;
  const posArray = posAttr.array as Float32Array;

  if (stroke.tool === "smooth") {
    // 1st pass: compute weighted average of current heights
    let sumWeights = 0;
    let sumHeights = 0;
    for (let j = jMin; j <= jMax; j++) {
      const vz = -halfD + j * dz;
      for (let i = iMin; i <= iMax; i++) {
        const vx = -halfW + i * dx;
        const d = Math.hypot(vx - cx, vz - cz);
        if (d > r) continue;
        const w = calculateFalloff(d / r, stroke.falloff);
        const idx = j * cols + i;
        const h = posArray[idx * 3 + 1];
        sumHeights += h * w;
        sumWeights += w;
      }
    }

    if (sumWeights > 1e-5) {
      const avgH = sumHeights / sumWeights;
      const smoothFactor = baseStrength * 0.35;
      for (let j = jMin; j <= jMax; j++) {
        const vz = -halfD + j * dz;
        for (let i = iMin; i <= iMax; i++) {
          const vx = -halfW + i * dx;
          const d = Math.hypot(vx - cx, vz - cz);
          if (d > r) continue;
          const w = calculateFalloff(d / r, stroke.falloff);
          const idx = j * cols + i;
          const currentH = posArray[idx * 3 + 1];
          const diff = (avgH - currentH) * w * smoothFactor;
          sculptOffsets[idx] = (sculptOffsets[idx] || 0) + diff;
        }
      }
    }
  } else if (stroke.tool === "flatten") {
    const targetH = stroke.targetHeight !== undefined ? stroke.targetHeight : stroke.hitPoint.y;
    const flattenFactor = baseStrength * 0.4;
    for (let j = jMin; j <= jMax; j++) {
      const vz = -halfD + j * dz;
      for (let i = iMin; i <= iMax; i++) {
        const vx = -halfW + i * dx;
        const d = Math.hypot(vx - cx, vz - cz);
        if (d > r) continue;
        const w = calculateFalloff(d / r, stroke.falloff);
        const idx = j * cols + i;
        const currentH = posArray[idx * 3 + 1];
        const diff = (targetH - currentH) * w * flattenFactor;
        sculptOffsets[idx] = (sculptOffsets[idx] || 0) + diff;
      }
    }
  } else if (stroke.tool === "noise") {
    const dir = stroke.invert ? -1 : 1;
    const noiseFactor = baseStrength * 0.25;
    for (let j = jMin; j <= jMax; j++) {
      const vz = -halfD + j * dz;
      for (let i = iMin; i <= iMax; i++) {
        const vx = -halfW + i * dx;
        const d = Math.hypot(vx - cx, vz - cz);
        if (d > r) continue;
        const w = calculateFalloff(d / r, stroke.falloff);
        const idx = j * cols + i;
        const n = (pseudoNoise(vx * 2.3 + 0.5, vz * 2.3 + 0.5) - 0.5) * 2.0;
        const delta = dir * n * w * noiseFactor;
        sculptOffsets[idx] = (sculptOffsets[idx] || 0) + delta;
      }
    }
  } else if (stroke.tool === "erode") {
    // Thermal / hydraulic slope relaxation
    const erodeFactor = baseStrength * 0.25;
    for (let j = jMin; j <= jMax; j++) {
      const vz = -halfD + j * dz;
      for (let i = iMin; i <= iMax; i++) {
        const vx = -halfW + i * dx;
        const d = Math.hypot(vx - cx, vz - cz);
        if (d > r) continue;
        const w = calculateFalloff(d / r, stroke.falloff);
        const idx = j * cols + i;

        const left = j * cols + Math.max(0, i - 1);
        const right = j * cols + Math.min(cols - 1, i + 1);
        const down = Math.max(0, j - 1) * cols + i;
        const up = Math.min(rows - 1, j + 1) * cols + i;

        const h = posArray[idx * 3 + 1];
        const avgNeighbors =
          (posArray[left * 3 + 1] + posArray[right * 3 + 1] + posArray[down * 3 + 1] + posArray[up * 3 + 1]) * 0.25;

        // If higher than neighbors, erode downward; if lower, fill slightly
        const delta = (avgNeighbors - h) * w * erodeFactor;
        sculptOffsets[idx] = (sculptOffsets[idx] || 0) + delta;
      }
    }
  } else {
    // Standard Sculpt (Raise / Lower)
    const dir = stroke.invert ? -1 : 1;
    const sculptFactor = dir * baseStrength * 0.3;
    for (let j = jMin; j <= jMax; j++) {
      const vz = -halfD + j * dz;
      for (let i = iMin; i <= iMax; i++) {
        const vx = -halfW + i * dx;
        const d = Math.hypot(vx - cx, vz - cz);
        if (d > r) continue;
        const w = calculateFalloff(d / r, stroke.falloff);
        const idx = j * cols + i;
        const delta = w * sculptFactor;
        sculptOffsets[idx] = (sculptOffsets[idx] || 0) + delta;
      }
    }
  }

  // Recompute heights and normals with updated offsets
  updateTerrainHeightsAndNormals(geometry, config, heightmapPixels, sculptOffsets);
}
