import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { InstancedItemSpec, renderInstanced } from "./instancedRender";
import { getSourcePivot } from "./transform";

const groupCache = createNodeCache<THREE.Group>(disposeObject3D);

function getGroup(nodeId: string): THREE.Group {
  let g = groupCache.get(nodeId);
  if (!g) {
    g = new THREE.Group();
    groupCache.set(nodeId, g);
  }
  return g;
}

function numberInput(input: unknown, param: unknown, fallback: number): number {
  const raw = input !== undefined ? input : param;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Hex Grid node — distributes points and instances in a regular hexagonal honeycomb pattern.
 * Supports pointy-topped and flat-topped orientations across XZ, XY, and YZ planes.
 */
export const HEX_GRID_NODE: NodeDefinition = {
  type: "structure/hex-grid",
  label: "Hex Grid",
  category: "structure",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "cols", label: "Cols (X)", type: "value" },
    { id: "rows", label: "Rows (Z/Y)", type: "value" },
    { id: "radius", label: "Hex Radius", type: "value" },
    { id: "spacing", label: "Spacing Multiplier", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "positions", label: "Positions", type: "list" },
    { id: "count", label: "Count", type: "value" },
    { id: "xValues", label: "X Values", type: "list" },
    { id: "yValues", label: "Y Values", type: "list" },
    { id: "zValues", label: "Z Values", type: "list" },
  ],
  defaultParams: {
    visible: 1,
    cols: 8,
    rows: 8,
    radius: 1.0,
    spacing: 1.0,
    orientation: "pointy",
    plane: "XZ",
    center: true,
    gpuInstancing: false,
  },
  paramFields: [
    { id: "visible", label: "Visible", kind: "boolean" },
    { id: "gpuInstancing", label: "GPU Instancing (1 draw call)", kind: "boolean" },
    { id: "cols", label: "Cols (X)", kind: "number", step: 1 },
    { id: "rows", label: "Rows (Z/Y)", kind: "number", step: 1 },
    { id: "radius", label: "Hex Radius", kind: "number", step: 0.1 },
    { id: "spacing", label: "Spacing Multiplier", kind: "number", step: 0.05 },
    { id: "orientation", label: "Orientation", kind: "select", options: ["pointy", "flat"] },
    { id: "plane", label: "Plane", kind: "select", options: ["XZ", "XY", "YZ"] },
    { id: "center", label: "Center Grid", kind: "boolean" },
  ],
  dynamicParamFields: () => [
    { id: "cols", label: "Cols (X)", kind: "number", step: 1, group: "Hex Pattern" },
    { id: "rows", label: "Rows (Z/Y)", kind: "number", step: 1, group: "Hex Pattern" },
    { id: "radius", label: "Hex Radius", kind: "number", step: 0.1, group: "Hex Pattern" },
    { id: "spacing", label: "Spacing Multiplier", kind: "number", step: 0.05, group: "Hex Pattern" },
    { id: "orientation", label: "Orientation", kind: "select", options: ["pointy", "flat"], group: "Hex Pattern" },
    { id: "plane", label: "Plane", kind: "select", options: ["XZ", "XY", "YZ"], group: "Hex Pattern" },
    { id: "center", label: "Center Grid", kind: "boolean", group: "Hex Pattern" },
    {
      id: "gpuInstancing",
      label: "GPU Instancing (1 draw call — disables Get/Set Instance)",
      kind: "boolean",
      group: "Performance",
    },
  ],
  evaluate: (inputs, params, ctx) => {
    const group = getGroup(ctx.nodeId);
    group.clear();

    const cols = Math.max(1, Math.min(200, Math.floor(numberInput(inputs.cols, params.cols, 8))));
    const rows = Math.max(1, Math.min(200, Math.floor(numberInput(inputs.rows, params.rows, 8))));
    const radius = Math.max(0.001, numberInput(inputs.radius, params.radius, 1.0));
    const spacing = Math.max(0.001, numberInput(inputs.spacing, params.spacing, 1.0));
    const orientation = String(params.orientation || "pointy");
    const plane = String(params.plane || "XZ");
    const center = Boolean(params.center ?? true);
    const gpuInstancing = Boolean(params.gpuInstancing);

    // Geometric step deltas
    let dx = 0;
    let dz = 0;
    if (orientation === "flat") {
      dx = 1.5 * radius * spacing;
      dz = Math.sqrt(3) * radius * spacing;
    } else {
      // pointy-topped (default)
      dx = Math.sqrt(3) * radius * spacing;
      dz = 1.5 * radius * spacing;
    }

    const maxX = orientation === "flat"
      ? (cols - 1) * dx
      : (cols - 1) * dx + (rows > 1 ? 0.5 * dx : 0);
    const maxZ = orientation === "flat"
      ? (rows - 1) * dz + (cols > 1 ? 0.5 * dz : 0)
      : (rows - 1) * dz;

    const halfX = center ? maxX / 2 : 0;
    const halfZ = center ? maxZ / 2 : 0;

    const positions: THREE.Vector3[] = [];
    const xValues: number[] = [];
    const yValues: number[] = [];
    const zValues: number[] = [];

    const instancedItems: InstancedItemSpec[] = [];
    const itemSource = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    const sourcePivot = itemSource ? getSourcePivot(itemSource) : null;
    const hasPivot = Boolean(sourcePivot && sourcePivot.lengthSq() > 1e-9);
    const pivotInv = hasPivot && sourcePivot ? new THREE.Matrix4().makeTranslation(-sourcePivot.x, -sourcePivot.y, -sourcePivot.z) : null;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let lx = 0;
        let lz = 0;

        if (orientation === "flat") {
          const colOffset = (c % 2) * 0.5 * dz;
          lx = c * dx - halfX;
          lz = r * dz + colOffset - halfZ;
        } else {
          // pointy
          const rowOffset = (r % 2) * 0.5 * dx;
          lx = c * dx + rowOffset - halfX;
          lz = r * dz - halfZ;
        }

        const pos = new THREE.Vector3();
        const scale = new THREE.Vector3(1, 1, 1);
        const rot = new THREE.Quaternion();

        if (plane === "XY") {
          pos.set(lx, lz, 0);
        } else if (plane === "YZ") {
          pos.set(0, lx, lz);
        } else {
          // XZ plane (ground default)
          pos.set(lx, 0, lz);
        }

        positions.push(pos);
        xValues.push(pos.x);
        yValues.push(pos.y);
        zValues.push(pos.z);

        if (itemSource) {
          const instanceMatrix = new THREE.Matrix4().compose(pos, rot, scale);
          if (gpuInstancing) {
            instancedItems.push({ template: itemSource, matrix: instanceMatrix });
          } else {
            const clone = itemSource.clone(true);
            if (pivotInv) {
              clone.matrixAutoUpdate = false;
              clone.matrix.copy(itemSource.matrix).multiply(pivotInv);
            }
            const wrapper = new THREE.Group();
            wrapper.matrixAutoUpdate = false;
            wrapper.matrix.copy(instanceMatrix);
            if (hasPivot && sourcePivot) wrapper.userData.pivot = sourcePivot.clone();
            wrapper.add(clone);
            group.add(wrapper);
          }
        }
      }
    }

    if (itemSource) {
      if (gpuInstancing) {
        renderInstanced(ctx.nodeId, group, instancedItems);
      }
    } else {
      // Fallback point-cloud preview when no geometry is connected
      const ptsGeom = new THREE.BufferGeometry().setFromPoints(positions);
      const ptsMat = new THREE.PointsMaterial({ color: 0x88bbff, size: 0.2 });
      const pts = new THREE.Points(ptsGeom, ptsMat);
      group.add(pts);
    }

    return {
      geometry: group,
      positions,
      count: positions.length,
      xValues,
      yValues,
      zValues,
    };
  },
};
