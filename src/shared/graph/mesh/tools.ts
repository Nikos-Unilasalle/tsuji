import * as THREE from "three";
import {
  QuadMesh,
  cloneQuadMesh,
  computeFaceCentroid,
  computeFaceNormal,
  extrudeFaces,
  withFaceUVs,
} from "../quadMesh";
import { buildTopology } from "./topology";
import { averageUV, boxProjectFace, lerpUV, UV, uvBounds } from "./uv";
import { mapEdgeAttributesInPlace, remapEdgeAttributes, splitEdgeAttributes } from "./attributes";

type V3 = [number, number, number];

/*
 * Modelling operations for Edit Mesh's tools. Every one takes the mesh as it
 * is and returns a new one (the input is never mutated), with per-corner UVs,
 * material slots and shading carried along, plus whatever the tool should
 * select afterwards.
 */

// ---------------------------------------------------------------------------
// Shared helpers

/**
 * UVs for arbitrary points on a face: the least-squares affine map from the
 * face's own plane to its corner UVs. Exact for any UV layout that is affine
 * across the face (box projection, a planar unwrap), and the best affine fit
 * otherwise — so a vertex created inside or on the edge of a face gets the UV
 * it visually sits at.
 */
export function faceUVMapper(positions: ReadonlyArray<V3>, face: number[], uvs: UV[]): (p: THREE.Vector3) => UV {
  const normal = computeFaceNormal(positions as V3[], face);
  const origin = new THREE.Vector3(...positions[face[0]]);
  const ax = Math.abs(normal.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(normal, ax).normalize();
  const v = new THREE.Vector3().crossVectors(normal, u);
  const coords = face.map((i) => {
    const d = new THREE.Vector3(...positions[i]).sub(origin);
    return [d.dot(u), d.dot(v)];
  });
  // Solve [s t 1] · A = [U V] in the least-squares sense (normal equations).
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const bu = [0, 0, 0];
  const bv = [0, 0, 0];
  coords.forEach(([s, t], k) => {
    const row = [s, t, 1];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) m[i][j] += row[i] * row[j];
      bu[i] += row[i] * uvs[k][0];
      bv[i] += row[i] * uvs[k][1];
    }
  });
  const inv = new THREE.Matrix3().set(m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2]);
  if (Math.abs(inv.determinant()) < 1e-12) {
    const avg = averageUV(uvs);
    return () => avg;
  }
  inv.invert();
  const cu = new THREE.Vector3(...bu).applyMatrix3(inv);
  const cv = new THREE.Vector3(...bv).applyMatrix3(inv);
  return (p) => {
    const d = p.clone().sub(origin);
    const s = d.dot(u);
    const t = d.dot(v);
    return [cu.x * s + cu.y * t + cu.z, cv.x * s + cv.y * t + cv.z];
  };
}

/** Appends a face with its per-face attributes, inheriting slot and shading from `from`. */
function pushFace(mesh: QuadMesh, face: number[], uvs: UV[], from: number): number {
  mesh.faces.push(face);
  mesh.faceUVs!.push(uvs);
  if (mesh.faceMaterials) mesh.faceMaterials.push(mesh.faceMaterials[from] ?? 0);
  if (mesh.faceShading && mesh.faceShading.length > 0) mesh.faceShading.push(mesh.faceShading[from] ?? mesh.shading ?? "auto");
  return mesh.faces.length - 1;
}

/**
 * Box-projects UVs for faces an operation created from nothing (bevel strips,
 * bridges, fills), against the whole mesh's bounds like boxProjectUVs.
 */
export function projectNewFaceUVs(mesh: QuadMesh, faces: number[]) {
  if (faces.length === 0) return;
  const bounds = uvBounds(mesh);
  for (const f of faces) mesh.faceUVs![f] = boxProjectFace(mesh, mesh.faces[f], computeFaceNormal(mesh.positions, mesh.faces[f]), bounds);
}

/**
 * Tidies a mesh after vertices were merged or faces rebuilt: collapses a
 * vertex repeated consecutively in a face, drops faces left with fewer than
 * three corners, then drops unused vertices and renumbers. `remapFace`
 * reports where each surviving face went (-1 when dropped), `remapVertex`
 * where each vertex went.
 */
