import { cloneQuadMesh, withFaceUVs, type PolyMesh } from "../quadMesh";
import { compactMesh, projectNewFaceUVs } from "./tools";
import { edgeKey, meshEdgeKeys, splitEdgeAttributes } from "./attributes";
import { triangulateFace } from "./triangulate";
import { PointTree } from "./spatial";
import type { PropagationMaps } from "./propagate";
import { lerpUV, type UV } from "./uv";

/*
 * Geometry for the Modeling nodes (nodes/modelingOps.ts) that the Edit Mesh
 * kernel (tools.ts, bevel.ts, bridge.ts…) doesn't already have, or has only
 * in a form tied to an interactive selection: vertex bevel, a revolve over
 * any set of edges, mirror across any axis plane, a plane clip with caps,
 * hole filling, edge split, triangulate / tris-to-quads, a bridge with
 * segments and twist.
 *
 * Same contract as the rest of mesh/: the input is never mutated, per-corner
 * UVs, colours, material slots and shading travel with the faces, and each
 * operation also reports *provenance* (`maps`, see propagate.ts) — which
 * source point / face every output element came from — so named attributes
 * and groups survive it exactly instead of being guessed from positions.
 *
 * In a provenance map, -1 means "new, from nothing" (the attribute reads 0)
 * and UNKNOWN means "work it out geometrically" (completeMaps).
 */

type V3 = [number, number, number];

export const UNKNOWN = -2;

const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
const lerp3 = (a: readonly number[], b: readonly number[], t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const normalize = (a: readonly number[], fallback: V3 = [0, 0, 1]): V3 => {
  const l = len(a);
  return l > 1e-12 && Number.isFinite(l) ? [a[0] / l, a[1] / l, a[2] / l] : fallback;
};
const finite3 = (a: readonly number[], fallback: V3 = [0, 0, 0]): V3 =>
  a.length >= 3 && a.every((x) => Number.isFinite(x)) ? [a[0], a[1], a[2]] : fallback;

/** Newell normal of a face: robust for n-gons and non-planar quads. */
export function faceNormalOf(positions: ReadonlyArray<readonly number[]>, face: readonly number[]): V3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < face.length; i++) {
    const c = positions[face[i]];
    const d = positions[face[(i + 1) % face.length]];
    if (!c || !d) continue;
    x += (c[1] - d[1]) * (c[2] + d[2]);
    y += (c[2] - d[2]) * (c[0] + d[0]);
    z += (c[0] - d[0]) * (c[1] + d[1]);
  }
  return normalize([x, y, z]);
}

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

function boundsDiagonal(positions: ReadonlyArray<readonly number[]>): number {
  if (positions.length === 0) return 1;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of positions) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[k]);
      hi[k] = Math.max(hi[k], p[k]);
    }
  }
  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
}

/** "a>b" for every half-edge of every non-empty face. */
function directedEdges(mesh: PolyMesh): Set<string> {
  const set = new Set<string>();
  for (const face of mesh.faces) for (let i = 0; i < face.length; i++) set.add(`${face[i]}>${face[(i + 1) % face.length]}`);
  return set;
}

// ---------------------------------------------------------------- provenance

/**
 * Fills the UNKNOWN entries of partial provenance maps from geometry: a point
 * takes the nearest source point; a face the source face sharing most of its
 * (mapped) corners, the nearest centroid breaking ties or standing in when
 * none share any. Entries already set (including -1) are kept.
 */
export function completeMaps(src: PolyMesh, out: PolyMesh, point?: ArrayLike<number> | null, face?: ArrayLike<number> | null): Required<PropagationMaps> {
  const pointMap = new Int32Array(out.positions.length).fill(UNKNOWN);
  if (point) for (let i = 0; i < pointMap.length; i++) pointMap[i] = point[i] ?? UNKNOWN;
  let tree: PointTree | null = null;
  for (let i = 0; i < pointMap.length; i++) {
    if (pointMap[i] !== UNKNOWN) continue;
    if (src.positions.length === 0) {
      pointMap[i] = -1;
      continue;
    }
    tree ??= new PointTree(src.positions);
    const p = out.positions[i];
    pointMap[i] = tree.nearest(p[0], p[1], p[2]).index;
  }

  const faceMap = new Int32Array(out.faces.length).fill(UNKNOWN);
  if (face) for (let i = 0; i < faceMap.length; i++) faceMap[i] = face[i] ?? UNKNOWN;
  let facesOfPoint: number[][] | null = null;
  let centroidTree: PointTree | null = null;
  const srcCentroids = () => src.faces.map((f) => centroidOf(src.positions, f));
  for (let f = 0; f < faceMap.length; f++) {
    if (faceMap[f] !== UNKNOWN) continue;
    if (src.faces.length === 0) {
      faceMap[f] = -1;
      continue;
    }
    if (!facesOfPoint) {
      facesOfPoint = Array.from({ length: src.positions.length }, () => [] as number[]);
      src.faces.forEach((sf, i) => sf.forEach((v) => facesOfPoint![v]?.push(i)));
    }
    const votes = new Map<number, number>();
    for (const v of out.faces[f]) {
      const sv = pointMap[v];
      if (sv < 0) continue;
      for (const sf of facesOfPoint[sv] ?? []) votes.set(sf, (votes.get(sf) ?? 0) + 1);
    }
    const c = centroidOf(out.positions, out.faces[f]);
    let best = -1;
    let bestVotes = 0;
    let bestDist = Infinity;
    for (const [sf, n] of votes) {
      if (n < bestVotes) continue;
      const d = len(sub(centroidOf(src.positions, src.faces[sf]), c));
      if (n > bestVotes || d < bestDist) {
        best = sf;
        bestVotes = n;
        bestDist = d;
      }
    }
    if (best < 0) {
      centroidTree ??= new PointTree(srcCentroids());
      best = centroidTree.nearest(c[0], c[1], c[2]).index;
    }
    faceMap[f] = best;
  }
  return { point: pointMap, face: faceMap };
}

/**
 * compactMesh, with provenance carried through it: `pointSrc` / `faceSrc`
 * describe `next` (before compaction), the result describes the compacted mesh.
 */
export function compactWithMaps(
  next: PolyMesh,
  pointSrc: ArrayLike<number>,
  faceSrc: ArrayLike<number>,
): { mesh: PolyMesh; point: Int32Array; face: Int32Array; remapFace: Int32Array; remapVertex: Int32Array } {
  const { mesh, remapFace, remapVertex } = compactMesh(next);
  const point = new Int32Array(mesh.positions.length).fill(UNKNOWN);
  const seen = new Uint8Array(mesh.positions.length);
  for (let i = 0; i < remapVertex.length; i++) {
    const o = remapVertex[i];
    if (o < 0 || seen[o]) continue;
    seen[o] = 1;
    point[o] = pointSrc[i] ?? UNKNOWN;
  }
  const face = new Int32Array(mesh.faces.length).fill(UNKNOWN);
  for (let f = 0; f < remapFace.length; f++) if (remapFace[f] >= 0) face[remapFace[f]] = faceSrc[f] ?? UNKNOWN;
  return { mesh, point, face, remapFace, remapVertex };
}

const identity = (n: number) => {
  const a = new Int32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  return a;
};

/** Per-face corner colours, or null — whatever the mesh stores for face f. */
const colorsOf = (mesh: PolyMesh, f: number) => mesh.faceColors?.[f] ?? null;

/**
 * Appends a face with every per-face array kept in step. `uvs` null leaves
 * them to projectNewFaceUVs (the caller collects those faces). `from` is the
 * face whose material slot and shading the new one inherits (-1: defaults).
 */
