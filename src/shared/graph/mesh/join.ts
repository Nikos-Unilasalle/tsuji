import type { PolyMesh } from "../quadMesh";
import { edgeKey } from "./attributes";
import { attrSize, domainSize, type AttrType, type PolyAttributes } from "./polyAttributes";

/**
 * Several PolyMeshes as one (Houdini Merge / Blender Join Geometry): vertices
 * and faces appended in order, every per-face and per-edge property carried,
 * and the attributes united — a mesh lacking an attribute another one has
 * gets zeros there, so a group made on one input is "not in the group" on
 * the others rather than lost.
 *
 * An int face attribute `piece_source` isn't written; callers that want to
 * know which input a face came from use `inputIndex` (`joinMeshes(…, name)`).
 */
export function joinMeshes(meshes: PolyMesh[], sourceAttribute?: string): PolyMesh {
  const list = meshes.filter((m) => m && m.positions);
  if (list.length === 0) return { positions: [], faces: [] };
  if (list.length === 1 && !sourceAttribute) return list[0];

  const out: PolyMesh = { positions: [], faces: [], shading: list[0].shading };
  const anyFaceUVs = list.some((m) => m.faceUVs);
  const anyMaterials = list.some((m) => m.faceMaterials);
  const anyColors = list.some((m) => m.faceColors);
  const anyShading = list.some((m) => m.faceShading && m.faceShading.length > 0);
  if (anyFaceUVs) out.faceUVs = [];
  if (anyMaterials) out.faceMaterials = [];
  if (anyColors) out.faceColors = [];
  if (anyShading) out.faceShading = [];

  // Attribute schema: union of names per domain (first type wins).
  const schema: Record<"point" | "face" | "corner" | "edge", Map<string, AttrType>> = {
    point: new Map(),
    face: new Map(),
    corner: new Map(),
    edge: new Map(),
  };
  for (const m of list) {
    for (const d of ["point", "face", "corner", "edge"] as const) {
      const src = m.attributes?.[d] as Record<string, { type: AttrType }> | undefined;
      if (src) for (const [n, a] of Object.entries(src)) if (!schema[d].has(n)) schema[d].set(n, a.type);
    }
  }
  const attrs: PolyAttributes = {};
  for (const d of ["point", "face", "corner"] as const) {
    if (schema[d].size === 0) continue;
    attrs[d] = {};
    for (const [n, type] of schema[d]) attrs[d]![n] = { type, data: [] };
  }
  if (schema.edge.size) {
    attrs.edge = {};
    for (const [n, type] of schema.edge) attrs.edge[n] = { type, values: {} };
  }
  const sourceIds: number[] = [];

  list.forEach((m, mi) => {
    const base = out.positions.length;
    for (const p of m.positions) out.positions.push([p[0], p[1], p[2]]);
    m.faces.forEach((face, f) => {
      out.faces.push(face.map((v) => v + base));
      if (out.faceUVs) out.faceUVs.push((m.faceUVs?.[f] ?? face.map(() => [0, 0])).map((uv) => [uv[0], uv[1]] as [number, number]));
      if (out.faceMaterials) out.faceMaterials.push(m.faceMaterials?.[f] ?? 0);
      if (out.faceColors) out.faceColors.push(m.faceColors?.[f] ?? null);
      if (out.faceShading) out.faceShading.push(m.faceShading?.[f] ?? m.shading ?? "auto");
      sourceIds.push(mi);
    });
    const shift = (pairs: [number, number][] | undefined) => pairs?.map(([a, b]) => [a + base, b + base] as [number, number]);
    for (const key of ["edges", "sharpEdges", "seamEdges"] as const) {
      const moved = shift(m[key]);
      if (moved && moved.length) out[key] = [...(out[key] ?? []), ...moved];
    }
    if (m.edgeCreases?.length) out.edgeCreases = [...(out.edgeCreases ?? []), ...m.edgeCreases.map(([a, b, w]) => [a + base, b + base, w] as [number, number, number])];

    for (const d of ["point", "face", "corner"] as const) {
      if (!attrs[d]) continue;
      const count = domainSize(m, d);
      for (const [n, type] of schema[d]) {
        const size = attrSize(type);
        const src = m.attributes?.[d]?.[n];
        const target = attrs[d]![n].data;
        for (let i = 0; i < count * size; i++) target.push(src && src.type === type ? (src.data[i] ?? 0) : 0);
      }
    }
    if (attrs.edge) {
      for (const [n] of schema.edge) {
        const src = m.attributes?.edge?.[n];
        if (!src) continue;
        for (const [key, value] of Object.entries(src.values)) {
          const [a, b] = key.split("_").map(Number);
          attrs.edge[n].values[edgeKey(a + base, b + base)] = [...value];
        }
      }
    }
  });

  if (sourceAttribute) {
    attrs.face = { ...(attrs.face ?? {}), [sourceAttribute]: { type: "int", data: sourceIds } };
  }
  if (Object.keys(attrs).length) out.attributes = attrs;
  return out;
}