export function compactMesh(mesh: QuadMesh): { mesh: QuadMesh; remapFace: Int32Array; remapVertex: Int32Array } {
  const remapFace = new Int32Array(mesh.faces.length).fill(-1);
  const faces: number[][] = [];
  const faceUVs: UV[][] = [];
  const faceMaterials: number[] = [];
  const faceShading: NonNullable<QuadMesh["faceShading"]> = [];
  const faceColors: NonNullable<QuadMesh["faceColors"]> = [];
  const hasShading = Boolean(mesh.faceShading && mesh.faceShading.length > 0);

  mesh.faces.forEach((face, f) => {
    const uvs = (mesh.faceUVs?.[f] ?? []) as UV[];
    const colors = mesh.faceColors?.[f] ?? null;
    const kept: number[] = [];
    const keptUVs: UV[] = [];
    const keptColors: [number, number, number][] = [];
    face.forEach((v, i) => {
      if (kept.length > 0 && kept[kept.length - 1] === v) return;
      kept.push(v);
      keptUVs.push(uvs[i] ?? [0, 0]);
      if (colors) keptColors.push(colors[i] ?? colors[0] ?? [1, 1, 1]);
    });
    while (kept.length > 1 && kept[0] === kept[kept.length - 1]) {
      kept.pop();
      keptUVs.pop();
      if (colors) keptColors.pop();
    }
    if (new Set(kept).size < 3) return;
    remapFace[f] = faces.length;
    faces.push(kept);
    faceUVs.push(keptUVs);
    faceMaterials.push(mesh.faceMaterials?.[f] ?? 0);
    faceColors.push(colors ? keptColors : null);
    if (hasShading) faceShading.push(mesh.faceShading![f]);
  });

  const remapVertex = new Int32Array(mesh.positions.length).fill(-1);
  const positions: V3[] = [];
  for (const face of faces) {
    for (const v of face) {
      if (remapVertex[v] === -1) {
        remapVertex[v] = -2; // used; numbered below, in original order
      }
    }
  }
  for (let v = 0; v < mesh.positions.length; v++) {
    if (remapVertex[v] === -2) {
      remapVertex[v] = positions.length;
      const p = mesh.positions[v];
      positions.push([p[0], p[1], p[2]]);
    }
  }

  const out: QuadMesh = {
    positions,
    faces: faces.map((face) => face.map((v) => remapVertex[v])),
    faceUVs: mesh.faceUVs ? faceUVs : undefined,
    shading: mesh.shading,
    faceShading: mesh.faceShading ? (hasShading ? faceShading : []) : undefined,
    faceMaterials: mesh.faceMaterials ? faceMaterials : undefined,
    faceColors: mesh.faceColors ? faceColors : undefined,
    sourceSignature: mesh.sourceSignature,
  };
  remapEdgeAttributes(mesh, out, remapVertex);
  return { mesh: out, remapFace, remapVertex };
}

