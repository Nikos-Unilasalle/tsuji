import * as THREE from "three";
import { MAX_EDGES_PER_TRIANGLE, wornPool } from "./wornPool";
import { advanceWornAO, type WornAOJob } from "./wornAO";

/*
 * What a Worn material needs from a mesh, computed once and kept.
 *
 * - Rest space: every position divided by the mesh's size (its largest
 *   extent), so wear width, noise scale and curvature thresholds mean the
 *   same thing on a ring and on a cathedral — and, for a unit-sized object,
 *   exactly what they meant before.
 * - Feature edges: welded edges whose faces meet at a real angle, signed
 *   (+ convex ridge, − concave crease), stored in the shared pool.
 * - Per triangle, the (up to 8) feature edges nearest it *along the surface*:
 *   the shader measures the exact distance to each, so a wear band runs as far
 *   as its width says, across as many triangles as it covers — not only the
 *   first row, as when each triangle only knew its own edges — and several
 *   edges meeting at a corner add up.
 * - Per vertex, the mean curvature (for smooth surfaces no edge sees) and the
 *   ambient occlusion (for grime), packed together.
 *
 * Deformation: a mesh whose topology stays and whose positions move (an
 * animated modifier, an Edit Mesh drag) only has its positions copied across;
 * the weathering stays glued to the rest pose, like a texture. When the shape
 * then holds still for a moment, it is baked again for the new shape.
 */

export const REST_REBAKE_DELAY_MS = 300;
/** Wear/dirt bands reach at most this far, in rest space (fractions of the mesh's size). */
export const MAX_REACH = 0.4;
/**
 * Edges bending less than this are never features (the material's Edge Angle
 * filters above it). High enough that a faceted smooth surface — a tube in 40
 * sides bends 9° per edge — doesn't flood every vertex's few remembered edges
 * with facets and crowd out a real edge nearby: curvature handles those.
 */
export const MIN_FEATURE_ANGLE = 15;
/** Feature edges each vertex remembers. */
const LABELS_PER_VERTEX = 4;

export interface WornEntry {
  prepared: THREE.BufferGeometry;
  /** Prepared (non-indexed) vertex → source vertex. */
  sourceOf: Int32Array;
  /** Source vertex → welded vertex. */
  weldOf: Int32Array;
  topologyKey: string;
  /** Who drew it (see WornPrepareOptions.owner): only the same owner may take it over. */
  owner: string | undefined;
  size: number;
  restHash: number;
  syncedHash: number;
  pendingHash: number;
  /** The source geometry and position version last synced: an unchanged one costs nothing. */
  lastSource: THREE.BufferGeometry | null;
  lastVersion: number;
  stableSince: number;
  featureEdges: number;
  /** This geometry's own data, as handed to the pool (edge indices local): tests and debugging. */
  data: { edges: Float32Array; lists: Float32Array; listStarts: Float32Array; listCounts: Uint8Array };
  ao: WornAOJob;
  release: () => void;
  /** Colour attribute version last copied across (hand-painted masks). */
  lastColorVersion: number;
  /** The impact list shown (see wornImpacts.ts), and its pool range. */
  impactKey?: string;
  releaseImpacts?: () => void;
}

export interface WornPrepareOptions {
  /** Current time in ms (tests pass their own clock). */
  now?: number;
  /** Bake ambient occlusion — only when something reads it. */
  ao?: boolean;
  /** Time the occlusion bake may take this call, in ms. */
  aoBudgetMs?: number;
  /**
   * What draws the geometry — a mesh that stays while its geometry is rebuilt
   * every frame (an animated modifier, an Edit Mesh drag). A new geometry
   * with the same topology takes over the bake of the one its owner drew
   * before, instead of baking again. Without an owner nothing is taken over:
   * two different boxes with the same segment counts would otherwise share
   * one prepared geometry, and both draw the shape of whichever came last.
   */
  owner?: string;
}

const bySource = new WeakMap<THREE.BufferGeometry, WornEntry>();
const recent: WornEntry[] = [];

/**
 * The Worn-ready version of `geometry` (a non-indexed copy carrying the
 * attributes above). Cheap to call every frame: a geometry it has seen, or a
 * new one with the same topology, only gets its positions synced.
 */
