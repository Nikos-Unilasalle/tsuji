import * as THREE from "three";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { clearMeshWarning, findFirstMesh, warnMeshRequired } from "../meshRequired";
import { inheritSourceMaterial, primitiveOutputs } from "./object";
import { preserveModifierUserData } from "./transform";

/**
 * The three shading modes, in Blender's vocabulary. "auto" is Blender's
 * Auto Smooth: faces stay smooth where the angle between neighbouring face
 * normals is below the threshold, and split (flat) across hard edges. The
 * angle threshold here is Blender's 30° default.
 */
export const SHADE_MODES = ["auto", "smooth", "flat"] as const;
export type ShadeMode = (typeof SHADE_MODES)[number];

interface ShadeState {
  mesh?: THREE.Mesh;
  /** Rebuild skip-signature — same idea as Subdivide's. */
  signature: string;
  /** The source position array the current geometry was built from — reference equality catches an upstream swap/morph that a uuid+count signature alone would miss. */
  srcPosArray?: unknown;
  srcPosCount: number;
}

const shadeCache = createNodeCache<ShadeState>((s) => {
  if (s.mesh) disposeObject3D(s.mesh);
});

function getState(nodeId: string): ShadeState {
  let state = shadeCache.get(nodeId);
  if (!state) {
    state = { signature: "", srcPosCount: -1 };
    shadeCache.set(nodeId, state);
  }
  return state;
}

/**
 * Welds vertices by position (not by attribute set) the way Blender's smooth
 * shading does: a Box's corner is 3 position entries with identical
 * coordinates but different normals/UVs, and it is one *place* — so it gets
 * one shared smooth normal. Returns the old-vertex -> welded-id map and the
 * deduped position list; `tolerance` mirrors mergeVertices' default (1e-4).
 */