function remapList(list: number[], remap: Int32Array): number[] {
  const out = new Set<number>();
  for (const i of list) if (remap[i] >= 0) out.add(remap[i]);
  return [...out].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Extrude

/**
 * Extrudes each selected face on its own — walls between neighbouring
 * selected faces too — rather than as one region (extrudeFaces).
 */
export function extrudeFacesIndividual(mesh: QuadMesh, faces: number[], distance: number): { mesh: QuadMesh; newFaces: number[] } {
  let current = cloneQuadMesh(mesh);
  const valid = [...new Set(faces)].filter((f) => f >= 0 && f < mesh.faces.length).sort((a, b) => a - b);
  for (const f of valid) current = extrudeFaces(current, [f], distance).mesh;
  return { mesh: current, newFaces: valid };
}

// ---------------------------------------------------------------------------
// Inset

/**
 * Insets the selected faces by an absolute `thickness`, measured
 * perpendicular to each border edge (mitred at corners, so the new border is
 * the same width all around), then pushes the inset part out along its
 * normal by `depth`.
 *
 * As one region (the default), only the region's outer border is inset and
 * faces inside it keep sharing their edges; `individual` insets every face on
 * its own. UVs of new vertices come from each face's UV mapping (see
 * faceUVMapper), so a textured surface stays continuous.
 */
export function insetRegion(
  mesh: QuadMesh,
  faceIndices: number[],
  thickness: number,
  depth = 0,
  individual = false,
): { mesh: QuadMesh; newFaces: number[] } {
  const selected = [...new Set(faceIndices)].filter((f) => f >= 0 && f < mesh.faces.length).sort((a, b) => a - b);
  if (selected.length === 0 || (thickness <= 0 && depth === 0)) return { mesh: cloneQuadMesh(mesh), newFaces: selected };
  if (individual) {
    let current = withFaceUVs(mesh);
    for (const f of selected) current = insetRegion(current, [f], thickness, depth, false).mesh;
    return { mesh: current, newFaces: selected };
  }

  const base = withFaceUVs(mesh);
  const next = cloneQuadMesh(base);
  const topo = buildTopology(base);
  const inRegion = new Set(selected);
  const positions = base.positions;

  // Border half-edges: in a selected face, with no selected face across.
  const border: number[] = [];
  for (const f of selected) {
    for (let h = topo.faceStart[f]; h < topo.faceStart[f] + topo.faceSize[f]; h++) {
      const twin = topo.heTwin[h];
      if (twin === -1 || !inRegion.has(topo.heFace[twin])) border.push(h);
    }
  }

  // For each border vertex, the (up to two) border edges through it and the
  // faces they belong to, to mitre the offset between them.
  const faceNormals = new Map<number, THREE.Vector3>();
  const normalOf = (f: number) => {
    let n = faceNormals.get(f);
    if (!n) faceNormals.set(f, (n = computeFaceNormal(positions, base.faces[f])));
    return n;
  };
  const inward = new Map<number, THREE.Vector3[]>();
  for (const h of border) {
    const a = topo.heOrigin[h];
    const b = topo.heOrigin[topo.heNext[h]];
    const dir = new THREE.Vector3(...positions[b]).sub(new THREE.Vector3(...positions[a])).normalize();
    // Interior of a counter-clockwise face is to the left: normal × edge.
    const left = new THREE.Vector3().crossVectors(normalOf(topo.heFace[h]), dir).normalize();
    for (const v of [a, b]) {
      const list = inward.get(v) ?? [];
      list.push(left);
      inward.set(v, list);
    }
  }

  // New inner vertex for every border vertex.
  const innerOf = new Map<number, number>();
  for (const [v, dirs] of inward) {
    const sum = dirs.reduce((acc, d) => acc.add(d), new THREE.Vector3());
    if (sum.lengthSq() < 1e-12) sum.copy(dirs[0]);
    sum.normalize();
    // Mitre: step far enough that each adjacent edge ends up `thickness` away.
    const cos = Math.max(0.2, Math.min(...dirs.map((d) => d.dot(sum))));
    const offset = sum.multiplyScalar(thickness / cos);
    const p = positions[v];
    innerOf.set(v, next.positions.length);
    next.positions.push([p[0] + offset.x, p[1] + offset.y, p[2] + offset.z]);
  }

  // The inset part (selected faces, with border vertices swapped for inner
  // ones) keeps its UV layout: each face maps its new corners through its own
  // original UV mapping.
  const mappers = new Map<number, (p: THREE.Vector3) => UV>();
  const mapperOf = (f: number) => {
    let m = mappers.get(f);
    if (!m) mappers.set(f, (m = faceUVMapper(positions, base.faces[f], base.faceUVs![f] as UV[])));
    return m;
  };
  const innerUV = (f: number, v: number) => mapperOf(f)(new THREE.Vector3(...next.positions[innerOf.get(v)!]));
  for (const f of selected) {
    const face = base.faces[f];
    next.faces[f] = face.map((v) => innerOf.get(v) ?? v);
    next.faceUVs![f] = face.map((v, i) => (innerOf.has(v) ? innerUV(f, v) : (base.faceUVs![f][i] as UV)));
  }

  // A quad on every border edge, between the original edge and its inner copy.
  for (const h of border) {
    const f = topo.heFace[h];
    const a = topo.heOrigin[h];
    const b = topo.heOrigin[topo.heNext[h]];
    const ia = innerOf.get(a)!;
    const ib = innerOf.get(b)!;
    const corner = h - topo.faceStart[f];
    const uvs = base.faceUVs![f] as UV[];
    pushFace(next, [a, b, ib, ia], [uvs[corner], uvs[(corner + 1) % uvs.length], innerUV(f, b), innerUV(f, a)], f);
  }

  // Depth: the inset part moves along its vertices' averaged normal.
  if (depth !== 0) {
    const moved = new Map<number, THREE.Vector3>();
    for (const f of selected) {
      for (const v of next.faces[f]) {
        const sum = moved.get(v) ?? new THREE.Vector3();
        moved.set(v, sum.add(normalOf(f)));
      }
    }
    for (const [v, n] of moved) {
      n.normalize().multiplyScalar(depth);
      const p = next.positions[v];
      next.positions[v] = [p[0] + n.x, p[1] + n.y, p[2] + n.z];
    }
  }

  return { mesh: next, newFaces: selected };
}

// ---------------------------------------------------------------------------
// Merge

/**
 * Merges the vertices into one, at their centre (or where the first / last
 * of them is). Faces that collapse below three corners are removed.
 */
export function mergeVertices(
  mesh: QuadMesh,
  vertices: number[],
  at: "center" | "first" | "last" = "center",
): { mesh: QuadMesh; vertex: number | null } {
  const valid = vertices.filter((v) => v >= 0 && v < mesh.positions.length);
  if (valid.length < 2) return { mesh: cloneQuadMesh(mesh), vertex: valid[0] ?? null };
  const keep = at === "last" ? valid[valid.length - 1] : valid[0];
  const next = withFaceUVs(cloneQuadMesh(mesh));
  if (at === "center") {
    const c = new THREE.Vector3();
    for (const v of valid) c.add(new THREE.Vector3(...mesh.positions[v]));
    c.divideScalar(valid.length);
    next.positions[keep] = [c.x, c.y, c.z];
  }
  const merged = new Set(valid);
  next.faces = next.faces.map((face) => face.map((v) => (merged.has(v) ? keep : v)));
  mapEdgeAttributesInPlace(next, (v) => (merged.has(v) ? keep : v));
  const { mesh: out, remapVertex } = compactMesh(next);
  return { mesh: out, vertex: remapVertex[keep] >= 0 ? remapVertex[keep] : null };
}

/**
 * Welds vertices closer than `distance` to each other (Blender's Merge by
 * Distance), restricted to `vertices` when given. Returns how many went.
 */
export function mergeByDistance(
  mesh: QuadMesh,
  distance: number,
  vertices?: number[],
): { mesh: QuadMesh; removed: number; remapVertex: Int32Array } {
  const candidates = vertices ?? mesh.positions.map((_, i) => i);
  const cell = Math.max(distance, 1e-9);
  const grid = new Map<string, number[]>();
  const target = new Int32Array(mesh.positions.length).map((_, i) => i);
  let removed = 0;
  const keyOf = (x: number, y: number, z: number) => `${x},${y},${z}`;
  for (const v of candidates) {
    const p = mesh.positions[v];
    if (!p) continue;
    const gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell), gz = Math.floor(p[2] / cell);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++) {
      for (let dy = -1; dy <= 1 && found < 0; dy++) {
        for (let dz = -1; dz <= 1 && found < 0; dz++) {
          for (const u of grid.get(keyOf(gx + dx, gy + dy, gz + dz)) ?? []) {
            const q = mesh.positions[u];
            if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= distance) {
              found = u;
              break;
            }
          }
        }
      }
    }
    if (found >= 0) {
      target[v] = found;
      removed++;
    } else {
      const key = keyOf(gx, gy, gz);
      const list = grid.get(key) ?? [];
      list.push(v);
      grid.set(key, list);
    }
  }
  if (removed === 0) return { mesh: cloneQuadMesh(mesh), removed: 0, remapVertex: target.map((_, i) => i) };
  const next = withFaceUVs(cloneQuadMesh(mesh));
  next.faces = next.faces.map((face) => face.map((v) => target[v]));
  mapEdgeAttributesInPlace(next, (v) => target[v]);
  const { mesh: out, remapVertex } = compactMesh(next);
  const finalMap = new Int32Array(mesh.positions.length);
  for (let v = 0; v < mesh.positions.length; v++) finalMap[v] = remapVertex[target[v]];
  return { mesh: out, removed, remapVertex: finalMap };
}

