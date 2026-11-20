import { Anisotropy, BOUNDARY, Cell2D, distanceToPolyline, nearestOnSegment, P2, pointInPolygon, polygonCentroid, voronoiCells } from "./voronoi2d";

/**
 * What sits on top of the bare tessellation in ./voronoi2d.ts: variable
 * density seeding (Poisson disk), walls the cells must follow (mirrored seed
 * pairs), Lloyd relaxation, and the sorting of shared edges into kinds.
 *
 * The order is that of Hoffmann et al. 2018 (PNAS 115:9905), who reproduced
 * dragonfly wing venation as primary veins first, then evenly spaced
 * "inhibitory centres" between them, then a Voronoi tessellation of those
 * centres — the secondary veins.
 */

/** Deterministic PRNG (mulberry32), so the same seed always lays out the same cells. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bounds(poly: P2[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  return { x0, y0, x1, y1 };
}

/**
 * A direction field off guide polylines: at each point, the tangent of the
 * nearest segment of each of the `count` nearest guides, blended by inverse
 * distance. Tangents are averaged as doubled angles, so a guide drawn
 * backwards still agrees with its neighbours. Returns radians.
 */
export function directionField(guides: P2[][], count = 2): (p: P2) => number {
  const lines = guides.filter((g) => g.length >= 2);
  if (lines.length === 0) return () => 0;
  return (p) => {
    const near: { d: number; a: number }[] = [];
    for (const g of lines) {
      let best = Infinity;
      let ang = 0;
      for (let i = 0; i + 1 < g.length; i++) {
        const hit = nearestOnSegment(p, g[i], g[i + 1]);
        if (hit.d2 < best) {
          best = hit.d2;
          ang = Math.atan2(g[i + 1][1] - g[i][1], g[i + 1][0] - g[i][0]);
        }
      }
      near.push({ d: Math.sqrt(best), a: ang });
    }
    near.sort((x, y) => x.d - y.d);
    let cx = 0;
    let cy = 0;
    for (const n of near.slice(0, Math.max(1, count))) {
      const w = 1 / Math.max(n.d, 1e-9);
      cx += w * Math.cos(2 * n.a);
      cy += w * Math.sin(2 * n.a);
    }
    return Math.atan2(cy, cx) / 2;
  };
}

/** Squared distance between p and q in the metric squeezed `k` times along `angle`. */
function metricDist2(p: P2, q: P2, k: number, angle: number): number {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const along = (dx * c + dy * s) / k;
  const across = -dx * s + dy * c;
  return along * along + across * across;
}

/** Mean of two directions (sign-free), radians. */
function meanAngle(a: number, b: number): number {
  return Math.atan2(Math.sin(2 * a) + Math.sin(2 * b), Math.cos(2 * a) + Math.cos(2 * b)) / 2;
}

export interface AnisoField {
  k: number;
  angleAt: (p: P2) => number;
}

/**
 * Poisson-disk points inside `outline` (Bridson's algorithm with a spacing
 * that varies over the plane): no two points closer than the mean of their
 * two spacings. `spacing` is clamped to at least 1/1000 of the outline's size
 * so a formula that dips to zero cannot ask for millions of points.
 */
