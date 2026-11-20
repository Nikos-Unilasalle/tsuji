import { nearestOnSegment, P2, polygonArea, untangle } from "./voronoi2d";
import { bounds } from "./voronoi2dLayout";

/**
 * A Voronoi diagram whose cells stretch along a direction field that turns
 * over the plane — the long, loose lanes of an insect wing's main veins, which
 * fan out from the base and bend toward the margin.
 *
 * Cut cell by cell (./voronoi2d), such a diagram does not close: with the
 * metric changing from site to site, three bisectors no longer meet in one
 * point and holes open at the junctions. Here every point of a fine grid
 * instead goes to its nearest site under the metric *at that point*
 * (stretched `k` times along the field), so the regions tile the plane
 * exactly. Their pixel borders are then traced into one shared graph,
 * smoothed (outline and wall vertices sliding along the true outline and
 * walls) and simplified — neighbouring cells keep sharing the very same
 * vertices, so the network has no gaps and no overlaps.
 *
 * Walls are hard here: they split the grid into separate pieces, and a point
 * only goes to a site in its own piece, so no cell reaches across one.
 */

export interface FieldTessellateOptions {
  outline: P2[];
  seeds: P2[];
  walls: P2[][];
  relax: number;
  /** Cells are k times longer along the field than across it. */
  k: number;
  angleAt: (p: P2) => number;
  /** Grid cells along the outline's longer side. */
  resolution: number;
}

export interface FieldTessellation {
  sites: P2[];
  cells: { site: number; verts: P2[] }[];
  /** Polylines between two cells, from junction to junction. */
  crossEdges: P2[][];
  /** Polylines along walls (between cells on either side of one). */
  wallEdges: P2[][];
}

const EMPTY: FieldTessellation = { sites: [], cells: [], crossEdges: [], wallEdges: [] };

function nearestOnPolyline(p: P2, line: P2[], closed: boolean): P2 {
  let best = { q: line[0], d2: Infinity };
  const n = line.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const hit = nearestOnSegment(p, line[i], line[(i + 1) % n]);
    if (hit.d2 < best.d2) best = hit;
  }
  return best.q;
}

/** Douglas–Peucker over a sequence of indices into `pos`; marks the kept ones. */
function simplify(seq: number[], pos: Float64Array, tol: number, keep: Uint8Array): void {
  const stack: [number, number][] = [[0, seq.length - 1]];
  keep[seq[0]] = 1;
  keep[seq[seq.length - 1]] = 1;
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const ax = pos[seq[a] * 2];
    const ay = pos[seq[a] * 2 + 1];
    const bx = pos[seq[b] * 2];
    const by = pos[seq[b] * 2 + 1];
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const p: P2 = [pos[seq[i] * 2], pos[seq[i] * 2 + 1]];
      const d = nearestOnSegment(p, [ax, ay], [bx, by]).d2;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    // A closed loop has a == b in position: always split it.
    if (worst > tol * tol || (ax === bx && ay === by)) {
      keep[seq[at]] = 1;
      stack.push([a, at], [at, b]);
    }
  }
}

