import { MeshBuffers, uvAndBounds } from "./marchingCubes";

/**
 * Blob elements → indexed surface, as a plain function over typed arrays (the
 * Rust build, wasm/kernels/src/surface_nets.rs, computes the same thing bit
 * for bit — surfaceNets.test.ts compares them).
 *
 * The field is a sum of compact bumps, one per element:
 *
 *   f(p) = Σ wᵢ · (1 − dᵢ(p)² / Rᵢ²)³    where dᵢ < Rᵢ, else 0
 *
 * dᵢ is the distance from p to the element's core — a point (sphere), a point
 * seen through a 3×3 matrix (ellipsoid) or a segment (capsule) — and Rᵢ its
 * reach. Each bump is exactly zero past its reach, so an element only costs
 * the cells it touches, and the surface is f = iso. The node picks iso so a
 * lone element's surface sits exactly at its radius (see blobIso).
 *
 * Meshed with naive Surface Nets: one vertex per cell the surface crosses
 * (the mean of the cell's edge crossings), one quad per crossed grid edge
 * joining the four cells around it. Vertices are shared, so the mesh is
 * indexed and smooth-shaded; normals are the field's analytic gradient.
 *
 * Only bricks of BRICK³ cells that some positive element reaches are ever
 * sampled, so the grid can be far finer than a dense one for the same cost,
 * and its box is fitted to the elements rather than a cube.
 */

/** Element layout in `elements`, BLOB_STRIDE doubles each. */
export const BLOB_STRIDE = 28;
export const BLOB_KIND = 0;
/** Core start (point / ellipsoid centre, segment start). */
export const BLOB_A = 1;
/** Segment end (ignored for points). */
export const BLOB_B = 4;
/** Row-major 3×3 applied to (p − core) before measuring — read for ellipsoids only. */
export const BLOB_M = 7;
/** World AABB of the element's reach: min xyz, max xyz. */
export const BLOB_AABB = 16;
export const BLOB_REACH = 22;
/** Signed: below zero carves. */
export const BLOB_WEIGHT = 23;
export const BLOB_COLOR = 24;
/** Colour of a carving element that has none: it then leaves the colours around it alone. */
export const BLOB_NO_COLOR = -1;
/**
 * Chain id, 0 for none. Consecutive elements sharing one (a polyline's
 * capsules) count as a single element: at each point the segment reaching
 * furthest in wins instead of their bumps adding up, so a tube has no bulge
 * at its joints. A chain's elements must be contiguous.
 */
export const BLOB_CHAIN = 27;

export const BLOB_POINT = 0;
export const BLOB_SEGMENT = 1;
/** Stored kind of a point with a shape matrix; specs say BLOB_POINT plus `shape`. Points and segments skip the matrix. */
export const BLOB_ELLIPSOID = 2;

/** Cells per brick edge. */
export const BRICK = 8;
/** Empty cells kept around the elements' reach, so the outermost grid samples are always outside. */
const PAD = 2;

export interface BlobsJob {
  elements: Float64Array;
  /** Field value the surface is extracted at. */
  iso: number;
  /** Cells along the longest side of the elements' box. */
  resolution: number;
  maxVertices: number;
  maxIndices: number;
  /** Blend each vertex's colour from the elements around it. */
  colors: boolean;
  uvDensity: number;
}

/** The sampling grid a job meshes over: what both kernels are handed, so they agree on it exactly. */
export interface BlobGrid {
  originX: number;
  originY: number;
  originZ: number;
  cell: number;
  nx: number;
  ny: number;
  nz: number;
}

/** The iso level at which a lone element of reach radius × smooth has its surface at radius. */
export function blobIso(smooth: number): number {
  const q = 1 - 1 / (smooth * smooth);
  return q * q * q;
}

