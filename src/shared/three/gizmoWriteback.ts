import * as THREE from "three";
import { GizmoTarget } from "../graph/transformLookup";

export type TransformGizmoMode = "translate" | "rotate" | "scale";

/**
 * The params a viewport drag writes back. computeGizmoWriteback below only
 * ever produces the pose fields; `pointsList` is the one entry that comes
 * from elsewhere — a curve control point handle, which shares the same
 * onTransformChange channel (see Viewport.tsx) because it wants the same
 * one-undo-step-per-drag and keyframe handling.
 */
export interface TransformPatch {
  location?: THREE.Vector3;
  rotation?: THREE.Vector3;
  scale?: THREE.Vector3;
  pointsList?: unknown[];
  /** Pivot Transform's own pivot point — written directly by its dedicated viewport marker, not through computeGizmoWriteback (see Viewport.tsx). */
  pivot?: THREE.Vector3;
  /** Points Selection's picked indices — written directly by its viewport click/marquee handling, not through computeGizmoWriteback. */
  selectedIndices?: number[];
  /** Face Selection's picked face indices + the flip to interactive mode — written directly by its viewport click handling. */
  selectedFaces?: number[];
  interactive?: boolean;
  /** Points Influence's sparse index -> 0-1 map — written directly by its viewport brush/discrete handling, not through computeGizmoWriteback. */
  influences?: Record<number, number>;
  /** Points Influence's Discrete-mode armed level — written by its viewport HUD buttons. */
  activeLevel?: number;
  /** Visual Slice's plane point/normal — written directly by its dedicated viewport proxy, not through computeGizmoWriteback (see Viewport.tsx). */
  point?: THREE.Vector3;
  direction?: THREE.Vector3;
  /** Clip Box's box extents — written directly by its dedicated viewport proxy, which also drives `location`/`rotation` above (see Viewport.tsx). */
  size?: THREE.Vector3;
  /** Force Field position & axis — written directly by its dedicated viewport proxy (see Viewport.tsx). */
  position?: THREE.Vector3;
  axis?: THREE.Vector3;
  /** Particle Emitter velocity — written directly by its dedicated viewport proxy. */
  velocity?: THREE.Vector3;
  /**
   * Edit Mesh's live edits — a gizmo drag, or a modal tool's preview —
   * written through this history-free path so the whole gesture is the one
   * undo step recorded when it started (see onTransformStart).
   */
  meshData?: unknown;
  selectMode?: string;
  selectedPoints?: number[];
  selectedEdges?: [number, number][];
  /** Edit Mesh's proportional radius, resized with the mouse wheel mid-drag. */
  proportionalDiameter?: number;
}

export interface GizmoWritebackInput {
  target: GizmoTarget;
  mode: TransformGizmoMode;
  /** The dragged object's local pose, after TransformControls updated it. */
  object: Pick<THREE.Object3D, "matrix" | "position" | "quaternion" | "scale">;
  /**
   * For an "offset" target: what its own `matrix` input currently resolves
   * to. For a "native" target: what is wired into the *object's* matrix
   * input. Identity when nothing is wired, matching each node's own
   * evaluate-time fallback.
   */
  upstreamMatrix: THREE.Matrix4 | null;
  /** Socket ids with a wire into the node being written — those are read-only. */
  wiredSockets: ReadonlySet<string>;
  /** The object's own pivot offset, subtracted when solving for native location. */
  pivot?: THREE.Vector3;
}

/**
 * Turns a gizmo drag into the params to write back, for whichever node
 * actually owns the pose (see transformLookup.ts's GizmoTarget).
 *
 * Only the channel being dragged is written, and only if nothing is wired
 * into it. Writing all three every time was the cause of values changing on
 * their own the moment a handle was touched:
 *
 *  - a rotation round-trips through a quaternion, and Euler triples are not
 *    unique, so a hand-typed (0, 0, 180°) could come back as an equivalent
 *    but different-looking triple after a *translate* drag that never meant
 *    to touch rotation at all;
 *  - `decompose` cannot recover a negative scale (it normalises the sign
 *    away), so a mirrored object quietly lost its flip;
 *  - a channel fed by a wire ignores its param — the param is only the
 *    unconnected fallback — so writing it looked like the drag did nothing
 *    while silently overwriting the stored fallback with whatever the
 *    animation happened to be showing that frame.
 */
export function computeGizmoWriteback(input: GizmoWritebackInput): TransformPatch {
  const { target, mode, object, upstreamMatrix, wiredSockets, pivot } = input;
  const patch: TransformPatch = {};

  if (target.kind === "absolute") {
    // A plain Transform node's location/rotation/scale directly compose the
    // object's final matrix — the gizmo's own dragged world pose IS what
    // belongs in its params.
    assign(patch, mode, wiredSockets, object.position.clone(), object.quaternion, object.scale.clone());
    return patch;
  }

  // Both remaining kinds solve `final = base × delta` for whichever side the
  // node in question owns:
  //
  //  - "offset" (a Matrix Transform node): its params are the *delta* on top
  //    of whatever feeds its own matrix input, so writing the gizmo's
  //    absolute pose straight in would double-count that base. Solve
  //    `delta = base⁻¹ × final`.
  //  - "native" (the object's own location/rotation/scale): those are the
  //    *base*, and whatever's wired into its matrix input is the delta. The
  //    mirror image — solve `base = final × delta⁻¹`.
  const upstream = upstreamMatrix ?? new THREE.Matrix4();
  const solved =
    target.kind === "offset"
      ? upstream.clone().invert().multiply(object.matrix)
      : object.matrix.clone().multiply(upstream.clone().invert());

  const location = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  solved.decompose(location, quaternion, scale);

  if (target.kind === "native" && pivot) {
    location.sub(pivot);
  }

  assign(patch, mode, wiredSockets, location, quaternion, scale);
  return patch;
}

function assign(
  patch: TransformPatch,
  mode: TransformGizmoMode,
  wiredSockets: ReadonlySet<string>,
  location: THREE.Vector3,
  quaternion: THREE.Quaternion,
  scale: THREE.Vector3,
): void {
  if (mode === "translate" && !wiredSockets.has("location")) {
    patch.location = location;
  }
  if (mode === "rotate" && !wiredSockets.has("rotation")) {
    const euler = new THREE.Euler().setFromQuaternion(quaternion);
    patch.rotation = new THREE.Vector3(euler.x, euler.y, euler.z);
  }
  if (mode === "scale" && !wiredSockets.has("scale")) {
    patch.scale = scale;
  }
}
