import { MATRIX_TRANSFORM_NODE, TRANSFORM_NODE } from "./nodes/transform";
import { Graph } from "./types";

/**
 * Node types whose mesh tags itself with a nodeId (see object.ts) and so can
 * be click-selected and gizmo-edited in the viewport. Doubles as the set of
 * types that own a native location/rotation/scale pose (composeNativeMatrix
 * in transform.ts) — see the "native" GizmoTarget kind below.
 */
export const GIZMO_SELECTABLE_TYPES = [
  "object/box",
  "object/plane",
  "object/sphere",
  "object/disc",
  "object/cylinder",
  "object/cone",
  "object/bar_graph",
  "object/line_graph",
  "object/chart_axis",
  "object/pie_chart",
  "object/scatter_plot",
  "object/point_cloud",
  "object/obj",
  "object/gltf",
  "object/frozen",
  "object/text",
  "curve/to_mesh",
  "curve/to_mesh_list",
  "curve/from_points",
  "curve/primitive",
  "curve/svg",
  "curve/svg_solid",
  "curve/svg_mesh",
  "curve/to_line",
  "curve/to_line_list",
  "curve/deform",
  "structure/merge",
  "object/empty",
  "texture/plane",
  "object/decal",
  "light/directional",
  "light/point",
  "light/spot",
  "light/probe",
  "calibration/camera",
  "calibration/grid",
  "modifier/lattice",
  "modifier/edit-mesh",
  "particles/force-field",
  "particles/curl-noise",
  "particles/strange-attractor",
  "particles/emitter",
  "object/raccoon",
  "object/laser-beam",
  "curve/grease-pencil",
  "curve/paint-on-geometry",
];

/**
 * What the viewport's gizmo found one hop upstream of a selected object's
 * `matrix` input, and how a drag should be written back (see Viewport.tsx):
 *
 * - "absolute": a plain `transform` node — its location/rotation/scale
 *   directly compose the object's final matrix, so the gizmo's own dragged
 *   world position/rotation/scale can be written straight into its params.
 * - "offset": a `transform/matrix-transform` node — its location/rotation/
 *   scale are a *local delta* applied on top of whatever `baseSourceNodeId`
 *   feeds its own `matrix` input (final = base * delta). Writing the
 *   gizmo's absolute pose straight into this node's params would double
 *   count the base transform, so the caller has to solve
 *   `delta = inverse(base) * final` first — `baseSourceNodeId` is what to
 *   look the current `base` matrix up from (null if nothing is wired in,
 *   i.e. base is the identity, same fallback MATRIX_TRANSFORM_NODE's own
 *   evaluate uses).
 *
 * - "native": neither of the above is wired directly upstream, but the
 *   object's own type owns a native pose (composeNativeMatrix in
 *   transform.ts — `final = base(object's own location/rotation/scale) ×
 *   delta(whatever's wired into its matrix input, identity if nothing is)`.
 *   The gizmo drags the object's own params as the base, same
 *   `base = final × delta⁻¹` inversion as "offset" but solved for the
 *   opposite unknown (there the base is fixed and the delta gets solved
 *   for; here the delta is fixed — from `deltaSourceNodeId` — and the base
 *   does). A strict superset of the old behavior: previously wiring
 *   anything other than Transform/MatrixTransform into `matrix` (a bare
 *   `Parent`, or nothing at all) meant no gizmo; now it falls through to
 *   "native" instead.
 *
 * "absolute" and "offset" are checked first and preserved exactly — a graph
 * that already wires an explicit Transform/Matrix Transform node upstream
 * keeps editing *that* node, not the object's own (in that case unused)
 * native params.
 *
 * Deliberately still one hop, not a full chain walk: `transform/parent`,
 * `transform/look-at`, or any other matrix-producing node has no single
 * location/rotation/scale to drag — those cases fall through to "native" (or
 * to null, for an object type with no native pose) rather than guessing.
 * Chaining is edited through each node's own param fields instead, same as
 * it is today.
 */
export type GizmoTarget =
  | { kind: "absolute"; transformNodeId: string }
  | { kind: "offset"; transformNodeId: string; baseSourceNodeId: string | null }
  | { kind: "native"; objectNodeId: string; deltaSourceNodeId: string | null };

const NATIVE_TRANSFORM_TYPES = new Set<string>(GIZMO_SELECTABLE_TYPES);

export function resolveGizmoTarget(graph: Graph, objectNodeId: string, depth = 0): GizmoTarget | null {
  const connection = graph.connections.find((c) => c.toNode === objectNodeId && c.toSocket === "matrix");
  const source = connection ? graph.nodes.find((n) => n.id === connection.fromNode) : undefined;

  if (source?.type === TRANSFORM_NODE.type) {
    // A plain Transform node is only safe to drag directly when none of its
    // own channels are wired — dragging it there writes straight into its
    // location/rotation/scale params, which is exactly what its evaluate
    // reads back (see transform.ts). But a wired channel (e.g. Rotation fed
    // by a Compose Vector with an axis disabled via the -1 sentinel) means
    // that channel's param is ignored at evaluate time — a drag can still
    // move the object on screen, so it silently looked "broken", not
    // read-only. Falling through to the object's own native pose below
    // (composeNativeMatrix's base, with this Transform node's resolved
    // output composed on top as the delta — same as any other non-Transform
    // matrix source) keeps every unwired channel, and every disabled axis
    // that folds to identity, directly draggable again.
    const channelWired = (socket: string) =>
      graph.connections.some((c) => c.toNode === source.id && c.toSocket === socket);
    if (!channelWired("location") && !channelWired("rotation") && !channelWired("scale")) {
      return { kind: "absolute", transformNodeId: source.id };
    }
  }

  if (source?.type === MATRIX_TRANSFORM_NODE.type) {
    const baseConnection = graph.connections.find((c) => c.toNode === source.id && c.toSocket === "matrix");
    return { kind: "offset", transformNodeId: source.id, baseSourceNodeId: baseConnection?.fromNode ?? null };
  }

  const objectNode = graph.nodes.find((n) => n.id === objectNodeId);
  if (objectNode && NATIVE_TRANSFORM_TYPES.has(objectNode.type)) {
    return { kind: "native", objectNodeId, deltaSourceNodeId: connection?.fromNode ?? null };
  }

  // A pure geometry modifier (Subdivide, Array, ...) owns no location/
  // rotation/scale of its own and passes the source mesh's pose through
  // untouched — its output is drawn at exactly the source's matrix, never
  // its own. Selecting one used to do nothing at all (not "native", nothing
  // wired to `matrix` either), even though the object on screen is right
  // there and looks selected. Deferring to whatever feeds its `geometry`
  // input resolves to the node that actually owns the pose, same as if that
  // upstream node had been selected directly — one hop further than the
  // matrix-chain walk above goes, but bounded (`depth`) against a cyclic
  // graph looping forever.
  if (depth < 8) {
    const geometryConnection = graph.connections.find(
      (c) => c.toNode === objectNodeId && c.toSocket === "geometry",
    );
    if (geometryConnection) {
      return resolveGizmoTarget(graph, geometryConnection.fromNode, depth + 1);
    }
  }

  return null;
}
