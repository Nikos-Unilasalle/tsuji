import * as THREE from "three";
import { bakeMeshesToGeometry, collectMeshMaterials } from "../bakeGeometry";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { sideSignature } from "../geometrySignature";
import { clearMeshWarning, collectMeshes, warnMeshRequired } from "../meshRequired";
import { prepareGeometryForMaterial, primitiveOutputs } from "./object";
import { requestJob } from "../offthread/jobs";
import { BooleanJob, BooleanResult, CsgSide, geometryData, geometryFromData } from "../offthread/csg";


interface BooleanState {
  mesh?: THREE.Mesh;
  /** Signature of the job result last applied to `mesh` (or that failed). */
  lastSignature?: string;
  /** That result's error: the node passes its first input through instead. */
  error?: string | null;
}

const booleanCache = createNodeCache<BooleanState>((s) => {
  if (s.mesh) disposeObject3D(s.mesh);
});

function getState(nodeId: string): BooleanState {
  let state = booleanCache.get(nodeId);
  if (!state) {
    state = {};
    booleanCache.set(nodeId, state);
  }
  return state;
}

/**
 * Every distinct material across both sides, numbered, and which number each
 * side's meshes use — what the worker's placeholder materials stand for (see
 * offthread/csg.ts). Identity matters: three-bvh-csg merges slots that share
 * a material, so two meshes sharing one must share its number.
 */
function materialTable(meshesA: THREE.Mesh[], meshesB: THREE.Mesh[]): { table: THREE.Material[]; a: number[]; b: number[] } {
  const table: THREE.Material[] = [];
  const number = (m: THREE.Material) => {
    let i = table.indexOf(m);
    if (i < 0) i = table.push(m) - 1;
    return i;
  };
  const a = collectMeshMaterials(meshesA).map(number);
  const b = collectMeshMaterials(meshesB).map(number);
  return { table, a, b };
}

/**
 * Each side baked into one world-space geometry — the shapes meet wherever
 * you actually positioned them. Each side's geometry carries one group per
 * source mesh (see bakeMeshesToGeometry), so a per-mesh material array lines
 * up with those groups and every mesh's own material/texture survives, not
 * just the first one on each side. Shared with Freeze — see bakeGeometry.ts
 * for why the parts are concatenated rather than unioned.
 *
 * The bake clones every attribute, so the payload's arrays are already this
 * node's own copies: transferring them to the worker detaches nothing upstream.
 */
function booleanJob(meshesA: THREE.Mesh[], meshesB: THREE.Mesh[], operation: string, useGroups: boolean): BooleanJob {
  const materials = materialTable(meshesA, meshesB);
  const side = (meshes: THREE.Mesh[], numbers: number[]): CsgSide | null => {
    const geometry = bakeMeshesToGeometry(meshes);
    if (!geometry) return null;
    const data = geometryData(geometry);
    // Drop the geometry object, not its arrays: they are the payload now.
    geometry.dispose();
    return { ...data, materials: numbers };
  };
  return { a: side(meshesA, materials.a), b: side(meshesB, materials.b), operation, useGroups, materialCount: materials.table.length };
}

function applyResult(state: BooleanState, result: BooleanResult, meshesA: THREE.Mesh[], meshesB: THREE.Mesh[], useGroups: boolean): void {
  const geometry = geometryFromData(result, result.drawCount);
  // useGroups → the library hands back a per-input material array, so faces
  // from object 2 inherit object 2's material; otherwise a single material
  // (object 1's) applies to the whole result. Mapped back through today's
  // table: the meshes are the same ones the job was built from unless the
  // inputs changed since, and then a newer job is already on its way.
  const { table } = materialTable(meshesA, meshesB);
  const srcMaterial = meshesA[0].material;
  const resultMaterial = useGroups
    ? result.materials.map((i) => table[i] ?? (Array.isArray(srcMaterial) ? srcMaterial[0] : srcMaterial))
    : srcMaterial;
  if (!state.mesh) {
    state.mesh = new THREE.Mesh(geometry, resultMaterial);
    state.mesh.castShadow = true;
    state.mesh.receiveShadow = true;
  } else {
    state.mesh.geometry.dispose();
    state.mesh.geometry = geometry;
    state.mesh.material = resultMaterial;
  }
  // A bare `mesh.material = ...` skips any material's `__prepareGeometry`
  // hook (Worn's per-triangle curvature, e.g.) — it needs to run on the
  // CSG's own output geometry, which exists only from this point on.
  prepareGeometryForMaterial(state.mesh, resultMaterial);
  // The result is already positioned (both inputs baked) — local identity.
  state.mesh.matrixAutoUpdate = false;
  state.mesh.matrix.identity();
}

