import * as THREE from "three";

export type SculptPrimitiveKind = "sphere" | "cube" | "plane";

export interface SculptMeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Per-vertex protection weight (0 = fully sculptable, 1 = fully protected). Same semantics as Terrain's maskWeights, but dense since sculpt-mesh vertex count changes with topology. */
  mask?: Float32Array;
}

/** 1-ring vertex adjacency, rebuilt whenever the index buffer changes (i.e. after any dyntopo split). */
export function buildAdjacency(indices: Uint32Array, vertexCount: number): number[][] {
  const neighbors: Set<number>[] = new Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) neighbors[i] = new Set();
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    neighbors[a].add(b);
    neighbors[a].add(c);
    neighbors[b].add(a);
    neighbors[b].add(c);
    neighbors[c].add(a);
    neighbors[c].add(b);
  }
  return neighbors.map((s) => Array.from(s));
}

/** Standard face-normal-accumulate-and-normalize — no finite-difference shortcut exists for arbitrary topology. */
export function computeVertexNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const vertexCount = positions.length / 3;
  const normals = new Float32Array(vertexCount * 3);
  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const pC = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();

  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    pA.fromArray(positions, a * 3);
    pB.fromArray(positions, b * 3);
    pC.fromArray(positions, c * 3);
    edge1.subVectors(pB, pA);
    edge2.subVectors(pC, pA);
    faceNormal.crossVectors(edge1, edge2);
    // Not normalized before accumulation: this weights each face's
    // contribution by its area, which is the standard smooth-normal blend.
    normals[a * 3] += faceNormal.x;
    normals[a * 3 + 1] += faceNormal.y;
    normals[a * 3 + 2] += faceNormal.z;
    normals[b * 3] += faceNormal.x;
    normals[b * 3 + 1] += faceNormal.y;
    normals[b * 3 + 2] += faceNormal.z;
    normals[c * 3] += faceNormal.x;
    normals[c * 3 + 1] += faceNormal.y;
    normals[c * 3 + 2] += faceNormal.z;
  }

  for (let i = 0; i < vertexCount; i++) {
    const x = normals[i * 3];
    const y = normals[i * 3 + 1];
    const z = normals[i * 3 + 2];
    const len = Math.hypot(x, y, z) || 1;
    normals[i * 3] = x / len;
    normals[i * 3 + 1] = y / len;
    normals[i * 3 + 2] = z / len;
  }
  return normals;
}

interface MutableMesh {
  positions: number[];
  indices: number[];
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

/** One loop-style split: every triangle becomes 4, new vertices at edge midpoints, deduplicated via an edge-key map so shared edges don't fork the surface. Optionally re-projects new vertices to a sphere of `projectRadius` (icosphere refinement). */
function subdivideTriangleMesh(mesh: MutableMesh, projectRadius?: number): MutableMesh {
  const positions = mesh.positions.slice();
  const midpointCache = new Map<string, number>();

  function getMidpoint(a: number, b: number): number {
    const key = edgeKey(a, b);
    const cached = midpointCache.get(key);
    if (cached !== undefined) return cached;
    let mx = (positions[a * 3] + positions[b * 3]) * 0.5;
    let my = (positions[a * 3 + 1] + positions[b * 3 + 1]) * 0.5;
    let mz = (positions[a * 3 + 2] + positions[b * 3 + 2]) * 0.5;
    if (projectRadius !== undefined) {
      const len = Math.hypot(mx, my, mz) || 1;
      const s = projectRadius / len;
      mx *= s;
      my *= s;
      mz *= s;
    }
    const idx = positions.length / 3;
    positions.push(mx, my, mz);
    midpointCache.set(key, idx);
    return idx;
  }

  const nextIndices: number[] = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t];
    const b = mesh.indices[t + 1];
    const c = mesh.indices[t + 2];
    const ab = getMidpoint(a, b);
    const bc = getMidpoint(b, c);
    const ca = getMidpoint(c, a);
    nextIndices.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
  }
  return { positions, indices: nextIndices };
}

function icosahedron(): MutableMesh {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const positions: number[] = [];
  for (const [x, y, z] of raw) {
    const len = Math.hypot(x, y, z);
    positions.push(x / len, y / len, z / len);
  }
  const indices = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
    1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
    4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ];
  return { positions, indices };
}

function buildIcosphere(radius: number, subdivisions: number): MutableMesh {
  let mesh = icosahedron();
  for (let i = 0; i < subdivisions; i++) {
    mesh = subdivideTriangleMesh(mesh, 1);
  }
  const positions = mesh.positions.map((v) => v * radius);
  return { positions, indices: mesh.indices };
}

