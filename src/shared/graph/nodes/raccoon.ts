import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { raccoonGeometry } from "../../three/raccoonGeometry";
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

/**
 * Disposes the mesh's material but never its geometry — that one is shared
 * by every Raccoon in the graph (see raccoonGeometry), so freeing it with
 * the first node deleted would empty every other one.
 */
const meshCache = createNodeCache<THREE.Mesh>((mesh) => {
  const material = mesh.material;
  if (Array.isArray(material)) material.forEach((m) => m.dispose());
  else material?.dispose();
});

function raccoonMesh(nodeId: string): THREE.Mesh {
  const existing = meshCache.get(nodeId);
  if (existing) return existing;
  const mesh = new THREE.Mesh(raccoonGeometry(), new THREE.MeshStandardMaterial({ color: 0xffffff }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.nodeId = nodeId;
  meshCache.set(nodeId, mesh);
  return mesh;
}

/**
 * Raccoon — a primitive like Box or Sphere, just with a shape nobody wants
 * to type coordinates for.
 *
 * A primitive, not a loader: its mesh is baked into the source
 * (raccoonGeometry.ts), so it needs no file, no path to rehydrate and
 * nothing that can go missing on another machine — exactly the contract the
 * other primitives keep, and the one Object (OBJ) cannot (rehydrateFiles is
 * Tauri-only and reads absolute local paths).
 *
 * Unlike Box and Sphere it is centred on X/Z with its feet on y=0 rather
 * than around its own middle, because a standing figure that half-sinks
 * through the floor by default is a worse starting point than one already
 * on it.
 */
export const OBJECT_RACCOON_NODE: NodeDefinition = {
  type: "object/raccoon",
  label: "Raccoon",
  category: "object",
  inputs: [...COMMON_PRIMITIVE_INPUTS],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: { ...COMMON_DEFAULT_PARAMS },
  paramFields: buildPrimitiveDynamicParamFields()(),
  dynamicParamFields: buildPrimitiveDynamicParamFields(),
  evaluate: (inputs, params, ctx) => {
    const mesh = raccoonMesh(ctx.nodeId);

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    const matParams = extractMaterialParams(inputs, params);
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);
    applyMaterialParams(mesh, matParams, THREE.FrontSide, texParams);

    return primitiveOutputs(mesh, params);
  },
};