export function poissonDisk(outline: P2[], spacing: (x: number, y: number) => number, seed: number, maxPoints: number, tries = 24, aniso?: AnisoField): P2[] {
  const k = aniso && aniso.k > 0 ? aniso.k : 1;
  const angles: number[] = [];
  if (outline.length < 3) return [];
  const { x0, y0, x1, y1 } = bounds(outline);
  const w = x1 - x0;
  const h = y1 - y0;
  const floor = Math.max(w, h) / 1000;
  if (!(floor > 0)) return [];
  const rAt = (x: number, y: number): number => {
    const r = spacing(x, y);
    return Number.isFinite(r) ? Math.max(floor, r) : Math.max(w, h);
  };
  let rMin = Infinity;
  let rMax = 0;
  for (let j = 0; j <= 16; j++) {
    for (let i = 0; i <= 16; i++) {
      const r = rAt(x0 + (w * i) / 16, y0 + (h * j) / 16);
      rMin = Math.min(rMin, r);
      rMax = Math.max(rMax, r);
    }
  }
  const cell = rMin;
  const nx = Math.max(1, Math.ceil(w / cell));
  const ny = Math.max(1, Math.ceil(h / cell));
  if (nx * ny > 4_000_000) return [];
  const buckets = new Map<number, number[]>();
  const pts: P2[] = [];
  const radii: number[] = [];
  const key = (p: P2): [number, number] => [Math.min(nx - 1, Math.floor((p[0] - x0) / cell)), Math.min(ny - 1, Math.floor((p[1] - y0) / cell))];
  const fits = (p: P2, r: number, ang: number): boolean => {
    const [ci, cj] = key(p);
    const reach = Math.ceil((Math.max(r, rMax) * Math.max(k, 1)) / cell);
    for (let j = Math.max(0, cj - reach); j <= Math.min(ny - 1, cj + reach); j++) {
      for (let i = Math.max(0, ci - reach); i <= Math.min(nx - 1, ci + reach); i++) {
        const list = buckets.get(j * nx + i);
        if (!list) continue;
        for (const k of list) {
          const q = pts[k];
          const need = (r + radii[k]) / 2;
          const d2 = aniso ? metricDist2(p, q, aniso.k, meanAngle(ang, angles[k])) : (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
          if (d2 < need * need) return false;
        }
      }
    }
    return true;
  };
  const add = (p: P2, r: number, ang: number): void => {
    angles.push(ang);
    const [ci, cj] = key(p);
    const k = cj * nx + ci;
    let list = buckets.get(k);
    if (!list) buckets.set(k, (list = []));
    list.push(pts.length);
    pts.push(p);
    radii.push(r);
  };
  const rand = mulberry32(seed);
  const active: number[] = [];
  // Several starts, so a narrow waist in the outline does not leave one lobe empty.
  for (let s = 0; s < 400 && pts.length < 8; s++) {
    const p: P2 = [x0 + rand() * w, y0 + rand() * h];
    if (!pointInPolygon(p, outline)) continue;
    const r = rAt(p[0], p[1]);
    const ang = aniso ? aniso.angleAt(p) : 0;
    if (!fits(p, r, ang)) continue;
    active.push(pts.length);
    add(p, r, ang);
  }
  while (active.length > 0 && pts.length < maxPoints) {
    const ai = Math.floor(rand() * active.length);
    const base = pts[active[ai]];
    const rb = radii[active[ai]];
    let placed = false;
    const baseAng = angles[active[ai]];
    const bc = Math.cos(baseAng);
    const bs = Math.sin(baseAng);
    for (let t = 0; t < tries; t++) {
      const ang = rand() * Math.PI * 2;
      const dist = rb * (1 + rand());
      // In the base point's own frame: k times further along its direction.
      const along = Math.cos(ang) * dist * k;
      const across = Math.sin(ang) * dist;
      const p: P2 = [base[0] + along * bc - across * bs, base[1] + along * bs + across * bc];
      if (p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1) continue;
      if (!pointInPolygon(p, outline)) continue;
      const r = rAt(p[0], p[1]);
      const pa = aniso ? aniso.angleAt(p) : 0;
      if (!fits(p, r, pa)) continue;
      active.push(pts.length);
      add(p, r, pa);
      placed = true;
      break;
    }
    if (!placed) active.splice(ai, 1);
  }
  return pts;
}

/** wall -1: a free seed (relaxed); -2: a fixed seed of a wall's outer rows; >= 0: one of a wall's mirrored pair. */
export type SiteKind = { wall: -1 | -2 } | { wall: number; side: 1 | -1 };

export interface Tessellation {
  sites: P2[];
  kinds: SiteKind[];
  cells: Cell2D[];
  /** Interior edges between two cells, not lying on a wall. */
  crossEdges: [P2, P2][];
  /** Edges on a wall (between the two seeds of a mirrored pair). */
  wallEdges: [P2, P2][];
}

export interface TessellateOptions {
  outline: P2[];
  seeds: P2[];
  walls: P2[][];
  /** Spacing of seed pairs along walls; <= 0 reads it from the nearest seed's own spacing. */
  wallSpacing: number;
  relax: number;
  /**
   * Rows of fixed seeds laid along each side of every wall (1 = just the
   * mirrored pair). Between two walls closer than about 2·rows spacings the
   * rows fill the strip — a ladder for one row, a grid for more — and only
   * wider fields keep free, relaxed seeds in their middle.
   */
  wallRows?: number;
  /** Cells stretched along a direction field (see Anisotropy in ./voronoi2d). */
  aniso?: AnisoField;
}

/** Bucket hash for "is any seed within r of p" while seeds are being added. */
class SeedHash {
  private readonly buckets = new Map<string, P2[]>();
  constructor(private readonly cell: number) {}
  private key(i: number, j: number): string {
    return `${i},${j}`;
  }
  add(p: P2): void {
    const k = this.key(Math.floor(p[0] / this.cell), Math.floor(p[1] / this.cell));
    let b = this.buckets.get(k);
    if (!b) this.buckets.set(k, (b = []));
    b.push(p);
  }
  near(p: P2, r: number): boolean {
    const reach = Math.ceil(r / this.cell);
    const ci = Math.floor(p[0] / this.cell);
    const cj = Math.floor(p[1] / this.cell);
    for (let j = cj - reach; j <= cj + reach; j++) {
      for (let i = ci - reach; i <= ci + reach; i++) {
        const b = this.buckets.get(this.key(i, j));
        if (!b) continue;
        for (const q of b) if ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 < r * r) return true;
      }
    }
    return false;
  }
}