export function prepareWornGeometry(geometry: THREE.BufferGeometry, options: WornPrepareOptions = {}): THREE.BufferGeometry {
  const now = options.now ?? performance.now();
  const own = geometry.userData.__wornEntry as WornEntry | undefined;
  if (own) {
    if (options.ao) advanceWornAO(own, options.aoBudgetMs ?? 4);
    return geometry;
  }
  const position = geometry.getAttribute("position");
  if (!position || position.count < 3) return geometry;

  const key = topologyKey(geometry);
  let entry = bySource.get(geometry);
  const owner = options.owner;
  if (!entry || entry.topologyKey !== key) {
    entry = owner === undefined
      ? undefined
      : recent.find((e) => e.owner === owner && e.topologyKey === key && !e.prepared.userData.__wornDisposed);
  }
  if (!entry) {
    entry = buildEntry(geometry, key, owner);
    remember(geometry, entry);
  } else {
    bySource.set(geometry, entry);
    const version = (position as THREE.BufferAttribute).version ?? 0;
    const colorVersion = (geometry.getAttribute("color") as THREE.BufferAttribute | undefined)?.version ?? -1;
    let hash = entry.syncedHash;
    if (geometry !== entry.lastSource || version !== entry.lastVersion || colorVersion !== entry.lastColorVersion) {
      hash = positionHash(geometry);
      if (hash !== entry.syncedHash) {
        syncAttributes(entry, geometry, ["position", "normal", "uv", "color"]);
        entry.syncedHash = hash;
      } else {
        // Same shape, maybe new paint or a new unwrap: those are cheap to copy.
        syncAttributes(entry, geometry, ["uv", "color"]);
      }
      entry.lastSource = geometry;
      entry.lastVersion = version;
      entry.lastColorVersion = colorVersion;
    }
    if (hash !== entry.restHash) {
      if (hash !== entry.pendingHash) {
        entry.pendingHash = hash;
        entry.stableSince = now;
      } else if (now - entry.stableSince >= REST_REBAKE_DELAY_MS) {
        // The shape moved and has settled: weather the new shape.
        const old = entry;
        entry = buildEntry(geometry, key, old.owner);
        remember(geometry, entry);
        forget(old);
        old.prepared.dispose();
      }
    }
  }
  if (options.ao) advanceWornAO(entry, options.aoBudgetMs ?? 4);
  return entry.prepared;
}

/** The entry behind a prepared geometry (tests, debugging). */
export function wornEntryOf(prepared: THREE.BufferGeometry): WornEntry | undefined {
  return prepared.userData.__wornEntry as WornEntry | undefined;
}

function remember(geometry: THREE.BufferGeometry, entry: WornEntry) {
  bySource.set(geometry, entry);
  recent.unshift(entry);
  while (recent.length > 16) recent.pop();
}

function forget(entry: WornEntry) {
  const i = recent.indexOf(entry);
  if (i >= 0) recent.splice(i, 1);
}

/** Vertex count, triangle count and a sample of the index: what must match to reuse a bake. */
function topologyKey(geometry: THREE.BufferGeometry): string {
  const index = geometry.getIndex();
  const count = geometry.getAttribute("position").count;
  if (!index) return `${count}:-`;
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(index.count / 64));
  for (let i = 0; i < index.count; i += step) h = Math.imul(h ^ index.getX(i), 16777619) >>> 0;
  return `${count}:${index.count}:${h.toString(36)}`;
}

/**
 * A content hash of the positions: their exact bits, read straight off the
 * buffer when it is a plain one — every value up to 4096 of them, an even
 * sample past that (a real edit or deformation moves far more than a few
 * vertices between two samples, and this runs every frame something moves).
 */
