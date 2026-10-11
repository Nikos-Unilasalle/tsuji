import * as THREE from "three";
import { VoronoiCell, Vec3 } from "./voronoi";

/**
 * Whether every edge of the mesh is shared by exactly two triangles — the
 * condition CSG needs to tell inside from outside. Vertices are matched by
 * position, so UV seams and split normals do not count as holes; collapsed
 * triangles (a UV sphere's poles) are ignored.
 *
 * A tube without end caps, a plane, or a pile of overlapping open sheets all
 * fail this, and CSG on them leaves stray cut faces floating in empty space.
 */
export function isWatertight(geometry: THREE.BufferGeometry): boolean {
  const pos = geometry.getAttribute("position");
  if (!pos) return false;
  const index = geometry.getIndex();
  const triCount = (index ? index.count : pos.count) / 3;
  if (triCount < 4) return false;

  const ids = new Map<string, number>();
  const idOf = (i: number): number => {
    const key = `${Math.round(pos.getX(i) * 1e5)},${Math.round(pos.getY(i) * 1e5)},${Math.round(pos.getZ(i) * 1e5)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    return id;
  };

  const edges = new Map<number, number>();
  const base = 1 << 24;
  for (let t = 0; t < triCount; t++) {
    const v = [0, 1, 2].map((k) => idOf(index ? index.getX(t * 3 + k) : t * 3 + k));
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
    for (let k = 0; k < 3; k++) {
      const a = v[k];
      const b = v[(k + 1) % 3];
      const key = a < b ? a * base + b : b * base + a;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  if (edges.size === 0) return false;
  for (const count of edges.values()) if (count !== 2) return false;
  return true;
}

interface Plane {
  nx: number;
  ny: number;
  nz: number;
  d: number;
}

/** The half-spaces a convex cell is the intersection of, one per face (n · x <= d). */
function cellPlanes(cell: VoronoiCell): Plane[] {
  const planes: Plane[] = [];
  for (const face of cell.faces) {
    // Newell's method: robust for any convex polygon, whatever its first three vertices do.
    let nx = 0, ny = 0, nz = 0;
    const vs = face.verts;
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i];
      const b = vs[(i + 1) % vs.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    nx /= len;
    ny /= len;
    nz /= len;
    planes.push({ nx, ny, nz, d: nx * vs[0][0] + ny * vs[0][1] + nz * vs[0][2] });
  }
  return planes;
}

/** position(3) + normal(3) + uv(2) */
const STRIDE = 8;

function clipPolygon(poly: number[][], plane: Plane): number[][] {
  const out: number[][] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const sa = plane.nx * a[0] + plane.ny * a[1] + plane.nz * a[2] - plane.d;
    const sb = plane.nx * b[0] + plane.ny * b[1] + plane.nz * b[2] - plane.d;
    if (sa <= 0) out.push(a);
    if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) {
      const t = sa / (sa - sb);
      const v = new Array<number>(STRIDE);
      for (let k = 0; k < STRIDE; k++) v[k] = a[k] + (b[k] - a[k]) * t;
      out.push(v);
    }
  }
  return out;
}

/**
 * The part of a mesh's *surface* inside a convex cell — each triangle clipped
 * against the cell's planes. No inside/outside test is needed, so it works on
 * any mesh: open, self-intersecting, a thin shell. The price is that nothing
 * closes the cut: the pieces are hollow skins, with no inside faces.
 *
 * Triangles keep their material group. Returns null when the cell holds none.
 */
export function clipSurfaceToCell(source: THREE.BufferGeometry, cell: VoronoiCell): THREE.BufferGeometry | null {
  const planes = cellPlanes(cell);
  if (planes.length < 4) return null;

  const pos = source.getAttribute("position");
  const nrm = source.getAttribute("normal");
  const uv = source.getAttribute("uv");
  const index = source.getIndex();
  const triCount = (index ? index.count : pos.count) / 3;

  // Cell bounds: skips the (vast majority of) triangles that cannot touch it.
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const f of cell.faces) {
    for (const p of f.verts) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[2] < minZ) minZ = p[2];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
      if (p[2] > maxZ) maxZ = p[2];
    }
  }

  const groups = source.groups.length > 0 ? source.groups : [{ start: 0, count: triCount * 3, materialIndex: 0 }];
  const perMaterial = new Map<number, number[]>();

  const vertex = (i: number): number[] => [
    pos.getX(i), pos.getY(i), pos.getZ(i),
    nrm ? nrm.getX(i) : 0, nrm ? nrm.getY(i) : 1, nrm ? nrm.getZ(i) : 0,
    uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0,
  ];

  for (const group of groups) {
    const first = group.start / 3;
    const last = Math.min(triCount, (group.start + group.count) / 3);
    for (let t = first; t < last; t++) {
      const ids = [0, 1, 2].map((k) => (index ? index.getX(t * 3 + k) : t * 3 + k));
      const tri = ids.map(vertex);
      const [a, b, c] = tri;
      if (
        Math.max(a[0], b[0], c[0]) < minX || Math.min(a[0], b[0], c[0]) > maxX ||
        Math.max(a[1], b[1], c[1]) < minY || Math.min(a[1], b[1], c[1]) > maxY ||
        Math.max(a[2], b[2], c[2]) < minZ || Math.min(a[2], b[2], c[2]) > maxZ
      ) continue;

      let poly: number[][] = tri;
      for (const plane of planes) {
        poly = clipPolygon(poly, plane);
        if (poly.length < 3) break;
      }
      if (poly.length < 3) continue;

      let out = perMaterial.get(group.materialIndex ?? 0);
      if (!out) perMaterial.set(group.materialIndex ?? 0, (out = []));
      for (let i = 1; i < poly.length - 1; i++) out.push(...poly[0], ...poly[i], ...poly[i + 1]);
    }
  }

  const materialIndices = [...perMaterial.keys()].sort((x, y) => x - y);
  const total = materialIndices.reduce((s, m) => s + perMaterial.get(m)!.length / STRIDE, 0);
  if (total < 3) return null;

  const p = new Float32Array(total * 3);
  const n = new Float32Array(total * 3);
  const u = new Float32Array(total * 2);
  const geometry = new THREE.BufferGeometry();
  let v = 0;
  for (const m of materialIndices) {
    const data = perMaterial.get(m)!;
    const start = v;
    for (let i = 0; i < data.length; i += STRIDE) {
      p.set(data.slice(i, i + 3), v * 3);
      n.set(data.slice(i + 3, i + 6), v * 3);
      u.set(data.slice(i + 6, i + 8), v * 2);
      v++;
    }
    geometry.addGroup(start, v - start, m);
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(p, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(n, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(u, 2));
  return geometry;
}

export type { Vec3 };
