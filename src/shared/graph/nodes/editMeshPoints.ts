import * as THREE from "three";
import { NodeDefinition } from "../types";
import { asVector3 } from "./transform";
import { writePointsToMesh } from "./pointsGeometry";
import { TOGGLE_POINTS_KEYFRAME_ACTION } from "./curve";

/**
 * Seeds/reseeds `pointsList` from whatever mesh is currently wired into
 * Basis — see App.tsx's onParamAction. A button rather than something
 * automatic in `evaluate`: evaluate is pure and can't write back into the
 * graph, and re-running this on every topology change (an upstream Subdivide
 * dialled up, say) would silently discard whatever the operator already
 * edited here.
 */
export const RESEED_MESH_POINTS_ACTION = "object/reseed-edit-points";

/** Two vertices this close together are the same corner as far as an operator is concerned — see applyWeldedPointMoves. */
const WELD_EPSILON_SQ = 1e-10;

/**
 * Applies dragged control-point positions, dragging every *coincident*
 * vertex along with each one.
 *
 * `extractPointsFromMesh` deliberately yields one point per raw
 * vertex-buffer entry rather than per unique position (see its own comment):
 * a Box's corner is three entries with the same position but different
 * normals and UVs. Without welding, a handle drag moved one of those three
 * and left the other two behind — the corner split open and the mesh tore
 * along its seams instead of following the handle, which reads as "the mesh
 * doesn't move" since only a sliver of it does.
 *
 * Deltas are read from the pre-move positions and written into a separate
 * array, so a vertex being dragged never also picks up a neighbour's delta,
 * and each welded vertex takes exactly one delta even when several of the
 * points it is coincident with are dragged together (a marquee selection
 * inevitably grabs all three of a corner's stacked handles at once).
 */
export function applyWeldedPointMoves(
  rawList: unknown[],
  moves: Map<number, THREE.Vector3>,
): THREE.Vector3[] {
  const points = rawList.map((p) => asVector3(p, new THREE.Vector3()));
  const result = points.map((p) => p.clone());
  const welded = new Set<number>();

  for (const [index, target] of moves) {
    const origin = points[index];
    if (!origin) continue;
    result[index].copy(target);
    const delta = new THREE.Vector3().subVectors(target, origin);
    for (let i = 0; i < points.length; i++) {
      if (moves.has(i) || welded.has(i)) continue;
      if (points[i].distanceToSquared(origin) <= WELD_EPSILON_SQ) {
        result[i].add(delta);
        welded.add(i);
      }
    }
  }

  return result;
}

/**
 * Edit Mesh Points — the mesh equivalent of Curve from Points' draggable
 * control-point handles (see curveHandles.ts / curveLookup.ts, which key off
 * any node with an array-valued `pointsList` param, this one included), but
 * fixed-topology: no insert/remove, since a mesh's vertex buffer is not free
 * to grow or shrink the way a curve's control-point list is — every entry
 * has to keep lining up with the source mesh's own vertex indices for
 * writePointsToMesh's index-aligned write-back to mean anything. Viewport.tsx
 * explicitly blocks the curve editor's insert/remove keys for this node type.
 *
 * `pointsList` starts empty (there is no mesh to seed it from until Basis is
 * wired) — "Reset Points from Basis" fills it in, and the node passes Basis
 * straight through, unedited, until then.
 */
export const EDIT_MESH_POINTS_NODE: NodeDefinition = {
  type: "object/edit_points",
  label: "Edit Mesh Points",
  category: "object",
  inputs: [{ id: "basis", label: "Basis", type: "geometry", owns: true }],
  outputs: [{ id: "geometry", label: "Geometry", type: "geometry" }],
  defaultParams: {
    pointsList: [],
    selectedPoints: [] as number[],
  },
  paramFields: [
    { id: "reseedButton", label: "Reset Points from Basis", kind: "button", action: RESEED_MESH_POINTS_ACTION },
    { id: "pointsKeyframeButton", label: "Keyframe points at frame", kind: "button", action: TOGGLE_POINTS_KEYFRAME_ACTION },
  ],
  evaluate: (inputs, params, ctx) => {
    const basisObj = inputs.basis as THREE.Object3D | undefined;
    if (!basisObj) return { geometry: null };

    const pointsList = Array.isArray(params.pointsList) ? params.pointsList : [];
    // Not seeded yet (or Basis was swapped for something else without
    // re-seeding): pass the mesh through untouched rather than guess.
    if (pointsList.length === 0) return { geometry: basisObj };

    const points = pointsList.map((p) => asVector3(p, new THREE.Vector3()));
    const result = writePointsToMesh(ctx.nodeId, basisObj, points, "Edit Mesh Points");
    return { geometry: result };
  },
};
