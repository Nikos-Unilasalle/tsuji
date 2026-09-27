import * as THREE from "three";
import { QuadMesh, computeFaceNormal } from "../quadMesh";
import { buildTopology } from "./topology";
import { edgeKey } from "./attributes";
import { triangulateFace } from "./triangulate";
import type { UV } from "./uv";

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
 * 2. Each island is projected flat along its average normal and turned to
 *    the angle giving the smallest bounding box.
 * 3. Islands are packed in rows, largest first, and the whole layout scaled
 *    uniformly into the 0..1 square — every island keeps the same texel
 *    density, so a texture has the same scale all over the model.
 */
export function smartUnwrap(mesh: QuadMesh, options: UnwrapOptions = {}): QuadMesh {
  const limit = Math.cos(THREE.MathUtils.degToRad(Math.max(1, Math.min(89, options.angleLimitDeg ?? 66))));
  const marginFrac = Math.max(0, Math.min(0.2, options.margin ?? 0.02));
  const topo = buildTopology(mesh);
  const P = mesh.positions;
  const seams = new Set((mesh.seamEdges ?? []).map(([a, b]) => edgeKey(a, b)));

  const normals = mesh.faces.map((face) => computeFaceNormal(P, face));
  const areas = mesh.faces.map((face) => {
    let area = 0;
    for (const [a, b, c] of triangulateFace(P, face)) {
      const pa = new THREE.Vector3(...P[face[a]]);
      area += new THREE.Vector3(...P[face[b]]).sub(pa).cross(new THREE.Vector3(...P[face[c]]).sub(pa)).length() / 2;
    }
    return area;
  });

  // 1. Islands.
  const islandOf = new Int32Array(mesh.faces.length).fill(-1);
  const islands: { faces: number[]; normal: THREE.Vector3 }[] = [];
  // Largest faces seed first: they set the direction the island projects along.
  const order = mesh.faces.map((_, f) => f).sort((a, b) => areas[b] - areas[a]);
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
        if (islandOf[g] >= 0) continue;
        if (normals[g].dot(island.normal.clone().normalize()) < limit) continue;
        islandOf[g] = id;
        island.faces.push(g);
        island.normal.addScaledVector(normals[g], areas[g] || 1e-9);
        stack.push(g);
      }
    }
    islands.push(island);
  }

  // 2. Flatten each island along its normal, at its tightest angle.
  type Placed = { uvs: Map<number, UV[]>; w: number; h: number };
  const flat: Placed[] = islands.map(({ faces, normal }) => {
    const n = normal.lengthSq() > 1e-18 ? normal.clone().normalize() : new THREE.Vector3(0, 0, 1);
    const helper = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(helper, n).normalize();
    const v = new THREE.Vector3().crossVectors(n, u);
    const pts = new Map<number, UV[]>();
    const all: UV[] = [];
    for (const f of faces) {
      const corners = mesh.faces[f].map((vi) => {
        const p = new THREE.Vector3(...P[vi]);
        const uv: UV = [p.dot(u), p.dot(v)];
        all.push(uv);
        return uv;
      });
      pts.set(f, corners);
    }
    // Tightest bounding box over rotations of 0..90° (every 2°).
    let bestAngle = 0;
    let bestArea = Infinity;
    for (let deg = 0; deg < 90; deg += 2) {
      const r = THREE.MathUtils.degToRad(deg);
      const c = Math.cos(r);
      const s = Math.sin(r);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [x, y] of all) {
        const rx = x * c - y * s;
        const ry = x * s + y * c;
        minX = Math.min(minX, rx); maxX = Math.max(maxX, rx);
        minY = Math.min(minY, ry); maxY = Math.max(maxY, ry);
      }
      const area = (maxX - minX) * (maxY - minY);
      if (area < bestArea - 1e-12) {
        bestArea = area;
        bestAngle = r;
      }
    }
    const c = Math.cos(bestAngle);
    const s = Math.sin(bestAngle);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const corners of pts.values()) {
      for (const uv of corners) {
        const rx = uv[0] * c - uv[1] * s;
        const ry = uv[0] * s + uv[1] * c;
        uv[0] = rx;
        uv[1] = ry;
        minX = Math.min(minX, rx); maxX = Math.max(maxX, rx);
        minY = Math.min(minY, ry); maxY = Math.max(maxY, ry);
      }
    }
    for (const corners of pts.values()) for (const uv of corners) { uv[0] -= minX; uv[1] -= minY; }
    return { uvs: pts, w: maxX - minX, h: maxY - minY };
  });

  // 3. Pack in rows, tallest first.
  const totalArea = flat.reduce((acc, i) => acc + Math.max(i.w, 1e-9) * Math.max(i.h, 1e-9), 0);
  const gap = Math.sqrt(totalArea) * marginFrac;
  const rowWidth = Math.max(Math.sqrt(totalArea) * 1.1, ...flat.map((i) => i.w));
  const byHeight = flat.map((_, i) => i).sort((a, b) => flat[b].h - flat[a].h);
  let x = 0;
  let y = 0;
  let rowH = 0;
  let usedW = 0;
  const offset = new Map<number, [number, number]>();
  for (const i of byHeight) {
    const { w, h } = flat[i];
    if (x > 0 && x + w > rowWidth) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    offset.set(i, [x, y]);
    x += w + gap;
    usedW = Math.max(usedW, x - gap);
    rowH = Math.max(rowH, h);
  }
  const usedH = y + rowH;
  const size = Math.max(usedW, usedH) || 1;

  const faceUVs: UV[][] = mesh.faces.map((face) => face.map(() => [0, 0] as UV));
  flat.forEach(({ uvs }, i) => {
    const [ox, oy] = offset.get(i)!;
    for (const [f, corners] of uvs) faceUVs[f] = corners.map(([cu, cv]) => [(cu + ox) / size, (cv + oy) / size]);
  });
  return { ...mesh, faceUVs };
}
