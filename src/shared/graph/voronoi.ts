/**
 * 3D Voronoi tessellation — a TypeScript implementation of the algorithm
 * behind Voro++ (Chris H. Rycroft, https://github.com/chr1shr/voro, modified
 * BSD licence, (c) UC Regents / Lawrence Berkeley National Laboratory).
 *
 * What is kept from Voro++: every cell is computed *independently*, starting
 * as the bounding box and being cut by the bisector plane of each neighbouring
 * site in turn, nearest first; the search stops as soon as the next neighbour
 * is further than twice the cell's current maximum radius, because its
 * bisector can no longer touch the cell. Neighbours are found through a
 * uniform block grid searched in expanding shells.
 *
 * What differs: Voro++ stores a cell as a vertex/edge table with pointer
 * arithmetic (fast in C++, miserable in TS). Here a cell is a list of convex
 * polygonal faces, each remembering which site (or wall) it borders — the same
 * information, simpler to clip and to triangulate for rendering.
 */

export type Vec3 = [number, number, number];

/** Neighbour ids of the six bounding-box walls: -1 = -x, -2 = +x, -3 = -y, -4 = +y, -5 = -z, -6 = +z. */
export const WALL_NEIGHBOR_MIN = -6;

export interface CellFace {
  /** Counter-clockwise seen from outside the cell. */
  verts: Vec3[];
  /** Index of the site on the other side, or a negative wall id. */
  neighbor: number;
}

const EPS = 1e-9;

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** A convex polyhedron that is cut down one half-space at a time. */
export class VoronoiCell {
  faces: CellFace[] = [];
  /** Squared distance from the site to the furthest vertex — drives the early-out. */
  maxRadiusSq = 0;