export function pushFace(mesh: PolyMesh, face: number[], uvs: UV[] | null, from: number, colors: V3[] | null = null): number {
  mesh.faces.push(face);
  if (mesh.faceUVs) {
    while (mesh.faceUVs.length < mesh.faces.length - 1) mesh.faceUVs.push([]);
    mesh.faceUVs.push(uvs ?? []);
  }
  if (mesh.faceMaterials) mesh.faceMaterials.push(from >= 0 ? (mesh.faceMaterials[from] ?? 0) : 0);
  if (mesh.faceShading && mesh.faceShading.length > 0) mesh.faceShading.push((from >= 0 ? mesh.faceShading[from] : undefined) ?? mesh.shading ?? "auto");
  if (mesh.faceColors) {
    while (mesh.faceColors.length < mesh.faces.length - 1) mesh.faceColors.push(null);
    mesh.faceColors.push(colors);
  }
  return mesh.faces.length - 1;
}

/** Drops sharp / seam / crease entries naming an edge the mesh no longer has. */
export function pruneEdgeFlags(mesh: PolyMesh): void {
  const exists = meshEdgeKeys(mesh);
  for (const [a, b] of mesh.edges ?? []) exists.add(edgeKey(a, b));
  if (mesh.sharpEdges) mesh.sharpEdges = mesh.sharpEdges.filter(([a, b]) => exists.has(edgeKey(a, b)));
  if (mesh.seamEdges) mesh.seamEdges = mesh.seamEdges.filter(([a, b]) => exists.has(edgeKey(a, b)));
  if (mesh.edgeCreases) mesh.edgeCreases = mesh.edgeCreases.filter(([a, b]) => exists.has(edgeKey(a, b)));
}

/**
 * Rebuilds sharp / seam / crease on `out` from `src` through a point map:
 * an output edge is flagged when the source edge its two ends came from was.
 * For operations that duplicate vertices (split edges), where one source
 * edge becomes several.
 */
function flagsThroughPointMap(src: PolyMesh, out: PolyMesh, pointMap: ArrayLike<number>): void {
  const sharp = new Set((src.sharpEdges ?? []).map(([a, b]) => edgeKey(a, b)));
  const seam = new Set((src.seamEdges ?? []).map(([a, b]) => edgeKey(a, b)));
  const crease = new Map((src.edgeCreases ?? []).map(([a, b, w]) => [edgeKey(a, b), w] as const));
  const keys = meshEdgeKeys(out);
  for (const [a, b] of out.edges ?? []) keys.add(edgeKey(a, b));
  const sharpOut: [number, number][] = [];
  const seamOut: [number, number][] = [];
  const creaseOut: [number, number, number][] = [];
  for (const key of keys) {
    const [a, b] = key.split("_").map(Number);
    const sa = pointMap[a];
    const sb = pointMap[b];
    if (sa < 0 || sb < 0 || sa === sb) continue;
    const sk = edgeKey(sa, sb);
    if (sharp.has(sk)) sharpOut.push([a, b]);
    if (seam.has(sk)) seamOut.push([a, b]);
    const w = crease.get(sk);
    if (w !== undefined) creaseOut.push([a, b, w]);
  }
  if (src.sharpEdges) out.sharpEdges = sharpOut;
  if (src.seamEdges) out.seamEdges = seamOut;
  if (src.edgeCreases) out.edgeCreases = creaseOut;
}

// ---------------------------------------------------------------- bevel vertices

/**
 * Bevels (chamfers) vertices: each selected vertex is replaced by one new
 * point on every edge leaving it, `width` along that edge, and the faces
 * around it by a cap face through those points — a cube corner becomes a
 * triangle. Two selected ends of one edge each stop short of its middle, so
 * neighbouring chamfers never cross. A vertex on an open border gets no cap
 * (there is no closed ring of points to make one from); a vertex with loose
 * edges is left alone (they have nowhere to go).
 */
export function bevelVertices(mesh: PolyMesh, vertices: number[], width: number): { mesh: PolyMesh; newFaces: number[]; maps: PropagationMaps } {
  const loose = new Set<number>();
  for (const [a, b] of mesh.edges ?? []) {
    loose.add(a);
    loose.add(b);
  }
  const sel = new Set(vertices.filter((v) => Number.isInteger(v) && v >= 0 && v < mesh.positions.length && !loose.has(v)));
  const n0 = mesh.positions.length;
  if (sel.size === 0 || !(width > 0)) return { mesh: cloneQuadMesh(mesh), newFaces: [], maps: { point: identity(n0), face: identity(mesh.faces.length) } };

  const base = withFaceUVs(mesh);
  const next = cloneQuadMesh(base);
  const pointSrc: number[] = Array.from(identity(n0));
  const pts = new Map<string, { index: number; t: number }>();
  /** The new point on edge v→w, `width` from v. */
  const pointOn = (v: number, w: number) => {
    const key = `${v}:${w}`;
    let entry = pts.get(key);
    if (!entry) {
      const pv = base.positions[v];
      const pw = base.positions[w];
      const L = len(sub(pw, pv));
      const d = Math.min(width, L * (sel.has(w) ? 0.45 : 0.9));
      const t = L > 1e-12 ? d / L : 0;
      next.positions.push(lerp3(pv, pw, t));
      pointSrc.push(v);
      entry = { index: next.positions.length - 1, t };
      pts.set(key, entry);
    }
    return entry;
  };

  // Cap edges around each vertex: in face F the corner v became
  // p(v, prev) → p(v, next), so the cap runs p(v, next) → p(v, prev).
  const capLinks = new Map<number, Map<number, number>>();
  const firstFace = new Map<number, number>();
  base.faces.forEach((face, f) => {
    if (!face.some((v) => sel.has(v))) return;
    const uvs = base.faceUVs![f] as UV[];
    const colors = colorsOf(base, f);
    const outFace: number[] = [];
    const outUVs: UV[] = [];
    const outColors: V3[] = [];
    const n = face.length;
    for (let i = 0; i < n; i++) {
      const v = face[i];
      if (!sel.has(v)) {
        outFace.push(v);
        outUVs.push(uvs[i]);
        if (colors) outColors.push(colors[i] ?? [1, 1, 1]);
        continue;
      }
      const ip = (i + n - 1) % n;
      const inx = (i + 1) % n;
      const a = pointOn(v, face[ip]);
      const b = pointOn(v, face[inx]);
      outFace.push(a.index, b.index);
      outUVs.push(lerpUV(uvs[i], uvs[ip], a.t), lerpUV(uvs[i], uvs[inx], b.t));
      if (colors) {
        const c = colors[i] ?? [1, 1, 1];
        outColors.push(lerp3(c, colors[ip] ?? c, a.t), lerp3(c, colors[inx] ?? c, b.t));
      }
      let links = capLinks.get(v);
      if (!links) capLinks.set(v, (links = new Map()));
      links.set(b.index, a.index);
      if (!firstFace.has(v)) firstFace.set(v, f);
    }
    next.faces[f] = outFace;
    next.faceUVs![f] = outUVs;
    if (next.faceColors && colors) next.faceColors[f] = outColors;
  });

  // Edge flags follow the edge's surviving part.
  const moveEnds = (a: number, b: number): [number, number] => [sel.has(a) ? (pts.get(`${a}:${b}`)?.index ?? a) : a, sel.has(b) ? (pts.get(`${b}:${a}`)?.index ?? b) : b];
  if (next.sharpEdges) next.sharpEdges = next.sharpEdges.map(([a, b]) => moveEnds(a, b));
  if (next.seamEdges) next.seamEdges = next.seamEdges.map(([a, b]) => moveEnds(a, b));
  if (next.edgeCreases) next.edgeCreases = next.edgeCreases.map(([a, b, w]) => [...moveEnds(a, b), w] as [number, number, number]);

  const faceSrc: number[] = Array.from(identity(base.faces.length));
  const created: number[] = [];
  for (const [v, links] of capLinks) {
    const start = links.keys().next().value as number;
    const ring = [start];
    let cur = links.get(start);
    let closed = false;
    for (let guard = 0; cur !== undefined && guard <= links.size; guard++) {
      if (cur === start) {
        closed = true;
        break;
      }
      ring.push(cur);
      cur = links.get(cur);
    }
    if (!closed || ring.length < 3 || ring.length !== links.size) continue;
    created.push(pushFace(next, ring, null, firstFace.get(v) ?? -1));
    faceSrc.push(UNKNOWN);
  }
  projectNewFaceUVs(next, created);
  const out = compactWithMaps(next, pointSrc, faceSrc);
  return {
    mesh: out.mesh,
    newFaces: created.map((f) => out.remapFace[f]).filter((f) => f >= 0),
    maps: { point: out.point, face: out.face },
  };
}

