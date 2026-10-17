import { NodeDefinition } from "../types";
import { resolvePointsInput } from "./pointsGeometry";

export type PointsInfluenceMode = "brush" | "discrete" | "gradient";

/** The 5 preset levels, in the order their viewport buttons render — shared by Brush (caps each dab's strength) and Discrete (the flat value a click/marquee assigns). */
export const POINTS_INFLUENCE_DISCRETE_LEVELS = [0.2, 0.4, 0.6, 0.8, 1.0];

/**
 * Points Influence — like Points Selection, but graded: every point gets its
 * own 0-1 influence instead of a binary in/out, painted in the viewport
 * (see Viewport.tsx's pointsInfluenceHandles), all three gestures gated
 * behind Cmd/Ctrl+drag like every other viewport pick tool in this codebase
 * (curve marquee, Points Selection marquee) — a plain drag always stays
 * camera orbit, never hijacked by the active node's editing mode:
 * - Brush: Cmd+drag a stroke, influence falls off with distance from the
 *   cursor, capped at whichever of the 5 preset levels is armed.
 * - Discrete: the same 5 levels, but a flat assign — Cmd-click or
 *   Cmd-marquee writes the armed level exactly, no falloff.
 * - Gradient: Cmd-drag a single straight line once; every point's influence
 *   becomes its own projection onto that line (1 at the start, 0 at the
 *   end, linear in between) — a full-object dégradé in one stroke, e.g.
 *   top-to-bottom, independent of the 5 preset levels.
 *
 * `influences` stores only the non-zero entries (index -> 0-1), same sparse
 * convention as Points Selection's `selectedIndices` — a point nobody ever
 * touched defaults to 0 influence rather than needing an explicit entry.
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
    // Not user-typed — painted by dragging/clicking in the viewport (see
    // Viewport.tsx). Sparse map: point index -> 0-1 influence.
    influences: {} as Record<number, number>,
    mode: "brush" as PointsInfluenceMode,
    brushRadius: 40,
    // Armed level for Discrete mode — which of the 5 viewport buttons is
    // currently selected; persisted like any other param so it survives a
    // reload with the last tool the operator was using.
    activeLevel: POINTS_INFLUENCE_DISCRETE_LEVELS[2],
  },
  paramFields: [
    { id: "mode", label: "Mode", kind: "select", options: ["brush", "discrete", "gradient"], group: "Points Influence" },
    { id: "brushRadius", label: "Brush Radius (px)", kind: "number", step: 5, group: "Points Influence" },
  ],
  // Reads nothing but its inputs and params: on a still mesh it is skipped and
  // hands back the same lists, which also lets the viewport skip recoloring.
  pure: true,
  evaluate: (inputs, params, ctx) => {
    const { points, matrix, geometry } = resolvePointsInput(inputs, ctx.nodeId, "Points Influence");

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
