import * as THREE from "three";
import { boxProjectUVs, quadMeshToBufferGeometry, type PolyMesh, type QuadMeshShading } from "../quadMesh";
import { findFirstMesh } from "../meshRequired";
import { importBufferGeometry } from "./importGeometry";
import { normalizeAttributes } from "./polyAttributes";
import { inferFaceMap, propagateAttributes } from "./propagate";
import { PointTree } from "./spatial";

/*
 * The one way geometry nodes read and write the modelling mesh.
 *
 * A mesh travels between nodes as a THREE.Mesh whose geometry carries its
 * PolyMesh in `userData.quadMesh` and, beside it, `userData.polyVertexOf`
 * (which PolyMesh vertex each buffer vertex was made for). Reading:
 *
 *  1. The geometry is one quadMeshToBufferGeometry built and nothing moved
 *     its vertices since → its PolyMesh, as is.
 *  2. A node downstream cloned the geometry and moved the vertices (Twist,
 *     Wave, Lattice — they predate PolyMesh and copy userData by reference,
 *     so the clone still names the undeformed mesh) → the PolyMesh with its
 *     positions read back through polyVertexOf. Topology, attributes and
 *     groups survive the deformer.
 *  3. The vertex layout changed (a node rebuilt the geometry some other way)
 *     → re-imported from the triangles, attributes carried over from the
 *     stale PolyMesh by nearest point / face.
 *  4. No PolyMesh at all (imports, older nodes) → re-imported.
 *
 * Results are cached per geometry and position-buffer version, so reading
 * the same upstream output every frame costs a WeakMap lookup.
 */

interface ReadCacheEntry {
  version: number;
  indexVersion: number;
  source: unknown;
  mesh: PolyMesh;
}
const readCache = new WeakMap<THREE.BufferGeometry, ReadCacheEntry>();

export function polyMeshFromGeometry(geometry: THREE.BufferGeometry): PolyMesh | null {
  const pos = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!pos) return null;
  const stored = geometry.userData?.quadMesh as PolyMesh | undefined;
  const hit = readCache.get(geometry);
  if (hit && hit.version === pos.version && hit.indexVersion === (geometry.index?.version ?? -1) && hit.source === stored) return hit.mesh;

  const mesh = computePolyMesh(geometry, pos, stored);
  if (mesh) readCache.set(geometry, { version: pos.version, indexVersion: geometry.index?.version ?? -1, source: stored, mesh });
  return mesh;
}

function computePolyMesh(geometry: THREE.BufferGeometry, pos: THREE.BufferAttribute, stored: PolyMesh | undefined): PolyMesh | null {
  const vertexOf = geometry.userData?.polyVertexOf as ArrayLike<number> | undefined;
  if (stored && vertexOf && vertexOf.length === pos.count && fits(vertexOf, stored.positions.length) && trianglesMatch(geometry, stored)) {
    let moved = false;
    const positions = stored.positions.map((p) => [p[0], p[1], p[2]] as [number, number, number]);
    for (let i = 0; i < pos.count; i++) {
      const v = vertexOf[i];
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const p = positions[v];
      if (Math.abs(p[0] - x) > 1e-7 || Math.abs(p[1] - y) > 1e-7 || Math.abs(p[2] - z) > 1e-7) {
        moved = true;
        p[0] = x;
        p[1] = y;
        p[2] = z;
      }
    }
    return moved ? { ...stored, positions } : stored;
  }

  const imported = importBufferGeometry(geometry);
  if (!imported) return null;
  const fresh = imported.faceUVs ? imported : boxProjectUVs(imported);
  // A node that built this geometry from scratch (Boolean, Weld, Fracture…)
  // leaves no PolyMesh, but emitModifiedMesh notes the one it started from,
  // so its attributes and groups carry over by proximity.
  const source = stored ?? (geometry.userData?.polyAttributeSource as PolyMesh | undefined);
  if (!source?.attributes) return fresh;
  return transferByNearest(source, fresh);
}