// ---------------------------------------------------------------------------
// Dissolve

/**
 * Replaces each connected region of faces by a single n-gon along its
 * border. A region whose border isn't one simple loop (it has a hole, or
 * touches itself) is left alone. Vertices left unused are removed.
 */
export function dissolveFaceRegions(mesh: QuadMesh, regions: number[][]): { mesh: QuadMesh; newFaces: number[] } {
  const base = withFaceUVs(mesh);
  const topo = buildTopology(base);
  const next = cloneQuadMesh(base);
  const removed = new Set<number>();
  const created: number[] = [];

  for (const region of regions) {
    const faces = new Set(region.filter((f) => f >= 0 && f < base.faces.length));
    if (faces.size < 2) continue;
    // Border half-edges keyed by origin; a simple loop has one per vertex.
    const byOrigin = new Map<number, number>();
    let simple = true;
    for (const f of faces) {
      for (let h = topo.faceStart[f]; h < topo.faceStart[f] + topo.faceSize[f]; h++) {
        const twin = topo.heTwin[h];
        if (twin !== -1 && faces.has(topo.heFace[twin])) continue;
        const o = topo.heOrigin[h];
        if (byOrigin.has(o)) simple = false;
        byOrigin.set(o, h);
      }
    }
    if (!simple || byOrigin.size < 3) continue;
    const start = byOrigin.values().next().value as number;
    const loop: number[] = [];
    const uvs: UV[] = [];
    let h = start;
    for (let guard = 0; guard <= byOrigin.size; guard++) {
      loop.push(topo.heOrigin[h]);
      const f = topo.heFace[h];
      uvs.push(base.faceUVs![f][h - topo.faceStart[f]] as UV);
      const nextOrigin = topo.heOrigin[topo.heNext[h]];
      const nh = byOrigin.get(nextOrigin);
      if (nh === undefined) {
        simple = false;
        break;
      }
      if (nh === start) break;
      h = nh;
    }
    if (!simple || loop.length !== byOrigin.size) continue;
    const first = Math.min(...faces);
    for (const f of faces) removed.add(f);
    created.push(pushFace(next, loop, uvs, first));
  }

  if (removed.size === 0) return { mesh: cloneQuadMesh(mesh), newFaces: [] };
  for (const f of removed) next.faces[f] = [];
  const { mesh: out, remapFace } = compactMesh(next);
  return { mesh: out, newFaces: remapList(created, remapFace) };
}

