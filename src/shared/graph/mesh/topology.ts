import type { QuadMesh } from "../quadMesh";

/**
 * Half-edge connectivity for a QuadMesh.
 *
 * QuadMesh stays the stored format (plain JSON in the .tsuji, per-corner UVs
 * already in faceUVs); this is the index built on top of it whenever an
 * operation or a selection tool needs to walk the surface — across an edge to
 * the neighbouring face, around a vertex, along a loop — instead of every
 * operation rebuilding its own ad-hoc edge maps.
 *
 * Half-edge `h` belongs to face `heFace[h]` and runs from `heOrigin[h]` to
 * `heOrigin[heNext[h]]`. Face `f`'s half-edges are `faceStart[f] ..
 * faceStart[f] + faceSize[f] - 1`, in the face's own winding: half-edge
 * `faceStart[f] + i` leaves corner `i`.
 *
 * `heTwin[h]` is the half-edge running the opposite way along the same edge in
 * the adjacent face, or -1 when there is none: a boundary edge, or an edge the
 * surface can't be walked across because it's non-manifold (three or more
 * faces) or its two faces disagree on winding. Those two cases are counted,
 * not thrown — imported meshes have them, and the operations below just stop
 * at such an edge the way they stop at a boundary.
 */
export interface MeshTopology {
  readonly vertexCount: number;
  readonly faceCount: number;
  readonly heOrigin: Int32Array;
  readonly heNext: Int32Array;
  readonly hePrev: Int32Array;
  readonly heTwin: Int32Array;
  readonly heFace: Int32Array;
  /** Undirected edge id of each half-edge (both halves of an edge share it). */
  readonly heEdge: Int32Array;
  readonly faceStart: Int32Array;
  readonly faceSize: Int32Array;
  /** One outgoing half-edge per vertex, preferring a boundary one; -1 when unused. */
  readonly vertexOut: Int32Array;
  /** Unique undirected edges as [min, max] vertex pairs, indexed by edge id. */
  readonly edges: ReadonlyArray<readonly [number, number]>;
  /** Edges shared by three or more faces. */
  readonly nonManifoldEdgeCount: number;
  /** Two-face edges whose faces run the same way along it (flipped winding). */
  readonly inconsistentEdgeCount: number;
  /** The half-edge running a → b, or -1. */
  findHalfedge(a: number, b: number): number;
  /** Edge id of the undirected edge {a, b}, or -1. */
  findEdge(a: number, b: number): number;
  /** Faces containing edge {a, b}. */
  edgeFaces(a: number, b: number): number[];
  /** Faces around a vertex (any order). */
  vertexFaces(v: number): number[];
  isBoundaryEdge(edgeId: number): boolean;
}

const pairKey = (a: number, b: number) => (a < b ? a * 0x100000000 + b : b * 0x100000000 + a);
const dirKey = (a: number, b: number) => a * 0x100000000 + b;

