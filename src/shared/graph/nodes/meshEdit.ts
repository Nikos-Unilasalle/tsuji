import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { clearMeshWarning, findFirstMesh, warnMeshRequired } from "../meshRequired";
import { createPRNG } from "../../math/random";
import { applyMaterialParams, inheritSourceMaterial, materialParamsFromValue, primitiveOutputs } from "./object";
import { asVector3, preserveModifierUserData } from "./transform";

export type FaceSelectMode = "all" | "normal" | "height";

export interface FaceSelectionConfig {
  mode: FaceSelectMode;
  axis: "x" | "y" | "z";
  threshold: number;
  invert: boolean;
}

const AXIS_VECTORS: Record<"x" | "y" | "z", THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

function triangleNormal(positions: ArrayLike<number>, a: number, b: number, c: number): THREE.Vector3 {
  const pa = new THREE.Vector3(positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]);
  const pb = new THREE.Vector3(positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]);
  const pc = new THREE.Vector3(positions[c * 3], positions[c * 3 + 1], positions[c * 3 + 2]);
  return new THREE.Vector3().subVectors(pb, pa).cross(new THREE.Vector3().subVectors(pc, pa)).normalize();
}

/**
 * Which triangles a modifier acts on, expressed as a geometric predicate
 * instead of manual per-face picking — there's no interactive selection
 * state anywhere in this graph (every node is a pure function re-run every
 * frame), so "select the top faces" has to be a formula, not a click. This
 * mirrors the 90% case of Blender's own field-based selection (facing a
 * direction, above a height) without needing a general field/attribute
 * system to express it.
 */
export function selectFaces(positions: ArrayLike<number>, indices: ArrayLike<number>, faceCount: number, config: FaceSelectionConfig): boolean[] {
  const result = new Array<boolean>(faceCount);
  const axisVec = AXIS_VECTORS[config.axis] ?? AXIS_VECTORS.y;

  for (let f = 0; f < faceCount; f++) {
    const a = indices[f * 3];
    const b = indices[f * 3 + 1];
    const c = indices[f * 3 + 2];

    let selected: boolean;
    if (config.mode === "all") {
      selected = true;
    } else if (config.mode === "normal") {
      selected = triangleNormal(positions, a, b, c).dot(axisVec) >= config.threshold;
    } else {
      // height: average of the face's own 3 vertices along the chosen axis
      const key = config.axis === "x" ? 0 : config.axis === "y" ? 1 : 2;
      const avg = (positions[a * 3 + key] + positions[b * 3 + key] + positions[c * 3 + key]) / 3;
      selected = avg >= config.threshold;
    }

    result[f] = config.invert ? !selected : selected;
  }
  return result;
}

export const FACE_SELECTION_PARAM_FIELDS = [
  { id: "selectMode", label: "Select", kind: "select" as const, options: ["all", "normal", "height"] },
  { id: "axis", label: "Axis", kind: "select" as const, options: ["x", "y", "z"] },
  { id: "threshold", label: "Threshold", kind: "number" as const, step: 0.1 },
  { id: "invert", label: "Invert Selection", kind: "boolean" as const },
];

export function faceSelectionConfigFromParams(params: Record<string, unknown>): FaceSelectionConfig {
  const mode = params.selectMode === "normal" || params.selectMode === "height" ? params.selectMode : "all";
  const axis = params.axis === "x" || params.axis === "z" ? params.axis : "y";
  return {
    mode,
    axis,
    threshold: Number(params.threshold) || 0,
    invert: Boolean(params.invert),
  };
}

interface WeldedMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/** Position-only weld, same trick as subdivide.ts's toIndexedMesh — extrude's boundary-edge detection needs a shared-vertex mesh (an edge is only "interior" if both its triangles agree it's the same vertex pair). */
function toWeldedMesh(geometry: THREE.BufferGeometry): WeldedMesh | null {
  const posAttr = geometry.attributes.position;
  if (!posAttr) return null;
  const positionOnly = new THREE.BufferGeometry();
  positionOnly.setAttribute("position", posAttr.clone());
  if (geometry.index) positionOnly.setIndex(geometry.index.clone());
  const welded = mergeVertices(positionOnly, 1e-4);
  const weldedIndex = welded.index;
  if (!weldedIndex) return null;
  return {
    positions: new Float32Array((welded.attributes.position as THREE.BufferAttribute).array),
    indices: new Uint32Array(weldedIndex.array),
  };
}

