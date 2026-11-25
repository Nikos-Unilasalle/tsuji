import type { PolyMesh } from "../quadMesh";
import { getTopology } from "./topology";
import { domainEdges } from "./polyAttributes";
import { triangulateFace } from "./triangulate";
import { edgeKey, remapEdgeAttributes } from "./attributes";
import type { PropagationMaps } from "./propagate";

/*
 * The geometry behind the phase-5 modelling nodes (nodes/modelingAlgos.ts),
 * kept free of THREE and of the node system so every algorithm can be tested
 * on bare PolyMeshes: Laplacian smoothing, poke, divide, dual, scale
 * elements, quickhull, bounding boxes, quadric decimation, element sorting
 * and subsetting.
 *
 * Topology-changing functions return `{ mesh, maps }`: the maps say which
 * source point / face every output element came from, so the node can hand
 * them to withAttributes() and named attributes and groups follow exactly
 * instead of by nearest-neighbour guess. They build UVs and corner colours
 * themselves (blended from the source corners), and carry the built-in edge
 * marks (sharp / seam / crease) wherever the edge survives.
 */

export type V3 = [number, number, number];
type UV = [number, number];
type Color3 = [number, number, number];

export interface OpResult {
  mesh: PolyMesh;
  maps: PropagationMaps;
}

// =================================================================== helpers

const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
const finite = (p: readonly number[] | undefined): p is readonly number[] =>
  !!p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]);

function centroidOf(positions: ReadonlyArray<readonly number[]>, face: readonly number[]): V3 {
  let x = 0, y = 0, z = 0;
  for (const v of face) {
    const p = positions[v];
    x += p[0];
    y += p[1];
    z += p[2];
  }
  const k = face.length || 1;
  return [x / k, y / k, z / k];
}

/** Newell normal (unit, or zero for a degenerate face). */
export function polygonNormal(positions: ReadonlyArray<readonly number[]>, face: readonly number[]): V3 {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < face.length; i++) {
    const a = positions[face[i]];
    const b = positions[face[(i + 1) % face.length]];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = Math.hypot(nx, ny, nz);
  return l > 1e-20 ? [nx / l, ny / l, nz / l] : [0, 0, 0];
}

/** Every vertex on a boundary edge (one face) — the outline smoothing pins and decimation guards. */
export function boundaryPoints(mesh: PolyMesh): Uint8Array {
  const out = new Uint8Array(mesh.positions.length);
  const topology = getTopology(mesh);
  topology.edges.forEach(([a, b], e) => {
    if (topology.isBoundaryEdge(e)) out[a] = out[b] = 1;
  });
  return out;
}

/**
 * Assembles an output mesh face by face, remembering where every point and
 * face came from and blending the source corners' UVs and colours for every
 * new corner. A corner is described as weights over the *source face's*
 * corners, which is exact for anything built inside one face (poke, divide,
 * dual centroids) and stays inside the face's own UV chart across seams.
 */
class MeshBuilder {
  readonly positions: V3[] = [];
  readonly pointSrc: number[] = [];
  readonly faces: number[][] = [];
  readonly faceSrc: number[] = [];
  private readonly faceUVs: UV[][] = [];
  private readonly faceColors: (Color3[] | null)[] = [];
  private readonly hasUV: boolean;
  private readonly hasColor: boolean;

  constructor(private readonly src: PolyMesh) {
    this.hasUV = Boolean(src.faceUVs || (src.uvs && src.uvs.length === src.positions.length));
    this.hasColor = Boolean(src.faceColors && src.faceColors.some((c) => c));
  }

  addPoint(p: readonly number[], srcPoint: number): number {
    this.positions.push([p[0], p[1], p[2]]);
    this.pointSrc.push(srcPoint);
    return this.positions.length - 1;
  }

  srcUV(f: number, c: number): UV {
    const uv = this.src.faceUVs?.[f]?.[c] ?? this.src.uvs?.[this.src.faces[f]?.[c]];
    return uv ? [uv[0], uv[1]] : [0, 0];
  }

  srcColor(f: number, c: number): Color3 {
    const col = this.src.faceColors?.[f]?.[c];
    return col ? [col[0], col[1], col[2]] : [1, 1, 1];
  }

  /**
   * `corners[i]` is a list of [source corner, weight] pairs (weights summing
   * to 1) within source face `srcFace`; null when the face can't say (its
   * UVs fall back to zero).
   */
  addFace(verts: number[], srcFace: number, corners: Array<Array<[number, number]>> | null): number {
    return this.addFaceMix(verts, srcFace, corners ? corners.map((mix) => mix.map(([c, w]) => [srcFace, c, w] as [number, number, number])) : null);
  }

  /** Like addFace, with each corner blended from [face, corner, weight] of any source faces (the dual's corners span several). */
  addFaceMix(verts: number[], srcFace: number, corners: Array<Array<[number, number, number]>> | null): number {
    this.faces.push(verts);
    this.faceSrc.push(srcFace);
    if (this.hasUV) {
      this.faceUVs.push(
        verts.map((_, i) => {
          let u = 0, v = 0;
          for (const [f, c, w] of corners?.[i] ?? []) {
            if (f < 0) continue;
            const uv = this.srcUV(f, c);
            u += uv[0] * w;
            v += uv[1] * w;
          }
          return [u, v] as UV;
        }),
      );
    }
    if (this.hasColor) {
      const anyColor = (corners ?? []).some((mix) => mix.some(([f]) => f >= 0 && this.src.faceColors?.[f]));
      this.faceColors.push(
        anyColor
          ? verts.map((_, i) => {
              const out: Color3 = [0, 0, 0];
              let total = 0;
              for (const [f, c, w] of corners?.[i] ?? []) {
                if (f < 0) continue;
                const col = this.srcColor(f, c);
                out[0] += col[0] * w;
                out[1] += col[1] * w;
                out[2] += col[2] * w;
                total += w;
              }
              return total > 0 ? out : ([1, 1, 1] as Color3);
            })
          : null,
      );
    }
    return this.faces.length - 1;
  }

  /** Copies a source face with its corners as they were, through a vertex map. */
  copyFace(f: number, vertexOf: (v: number) => number): number {
    const face = this.src.faces[f];
    return this.addFace(face.map(vertexOf), f, face.map((_, c) => [[c, 1]]));
  }

  /** Raw per-corner data, for an operation (decimation) that tracks corners itself. */
  addFaceWithData(verts: number[], srcFace: number, uvs: UV[] | null, colors: Color3[] | null): number {
    this.faces.push(verts);
    this.faceSrc.push(srcFace);
    if (this.hasUV) this.faceUVs.push(uvs ?? verts.map(() => [0, 0] as UV));
    if (this.hasColor) this.faceColors.push(colors);
    return this.faces.length - 1;
  }

  /**
   * The finished mesh. `vertexOf` maps source vertices to the output vertex
   * that *is* them (for the built-in edge marks and loose edges), -1 when
   * gone.
   */
  build(vertexOf: ArrayLike<number>, opts: { keepLooseEdges?: boolean } = {}): OpResult {
    const src = this.src;
    const hasShading = Boolean(src.faceShading && src.faceShading.length > 0);
    const out: PolyMesh = {
      positions: this.positions,
      faces: this.faces,
      faceUVs: this.hasUV ? this.faceUVs : undefined,
      faceColors: this.hasColor ? this.faceColors : undefined,
      faceMaterials: src.faceMaterials ? this.faceSrc.map((f) => (f >= 0 ? (src.faceMaterials![f] ?? 0) : 0)) : undefined,
      faceShading: hasShading ? this.faceSrc.map((f) => src.faceShading![f] ?? src.shading ?? "auto") : undefined,
      shading: src.shading,
      sourceSignature: src.sourceSignature,
    };
    remapEdgeAttributes(opts.keepLooseEdges === false ? { ...src, edges: undefined } : src, out, vertexOf);
    return { mesh: out, maps: { point: Int32Array.from(this.pointSrc), face: Int32Array.from(this.faceSrc) } };
  }
}

const identityVertexOf = (n: number) => {
  const a = new Int32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  return a;
};

// =================================================================== smoothing

export type SmoothWeighting = "uniform" | "edge-length" | "cotangent";

export interface SmoothOptions {
  iterations: number;
  /** λ of each step, 0..1. */
  strength: number;
  weighting?: SmoothWeighting;
  /** Taubin λ|μ smoothing: a shrinking step then an inflating one, so the mesh keeps its volume. */
  preserveVolume?: boolean;
  /** Boundary points don't move (otherwise they relax along the boundary only). */
  pinBoundary?: boolean;
  /** Per-point influence 0..1 (group × weight attribute); 0 = fixed. Absent = all 1. */
  weights?: ArrayLike<number>;
}

/**
 * Laplacian smoothing: each point moves toward the weighted average of its
 * neighbours. Uniform weights even out the spacing (and shrink); edge-length
 * weights (1/length, Fujiwara) favour near neighbours; cotangent weights
 * follow the surface's own geometry, so a flat region stays put and only
 * curvature is smoothed. Negative cotangents (obtuse triangles) are clamped
 * — the "cotangent-ish" that never pushes a point outward.
 *
 * Boundary points, when not pinned, only see their boundary neighbours: the
 * outline relaxes along itself instead of collapsing inward.
 */