/** Connected groups of `faces`, joined only across the given edges (all shared edges when omitted). */
function faceGroups(mesh: QuadMesh, faces: Set<number>, across?: Set<string>): number[][] {
  const topo = buildTopology(mesh);
  const seen = new Set<number>();
  const groups: number[][] = [];
  for (const start of faces) {
    if (seen.has(start)) continue;
    const group: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const f = stack.pop()!;
      group.push(f);
      for (let h = topo.faceStart[f]; h < topo.faceStart[f] + topo.faceSize[f]; h++) {
        const twin = topo.heTwin[h];
        if (twin === -1) continue;
        const g = topo.heFace[twin];
        if (seen.has(g) || !faces.has(g)) continue;
        if (across) {
          const [a, b] = topo.edges[topo.heEdge[h]];
          if (!across.has(`${a}_${b}`)) continue;
        }
        seen.add(g);
        stack.push(g);
      }
    }
    groups.push(group);
  }
  return groups;
}

/** Dissolves selected faces: each connected patch becomes one n-gon. */
export function dissolveFaces(mesh: QuadMesh, faces: number[]) {
  return dissolveFaceRegions(mesh, faceGroups(mesh, new Set(faces)));
}

/** Dissolves selected edges: the two faces on each side become one. */
export function dissolveEdges(mesh: QuadMesh, edges: [number, number][]) {
  const topo = buildTopology(mesh);
  const keys = new Set<string>();
  const faces = new Set<number>();
  for (const [a, b] of edges) {
    const id = topo.findEdge(a, b);
    if (id < 0) continue;
    const adjacent = topo.edgeFaces(a, b);
    if (adjacent.length !== 2) continue;
    const [u, v] = topo.edges[id];
    keys.add(`${u}_${v}`);
    for (const f of adjacent) faces.add(f);
  }
  return dissolveFaceRegions(mesh, faceGroups(mesh, faces, keys));
}

/**
 * Dissolves selected vertices: the faces around an interior vertex become
 * one n-gon without it; a vertex in the middle of a straight run of two
 * edges is simply dropped from its faces.
 */
