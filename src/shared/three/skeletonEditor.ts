import {
  addJoint,
  childrenOf,
  mirrorJoints,
  readSkeleton,
  removeJoints,
  skeletonParams,
  subdivideBone,
} from "../graph/ik/skeletonEdit";

/**
 * What the Skeleton node's viewport palette and keys do, as plain functions:
 * the node's params and the picked joints in, the params to write and the new
 * selection out (null when the operation does not apply). The viewport only
 * carries the result to the graph, as one undo step.
 *
 * The last picked joint is the active one: a new joint hangs from it.
 */
export type SkeletonOp =
  | "add"
  | "subdivide"
  | "delete"
  | "mirror"
  | "selectChildren"
  | "selectParent"
  | "selectAll"
  | "mode";

export interface SkeletonOpResult {
  params?: Record<string, unknown>;
  selection: number[];
}

export function skeletonOp(op: SkeletonOp, params: Record<string, unknown>, picked: number[]): SkeletonOpResult | null {
  const data = readSkeleton(params);
  const n = data.points.length;
  const selection = picked.filter((i) => i >= 0 && i < n);
  const active = selection.length ? selection[selection.length - 1] : -1;

  // Selecting never changes the rig.
  if (op === "selectAll") return { selection: data.points.map((_, i) => i) };
  if (op === "selectChildren") {
    const kids = selection.flatMap((i) => childrenOf(data, i));
    return kids.length ? { selection: [...new Set(kids)] } : null;
  }
  if (op === "selectParent") {
    const parents = [...new Set(selection.map((i) => data.parents[i]).filter((p) => p >= 0))];
    return parents.length ? { selection: parents } : null;
  }

  if (op === "mode") {
    const editing = String(params.mode ?? "Edit") !== "Pose";
    if (editing) return { params: { mode: "Pose", restPoints: data.points.map((p) => p.clone()) }, selection };
    // Back to the rest pose: the joints return to where Edit mode left them.
    const stored = Array.isArray(params.restPoints) ? params.restPoints : [];
    return {
      params: { mode: "Edit", ...(stored.length === n ? { pointsList: readSkeleton({ pointsList: stored }).points } : {}), restPoints: [] },
      selection,
    };
  }

  // Changing the joints themselves is for Edit mode: in Pose mode the rest is fixed.
  if (String(params.mode ?? "Edit") === "Pose") return null;

  if (op === "add") {
    const parent = active >= 0 ? active : n - 1;
    const added = addJoint(data, parent);
    return { params: skeletonParams(added.data), selection: [added.index] };
  }
  if (op === "subdivide") {
    const split = subdivideBone(data, active);
    return split ? { params: skeletonParams(split.data), selection: [split.index] } : null;
  }
  if (op === "delete") {
    const removed = removeJoints(data, selection);
    if (!removed) return null;
    // Keep something picked: the joint that took the first deleted one's place, or the last.
    const next = Math.min(removed.data.points.length - 1, Math.max(0, Math.min(...selection)));
    return { params: skeletonParams(removed.data), selection: [next] };
  }
  if (op === "mirror") {
    const mirrored = mirrorJoints(data, selection, 0, 0);
    return mirrored ? { params: skeletonParams(mirrored.data), selection: mirrored.added } : null;
  }
  return null;
}