function positionHash(geometry: THREE.BufferGeometry): number {
  const p = geometry.getAttribute("position");
  let h = 0x811c9dc5;
  if (!("isInterleavedBufferAttribute" in p) && p.array instanceof Float32Array) {
    const bits = new Uint32Array(p.array.buffer, p.array.byteOffset, p.count * 3);
    const step = bits.length > 4096 ? Math.floor(bits.length / 4096) : 1;
    for (let i = 0; i < bits.length; i += step) h = Math.imul(h ^ bits[i], 16777619);
    return Math.imul(h ^ bits.length, 16777619) >>> 0;
  }
  for (let i = 0; i < p.count; i++) {
    h = Math.imul(h ^ Math.round(p.getX(i) * 1e6), 16777619);
    h = Math.imul(h ^ Math.round(p.getY(i) * 1e6), 16777619);
    h = Math.imul(h ^ Math.round(p.getZ(i) * 1e6), 16777619);
  }
  return h >>> 0;
}

/** Copies the named attributes (moved positions, normals, UVs, colours) onto the prepared copy. */
function syncAttributes(entry: WornEntry, source: THREE.BufferGeometry, names: readonly string[]) {
  const target = entry.prepared;
  for (const name of names) {
    const from = source.getAttribute(name);
    let to = target.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (from && !to && name === "color") {
      // Painted for the first time since the bake.
      to = new THREE.Float32BufferAttribute(new Float32Array(entry.sourceOf.length * from.itemSize), from.itemSize);
      target.setAttribute("color", to);
      target.setAttribute("aWornPaint", to);
    }
    if (!from || !to || to.itemSize !== from.itemSize) continue;
    const size = from.itemSize;
    const arr = to.array as Float32Array;
    const sourceOf = entry.sourceOf;
    if (!("isInterleavedBufferAttribute" in from) && !from.normalized) {
      // Plain buffer: straight array reads, no per-component calls.
      const src = from.array as ArrayLike<number>;
      for (let i = 0; i < sourceOf.length; i++) {
        const s = sourceOf[i] * size;
        const d = i * size;
        for (let k = 0; k < size; k++) arr[d + k] = src[s + k];
      }
    } else {
      for (let i = 0; i < sourceOf.length; i++) {
        for (let k = 0; k < size; k++) arr[i * size + k] = from.getComponent(sourceOf[i], k);
      }
    }
    to.needsUpdate = true;
  }
  if (!names.includes("position")) return;
  if (!source.getAttribute("normal")) target.computeVertexNormals();
  // The source's own bounds when it has them: same points, no second pass.
  if (source.boundingSphere) target.boundingSphere = source.boundingSphere.clone();
  else target.computeBoundingSphere();
  if (source.boundingBox) target.boundingBox = source.boundingBox.clone();
  else target.computeBoundingBox();
}

// ---------------------------------------------------------------------------
// The bake

