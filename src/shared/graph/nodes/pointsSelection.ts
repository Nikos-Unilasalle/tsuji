import { NodeDefinition } from "../types";
import { resolvePointsInput } from "./pointsGeometry";

/**
 * Points Selection — a pick-list of indices into an incoming point set, made
 * by clicking/marquee-dragging the points in the 3D viewport when this node
 * is selected in the graph (see Viewport.tsx's points-edit gate, parallel to
 * the existing curve-handle one). `selectedIndices` lives as a plain param —
 * same storage convention as `pointsList` elsewhere — so a selection
 * survives save/load and undo/redo like any other param.
 *
 * Two ways to feed it points, so the whole "spring part of a mesh" workflow
 * can be either the explicit long form or a two-node shortcut:
 * - Points + Matrix (a Mesh to Points or Lattice Deform output plugged in).
 * - Geometry directly — this node does its own Mesh to Points extraction
 *   internally (same extractPointsFromMesh core) and additionally passes the
 *   original object through on `geometry`, which is what lets
 *   `OBJ -> Points Selection -> Spring Vector` skip both the separate Mesh
 *   to Points *and* Points to Mesh nodes: Spring Vector's own Geometry input
 *   (see spring.ts) reads that passthrough and writes its result straight
 *   back into a mesh, with no points-list plumbing visible to the operator.
 * Geometry wins if both are wired — it's not a sensible thing to wire both.
 *
 * Outputs `mask`, not the index list itself, because that's what Spring
 * Vector's Individual Points mode actually consumes: a same-length
 * 1-or-0-per-point array is a direct per-index lookup, whereas the index
 * list would make every consumer re-derive that lookup itself.
 */
export const POINTS_SELECTION_NODE: NodeDefinition = {
  type: "list/points-selection",
  label: "Points Selection",
  category: "list",
  inputs: [
    { id: "geometry", label: "Geometry (shortcut)", type: "geometry" },
    { id: "points", label: "Points", type: "list" },
    { id: "matrix", label: "Matrix (viewport placement)", type: "matrix" },
  ],
  outputs: [
    { id: "points", label: "Points (passthrough)", type: "list" },
    { id: "mask", label: "Mask (1=selected)", type: "list" },
    { id: "matrix", label: "Matrix (passthrough)", type: "matrix" },
    { id: "geometry", label: "Geometry (passthrough)", type: "geometry" },
    { id: "count", label: "Selected Count", type: "value" },
  ],
  // Not user-typed — set by clicking/marquee-dragging points in the
  // viewport (see Viewport.tsx). No paramFields entry: exposing a raw index
  // array as a manually-edited number field would invite hand-typed
  // out-of-range indices for no real benefit.
  defaultParams: {
    selectedIndices: [] as number[],
    // Off: clicks and the marquee only reach the points the camera sees, not
    // the ones behind the surface. On: every point, as Edit Mesh's X-ray.
    xray: false,
  },
  paramFields: [],
  // Reads nothing but its inputs and params (ctx.nodeId only names errors):
  // on a still mesh it hands back the same lists, which lets the viewport
  // skip resyncing the cloud.
  pure: true,
  evaluate: (inputs, params, ctx) => {
    const { points, matrix, geometry } = resolvePointsInput(inputs, ctx.nodeId, "Points Selection");

    const selected = Array.isArray(params.selectedIndices) ? (params.selectedIndices as number[]) : [];
    const selectedSet = new Set(selected);
    const mask = points.map((_, i) => (selectedSet.has(i) ? 1 : 0));

    return { points, mask, matrix, geometry, count: selected.length };
  },
};