/**
 * Called by emitModifiedMesh for every new geometry a modifier hands out: when
 * the geometry carries no PolyMesh of its own but the mesh it was made from
 * had attributes, remember that mesh so a parametric node downstream can
 * recover the attributes (lazily — nothing is computed unless something
 * reads them).
 */
export function notePolyAttributeSource(geometry: THREE.BufferGeometry, sourceGeometry: THREE.BufferGeometry | undefined): void {
  if (!sourceGeometry || geometry === sourceGeometry) return;
  if (geometry.userData?.quadMesh || geometry.userData?.polyAttributeSource) return;
  const hasPoly = sourceGeometry.userData?.quadMesh || sourceGeometry.userData?.polyAttributeSource;
  if (!hasPoly) return;
  const source = polyMeshFromGeometry(sourceGeometry);
  if (!source?.attributes) return;
  const a = source.attributes;
  const any = [a.point, a.face, a.corner, a.edge].some((r) => r && Object.keys(r).length > 0);
  if (any) geometry.userData = { ...geometry.userData, polyAttributeSource: source };
}

/**
 * The geometry still draws the stored mesh's faces: a node that cloned the
 * geometry and rewrote its index (legacy Delete Geometry) keeps the vertex
 * buffer — so polyVertexOf still fits — but not the faces.
 */
function trianglesMatch(geometry: THREE.BufferGeometry, mesh: PolyMesh): boolean {
  let expected = 0;
  for (const f of mesh.faces) if (f.length >= 3) expected += f.length - 2;
  const drawn = geometry.index ? geometry.index.count / 3 : (geometry.getAttribute("position")?.count ?? 0) / 3;
  return drawn === expected;
}

function fits(map: ArrayLike<number>, n: number): boolean {
  for (let i = 0; i < map.length; i++) if (!(map[i] >= 0 && map[i] < n)) return false;
  return true;
}

/** Attributes of `src` onto an unrelated mesh `out`, point by nearest point, face by nearest centroid. */
export function transferByNearest(src: PolyMesh, out: PolyMesh): PolyMesh {
  if (src.positions.length === 0) return out;
  const tree = new PointTree(src.positions);
  const point = new Int32Array(out.positions.length);
  out.positions.forEach((p, i) => (point[i] = tree.nearest(p[0], p[1], p[2]).index));
  // inferFaceMap's "same index" shortcut would be wrong here: force nearest.
  const face = inferFaceMap({ ...src, faces: [] }, out, point);
  if (src.faces.length) {
    const centroids = src.faces.map((f) => centroidOf(src, f));
    const faceTree = new PointTree(centroids);
    out.faces.forEach((f, i) => {
      const c = centroidOf(out, f);
      face[i] = faceTree.nearest(c[0], c[1], c[2]).index;
    });
  }
  return propagateAttributes(src, out, { point, face });
}

function centroidOf(mesh: PolyMesh, face: readonly number[]): [number, number, number] {
  let x = 0, y = 0, z = 0;
  for (const v of face) {
    const p = mesh.positions[v];
    x += p[0];
    y += p[1];
    z += p[2];
  }
  const n = face.length || 1;
  return [x / n, y / n, z / n];
}

export interface PolyInput {
  /** The modelling mesh, in the source mesh's local space. */
  mesh: PolyMesh;
  /** The THREE.Mesh it was read from (pose, material and userData come from it). */
  srcMesh: THREE.Mesh;
}

/** The PolyMesh of the first mesh under `object`, or null when there is none. */
export function readPolyMesh(object: THREE.Object3D | null | undefined): PolyInput | null {
  if (!object) return null;
  const srcMesh = findFirstMesh(object);
  if (!srcMesh?.geometry) return null;
  const mesh = polyMeshFromGeometry(srcMesh.geometry);
  return mesh ? { mesh, srcMesh } : null;
}

/**
 * Geometry for a PolyMesh, carrying the mesh (and the vertex map that lets
 * the next node recover it) in userData. Attribute arrays are brought to
 * their domain lengths first.
 */
export function polyMeshToGeometry(mesh: PolyMesh, shading?: QuadMeshShading): THREE.BufferGeometry {
  return quadMeshToBufferGeometry(normalizeAttributes(mesh), shading);
}
