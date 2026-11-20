/**
 * 2D Voronoi tessellation clipped to an arbitrary closed outline — the plane
 * counterpart of ./voronoi.ts, built the same way (after Voro++, C. H.
 * Rycroft): each cell starts as the outline's bounding box and is cut by the
 * bisector of each neighbouring site, nearest first, stopping once the next
 * site is further than twice the cell's radius. Neighbours come from a uniform
 * bucket grid searched in growing rings.
 *
 * The convex cell is then intersected with the outline, which may be concave
 * (a wing's trailing edge, a leaf's notch): the outline is clipped by each
 * edge of the convex cell — even for a site outside the outline, whose region
 * can still reach in past a concave notch. Every edge remembers what it borders — another
 * site's index, or BOUNDARY — so shared edges can be emitted once and sorted
 * into kinds (crossing veins, margin, walls).
 *
 * Walls are polylines the tessellation must follow (a dragonfly's main veins,
 * a road through a parcel layout). They are honoured with mirrored seed pairs:
 * points placed at ±offset on either side of the wall, whose bisector is the
 * wall itself. Free seeds too close to a wall are dropped, so cells line up
 * against it in a row — the ladder of cross-veins a real wing shows along its
 * longitudinal veins (Hoffmann et al. 2018, PNAS 115:9905).
 */

export type P2 = [number, number];

/** Neighbour id of an edge lying on the outline. */
export const BOUNDARY = -1;

export interface Cell2D {
  site: number;
  /** Counter-clockwise; `labels[i]` is what the edge from verts[i] to verts[i+1] borders. */
  verts: P2[];
  labels: number[];
}

interface LPoly {
  verts: P2[];
  labels: number[];
}

const EPS = 1e-12;

