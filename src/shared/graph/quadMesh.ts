import * as THREE from "three";
import { triangulateFace } from "./mesh/triangulate";
import { averageUV, boxProjectFace, lerpUV, UV, uvBounds } from "./mesh/uv";
import { quadRing } from "./mesh/loops";
import { importBufferGeometry } from "./mesh/importGeometry";

export type QuadMeshShading = "auto" | "smooth" | "flat";

export interface QuadMesh {
  positions: [number, number, number][];
  faces: number[][]; // indices of vertices (4 for quads, 3 for triangles)
  uvs?: [number, number][];
  faceUVs?: [number, number][][];
  shading?: QuadMeshShading;
  faceShading?: QuadMeshShading[];
  /**
   * Material slot per face (a BufferGeometry group's materialIndex), carried
   * through every operation so a multi-material import keeps its materials.
   * Absent means every face uses slot 0.
   */
  faceMaterials?: number[];
  /**
   * geometrySignature() of the input this mesh was frozen from. Lets Edit
   * Mesh tell the operator the input has moved on since — otherwise the
   * frozen copy silently ignores every upstream change.
   */
  sourceSignature?: string;
}

export function cloneQuadMesh(mesh: QuadMesh): QuadMesh {
  return {
    positions: mesh.positions.map((p) => [p[0], p[1], p[2]]),
    faces: mesh.faces.map((f) => [...f]),
    uvs: mesh.uvs ? mesh.uvs.map((uv) => [uv[0], uv[1]]) : undefined,
    faceUVs: mesh.faceUVs ? mesh.faceUVs.map((fuv) => fuv.map((uv) => [uv[0], uv[1]])) : undefined,
    shading: mesh.shading,
    faceShading: mesh.faceShading ? [...mesh.faceShading] : undefined,
    faceMaterials: mesh.faceMaterials ? [...mesh.faceMaterials] : undefined,
    sourceSignature: mesh.sourceSignature,
  };
}

/**
 * A content fingerprint of the edited mesh, because identity cannot be used
 * here and equality would be a full deep compare every frame.
 *
 * The cache used to hold `cloneQuadMesh(quadMesh)` and then test
 * `state.lastQuadMesh === quadMesh` — a clone is never identical to what it
 * was cloned from, so the comparison was false every single time and the
 * geometry was rebuilt (and re-uploaded to the GPU) on every frame, 30 out of
 * 30 at rest. It cost nothing visible and broke nothing, which is exactly why
 * it lasted; it also made every rigid body downstream reset itself, back when
 * physics keyed on geometry identity.
 *
 * Positions are quantised to 1e-5 rather than hashed as floats: the viewport
 * writes them back from a drag, and a bit of float noise below what a pixel
 * can express should not force a rebuild. Face UVs are in the hash because
 * Recalculate UVs changes nothing else, and leaving them out made that button
 * do nothing.
 */
export function quadMeshSignature(mesh: QuadMesh): string {
  let hash = 0x811c9dc5;
  const mix = (n: number) => {
    hash = Math.imul(hash ^ (n | 0), 16777619) >>> 0;
  };

  for (const [x, y, z] of mesh.positions) {
    mix(Math.round(x * 1e5));
    mix(Math.round(y * 1e5));
    mix(Math.round(z * 1e5));
  }
  for (const face of mesh.faces) {
    mix(face.length);
    for (const index of face) mix(index);
  }
  if (mesh.faceUVs) {
    for (const face of mesh.faceUVs) {
      for (const [u, v] of face) {
        mix(Math.round(u * 1e5));
        mix(Math.round(v * 1e5));
      }
    }
  }
  if (mesh.faceMaterials) for (const m of mesh.faceMaterials) mix(m);
  return `${mesh.positions.length}:${mesh.faces.length}:${hash.toString(36)}`;
}

/**
 * A content fingerprint of a BufferGeometry's positions and index. Positions
 * are quantised to 1e-5 so float noise below what a pixel can show doesn't
 * register as a change.
 */
export function geometrySignature(geometry: THREE.BufferGeometry): string {
  let hash = 0x811c9dc5;
  const mix = (n: number) => {
    hash = Math.imul(hash ^ (n | 0), 16777619) >>> 0;
  };
  const pos = geometry.attributes.position;
  const count = pos ? pos.count : 0;
  for (let i = 0; i < count; i++) {
    mix(Math.round(pos.getX(i) * 1e5));
    mix(Math.round(pos.getY(i) * 1e5));
    mix(Math.round(pos.getZ(i) * 1e5));
  }
  const index = geometry.index;
  if (index) for (let i = 0; i < index.count; i++) mix(index.getX(i));
  return `${count}:${index ? index.count : 0}:${hash.toString(36)}`;
}

/**
 * Computes face normal from 3D positions.
 */
