import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { bakeMeshesToGeometry, FrozenGeometryData, geometryToFrozenData } from "../bakeGeometry";
import { collectMeshes } from "../meshRequired";
import { composeNativeMatrix } from "./transform";
import {
  applyMaterialParams,
  buildPrimitiveDynamicParamFields,
  COMMON_DEFAULT_PARAMS,
  COMMON_PRIMITIVE_INPUTS,
  COMMON_PRIMITIVE_OUTPUTS,
  extractMaterialParams,
  extractTextureParams,
  primitiveOutputs,
} from "./object";

interface FrozenState {
  mesh: THREE.Mesh;
  /** The exact params.positions array the current geometry was built from — a new Bake creates a new array, so identity is enough to detect it. */
  builtFrom?: unknown;
}

const frozenCache = createNodeCache<FrozenState>((s) => disposeObject3D(s.mesh));

/** Action id the Recalculate UVs button sends up to App.tsx's onAction — see the handler next to EDIT_MESH_UNWRAP_UVS_ACTION. */
export const FROZEN_UNWRAP_UVS_ACTION = "object/frozen-unwrap-uvs";

function buildGeometry(params: Record<string, unknown>): THREE.BufferGeometry {
  const positions = Array.isArray(params.positions) ? (params.positions as number[]) : [];
  const normals = Array.isArray(params.normals) ? (params.normals as number[]) : [];
  const uvs = Array.isArray(params.uvs) ? (params.uvs as number[]) : [];
  const index = Array.isArray(params.index) ? (params.index as number[]) : null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (normals.length === positions.length) {
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  } else {
    geometry.computeVertexNormals();
  }
  if (uvs.length > 0) geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  if (index) geometry.setIndex(index);
  return geometry;
}

/**
 * Frozen Geometry node — the actual output of Particle Render (Instances)'
 * Bake button (see bakeInstancesToGeometryData in particleInstances.ts). Its
 * geometry is stored as plain number arrays in params rather than a live
 * THREE object, so it round-trips through save/reload like any other node
 * and, being a real single Mesh, is exactly what Boolean, Subdivide and
 * Lattice Deform need (see meshRequired.ts) — none of which accept the
 * InstancedMesh it was captured from.
 */
export const OBJECT_FROZEN_NODE: NodeDefinition = {
  type: "object/frozen",
  label: "Frozen Geometry",
  category: "object",
  inputs: [...COMMON_PRIMITIVE_INPUTS],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: {
    ...COMMON_DEFAULT_PARAMS,
    positions: [] as number[],
    normals: [] as number[],
    uvs: [] as number[],
    index: null as number[] | null,
    // A baked-in geometry has no upstream node whose own default side choice
    // this could otherwise inherit (Box picks FrontSide, Plane picks
    // DoubleSide, each baked into their own evaluate call) — a source that
    // was two-sided (glTF's own doubleSided flag, e.g. a leaf or a cloth
    // panel with real thickness) needs its own switch here instead.
    doubleSided: 0,
  },
  paramFields: buildPrimitiveDynamicParamFields([
    { id: "doubleSided", label: "Double Sided", kind: "boolean", group: "Material" },
    { id: "unwrapButton", label: "Recalculate UVs", kind: "button", action: FROZEN_UNWRAP_UVS_ACTION },
  ])(),
  dynamicParamFields: buildPrimitiveDynamicParamFields([
    { id: "doubleSided", label: "Double Sided", kind: "boolean", group: "Material" },
    { id: "unwrapButton", label: "Recalculate UVs", kind: "button", action: FROZEN_UNWRAP_UVS_ACTION },
  ]),
  evaluate: (inputs, params, ctx) => {
    let state = frozenCache.get(ctx.nodeId);
    if (!state || state.builtFrom !== params.positions) {
      if (state) disposeObject3D(state.mesh);
      const mesh = new THREE.Mesh(buildGeometry(params), new THREE.MeshStandardMaterial({ color: 0xffffff }));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.nodeId = ctx.nodeId;
      state = { mesh, builtFrom: params.positions };
      frozenCache.set(ctx.nodeId, state);
    }
    const mesh = state.mesh;

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    const matParams = extractMaterialParams(inputs, params);
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);
    const side = params.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
    applyMaterialParams(mesh, matParams, side, texParams);

    return primitiveOutputs(mesh);
  },
};

/** Action id the Freeze button sends up to App.tsx's onAction — see freezeObjectToGeometryData. */
export const FREEZE_GEOMETRY_ACTION = "object/freeze-to-frozen-node";

/**
 * Whatever a node is currently drawing, flattened into the plain arrays a
 * Frozen Geometry node stores.
 *
 * This is the generic counterpart of Particle Render's Bake and glTF's
 * Explode: those read one specific node's private cache, while this takes any
 * node's evaluated `geometry` output. What comes back has no tie to the graph
 * that produced it, which is the point — Freeze exists to cut a long chain of
 * expensive modifiers loose and keep only its result.
 *
 * Everything is baked in WORLD space and the new node is left at the origin,
 * so the frozen copy lands exactly where the original was rather than
 * needing the upstream transform chain replayed onto it.
 *
 * Returns null when there is nothing meshy to freeze — a Points cloud, a fat
 * line, an empty group — which the caller reports rather than treating as a
 * failure.
 */
export function freezeObjectToGeometryData(object: THREE.Object3D): FrozenGeometryData | null {
  // The tree is evaluated, not rendered, so its cached matrixWorld is
  // whatever the last frame left. Forcing from the root is the only reliable
  // refresh here — see the same call in decal.ts for why the non-forcing
  // variant silently does nothing on a primitive that writes `.matrix`.
  object.updateMatrixWorld(true);
  const meshes = collectMeshes(object);
  if (meshes.length === 0) return null;
  const geometry = bakeMeshesToGeometry(meshes);
  if (!geometry) return null;
  const data = geometryToFrozenData(geometry);
  geometry.dispose();
  return data;
}