export function smoothPositions(mesh: PolyMesh, opts: SmoothOptions): V3[] {
  const n = mesh.positions.length;
  const pos = new Float64Array(n * 3);
  mesh.positions.forEach((p, i) => {
    pos[i * 3] = Number.isFinite(p[0]) ? p[0] : 0;
    pos[i * 3 + 1] = Number.isFinite(p[1]) ? p[1] : 0;
    pos[i * 3 + 2] = Number.isFinite(p[2]) ? p[2] : 0;
  });
  const iterations = Math.max(0, Math.min(1000, Math.round(opts.iterations)));
  const lambda = Math.max(0, Math.min(1, opts.strength));
  if (n === 0 || iterations === 0 || lambda === 0) return mesh.positions.map((p) => [p[0], p[1], p[2]]);

  const influence = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = opts.weights ? Number(opts.weights[i]) : 1;
    influence[i] = Number.isFinite(w) ? Math.max(0, Math.min(1, w)) : 0;
  }

  // Adjacency as CSR with a fixed per-edge weight (cotangent) or 1.
  const boundary = boundaryPoints(mesh);
  const topology = getTopology(mesh);
  const edges = domainEdges(mesh);
  const boundaryEdge = (a: number, b: number) => {
    const id = topology.findEdge(a, b);
    return id < 0 || topology.isBoundaryEdge(id);
  };
  const cot = opts.weighting === "cotangent" ? cotangentWeights(mesh) : null;
  const lists: Array<Array<[number, number]>> = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) {
    const w = cot ? Math.max(1e-4, cot.get(edgeKey(a, b)) ?? 0) : 1;
    // A boundary point keeps only boundary neighbours (relaxes along the outline).
    if (!boundary[a] || boundaryEdge(a, b)) lists[a].push([b, w]);
    if (!boundary[b] || boundaryEdge(a, b)) lists[b].push([a, w]);
  }
  if (opts.pinBoundary) for (let i = 0; i < n; i++) if (boundary[i]) influence[i] = 0;

  const next = new Float64Array(n * 3);
  const step = (factor: number) => {
    next.set(pos);
    for (let i = 0; i < n; i++) {
      const k = influence[i] * factor;
      const nb = lists[i];
      if (k === 0 || nb.length === 0) continue;
      let sx = 0, sy = 0, sz = 0, sw = 0;
      for (const [j, w0] of nb) {
        let w = w0;
        if (opts.weighting === "edge-length") {
          const d = Math.hypot(pos[j * 3] - pos[i * 3], pos[j * 3 + 1] - pos[i * 3 + 1], pos[j * 3 + 2] - pos[i * 3 + 2]);
          w = 1 / Math.max(d, 1e-9);
        }
        sx += pos[j * 3] * w;
        sy += pos[j * 3 + 1] * w;
        sz += pos[j * 3 + 2] * w;
        sw += w;
      }
      if (!(sw > 0)) continue;
      next[i * 3] = pos[i * 3] + k * (sx / sw - pos[i * 3]);
      next[i * 3 + 1] = pos[i * 3 + 1] + k * (sy / sw - pos[i * 3 + 1]);
      next[i * 3 + 2] = pos[i * 3 + 2] + k * (sz / sw - pos[i * 3 + 2]);
    }
    pos.set(next);
  };
  // Taubin's μ from a pass-band of 0.1: 1/kpb = 1/λ + 1/μ.
  const mu = 1 / (0.1 - 1 / Math.max(lambda, 1e-3));
  for (let it = 0; it < iterations; it++) {
    step(lambda);
    if (opts.preserveVolume) step(mu);
  }
  const out: V3[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    out[i] = Number.isFinite(x + y + z) ? [x, y, z] : [mesh.positions[i][0], mesh.positions[i][1], mesh.positions[i][2]];
  }
  return out;
}

/** Sum of the cotangents of the angles opposite each edge, over the faces' triangulations. */
function cotangentWeights(mesh: PolyMesh): Map<string, number> {
  const out = new Map<string, number>();
  const add = (a: number, b: number, w: number) => {
    const k = edgeKey(a, b);
    out.set(k, (out.get(k) ?? 0) + w);
  };
  for (const face of mesh.faces) {
    if (face.length < 3) continue;
    for (const [i, j, k] of triangulateFace(mesh.positions, face)) {
      const tri = [face[i], face[j], face[k]];
      for (let c = 0; c < 3; c++) {
        const o = mesh.positions[tri[c]];
        const a = tri[(c + 1) % 3], b = tri[(c + 2) % 3];
        const u = sub(mesh.positions[a], o), v = sub(mesh.positions[b], o);
        const s = len(cross(u, v));
        if (s < 1e-20) continue;
        // Only edges of the polygon count; a triangulation diagonal isn't a mesh edge.
        add(a, b, (0.5 * dot(u, v)) / s);
      }
    }
  }
  return out;
}

// =================================================================== poke

/**
 * Each listed face becomes a fan of triangles around its centroid (pushed
 * `offset` along the face normal). The other faces are copied as they are;
 * the original points keep their indices and the centroids are appended.
 */
export function pokeFaces(mesh: PolyMesh, faces: Iterable<number>, offset = 0): OpResult {
  const b = new MeshBuilder(mesh);
  mesh.positions.forEach((p, i) => b.addPoint(p, i));
  const poke = new Uint8Array(mesh.faces.length);
  for (const f of faces) if (f >= 0 && f < poke.length) poke[f] = 1;
  const off = Number.isFinite(offset) ? offset : 0;
  mesh.faces.forEach((face, f) => {
    if (!poke[f] || face.length < 3) {
      b.copyFace(f, (v) => v);
      return;
    }
    const c = centroidOf(mesh.positions, face);
    const nrm = polygonNormal(mesh.positions, face);
    const ci = b.addPoint([c[0] + nrm[0] * off, c[1] + nrm[1] * off, c[2] + nrm[2] * off], nearestCorner(mesh, face, c));
    const all: Array<[number, number]> = face.map((_, k) => [k, 1 / face.length]);
    for (let k = 0; k < face.length; k++) {
      const k1 = (k + 1) % face.length;
      b.addFace([face[k], face[k1], ci], f, [[[k, 1]], [[k1, 1]], all]);
    }
  });
  return b.build(identityVertexOf(mesh.positions.length));
}

