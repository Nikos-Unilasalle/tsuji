import type { PolyMesh } from "../quadMesh";
import { edgeKey } from "./attributes";
import {
  attrSize,
  domainEdges,
  type PolyAttribute,
  type PolyAttributes,
  type PolyEdgeAttribute,
} from "./polyAttributes";
import { PointTree } from "./spatial";

/**
 * Carries named attributes from the mesh an operation started from (`src`)
 * onto the mesh it produced (`out`).
 *
 * The operations in mesh/ and quadMesh.ts predate attributes and build their
 * results by hand; teaching every one of them to thread attribute arrays
 * through would touch every line that pushes a face. Instead an operation
 * either says where each output element came from (`maps`), or the
 * provenance is inferred:
 *
 *  - **points**: every operation here appends new vertices after the old ones
 *    and keeps the old indices (deletions compact, and say so with a map), so
 *    output vertex i < src count *is* source vertex i. A new vertex takes the
 *    value of the nearest source vertex — an extruded cap takes its base's,
 *    an edge midpoint one of its ends', which is what a group should do.
 *  - **faces**: output face i < src count whose vertices overlap source face
 *    i is that face; any other takes the face whose centroid is nearest
 *    (side walls of an extrusion land on the face they grew from or a
 *    neighbour — good enough for groups, exact for single faces).
 *  - **edges**: an edge keeps its value when both its vertices map to a
 *    source edge carrying one.
 *  - **corners**: through the face map, matching corners by source vertex.
 *
 * Attributes already present on `out` win: an operation that wrote its own
 * groups (extrude's `extrude_top`) keeps them.
 */
export interface PropagationMaps {
  /** For each output point, the source point it came from, or -1. */
  point?: ArrayLike<number>;
  /** For each output face, the source face it came from, or -1. */
  face?: ArrayLike<number>;
}

export function propagateAttributes(src: PolyMesh, out: PolyMesh, maps: PropagationMaps = {}): PolyMesh {
  const attrs = src.attributes;
  if (!attrs || (!attrs.point && !attrs.face && !attrs.corner && !attrs.edge)) return out;
  const hasAny = (r: Record<string, unknown> | undefined) => r && Object.keys(r).length > 0;
  if (!hasAny(attrs.point) && !hasAny(attrs.face) && !hasAny(attrs.corner) && !hasAny(attrs.edge)) return out;

  const pointMap = maps.point ?? inferPointMap(src, out);
  const needFaces = hasAny(attrs.face) || hasAny(attrs.corner);
  const faceMap = needFaces ? (maps.face ?? inferFaceMap(src, out, pointMap)) : null;

  const result: PolyAttributes = { ...(out.attributes ?? {}) };

  if (hasAny(attrs.point)) {
    const dst: Record<string, PolyAttribute> = { ...(result.point ?? {}) };
    for (const [name, attr] of Object.entries(attrs.point!)) {
      if (dst[name]) continue;
      dst[name] = remapFlat(attr, pointMap, out.positions.length);
    }
    result.point = dst;
  }

  if (faceMap && hasAny(attrs.face)) {
    const dst: Record<string, PolyAttribute> = { ...(result.face ?? {}) };
    for (const [name, attr] of Object.entries(attrs.face!)) {
      if (dst[name]) continue;
      dst[name] = remapFlat(attr, faceMap, out.faces.length);
    }
    result.face = dst;
  }

  if (faceMap && hasAny(attrs.corner)) {
    const srcCornerStart = cornerStarts(src);
    const dst: Record<string, PolyAttribute> = { ...(result.corner ?? {}) };
    for (const [name, attr] of Object.entries(attrs.corner!)) {
      if (dst[name]) continue;
      const size = attrSize(attr.type);
      const data: number[] = [];
      out.faces.forEach((face, f) => {
        const sf = faceMap[f];
        const sface = sf >= 0 ? src.faces[sf] : undefined;
        face.forEach((v) => {
          let sc = -1;
          if (sface) {
            const sv = pointMap[v];
            let k = sv >= 0 ? sface.indexOf(sv) : -1;
            if (k < 0 && sface.length > 0) k = 0;
            if (k >= 0) sc = srcCornerStart[sf] + k;
          }
          for (let c = 0; c < size; c++) data.push(sc >= 0 ? (attr.data[sc * size + c] ?? 0) : 0);
        });
      });
      dst[name] = { type: attr.type, data };
    }
    result.corner = dst;
  }

  if (hasAny(attrs.edge)) {
    const dst: Record<string, PolyEdgeAttribute> = { ...(result.edge ?? {}) };
    const outEdges = domainEdges(out);
    for (const [name, attr] of Object.entries(attrs.edge!)) {
      if (dst[name]) continue;
      const values: Record<string, number[]> = {};
      for (const [a, b] of outEdges) {
        const sa = pointMap[a];
        const sb = pointMap[b];
        if (sa < 0 || sb < 0 || sa === sb) continue;
        const v = attr.values[edgeKey(sa, sb)];
        if (v) values[edgeKey(a, b)] = [...v];
      }
      dst[name] = { type: attr.type, values };
    }
    result.edge = dst;
  }

  return { ...out, attributes: result };
}