/**
 * Extrudes the selected faces outward along their own averaged vertex
 * normals: duplicates the selected patch's vertices, offsets the duplicates
 * by `distance`, re-targets the selected faces onto the duplicates (the
 * raised cap), and stitches a wall of new triangles around the patch's
 * boundary — every edge touched by exactly one selected face (a mesh
 * boundary within the selection) or shared between one selected and one
 * unselected face. An edge shared by two selected faces is interior to the
 * patch and gets no wall.
 *
 * Wall winding comes from the selected face's own edge direction (not just
 * the undirected pair) so it comes out facing outward automatically,
 * consistent with the cap, without guessing from geometry.
 */
function extrudeSelected(mesh: WeldedMesh, selected: boolean[], distance: number): WeldedMesh {
  const { positions, indices } = mesh;
  const faceCount = indices.length / 3;
  const vertexCount = positions.length / 3;

  const vertexNormalSum = new Float32Array(vertexCount * 3);
  const vertexSelected = new Uint8Array(vertexCount);
  for (let f = 0; f < faceCount; f++) {
    if (!selected[f]) continue;
    const a = indices[f * 3];
    const b = indices[f * 3 + 1];
    const c = indices[f * 3 + 2];
    const n = triangleNormal(positions, a, b, c);
    for (const v of [a, b, c]) {
      vertexSelected[v] = 1;
      vertexNormalSum[v * 3] += n.x;
      vertexNormalSum[v * 3 + 1] += n.y;
      vertexNormalSum[v * 3 + 2] += n.z;
    }
  }

  const oldToNew = new Int32Array(vertexCount).fill(-1);
  const outPositions: number[] = Array.from(positions);
  for (let v = 0; v < vertexCount; v++) {
    if (!vertexSelected[v]) continue;
    const nx = vertexNormalSum[v * 3];
    const ny = vertexNormalSum[v * 3 + 1];
    const nz = vertexNormalSum[v * 3 + 2];
    const len = Math.hypot(nx, ny, nz) || 1;
    outPositions.push(
      positions[v * 3] + (nx / len) * distance,
      positions[v * 3 + 1] + (ny / len) * distance,
      positions[v * 3 + 2] + (nz / len) * distance,
    );
    oldToNew[v] = outPositions.length / 3 - 1;
  }

  const outIndices: number[] = [];
  for (let f = 0; f < faceCount; f++) {
    const a = indices[f * 3];
    const b = indices[f * 3 + 1];
    const c = indices[f * 3 + 2];
    if (selected[f]) {
      outIndices.push(oldToNew[a], oldToNew[b], oldToNew[c]);
    } else {
      outIndices.push(a, b, c);
    }
  }

  interface EdgeEntry {
    u: number;
    v: number;
    selected: boolean;
  }
  const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const edgeMap = new Map<string, EdgeEntry[]>();
  for (let f = 0; f < faceCount; f++) {
    const tri = [indices[f * 3], indices[f * 3 + 1], indices[f * 3 + 2]];
    for (let e = 0; e < 3; e++) {
      const u = tri[e];
      const v = tri[(e + 1) % 3];
      const key = edgeKey(u, v);
      const arr = edgeMap.get(key) ?? [];
      arr.push({ u, v, selected: selected[f] });
      edgeMap.set(key, arr);
    }
  }

  for (const entries of edgeMap.values()) {
    const selEntry = entries.find((e) => e.selected);
    if (!selEntry) continue;
    const selectedCount = entries.filter((e) => e.selected).length;
    if (selectedCount === entries.length && entries.length === 2) continue; // interior to the patch
    const { u, v } = selEntry;
    const u2 = oldToNew[u];
    const v2 = oldToNew[v];
    outIndices.push(u, v, v2);
    outIndices.push(u, v2, u2);
  }

  return { positions: new Float32Array(outPositions), indices: new Uint32Array(outIndices) };
}

