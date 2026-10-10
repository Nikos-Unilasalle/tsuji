import * as THREE from "three";
import { NodeDefinition, ParamFieldDef } from "../types";
import { createNodeCache } from "../nodeCaches";
import {
  BrushDab,
  MAP_BRUSH_TOOLS,
  applyDab,
  createPaintGrid,
  decodePaint,
  encodePaint,
} from "../../math/mapgen";

/**
 * Map Paint — the brush behind Map Elevation's `paint` input.
 *
 * The node itself only publishes a texture. Painting happens in the viewport
 * (see Viewport.tsx): while this node is selected, dragging over the terrain
 * calls paintDab() on the live grid below, and the stroke is written back to
 * `paintData` when the mouse is released. Nothing here depends on the Terrain
 * node, so the graph stays acyclic even though the brush is aimed at it.
 */

export const MAP_PAINT_RESOLUTIONS = ["128", "256", "512"];

export interface MapPaintState {
  size: number;
  /** Working grid, 0.5 = neutral. Mutated live while a stroke is in progress. */
  grid: Float32Array;
  texture: THREE.DataTexture;
  /** The `paintData` string the grid currently corresponds to. */
  committed: string;
  dirty: boolean;
}

const paintCache = createNodeCache<MapPaintState>((s) => s.texture.dispose());

function makeTexture(size: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Float32Array(size * size * 4), size, size, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** Copies the grid into the texture and bumps its version, which is what makes Map Elevation recompute. */
export function flushMapPaint(state: MapPaintState): void {
  const out = state.texture.image.data as Float32Array;
  const g = state.grid;
  for (let i = 0; i < g.length; i++) {
    out[i * 4] = g[i];
    out[i * 4 + 1] = g[i];
    out[i * 4 + 2] = g[i];
    out[i * 4 + 3] = 1;
  }
  state.texture.needsUpdate = true;
  state.dirty = false;
}

/** The node's live state, rebuilt whenever the saved data or resolution no longer matches (undo, Reset, a new file). */
export function getMapPaintState(nodeId: string, size: number, data: unknown): MapPaintState {
  const saved = typeof data === "string" ? data : "";
  let state = paintCache.get(nodeId);
  if (state && state.size !== size) {
    state.texture.dispose();
    paintCache.delete(nodeId);
    state = undefined;
  }
  if (!state) {
    state = { size, grid: decodePaint(saved, size), texture: makeTexture(size), committed: saved, dirty: false };
    flushMapPaint(state);
    paintCache.set(nodeId, state);
  } else if (state.committed !== saved) {
    state.grid = decodePaint(saved, size);
    state.committed = saved;
    flushMapPaint(state);
  }
  return state;
}

/** Applies a dab to the live grid; the texture is refreshed separately (flushMapPaint) so strokes can throttle it. */
export function paintDab(state: MapPaintState, dab: BrushDab): boolean {
  const changed = applyDab(state.grid, state.size, dab);
  if (changed) state.dirty = true;
  return changed;
}

/** Ends a stroke: refreshes the texture and returns the string to save as `paintData`. */
export function commitMapPaint(state: MapPaintState): string {
  flushMapPaint(state);
  state.committed = encodePaint(state.grid);
  return state.committed;
}

const PAINT_FIELDS: ParamFieldDef[] = [
  { id: "resolution", label: "Paint Resolution", kind: "select", options: MAP_PAINT_RESOLUTIONS, group: "Layer" },
  { id: "brushTool", label: "Brush Tool", kind: "select", options: [...MAP_BRUSH_TOOLS], group: "Brush" },
  { id: "brushSize", label: "Brush Radius (% of map)", kind: "number", step: 0.01, percent: true, group: "Brush" },
  { id: "brushStrength", label: "Brush Strength", kind: "number", step: 0.05, percent: true, group: "Brush" },
  {
    id: "brushFalloff",
    label: "Brush Falloff",
    kind: "select",
    options: ["smooth", "linear", "sphere", "flat"],
    group: "Brush",
  },
  { id: "width", label: "Fallback Width (X)", kind: "number", step: 1, group: "Aim at a flat map when no Terrain is shown" },
  { id: "depth", label: "Fallback Depth (Z)", kind: "number", step: 1, group: "Aim at a flat map when no Terrain is shown" },
];

export const MAP_PAINT_NODE: NodeDefinition = {
  type: "map/paint",
  label: "Map Paint",
  category: "map",
  inputs: [],
  outputs: [{ id: "paint", label: "Paint", type: "texture" }],
  reset: { params: ["paintData"] },
  defaultParams: {
    resolution: "256",
    paintData: "",
    brushTool: "raise",
    brushSize: 0.08,
    brushStrength: 0.5,
    brushFalloff: "smooth",
    width: 40,
    depth: 40,
  },
  paramFields: PAINT_FIELDS,
  evaluate: (_inputs, params, ctx) => {
    const size = MAP_PAINT_RESOLUTIONS.includes(String(params.resolution)) ? Number(params.resolution) : 256;
    return { paint: getMapPaintState(ctx.nodeId, size, params.paintData).texture };
  },
};

/** A blank grid, for tests and callers that need a layer without a node. */
export { createPaintGrid };
