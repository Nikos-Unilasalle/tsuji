import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { NodeDefinition, ParamFieldDef } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { toBoolean } from "../sockets";
import { asColor, COMMON_DEFAULT_PARAMS, NATIVE_TRANSFORM_PARAM_FIELDS, numberInput } from "./object";
import { asVector3, composeNativeMatrix } from "./transform";
import { createLabelMesh, disposeLabelMesh, LabelMeshState, updateLabelText } from "./labelTexture";
import { formatTick, mathBasis, MathDimension, niceStep, spaceMatrix, ticks } from "../mathSpace";
import { faceCamera } from "../billboard";

const GRID_PLANES = ["none", "xy", "xz", "yz", "all"] as const;

interface AxesState {
  root: THREE.Group;
  axisLine: LineSegments2;
  axisMaterial: LineMaterial;
  gridLine: LineSegments2;
  gridMaterial: LineMaterial;
  arrows: THREE.Mesh;
  labels: LabelMeshState[];
  signature?: string;
}

const axesCache = createNodeCache<AxesState>((s) => {
  disposeObject3D(s.root);
  for (const l of s.labels) disposeLabelMesh(l);
});

function axesState(nodeId: string): AxesState {
  let state = axesCache.get(nodeId);
  if (state) return state;
  const root = new THREE.Group();
  root.matrixAutoUpdate = false;
  root.userData.nodeId = nodeId;
  const axisMaterial = new LineMaterial({ color: 0x222222, linewidth: 2 });
  const gridMaterial = new LineMaterial({ color: 0xd5dbe1, linewidth: 1 });
  const axisLine = new LineSegments2(new LineSegmentsGeometry(), axisMaterial);
  const gridLine = new LineSegments2(new LineSegmentsGeometry(), gridMaterial);
  // The grid draws first and never hides the axes or anything plotted on it.
  gridLine.renderOrder = -1;
  gridMaterial.depthWrite = false;
  const arrows = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0x222222 }));
  for (const o of [axisLine, gridLine, arrows]) {
    o.userData.nodeId = nodeId;
    o.frustumCulled = false;
    root.add(o);
  }
  state = { root, axisLine, axisMaterial, gridLine, gridMaterial, arrows, labels: [] };
  axesCache.set(nodeId, state);
  return state;
}

interface AxisSpec {
  min: number;
  max: number;
  step: number;
}

function axisSpec(params: Record<string, unknown>, axis: "x" | "y" | "z"): AxisSpec {
  const min = numberInput(undefined, params[`${axis}Min`], -5);
  const max = numberInput(undefined, params[`${axis}Max`], 5);
  const lo = Math.min(min, max), hi = Math.max(min, max);
  const step = numberInput(undefined, params[`${axis}Step`], 0);
  return { min: lo, max: hi, step: step > 0 ? step : niceStep(hi - lo) };
}

const EXTRA_FIELDS: ParamFieldDef[] = [
  { id: "dimension", label: "Dimension", kind: "select", options: ["2D", "3D"], optionLabels: ["2D (x right, y up)", "3D (z up)"], group: "Axes" },
  { id: "xMin", label: "x min", kind: "number", step: 0.5, group: "Axes" },
  { id: "xMax", label: "x max", kind: "number", step: 0.5, group: "Axes" },
  { id: "xStep", label: "x step (0 = auto)", kind: "number", step: 0.5, group: "Axes" },
  { id: "yMin", label: "y min", kind: "number", step: 0.5, group: "Axes" },
  { id: "yMax", label: "y max", kind: "number", step: 0.5, group: "Axes" },
  { id: "yStep", label: "y step (0 = auto)", kind: "number", step: 0.5, group: "Axes" },
  { id: "zMin", label: "z min (3D)", kind: "number", step: 0.5, group: "Axes" },
  { id: "zMax", label: "z max (3D)", kind: "number", step: 0.5, group: "Axes" },
  { id: "zStep", label: "z step (0 = auto)", kind: "number", step: 0.5, group: "Axes" },
  { id: "unit", label: "Unit Length (world, per axis)", kind: "vector", group: "Axes" },
  { id: "grid", label: "Grid", kind: "select", options: [...GRID_PLANES], optionLabels: ["None", "xy", "xz", "yz", "All three"], group: "Grid" },
  { id: "labels", label: "Numbers", kind: "boolean", group: "Labels" },
  { id: "piTicks", label: "x in multiples of π", kind: "boolean", group: "Labels" },
  { id: "names", label: "Axis Names (comma list)", kind: "text", group: "Labels" },
  { id: "labelSize", label: "Text Size", kind: "number", step: 0.05, group: "Labels" },
  { id: "arrows", label: "Arrow Tips", kind: "boolean", group: "Style" },
  { id: "axisColor", label: "Axis Color", kind: "color", group: "Style" },
  { id: "gridColor", label: "Grid Color", kind: "color", group: "Style" },
  { id: "axisWidth", label: "Axis Width (px)", kind: "number", step: 0.5, group: "Style" },
  { id: "gridWidth", label: "Grid Width (px)", kind: "number", step: 0.5, group: "Style" },
];