/**
 * The recursive per-pass transform that turns repeated extrusions into a
 * growing, bending, tapering shape (a tree grown out of a tube's top ring).
 * Applied to the extrusion's current *tip* (the face set that stays selected
 * across passes) after each pass:
 *
 *  - rotation is about the tip's own centroid, so each pass's cap is tilted
 *    relative to the one before — and because the next pass extrudes along
 *    the (rotated) cap normals, the branch direction bends at every joint;
 *  - scale shrinks the tip around that same centroid — a taper that narrows
 *    the branch toward its top (component-wise, so a wired matrix's non-uniform
 *    scale carries through);
 *  - location nudges the whole tip — a per-pass drift that adds irregularity.
 *
 * The pivot is the centroid of the selected patch, which for the classic
 * tube-ring case is exactly the rim the previous segment's walls attach to,
 * so the previous walls stay put and the bend happens cleanly at the joint.
 */
export interface GrowConfig {
  /** Number of successive extrusions (0 = no-op). */
  passes: number;
  /** Per-pass rotation of the tip, in radians. */
  rotation: THREE.Vector3;
  /** Per-pass scale multiplier of the tip (1 = none), component-wise. */
  scale: THREE.Vector3;
  /** Per-pass offset of the tip. */
  location: THREE.Vector3;
  /** 0-1: how much each pass's transforms jitter, as a fraction of their own value. */
  random: number;
  /** Seed for that jitter, so a given seed always grows the same shape. */
  seed: number;
}

/** Rotates, scales and offsets every vertex of the currently selected faces about the patch's centroid, in place. */
function applyTipTransform(mesh: WeldedMesh, selected: boolean[], rotation: THREE.Vector3, scale: THREE.Vector3, location: THREE.Vector3): void {
  const { positions, indices } = mesh;
  const faceCount = indices.length / 3;

  const tipSet = new Set<number>();
  for (let f = 0; f < faceCount; f++) {
    if (!selected[f]) continue;
    tipSet.add(indices[f * 3]);
    tipSet.add(indices[f * 3 + 1]);
    tipSet.add(indices[f * 3 + 2]);
  }
  if (tipSet.size === 0) return;

  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const v of tipSet) {
    cx += positions[v * 3];
    cy += positions[v * 3 + 1];
    cz += positions[v * 3 + 2];
  }
  const count = tipSet.size;
  cx /= count;
  cy /= count;
  cz /= count;

  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation.x, rotation.y, rotation.z));
  const p = new THREE.Vector3();
  for (const v of tipSet) {
    p.set(positions[v * 3] - cx, positions[v * 3 + 1] - cy, positions[v * 3 + 2] - cz);
    p.applyQuaternion(quat);
    p.multiply(scale);
    positions[v * 3] = p.x + cx + location.x;
    positions[v * 3 + 1] = p.y + cy + location.y;
    positions[v * 3 + 2] = p.z + cz + location.z;
  }
}

/**
 * The multi-pass extrude. Each pass re-extrudes the same face selection (the
 * growing tip) and then applies the recursive transform to it; `selected` is
 * extended with `false` for every new wall face so later passes keep treating
 * only the tip as selected. The `random` fraction jitters distance, rotation,
 * scale and location independently per pass around their base values, from a
 * seeded PRNG so a fixed seed always grows the same shape.
 */
