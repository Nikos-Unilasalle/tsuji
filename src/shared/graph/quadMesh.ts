import * as THREE from "three";

export type QuadMeshShading = "auto" | "smooth" | "flat";

export interface QuadMesh {
  positions: [number, number, number][];
  faces: number[][]; // indices of vertices (4 for quads, 3 for triangles)
  uvs?: [number, number][];
  faceUVs?: [number, number][][];
  shading?: QuadMeshShading;
  faceShading?: QuadMeshShading[];
}

export function cloneQuadMesh(mesh: QuadMesh): QuadMesh {
  return {
    positions: mesh.positions.map((p) => [p[0], p[1], p[2]]),
    faces: mesh.faces.map((f) => [...f]),
    uvs: mesh.uvs ? mesh.uvs.map((uv) => [uv[0], uv[1]]) : undefined,
    faceUVs: mesh.faceUVs ? mesh.faceUVs.map((fuv) => fuv.map((uv) => [uv[0], uv[1]])) : undefined,
    shading: mesh.shading,
    faceShading: mesh.faceShading ? [...mesh.faceShading] : undefined,
  };
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
  const faceUVs: [number, number][][] = [];

  // Calculate overall mesh bounding box and uniform isotropic span
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (const p of next.positions) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
    if (p[2] < minZ) minZ = p[2];
    if (p[2] > maxZ) maxZ = p[2];
  }

  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const spanZ = maxZ - minZ || 1;
  const span = Math.max(spanX, spanY, spanZ) || 1;

  for (let f = 0; f < next.faces.length; f++) {
    const face = next.faces[f];
    if (face.length === 0) {
      faceUVs.push([]);
      continue;
    }
    const n = computeFaceNormal(next.positions, face);
    const absX = Math.abs(n.x);
    const absY = Math.abs(n.y);
    const absZ = Math.abs(n.z);

    const uvsForFace: [number, number][] = [];

    for (const vIdx of face) {
      const p = next.positions[vIdx];
      let u = 0;
      let v = 0;

      if (absX >= absY && absX >= absZ) {
        // YZ plane (Right/Left)
        // Right (+X): look from +X towards origin -> U along -Z, V along +Y
        // Left (-X): look from -X towards origin -> U along +Z, V along +Y
        u = n.x > 0 ? (maxZ - p[2]) / span : (p[2] - minZ) / span;
        v = (p[1] - minY) / span;
      } else if (absY >= absX && absY >= absZ) {
        // XZ plane (Top/Bottom)
        // Top (+Y): look from +Y down -> U along +X, V along -Z
        // Bottom (-Y): look from -Y up -> U along +X, V along +Z
        u = (p[0] - minX) / span;
        v = n.y > 0 ? (maxZ - p[2]) / span : (p[2] - minZ) / span;
      } else {
        // XY plane (Front/Back)
        // Front (+Z): look from +Z towards origin -> U along +X, V along +Y
        // Back (-Z): look from -Z towards origin -> U along -X, V along +Y
        u = n.z > 0 ? (p[0] - minX) / span : (maxX - p[0]) / span;
        v = (p[1] - minY) / span;
      }

      uvsForFace.push([u, v]);
    }

    faceUVs.push(uvsForFace);
  }

  next.faceUVs = faceUVs;
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
  const indices: number[] = [];

  if (isPureSmooth) {
    for (const p of mesh.positions) {
      positions.push(p[0], p[1], p[2]);
    }
    if (mesh.uvs && mesh.uvs.length === mesh.positions.length) {
      for (const uv of mesh.uvs) {
        uvs.push(uv[0], uv[1]);
      }
    }

    for (const face of mesh.faces) {
      if (face.length === 4) {
        indices.push(face[0], face[1], face[2]);
        indices.push(face[0], face[2], face[3]);
      } else if (face.length === 3) {
        indices.push(face[0], face[1], face[2]);
      } else if (face.length > 4) {
        for (let i = 1; i < face.length - 1; i++) {
          indices.push(face[0], face[i], face[i + 1]);
        }
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    if (uvs.length > 0) {
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    }
    geometry.setIndex(indices);
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

  for (let f = 0; f < numFaces; f++) {
    const face = mesh.faces[f];
    const vertIndices: number[] = [];
    for (let i = 0; i < face.length; i++) {
      vertIndices.push(addVertex(face[i], f, i));
    }

    if (face.length === 4) {
      indices.push(vertIndices[0], vertIndices[1], vertIndices[2]);
      indices.push(vertIndices[0], vertIndices[2], vertIndices[3]);
    } else if (face.length === 3) {
      indices.push(vertIndices[0], vertIndices[1], vertIndices[2]);
    } else if (face.length > 4) {
      for (let i = 1; i < face.length - 1; i++) {
        indices.push(vertIndices[0], vertIndices[i], vertIndices[i + 1]);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  if (uvs.length > 0) {
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  }
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.quadMesh = cloneQuadMesh(mesh);
  return geometry;
}

/**
 * Converts a BufferGeometry to a QuadMesh.
 * If `userData.quadMesh` exists, uses that directly.
 * Otherwise reconstructs quads from adjacent coplanar triangles and preserves UVs.
 */
export function bufferGeometryToQuadMesh(geometry: THREE.BufferGeometry): QuadMesh {
  if (geometry.userData.quadMesh) {
    return cloneQuadMesh(geometry.userData.quadMesh);
  }

  const posAttr = geometry.attributes.position;
  if (!posAttr) return createQuadBox();
  const uvAttr = geometry.attributes.uv;

  // Simple conversion: extract welded positions and find quad pairs
  const vertexMap = new Map<string, number>();
  const positions: [number, number, number][] = [];
  const vertexRemap: number[] = [];

  for (let i = 0; i < posAttr.count; i++) {
    const x = Math.round(posAttr.getX(i) * 10000) / 10000;
    const y = Math.round(posAttr.getY(i) * 10000) / 10000;
    const z = Math.round(posAttr.getZ(i) * 10000) / 10000;
    const key = `${x},${y},${z}`;
    let idx = vertexMap.get(key);
    if (idx === undefined) {
      idx = positions.length;
      positions.push([posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)]);
      vertexMap.set(key, idx);
    }
    vertexRemap.push(idx);
  }

  const index = geometry.index;
  const triCount = index ? index.count / 3 : posAttr.count / 3;
  const triangles: [number, number, number][] = [];
  const triUVs: [number, number][][] = [];

  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const a = vertexRemap[i0];
    const b = vertexRemap[i1];
    const c = vertexRemap[i2];
    if (a !== b && b !== c && c !== a) {
      triangles.push([a, b, c]);
      if (uvAttr) {
        triUVs.push([
          [uvAttr.getX(i0), uvAttr.getY(i0)],
          [uvAttr.getX(i1), uvAttr.getY(i1)],
          [uvAttr.getX(i2), uvAttr.getY(i2)],
        ]);
      }
    }
  }

  // Pair up adjacent coplanar triangles into quads
  const edgeToTriangles = new Map<string, number[]>();
  for (let t = 0; t < triangles.length; t++) {
    const tri = triangles[t];
    for (let e = 0; e < 3; e++) {
      const u = Math.min(tri[e], tri[(e + 1) % 3]);
      const v = Math.max(tri[e], tri[(e + 1) % 3]);
      const key = `${u}_${v}`;
      const arr = edgeToTriangles.get(key) ?? [];
      arr.push(t);
      edgeToTriangles.set(key, arr);
    }
  }

  const paired = new Set<number>();
  const faces: number[][] = [];
  const faceUVs: [number, number][][] = [];

  function getTriCornerUV(tIdx: number, vIdx: number): [number, number] {
    if (!uvAttr || !triUVs[tIdx]) return [0, 0];
    const tri = triangles[tIdx];
    const pos = tri.indexOf(vIdx);
    return pos >= 0 ? triUVs[tIdx][pos] : [0, 0];
  }

  for (const [edgeKey, triIndices] of edgeToTriangles.entries()) {
    if (triIndices.length !== 2) continue;
    const [t0, t1] = triIndices;
    if (paired.has(t0) || paired.has(t1)) continue;

    const tri0 = triangles[t0];
    const tri1 = triangles[t1];
    const norm0 = computeFaceNormal(positions, tri0);
    const norm1 = computeFaceNormal(positions, tri1);

    // If normals are parallel (coplanar)
    if (norm0.dot(norm1) > 0.99) {
      const [uStr, vStr] = edgeKey.split("_");
      const u = Number(uStr);
      const v = Number(vStr);

      const other0 = tri0.find((idx) => idx !== u && idx !== v)!;
      const other1 = tri1.find((idx) => idx !== u && idx !== v)!;

      // Construct quad preserving orientation
      const e0 = tri0.indexOf(u);
      const next0 = tri0[(e0 + 1) % 3];
      let quad: number[];
      if (next0 === v) {
        // u -> v in tri0
        quad = [other0, u, other1, v];
      } else {
        // v -> u in tri0
        quad = [other0, v, other1, u];
      }
      faces.push(quad);

      if (uvAttr) {
        const uvsForQuad: [number, number][] = quad.map((vIdx) => {
          if (tri0.includes(vIdx)) return getTriCornerUV(t0, vIdx);
          return getTriCornerUV(t1, vIdx);
        });
        faceUVs.push(uvsForQuad);
      }

      paired.add(t0);
      paired.add(t1);
    }
  }

  // Add remaining un-paired triangles
  for (let t = 0; t < triangles.length; t++) {
    if (!paired.has(t)) {
      faces.push(triangles[t]);
      if (uvAttr && triUVs[t]) {
        faceUVs.push(triUVs[t]);
      }
    }
  }

  const result: QuadMesh = { positions, faces };
  if (uvAttr && faceUVs.length === faces.length) {
    result.faceUVs = faceUVs;
  } else {
    return boxProjectUVs(result);
  }

  return result;
}

/**
 * Extrudes the selected face(s) outward along their averaged face normal.
 * Duplicates vertices, shifts them along the normal, updates cap faces,
 * and stitches quad side walls around the boundary edges of the selection.
 */
export function extrudeFaces(
  mesh: QuadMesh,
  selectedFaceIndices: number[],
  distance = 0.5,
): { mesh: QuadMesh; newFaces: number[] } {
  if (selectedFaceIndices.length === 0 || distance === 0) {
    return { mesh: cloneQuadMesh(mesh), newFaces: [...selectedFaceIndices] };
  }

  const next = cloneQuadMesh(mesh);

  // Map each selected vertex to its average normal
  const vertexNormals = new Map<number, THREE.Vector3>();
  for (const fIdx of selectedFaceIndices) {
    const face = next.faces[fIdx];
    if (!face) continue;
    const norm = computeFaceNormal(next.positions, face);
    for (const v of face) {
      const existing = vertexNormals.get(v) ?? new THREE.Vector3();
      existing.add(norm);
      vertexNormals.set(v, existing);
    }
  }

  // Duplicate vertices for the extruded patch
  const oldToNew = new Map<number, number>();
  for (const [vIdx, sumNorm] of vertexNormals.entries()) {
    const norm = sumNorm.normalize();
    const oldP = next.positions[vIdx];
    const newP: [number, number, number] = [
      oldP[0] + norm.x * distance,
      oldP[1] + norm.y * distance,
      oldP[2] + norm.z * distance,
    ];
    const newIdx = next.positions.length;
    next.positions.push(newP);
    oldToNew.set(vIdx, newIdx);
  }

  // Update extruded cap faces to reference the new vertices
  for (const fIdx of selectedFaceIndices) {
    const face = next.faces[fIdx];
    if (!face) continue;
    next.faces[fIdx] = face.map((v) => oldToNew.get(v) ?? v);
  }

  // Find boundary directed edges of the selected face patch
  interface DirectedEdge {
    u: number;
    v: number;
  }
  const edgeCounts = new Map<string, { count: number; edge: DirectedEdge }>();
  for (const fIdx of selectedFaceIndices) {
    const face = mesh.faces[fIdx]; // use original vertex indices before duplication
    if (!face) continue;
    const len = face.length;
    for (let i = 0; i < len; i++) {
      const u = face[i];
      const v = face[(i + 1) % len];
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      const entry = edgeCounts.get(key) ?? { count: 0, edge: { u, v } };
      entry.count++;
      edgeCounts.set(key, entry);
    }
  }

  // An edge with count === 1 is on the boundary of the selected region: create a quad wall
  for (const { count, edge } of edgeCounts.values()) {
    if (count === 1) {
      const { u, v } = edge;
      const u2 = oldToNew.get(u);
      const v2 = oldToNew.get(v);
      if (u2 !== undefined && v2 !== undefined) {
        // Wall winding: [u, v, v2, u2]
        next.faces.push([u, v, v2, u2]);
      }
    }
  }

  return { mesh: boxProjectUVs(next), newFaces: [...selectedFaceIndices] };
}

/**
 * Insets the selected face(s) by scaling inner vertices toward the centroid.
 * Creates an inner quad and 4 surrounding quad border faces.
 */
export function insetFaces(
  mesh: QuadMesh,
  selectedFaceIndices: number[],
  insetRatio = 0.25,
): { mesh: QuadMesh; newFaces: number[] } {
  if (selectedFaceIndices.length === 0 || insetRatio <= 0) {
    return { mesh: cloneQuadMesh(mesh), newFaces: [...selectedFaceIndices] };
  }

  const next = cloneQuadMesh(mesh);
  const ratio = Math.max(0.01, Math.min(0.95, insetRatio));
  const newInnerFaceIndices: number[] = [];

  for (const fIdx of selectedFaceIndices) {
    const face = next.faces[fIdx];
    if (!face || face.length !== 4) continue;

    const [v0, v1, v2, v3] = face;
    const c = computeFaceCentroid(next.positions, face);

    // Create 4 inner vertices
    const innerIndices: number[] = [];
    for (const v of [v0, v1, v2, v3]) {
      const p = next.positions[v];
      const newX = p[0] + (c.x - p[0]) * ratio;
      const newY = p[1] + (c.y - p[1]) * ratio;
      const newZ = p[2] + (c.z - p[2]) * ratio;
      const newIdx = next.positions.length;
      next.positions.push([newX, newY, newZ]);
      innerIndices.push(newIdx);
    }

    const [i0, i1, i2, i3] = innerIndices;

    // Replace original face with the inner quad
    next.faces[fIdx] = [i0, i1, i2, i3];
    newInnerFaceIndices.push(fIdx);

    // Add 4 surrounding border quads
    next.faces.push([v0, v1, i1, i0]);
    next.faces.push([v1, v2, i2, i1]);
    next.faces.push([v2, v3, i3, i2]);
    next.faces.push([v3, v0, i0, i3]);
  }

  return { mesh: boxProjectUVs(next), newFaces: newInnerFaceIndices };
}

/**
 * Performs a loop cut across a continuous loop of quads.
 * Splits every quad in the loop into two quads at ratio `t` (default 0.5).
 */
/**
 * Performs a loop cut across a continuous loop of quads.
 * Splits every quad in the loop into `cuts + 1` quads.
 * `cutsOrRatio`: either the number of cuts (integer >= 1) or a specific cut ratio t (0 < t < 1).
 */
export function loopCut(
  mesh: QuadMesh,
  startEdge: [number, number],
  cutsOrRatio: number = 1,
): { mesh: QuadMesh; newEdgeIndices: [number, number][]; newVertexIndices: number[] } {
  const next = cloneQuadMesh(mesh);

  const isSingleRatio = cutsOrRatio > 0 && cutsOrRatio < 1;
  const numCuts = isSingleRatio ? 1 : Math.max(1, Math.min(32, Math.round(cutsOrRatio)));

  const ratios: number[] = [];
  if (isSingleRatio) {
    ratios.push(Math.max(0.05, Math.min(0.95, cutsOrRatio)));
  } else {
    for (let k = 0; k < numCuts; k++) {
      ratios.push((k + 1) / (numCuts + 1));
    }
  }

  const [u0, v0] = startEdge;
  const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);

  // Map each undirected edge to faces that contain it
  const edgeToFaces = new Map<string, number[]>();
  for (let f = 0; f < next.faces.length; f++) {
    const face = next.faces[f];
    for (let i = 0; i < face.length; i++) {
      const a = face[i];
      const b = face[(i + 1) % face.length];
      const key = edgeKey(a, b);
      const arr = edgeToFaces.get(key) ?? [];
      arr.push(f);
      edgeToFaces.set(key, arr);
    }
  }

  // Find start face containing the start edge
  const initialFaces = edgeToFaces.get(edgeKey(u0, v0));
  if (!initialFaces || initialFaces.length === 0) {
    return { mesh: next, newEdgeIndices: [], newVertexIndices: [] };
  }

  // Traverse quads across opposite edges
  const visitedFaces = new Set<number>();
  const facesToSplit: { faceIndex: number; edgeA: [number, number]; edgeB: [number, number] }[] = [];

  let currentFace = initialFaces[0];
  let inEdge: [number, number] = [u0, v0];

  const maxSteps = next.faces.length;
  for (let step = 0; step < maxSteps; step++) {
    if (visitedFaces.has(currentFace)) break;
    visitedFaces.add(currentFace);

    const face = next.faces[currentFace];
    if (face.length !== 4) break;

    // Find inEdge in face
    let inIdx = -1;
    for (let i = 0; i < 4; i++) {
      const a = face[i];
      const b = face[(i + 1) % 4];
      if ((a === inEdge[0] && b === inEdge[1]) || (a === inEdge[1] && b === inEdge[0])) {
        inIdx = i;
        break;
      }
    }
    if (inIdx === -1) break;

    // The opposite edge is at (inIdx + 2) % 4
    const oppA = face[(inIdx + 2) % 4];
    const oppB = face[(inIdx + 3) % 4];
    const oppEdge: [number, number] = [oppA, oppB];

    facesToSplit.push({
      faceIndex: currentFace,
      edgeA: [face[inIdx], face[(inIdx + 1) % 4]],
      edgeB: oppEdge,
    });

    // Find next face sharing oppEdge
    const neighbors = edgeToFaces.get(edgeKey(oppA, oppB));
    const nextFace = neighbors?.find((f) => f !== currentFace);
    if (nextFace === undefined || visitedFaces.has(nextFace)) {
      break;
    }
    currentFace = nextFace;
    inEdge = oppEdge;
  }

  if (facesToSplit.length === 0) {
    return { mesh: next, newEdgeIndices: [], newVertexIndices: [] };
  }

  // Canonical edge division points: ensures vertices on shared edges are identical across adjacent faces
  const edgePoints = new Map<string, number>();
  const newVertexIndices: number[] = [];

  function getOrAddEdgePoint(a: number, b: number, tFromA: number): number {
    const u = Math.min(a, b);
    const v = Math.max(a, b);
    const tFromU = a < b ? tFromA : 1 - tFromA;
    const tKey = Math.round(tFromU * 10000);
    const key = `${u}_${v}_${tKey}`;
    const existing = edgePoints.get(key);
    if (existing !== undefined) return existing;

    const pu = next.positions[u];
    const pv = next.positions[v];
    const pt: [number, number, number] = [
      pu[0] + (pv[0] - pu[0]) * tFromU,
      pu[1] + (pv[1] - pu[1]) * tFromU,
      pu[2] + (pv[2] - pu[2]) * tFromU,
    ];
    const newIdx = next.positions.length;
    next.positions.push(pt);
    edgePoints.set(key, newIdx);
    newVertexIndices.push(newIdx);
    return newIdx;
  }

  const newEdgeIndices: [number, number][] = [];

  for (const item of facesToSplit) {
    const face = next.faces[item.faceIndex];
    let idxA = -1;
    for (let i = 0; i < 4; i++) {
      const a = face[i];
      const b = face[(i + 1) % 4];
      if ((a === item.edgeA[0] && b === item.edgeA[1]) || (a === item.edgeA[1] && b === item.edgeA[0])) {
        idxA = i;
        break;
      }
    }
    if (idxA === -1) continue;

    const v0 = face[idxA];
    const v1 = face[(idxA + 1) % 4];
    const v2 = face[(idxA + 2) % 4];
    const v3 = face[(idxA + 3) % 4];

    // Division points along (v0 -> v1) and opposite (v3 -> v2)
    const ptsA: number[] = [];
    const ptsB: number[] = [];
    for (const r of ratios) {
      const mA = getOrAddEdgePoint(v0, v1, r);
      const mB = getOrAddEdgePoint(v3, v2, r);
      ptsA.push(mA);
      ptsB.push(mB);
      newEdgeIndices.push([mA, mB]);
    }

    const rowA = [v0, ...ptsA, v1];
    const rowB = [v3, ...ptsB, v2];

    // First sub-quad replaces the original face
    next.faces[item.faceIndex] = [rowA[0], rowA[1], rowB[1], rowB[0]];

    // Remaining sub-quads are appended
    for (let i = 1; i <= numCuts; i++) {
      next.faces.push([rowA[i], rowA[i + 1], rowB[i + 1], rowB[i]]);
    }
  }

  // Update UVs for all faces
  const unwrapped = boxProjectUVs(next);

  return { mesh: unwrapped, newEdgeIndices, newVertexIndices };
}

/**
 * Calculates 3D line segments representing the loop cut preview lines across quads.
 * Used for real-time hover feedback in the viewport before clicking.
 * `cutsOrRatio`: either the number of cuts (integer >= 1) or a specific cut ratio t (0 < t < 1).
 */
export function getLoopCutPreviewSegments(
  mesh: QuadMesh,
  startEdge: [number, number],
  cutsOrRatio: number = 1,
): [ [number, number, number], [number, number, number] ][] {
  const isSingleRatio = cutsOrRatio > 0 && cutsOrRatio < 1;
  const numCuts = isSingleRatio ? 1 : Math.max(1, Math.min(32, Math.round(cutsOrRatio)));

  const ratios: number[] = [];
  if (isSingleRatio) {
    ratios.push(Math.max(0.05, Math.min(0.95, cutsOrRatio)));
  } else {
    for (let k = 0; k < numCuts; k++) {
      ratios.push((k + 1) / (numCuts + 1));
    }
  }

  const [u0, v0] = startEdge;
  const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);

  const edgeToFaces = new Map<string, number[]>();
  for (let f = 0; f < mesh.faces.length; f++) {
    const face = mesh.faces[f];
    for (let i = 0; i < face.length; i++) {
      const a = face[i];
      const b = face[(i + 1) % face.length];
      const key = edgeKey(a, b);
      const arr = edgeToFaces.get(key) ?? [];
      arr.push(f);
      edgeToFaces.set(key, arr);
    }
  }

  const initialFaces = edgeToFaces.get(edgeKey(u0, v0));
  if (!initialFaces || initialFaces.length === 0) return [];

  const segments: [ [number, number, number], [number, number, number] ][] = [];
  const visitedFaces = new Set<number>();

  let currentFace = initialFaces[0];
  let inEdge: [number, number] = [u0, v0];

  const maxSteps = mesh.faces.length;
  for (let step = 0; step < maxSteps; step++) {
    if (visitedFaces.has(currentFace)) break;
    visitedFaces.add(currentFace);

    const face = mesh.faces[currentFace];
    if (face.length !== 4) break;

    let inIdx = -1;
    for (let i = 0; i < 4; i++) {
      const a = face[i];
      const b = face[(i + 1) % 4];
      if ((a === inEdge[0] && b === inEdge[1]) || (a === inEdge[1] && b === inEdge[0])) {
        inIdx = i;
        break;
      }
    }
    if (inIdx === -1) break;

    const oppA = face[(inIdx + 2) % 4];
    const oppB = face[(inIdx + 3) % 4];
    const oppEdge: [number, number] = [oppA, oppB];

    const pa = mesh.positions[face[inIdx]];
    const pb = mesh.positions[face[(inIdx + 1) % 4]];
    const pc = mesh.positions[oppA];
    const pd = mesh.positions[oppB];

    if (pa && pb && pc && pd) {
      for (const r of ratios) {
        const midA: [number, number, number] = [
          pa[0] + (pb[0] - pa[0]) * r,
          pa[1] + (pb[1] - pa[1]) * r,
          pa[2] + (pb[2] - pa[2]) * r,
        ];
        const midB: [number, number, number] = [
          pd[0] + (pc[0] - pd[0]) * r,
          pd[1] + (pc[1] - pd[1]) * r,
          pd[2] + (pc[2] - pd[2]) * r,
        ];
        segments.push([midA, midB]);
      }
    }

    const neighbors = edgeToFaces.get(edgeKey(oppA, oppB));
    const nextFace = neighbors?.find((f) => f !== currentFace);
    if (nextFace === undefined || visitedFaces.has(nextFace)) {
      break;
    }
    currentFace = nextFace;
    inEdge = oppEdge;
  }

  return segments;
}

/**
 * Transforms the selected points or faces around their centroid.
 */
export function transformSelection(
  mesh: QuadMesh,
  mode: "points" | "faces",
  selectedIndices: number[],
  delta: { position: THREE.Vector3; rotation: THREE.Quaternion; scale: THREE.Vector3 },
  centroid: THREE.Vector3,
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

  const next = cloneQuadMesh(mesh);
  const p = new THREE.Vector3();

  for (const vIdx of targetVertexIndices) {
    const raw = next.positions[vIdx];
    p.set(raw[0] - centroid.x, raw[1] - centroid.y, raw[2] - centroid.z);

    // Apply scale relative to centroid
    p.multiply(delta.scale);
    // Apply rotation relative to centroid
    p.applyQuaternion(delta.rotation);
    // Apply position offset
    p.add(centroid).add(delta.position);

    next.positions[vIdx] = [p.x, p.y, p.z];
  }

  return next;
}
