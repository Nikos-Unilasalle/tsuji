import type { QuadMesh } from "../quadMesh";
import { getTopology } from "./topology";

export interface RingFace {
  face: number;
  /** Corner (0-3) the ring enters the quad through: the edge corner → corner+1. */
  corner: number;
  /**
   * The ring crosses this quad's entry edge in the opposite direction to the
   * start edge (the half of the ring walked backwards from it). A cut at
   * ratio t along the start edge sits at 1 − t along this quad's entry edge.
   */
  flipped: boolean;
}

/**
 * The quads a loop cut through edge {a, b} crosses — the edge ring — in walk
 * order, starting with a quad on that edge.
 *
 * Walked from the start edge through each quad to its opposite edge and on
 * into the next quad, and — when that doesn't come back around to the start —
 * also from the start edge the *other* way, so a cut through the middle of an
 * open grid splits the whole strip rather than stopping halfway. A walk stops
 * at a boundary, a non-quad face, or an edge that can't be crossed (see
 * MeshTopology.heTwin).
 */
export function quadRing(mesh: QuadMesh, a: number, b: number): { faces: RingFace[]; closed: boolean } {
  const topo = getTopology(mesh);
  let start = topo.findHalfedge(a, b);
  if (start === -1) start = topo.findHalfedge(b, a);
  if (start === -1) return { faces: [], closed: false };

  const visited = new Set<number>();
  const faces: RingFace[] = [];

  const walk = (from: number, flipped: boolean): boolean => {
    let h = from;
    while (h !== -1) {
      const f = topo.heFace[h];
      if (visited.has(f)) return faces.length > 0 && f === faces[0].face;
      if (topo.faceSize[f] !== 4) return false;
      visited.add(f);
      faces.push({ face: f, corner: h - topo.faceStart[f], flipped });
      const opposite = topo.heNext[topo.heNext[h]];
      h = topo.heTwin[opposite];
    }
    return false;
  };

  const closed = walk(start, false);
  if (!closed) {
    const back = topo.heTwin[start];
    if (back !== -1) {
      // Prepend the backward half so the list reads as one continuous strip.
      const forward = faces.splice(0);
      walk(back, true);
      faces.reverse();
      faces.push(...forward);
    }
  }
  return { faces, closed };
}

type EdgePair = [number, number];

/**
 * The edge loop through edge {a, b}, as Blender's Alt+click picks it: from
 * each end, continue straight through the vertex — at a vertex with exactly
 * four edges, the edge opposite the one arrived by — until the loop closes, or
 * reaches a pole (any other edge count) or a boundary. A boundary edge
 * instead follows the boundary around its hole or open border.
 */
export function edgeLoop(mesh: QuadMesh, a: number, b: number): EdgePair[] {
  const topo = getTopology(mesh);
  let start = topo.findHalfedge(a, b);
  if (start === -1) start = topo.findHalfedge(b, a);
  if (start === -1) return [];

  const valence = new Int32Array(topo.vertexCount);
  for (const [u, v] of topo.edges) {
    valence[u]++;
    valence[v]++;
  }

  // The next half-edge of the loop after h (x → y), leaving y; -1 to stop.
  const step = (h: number): number => {
    const y = topo.heOrigin[topo.heNext[h]];
    if (topo.heTwin[h] === -1) {
      // Along the boundary: turn around y, face by face, to the next
      // boundary half-edge leaving it.
      let c = topo.heNext[h];
      for (let guard = 0; guard < 64 && topo.heTwin[c] !== -1; guard++) c = topo.heNext[topo.heTwin[c]];
      return topo.heTwin[c] === -1 && c !== h ? c : -1;
    }
    if (valence[y] !== 4) return -1;
    const across = topo.heTwin[topo.heNext[h]];
    return across === -1 ? -1 : topo.heNext[across];
  };

  const seen = new Set<number>([topo.heEdge[start]]);
  const out: EdgePair[] = [[...topo.edges[topo.heEdge[start]]] as EdgePair];
  const walk = (from: number) => {
    for (let h = step(from); h !== -1 && !seen.has(topo.heEdge[h]); h = step(h)) {
      seen.add(topo.heEdge[h]);
      out.push([...topo.edges[topo.heEdge[h]]] as EdgePair);
    }
  };
  walk(start);
  const back = topo.heTwin[start];
  if (back !== -1) walk(back);
  return out;
}

/**
 * The edge ring through edge {a, b}: the "rungs" a loop cut there would
 * cross — the entry and opposite edge of every quad in quadRing.
 */
export function edgeRing(mesh: QuadMesh, a: number, b: number): EdgePair[] {
  const seen = new Set<string>();
  const out: EdgePair[] = [];
  const add = (u: number, v: number) => {
    const e: EdgePair = u < v ? [u, v] : [v, u];
    const key = `${e[0]}_${e[1]}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  };
  add(a, b);
  for (const { face, corner } of quadRing(mesh, a, b).faces) {
    const f = mesh.faces[face];
    add(f[corner], f[(corner + 1) % 4]);
    add(f[(corner + 2) % 4], f[(corner + 3) % 4]);
  }
  return out;
}