/** Null when no element adds to the field (nothing can be inside). */
export function blobGrid(job: BlobsJob): BlobGrid | null {
  const e = job.elements;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i + BLOB_STRIDE <= e.length; i += BLOB_STRIDE) {
    if (!(e[i + BLOB_WEIGHT] > 0)) continue;
    const o = i + BLOB_AABB;
    if (e[o] < minX) minX = e[o];
    if (e[o + 1] < minY) minY = e[o + 1];
    if (e[o + 2] < minZ) minZ = e[o + 2];
    if (e[o + 3] > maxX) maxX = e[o + 3];
    if (e[o + 4] > maxY) maxY = e[o + 4];
    if (e[o + 5] > maxZ) maxZ = e[o + 5];
  }
  if (!(maxX >= minX)) return null;
  const longest = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
  const resolution = Math.max(1, Math.floor(job.resolution));
  const cell = longest / resolution;
  const span = (lo: number, hi: number) => Math.min(resolution, Math.ceil((hi - lo) / cell)) + 2 * PAD;
  return {
    originX: minX - PAD * cell,
    originY: minY - PAD * cell,
    originZ: minZ - PAD * cell,
    cell,
    nx: span(minX, maxX),
    ny: span(minY, maxY),
    nz: span(minZ, maxZ),
  };
}

/** Corner offsets of a cell, corner c = x + 2y + 4z. */
const EDGES: ReadonlyArray<readonly [number, number, number]> = [
  // [corner a, corner b, axis]
  [0, 1, 0], [2, 3, 0], [4, 5, 0], [6, 7, 0],
  [0, 2, 1], [1, 3, 1], [4, 6, 1], [5, 7, 1],
  [0, 4, 2], [1, 5, 2], [2, 6, 2], [3, 7, 2],
];

interface Scratch {
  samples: Float64Array;
  /** Per surface brick: BRICK³ vertex indices (−1 none). */
  vertexOf: Int32Array[];
  /** Per surface brick: BRICK³ bytes — bit 0 the cell's min corner is inside, bits 1–3 its +x/+y/+z edge crosses. */
  edgeBits: Uint8Array[];
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  index: Uint32Array;
}

const S1 = BRICK + 1;
const scratch: Scratch = {
  samples: new Float64Array(S1 * S1 * S1),
  vertexOf: [],
  edgeBits: [],
  position: new Float32Array(3 * 4096),
  normal: new Float32Array(3 * 4096),
  color: new Float32Array(3 * 4096),
  index: new Uint32Array(6 * 4096),
};

function growFloat(a: Float32Array, min: number): Float32Array {
  let n = a.length * 2;
  while (n < min) n *= 2;
  const b = new Float32Array(n);
  b.set(a);
  return b;
}

function growIndex(a: Uint32Array, min: number): Uint32Array {
  let n = a.length * 2;
  while (n < min) n *= 2;
  const b = new Uint32Array(n);
  b.set(a);
  return b;
}

/** How far in p is along the element's bump: 1 − d²/R² inside its reach, 0 outside. */
function qAt(e: Float64Array, o: number, len2: number, px: number, py: number, pz: number): number {
  let dx = px - e[o + BLOB_A];
  let dy = py - e[o + BLOB_A + 1];
  let dz = pz - e[o + BLOB_A + 2];
  if (e[o + BLOB_KIND] === BLOB_SEGMENT && len2 > 0) {
    const sx = e[o + BLOB_B] - e[o + BLOB_A];
    const sy = e[o + BLOB_B + 1] - e[o + BLOB_A + 1];
    const sz = e[o + BLOB_B + 2] - e[o + BLOB_A + 2];
    let t = (dx * sx + dy * sy + dz * sz) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    dx = dx - t * sx;
    dy = dy - t * sy;
    dz = dz - t * sz;
  }
  let d2: number;
  if (e[o + BLOB_KIND] === BLOB_ELLIPSOID) {
    const m = o + BLOB_M;
    const ux = e[m] * dx + e[m + 1] * dy + e[m + 2] * dz;
    const uy = e[m + 3] * dx + e[m + 4] * dy + e[m + 5] * dz;
    const uz = e[m + 6] * dx + e[m + 7] * dy + e[m + 8] * dz;
    d2 = ux * ux + uy * uy + uz * uz;
  } else {
    d2 = dx * dx + dy * dy + dz * dz;
  }
  const r = e[o + BLOB_REACH];
  const r2 = r * r;
  if (!(d2 < r2)) return 0;
  return 1 - d2 / r2;
}

