import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Flattening a whole object tree into one world-space geometry.
 *
 * Two features need exactly this and used to want it for different reasons:
 * Boolean, which must hand the CSG evaluator a single brush per side, and
 * Freeze, which turns whatever a node is currently producing into a static
 * mesh. Both start from the same problem — a `geometry` socket carries a
 * tree, and Array / Merge / an imported model all hand down a Group of many
 * meshes — so the flattening lives here rather than twice.
 */

/**
 * The attributes worth keeping. Everything else is dropped before merging,
 * because mergeGeometries requires every part to carry the exact same
 * attribute set — and the parts of one tree routinely come from different
 * sources (an Array of one primitive merged with a hand-placed second shape),
 * which would otherwise refuse to merge at all.
 */
const KEPT_ATTRIBUTES = ["position", "normal", "uv"];

/**
 * Every mesh baked into one geometry, in world space.
 *
 * The parts are concatenated rather than boolean-unioned: for disjoint solids
 * (what an Array produces) a merged multi-shell geometry is exactly right,
 * and it costs one O(n) copy instead of n CSG passes. Parts that overlap each
 * other keep their interior faces, which is correct for a freeze — it is a
 * snapshot of what was on screen, not a repair pass.
 *
 * Returns null when there is nothing to bake, or when the parts cannot be
 * reconciled into one buffer; callers are expected to treat that as "no
 * result" rather than an error, since both of their fallbacks are to leave
 * the graph alone.
 */
export function bakeMeshesToGeometry(meshes: THREE.Mesh[]): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = [];
  for (const mesh of meshes) {
    const geometry = mesh.geometry.clone();
    for (const name of Object.keys(geometry.attributes)) {
      if (!KEPT_ATTRIBUTES.includes(name)) geometry.deleteAttribute(name);
    }
    // Morph targets do not survive a merge and mean nothing once baked.
    geometry.morphAttributes = {};
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    if (!geometry.attributes.uv) {
      // A missing uv on one part alone would block the merge; an empty one
      // costs two floats a vertex and keeps every part's attribute set equal.
      geometry.setAttribute(
        "uv",
        new THREE.BufferAttribute(new Float32Array(geometry.attributes.position.count * 2), 2),
      );
    }
    // World space, so the parts meet wherever they were actually placed.
    geometry.applyMatrix4(mesh.matrixWorld);
    parts.push(geometry);
  }

  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];

  // mergeGeometries also requires every part to agree on being indexed;
  // flatten them all only when they actually disagree.
  const mixedIndexing = parts.some((p) => p.index === null);
  const normalized = parts.map((part) => {
    if (!mixedIndexing || !part.index) return part;
    const flat = part.toNonIndexed();
    part.dispose();
    return flat;
  });

  // Grouped so a caller that cares about materials (Boolean) can hand back a
  // per-part material array lined up with these groups' materialIndex; Freeze
  // ignores groups entirely, so they cost it nothing.
  const merged = mergeGeometries(normalized, true);
  for (const part of normalized) part.dispose();
  return merged;
}

/** Each mesh's own material, single or first-of-array, in the same order as
 * the `meshes` passed to `bakeMeshesToGeometry` — lines up with the groups
 * (materialIndex 0..n-1) that function's merged geometry carries. */
export function collectMeshMaterials(meshes: THREE.Mesh[]): THREE.Material[] {
  return meshes.map((mesh) => (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material));
}

/** The plain, JSON-serializable form a Frozen Geometry node stores in its params. */
export interface FrozenGeometryData {
  positions: number[];
  normals: number[];
  uvs: number[];
  index: number[] | null;
}

/**
 * A geometry as plain number arrays.
 *
 * `Array.from` rather than the typed array itself: params are saved with
 * `JSON.parse(JSON.stringify(...))` (see storage.ts's cleanGraph), and a
 * Float32Array serializes to an OBJECT keyed by index — `{"0": 1, "1": 2}` —
 * which would reload as something no attribute constructor accepts.
 */
export function geometryToFrozenData(geometry: THREE.BufferGeometry): FrozenGeometryData {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  const index = geometry.getIndex();
  return {
    positions: Array.from(position.array as ArrayLike<number>),
    normals: normal ? Array.from(normal.array as ArrayLike<number>) : [],
    uvs: uv ? Array.from(uv.array as ArrayLike<number>) : [],
    index: index ? Array.from(index.array as ArrayLike<number>) : null,
  };
}