export function polygonArea(v: P2[]): number {
  let a = 0;
  for (let i = 0, n = v.length; i < n; i++) {
    const p = v[i];
    const q = v[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function polygonCentroid(v: P2[]): P2 {
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0, n = v.length; i < n; i++) {
    const p = v[i];
    const q = v[(i + 1) % n];
    const c = p[0] * q[1] - q[0] * p[1];
    a += c;
    cx += (p[0] + q[0]) * c;
    cy += (p[1] + q[1]) * c;
  }
  if (Math.abs(a) < EPS) {
    let sx = 0;
    let sy = 0;
    for (const p of v) {
      sx += p[0];
      sy += p[1];
    }
    return [sx / Math.max(1, v.length), sy / Math.max(1, v.length)];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInPolygon(p: P2, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/**
 * Keeps the part of `poly` where `nx·x + ny·y <= d` (Sutherland–Hodgman), the
 * new edge along the cut labelled `label`. Correct for a concave subject too,
 * apart from zero-width bridges where the result falls into several pieces.
 */
function clipHalfPlane(poly: LPoly, nx: number, ny: number, d: number, label: number): LPoly {
  const { verts, labels } = poly;
  const n = verts.length;
  const outV: P2[] = [];
  const outL: number[] = [];
  if (n === 0) return { verts: outV, labels: outL };
  for (let i = 0; i < n; i++) {
    const s = verts[i];
    const e = verts[(i + 1) % n];
    const ds = nx * s[0] + ny * s[1] - d;
    const de = nx * e[0] + ny * e[1] - d;
    const sIn = ds <= 0;
    const eIn = de <= 0;
    if (sIn) {
      outV.push(s);
      outL.push(labels[i]);
    }
    if (sIn !== eIn) {
      const t = ds / (ds - de);
      outV.push([s[0] + (e[0] - s[0]) * t, s[1] + (e[1] - s[1]) * t]);
      outL.push(sIn ? label : labels[i]);
    }
  }
  return { verts: outV, labels: outL };
}

function maxRadiusSq(poly: LPoly, s: P2): number {
  let m = 0;
  for (const p of poly.verts) m = Math.max(m, (p[0] - s[0]) ** 2 + (p[1] - s[1]) ** 2);
  return m;
}

/** Uniform bucket grid over the sites, for nearest-first ring search. */
class SiteGrid {
  readonly cells: number[][];
  readonly nx: number;
  readonly ny: number;
  readonly size: number;
  constructor(readonly sites: P2[], readonly x0: number, readonly y0: number, w: number, h: number) {
    const per = Math.sqrt((w * h) / Math.max(1, sites.length)) * 1.5;
    this.size = Math.max(per, 1e-9);
    this.nx = Math.max(1, Math.ceil(w / this.size));
    this.ny = Math.max(1, Math.ceil(h / this.size));
    this.cells = Array.from({ length: this.nx * this.ny }, () => []);
    sites.forEach((s, i) => this.cells[this.index(s)].push(i));
  }
  private clampI(v: number, n: number): number {
    return Math.min(n - 1, Math.max(0, v));
  }
  cellOf(s: P2): [number, number] {
    return [this.clampI(Math.floor((s[0] - this.x0) / this.size), this.nx), this.clampI(Math.floor((s[1] - this.y0) / this.size), this.ny)];
  }
  index(s: P2): number {
    const [i, j] = this.cellOf(s);
    return j * this.nx + i;
  }
  /** Site indices in the square ring at Chebyshev distance r from cell (ci, cj). */
  ring(ci: number, cj: number, r: number, out: number[]): void {
    for (let j = cj - r; j <= cj + r; j++) {
      if (j < 0 || j >= this.ny) continue;
      for (let i = ci - r; i <= ci + r; i++) {
        if (i < 0 || i >= this.nx) continue;
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
        for (const k of this.cells[j * this.nx + i]) out.push(k);
      }
    }
  }
}

/** Collapses consecutive near-duplicate vertices left by clipping. */
function cleanPoly(poly: LPoly, tol: number): LPoly {
  const v: P2[] = [];
  const l: number[] = [];
  const t2 = tol * tol;
  for (let i = 0; i < poly.verts.length; i++) {
    const p = poly.verts[i];
    if (v.length > 0) {
      const q = v[v.length - 1];
      if ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 < t2) {
        l[l.length - 1] = poly.labels[i];
        continue;
      }
    }
    v.push(p);
    l.push(poly.labels[i]);
  }
  while (v.length > 1) {
    const a = v[v.length - 1];
    const b = v[0];
    if ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 >= t2) break;
    v.pop();
    l.pop();
  }
  return { verts: v, labels: l };
}

/**
 * Cells stretched `k` times along a direction that may differ from site to
 * site (a direction field: along a vein, fanning out with it). Each pair of
 * sites is split by the bisector of the metric squeezed along the mean of
 * their two directions, so both cells share the same edge. With a direction
 * that varies, three such bisectors need not meet in one point: the diagram
 * leaves slivers at some junctions, small while the field turns slowly.
 */
export interface Anisotropy {
  k: number;
  /** Direction per site, radians. */
  angles: number[];
}

/**
 * The Voronoi cell of every site, clipped to `outline` (a closed polygon,
 * either winding). A cell wholly outside the outline comes back empty.
 */
export function voronoiCells(sites: P2[], outline: P2[], aniso?: Anisotropy): Cell2D[] {
  const k = aniso && Number.isFinite(aniso.k) && aniso.k > 0 ? aniso.k : 1;
  const stretched = aniso !== undefined && Math.abs(k - 1) > 1e-9;
  // Doubled-angle unit vectors: direction without a sign, so 0° and 180° average to 0°, not 90°.
  const dbl = stretched ? sites.map((_, i) => [Math.cos(2 * aniso.angles[i]), Math.sin(2 * aniso.angles[i])] as P2) : [];
  const reach2 = Math.max(k * k, 1 / (k * k));
  const ring = polygonArea(outline) < 0 ? [...outline].reverse() : outline;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of ring) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  const w = Math.max(x1 - x0, 1e-9);
  const h = Math.max(y1 - y0, 1e-9);
  const tol = Math.max(w, h) * 1e-7;
  // The grid spans the sites too: one outside the outline (a wall's mirror
  // seed) must still sit in its true bucket, or the ring early-out misses it.
  let gx0 = x0;
  let gy0 = y0;
  let gx1 = x1;
  let gy1 = y1;
  for (const p of sites) {
    gx0 = Math.min(gx0, p[0]);
    gy0 = Math.min(gy0, p[1]);
    gx1 = Math.max(gx1, p[0]);
    gy1 = Math.max(gy1, p[1]);
  }
  const grid = new SiteGrid(sites, gx0, gy0, Math.max(gx1 - gx0, 1e-9), Math.max(gy1 - gy0, 1e-9));
  const outlineLabels = ring.map(() => BOUNDARY);
  const maxRing = Math.max(grid.nx, grid.ny);
  const candidates: number[] = [];

  return sites.map((s, si): Cell2D => {
    // The box is padded so no edge of it survives into the outline clip.
    const pad = Math.max(w, h);
    let cell: LPoly = {
      verts: [[x0 - pad, y0 - pad], [x1 + pad, y0 - pad], [x1 + pad, y1 + pad], [x0 - pad, y1 + pad]],
      labels: [BOUNDARY, BOUNDARY, BOUNDARY, BOUNDARY],
    };
    let r2 = maxRadiusSq(cell, s);
    const [ci, cj] = grid.cellOf(s);
    for (let r = 0; r <= maxRing; r++) {
      // Every site in ring r is at least (r - 1) cells away.
      const minDist = Math.max(0, r - 1) * grid.size;
      if (minDist * minDist > 4 * r2 * reach2) break;
      candidates.length = 0;
      grid.ring(ci, cj, r, candidates);
      candidates.sort((a, b) => (sites[a][0] - s[0]) ** 2 + (sites[a][1] - s[1]) ** 2 - ((sites[b][0] - s[0]) ** 2 + (sites[b][1] - s[1]) ** 2));
      for (const kk of candidates) {
        if (kk === si) continue;
        const q = sites[kk];
        const dx = q[0] - s[0];
        const dy = q[1] - s[1];
        const d2 = dx * dx + dy * dy;
        if (d2 < EPS) continue;
        if (d2 > 4 * r2 * reach2) continue;
        if (stretched) {
          // Bisector in the metric G = R diag(1/k², 1) Rᵀ along the pair's mean direction.
          let cx = dbl[si][0] + dbl[kk][0];
          let cy = dbl[si][1] + dbl[kk][1];
          const l = Math.hypot(cx, cy);
          if (l < 1e-9) {
            cx = dbl[si][0];
            cy = dbl[si][1];
          } else {
            cx /= l;
            cy /= l;
          }
          const half = Math.atan2(cy, cx) / 2;
          const c = Math.cos(half);
          const sn = Math.sin(half);
          const inv = 1 / (k * k);
          const g = (x: number, y: number): P2 => {
            const along = (x * c + y * sn) * inv;
            const across = -x * sn + y * c;
            return [along * c - across * sn, along * sn + across * c];
          };
          const [nx, ny] = g(dx, dy);
          const gq = g(q[0], q[1]);
          const gs = g(s[0], s[1]);
          const d = (q[0] * gq[0] + q[1] * gq[1] - (s[0] * gs[0] + s[1] * gs[1])) / 2;
          cell = clipHalfPlane(cell, nx, ny, d, kk);
        } else {
          const d = (q[0] * q[0] + q[1] * q[1] - s[0] * s[0] - s[1] * s[1]) / 2;
          cell = clipHalfPlane(cell, dx, dy, d, kk);
        }
        if (cell.verts.length < 3) return { site: si, verts: [], labels: [] };
        r2 = maxRadiusSq(cell, s);
      }
    }
    // Intersect with the (possibly concave) outline: clip it by each convex-cell edge.
    // A near-zero edge left by clipping has a normal made of rounding noise, which would cut
    // the outline along an arbitrary line: drop those first.
    cell = cleanPoly(cell, tol);
    let clipped: LPoly = { verts: ring, labels: outlineLabels };
    const cv = cell.verts;
    for (let i = 0; i < cv.length && clipped.verts.length >= 3; i++) {
      const a = cv[i];
      const b = cv[(i + 1) % cv.length];
      if ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 < tol * tol) continue;
      // Outward normal of a CCW edge (b - a) is (dy, -dx).
      const nx = b[1] - a[1];
      const ny = -(b[0] - a[0]);
      clipped = clipHalfPlane(clipped, nx, ny, nx * a[0] + ny * a[1], cell.labels[i]);
    }
    clipped = cleanPoly(clipped, tol);
    if (clipped.verts.length < 3) return { site: si, verts: [], labels: [] };
    return { site: si, verts: clipped.verts, labels: clipped.labels };
  });
}

/** Point on segment ab nearest to p, and its squared distance. */
export function nearestOnSegment(p: P2, a: P2, b: P2): { q: P2; d2: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 < EPS ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  const q: P2 = [a[0] + dx * t, a[1] + dy * t];
  return { q, d2: (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2, t };
}

export function distanceToPolyline(p: P2, line: P2[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) best = Math.min(best, nearestOnSegment(p, line[i], line[i + 1]).d2);
  return Math.sqrt(best);
}

/** Moves every polygon vertex inward by `d` (miter offset); null once the polygon collapses. */
export function insetPolygon(v: P2[], d: number): P2[] | null {
  if (d <= 0) return v;
  const n = v.length;
  const ccw = polygonArea(v) > 0 ? 1 : -1;
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = v[(i + n - 1) % n];
    const p1 = v[i];
    const p2 = v[(i + 1) % n];
    const e0 = norm([p1[0] - p0[0], p1[1] - p0[1]]);
    const e1 = norm([p2[0] - p1[0], p2[1] - p1[1]]);
    const n0: P2 = [-e0[1] * ccw, e0[0] * ccw];
    const n1: P2 = [-e1[1] * ccw, e1[0] * ccw];
    const bis = norm([n0[0] + n1[0], n0[1] + n1[1]]);
    const cos = Math.max(0.25, bis[0] * n1[0] + bis[1] * n1[1]);
    out.push([p1[0] + (bis[0] * d) / cos, p1[1] + (bis[1] * d) / cos]);
  }
  const a0 = polygonArea(v);
  const a1 = polygonArea(out);
  if (Math.sign(a0) !== Math.sign(a1) || Math.abs(a1) < Math.abs(a0) * 0.02) return null;
  // Past collapse a polygon turns inside out with its winding intact (a square
  // rotated half a turn), but every edge then points backwards.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if ((v[j][0] - v[i][0]) * (out[j][0] - out[i][0]) + (v[j][1] - v[i][1]) * (out[j][1] - out[i][1]) < 0) return null;
  }
  return out;
}