/** Arc-length walker over a polyline: point and unit normal at distance s. */
function walker(wall: P2[]): { total: number; at: (s: number) => { p: P2; n: P2 } } {
  const cum = [0];
  let total = 0;
  for (let i = 1; i < wall.length; i++) cum.push((total += Math.hypot(wall[i][0] - wall[i - 1][0], wall[i][1] - wall[i - 1][1])));
  return {
    total,
    at: (s) => {
      let seg = 0;
      while (seg < wall.length - 2 && cum[seg + 1] < s) seg++;
      const a = wall[seg];
      const b = wall[seg + 1];
      const len = cum[seg + 1] - cum[seg] || 1;
      const t = Math.max(0, Math.min(1, (s - cum[seg]) / len));
      return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], n: [-(b[1] - a[1]) / len, (b[0] - a[0]) / len] };
    },
  };
}

/**
 * The outer rows (2…rows) of fixed seeds beside each wall, odd rows shifted
 * half a step so the cells brick-bond (three veins to a junction, as on a real
 * wing) instead of meeting four at a corner. A seed is kept only on its own
 * wall's side of the strip, clear of the other walls and of seeds already laid.
 */
function rowSeeds(walls: P2[][], rows: number, spacingAt: (p: P2) => number, outline: P2[], hash: SeedHash, along = 1): P2[] {
  const out: P2[] = [];
  if (rows < 2) return out;
  walls.forEach((wall, wi) => {
    const w = walker(wall);
    if (w.total <= 0) return;
    for (let k = 1; k < rows; k++) {
      let s = spacingAt(wall[0]) * 0.5;
      while (s < w.total) {
        const step = spacingAt(w.at(s).p);
        const { p, n } = w.at(s + (k % 2) * step * along * 0.5);
        for (const side of [1, -1]) {
          const off = (k + 0.5) * step;
          const q: P2 = [p[0] + n[0] * side * off, p[1] + n[1] * side * off];
          if (!pointInPolygon(q, outline)) continue;
          const own = distanceToPolyline(q, wall);
          if (own < off * 0.8) continue;
          let clear = true;
          for (let oi = 0; oi < walls.length && clear; oi++) {
            if (oi === wi) continue;
            const d = distanceToPolyline(q, walls[oi]);
            if (d < own + 0.25 * step || d < 0.5 * step) clear = false;
          }
          if (!clear || hash.near(q, 0.75 * step)) continue;
          hash.add(q);
          out.push(q);
        }
        s += step * along;
      }
    }
  });
  return out;
}

/** Each free seed's distance to its nearest other free seed (brute force over a sorted sweep). */
function nearestNeighbourDistances(pts: P2[]): number[] {
  const order = pts.map((_, i) => i).sort((a, b) => pts[a][0] - pts[b][0]);
  const out = new Array<number>(pts.length).fill(Infinity);
  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi];
    const p = pts[i];
    for (let dir = -1; dir <= 1; dir += 2) {
      for (let oj = oi + dir; oj >= 0 && oj < order.length; oj += dir) {
        const q = pts[order[oj]];
        const dx = q[0] - p[0];
        if (dx * dx >= out[i] * out[i]) break;
        out[i] = Math.min(out[i], Math.hypot(dx, q[1] - p[1]));
      }
    }
  }
  return out;
}

