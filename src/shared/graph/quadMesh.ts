import * as THREE from "three";
import { triangulateFace } from "./mesh/triangulate";
import { averageUV, boxProjectFace, fillNewFaceUVs, lerpUV, UV } from "./mesh/uv";
import { quadRing } from "./mesh/loops";
import { importBufferGeometry } from "./mesh/importGeometry";
import { cloneEdgeAttributes, cornerColor, remapEdgeAttributes, splitEdgeAttributes } from "./mesh/attributes";

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
  /** Edges shading keeps hard (normals don't blend across them), as vertex pairs. */
  sharpEdges?: [number, number][];
  /** Edges Smart UV Unwrap cuts the UV layout along. */
  seamEdges?: [number, number][];
  /** Subdivision crease weights (0..1) as [a, b, weight]: 1 keeps the edge sharp through Catmull-Clark. */
  edgeCreases?: [number, number, number][];
  /** Vertex colour per face corner (parallel to faceUVs); null / missing = white. */
  faceColors?: ([number, number, number][] | null)[];
  /**
   * Loose edges: ones no face uses, as vertex pairs (lower index first) — a
   * wire outline, Blender's edges-only mesh. Drawn as lines (see
   * syncLooseEdgeLines); the faces' own edges are never listed here.
   */
  edges?: [number, number][];
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
    ...cloneEdgeAttributes(mesh),
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
const signatureCache = new WeakMap<QuadMesh, string>();

/**
 * Memoised per mesh object: stored and preview meshes are never mutated
 * after they're built (every edit makes a new one), and at 50k vertices the
 * hash is ~15 ms — the node and the viewport overlay each used to pay it
 * every frame of a drag.
 */
export function quadMeshSignature(mesh: QuadMesh): string {
  let cached = signatureCache.get(mesh);
  if (cached === undefined) {
    cached = computeQuadMeshSignature(mesh);
    signatureCache.set(mesh, cached);
  }
  return cached;
}