export function dissolveVertices(mesh: QuadMesh, vertices: number[]): { mesh: QuadMesh; newFaces: number[] } {
  const topo = buildTopology(mesh);
  const valence = new Int32Array(topo.vertexCount);
  for (const [a, b] of topo.edges) {
    valence[a]++;
    valence[b]++;
  }
  const regions: number[][] = [];
  const dropped = new Set<number>();
  for (const v of vertices) {
    if (v < 0 || v >= topo.vertexCount) continue;
    if (valence[v] === 2) dropped.add(v);
    else if (valence[v] > 2) regions.push(topo.vertexFaces(v));
  }
  let current = mesh;
  if (dropped.size > 0) {
    const next = withFaceUVs(cloneQuadMesh(mesh));
    next.faces.forEach((face, f) => {
      const keep = face.map((v, i) => [v, i] as const).filter(([v]) => !dropped.has(v));
      if (keep.length === face.length || keep.length < 3) return;
      next.faces[f] = keep.map(([v]) => v);
      next.faceUVs![f] = keep.map(([, i]) => next.faceUVs![f][i]);
    });
    current = compactMesh(next).mesh;
    // Indices shift after compaction: dissolve the rest on fresh topology.
    const remaining = vertices.filter((v) => !dropped.has(v));
    if (remaining.length === 0) return { mesh: current, newFaces: [] };
    const remap = compactMesh(next).remapVertex;
    return dissolveVertices(current, remaining.map((v) => remap[v]).filter((v) => v >= 0));
  }
  // Overlapping fans (neighbouring selected vertices) merge into one region.
  const merged = new Set<number>();
  for (const r of regions) for (const f of r) merged.add(f);
  const groups = faceGroups(current, merged);
  return dissolveFaceRegions(current, groups);
}

// ---------------------------------------------------------------------------
// Fill

/**
 * Makes a face from the selected vertices (Blender's F).
 *
 * The corner order comes from the mesh's open border when every vertex is on
 * one border loop (filling a hole, or bridging a gap along it); otherwise
 * from their angle around their centre in their best-fit plane. The winding
 * is then chosen to agree with any existing face on a shared edge, so the new
 * face's normal points the same way as its neighbours'.
 */
export function fillVertices(mesh: QuadMesh, vertices: number[]): { mesh: QuadMesh; newFaces: number[] } {
  const verts = [...new Set(vertices)].filter((v) => v >= 0 && v < mesh.positions.length);
  if (verts.length < 3) return { mesh: cloneQuadMesh(mesh), newFaces: [] };
  const topo = buildTopology(mesh);
  const set = new Set(verts);

  let order: number[] | null = null;
  // Along the border: boundary half-edges have no twin; walk them.
  const nextOnBorder = new Map<number, number>();
  for (let h = 0; h < topo.heOrigin.length; h++) {
    if (topo.heTwin[h] === -1) nextOnBorder.set(topo.heOrigin[topo.heNext[h]], topo.heOrigin[h]); // reversed: the hole's own winding
  }
  if (verts.every((v) => nextOnBorder.has(v))) {
    const walk: number[] = [];
    let v = verts[0];
    for (let guard = 0; guard < topo.vertexCount; guard++) {
      if (set.has(v)) walk.push(v);
      v = nextOnBorder.get(v)!;
      if (v === verts[0] || v === undefined) break;
    }
    if (walk.length === verts.length) order = walk;
  }

  if (!order) {
    const pts = verts.map((v) => new THREE.Vector3(...mesh.positions[v]));
    const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length);
    // Newell normal of the points in any order is unreliable; use the
    // largest-area triangle through the centre as the plane.
    const n = new THREE.Vector3();
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const cand = new THREE.Vector3().subVectors(pts[i], c).cross(new THREE.Vector3().subVectors(pts[j], c));
        if (cand.lengthSq() > n.lengthSq()) n.copy(cand);
      }
    }
    if (n.lengthSq() < 1e-18) return { mesh: cloneQuadMesh(mesh), newFaces: [] };
    n.normalize();
    const u = new THREE.Vector3().subVectors(pts[0], c).normalize();
    const w = new THREE.Vector3().crossVectors(n, u);
    order = verts
      .map((v, i) => ({ v, a: Math.atan2(new THREE.Vector3().subVectors(pts[i], c).dot(w), new THREE.Vector3().subVectors(pts[i], c).dot(u)) }))
      .sort((x, y) => x.a - y.a)
      .map((x) => x.v);
  }

  // Wind against existing faces: if some face already runs a → b, we must run b → a.
  let agree = 0;
  for (let i = 0; i < order.length; i++) {
    const a = order[i];
    const b = order[(i + 1) % order.length];
    if (topo.findHalfedge(a, b) >= 0) agree--;
    if (topo.findHalfedge(b, a) >= 0) agree++;
  }
  if (agree < 0) order.reverse();
  // Already a face with exactly these corners? Nothing to make.
  const key = [...order].sort((a, b) => a - b).join(",");
  if (mesh.faces.some((f) => f.length === order!.length && [...f].sort((a, b) => a - b).join(",") === key)) {
    return { mesh: cloneQuadMesh(mesh), newFaces: [] };
  }

  const next = withFaceUVs(cloneQuadMesh(mesh));
  const bounds = new THREE.Box3().setFromPoints(next.positions.map((p) => new THREE.Vector3(...p)));
  const size = bounds.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z) || 1;
  const n = computeFaceNormal(next.positions, order);
  const uvs: UV[] = order.map((v) => {
    const p = next.positions[v];
    // A simple planar projection along the new face's dominant axis.
    if (Math.abs(n.x) >= Math.abs(n.y) && Math.abs(n.x) >= Math.abs(n.z)) return [(p[2] - bounds.min.z) / span, (p[1] - bounds.min.y) / span];
    if (Math.abs(n.y) >= Math.abs(n.z)) return [(p[0] - bounds.min.x) / span, (p[2] - bounds.min.z) / span];
    return [(p[0] - bounds.min.x) / span, (p[1] - bounds.min.y) / span];
  });
  const neighbour = topo.vertexFaces(order[0])[0] ?? 0;
  const f = pushFace(next, order, uvs, neighbour);
  return { mesh: next, newFaces: [f] };
}