  constructor(
    readonly site: Vec3,
    min: Vec3,
    max: Vec3,
  ) {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    const v = (x: number, y: number, z: number): Vec3 => [x, y, z];
    // Outward-CCW quads of an axis-aligned box.
    this.faces = [
      { neighbor: -1, verts: [v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0)] },
      { neighbor: -2, verts: [v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1)] },
      { neighbor: -3, verts: [v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)] },
      { neighbor: -4, verts: [v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1), v(x1, y1, z0)] },
      { neighbor: -5, verts: [v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0), v(x1, y0, z0)] },
      { neighbor: -6, verts: [v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)] },
    ];
    this.updateRadius();
  }

  get isEmpty(): boolean {
    return this.faces.length < 4;
  }

  private updateRadius(): void {
    let m = 0;
    const [sx, sy, sz] = this.site;
    for (const f of this.faces) {
      for (const p of f.verts) {
        const d = (p[0] - sx) ** 2 + (p[1] - sy) ** 2 + (p[2] - sz) ** 2;
        if (d > m) m = d;
      }
    }
    this.maxRadiusSq = m;
  }

  /**
   * Keep the part of the cell where `n · x <= d` (n need not be normalised).
   * `neighbor` labels the new face. Returns false if the plane missed the cell.
   */
  cut(n: Vec3, d: number, neighbor: number): boolean {
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < EPS) return false;
    const nx = n[0] / len;
    const ny = n[1] / len;
    const nz = n[2] / len;
    const dd = d / len;

    let anyOutside = false;
    const out: CellFace[] = [];
    const cap: Vec3[] = [];

    for (const face of this.faces) {
      const vs = face.verts;
      const k = vs.length;
      const s = new Array<number>(k);
      for (let i = 0; i < k; i++) {
        s[i] = nx * vs[i][0] + ny * vs[i][1] + nz * vs[i][2] - dd;
        if (s[i] > EPS) anyOutside = true;
      }

      const poly: Vec3[] = [];
      for (let i = 0; i < k; i++) {
        const j = (i + 1) % k;
        const a = vs[i];
        const b = vs[j];
        if (s[i] <= EPS) {
          poly.push(a);
          // A vertex lying on the plane is part of the cap's outline.
          if (s[i] >= -EPS) cap.push(a);
        }
        if ((s[i] < -EPS && s[j] > EPS) || (s[i] > EPS && s[j] < -EPS)) {
          const t = s[i] / (s[i] - s[j]);
          const p: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
          poly.push(p);
          cap.push(p);
        }
      }
      if (poly.length >= 3) out.push({ verts: poly, neighbor: face.neighbor });
    }

    if (!anyOutside) return false;

    // Cap: the cut polygon, ordered around its centroid in the plane.
    const pts: Vec3[] = [];
    for (const p of cap) {
      if (!pts.some((q) => Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]) + Math.abs(q[2] - p[2]) < 1e-7)) pts.push(p);
    }
    if (pts.length >= 3) {
      const c: Vec3 = [0, 0, 0];
      for (const p of pts) {
        c[0] += p[0];
        c[1] += p[1];
        c[2] += p[2];
      }
      c[0] /= pts.length;
      c[1] /= pts.length;
      c[2] /= pts.length;

      // Basis (u, v) with u × v = n, so ascending angle winds CCW seen from outside.
      const helper: Vec3 = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const u = cross([nx, ny, nz], helper);
      const ul = Math.hypot(u[0], u[1], u[2]);
      u[0] /= ul;
      u[1] /= ul;
      u[2] /= ul;
      const w = cross([nx, ny, nz], u);
      const angle = (p: Vec3) => {
        const rx = p[0] - c[0];
        const ry = p[1] - c[1];
        const rz = p[2] - c[2];
        return Math.atan2(rx * w[0] + ry * w[1] + rz * w[2], rx * u[0] + ry * u[1] + rz * u[2]);
      };
      pts.sort((a, b) => angle(a) - angle(b));
      out.push({ verts: pts, neighbor });
    }

    this.faces = out;
    this.updateRadius();
    return true;
  }

  /** Mean of the vertices — a stable interior point, good enough as a body origin. */
  centroid(): Vec3 {
    const c: Vec3 = [0, 0, 0];
    let n = 0;
    for (const f of this.faces) {
      for (const p of f.verts) {
        c[0] += p[0];
        c[1] += p[1];
        c[2] += p[2];
        n++;
      }
    }
    return n ? [c[0] / n, c[1] / n, c[2] / n] : [...this.site];
  }

  /** Exact volume, by summing signed tetrahedra from the site. */
  volume(): number {
    let v = 0;
    const [sx, sy, sz] = this.site;
    for (const f of this.faces) {
      const a = f.verts[0];
      for (let i = 1; i < f.verts.length - 1; i++) {
        const b = f.verts[i];
        const c = f.verts[i + 1];
        const ax = a[0] - sx, ay = a[1] - sy, az = a[2] - sz;
        const bx = b[0] - sx, by = b[1] - sy, bz = b[2] - sz;
        const cx = c[0] - sx, cy = c[1] - sy, cz = c[2] - sz;
        v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
      }
    }
    return v;
  }

  /** Indices of the sites this cell touches (walls excluded). */
  neighbors(): number[] {
    return this.faces.filter((f) => f.neighbor >= 0).map((f) => f.neighbor);
  }
}

export interface TessellationOptions {
  /** Box every cell is clipped to. */
  min: Vec3;
  max: Vec3;
  /**
   * Total clearance left between two neighbouring cells. Each bisector is
   * pulled back by half of it, so cells (and the pieces cut from them) do not
   * touch — which is also what stops a physics engine from seeing them overlap
   * on the first frame.
   */
  gap?: number;
}

/**
 * Voronoi tessellation of `sites` inside the box. The result has one entry per
 * site, in order; a site whose cell vanished (outside the box, or squeezed out
 * by a duplicate) gets an empty cell.
 */