function buildEntry(source: THREE.BufferGeometry, key: string, owner: string | undefined): WornEntry {
  const pos = source.getAttribute("position");
  const index = source.getIndex();
  const vertexCount = pos.count;
  const triCount = Math.floor((index ? index.count : vertexCount) / 3);
  const corner = (t: number, c: number) => (index ? index.getX(t * 3 + c) : t * 3 + c);

  // Size: the largest extent. Rest space = position / size.
  source.computeBoundingBox();
  const box = source.boundingBox!;
  const size = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z, 1e-9);

  // Weld by position, once per source vertex (a split-normal or UV seam is
  // one point of the surface, not a border).
  const weldOf = new Int32Array(vertexCount);
  const weldIds = new Map<string, number>();
  const q = 1e5 / size;
  const wx: number[] = [], wy: number[] = [], wz: number[] = [];
  for (let v = 0; v < vertexCount; v++) {
    const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
    const k = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    let id = weldIds.get(k);
    if (id === undefined) {
      id = wx.length;
      weldIds.set(k, id);
      wx.push(x / size); wy.push(y / size); wz.push(z / size);
    }
    weldOf[v] = id;
  }
  const W = wx.length;

  // Triangles (welded), unit normals.
  const tri = new Int32Array(triCount * 3);
  const tn = new Float32Array(triCount * 3);
  const valid = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const a = weldOf[corner(t, 0)], b = weldOf[corner(t, 1)], c = weldOf[corner(t, 2)];
    tri[t * 3] = a; tri[t * 3 + 1] = b; tri[t * 3 + 2] = c;
    const e1x = wx[b] - wx[a], e1y = wy[b] - wy[a], e1z = wz[b] - wz[a];
    const e2x = wx[c] - wx[a], e2y = wy[c] - wy[a], e2z = wz[c] - wz[a];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz);
    if (l > 1e-12 && a !== b && b !== c && a !== c) {
      tn[t * 3] = nx / l; tn[t * 3 + 1] = ny / l; tn[t * 3 + 2] = nz / l;
      valid[t] = 1;
    }
  }

  // Edges → the (up to two) triangles on them.
  const edgeTris = new Map<number, number[]>();
  const edgeKey = (a: number, b: number) => (a < b ? a * W + b : b * W + a);
  for (let t = 0; t < triCount; t++) {
    if (!valid[t]) continue;
    for (let c = 0; c < 3; c++) {
      const a = tri[t * 3 + c], b = tri[t * 3 + ((c + 1) % 3)];
      const k = edgeKey(a, b);
      const list = edgeTris.get(k);
      if (list) list.push(t);
      else edgeTris.set(k, [t]);
    }
  }

  // Feature edges: two faces meeting at more than a sliver of an angle. An
  // edge with one face is left alone: far more often than a true border, it
  // is a seam a modifier computed twice with float noise (a Boolean's
  // retriangulation), and wearing every one would streak the whole panel.
  const featureA: number[] = [], featureB: number[] = [], featureAngle: number[] = [];
  // Neighbour graph for the surface distances, and per-vertex normal sums for curvature.
  const neighbours: number[][] = Array.from({ length: W }, () => []);
  const vn = new Float32Array(W * 3);
  for (let t = 0; t < triCount; t++) {
    if (!valid[t]) continue;
    for (let c = 0; c < 3; c++) {
      const v = tri[t * 3 + c];
      vn[v * 3] += tn[t * 3]; vn[v * 3 + 1] += tn[t * 3 + 1]; vn[v * 3 + 2] += tn[t * 3 + 2];
    }
  }
  for (const [k, tris] of edgeTris) {
    const a = Math.floor(k / W), b = k % W;
    neighbours[a].push(b);
    neighbours[b].push(a);
    if (tris.length !== 2) continue;
    const [t1, t2] = tris;
    const dot = Math.max(-1, Math.min(1, tn[t1 * 3] * tn[t2 * 3] + tn[t1 * 3 + 1] * tn[t2 * 3 + 1] + tn[t1 * 3 + 2] * tn[t2 * 3 + 2]));
    const angle = (Math.acos(dot) * 180) / Math.PI;
    if (angle < MIN_FEATURE_ANGLE) continue;
    // Convex when t2's far corner falls below t1's plane.
    let opp = -1;
    for (let c = 0; c < 3; c++) {
      const v = tri[t2 * 3 + c];
      if (v !== a && v !== b) opp = v;
    }
    if (opp < 0) continue;
    const mx = (wx[a] + wx[b]) / 2, my = (wy[a] + wy[b]) / 2, mz = (wz[a] + wz[b]) / 2;
    const proj = (wx[opp] - mx) * tn[t1 * 3] + (wy[opp] - my) * tn[t1 * 3 + 1] + (wz[opp] - mz) * tn[t1 * 3 + 2];
    if (Math.abs(proj) < 1e-9) continue;
    featureA.push(a);
    featureB.push(b);
    featureAngle.push(proj < 0 ? angle : -angle);
  }
  const featureRuns = mergeCollinearFeatures(featureA, featureB, featureAngle, wx, wy, wz);
  const E = featureA.length;

  // K nearest feature edges per vertex, along the surface (multi-label Dijkstra).
  const labelEdge = new Int32Array(W * LABELS_PER_VERTEX).fill(-1);
  const labelDist = new Float32Array(W * LABELS_PER_VERTEX).fill(Infinity);
  const heap = new MinHeap();
  // Every vertex along an edge is on it: the spread starts from all of them.
  for (let e = 0; e < E; e++) for (const v of featureRuns[e]) heap.push(0, v, e);
  while (heap.size > 0) {
    const [d, v, e] = heap.pop();
    // This edge already reached here (at least as close: pops come nearest
    // first), or the vertex is full of closer ones? Then stop spreading it.
    const base = v * LABELS_PER_VERTEX;
    let existing = -1, empty = -1, worst = -1;
    for (let i = 0; i < LABELS_PER_VERTEX; i++) {
      const le = labelEdge[base + i];
      if (le === e) existing = i;
      else if (le < 0) {
        if (empty < 0) empty = i;
      } else if (worst < 0 || labelDist[base + i] > labelDist[base + worst]) worst = i;
    }
    let slot: number;
    if (existing >= 0) {
      if (labelDist[base + existing] <= d) continue;
      slot = existing;
    } else if (empty >= 0) {
      slot = empty;
    } else {
      if (labelDist[base + worst] <= d) continue;
      slot = worst;
    }
    labelEdge[base + slot] = e;
    labelDist[base + slot] = d;
    for (const w of neighbours[v]) {
      const nd = d + Math.hypot(wx[w] - wx[v], wy[w] - wy[v], wz[w] - wz[v]);
      if (nd <= MAX_REACH) heap.push(nd, w, e);
    }
  }

  // Per triangle: its corners' labels, nearest first, at most 8.
  const listCounts = new Uint8Array(triCount);
  const listStarts = new Float32Array(triCount);
  const listData: number[] = [];
  const nearest = new Map<number, number>();
  for (let t = 0; t < triCount; t++) {
    nearest.clear();
    if (valid[t]) {
      for (let c = 0; c < 3; c++) {
        const base = tri[t * 3 + c] * LABELS_PER_VERTEX;
        for (let i = 0; i < LABELS_PER_VERTEX; i++) {
          const e = labelEdge[base + i];
          if (e < 0) continue;
          const d = labelDist[base + i];
          const prev = nearest.get(e);
          if (prev === undefined || d < prev) nearest.set(e, d);
        }
      }
    }
    const list = [...nearest.entries()].sort((x, y) => x[1] - y[1]).slice(0, MAX_EDGES_PER_TRIANGLE).map(([e]) => e);
    listStarts[t] = listData.length / 4;
    listCounts[t] = list.length;
    for (const e of list) listData.push(e);
    while (listData.length % 4 !== 0) listData.push(-1);
  }
  if (listData.length === 0) listData.push(-1, -1, -1, -1);

  const edgeData = new Float32Array(Math.max(1, E) * 8);
  for (let e = 0; e < E; e++) {
    const a = featureA[e], b = featureB[e];
    edgeData.set([wx[a], wy[a], wz[a], featureAngle[e], wx[b], wy[b], wz[b], 0], e * 8);
  }

  // Mean curvature per welded vertex, ×size (dimensionless: 1 = a radius of the whole object).
  const curvature = new Float32Array(W);
  for (let v = 0; v < W; v++) {
    const n = Math.hypot(vn[v * 3], vn[v * 3 + 1], vn[v * 3 + 2]);
    const list = neighbours[v];
    if (n < 1e-12 || list.length === 0) continue;
    const nx = vn[v * 3] / n, ny = vn[v * 3 + 1] / n, nz = vn[v * 3 + 2] / n;
    let dotSum = 0, lengthSum = 0;
    for (const w of list) {
      const dx = wx[w] - wx[v], dy = wy[w] - wy[v], dz = wz[w] - wz[v];
      const l = Math.hypot(dx, dy, dz);
      if (l < 1e-12) continue;
      dotSum += (dx * nx + dy * ny + dz * nz) / l;
      lengthSum += l;
    }
    const meanLength = lengthSum / list.length;
    curvature[v] = meanLength > 1e-12 ? (-(dotSum / list.length) * 2) / meanLength : 0;
  }

  // The prepared copy: non-indexed (the edge list is per triangle), with the source's own attributes.
  const prepared = source.index ? source.toNonIndexed() : source.clone();
  prepared.userData = { ...source.userData };
  const preparedCount = triCount * 3;
  const sourceOf = new Int32Array(preparedCount);
  const rest = new Float32Array(preparedCount * 3);
  const surface = new Float32Array(preparedCount * 2);
  const listAttr = new Float32Array(preparedCount * 2);
  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const i = t * 3 + c;
      const s = corner(t, c);
      const w = weldOf[s];
      sourceOf[i] = s;
      rest[i * 3] = wx[w]; rest[i * 3 + 1] = wy[w]; rest[i * 3 + 2] = wz[w];
      surface[i * 2] = curvature[w];
      surface[i * 2 + 1] = 1; // open until the occlusion bake says otherwise
      listAttr[i * 2 + 1] = listCounts[t];
    }
  }
  prepared.setAttribute("aWornRest", new THREE.Float32BufferAttribute(rest, 3));
  prepared.setAttribute("aWornSurface", new THREE.Float32BufferAttribute(surface, 2));
  const listAttribute = new THREE.Float32BufferAttribute(listAttr, 2);
  prepared.setAttribute("aWornList", listAttribute);
  // Hand-painted masks read the vertex colours, under a name of their own
  // (the same attribute, one buffer): "color" is three's, declared only when
  // a material asks for vertex colours.
  const color = prepared.getAttribute("color");
  if (color) prepared.setAttribute("aWornPaint", color);
  // No impacts yet: (start, count) = (0, 0) everywhere.
  prepared.setAttribute("aWornImpacts", new THREE.Float32BufferAttribute(new Float32Array(preparedCount * 2), 2));

  const entry: WornEntry = {
    prepared,
    sourceOf,
    weldOf,
    topologyKey: key,
    owner,
    size,
    restHash: positionHash(source),
    syncedHash: 0,
    pendingHash: 0,
    lastSource: source,
    lastVersion: (pos as THREE.BufferAttribute).version ?? 0,
    lastColorVersion: (source.getAttribute("color") as THREE.BufferAttribute | undefined)?.version ?? -1,
    stableSince: 0,
    featureEdges: E,
    data: { edges: edgeData, lists: new Float32Array(listData), listStarts, listCounts },
    ao: { weldedPositions: { x: wx, y: wy, z: wz }, vertexNormals: vn, triangles: tri, valid, next: 0, done: false, weldOf, sourceOf },
    release: () => {},
  };
  entry.syncedHash = entry.restHash;
  entry.pendingHash = entry.restHash;
  prepared.userData.__wornEntry = entry;

  entry.release = wornPool.add(edgeData, entry.data.lists, (edgeBase, listBase) => {
    void edgeBase; // edge indices are made global by the pool itself
    for (let t = 0; t < triCount; t++) {
      const start = listStarts[t] + listBase;
      for (let c = 0; c < 3; c++) listAttr[(t * 3 + c) * 2] = start;
    }
    listAttribute.needsUpdate = true;
  });
  prepared.addEventListener("dispose", () => {
    prepared.userData.__wornDisposed = true;
    entry.release();
    entry.releaseImpacts?.();
    forget(entry);
  });
  return entry;
}

