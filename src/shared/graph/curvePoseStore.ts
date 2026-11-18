import * as THREE from "three";

/**
 * The native pose (location/rotation/scale + wired matrix) that a curve node
 * applied last, keyed by node id. Curve consumers that build *geometry* from a
 * curve (Curve to Mesh) need to know where the gizmo put the curve, but the
 * curve value itself is just a path in local space — so the curve node writes
 * its pose here and the consumer composes it into its own matrix, keeping the
 * built geometry local (a spawned copy then sits on its support instead of
 * being pushed off it by a baked-in world offset).
 */
const poses = new Map<string, THREE.Matrix4>();

export function setCurveNodePose(nodeId: string, matrix: THREE.Matrix4): void {
  poses.set(nodeId, matrix.clone());
}

export function getCurveNodePose(nodeId: string): THREE.Matrix4 | undefined {
  return poses.get(nodeId);
}

/**
 * The points wired into a Curve from Points' Points input (before its
 * `pointOffsets`), keyed by node id, or none when the input is free: the
 * viewport draws and drags that node's handles from these.
 */
const inputPoints = new Map<string, THREE.Vector3[]>();

export function setCurveInputPoints(nodeId: string, points: THREE.Vector3[] | null): void {
  if (points) inputPoints.set(nodeId, points.map((p) => p.clone()));
  else inputPoints.delete(nodeId);
}

export function getCurveInputPoints(nodeId: string): THREE.Vector3[] | undefined {
  return inputPoints.get(nodeId);
}