function norm(v: P2): P2 {
  const l = Math.hypot(v[0], v[1]);
  return l < EPS ? [0, 0] : [v[0] / l, v[1] / l];
}

function segmentsCross(a: P2, b: P2, c: P2, d: P2): boolean {
  const o = (p: P2, q: P2, r: P2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * A cell cut from a very concave outline can come back with zero-width spikes
 * or bridges, or crossing itself; triangulated as is, it covers some of its
 * area twice (a darker patch on a see-through membrane). Drops repeated
 * points and spikes, and if it still crosses
 * itself, cuts it at each crossing and keeps the larger loop. Null when
 * nothing with area is left.
 */
export function simplePolygon(v: P2[], tol = 1e-9): P2[] | null {
  let p = v.filter((q, i) => {
    const r = v[(i + v.length - 1) % v.length];
    return (q[0] - r[0]) ** 2 + (q[1] - r[1]) ** 2 > tol * tol;
  });
  // Spikes: a vertex where the outline doubles back on itself.
  for (let changed = true; changed && p.length >= 3; ) {
    changed = false;
    for (let i = 0; i < p.length && p.length >= 3; i++) {
      const a = p[(i + p.length - 1) % p.length];
      const b = p[i];
      const c = p[(i + 1) % p.length];
      const ux = b[0] - a[0];
      const uy = b[1] - a[1];
      const wx = c[0] - b[0];
      const wy = c[1] - b[1];
      const cr = ux * wy - uy * wx;
      const dot = ux * wx + uy * wy;
      const lu = Math.hypot(ux, uy);
      const lw = Math.hypot(wx, wy);
      if (lu < tol || lw < tol || (Math.abs(cr) <= 1e-6 * lu * lw && dot < 0)) {
        p.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  if (p.length < 3) return null;
  const n = p.length;
  let crosses = false;
  for (let i = 0; i < n && !crosses; i++) {
    for (let j = i + 2; j < n && !crosses; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) crosses = true;
    }
  }
  if (crosses) p = untangle(p);
  return p.length >= 3 && Math.abs(polygonArea(p)) > tol * tol ? p : null;
}

/**
 * A ring that crosses itself (a narrow neck pinched shut by smoothing) cut at
 * each crossing, keeping the larger loop every time — a simple polygon.
 */
export function untangle(ring: P2[]): P2[] {
  let p = ring;
  for (let guard = 0; guard < ring.length; guard++) {
    const n = p.length;
    if (n < 4) return p;
    let hit: [number, number] | null = null;
    for (let i = 0; i < n && !hit; i++) {
      for (let j = i + 2; j < n && !hit; j++) {
        if (i === 0 && j === n - 1) continue;
        if (segmentsCross(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) hit = [i, j];
      }
    }
    if (!hit) return p;
    const [i, j] = hit;
    const a = p[i];
    const b = p[i + 1];
    const c = p[j];
    const d = p[(j + 1) % n];
    const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
    const t = den === 0 ? 0.5 : ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den;
    const x: P2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const outer = [...p.slice(0, i + 1), x, ...p.slice(j + 1)];
    const inner = [x, ...p.slice(i + 1, j + 1)];
    p = Math.abs(polygonArea(outer)) >= Math.abs(polygonArea(inner)) ? outer : inner;
  }
  return p;
}
