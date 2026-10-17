import * as THREE from "three";
import { curveFromJSON } from "../curveClasses";
import type { ProfilePoint } from "../profileCurve";
import { createVariableThicknessTubeGeometry } from "../tubeGeometry";

/**
 * Curve to Mesh's tube sweep as a job. The curve travels as its own
 * `toJSON()` (the same object the node's signature is built from) and is
 * rebuilt on the other side by curveFromJSON, so the worker sweeps exactly
 * the curve the main thread holds: same control points, same arc-length
 * table, same output bit for bit.
 */
export interface CurveTubeJob {
  /** `curve.toJSON()`; canRebuildCurve(curve) must hold. */
  curve: unknown;
  tubularSegments: number;
  radialSegments: number;
  thickness: number;
  profile: ProfilePoint[];
  closed: boolean;
  startProgress: number;
  endProgress: number;
  caps: boolean;
}

/** An indexed geometry as flat arrays; all empty for a zero-length trim (no attributes at all). */
export interface TubeBuffers {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  index: Uint16Array | Uint32Array | null;
}

export function sweepCurveTube(job: CurveTubeJob): TubeBuffers {
  const geometry = createVariableThicknessTubeGeometry(
    curveFromJSON(job.curve),
    job.tubularSegments,
    job.radialSegments,
    job.thickness,
    job.profile,
    job.closed,
    job.startProgress,
    job.endProgress,
    job.caps,
  );
  const array = (name: string) => (geometry.getAttribute(name)?.array as Float32Array | undefined) ?? new Float32Array(0);
  const buffers: TubeBuffers = {
    position: array("position"),
    normal: array("normal"),
    uv: array("uv"),
    index: (geometry.index?.array as Uint16Array | Uint32Array | undefined) ?? null,
  };
  // Only the arrays live on; the geometry was never drawn.
  geometry.dispose();
  return buffers;
}

/** The geometry sweepCurveTube's buffers came from; takes ownership of the arrays. */
export function geometryFromTubeBuffers(buffers: TubeBuffers): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  if (buffers.position.length === 0) return geometry;
  geometry.setAttribute("position", new THREE.BufferAttribute(buffers.position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(buffers.normal, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(buffers.uv, 2));
  if (buffers.index) geometry.setIndex(new THREE.BufferAttribute(buffers.index, 1));
  return geometry;
}
