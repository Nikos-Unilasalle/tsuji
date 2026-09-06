import * as THREE from "three";
import { NodeDefinition, ParamFieldDef } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { InstancedItemSpec, renderInstanced } from "./instancedRender";
import { getSourcePivot } from "./transform";

const groupCache = createNodeCache<THREE.Group>(disposeObject3D);

function attachInstance(
  itemSource: THREE.Object3D,
  instanceMatrix: THREE.Matrix4,
  gpuInstancing: boolean,
  instancedItems: InstancedItemSpec[],
  group: THREE.Group,
): void {
  if (gpuInstancing) {
    instancedItems.push({ template: itemSource, matrix: instanceMatrix });
    return;
  }

  const sourcePivot = getSourcePivot(itemSource);
  const hasPivot = sourcePivot.lengthSq() > 1e-9;
  const pivotInv = hasPivot ? new THREE.Matrix4().makeTranslation(-sourcePivot.x, -sourcePivot.y, -sourcePivot.z) : null;

  const clone = itemSource.clone(true);
  if (pivotInv) {
    clone.matrixAutoUpdate = false;
    clone.matrix.copy(itemSource.matrix).multiply(pivotInv);
  }
  const wrapper = new THREE.Group();
  wrapper.matrixAutoUpdate = false;
  wrapper.matrix.copy(instanceMatrix);
  if (hasPivot) wrapper.userData.pivot = sourcePivot.clone();
  wrapper.add(clone);

  group.add(wrapper);
}

function getGroup(nodeId: string): THREE.Group {
  const existing = groupCache.get(nodeId);
  if (existing) return existing;
  const group = new THREE.Group();
  groupCache.set(nodeId, group);
  return group;
}

/** GLSL-style fract() — deterministic per-index hash, same construct used for lifetime variance elsewhere. */
function fract(x: number): number {
  return x - Math.floor(x);
}

/**
 * Cumulative offsets with each gap jittered by up to +/-variance — a
 * per-instance offset jitter (each item nudged independently) would still
 * leave every *gap* exactly `step`, reading as perfectly even items that
 * merely wobble in place; varying the gap itself, and accumulating, is what
 * actually makes consecutive distances uneven the way real-world spacing is.
 * The hash is a pure function of the gap's own index, not of runtime state,
 * so re-evaluating the same Count/Spacing/Variance always reproduces the
 * same layout. `step` is whatever unit the caller is spacing in — world
 * units for linear/grid, radians for circular, a dimensionless "cell" for
 * curve mode (see its own normalization).
 */
function cumulativeOffsetsWithVariance(count: number, step: number, variance: number): number[] {
  const offsets = [0];
  for (let i = 1; i < count; i++) {
    const rand = fract(Math.sin(i * 78.233) * 43758.5453);
    const gap = step * (1 + variance * (rand * 2 - 1));
    offsets.push(offsets[i - 1] + gap);
  }
  return offsets;
}

/**
 * A centered row of `count` cumulative offsets (see above), shifted so the
 * row as a whole is centered on 0 — the jittered equivalent of grid/grid3d's
 * `(i - (count-1)/2) * spacing`. With variance the row's total span is no
 * longer exactly `(count-1)*spacing`, so it centers on the row's own actual
 * span rather than the nominal one; individual gaps stay jittered either way.
 */
function centeredOffsetsWithVariance(count: number, step: number, variance: number, center: boolean): number[] {
  const offsets = cumulativeOffsetsWithVariance(count, step, variance);
  if (!center) return offsets;
  const half = offsets[count - 1] / 2;
  return offsets.map((o) => o - half);
}

/**
 * Array node — duplicates a 3D Geometry input multiple times.
 * Supports Linear, Circular, 2D Grid, and 3D Grid Volume arrays.
 */
