import * as THREE from "three";
import type { QuadMesh } from "../quadMesh";

/** Adjacent triangles bent further apart than this stay triangles. */
const MAX_FACE_ANGLE_DEG = 40;
/** A merged quad whose corners stray further than this from square, on average, isn't made. */
const MAX_SHAPE_ERROR_DEG = 40;
/** Welding tolerance, relative to the bounding-box diagonal. */
const WELD_RELATIVE = 1e-6;

type V3 = [number, number, number];

/**
 * Rebuilds an editable QuadMesh from a triangulated BufferGeometry.
 *
 * - **Welding** by distance relative to the object's size (a fixed 1e-4 used
 *   to merge real detail on small objects and miss seams on large ones).
 *   Only positions are welded: per-corner UVs are kept, so UV seams survive.
 * - **Quads** rebuilt the way Blender's Tris to Quads does: every pair of
 *   triangles sharing an edge is scored — how far the two bend apart plus
 *   how far the merged quad's corners are from square — and pairs are taken
 *   best first. Before, pairs were taken in whatever order a Map yielded them
 *   and only if nearly coplanar, so a sphere came in as triangles and grids
 *   came in with diagonals zig-zagging across quads. Pairs are refused across
 *   a UV seam, across a material change, when the quad would be concave, and
 *   when the two triangles disagree on winding.
 * - **Materials**: the geometry's groups become per-face material slots.
 */