/** The brick-local sample range [x0..x1] × [y0..y1] × [z0..z1] inside element o's box (empty when x0 > x1, …). */
function localRange(e: Float64Array, o: number, g: BlobGrid, gx0: number, gy0: number, gz0: number, out: Int32Array): void {
  const a = o + BLOB_AABB;
  const h = g.cell;
  out[0] = Math.max(0, Math.ceil((e[a] - g.originX) / h) - gx0);
  out[1] = Math.max(0, Math.ceil((e[a + 1] - g.originY) / h) - gy0);
  out[2] = Math.max(0, Math.ceil((e[a + 2] - g.originZ) / h) - gz0);
  out[3] = Math.min(BRICK, Math.floor((e[a + 3] - g.originX) / h) - gx0);
  out[4] = Math.min(BRICK, Math.floor((e[a + 4] - g.originY) / h) - gy0);
  out[5] = Math.min(BRICK, Math.floor((e[a + 5] - g.originZ) / h) - gz0);
}

export function polygonizeBlobs(job: BlobsJob): MeshBuffers {
  const grid = blobGrid(job);
  if (!grid) return uvAndBounds(new Float32Array(0), new Float32Array(0), 0, job.uvDensity);
  const r = runBlobs(job, grid);
  const count = r.vertices;
  return {
    ...uvAndBounds(scratch.position.slice(0, count * 3), scratch.normal.slice(0, count * 3), count, job.uvDensity),
    index: scratch.index.slice(0, r.indices),
    color: job.colors ? scratch.color.slice(0, count * 3) : undefined,
  };
}