export function buildTopology(mesh: QuadMesh): MeshTopology {
  const vertexCount = mesh.positions.length;
  const faceCount = mesh.faces.length;

  let heCount = 0;
  const faceStart = new Int32Array(faceCount);
  const faceSize = new Int32Array(faceCount);
  for (let f = 0; f < faceCount; f++) {
    faceStart[f] = heCount;
    faceSize[f] = mesh.faces[f].length;
    heCount += mesh.faces[f].length;
  }

  const heOrigin = new Int32Array(heCount);
  const heNext = new Int32Array(heCount);
  const hePrev = new Int32Array(heCount);
  const heTwin = new Int32Array(heCount).fill(-1);
  const heFace = new Int32Array(heCount);
  const heEdge = new Int32Array(heCount);

  const directed = new Map<number, number>();
  const edgeIds = new Map<number, number>();
  const edges: [number, number][] = [];
  const edgeHalfedges: number[][] = [];

  for (let f = 0; f < faceCount; f++) {
    const face = mesh.faces[f];
    const n = face.length;
    const base = faceStart[f];
    for (let i = 0; i < n; i++) {
      const h = base + i;
      const a = face[i];
      const b = face[(i + 1) % n];
      heOrigin[h] = a;
      heNext[h] = base + ((i + 1) % n);
      hePrev[h] = base + ((i + n - 1) % n);
      heFace[h] = f;
      if (!directed.has(dirKey(a, b))) directed.set(dirKey(a, b), h);

      const key = pairKey(a, b);
      let id = edgeIds.get(key);
      if (id === undefined) {
        id = edges.length;
        edgeIds.set(key, id);
        edges.push(a < b ? [a, b] : [b, a]);
        edgeHalfedges.push([]);
      }
      heEdge[h] = id;
      edgeHalfedges[id].push(h);
    }
  }

  let nonManifoldEdgeCount = 0;
  let inconsistentEdgeCount = 0;
  for (const halves of edgeHalfedges) {
    if (halves.length > 2) {
      nonManifoldEdgeCount++;
      continue;
    }
    if (halves.length !== 2) continue;
    const [h0, h1] = halves;
    // Twins must run in opposite directions: h1 goes where h0 came from.
    if (heOrigin[h0] === heOrigin[heNext[h1]] && heOrigin[h1] === heOrigin[heNext[h0]]) {
      heTwin[h0] = h1;
      heTwin[h1] = h0;
    } else {
      inconsistentEdgeCount++;
    }
  }

  // An outgoing half-edge per vertex; a boundary one where there is one, so
  // a walk around the vertex that starts there covers the whole fan.
  const vertexOut = new Int32Array(vertexCount).fill(-1);
  for (let h = 0; h < heCount; h++) {
    const v = heOrigin[h];
    if (v < 0 || v >= vertexCount) continue;
    if (vertexOut[v] === -1 || heTwin[hePrev[h]] === -1) vertexOut[v] = h;
  }

  let vertexFacesCache: number[][] | null = null;

  return {
    vertexCount,
    faceCount,
    heOrigin,
    heNext,
    hePrev,
    heTwin,
    heFace,
    heEdge,
    faceStart,
    faceSize,
    vertexOut,
    edges,
    nonManifoldEdgeCount,
    inconsistentEdgeCount,
    findHalfedge: (a, b) => directed.get(dirKey(a, b)) ?? -1,
    findEdge: (a, b) => edgeIds.get(pairKey(a, b)) ?? -1,
    edgeFaces(a, b) {
      const id = edgeIds.get(pairKey(a, b));
      return id === undefined ? [] : edgeHalfedges[id].map((h) => heFace[h]);
    },
    vertexFaces(v) {
      // Built on first use: a walk around the vertex would miss faces past a
      // non-manifold edge, so this is a plain incidence list instead.
      if (!vertexFacesCache) {
        const lists: number[][] = Array.from({ length: vertexCount }, () => []);
        for (let f = 0; f < faceCount; f++) {
          for (const u of mesh.faces[f]) {
            const list = lists[u];
            if (list && list[list.length - 1] !== f) list.push(f);
          }
        }
        vertexFacesCache = lists;
      }
      return vertexFacesCache[v] ?? [];
    },
    isBoundaryEdge: (id) => edgeHalfedges[id]?.length === 1,
  };
}

const topologyCache = new WeakMap<QuadMesh, MeshTopology>();

/**
 * The topology of `mesh`, cached on the object. Only valid while the mesh is
 * treated as immutable — which every stored mesh is (edits replace meshData,
 * they never mutate it); an operation building a new mesh calls buildTopology
 * on it directly instead.
 */
export function getTopology(mesh: QuadMesh): MeshTopology {
  let topology = topologyCache.get(mesh);
  if (!topology) {
    topology = buildTopology(mesh);
    topologyCache.set(mesh, topology);
  }
  return topology;
}