function nearestCorner(mesh: PolyMesh, face: readonly number[], p: readonly number[]): number {
  let best = face[0] ?? -1, bestD = Infinity;
  for (const v of face) {
    const q = mesh.positions[v];
    const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return best;
}

// =================================================================== divide

export type DivideMode = "quads" | "triangles";

/**
 * Linear tessellation: every listed face is cut into a regular grid with
 * `cuts` segments per edge — N×N quads for a quad (or 2·N² triangles in
 * triangle mode), an N² triangle grid for a triangle, and for an n-gon a fan
 * of triangle grids around its centroid. No smoothing: points stay on the
 * original faces (Catmull-Clark's job is elsewhere).
 *
 * Edge points are shared between neighbouring divided faces, and a face
 * left out that borders a divided one gets the new edge points inserted
 * into its outline, so the result has no cracks or T-junctions.
 */
export function divideFaces(mesh: PolyMesh, faces: Iterable<number>, cuts: number, mode: DivideMode = "quads"): OpResult {
  const N = Math.max(1, Math.min(64, Math.round(Number.isFinite(cuts) ? cuts : 1)));
  const b = new MeshBuilder(mesh);
  mesh.positions.forEach((p, i) => b.addPoint(p, i));
  const divide = new Uint8Array(mesh.faces.length);
  for (const f of faces) if (f >= 0 && f < divide.length && mesh.faces[f].length >= 3) divide[f] = 1;
  if (N === 1 && mode === "quads") {
    mesh.faces.forEach((_, f) => b.copyFace(f, (v) => v));
    return b.build(identityVertexOf(mesh.positions.length));
  }

  // Interior points of each split edge, ordered from the lower vertex index.
  const edgePoints = new Map<string, number[]>();
  const splitEdge = (a: number, c: number): number[] => {
    const key = edgeKey(a, c);
    let pts = edgePoints.get(key);
    if (!pts) {
      const lo = Math.min(a, c), hi = Math.max(a, c);
      const p = mesh.positions[lo], q = mesh.positions[hi];
      pts = [];
      for (let i = 1; i < N; i++) {
        const t = i / N;
        pts.push(b.addPoint([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t], t < 0.5 ? lo : hi));
      }
      edgePoints.set(key, pts);
    }
    return a < c ? pts : [...pts].reverse();
  };
  // The point at step i (0..N) along a→c, as the shared edge point.
  const along = (a: number, c: number, i: number) => (i === 0 ? a : i === N ? c : splitEdge(a, c)[i - 1]);

  // Split every divided face's edges first, so neighbours see them.
  mesh.faces.forEach((face, f) => {
    if (!divide[f]) return;
    for (let k = 0; k < face.length; k++) if (N > 1) splitEdge(face[k], face[(k + 1) % face.length]);
  });

  mesh.faces.forEach((face, f) => {
    if (!divide[f]) {
      // Insert the split points of any divided neighbour's edge.
      const verts: number[] = [];
      const corners: Array<Array<[number, number]>> = [];
      face.forEach((v, k) => {
        const k1 = (k + 1) % face.length;
        verts.push(v);
        corners.push([[k, 1]]);
        const pts = edgePoints.get(edgeKey(v, face[k1]));
        if (!pts) return;
        const ordered = v < face[k1] ? pts : [...pts].reverse();
        ordered.forEach((p, i) => {
          const t = (i + 1) / N;
          verts.push(p);
          corners.push([[k, 1 - t], [k1, t]]);
        });
      });
      b.addFace(verts, f, corners);
      return;
    }
    if (face.length === 4) divideQuad(b, mesh, face, f, N, mode, along);
    else if (face.length === 3) divideTriangle(b, mesh, [0, 1, 2], face, f, N, along, null);
    else divideNgon(b, mesh, face, f, N, along);
  });

  const out = b.build(identityVertexOf(mesh.positions.length));
  // A sharp / seam / creased edge marks every piece it was cut into (the
  // builder only carried over the edges that still exist whole).
  if (hasEdgeMarks(mesh)) restoreSplitMarks(mesh, out.mesh, edgePoints);
  return out;
}

function hasEdgeMarks(mesh: PolyMesh): boolean {
  return Boolean(mesh.sharpEdges?.length || mesh.seamEdges?.length || mesh.edgeCreases?.length);
}

function restoreSplitMarks(src: PolyMesh, out: PolyMesh, edgePoints: Map<string, number[]>) {
  const pieces = (a: number, c: number): [number, number][] | null => {
    const pts = edgePoints.get(edgeKey(a, c));
    if (!pts) return null;
    const lo = Math.min(a, c), hi = Math.max(a, c);
    const chain = [lo, ...pts, hi];
    return chain.slice(1).map((v, i) => (chain[i] < v ? [chain[i], v] : [v, chain[i]]) as [number, number]);
  };
  const extend = (list: [number, number][] | undefined, current: [number, number][] | undefined) => {
    if (!list) return current;
    const next = [...(current ?? [])];
    const have = new Set(next.map(([x, y]) => edgeKey(x, y)));
    for (const [x, y] of list) for (const p of pieces(x, y) ?? []) if (!have.has(edgeKey(p[0], p[1]))) next.push(p);
    return next;
  };
  out.sharpEdges = extend(src.sharpEdges, out.sharpEdges);
  out.seamEdges = extend(src.seamEdges, out.seamEdges);
  if (src.edgeCreases) {
    const next = [...(out.edgeCreases ?? [])];
    const have = new Set(next.map(([x, y]) => edgeKey(x, y)));
    for (const [x, y, w] of src.edgeCreases) for (const p of pieces(x, y) ?? []) if (!have.has(edgeKey(p[0], p[1]))) next.push([p[0], p[1], w]);
    out.edgeCreases = next;
  }
}

type Along = (a: number, c: number, i: number) => number;

function divideQuad(b: MeshBuilder, mesh: PolyMesh, face: number[], f: number, N: number, mode: DivideMode, along: Along) {
  const [v0, v1, v2, v3] = face;
  const P = (k: number) => mesh.positions[face[k]];
  // grid[j][i]: i along v0→v1, j along v0→v3 (bilinear).
  const grid: number[][] = [];
  for (let j = 0; j <= N; j++) {
    const row: number[] = [];
    for (let i = 0; i <= N; i++) {
      if (j === 0) row.push(along(v0, v1, i));
      else if (j === N) row.push(along(v3, v2, i));
      else if (i === 0) row.push(along(v0, v3, j));
      else if (i === N) row.push(along(v1, v2, j));
      else {
        const u = i / N, v = j / N;
        const w = [(1 - u) * (1 - v), u * (1 - v), u * v, (1 - u) * v];
        const p: V3 = [0, 0, 0];
        for (let k = 0; k < 4; k++) for (let c = 0; c < 3; c++) p[c] += P(k)[c] * w[k];
        row.push(b.addPoint(p, face[w.indexOf(Math.max(...w))]));
      }
    }
    grid.push(row);
  }
  const mix = (i: number, j: number): Array<[number, number]> => {
    const u = i / N, v = j / N;
    return [[0, (1 - u) * (1 - v)], [1, u * (1 - v)], [2, u * v], [3, (1 - u) * v]];
  };
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = grid[j][i], c1 = grid[j][i + 1], c2 = grid[j + 1][i + 1], c3 = grid[j + 1][i];
      if (mode === "quads") b.addFace([a, c1, c2, c3], f, [mix(i, j), mix(i + 1, j), mix(i + 1, j + 1), mix(i, j + 1)]);
      else {
        b.addFace([a, c1, c2], f, [mix(i, j), mix(i + 1, j), mix(i + 1, j + 1)]);
        b.addFace([a, c2, c3], f, [mix(i, j), mix(i + 1, j + 1), mix(i, j + 1)]);
      }
    }
  }
}

/**
 * Triangle grid over triangle (A, B, C). `corners` are the three corners'
 * source-corner mixes (for an n-gon fan, C is the centroid). `cVertex` is the
 * already-created centre point for a fan, null for a real triangle.
 */
function divideTriangle(
  b: MeshBuilder,
  mesh: PolyMesh,
  cornerIdx: [number, number, number],
  face: number[],
  f: number,
  N: number,
  along: Along,
  fan: { centre: number; centreMix: Array<[number, number]>; spoke: (k: number, i: number) => number } | null,
) {
  const A = face[cornerIdx[0]], B = face[cornerIdx[1]];
  const C = fan ? fan.centre : face[cornerIdx[2]];
  const posOf = (v: number) => b.positions[v];
  const mixA: Array<[number, number]> = [[cornerIdx[0], 1]];
  const mixB: Array<[number, number]> = [[cornerIdx[1], 1]];
  const mixC: Array<[number, number]> = fan ? fan.centreMix : [[cornerIdx[2], 1]];
  // Point (i, j): i steps toward B, j toward C; barycentric (1 - (i+j)/N, i/N, j/N).
  const rows: number[][] = [];
  for (let j = 0; j <= N; j++) {
    const row: number[] = [];
    for (let i = 0; i + j <= N; i++) {
      let v: number;
      if (j === 0) v = along(A, B, i);
      else if (i === 0) v = fan ? fan.spoke(cornerIdx[0], j) : along(A, C, j);
      else if (i + j === N) v = fan ? fan.spoke(cornerIdx[1], j) : along(B, C, j);
      else {
        const wa = 1 - (i + j) / N, wb = i / N, wc = j / N;
        const pa = posOf(A), pb = posOf(B), pc = posOf(C);
        v = b.addPoint(
          [pa[0] * wa + pb[0] * wb + pc[0] * wc, pa[1] * wa + pb[1] * wb + pc[1] * wc, pa[2] * wa + pb[2] * wb + pc[2] * wc],
          wa >= wb && wa >= wc ? A : wb >= wc ? B : nearestCorner(mesh, face, posOf(C)),
        );
      }
      row.push(v);
    }
    rows.push(row);
  }
  const mix = (i: number, j: number): Array<[number, number]> => {
    const wa = 1 - (i + j) / N, wb = i / N, wc = j / N;
    const out: Array<[number, number]> = [];
    for (const [c, w] of mixA) out.push([c, w * wa]);
    for (const [c, w] of mixB) out.push([c, w * wb]);
    for (const [c, w] of mixC) out.push([c, w * wc]);
    return out;
  };
  for (let j = 0; j < N; j++) {
    for (let i = 0; i + j < N; i++) {
      b.addFace([rows[j][i], rows[j][i + 1], rows[j + 1][i]], f, [mix(i, j), mix(i + 1, j), mix(i, j + 1)]);
      if (i + j + 1 < N) b.addFace([rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i]], f, [mix(i + 1, j), mix(i + 1, j + 1), mix(i, j + 1)]);
    }
  }
}

function divideNgon(b: MeshBuilder, mesh: PolyMesh, face: number[], f: number, N: number, along: Along) {
  const c = centroidOf(mesh.positions, face);
  const centre = b.addPoint(c, nearestCorner(mesh, face, c));
  const centreMix: Array<[number, number]> = face.map((_, k) => [k, 1 / face.length]);
  // Spoke points from corner k to the centre, shared by the two fans beside it.
  const spokes = face.map((v, k) => {
    const p = mesh.positions[v];
    const pts: number[] = [v];
    for (let j = 1; j < N; j++) {
      const t = j / N;
      pts.push(b.addPoint([p[0] + (c[0] - p[0]) * t, p[1] + (c[1] - p[1]) * t, p[2] + (c[2] - p[2]) * t], t < 0.5 ? face[k] : nearestCorner(mesh, face, c)));
    }
    pts.push(centre);
    return pts;
  });
  for (let k = 0; k < face.length; k++) {
    const k1 = (k + 1) % face.length;
    divideTriangle(b, mesh, [k, k1, -1], face, f, N, along, { centre, centreMix, spoke: (corner, j) => spokes[corner][j] });
  }
}

// =================================================================== dual

/**
 * The dual of the listed faces: every face's centroid becomes a point, and
 * every point those faces surround becomes a face through the centroids of
 * its faces, in winding order. A point on the boundary of the region (or of
 * an open mesh) has an open fan; with `keepBoundary` it still gets a face,
 * closed through the midpoints of its two boundary edges and the point
 * itself, so the dual covers the same area — without it, boundary points are
 * dropped and the dual is smaller by half a ring.
 *
 * Faces outside the list are kept unchanged (with their own points).
 */