function mirrorSeeds(walls: P2[][], free: P2[], wallSpacing: number, along = 1): { seeds: P2[]; kinds: SiteKind[]; spacingAt: (p: P2) => number } {
  const nn = nearestNeighbourDistances(free);
  const fallback = Number.isFinite(Math.min(...nn)) ? nn.reduce((s, d) => s + (Number.isFinite(d) ? d : 0), 0) / Math.max(1, nn.length) : 0.1;
  const spacingAt = (p: P2): number => {
    if (wallSpacing > 0) return wallSpacing;
    let best = Infinity;
    let r = fallback;
    for (let i = 0; i < free.length; i++) {
      const d = (free[i][0] - p[0]) ** 2 + (free[i][1] - p[1]) ** 2;
      if (d < best && Number.isFinite(nn[i])) {
        best = d;
        r = nn[i];
      }
    }
    return r;
  };
  const seeds: P2[] = [];
  const kinds: SiteKind[] = [];
  walls.forEach((wall, wi) => {
    let total = 0;
    const cum = [0];
    for (let i = 1; i < wall.length; i++) cum.push((total += Math.hypot(wall[i][0] - wall[i - 1][0], wall[i][1] - wall[i - 1][1])));
    if (total <= 0) return;
    let s = spacingAt(wall[0]) * 0.5;
    let seg = 0;
    while (s < total) {
      while (seg < wall.length - 2 && cum[seg + 1] < s) seg++;
      const a = wall[seg];
      const b = wall[seg + 1];
      const len = cum[seg + 1] - cum[seg] || 1;
      const t = (s - cum[seg]) / len;
      const p: P2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const step = spacingAt(p);
      const n: P2 = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
      // A neighbouring wall closer than one spacing: meet it halfway, so the seed
      // is shared. Both seeds of the pair move in together — the wall is their
      // bisector only while they stay symmetric about it.
      let off = step / 2;
      for (const side of [1, -1] as const) {
        walls.forEach((other, oi) => {
          if (oi === wi) return;
          let best = { q: p, d2: Infinity };
          for (let k = 0; k + 1 < other.length; k++) {
            const hit = nearestOnSegment(p, other[k], other[k + 1]);
            if (hit.d2 < best.d2) best = hit;
          }
          const d = Math.sqrt(best.d2);
          const ahead = (best.q[0] - p[0]) * n[0] * side + (best.q[1] - p[1]) * n[1] * side;
          if (d < step && ahead > 0.5 * d) off = Math.min(off, d / 2);
        });
      }
      for (const side of [1, -1] as const) {
        const q: P2 = [p[0] + n[0] * side * off, p[1] + n[1] * side * off];
        if (seeds.some((o) => (o[0] - q[0]) ** 2 + (o[1] - q[1]) ** 2 < (off * 0.3) ** 2)) continue;
        seeds.push(q);
        kinds.push({ wall: wi, side });
      }
      s += step * along;
    }
  });
  return { seeds, kinds, spacingAt };
}

function edgeKey(a: P2, b: P2): boolean {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 > 1e-18;
}

/** Seeds → (walls) → relaxed Voronoi cells, with their shared edges sorted by kind. */
export function tessellate(o: TessellateOptions): Tessellation {
  const walls = o.walls.filter((w) => w.length >= 2);
  let free = o.seeds.filter((p) => pointInPolygon(p, o.outline));
  // Stretched cells beside a wall run k times longer along it (the field follows the walls).
  const along = o.aniso ? Math.max(1, o.aniso.k) : 1;
  const mirror = mirrorSeeds(walls, free, o.wallSpacing, along);
  let rows: P2[] = [];
  if (walls.length > 0) {
    const fixed = new SeedHash(Math.max(1e-6, mirror.spacingAt(mirror.seeds[0] ?? [0, 0])));
    for (const q of mirror.seeds) fixed.add(q);
    rows = rowSeeds(walls, Math.max(1, Math.round(o.wallRows ?? 1)), mirror.spacingAt, o.outline, fixed, along);
    free = free.filter((p) => {
      const sp = mirror.spacingAt(p);
      return walls.every((w) => distanceToPolyline(p, w) >= sp * 0.75) && !fixed.near(p, sp * 0.75);
    });
  }
  const sites: P2[] = [...free, ...mirror.seeds, ...rows];
  const kinds: SiteKind[] = [...free.map((): SiteKind => ({ wall: -1 })), ...mirror.kinds, ...rows.map((): SiteKind => ({ wall: -2 }))];
  const metric = (): Anisotropy | undefined => (o.aniso ? { k: o.aniso.k, angles: sites.map(o.aniso.angleAt) } : undefined);
  let cells = voronoiCells(sites, o.outline, metric());
  for (let it = 0; it < Math.max(0, Math.round(o.relax)); it++) {
    for (let i = 0; i < free.length; i++) {
      if (cells[i].verts.length >= 3) sites[i] = polygonCentroid(cells[i].verts);
    }
    cells = voronoiCells(sites, o.outline, metric());
  }
  const crossEdges: [P2, P2][] = [];
  const wallEdges: [P2, P2][] = [];
  for (const cell of cells) {
    const si = cell.site;
    const n = cell.verts.length;
    for (let e = 0; e < n; e++) {
      const other = cell.labels[e];
      if (other === BOUNDARY) continue;
      if (other < si && cells[other].verts.length >= 3) continue;
      const a = cell.verts[e];
      const b = cell.verts[(e + 1) % n];
      if (!edgeKey(a, b)) continue;
      const ka = kinds[si];
      const kb = kinds[other];
      const paired = ka.wall >= 0 && ka.wall === kb.wall && "side" in ka && "side" in kb && ka.side !== kb.side;
      // Where two walls share a seed, the edge on the second wall joins seeds of different walls: caught by position.
      const mid: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const onWall =
        paired ||
        (ka.wall >= 0 && kb.wall >= 0 && walls.some((w) => distanceToPolyline(mid, w) < mirror.spacingAt(mid) * 0.08));
      (onWall ? wallEdges : crossEdges).push([a, b]);
    }
  }
  return { sites, kinds, cells, crossEdges, wallEdges };
}