function runBlobs(job: BlobsJob, g: BlobGrid): { vertices: number; indices: number } {
  const e = job.elements;
  const elementCount = Math.floor(e.length / BLOB_STRIDE);
  const iso = job.iso;
  const h = g.cell;
  const bh = h * BRICK;
  const nbx = Math.ceil(g.nx / BRICK);
  const nby = Math.ceil(g.ny / BRICK);
  const nbz = Math.ceil(g.nz / BRICK);
  const brickCount = nbx * nby * nbz;

  const segLen2 = new Float64Array(elementCount);
  // Brick range each element reaches, one cell wider each side: every cell
  // touching a sample inside a positive element's reach then lies in an
  // active brick, so no crossed edge is ever missing one of its four cells.
  const ranges = new Int32Array(elementCount * 6);
  const clampB = (v: number, n: number) => (v < 0 ? 0 : v >= n ? n - 1 : v);
  const active = new Uint8Array(brickCount);
  const listCount = new Int32Array(brickCount + 1);
  for (let id = 0; id < elementCount; id++) {
    const o = id * BLOB_STRIDE;
    const sx = e[o + BLOB_B] - e[o + BLOB_A];
    const sy = e[o + BLOB_B + 1] - e[o + BLOB_A + 1];
    const sz = e[o + BLOB_B + 2] - e[o + BLOB_A + 2];
    segLen2[id] = sx * sx + sy * sy + sz * sz;
    const a = o + BLOB_AABB;
    const x0 = clampB(Math.floor((e[a] - h - g.originX) / bh), nbx);
    const y0 = clampB(Math.floor((e[a + 1] - h - g.originY) / bh), nby);
    const z0 = clampB(Math.floor((e[a + 2] - h - g.originZ) / bh), nbz);
    const x1 = clampB(Math.floor((e[a + 3] + h - g.originX) / bh), nbx);
    const y1 = clampB(Math.floor((e[a + 4] + h - g.originY) / bh), nby);
    const z1 = clampB(Math.floor((e[a + 5] + h - g.originZ) / bh), nbz);
    ranges.set([x0, y0, z0, x1, y1, z1], id * 6);
    const positive = e[o + BLOB_WEIGHT] > 0;
    for (let bz = z0; bz <= z1; bz++)
      for (let by = y0; by <= y1; by++)
        for (let bx = x0; bx <= x1; bx++) {
          const b = bx + nbx * (by + nby * bz);
          if (positive) active[b] = 1;
          listCount[b + 1]++;
        }
  }
  // Per-brick element lists (CSR), in element order so the field sums in the same order everywhere.
  for (let b = 0; b < brickCount; b++) listCount[b + 1] += listCount[b];
  const list = new Int32Array(listCount[brickCount]);
  const fill = listCount.slice(0, brickCount);
  for (let id = 0; id < elementCount; id++) {
    const r = id * 6;
    for (let bz = ranges[r + 2]; bz <= ranges[r + 5]; bz++)
      for (let by = ranges[r + 1]; by <= ranges[r + 4]; by++)
        for (let bx = ranges[r]; bx <= ranges[r + 3]; bx++) list[fill[bx + nbx * (by + nby * bz)]++] = id;
  }

  const s = scratch;
  const samples = s.samples;
  const slot = new Int32Array(brickCount).fill(-1);
  let surfaceBricks = 0;
  let vertices = 0;
  const maxVertices = job.maxVertices;
  const colors = job.colors;
  const corner = new Float64Array(8);
  const range = new Int32Array(6);
  const chainQ = new Float64Array(S1 * S1 * S1);
  const chainW = new Float64Array(S1 * S1 * S1);

  for (let bz = 0; bz < nbz; bz++)
    for (let by = 0; by < nby; by++)
      for (let bx = 0; bx < nbx; bx++) {
        const b = bx + nbx * (by + nby * bz);
        if (!active[b]) continue;
        const from = listCount[b];
        const to = listCount[b + 1];
        const gx0 = bx * BRICK;
        const gy0 = by * BRICK;
        const gz0 = bz * BRICK;
        // Splat each element over only the samples inside its box, in element
        // order — every sample still sums its elements in the same order. A
        // chain is splatted into chainQ/chainW (best q per sample) first, then
        // added as one bump.
        samples.fill(0);
        for (let k = from; k < to; ) {
          const chain = e[list[k] * BLOB_STRIDE + BLOB_CHAIN];
          let end = k + 1;
          if (chain > 0) while (end < to && e[list[end] * BLOB_STRIDE + BLOB_CHAIN] === chain) end++;
          if (chain > 0) {
            chainQ.fill(0);
            for (let c = k; c < end; c++) {
              const id = list[c];
              const o = id * BLOB_STRIDE;
              const w = e[o + BLOB_WEIGHT];
              localRange(e, o, g, gx0, gy0, gz0, range);
              for (let lz = range[2]; lz <= range[5]; lz++) {
                const pz = g.originZ + (gz0 + lz) * h;
                for (let ly = range[1]; ly <= range[4]; ly++) {
                  const py = g.originY + (gy0 + ly) * h;
                  for (let lx = range[0]; lx <= range[3]; lx++) {
                    const px = g.originX + (gx0 + lx) * h;
                    const q = qAt(e, o, segLen2[id], px, py, pz);
                    const i = lx + S1 * (ly + S1 * lz);
                    if (q > chainQ[i]) {
                      chainQ[i] = q;
                      chainW[i] = w;
                    }
                  }
                }
              }
            }
            for (let i = 0; i < S1 * S1 * S1; i++) {
              const q = chainQ[i];
              if (q > 0) samples[i] += chainW[i] * q * q * q;
            }
          } else {
            const id = list[k];
            const o = id * BLOB_STRIDE;
            const w = e[o + BLOB_WEIGHT];
            localRange(e, o, g, gx0, gy0, gz0, range);
            for (let lz = range[2]; lz <= range[5]; lz++) {
              const pz = g.originZ + (gz0 + lz) * h;
              for (let ly = range[1]; ly <= range[4]; ly++) {
                const py = g.originY + (gy0 + ly) * h;
                for (let lx = range[0]; lx <= range[3]; lx++) {
                  const px = g.originX + (gx0 + lx) * h;
                  const q = qAt(e, o, segLen2[id], px, py, pz);
                  if (q > 0) samples[lx + S1 * (ly + S1 * lz)] += w * q * q * q;
                }
              }
            }
          }
          k = end;
        }
        let inside = 0;
        for (let i = 0; i < S1 * S1 * S1; i++) {
          const v = samples[i] - iso;
          samples[i] = v;
          if (v > 0) inside++;
        }
        if (inside === 0 || inside === S1 * S1 * S1) continue;

        const sb = surfaceBricks++;
        slot[b] = sb;
        if (!s.vertexOf[sb]) {
          s.vertexOf[sb] = new Int32Array(BRICK * BRICK * BRICK);
          s.edgeBits[sb] = new Uint8Array(BRICK * BRICK * BRICK);
        }
        const vertexOf = s.vertexOf[sb];
        const edgeBits = s.edgeBits[sb];
        vertexOf.fill(-1);
        edgeBits.fill(0);

        for (let lz = 0; lz < BRICK; lz++) {
          const cz = gz0 + lz;
          if (cz >= g.nz) break;
          for (let ly = 0; ly < BRICK; ly++) {
            const cy = gy0 + ly;
            if (cy >= g.ny) break;
            for (let lx = 0; lx < BRICK; lx++) {
              const cx = gx0 + lx;
              if (cx >= g.nx) break;
              let mask = 0;
              for (let c = 0; c < 8; c++) {
                const v = samples[lx + (c & 1) + S1 * (ly + ((c >> 1) & 1) + S1 * (lz + (c >> 2)))];
                corner[c] = v;
                if (v > 0) mask |= 1 << c;
              }
              const cellIndex = lx + BRICK * (ly + BRICK * lz);
              edgeBits[cellIndex] =
                (mask & 1) | (((mask ^ (mask >> 1)) & 1) << 1) | (((mask ^ (mask >> 2)) & 1) << 2) | (((mask ^ (mask >> 4)) & 1) << 3);
              if (mask === 0 || mask === 255 || vertices >= maxVertices) continue;

              let ox = 0, oy = 0, oz = 0, crossings = 0;
              for (let k = 0; k < 12; k++) {
                const [ca, cb, axis] = EDGES[k];
                const va = corner[ca];
                const vb = corner[cb];
                if (va > 0 === vb > 0) continue;
                const mu = va / (va - vb);
                const ax = ca & 1, ay = (ca >> 1) & 1, az = ca >> 2;
                ox += axis === 0 ? mu : ax;
                oy += axis === 1 ? mu : ay;
                oz += axis === 2 ? mu : az;
                crossings++;
              }
              const vx = g.originX + (cx + ox / crossings) * h;
              const vy = g.originY + (cy + oy / crossings) * h;
              const vz = g.originZ + (cz + oz / crossings) * h;
              writeVertex(e, list, from, to, segLen2, vx, vy, vz, vertices, colors, iso);
              vertexOf[cellIndex] = vertices++;
            }
          }
        }
      }

  // Faces: every crossed grid edge joins the four cells around it.
  let indices = 0;
  const maxIndices = job.maxIndices;
  const vertexAt = (cx: number, cy: number, cz: number): number => {
    if (cx < 0 || cy < 0 || cz < 0) return -1;
    const b = (cx >> 3) + nbx * ((cy >> 3) + nby * (cz >> 3));
    const sb = slot[b];
    if (sb < 0) return -1;
    return s.vertexOf[sb][(cx & 7) + BRICK * ((cy & 7) + BRICK * (cz & 7))];
  };
  const quad = (v0: number, v1: number, v2: number, v3: number) => {
    if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0 || indices + 6 > maxIndices) return;
    if (indices + 6 > s.index.length) s.index = growIndex(s.index, indices + 6);
    const ix = s.index;
    ix[indices] = v0;
    ix[indices + 1] = v1;
    ix[indices + 2] = v2;
    ix[indices + 3] = v0;
    ix[indices + 4] = v2;
    ix[indices + 5] = v3;
    indices += 6;
  };
  for (let b = 0; b < brickCount; b++) {
    const sb = slot[b];
    if (sb < 0) continue;
    const bx = b % nbx;
    const by = Math.floor(b / nbx) % nby;
    const bz = Math.floor(b / (nbx * nby));
    const edgeBits = s.edgeBits[sb];
    for (let lz = 0; lz < BRICK; lz++)
      for (let ly = 0; ly < BRICK; ly++)
        for (let lx = 0; lx < BRICK; lx++) {
          const bits = edgeBits[lx + BRICK * (ly + BRICK * lz)];
          if (bits < 2) continue;
          const cx = bx * BRICK + lx;
          const cy = by * BRICK + ly;
          const cz = bz * BRICK + lz;
          const inside = (bits & 1) === 1;
          // Winding: counter-clockwise seen from outside, i.e. from the side of the edge's outer end.
          if (bits & 2) {
            const a = vertexAt(cx, cy - 1, cz - 1), c = vertexAt(cx, cy, cz - 1), d = vertexAt(cx, cy, cz), f = vertexAt(cx, cy - 1, cz);
            if (inside) quad(a, c, d, f);
            else quad(a, f, d, c);
          }
          if (bits & 4) {
            const a = vertexAt(cx - 1, cy, cz - 1), c = vertexAt(cx - 1, cy, cz), d = vertexAt(cx, cy, cz), f = vertexAt(cx, cy, cz - 1);
            if (inside) quad(a, c, d, f);
            else quad(a, f, d, c);
          }
          if (bits & 8) {
            const a = vertexAt(cx - 1, cy - 1, cz), c = vertexAt(cx, cy - 1, cz), d = vertexAt(cx, cy, cz), f = vertexAt(cx - 1, cy, cz);
            if (inside) quad(a, c, d, f);
            else quad(a, f, d, c);
          }
        }
  }
  return { vertices, indices };
}

