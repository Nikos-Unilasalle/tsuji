import * as THREE from "three";
import { NodeDefinition } from "../types";
import { resolvePointsInput } from "./pointsGeometry";
import { getTexturePaintState } from "./texturePaint";
import { clearPaintCanvas, createPaintCanvas, restorePaintCanvas, type TexturePaintTool } from "../../three/texturePainter";
import { syncCanvasTexture } from "../../three/layeredTexture";

/** The tools in the node's palette. Erase paints 0 rather than clearing to transparent, so the map stays opaque. */
export type PointsInfluenceTool = "paint" | "erase" | "smooth" | "fill";

/** The 5 preset values the palette offers for the brush, in the order their buttons render. */
export const POINTS_INFLUENCE_LEVELS = [0.2, 0.4, 0.6, 0.8, 1.0];

/** App.tsx's onAction id for the Compute button. */
export const POINTS_INFLUENCE_COMPUTE_ACTION = "points-influence/compute";

/** The empty map: no influence anywhere. */
export const POINTS_INFLUENCE_BASE = "#000000";

/**
 * Points Influence — like Points Selection, but graded: every point gets its
 * own 0-1 influence instead of a binary in/out.
 *
 * The influence is painted on the surface, not on the points: a grayscale
 * texture (black 0, white 1) on the input mesh's UVs, using Texture Paint's
 * canvas, strokes and save path (see Viewport.tsx — isTexturePaintNode
 * covers this node too). Painting therefore costs what painting a texture
 * costs, whatever the point count. Compute (App.tsx's onAction) then reads
 * the map under each vertex's UV and writes the result to `influences`,
 * which is what the node outputs — so a stroke changes nothing downstream
 * until Compute runs.
 *
 * `influences` stores only the non-zero entries (index -> 0-1), the same
 * sparse convention as Points Selection's `selectedIndices`.
 *
 * Outputs `influence`, not `mask`, but it's still a same-length numeric list
 * consumers read by index — Spring Vector / Wiggle Vector's Mask input (a
 * continuous 0-1 blend, not a binary threshold — see spring.ts/wiggle.ts)
 * and Extrude Mesh's per-vertex distance scale both accept it interchangeably
 * with Points Selection's own (0-or-1) mask output.
 */
export const POINTS_INFLUENCE_NODE: NodeDefinition = {
  type: "list/points-influence",
  label: "Points Influence",
  category: "list",
  inputs: [
    { id: "geometry", label: "Geometry (shortcut)", type: "geometry" },
    { id: "points", label: "Points", type: "list" },
    { id: "matrix", label: "Matrix (viewport placement)", type: "matrix" },
  ],
  outputs: [
    { id: "points", label: "Points (passthrough)", type: "list" },
    { id: "influence", label: "Influence (0-1 per point)", type: "list" },
    { id: "matrix", label: "Matrix (passthrough)", type: "matrix" },
    { id: "geometry", label: "Geometry (passthrough)", type: "geometry" },
    { id: "count", label: "Painted Count", type: "value" },
  ],
  defaultParams: {
    // Written by Compute from the painted map. Sparse: point index -> 0-1.
    influences: {} as Record<number, number>,
    // The painted map, as Texture Paint stores its canvas.
    textureData: "",
    resolution: 1024,
    brushTool: "paint" as PointsInfluenceTool,
    brushValue: 1,
    brushSize: 24,
    brushOpacity: 1,
    brushHardness: 0.5,
    symmetryX: false,
    usePressure: true,
    pressureTarget: "both",
  },
  paramFields: [
    {
      id: "computeNote",
      label: "Paint on the surface, then Compute to give each point the influence under it. The mesh needs UVs.",
      kind: "note",
    },
    { id: "compute", label: "Compute", kind: "button", action: POINTS_INFLUENCE_COMPUTE_ACTION },
    { id: "resolution", label: "Map Resolution", kind: "select", options: ["512", "1024", "2048"], group: "Brush" },
    {
      id: "brushTool",
      label: "Tool",
      kind: "select",
      options: ["paint", "erase", "smooth", "fill"],
      optionLabels: ["Paint", "Erase", "Smooth", "Fill"],
      group: "Brush",
    },
    { id: "brushValue", label: "Influence", kind: "number", step: 0.05, group: "Brush" },
    { id: "brushSize", label: "Size (map px)", kind: "number", step: 1, group: "Brush" },
    { id: "brushOpacity", label: "Opacity", kind: "number", step: 0.05, group: "Brush" },
    { id: "brushHardness", label: "Hardness", kind: "number", step: 0.05, group: "Brush" },
    { id: "symmetryX", label: "Mirror X (UV)", kind: "boolean", group: "Brush" },
    { id: "usePressure", label: "Stylus Pressure", kind: "boolean", group: "Brush" },
  ],
  // Reads nothing but its inputs and params (the paint canvas it keeps in
  // sync is only read by the viewport and Compute): on a still mesh it hands
  // back the same lists.
  pure: true,
  evaluate: (inputs, params, ctx) => {
    const { points, matrix, geometry } = resolvePointsInput(inputs, ctx.nodeId, "Points Influence");
    ensureInfluenceMap(ctx.nodeId, params);

    const influences = params.influences && typeof params.influences === "object" ? (params.influences as Record<string, number>) : {};
    let painted = 0;
    const influence = points.map((_, i) => {
      const v = Number(influences[i]) || 0;
      if (v > 0) painted++;
      return Math.max(0, Math.min(1, v));
    });

    return { points, influence, matrix, geometry, count: painted };
  },
};