/** A binary min-heap of (distance, vertex, edge) triples. */
class MinHeap {
  private d: number[] = [];
  private v: number[] = [];
  private e: number[] = [];
  get size() {
    return this.d.length;
  }
  push(d: number, v: number, e: number) {
    this.d.push(d); this.v.push(v); this.e.push(e);
    let i = this.d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.d[p] <= this.d[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number, number] {
    const top: [number, number, number] = [this.d[0], this.v[0], this.e[0]];
    const last = this.d.length - 1;
    this.swap(0, last);
    this.d.pop(); this.v.pop(); this.e.pop();
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < this.d.length && this.d[l] < this.d[m]) m = l;
      if (r < this.d.length && this.d[r] < this.d[m]) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.d[a], this.d[b]] = [this.d[b], this.d[a]];
    [this.v[a], this.v[b]] = [this.v[b], this.v[a]];
    [this.e[a], this.e[b]] = [this.e[b], this.e[a]];
  }
}

/**
 * What the shader computes for one point of one triangle, on the CPU: the
 * distance (rest space) to the nearest convex and concave feature edge in the
 * triangle's list, filtered by `edgeAngle`. For tests and tools.
 */
export function wornEdgeDistances(entry: WornEntry, triangle: number, restPoint: [number, number, number], edgeAngle = 30): { convex: number; concave: number } {
  const { edges, lists, listStarts, listCounts } = entry.data;
  let convex = Infinity;
  let concave = Infinity;
  for (let i = 0; i < listCounts[triangle]; i++) {
    const e = lists[listStarts[triangle] * 4 + i];
    if (e < 0) continue;
    const o = e * 8;
    const angle = edges[o + 3];
    if (Math.abs(angle) <= edgeAngle) continue;
    const ax = edges[o], ay = edges[o + 1], az = edges[o + 2];
    const bx = edges[o + 4], by = edges[o + 5], bz = edges[o + 6];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const len2 = Math.max(abx * abx + aby * aby + abz * abz, 1e-12);
    const t = Math.max(0, Math.min(1, ((restPoint[0] - ax) * abx + (restPoint[1] - ay) * aby + (restPoint[2] - az) * abz) / len2));
    const d = Math.hypot(restPoint[0] - (ax + abx * t), restPoint[1] - (ay + aby * t), restPoint[2] - (az + abz * t));
    if (angle > 0) convex = Math.min(convex, d);
    else concave = Math.min(concave, d);
  }
  return { convex, concave };
}

