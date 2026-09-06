import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { IndexedMesh, subdivide as runSubdivide, SubdivisionMode } from "../subdivision";
import { NodeDefinition } from "../types";
import { clearMeshWarning, findFirstMesh, warnMeshRequired } from "../meshRequired";
import { primitiveOutputs } from "./object";
import { preserveModifierUserData } from "./transform";


interface SubdivideState {
  mesh?: THREE.Mesh;
  /** Skips re-running the algorithm when neither the source geometry nor the params changed since last frame — a few subdivision levels of Catmull-Clark is real CPU work, not free to redo 60 times a second. */
  lastSignature?: string;
}

const subdivideCache = createNodeCache<SubdivideState>((s) => {
  if (s.mesh) disposeObject3D(s.mesh);
});

function getState(nodeId: string): SubdivideState {
  let state = subdivideCache.get(nodeId);
  if (!state) {
    state = {};
    subdivideCache.set(nodeId, state);
  }
  return state;
}

/**
 * Extracts a plain indexed, *welded* {positions, indices} pair from a
 * source geometry — subdivision.ts's algorithms both assume a shared-vertex
 * mesh (an edge point is computed once and reused by both triangles either
 * side of it; a vertex point needs the *complete* ring of faces around that
 * vertex to average over).
 *
 * Every three.js primitive already ships an index buffer, but not a welded
 * one: a Box needs 3 different normals at each corner (one per face), which
 * three.js gets by giving that corner 3 separate position entries — same
 * coordinates, different vertex. Subdividing straight off that index treats
 * each of a Box's 6 faces as its own disconnected island with no shared
 * edges to any neighbour, which is exactly what produced the twisted,
 * saddle-shaped result reported against Catmull-Clark on a Box: every
 * "boundary" vertex point was only ever averaging its own face's two edges,
 * not the full ring a real interior corner has.
 *
 * `mergeVertices` itself hashes on *every* attribute present, so it
 * wouldn't merge those same-position-different-normal corners either — this
 * builds a position-only geometry first so the weld runs on coordinates
 * alone. UVs get their own, separately-welded pass — see `toIndexedUVMesh` —
 * since a Box's face corners need to stay split in UV-space exactly where
 * they just got welded together here.
 */
function toIndexedMesh(geometry: THREE.BufferGeometry): IndexedMesh | null {
  const posAttr = geometry.attributes.position;
  if (!posAttr) return null;

  const positionOnly = new THREE.BufferGeometry();
  positionOnly.setAttribute("position", posAttr.clone());
  if (geometry.index) positionOnly.setIndex(geometry.index.clone());

  const welded = mergeVertices(positionOnly, 1e-4);
  const weldedPosAttr = welded.attributes.position as THREE.BufferAttribute;
  const weldedIndex = welded.index;
  if (!weldedIndex) return null;

  return {
    positions: new Float32Array(weldedPosAttr.array),
    indices: new Uint32Array(weldedIndex.array),
  };
}