/** Position, analytic normal (−∇f, normalised) and blended colour of vertex v. */
function writeVertex(
  e: Float64Array,
  list: Int32Array,
  from: number,
  to: number,
  segLen2: Float64Array,
  px: number,
  py: number,
  pz: number,
  v: number,
  colors: boolean,
  iso: number,
): void {
  let gx = 0, gy = 0, gz = 0;
  let cw = 0, cr = 0, cg = 0, cb = 0;
  let nw = 0, nr = 0, ng = 0, nb = 0;
  for (let k = from; k < to; ) {
    let id = list[k];
    const chain = e[id * BLOB_STRIDE + BLOB_CHAIN];
    let end = k + 1;
    if (chain > 0) {
      // A chain counts once: through the segment reaching furthest in here.
      while (end < to && e[list[end] * BLOB_STRIDE + BLOB_CHAIN] === chain) end++;
      let best = 0;
      for (let c = k; c < end; c++) {
        const q = qAt(e, list[c] * BLOB_STRIDE, segLen2[list[c]], px, py, pz);
        if (q > best) {
          best = q;
          id = list[c];
        }
      }
    }
    k = end;
    const o = id * BLOB_STRIDE;
    const a = o + BLOB_AABB;
    if (px < e[a] || py < e[a + 1] || pz < e[a + 2] || px > e[a + 3] || py > e[a + 4] || pz > e[a + 5]) continue;
    let dx = px - e[o + BLOB_A];
    let dy = py - e[o + BLOB_A + 1];
    let dz = pz - e[o + BLOB_A + 2];
    if (e[o + BLOB_KIND] === BLOB_SEGMENT) {
      const len2 = segLen2[id];
      if (len2 > 0) {
        const sx = e[o + BLOB_B] - e[o + BLOB_A];
        const sy = e[o + BLOB_B + 1] - e[o + BLOB_A + 1];
        const sz = e[o + BLOB_B + 2] - e[o + BLOB_A + 2];
        let t = (dx * sx + dy * sy + dz * sz) / len2;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        dx = dx - t * sx;
        dy = dy - t * sy;
        dz = dz - t * sz;
      }
    }
    const ellipsoid = e[o + BLOB_KIND] === BLOB_ELLIPSOID;
    const m = o + BLOB_M;
    let ux = dx, uy = dy, uz = dz;
    if (ellipsoid) {
      ux = e[m] * dx + e[m + 1] * dy + e[m + 2] * dz;
      uy = e[m + 3] * dx + e[m + 4] * dy + e[m + 5] * dz;
      uz = e[m + 6] * dx + e[m + 7] * dy + e[m + 8] * dz;
    }
    const d2 = ux * ux + uy * uy + uz * uz;
    const r = e[o + BLOB_REACH];
    const r2 = r * r;
    if (!(d2 < r2)) continue;
    const q = 1 - d2 / r2;
    const w = e[o + BLOB_WEIGHT];
    // d f / d p = w · 3q² · (−1/R²) · ∇(d²), and ∇(d²) = 2 Mᵀ u (M = I but for ellipsoids).
    const coef = (w * 3 * q * q * -2) / r2;
    if (ellipsoid) {
      gx += coef * (e[m] * ux + e[m + 3] * uy + e[m + 6] * uz);
      gy += coef * (e[m + 1] * ux + e[m + 4] * uy + e[m + 7] * uz);
      gz += coef * (e[m + 2] * ux + e[m + 5] * uy + e[m + 8] * uz);
    } else {
      gx += coef * ux;
      gy += coef * uy;
      gz += coef * uz;
    }
    if (colors && w > 0) {
      const f = w * q * q * q;
      cw += f;
      cr += f * e[o + BLOB_COLOR];
      cg += f * e[o + BLOB_COLOR + 1];
      cb += f * e[o + BLOB_COLOR + 2];
    } else if (colors && e[o + BLOB_COLOR] >= 0) {
      // A carving element with a colour (BLOB_NO_COLOR otherwise) tints the surface it cuts.
      const f = -w * q * q * q;
      nw += f;
      nr += f * e[o + BLOB_COLOR];
      ng += f * e[o + BLOB_COLOR + 1];
      nb += f * e[o + BLOB_COLOR + 2];
    }
  }
  const s = scratch;
  const i = v * 3;
  if (i + 3 > s.position.length) {
    s.position = growFloat(s.position, i + 3);
    s.normal = growFloat(s.normal, i + 3);
    s.color = growFloat(s.color, i + 3);
  }
  s.position[i] = px;
  s.position[i + 1] = py;
  s.position[i + 2] = pz;
  const len = Math.sqrt(gx * gx + gy * gy + gz * gz);
  if (len > 0) {
    s.normal[i] = -gx / len;
    s.normal[i + 1] = -gy / len;
    s.normal[i + 2] = -gz / len;
  } else {
    s.normal[i] = 0;
    s.normal[i + 1] = 1;
    s.normal[i + 2] = 0;
  }
  if (colors) {
    let r = 1, g = 1, b = 1;
    if (cw > 0) {
      r = cr / cw;
      g = cg / cw;
      b = cb / cw;
    }
    if (nw > 0) {
      // How much was carved here, against the iso level: 0 on an intact
      // surface, 1 once the carvers alone would have reached it — the rim of
      // a cut fades into its own colour, the bottom takes it fully.
      const t = nw / iso < 1 ? nw / iso : 1;
      r = r + (nr / nw - r) * t;
      g = g + (ng / nw - g) * t;
      b = b + (nb / nw - b) * t;
    }
    s.color[i] = r;
    s.color[i + 1] = g;
    s.color[i + 2] = b;
  }
}