export function fieldTessellate(o: FieldTessellateOptions): FieldTessellation {
  const outline = o.outline;
  if (outline.length < 3) return EMPTY;
  const box = bounds(outline);
  const size = Math.max(box.x1 - box.x0, box.y1 - box.y0);
  if (!(size > 0)) return EMPTY;
  const res = Math.max(32, Math.min(2000, Math.round(o.resolution)));
  const h = size / res;
  const ox = box.x0 - h;
  const oy = box.y0 - h;
  const nx = Math.ceil((box.x1 - box.x0) / h) + 2;
  const ny = Math.ceil((box.y1 - box.y0) / h) + 2;
  const N = nx * ny;
  const k = Math.max(0.05, o.k);
  const reachK = Math.max(1, k);

  // Pixels inside the outline, by scanline.
  const inside = new Uint8Array(N);
  for (let j = 0; j < ny; j++) {
    const y = oy + (j + 0.5) * h;
    const xs: number[] = [];
    for (let a = 0, b = outline.length - 1; a < outline.length; b = a++) {
      const [ax, ay] = outline[a];
      const [bx, by] = outline[b];
      if (ay > y !== by > y) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
    }
    xs.sort((p, q) => p - q);
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const i0 = Math.max(0, Math.ceil((xs[s] - ox) / h - 0.5));
      const i1 = Math.min(nx - 1, Math.floor((xs[s + 1] - ox) / h - 0.5));
      for (let i = i0; i <= i1; i++) inside[j * nx + i] = 1;
    }
  }
  const pixelOf = (p: P2): number => {
    const i = Math.floor((p[0] - ox) / h);
    const j = Math.floor((p[1] - oy) / h);
    return i >= 0 && j >= 0 && i < nx && j < ny ? j * nx + i : -1;
  };

  // Walls: rasterised as barriers, then the inside split into connected pieces.
  const walls = o.walls.filter((w) => w.length >= 2);
  const comp = new Int32Array(N).fill(-1);
  if (walls.length > 0) {
    const barrier = new Uint8Array(N);
    for (const w of walls) {
      for (let s = 0; s + 1 < w.length; s++) {
        const [ax, ay] = w[s];
        const [bx, by] = w[s + 1];
        const steps = Math.max(1, Math.ceil((Math.hypot(bx - ax, by - ay) / h) * 4));
        for (let t = 0; t <= steps; t++) {
          const px = pixelOf([ax + ((bx - ax) * t) / steps, ay + ((by - ay) * t) / steps]);
          if (px >= 0) barrier[px] = 1;
        }
      }
    }
    let next = 0;
    const queue = new Int32Array(N);
    for (let start = 0; start < N; start++) {
      if (!inside[start] || barrier[start] || comp[start] >= 0) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      comp[start] = next;
      while (head < tail) {
        const px = queue[head++];
        const i = px % nx;
        const j = (px - i) / nx;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const q = jj * nx + ii;
          if (inside[q] && !barrier[q] && comp[q] < 0) {
            comp[q] = next;
            queue[tail++] = q;
          }
        }
      }
      next++;
    }
  }

  const sites: P2[] = o.seeds.filter((p) => {
    const px = pixelOf(p);
    return px >= 0 && inside[px];
  });
  if (sites.length === 0) return { ...EMPTY };
  // A site on a wall's own pixels belongs to the piece of its nearest free pixel.
  const siteComp = (i: number): number => {
    const p = sites[i];
    const px = pixelOf(p);
    if (px < 0 || comp[px] >= 0 || walls.length === 0) return px >= 0 ? comp[px] : -1;
    const ci = px % nx;
    const cj = (px - ci) / nx;
    let best = -1;
    let bestD = Infinity;
    for (let jj = cj - 2; jj <= cj + 2; jj++) {
      for (let ii = ci - 2; ii <= ci + 2; ii++) {
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny || comp[jj * nx + ii] < 0) continue;
        const d = (ox + (ii + 0.5) * h - p[0]) ** 2 + (oy + (jj + 0.5) * h - p[1]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = comp[jj * nx + ii];
        }
      }
    }
    return best;
  };

  // The field, sampled on a coarse grid and interpolated as doubled angles.
  const stride = 4;
  const cxN = Math.ceil(nx / stride) + 1;
  const cyN = Math.ceil(ny / stride) + 1;
  const fc = new Float64Array(cxN * cyN);
  const fs = new Float64Array(cxN * cyN);
  for (let j = 0; j < cyN; j++) {
    for (let i = 0; i < cxN; i++) {
      const a = o.angleAt([ox + (i * stride + 0.5) * h, oy + (j * stride + 0.5) * h]);
      fc[j * cxN + i] = Math.cos(2 * a);
      fs[j * cxN + i] = Math.sin(2 * a);
    }
  }
  const dirC = new Float64Array(N);
  const dirS = new Float64Array(N);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const px = j * nx + i;
      if (!inside[px]) continue;
      const gi = Math.min(cxN - 2, Math.floor(i / stride));
      const gj = Math.min(cyN - 2, Math.floor(j / stride));
      const u = i / stride - gi;
      const v = j / stride - gj;
      const lerp = (f: Float64Array) =>
        (f[gj * cxN + gi] * (1 - u) + f[gj * cxN + gi + 1] * u) * (1 - v) + (f[(gj + 1) * cxN + gi] * (1 - u) + f[(gj + 1) * cxN + gi + 1] * u) * v;
      const a = Math.atan2(lerp(fs), lerp(fc)) / 2;
      dirC[px] = Math.cos(a);
      dirS[px] = Math.sin(a);
    }
  }

  // Each pixel to its nearest site under the metric at the pixel (rings of site buckets).
  const labels = new Int32Array(N).fill(-1);
  const assign = (): void => {
    const g = Math.max(h, Math.sqrt(((box.x1 - box.x0) * (box.y1 - box.y0)) / sites.length));
    const gx = Math.ceil((box.x1 - box.x0) / g) + 1;
    const gy = Math.ceil((box.y1 - box.y0) / g) + 1;
    const buckets: number[][] = Array.from({ length: gx * gy }, () => []);
    const comps = sites.map((_, i) => siteComp(i));
    sites.forEach((p, i) => {
      const bi = Math.max(0, Math.min(gx - 1, Math.floor((p[0] - box.x0) / g)));
      const bj = Math.max(0, Math.min(gy - 1, Math.floor((p[1] - box.y0) / g)));
      buckets[bj * gx + bi].push(i);
    });
    const maxRing = Math.max(gx, gy);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const px = j * nx + i;
        if (!inside[px]) continue;
        const x = ox + (i + 0.5) * h;
        const y = oy + (j + 0.5) * h;
        const c = dirC[px];
        const s = dirS[px];
        const pc = comp[px];
        const bi = Math.max(0, Math.min(gx - 1, Math.floor((x - box.x0) / g)));
        const bj = Math.max(0, Math.min(gy - 1, Math.floor((y - box.y0) / g)));
        let best = -1;
        let bestD = Infinity;
        for (let pass = 0; pass < 2 && best < 0; pass++) {
          for (let r = 0; r <= maxRing; r++) {
            if (best >= 0 && (r - 1) * g > Math.sqrt(bestD) * reachK) break;
            for (let jj = bj - r; jj <= bj + r; jj++) {
              if (jj < 0 || jj >= gy) continue;
              const edgeRow = jj === bj - r || jj === bj + r;
              for (let ii = bi - r; ii <= bi + r; ii += edgeRow ? 1 : 2 * r || 1) {
                if (ii < 0 || ii >= gx) continue;
                for (const si of buckets[jj * gx + ii]) {
                  // Walls: only sites in this pixel's own piece (second pass: any site).
                  if (pass === 0 && pc >= 0 && comps[si] >= 0 && comps[si] !== pc) continue;
                  const dx = sites[si][0] - x;
                  const dy = sites[si][1] - y;
                  const along = (dx * c + dy * s) / k;
                  const across = -dx * s + dy * c;
                  const d = along * along + across * across;
                  if (d < bestD) {
                    bestD = d;
                    best = si;
                  }
                }
              }
            }
          }
        }
        labels[px] = best;
      }
    }
  };
  assign();
  for (let it = 0; it < Math.max(0, Math.round(o.relax)); it++) {
    const sx = new Float64Array(sites.length);
    const sy = new Float64Array(sites.length);
    const sn = new Float64Array(sites.length);
    for (let px = 0; px < N; px++) {
      const l = labels[px];
      if (l < 0) continue;
      const i = px % nx;
      sx[l] += ox + (i + 0.5) * h;
      sy[l] += oy + ((px - i) / nx + 0.5) * h;
      sn[l]++;
    }
    for (let l = 0; l < sites.length; l++) if (sn[l] > 0) sites[l] = [sx[l] / sn[l], sy[l] / sn[l]];
    assign();
  }

  // One piece per cell, and no cell enclosed in another (a cell cannot carry a hole): stray
  // pieces and enclosed cells join the neighbour they share the longest border with.
  for (let pass = 0; pass < 6; pass++) {
    const piece = new Int32Array(N).fill(-1);
    const pieceLabel: number[] = [];
    const pieceSize: number[] = [];
    const pieceNbr: Map<number, number>[] = [];
    const queue = new Int32Array(N);
    for (let start = 0; start < N; start++) {
      const l = labels[start];
      if (l < 0 || piece[start] >= 0) continue;
      const id = pieceLabel.length;
      const nbr = new Map<number, number>();
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      piece[start] = id;
      while (head < tail) {
        const px = queue[head++];
        const i = px % nx;
        const j = (px - i) / nx;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + di;
          const jj = j + dj;
          const q = ii < 0 || jj < 0 || ii >= nx || jj >= ny ? -1 : jj * nx + ii;
          const lq = q < 0 ? -1 : labels[q];
          if (lq === l) {
            if (piece[q] < 0) {
              piece[q] = id;
              queue[tail++] = q;
            }
          } else nbr.set(lq, (nbr.get(lq) ?? 0) + 1);
        }
      }
      pieceLabel.push(l);
      pieceSize.push(tail);
      pieceNbr.push(nbr);
    }
    const largest = new Map<number, number>();
    pieceLabel.forEach((l, id) => {
      const best = largest.get(l);
      if (best === undefined || pieceSize[id] > pieceSize[best]) largest.set(l, id);
    });
    const target = new Int32Array(pieceLabel.length).fill(-1);
    let changed = false;
    pieceLabel.forEach((l, id) => {
      const nbr = pieceNbr[id];
      const enclosed = !nbr.has(-1) && nbr.size === 1;
      if (largest.get(l) === id && !enclosed) return;
      let best = -1;
      let bestN = 0;
      for (const [lq, cnt] of nbr) {
        if (lq >= 0 && cnt > bestN) {
          best = lq;
          bestN = cnt;
        }
      }
      if (best >= 0) {
        target[id] = best;
        changed = true;
      }
    });
    if (!changed) break;
    for (let px = 0; px < N; px++) if (piece[px] >= 0 && target[piece[px]] >= 0) labels[px] = target[piece[px]];
  }

  // Pixel borders between different labels, on the lattice of pixel corners.
  const W = nx + 1;
  const lab = (i: number, j: number): number => (i < 0 || j < 0 || i >= nx || j >= ny ? -1 : labels[j * nx + i]);
  const compOf = (l: number): number => (l < 0 ? -1 : siteComp(l));
  type Kind = 0 | 1 | 2; // 0 cross, 1 outline, 2 wall
  const ea: number[] = [];
  const eb: number[] = [];
  const el: number[] = [];
  const er: number[] = [];
  const ek: Kind[] = [];
  const addEdge = (a: number, b: number, l: number, r: number): void => {
    if (l === r) return;
    ea.push(a);
    eb.push(b);
    el.push(l);
    er.push(r);
    const cl = compOf(l);
    const cr = compOf(r);
    ek.push(l < 0 || r < 0 ? 1 : cl >= 0 && cr >= 0 && cl !== cr ? 2 : 0);
  };
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      // Horizontal edge (i,j)→(i+1,j): pixel above on its left.
      if (i < nx) addEdge(j * W + i, j * W + i + 1, lab(i, j), lab(i, j - 1));
      // Vertical edge (i,j)→(i,j+1): pixel to the left on its left.
      if (j < ny) addEdge(j * W + i, (j + 1) * W + i, lab(i - 1, j), lab(i, j));
    }
  }
  const NC = W * (ny + 1);
  const deg = new Uint8Array(NC);
  const snap = new Uint8Array(NC); // bit 1 outline, bit 2 wall
  const inc: number[][] = new Array(NC);
  for (let e = 0; e < ea.length; e++) {
    for (const cIdx of [ea[e], eb[e]]) {
      deg[cIdx]++;
      (inc[cIdx] ??= []).push(e);
      if (ek[e] === 1) snap[cIdx] |= 1;
      else if (ek[e] === 2) snap[cIdx] |= 2;
    }
  }
  const pos = new Float64Array(NC * 2);
  for (let c = 0; c < NC; c++) {
    const i = c % W;
    pos[c * 2] = ox + i * h;
    pos[c * 2 + 1] = oy + ((c - i) / W) * h;
  }
  const active: number[] = [];
  for (let c = 0; c < NC; c++) if (deg[c] > 0) active.push(c);
  const toWall = (p: P2): P2 => {
    let q = p;
    let bestD = Infinity;
    for (const w of walls) {
      const cand = nearestOnPolyline(p, w, false);
      const d = (cand[0] - p[0]) ** 2 + (cand[1] - p[1]) ** 2;
      if (d < bestD) {
        bestD = d;
        q = cand;
      }
    }
    return q;
  };
  const project = (c: number): void => {
    let p: P2 = [pos[c * 2], pos[c * 2 + 1]];
    // On both (where a wall meets the outline): alternate, converging on the crossing.
    const rounds = snap[c] === 3 ? 6 : 1;
    for (let r = 0; r < rounds; r++) {
      if (snap[c] & 2) p = toWall(p);
      if (snap[c] & 1) p = nearestOnPolyline(p, outline, true);
    }
    pos[c * 2] = p[0];
    pos[c * 2 + 1] = p[1];
  };
  const other = (e: number, c: number): number => (ea[e] === c ? eb[e] : ea[e]);
  for (const c of active) project(c);
  const tmp = new Float64Array(NC * 2);
  for (let it = 0; it < 10; it++) {
    for (const c of active) {
      if (deg[c] !== 2) continue;
      const [e0, e1] = inc[c];
      const a = other(e0, c);
      const b = other(e1, c);
      tmp[c * 2] = 0.5 * pos[c * 2] + 0.25 * (pos[a * 2] + pos[b * 2]);
      tmp[c * 2 + 1] = 0.5 * pos[c * 2 + 1] + 0.25 * (pos[a * 2 + 1] + pos[b * 2 + 1]);
    }
    for (const c of active) {
      if (deg[c] !== 2) continue;
      pos[c * 2] = tmp[c * 2];
      pos[c * 2 + 1] = tmp[c * 2 + 1];
      if (snap[c]) project(c);
    }
  }

  // Polylines junction to junction; simplification decides the kept corners for everyone.
  const keep = new Uint8Array(NC);
  const used = new Uint8Array(ea.length);
  const crossEdges: P2[][] = [];
  const wallEdges: P2[][] = [];
  const walk = (start: number, from: number, seq: number[]): void => {
    let c = start;
    let e = from;
    while (deg[c] === 2) {
      const nextE = inc[c][0] === e ? inc[c][1] : inc[c][0];
      if (used[nextE]) break;
      used[nextE] = 1;
      c = other(nextE, c);
      e = nextE;
      seq.push(c);
    }
  };
  const tol = h * 0.2;
  for (let e = 0; e < ea.length; e++) {
    if (used[e]) continue;
    used[e] = 1;
    const fwd = [ea[e], eb[e]];
    walk(eb[e], e, fwd);
    const back: number[] = [];
    walk(ea[e], e, back);
    const seq = [...back.reverse(), ...fwd];
    simplify(seq, pos, tol, keep);
    if (ek[e] === 1) continue;
    const line = seq.filter((c) => keep[c]).map((c): P2 => [pos[c * 2], pos[c * 2 + 1]]);
    (ek[e] === 2 ? wallEdges : crossEdges).push(line);
  }
  for (let c = 0; c < NC; c++) if (deg[c] > 0 && deg[c] !== 2) keep[c] = 1;

  // Each label's border loops, its pixels on the left.
  const out = new Map<number, number[]>();
  const dirKey = (corner: number, label: number) => label * NC + corner;
  const dirFrom: number[] = [];
  const dirTo: number[] = [];
  const dirLab: number[] = [];
  for (let e = 0; e < ea.length; e++) {
    for (const [a, b, l] of [[ea[e], eb[e], el[e]], [eb[e], ea[e], er[e]]]) {
      if (l < 0) continue;
      const id = dirFrom.length;
      dirFrom.push(a);
      dirTo.push(b);
      dirLab.push(l);
      const key = dirKey(a, l);
      const list = out.get(key);
      if (list) list.push(id);
      else out.set(key, [id]);
    }
  }
  const dirUsed = new Uint8Array(dirFrom.length);
  const cells: { site: number; verts: P2[] }[] = [];
  for (let d = 0; d < dirFrom.length; d++) {
    if (dirUsed[d]) continue;
    const l = dirLab[d];
    const loop: number[] = [];
    let cur = d;
    while (cur >= 0 && !dirUsed[cur]) {
      dirUsed[cur] = 1;
      loop.push(dirFrom[cur]);
      const nexts = out.get(dirKey(dirTo[cur], l)) ?? [];
      cur = nexts.find((n) => !dirUsed[n]) ?? -1;
    }
    const verts = untangle(loop.filter((c) => keep[c]).map((c): P2 => [pos[c * 2], pos[c * 2 + 1]]));
    if (verts.length < 3) continue;
    // Positive loops are pieces of the cell (a turning field can split one in two); negative ones are holes.
    if (polygonArea(verts) > h * h * 0.5) cells.push({ site: l, verts });
  }
  cells.sort((a, b) => a.site - b.site);
  return { sites, cells, crossEdges, wallEdges };
}