// ---------------------------------------------------------------------------
// Flip, duplicate, subdivide

/** Reverses the winding of the selected faces, flipping their normals. */
export function flipFaces(mesh: QuadMesh, faces: number[]): QuadMesh {
  const next = withFaceUVs(cloneQuadMesh(mesh));
  for (const f of new Set(faces)) {
    if (!next.faces[f]) continue;
    next.faces[f] = [...next.faces[f]].reverse();
    next.faceUVs![f] = [...next.faceUVs![f]].reverse();
  }
  return next;
}

/**
 * Copies the selected faces as new, disconnected geometry (Shift+D). The
 * copies come back selected, sitting exactly on the originals.
 */
export function duplicateFaces(mesh: QuadMesh, faces: number[]): { mesh: QuadMesh; newFaces: number[] } {
  const next = withFaceUVs(cloneQuadMesh(mesh));
  const copyOf = new Map<number, number>();
  const newFaces: number[] = [];
  for (const f of [...new Set(faces)].sort((a, b) => a - b)) {
    const face = mesh.faces[f];
    if (!face) continue;
    const copied = face.map((v) => {
      let c = copyOf.get(v);
      if (c === undefined) {
        c = next.positions.length;
        const p = mesh.positions[v];
        next.positions.push([p[0], p[1], p[2]]);
        copyOf.set(v, c);
      }
      return c;
    });
    newFaces.push(pushFace(next, copied, next.faceUVs![f].map((uv) => [uv[0], uv[1]] as UV), f));
  }
  return { mesh: next, newFaces };
}

/**
 * Subdivides the selected faces once: every edge gets a midpoint and each
 * face splits into quads around its centre (a quad into four, a triangle
 * into three, an n-gon into n). Unselected neighbours sharing a split edge
 * take the midpoint as an extra corner, so the surface stays closed.
 */
