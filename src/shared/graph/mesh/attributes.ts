import type { QuadMesh } from "../quadMesh";

/*
 * Edge attributes — sharp, seam, crease — are stored as vertex pairs (lower
 * index first), so they read naturally in the saved file and survive any
 * operation that keeps those two vertices. Operations that renumber vertices
 * remap them (remapEdgeAttributes); operations that split an edge hand the
 * attribute on to both halves (splitEdgeAttributes).
 */

export type Color3 = [number, number, number];
export type EdgeAttribute = "sharpEdges" | "seamEdges";

export const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
const pair = (a: number, b: number): [number, number] => (a < b ? [a, b] : [b, a]);

/** Copies of the edge attributes (for cloneQuadMesh). */
export function cloneEdgeAttributes(
  mesh: QuadMesh,
): Pick<QuadMesh, "sharpEdges" | "seamEdges" | "edgeCreases" | "faceColors" | "edges"> {
  return {
    edges: mesh.edges?.map(([a, b]) => [a, b] as [number, number]),
    sharpEdges: mesh.sharpEdges?.map(([a, b]) => [a, b] as [number, number]),
    seamEdges: mesh.seamEdges?.map(([a, b]) => [a, b] as [number, number]),
    edgeCreases: mesh.edgeCreases?.map(([a, b, w]) => [a, b, w] as [number, number, number]),
    faceColors: mesh.faceColors?.map((c) => (c ? c.map((x) => [x[0], x[1], x[2]] as Color3) : null)),
  };
}

/** The mesh's existing edges, as keys. */
export function meshEdgeKeys(mesh: QuadMesh): Set<string> {
  const keys = new Set<string>();
  for (const face of mesh.faces) for (let i = 0; i < face.length; i++) keys.add(edgeKey(face[i], face[(i + 1) % face.length]));
  return keys;
}

/**
 * Writes `src`'s edge attributes onto `out` through a vertex renumbering
 * (-1 = gone), keeping only edges `out` actually has.
 */
export function remapEdgeAttributes(src: QuadMesh, out: QuadMesh, remap: ArrayLike<number>): void {
  const exists = meshEdgeKeys(out);
  const mapPairs = (list?: [number, number][]) => {
    if (!list) return undefined;
    const seen = new Set<string>();
    const next: [number, number][] = [];
    for (const [a, b] of list) {
      const x = remap[a];
      const y = remap[b];
      if (x === undefined || y === undefined || x < 0 || y < 0 || x === y) continue;
      const key = edgeKey(x, y);
      if (!exists.has(key) || seen.has(key)) continue;
      seen.add(key);
      next.push(pair(x, y));
    }
    return next;
  };
  out.sharpEdges = mapPairs(src.sharpEdges);
  out.seamEdges = mapPairs(src.seamEdges);
  // Loose edges survive wherever both ends do — unless a face now uses them.
  if (src.edges) {
    const seen = new Set<string>();
    out.edges = [];
    for (const [a, b] of src.edges) {
      const x = remap[a];
      const y = remap[b];
      if (x === undefined || y === undefined || x < 0 || y < 0 || x === y) continue;
      const key = edgeKey(x, y);
      if (exists.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.edges.push(pair(x, y));
    }
  }
  if (src.edgeCreases) {
    const seen = new Set<string>();
    out.edgeCreases = [];
    for (const [a, b, w] of src.edgeCreases) {
      const x = remap[a];
      const y = remap[b];
      if (x === undefined || y === undefined || x < 0 || y < 0 || x === y) continue;
      const key = edgeKey(x, y);
      if (!exists.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.edgeCreases.push([...pair(x, y), w]);
    }
  }
}

/** Remaps edge attributes in place through a vertex map (merges: many to one). */
export function mapEdgeAttributesInPlace(mesh: QuadMesh, map: (v: number) => number): void {
  const identity = new Int32Array(mesh.positions.length).map((_, i) => map(i));
  const copy = { ...mesh };
  remapEdgeAttributes(copy, mesh, identity);
}

/**
 * An operation put vertices `mids` along edge a–b, in order from a (loop
 * cut, knife, subdivide): whatever marked a–b now marks every piece of it.
 */
export function splitEdgeAttributes(mesh: QuadMesh, a: number, b: number, mids: number[]): void {
  if (mids.length === 0) return;
  const key = edgeKey(a, b);
  const chain = [a, ...mids, b];
  const pieces = chain.slice(1).map((v, i) => pair(chain[i], v));
  const splitPairs = (list?: [number, number][]) => {
    if (!list) return;
    const i = list.findIndex(([x, y]) => edgeKey(x, y) === key);
    if (i >= 0) list.splice(i, 1, ...pieces);
  };
  splitPairs(mesh.sharpEdges);
  splitPairs(mesh.seamEdges);
  if (mesh.edgeCreases) {
    const i = mesh.edgeCreases.findIndex(([x, y]) => edgeKey(x, y) === key);
    if (i >= 0) {
      const w = mesh.edgeCreases[i][2];
      mesh.edgeCreases.splice(i, 1, ...pieces.map((p) => [p[0], p[1], w] as [number, number, number]));
    }
  }
}

/** Marks (or, with `clear`, unmarks) edges as sharp or seam. */
export function setEdgeFlag(mesh: QuadMesh, attribute: EdgeAttribute, edges: [number, number][], clear = false): QuadMesh {
  const current = new Map((mesh[attribute] ?? []).map((e) => [edgeKey(e[0], e[1]), e] as const));
  for (const [a, b] of edges) {
    if (clear) current.delete(edgeKey(a, b));
    else current.set(edgeKey(a, b), pair(a, b));
  }
  return { ...mesh, [attribute]: [...current.values()] };
}

/** Sets the crease weight (0..1; 0 removes it) of the given edges. */
export function setEdgeCrease(mesh: QuadMesh, edges: [number, number][], weight: number): QuadMesh {
  const w = Math.max(0, Math.min(1, weight));
  const current = new Map((mesh.edgeCreases ?? []).map((e) => [edgeKey(e[0], e[1]), e] as const));
  for (const [a, b] of edges) {
    if (w === 0) current.delete(edgeKey(a, b));
    else current.set(edgeKey(a, b), [...pair(a, b), w]);
  }
  return { ...mesh, edgeCreases: [...current.values()] };
}

/** Crease weight per edge key. */
export function creaseMap(mesh: QuadMesh): Map<string, number> {
  return new Map((mesh.edgeCreases ?? []).map(([a, b, w]) => [edgeKey(a, b), w]));
}

/** The colour of each corner of face f, falling back to the face's first colour, then white. */
export function cornerColor(mesh: QuadMesh, f: number, corner: number): Color3 {
  const c = mesh.faceColors?.[f];
  return c?.[corner] ?? c?.[0] ?? [1, 1, 1];
}

/**
 * Paints corners: every corner of the given faces, or — for points — every
 * corner sitting on one of the vertices.
 */
export function paintCorners(mesh: QuadMesh, color: Color3, target: { faces?: number[]; vertices?: number[] }): QuadMesh {
  const faceColors = mesh.faces.map((face, f) => face.map((_, i) => cornerColor(mesh, f, i)) as Color3[]);
  const faces = new Set(target.faces ?? []);
  const vertices = new Set(target.vertices ?? []);
  mesh.faces.forEach((face, f) =>
    face.forEach((v, i) => {
      if (faces.has(f) || vertices.has(v)) faceColors[f][i] = [color[0], color[1], color[2]];
    }),
  );
  return { ...mesh, faceColors };
}