export function tessellate(sites: Vec3[], options: TessellationOptions): VoronoiCell[] {
  const { min, max } = options;
  const halfGap = Math.max(0, options.gap ?? 0) / 2;
  const n = sites.length;
  const cells: VoronoiCell[] = [];
  if (n === 0) return cells;

  // Block grid, ~2 sites per block (Voro++ aims for the same).
  const size: Vec3 = [Math.max(max[0] - min[0], EPS), Math.max(max[1] - min[1], EPS), Math.max(max[2] - min[2], EPS)];
  const volume = size[0] * size[1] * size[2];
  const blockEdge = Math.cbrt((volume * 2) / n);
  const dims: Vec3 = [
    Math.max(1, Math.min(64, Math.ceil(size[0] / blockEdge))),
    Math.max(1, Math.min(64, Math.ceil(size[1] / blockEdge))),
    Math.max(1, Math.min(64, Math.ceil(size[2] / blockEdge))),
  ];
  const bs: Vec3 = [size[0] / dims[0], size[1] / dims[1], size[2] / dims[2]];
  const minBlock = Math.min(bs[0], bs[1], bs[2]);
  const maxShell = Math.max(dims[0], dims[1], dims[2]);

  const blockOf = (p: Vec3): Vec3 => [
    Math.min(dims[0] - 1, Math.max(0, Math.floor((p[0] - min[0]) / bs[0]))),
    Math.min(dims[1] - 1, Math.max(0, Math.floor((p[1] - min[1]) / bs[1]))),
    Math.min(dims[2] - 1, Math.max(0, Math.floor((p[2] - min[2]) / bs[2]))),
  ];
  const blocks: number[][] = Array.from({ length: dims[0] * dims[1] * dims[2] }, () => []);
  const blockIndex = (x: number, y: number, z: number) => (z * dims[1] + y) * dims[0] + x;
  for (let i = 0; i < n; i++) {
    const b = blockOf(sites[i]);
    blocks[blockIndex(b[0], b[1], b[2])].push(i);
  }

  for (let i = 0; i < n; i++) {
    const site = sites[i];
    const cell = new VoronoiCell(site, min, max);
    const home = blockOf(site);

    for (let r = 0; r <= maxShell; r++) {
      // No site in this shell can be nearer than (r - 1) block edges.
      const lower = (r - 1) * minBlock;
      if (r > 1 && lower * lower > 4 * cell.maxRadiusSq) break;

      // Collect this shell's sites, nearest first, so close cuts shrink the
      // cell before the far ones are even tested.
      const found: { j: number; d2: number }[] = [];
      for (let z = home[2] - r; z <= home[2] + r; z++) {
        if (z < 0 || z >= dims[2]) continue;
        for (let y = home[1] - r; y <= home[1] + r; y++) {
          if (y < 0 || y >= dims[1]) continue;
          for (let x = home[0] - r; x <= home[0] + r; x++) {
            if (x < 0 || x >= dims[0]) continue;
            // Only the surface of the cube of radius r.
            if (Math.max(Math.abs(x - home[0]), Math.abs(y - home[1]), Math.abs(z - home[2])) !== r) continue;
            for (const j of blocks[blockIndex(x, y, z)]) {
              if (j === i) continue;
              const q = sites[j];
              found.push({ j, d2: (q[0] - site[0]) ** 2 + (q[1] - site[1]) ** 2 + (q[2] - site[2]) ** 2 });
            }
          }
        }
      }
      found.sort((a, b) => a.d2 - b.d2);

      for (const { j, d2 } of found) {
        // Bisector sits at distance sqrt(d2)/2: out of reach of the cell.
        if (d2 > 4 * cell.maxRadiusSq) break;
        if (d2 < 1e-18) continue; // duplicate site: leave it to the first one
        const q = sites[j];
        const nrm: Vec3 = [q[0] - site[0], q[1] - site[1], q[2] - site[2]];
        const dist = Math.sqrt(d2);
        // Plane through the midpoint, normal toward q, pulled back by halfGap.
        const mid = (site[0] + q[0]) / 2 * nrm[0] + (site[1] + q[1]) / 2 * nrm[1] + (site[2] + q[2]) / 2 * nrm[2];
        cell.cut(nrm, mid - halfGap * dist, j);
        if (cell.isEmpty) break;
      }
      if (cell.isEmpty) break;
    }
    cells.push(cell);
  }
  return cells;
}

/**
 * Triangle soup for a cell: positions, a flat normal per face, and one
 * `faceIds` entry per triangle carrying the face's neighbour id — the caller
 * uses it to tell a cut face (neighbour >= 0) from a wall.
 */
export function cellToTriangles(cell: VoronoiCell): { positions: number[]; normals: number[]; neighbors: number[] } {
  const positions: number[] = [];
  const normals: number[] = [];
  const neighbors: number[] = [];
  for (const f of cell.faces) {
    const a = f.verts[0];
    for (let i = 1; i < f.verts.length - 1; i++) {
      const b = f.verts[i];
      const c = f.verts[i + 1];
      const e1: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const nn = cross(e1, e2);
      const l = Math.hypot(nn[0], nn[1], nn[2]) || 1;
      for (const p of [a, b, c]) {
        positions.push(p[0], p[1], p[2]);
        normals.push(nn[0] / l, nn[1] / l, nn[2] / l);
      }
      neighbors.push(f.neighbor);
    }
  }
  return { positions, normals, neighbors };
}
