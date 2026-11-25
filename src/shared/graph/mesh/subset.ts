import { deleteFaces, extractFaces, type PolyMesh } from "../quadMesh";
import { propagateAttributes, type PropagationMaps } from "./propagate";

/**
 * Keeping a subset of faces with attributes intact. quadMesh.ts's
 * deleteFaces / extractFaces compact the mesh (unused vertices go, the rest
 * are renumbered in order), which defeats propagate's "old indices are kept"
 * inference — so the exact maps are rebuilt here the same way subsetFaces
 * numbers things: kept faces in order, used vertices in ascending order
 * (loose edges keep their vertices unless `dropLooseEdges`).
 */
export function subsetMaps(mesh: PolyMesh, keepFace: ArrayLike<number>, dropLooseEdges = false): Required<PropagationMaps> {
  const face: number[] = [];
  const used = new Uint8Array(mesh.positions.length);
  mesh.faces.forEach((f, i) => {
    if (!keepFace[i]) return;
    face.push(i);
    for (const v of f) used[v] = 1;
  });
  if (!dropLooseEdges) for (const [a, b] of mesh.edges ?? []) used[a] = used[b] = 1;
  const point: number[] = [];
  for (let v = 0; v < used.length; v++) if (used[v]) point.push(v);
  return { point, face };
}

/** The faces with `keepFace[f]` set, everything else deleted, attributes and groups carried. */
export function keepFacesWithAttributes(mesh: PolyMesh, keepFace: ArrayLike<number>): PolyMesh {
  const remove: number[] = [];
  for (let f = 0; f < mesh.faces.length; f++) if (!keepFace[f]) remove.push(f);
  if (remove.length === 0) return mesh;
  const bare: PolyMesh = { ...mesh, attributes: undefined };
  return propagateAttributes(mesh, deleteFaces(bare, remove), subsetMaps(mesh, keepFace));
}

/** The faces with `faceMask[f]` set as a mesh of their own (loose edges stay behind). */
export function extractFacesWithAttributes(mesh: PolyMesh, faceMask: ArrayLike<number>): PolyMesh {
  const faces: number[] = [];
  for (let f = 0; f < mesh.faces.length; f++) if (faceMask[f]) faces.push(f);
  const bare: PolyMesh = { ...mesh, attributes: undefined };
  return propagateAttributes(mesh, extractFaces(bare, faces), subsetMaps(mesh, faceMask, true));
}

/** Points removed (and every face using one): keeps points with `keepPoint[v]` set. */
export function keepPointsWithAttributes(mesh: PolyMesh, keepPoint: ArrayLike<number>): PolyMesh {
  const keepFace = Uint8Array.from(mesh.faces, (f) => (f.every((v) => keepPoint[v]) ? 1 : 0));
  // Loose edges with a removed end go too.
  const edges = mesh.edges?.filter(([a, b]) => keepPoint[a] && keepPoint[b]);
  const trimmed: PolyMesh = edges && mesh.edges && edges.length !== mesh.edges.length ? { ...mesh, edges } : mesh;
  return keepFacesWithAttributes(trimmed, keepFace);
}
