import { calculateFalloff, BrushFalloff } from "../../three/brushFalloff";

/**
 * The paint layer behind the Map Paint brush: a square grid of bias values in
 * [0, 1] where 0.5 means "leave the terrain alone", above raises it and below
 * lowers it. Map Elevation reads it as a texture, so painting never touches
 * the generator itself — it only nudges the noise.
 *
 * Row 0 is the map's y = 0 edge, the same convention as the Terrain heightmap.
 */

export type MapBrushTool = "raise" | "lower" | "smooth" | "erase";
export const MAP_BRUSH_TOOLS: MapBrushTool[] = ["raise", "lower", "smooth", "erase"];
export const PAINT_NEUTRAL = 0.5;

export interface BrushDab {
  /** Centre in map coordinates, 0..1. */
  x: number;
  y: number;
  /** Radius as a fraction of the map width. */
  radius: number;
  /** 0..1. */
  strength: number;
  tool: MapBrushTool;
  falloff: BrushFalloff;
  /** Swaps raise and lower (the Alt key). */
  invert?: boolean;
}

/** How far one full-strength dab at the centre moves the bias. */
const DAB_RATE = 0.1;

export function createPaintGrid(size: number): Float32Array {
  return new Float32Array(size * size).fill(PAINT_NEUTRAL);
}

/** Applies one brush dab in place; returns whether any cell changed. */
export function applyDab(grid: Float32Array, size: number, dab: BrushDab): boolean {
  const r = Math.max(0.5, dab.radius * size);
  const cx = dab.x * size - 0.5;
  const cy = dab.y * size - 0.5;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(size - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(size - 1, Math.ceil(cy + r));
  if (x0 > x1 || y0 > y1) return false;

  const strength = Math.max(0, Math.min(1, dab.strength));
  let tool = dab.tool;
  if (dab.invert && (tool === "raise" || tool === "lower")) tool = tool === "raise" ? "lower" : "raise";

  // Smoothing reads neighbours, so it works from a snapshot of the area.
  let snapshot: Float32Array | null = null;
  const sw = x1 - x0 + 3;
  if (tool === "smooth") {
    snapshot = new Float32Array(sw * (y1 - y0 + 3));
    for (let y = y0 - 1; y <= y1 + 1; y++) {
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        const gx = Math.min(size - 1, Math.max(0, x));
        const gy = Math.min(size - 1, Math.max(0, y));
        snapshot[(y - y0 + 1) * sw + (x - x0 + 1)] = grid[gy * size + gx];
      }
    }
  }

  let changed = false;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const f = calculateFalloff(Math.hypot(x - cx, y - cy) / r, dab.falloff);
      if (f <= 0) continue;
      const i = y * size + x;
      const v = grid[i];
      let next = v;
      if (tool === "raise") next = v + f * strength * DAB_RATE;
      else if (tool === "lower") next = v - f * strength * DAB_RATE;
      else if (tool === "erase") next = v + (PAINT_NEUTRAL - v) * Math.min(1, f * strength * 0.5);
      else if (snapshot) {
        const o = (y - y0 + 1) * sw + (x - x0 + 1);
        const mean =
          (snapshot[o - sw - 1] + snapshot[o - sw] + snapshot[o - sw + 1] + snapshot[o - 1] + snapshot[o + 1] + snapshot[o + sw - 1] + snapshot[o + sw] + snapshot[o + sw + 1]) / 8;
        next = v + (mean - v) * Math.min(1, f * strength);
      }
      next = Math.max(0, Math.min(1, next));
      if (next !== v) {
        grid[i] = next;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Compact text form for saving in a node param: each cell quantised to a byte
 * (v × 256, so 0.5 is exactly 128) and run-length encoded, because a map that
 * is mostly unpainted is mostly one long run. Empty string = nothing painted.
 */
export function encodePaint(grid: Float32Array): string {
  const bytes: number[] = [];
  let run = 0;
  let prev = -1;
  let painted = false;
  for (let i = 0; i < grid.length; i++) {
    const q = Math.max(0, Math.min(255, Math.round(grid[i] * 256)));
    if (q !== 128) painted = true;
    if (q === prev && run < 255) {
      run++;
    } else {
      if (run > 0) bytes.push(prev, run);
      prev = q;
      run = 1;
    }
  }
  if (!painted) return "";
  bytes.push(prev, run);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.slice(i, i + 8192));
  return btoa(bin);
}

/** Inverse of encodePaint; a missing, malformed or wrong-sized string gives a blank grid. */
export function decodePaint(data: unknown, size: number): Float32Array {
  const grid = createPaintGrid(size);
  if (typeof data !== "string" || data.length === 0) return grid;
  let bin: string;
  try {
    bin = atob(data);
  } catch {
    return grid;
  }
  if (bin.length % 2 !== 0) return grid;
  const out = new Float32Array(size * size);
  let at = 0;
  for (let i = 0; i < bin.length; i += 2) {
    const v = bin.charCodeAt(i) / 256;
    const n = bin.charCodeAt(i + 1);
    if (at + n > out.length) return grid;
    out.fill(v, at, at + n);
    at += n;
  }
  return at === out.length ? out : grid;
}