// ---------------------------------------------------------------- revolve

export interface RevolveOptions {
  axis: V3;
  center: V3;
  /** Degrees; ±360 is a full turn. */
  angle: number;
  steps: number;
  /** A full turn closes onto the profile itself rather than ending on a copy of it. */
  weldSeam?: boolean;
  /** Reverse the winding chosen automatically. */
  flip?: boolean;
}

/**
 * Revolves (lathes) edges around an axis: the generalisation of spinEdges to
 * any edge set (branching, several pieces, the open border of a surface) and
 * any axis direction. Each edge sweeps a strip of `steps` quads; points on
 * the axis are shared, so the quads touching them become triangles.
 *
 * Winding: when the profile edges border existing faces, the new faces run
 * against them (one consistent surface); otherwise they face away from the
 * axis.
 */
export function revolveEdges(mesh: PolyMesh, edges: [number, number][], options: RevolveOptions): { mesh: PolyMesh; newFaces: number[]; maps: PropagationMaps } {
  const n0 = mesh.positions.length;
  const unchanged = () => ({ mesh: cloneQuadMesh(mesh), newFaces: [], maps: { point: identity(n0), face: identity(mesh.faces.length) } });
  const angleDeg = Math.max(-360, Math.min(360, Number.isFinite(options.angle) ? options.angle : 0));
  const steps = Math.max(1, Math.min(256, Math.round(Number.isFinite(options.steps) ? options.steps : 1)));
  const unique = new Map<string, [number, number]>();
  for (const [a, b] of edges) {
    if (a === b || !mesh.positions[a] || !mesh.positions[b]) continue;
    unique.set(edgeKey(a, b), [a, b]);
  }
  if (unique.size === 0 || angleDeg === 0) return unchanged();

  const axis = normalize(finite3(options.axis, [0, 1, 0]), [0, 1, 0]);
  const center = finite3(options.center);
  const full = Math.abs(Math.abs(angleDeg) - 360) < 1e-6;
  const weld = full && options.weldSeam !== false;
  const scale = boundsDiagonal(mesh.positions);

  // Orient the profile so neighbouring strips agree: against an existing
  // face where there is one, else continuing the chain through each vertex.
  const existing = directedEdges(mesh);
  const role = new Map<number, "in" | "out">();
  const oriented: [number, number][] = [];
  const pending = [...unique.values()];
  const byVertex = new Map<number, [number, number][]>();
  for (const e of pending) for (const v of e) byVertex.set(v, [...(byVertex.get(v) ?? []), e]);
  const done = new Set<string>();
  const orient = (e: [number, number], from?: number) => {
    const key = edgeKey(e[0], e[1]);
    if (done.has(key)) return;
    done.add(key);
    let [a, b] = e;
    if (existing.has(`${a}>${b}`)) [a, b] = [b, a];
    else if (existing.has(`${b}>${a}`)) {
      /* already against it */
    } else if (from !== undefined) {
      const other = from === a ? b : a;
      [a, b] = role.get(from) === "in" ? [from, other] : [other, from];
    }
    oriented.push([a, b]);
    if (!role.has(a)) role.set(a, "out");
    if (!role.has(b)) role.set(b, "in");
    for (const v of [a, b]) for (const next of byVertex.get(v) ?? []) if (!done.has(edgeKey(next[0], next[1]))) stack.push([next, v]);
  };
  const stack: [[number, number], number][] = [];
  for (const e of pending) {
    if (done.has(edgeKey(e[0], e[1]))) continue;
    orient(e);
    while (stack.length) {
      const [next, v] = stack.pop()!;
      orient(next, v);
    }
  }

  const base = withFaceUVs(mesh);
  const next = cloneQuadMesh(base);
  const pointSrc: number[] = Array.from(identity(n0));
  const rel = (v: number) => sub(base.positions[v], center);
  const onAxis = (v: number) => {
    const p = rel(v);
    const h = dot(p, axis);
    return len(sub(p, [axis[0] * h, axis[1] * h, axis[2] * h])) < scale * 1e-6;
  };
  const rotate = (p: V3, theta: number): V3 => {
    // Rodrigues: p cosθ + (k × p) sinθ + k (k·p)(1 − cosθ)
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const kxp = cross(axis, p);
    const kp = dot(axis, p) * (1 - c);
    return [p[0] * c + kxp[0] * s + axis[0] * kp, p[1] * c + kxp[1] * s + axis[1] * kp, p[2] * c + kxp[2] * s + axis[2] * kp];
  };

  const verts = new Set<number>();
  for (const [a, b] of oriented) {
    verts.add(a);
    verts.add(b);
  }
  const rings = new Map<number, number[]>();
  for (const v of verts) {
    const ring = [v];
    const axial = onAxis(v);
    for (let k = 1; k <= steps; k++) {
      if ((weld && k === steps) || axial) {
        ring.push(v);
        continue;
      }
      const p = rotate(rel(v), (angleDeg * Math.PI * k) / (180 * steps));
      next.positions.push([p[0] + center[0], p[1] + center[1], p[2] + center[2]]);
      pointSrc.push(v);
      ring.push(next.positions.length - 1);
    }
    rings.set(v, ring);
  }

  // v of the UVs: height along the axis over the profile, or the distance
  // from it when the profile is square to the axis (a disc).
  const heights = new Map<number, number>();
  let hMin = Infinity, hMax = -Infinity;
  for (const v of verts) {
    const h = dot(rel(v), axis);
    heights.set(v, h);
    hMin = Math.min(hMin, h);
    hMax = Math.max(hMax, h);
  }
  if (hMax - hMin < scale * 1e-6) {
    hMin = Infinity;
    hMax = -Infinity;
    for (const v of verts) {
      const p = rel(v);
      const h = dot(p, axis);
      const r = len(sub(p, [axis[0] * h, axis[1] * h, axis[2] * h]));
      heights.set(v, r);
      hMin = Math.min(hMin, r);
      hMax = Math.max(hMax, r);
    }
  }
  const vOf = (v: number) => (heights.get(v)! - hMin) / (hMax - hMin || 1);

  const faces: { face: number[]; uvs: UV[] }[] = [];
  for (const [a, b] of oriented) {
    const ra = rings.get(a)!;
    const rb = rings.get(b)!;
    for (let k = 0; k < steps; k++) {
      // Runs a → b at k, as the profile was oriented.
      const quad = [ra[k], rb[k], rb[k + 1], ra[k + 1]];
      const quv: UV[] = [[k / steps, vOf(a)], [k / steps, vOf(b)], [(k + 1) / steps, vOf(b)], [(k + 1) / steps, vOf(a)]];
      const keep: number[] = [];
      for (let i = 0; i < 4; i++) if (quad[i] !== quad[(i + 1) % 4]) keep.push(i);
      if (new Set(keep.map((i) => quad[i])).size < 3) continue;
      faces.push({ face: keep.map((i) => quad[i]), uvs: keep.map((i) => quv[i]) });
    }
  }
  if (faces.length === 0) return unchanged();

  // Agreement with existing faces decides when there are any; otherwise
  // outward, area-weighted, so faces square to the axis can't swing it.
  let vote = 0;
  for (const { face } of faces) {
    for (let i = 0; i < face.length; i++) {
      const u = face[i];
      const w = face[(i + 1) % face.length];
      if (existing.has(`${u}>${w}`)) vote--;
      if (existing.has(`${w}>${u}`)) vote++;
    }
  }
  let flip = vote < 0;
  if (vote === 0) {
    let outward = 0;
    for (const { face } of faces) {
      const pts = face.map((v) => next.positions[v]);
      const nrm = cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]));
      const c = sub(centroidOf(next.positions, face), center);
      const h = dot(c, axis);
      outward += dot(nrm, sub(c, [axis[0] * h, axis[1] * h, axis[2] * h]));
    }
    flip = outward < 0;
  }
  if (options.flip) flip = !flip;

  const created: number[] = [];
  for (const { face, uvs } of faces) {
    created.push(pushFace(next, flip ? [...face].reverse() : face, flip ? [...uvs].reverse() : uvs, -1));
  }
  // A loose edge swept into a face is no longer loose.
  if (next.edges) {
    const used = meshEdgeKeys(next);
    next.edges = next.edges.filter(([a, b]) => !used.has(edgeKey(a, b)));
  }
  const faceSrc = [...identity(mesh.faces.length), ...created.map(() => -1)];
  return { mesh: next, newFaces: created, maps: { point: Int32Array.from(pointSrc), face: Int32Array.from(faceSrc) } };
}

