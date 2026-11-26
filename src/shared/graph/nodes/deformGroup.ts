import * as THREE from "three";
import type { ParamFieldDef } from "../types";
import { polyMeshFromGeometry } from "../mesh/polyIO";
import { evaluateGroup } from "../mesh/groupExpr";
import { readAttribute } from "../mesh/polyAttributes";
import { quadMeshSignature } from "../quadMesh";
import { PointTree } from "../mesh/spatial";

/*
 * Group and Weight for the deformers that predate PolyMesh (Twist/Bend/Taper,
 * Wave/Ripple, Lattice Deform). They deform a copy of the source's vertex
 * buffer in place; this then pulls each vertex back toward where it started
 * by how far outside the group it is:
 *
 *   result = rest + (deformed - rest) × inGroup × weight
 *
 * `inGroup` comes from the Group expression on points, `weight` from a float
 * point attribute (Select Distance writes one, `weight`), so a soft selection
 * gives a soft deformation. Buffer vertices map to PolyMesh points through
 * polyVertexOf when the buffer is the source's own layout, and by nearest
 * rest position when the deformer re-cut it (Twist tessellates long edges).
 */

export const DEFORM_GROUP_FIELDS: ParamFieldDef[] = [
  { id: "group", label: "Group (points; empty = all)", kind: "text", group: "Group", help: "group", domain: "point" },
  { id: "weightAttribute", label: "Weight Attribute (float, points)", kind: "text", group: "Group" },
];

export const DEFORM_GROUP_DEFAULTS = { group: "", weightAttribute: "" };

interface Target {
  source: THREE.Mesh;
  output: THREE.Mesh;
  base: Float32Array;
}

const cache = new WeakMap<THREE.BufferGeometry, { key: string; weights: Float32Array | null }>();

/** Per output-buffer vertex factor in [0, 1], or null when no Group / Weight is set (deform everything fully). */
export function deformWeights(target: Target, params: Record<string, unknown>): Float32Array | null {
  return groupWeightsForBuffer(target.source.geometry, target.base, params, target.output.geometry);
}

/**
 * The same factors for any vertex buffer derived from `sourceGeom`: `rest`
 * holds that buffer's undeformed positions (3 per vertex). `cacheOn` keys the
 * cache (defaults to the source geometry).
 */
export function groupWeightsForBuffer(
  sourceGeom: THREE.BufferGeometry,
  rest: ArrayLike<number>,
  params: Record<string, unknown>,
  cacheOn: THREE.BufferGeometry = sourceGeom,
): Float32Array | null {
  const expr = String(params.group ?? "").trim();
  const weightName = String(params.weightAttribute ?? "").trim();
  if (!expr && !weightName) return null;
  const poly = polyMeshFromGeometry(sourceGeom);
  if (!poly) return null;
  const count = Math.floor(rest.length / 3);
  const key = `${quadMeshSignature(poly)}|${expr}|${weightName}|${count}`;
  const hit = cache.get(cacheOn);
  if (hit && hit.key === key) return hit.weights;
  const target = { base: rest };

  const mask = evaluateGroup(poly, "point", expr).mask;
  const w = weightName ? readAttribute(poly, "point", weightName) : null;
  const perPoint = new Float32Array(poly.positions.length);
  for (let v = 0; v < perPoint.length; v++) {
    perPoint[v] = mask[v] ? (w ? Math.max(0, Math.min(1, w.values[v * w.size])) : 1) : 0;
  }

  const vertexOf = sourceGeom.userData?.polyVertexOf as ArrayLike<number> | undefined;
  const weights = new Float32Array(count);
  if (vertexOf && vertexOf.length === count) {
    for (let i = 0; i < count; i++) weights[i] = perPoint[vertexOf[i]] ?? 0;
  } else {
    const tree = new PointTree(poly.positions);
    for (let i = 0; i < count; i++) {
      weights[i] = perPoint[tree.nearest(target.base[i * 3], target.base[i * 3 + 1], target.base[i * 3 + 2]).index] ?? 0;
    }
  }
  cache.set(cacheOn, { key, weights });
  return weights;
}

/** Blends a deformed target back toward its rest positions by the group weights. */
export function applyDeformGroup(target: Target, params: Record<string, unknown>): void {
  const weights = deformWeights(target, params);
  if (!weights) return;
  const pos = target.output.geometry.attributes.position as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  const base = target.base;
  if (arr.length !== base.length) return;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i];
    if (w >= 1) continue;
    for (let k = 0; k < 3; k++) {
      const j = i * 3 + k;
      arr[j] = base[j] + (arr[j] - base[j]) * w;
    }
  }
  pos.needsUpdate = true;
  target.output.geometry.computeVertexNormals();
  target.output.geometry.computeBoundingBox();
  target.output.geometry.computeBoundingSphere();
}