/**
 * Axes — a coordinate system to draw math in: a number line, 2D axes with a
 * grid, or 3D axes with z up. Ranges, steps (round ones picked for you when
 * left at 0), units, grid planes, numbers that always face the camera, axis
 * names and arrow tips.
 *
 * Its Space output is the matrix from math coordinates to the world — wire it
 * into Function Curve, Function Surface or anything else that takes a Space,
 * and what they draw sits on these axes, at their scale, wherever the axes
 * are moved. Nothing to convert by hand; z is up in 3D, as on paper.
 */
export const AXES_NODE: NodeDefinition = {
  type: "math/axes",
  label: "Axes",
  category: "math",
  inputs: [
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "visible", label: "Visible", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "space", label: "Space (math → world)", type: "matrix" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    visible: COMMON_DEFAULT_PARAMS.visible,
    location: COMMON_DEFAULT_PARAMS.location,
    rotation: COMMON_DEFAULT_PARAMS.rotation,
    scale: COMMON_DEFAULT_PARAMS.scale,
    showPivot: COMMON_DEFAULT_PARAMS.showPivot,
    pivot: COMMON_DEFAULT_PARAMS.pivot,
    inheritRotation: COMMON_DEFAULT_PARAMS.inheritRotation,
    inheritScale: COMMON_DEFAULT_PARAMS.inheritScale,
    dimension: "2D",
    xMin: -5, xMax: 5, xStep: 0,
    yMin: -3, yMax: 3, yStep: 0,
    zMin: -3, zMax: 3, zStep: 0,
    unit: new THREE.Vector3(1, 1, 1),
    grid: "xy",
    labels: true,
    piTicks: false,
    names: "x, y, z",
    labelSize: 0.28,
    arrows: true,
    axisColor: new THREE.Color(0x222222),
    gridColor: new THREE.Color(0xd5dbe1),
    axisWidth: 2,
    gridWidth: 1,
  },
  paramFields: [...NATIVE_TRANSFORM_PARAM_FIELDS, ...EXTRA_FIELDS],
  evaluate: (inputs, params, ctx) => {
    const state = axesState(ctx.nodeId);
    const dimension: MathDimension = params.dimension === "3D" ? "3D" : "2D";
    const unit = asVector3(params.unit, new THREE.Vector3(1, 1, 1));
    const pose = composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params);
    if (ctx.nodeId !== ctx.liveEditNodeId) state.root.matrix.copy(pose);
    const space = spaceMatrix(pose, dimension, unit);

    const axisColor = asColor(params.axisColor, new THREE.Color(0x222222));
    state.axisMaterial.color.copy(axisColor);
    (state.arrows.material as THREE.MeshBasicMaterial).color.copy(axisColor);
    state.gridMaterial.color.copy(asColor(params.gridColor, new THREE.Color(0xd5dbe1)));
    state.axisMaterial.linewidth = Math.max(0.1, numberInput(undefined, params.axisWidth, 2));
    state.gridMaterial.linewidth = Math.max(0.1, numberInput(undefined, params.gridWidth, 1));
    const size = new THREE.Vector2(1920, 1080);
    if (ctx.renderer) {
      ctx.renderer.getSize(size);
      if (size.x <= 0 || size.y <= 0) size.set(1920, 1080);
    }
    state.axisMaterial.resolution.copy(size);
    state.gridMaterial.resolution.copy(size);

    const specs = { x: axisSpec(params, "x"), y: axisSpec(params, "y"), z: axisSpec(params, "z") };
    const signature = JSON.stringify([dimension, unit.toArray(), specs, params.grid, params.labels, params.piTicks, params.names, params.labelSize, params.arrows, axisColor.getHex()]);
    if (state.signature !== signature) {
      state.signature = signature;
      build(state, dimension, unit, specs, params, ctx.nodeId);
    }
    state.root.visible = toBoolean(inputs.visible ?? params.visible ?? true);
    return { geometry: state.root, space, matrix: pose.clone() };
  },
};