function computeQuadMeshSignature(mesh: QuadMesh): string {
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
  // Shading-relevant extras: sharp edges and corner colours change the
  // built geometry; seams and creases don't, but are cheap to include.
  for (const list of [mesh.sharpEdges, mesh.seamEdges]) if (list) for (const [a, b] of list) mix(a * 7919 + b);
  if (mesh.edgeCreases) for (const [a, b, w] of mesh.edgeCreases) mix(a * 7919 + b + Math.round(w * 1000));
  if (mesh.faceColors) {
    for (const c of mesh.faceColors) {
      if (!c) continue;
      for (const [r, g, b] of c) mix(Math.round(r * 255) * 65536 + Math.round(g * 255) * 256 + Math.round(b * 255));
    }
  }
  if (mesh.edges) for (const [a, b] of mesh.edges) mix(a * 104729 + b);
  return `${mesh.positions.length}:${mesh.faces.length}:${mesh.edges?.length ?? 0}:${hash.toString(36)}`;
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
 * Box/cube projection UVs for a QuadMesh: each face onto its dominant normal
 * plane (XY, XZ, or YZ), in object space at a fixed density (UV_DENSITY) —
 * so each face's UVs depend on that face alone.
 */
export function boxProjectUVs(mesh: QuadMesh): QuadMesh {
  const next = cloneQuadMesh(mesh);
  next.faceUVs = next.faces.map((face) =>
    face.length === 0 ? [] : boxProjectFace(next, face, computeFaceNormal(next.positions, face)),
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
const edgesCache = new WeakMap<number[][], [number, number][]>();

/** Memoised per faces array (shared, unchanged, while a drag only moves vertices). */
export function getQuadMeshEdges(mesh: QuadMesh): [number, number][] {
  let edges = edgesCache.get(mesh.faces);
  if (!edges) {
    edges = computeQuadMeshEdges(mesh);
    edgesCache.set(mesh.faces, edges);
  }
  if (!mesh.edges?.length) return edges;
  // The loose edges after the faces' own, memoised on the pair of arrays.
  const cached = withLooseCache.get(mesh.edges);
  if (cached && cached.faceEdges === edges) return cached.all;
  const all = [...edges, ...mesh.edges.map(([a, b]) => [a, b] as [number, number])];
  withLooseCache.set(mesh.edges, { faceEdges: edges, all });
  return all;
}

const withLooseCache = new WeakMap<[number, number][], { faceEdges: [number, number][]; all: [number, number][] }>();

/**
 * Draws the mesh's loose edges on `object`, as a LineSegments child it keeps
 * (and removes once there are none). The faces are the object's own geometry;
 * lines are the only way to show an edge no face uses. The colour follows the
 * object's material, so an edges-only mesh still reads as its colour.
 */
export function syncLooseEdgeLines(object: THREE.Mesh, mesh: QuadMesh | null): void {
  let lines = object.children.find((c) => c.userData.looseEdges) as THREE.LineSegments | undefined;
  if (!mesh?.edges?.length) {
    if (lines) {
      object.remove(lines);
      lines.geometry.dispose();
      (lines.material as THREE.Material).dispose();
    }
    return;
  }
  if (!lines) {
    lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
    lines.userData.looseEdges = true;
    object.add(lines);
  }
  const key = `${quadMeshSignature(mesh)}`;
  if (lines.userData.key !== key) {
    lines.userData.key = key;
    const positions: number[] = [];
    for (const [a, b] of mesh.edges) {
      const pa = mesh.positions[a];
      const pb = mesh.positions[b];
      if (pa && pb) positions.push(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2]);
    }
    lines.geometry.dispose();
    lines.geometry = new THREE.BufferGeometry();
    lines.geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  }
  const source = Array.isArray(object.material) ? object.material[0] : object.material;
  const color = (source as THREE.MeshStandardMaterial | undefined)?.color;
  const lineMaterial = lines.material as THREE.LineBasicMaterial;
  if (color instanceof THREE.Color) lineMaterial.color.copy(color);
}

function computeQuadMeshEdges(mesh: QuadMesh): [number, number][] {
  // Numeric keys (a·N + b): several times faster than string keys at mesh sizes.
  const n = mesh.positions.length + 1;
  const edgeSet = new Set<number>();
  const edges: [number, number][] = [];

  for (const face of mesh.faces) {
    const len = face.length;
    for (let i = 0; i < len; i++) {
      const u = face[i];
      const v = face[(i + 1) % len];
      const a = u < v ? u : v;
      const b = u < v ? v : u;
      const key = a * n + b;
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
 * Attaches the QuadMesh it was built from in `geometry.userData.quadMesh` — by reference, read-only.
 */
export function quadMeshToBufferGeometry(
  inputMesh: QuadMesh,
  forcedShading?: QuadMeshShading,
): THREE.BufferGeometry {
  const globalShading = forcedShading || inputMesh.shading || "auto";
  const hasPerFaceShading = Boolean(inputMesh.faceShading && inputMesh.faceShading.length > 0);

  // UVs are never projected here from the mesh as it currently stands — that
  // made the texture slide over the whole mesh whenever one vertex moved, and
  // change with the shading mode. Stored per-corner UVs are used as they are;
  // per-vertex ones (a plane's grid) likewise, converted to per-corner unless
  // the pure-smooth path below takes them directly; a mesh with neither gets
  // the fixed-density projection, which depends on each face alone.
  const hasFaceUVs = Boolean(
    inputMesh.faceUVs &&
      inputMesh.faceUVs.length === inputMesh.faces.length &&
      inputMesh.faceUVs.every((uvs, f) => uvs.length === inputMesh.faces[f].length),
  );
  const hasVertexUVs = Boolean(inputMesh.uvs && inputMesh.uvs.length === inputMesh.positions.length);
  const smoothTakesVertexUVs = globalShading === "smooth" && !hasPerFaceShading && hasVertexUVs;
  const mesh = hasFaceUVs || smoothTakesVertexUVs ? inputMesh : withFaceUVs(inputMesh);

  const numFaces = mesh.faces.length;

  const faceNormals: THREE.Vector3[] = new Array(numFaces);
  for (let f = 0; f < numFaces; f++) {
    faceNormals[f] = computeFaceNormal(mesh.positions, mesh.faces[f]);
  }

  const vertexFaceLists: number[][] = new Array(mesh.positions.length);
  for (let f = 0; f < numFaces; f++) {
    for (const v of mesh.faces[f]) (vertexFaceLists[v] ??= []).push(f);
  }
  const vertexFaces = { get: (v: number): number[] | undefined => vertexFaceLists[v] };

  const COS_CREASE = Math.cos((35 * Math.PI) / 180); // ~0.819 crease angle

  // Sharp edges split smoothing: around a vertex on one, the faces fall into
  // groups separated by its sharp edges, and a corner's normal only blends
  // the faces of its own group.
  const sharp = new Set((mesh.sharpEdges ?? []).map(([a, b]) => (a < b ? `${a}_${b}` : `${b}_${a}`)));
  const smoothingGroup = new Map<string, number[]>();
  if (sharp.size > 0) {
    const sharpVerts = new Set<number>();
    for (const key of sharp) for (const v of key.split("_").map(Number)) sharpVerts.add(v);
    for (const v of sharpVerts) {
      const around = vertexFaces.get(v) ?? [];
      const parent = new Map(around.map((f) => [f, f]));
      const find = (f: number): number => (parent.get(f) === f ? f : find(parent.get(f)!));
      const byEdge = new Map<string, number[]>();
      for (const f of around) {
        const face = mesh.faces[f];
        const i = face.indexOf(v);
        for (const x of [face[(i + 1) % face.length], face[(i + face.length - 1) % face.length]]) {
          const key = v < x ? `${v}_${x}` : `${x}_${v}`;
          byEdge.set(key, [...(byEdge.get(key) ?? []), f]);
        }
      }
      for (const [key, fs] of byEdge) {
        if (sharp.has(key) || fs.length < 2) continue;
        for (let k = 1; k < fs.length; k++) parent.set(find(fs[k]), find(fs[0]));
      }
      for (const f of around) smoothingGroup.set(`${v}:${f}`, around.filter((g) => find(g) === find(f)));
    }
  }
  const hasColors = Boolean(mesh.faceColors && mesh.faceColors.some((c) => c));

  const isPureSmooth = globalShading === "smooth" && !hasPerFaceShading && !mesh.faceUVs && sharp.size === 0 && !hasColors;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];

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
    geometry.userData.quadMesh = mesh; // read-only: consumers copy it (bufferGeometryToQuadMesh, resolveEditMeshData)
    buildPlans.set(geometry, { kind: "shared", mesh: inputMesh, shading: globalShading });
    return geometry;
  }

  // Split-vertex geometry: respects sharp crease angles, per-face UVs and
  // corner colours. A face corner reuses an output vertex already made for
  // the same mesh vertex when normal, UV and colour all match (quantised);
  // the candidates are the few made for that vertex so far, compared as
  // numbers — no string keys or per-corner allocations, which at 50k
  // vertices made this the slowest step of every edit.
  const fnx = new Float64Array(numFaces);
  const fny = new Float64Array(numFaces);
  const fnz = new Float64Array(numFaces);
  for (let f = 0; f < numFaces; f++) {
    fnx[f] = faceNormals[f].x;
    fny[f] = faceNormals[f].y;
    fnz[f] = faceNormals[f].z;
  }
  /** Per mesh vertex: the output vertices made for it, flat runs of [index, qnx, qny, qnz, qu, qv, qc]. */
  const madeFor: number[][] = new Array(mesh.positions.length);
  const q = (x: number, s: number) => Math.round(x * s);

  function addVertex(vIdx: number, faceIdx: number, inFaceIdx: number): number {
    const faceMode = mesh.faceShading?.[faceIdx] || globalShading;
    let nx = 0, ny = 0, nz = 0;
    if (faceMode === "flat") {
      nx = fnx[faceIdx]; ny = fny[faceIdx]; nz = fnz[faceIdx];
    } else {
      const neighborFaces =
        (smoothingGroup.size > 0 ? smoothingGroup.get(`${vIdx}:${faceIdx}`) : undefined) ?? vertexFaces.get(vIdx) ?? [faceIdx];
      const ax = fnx[faceIdx], ay = fny[faceIdx], az = fnz[faceIdx];
      for (const nF of neighborFaces) {
        // "auto": only faces within the crease angle of this one.
        if (faceMode !== "smooth" && ax * fnx[nF] + ay * fny[nF] + az * fnz[nF] < COS_CREASE) continue;
        nx += fnx[nF]; ny += fny[nF]; nz += fnz[nF];
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
    }

    let u = 0;
    let v = 0;
    const cornerUV = mesh.faceUVs?.[faceIdx]?.[inFaceIdx];
    if (cornerUV) {
      u = cornerUV[0];
      v = cornerUV[1];
    } else if (mesh.uvs?.[vIdx]) {
      u = mesh.uvs[vIdx][0];
      v = mesh.uvs[vIdx][1];
    }
    const color = hasColors ? cornerColor(mesh, faceIdx, inFaceIdx) : null;

    const k0 = q(nx, 100), k1 = q(ny, 100), k2 = q(nz, 100), k3 = q(u, 1000), k4 = q(v, 1000);
    const k5 = color ? q(color[0], 255) * 65536 + q(color[1], 255) * 256 + q(color[2], 255) : -1;
    // Made-for list, flat: [index, k0..k5] per candidate.
    const list = (madeFor[vIdx] ??= []);
    for (let i = 0; i < list.length; i += 7) {
      if (list[i + 1] === k0 && list[i + 2] === k1 && list[i + 3] === k2 && list[i + 4] === k3 && list[i + 5] === k4 && list[i + 6] === k5) {
        return list[i];
      }
    }

    const p = mesh.positions[vIdx];
    const newIdx = positions.length / 3;
    positions.push(p[0], p[1], p[2]);
    normals.push(nx, ny, nz);
    uvs.push(u, v);
    if (color) colors.push(color[0], color[1], color[2]);
    list.push(newIdx, k0, k1, k2, k3, k4, k5);
    return newIdx;
  }

  const byMaterial = new Map<number, number[]>();
  const cornerOut: number[] = [];
  for (let f = 0; f < numFaces; f++) {
    const face = mesh.faces[f];
    const vertIndices: number[] = [];
    for (let i = 0; i < face.length; i++) {
      const out = addVertex(face[i], f, i);
      vertIndices.push(out);
      cornerOut.push(out);
    }
    const list = materialList(byMaterial, mesh.faceMaterials?.[f] ?? 0);
    const n = faceNormals[f];
    for (const [a, b, c] of triangulateFace(mesh.positions, face, [n.x, n.y, n.z])) {
      list.push(vertIndices[a], vertIndices[b], vertIndices[c]);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  if (uvs.length > 0) {
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  }
  if (hasColors) geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  setGroupedIndex(geometry, byMaterial, Boolean(mesh.faceMaterials));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.quadMesh = mesh; // read-only: consumers copy it (bufferGeometryToQuadMesh, resolveEditMeshData)
  buildPlans.set(geometry, { kind: "split", mesh: inputMesh, shading: globalShading, cornerOut: Int32Array.from(cornerOut), smoothingGroup });
  return geometry;
}

interface BuildPlan {
  kind: "split" | "shared";
  /** The mesh the geometry was built from (for the same-topology check). */
  mesh: QuadMesh;
  shading: QuadMeshShading;
  /** Split build: the output vertex of every face corner, in face order. */
  cornerOut?: Int32Array;
  smoothingGroup?: Map<string, number[]>;
}
const buildPlans = new WeakMap<THREE.BufferGeometry, BuildPlan>();

/**
 * Moves an existing geometry's vertices to `mesh`'s positions and refreshes
 * its normals, in place, when `mesh` has the same topology as the one it was
 * built from (same faces, UVs, colours, marks and shading — compared by
 * reference, since a vertex drag shares all of those). Returns false when it
 * can't, and the caller rebuilds. Where the corners were split into separate
 * vertices stays as it was at the last full build; for a drag that's exact
 * in flat and smooth shading and near enough in auto.
 */
export function updateQuadMeshGeometry(geometry: THREE.BufferGeometry, mesh: QuadMesh, forcedShading?: QuadMeshShading): boolean {
  const plan = buildPlans.get(geometry);
  if (!plan) return false;
  const prev = plan.mesh;
  const shading = forcedShading || mesh.shading || "auto";
  if (
    shading !== plan.shading ||
    prev.faces !== mesh.faces ||
    prev.faceUVs !== mesh.faceUVs ||
    prev.uvs !== mesh.uvs ||
    prev.faceColors !== mesh.faceColors ||
    prev.faceShading !== mesh.faceShading ||
    prev.faceMaterials !== mesh.faceMaterials ||
    prev.sharpEdges !== mesh.sharpEdges ||
    prev.positions.length !== mesh.positions.length
  ) {
    return false;
  }
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  if (plan.kind === "shared") {
    mesh.positions.forEach((p, i) => pos.setXYZ(i, p[0], p[1], p[2]));
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
  } else {
    const nor = geometry.attributes.normal as THREE.BufferAttribute;
    const numFaces = mesh.faces.length;
    const fnx = new Float64Array(numFaces);
    const fny = new Float64Array(numFaces);
    const fnz = new Float64Array(numFaces);
    for (let f = 0; f < numFaces; f++) {
      const n = computeFaceNormal(mesh.positions, mesh.faces[f]);
      fnx[f] = n.x; fny[f] = n.y; fnz[f] = n.z;
    }
    const vertexFaceLists: number[][] = new Array(mesh.positions.length);
    for (let f = 0; f < numFaces; f++) for (const v of mesh.faces[f]) (vertexFaceLists[v] ??= []).push(f);
    const COS_CREASE = Math.cos((35 * Math.PI) / 180);
    const done = new Uint8Array(pos.count);
    const groups = plan.smoothingGroup!;
    let k = 0;
    for (let f = 0; f < numFaces; f++) {
      const face = mesh.faces[f];
      const faceMode = mesh.faceShading?.[f] || shading;
      for (let i = 0; i < face.length; i++, k++) {
        const out = plan.cornerOut![k];
        if (done[out]) continue;
        done[out] = 1;
        const v = face[i];
        const p = mesh.positions[v];
        pos.setXYZ(out, p[0], p[1], p[2]);
        let nx = fnx[f], ny = fny[f], nz = fnz[f];
        if (faceMode !== "flat") {
          nx = ny = nz = 0;
          const around = (groups.size > 0 ? groups.get(`${v}:${f}`) : undefined) ?? vertexFaceLists[v] ?? [f];
          for (const g of around) {
            if (faceMode !== "smooth" && fnx[f] * fnx[g] + fny[f] * fny[g] + fnz[f] * fnz[g] < COS_CREASE) continue;
            nx += fnx[g]; ny += fny[g]; nz += fnz[g];
          }
          const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          nx /= len; ny /= len; nz /= len;
        }
        nor.setXYZ(out, nx, ny, nz);
      }
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.quadMesh = mesh; // read-only: consumers copy it (bufferGeometryToQuadMesh, resolveEditMeshData)
  plan.mesh = mesh;
  return true;
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
  const valid = (f: number) => mesh.faceUVs?.[f]?.length === mesh.faces[f].length;
  if (mesh.faceUVs) {
    const missing = mesh.faces.map((_, f) => f).filter((f) => !valid(f));
    if (missing.length === 0 && mesh.faceUVs.length === mesh.faces.length) return mesh;
    if (missing.length < mesh.faces.length) {
      // Keep every face's UVs that are there; the others continue from them.
      const next = cloneQuadMesh(mesh);
      next.faceUVs = mesh.faces.map((_, f) => (valid(f) ? mesh.faceUVs![f].map((uv) => [uv[0], uv[1]] as [number, number]) : []));
      fillNewFaceUVs(next, missing);
      return next;
    }
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
 * (given, or — when omitted — continued from its neighbours once the whole
 * operation is built: `pending` collects those for fillNewFaceUVs), material
 * slot and shading inherited from the face it came from.
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
  fillNewFaceUVs(next, pending);
}

/** Selected face indices that exist, deduplicated, in ascending order. */
function validFaces(mesh: QuadMesh, indices: number[]): number[] {
  return [...new Set(indices)].filter((f) => Number.isInteger(f) && f >= 0 && f < mesh.faces.length).sort((a, b) => a - b);
}

/**
 * Extrudes the selected face(s) outward along their averaged face normal —
 * or, given a `direction` (a unit vector, mesh space), all of them along it:
 * an extrude locked to an axis, as with E then X / Y / Z.
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
  direction?: { x: number; y: number; z: number },
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
    const n = direction ? new THREE.Vector3(direction.x, direction.y, direction.z) : sum.normalize();
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
    const along = splitAlong.get(`${u}_${v}`) ?? [];
    along.push({ t, v: index });
    splitAlong.set(`${u}_${v}`, along);
    newVertexIndices.push(index);
    return index;
  }
  /** New vertices on each original edge (keyed low_high), with their position along it. */
  const splitAlong = new Map<string, { t: number; v: number }[]>();

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

  for (const [key, points] of splitAlong) {
    const [u, v] = key.split("_").map(Number);
    splitEdgeAttributes(next, u, v, points.sort((x, y) => x.t - y.t).map((p) => p.v));
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

export type ProportionalFalloff = "smooth" | "sphere" | "root" | "linear" | "sharp" | "constant";

export interface ProportionalOptions {
  enabled?: boolean;
  diameter?: number;
  /** How influence fades with distance (Blender's falloff curves). Default smooth. */
  falloff?: ProportionalFalloff;
  /**
   * Measure distance along the mesh's edges rather than straight through
   * space, so only geometry connected to the selection moves — two fingers
   * of a hand no longer drag each other along.
   */
  connected?: boolean;
}

/** Influence weight at `t` = distance / radius, in [0, 1]. */
export function proportionalWeight(t: number, falloff: ProportionalFalloff = "smooth"): number {
  if (t >= 1) return 0;
  const u = 1 - Math.max(0, t);
  switch (falloff) {
    case "sphere":
      return Math.sqrt(Math.max(0, 1 - t * t));
    case "root":
      return Math.sqrt(u);
    case "linear":
      return u;
    case "sharp":
      return u * u;
    case "constant":
      return 1;
    default:
      return u * u * (3 - 2 * u);
  }
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
 * `T(position) · R(quaternion) · S · R(startQuaternion)⁻¹ · T(-startPosition)`
 * — the scale S applies along the gizmo's own axes as they were when the drag
 * began, so it's right for a gizmo oriented Local or Normal, not just Global.
 * With an identity start orientation this is `T · ΔR · S · T⁻¹`.
 */
export function gizmoWorldDelta(
  startPosition: THREE.Vector3,
  startQuaternion: THREE.Quaternion,
  startScale: THREE.Vector3,
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
  scale: THREE.Vector3,
): THREE.Matrix4 {
  const sx = startScale.x !== 0 ? scale.x / startScale.x : 1;
  const sy = startScale.y !== 0 ? scale.y / startScale.y : 1;
  const sz = startScale.z !== 0 ? scale.z / startScale.z : 1;
  return new THREE.Matrix4()
    .makeTranslation(position.x, position.y, position.z)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(quaternion))
    .multiply(new THREE.Matrix4().makeScale(sx, sy, sz))
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(startQuaternion.clone().invert()))
    .multiply(new THREE.Matrix4().makeTranslation(-startPosition.x, -startPosition.y, -startPosition.z));
}

/**
 * Applies a local-space affine `matrix` to the selected points / faces, with
 * optional Blender-style Proportional Editing (unselected vertices within the
 * influence radius get the same displacement, weighted by the falloff).
 */
export function transformSelectionByMatrix(
  mesh: QuadMesh,
  mode: "points" | "faces",
  selectedIndices: number[],
  matrix: THREE.Matrix4,
  proportionalOptions?: ProportionalOptions,
): QuadMesh {
  const vertices = new Set<number>();
  if (mode === "points") {
    for (const idx of selectedIndices) if (idx >= 0 && idx < mesh.positions.length) vertices.add(idx);
  } else {
    for (const f of selectedIndices) for (const v of mesh.faces[f] ?? []) vertices.add(v);
  }
  return transformVertexGroups(mesh, [{ vertices: [...vertices], matrix }], proportionalOptions);
}

/**
 * Applies one local-space matrix per group of vertices — several groups for
 * the Individual Origins pivot, where each island turns about its own centre.
 * With proportional editing, an unselected vertex follows the group of the
 * selected vertex nearest to it, weighted by distance (straight-line, or
 * along edges when `connected`).
 */
export function transformVertexGroups(
  mesh: QuadMesh,
  groups: { vertices: number[]; matrix: THREE.Matrix4 }[],
  proportional?: ProportionalOptions,
): QuadMesh {
  // Only positions change: everything else is shared with the input rather
  // than copied (meshes are never mutated once built). That's what lets the
  // geometry build see "same topology" by reference and just move vertices
  // — see updateQuadMeshGeometry — on every frame of a drag.
  const next: QuadMesh = { ...mesh, positions: mesh.positions.map((p) => [p[0], p[1], p[2]] as [number, number, number]) };
  const groupOf = new Map<number, number>();
  groups.forEach((g, gi) => {
    for (const v of g.vertices) if (v >= 0 && v < mesh.positions.length) groupOf.set(v, gi);
  });
  if (groupOf.size === 0) return next;

  const p = new THREE.Vector3();
  const moved = (v: number, gi: number) => {
    const raw = mesh.positions[v];
    return p.set(raw[0], raw[1], raw[2]).applyMatrix4(groups[gi].matrix);
  };
  for (const [v, gi] of groupOf) {
    const q = moved(v, gi);
    next.positions[v] = [q.x, q.y, q.z];
  }
  if (!proportional?.enabled) return next;

  const radius = Math.max(1e-4, Number(proportional.diameter) || 1.0) / 2;
  const falloff = proportional.falloff ?? "smooth";
  // Nearest selected vertex (and its distance) for every vertex in reach.
  const nearest = proportional.connected
    ? connectedDistances(mesh, groupOf, radius)
    : straightDistances(mesh, groupOf, radius);
  for (const [v, { dist, source }] of nearest) {
    if (groupOf.has(v)) continue;
    const w = proportionalWeight(dist / radius, falloff);
    if (w <= 0) continue;
    const raw = mesh.positions[v];
    const q = moved(v, groupOf.get(source)!);
    next.positions[v] = [raw[0] + (q.x - raw[0]) * w, raw[1] + (q.y - raw[1]) * w, raw[2] + (q.z - raw[2]) * w];
  }
  return next;
}

type Reach = Map<number, { dist: number; source: number }>;

function straightDistances(mesh: QuadMesh, selected: Map<number, number>, radius: number): Reach {
  const out: Reach = new Map();
  const sources = [...selected.keys()];
  mesh.positions.forEach((raw, v) => {
    if (selected.has(v)) return;
    let best = Infinity;
    let source = -1;
    for (const s of sources) {
      const q = mesh.positions[s];
      const d = (raw[0] - q[0]) ** 2 + (raw[1] - q[1]) ** 2 + (raw[2] - q[2]) ** 2;
      if (d < best) {
        best = d;
        source = s;
      }
    }
    const dist = Math.sqrt(best);
    if (dist < radius) out.set(v, { dist, source });
  });
  return out;
}

/** Shortest distance along edges from the selection (Dijkstra), up to `radius`. */
function connectedDistances(mesh: QuadMesh, selected: Map<number, number>, radius: number): Reach {
  const neighbours: number[][] = Array.from({ length: mesh.positions.length }, () => []);
  for (const [a, b] of getQuadMeshEdges(mesh)) {
    neighbours[a].push(b);
    neighbours[b].push(a);
  }
  const out: Reach = new Map();
  const queue: { v: number; dist: number; source: number }[] = [];
  for (const s of selected.keys()) {
    out.set(s, { dist: 0, source: s });
    queue.push({ v: s, dist: 0, source: s });
  }
  // A plain sorted queue: meshes edited by hand are small enough.
  while (queue.length) {
    let bi = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].dist < queue[bi].dist) bi = i;
    const { v, dist, source } = queue.splice(bi, 1)[0];
    if (dist > (out.get(v)?.dist ?? Infinity)) continue;
    const pv = mesh.positions[v];
    for (const n of neighbours[v]) {
      const pn = mesh.positions[n];
      const d = dist + Math.hypot(pv[0] - pn[0], pv[1] - pn[1], pv[2] - pn[2]);
      if (d >= radius || d >= (out.get(n)?.dist ?? Infinity)) continue;
      out.set(n, { dist: d, source });
      queue.push({ v: n, dist: d, source });
    }
  }
  return out;
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
  for (const [a, b] of mesh.edges ?? []) used[a] = used[b] = 1;
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
  const out: QuadMesh = {
    positions,
    faces: kept.map((f) => mesh.faces[f].map((v) => oldToNew.get(v)!)),
    uvs: mesh.uvs ? uvs : undefined,
    faceUVs: mesh.faceUVs ? kept.map((f) => (mesh.faceUVs![f] ?? []).map((uv) => [uv[0], uv[1]] as [number, number])) : undefined,
    shading: mesh.shading,
    faceShading: mesh.faceShading ? (hasFaceShading ? kept.map((f) => mesh.faceShading![f]) : []) : undefined,
    faceMaterials: mesh.faceMaterials ? kept.map((f) => mesh.faceMaterials![f] ?? 0) : undefined,
    faceColors: mesh.faceColors ? kept.map((f) => mesh.faceColors![f] ?? null) : undefined,
    sourceSignature: mesh.sourceSignature,
  };
  const remap = new Int32Array(mesh.positions.length).fill(-1);
  for (const [v, n] of oldToNew) remap[v] = n;
  remapEdgeAttributes(mesh, out, remap);
  return out;
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
 * Deletes vertices, as Blender does: with every edge and face using them.
 * What else those faces had stays — their other edges become loose edges —
 * so deleting one corner of a quad leaves the three edges opposite it.
 */
export function deleteVertices(mesh: QuadMesh, vertices: number[]): QuadMesh {
  const gone = new Set(vertices.map(Number));
  if (gone.size === 0) return cloneQuadMesh(mesh);
  return deleteKeepingEdges(mesh, (face) => face.some((v) => gone.has(v)), (a, b) => gone.has(a) || gone.has(b));
}

/**
 * Deletes edges, as Blender does: with every face using them. Those faces'
 * other edges stay, as loose edges; vertices left with nothing go.
 */
export function deleteEdges(mesh: QuadMesh, edges: [number, number][]): QuadMesh {
  const gone = new Set(edges.map(([a, b]) => (a < b ? `${a}_${b}` : `${b}_${a}`)));
  if (gone.size === 0) return cloneQuadMesh(mesh);
  const isGone = (a: number, b: number) => gone.has(a < b ? `${a}_${b}` : `${b}_${a}`);
  return deleteKeepingEdges(mesh, (face) => face.some((v, i) => isGone(v, face[(i + 1) % face.length])), isGone);
}

/**
 * Drops the faces `removeFace` picks, and every edge `removeEdge` picks;
 * each dropped face's remaining edges no surviving face uses are kept as
 * loose edges.
 */
function deleteKeepingEdges(
  mesh: QuadMesh,
  removeFace: (face: number[]) => boolean,
  removeEdge: (a: number, b: number) => boolean,
): QuadMesh {
  const key = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const keptFaces = new Set<number>();
  const surviving = new Set<string>();
  mesh.faces.forEach((face, f) => {
    if (removeFace(face)) return;
    keptFaces.add(f);
    face.forEach((v, i) => surviving.add(key(v, face[(i + 1) % face.length])));
  });
  const loose = new Map<string, [number, number]>();
  const offer = (a: number, b: number) => {
    const k = key(a, b);
    if (a !== b && !removeEdge(a, b) && !surviving.has(k)) loose.set(k, a < b ? [a, b] : [b, a]);
  };
  for (const [a, b] of mesh.edges ?? []) offer(a, b);
  mesh.faces.forEach((face, f) => {
    if (keptFaces.has(f)) return;
    face.forEach((v, i) => offer(v, face[(i + 1) % face.length]));
  });
  return subsetFaces({ ...mesh, edges: [...loose.values()] }, (f) => keptFaces.has(f));
}

/**
 * Extracts the specified faces from a QuadMesh into a new QuadMesh,
 * preserving their geometry, UVs, shading and materials with compact vertex
 * indexing.
 */
export function extractFaces(mesh: QuadMesh, faceIndices: number[]): QuadMesh {
  const toExtract = new Set(faceIndices.map(Number));
  // Loose edges belong to no face, so they stay with the mesh the faces left.
  return subsetFaces({ ...mesh, edges: undefined }, (f) => toExtract.has(f));
}