function weldPositions(pos: THREE.BufferAttribute, tolerance: number): { oldToNew: Int32Array; uniquePositions: Float32Array } {
  const count = pos.count;
  const oldToNew = new Int32Array(count);
  const map = new Map<string, number>();
  const unique: number[] = [];
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pos.getX(i) / tolerance)}:${Math.round(pos.getY(i) / tolerance)}:${Math.round(pos.getZ(i) / tolerance)}`;
    let ni = map.get(key);
    if (ni === undefined) {
      ni = unique.length / 3;
      map.set(key, ni);
      unique.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    }
    oldToNew[i] = ni;
  }
  return { oldToNew, uniquePositions: new Float32Array(unique) };
}

/** Per-face (geometric) normals of an indexed triangle mesh. */
function computeFaceNormals(pos: THREE.BufferAttribute, index: THREE.BufferAttribute): Float32Array {
  const faceCount = index.count / 3;
  const normals = new Float32Array(faceCount * 3);
  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const pC = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const cb = new THREE.Vector3();
  for (let i = 0; i < faceCount; i++) {
    pA.fromBufferAttribute(pos, index.getX(i * 3));
    pB.fromBufferAttribute(pos, index.getX(i * 3 + 1));
    pC.fromBufferAttribute(pos, index.getX(i * 3 + 2));
    cb.subVectors(pC, pB);
    ab.subVectors(pA, pB);
    cb.cross(ab);
    const len = cb.length();
    normals[i * 3] = len > 1e-12 ? cb.x / len : 0;
    normals[i * 3 + 1] = len > 1e-12 ? cb.y / len : 1;
    normals[i * 3 + 2] = len > 1e-12 ? cb.z / len : 0;
  }
  return normals;
}

function find(parent: Int32Array, x: number): number {
  while (parent[x] !== x) {
    parent[x] = parent[parent[x]];
    x = parent[x];
  }
  return x;
}

function union(parent: Int32Array, a: number, b: number): void {
  const ra = find(parent, a);
  const rb = find(parent, b);
  if (ra !== rb) parent[rb] = ra;
}

/**
 * Averaged per-vertex normals — the classic smooth look. The geometry is
 * welded by position *first*, because computeVertexNormals alone averages
 * only across vertices that share an index, and a Box (unwelded, 3 indices
 * per corner) would otherwise stay hard-edged. The welded normals are mapped
 * back onto the original unwelded vertices, so positions/UVs are untouched.
 */
function buildSmoothGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = src.attributes.position as THREE.BufferAttribute;
  const { oldToNew, uniquePositions } = weldPositions(pos, 1e-4);

  const welded = new THREE.BufferGeometry();
  welded.setAttribute("position", new THREE.Float32BufferAttribute(uniquePositions, 3));
  const srcIndex = src.index;
  if (srcIndex) {
    const mapped = new Uint32Array(srcIndex.count);
    for (let i = 0; i < srcIndex.count; i++) mapped[i] = oldToNew[srcIndex.getX(i)];
    welded.setIndex(new THREE.BufferAttribute(mapped, 1));
  } else {
    const mapped = new Uint32Array(pos.count);
    for (let i = 0; i < pos.count; i++) mapped[i] = oldToNew[i];
    welded.setIndex(new THREE.BufferAttribute(mapped, 1));
  }
  welded.computeVertexNormals();
  const weldedNormals = welded.attributes.normal as THREE.BufferAttribute;

  const out = src.clone();
  const normals = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    normals[i * 3] = weldedNormals.getX(oldToNew[i]);
    normals[i * 3 + 1] = weldedNormals.getY(oldToNew[i]);
    normals[i * 3 + 2] = weldedNormals.getZ(oldToNew[i]);
  }
  out.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  return out;
}

/** Per-face normals — each triangle duplicated and flat, the hard-edged look. */
function buildFlatGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const geometry = src.index ? src.toNonIndexed() : src.clone();
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Blender-style Auto Smooth. Faces sharing an edge stay smooth (union'd into
 * the same smoothing group) when the angle between their normals is below
 * `angleRad`; everything else becomes a hard edge. Each vertex then gets one
 * averaged normal per smoothing group it belongs to, and is split into that
 * many vertices — exactly what Blender's Edge Split / Auto Smooth does to a
 * corner on a hard edge. Edge detection runs on *welded* vertex ids so
 * duplicated corners (a Box's 3-per-corner entries) are recognized as the
 * same place; the split rebuild works on the original vertices, so UVs stay
 * per-corner and undistorted.
 */
function buildAutoSmoothGeometry(src: THREE.BufferGeometry, angleRad: number): THREE.BufferGeometry {
  const pos = src.attributes.position as THREE.BufferAttribute;
  const srcIndex = src.index;
  const uv = src.attributes.uv as THREE.BufferAttribute | undefined;
  const faceCount = srcIndex ? srcIndex.count / 3 : pos.count / 3;
  const index = srcIndex ?? (new THREE.BufferAttribute(new Uint32Array(pos.count).map((_, i) => i), 1) as THREE.BufferAttribute);

  const { oldToNew } = weldPositions(pos, 1e-4);
  const faceNormals = computeFaceNormals(pos, index);
  const cosThreshold = Math.cos(Math.max(0.001, Math.min(179.999, angleRad)));

  // Edges (by sorted *welded* vertex ids) -> the faces on each side.
  const edgeFaces = new Map<string, number[]>();
  for (let f = 0; f < faceCount; f++) {
    for (let e = 0; e < 3; e++) {
      const a = oldToNew[index.getX(f * 3 + e)];
      const b = oldToNew[index.getX(f * 3 + ((e + 1) % 3))];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const list = edgeFaces.get(key);
      if (list) list.push(f);
      else edgeFaces.set(key, [f]);
    }
  }

  const parent = new Int32Array(faceCount);
  for (let i = 0; i < faceCount; i++) parent[i] = i;
  for (const faces of edgeFaces.values()) {
    if (faces.length !== 2) continue; // boundary / non-manifold: keep hard
    const [f0, f1] = faces;
    const dot =
      faceNormals[f0 * 3] * faceNormals[f1 * 3] +
      faceNormals[f0 * 3 + 1] * faceNormals[f1 * 3 + 1] +
      faceNormals[f0 * 3 + 2] * faceNormals[f1 * 3 + 2];
    if (dot >= cosThreshold) union(parent, f0, f1);
  }

  // Welded vertex -> incident faces (welded ids are the place identity).
  const vertexFaces: number[][] = [];
  for (let f = 0; f < faceCount; f++) {
    for (let c = 0; c < 3; c++) {
      const wid = oldToNew[index.getX(f * 3 + c)];
      (vertexFaces[wid] ||= []).push(f);
    }
  }

  // Rebuild as split vertices: one (position, normal, uv) triple per
  // (sourceVertex, smoothingGroup) pair.
  const newPos: number[] = [];
  const newNormals: number[] = [];
  const newUvs: number[] = uv ? [] : (null as unknown as number[]);
  const newIndex: number[] = [];
  const split = new Map<number, Map<number, number>>();

  for (let f = 0; f < faceCount; f++) {
    const rep = find(parent, f);
    for (let c = 0; c < 3; c++) {
      const v = index.getX(f * 3 + c);
      const wid = oldToNew[v];
      let repMap = split.get(wid);
      if (!repMap) {
        repMap = new Map();
        split.set(wid, repMap);
      }
      let ni = repMap.get(rep);
      if (ni === undefined) {
        ni = newPos.length / 3;
        repMap.set(rep, ni);
        newPos.push(pos.getX(v), pos.getY(v), pos.getZ(v));
        // Group normal = average of the face normals of every face in this
        // smoothing group touching the place.
        let nx = 0;
        let ny = 0;
        let nz = 0;
        for (const fv of vertexFaces[wid]) {
          if (find(parent, fv) !== rep) continue;
          nx += faceNormals[fv * 3];
          ny += faceNormals[fv * 3 + 1];
          nz += faceNormals[fv * 3 + 2];
        }
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 1e-12) {
          nx /= len;
          ny /= len;
          nz /= len;
        }
        newNormals.push(nx, ny, nz);
        if (uv) newUvs.push(uv.getX(v), uv.getY(v));
      }
      newIndex.push(ni);
    }
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(newPos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(newNormals, 3));
  if (uv) out.setAttribute("uv", new THREE.Float32BufferAttribute(newUvs, 2));
  // The split's newIndex is what actually makes the triangles reference the
  // right split vertices — without it three.js renders vertices in raw
  // consecutive triples, which is a garbage mesh (this was the "auto destroys
  // the geometry" bug: counts and normals were right, the index never got set).
  out.setIndex(new THREE.BufferAttribute(new Uint32Array(newIndex), 1));
  return out;
}

export const SHADE_NODE: NodeDefinition = {
  type: "modifier/shade",
  label: "Shade",
  category: "transform",
  inputs: [{ id: "geometry", label: "Geometry", type: "geometry", owns: true }],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    mode: "auto",
    autoAngle: 30,
  },
  paramFields: [
    { id: "mode", label: "Shading", kind: "select", options: [...SHADE_MODES] },
    { id: "autoAngle", label: "Auto Smooth Angle (°)", kind: "number", step: 1, group: "Auto Smooth" },
  ],
  evaluate: (inputs, params, ctx) => {
    const inputObj = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (!inputObj) return { geometry: null, matrix: new THREE.Matrix4() };

    const srcMesh = findFirstMesh(inputObj);
    const srcGeom = srcMesh?.geometry;
    if (!srcMesh || !srcGeom || !srcGeom.attributes.position) {
      warnMeshRequired(ctx.nodeId, "Shade", inputObj);
      return primitiveOutputs(inputObj);
    }
    clearMeshWarning(ctx.nodeId);

    const mode: ShadeMode = (SHADE_MODES as readonly string[]).includes(String(params.mode)) ? (params.mode as ShadeMode) : "auto";
    const angle = Number(params.autoAngle);
    const angleRad = (Number.isFinite(angle) ? angle : 30) * (Math.PI / 180);

    const state = getState(ctx.nodeId);
    const posAttr = srcGeom.attributes.position as THREE.BufferAttribute;
    const signature = `${mode}:${angleRad.toFixed(4)}:${srcGeom.uuid}`;
    const srcChanged = state.srcPosArray !== posAttr.array || state.srcPosCount !== posAttr.count;
    if (state.mesh && state.signature === signature && !srcChanged) {
      // srcMesh.matrix is only its LOCAL pose — correct for a mesh that
      // directly carries its own transform (Box, Sphere, ...), but wrong for
      // one nested under a posed wrapper group (OBJ Model bakes its Location/
      // Rotation/Scale/Pivot onto the group, not the mesh inside it), where
      // .matrix alone is identity and this would silently reset the pose.
      // matrixWorld is correct either way — computed by forcing it from
      // inputObj (the root), not srcMesh itself: three's own
      // `mesh.updateWorldMatrix(true, false, true)` only forwards `force` to
      // the mesh, not to the parents it climbs to recompute, so a wrapper
      // group whose matrixWorldNeedsUpdate flag was never set (true here,
      // since OBJ Model writes `.matrix` directly rather than through
      // position/rotation/scale) silently stayed at its stale/identity
      // matrixWorld regardless. updateMatrixWorld(true) from the root
      // correctly cascades force down through every descendant instead.
      // Also force matrixAutoUpdate off rather than copying the source's
      // flag: an OBJ-parsed mesh defaults it true, which would have three's
      // own render loop recompute (and wipe) this matrix next frame.
      inputObj.updateMatrixWorld(true);
      state.mesh.matrixAutoUpdate = false;
      state.mesh.matrix.copy(srcMesh.matrixWorld);
      preserveModifierUserData(state.mesh, inputObj, srcMesh, ctx.nodeId);
      inheritSourceMaterial(state.mesh, srcMesh.material);
      return primitiveOutputs(state.mesh);
    }

    const geometry =
      mode === "smooth"
        ? buildSmoothGeometry(srcGeom)
        : mode === "flat"
          ? buildFlatGeometry(srcGeom)
          : buildAutoSmoothGeometry(srcGeom, angleRad);

    if (!state.mesh) {
      state.mesh = new THREE.Mesh(geometry);
    } else {
      state.mesh.geometry.dispose();
      state.mesh.geometry = geometry;
    }
    inheritSourceMaterial(state.mesh, srcMesh.material);
    state.mesh.castShadow = srcMesh.castShadow;
    state.mesh.receiveShadow = srcMesh.receiveShadow;
    // See the cached-return branch above for why matrixWorld (not matrix)
    // and a forced-false matrixAutoUpdate.
    inputObj.updateMatrixWorld(true);
    state.mesh.matrixAutoUpdate = false;
    state.mesh.matrix.copy(srcMesh.matrixWorld);
    preserveModifierUserData(state.mesh, inputObj, srcMesh, ctx.nodeId);
    state.signature = signature;
    state.srcPosArray = posAttr.array;
    state.srcPosCount = posAttr.count;

    return primitiveOutputs(state.mesh);
  },
};
