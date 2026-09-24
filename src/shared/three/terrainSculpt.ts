import * as THREE from "three";
import { TerrainGridConfig, updateTerrainHeightsAndNormals } from "./terrainEngine";
import { BrushFalloff, calculateFalloff, strokeBaseStrength } from "./brushFalloff";

export type TerrainBrushTool =
  | "sculpt"
  | "smooth"
  | "flatten"
  | "noise"
  | "erode"
  | "clayStrip"
  | "pinch"
  | "crease"
  | "mask";
export type TerrainBrushFalloff = BrushFalloff;

export interface SculptStrokeParams {
  tool: TerrainBrushTool;
  falloff: TerrainBrushFalloff;
  radius: number;
  strength: number;
  invert: boolean;
  hitPoint: THREE.Vector3; // In terrain local coordinates
  targetHeight?: number;   // In terrain local coordinates (for flatten)
  deltaTime?: number;
  /** Mask tool: paints maskWeights toward 1 normally, toward 0 when true (Blender's Shift-erase). */
  maskErase?: boolean;
  symmetryX?: boolean;
  symmetryZ?: boolean;
}

export { calculateFalloff };

function pseudoNoise(x: number, z: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453123;
  return s - Math.floor(s);
}

/** Applies one tool's brush footprint centered at local (cx, cz). */
function applyStrokeAtCenter(
  posArray: Float32Array,
  config: TerrainGridConfig,
  cx: number,
  cz: number,
  sculptOffsets: Record<number, number>,
  maskWeights: Record<number, number> | undefined,
  stroke: SculptStrokeParams,
  baseStrength: number,
): void {
  const { width, depth, segmentsX, segmentsZ } = config;
  const cols = segmentsX + 1;
  const rows = segmentsZ + 1;
  const dx = width / segmentsX;
  const dz = depth / segmentsZ;
  const halfW = width * 0.5;
  const halfD = depth * 0.5;
  const r = Math.max(0.1, stroke.radius);

  const iMin = Math.max(0, Math.floor((cx - r + halfW) / dx));
  const iMax = Math.min(cols - 1, Math.ceil((cx + r + halfW) / dx));
  const jMin = Math.max(0, Math.floor((cz - r + halfD) / dz));
  const jMax = Math.min(rows - 1, Math.ceil((cz + r + halfD) / dz));
  if (iMin > iMax || jMin > jMax) return;

  const applyDelta = (idx: number, rawDelta: number) => {
    const mask = maskWeights ? 1 - (maskWeights[idx] || 0) : 1;
    if (mask <= 0) return;
    sculptOffsets[idx] = (sculptOffsets[idx] || 0) + rawDelta * mask;
  };

  if (stroke.tool === "mask") {
    const dir = stroke.maskErase ? -1 : 1;
    const paintFactor = baseStrength * 0.6;
    if (!maskWeights) return;
    for (let j = jMin; j <= jMax; j++) {
      const vz = -halfD + j * dz;
      for (let i = iMin; i <= iMax; i++) {
        const vx = -halfW + i * dx;
        const d = Math.hypot(vx - cx, vz - cz);
        if (d > r) continue;
        const w = calculateFalloff(d / r, stroke.falloff);
        const idx = j * cols + i;
        const next = (maskWeights[idx] || 0) + dir * w * paintFactor;
        maskWeights[idx] = Math.max(0, Math.min(1, next));
      }
    }
    return;
  }

  if (stroke.tool === "smooth" || stroke.tool === "pinch") {
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
        sumHeights += posArray[idx * 3 + 1] * w;
        sumWeights += w;
      }
    }
    if (sumWeights <= 1e-5) return;
    const avgH = sumHeights / sumWeights;
    // Smooth pulls toward the neighborhood average (blurs); Pinch pushes
    // away from it (sharpens) — same math, opposite sign.
    const sign = stroke.tool === "pinch" ? -1 : 1;
    const factor = baseStrength * (stroke.tool === "pinch" ? 0.3 : 0.35) * sign;
    for (let j = jMin; j <= jMax; j++) {
      const vz = -halfD + j * dz;
      for (let i = iMin; i <= iMax; i++) {
        const vx = -halfW + i * dx;
        const d = Math.hypot(vx - cx, vz - cz);
        if (d > r) continue;
        const w = calculateFalloff(d / r, stroke.falloff);
        const idx = j * cols + i;
        const currentH = posArray[idx * 3 + 1];
        applyDelta(idx, (avgH - currentH) * w * factor);
      }
    }
    return;
  }

  if (stroke.tool === "flatten" || stroke.tool === "clayStrip") {
    // Flatten locks the target height at stroke start; Clay Strip re-targets
    // the brush-local average height every call, building material up
    // instead of leveling to one fixed plane.
    let targetH: number;
    if (stroke.tool === "clayStrip") {
      let sum = 0;
      let count = 0;
      for (let j = jMin; j <= jMax; j++) {
        for (let i = iMin; i <= iMax; i++) {
          sum += posArray[(j * cols + i) * 3 + 1];
          count++;
        }
      }
      targetH = count > 0 ? sum / count : stroke.hitPoint.y;
    } else {
      targetH = stroke.targetHeight !== undefined ? stroke.targetHeight : stroke.hitPoint.y;
    }
    const factor = baseStrength * (stroke.tool === "clayStrip" ? 0.5 : 0.4);
    for (let j = jMin; j <= jMax; j++) {
      const vz = -halfD + j * dz;
      for (let i = iMin; i <= iMax; i++) {
        const vx = -halfW + i * dx;
        const d = Math.hypot(vx - cx, vz - cz);
        if (d > r) continue;
        const w = calculateFalloff(d / r, stroke.falloff);
        const idx = j * cols + i;
        const currentH = posArray[idx * 3 + 1];
        applyDelta(idx, (targetH - currentH) * w * factor);
      }
    }
    return;
  }

  if (stroke.tool === "noise") {
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
        applyDelta(idx, dir * n * w * noiseFactor);
      }
    }
    return;
  }

  if (stroke.tool === "erode") {
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
        applyDelta(idx, (avgNeighbors - h) * w * erodeFactor);
      }
    }
    return;
  }

  if (stroke.tool === "crease") {
    // Pinch (sharpen toward the neighborhood average) plus a tight, small
    // lower right at the center — carves a sharp valley line.
    let sumWeights = 0;
    let sumHeights = 0;
    for (let j = jMin; j <= jMax; j++) {
      const vz = -halfD + j * dz;
      for (let i = iMin; i <= iMax; i++) {
        const vx = -halfW + i * dx;
        const d = Math.hypot(vx - cx, vz - cz);
        if (d > r) continue;
        const w = calculateFalloff(d / r, stroke.falloff);
        sumHeights += posArray[(j * cols + i) * 3 + 1] * w;
        sumWeights += w;
      }
    }
    const avgH = sumWeights > 1e-5 ? sumHeights / sumWeights : stroke.hitPoint.y;
    const pinchFactor = baseStrength * 0.3;
    const dir = stroke.invert ? 1 : -1;
    const creaseFactor = dir * baseStrength * 0.3;
    for (let j = jMin; j <= jMax; j++) {
      const vz = -halfD + j * dz;
      for (let i = iMin; i <= iMax; i++) {
        const vx = -halfW + i * dx;
        const d = Math.hypot(vx - cx, vz - cz);
        if (d > r) continue;
        const idx = j * cols + i;
        const currentH = posArray[idx * 3 + 1];
        const pinchW = calculateFalloff(d / r, stroke.falloff);
        const creaseW = calculateFalloff(Math.min(1, (d / r) * 2), stroke.falloff);
        applyDelta(idx, (currentH - avgH) * pinchW * -pinchFactor + creaseW * creaseFactor);
      }
    }
    return;
  }

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
      applyDelta(idx, w * sculptFactor);
    }
  }
}

