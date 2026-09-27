import { QuadMesh, cloneQuadMesh, withFaceUVs } from "../quadMesh";
import { lerpUV, UV } from "./uv";
import { splitEdgeAttributes } from "./attributes";

/** A knife cut point: on a vertex, or on an edge at `t` from its first vertex. */
export type KnifePoint = { vertex: number } | { edge: [number, number]; t: number };

/**
 * Cuts the mesh along a path of points snapped to vertices and edges
 * (Blender's knife, restricted to cuts along existing geometry: every point
 * sits on a vertex or an edge). A point on an edge splits that edge — in
 * every face using it, so neighbours stay attached — and each consecutive
 * pair of points sharing a face splits that face in two between them.
 *
 * Returns the new edges (selected afterwards) and how many segments couldn't
 * be cut because their two points share no face.
 */
export function knifeCut(
  mesh: QuadMesh,
  points: KnifePoint[],
): { mesh: QuadMesh; newEdges: [number, number][]; skipped: number } {
  const next = withFaceUVs(cloneQuadMesh(mesh));
  /** Vertices already inserted on each original edge, by position along it from its lower vertex. */
  const splits = new Map<string, { t: number; v: number }[]>();

  function insertOnEdge(a: number, b: number, tFromA: number): number {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const t = a === lo ? tFromA : 1 - tFromA;
    const key = `${lo}_${hi}`;
    const list = splits.get(key) ?? [];
    const existing = list.find((s) => Math.abs(s.t - t) < 1e-6);
    if (existing) return existing.v;
    // The sub-edge (already split by earlier points) this one falls on.
    const stops = [{ t: 0, v: lo }, ...list, { t: 1, v: hi }].sort((x, y) => x.t - y.t);
    let k = 0;
    while (k < stops.length - 2 && stops[k + 1].t < t) k++;
    const from = stops[k];
    const to = stops[k + 1];
    const local = (t - from.t) / Math.max(1e-9, to.t - from.t);
    const pa = next.positions[from.v];
    const pb = next.positions[to.v];
    const v = next.positions.length;
    next.positions.push([pa[0] + (pb[0] - pa[0]) * local, pa[1] + (pb[1] - pa[1]) * local, pa[2] + (pb[2] - pa[2]) * local]);
    // Into every face running along from.v–to.v, either way round.
    next.faces.forEach((face, f) => {
      const uvs = next.faceUVs![f] as UV[];
      for (let i = 0; i < face.length; i++) {
        const j = (i + 1) % face.length;
        const x = face[i];
        const y = face[j];
        if (!((x === from.v && y === to.v) || (x === to.v && y === from.v))) continue;
        const s = x === from.v ? local : 1 - local;
        face.splice(i + 1, 0, v);
        uvs.splice(i + 1, 0, lerpUV(uvs[i], uvs[j], s));
        break;
      }
    });
    list.push({ t, v });
    splits.set(key, list);
    splitEdgeAttributes(next, from.v, to.v, [v]);
    return v;
  }

  const resolved = points.map((p) => ("vertex" in p ? p.vertex : insertOnEdge(p.edge[0], p.edge[1], p.t)));

  const newEdges: [number, number][] = [];
  let skipped = 0;
  for (let k = 0; k + 1 < resolved.length; k++) {
    const p = resolved[k];
    const q = resolved[k + 1];
    if (p === q) continue;
    let cut = false;
    for (let f = 0; f < next.faces.length && !cut; f++) {
      const face = next.faces[f];
      const i = face.indexOf(p);
      const j = face.indexOf(q);
      if (i < 0 || j < 0) continue;
      const n = face.length;
      if ((i + 1) % n === j || (j + 1) % n === i) {
        cut = true; // already an edge
        break;
      }
      const uvs = next.faceUVs![f];
      const span = (from: number, to: number) => {
        const idx: number[] = [];
        for (let x = from; ; x = (x + 1) % n) {
          idx.push(x);
          if (x === to) break;
        }
        return idx;
      };
      const first = span(i, j);
      const second = span(j, i);
      next.faces[f] = first.map((x) => face[x]);
      next.faceUVs![f] = first.map((x) => uvs[x]);
      next.faces.push(second.map((x) => face[x]));
      next.faceUVs!.push(second.map((x) => uvs[x]));
      if (next.faceMaterials) next.faceMaterials.push(next.faceMaterials[f] ?? 0);
      if (next.faceShading && next.faceShading.length > 0) next.faceShading.push(next.faceShading[f] ?? next.shading ?? "auto");
      newEdges.push(p < q ? [p, q] : [q, p]);
      cut = true;
    }
    if (!cut) skipped++;
  }
  return { mesh: next, newEdges, skipped };
}
