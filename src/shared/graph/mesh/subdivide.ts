import { QuadMesh, withFaceUVs } from "../quadMesh";
import { buildTopology } from "./topology";
import { cornerColor, creaseMap, edgeKey } from "./attributes";
import type { UV } from "./uv";

type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Catmull-Clark on the polygons themselves — quads, triangles and n-gons —
 * rather than on a triangulation of them, which is what gives a quad cage
 * its clean, even limit surface (subdividing the triangles instead leaves
 * lumps and pinches along every diagonal).
 *
 * Creases: an edge's weight (0..1) blends its new points between the smooth
 * rule and the sharp one, so 1 keeps the edge a hard line through every
 * level; a vertex on two creased edges follows the crease, on three or more
 * stays put (a corner). Open borders count as fully creased. Crease weights,
 * sharp edges and seams are handed on to both halves of each split edge.
 *
 * UVs, corner colours, material slots and shading are subdivided linearly
 * per face (an edge's new corner at the midpoint of its two, a face's at the
 * average), so texture seams stay where they were.
 */
export function catmullClarkQuadMesh(mesh: QuadMesh, levels = 1): QuadMesh {
  let current = withFaceUVs(mesh);
  const count = Math.max(0, Math.min(6, Math.round(levels)));
  for (let i = 0; i < count; i++) current = catmullClarkStep(current);
  return current;
}

