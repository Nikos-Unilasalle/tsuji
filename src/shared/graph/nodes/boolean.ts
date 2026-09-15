import * as THREE from "three";
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from "three-bvh-csg";
import { bakeMeshesToGeometry, collectMeshMaterials } from "../bakeGeometry";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { sideSignature } from "../geometrySignature";
import { clearMeshWarning, collectMeshes, warnMeshRequired } from "../meshRequired";
import { prepareGeometryForMaterial, primitiveOutputs } from "./object";


interface BooleanState {
  mesh?: THREE.Mesh;
  /** Skips re-running the (expensive) CSG when neither geometry, pose nor params changed. */
  lastSignature?: string;
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

/** three-bvh-csg stores its MeshBVH on `geometry.n` — null it before disposing. */
function disposeGeometry(g: THREE.BufferGeometry): void {
  (g as { n?: unknown }).n = null;
  g.dispose();
}

const OPERATIONS: Record<string, number> = { add: ADDITION, subtract: SUBTRACTION, intersect: INTERSECTION };

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
    const srcA = meshesA[0];

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
    if (state.mesh && state.lastSignature === signature) {
      return primitiveOutputs(state.mesh);
    }

    // Each side baked into one world-space geometry — the shapes meet
    // wherever you actually positioned them. Each side's geometry carries one
    // group per source mesh (see bakeMeshesToGeometry), so a per-mesh
    // material array lines up with those groups and every mesh's own
    // material/texture survives, not just the first one on each side.
    // Shared with Freeze — see bakeGeometry.ts for why the parts are
    // concatenated rather than unioned.
    const geometryA = bakeMeshesToGeometry(meshesA);
    const geometryB = bakeMeshesToGeometry(meshesB);
    if (!geometryA || !geometryB) {
      // mergeGeometries refused the parts — hand the input back rather than
      // feed the CSG a half-built brush.
      if (geometryA) disposeGeometry(geometryA);
      if (geometryB) disposeGeometry(geometryB);
      console.error("Boolean: could not merge the parts of an input into one shape");
      return primitiveOutputs(inputA);
    }
    const materialsA = collectMeshMaterials(meshesA);
    const materialsB = collectMeshMaterials(meshesB);
    const brushA = new Brush(geometryA, materialsA.length > 1 ? materialsA : materialsA[0]);
    const brushB = new Brush(geometryB, materialsB.length > 1 ? materialsB : materialsB[0]);

    try {
      const evaluator = new Evaluator();
      evaluator.useGroups = useGroups;
      const result = evaluator.evaluate(brushA, brushB, OPERATIONS[operation] ?? SUBTRACTION);
      const geometry = result.geometry;

      const resultMaterial = useGroups ? result.material : srcA.material;
      if (!state.mesh) {
        state.mesh = new THREE.Mesh(geometry, resultMaterial);
        state.mesh.castShadow = true;
        state.mesh.receiveShadow = true;
      } else {
        disposeGeometry(state.mesh.geometry);
        state.mesh.geometry = geometry;
        // useGroups → the library hands back a per-input material array, so
        // faces from object 2 inherit object 2's material; otherwise a single
        // material (object 1's) applies to the whole result.
        state.mesh.material = resultMaterial;
      }
      // A bare `mesh.material = ...` skips any material's `__prepareGeometry`
      // hook (Worn's per-triangle curvature, e.g.) — it needs to run on the
      // CSG's own output geometry, which exists only from this point on.
      prepareGeometryForMaterial(state.mesh, resultMaterial);
      // The result is already positioned (both inputs baked) — local identity.
      state.mesh.matrixAutoUpdate = false;
      state.mesh.matrix.identity();
      state.lastSignature = signature;
      return primitiveOutputs(state.mesh);
    } catch (err) {
      console.error("Boolean CSG failed:", err);
      return primitiveOutputs(inputA);
    } finally {
      disposeGeometry(brushA.geometry);
      disposeGeometry(brushB.geometry);
    }
  },
};