function extrudeGrow(mesh: WeldedMesh, selected: boolean[], distance: number, config: GrowConfig): WeldedMesh {
  const hasTransform =
    config.rotation.lengthSq() > 0 ||
    config.scale.x !== 1 ||
    config.scale.y !== 1 ||
    config.scale.z !== 1 ||
    config.location.lengthSq() > 0;
  const rng = createPRNG(config.seed);
  let current = mesh;
  for (let pass = 0; pass < config.passes; pass++) {
    const jit = (base: number) => base * (1 + (rng() * 2 - 1) * config.random);
    current = extrudeSelected(current, selected, Math.max(0, jit(distance)));
    // New wall faces are never selected — keep the mask aligned with the mesh.
    while (selected.length < current.indices.length / 3) selected.push(false);

    if (hasTransform || config.random > 0) {
      applyTipTransform(
        current,
        selected,
        new THREE.Vector3(jit(config.rotation.x), jit(config.rotation.y), jit(config.rotation.z)),
        new THREE.Vector3(jit(config.scale.x), jit(config.scale.y), jit(config.scale.z)),
        new THREE.Vector3(jit(config.location.x), jit(config.location.y), jit(config.location.z)),
      );
    }
  }
  return current;
}

interface MeshEditState {
  mesh?: THREE.Mesh;
  lastSignature?: string;
}

const meshEditCache = createNodeCache<MeshEditState>((s) => {
  if (s.mesh) disposeObject3D(s.mesh);
});

function getState(cache: typeof meshEditCache, nodeId: string): MeshEditState {
  let state = cache.get(nodeId);
  if (!state) {
    state = {};
    cache.set(nodeId, state);
  }
  return state;
}

/**
 * Extrude Mesh modifier — pushes the selected faces outward along their own
 * averaged normal and stitches a wall around the patch. What gets extruded
 * comes from the `Selection` input when one is wired (the Face Selection
 * node's `selection` list, one boolean per face in the source geometry's
 * index order); otherwise the formula fields below select it. Distance is
 * wireable so it can be driven/animated like any other modifier param.
 *
 * With `Passes` above 1 the same selection is extruded repeatedly, and each
 * pass's cap is then transformed recursively — Rotate (about its own
 * centroid), Scale and Location — plus an optional per-pass random jitter.
 * Wiring a `Transform` matrix (another object's matrix, e.g. a rotating
 * Empty) replaces those three direct fields with the matrix's own
 * translation/rotation/scale, so the branch follows whatever object you
 * drive instead of a fixed per-pass offset. That combination is what grows a
 * tube's top ring into a tree: extrude up, tilt a little, extrude the tilted
 * cap again, taper, and repeat (see extrudeGrow/applyTipTransform).
 *
 * UV/vertex-color attributes are not carried through, same tradeoff as
 * Subdivide made before it grew its own UV pass — extruding a texture
 * correctly needs new UV space for the cap and walls, which is real
 * additional work for a modifier whose job is silhouette, not
 * texture-mapped output. Normals are recomputed smooth.
/**
 * Applies the connected material or falls back to an adapted source material.
 * If the source mesh relies on vertexColors (e.g. Grease Pencil ribbons),
 * but the extruded geometry has no vertex colors, this assigns a standard
 * shaded material with the source stroke color so it never renders pitch black.
 */
function applyExtrudeMaterial(mesh: THREE.Mesh, srcMesh: THREE.Mesh, materialInput: unknown) {
  const matParams = materialParamsFromValue(materialInput);
  if (matParams) {
    applyMaterialParams(mesh, matParams, THREE.DoubleSide);
    return;
  }

  const srcMat = srcMesh.material;
  const isVertexColored = srcMat && !Array.isArray(srcMat) && (srcMat as any).vertexColors;
  if (isVertexColored) {
    let col = new THREE.Color(0x38bdf8);
    const colorAttr = srcMesh.geometry?.attributes?.color;
    if (colorAttr && colorAttr.count > 0) {
      col.setRGB(colorAttr.getX(0), colorAttr.getY(0), colorAttr.getZ(0));
    }
    if (!(mesh.material instanceof THREE.MeshStandardMaterial) || (mesh.material as any).__isSharedFromSrc) {
      mesh.material = new THREE.MeshStandardMaterial({
        color: col,
        roughness: 0.4,
        metalness: 0.1,
        side: THREE.DoubleSide,
      });
      (mesh.material as any).__isSharedFromSrc = false;
    } else {
      (mesh.material as THREE.MeshStandardMaterial).color.copy(col);
      mesh.material.side = THREE.DoubleSide;
    }
  } else if (srcMat instanceof THREE.Material) {
    inheritSourceMaterial(mesh, srcMat);
    (mesh.material as any).__isSharedFromSrc = true;
  } else if (!mesh.material) {
    mesh.material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.4,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });
  }
}