export function dualMesh(mesh: PolyMesh, faces: Iterable<number>, keepBoundary = true): OpResult {
  const inSet = new Uint8Array(mesh.faces.length);
  for (const f of faces) if (f >= 0 && f < inSet.length && mesh.faces[f].length >= 3) inSet[f] = 1;
  const region: PolyMesh = { positions: mesh.positions, faces: mesh.faces.map((face, f) => (inSet[f] ? face : [])) };
  // A topology over the region only: an edge to an outside face is a boundary.
  const topo = getTopology(region);
  const b = new MeshBuilder(mesh);

  // Faces outside the region keep their points (created on demand).
  const vertexOf = new Int32Array(mesh.positions.length).fill(-1);
  const keepPoint = (v: number) => {
    if (vertexOf[v] < 0) vertexOf[v] = b.addPoint(mesh.positions[v], v);
    return vertexOf[v];
  };
  mesh.faces.forEach((_, f) => {
    if (!inSet[f]) b.copyFace(f, keepPoint);
  });

  const centroid = new Int32Array(mesh.faces.length).fill(-1);
  const centreOf = (f: number) => {
    if (centroid[f] < 0) {
      const c = centroidOf(mesh.positions, mesh.faces[f]);
      centroid[f] = b.addPoint(c, nearestCorner(mesh, mesh.faces[f], c));
    }
    return centroid[f];
  };
  const midpoints = new Map<string, number>();
  const midOf = (a: number, c: number) => {
    const key = edgeKey(a, c);
    let m = midpoints.get(key);
    if (m === undefined) {
      const p = mesh.positions[a], q = mesh.positions[c];
      m = b.addPoint([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2], Math.min(a, c));
      midpoints.set(key, m);
    }
    return m;
  };

  // All outgoing half-edges per vertex (a vertex can have several fans when non-manifold).
  const heCount = topo.heOrigin.length;
  const outgoing: number[][] = Array.from({ length: mesh.positions.length }, () => []);
  for (let h = 0; h < heCount; h++) outgoing[topo.heOrigin[h]].push(h);
  const visited = new Uint8Array(heCount);

  for (let v = 0; v < mesh.positions.length; v++) {
    const outs = outgoing[v];
    if (outs.length === 0) continue;
    // Open fans first (start at a half-edge with nothing clockwise of it), then closed cycles.
    const starts = [...outs.filter((h) => topo.heTwin[h] < 0), ...outs];
    for (const start of starts) {
      if (visited[start]) continue;
      const open = topo.heTwin[start] < 0;
      const fan: number[] = [];
      let h = start;
      let last = -1;
      for (let guard = 0; guard < outs.length + 1; guard++) {
        if (visited[h]) break;
        visited[h] = 1;
        fan.push(h);
        const back = topo.hePrev[h];
        last = back;
        const t = topo.heTwin[back];
        if (t < 0) break;
        h = t;
        if (h === start) break;
      }
      if (fan.length === 0) continue;
      const srcFace = topo.heFace[fan[0]];
      const centreMix = (f: number) => mesh.faces[f].map((_, k) => [f, k, 1 / mesh.faces[f].length] as [number, number, number]);
      if (!open) {
        if (fan.length < 3) continue;
        b.addFaceMix(fan.map((hh) => centreOf(topo.heFace[hh])), srcFace, fan.map((hh) => centreMix(topo.heFace[hh])));
        continue;
      }
      if (!keepBoundary) continue;
      // Open fan: midpoint of the first edge, the centroids, midpoint of the last edge, the point itself.
      const a = topo.heOrigin[topo.heNext[fan[0]]];
      const z = topo.heOrigin[last];
      const firstFace = topo.heFace[fan[0]];
      const lastFace = topo.heFace[last];
      const corner = (f: number, x: number) => Math.max(0, mesh.faces[f].indexOf(x));
      const verts = [midOf(v, a), ...fan.map((hh) => centreOf(topo.heFace[hh])), midOf(v, z), keepPoint(v)];
      const corners: Array<Array<[number, number, number]>> = [
        [[firstFace, corner(firstFace, v), 0.5], [firstFace, corner(firstFace, a), 0.5]],
        ...fan.map((hh) => centreMix(topo.heFace[hh])),
        [[lastFace, corner(lastFace, v), 0.5], [lastFace, corner(lastFace, z), 0.5]],
        [[firstFace, corner(firstFace, v), 1]],
      ];
      b.addFaceMix(verts, srcFace, corners);
    }
  }
  return b.build(vertexOf);
}

// =================================================================== scale elements

export type ElementMode = "face" | "piece";

/**
 * Scales every listed face — or every connected piece of the listed faces —
 * around its own centroid. `disconnect` gives each element its own copies of
 * its points (Blender's "individual faces" after a split); otherwise a point
 * shared by several elements takes the average of where each would put it,
 * and points shared with faces outside the list don't move apart from them.
 * `weights` (per source point) blends between unscaled (0) and scaled (1).
 */
export function scaleElements(
  mesh: PolyMesh,
  faces: Iterable<number>,
  scale: readonly number[],
  opts: { mode?: ElementMode; disconnect?: boolean; weights?: ArrayLike<number> } = {},
): OpResult {
  const sel = new Uint8Array(mesh.faces.length);
  for (const f of faces) if (f >= 0 && f < sel.length && mesh.faces[f].length > 0) sel[f] = 1;
  const s: V3 = [0, 1, 2].map((i) => (Number.isFinite(scale[i]) ? scale[i] : 1)) as V3;
  const weight = (v: number) => {
    const w = opts.weights ? Number(opts.weights[v]) : 1;
    return Number.isFinite(w) ? Math.max(0, Math.min(1, w)) : 0;
  };

  // Element id per selected face.
  const element = new Int32Array(mesh.faces.length).fill(-1);
  let elements = 0;
  if (opts.mode === "piece") {
    // Pieces of the selected faces only (connected through shared points).
    const parent = new Int32Array(mesh.positions.length).map((_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) x = parent[x] = parent[parent[x]];
      return x;
    };
    mesh.faces.forEach((face, f) => {
      if (!sel[f]) return;
      for (let i = 1; i < face.length; i++) {
        const a = find(face[0]), c = find(face[i]);
        if (a !== c) parent[a] = c;
      }
    });
    const label = new Map<number, number>();
    mesh.faces.forEach((face, f) => {
      if (!sel[f]) return;
      const r = find(face[0]);
      let id = label.get(r);
      if (id === undefined) label.set(r, (id = elements++));
      element[f] = id;
    });
  } else {
    mesh.faces.forEach((_, f) => {
      if (sel[f]) element[f] = elements++;
    });
  }

  // Element centroids (average of each element's distinct points).
  const centre = new Float64Array(elements * 3);
  const counts = new Float64Array(elements);
  const seen = new Map<number, Set<number>>();
  mesh.faces.forEach((face, f) => {
    const e = element[f];
    if (e < 0) return;
    let set = seen.get(e);
    if (!set) seen.set(e, (set = new Set()));
    for (const v of face) {
      if (set.has(v)) continue;
      set.add(v);
      const p = mesh.positions[v];
      centre[e * 3] += p[0];
      centre[e * 3 + 1] += p[1];
      centre[e * 3 + 2] += p[2];
      counts[e]++;
    }
  });
  for (let e = 0; e < elements; e++) for (let c = 0; c < 3; c++) centre[e * 3 + c] /= counts[e] || 1;

  const scaled = (v: number, e: number): V3 => {
    const p = mesh.positions[v];
    const w = weight(v);
    const out: V3 = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const target = centre[e * 3 + c] + (p[c] - centre[e * 3 + c]) * s[c];
      out[c] = p[c] + (target - p[c]) * w;
    }
    return out;
  };

  const b = new MeshBuilder(mesh);
  if (!opts.disconnect) {
    // Same points: each moves to the average of its elements' proposals, unless an outside face pins it.
    const pinned = new Uint8Array(mesh.positions.length);
    mesh.faces.forEach((face, f) => {
      if (!sel[f]) for (const v of face) pinned[v] = 1;
    });
    const acc = new Float64Array(mesh.positions.length * 3);
    const n = new Float64Array(mesh.positions.length);
    for (const [e, set] of seen) {
      for (const v of set) {
        if (pinned[v]) continue;
        const q = scaled(v, e);
        acc[v * 3] += q[0];
        acc[v * 3 + 1] += q[1];
        acc[v * 3 + 2] += q[2];
        n[v]++;
      }
    }
    mesh.positions.forEach((p, v) => b.addPoint(n[v] ? [acc[v * 3] / n[v], acc[v * 3 + 1] / n[v], acc[v * 3 + 2] / n[v]] : p, v));
    mesh.faces.forEach((_, f) => b.copyFace(f, (v) => v));
    return b.build(identityVertexOf(mesh.positions.length));
  }

  // Disconnected: outside faces share the original points; each element gets its own copies.
  const vertexOf = new Int32Array(mesh.positions.length).fill(-1);
  const keep = (v: number) => {
    if (vertexOf[v] < 0) vertexOf[v] = b.addPoint(mesh.positions[v], v);
    return vertexOf[v];
  };
  const copies = new Map<number, number>();
  const copyOf = (v: number, e: number) => {
    const key = e * mesh.positions.length + v;
    let i = copies.get(key);
    if (i === undefined) copies.set(key, (i = b.addPoint(scaled(v, e), v)));
    return i;
  };
  mesh.faces.forEach((_, f) => {
    const e = element[f];
    b.copyFace(f, e < 0 ? keep : (v) => copyOf(v, e));
  });
  // Points nothing used (loose-edge ends, stray points) stay.
  const used = new Uint8Array(mesh.positions.length);
  for (const face of mesh.faces) for (const v of face) used[v] = 1;
  for (const [a, c] of mesh.edges ?? []) {
    keep(a);
    keep(c);
  }
  mesh.positions.forEach((_, v) => {
    if (!used[v]) keep(v);
  });
  return b.build(vertexOf);
}

// =================================================================== convex hull

/**
 * 3-D convex hull by quickhull. Returns faces as indices into `points`
 * (outward winding). With `mergeCoplanar`, triangles lying in one plane are
 * joined into a single convex polygon (a cube's hull is 6 quads, not 12
 * triangles).
 *
 * Degenerate inputs never throw: fewer than three distinct points or a line
 * give no faces; a flat set gives its 2-D hull as one polygon. Non-finite
 * points are ignored.
 */