export function computeFaceNormal(positions: [number, number, number][], face: number[]): THREE.Vector3 {
  if (face.length < 3) return new THREE.Vector3(0, 1, 0);
  const normal = new THREE.Vector3();
  // Newell's method for arbitrary polygons
  for (let i = 0; i < face.length; i++) {
    const curr = positions[face[i]];
    const next = positions[face[(i + 1) % face.length]];
    if (!curr || !next) continue;
    normal.x += (curr[1] - next[1]) * (curr[2] + next[2]);
    normal.y += (curr[2] - next[2]) * (curr[0] + next[0]);
    normal.z += (curr[0] - next[0]) * (curr[1] + next[1]);
  }
  const len = normal.length();
  return len > 1e-6 ? normal.normalize() : new THREE.Vector3(0, 1, 0);
}

/**
 * Computes the 3D centroid of a face.
 */
export function computeFaceCentroid(positions: [number, number, number][], face: number[]): THREE.Vector3 {
  const centroid = new THREE.Vector3();
  if (face.length === 0) return centroid;
  for (const idx of face) {
    const p = positions[idx];
    if (p) centroid.add(new THREE.Vector3(p[0], p[1], p[2]));
  }
  return centroid.divideScalar(face.length);
}

/**
 * Generates coherent box/cube projection UVs for a QuadMesh.
 * Projects each face onto its dominant normal plane (XY, XZ, or YZ).
 */
export function boxProjectUVs(mesh: QuadMesh): QuadMesh {
  const next = cloneQuadMesh(mesh);
  const bounds = uvBounds(next);
  next.faceUVs = next.faces.map((face) =>
    face.length === 0 ? [] : boxProjectFace(next, face, computeFaceNormal(next.positions, face), bounds),
  );
  return next;
}

/**
 * Creates a pristine unit box represented as 6 quads and 8 unique vertices.
 * No internal diagonal triangulation edges.
 */
export function createQuadBox(width = 1, height = 1, depth = 1): QuadMesh {
  const hw = width / 2;
  const hh = height / 2;
  const hd = depth / 2;

  const positions: [number, number, number][] = [
    [-hw, -hh, -hd], // 0
    [hw, -hh, -hd],  // 1
    [hw, hh, -hd],   // 2
    [-hw, hh, -hd],  // 3
    [-hw, -hh, hd],  // 4
    [hw, -hh, hd],   // 5
    [hw, hh, hd],    // 6
    [-hw, hh, hd],   // 7
  ];

  // Outward CCW face winding
  const faces: number[][] = [
    [4, 5, 6, 7], // Front (+Z)
    [1, 0, 3, 2], // Back (-Z)
    [7, 6, 2, 3], // Top (+Y)
    [0, 1, 5, 4], // Bottom (-Y)
    [5, 1, 2, 6], // Right (+X)
    [0, 4, 7, 3], // Left (-X)
  ];

  return boxProjectUVs({
    positions,
    faces,
    shading: "auto",
  });
}

/**
 * Creates a plane represented as a grid of quads.
 */
export function createQuadPlane(width = 1, height = 1, segX = 1, segY = 1): QuadMesh {
  const sx = Math.max(1, Math.round(segX));
  const sy = Math.max(1, Math.round(segY));
  const hw = width / 2;
  const hh = height / 2;

  const positions: [number, number, number][] = [];
  const uvs: [number, number][] = [];

  for (let iy = 0; iy <= sy; iy++) {
    const y = -hh + (iy / sy) * height;
    const v = iy / sy;
    for (let ix = 0; ix <= sx; ix++) {
      const x = -hw + (ix / sx) * width;
      const u = ix / sx;
      positions.push([x, y, 0]);
      uvs.push([u, v]);
    }
  }

  const faces: number[][] = [];
  for (let iy = 0; iy < sy; iy++) {
    for (let ix = 0; ix < sx; ix++) {
      const a = iy * (sx + 1) + ix;
      const b = a + 1;
      const c = (iy + 1) * (sx + 1) + ix + 1;
      const d = (iy + 1) * (sx + 1) + ix;
      faces.push([a, b, c, d]);
    }
  }

  return { positions, faces, uvs, shading: "auto" };
}

/**
 * Returns the unique undirected edges of the quad mesh,
 * omitting any internal triangulation diagonals.
 */