function remapFlat(attr: PolyAttribute, map: ArrayLike<number>, count: number): PolyAttribute {
  const size = attrSize(attr.type);
  const data = new Array<number>(count * size).fill(0);
  for (let i = 0; i < count; i++) {
    const s = map[i];
    if (s === undefined || s < 0) continue;
    for (let c = 0; c < size; c++) data[i * size + c] = attr.data[s * size + c] ?? 0;
  }
  return { type: attr.type, data };
}

function cornerStarts(mesh: PolyMesh): Int32Array {
  const starts = new Int32Array(mesh.faces.length);
  let c = 0;
  mesh.faces.forEach((face, f) => {
    starts[f] = c;
    c += face.length;
  });
  return starts;
}

/** Output point → source point: kept index for i < src count, nearest source point otherwise. */
export function inferPointMap(src: PolyMesh, out: PolyMesh): Int32Array {
  const map = new Int32Array(out.positions.length);
  const n = src.positions.length;
  let tree: PointTree | null = null;
  for (let i = 0; i < out.positions.length; i++) {
    if (i < n) {
      map[i] = i;
      continue;
    }
    if (n === 0) {
      map[i] = -1;
      continue;
    }
    tree ??= new PointTree(src.positions);
    const p = out.positions[i];
    map[i] = tree.nearest(p[0], p[1], p[2]).index;
  }
  return map;
}

/** Output face → source face: same index when the vertices overlap, nearest centroid otherwise. */
export function inferFaceMap(src: PolyMesh, out: PolyMesh, pointMap: ArrayLike<number>): Int32Array {
  const map = new Int32Array(out.faces.length);
  if (src.faces.length === 0) return map.fill(-1);
  const centroid = (mesh: PolyMesh, face: readonly number[]): [number, number, number] => {
    let x = 0, y = 0, z = 0;
    for (const v of face) {
      const p = mesh.positions[v];
      x += p[0];
      y += p[1];
      z += p[2];
    }
    const k = face.length || 1;
    return [x / k, y / k, z / k];
  };
  let tree: PointTree | null = null;
  out.faces.forEach((face, f) => {
    if (f < src.faces.length) {
      const sface = src.faces[f];
      const set = new Set(sface);
      if (face.some((v) => set.has(pointMap[v]))) {
        map[f] = f;
        return;
      }
    }
    tree ??= new PointTree(src.faces.map((sf) => centroid(src, sf)));
    const c = centroid(out, face);
    map[f] = tree.nearest(c[0], c[1], c[2]).index;
  });
  return map;
}

/**
 * Runs `op` on `src` and propagates `src`'s attributes onto its result. The
 * one call a mesh-operation node needs.
 *
 * The op sees the mesh *without* its attributes: most operations clone their
 * input and append to it, and a cloned attribute array left at the old
 * length would otherwise pass for one the operation wrote itself. Whatever
 * attributes the op does return (groups it made) are kept as they are.
 */
export function withAttributes(
  src: PolyMesh,
  op: (mesh: PolyMesh) => PolyMesh | { mesh: PolyMesh; maps?: PropagationMaps },
  maps?: PropagationMaps,
): PolyMesh {
  const bare: PolyMesh = { ...src, attributes: undefined };
  const result = op(bare);
  if ("positions" in result) return propagateAttributes(src, result, maps);
  return propagateAttributes(src, result.mesh, result.maps ?? maps);
}