export const EXTRUDE_MESH_NODE: NodeDefinition = {
  type: "modifier/extrude",
  label: "Extrude Mesh",
  category: "transform",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    // A Face Selection node's `selection` output — booleans, one per face in
    // the source geometry's index order. Replaces the formula fields below.
    { id: "selection", label: "Face Selection", type: "list" },
    { id: "material", label: "Material", type: "material" },
    { id: "distance", label: "Distance", type: "value" },
    { id: "passes", label: "Passes", type: "value" },
    // A matrix whose translation/rotation/scale becomes the per-pass
    // transform — wire another object's matrix (a rotating Empty, a Transform
    // node) to grow the branch along it instead of the direct fields.
    { id: "transform", label: "Per-Pass Transform (Matrix)", type: "matrix" },
    { id: "rotation", label: "Rotation / Pass", type: "vector" },
    { id: "scale", label: "Scale / Pass", type: "value" },
    { id: "location", label: "Location / Pass", type: "vector" },
    { id: "random", label: "Random %", type: "value" },
    { id: "seed", label: "Seed", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    distance: 0.5,
    passes: 1,
    rotation: new THREE.Vector3(0, 0, 0),
    scale: 1,
    location: new THREE.Vector3(0, 0, 0),
    random: 0,
    seed: 1,
    selectMode: "all",
    axis: "y",
    threshold: 0,
    invert: false,
  },
  paramFields: [
    { id: "distance", label: "Distance", kind: "number", step: 0.05, group: "Extrude" },
    { id: "passes", label: "Passes", kind: "number", step: 1, group: "Extrude" },
    { id: "rotation", label: "Rotation / Pass (°)", kind: "vector", step: 1, degrees: true, group: "Grow" },
    { id: "scale", label: "Scale / Pass", kind: "number", step: 0.01, group: "Grow" },
    { id: "location", label: "Location / Pass", kind: "vector", group: "Grow" },
    { id: "random", label: "Random %", kind: "number", step: 0.05, group: "Random" },
    { id: "seed", label: "Seed", kind: "number", step: 1, group: "Random" },
    ...FACE_SELECTION_PARAM_FIELDS.map((f) => ({ ...f, group: "Extrude" })),
  ],
  evaluate: (inputs, params, ctx) => {
    const inputObj = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (!inputObj) return { geometry: null };

    const srcMesh = findFirstMesh(inputObj);
    const srcGeom = srcMesh?.geometry;
    if (!srcMesh || !srcGeom || !srcGeom.attributes.position) {
      warnMeshRequired(ctx.nodeId, "Extrude Mesh", inputObj);
      return primitiveOutputs(inputObj);
    }
    clearMeshWarning(ctx.nodeId);

    const distance = inputs.distance !== undefined ? Number(inputs.distance) : Number(params.distance) || 0;
    const passes = Math.max(0, Math.min(64, Math.round(inputs.passes !== undefined ? Number(inputs.passes) : Number(params.passes) || 1)));
    const random = Math.max(0, Math.min(1, inputs.random !== undefined ? Number(inputs.random) : Number(params.random) || 0));
    const seed = Number.isFinite(Number(inputs.seed ?? params.seed)) ? Number(inputs.seed ?? params.seed) : 1;
    const selection = faceSelectionConfigFromParams(params);

    // A wired matrix is the single source of the per-pass transform — its
    // translation/rotation/scale replace the three direct fields entirely.
    let growRotation: THREE.Vector3;
    let growScale: THREE.Vector3;
    let growLocation: THREE.Vector3;
    if (inputs.transform instanceof THREE.Matrix4) {
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scl = new THREE.Vector3();
      inputs.transform.decompose(pos, quat, scl);
      const euler = new THREE.Euler().setFromQuaternion(quat);
      growRotation = new THREE.Vector3(euler.x, euler.y, euler.z);
      growScale = scl;
      growLocation = pos;
    } else {
      const rawScale = inputs.scale !== undefined ? Number(inputs.scale) : Number(params.scale);
      const s = Number.isFinite(rawScale) && rawScale !== 0 ? rawScale : 1;
      growScale = new THREE.Vector3(s, s, s);
      growRotation = asVector3(inputs.rotation, params.rotation instanceof THREE.Vector3 ? params.rotation : new THREE.Vector3()).clone();
      growLocation = asVector3(inputs.location, params.location instanceof THREE.Vector3 ? params.location : new THREE.Vector3()).clone();
    }

    const rawSelection = Array.isArray(inputs.selection) ? (inputs.selection as unknown[]).map((v) => Boolean(v)) : null;

    const state = getState(meshEditCache, ctx.nodeId);
    const transformPart = inputs.transform instanceof THREE.Matrix4
      ? `M${inputs.transform.elements.map((n) => n.toFixed(4)).join(",")}`
      : `${growRotation.toArray().map((n) => n.toFixed(4)).join(",")}:${growScale.toArray().map((n) => n.toFixed(4)).join(",")}:${growLocation.toArray().map((n) => n.toFixed(4)).join(",")}`;
    const signature = `${distance}:${passes}:${transformPart}:${random}:${seed}:${selection.mode}:${selection.axis}:${selection.threshold}:${selection.invert}:${rawSelection ? rawSelection.map(Number).join("") : ""}:${srcGeom.attributes.position.count}:${srcGeom.index?.count ?? -1}`;
    if (state.mesh && state.lastSignature === signature) {
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
      applyExtrudeMaterial(state.mesh, srcMesh, inputs.material);
      return primitiveOutputs(state.mesh);
    }

    const welded = toWeldedMesh(srcGeom);
    if (!welded) return primitiveOutputs(inputObj);

    const faceCount = welded.indices.length / 3;

    // The welded mesh keeps the source's face order (the weld merges
    // vertices, it never reorders triangles), so a selection aligned to the
    // source's index order lines up 1:1. A mismatched-length selection is a
    // wiring error — fall back to the formula rather than silently misalign.
    const selected =
      rawSelection && rawSelection.length === faceCount
        ? rawSelection
        : selectFaces(welded.positions, welded.indices, faceCount, selection);

    if (passes === 0 || distance === 0 || !selected.some(Boolean)) {
      if (inputs.material) {
        applyExtrudeMaterial(srcMesh, srcMesh, inputs.material);
      }
      return primitiveOutputs(inputObj);
    }

    const result = extrudeGrow(welded, selected, distance, {
      passes,
      rotation: growRotation,
      scale: growScale,
      location: growLocation,
      random,
      seed,
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(result.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(result.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    if (!state.mesh) {
      state.mesh = new THREE.Mesh(geometry);
      state.mesh.castShadow = true;
      state.mesh.receiveShadow = true;
    } else {
      state.mesh.geometry.dispose();
      state.mesh.geometry = geometry;
    }
    applyExtrudeMaterial(state.mesh, srcMesh, inputs.material);

    // See the first occurrence above for why matrixWorld (not matrix) and
    // a forced-false matrixAutoUpdate.
    inputObj.updateMatrixWorld(true);
    state.mesh.matrixAutoUpdate = false;
    state.mesh.matrix.copy(srcMesh.matrixWorld);
    preserveModifierUserData(state.mesh, inputObj, srcMesh, ctx.nodeId);
    state.lastSignature = signature;

    return primitiveOutputs(state.mesh);
  },
};

/**
 * Face Selection node — a mesh modifier's face picker, lifted out of Extrude
 * so it is its own wireable thing. Interactive: with the node selected in the
 * graph, Shift+left-click in the viewport selects a face (highlighted green
 * by the viewport) and Shift+right-click deselects it.
 *
 * Extrude used to take a per-vertex Points/Influence override, which was the
 * wrong tool for selecting *faces*: influence is index-aligned to the vertex
 * buffer and meant for painted gradients, so it could neither pick a clean
 * ring of faces nor survive multi-pass extrusion (every new wall vertex
 * shifts the alignment). A face selection is a flat list of booleans, one
 * per triangle in the source geometry's index order — the shape every
 * modifier's selection is really in.
 *
 * The `selection` is the *interactive* set of picked face indices
 * (`selectedFaces`) once the operator has clicked; before that it is the
 * formula selection (Select/Axis/Threshold/Invert), which also acts as the
 * seed the first click starts from. Flip "Interactive" back off to return to
 * the formula.
 *
 * Outputs:
 *  - `selection` — the boolean list itself, wire it straight into Extrude
 *    Mesh's `Face Selection` input;
 *  - `faces` — the integer indices of the selected faces, for composing or
 *    inspecting the result;
 *  - `count` — how many faces are selected;
 *  - `geometry`/`matrix` — the source object passed through, so the mesh it
 *    picks on keeps rendering (and stays the raycast target for picking).
 */
export const FACE_SELECTION_NODE: NodeDefinition = {
  type: "modifier/face-selection",
  label: "Face Selection",
  category: "transform",
  inputs: [
    // `owns`: this node re-emits the source object through its `geometry`
    // output, so the source renders via this node rather than on its own.
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "threshold", label: "Threshold", type: "value" },
  ],
  outputs: [
    { id: "selection", label: "Selection", type: "list" },
    { id: "faces", label: "Faces", type: "list" },
    { id: "count", label: "Count", type: "value" },
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    selectMode: "all",
    axis: "y",
    threshold: 0,
    invert: false,
    // Picked by Shift+clicking faces in the viewport (see Viewport.tsx's
    // face-selection gate). Not exposed as a field — a raw index array is
    // only ever authored by clicking, same convention as Points Selection's
    // `selectedIndices`.
    selectedFaces: [] as number[],
    interactive: false,
  },
  paramFields: [
    ...FACE_SELECTION_PARAM_FIELDS,
    { id: "interactive", label: "Interactive (picked faces win over the formula)", kind: "boolean" },
  ],
  evaluate: (inputs, params) => {
    const inputObj = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (!inputObj) return { selection: [], faces: [], count: 0, geometry: null, matrix: new THREE.Matrix4() };

    const srcMesh = findFirstMesh(inputObj);
    const srcGeom = srcMesh?.geometry;
    if (!srcMesh || !srcGeom || !srcGeom.attributes.position) {
      return { selection: [], faces: [], count: 0, geometry: inputObj, matrix: new THREE.Matrix4() };
    }

    const config = faceSelectionConfigFromParams(params);
    if (inputs.threshold !== undefined && Number.isFinite(Number(inputs.threshold))) {
      config.threshold = Number(inputs.threshold);
    }

    const posAttr = srcGeom.attributes.position;
    const srcIndex = srcGeom.index;
    const faceCount = srcIndex ? srcIndex.count / 3 : posAttr.count / 3;
    const indices: number[] = [];
    if (srcIndex) {
      for (let i = 0; i < srcIndex.count; i++) indices.push(srcIndex.getX(i));
    } else {
      for (let i = 0; i < posAttr.count; i++) indices.push(i);
    }

    const interactive = params.interactive === true;
    let selected: boolean[];
    if (interactive) {
      const picked = new Set(Array.isArray(params.selectedFaces) ? (params.selectedFaces as number[]) : []);
      selected = new Array(faceCount);
      for (let f = 0; f < faceCount; f++) selected[f] = picked.has(f);
    } else {
      selected = selectFaces(posAttr.array as ArrayLike<number>, indices, faceCount, config);
    }

    const faces: number[] = [];
    for (let f = 0; f < faceCount; f++) if (selected[f]) faces.push(f);

    const passthrough = primitiveOutputs(inputObj);
    return { selection: selected, faces, count: faces.length, geometry: passthrough.geometry, matrix: passthrough.matrix };
  },
};

/**
 * Delete Geometry modifier — drops the selected faces entirely rather than
 * moving anything, so unlike Extrude this needs no new topology: surviving
 * faces keep their original vertex indices verbatim, which means position,
 * normal, UV, everything carries through untouched. Orphaned vertices (no
 * longer referenced by any surviving face) are left in the buffer rather
 * than compacted — wasted memory is cheaper than a second remap pass, and
 * three.js draws nothing but what the index buffer points at.
 */
export const DELETE_GEOMETRY_NODE: NodeDefinition = {
  type: "modifier/delete-geometry",
  label: "Delete Geometry",
  category: "transform",
  inputs: [{ id: "geometry", label: "Geometry", type: "geometry", owns: true }],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    // "height" + threshold 0 deletes exactly the upper half by default — a
    // visible, obviously-a-starting-point result, rather than "all" which
    // (with invert off) would delete the entire mesh the instant this node
    // is dropped in.
    selectMode: "height",
    axis: "y",
    threshold: 0,
    invert: false,
  },
  paramFields: FACE_SELECTION_PARAM_FIELDS,
  evaluate: (inputs, params, ctx) => {
    const inputObj = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (!inputObj) return { geometry: null };

    const srcMesh = findFirstMesh(inputObj);
    const srcGeom = srcMesh?.geometry;
    if (!srcMesh || !srcGeom || !srcGeom.attributes.position) {
      warnMeshRequired(ctx.nodeId, "Delete Geometry", inputObj);
      return primitiveOutputs(inputObj);
    }
    clearMeshWarning(ctx.nodeId);

    const selection = faceSelectionConfigFromParams(params);
    const state = getState(meshEditCache, ctx.nodeId);
    const signature = `${selection.mode}:${selection.axis}:${selection.threshold}:${selection.invert}:${srcGeom.attributes.position.count}:${srcGeom.index?.count ?? -1}`;
    if (state.mesh && state.lastSignature === signature) {
      // See the first occurrence above for why matrixWorld (not matrix) and
      // a forced-false matrixAutoUpdate.
      inputObj.updateMatrixWorld(true);
      state.mesh.matrixAutoUpdate = false;
      state.mesh.matrix.copy(srcMesh.matrixWorld);
      preserveModifierUserData(state.mesh, inputObj, srcMesh, ctx.nodeId);
      // Live material inheritance, same as Extrude: the surviving faces keep
      // the source's material, refreshed on cache hits so upstream animation
      // keeps driving it.
      inheritSourceMaterial(state.mesh, srcMesh.material);
      return primitiveOutputs(state.mesh);
    }

    const posAttr = srcGeom.attributes.position;
    const srcIndex = srcGeom.index;
    const faceCount = srcIndex ? srcIndex.count / 3 : posAttr.count / 3;
    const positions = new Float32Array(posAttr.array as ArrayLike<number>);
    const indices: number[] = [];
    if (srcIndex) {
      for (let i = 0; i < srcIndex.count; i++) indices.push(srcIndex.getX(i));
    } else {
      for (let i = 0; i < posAttr.count; i++) indices.push(i);
    }

    const toDelete = selectFaces(positions, indices, faceCount, selection);
    const keepIndices: number[] = [];
    for (let f = 0; f < faceCount; f++) {
      if (toDelete[f]) continue;
      keepIndices.push(indices[f * 3], indices[f * 3 + 1], indices[f * 3 + 2]);
    }

    const geometry = srcGeom.clone();
    geometry.setIndex(keepIndices);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    if (!state.mesh) {
      state.mesh = new THREE.Mesh(geometry);
      state.mesh.castShadow = true;
      state.mesh.receiveShadow = true;
    } else {
      state.mesh.geometry.dispose();
      state.mesh.geometry = geometry;
    }
    inheritSourceMaterial(state.mesh, srcMesh.material);
    // See the first occurrence above for why matrixWorld (not matrix) and
    // a forced-false matrixAutoUpdate.
    inputObj.updateMatrixWorld(true);
    state.mesh.matrixAutoUpdate = false;
    state.mesh.matrix.copy(srcMesh.matrixWorld);
    preserveModifierUserData(state.mesh, inputObj, srcMesh, ctx.nodeId);
    state.lastSignature = signature;

    return primitiveOutputs(state.mesh);
  },
};