export function getQuadMeshEdges(mesh: QuadMesh): [number, number][] {
  const edgeSet = new Set<string>();
  const edges: [number, number][] = [];

  for (const face of mesh.faces) {
    const len = face.length;
    for (let i = 0; i < len; i++) {
      const u = face[i];
      const v = face[(i + 1) % len];
      const a = Math.min(u, v);
      const b = Math.max(u, v);
      const key = `${a}_${b}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push([a, b]);
      }
    }
  }

  return edges;
}

function materialList(byMaterial: Map<number, number[]>, material: number): number[] {
  let list = byMaterial.get(material);
  if (!list) {
    list = [];
    byMaterial.set(material, list);
  }
  return list;
}

/**
 * Writes the index sorted by material slot, one BufferGeometry group per slot,
 * so a multi-material mesh renders each face with its own material. A mesh
 * with no faceMaterials gets a plain index and no groups, as before.
 */
function setGroupedIndex(geometry: THREE.BufferGeometry, byMaterial: Map<number, number[]>, grouped: boolean) {
  const slots = [...byMaterial.keys()].sort((a, b) => a - b);
  const indices: number[] = [];
  for (const slot of slots) {
    const list = byMaterial.get(slot)!;
    if (grouped) geometry.addGroup(indices.length, list.length, slot);
    for (const i of list) indices.push(i);
  }
  geometry.setIndex(indices);
}

/**
 * Converts a QuadMesh to a Three.js BufferGeometry (triangulated for GPU rendering).
 * Supports "auto" (crease angle), "smooth", and "flat" shading.
 * Attaches the original QuadMesh in `geometry.userData.quadMesh`.
 */
export function quadMeshToBufferGeometry(
  inputMesh: QuadMesh,
  forcedShading?: QuadMeshShading,
): THREE.BufferGeometry {
  const globalShading = forcedShading || inputMesh.shading || "auto";
  const hasPerFaceShading = Boolean(inputMesh.faceShading && inputMesh.faceShading.length > 0);

  // Ensure mesh has valid UVs when faceUVs are expected (auto/flat shading or faceUVs present)
  const needsAutoUVs =
    (!inputMesh.faceUVs || inputMesh.faceUVs.length !== inputMesh.faces.length) &&
    !(globalShading === "smooth" && !hasPerFaceShading && !inputMesh.faceUVs);
  const mesh = needsAutoUVs ? boxProjectUVs(inputMesh) : inputMesh;

  const numFaces = mesh.faces.length;

  const faceNormals: THREE.Vector3[] = new Array(numFaces);
  for (let f = 0; f < numFaces; f++) {
    faceNormals[f] = computeFaceNormal(mesh.positions, mesh.faces[f]);
  }

  const vertexFaces = new Map<number, number[]>();
  for (let f = 0; f < numFaces; f++) {
    for (const v of mesh.faces[f]) {
      let list = vertexFaces.get(v);
      if (!list) {
        list = [];
        vertexFaces.set(v, list);
      }
      list.push(f);
    }
  }

  const COS_CREASE = Math.cos((35 * Math.PI) / 180); // ~0.819 crease angle

  const isPureSmooth = globalShading === "smooth" && !hasPerFaceShading && !mesh.faceUVs;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];

  if (isPureSmooth) {
    for (const p of mesh.positions) {
      positions.push(p[0], p[1], p[2]);
    }
    if (mesh.uvs && mesh.uvs.length === mesh.positions.length) {
      for (const uv of mesh.uvs) {
        uvs.push(uv[0], uv[1]);
      }
    }

    const byMaterial = new Map<number, number[]>();
    mesh.faces.forEach((face, f) => {
      const list = materialList(byMaterial, mesh.faceMaterials?.[f] ?? 0);
      for (const [a, b, c] of triangulateFace(mesh.positions, face)) list.push(face[a], face[b], face[c]);
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    if (uvs.length > 0) {
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    }
    setGroupedIndex(geometry, byMaterial, Boolean(mesh.faceMaterials));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    geometry.userData.quadMesh = cloneQuadMesh(mesh);
    return geometry;
  }

  // Split-vertex geometry: respects sharp crease angles and per-face UVs
  const vertexLookup = new Map<string, number>();

  function addVertex(vIdx: number, faceIdx: number, inFaceIdx: number): number {
    const faceMode = mesh.faceShading?.[faceIdx] || globalShading;
    const fn = faceNormals[faceIdx];

    const normal = new THREE.Vector3();
    if (faceMode === "flat") {
      normal.copy(fn);
    } else if (faceMode === "smooth") {
      const neighborFaces = vertexFaces.get(vIdx) ?? [faceIdx];
      for (const nF of neighborFaces) {
        normal.add(faceNormals[nF]);
      }
      normal.normalize();
    } else {
      // "auto": accumulate adjacent faces within crease angle
      const neighborFaces = vertexFaces.get(vIdx) ?? [faceIdx];
      for (const nF of neighborFaces) {
        const nfn = faceNormals[nF];
        if (fn.dot(nfn) >= COS_CREASE) {
          normal.add(nfn);
        }
      }
      normal.normalize();
    }

    const p = mesh.positions[vIdx];
    let u = 0;
    let v = 0;
    if (mesh.faceUVs?.[faceIdx]?.[inFaceIdx]) {
      u = mesh.faceUVs[faceIdx][inFaceIdx][0];
      v = mesh.faceUVs[faceIdx][inFaceIdx][1];
    } else if (mesh.uvs?.[vIdx]) {
      u = mesh.uvs[vIdx][0];
      v = mesh.uvs[vIdx][1];
    }

    const key = `${vIdx}|${Math.round(normal.x * 100)}_${Math.round(normal.y * 100)}_${Math.round(normal.z * 100)}|${Math.round(u * 1000)}_${Math.round(v * 1000)}`;
    const existing = vertexLookup.get(key);
    if (existing !== undefined) return existing;

    const newIdx = positions.length / 3;
    positions.push(p[0], p[1], p[2]);
    normals.push(normal.x, normal.y, normal.z);
    uvs.push(u, v);
    vertexLookup.set(key, newIdx);
    return newIdx;
  }

  const byMaterial = new Map<number, number[]>();
  for (let f = 0; f < numFaces; f++) {
    const face = mesh.faces[f];
    const vertIndices: number[] = [];
    for (let i = 0; i < face.length; i++) {
      vertIndices.push(addVertex(face[i], f, i));
    }
    const list = materialList(byMaterial, mesh.faceMaterials?.[f] ?? 0);
    for (const [a, b, c] of triangulateFace(mesh.positions, face)) {
      list.push(vertIndices[a], vertIndices[b], vertIndices[c]);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  if (uvs.length > 0) {
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  }
  setGroupedIndex(geometry, byMaterial, Boolean(mesh.faceMaterials));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.quadMesh = cloneQuadMesh(mesh);
  return geometry;
}

/**
 * Converts a BufferGeometry to a QuadMesh.
 * If `userData.quadMesh` exists, uses that directly.
 * Otherwise rebuilds quads, UVs and material slots — see importBufferGeometry.
 */
export function bufferGeometryToQuadMesh(geometry: THREE.BufferGeometry): QuadMesh {
  if (geometry.userData.quadMesh) {
    return cloneQuadMesh(geometry.userData.quadMesh);
  }
  const imported = importBufferGeometry(geometry);
  if (!imported) return createQuadBox();
  return imported.faceUVs ? imported : boxProjectUVs(imported);
}

/**
 * The mesh with a per-corner UV for every face, which every operation below
 * carries through and extends: existing faceUVs as-is, per-vertex `uvs` (a
 * createQuadPlane grid) turned into per-corner ones, otherwise a box
 * projection. Returns the input itself when it already qualifies.
 */
export function withFaceUVs(mesh: QuadMesh): QuadMesh {
  if (mesh.faceUVs && mesh.faceUVs.length === mesh.faces.length &&
      mesh.faceUVs.every((uvs, f) => uvs.length === mesh.faces[f].length)) {
    return mesh;
  }
  if (mesh.uvs && mesh.uvs.length === mesh.positions.length) {
    const next = cloneQuadMesh(mesh);
    next.faceUVs = mesh.faces.map((face) => face.map((v) => [mesh.uvs![v][0], mesh.uvs![v][1]] as [number, number]));
    return next;
  }
  return boxProjectUVs(mesh);
}

/**
 * Appends a face created by an operation, with its per-face attributes: UVs
 * (given, or box-projected when omitted — `pending` collects those so they are
 * projected in one pass against the final bounds), material slot and shading
 * inherited from the face it came from.
 */
function appendFace(
  next: QuadMesh,
  face: number[],
  from: number,
  uvs: [number, number][] | null,
  pending: number[],
): number {
  const index = next.faces.length;
  next.faces.push(face);
  next.faceUVs!.push(uvs ?? []);
  if (!uvs) pending.push(index);
  if (next.faceMaterials) next.faceMaterials.push(next.faceMaterials[from] ?? 0);
  if (next.faceShading && next.faceShading.length > 0) next.faceShading.push(next.faceShading[from] ?? next.shading ?? "auto");
  return index;
}

function projectPendingUVs(next: QuadMesh, pending: number[]) {
  if (pending.length === 0) return;
  const bounds = uvBounds(next);
  for (const f of pending) {
    next.faceUVs![f] = boxProjectFace(next, next.faces[f], computeFaceNormal(next.positions, next.faces[f]), bounds);
  }
}

/** Selected face indices that exist, deduplicated, in ascending order. */
function validFaces(mesh: QuadMesh, indices: number[]): number[] {
  return [...new Set(indices)].filter((f) => Number.isInteger(f) && f >= 0 && f < mesh.faces.length).sort((a, b) => a - b);
}

/**
 * Extrudes the selected face(s) outward along their averaged face normal.
 * Duplicates the region's vertices, moves the cap faces onto them and
 * stitches a quad wall along every edge on the region's border.
 *
 * The caps keep their UVs (same corners, moved) and every untouched face
 * keeps its own; only the new walls are box-projected. Walls inherit the
 * material and shading of the cap face they border.
 */
export function extrudeFaces(
  mesh: QuadMesh,
  selectedFaceIndices: number[],
  distance = 0.5,
): { mesh: QuadMesh; newFaces: number[] } {
  const selected = validFaces(mesh, selectedFaceIndices);
  if (selected.length === 0 || distance === 0) {
    return { mesh: cloneQuadMesh(mesh), newFaces: selected };
  }

  const base = withFaceUVs(mesh);
  const next = cloneQuadMesh(base);

  // Each region vertex moves along the average of its selected faces' normals.
  const vertexNormals = new Map<number, THREE.Vector3>();
  for (const f of selected) {
    const normal = computeFaceNormal(base.positions, base.faces[f]);
    for (const v of base.faces[f]) {
      const sum = vertexNormals.get(v) ?? new THREE.Vector3();
      vertexNormals.set(v, sum.add(normal));
    }
  }

  const oldToNew = new Map<number, number>();
  for (const [v, sum] of vertexNormals) {
    const n = sum.normalize();
    const p = base.positions[v];
    oldToNew.set(v, next.positions.length);
    next.positions.push([p[0] + n.x * distance, p[1] + n.y * distance, p[2] + n.z * distance]);
  }

  for (const f of selected) next.faces[f] = base.faces[f].map((v) => oldToNew.get(v) ?? v);

  // Border edges of the region: used by exactly one selected face. Each wall
  // runs along that face's own edge direction, so it winds outward.
  const edgeUse = new Map<string, { count: number; u: number; v: number; face: number }>();
  for (const f of selected) {
    const face = base.faces[f];
    for (let i = 0; i < face.length; i++) {
      const u = face[i];
      const v = face[(i + 1) % face.length];
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      const entry = edgeUse.get(key) ?? { count: 0, u, v, face: f };
      entry.count++;
      edgeUse.set(key, entry);
    }
  }

  const pending: number[] = [];
  for (const { count, u, v, face } of edgeUse.values()) {
    if (count !== 1) continue;
    appendFace(next, [u, v, oldToNew.get(v)!, oldToNew.get(u)!], face, null, pending);
  }
  projectPendingUVs(next, pending);

  return { mesh: next, newFaces: selected };
}

/**
 * Insets the selected face(s): each face shrinks toward its centroid into an
 * inner face, ringed by one quad per original edge. Works for triangles and
 * n-gons as well as quads.
 *
 * UVs are exact: inner corners are interpolated between each corner's UV and
 * the face's UV centroid by the same ratio as the positions, and the border
 * quads reuse the original and inner corner UVs.
 */
export function insetFaces(
  mesh: QuadMesh,
  selectedFaceIndices: number[],
  insetRatio = 0.25,
): { mesh: QuadMesh; newFaces: number[] } {
  const selected = validFaces(mesh, selectedFaceIndices);
  if (selected.length === 0 || insetRatio <= 0) {
    return { mesh: cloneQuadMesh(mesh), newFaces: selected };
  }

  const base = withFaceUVs(mesh);
  const next = cloneQuadMesh(base);
  const ratio = Math.max(0.01, Math.min(0.95, insetRatio));
  const pending: number[] = [];

  for (const f of selected) {
    const face = base.faces[f];
    const faceUVs = base.faceUVs![f] as UV[];
    const c = computeFaceCentroid(base.positions, face);
    const cUV = averageUV(faceUVs);

    const inner = face.map((v) => {
      const p = base.positions[v];
      next.positions.push([p[0] + (c.x - p[0]) * ratio, p[1] + (c.y - p[1]) * ratio, p[2] + (c.z - p[2]) * ratio]);
      return next.positions.length - 1;
    });
    const innerUVs = faceUVs.map((uv) => lerpUV(uv, cUV, ratio));

    next.faces[f] = inner;
    next.faceUVs![f] = innerUVs;

    const n = face.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      appendFace(
        next,
        [face[i], face[j], inner[j], inner[i]],
        f,
        [faceUVs[i], faceUVs[j], innerUVs[j], innerUVs[i]],
        pending,
      );
    }
  }

  return { mesh: next, newFaces: selected };
}

/** Cut ratios along an edge: `cutsOrRatio` cuts evenly spaced, or a single cut at that ratio when it's in (0, 1). */
function cutRatios(cutsOrRatio: number): number[] {
  if (cutsOrRatio > 0 && cutsOrRatio < 1) return [Math.max(0.05, Math.min(0.95, cutsOrRatio))];
  const cuts = Math.max(1, Math.min(32, Math.round(cutsOrRatio)));
  return Array.from({ length: cuts }, (_, k) => (k + 1) / (cuts + 1));
}

/**
 * Performs a loop cut across the ring of quads through `startEdge` (see
 * quadRing: both directions, stopping at boundaries and non-quads), splitting
 * each into `cuts + 1` quads — or in two at a given ratio when `cutsOrRatio`
 * is in (0, 1). The ratio is measured along the start edge and kept
 * consistent all the way around, so neighbouring quads share their new
 * vertices whatever the ratio.
 *
 * UVs are interpolated per face along the split edges; sub-faces inherit
 * material and shading.
 */
export function loopCut(
  mesh: QuadMesh,
  startEdge: [number, number],
  cutsOrRatio: number = 1,
): { mesh: QuadMesh; newEdgeIndices: [number, number][]; newVertexIndices: number[] } {
  const base = withFaceUVs(mesh);
  const next = cloneQuadMesh(base);
  const { faces: ring } = quadRing(base, startEdge[0], startEdge[1]);
  if (ring.length === 0) return { mesh: next, newEdgeIndices: [], newVertexIndices: [] };

  const ratios = cutRatios(cutsOrRatio);
  const edgePoints = new Map<string, number>();
  const newVertexIndices: number[] = [];

  // One shared vertex per (edge, position along it), keyed from the edge's
  // lower-index end so both faces on an edge land on the same vertex.
  function edgePoint(a: number, b: number, tFromA: number): number {
    const u = Math.min(a, b);
    const v = Math.max(a, b);
    const t = a < b ? tFromA : 1 - tFromA;
    const key = `${u}_${v}_${Math.round(t * 100000)}`;
    const existing = edgePoints.get(key);
    if (existing !== undefined) return existing;
    const pu = base.positions[u];
    const pv = base.positions[v];
    const index = next.positions.length;
    next.positions.push([pu[0] + (pv[0] - pu[0]) * t, pu[1] + (pv[1] - pu[1]) * t, pu[2] + (pv[2] - pu[2]) * t]);
    edgePoints.set(key, index);
    newVertexIndices.push(index);
    return index;
  }

  const newEdgeIndices: [number, number][] = [];
  const pending: number[] = [];

  for (const { face: f, corner, flipped } of ring) {
    const face = base.faces[f];
    const uvs = base.faceUVs![f] as UV[];
    const k = [corner, (corner + 1) % 4, (corner + 2) % 4, (corner + 3) % 4];
    const [v0, v1, v2, v3] = k.map((i) => face[i]);
    const [t0, t1, t2, t3] = k.map((i) => uvs[i]);

    // Along the entry edge v0 → v1 and the opposite edge v3 → v2, in order.
    const local = ratios.map((r) => (flipped ? 1 - r : r)).sort((a, b) => a - b);
    const rowA = [v0, ...local.map((r) => edgePoint(v0, v1, r)), v1];
    const rowB = [v3, ...local.map((r) => edgePoint(v3, v2, r)), v2];
    const uvA = [t0, ...local.map((r) => lerpUV(t0, t1, r)), t1];
    const uvB = [t3, ...local.map((r) => lerpUV(t3, t2, r)), t2];
    for (let i = 1; i < rowA.length - 1; i++) newEdgeIndices.push([rowA[i], rowB[i]]);

    // The first strip replaces the face (keeping its index), the rest are appended.
    next.faces[f] = [rowA[0], rowA[1], rowB[1], rowB[0]];
    next.faceUVs![f] = [uvA[0], uvA[1], uvB[1], uvB[0]];
    for (let i = 1; i < rowA.length - 1; i++) {
      appendFace(next, [rowA[i], rowA[i + 1], rowB[i + 1], rowB[i]], f, [uvA[i], uvA[i + 1], uvB[i + 1], uvB[i]], pending);
    }
  }

  return { mesh: next, newEdgeIndices, newVertexIndices };
}

/**
 * The lines a loop cut through `startEdge` would add, for the hover preview —
 * the same ring and ratios loopCut uses.
 */
export function getLoopCutPreviewSegments(
  mesh: QuadMesh,
  startEdge: [number, number],
  cutsOrRatio: number = 1,
): [ [number, number, number], [number, number, number] ][] {
  const { faces: ring } = quadRing(mesh, startEdge[0], startEdge[1]);
  const ratios = cutRatios(cutsOrRatio);
  const segments: [ [number, number, number], [number, number, number] ][] = [];
  const lerp = (a: number[], b: number[], t: number): [number, number, number] => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  for (const { face: f, corner, flipped } of ring) {
    const face = mesh.faces[f];
    const p0 = mesh.positions[face[corner]];
    const p1 = mesh.positions[face[(corner + 1) % 4]];
    const p2 = mesh.positions[face[(corner + 2) % 4]];
    const p3 = mesh.positions[face[(corner + 3) % 4]];
    if (!p0 || !p1 || !p2 || !p3) continue;
    for (const r of ratios) {
      const t = flipped ? 1 - r : r;
      segments.push([lerp(p0, p1, t), lerp(p3, p2, t)]);
    }
  }
  return segments;
}

export interface ProportionalOptions {
  enabled?: boolean;
  diameter?: number;
}

/**
 * Transforms the selected points or faces around their centroid, with optional Blender-style Proportional Editing.
 */
export function transformSelection(
  mesh: QuadMesh,
  mode: "points" | "faces",
  selectedIndices: number[],
  delta: { position: THREE.Vector3; rotation: THREE.Quaternion; scale: THREE.Vector3 },
  centroid: THREE.Vector3,
  proportionalOptions?: ProportionalOptions,
): QuadMesh {
  const matrix = new THREE.Matrix4()
    .makeTranslation(centroid.x + delta.position.x, centroid.y + delta.position.y, centroid.z + delta.position.z)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(delta.rotation))
    .multiply(new THREE.Matrix4().makeScale(delta.scale.x, delta.scale.y, delta.scale.z))
    .multiply(new THREE.Matrix4().makeTranslation(-centroid.x, -centroid.y, -centroid.z));
  return transformSelectionByMatrix(mesh, mode, selectedIndices, matrix, proportionalOptions);
}

/**
 * The gizmo works in world space, the mesh data lives in local space. A
 * rotation or scale delta read straight off the gizmo and applied to local
 * coordinates is only right while the object has an identity rotation and a
 * uniform scale — on anything else the selection turned about the wrong axis.
 * Conjugating the world-space delta by the object's world matrix
 * (`M⁻¹ · D · M`) gives the exact local-space equivalent for any pose,
 * non-uniform scale included.
 */
export function worldDeltaToLocal(worldDelta: THREE.Matrix4, meshWorldMatrix: THREE.Matrix4): THREE.Matrix4 {
  const inv = meshWorldMatrix.clone().invert();
  return inv.multiply(worldDelta).multiply(meshWorldMatrix);
}

/**
 * The world-space delta of a gizmo drag around the selection centroid:
 * `T(position) · R · S · T(-startPosition)`, where R and S are the rotation and
 * scale the gizmo has accumulated since the drag began.
 */
export function gizmoWorldDelta(
  startPosition: THREE.Vector3,
  startQuaternion: THREE.Quaternion,
  startScale: THREE.Vector3,
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
  scale: THREE.Vector3,
): THREE.Matrix4 {
  const deltaQuat = quaternion.clone().multiply(startQuaternion.clone().invert());
  const sx = startScale.x !== 0 ? scale.x / startScale.x : 1;
  const sy = startScale.y !== 0 ? scale.y / startScale.y : 1;
  const sz = startScale.z !== 0 ? scale.z / startScale.z : 1;
  return new THREE.Matrix4()
    .makeTranslation(position.x, position.y, position.z)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(deltaQuat))
    .multiply(new THREE.Matrix4().makeScale(sx, sy, sz))
    .multiply(new THREE.Matrix4().makeTranslation(-startPosition.x, -startPosition.y, -startPosition.z));
}

/**
 * Applies a local-space affine `matrix` to the selected points / faces, with
 * optional Blender-style Proportional Editing (unselected vertices within the
 * influence radius get the same displacement, weighted by a smooth falloff).
 */
export function transformSelectionByMatrix(
  mesh: QuadMesh,
  mode: "points" | "faces",
  selectedIndices: number[],
  matrix: THREE.Matrix4,
  proportionalOptions?: ProportionalOptions,
): QuadMesh {
  if (selectedIndices.length === 0) return cloneQuadMesh(mesh);

  const targetVertexIndices = new Set<number>();
  if (mode === "points") {
    for (const idx of selectedIndices) {
      if (idx >= 0 && idx < mesh.positions.length) targetVertexIndices.add(idx);
    }
  } else {
    for (const fIdx of selectedIndices) {
      const face = mesh.faces[fIdx];
      if (!face) continue;
      for (const v of face) targetVertexIndices.add(v);
    }
  }

  if (targetVertexIndices.size === 0) return cloneQuadMesh(mesh);

  const next = cloneQuadMesh(mesh);
  const isProportional = Boolean(proportionalOptions?.enabled);
  const diameter = Math.max(1e-4, Number(proportionalOptions?.diameter) || 1.0);
  const radius = diameter / 2;
  const radiusSq = radius * radius;

  const p = new THREE.Vector3();
  const computeFullTransformed = (raw: [number, number, number]): THREE.Vector3 =>
    p.set(raw[0], raw[1], raw[2]).applyMatrix4(matrix);

  if (!isProportional) {
    for (const vIdx of targetVertexIndices) {
      const raw = mesh.positions[vIdx];
      if (!raw) continue;
      const full = computeFullTransformed(raw);
      next.positions[vIdx] = [full.x, full.y, full.z];
    }
    return next;
  }

  // Pre-gather selected vertex positions for fast distance checking
  const selectedPositions: [number, number, number][] = [];
  for (const vIdx of targetVertexIndices) {
    const sp = mesh.positions[vIdx];
    if (sp) selectedPositions.push(sp);
  }

  for (let i = 0; i < mesh.positions.length; i++) {
    const raw = mesh.positions[i];
    if (!raw) continue;

    if (targetVertexIndices.has(i)) {
      const full = computeFullTransformed(raw);
      next.positions[i] = [full.x, full.y, full.z];
      continue;
    }

    // Find min distance to any selected vertex
    let minDistSq = Infinity;
    const px = raw[0];
    const py = raw[1];
    const pz = raw[2];
    for (let s = 0; s < selectedPositions.length; s++) {
      const sp = selectedPositions[s];
      const dx = px - sp[0];
      const dy = py - sp[1];
      const dz = pz - sp[2];
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < minDistSq) {
        minDistSq = distSq;
        if (minDistSq <= 0) break;
      }
    }

    if (minDistSq < radiusSq) {
      const dist = Math.sqrt(minDistSq);
      const t = dist / radius; // 0 (closest) to 1 (at influence boundary)
      // Smoothstep falloff (Blender smooth curve): u = 1 - t, weight = u^2 * (3 - 2u)
      const u = 1 - t;
      const weight = u * u * (3 - 2 * u);

      const full = computeFullTransformed(raw);
      const dispX = full.x - raw[0];
      const dispY = full.y - raw[1];
      const dispZ = full.z - raw[2];

      next.positions[i] = [
        raw[0] + dispX * weight,
        raw[1] + dispY * weight,
        raw[2] + dispZ * weight,
      ];
    }
  }

  return next;
}

/**
 * The faces for which `keep` is true, with every per-face attribute (UVs,
 * shading, material) carried along and the vertices compacted: unused ones
 * dropped, the rest renumbered in their original order.
 */
function subsetFaces(mesh: QuadMesh, keep: (face: number) => boolean): QuadMesh {
  const kept: number[] = [];
  for (let f = 0; f < mesh.faces.length; f++) if (keep(f)) kept.push(f);

  const oldToNew = new Map<number, number>();
  const used = new Uint8Array(mesh.positions.length);
  for (const f of kept) for (const v of mesh.faces[f]) used[v] = 1;
  const positions: [number, number, number][] = [];
  const uvs: [number, number][] = [];
  for (let v = 0; v < mesh.positions.length; v++) {
    if (!used[v]) continue;
    oldToNew.set(v, positions.length);
    const p = mesh.positions[v];
    positions.push([p[0], p[1], p[2]]);
    if (mesh.uvs?.[v]) uvs.push([mesh.uvs[v][0], mesh.uvs[v][1]]);
  }

  const hasFaceShading = Boolean(mesh.faceShading && mesh.faceShading.length > 0);
  return {
    positions,
    faces: kept.map((f) => mesh.faces[f].map((v) => oldToNew.get(v)!)),
    uvs: mesh.uvs ? uvs : undefined,
    faceUVs: mesh.faceUVs ? kept.map((f) => (mesh.faceUVs![f] ?? []).map((uv) => [uv[0], uv[1]] as [number, number])) : undefined,
    shading: mesh.shading,
    faceShading: mesh.faceShading ? (hasFaceShading ? kept.map((f) => mesh.faceShading![f]) : []) : undefined,
    faceMaterials: mesh.faceMaterials ? kept.map((f) => mesh.faceMaterials![f] ?? 0) : undefined,
    sourceSignature: mesh.sourceSignature,
  };
}

/**
 * Deletes the specified faces from a QuadMesh, reindexing vertices and
 * dropping any left unused, with UVs, shading and materials kept in step.
 */
export function deleteFaces(mesh: QuadMesh, faceIndices: number[]): QuadMesh {
  if (faceIndices.length === 0) return cloneQuadMesh(mesh);
  const toDelete = new Set(faceIndices.map(Number));
  return subsetFaces(mesh, (f) => !toDelete.has(f));
}

/**
 * Extracts the specified faces from a QuadMesh into a new QuadMesh,
 * preserving their geometry, UVs, shading and materials with compact vertex
 * indexing.
 */
export function extractFaces(mesh: QuadMesh, faceIndices: number[]): QuadMesh {
  const toExtract = new Set(faceIndices.map(Number));
  return subsetFaces(mesh, (f) => toExtract.has(f));
}