/**
 * Boolean (CSG) modifier — combines two closed meshes via union / subtraction /
 * intersection using three-bvh-csg. Both inputs' world transforms are baked into
 * their geometry first, so the shapes meet wherever you actually placed them.
 *
 * For the cleanest result both inputs should be watertight (manifold, no open
 * edges) — CSG cannot recover from open or self-intersecting surfaces.
 */
export const BOOLEAN_NODE: NodeDefinition = {
  type: "modifier/boolean",
  label: "Boolean",
  category: "transform",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "boolean", label: "Boolean Shape", type: "geometry", owns: true },
    { id: "operation", label: "Operation", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    operation: "subtract",
    useGroups: true,
  },
  paramFields: [
    { id: "operation", label: "Operation", kind: "select", options: ["add", "subtract", "intersect"] },
    { id: "useGroups", label: "Keep Materials (Groups)", kind: "boolean" },
  ],
  evaluate: (inputs, params, ctx) => {
    const inputA = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    const inputB = inputs.boolean instanceof THREE.Object3D ? inputs.boolean : null;
    if (!inputA || !inputB) {
      return inputA ? primitiveOutputs(inputA) : { geometry: null };
    }

    // Every mesh on each side, not just the first: an Array (or a Merge, or
    // an imported model) is a Group of many, and all of them take part.
    const meshesA = collectMeshes(inputA);
    const meshesB = collectMeshes(inputB);
    if (meshesA.length === 0 || meshesB.length === 0) {
      warnMeshRequired(ctx.nodeId, "Boolean", meshesA.length > 0 ? inputB : inputA);
      return primitiveOutputs(inputA);
    }
    clearMeshWarning(ctx.nodeId);

    // Recompute the sources' world matrices, forced, from their OWN root
    // (inputA/inputB), not from the found mesh: a mesh feeding a modifier is
    // no longer drawn itself, so nothing keeps its matrixWorld fresh, and
    // `mesh.updateWorldMatrix(true, false, true)` only forwards `force` to
    // the mesh itself — three's own updateWorldMatrix does NOT propagate
    // force to the parent it climbs to (see Object3D.updateWorldMatrix), so
    // a mesh nested under a posed wrapper group whose own matrixWorldNeedsUpdate
    // was never set (OBJ Model bakes its pose onto exactly such a group)
    // still computed a stale/identity world matrix despite this call.
    // updateMatrixWorld(true) from the root correctly cascades force
    // downward through every descendant instead.
    inputA.updateMatrixWorld(true);
    inputB.updateMatrixWorld(true);

    const operation = String(inputs.operation ?? params.operation ?? "subtract");
    const useGroups = Boolean(params.useGroups);

    const state = getState(ctx.nodeId);

    const signature = JSON.stringify([operation, useGroups, sideSignature(meshesA), sideSignature(meshesB)]);

    // The CSG runs in the geometry worker (offthread/jobs.ts): this frame
    // shows the newest finished result, which trails moving inputs by a frame
    // or so and is exact once they stop. Export capture runs it inline. Only
    // a job that actually starts bakes the two sides.
    const job = requestJob(ctx.nodeId, "boolean", signature, () => booleanJob(meshesA, meshesB, operation, useGroups), {
      sync: ctx.capturing === true,
    });
    const result = job.result;
    if (result && job.signature !== state.lastSignature) {
      state.lastSignature = job.signature!;
      state.error = result.error;
      if (result.error === "merge") {
        // mergeGeometries refused the parts — hand the input back rather than
        // feed the CSG a half-built brush.
        console.error("Boolean: could not merge the parts of an input into one shape");
      } else if (result.error) {
        console.error("Boolean CSG failed:", result.error);
      } else {
        applyResult(state, result, meshesA, meshesB, useGroups);
      }
    }
    if (!state.mesh || state.error) return primitiveOutputs(inputA);
    return primitiveOutputs(state.mesh);
  },
};