export interface BlobElementSpec {
  kind: typeof BLOB_POINT | typeof BLOB_SEGMENT;
  a: readonly [number, number, number];
  /** Segment end; ignored for points. */
  b?: readonly [number, number, number];
  /** Surface radius of the element on its own. */
  radius: number;
  /** Reach = radius × smooth. */
  smooth: number;
  weight: number;
  color?: readonly [number, number, number];
  /** Chain id (> 0) shared by a polyline's consecutive segments; see BLOB_CHAIN. */
  chain?: number;
  /**
   * Row-major 3×3 shaping a point into an ellipsoid: the unit sphere's image
   * under it is the element's shape (radius 1 → radius along each column).
   * Must be invertible; ignored for segments.
   */
  shape?: ArrayLike<number>;
}

/**
 * Writes one element into `out` at slot `i`. Returns false (and writes
 * nothing usable) for a degenerate one — non-finite numbers, zero radius, a
 * singular shape — which the caller should drop.
 */
export function writeBlobElement(out: Float64Array, i: number, spec: BlobElementSpec): boolean {
  const o = i * BLOB_STRIDE;
  const reach = spec.radius * spec.smooth;
  if (!(reach > 0) || !Number.isFinite(reach) || !Number.isFinite(spec.weight)) return false;
  const [ax, ay, az] = spec.a;
  const [bx, by, bz] = spec.kind === BLOB_SEGMENT && spec.b ? spec.b : spec.a;
  if (![ax, ay, az, bx, by, bz].every(Number.isFinite)) return false;
  out[o + BLOB_KIND] = spec.kind === BLOB_POINT && spec.shape ? BLOB_ELLIPSOID : spec.kind;
  out[o + BLOB_A] = ax;
  out[o + BLOB_A + 1] = ay;
  out[o + BLOB_A + 2] = az;
  out[o + BLOB_B] = bx;
  out[o + BLOB_B + 1] = by;
  out[o + BLOB_B + 2] = bz;
  // Half-extent of the reach along each world axis.
  let ex = reach, ey = reach, ez = reach;
  const m = o + BLOB_M;
  out.fill(0, m, m + 9);
  const L = spec.kind === BLOB_POINT ? spec.shape : undefined;
  if (L) {
    const inv = invert3(L);
    if (!inv) return false;
    out.set(inv, m);
    ex = reach * Math.hypot(L[0], L[1], L[2]);
    ey = reach * Math.hypot(L[3], L[4], L[5]);
    ez = reach * Math.hypot(L[6], L[7], L[8]);
  } else {
    out[m] = 1;
    out[m + 4] = 1;
    out[m + 8] = 1;
  }
  const a = o + BLOB_AABB;
  out[a] = Math.min(ax, bx) - ex;
  out[a + 1] = Math.min(ay, by) - ey;
  out[a + 2] = Math.min(az, bz) - ez;
  out[a + 3] = Math.max(ax, bx) + ex;
  out[a + 4] = Math.max(ay, by) + ey;
  out[a + 5] = Math.max(az, bz) + ez;
  out[o + BLOB_REACH] = reach;
  out[o + BLOB_WEIGHT] = spec.weight;
  const c = spec.color ?? (spec.weight > 0 ? [1, 1, 1] : [BLOB_NO_COLOR, BLOB_NO_COLOR, BLOB_NO_COLOR]);
  out[o + BLOB_COLOR] = c[0];
  out[o + BLOB_COLOR + 1] = c[1];
  out[o + BLOB_COLOR + 2] = c[2];
  out[o + BLOB_CHAIN] = spec.chain && spec.chain > 0 ? spec.chain : 0;
  return true;
}

function invert3(m: ArrayLike<number>): number[] | null {
  const [a, b, c, d, e, f, g, h, k] = [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]];
  const A = e * k - f * h;
  const B = -(d * k - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const s = 1 / det;
  return [
    A * s, -(b * k - c * h) * s, (b * f - c * e) * s,
    B * s, (a * k - c * g) * s, -(a * f - c * d) * s,
    C * s, -(a * h - b * g) * s, (a * e - b * d) * s,
  ];
}
