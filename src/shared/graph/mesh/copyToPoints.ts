import type { PolyMesh, QuadMeshShading } from "../quadMesh";
import { edgeKey } from "./attributes";
import { attrSize, isBuiltinAttribute, readAttribute, setAttribute, type PolyAttribute, type PolyAttributes, type PolyEdgeAttribute } from "./polyAttributes";
import { propagateAttributes } from "./propagate";

/*
 * Copy to Points (phase 9): every chosen target point gets a transformed
 * copy of a source mesh (one of several variants), all merged into one
 * PolyMesh so downstream modelling nodes see a single editable mesh — not
 * instances.
 *
 * Attributes: the copies keep their source's (point, face, corner, edge),
 * gain `copy` (int, point and face: the target point index), and, when asked,
 * every stored point attribute of the target point they sit on (overriding a
 * source attribute of the same name, as in Houdini).
 */

export type Vec3 = [number, number, number];

/**
 * Several meshes as one, attributes unioned (an attribute missing from one
 * mesh reads as 0 there). Used to give every variant one shared index space.
 */
export function concatPolyMeshes(meshes: PolyMesh[]): PolyMesh {
  if (meshes.length === 1) return meshes[0];
  const positions: Vec3[] = [];
  const faces: number[][] = [];
  const anyUV = meshes.some((m) => m.faceUVs);
  const anyColor = meshes.some((m) => m.faceColors);
  const anyMat = meshes.some((m) => m.faceMaterials);
  const anyShading = meshes.some((m) => m.faceShading);
  const faceUVs: [number, number][][] = [];
  const faceColors: ([number, number, number][] | null)[] = [];
  const faceMaterials: number[] = [];
  const faceShading: QuadMeshShading[] = [];
  const sharp: [number, number][] = [];
  const seam: [number, number][] = [];
  const creases: [number, number, number][] = [];
  const loose: [number, number][] = [];
  const pointStart: number[] = [];
  const faceStart: number[] = [];
  const cornerStart: number[] = [];
  let corners = 0;
  for (const m of meshes) {
    const off = positions.length;
    pointStart.push(off);
    faceStart.push(faces.length);
    cornerStart.push(corners);
    for (const p of m.positions) positions.push([p[0], p[1], p[2]]);
    m.faces.forEach((f, fi) => {
      faces.push(f.map((v) => v + off));
      corners += f.length;
      if (anyUV) faceUVs.push(m.faceUVs?.[fi]?.map((uv) => [uv[0], uv[1]] as [number, number]) ?? f.map(() => [0, 0] as [number, number]));
      if (anyColor) faceColors.push(m.faceColors?.[fi] ?? null);
      if (anyMat) faceMaterials.push(m.faceMaterials?.[fi] ?? 0);
      if (anyShading) faceShading.push(m.faceShading?.[fi] ?? m.shading ?? "auto");
    });
    for (const [a, b] of m.sharpEdges ?? []) sharp.push([a + off, b + off]);
    for (const [a, b] of m.seamEdges ?? []) seam.push([a + off, b + off]);
    for (const [a, b, w] of m.edgeCreases ?? []) creases.push([a + off, b + off, w]);
    for (const [a, b] of m.edges ?? []) loose.push([a + off, b + off]);
  }
  const out: PolyMesh = { positions, faces };
  if (anyUV) out.faceUVs = faceUVs;
  if (anyColor) out.faceColors = faceColors;
  if (anyMat) out.faceMaterials = faceMaterials;
  if (anyShading) out.faceShading = faceShading;
  if (meshes[0].shading) out.shading = meshes[0].shading;
  if (sharp.length) out.sharpEdges = sharp;
  if (seam.length) out.seamEdges = seam;
  if (creases.length) out.edgeCreases = creases;
  if (loose.length) out.edges = loose;

  const attributes: PolyAttributes = {};
  const starts = { point: pointStart, face: faceStart, corner: cornerStart };
  const totals = { point: positions.length, face: faces.length, corner: corners };
  for (const domain of ["point", "face", "corner"] as const) {
    const names = new Map<string, PolyAttribute["type"]>();
    for (const m of meshes) for (const [name, a] of Object.entries(m.attributes?.[domain] ?? {})) if (!names.has(name)) names.set(name, a.type);
    if (!names.size) continue;
    const dst: Record<string, PolyAttribute> = {};
    for (const [name, type] of names) {
      const size = attrSize(type);
      const data = new Array<number>(totals[domain] * size).fill(0);
      meshes.forEach((m, mi) => {
        const a = m.attributes?.[domain]?.[name];
        if (!a || attrSize(a.type) !== size) return;
        const base = starts[domain][mi] * size;
        const count = (domain === "point" ? m.positions.length : domain === "face" ? m.faces.length : m.faces.reduce((s, f) => s + f.length, 0)) * size;
        for (let i = 0; i < count; i++) data[base + i] = a.data[i] ?? 0;
      });
      dst[name] = { type, data };
    }
    attributes[domain] = dst;
  }
  const edgeNames = new Map<string, PolyEdgeAttribute["type"]>();
  for (const m of meshes) for (const [name, a] of Object.entries(m.attributes?.edge ?? {})) if (!edgeNames.has(name)) edgeNames.set(name, a.type);
  if (edgeNames.size) {
    const dst: Record<string, PolyEdgeAttribute> = {};
    for (const [name, type] of edgeNames) {
      const values: Record<string, number[]> = {};
      meshes.forEach((m, mi) => {
        const a = m.attributes?.edge?.[name];
        if (!a) return;
        for (const [k, v] of Object.entries(a.values)) {
          const [x, y] = k.split("_").map(Number);
          if (Number.isInteger(x) && Number.isInteger(y)) values[edgeKey(x + pointStart[mi], y + pointStart[mi])] = [...v];
        }
      });
      dst[name] = { type, values };
    }
    attributes.edge = dst;
  }
  if (Object.keys(attributes).length) out.attributes = attributes;
  return out;
}

