import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { isRealMesh } from "../../three/objectKinds";
import { clearMeshWarning, warnMeshRequired } from "../meshRequired";
import { primitiveOutputs } from "./object";

/**
 * Invert Normals — turns a surface inside out.
 *
 * Two things decide which way a face points, and flipping only one of them
 * looks broken in a different way each time:
 *
 * - the **winding order** of each triangle, which is what backface culling
 *   reads. Flip only this and the far side of the object becomes the visible
 *   one, still lit as though it faced outward.
 * - the **normal vectors**, which are what lighting reads. Flip only these
 *   and the object keeps showing the same faces, now shaded as if the light
 *   were behind them.
 *
 * So "both" is the default and is what Blender's Flip Normals does. The two
 * halves are still offered separately because they answer different
 * questions — "why is my imported model inside out" is winding, "why is this
 * wall lit from the wrong side" is normals.
 */

export const INVERT_MODES = ["both", "normals", "winding"] as const;
export type InvertMode = (typeof INVERT_MODES)[number];

/**
 * Which geometries this node currently has flipped.
 *
 * Flipping is exactly self-inverse — applying it twice restores the original
 * bit for bit — so undoing needs no snapshot of the original arrays, just a
 * record of what was touched. That matters because this mutates geometry
 * owned by an upstream node and cached across frames: without the record,
 * deleting this node would leave the mesh inside out with nothing left in
 * the graph to explain why, and re-running it every frame would flip the
 * same geometry back and forth into a strobe.
 */
interface InvertState {
  flipped: Map<THREE.BufferGeometry, InvertMode>;
}

const invertCache = createNodeCache<InvertState>((state) => {
  for (const [geometry, mode] of state.flipped) applyInversion(geometry, mode);
  state.flipped.clear();
});

/** Reverses each triangle's winding, which is what decides its facing. */
function reverseWinding(geometry: THREE.BufferGeometry): void {
  const index = geometry.getIndex();
  if (index) {
    const array = index.array as unknown as { [i: number]: number; length: number };
    for (let i = 0; i + 2 < index.count; i += 3) {
      const b = array[i + 1];
      array[i + 1] = array[i + 2];
      array[i + 2] = b;
    }
    index.needsUpdate = true;
    return;
  }

  // Unindexed: the triangle's corners *are* consecutive entries in every
  // attribute, so each one has to be swapped in step or positions would come
  // apart from their own UVs and normals.
  for (const name of Object.keys(geometry.attributes)) {
    const attribute = geometry.attributes[name] as THREE.BufferAttribute;
    const itemSize = attribute.itemSize;
    const array = attribute.array as unknown as { [i: number]: number };
    for (let i = 0; i + 2 < attribute.count; i += 3) {
      for (let c = 0; c < itemSize; c++) {
        const bi = (i + 1) * itemSize + c;
        const ci = (i + 2) * itemSize + c;
        const b = array[bi];
        array[bi] = array[ci];
        array[ci] = b;
      }
    }
    attribute.needsUpdate = true;
  }
}

/** Negates every normal, which is what decides how the surface is lit. */
function negateNormals(geometry: THREE.BufferGeometry): void {
  const normal = geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
  if (!normal) return;
  const array = normal.array as unknown as { [i: number]: number; length: number };
  for (let i = 0; i < array.length; i++) array[i] = -array[i];
  normal.needsUpdate = true;
}

/**
 * Applies the inversion in place. Self-inverse: calling it a second time with
 * the same mode restores exactly what was there, which is what the undo on
 * teardown relies on.
 */
export function applyInversion(geometry: THREE.BufferGeometry, mode: InvertMode): void {
  if (mode === "both" || mode === "winding") reverseWinding(geometry);
  if (mode === "both" || mode === "normals") negateNormals(geometry);
}

/** Every real mesh under an object — a modifier has no reason to stop at the first one. */
export function collectInvertTargets(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse((child) => {
    if (!isRealMesh(child)) return;
    // Helper geometry (a clip cap's stencil draw, a light's icon) is not the
    // model, and flipping it would corrupt what it is there to do.
    if (child.userData.__clipCapHelper || child.userData.isHelper) return;
    if (child.geometry?.getAttribute("position")) meshes.push(child);
  });
  return meshes;
}

/**
 * Brings the set of flipped geometries in line with what the node should be
 * flipping now: flips what isn't yet, and un-flips what it no longer reaches
 * or what it flipped a different way. Rewiring the input, changing the mode,
 * or an upstream node rebuilding its geometry all land here.
 */
export function syncInversion(state: InvertState, targets: THREE.Mesh[], mode: InvertMode): void {
  const wanted = new Map<THREE.BufferGeometry, InvertMode>();
  for (const mesh of targets) wanted.set(mesh.geometry, mode);

  for (const [geometry, appliedMode] of [...state.flipped]) {
    if (wanted.get(geometry) === appliedMode) continue;
    applyInversion(geometry, appliedMode);
    state.flipped.delete(geometry);
  }

  for (const [geometry, wantedMode] of wanted) {
    if (state.flipped.has(geometry)) continue;
    applyInversion(geometry, wantedMode);
    state.flipped.set(geometry, wantedMode);
  }
}

function getState(nodeId: string): InvertState {
  let state = invertCache.get(nodeId);
  if (!state) {
    state = { flipped: new Map() };
    invertCache.set(nodeId, state);
  }
  return state;
}

/** Invert Normals node — flips a surface's facing, its shading, or both. */
export const INVERT_NORMALS_NODE: NodeDefinition = {
  type: "modifier/invert-normals",
  label: "Invert Normals",
  category: "modeling",
  inputs: [{ id: "geometry", label: "Geometry", type: "geometry", owns: true }],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    mode: "both",
  },
  paramFields: [{ id: "mode", label: "Flip", kind: "select", options: [...INVERT_MODES] }],
  evaluate: (inputs, params, ctx) => {
    const state = getState(ctx.nodeId);
    const inputObj = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (!inputObj) {
      // Unwiring has to release what was flipped, or the last object stays
      // inside out with nothing connected to explain it.
      syncInversion(state, [], "both");
      return { geometry: null, matrix: new THREE.Matrix4() };
    }

    const mode: InvertMode = (INVERT_MODES as readonly string[]).includes(String(params.mode))
      ? (params.mode as InvertMode)
      : "both";

    const targets = collectInvertTargets(inputObj);
    if (targets.length === 0) {
      syncInversion(state, [], mode);
      warnMeshRequired(ctx.nodeId, "Invert Normals", inputObj);
      return primitiveOutputs(inputObj);
    }
    clearMeshWarning(ctx.nodeId);

    syncInversion(state, targets, mode);

    return primitiveOutputs(inputObj);
  },
};
