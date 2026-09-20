import { Graph, NodeInstance } from "./types";

/**
 * Node types that own an editable `pointsList` param — the control points the
 * viewport draws draggable handles for. `curve/to_mesh` is in here for its
 * *fallback* list only: the one it builds a curve from when nothing is wired
 * into its `curve` input (see curve.ts). A node loaded from an .ovm file
 * carries the param regardless of type, so the check below accepts either.
 */
export const CURVE_POINTS_NODE_TYPES = [
  "curve/from_points",
  "curve/to_mesh",
  "modifier/lattice",
  "object/edit_points",
];

/**
 * What the viewport's curve-point handles edit, and in whose space:
 *
 * - `pointsNodeId` — the node whose `pointsList` param a handle drag writes
 *   into. Always the node that actually *feeds* the drawn curve, which is not
 *   the selected node when a Curve to Mesh has a Curve from Points wired in:
 *   editing the consumer's own (unused) fallback list there would move
 *   handles that change nothing on screen.
 *
 * - `spaceNodeId` — the node whose evaluated object places those points in
 *   the world. Control points are stored in the *curve's* own coordinate
 *   space; the mesh built from them carries a location/rotation/scale on top
 *   (composeNativeMatrix, plus anything wired into its `matrix` input). The
 *   handles have to be drawn through that same matrix, or they sit at the
 *   origin while the tube they belong to is somewhere else — and a drag has
 *   to be read back through its inverse. Equal to `pointsNodeId` when the
 *   points live on the object that draws them (a Curve to Mesh editing its
 *   own fallback list, or a Curve from Points with no consumer yet, whose
 *   space is then simply the world).
 *
 * Deliberately one hop, same as resolveGizmoTarget in transformLookup.ts: a
 * curve routed through Reroute/List nodes falls back to no handles rather
 * than guessing which object it ends up drawn by.
 */
export interface CurveEditTarget {
  pointsNodeId: string;
  spaceNodeId: string;
}

function hasEditablePoints(node: NodeInstance | undefined): boolean {
  if (!node) return false;
  return CURVE_POINTS_NODE_TYPES.includes(node.type) || Array.isArray(node.params.pointsList);
}

export function resolveCurveEditTarget(graph: Graph, selectedNodeId: string | null): CurveEditTarget | null {
  if (!selectedNodeId) return null;
  const selected = graph.nodes.find((n) => n.id === selectedNodeId);
  if (!selected) return null;

  // Selected node consumes a curve (Curve to Mesh, Curve Deform): the points
  // belong to whatever produces it, the space is the consumer's own.
  const wire = graph.connections.find((c) => c.toNode === selected.id && c.toSocket === "curve");
  if (wire) {
    const producer = graph.nodes.find((n) => n.id === wire.fromNode);
    // A producer with no control points of its own (Curve Primitive) is
    // parametric — there is nothing to drag, so no handles at all.
    return hasEditablePoints(producer) ? { pointsNodeId: producer!.id, spaceNodeId: selected.id } : null;
  }

  if (!hasEditablePoints(selected)) return null;

  // Selected node owns the points. If it also feeds a consumer, that
  // consumer's transform is what places them on screen.
  const consumer = graph.connections.find((c) => c.fromNode === selected.id && c.fromSocket === "curve");
  return { pointsNodeId: selected.id, spaceNodeId: consumer?.toNode ?? selected.id };
}
