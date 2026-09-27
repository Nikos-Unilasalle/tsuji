import type { QuadMesh } from "../quadMesh";
import { computeFaceNormal } from "../quadMesh";
import { getTopology } from "./topology";

export type SelectMode = "points" | "edges" | "faces";

/** An edge as its two vertex indices, lower first. */
export type EdgeRef = [number, number];

export const edgeRef = (a: number, b: number): EdgeRef => (a < b ? [a, b] : [b, a]);
export const edgeRefKey = (e: readonly [number, number]) => (e[0] < e[1] ? `${e[0]}_${e[1]}` : `${e[1]}_${e[0]}`);

/** A selection in all three modes; only the active mode's list is meaningful. */
export interface MeshSelection {
  points: number[];
  edges: EdgeRef[];
  faces: number[];
}

export const emptySelection = (): MeshSelection => ({ points: [], edges: [], faces: [] });

/** Edges from a param value: pairs of integers, normalised lower-first, deduplicated. */
export function normalizeEdges(value: unknown): EdgeRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: EdgeRef[] = [];
  for (const e of value) {
    if (!Array.isArray(e) || e.length !== 2 || !Number.isInteger(e[0]) || !Number.isInteger(e[1]) || e[0] === e[1]) continue;
    const ref = edgeRef(e[0], e[1]);
    const key = edgeRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/** Every vertex the selection covers: the points, the edges' ends, the faces' corners. */
export function selectionVertices(mesh: QuadMesh, mode: SelectMode, sel: MeshSelection): Set<number> {
  const out = new Set<number>();
  if (mode === "points") {
    for (const v of sel.points) if (v >= 0 && v < mesh.positions.length) out.add(v);
  } else if (mode === "edges") {
    for (const [a, b] of sel.edges) {
      if (a < mesh.positions.length) out.add(a);
      if (b < mesh.positions.length) out.add(b);
    }
  } else {
    for (const f of sel.faces) for (const v of mesh.faces[f] ?? []) out.add(v);
  }
  return out;
}

/** Edges whose two ends are both in `vertices`. */
function edgesWithin(mesh: QuadMesh, vertices: Set<number>): EdgeRef[] {
  return getTopology(mesh).edges.filter(([a, b]) => vertices.has(a) && vertices.has(b)).map(([a, b]) => [a, b] as EdgeRef);
}

/** Faces whose corners are all in `vertices`. */
function facesWithin(mesh: QuadMesh, vertices: Set<number>): number[] {
  const out: number[] = [];
  mesh.faces.forEach((face, f) => {
    if (face.length > 0 && face.every((v) => vertices.has(v))) out.push(f);
  });
  return out;
}

/**
 * The selection carried over to another mode, the way Blender does it when
 * the select mode changes: points → edges/faces keeps those whose corners are
 * all selected; faces → points/edges takes their corners/edges; edges → faces
 * keeps faces whose every edge is selected.
 */
export function convertSelection(mesh: QuadMesh, from: SelectMode, sel: MeshSelection, to: SelectMode): MeshSelection {
  const out: MeshSelection = { ...sel };
  if (from === to) return out;
  const vertices = selectionVertices(mesh, from, sel);
  if (to === "points") {
    out.points = [...vertices].sort((a, b) => a - b);
  } else if (to === "edges") {
    if (from === "faces") {
      const keys = new Set<string>();
      out.edges = [];
      for (const f of sel.faces) {
        const face = mesh.faces[f] ?? [];
        for (let i = 0; i < face.length; i++) {
          const e = edgeRef(face[i], face[(i + 1) % face.length]);
          if (!keys.has(edgeRefKey(e))) {
            keys.add(edgeRefKey(e));
            out.edges.push(e);
          }
        }
      }
    } else {
      out.edges = edgesWithin(mesh, vertices);
    }
  } else if (from === "edges") {
    const keys = new Set(sel.edges.map(edgeRefKey));
    out.faces = [];
    mesh.faces.forEach((face, f) => {
      if (face.every((v, i) => keys.has(edgeRefKey([v, face[(i + 1) % face.length]])))) out.faces.push(f);
    });
  } else {
    out.faces = facesWithin(mesh, vertices);
  }
  return out;
}

/** Vertex → neighbouring vertices across an edge. */
function vertexNeighbours(mesh: QuadMesh): number[][] {
  const neighbours: number[][] = Array.from({ length: mesh.positions.length }, () => []);
  for (const [a, b] of getTopology(mesh).edges) {
    neighbours[a]?.push(b);
    neighbours[b]?.push(a);
  }
  return neighbours;
}

/** A points-mode result expressed in `mode` (edges/faces within the vertex set). */
function fromVertices(mesh: QuadMesh, mode: SelectMode, sel: MeshSelection, vertices: Set<number>): MeshSelection {
  const out: MeshSelection = { ...sel };
  if (mode === "points") out.points = [...vertices].sort((a, b) => a - b);
  else if (mode === "edges") out.edges = edgesWithin(mesh, vertices);
  else out.faces = facesWithin(mesh, vertices);
  return out;
}

/**
 * Grows the selection by one step: points take their neighbours, edges and
 * faces take everything sharing a vertex with them (Blender's default).
 */
export function growSelection(mesh: QuadMesh, mode: SelectMode, sel: MeshSelection): MeshSelection {
  const vertices = selectionVertices(mesh, mode, sel);
  if (mode === "points") {
    const neighbours = vertexNeighbours(mesh);
    const grown = new Set(vertices);
    for (const v of vertices) for (const n of neighbours[v] ?? []) grown.add(n);
    return fromVertices(mesh, mode, sel, grown);
  }
  if (mode === "edges") {
    const out: MeshSelection = { ...sel };
    out.edges = getTopology(mesh).edges.filter(([a, b]) => vertices.has(a) || vertices.has(b)).map(([a, b]) => [a, b] as EdgeRef);
    return out;
  }
  const out: MeshSelection = { ...sel };
  out.faces = [];
  mesh.faces.forEach((face, f) => {
    if (face.some((v) => vertices.has(v))) out.faces.push(f);
  });
  return out;
}

/** Vertices on an open border of the mesh itself. */
function meshBorderVertices(mesh: QuadMesh): Set<number> {
  const topo = getTopology(mesh);
  const out = new Set<number>();
  topo.edges.forEach(([a, b], e) => {
    if (topo.isBoundaryEdge(e)) {
      out.add(a);
      out.add(b);
    }
  });
  return out;
}

/**
 * Shrinks the selection by one step: drops everything on the selected
 * region's border — vertices with an unselected neighbour, faces touching a
 * vertex an unselected face also uses. The mesh's own open border counts as
 * a border too, as in Blender: shrinking a whole selected plane peels off
 * its outer ring.
 */
export function shrinkSelection(mesh: QuadMesh, mode: SelectMode, sel: MeshSelection): MeshSelection {
  const meshBorder = meshBorderVertices(mesh);
  if (mode === "faces") {
    const selected = new Set(sel.faces);
    const border = new Set<number>(meshBorder);
    mesh.faces.forEach((face, f) => {
      if (!selected.has(f)) for (const v of face) border.add(v);
    });
    const out: MeshSelection = { ...sel };
    out.faces = sel.faces.filter((f) => !(mesh.faces[f] ?? []).some((v) => border.has(v)));
    return out;
  }
  const vertices = selectionVertices(mesh, mode, sel);
  const neighbours = vertexNeighbours(mesh);
  const kept = new Set<number>();
  for (const v of vertices) {
    if (!meshBorder.has(v) && (neighbours[v] ?? []).every((n) => vertices.has(n))) kept.add(v);
  }
  return fromVertices(mesh, mode, sel, kept);
}

/**
 * Every vertex connected to `seeds` through edges — the islands they're on.
 */
export function linkedVertices(mesh: QuadMesh, seeds: Iterable<number>): Set<number> {
  const neighbours = vertexNeighbours(mesh);
  const seen = new Set<number>();
  const stack = [...seeds].filter((v) => v >= 0 && v < mesh.positions.length);
  for (const v of stack) seen.add(v);
  while (stack.length) {
    const v = stack.pop()!;
    for (const n of neighbours[v]) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return seen;
}

/** The whole islands the selection touches, in `mode`. */
export function linkedSelection(mesh: QuadMesh, mode: SelectMode, sel: MeshSelection): MeshSelection {
  return fromVertices(mesh, mode, sel, linkedVertices(mesh, selectionVertices(mesh, mode, sel)));
}

/**
 * Faces reachable from `seeds` across edges where the two faces bend by no
 * more than `maxAngleDeg` — a flat side of a model, a floor, a panel.
 */
export function flatFaces(mesh: QuadMesh, seeds: number[], maxAngleDeg: number): number[] {
  const topo = getTopology(mesh);
  const cosLimit = Math.cos((Math.max(0, maxAngleDeg) * Math.PI) / 180) - 1e-9;
  const normals = mesh.faces.map((face) => computeFaceNormal(mesh.positions, face));
  const seen = new Set<number>(seeds.filter((f) => f >= 0 && f < mesh.faces.length));
  const stack = [...seen];
  while (stack.length) {
    const f = stack.pop()!;
    for (let h = topo.faceStart[f]; h < topo.faceStart[f] + topo.faceSize[f]; h++) {
      const twin = topo.heTwin[h];
      if (twin === -1) continue;
      const g = topo.heFace[twin];
      if (seen.has(g) || normals[f].dot(normals[g]) < cosLimit) continue;
      seen.add(g);
      stack.push(g);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

export type SelectionOp = "replace" | "add" | "toggle" | "remove";

/** `picked` merged into `current` for `mode`'s list; the other modes' lists are kept. */
export function combineSelection(mode: SelectMode, current: MeshSelection, picked: MeshSelection, op: SelectionOp): MeshSelection {
  const out: MeshSelection = { ...current };
  if (mode === "edges") {
    const map = new Map<string, EdgeRef>(op === "replace" ? [] : current.edges.map((e) => [edgeRefKey(e), e]));
    for (const e of picked.edges) {
      const ref = edgeRef(e[0], e[1]);
      const key = edgeRefKey(ref);
      if (op === "remove" || (op === "toggle" && map.has(key))) map.delete(key);
      else map.set(key, ref);
    }
    out.edges = [...map.values()];
    return out;
  }
  const list = mode === "points" ? "points" : "faces";
  const set = new Set<number>(op === "replace" ? [] : current[list]);
  for (const i of picked[list]) {
    if (op === "remove" || (op === "toggle" && set.has(i))) set.delete(i);
    else set.add(i);
  }
  out[list] = [...set].sort((a, b) => a - b);
  return out;
}

/** Everything in the mesh, in `mode`. */
export function selectAll(mesh: QuadMesh, mode: SelectMode, current: MeshSelection): MeshSelection {
  const out: MeshSelection = { ...current };
  if (mode === "points") out.points = mesh.positions.map((_, i) => i);
  else if (mode === "edges") out.edges = getTopology(mesh).edges.map(([a, b]) => [a, b] as EdgeRef);
  else out.faces = mesh.faces.map((_, i) => i);
  return out;
}
