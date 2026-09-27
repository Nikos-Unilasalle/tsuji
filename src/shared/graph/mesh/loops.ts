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