/**
 * Joins edges into polylines, carrying on through a junction along the edge
 * that turns least, if it turns less than `maxTurn` (radians). Chains shorter
 * than `minLength` are dropped. On a sparse, stretched Voronoi the long chains
 * are the lanes' sides — the zigzag intercalary veins of an insect wing.
 */
export function chainEdges(edges: [P2, P2][], maxTurn: number, minLength: number, tol: number): P2[][] {
  // Endpoints closer than tol are one junction: a stretched diagram along a
  // turning field leaves its three edges a hair apart (see Anisotropy).
  const ids = new Map<P2, string>();
  const grid = new Map<string, { p: P2; id: string }[]>();
  const cellOf = (p: P2): [number, number] => [Math.floor(p[0] / tol), Math.floor(p[1] / tol)];
  for (const [a, b] of edges) {
    for (const p of [a, b]) {
      if (ids.has(p)) continue;
      const [ci, cj] = cellOf(p);
      let found: string | undefined;
      for (let j = cj - 1; j <= cj + 1 && !found; j++) {
        for (let i = ci - 1; i <= ci + 1 && !found; i++) {
          for (const e of grid.get(`${i},${j}`) ?? []) {
            if ((e.p[0] - p[0]) ** 2 + (e.p[1] - p[1]) ** 2 <= tol * tol) {
              found = e.id;
              break;
            }
          }
        }
      }
      const id = found ?? `${ci},${cj},${ids.size}`;
      ids.set(p, id);
      const k = `${ci},${cj}`;
      let list = grid.get(k);
      if (!list) grid.set(k, (list = []));
      list.push({ p, id });
    }
  }
  const key = (p: P2) => ids.get(p) ?? `${p[0]},${p[1]}`;
  const at = new Map<string, number[]>();
  edges.forEach(([a, b], i) => {
    for (const p of [a, b]) {
      const k = key(p);
      let l = at.get(k);
      if (!l) at.set(k, (l = []));
      l.push(i);
    }
  });
  const used = new Uint8Array(edges.length);
  const cosMax = Math.cos(maxTurn);
  const extend = (chain: P2[]): void => {
    for (;;) {
      const end = chain[chain.length - 1];
      const prev = chain[chain.length - 2];
      const dx = end[0] - prev[0];
      const dy = end[1] - prev[1];
      const dl = Math.hypot(dx, dy) || 1;
      let best = -1;
      let bestCos = cosMax;
      let bestFar: P2 | null = null;
      for (const ei of at.get(key(end)) ?? []) {
        if (used[ei]) continue;
        const [a, b] = edges[ei];
        const far = key(a) === key(end) ? b : a;
        const ex = far[0] - end[0];
        const ey = far[1] - end[1];
        const c = (dx * ex + dy * ey) / (dl * (Math.hypot(ex, ey) || 1));
        if (c > bestCos) {
          bestCos = c;
          best = ei;
          bestFar = far;
        }
      }
      if (best < 0 || !bestFar) return;
      used[best] = 1;
      chain.push(bestFar);
    }
  };
  const chains: P2[][] = [];
  edges.forEach(([a, b], i) => {
    if (used[i]) return;
    used[i] = 1;
    const chain: P2[] = [a, b];
    extend(chain);
    chain.reverse();
    extend(chain);
    let len = 0;
    for (let k = 1; k < chain.length; k++) len += Math.hypot(chain[k][0] - chain[k - 1][0], chain[k][1] - chain[k - 1][1]);
    if (len >= minLength) chains.push(chain);
  });
  return chains;
}