function catmullClarkStep(mesh: QuadMesh): QuadMesh {
  const topo = buildTopology(mesh);
  const P = mesh.positions;
  const creases = creaseMap(mesh);
  const sharpKeys = new Set((mesh.sharpEdges ?? []).map(([a, b]) => edgeKey(a, b)));
  const seamKeys = new Set((mesh.seamEdges ?? []).map(([a, b]) => edgeKey(a, b)));

  // Face points.
  const facePoints: V3[] = mesh.faces.map((face) => {
    let c: V3 = [0, 0, 0];
    for (const v of face) c = add(c, P[v]);
    return scale(c, 1 / face.length);
  });

  // Per edge: its faces, its crease (1 on a border or non-manifold edge).
  const edgeFaceList: number[][] = topo.edges.map(() => []);
  for (let h = 0; h < topo.heOrigin.length; h++) edgeFaceList[topo.heEdge[h]].push(topo.heFace[h]);
  const edgeCrease = topo.edges.map(([a, b], e) => (edgeFaceList[e].length !== 2 ? 1 : (creases.get(edgeKey(a, b)) ?? 0)));

  const edgePoints: V3[] = topo.edges.map(([a, b], e) => {
    const mid = scale(add(P[a], P[b]), 0.5);
    const faces = edgeFaceList[e];
    if (faces.length !== 2) return mid;
    const smooth = scale(add(add(P[a], P[b]), add(facePoints[faces[0]], facePoints[faces[1]])), 0.25);
    return lerp(smooth, mid, edgeCrease[e]);
  });

  // Vertex points.
  const vertexEdges: number[][] = Array.from({ length: P.length }, () => []);
  topo.edges.forEach(([a, b], e) => {
    vertexEdges[a].push(e);
    vertexEdges[b].push(e);
  });
  const vertexPoints: V3[] = P.map((S, v) => {
    const edges = vertexEdges[v];
    const faces = topo.vertexFaces(v);
    if (edges.length === 0 || faces.length === 0) return S;
    const other = (e: number) => (topo.edges[e][0] === v ? topo.edges[e][1] : topo.edges[e][0]);
    const creased = edges.filter((e) => edgeCrease[e] > 0);

    // Smooth rule: (Q + 2R + (n - 3)S) / n.
    const n = edges.length;
    let Q: V3 = [0, 0, 0];
    for (const f of faces) Q = add(Q, facePoints[f]);
    Q = scale(Q, 1 / faces.length);
    let R: V3 = [0, 0, 0];
    for (const e of edges) R = add(R, scale(add(S, P[other(e)]), 0.5));
    R = scale(R, 1 / n);
    const smooth = scale(add(add(Q, scale(R, 2)), scale(S, n - 3)), 1 / n);

    if (creased.length < 2) return smooth;
    const weight = creased.reduce((acc, e) => acc + edgeCrease[e], 0) / creased.length;
    const sharpRule =
      creased.length === 2
        ? scale(add(add(P[other(creased[0])], P[other(creased[1])]), scale(S, 6)), 1 / 8)
        : S; // three or more creases meet: a corner
    return lerp(smooth, sharpRule, weight);
  });

  // New vertex order: vertex points, face points, edge points.
  const faceBase = P.length;
  const edgeBase = faceBase + facePoints.length;
  const positions: V3[] = [...vertexPoints, ...facePoints, ...edgePoints];

  const faces: number[][] = [];
  const faceUVs: UV[][] = [];
  const faceColors: NonNullable<QuadMesh["faceColors"]> = [];
  const faceMaterials: number[] = [];
  const faceShading: NonNullable<QuadMesh["faceShading"]> = [];
  const hasColors = Boolean(mesh.faceColors?.some((c) => c));
  const hasShading = Boolean(mesh.faceShading && mesh.faceShading.length > 0);

  mesh.faces.forEach((face, f) => {
    const n = face.length;
    const uvs = mesh.faceUVs![f] as UV[];
    const fpUV: UV = [uvs.reduce((s, uv) => s + uv[0], 0) / n, uvs.reduce((s, uv) => s + uv[1], 0) / n];
    const col = (i: number) => cornerColor(mesh, f, i);
    const fpCol: V3 = hasColors ? scale(face.reduce<V3>((acc, _, i) => add(acc, col(i)), [0, 0, 0]), 1 / n) : [1, 1, 1];
    const ep = (i: number) => edgeBase + topo.findEdge(face[i], face[(i + 1) % n]);
    for (let i = 0; i < n; i++) {
      const prev = (i + n - 1) % n;
      faces.push([face[i], ep(i), faceBase + f, ep(prev)]);
      faceUVs.push([
        uvs[i],
        [(uvs[i][0] + uvs[(i + 1) % n][0]) / 2, (uvs[i][1] + uvs[(i + 1) % n][1]) / 2],
        fpUV,
        [(uvs[prev][0] + uvs[i][0]) / 2, (uvs[prev][1] + uvs[i][1]) / 2],
      ]);
      if (hasColors) {
        faceColors.push([col(i), scale(add(col(i), col((i + 1) % n)), 0.5), fpCol, scale(add(col(prev), col(i)), 0.5)]);
      }
      faceMaterials.push(mesh.faceMaterials?.[f] ?? 0);
      if (hasShading) faceShading.push(mesh.faceShading![f]);
    }
  });

  // Each marked edge becomes its two halves.
  const halves = (keys: Set<string>) => {
    const out: [number, number][] = [];
    topo.edges.forEach(([a, b], e) => {
      if (!keys.has(edgeKey(a, b))) return;
      out.push([a, edgeBase + e].sort((x, y) => x - y) as [number, number]);
      out.push([b, edgeBase + e].sort((x, y) => x - y) as [number, number]);
    });
    return out;
  };
  const edgeCreases: [number, number, number][] = [];
  topo.edges.forEach(([a, b], e) => {
    const w = creases.get(edgeKey(a, b));
    if (!w) return;
    edgeCreases.push([Math.min(a, edgeBase + e), Math.max(a, edgeBase + e), w]);
    edgeCreases.push([Math.min(b, edgeBase + e), Math.max(b, edgeBase + e), w]);
  });

  return {
    positions,
    faces,
    faceUVs,
    shading: mesh.shading,
    faceShading: hasShading ? faceShading : mesh.faceShading ? [] : undefined,
    faceMaterials: mesh.faceMaterials ? faceMaterials : undefined,
    faceColors: hasColors ? faceColors : undefined,
    sharpEdges: mesh.sharpEdges ? halves(sharpKeys) : undefined,
    seamEdges: mesh.seamEdges ? halves(seamKeys) : undefined,
    edgeCreases: mesh.edgeCreases ? edgeCreases : undefined,
    // Vertex points keep their vertices' indices, and a vertex no face uses
    // stays put: loose edges come through as they were.
    edges: mesh.edges?.map(([a, b]) => [a, b] as [number, number]),
    sourceSignature: mesh.sourceSignature,
  };
}