export const ARRAY_NODE: NodeDefinition = {
  type: "structure/array",
  label: "Array",
  category: "instance",
  inputs: [
    { id: "visible", label: "Visible", type: "value" },
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "geometries", label: "Geometries (List) — random pick per instance", type: "list" },
    { id: "count", label: "Count", type: "value" },
    { id: "spacing", label: "Spacing", type: "value" },
    { id: "spacingVariance", label: "Spacing Variance (%)", type: "value" },
    { id: "radius", label: "Radius", type: "value" },
    { id: "countX", label: "Count X", type: "value" },
    { id: "countY", label: "Count Y", type: "value" },
    { id: "countZ", label: "Count Z", type: "value" },
    { id: "spacingX", label: "Spacing X", type: "value" },
    { id: "spacingY", label: "Spacing Y", type: "value" },
    { id: "spacingZ", label: "Spacing Z", type: "value" },
    { id: "curve", label: "Curve", type: "curve" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  outputs: [{ id: "geometry", label: "Geometry", type: "geometry" }],
  defaultParams: {
    visible: 1,
    count: 5,
    mode: "linear",
    curveOrient: false,
    axis: "X",
    spacing: 2.0,
    // 0 = every gap is exactly Spacing, same as before this param existed.
    spacingVariance: 0,
    radius: 3.0,
    plane: "XZ",
    totalAngle: 360,
    orient: true,
    gridRows: 3,
    gridCols: 3,
    countX: 3,
    countY: 3,
    countZ: 3,
    spacingX: 2.0,
    spacingY: 2.0,
    spacingZ: 2.0,
    centerGrid: true,
    seed: 0,
    gpuInstancing: false,
  },
  paramFields: [
    { id: "visible", label: "Visible", kind: "boolean" },
    { id: "seed", label: "Random Pick Seed", kind: "number", step: 1 },
    { id: "gpuInstancing", label: "GPU Instancing (1 draw call)", kind: "boolean" },
    { id: "mode", label: "Mode", kind: "select", options: ["linear", "circular", "grid", "grid3d", "curve"] },
    { id: "count", label: "Count", kind: "number", step: 1 },
    { id: "axis", label: "Linear Axis", kind: "select", options: ["X", "Y", "Z"] },
    { id: "spacing", label: "Linear Spacing", kind: "number", step: 0.1 },
    { id: "spacingVariance", label: "Spacing Variance (%)", kind: "number", step: 5 },
    { id: "radius", label: "Circular Radius", kind: "number", step: 0.1 },
    { id: "plane", label: "Plane", kind: "select", options: ["XZ", "XY", "YZ"] },
    { id: "totalAngle", label: "Total Angle (°)", kind: "number", step: 15 },
    { id: "orient", label: "Orient to Circle", kind: "boolean" },
    { id: "gridCols", label: "Cols (X)", kind: "number", step: 1 },
    { id: "gridRows", label: "Rows (Y/Z)", kind: "number", step: 1 },
    { id: "countX", label: "Count X", kind: "number", step: 1 },
    { id: "countY", label: "Count Y", kind: "number", step: 1 },
    { id: "countZ", label: "Count Z", kind: "number", step: 1 },
    { id: "spacingX", label: "Spacing X", kind: "number", step: 0.1 },
    { id: "spacingY", label: "Spacing Y/Z", kind: "number", step: 0.1 },
    { id: "spacingZ", label: "Spacing Z", kind: "number", step: 0.1 },
    { id: "centerGrid", label: "Center Grid", kind: "boolean" },
  ],
  dynamicParamFields: (instance) => {
    const mode = String(instance?.params?.mode || "linear");
    const fields: ParamFieldDef[] = [
      { id: "mode", label: "Mode", kind: "select", options: ["linear", "circular", "grid", "grid3d", "curve"], group: "Pattern & Grid" },
      { id: "seed", label: "Random Pick Seed", kind: "number", step: 1, group: "Variety" },
      {
        id: "gpuInstancing",
        label: "GPU Instancing (1 draw call — disables Get/Set Instance)",
        kind: "boolean",
        group: "Pattern & Grid",
      },
    ];

    if (mode === "linear") {
      fields.push(
        { id: "count", label: "Count", kind: "number", step: 1, group: "Pattern & Grid" },
        { id: "axis", label: "Linear Axis", kind: "select", options: ["X", "Y", "Z"], group: "Pattern & Grid" },
        { id: "spacing", label: "Linear Spacing", kind: "number", step: 0.1, group: "Pattern & Grid" },
        { id: "spacingVariance", label: "Spacing Variance (%)", kind: "number", step: 5, group: "Pattern & Grid" },
      );
    } else if (mode === "circular") {
      fields.push(
        { id: "count", label: "Count", kind: "number", step: 1, group: "Pattern & Grid" },
        { id: "radius", label: "Circular Radius", kind: "number", step: 0.1, group: "Pattern & Grid" },
        { id: "plane", label: "Circular Plane", kind: "select", options: ["XZ", "XY", "YZ"], group: "Pattern & Grid" },
        { id: "totalAngle", label: "Total Angle (°)", kind: "number", step: 15, group: "Pattern & Grid" },
        { id: "orient", label: "Orient to Circle", kind: "boolean", group: "Pattern & Grid" },
        { id: "spacingVariance", label: "Spacing Variance (%)", kind: "number", step: 5, group: "Pattern & Grid" },
      );
    } else if (mode === "grid") {
      fields.push(
        { id: "gridCols", label: "Cols (X)", kind: "number", step: 1, group: "Pattern & Grid" },
        { id: "gridRows", label: "Rows (Y/Z)", kind: "number", step: 1, group: "Pattern & Grid" },
        { id: "spacingX", label: "Spacing X", kind: "number", step: 0.1, group: "Pattern & Grid" },
        { id: "spacingY", label: "Spacing Y/Z", kind: "number", step: 0.1, group: "Pattern & Grid" },
        { id: "spacingVariance", label: "Spacing Variance (%)", kind: "number", step: 5, group: "Pattern & Grid" },
        { id: "plane", label: "Grid Plane", kind: "select", options: ["XZ", "XY", "YZ"], group: "Pattern & Grid" },
        { id: "centerGrid", label: "Center Grid", kind: "boolean", group: "Pattern & Grid" },
      );
    } else if (mode === "grid3d") {
      fields.push(
        { id: "countX", label: "Count X", kind: "number", step: 1, group: "Pattern & Grid" },
        { id: "countY", label: "Count Y", kind: "number", step: 1, group: "Pattern & Grid" },
        { id: "countZ", label: "Count Z", kind: "number", step: 1, group: "Pattern & Grid" },
        { id: "spacingX", label: "Spacing X", kind: "number", step: 0.1, group: "Pattern & Grid" },
        { id: "spacingY", label: "Spacing Y", kind: "number", step: 0.1, group: "Pattern & Grid" },
        { id: "spacingZ", label: "Spacing Z", kind: "number", step: 0.1, group: "Pattern & Grid" },
        { id: "spacingVariance", label: "Spacing Variance (%)", kind: "number", step: 5, group: "Pattern & Grid" },
        { id: "centerGrid", label: "Center Grid", kind: "boolean", group: "Pattern & Grid" },
      );
    } else if (mode === "curve") {
      fields.push(
        { id: "count", label: "Count", kind: "number", step: 1, group: "Pattern & Grid" },
        { id: "curveOrient", label: "Orient to Curve", kind: "boolean", group: "Pattern & Grid" },
        { id: "spacingVariance", label: "Spacing Variance (%)", kind: "number", step: 5, group: "Pattern & Grid" },
      );
    }
    return fields;
  },
  evaluate: (inputs, params, ctx) => {
    const group = getGroup(ctx.nodeId);
    group.clear();

    const source = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    const pool = Array.isArray(inputs.geometries)
      ? (inputs.geometries.filter((g) => g instanceof THREE.Object3D) as THREE.Object3D[])
      : null;
    if (!source && (!pool || pool.length === 0)) return { geometry: group };

    // Deterministic per-index pick — same hash construct as the spacing
    // jitter above, so re-evaluating the same graph always reproduces the
    // same variety instead of reshuffling every frame.
    const pickSeed = Number(params.seed) || 0;
    const pickSource = (i: number): THREE.Object3D | null => {
      if (pool && pool.length > 0) {
        const h = fract(Math.sin((i + pickSeed * 1000) * 12.9898) * 43758.5453);
        return pool[Math.floor(h * pool.length) % pool.length];
      }
      return source;
    };

    const mode = String(params.mode || "linear");
    const stepMatrix = inputs.matrix instanceof THREE.Matrix4
      ? inputs.matrix
      : (Array.isArray(inputs.matrix) && inputs.matrix[0] instanceof THREE.Matrix4
        ? (inputs.matrix[0] as THREE.Matrix4)
        : null);
    const gpuInstancing = Boolean(params.gpuInstancing);
    const instancedItems: InstancedItemSpec[] = [];

    const rawSpacingVariance = inputs.spacingVariance !== undefined ? Number(inputs.spacingVariance) : Number(params.spacingVariance);
    const spacingVariance = Math.max(0, Math.min(100, isNaN(rawSpacingVariance) ? 0 : rawSpacingVariance)) / 100;

    // Unlike linear/circular/curve (capped at 500 via `count`), grid and
    // grid3d let each dimension grow independently — nothing stopped e.g.
    // 100x100x100 from producing 1,000,000 raw Group+clone Object3Ds (or an
    // InstancedMesh with a 1M-entry matrix), which stalls the tab hard enough
    // that the scene reads as empty. Clamp the *product*, not each axis, so a
    // wide-but-shallow grid isn't punished the same as a cube; scale every
    // axis down by the same factor so the requested aspect ratio is kept.
    const clampGridTotal = (counts: number[], cap: number): number[] => {
      const total = counts.reduce((a, b) => a * b, 1);
      if (total <= cap) return counts;
      const factor = Math.pow(cap / total, 1 / counts.length);
      return counts.map((c) => Math.max(1, Math.floor(c * factor)));
    };
    const gridInstanceCap = gpuInstancing ? 200_000 : 5_000;

    if (mode === "grid") {
      const [rows, cols] = clampGridTotal(
        [Math.max(1, Math.floor(Number(params.gridRows) || 3)), Math.max(1, Math.floor(Number(params.gridCols) || 3))],
        gridInstanceCap,
      );
      const spX = inputs.spacingX !== undefined ? Number(inputs.spacingX) : (Number(params.spacingX) || 2.0);
      const spY = inputs.spacingY !== undefined ? Number(inputs.spacingY) : (Number(params.spacingY) || 2.0);
      const plane = String(params.plane || "XZ");
      const center = Boolean(params.centerGrid ?? true);
      const colOffsets = centeredOffsetsWithVariance(cols, spX, spacingVariance, center);
      const rowOffsets = centeredOffsetsWithVariance(rows, spY, spacingVariance, center);

      let stepPower = new THREE.Matrix4();
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const itemSource = pickSource(r * cols + c);
          if (!itemSource) continue;
          const instanceMatrix = new THREE.Matrix4();
          const pos = new THREE.Vector3();

          const offsetX = colOffsets[c];
          const offsetY = rowOffsets[r];

          if (plane === "XY") {
            pos.set(offsetX, offsetY, 0);
          } else if (plane === "YZ") {
            pos.set(0, offsetX, offsetY);
          } else {
            // XZ plane (ground)
            pos.set(offsetX, 0, offsetY);
          }

          instanceMatrix.compose(pos, new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
          if (stepMatrix) {
            instanceMatrix.premultiply(stepPower);
            stepPower = new THREE.Matrix4().multiplyMatrices(stepMatrix, stepPower);
          }

          attachInstance(itemSource, instanceMatrix, gpuInstancing, instancedItems, group);
        }
      }
      if (gpuInstancing) renderInstanced(ctx.nodeId, group, instancedItems);
      return { geometry: group };
    }

    if (mode === "grid3d") {
      const [cX, cY, cZ] = clampGridTotal(
        [
          Math.max(1, Math.floor(inputs.countX !== undefined ? Number(inputs.countX) : (Number(params.countX) || 3))),
          Math.max(1, Math.floor(inputs.countY !== undefined ? Number(inputs.countY) : (Number(params.countY) || 3))),
          Math.max(1, Math.floor(inputs.countZ !== undefined ? Number(inputs.countZ) : (Number(params.countZ) || 3))),
        ],
        gridInstanceCap,
      );
      const spX = inputs.spacingX !== undefined ? Number(inputs.spacingX) : (Number(params.spacingX) || 2.0);
      const spY = inputs.spacingY !== undefined ? Number(inputs.spacingY) : (Number(params.spacingY) || 2.0);
      const spZ = inputs.spacingZ !== undefined ? Number(inputs.spacingZ) : (Number(params.spacingZ) || 2.0);
      const center = Boolean(params.centerGrid ?? true);
      const xOffsets = centeredOffsetsWithVariance(cX, spX, spacingVariance, center);
      const yOffsets = centeredOffsetsWithVariance(cY, spY, spacingVariance, center);
      const zOffsets = centeredOffsetsWithVariance(cZ, spZ, spacingVariance, center);

      let stepPower = new THREE.Matrix4();
      for (let ix = 0; ix < cX; ix++) {
        for (let iy = 0; iy < cY; iy++) {
          for (let iz = 0; iz < cZ; iz++) {
            const itemSource = pickSource((ix * cY + iy) * cZ + iz);
            if (!itemSource) continue;
            const instanceMatrix = new THREE.Matrix4();
            const pos = new THREE.Vector3(xOffsets[ix], yOffsets[iy], zOffsets[iz]);

            instanceMatrix.compose(pos, new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
            if (stepMatrix) {
              instanceMatrix.premultiply(stepPower);
              stepPower = new THREE.Matrix4().multiplyMatrices(stepMatrix, stepPower);
            }

            attachInstance(itemSource, instanceMatrix, gpuInstancing, instancedItems, group);
          }
        }
      }
      if (gpuInstancing) renderInstanced(ctx.nodeId, group, instancedItems);
      return { geometry: group };
    }

    const rawCount = inputs.count !== undefined ? Number(inputs.count) : Number(params.count);
    const count = Math.max(1, Math.min(500, Math.floor(isNaN(rawCount) ? 5 : rawCount)));

    const curveInput = inputs.curve instanceof THREE.Curve ? (inputs.curve as THREE.Curve<THREE.Vector3>) : null;
    // Arc-length parameterized (getPointAt/getTangentAt), not getPoint(i/count)
    // — evenly spaced by distance along the curve, not by the curve's own
    // (possibly uneven) internal t parameterization. A closed curve's t=0 and
    // t=1 are the same point, so it's divided into `count` steps around the
    // loop with no duplicate at the seam; an open curve is divided into
    // `count - 1` so the first and last instances land exactly on its ends.
    const curveClosed = curveInput ? Boolean((curveInput as unknown as { closed?: boolean }).closed) : false;
    const curveDivisions = curveClosed ? count : Math.max(1, count - 1);

    const rawLinearSpacing = inputs.spacing !== undefined ? Number(inputs.spacing) : Number(params.spacing);
    const linearSpacing = isNaN(rawLinearSpacing) ? 2.0 : rawLinearSpacing;
    const linearOffsets = mode === "linear" ? cumulativeOffsetsWithVariance(count, linearSpacing, spacingVariance) : null;

    // Circular: jitter the angular step the same way, so consecutive
    // instances sit unevenly around the ring instead of at a perfectly
    // uniform angle.
    let circularAngleOffsets: number[] | null = null;
    if (mode === "circular") {
      const totalAngleDeg = Number(params.totalAngle) || 360;
      const totalAngleRad = (totalAngleDeg * Math.PI) / 180;
      const stepAngleRad = count > 1 && totalAngleDeg < 360 ? totalAngleRad / (count - 1) : totalAngleRad / count;
      circularAngleOffsets = cumulativeOffsetsWithVariance(count, stepAngleRad, spacingVariance);
    }

    // Curve: jitter the arc-length "cell" step the same way, then normalize
    // by the row's own actual span — the endpoints stay exactly where they
    // were (open) and the loop still closes without a seam duplicate
    // (closed), same as the unjittered curveDivisions math above. Degrades
    // to the exact old i/curveDivisions steps at 0 variance.
    let curveUOffsets: number[] | null = null;
    if (mode === "curve" && curveInput) {
      const raw = cumulativeOffsetsWithVariance(curveDivisions + 1, 1, spacingVariance);
      const total = raw[curveDivisions] || 1;
      curveUOffsets = raw.map((v) => v / total);
    }

    let stepPower = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      const itemSource = pickSource(i);
      if (!itemSource) continue;

      const instanceMatrix = new THREE.Matrix4();
      const pos = new THREE.Vector3();
      const rot = new THREE.Euler();
      const scale = new THREE.Vector3(1, 1, 1);
      // Only "curve" mode sets this (tangent alignment isn't expressible as
      // the Euler `rot` every other mode builds) — reset every iteration so
      // a degenerate tangent on one instance can't leak the previous
      // instance's rotation onto it.
      let quatOverride: THREE.Quaternion | null = null;

      if (mode === "curve" && curveInput) {
        const u = curveUOffsets ? curveUOffsets[i] : 0;
        pos.copy(curveInput.getPointAt(Math.min(1, u)));
        if (Boolean(params.curveOrient)) {
          const tangent = curveInput.getTangentAt(Math.min(1, u));
          if (tangent.lengthSq() > 1e-12) {
            quatOverride = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent.normalize());
          }
        }
      } else if (mode === "linear") {
        const axis = String(params.axis || "X");
        const offset = linearOffsets![i];

        if (axis === "Y") {
          pos.set(0, offset, 0);
        } else if (axis === "Z") {
          pos.set(0, 0, offset);
        } else {
          // X Axis default
          pos.set(offset, 0, 0);
        }
      } else if (mode === "circular") {
        const rawRadius = inputs.radius !== undefined ? Number(inputs.radius) : Number(params.radius);
        const radius = isNaN(rawRadius) ? 3.0 : rawRadius;
        const plane = String(params.plane || "XZ");
        const orient = Boolean(params.orient ?? true);

        const angle = circularAngleOffsets![i];

        if (plane === "XY") {
          pos.set(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
          if (orient) rot.z = angle;
        } else if (plane === "YZ") {
          pos.set(0, Math.cos(angle) * radius, Math.sin(angle) * radius);
          if (orient) rot.x = angle;
        } else {
          // XZ plane default (ground plane)
          pos.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
          if (orient) rot.y = -angle + Math.PI / 2;
        }
      }

      instanceMatrix.compose(pos, quatOverride ?? new THREE.Quaternion().setFromEuler(rot), scale);
      if (stepMatrix) {
        instanceMatrix.premultiply(stepPower);
        stepPower = new THREE.Matrix4().multiplyMatrices(stepMatrix, stepPower);
      }

      attachInstance(itemSource, instanceMatrix, gpuInstancing, instancedItems, group);
    }

    if (gpuInstancing) renderInstanced(ctx.nodeId, group, instancedItems);
    return { geometry: group };
  },
};