/** Splits a closed ring where it turns sharply (at least two pieces), so each side of a narrow region is its own wall. */
export function splitRing(ring: P2[], maxTurnDeg = 40): P2[][] {
  const n = ring.length;
  if (n < 3) return [];
  const cos = Math.cos((maxTurnDeg * Math.PI) / 180);
  const corners: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[(i + n - 1) % n];
    const b = ring[i];
    const c = ring[(i + 1) % n];
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const vx = c[0] - b[0];
    const vy = c[1] - b[1];
    const d = (ux * vx + uy * vy) / ((Math.hypot(ux, uy) || 1) * (Math.hypot(vx, vy) || 1));
    if (d < cos) corners.push(i);
  }
  if (corners.length < 2) {
    // A smooth ring: cut it at its two most distant vertices.
    let far = { i: 0, j: 0, d: -1 };
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = (ring[i][0] - ring[j][0]) ** 2 + (ring[i][1] - ring[j][1]) ** 2;
        if (d > far.d) far = { i, j, d };
      }
    }
    corners.splice(0, corners.length, far.i, far.j);
  }
  const pieces: P2[][] = [];
  for (let k = 0; k < corners.length; k++) {
    const s = corners[k];
    const e = corners[(k + 1) % corners.length];
    const piece: P2[] = [];
    for (let i = s; ; i = (i + 1) % n) {
      piece.push(ring[i]);
      if (i === e) break;
    }
    if (piece.length >= 2) pieces.push(piece);
  }
  return pieces;
}