function toBufferGeometry(mesh: IndexedMesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Same weld-by-value trick as `toIndexedMesh`, but welding UV coordinates
 * instead of positions — padded to (u, v, 0) so `mergeVertices` (which only
 * knows how to hash a "position" attribute) can weld it unmodified. Two
 * triangle corners become one UV-vertex iff they carry the *same* UV value,
 * completely independent of whether they share a position-vertex — which is
 * exactly what a Box's face-corner UV seams need: three corners at the same
 * XYZ but three different UVs stay three separate UV-vertices here, even
 * though `toIndexedMesh` welds them into one position-vertex.
 *
 * Reuses `geometry`'s own (unwelded) index buffer, not the position-welded
 * one — see the correspondence note in `toBufferGeometryWithUV` for why that
 * matters.
 */
function toIndexedUVMesh(geometry: THREE.BufferGeometry): IndexedMesh | null {
  const uvAttr = geometry.attributes.uv as THREE.BufferAttribute | undefined;
  if (!uvAttr) return null;

  const padded = new Float32Array(uvAttr.count * 3);
  for (let i = 0; i < uvAttr.count; i++) {
    padded[i * 3] = uvAttr.getX(i);
    padded[i * 3 + 1] = uvAttr.getY(i);
    padded[i * 3 + 2] = 0;
  }
  const uvGeometry = new THREE.BufferGeometry();
  uvGeometry.setAttribute("position", new THREE.BufferAttribute(padded, 3));
  if (geometry.index) uvGeometry.setIndex(geometry.index.clone());
  return toIndexedMesh(uvGeometry);
}

/**
 * Zips a subdivided position mesh and an independently-subdivided UV mesh
 * back into one renderable geometry, carrying real UVs through Catmull-Clark
 * and Simple subdivision without the old "drop them" workaround.
 *
 * The zip works because `subdivide()` (both modes) is purely structural: the
 * output face count and each output triangle's corner order are a function
 * of the *input index topology* alone, never of the coordinate values being
 * subdivided. `pos` and `uv` were built from the same source triangle list
 * (`toIndexedUVMesh` reuses the source geometry's own unwelded index buffer,
 * same as `toIndexedMesh`), so every subdivision level preserves that
 * correspondence — output corner `i` means "the same mesh corner" in both,
 * even though position-welding and UV-welding produced different vertex
 * counts (a Box has 8 position-vertices but 24 UV-vertices, one per face
 * corner). That lets this loop pull position+normal from one welded space
 * and UV from a completely different one, per corner, with no shared index.
 *
 * Normals are computed on the *indexed* position mesh before flattening —
 * flattening first would leave `computeVertexNormals()` nothing to average
 * across (every corner already its own vertex), producing flat per-triangle
 * normals instead of the smooth ones a Catmull-Clark surface should have.
 */
function toBufferGeometryWithUV(pos: IndexedMesh, uv: IndexedMesh): THREE.BufferGeometry | null {
  if (pos.indices.length !== uv.indices.length) return null; // structural guarantee broken — bail to the no-UV path rather than zip garbage

  const indexedGeom = new THREE.BufferGeometry();
  indexedGeom.setAttribute("position", new THREE.BufferAttribute(pos.positions, 3));
  indexedGeom.setIndex(new THREE.BufferAttribute(pos.indices, 1));
  indexedGeom.computeVertexNormals();
  const normalAttr = indexedGeom.attributes.normal as THREE.BufferAttribute;

  const cornerCount = pos.indices.length;
  const finalPositions = new Float32Array(cornerCount * 3);
  const finalNormals = new Float32Array(cornerCount * 3);
  const finalUVs = new Float32Array(cornerCount * 2);

  for (let i = 0; i < cornerCount; i++) {
    const pi = pos.indices[i];
    const ui = uv.indices[i];
    finalPositions[i * 3] = pos.positions[pi * 3];
    finalPositions[i * 3 + 1] = pos.positions[pi * 3 + 1];
    finalPositions[i * 3 + 2] = pos.positions[pi * 3 + 2];
    finalNormals[i * 3] = normalAttr.getX(pi);
    finalNormals[i * 3 + 1] = normalAttr.getY(pi);
    finalNormals[i * 3 + 2] = normalAttr.getZ(pi);
    finalUVs[i * 2] = uv.positions[ui * 3];
    finalUVs[i * 2 + 1] = uv.positions[ui * 3 + 1];
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(finalPositions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(finalNormals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(finalUVs, 2));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export const SUBDIVIDE_NODE: NodeDefinition = {
  type: "modifier/subdivide",
  label: "Subdivide",
  category: "transform",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "levels", label: "Levels", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    mode: "catmull-clark",
    levels: 1,
  },
  paramFields: [
    { id: "mode", label: "Mode", kind: "select", options: ["simple", "catmull-clark"] },
    { id: "levels", label: "Levels", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const inputObj = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (!inputObj) return { geometry: null };

    const srcMesh = findFirstMesh(inputObj);
    const srcGeom = srcMesh?.geometry;
    if (!srcMesh || !srcGeom || !srcGeom.attributes.position) {
      warnMeshRequired(ctx.nodeId, "Subdivide", inputObj);
      return primitiveOutputs(inputObj);
    }
    clearMeshWarning(ctx.nodeId);

    const mode: SubdivisionMode = params.mode === "simple" ? "simple" : "catmull-clark";
    const levels = Math.max(0, Math.min(5, Math.round(Number(params.levels) || 0)));

    // Capped at 5: Catmull-Clark roughly triples the triangle count (and
    // Simple quadruples it) per level, so level 5 alone is already a
    // several-hundred-thousand-triangle mesh off of a 100-triangle source —
    // past that the cap exists to keep a typo in the param field from
    // freezing the tab rather than to limit legitimate use.

    const state = getState(ctx.nodeId);

    const signature = `${mode}:${levels}:${srcGeom.attributes.position.count}:${srcGeom.index?.count ?? -1}:${srcGeom.attributes.uv?.count ?? -1}`;
    if (state.mesh && state.lastSignature === signature) {
      // Topology unchanged since last run — skip re-subdividing, but the
      // source's pose still needs copying every call: an upstream animation
      // moves srcMesh.matrix every frame without ever touching its geometry,
      // so signature alone would stay stable and this early return used to
      // leave state.mesh frozen at whatever pose it last recomputed at.
      // srcMesh.matrix is only its LOCAL pose — correct for a mesh that
      // directly carries its own transform (Box, Sphere, ...), but wrong for
      // one nested under a posed wrapper group (OBJ Model bakes its Location/
      // Rotation/Scale/Pivot onto the group, not the mesh inside it), where
      // .matrix alone is identity and this would silently reset the pose.
      // matrixWorld is correct either way. Also force matrixAutoUpdate off
      // rather than copying the source's flag: an OBJ-parsed mesh defaults to
      // true, which would have three's own render loop recompute (and wipe)
      // this matrix from its untouched position/quaternion/scale next frame.
      inputObj.updateMatrixWorld(true);
      state.mesh.matrixAutoUpdate = false;
      state.mesh.matrix.copy(srcMesh.matrixWorld);
      preserveModifierUserData(state.mesh, inputObj, srcMesh, ctx.nodeId);
      return primitiveOutputs(state.mesh);
    }

    const indexedMesh = toIndexedMesh(srcGeom);
    if (!indexedMesh) return primitiveOutputs(inputObj);

    const posResult = runSubdivide(indexedMesh, mode, levels);

    const uvIndexedMesh = toIndexedUVMesh(srcGeom);
    const uvResult = uvIndexedMesh ? runSubdivide(uvIndexedMesh, mode, levels) : null;
    const geometry = (uvResult && toBufferGeometryWithUV(posResult, uvResult)) || toBufferGeometry(posResult);

    if (!state.mesh) {
      state.mesh = new THREE.Mesh(geometry, srcMesh.material);
      state.mesh.castShadow = true;
      state.mesh.receiveShadow = true;
    } else {
      state.mesh.geometry.dispose();
      state.mesh.geometry = geometry;
      state.mesh.material = srcMesh.material;
    }
    // Same pose as whatever was plugged in — this node reshapes the
    // surface, it doesn't move it, so it has no location/rotation/scale of
    // its own the way Lattice Deform's cage does. See the cached-return
    // branch above for why matrixWorld (not matrix) and a forced-false
    // matrixAutoUpdate.
    inputObj.updateMatrixWorld(true);
    state.mesh.matrixAutoUpdate = false;
    state.mesh.matrix.copy(srcMesh.matrixWorld);
    preserveModifierUserData(state.mesh, inputObj, srcMesh, ctx.nodeId);
    state.lastSignature = signature;

    return primitiveOutputs(state.mesh);
  },
};
