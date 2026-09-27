import type { QuadMesh } from "../quadMesh";
import { buildTopology } from "./topology";

export interface MeshReport {
  /** Structural faults no operation may ever produce. Empty for a sound mesh. */
  errors: string[];
  /** Surface-quality counts: legitimate in an imported mesh, regressions when an operation introduces them. */
  boundaryEdges: number;
  nonManifoldEdges: number;
  inconsistentEdges: number;
  orphanVertices: number;
}

/**
 * Checks a QuadMesh's invariants. Used by the operation tests (every op must
 * keep `errors` empty, and must not add non-manifold or flipped edges to a
 * mesh that had none) and handy when an imported mesh misbehaves.
 */
export function validateQuadMesh(mesh: QuadMesh): MeshReport {
  const errors: string[] = [];
  const n = mesh.positions.length;

  mesh.positions.forEach((p, i) => {
    if (!p || p.length !== 3 || !p.every(Number.isFinite)) errors.push(`vertex ${i}: not a finite 3D position`);
  });

  const used = new Uint8Array(n);
  mesh.faces.forEach((face, f) => {
    if (face.length < 3) errors.push(`face ${f}: ${face.length} corners`);
    const seen = new Set<number>();
    for (const v of face) {
      if (!Number.isInteger(v) || v < 0 || v >= n) {
        errors.push(`face ${f}: vertex index ${v} out of range`);
        continue;
      }
      if (seen.has(v)) errors.push(`face ${f}: vertex ${v} repeated`);
      seen.add(v);
      used[v] = 1;
    }
  });

  if (mesh.faceUVs) {
    if (mesh.faceUVs.length !== mesh.faces.length) {
      errors.push(`faceUVs: ${mesh.faceUVs.length} entries for ${mesh.faces.length} faces`);
    } else {
      mesh.faceUVs.forEach((uvs, f) => {
        if (uvs.length !== mesh.faces[f].length) errors.push(`face ${f}: ${uvs.length} UVs for ${mesh.faces[f].length} corners`);
      });
    }
  }
  if (mesh.faceMaterials && mesh.faceMaterials.length !== mesh.faces.length) {
    errors.push(`faceMaterials: ${mesh.faceMaterials.length} entries for ${mesh.faces.length} faces`);
  }
  if (mesh.faceShading && mesh.faceShading.length > 0 && mesh.faceShading.length !== mesh.faces.length) {
    errors.push(`faceShading: ${mesh.faceShading.length} entries for ${mesh.faces.length} faces`);
  }

  let orphanVertices = 0;
  for (let i = 0; i < n; i++) if (!used[i]) orphanVertices++;

  if (errors.length > 0) {
    return { errors, boundaryEdges: 0, nonManifoldEdges: 0, inconsistentEdges: 0, orphanVertices };
  }

  const topology = buildTopology(mesh);
  let boundaryEdges = 0;
  for (let e = 0; e < topology.edges.length; e++) if (topology.isBoundaryEdge(e)) boundaryEdges++;

  return {
    errors,
    boundaryEdges,
    nonManifoldEdges: topology.nonManifoldEdgeCount,
    inconsistentEdges: topology.inconsistentEdgeCount,
    orphanVertices,
  };
}