// ---------------------------------------------------------------- mirror

export interface MirrorOptions {
  axis: 0 | 1 | 2;
  offset: number;
  /** Faces copied across the plane. */
  faces: number[];
  /** Points this close to the plane are snapped onto it and shared by both halves; negative: no welding at all. */
  tolerance: number;
  /** Reverse the copies' winding so their normals face out (a reflection turns them inside out). */
  flip: boolean;
  /** Mirror loose edges too (when the whole mesh is mirrored). */
  includeLoose?: boolean;
}

/**
 * Copies faces to the other side of an axis plane (Houdini's Mirror, keep
 * input). Points within `tolerance` of the plane are welded — snapped onto
 * it and shared by the original and the copy — so a half modelled against
 * the plane closes into one surface. Faces lying entirely on the plane have
 * no distinct image and are not copied.
 */
export function mirrorMesh(mesh: PolyMesh, options: MirrorOptions): { mesh: PolyMesh; newFaces: number[]; maps: PropagationMaps } {
  const axis = options.axis;
  const offset = Number.isFinite(options.offset) ? options.offset : 0;
  const tol = Number.isFinite(options.tolerance) ? options.tolerance : 0;
  const base = withFaceUVs(mesh);
  const next = cloneQuadMesh(base);
  const n0 = mesh.positions.length;
  const pointSrc: number[] = Array.from(identity(n0));
  const faces = [...new Set(options.faces)].filter((f) => Number.isInteger(f) && f >= 0 && f < mesh.faces.length).sort((a, b) => a - b);

  const verts = new Set<number>();
  for (const f of faces) for (const v of mesh.faces[f]) verts.add(v);
  const looseEdges = options.includeLoose ? (mesh.edges ?? []) : [];
  for (const [a, b] of looseEdges) {
    verts.add(a);
    verts.add(b);
  }

  const image = new Map<number, number>();
  const onPlane = new Set<number>();
  for (const v of [...verts].sort((a, b) => a - b)) {
    const p = next.positions[v];
    if (tol >= 0 && Math.abs(p[axis] - offset) <= tol) {
      p[axis] = offset;
      image.set(v, v);
      onPlane.add(v);
      continue;
    }
    const q: V3 = [p[0], p[1], p[2]];
    q[axis] = 2 * offset - p[axis];
    next.positions.push(q);
    pointSrc.push(v);
    image.set(v, next.positions.length - 1);
  }

  const created: number[] = [];
  const faceSrc: number[] = Array.from(identity(mesh.faces.length));
  for (const f of faces) {
    const face = base.faces[f];
    if (face.every((v) => onPlane.has(v))) continue;
    let copy = face.map((v) => image.get(v)!);
    let uvs = (base.faceUVs![f] as UV[]).map((uv) => [uv[0], uv[1]] as UV);
    const src = colorsOf(base, f);
    let colors = src ? src.map((c) => [c[0], c[1], c[2]] as V3) : null;
    if (options.flip) {
      copy = copy.reverse();
      uvs = uvs.reverse();
      colors = colors ? colors.reverse() : null;
    }
    created.push(pushFace(next, copy, uvs, f, colors));
    faceSrc.push(f);
  }

  const mirrored = (a: number, b: number) => verts.has(a) && verts.has(b) && !(onPlane.has(a) && onPlane.has(b));
  if (looseEdges.length) {
    next.edges = [...(next.edges ?? [])];
    for (const [a, b] of looseEdges) if (mirrored(a, b)) next.edges.push([image.get(a)!, image.get(b)!].sort((x, y) => x - y) as [number, number]);
  }
  const exists = meshEdgeKeys(next);
  for (const [a, b] of next.edges ?? []) exists.add(edgeKey(a, b));
  const copyPairs = (list?: [number, number][]) =>
    list ? [...list, ...list.filter(([a, b]) => mirrored(a, b) && exists.has(edgeKey(image.get(a)!, image.get(b)!))).map(([a, b]) => [image.get(a)!, image.get(b)!] as [number, number])] : undefined;
  next.sharpEdges = copyPairs(next.sharpEdges);
  next.seamEdges = copyPairs(next.seamEdges);
  if (next.edgeCreases) {
    next.edgeCreases = [
      ...next.edgeCreases,
      ...next.edgeCreases.filter(([a, b]) => mirrored(a, b) && exists.has(edgeKey(image.get(a)!, image.get(b)!))).map(([a, b, w]) => [image.get(a)!, image.get(b)!, w] as [number, number, number]),
    ];
  }
  return { mesh: next, newFaces: created, maps: { point: Int32Array.from(pointSrc), face: Int32Array.from(faceSrc) } };
}

// ---------------------------------------------------------------- clip / bisect

export type ClipKeep = "above" | "below" | "both";

export interface ClipOptions {
  point: V3;
  normal: V3;
  keep: ClipKeep;
  /** Close each cut on a kept side with a face (not with keep "both": nothing is open). */
  cap: boolean;
  /** Faces that are cut (and removed on the discarded side); null = all. Others only get the new points on their shared edges. */
  faces?: ReadonlySet<number> | null;
}

export interface ClipResult {
  mesh: PolyMesh;
  /** The new edges along the plane. */
  cutEdges: [number, number][];
  capFaces: number[];
  above: number[];
  below: number[];
  maps: PropagationMaps;
}

interface Corner {
  v: number;
  uv: UV;
  color: V3 | null;
}

/**
 * Cuts the mesh with a plane (Houdini's Clip, Blender's Bisect). Edges that
 * cross it get one new point each — shared by every face on that edge, so
 * the surface stays closed — and each crossing face is split along the line;
 * "above" (the side the normal points to) or "below" is kept, or both.
 *
 * A face is split by pairing its crossing points in order along the cut line
 * (the classic even-odd rule), so concave n-gons crossing the plane several
 * times come apart into the right pieces, not a single folded polygon.
 *
 * Caps close each loop of the cut with one n-gon on the kept side, wound
 * against the faces around it.
 */