/**
 * Applies a sculpting brush stroke to terrain offsets.
 * Mutates sculptOffsets (and maskWeights, for the mask tool) in place and
 * updates the geometry buffers.
 */
export function applySculptStroke(
  geometry: THREE.BufferGeometry,
  config: TerrainGridConfig,
  heightmapPixels: { data: Uint8ClampedArray | Uint8Array | Float32Array; width: number; height: number } | null,
  sculptOffsets: Record<number, number>,
  stroke: SculptStrokeParams,
  maskWeights?: Record<number, number>,
): void {
  const posAttr = geometry.attributes.position as THREE.BufferAttribute;
  const posArray = posAttr.array as Float32Array;
  const baseStrength = strokeBaseStrength(stroke.strength, stroke.deltaTime);

  const cx = stroke.hitPoint.x;
  const cz = stroke.hitPoint.z;
  applyStrokeAtCenter(posArray, config, cx, cz, sculptOffsets, maskWeights, stroke, baseStrength);

  if (stroke.symmetryX) {
    applyStrokeAtCenter(posArray, config, -cx, cz, sculptOffsets, maskWeights, stroke, baseStrength);
  }
  if (stroke.symmetryZ) {
    applyStrokeAtCenter(posArray, config, cx, -cz, sculptOffsets, maskWeights, stroke, baseStrength);
  }
  if (stroke.symmetryX && stroke.symmetryZ) {
    applyStrokeAtCenter(posArray, config, -cx, -cz, sculptOffsets, maskWeights, stroke, baseStrength);
  }

  // Recompute heights and normals with updated offsets
  updateTerrainHeightsAndNormals(geometry, config, heightmapPixels, sculptOffsets, maskWeights);
}