function build(
  state: AxesState,
  dimension: MathDimension,
  unit: THREE.Vector3,
  specs: Record<"x" | "y" | "z", AxisSpec>,
  params: Record<string, unknown>,
  nodeId: string,
): void {
  // Everything below is built in math coordinates and mapped through this
  // (basis × units) into the group, whose own matrix is the placement.
  const toAxes = mathBasis(dimension).multiply(new THREE.Matrix4().makeScale(unit.x || 1, unit.y || 1, unit.z || 1));
  const p = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(toAxes);
  const axes: ("x" | "y" | "z")[] = dimension === "3D" ? ["x", "y", "z"] : ["x", "y"];
  const along = (axis: "x" | "y" | "z", v: number) => p(axis === "x" ? v : 0, axis === "y" ? v : 0, axis === "z" ? v : 0);
  const avgUnit = (Math.abs(unit.x) + Math.abs(unit.y) + (dimension === "3D" ? Math.abs(unit.z) : 0)) / (dimension === "3D" ? 3 : 2) || 1;
  const labelSize = Math.max(0.01, numberInput(undefined, params.labelSize, 0.28)) * avgUnit;
  const tick = labelSize * 0.35;

  const axisSegs: number[] = [];
  const gridSegs: number[] = [];
  const push = (list: number[], a: THREE.Vector3, b: THREE.Vector3) => list.push(a.x, a.y, a.z, b.x, b.y, b.z);

  for (const axis of axes) {
    const s = specs[axis];
    push(axisSegs, along(axis, s.min), along(axis, s.max));
    // Tick marks across the axis, in the axis's own plane.
    const across = axis === "y" && dimension === "2D" ? "x" : axis === "x" ? "y" : axis === "y" ? "x" : "x";
    for (const v of ticks(s.min, s.max, s.step)) {
      if (Math.abs(v) < 1e-12) continue;
      const c = along(axis, v);
      const d = along(across, 1).normalize().multiplyScalar(tick);
      push(axisSegs, c.clone().sub(d), c.clone().add(d));
    }
  }

  const grid = dimension === "2D" ? (params.grid === "none" ? "none" : "xy") : String(params.grid ?? "xy");
  const planes: ["x" | "y" | "z", "x" | "y" | "z"][] = grid === "all" ? [["x", "y"], ["x", "z"], ["y", "z"]] : grid === "none" ? [] : [[grid[0] as "x", grid[1] as "y"]];
  for (const [u, v] of planes) {
    const su = specs[u], sv = specs[v];
    const at = (a: number, b: number) => p(u === "x" ? a : v === "x" ? b : 0, u === "y" ? a : v === "y" ? b : 0, u === "z" ? a : v === "z" ? b : 0);
    for (const a of ticks(su.min, su.max, su.step)) push(gridSegs, at(a, sv.min), at(a, sv.max));
    for (const b of ticks(sv.min, sv.max, sv.step)) push(gridSegs, at(su.min, b), at(su.max, b));
  }

  state.axisLine.geometry.dispose();
  state.axisLine.geometry = new LineSegmentsGeometry().setPositions(axisSegs);
  state.gridLine.geometry.dispose();
  state.gridLine.geometry = new LineSegmentsGeometry().setPositions(gridSegs.length ? gridSegs : [0, 0, 0, 0, 0, 0]);
  state.gridLine.visible = gridSegs.length > 0;

  // Arrow tips: a cone at the positive end of each axis, pointing along it.
  const cones: THREE.BufferGeometry[] = [];
  if (toBoolean(params.arrows ?? true)) {
    for (const axis of axes) {
      const end = along(axis, specs[axis].max);
      const dir = along(axis, 1).normalize();
      const cone = new THREE.ConeGeometry(tick * 0.9, tick * 3, 16);
      cone.translate(0, tick * 1.5, 0);
      cone.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
      cone.translate(end.x, end.y, end.z);
      cones.push(cone);
    }
  }
  state.arrows.geometry.dispose();
  state.arrows.geometry = cones.length ? mergeAll(cones) : new THREE.BufferGeometry();

  // Numbers and names, all facing the camera.
  const texts: { text: string; at: THREE.Vector3; size: number }[] = [];
  if (toBoolean(params.labels ?? true)) {
    for (const axis of axes) {
      const s = specs[axis];
      const pi = axis === "x" && toBoolean(params.piTicks);
      const step = pi && !(numberInput(undefined, params.xStep, 0) > 0) ? Math.PI / 2 : s.step;
      // Numbers sit beside the axis: below x, left of y, left of z.
      const offset = axis === "x" ? (dimension === "3D" ? p(0, -1, 0) : p(0, -1, 0)) : p(-1, 0, 0);
      offset.normalize().multiplyScalar(labelSize * 1.1);
      for (const v of ticks(s.min, s.max, step)) {
        if (Math.abs(v) < 1e-12) continue;
        texts.push({ text: formatTick(v, pi), at: along(axis, v).add(offset), size: labelSize });
      }
    }
    texts.push({ text: "0", at: p(0, 0, 0).add(p(-1, -1, 0).normalize().multiplyScalar(labelSize)), size: labelSize });
  }
  const names = String(params.names ?? "x, y, z").split(",").map((n) => n.trim());
  axes.forEach((axis, k) => {
    if (!names[k]) return;
    const dir = along(axis, 1).normalize();
    texts.push({ text: names[k], at: along(axis, specs[axis].max).addScaledVector(dir, tick * 5), size: labelSize * 1.2 });
  });

  while (state.labels.length < texts.length) {
    const label = createLabelMesh(nodeId);
    faceCamera(label.mesh);
    state.root.add(label.mesh);
    state.labels.push(label);
  }
  state.labels.forEach((label, i) => {
    const t = texts[i];
    label.mesh.visible = !!t;
    if (!t) return;
    updateLabelText(label, t.text, t.size);
    label.mesh.position.copy(t.at);
    (label.mesh.material as THREE.MeshBasicMaterial).color.copy(asColor(params.axisColor, new THREE.Color(0x222222)));
  });
}

function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  for (const g of parts) {
    const geo = g.index ? g.toNonIndexed() : g;
    positions.push(...(geo.getAttribute("position").array as Float32Array));
    normals.push(...(geo.getAttribute("normal").array as Float32Array));
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  return out;
}