export function convexHull(points: ReadonlyArray<readonly number[]>, mergeCoplanar = true): number[][] {
  const ids: number[] = [];
  points.forEach((p, i) => {
    if (finite(p)) ids.push(i);
  });
  if (ids.length < 3) return [];
  const P = (i: number) => points[i];

  // Scale-relative tolerance.
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const ext = [0, 0, 0, 0, 0, 0];
  for (const i of ids) {
    const p = P(i);
    if (p[0] < minX) (minX = p[0]), (ext[0] = i);
    if (p[0] > maxX) (maxX = p[0]), (ext[1] = i);
    if (p[1] < minY) (minY = p[1]), (ext[2] = i);
    if (p[1] > maxY) (maxY = p[1]), (ext[3] = i);
    if (p[2] < minZ) (minZ = p[2]), (ext[4] = i);
    if (p[2] > maxZ) (maxZ = p[2]), (ext[5] = i);
  }
  const size = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  if (!(size > 0)) return [];
  const eps = size * 1e-9;

  // Initial simplex: the widest axis pair, the point farthest from that line, then from that plane.
  let i0 = ext[0], i1 = ext[1];
  let best = -1;
  for (let a = 0; a < 3; a++) {
    const d = len(sub(P(ext[a * 2 + 1]), P(ext[a * 2])));
    if (d > best) {
      best = d;
      i0 = ext[a * 2];
      i1 = ext[a * 2 + 1];
    }
  }
  const dir = sub(P(i1), P(i0));
  let i2 = -1;
  best = eps;
  for (const i of ids) {
    const d = len(cross(dir, sub(P(i), P(i0)))) / (len(dir) || 1);
    if (d > best) {
      best = d;
      i2 = i;
    }
  }
  if (i2 < 0) return []; // collinear
  const n012 = cross(sub(P(i1), P(i0)), sub(P(i2), P(i0)));
  const nl = len(n012);
  let i3 = -1;
  best = eps;
  for (const i of ids) {
    const d = Math.abs(dot(n012, sub(P(i), P(i0)))) / nl;
    if (d > best) {
      best = d;
      i3 = i;
    }
  }
  if (i3 < 0) return planarHull(points, ids, [n012[0] / nl, n012[1] / nl, n012[2] / nl]);

  // Faces as flat arrays.
  const fv: number[] = []; // 3 per face
  const fn: number[] = []; // normal xyz + offset, 4 per face
  const alive: boolean[] = [];
  const outside: number[][] = [];
  const edgeFace = new Map<number, number>();
  const K = points.length + 1;
  const dirKey = (a: number, c: number) => a * K + c;
  const distTo = (f: number, p: readonly number[]) => fn[f * 4] * p[0] + fn[f * 4 + 1] * p[1] + fn[f * 4 + 2] * p[2] - fn[f * 4 + 3];

  const addFace = (a: number, c: number, d: number): number => {
    const f = alive.length;
    const nrm = cross(sub(P(c), P(a)), sub(P(d), P(a)));
    const l = len(nrm) || 1;
    fv.push(a, c, d);
    fn.push(nrm[0] / l, nrm[1] / l, nrm[2] / l, (nrm[0] * P(a)[0] + nrm[1] * P(a)[1] + nrm[2] * P(a)[2]) / l);
    alive.push(true);
    outside.push([]);
    edgeFace.set(dirKey(a, c), f);
    edgeFace.set(dirKey(c, d), f);
    edgeFace.set(dirKey(d, a), f);
    return f;
  };

  const tetra = [i0, i1, i2, i3];
  const tc = centroidOf(points, tetra);
  for (const [a, c, d] of [[i0, i1, i2], [i0, i1, i3], [i1, i2, i3], [i2, i0, i3]]) {
    // Orient outward: the tetra's centroid must be behind.
    const nrm = cross(sub(P(c), P(a)), sub(P(d), P(a)));
    if (dot(nrm, sub(tc, P(a))) > 0) addFace(a, d, c);
    else addFace(a, c, d);
  }
  const inTetra = new Set(tetra);
  for (const i of ids) {
    if (inTetra.has(i)) continue;
    for (let f = 0; f < 4; f++) {
      if (distTo(f, P(i)) > eps) {
        outside[f].push(i);
        break;
      }
    }
  }

  const visStamp: number[] = [];
  const hidStamp: number[] = [];
  let iteration = 0;
  const maxIterations = ids.length * 4 + 64;
  for (let cursor = 0; cursor < alive.length && iteration < maxIterations; cursor++) {
    if (!alive[cursor] || outside[cursor].length === 0) continue;
    iteration++;
    // Eye: the farthest outside point of this face.
    let eye = -1;
    best = -Infinity;
    for (const i of outside[cursor]) {
      const d = distTo(cursor, P(i));
      if (d > best) {
        best = d;
        eye = i;
      }
    }
    const pe = P(eye);
    // Visible faces (connected to this one) and the horizon around them.
    const visible: number[] = [cursor];
    visStamp[cursor] = iteration;
    const horizon: [number, number][] = [];
    for (let k = 0; k < visible.length; k++) {
      const f = visible[k];
      for (let e = 0; e < 3; e++) {
        const a = fv[f * 3 + e], c = fv[f * 3 + ((e + 1) % 3)];
        const g = edgeFace.get(dirKey(c, a));
        if (g === undefined || !alive[g]) {
          horizon.push([a, c]);
          continue;
        }
        if (visStamp[g] === iteration) continue;
        if (hidStamp[g] !== iteration && distTo(g, pe) > eps) {
          visStamp[g] = iteration;
          visible.push(g);
        } else {
          hidStamp[g] = iteration;
          horizon.push([a, c]);
        }
      }
    }
    // Remove the visible faces, collecting their outside points.
    const orphans: number[] = [];
    for (const f of visible) {
      alive[f] = false;
      for (const i of outside[f]) if (i !== eye) orphans.push(i);
      outside[f] = [];
      for (let e = 0; e < 3; e++) {
        const a = fv[f * 3 + e], c = fv[f * 3 + ((e + 1) % 3)];
        if (edgeFace.get(dirKey(a, c)) === f) edgeFace.delete(dirKey(a, c));
      }
    }
    const fresh = horizon.map(([a, c]) => addFace(a, c, eye));
    for (const i of orphans) {
      for (const f of fresh) {
        if (distTo(f, P(i)) > eps) {
          outside[f].push(i);
          break;
        }
      }
    }
  }

  const tris: number[] = [];
  for (let f = 0; f < alive.length; f++) if (alive[f]) tris.push(f);
  if (!mergeCoplanar) return tris.map((f) => [fv[f * 3], fv[f * 3 + 1], fv[f * 3 + 2]]);

  // Join coplanar neighbours into polygons (flood fill across edges with the same plane).
  const region = new Map<number, number>();
  const regions: number[][] = [];
  for (const f of tris) {
    if (region.has(f)) continue;
    const id = regions.length;
    const list = [f];
    region.set(f, id);
    for (let k = 0; k < list.length; k++) {
      const g = list[k];
      for (let e = 0; e < 3; e++) {
        const a = fv[g * 3 + e], c = fv[g * 3 + ((e + 1) % 3)];
        const h = edgeFace.get(dirKey(c, a));
        if (h === undefined || !alive[h] || region.has(h)) continue;
        const same = fn[h * 4] * fn[f * 4] + fn[h * 4 + 1] * fn[f * 4 + 1] + fn[h * 4 + 2] * fn[f * 4 + 2] > 1 - 1e-9 && Math.abs(fn[h * 4 + 3] - fn[f * 4 + 3]) < eps * 10;
        if (!same) continue;
        region.set(h, id);
        list.push(h);
      }
    }
    regions.push(list);
  }
  const out: number[][] = [];
  for (const list of regions) {
    if (list.length === 1) {
      const f = list[0];
      out.push([fv[f * 3], fv[f * 3 + 1], fv[f * 3 + 2]]);
      continue;
    }
    // Boundary edges of the region chain into one loop (the region is convex).
    const inRegion = new Set(list);
    const nextOf = new Map<number, number>();
    let ok = true;
    for (const g of list) {
      for (let e = 0; e < 3; e++) {
        const a = fv[g * 3 + e], c = fv[g * 3 + ((e + 1) % 3)];
        const h = edgeFace.get(dirKey(c, a));
        if (h !== undefined && inRegion.has(h)) continue;
        if (nextOf.has(a)) ok = false;
        nextOf.set(a, c);
      }
    }
    const loop: number[] = [];
    if (ok && nextOf.size >= 3) {
      const start = nextOf.keys().next().value as number;
      let v = start;
      for (let guard = 0; guard <= nextOf.size; guard++) {
        loop.push(v);
        const nv = nextOf.get(v);
        if (nv === undefined) {
          ok = false;
          break;
        }
        v = nv;
        if (v === start) break;
      }
      if (v !== start || loop.length !== nextOf.size) ok = false;
    } else ok = false;
    if (ok) out.push(loop);
    else for (const f of list) out.push([fv[f * 3], fv[f * 3 + 1], fv[f * 3 + 2]]);
  }
  return out;
}

