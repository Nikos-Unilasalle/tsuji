import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { composeNativeMatrix } from "./transform";

interface CachedGrid {
  grid: THREE.GridHelper;
  size: number;
  divisions: number;
  colorHex: number;
}

const gridCache = createNodeCache<CachedGrid>((c) => disposeObject3D(c.grid));

function getGrid(nodeId: string, size: number, divisions: number, color: THREE.Color): THREE.GridHelper {
  const colorHex = color.getHex();
  const cached = gridCache.get(nodeId);
  if (cached && cached.size === size && cached.divisions === divisions && cached.colorHex === colorHex) {
    return cached.grid;
  }
  if (cached) {
    cached.grid.geometry.dispose();
    (cached.grid.material as THREE.Material).dispose();
  }
  const grid = new THREE.GridHelper(size, divisions, color, color);
  grid.userData.nodeId = nodeId;
  gridCache.set(nodeId, { grid, size, divisions, colorHex });
  return grid;
}

/**
 * "3D Grid" from BIBLE.md's Calibration section — a visual overlay for
 * millimetring animations (and Manual Alignment, see camera.ts) against
 * the real physical space. Can be transformed natively like any 3D primitive.
 */
export const GRID_NODE: NodeDefinition = {
  type: "calibration/grid",
  label: "3D Grid",
  category: "camera",
  inputs: [{ id: "matrix", label: "Matrix", type: "matrix" }],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    size: 10,
    divisions: 10,
    color: new THREE.Color(0x38bdf8),
  },
  dynamicParamFields: () => [
    { id: "location", label: "Location", kind: "vector", group: "Transform" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true, group: "Transform" },
    { id: "scale", label: "Scale", kind: "vector", group: "Transform" },

    { id: "size", label: "Size", kind: "number", step: 1, group: "Grid" },
    { id: "divisions", label: "Divisions", kind: "number", step: 1, group: "Grid" },
    { id: "color", label: "Color", kind: "color", group: "Grid" },
  ],
  evaluate: (inputs, params, ctx) => {
    const size = Math.max(0.01, Number(params.size) || 10);
    const divisions = Math.max(1, Math.floor(Number(params.divisions) || 10));
    const color = params.color instanceof THREE.Color ? params.color : new THREE.Color(0x38bdf8);
    const grid = getGrid(ctx.nodeId, size, divisions, color);

    grid.userData.nodeId = ctx.nodeId;

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      const wiredMatrix = inputs.matrix instanceof THREE.Matrix4 ? inputs.matrix.clone() : new THREE.Matrix4();
      grid.matrixAutoUpdate = false;
      grid.matrix.copy(composeNativeMatrix(wiredMatrix, params.location, params.rotation, params.scale, params));
    }

    return {
      geometry: grid,
      matrix: grid.matrix.clone(),
    };
  },
};