function readResolution(params: Record<string, unknown>): number {
  return Math.max(64, Math.min(4096, Number(params.resolution) || 1024));
}

/**
 * Creates (or resizes) the node's paint canvas and brings it in line with
 * `textureData` — a reload, undo, or Clear. The canvas lives in Texture
 * Paint's per-node state, which is where the viewport's strokes look for it.
 */
function ensureInfluenceMap(nodeId: string, params: Record<string, unknown>): void {
  const state = getTexturePaintState(nodeId);
  const res = readResolution(params);
  if (!state.canvas || state.lastRes !== res) {
    state.canvas = createPaintCanvas(res, res, POINTS_INFLUENCE_BASE);
    state.lastRes = res;
    state.lastDataUrl = undefined;
    // Data, not colour: no sRGB decode, so the shader reads the value painted.
    state.texture = syncCanvasTexture(state.texture, state.canvas, THREE.NoColorSpace);
  }
  const dataUrl = String(params.textureData || "");
  if (dataUrl !== state.lastDataUrl) {
    state.lastDataUrl = dataUrl;
    const canvas = state.canvas;
    if (dataUrl) {
      restorePaintCanvas(canvas, dataUrl, () => {
        if (state.texture) state.texture.needsUpdate = true;
      });
    } else {
      clearPaintCanvas(canvas, POINTS_INFLUENCE_BASE);
      if (state.texture) state.texture.needsUpdate = true;
    }
  }
}

export function readPointsInfluenceTool(params: Record<string, unknown>): PointsInfluenceTool {
  const tool = params.brushTool;
  return tool === "erase" || tool === "smooth" || tool === "fill" ? tool : "paint";
}

export function readPointsInfluenceValue(params: Record<string, unknown>): number {
  const v = Number(params.brushValue);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}

/** `#rrggbb` gray for an influence: the map stores influence v as the gray v. */
export function influenceGray(v: number): string {
  const byte = Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${byte}${byte}${byte}`;
}

/** The Texture Paint tool and colour a stroke of this node uses. */
export function influenceStroke(params: Record<string, unknown>): { tool: TexturePaintTool; color: string } {
  const tool = readPointsInfluenceTool(params);
  if (tool === "erase") return { tool: "paint", color: POINTS_INFLUENCE_BASE };
  return { tool, color: influenceGray(readPointsInfluenceValue(params)) };
}

interface UvSource {
  count: number;
  getX(i: number): number;
  getY(i: number): number;
}

interface PositionSource extends UvSource {
  getZ(i: number): number;
}

/**
 * The influence under each vertex: the painted map bilinearly sampled at the
 * vertex's UV (V up, as the painter maps it), the gray times its alpha.
 *
 * Vertices that share a position — the copies a UV seam splits a vertex
 * into — get the strongest of their samples, so a stroke that stopped at
 * the seam on one side of the UV layout still moves the whole point.
 *
 * Returns only the non-zero entries, rounded to 1/1000.
 */
export function sampleInfluences(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  uv: UvSource,
  position?: PositionSource,
): Record<number, number> {
  const values = new Float32Array(uv.count);
  const read = (x: number, y: number) => {
    const xi = ((x % width) + width) % width;
    const yi = Math.max(0, Math.min(height - 1, y));
    const o = (yi * width + xi) * 4;
    return (pixels[o] / 255) * (pixels[o + 3] / 255);
  };
  for (let i = 0; i < uv.count; i++) {
    const u = ((uv.getX(i) % 1) + 1) % 1;
    const v = Math.max(0, Math.min(1, uv.getY(i)));
    const fx = u * width - 0.5;
    const fy = (1 - v) * height - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const top = read(x0, y0) * (1 - tx) + read(x0 + 1, y0) * tx;
    const bottom = read(x0, y0 + 1) * (1 - tx) + read(x0 + 1, y0 + 1) * tx;
    values[i] = top * (1 - ty) + bottom * ty;
  }

  if (position && position.count === uv.count) {
    const key = (i: number) =>
      `${Math.round(position.getX(i) * 1e5)},${Math.round(position.getY(i) * 1e5)},${Math.round(position.getZ(i) * 1e5)}`;
    const strongest = new Map<string, number>();
    for (let i = 0; i < values.length; i++) {
      const k = key(i);
      strongest.set(k, Math.max(strongest.get(k) ?? 0, values[i]));
    }
    for (let i = 0; i < values.length; i++) values[i] = strongest.get(key(i)) ?? values[i];
  }

  const out: Record<number, number> = {};
  for (let i = 0; i < values.length; i++) {
    const rounded = Math.round(values[i] * 1000) / 1000;
    if (rounded > 0) out[i] = rounded;
  }
  return out;
}

/**
 * Compute: the influence each vertex of `geometry` reads from the node's
 * painted map. Null when the geometry has no UVs (nothing to sample with)
 * or the node has no map yet.
 */
export function computePointInfluences(nodeId: string, geometry: THREE.BufferGeometry): Record<number, number> | null {
  const uv = geometry.attributes.uv;
  const canvas = getTexturePaintState(nodeId).canvas;
  if (!uv || !canvas) return null;
  const ctx2d = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx2d) return null;
  const { data } = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
  return sampleInfluences(data, canvas.width, canvas.height, uv, geometry.attributes.position);
}
