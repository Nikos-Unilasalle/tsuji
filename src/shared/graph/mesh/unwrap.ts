import * as THREE from "three";
import { QuadMesh, computeFaceNormal } from "../quadMesh";
import { buildTopology } from "./topology";
import { edgeKey } from "./attributes";
import { triangulateFace } from "./triangulate";
import type { UV } from "./uv";
import { packIslands } from "./pack";

export interface UnwrapOptions {
  /** Faces bending further than this from their island's average normal start a new island. */
  angleLimitDeg?: number;
  /** Gap between islands, as a fraction of the final layout. */
  margin?: number;
}

/**
 * Smart UV unwrap (in the spirit of Blender's Smart UV Project):
 *
 * 1. Islands: faces flood-filled across shared edges, stopping at seams,
 *    open borders, and any face whose normal strays more than `angleLimitDeg`
 *    from the island's running average normal — measured against the
 *    average, not the neighbour, so a cylinder can't wrap into one island
 *    that folds over itself.
 * 2. Each island is projected flat along its average normal, at 3D scale.
 * 3. Islands are packed (packIslands): turned to their tightest box, laid
 *    landscape, shelved, and the whole layout scaled uniformly into the 0..1
 *    square — every island keeps the same texel density, so a texture has
 *    the same scale all over the model.
 */
export function smartUnwrap(mesh: QuadMesh, options: UnwrapOptions = {}): QuadMesh {
  const marginFrac = Math.max(0, Math.min(0.2, options.margin ?? 0.02));
  const P = mesh.positions;
  const islands = angleIslands(mesh, mesh.faces.map((_, f) => f), options.angleLimitDeg ?? 66);

  // 2. Flatten each island along its normal, at 3D scale.
  const faceUVs: UV[][] = mesh.faces.map((face) => face.map(() => [0, 0] as UV));
  const packed: UV[][] = islands.map(({ faces, normal }) => {
    const n = normal.lengthSq() > 1e-18 ? normal.clone().normalize() : new THREE.Vector3(0, 0, 1);
    const helper = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(helper, n).normalize();
    const v = new THREE.Vector3().crossVectors(n, u);
    const points: UV[] = [];
    for (const f of faces) {
      faceUVs[f] = mesh.faces[f].map((vi) => {
        const p = new THREE.Vector3(...P[vi]);
        const uv: UV = [p.dot(u), p.dot(v)];
        points.push(uv);
        return uv;
      });
    }
    return points;
  });

  // 3. Turn, lay down and pack them — one scale for all (see packIslands).
  packIslands(packed, marginFrac);
  return { ...mesh, faceUVs };
}

/**
 * Step 1 of Smart UV Project, on its own: `faces` split into islands flood
 * filled across shared edges, stopping at seams, open borders, and any face
 * whose normal strays more than `angleLimitDeg` from the island's running
 * (area-weighted) average normal. Also what Unwrap cuts a closed surface with
 * no seams into, since a conformal unwrap needs an open patch.
 */
export function angleIslands(mesh: QuadMesh, faces: number[], angleLimitDeg = 66): { faces: number[]; normal: THREE.Vector3 }[] {
  const limit = Math.cos(THREE.MathUtils.degToRad(Math.max(1, Math.min(89, angleLimitDeg))));
  const topo = buildTopology(mesh);
  const P = mesh.positions;
  const seams = new Set((mesh.seamEdges ?? []).map(([a, b]) => edgeKey(a, b)));
  const inSet = new Set(faces);

  const normals = mesh.faces.map((face) => computeFaceNormal(P, face));
  const areas = mesh.faces.map((face) => {
    let area = 0;
    for (const [a, b, c] of triangulateFace(P, face)) {
      const pa = new THREE.Vector3(...P[face[a]]);
      area += new THREE.Vector3(...P[face[b]]).sub(pa).cross(new THREE.Vector3(...P[face[c]]).sub(pa)).length() / 2;
    }
    return area;
  });

  const islandOf = new Int32Array(mesh.faces.length).fill(-1);
  const islands: { faces: number[]; normal: THREE.Vector3 }[] = [];
  // Largest faces seed first: they set the direction the island projects along.
  const order = [...inSet].sort((a, b) => areas[b] - areas[a]);
  for (const seed of order) {
    if (islandOf[seed] >= 0) continue;
    const id = islands.length;
    const island = { faces: [seed], normal: normals[seed].clone().multiplyScalar(areas[seed] || 1e-9) };
    islandOf[seed] = id;
    const stack = [seed];
    while (stack.length) {
      const f = stack.pop()!;
      for (let h = topo.faceStart[f]; h < topo.faceStart[f] + topo.faceSize[f]; h++) {
        const twin = topo.heTwin[h];
        if (twin === -1) continue;
        const [a, b] = topo.edges[topo.heEdge[h]];
        if (seams.has(edgeKey(a, b))) continue;
        const g = topo.heFace[twin];
        if (islandOf[g] >= 0 || !inSet.has(g)) continue;
        if (normals[g].dot(island.normal.clone().normalize()) < limit) continue;
        islandOf[g] = id;
        island.faces.push(g);
        island.normal.addScaledVector(normals[g], areas[g] || 1e-9);
        stack.push(g);
      }
    }
    islands.push(island);
  }
  return islands;
}