/** 2-D hull (Andrew's monotone chain) of points lying in one plane, as one polygon facing `normal`. */
function planarHull(points: ReadonlyArray<readonly number[]>, ids: number[], normal: V3): number[][] {
  const helper: V3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = cross(helper, normal);
  const ul = len(u);
  const U: V3 = [u[0] / ul, u[1] / ul, u[2] / ul];
  const V = cross(normal, U);
  const pts = ids.map((i) => ({ i, x: dot(points[i], U), y: dot(points[i], V) }));
  pts.sort((a, c) => a.x - c.x || a.y - c.y);
  const crossZ = (o: (typeof pts)[0], a: (typeof pts)[0], c: (typeof pts)[0]) => (a.x - o.x) * (c.y - o.y) - (a.y - o.y) * (c.x - o.x);
  const lower: typeof pts = [];
  for (const p of pts) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: typeof pts = [];
  for (let k = pts.length - 1; k >= 0; k--) {
    const p = pts[k];
    while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)].map((p) => p.i);
  return hull.length >= 3 ? [hull] : [];
}

/** A mesh of the hull of `points`, with each hull point remembering its source index. */
export function hullMesh(points: ReadonlyArray<readonly number[]>, mergeCoplanar = true): { mesh: PolyMesh; source: Int32Array } {
  const faces = convexHull(points, mergeCoplanar);
  const remap = new Map<number, number>();
  const source: number[] = [];
  const positions: V3[] = [];
  const out = faces.map((face) =>
    face.map((i) => {
      let j = remap.get(i);
      if (j === undefined) {
        j = positions.length;
        remap.set(i, j);
        positions.push([points[i][0], points[i][1], points[i][2]]);
        source.push(i);
      }
      return j;
    }),
  );
  return { mesh: { positions, faces: out, shading: "flat" }, source: Int32Array.from(source) };
}

// =================================================================== bounding box

export interface OrientedBox {
  center: V3;
  /** Unit axes, right-handed. */
  axes: [V3, V3, V3];
  /** Half extents along each axis. */
  half: V3;
}

/**
 * Axis-aligned or oriented bounding box. The oriented one takes its axes
 * from the principal components of the points (covariance eigenvectors) —
 * not the minimal-volume box, but the right one for the elongated and flat
 * shapes a box is usually asked to fit, and stable as points move.
 */
export function boundingBox(points: ReadonlyArray<readonly number[]>, oriented: boolean): OrientedBox {
  const pts = points.filter(finite);
  let axes: [V3, V3, V3] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  if (oriented && pts.length >= 2) {
    const m: V3 = [0, 0, 0];
    for (const p of pts) for (let c = 0; c < 3; c++) m[c] += p[c] / pts.length;
    const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const p of pts) {
      const d = sub(p, m);
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cov[r * 3 + c] += d[r] * d[c];
    }
    const { vectors } = jacobiEigen(cov);
    // Largest variance first; right-handed.
    const a0 = vectors[0], a1 = vectors[1];
    axes = [a0, a1, cross(a0, a1)];
  }
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    for (let c = 0; c < 3; c++) {
      const d = dot(p, axes[c]);
      if (d < lo[c]) lo[c] = d;
      if (d > hi[c]) hi[c] = d;
    }
  }
  if (pts.length === 0) return { center: [0, 0, 0], axes, half: [0, 0, 0] };
  const mid: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const center: V3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) center[k] += axes[c][k] * mid[c];
  return { center, axes, half: [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2] };
}

/** Eigen-decomposition of a symmetric 3×3 (row-major), eigenvectors sorted by decreasing eigenvalue. */
function jacobiEigen(m: number[]): { values: V3; vectors: [V3, V3, V3] } {
  const a = [...m];
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]);
    if (off < 1e-30) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = a[p * 3 + q];
      if (Math.abs(apq) < 1e-30) continue;
      const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p], akq = a[k * 3 + q];
        a[k * 3 + p] = c * akp - s * akq;
        a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k], aqk = a[q * 3 + k];
        a[p * 3 + k] = c * apk - s * aqk;
        a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p], vkq = v[k * 3 + q];
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((x, y) => a[y * 4] - a[x * 4]);
  const col = (k: number): V3 => {
    const x: V3 = [v[k], v[3 + k], v[6 + k]];
    const l = len(x) || 1;
    return [x[0] / l, x[1] / l, x[2] / l];
  };
  return { values: order.map((k) => a[k * 4]) as V3, vectors: [col(order[0]), col(order[1]), col(order[2])] };
}

/** A closed 8-point, 6-quad box mesh (outward winding, box-projected UVs). */
export function boxToMesh(box: OrientedBox): PolyMesh {
  const corner = (sx: number, sy: number, sz: number): V3 => {
    const out: V3 = [...box.center];
    const s = [sx, sy, sz];
    for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) out[k] += box.axes[c][k] * box.half[c] * s[c];
    return out;
  };
  const positions: V3[] = [
    corner(-1, -1, -1), corner(1, -1, -1), corner(1, 1, -1), corner(-1, 1, -1),
    corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1),
  ];
  // Same winding as createQuadBox (outward for a right-handed basis).
  const faces = [[4, 5, 6, 7], [1, 0, 3, 2], [7, 6, 2, 3], [0, 1, 5, 4], [5, 1, 2, 6], [0, 4, 7, 3]];
  const quadUV: UV[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  return { positions, faces, faceUVs: faces.map(() => quadUV.map((uv) => [uv[0], uv[1]] as UV)), shading: "flat" };
}

/** Appends `b` to `a` (b's points renumbered after a's); maps report b's elements as -1. */
export function appendMesh(a: PolyMesh, b: PolyMesh): OpResult {
  const n = a.positions.length;
  const hasUV = Boolean(a.faceUVs || a.uvs || b.faceUVs);
  const uvOf = (m: PolyMesh, f: number, c: number): UV => {
    const uv = m.faceUVs?.[f]?.[c] ?? m.uvs?.[m.faces[f][c]];
    return uv ? [uv[0], uv[1]] : [0, 0];
  };
  const mesh: PolyMesh = {
    ...a,
    uvs: undefined,
    positions: [...a.positions.map((p) => [p[0], p[1], p[2]] as V3), ...b.positions.map((p) => [p[0], p[1], p[2]] as V3)],
    faces: [...a.faces.map((f) => [...f]), ...b.faces.map((f) => f.map((v) => v + n))],
    faceUVs: hasUV ? [...a.faces.map((face, f) => face.map((_, c) => uvOf(a, f, c))), ...b.faces.map((face, f) => face.map((_, c) => uvOf(b, f, c)))] : undefined,
    faceMaterials: a.faceMaterials ? [...a.faceMaterials, ...b.faces.map(() => 0)] : undefined,
    faceColors: a.faceColors ? [...a.faceColors, ...b.faces.map(() => null)] : undefined,
    faceShading: a.faceShading?.length ? [...a.faceShading, ...b.faces.map(() => b.shading ?? "flat")] : undefined,
  };
  const point = new Int32Array(mesh.positions.length).fill(-1);
  for (let i = 0; i < n; i++) point[i] = i;
  const face = new Int32Array(mesh.faces.length).fill(-1);
  for (let i = 0; i < a.faces.length; i++) face[i] = i;
  return { mesh, maps: { point, face } };
}

// =================================================================== decimation

export interface DecimateOptions {
  /** Triangles to keep among the decimated faces (after triangulation). */
  targetTriangles: number;
  /** Points on an open boundary never move. */
  preserveBoundary?: boolean;
}

/**
 * Quadric error edge collapse (Garland–Heckbert). The listed faces are
 * triangulated; every point carries the sum of the squared distances to the
 * planes of its original triangles, and the cheapest edge — the one whose
 * merged point stays closest to all of those planes — collapses first, from
 * a binary heap with lazy invalidation (a per-point stamp), so a 20k-face
 * mesh reduces in well under a second.
 *
 * Collapses that would fold a triangle over (normal flips), pinch the
 * surface into a non-manifold (link condition) or move a point of a face
 * outside the list are refused. Open boundaries are either pinned or held
 * in place by perpendicular "boundary planes" in the quadrics.
 *
 * UVs and corner colours follow each collapse along the edge (the edge's
 * UV delta, applied in every triangle's own chart, so seams stay apart).
 */