export function clipMesh(mesh: PolyMesh, options: ClipOptions): ClipResult {
  const n = normalize(finite3(options.normal, [0, 1, 0]), [0, 0, 0]);
  const point = finite3(options.point);
  const base = withFaceUVs(mesh);
  const n0 = mesh.positions.length;
  const nothing = (): ClipResult => ({
    mesh: cloneQuadMesh(mesh),
    cutEdges: [],
    capFaces: [],
    above: [],
    below: [],
    maps: { point: identity(n0), face: identity(mesh.faces.length) },
  });
  if (len(n) === 0) return nothing();

  const eps = boundsDiagonal(mesh.positions) * 1e-9;
  const dist = base.positions.map((p) => dot(sub(p, point), n));
  const sign = dist.map((d) => (d > eps ? 1 : d < -eps ? -1 : 0));
  const inScope = (f: number) => !options.faces || options.faces.has(f);

  const next = cloneQuadMesh(base);
  const pointSrc: number[] = Array.from(identity(n0));
  const vsign: number[] = [...sign];
  const cuts = new Map<string, { v: number; a: number; t: number }>();
  const cutVertex = (a: number, b: number) => {
    const key = edgeKey(a, b);
    let c = cuts.get(key);
    if (!c) {
      const t = dist[a] / (dist[a] - dist[b]);
      const p = lerp3(base.positions[a], base.positions[b], t);
      // Exactly on the plane: no rounding residue to tell the cap from a sliver.
      const off = dot(sub(p, point), n);
      next.positions.push([p[0] - n[0] * off, p[1] - n[1] * off, p[2] - n[2] * off]);
      pointSrc.push(t < 0.5 ? a : b);
      vsign.push(0);
      c = { v: next.positions.length - 1, a, t };
      cuts.set(key, c);
    }
    return c;
  };
  // Only edges of the faces being cut are split.
  base.faces.forEach((face, f) => {
    if (!inScope(f)) return;
    face.forEach((a, i) => {
      const b = face[(i + 1) % face.length];
      if (sign[a] * sign[b] < 0) cutVertex(a, b);
    });
  });

  const outFaces: number[][] = [];
  const outUVs: UV[][] = [];
  const outColors: (V3[] | null)[] = [];
  const faceSrc: number[] = [];
  const above: number[] = [];
  const below: number[] = [];
  const cutKeys = new Map<string, [number, number]>();
  const keepSide = (s: number) => options.keep === "both" || (options.keep === "above" ? s >= 0 : s <= 0);
  /** side 0: an untouched face outside the scope, kept and in neither side group. */
  const emit = (corners: Corner[], f: number, side: number) => {
    if (side !== 0 && !keepSide(side)) return;
    const idx = outFaces.length;
    outFaces.push(corners.map((c) => c.v));
    outUVs.push(corners.map((c) => c.uv));
    outColors.push(base.faceColors?.[f] ? corners.map((c) => c.color ?? [1, 1, 1]) : null);
    faceSrc.push(f);
    if (side > 0) above.push(idx);
    else if (side < 0) below.push(idx);
  };

  base.faces.forEach((face, f) => {
    const uvs = base.faceUVs![f] as UV[];
    const colors = colorsOf(base, f);
    const ring: Corner[] = [];
    face.forEach((a, i) => {
      const j = (i + 1) % face.length;
      ring.push({ v: a, uv: uvs[i] ?? [0, 0], color: colors ? (colors[i] ?? [1, 1, 1]) : null });
      const c = cuts.get(edgeKey(a, face[j]));
      if (!c) return;
      const t = c.a === a ? c.t : 1 - c.t;
      const ca = colors ? (colors[i] ?? [1, 1, 1]) : null;
      ring.push({ v: c.v, uv: lerpUV(uvs[i] ?? [0, 0], uvs[j] ?? [0, 0], t), color: ca ? lerp3(ca, colors![j] ?? ca, t) : null });
    });
    if (!inScope(f)) {
      // Untouched, but it keeps the points its cut neighbours put on its edges.
      emit(ring, f, 0);
      return;
    }
    const s = ring.map((c) => vsign[c.v]);
    const hasPos = s.some((x) => x > 0);
    const hasNeg = s.some((x) => x < 0);
    if (!hasPos || !hasNeg) {
      // A face lying in the plane belongs to whichever side is kept.
      emit(ring, f, hasNeg ? -1 : hasPos ? 1 : options.keep === "below" ? -1 : 1);
      return;
    }
    const pieces = splitRing(ring, s, next.positions, faceNormalOf(base.positions, face), n);
    for (const piece of pieces) {
      emit(piece.corners, f, piece.side);
      for (let i = 0; i < piece.corners.length; i++) {
        const a = piece.corners[i].v;
        const b = piece.corners[(i + 1) % piece.corners.length].v;
        if (vsign[a] === 0 && vsign[b] === 0) cutKeys.set(edgeKey(a, b), a < b ? [a, b] : [b, a]);
      }
    }
  });

  for (const [key, c] of cuts) {
    const [a, b] = key.split("_").map(Number);
    splitEdgeAttributes(next, a, b, [c.v]);
  }

  // Loose edges are clipped like everything else.
  if (next.edges) {
    const edges: [number, number][] = [];
    for (const [a, b] of next.edges) {
      if (sign[a] * sign[b] < 0) {
        const c = cutVertex(a, b);
        for (const end of [a, b]) if (keepSide(sign[end])) edges.push(end < c.v ? [end, c.v] : [c.v, end]);
      } else if (sign[a] + sign[b] === 0 || keepSide(Math.sign(sign[a] + sign[b]))) {
        edges.push([a, b]);
      }
    }
    next.edges = edges;
  }

  const hasShading = Boolean(base.faceShading && base.faceShading.length > 0);
  next.faces = outFaces;
  next.faceUVs = outUVs;
  if (base.faceMaterials) next.faceMaterials = faceSrc.map((f) => base.faceMaterials![f] ?? 0);
  if (base.faceShading) next.faceShading = hasShading ? faceSrc.map((f) => base.faceShading![f] ?? base.shading ?? "auto") : [];
  if (base.faceColors) next.faceColors = outColors;

  // Caps: the cut edges left open on the kept side, chained into loops.
  const capFaces: number[] = [];
  if (options.cap && options.keep !== "both" && cutKeys.size > 0) {
    const directed = directedEdges(next);
    const ownerOf = new Map<string, number>();
    next.faces.forEach((face, f) => face.forEach((a, i) => ownerOf.set(`${a}>${face[(i + 1) % face.length]}`, f)));
    const links = new Map<number, number[]>();
    for (const [a, b] of cutKeys.values()) {
      for (const [u, w] of [[a, b], [b, a]] as const) {
        if (directed.has(`${u}>${w}`) && !directed.has(`${w}>${u}`)) links.set(w, [...(links.get(w) ?? []), u]);
      }
    }
    const used = new Set<string>();
    for (const [start, outs] of links) {
      for (const first of outs) {
        if (used.has(`${start}>${first}`)) continue;
        const loop = [start];
        used.add(`${start}>${first}`);
        let cur = first;
        let closed = false;
        for (let guard = 0; guard < links.size + 1; guard++) {
          if (cur === start) {
            closed = true;
            break;
          }
          loop.push(cur);
          const nextV = (links.get(cur) ?? []).find((w) => !used.has(`${cur}>${w}`));
          if (nextV === undefined) break;
          used.add(`${cur}>${nextV}`);
          cur = nextV;
        }
        if (!closed || loop.length < 3) continue;
        const from = ownerOf.get(`${loop[1]}>${loop[0]}`) ?? -1;
        capFaces.push(pushFace(next, loop, null, from));
        faceSrc.push(-1);
      }
    }
    projectNewFaceUVs(next, capFaces);
  }

  const out = compactWithMaps(next, pointSrc, faceSrc);
  const remapF = (list: number[]) => list.map((f) => out.remapFace[f]).filter((f) => f >= 0);
  const cutEdges: [number, number][] = [];
  for (const [a, b] of cutKeys.values()) {
    const x = out.remapVertex[a];
    const y = out.remapVertex[b];
    if (x >= 0 && y >= 0 && x !== y) cutEdges.push(x < y ? [x, y] : [y, x]);
  }
  return {
    mesh: out.mesh,
    cutEdges,
    capFaces: remapF(capFaces),
    above: remapF(above),
    below: remapF(below),
    maps: { point: out.point, face: out.face },
  };
}

/**
 * Splits a face's corner ring (with the cut points already inserted, sign 0)
 * into its pieces on either side of the plane: crossing points sorted along
 * the cut line pair up into chords, each chord splits the ring that holds
 * both ends.
 */