export function subdivideFaces(mesh: QuadMesh, faces: number[]): { mesh: QuadMesh; newFaces: number[] } {
  const selected = [...new Set(faces)].filter((f) => f >= 0 && f < mesh.faces.length).sort((a, b) => a - b);
  if (selected.length === 0) return { mesh: cloneQuadMesh(mesh), newFaces: [] };
  const base = withFaceUVs(mesh);
  const next = cloneQuadMesh(base);
  const midpoints = new Map<string, number>();
  const midpoint = (a: number, b: number) => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    let m = midpoints.get(key);
    if (m === undefined) {
      const pa = base.positions[a];
      const pb = base.positions[b];
      m = next.positions.length;
      next.positions.push([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2]);
      midpoints.set(key, m);
    }
    return m;
  };

  const newFaces: number[] = [];
  const inSel = new Set(selected);
  for (const f of selected) {
    const face = base.faces[f];
    const uvs = base.faceUVs![f] as UV[];
    const n = face.length;
    const c = computeFaceCentroid(base.positions, face);
    const center = next.positions.length;
    next.positions.push([c.x, c.y, c.z]);
    const cUV = averageUV(uvs);
    const mids = face.map((v, i) => midpoint(v, face[(i + 1) % n]));
    const midUVs = uvs.map((uv, i) => lerpUV(uv, uvs[(i + 1) % n], 0.5));
    // Quad i: corner i, its outgoing midpoint, centre, incoming midpoint.
    for (let i = 0; i < n; i++) {
      const prev = (i + n - 1) % n;
      const quad = [face[i], mids[i], center, mids[prev]];
      const quadUVs: UV[] = [uvs[i], midUVs[i], cUV, midUVs[prev]];
      if (i === 0) {
        next.faces[f] = quad;
        next.faceUVs![f] = quadUVs;
        newFaces.push(f);
      } else {
        newFaces.push(pushFace(next, quad, quadUVs, f));
      }
    }
  }

  for (const [key, m] of midpoints) {
    const [a, b] = key.split("_").map(Number);
    splitEdgeAttributes(next, a, b, [m]);
  }

  // Neighbours: insert each midpoint on their shared edge.
  base.faces.forEach((face, f) => {
    if (inSel.has(f)) return;
    const uvs = base.faceUVs![f] as UV[];
    const out: number[] = [];
    const outUVs: UV[] = [];
    face.forEach((v, i) => {
      const w = face[(i + 1) % face.length];
      out.push(v);
      outUVs.push(uvs[i]);
      const m = midpoints.get(v < w ? `${v}_${w}` : `${w}_${v}`);
      if (m !== undefined) {
        out.push(m);
        outUVs.push(lerpUV(uvs[i], uvs[(i + 1) % face.length], 0.5));
      }
    });
    if (out.length !== face.length) {
      next.faces[f] = out;
      next.faceUVs![f] = outUVs;
    }
  });

  return { mesh: next, newFaces };
}

// ---------------------------------------------------------------------------
// Mirror

/**
 * Each vertex's mirror image across the local X = 0 plane, when the mesh has
 * one within `tolerance` (-1 otherwise; a vertex on the plane is its own).
 */
export function mirrorXMap(mesh: QuadMesh, tolerance = 1e-4): Int32Array {
  const map = new Int32Array(mesh.positions.length).fill(-1);
  const cell = Math.max(tolerance * 4, 1e-9);
  const grid = new Map<string, number[]>();
  const key = (p: readonly number[]) => `${Math.round(p[0] / cell)},${Math.round(p[1] / cell)},${Math.round(p[2] / cell)}`;
  mesh.positions.forEach((p, i) => {
    const k = key(p);
    const list = grid.get(k) ?? [];
    list.push(i);
    grid.set(k, list);
  });
  mesh.positions.forEach((p, i) => {
    const target: V3 = [-p[0], p[1], p[2]];
    const tk = [Math.round(target[0] / cell), Math.round(target[1] / cell), Math.round(target[2] / cell)];
    let best = -1;
    let bestDist = tolerance;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const j of grid.get(`${tk[0] + dx},${tk[1] + dy},${tk[2] + dz}`) ?? []) {
            const q = mesh.positions[j];
            const d = Math.hypot(q[0] - target[0], q[1] - target[1], q[2] - target[2]);
            if (d <= bestDist) {
              bestDist = d;
              best = j;
            }
          }
        }
      }
    }
    map[i] = best;
  });
  return map;
}

/**
 * Applies to `moved` (vertex → new position, from a transform of the
 * selection) the mirror of every move onto each vertex's counterpart across
 * X = 0 — what Blender's X-mirror option does. A vertex on the plane stays on
 * it. Counterparts that were themselves moved keep their own move.
 */
export function mirrorMovesX(
  mesh: QuadMesh,
  moved: Map<number, V3>,
  mirror: Int32Array,
  planeTolerance = 1e-4,
): Map<number, V3> {
  const out = new Map(moved);
  for (const [v, p] of moved) {
    const orig = mesh.positions[v];
    if (Math.abs(orig[0]) <= planeTolerance) {
      out.set(v, [0, p[1], p[2]]);
      continue;
    }
    const m = mirror[v];
    if (m < 0 || m === v || moved.has(m)) continue;
    out.set(m, [-p[0], p[1], p[2]]);
  }
  return out;
}