export function decimateMesh(mesh: PolyMesh, faces: Iterable<number>, opts: DecimateOptions): OpResult & { triangles: number } {
  const nV = mesh.positions.length;
  const sel = new Uint8Array(mesh.faces.length);
  for (const f of faces) if (f >= 0 && f < sel.length && mesh.faces[f].length >= 3) sel[f] = 1;

  const pos = new Float64Array(nV * 3);
  mesh.positions.forEach((p, i) => {
    for (let c = 0; c < 3; c++) pos[i * 3 + c] = Number.isFinite(p[c]) ? p[c] : 0;
  });

  // Corner channels: uv (2) + colour (3) when present.
  const hasUV = Boolean(mesh.faceUVs || (mesh.uvs && mesh.uvs.length === nV));
  const hasColor = Boolean(mesh.faceColors && mesh.faceColors.some((c) => c));
  const C = (hasUV ? 2 : 0) + (hasColor ? 3 : 0);

  // Triangles of the decimated faces.
  const tv: number[] = [];
  const tsrc: number[] = [];
  const tdata: number[] = [];
  const locked = new Uint8Array(nV);
  mesh.faces.forEach((face, f) => {
    if (!sel[f]) {
      for (const v of face) locked[v] = 1;
      return;
    }
    for (const tri of triangulateFace(mesh.positions, face)) {
      for (const k of tri) {
        tv.push(face[k]);
        if (hasUV) {
          const uv = mesh.faceUVs?.[f]?.[k] ?? mesh.uvs?.[face[k]] ?? [0, 0];
          tdata.push(uv[0], uv[1]);
        }
        if (hasColor) {
          const col = mesh.faceColors?.[f]?.[k] ?? [1, 1, 1];
          tdata.push(col[0], col[1], col[2]);
        }
      }
      tsrc.push(f);
    }
  });
  for (const [a, c] of mesh.edges ?? []) locked[a] = locked[c] = 1;
  const T = tsrc.length;
  const talive = new Uint8Array(T).fill(1);
  let liveTris = T;
  const target = Math.max(0, Math.floor(opts.targetTriangles));

  const vtris: number[][] = Array.from({ length: nV }, () => []);
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) vtris[tv[t * 3 + k]].push(t);

  // Boundary edges of the triangle set (an edge to an outside face counts: its points are locked anyway).
  const edgeUse = new Map<number, number>();
  const ek = (a: number, c: number) => (a < c ? a * nV + c : c * nV + a);
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
    const key = ek(tv[t * 3 + k], tv[t * 3 + ((k + 1) % 3)]);
    edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
  }
  const boundary = new Uint8Array(nV);
  for (const [key, n] of edgeUse) if (n === 1) {
    boundary[Math.floor(key / nV)] = 1;
    boundary[key % nV] = 1;
  }
  if (opts.preserveBoundary) for (let v = 0; v < nV; v++) if (boundary[v]) locked[v] = 1;

  // Quadrics: [aa ab ac ad bb bc bd cc cd dd].
  const Q = new Float64Array(nV * 10);
  const addPlane = (v: number, a: number, b: number, c: number, d: number, w: number) => {
    const q = v * 10;
    Q[q] += w * a * a; Q[q + 1] += w * a * b; Q[q + 2] += w * a * c; Q[q + 3] += w * a * d;
    Q[q + 4] += w * b * b; Q[q + 5] += w * b * c; Q[q + 6] += w * b * d;
    Q[q + 7] += w * c * c; Q[q + 8] += w * c * d; Q[q + 9] += w * d * d;
  };
  const P3 = (v: number): V3 => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
  const triNormal = (a: V3, b: V3, c: V3): V3 => cross(sub(b, a), sub(c, a));
  let meanEdge = 0;
  for (let t = 0; t < T; t++) {
    const a = P3(tv[t * 3]), b = P3(tv[t * 3 + 1]), c = P3(tv[t * 3 + 2]);
    const nrm = triNormal(a, b, c);
    const l = len(nrm);
    meanEdge += len(sub(b, a));
    if (l < 1e-20) continue;
    const nx = nrm[0] / l, ny = nrm[1] / l, nz = nrm[2] / l;
    const d = -(nx * a[0] + ny * a[1] + nz * a[2]);
    const area = l / 2;
    for (let k = 0; k < 3; k++) addPlane(tv[t * 3 + k], nx, ny, nz, d, area);
    if (!opts.preserveBoundary) {
      // Boundary planes: perpendicular to the triangle through each open edge, heavily weighted.
      for (let k = 0; k < 3; k++) {
        const u = tv[t * 3 + k], w = tv[t * 3 + ((k + 1) % 3)];
        if (edgeUse.get(ek(u, w)) !== 1) continue;
        const e = sub(P3(w), P3(u));
        const bn = cross(e, [nx, ny, nz]);
        const bl = len(bn);
        if (bl < 1e-20) continue;
        const bx = bn[0] / bl, by = bn[1] / bl, bz = bn[2] / bl;
        const bd = -(bx * pos[u * 3] + by * pos[u * 3 + 1] + bz * pos[u * 3 + 2]);
        const weight = 100 * dot(e, e);
        addPlane(u, bx, by, bz, bd, weight);
        addPlane(w, bx, by, bz, bd, weight);
      }
    }
  }
  meanEdge = T ? meanEdge / T : 1;

  const quadricError = (q: Float64Array, x: number, y: number, z: number) =>
    q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x + q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y + q[7] * z * z + 2 * q[8] * z + q[9];
  const qsum = new Float64Array(10);

  /** Where u + v would collapse to, and at what cost; null if not allowed. `keep` is the point that survives. */
  const plan = (u: number, v: number): { cost: number; keep: number; gone: number; p: V3 } | null => {
    if (locked[u] && locked[v]) return null;
    let keep = u, gone = v;
    if (locked[v]) (keep = v), (gone = u);
    for (let k = 0; k < 10; k++) qsum[k] = Q[keep * 10 + k] + Q[gone * 10 + k];
    const pk = P3(keep), pg = P3(gone);
    const edgeLen2 = (pk[0] - pg[0]) ** 2 + (pk[1] - pg[1]) ** 2 + (pk[2] - pg[2]) ** 2;
    let p: V3;
    if (locked[keep]) p = pk;
    else {
      const candidates: V3[] = [[(pk[0] + pg[0]) / 2, (pk[1] + pg[1]) / 2, (pk[2] + pg[2]) / 2], pk, pg];
      const opt = solveQuadric(qsum);
      // The optimum is only trusted near the edge: a near-singular system can throw it far away.
      if (opt && (opt[0] - candidates[0][0]) ** 2 + (opt[1] - candidates[0][1]) ** 2 + (opt[2] - candidates[0][2]) ** 2 < edgeLen2) candidates.unshift(opt);
      p = candidates[0];
      let bestE = quadricError(qsum, p[0], p[1], p[2]);
      for (let k = 1; k < candidates.length; k++) {
        const e = quadricError(qsum, candidates[k][0], candidates[k][1], candidates[k][2]);
        if (e < bestE - 1e-15) {
          bestE = e;
          p = candidates[k];
        }
      }
    }
    // Shortest edges first where the error ties (flat regions): keeps the triangles even.
    const err = Math.max(0, quadricError(qsum, p[0], p[1], p[2]));
    return { cost: err + 1e-6 * edgeLen2 * edgeLen2 / (meanEdge * meanEdge || 1), keep, gone, p };
  };

  const stamp = new Int32Array(nV);
  const alive = new Uint8Array(nV).fill(1);
  const heap = new CollapseHeap();
  const pushEdge = (u: number, v: number) => {
    const pl = plan(u, v);
    if (pl) heap.push(pl.cost, u, v, stamp[u], stamp[v]);
  };
  for (const key of edgeUse.keys()) pushEdge(Math.floor(key / nV), key % nV);

  const neighbours = (v: number, into: Set<number>) => {
    into.clear();
    for (const t of vtris[v]) {
      if (!talive[t]) continue;
      for (let k = 0; k < 3; k++) {
        const w = tv[t * 3 + k];
        if (w !== v) into.add(w);
      }
    }
    return into;
  };
  const nu = new Set<number>(), ng = new Set<number>();

  while (liveTris > target && heap.size > 0) {
    const [u, v, su, sv] = heap.pop();
    if (!alive[u] || !alive[v] || stamp[u] !== su || stamp[v] !== sv) continue;
    const pl = plan(u, v);
    if (!pl) continue;
    const { keep, gone, p } = pl;

    // Triangles on the edge.
    const shared: number[] = [];
    for (const t of vtris[gone]) {
      if (!talive[t]) continue;
      if (tv[t * 3] === keep || tv[t * 3 + 1] === keep || tv[t * 3 + 2] === keep) shared.push(t);
    }
    if (shared.length === 0) continue;
    // Link condition: the only common neighbours are the shared triangles' third points.
    neighbours(keep, nu);
    neighbours(gone, ng);
    let common = 0;
    for (const w of ng) if (nu.has(w)) common++;
    if (common !== shared.length) continue;
    if (shared.length === 2 && boundary[keep] && boundary[gone]) continue; // would pinch two boundaries together
    if (shared.length > 2) continue;

    // No triangle may flip or collapse to nothing.
    let flips = false;
    for (const w of [keep, gone]) {
      for (const t of vtris[w]) {
        if (!talive[t] || shared.includes(t)) continue;
        const corners = [tv[t * 3], tv[t * 3 + 1], tv[t * 3 + 2]];
        const before = triNormal(P3(corners[0]), P3(corners[1]), P3(corners[2]));
        const moved = corners.map((x) => (x === keep || x === gone ? p : P3(x))) as [V3, V3, V3];
        const after = triNormal(moved[0], moved[1], moved[2]);
        const lb = len(before), la = len(after);
        if (lb < 1e-24) continue;
        if (la < lb * 1e-6 || dot(before, after) < 0.2 * lb * la) {
          flips = true;
          break;
        }
      }
      if (flips) break;
    }
    if (flips) continue;

    // Corner data follows the collapse along the edge.
    if (C > 0) {
      const t0 = shared[0];
      const kk = [0, 1, 2].find((k) => tv[t0 * 3 + k] === keep)!;
      const kg = [0, 1, 2].find((k) => tv[t0 * 3 + k] === gone)!;
      const pk = P3(keep), pg = P3(gone);
      const e = sub(pk, pg);
      const ee = dot(e, e);
      const s = ee > 0 ? Math.max(0, Math.min(1, dot(sub(p, pg), e) / ee)) : 0.5;
      const delta: number[] = [];
      for (let c = 0; c < C; c++) delta.push(tdata[(t0 * 3 + kk) * C + c] - tdata[(t0 * 3 + kg) * C + c]);
      for (const [w, factor] of [[gone, s], [keep, s - 1]] as const) {
        for (const t of vtris[w]) {
          if (!talive[t] || shared.includes(t)) continue;
          for (let k = 0; k < 3; k++) if (tv[t * 3 + k] === w) for (let c = 0; c < C; c++) tdata[(t * 3 + k) * C + c] += factor * delta[c];
        }
      }
    }

    for (const t of shared) {
      talive[t] = 0;
      liveTris--;
    }
    for (const t of vtris[gone]) {
      if (!talive[t]) continue;
      for (let k = 0; k < 3; k++) if (tv[t * 3 + k] === gone) tv[t * 3 + k] = keep;
      vtris[keep].push(t);
    }
    vtris[gone] = [];
    vtris[keep] = [...new Set(vtris[keep].filter((t) => talive[t]))];
    pos[keep * 3] = p[0];
    pos[keep * 3 + 1] = p[1];
    pos[keep * 3 + 2] = p[2];
    for (let k = 0; k < 10; k++) Q[keep * 10 + k] += Q[gone * 10 + k];
    alive[gone] = 0;
    boundary[keep] = boundary[keep] || boundary[gone] ? 1 : 0;
    stamp[keep]++;
    for (const w of neighbours(keep, nu)) pushEdge(keep, w);
  }

  // Output: points that survive (and stray points no face used), outside faces as they were, then the triangles.
  const used = new Uint8Array(nV);
  mesh.faces.forEach((face, f) => {
    if (!sel[f]) for (const v of face) used[v] = 1;
  });
  for (let t = 0; t < T; t++) if (talive[t]) for (let k = 0; k < 3; k++) used[tv[t * 3 + k]] = 1;
  const inFace = new Uint8Array(nV);
  for (const face of mesh.faces) for (const v of face) inFace[v] = 1;
  for (const [a, c] of mesh.edges ?? []) used[a] = used[c] = 1;
  const b = new MeshBuilder(mesh);
  const vertexOf = new Int32Array(nV).fill(-1);
  for (let v = 0; v < nV; v++) if ((used[v] && alive[v]) || !inFace[v]) vertexOf[v] = b.addPoint(P3(v), v);
  mesh.faces.forEach((_, f) => {
    if (!sel[f]) b.copyFace(f, (v) => vertexOf[v]);
  });
  let triangles = 0;
  for (let t = 0; t < T; t++) {
    if (!talive[t]) continue;
    triangles++;
    const verts = [tv[t * 3], tv[t * 3 + 1], tv[t * 3 + 2]].map((v) => vertexOf[v]);
    const uvs = hasUV ? [0, 1, 2].map((k) => [tdata[(t * 3 + k) * C], tdata[(t * 3 + k) * C + 1]] as UV) : null;
    const off = hasUV ? 2 : 0;
    const colors = hasColor ? [0, 1, 2].map((k) => [0, 1, 2].map((c) => tdata[(t * 3 + k) * C + off + c]) as Color3) : null;
    b.addFaceWithData(verts, tsrc[t], uvs, colors);
  }
  return { ...b.build(vertexOf), triangles };
}