function splitRing(ring: Corner[], s: number[], positions: ReadonlyArray<readonly number[]>, faceNormal: V3, planeNormal: V3): { corners: Corner[]; side: number }[] {
  const n = ring.length;
  const nonZero = (i: number, step: number) => {
    for (let k = 1; k < n; k++) {
      const j = (i + step * k + n * k) % n;
      if (s[j] !== 0) return s[j];
    }
    return 0;
  };
  const crossings: number[] = [];
  for (let i = 0; i < n; i++) {
    if (s[i] !== 0) continue;
    // A run of points on the plane crosses once, at its last point.
    if (s[(i + 1) % n] === 0) continue;
    const before = nonZero(i, -1);
    const after = s[(i + 1) % n];
    if (before !== 0 && before !== after) crossings.push(i);
  }
  const whole = () => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += s[i];
    return [{ corners: ring, side: sum < 0 ? -1 : 1 }];
  };
  if (crossings.length < 2 || crossings.length % 2 !== 0) return whole();

  let line = cross(faceNormal, planeNormal);
  if (len(line) < 1e-9) return whole();
  line = normalize(line);
  crossings.sort((a, b) => dot(positions[ring[a].v], line) - dot(positions[ring[b].v], line));

  let rings: number[][] = [Array.from({ length: n }, (_, i) => i)];
  for (let c = 0; c + 1 < crossings.length; c += 2) {
    const p = crossings[c];
    const q = crossings[c + 1];
    const r = rings.findIndex((list) => list.includes(p) && list.includes(q));
    if (r < 0) continue;
    const list = rings[r];
    const ip = list.indexOf(p);
    const iq = list.indexOf(q);
    const m = list.length;
    if (Math.abs(ip - iq) === 1 || Math.abs(ip - iq) === m - 1) continue;
    const walk = (from: number, to: number) => {
      const outList: number[] = [];
      for (let k = from; ; k = (k + 1) % m) {
        outList.push(list[k]);
        if (k === to) break;
      }
      return outList;
    };
    rings = [...rings.slice(0, r), walk(ip, iq), walk(iq, ip), ...rings.slice(r + 1)];
  }
  const pieces: { corners: Corner[]; side: number }[] = [];
  for (const list of rings) {
    const side = list.map((i) => s[i]).find((x) => x !== 0) ?? 0;
    if (side === 0 || new Set(list.map((i) => ring[i].v)).size < 3) continue;
    pieces.push({ corners: list.map((i) => ring[i]), side });
  }
  return pieces.length ? pieces : whole();
}

// ---------------------------------------------------------------- fill holes

/**
 * Closes the open borders of the mesh with one n-gon per hole, wound against
 * the faces around it. `allow` decides per border edge whether it may be
 * filled — a hole is filled only when all its edges are allowed — and
 * `maxSides` (> 0) skips holes with more corners than that (keep a
 * cylinder's ends open, close the small gaps).
 */
export function fillHoles(mesh: PolyMesh, allow: (a: number, b: number) => boolean, maxSides = 0): { mesh: PolyMesh; newFaces: number[]; maps: PropagationMaps } {
  const use = new Map<string, number>();
  mesh.faces.forEach((face) =>
    face.forEach((a, i) => {
      const key = edgeKey(a, face[(i + 1) % face.length]);
      use.set(key, (use.get(key) ?? 0) + 1);
    }),
  );
  // A border half-edge a → b: the hole runs b → a.
  const links = new Map<number, number[]>();
  const owner = new Map<string, number>();
  mesh.faces.forEach((face, f) => {
    face.forEach((a, i) => {
      const b = face[(i + 1) % face.length];
      if (use.get(edgeKey(a, b)) !== 1) return;
      links.set(b, [...(links.get(b) ?? []), a]);
      owner.set(`${b}>${a}`, f);
    });
  });

  const base = withFaceUVs(mesh);
  const next = cloneQuadMesh(base);
  const created: number[] = [];
  const usedLinks = new Set<string>();
  for (const [start, outs] of links) {
    for (const first of outs) {
      if (usedLinks.has(`${start}>${first}`)) continue;
      const loop = [start];
      const walked = [`${start}>${first}`];
      usedLinks.add(walked[0]);
      let cur = first;
      let closed = false;
      for (let guard = 0; guard <= links.size; guard++) {
        if (cur === start) {
          closed = true;
          break;
        }
        loop.push(cur);
        const nextV = (links.get(cur) ?? []).find((w) => !usedLinks.has(`${cur}>${w}`));
        if (nextV === undefined) break;
        const key = `${cur}>${nextV}`;
        usedLinks.add(key);
        walked.push(key);
        cur = nextV;
      }
      if (!closed || loop.length < 3) continue;
      if (maxSides > 0 && loop.length > maxSides) continue;
      if (new Set(loop).size !== loop.length) continue;
      if (!loop.every((a, i) => allow(a, loop[(i + 1) % loop.length]))) continue;
      created.push(pushFace(next, loop, null, owner.get(walked[0]) ?? -1));
    }
  }
  projectNewFaceUVs(next, created);
  const faceSrc = [...identity(mesh.faces.length), ...created.map(() => -1)];
  return { mesh: next, newFaces: created, maps: { point: identity(mesh.positions.length), face: Int32Array.from(faceSrc) } };
}

// ---------------------------------------------------------------- split edges

/**
 * Splits the mesh along edges (Blender's Edge Split): the faces on either
 * side of a split edge stop sharing its vertices. Around each vertex, the
 * faces still joined across unsplit edges keep one vertex between them;
 * each other fan gets a copy.
 */