/** Six flat NxN grids folded into a cube shell, vertices welded across face seams by position so the surface has no cracks. */
function buildSubdividedCube(size: number, segments: number): MutableMesh {
  const half = size / 2;
  const seg = Math.max(1, Math.round(segments));
  const positions: number[] = [];
  const indices: number[] = [];
  const weld = new Map<string, number>();

  function weldedVertex(x: number, y: number, z: number): number {
    const key = `${x.toFixed(5)}_${y.toFixed(5)}_${z.toFixed(5)}`;
    const cached = weld.get(key);
    if (cached !== undefined) return cached;
    const idx = positions.length / 3;
    positions.push(x, y, z);
    weld.set(key, idx);
    return idx;
  }

  // Each face: an origin corner plus two basis vectors spanning the face.
  const faces: { origin: THREE.Vector3; uAxis: THREE.Vector3; vAxis: THREE.Vector3 }[] = [
    { origin: new THREE.Vector3(-half, -half, half), uAxis: new THREE.Vector3(1, 0, 0), vAxis: new THREE.Vector3(0, 1, 0) }, // +Z
    { origin: new THREE.Vector3(half, -half, -half), uAxis: new THREE.Vector3(-1, 0, 0), vAxis: new THREE.Vector3(0, 1, 0) }, // -Z
    { origin: new THREE.Vector3(-half, half, -half), uAxis: new THREE.Vector3(1, 0, 0), vAxis: new THREE.Vector3(0, 0, 1) }, // +Y
    { origin: new THREE.Vector3(-half, -half, half), uAxis: new THREE.Vector3(1, 0, 0), vAxis: new THREE.Vector3(0, 0, -1) }, // -Y
    { origin: new THREE.Vector3(half, -half, half), uAxis: new THREE.Vector3(0, 0, -1), vAxis: new THREE.Vector3(0, 1, 0) }, // +X
    { origin: new THREE.Vector3(-half, -half, -half), uAxis: new THREE.Vector3(0, 0, 1), vAxis: new THREE.Vector3(0, 1, 0) }, // -X
  ];

  const step = size / seg;
  for (const face of faces) {
    const grid: number[][] = [];
    for (let j = 0; j <= seg; j++) {
      grid.push([]);
      for (let i = 0; i <= seg; i++) {
        const p = face.origin
          .clone()
          .addScaledVector(face.uAxis, i * step)
          .addScaledVector(face.vAxis, j * step);
        grid[j].push(weldedVertex(p.x, p.y, p.z));
      }
    }
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = grid[j][i];
        const b = grid[j][i + 1];
        const c = grid[j + 1][i + 1];
        const d = grid[j + 1][i];
        indices.push(a, b, c, a, c, d);
      }
    }
  }
  return { positions, indices };
}

function buildFlatPlane(size: number, segments: number): MutableMesh {
  const half = size / 2;
  const seg = Math.max(1, Math.round(segments));
  const step = size / seg;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= seg; j++) {
    for (let i = 0; i <= seg; i++) {
      positions.push(-half + i * step, 0, -half + j * step);
    }
  }
  const cols = seg + 1;
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * cols + i;
      const b = j * cols + i + 1;
      const c = (j + 1) * cols + i + 1;
      const d = (j + 1) * cols + i;
      indices.push(a, b, c, a, c, d);
    }
  }
  return { positions, indices };
}

/** Builds a base sculpt mesh. `subdivisions` is icosphere subdivision depth for spheres, or a grid-segment count for cube/plane. */
export function buildBasePrimitive(
  kind: SculptPrimitiveKind,
  subdivisions: number,
  size: number,
): SculptMeshData {
  let raw: MutableMesh;
  if (kind === "sphere") {
    raw = buildIcosphere(size * 0.5, Math.max(0, Math.round(subdivisions)));
  } else if (kind === "cube") {
    raw = buildSubdividedCube(size, subdivisions);
  } else {
    raw = buildFlatPlane(size, subdivisions);
  }
  const positions = new Float32Array(raw.positions);
  const indices = new Uint32Array(raw.indices);
  const normals = computeVertexNormals(positions, indices);
  return { positions, normals, indices };
}

/**
 * Writes a SculptMeshData snapshot into a live BufferGeometry. Unlike Terrain
 * (fixed vertex count, in-place mutation), dyntopo changes vertex/index
 * counts every stroke call, so this replaces the attributes outright rather
 * than mutating typed arrays in place.
 */
/** Warm red tint blended over masked (protected) areas — the mask tool is otherwise invisible, since it paints a weight with no visual trace of its own. */
const MASK_TINT_COLOR = new THREE.Color(0x2680ff);

export function meshHasActiveMask(mask: Float32Array | undefined): boolean {
  if (!mask) return false;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] > 0.001) return true;
  }
  return false;
}

/**
 * Writes a SculptMeshData snapshot into a live BufferGeometry. Unlike Terrain
 * (fixed vertex count, in-place mutation), dyntopo changes vertex/index
 * counts every stroke call, so this replaces the attributes outright rather
 * than mutating typed arrays in place.
 *
 * Returns whether the mask is currently visible (any weight > 0) — callers
 * must toggle `material.vertexColors` (and set `needsUpdate`) to match, since
 * this only touches the geometry, not the material drawing it.
 */
export function syncBufferGeometry(geometry: THREE.BufferGeometry, mesh: SculptMeshData): boolean {
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new THREE.Uint32BufferAttribute(mesh.indices, 1));
  geometry.attributes.position.needsUpdate = true;
  geometry.attributes.normal.needsUpdate = true;
  if (geometry.index) geometry.index.needsUpdate = true;

  const maskActive = meshHasActiveMask(mesh.mask);
  if (maskActive) {
    const vertexCount = mesh.positions.length / 3;
    const colors = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      const w = mesh.mask![i] ?? 0;
      colors[i * 3] = 1 + (MASK_TINT_COLOR.r - 1) * w;
      colors[i * 3 + 1] = 1 + (MASK_TINT_COLOR.g - 1) * w;
      colors[i * 3 + 2] = 1 + (MASK_TINT_COLOR.b - 1) * w;
    }
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.attributes.color.needsUpdate = true;
  } else if (geometry.attributes.color) {
    geometry.deleteAttribute("color");
  }

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return maskActive;
}

export { subdivideTriangleMesh, edgeKey };
export type { MutableMesh };