/** Solves A x = -b for the quadric's minimum; null when the system is (near) singular. */
function solveQuadric(q: Float64Array): V3 | null {
  const a00 = q[0], a01 = q[1], a02 = q[2], a11 = q[4], a12 = q[5], a22 = q[7];
  const b0 = -q[3], b1 = -q[6], b2 = -q[8];
  const c00 = a11 * a22 - a12 * a12;
  const c01 = a02 * a12 - a01 * a22;
  const c02 = a01 * a12 - a02 * a11;
  const det = a00 * c00 + a01 * c01 + a02 * c02;
  const scale = Math.abs(a00) + Math.abs(a11) + Math.abs(a22);
  if (!(Math.abs(det) > 1e-9 * scale * scale * scale) || scale === 0) return null;
  const c11 = a00 * a22 - a02 * a02;
  const c12 = a01 * a02 - a00 * a12;
  const c22 = a00 * a11 - a01 * a01;
  const x = (c00 * b0 + c01 * b1 + c02 * b2) / det;
  const y = (c01 * b0 + c11 * b1 + c12 * b2) / det;
  const z = (c02 * b0 + c12 * b1 + c22 * b2) / det;
  return Number.isFinite(x + y + z) ? [x, y, z] : null;
}

/** Min-heap of candidate collapses (cost, u, v, stamps), parallel arrays. */
class CollapseHeap {
  private cost: number[] = [];
  private data: number[] = []; // 4 per entry
  get size() {
    return this.cost.length;
  }
  push(cost: number, u: number, v: number, su: number, sv: number) {
    let i = this.cost.length;
    this.cost.push(cost);
    this.data.push(u, v, su, sv);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cost[p] <= cost) break;
      this.move(p, i);
      i = p;
    }
    this.cost[i] = cost;
    this.data[i * 4] = u;
    this.data[i * 4 + 1] = v;
    this.data[i * 4 + 2] = su;
    this.data[i * 4 + 3] = sv;
  }
  pop(): [number, number, number, number] {
    const d = this.data;
    const top: [number, number, number, number] = [d[0], d[1], d[2], d[3]];
    const lastCost = this.cost.pop()!;
    const last = d.splice(d.length - 4, 4);
    const n = this.cost.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = -1;
        let mc = lastCost;
        if (l < n && this.cost[l] < mc) (m = l), (mc = this.cost[l]);
        if (r < n && this.cost[r] < mc) (m = r), (mc = this.cost[r]);
        if (m < 0) break;
        this.move(m, i);
        i = m;
      }
      this.cost[i] = lastCost;
      d[i * 4] = last[0];
      d[i * 4 + 1] = last[1];
      d[i * 4 + 2] = last[2];
      d[i * 4 + 3] = last[3];
    }
    return top;
  }
  private move(from: number, to: number) {
    this.cost[to] = this.cost[from];
    for (let k = 0; k < 4; k++) this.data[to * 4 + k] = this.data[from * 4 + k];
  }
}

// =================================================================== sort / subset

/** Points reordered: output point i is source point `order[i]` (a permutation). */
export function permutePoints(mesh: PolyMesh, order: ArrayLike<number>): OpResult {
  const n = mesh.positions.length;
  const inverse = new Int32Array(n).fill(-1);
  for (let i = 0; i < order.length; i++) inverse[order[i]] = i;
  const out: PolyMesh = {
    ...mesh,
    positions: Array.from(order, (s) => [mesh.positions[s][0], mesh.positions[s][1], mesh.positions[s][2]] as V3),
    faces: mesh.faces.map((face) => face.map((v) => inverse[v])),
    uvs: mesh.uvs && mesh.uvs.length === n ? Array.from(order, (s) => [mesh.uvs![s][0], mesh.uvs![s][1]] as UV) : mesh.uvs,
  };
  remapEdgeAttributes(mesh, out, inverse);
  const face = new Int32Array(mesh.faces.length).map((_, i) => i);
  return { mesh: out, maps: { point: Int32Array.from(order), face } };
}

/** Faces reordered: output face i is source face `order[i]` (a permutation). */
export function permuteFaces(mesh: PolyMesh, order: ArrayLike<number>): OpResult {
  const pick = <T>(list: T[] | undefined): T[] | undefined => (list && list.length ? Array.from(order, (s) => list[s]) : list);
  const out: PolyMesh = {
    ...mesh,
    faces: Array.from(order, (s) => [...mesh.faces[s]]),
    faceUVs: pick(mesh.faceUVs),
    faceColors: pick(mesh.faceColors),
    faceMaterials: pick(mesh.faceMaterials),
    faceShading: pick(mesh.faceShading),
  };
  return { mesh: out, maps: { point: identityVertexOf(mesh.positions.length), face: Int32Array.from(order) } };
}

/**
 * The part of a mesh a mask keeps, Houdini's Blast with "delete non
 * selected": faces kept by `keepFace`, loose edges whose ends both survive,
 * and points — those the kept faces and edges use, plus every point in
 * `keepPoint` even when no face is left around it (a point group keeps its
 * points).
 */
export function subsetMesh(
  mesh: PolyMesh,
  keepFace: (f: number) => boolean,
  keepPoint: ((v: number) => boolean) | null,
  extraEdges: ReadonlyArray<readonly [number, number]> = [],
): OpResult {
  const b = new MeshBuilder(mesh);
  const kept: number[] = [];
  mesh.faces.forEach((_, f) => {
    if (keepFace(f)) kept.push(f);
  });
  const want = new Uint8Array(mesh.positions.length);
  for (const f of kept) for (const v of mesh.faces[f]) want[v] = 1;
  const loose: [number, number][] = [];
  const looseKeys = new Set<string>();
  const offerLoose = (a: number, c: number) => {
    if (keepPoint && !(keepPoint(a) && keepPoint(c))) return;
    const k = edgeKey(a, c);
    if (looseKeys.has(k) || a === c) return;
    looseKeys.add(k);
    loose.push(a < c ? [a, c] : [c, a]);
    want[a] = want[c] = 1;
  };
  if (keepPoint) for (const [a, c] of mesh.edges ?? []) offerLoose(a, c);
  for (const [a, c] of extraEdges) offerLoose(a, c);
  if (keepPoint) mesh.positions.forEach((_, v) => keepPoint(v) && (want[v] = 1));
  const vertexOf = new Int32Array(mesh.positions.length).fill(-1);
  mesh.positions.forEach((p, v) => {
    if (want[v]) vertexOf[v] = b.addPoint(p, v);
  });
  for (const f of kept) b.copyFace(f, (v) => vertexOf[v]);
  const result = b.build(vertexOf, { keepLooseEdges: false });
  // Loose edges that a kept face doesn't already use.
  const faceKeys = new Set<string>();
  for (const face of result.mesh.faces) face.forEach((v, i) => faceKeys.add(edgeKey(v, face[(i + 1) % face.length])));
  const edges: [number, number][] = [];
  for (const [a, c] of loose) {
    const x = vertexOf[a], y = vertexOf[c];
    if (x < 0 || y < 0 || faceKeys.has(edgeKey(x, y))) continue;
    edges.push(x < y ? [x, y] : [y, x]);
  }
  result.mesh.edges = edges.length ? edges : undefined;
  return result;
}
