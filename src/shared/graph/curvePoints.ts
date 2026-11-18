import * as THREE from "three";
import { asVector3 } from "./nodes/transform";

/**
 * Editing operations on a curve node's `pointsList` param, used by the
 * viewport's control-point handles (see curveHandles.ts). Both return a new
 * array — params are never mutated in place, the graph is replaced.
 *
 * The stored list may hold real Vector3s or the plain `{x, y, z}` objects a
 * saved .ovm file (or the IPC bridge to the output window) hands back, so
 * everything goes through asVector3 on the way in and comes out as Vector3.
 */

/** Below this a curve has no shape left to draw — every curve type needs a start and an end. */
export const MIN_CURVE_POINTS = 2;

/** Where a new point lands past the end of the list: the last segment, continued. */
const EXTEND_FACTOR = 1;

export function toPointVectors(rawPoints: unknown): THREE.Vector3[] {
  if (!Array.isArray(rawPoints)) return [];
  return rawPoints.map((p) => asVector3(p, new THREE.Vector3()).clone());
}

/**
 * A new point after `index`: halfway to the next one, or — past the last —
 * one more step in the direction the curve was already heading, so adding to
 * the end of a path extends it instead of stacking points on the tip.
 */
export function insertCurvePointAfter(rawPoints: unknown, index: number): THREE.Vector3[] | null {
  const points = toPointVectors(rawPoints);
  if (index < 0 || index >= points.length) return null;

  const current = points[index];
  const next = points[index + 1];

  let inserted: THREE.Vector3;
  if (next) {
    inserted = current.clone().lerp(next, 0.5);
  } else {
    const previous = points[index - 1] ?? current;
    const direction = current.clone().sub(previous);
    if (direction.lengthSq() < 1e-12) direction.set(EXTEND_FACTOR, 0, 0);
    inserted = current.clone().add(direction.multiplyScalar(EXTEND_FACTOR));
  }

  return [...points.slice(0, index + 1), inserted, ...points.slice(index + 1)];
}

/** The list without `index`, or null when removing it would leave too few points to make a curve. */
export function removeCurvePoint(rawPoints: unknown, index: number): THREE.Vector3[] | null {
  const points = toPointVectors(rawPoints);
  if (index < 0 || index >= points.length) return null;
  if (points.length <= MIN_CURVE_POINTS) return null;
  return points.filter((_, idx) => idx !== index);
}

/**
 * Curve from Points with its Points input wired: the handles edit offsets
 * on top of the incoming points (`pointOffsets`, one per point, missing ones
 * zero) rather than `pointsList`, so whatever feeds the input — a Curve
 * Primitive whose radius changes, say — still drives the curve.
 */
export function offsetCurvePoints(base: THREE.Vector3[], rawOffsets: unknown): THREE.Vector3[] {
  const offsets = toPointVectors(rawOffsets);
  return base.map((p, i) => (offsets[i] ? p.clone().add(offsets[i]) : p.clone()));
}

/** The offsets that put each moved point where it was dropped, the others kept. */
export function offsetsForMovedPoints(
  base: THREE.Vector3[],
  rawOffsets: unknown,
  moves: Map<number, THREE.Vector3>,
): THREE.Vector3[] {
  const offsets = toPointVectors(rawOffsets);
  return base.map((p, i) => {
    const moved = moves.get(i);
    if (moved) return moved.clone().sub(p);
    return offsets[i] ?? new THREE.Vector3();
  });
}