/**
 * Joins runs of feature edges that are one straight edge cut into pieces
 * (a subdivided box: every edge in 48 bits) into single segments, in place.
 * The shader measures distance to a segment exactly, so nothing is lost —
 * and a vertex's few remembered edges are no longer all pieces of the same
 * one, which is what lets a corner see every edge that meets there. It also
 * divides the bake's work by the number of pieces.
 */
function mergeCollinearFeatures(A: number[], B: number[], angle: number[], x: number[], y: number[], z: number[]): number[][] {
  const n = A.length;
  if (n < 2) return A.map((a, e) => [a, B[e]]);
  const at = new Map<number, number[]>();
  for (let e = 0; e < n; e++) {
    for (const v of [A[e], B[e]]) {
      const list = at.get(v);
      if (list) list.push(e);
      else at.set(v, [e]);
    }
  }
  const dir = (e: number, from: number) => {
    const to = A[e] === from ? B[e] : A[e];
    const dx = x[to] - x[from], dy = y[to] - y[from], dz = z[to] - z[from];
    const l = Math.hypot(dx, dy, dz) || 1;
    return [dx / l, dy / l, dz / l];
  };
  /** At v, does e continue straight on into another piece of the same edge? */
  const continuation = (e: number, v: number): number => {
    const list = at.get(v)!;
    if (list.length !== 2) return -1; // a corner, or a dead end
    const f = list[0] === e ? list[1] : list[0];
    if (Math.sign(angle[f]) !== Math.sign(angle[e]) || Math.abs(Math.abs(angle[f]) - Math.abs(angle[e])) > 5) return -1;
    const a = dir(e, v), b = dir(f, v);
    // Opposite directions out of v: collinear within ~1.5°.
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] < -0.9997 ? f : -1;
  };
  const used = new Uint8Array(n);
  const outA: number[] = [], outB: number[] = [], outAngle: number[] = [];
  const runs: number[][] = [];
  for (let e = 0; e < n; e++) {
    if (used[e]) continue;
    used[e] = 1;
    // Walk both ways along the run.
    let startV = A[e], endV = B[e];
    let sum = angle[e], count = 1;
    const run = [A[e], B[e]];
    for (const side of [0, 1]) {
      let cur = e;
      let v = side === 0 ? A[e] : B[e];
      for (;;) {
        const next = continuation(cur, v);
        if (next < 0 || used[next]) break;
        used[next] = 1;
        sum += angle[next];
        count++;
        v = A[next] === v ? B[next] : A[next];
        run.push(v);
        cur = next;
      }
      if (side === 0) startV = v;
      else endV = v;
    }
    outA.push(startV);
    outB.push(endV);
    outAngle.push(sum / count);
    runs.push(run);
  }
  A.length = 0; B.length = 0; angle.length = 0;
  A.push(...outA); B.push(...outB); angle.push(...outAngle);
  return runs;
}