export function importBufferGeometry(geometry: THREE.BufferGeometry): QuadMesh | null {
  const posAttr = geometry.attributes.position;
  if (!posAttr) return null;
  const uvAttr = geometry.attributes.uv;
  const index = geometry.index;

  // --- Weld positions ---------------------------------------------------
  geometry.computeBoundingBox();
  const diag = geometry.boundingBox ? geometry.boundingBox.getSize(new THREE.Vector3()).length() : 1;
  const cell = Math.max(diag * WELD_RELATIVE, 1e-12);
  const cellOf = new Map<string, number>();
  const positions: V3[] = [];
  const remap = new Int32Array(posAttr.count);
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
    const key = `${Math.round(x / cell)},${Math.round(y / cell)},${Math.round(z / cell)}`;
    let v = cellOf.get(key);
    if (v === undefined) {
      v = positions.length;
      positions.push([x, y, z]);
      cellOf.set(key, v);
    }
    remap[i] = v;
  }

  // --- Triangles --------------------------------------------------------
  const groups = [...geometry.groups].sort((a, b) => a.start - b.start);
  const materialAt = (element: number): number => {
    for (const g of groups) if (element >= g.start && element < g.start + g.count) return g.materialIndex ?? 0;
    return 0;
  };
  const distinctMaterials = new Set(groups.map((g) => g.materialIndex ?? 0));
  const useMaterials = distinctMaterials.size > 1;

  const triCount = Math.floor((index ? index.count : posAttr.count) / 3);
  const tris: V3[] = [];
  const triUVs: [number, number][][] = [];
  const triMaterial: number[] = [];
  const minArea2 = (diag * 1e-9) ** 2;
  for (let t = 0; t < triCount; t++) {
    const e = [t * 3, t * 3 + 1, t * 3 + 2];
    const raw = e.map((k) => (index ? index.getX(k) : k));
    const [a, b, c] = raw.map((r) => remap[r]);
    if (a === b || b === c || c === a) continue;
    if (cross2(positions[a], positions[b], positions[c]) <= minArea2) continue;
    tris.push([a, b, c]);
    triUVs.push(uvAttr ? raw.map((r) => [uvAttr.getX(r), uvAttr.getY(r)] as [number, number]) : []);
    triMaterial.push(useMaterials ? materialAt(t * 3) : 0);
  }

  // --- Candidate pairs ----------------------------------------------------
  const edgeTris = new Map<string, number[]>();
  tris.forEach((tri, t) => {
    for (let i = 0; i < 3; i++) {
      const u = tri[i], v = tri[(i + 1) % 3];
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      const list = edgeTris.get(key);
      if (list) list.push(t);
      else edgeTris.set(key, [t]);
    }
  });

  const maxAngle = (MAX_FACE_ANGLE_DEG * Math.PI) / 180;
  const candidates: { t0: number; t1: number; quad: number[]; uvs: [number, number][]; error: number }[] = [];
  for (const [key, list] of edgeTris) {
    if (list.length !== 2) continue;
    const [t0, t1] = list;
    if (triMaterial[t0] !== triMaterial[t1]) continue;
    const [su, sv] = key.split("_").map(Number);
    const tri0 = tris[t0], tri1 = tris[t1];
    // Orient the shared edge as tri0 runs it: u → v. tri1 must run v → u.
    const i0 = tri0.indexOf(su);
    const [u, v] = tri0[(i0 + 1) % 3] === sv ? [su, sv] : [sv, su];
    const j = tri1.indexOf(v);
    if (tri1[(j + 1) % 3] !== u) continue;

    const other0 = tri0.find((x) => x !== u && x !== v)!;
    const other1 = tri1.find((x) => x !== u && x !== v)!;

    if (uvAttr) {
      const uv0 = (vIdx: number) => triUVs[t0][tri0.indexOf(vIdx)];
      const uv1 = (vIdx: number) => triUVs[t1][tri1.indexOf(vIdx)];
      if (!sameUV(uv0(u), uv1(u)) || !sameUV(uv0(v), uv1(v))) continue; // UV seam
    }

    const n0 = normalOf(positions[tri0[0]], positions[tri0[1]], positions[tri0[2]]);
    const n1 = normalOf(positions[tri1[0]], positions[tri1[1]], positions[tri1[2]]);
    const bend = Math.acos(Math.max(-1, Math.min(1, dot(n0, n1))));
    if (bend > maxAngle) continue;

    const quad = [other0, u, other1, v];
    const shape = quadShapeError(quad.map((q) => positions[q]), normalize(add(n0, n1)));
    if (shape === null || shape > MAX_SHAPE_ERROR_DEG) continue;

    const uvs = uvAttr
      ? quad.map((q) => (tri0.includes(q) ? triUVs[t0][tri0.indexOf(q)] : triUVs[t1][tri1.indexOf(q)]))
      : [];
    candidates.push({ t0, t1, quad, uvs, error: (bend * 180) / Math.PI + shape });
  }
  candidates.sort((a, b) => a.error - b.error);

  // --- Greedy pairing, best first ---------------------------------------------
  const faceAt = new Map<number, { face: number[]; uvs: [number, number][]; material: number }>();
  const paired = new Uint8Array(tris.length);
  for (const c of candidates) {
    if (paired[c.t0] || paired[c.t1]) continue;
    paired[c.t0] = paired[c.t1] = 1;
    faceAt.set(Math.min(c.t0, c.t1), { face: c.quad, uvs: c.uvs, material: triMaterial[c.t0] });
  }
  for (let t = 0; t < tris.length; t++) {
    if (!paired[t]) faceAt.set(t, { face: [...tris[t]], uvs: triUVs[t], material: triMaterial[t] });
  }

  // Faces in source order (a quad sits where its first triangle was), so the
  // same geometry always yields the same face indices.
  const order = [...faceAt.keys()].sort((a, b) => a - b);
  const result: QuadMesh = {
    positions,
    faces: order.map((t) => faceAt.get(t)!.face),
  };
  if (uvAttr) result.faceUVs = order.map((t) => faceAt.get(t)!.uvs);
  if (useMaterials) result.faceMaterials = order.map((t) => faceAt.get(t)!.material);
  return result;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a: V3): V3 => {
  const l = length(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
};
const normalOf = (a: V3, b: V3, c: V3) => normalize(cross(sub(b, a), sub(c, a)));
const cross2 = (a: V3, b: V3, c: V3) => {
  const n = cross(sub(b, a), sub(c, a));
  return dot(n, n);
};
const sameUV = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;

/**
 * Mean deviation of the quad's corner angles from 90°, in degrees, or null
 * when the quad is concave (a corner turning against the face normal).
 */
function quadShapeError(p: V3[], normal: V3): number | null {
  let error = 0;
  for (let i = 0; i < 4; i++) {
    const prev = sub(p[(i + 3) % 4], p[i]);
    const next = sub(p[(i + 1) % 4], p[i]);
    if (dot(cross(next, prev), normal) <= 0) return null;
    const cos = dot(prev, next) / (length(prev) * length(next) || 1);
    error += Math.abs((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI - 90);
  }
  return error / 4;
}