export function splitEdges(mesh: PolyMesh, edges: [number, number][]): { mesh: PolyMesh; maps: PropagationMaps } {
  const split = new Set(edges.map(([a, b]) => edgeKey(a, b)));
  const n0 = mesh.positions.length;
  const out = cloneQuadMesh(mesh);
  if (split.size === 0) return { mesh: out, maps: { point: identity(n0), face: identity(mesh.faces.length) } };

  // One union-find node per face corner.
  const cornerStart: number[] = [];
  let total = 0;
  for (const face of mesh.faces) {
    cornerStart.push(total);
    total += face.length;
  }
  const parent = new Int32Array(total);
  for (let i = 0; i < total; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  // Corners at each end of every face edge, by edge.
  const byEdge = new Map<string, { lo: number; hi: number }[]>();
  mesh.faces.forEach((face, f) => {
    face.forEach((a, i) => {
      const j = (i + 1) % face.length;
      const b = face[j];
      if (a === b) return;
      const key = edgeKey(a, b);
      const ca = cornerStart[f] + i;
      const cb = cornerStart[f] + j;
      const list = byEdge.get(key) ?? [];
      list.push(a < b ? { lo: ca, hi: cb } : { lo: cb, hi: ca });
      byEdge.set(key, list);
    });
  });
  for (const [key, list] of byEdge) {
    if (split.has(key)) continue;
    for (let k = 1; k < list.length; k++) {
      union(list[0].lo, list[k].lo);
      union(list[0].hi, list[k].hi);
    }
  }

  const pointSrc: number[] = Array.from(identity(n0));
  const firstClass = new Map<number, number>();
  const classVertex = new Map<number, number>();
  // Corners in order, so the vertex keeps the fan of its lowest corner.
  mesh.faces.forEach((face, f) => {
    face.forEach((v, i) => {
      const root = find(cornerStart[f] + i);
      let target = classVertex.get(root);
      if (target === undefined) {
        if (!firstClass.has(v)) {
          firstClass.set(v, root);
          target = v;
        } else {
          const p = mesh.positions[v];
          out.positions.push([p[0], p[1], p[2]]);
          pointSrc.push(v);
          target = out.positions.length - 1;
        }
        classVertex.set(root, target);
      }
      out.faces[f][i] = target;
    });
  });
  flagsThroughPointMap(mesh, out, pointSrc);
  return { mesh: out, maps: { point: Int32Array.from(pointSrc), face: identity(mesh.faces.length) } };
}

// ---------------------------------------------------------------- triangulate / quadrangulate

/** Triangulates the given faces (ear clipping for n-gons, see triangulateFace). */
export function triangulateFaces(mesh: PolyMesh, faces: number[]): { mesh: PolyMesh; newFaces: number[]; maps: PropagationMaps } {
  const base = withFaceUVs(mesh);
  const next = cloneQuadMesh(base);
  const faceSrc: number[] = Array.from(identity(mesh.faces.length));
  const created: number[] = [];
  for (const f of [...new Set(faces)].filter((x) => Number.isInteger(x) && x >= 0 && x < mesh.faces.length).sort((a, b) => a - b)) {
    const face = base.faces[f];
    if (face.length <= 3) {
      created.push(f);
      continue;
    }
    const uvs = base.faceUVs![f] as UV[];
    const colors = colorsOf(base, f);
    const tris = triangulateFace(base.positions, face);
    tris.forEach((tri, k) => {
      const tf = tri.map((i) => face[i]);
      const tuv = tri.map((i) => [uvs[i]?.[0] ?? 0, uvs[i]?.[1] ?? 0] as UV);
      const tc = colors ? tri.map((i) => [...(colors[i] ?? [1, 1, 1])] as V3) : null;
      if (k === 0) {
        next.faces[f] = tf;
        next.faceUVs![f] = tuv;
        if (next.faceColors && colors) next.faceColors[f] = tc;
        created.push(f);
      } else {
        created.push(pushFace(next, tf, tuv, f, tc));
        faceSrc.push(f);
      }
    });
  }
  return { mesh: next, newFaces: created, maps: { point: identity(mesh.positions.length), face: Int32Array.from(faceSrc) } };
}

export interface QuadrangulateOptions {
  /** Neighbouring triangles bent further apart than this (degrees) stay triangles. */
  maxAngle: number;
  /** A merged quad whose corners stray from square by more than this (degrees, mean) isn't made. */
  maxShapeError: number;
  /** Don't merge across these. */
  respectSharp?: boolean;
  respectSeams?: boolean;
  respectMaterials?: boolean;
  respectUVs?: boolean;
}

/**
 * Pairs triangles into quads, the way Blender's Tris to Quads does (and the
 * scorer importBufferGeometry uses on import): every pair of selected
 * triangles sharing a manifold edge is scored by how far they bend apart plus
 * how far the merged quad's corners are from square, and pairs are taken
 * best first. Concave results, flipped neighbours and (optionally) pairs
 * across sharp edges, seams, UV cuts and material changes are refused.
 */
export function trianglesToQuads(mesh: PolyMesh, faces: number[], options: QuadrangulateOptions): { mesh: PolyMesh; merged: number; maps: PropagationMaps } {
  const base = withFaceUVs(mesh);
  const P = base.positions;
  const tris = new Set(faces.filter((f) => base.faces[f]?.length === 3));
  const use = new Map<string, number[]>();
  base.faces.forEach((face, f) =>
    face.forEach((a, i) => {
      const key = edgeKey(a, face[(i + 1) % face.length]);
      const list = use.get(key);
      if (list) list.push(f);
      else use.set(key, [f]);
    }),
  );
  const sharp = new Set((base.sharpEdges ?? []).map(([a, b]) => edgeKey(a, b)));
  const seams = new Set((base.seamEdges ?? []).map(([a, b]) => edgeKey(a, b)));
  const maxAngle = Math.max(0, Math.min(180, Number.isFinite(options.maxAngle) ? options.maxAngle : 40));
  const maxShape = Math.max(0, Math.min(180, Number.isFinite(options.maxShapeError) ? options.maxShapeError : 40));
  const sameUV = (a: UV | undefined, b: UV | undefined) => !a || !b || (Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5);

  const candidates: { t0: number; t1: number; quad: number[]; uvs: UV[]; colors: V3[] | null; error: number }[] = [];
  for (const [key, list] of use) {
    if (list.length !== 2) continue;
    const [t0, t1] = list;
    if (t0 === t1 || !tris.has(t0) || !tris.has(t1)) continue;
    if (options.respectSharp !== false && sharp.has(key)) continue;
    if (options.respectSeams !== false && seams.has(key)) continue;
    if (options.respectMaterials !== false && (base.faceMaterials?.[t0] ?? 0) !== (base.faceMaterials?.[t1] ?? 0)) continue;
    const tri0 = base.faces[t0];
    const tri1 = base.faces[t1];
    const [su, sv] = key.split("_").map(Number);
    const i0 = tri0.indexOf(su);
    const [u, v] = tri0[(i0 + 1) % 3] === sv ? [su, sv] : [sv, su];
    const j = tri1.indexOf(v);
    if (tri1[(j + 1) % 3] !== u) continue; // the two disagree on winding
    const uv0 = (x: number) => base.faceUVs![t0][tri0.indexOf(x)] as UV;
    const uv1 = (x: number) => base.faceUVs![t1][tri1.indexOf(x)] as UV;
    if (options.respectUVs !== false && (!sameUV(uv0(u), uv1(u)) || !sameUV(uv0(v), uv1(v)))) continue;

    const n0 = faceNormalOf(P, tri0);
    const n1 = faceNormalOf(P, tri1);
    const bend = (Math.acos(Math.max(-1, Math.min(1, dot(n0, n1)))) * 180) / Math.PI;
    if (bend > maxAngle) continue;
    const other0 = tri0.find((x) => x !== u && x !== v)!;
    const other1 = tri1.find((x) => x !== u && x !== v)!;
    const quad = [other0, u, other1, v];
    const shape = quadShapeError(quad.map((q) => P[q]), normalize([n0[0] + n1[0], n0[1] + n1[1], n0[2] + n1[2]]));
    if (shape === null || shape > maxShape) continue;
    const pick = <T>(q: number, a: T[] | null | undefined, b: T[] | null | undefined): T | undefined =>
      tri0.includes(q) ? a?.[tri0.indexOf(q)] : b?.[tri1.indexOf(q)];
    const c0 = colorsOf(base, t0);
    const c1 = colorsOf(base, t1);
    candidates.push({
      t0,
      t1,
      quad,
      uvs: quad.map((q) => (pick(q, base.faceUVs![t0] as UV[], base.faceUVs![t1] as UV[]) ?? [0, 0]) as UV),
      colors: c0 || c1 ? quad.map((q) => (pick(q, c0, c1) ?? [1, 1, 1]) as V3) : null,
      error: bend + shape,
    });
  }
  candidates.sort((a, b) => a.error - b.error);

  const paired = new Set<number>();
  const quadAt = new Map<number, (typeof candidates)[number]>();
  for (const c of candidates) {
    if (paired.has(c.t0) || paired.has(c.t1)) continue;
    paired.add(c.t0);
    paired.add(c.t1);
    quadAt.set(Math.min(c.t0, c.t1), c);
  }
  const next = cloneQuadMesh(base);
  if (quadAt.size === 0) return { mesh: next, merged: 0, maps: { point: identity(mesh.positions.length), face: identity(mesh.faces.length) } };

  const keep: number[] = [];
  base.faces.forEach((_, f) => {
    if (quadAt.has(f) || !paired.has(f)) keep.push(f);
  });
  const hasShading = Boolean(base.faceShading && base.faceShading.length > 0);
  next.faces = keep.map((f) => quadAt.get(f)?.quad ?? [...base.faces[f]]);
  next.faceUVs = keep.map((f) => quadAt.get(f)?.uvs ?? (base.faceUVs![f] as UV[]).map((uv) => [uv[0], uv[1]] as UV));
  if (base.faceMaterials) next.faceMaterials = keep.map((f) => base.faceMaterials![f] ?? 0);
  if (base.faceShading) next.faceShading = hasShading ? keep.map((f) => base.faceShading![f]) : [];
  if (base.faceColors) next.faceColors = keep.map((f) => (quadAt.has(f) ? quadAt.get(f)!.colors : (base.faceColors![f] ?? null)));
  pruneEdgeFlags(next);
  return { mesh: next, merged: quadAt.size, maps: { point: identity(mesh.positions.length), face: Int32Array.from(keep) } };
}

/** Mean deviation of a quad's corner angles from 90°, or null when concave. */
function quadShapeError(p: ReadonlyArray<readonly number[]>, normal: V3): number | null {
  let error = 0;
  for (let i = 0; i < 4; i++) {
    const prev = sub(p[(i + 3) % 4], p[i]);
    const nxt = sub(p[(i + 1) % 4], p[i]);
    if (dot(cross(nxt, prev), normal) <= 0) return null;
    const cos = dot(prev, nxt) / (len(prev) * len(nxt) || 1);
    error += Math.abs((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI - 90);
  }
  return error / 4;
}

// ---------------------------------------------------------------- bridge

export interface Chain {
  verts: number[];
  closed: boolean;
}

export interface BridgeOptions {
  /** Rings of quads across the gap (1 = straight across). */
  segments: number;
  /** Extra rotation of the second loop, in vertices (closed loops only). */
  twist: number;
  /** Faces removed before bridging (bridging two face groups: their holes are joined). */
  removeFaces?: number[];
}

/**
 * Joins two vertex chains (edge loops, or open chains) with a band of quads
 * — Bridge Edge Loops with Blender's extra knobs: `segments` rings across the
 * gap, `twist` turns the second loop by whole vertices. Loops are matched at
 * the rotation and direction that keeps the bridge shortest; the band is
 * wound to agree with faces already on its two ends.
 */
export function bridgeChains(mesh: PolyMesh, A: Chain, B: Chain, options: BridgeOptions): { mesh: PolyMesh; newFaces: number[]; maps: PropagationMaps; error?: string } {
  const n0 = mesh.positions.length;
  const fail = (error: string) => ({ mesh: cloneQuadMesh(mesh), newFaces: [], maps: { point: identity(n0), face: identity(mesh.faces.length) }, error });
  if (A.closed !== B.closed) return fail("both loops must be closed, or both open");
  if (A.verts.length !== B.verts.length) return fail(`the loops have ${A.verts.length} and ${B.verts.length} points — they must match`);
  if (A.verts.length < 2) return fail("each side needs at least one edge");
  const shared = new Set(A.verts);
  if (B.verts.some((v) => shared.has(v))) return fail("the two sides share points");
  const n = A.verts.length;
  const a = A.verts;
  const P = mesh.positions;
  const d2 = (x: number, y: number) => {
    const d = sub(P[x], P[y]);
    return dot(d, d);
  };
  let best = B.verts;
  let bestCost = Infinity;
  for (const dir of [B.verts, [...B.verts].reverse()]) {
    for (let r = 0; r < (A.closed ? n : 1); r++) {
      const cand = dir.map((_, i) => dir[(i + r) % n]);
      let cost = 0;
      for (let i = 0; i < n; i++) cost += d2(a[i], cand[i]);
      if (cost < bestCost - 1e-12) {
        bestCost = cost;
        best = cand;
      }
    }
  }
  const twist = A.closed ? ((Math.round(Number.isFinite(options.twist) ? options.twist : 0) % n) + n) % n : 0;
  if (twist) best = best.map((_, i) => best[(i + twist) % n]);

  const base = withFaceUVs(mesh);
  const next = cloneQuadMesh(base);
  const removed = new Set((options.removeFaces ?? []).filter((f) => f >= 0 && f < mesh.faces.length));
  for (const f of removed) {
    next.faces[f] = [];
    next.faceUVs![f] = [];
  }
  const pointSrc: number[] = Array.from(identity(n0));
  const segs = Math.max(1, Math.min(64, Math.round(Number.isFinite(options.segments) ? options.segments : 1)));
  const rings: number[][] = [a];
  for (let s = 1; s < segs; s++) {
    const t = s / segs;
    rings.push(
      a.map((v, i) => {
        next.positions.push(lerp3(P[v], P[best[i]], t));
        pointSrc.push(t < 0.5 ? v : best[i]);
        return next.positions.length - 1;
      }),
    );
  }
  rings.push(best);

  const quads: number[][] = [];
  const steps = A.closed ? n : n - 1;
  for (let s = 0; s < segs; s++) {
    for (let i = 0; i < steps; i++) {
      const j = (i + 1) % n;
      quads.push([rings[s][i], rings[s][j], rings[s + 1][j], rings[s + 1][i]]);
    }
  }
  const existing = directedEdges(next);
  let vote = 0;
  for (const q of quads) {
    for (let k = 0; k < 4; k++) {
      const u = q[k];
      const w = q[(k + 1) % 4];
      if (existing.has(`${u}>${w}`)) vote--;
      if (existing.has(`${w}>${u}`)) vote++;
    }
  }
  let from = -1;
  next.faces.forEach((face, f) => {
    if (from < 0 && face.includes(a[0])) from = f;
  });
  const created: number[] = [];
  const faceSrc: number[] = Array.from(identity(mesh.faces.length));
  for (const q of quads) {
    created.push(pushFace(next, vote < 0 ? [...q].reverse() : q, null, from));
    faceSrc.push(-1);
  }
  projectNewFaceUVs(next, created);
  const out = compactWithMaps(next, pointSrc, faceSrc);
  return { mesh: out.mesh, newFaces: created.map((f) => out.remapFace[f]).filter((f) => f >= 0), maps: { point: out.point, face: out.face } };
}

/** The border edges of a set of faces: those with exactly one of the faces on them. */
export function regionBorder(mesh: PolyMesh, faces: Iterable<number>): [number, number][] {
  const set = new Set(faces);
  const count = new Map<string, { a: number; b: number; n: number }>();
  for (const f of set) {
    const face = mesh.faces[f];
    if (!face) continue;
    face.forEach((a, i) => {
      const b = face[(i + 1) % face.length];
      const key = edgeKey(a, b);
      const e = count.get(key) ?? { a, b, n: 0 };
      e.n++;
      count.set(key, e);
    });
  }
  return [...count.values()].filter((e) => e.n === 1).map((e) => [e.a, e.b]);
}

/** Connected pieces of a set of faces (joined across shared edges). */
export function faceIslands(mesh: PolyMesh, faces: Iterable<number>): number[][] {
  const set = new Set(faces);
  const byEdge = new Map<string, number[]>();
  for (const f of set) {
    const face = mesh.faces[f];
    if (!face) continue;
    face.forEach((a, i) => {
      const key = edgeKey(a, face[(i + 1) % face.length]);
      byEdge.set(key, [...(byEdge.get(key) ?? []), f]);
    });
  }
  const seen = new Set<number>();
  const islands: number[][] = [];
  for (const start of [...set].sort((x, y) => x - y)) {
    if (seen.has(start) || !mesh.faces[start]) continue;
    const island: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const f = stack.pop()!;
      island.push(f);
      const face = mesh.faces[f];
      face.forEach((a, i) => {
        for (const g of byEdge.get(edgeKey(a, face[(i + 1) % face.length])) ?? []) {
          if (seen.has(g)) continue;
          seen.add(g);
          stack.push(g);
        }
      });
    }
    islands.push(island);
  }
  return islands;
}

// ---------------------------------------------------------------- subset maps

/**
 * Provenance for deleteFaces / extractFaces (which compact without saying
 * how): the kept faces in order, and the vertices they (and, for a delete,
 * the loose edges) use, in their original order. Null when the result
 * doesn't line up — the caller then falls back to completeMaps.
 */
export function subsetMaps(src: PolyMesh, out: PolyMesh, keptFaces: number[], countLoose: ReadonlyArray<readonly [number, number]>): PropagationMaps | null {
  const used = new Uint8Array(src.positions.length);
  for (const f of keptFaces) for (const v of src.faces[f]) used[v] = 1;
  for (const [a, b] of countLoose) used[a] = used[b] = 1;
  const point: number[] = [];
  for (let v = 0; v < used.length; v++) if (used[v]) point.push(v);
  if (point.length !== out.positions.length || keptFaces.length !== out.faces.length) return null;
  return { point: Int32Array.from(point), face: Int32Array.from(keptFaces) };
}