export interface CopyPlacement {
  /** Target point index (written to `copy`). */
  point: number;
  /** Which source variant. */
  variant: number;
  /** Column-major 4×4 (THREE.Matrix4.elements) from source space to output space. */
  matrix: ArrayLike<number>;
}

export function copyToPoints(
  sources: PolyMesh[],
  target: PolyMesh,
  placements: CopyPlacement[],
  opts: { copyTargetAttributes?: boolean } = {},
): PolyMesh {
  const combined = concatPolyMeshes(sources);
  const vStart: number[] = [];
  const fStart: number[] = [];
  let v = 0, f = 0;
  for (const s of sources) {
    vStart.push(v);
    fStart.push(f);
    v += s.positions.length;
    f += s.faces.length;
  }
  const positions: Vec3[] = [];
  const faces: number[][] = [];
  const pointMap: number[] = [];
  const faceMap: number[] = [];
  const copyPoint: number[] = [];
  const copyFace: number[] = [];
  const pointOfCopy: number[] = [];
  const hasUV = Boolean(combined.faceUVs);
  const hasColor = Boolean(combined.faceColors);
  const faceUVs: [number, number][][] = [];
  const faceColors: ([number, number, number][] | null)[] = [];
  const faceMaterials: number[] = [];
  const faceShading: QuadMeshShading[] = [];
  const sharp: [number, number][] = [];
  const seam: [number, number][] = [];
  const creases: [number, number, number][] = [];
  const loose: [number, number][] = [];

  for (const pl of placements) {
    const vi = Math.max(0, Math.min(sources.length - 1, pl.variant | 0));
    const src = sources[vi];
    const e = pl.matrix;
    // A mirroring transform turns faces inside out: reverse their winding back.
    const det =
      e[0] * (e[5] * e[10] - e[9] * e[6]) - e[4] * (e[1] * e[10] - e[9] * e[2]) + e[8] * (e[1] * e[6] - e[5] * e[2]);
    const flip = det < 0;
    const off = positions.length;
    for (let i = 0; i < src.positions.length; i++) {
      const p = src.positions[i];
      const x = e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12];
      const y = e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + e[13];
      const z = e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14];
      positions.push(Number.isFinite(x + y + z) ? [x, y, z] : [p[0], p[1], p[2]]);
      pointMap.push(vStart[vi] + i);
      copyPoint.push(pl.point);
      pointOfCopy.push(pl.point);
    }
    src.faces.forEach((face, fi) => {
      const cf = fStart[vi] + fi;
      const order = flip ? face.map((_, k) => (face.length - k) % face.length) : face.map((_, k) => k);
      faces.push(order.map((k) => face[k] + off));
      faceMap.push(cf);
      copyFace.push(pl.point);
      if (hasUV) faceUVs.push(order.map((k) => [...combined.faceUVs![cf][k]] as [number, number]));
      if (hasColor) {
        const c = combined.faceColors![cf];
        faceColors.push(c ? order.map((k) => [...c[k]] as [number, number, number]) : null);
      }
      if (combined.faceMaterials) faceMaterials.push(combined.faceMaterials[cf] ?? 0);
      if (combined.faceShading) faceShading.push(combined.faceShading[cf]);
    });
    for (const [a, b] of src.sharpEdges ?? []) sharp.push([a + off, b + off]);
    for (const [a, b] of src.seamEdges ?? []) seam.push([a + off, b + off]);
    for (const [a, b, w] of src.edgeCreases ?? []) creases.push([a + off, b + off, w]);
    for (const [a, b] of src.edges ?? []) loose.push([a + off, b + off]);
  }

  let out: PolyMesh = { positions, faces };
  if (hasUV) out.faceUVs = faceUVs;
  if (hasColor) out.faceColors = faceColors;
  if (combined.faceMaterials) out.faceMaterials = faceMaterials;
  if (combined.faceShading) out.faceShading = faceShading;
  if (combined.shading) out.shading = combined.shading;
  if (sharp.length) out.sharpEdges = sharp;
  if (seam.length) out.seamEdges = seam;
  if (creases.length) out.edgeCreases = creases;
  if (loose.length) out.edges = loose;
  // Corners are matched through the point map, so reversed faces still pick
  // up the right per-corner values.
  out = propagateAttributes(combined, out, { point: pointMap, face: faceMap });

  if (opts.copyTargetAttributes) {
    for (const [name, attr] of Object.entries(target.attributes?.point ?? {})) {
      if (name === "copy" || isBuiltinAttribute("point", name)) continue;
      const read = readAttribute(target, "point", name);
      if (!read) continue;
      const size = read.size;
      const data = new Float64Array(positions.length * size);
      for (let i = 0; i < positions.length; i++) for (let k = 0; k < size; k++) data[i * size + k] = read.values[pointOfCopy[i] * size + k] ?? 0;
      out = setAttribute(out, "point", name, attr.type, data);
    }
  }
  out = setAttribute(out, "point", "copy", "int", copyPoint);
  out = setAttribute(out, "face", "copy", "int", copyFace);
  return out;
}
