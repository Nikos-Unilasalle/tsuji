import * as THREE from "three";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { toBoolean } from "../sockets";
import { NodeDefinition, ParamFieldDef } from "../types";
import { getXyz, parseXyzText, setXyz } from "../xyzStore";
import { createLabelMesh, disposeLabelMesh, LabelMeshState, updateLabelText } from "./labelTexture";
import {
  applyMaterialParams,
  asColor,
  buildPrimitiveDynamicParamFields,
  COMMON_DEFAULT_PARAMS,
  COMMON_PRIMITIVE_INPUTS,
  COMMON_PRIMITIVE_OUTPUTS,
  extractMaterialParams,
  extractTextureParams,
  numberInput,
  primitiveOutputs,
} from "./object";
import { composeNativeMatrix } from "./transform";

/**
 * Dataviz primitives — Bar Graph's siblings (see object.ts). Same shape as
 * every other object/* primitive: a cached THREE object per node id,
 * COMMON_PRIMITIVE_INPUTS/OUTPUTS for material+texture+transform, values fed
 * in as plain number Lists (from CSV Reader's `column` output, List Math,
 * etc.) rather than a dedicated "chart data" type — one List socket type
 * for anything array-shaped, same as the rest of the engine.
 */

function toNumberList(v: unknown): number[] {
  if (!Array.isArray(v)) return typeof v === "number" ? [v] : [];
  return v.map((x) => Number(x) || 0);
}

function toColorList(v: unknown): THREE.Color[] {
  if (!Array.isArray(v)) return [];
  return v.map((c) => asColor(c, new THREE.Color(0xffffff)));
}

/* ----------------------------------------------------------------------- */
/* Line Graph                                                              */
/* ----------------------------------------------------------------------- */

interface LineGraphState {
  group: THREE.Group;
  tubeMesh: THREE.Mesh;
  pointsGroup: THREE.Group;
  pointGeometry: THREE.SphereGeometry;
}

const lineGraphCache = createNodeCache<LineGraphState>((s) => disposeObject3D(s.group));

function lineGraphState(nodeId: string): LineGraphState {
  const existing = lineGraphCache.get(nodeId);
  if (existing) return existing;

  const group = new THREE.Group();
  group.userData.nodeId = nodeId;
  const tubeMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: 0xffffff }));
  tubeMesh.castShadow = true;
  tubeMesh.receiveShadow = true;
  tubeMesh.userData.nodeId = nodeId;
  const pointsGroup = new THREE.Group();
  const pointGeometry = new THREE.SphereGeometry(0.5, 12, 8);

  group.add(tubeMesh);
  group.add(pointsGroup);

  const state: LineGraphState = { group, tubeMesh, pointsGroup, pointGeometry };
  lineGraphCache.set(nodeId, state);
  return state;
}

export const LINE_GRAPH_NODE: NodeDefinition = {
  type: "object/line_graph",
  label: "Line Graph",
  category: "dataviz",
  inputs: [
    { id: "values", label: "Values (List)", type: "list" },
    { id: "colors", label: "Point Colors (List)", type: "list" },
    { id: "count", label: "Point Count", type: "value" },
    { id: "spacing", label: "Spacing", type: "value" },
    { id: "maxHeight", label: "Max Height", type: "value" },
    { id: "lineWidth", label: "Line Width", type: "value" },
    { id: "smooth", label: "Smooth", type: "value" },
    { id: "showPoints", label: "Show Points", type: "value" },
    { id: "pointSize", label: "Point Size", type: "value" },
    ...COMMON_PRIMITIVE_INPUTS,
  ],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: {
    count: 5,
    spacing: 0.6,
    maxHeight: 5,
    lineWidth: 0.05,
    smooth: 0,
    showPoints: 1,
    pointSize: 0.12,
    ...COMMON_DEFAULT_PARAMS,
  },
  paramFields: buildPrimitiveDynamicParamFields([
    { id: "count", label: "Point Count", kind: "number", step: 1 },
    { id: "spacing", label: "Spacing", kind: "number", step: 0.05 },
    { id: "maxHeight", label: "Max Height", kind: "number", step: 0.5 },
    { id: "lineWidth", label: "Line Width", kind: "number", step: 0.01 },
    { id: "smooth", label: "Smooth", kind: "boolean" },
    { id: "showPoints", label: "Show Points", kind: "boolean" },
    { id: "pointSize", label: "Point Size", kind: "number", step: 0.01 },
  ])(),
  dynamicParamFields: buildPrimitiveDynamicParamFields([
    { id: "count", label: "Point Count", kind: "number", step: 1 },
    { id: "spacing", label: "Spacing", kind: "number", step: 0.05 },
    { id: "maxHeight", label: "Max Height", kind: "number", step: 0.5 },
    { id: "lineWidth", label: "Line Width", kind: "number", step: 0.01 },
    { id: "smooth", label: "Smooth", kind: "boolean" },
    { id: "showPoints", label: "Show Points", kind: "boolean" },
    { id: "pointSize", label: "Point Size", kind: "number", step: 0.01 },
  ]),
  evaluate: (inputs, params, ctx) => {
    const state = lineGraphState(ctx.nodeId);

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      state.group.matrixAutoUpdate = false;
      state.group.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    const rawValues = toNumberList(inputs.values).length > 0 ? toNumberList(inputs.values) : [0.2, 0.6, 0.4, 0.9, 0.5];
    const rawColors = toColorList(inputs.colors);
    const matParams = extractMaterialParams(inputs, params);
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);

    const count = Math.max(2, numberInput(inputs.count, params.count, 5));
    const spacing = numberInput(inputs.spacing, params.spacing, 0.6);
    const maxHeight = Math.max(0.01, numberInput(inputs.maxHeight, params.maxHeight, 5));
    const lineWidth = Math.max(0.001, numberInput(inputs.lineWidth, params.lineWidth, 0.05));
    const smooth = toBoolean(inputs.smooth !== undefined ? inputs.smooth : params.smooth ?? 0);
    const showPoints = toBoolean(inputs.showPoints !== undefined ? inputs.showPoints : params.showPoints ?? 1);
    const pointSize = Math.max(0.001, numberInput(inputs.pointSize, params.pointSize, 0.12));

    const totalWidth = (count - 1) * spacing;
    const startX = -totalWidth / 2;
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < count; i++) {
      const rawVal = rawValues[i % rawValues.length] ?? 0;
      points.push(new THREE.Vector3(startX + i * spacing, rawVal * maxHeight, 0));
    }

    // Straight segments (a piecewise-linear path, still a real Curve so
    // TubeGeometry can walk it) vs one CatmullRomCurve3 through every point.
    // Same downstream mesh either way — only how the path between points is
    // interpolated changes.
    const curve: THREE.Curve<THREE.Vector3> = smooth
      ? new THREE.CatmullRomCurve3(points)
      : (() => {
          const path = new THREE.CurvePath<THREE.Vector3>();
          for (let i = 0; i < points.length - 1; i++) {
            path.add(new THREE.LineCurve3(points[i], points[i + 1]));
          }
          return path;
        })();

    if (state.tubeMesh.geometry) state.tubeMesh.geometry.dispose();
    state.tubeMesh.geometry = new THREE.TubeGeometry(curve, Math.max(8, count * 8), lineWidth / 2, 8, false);
    state.tubeMesh.material = matParams.shadeless
      ? new THREE.MeshBasicMaterial({ color: 0xffffff })
      : new THREE.MeshStandardMaterial({ color: 0xffffff });
    applyMaterialParams(state.tubeMesh, matParams, THREE.FrontSide, texParams);

    while (state.pointsGroup.children.length < count) {
      const mesh = new THREE.Mesh(
        state.pointGeometry,
        matParams.shadeless ? new THREE.MeshBasicMaterial({ color: 0xffffff }) : new THREE.MeshStandardMaterial({ color: 0xffffff }),
      );
      mesh.castShadow = true;
      mesh.userData.nodeId = ctx.nodeId;
      state.pointsGroup.add(mesh);
    }
    while (state.pointsGroup.children.length > count) {
      const child = state.pointsGroup.children[state.pointsGroup.children.length - 1];
      state.pointsGroup.remove(child);
      if (child instanceof THREE.Mesh && child.material) (child.material as THREE.Material).dispose();
    }

    state.pointsGroup.visible = showPoints;
    for (let i = 0; i < count; i++) {
      const marker = state.pointsGroup.children[i] as THREE.Mesh;
      marker.position.copy(points[i]);
      marker.scale.setScalar(pointSize);
      const markerColor = rawColors.length > 0 ? rawColors[i % rawColors.length] : matParams.color;
      applyMaterialParams(marker, { ...matParams, color: markerColor }, THREE.FrontSide, texParams);
    }

    return primitiveOutputs(state.group);
  },
};

/* ----------------------------------------------------------------------- */
/* Chart Axis                                                              */
/* ----------------------------------------------------------------------- */

interface ChartAxisState {
  group: THREE.Group;
  axisMesh: THREE.Mesh;
  ticksGroup: THREE.Group;
  gridGroup: THREE.Group;
  labelsGroup: THREE.Group;
  labels: Map<number, LabelMeshState>;
  tickGeometry: THREE.BoxGeometry;
  gridGeometry: THREE.BoxGeometry;
}

const chartAxisCache = createNodeCache<ChartAxisState>((s) => {
  disposeObject3D(s.group);
  s.labels.forEach(disposeLabelMesh);
});

function chartAxisState(nodeId: string): ChartAxisState {
  const existing = chartAxisCache.get(nodeId);
  if (existing) return existing;

  const group = new THREE.Group();
  group.userData.nodeId = nodeId;
  const axisMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x94a3b8 }));
  const ticksGroup = new THREE.Group();
  const gridGroup = new THREE.Group();
  const labelsGroup = new THREE.Group();
  group.add(axisMesh, ticksGroup, gridGroup, labelsGroup);

  const state: ChartAxisState = {
    group,
    axisMesh,
    ticksGroup,
    gridGroup,
    labelsGroup,
    labels: new Map(),
    tickGeometry: new THREE.BoxGeometry(1, 1, 1),
    gridGeometry: new THREE.BoxGeometry(1, 1, 1),
  };
  chartAxisCache.set(nodeId, state);
  return state;
}

function pooledBoxMesh(pool: THREE.Group, index: number, geometry: THREE.BufferGeometry, color: number, nodeId: string): THREE.Mesh {
  while (pool.children.length <= index) {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true }));
    mesh.userData.nodeId = nodeId;
    pool.add(mesh);
  }
  return pool.children[index] as THREE.Mesh;
}

export const CHART_AXIS_NODE: NodeDefinition = {
  type: "object/chart_axis",
  label: "Chart Axis",
  category: "dataviz",
  inputs: [
    { id: "min", label: "Min Value", type: "value" },
    { id: "max", label: "Max Value", type: "value" },
    { id: "step", label: "Step", type: "value" },
    { id: "maxHeight", label: "Max Height", type: "value" },
    { id: "width", label: "Grid Width", type: "value" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: {
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    min: 0,
    max: 1,
    step: 0.2,
    maxHeight: 5,
    width: 4,
    decimals: 1,
    showGrid: 1,
    color: new THREE.Color(0x94a3b8),
  },
  paramFields: [
    { id: "location", label: "Location", kind: "vector", group: "Transform" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true, group: "Transform" },
    { id: "min", label: "Min Value", kind: "number", step: 0.1 },
    { id: "max", label: "Max Value", kind: "number", step: 0.1 },
    { id: "step", label: "Step", kind: "number", step: 0.05 },
    { id: "maxHeight", label: "Max Height", kind: "number", step: 0.5 },
    { id: "width", label: "Grid Width", kind: "number", step: 0.1 },
    { id: "decimals", label: "Decimals", kind: "number", step: 1 },
    { id: "showGrid", label: "Show Grid Lines", kind: "boolean" },
    { id: "color", label: "Color", kind: "color" },
  ] as ParamFieldDef[],
  evaluate: (inputs, params, ctx) => {
    const state = chartAxisState(ctx.nodeId);

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      state.group.matrixAutoUpdate = false;
      state.group.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    const min = numberInput(inputs.min, params.min, 0);
    const max = Math.max(min + 1e-6, numberInput(inputs.max, params.max, 1));
    const step = Math.max(1e-6, numberInput(inputs.step, params.step, 0.2));
    const maxHeight = Math.max(0.01, numberInput(inputs.maxHeight, params.maxHeight, 5));
    const width = Math.max(0.01, numberInput(inputs.width, params.width, 4));
    const decimals = Math.max(0, Math.min(6, Math.floor(numberInput(undefined, params.decimals, 1))));
    const showGrid = toBoolean(params.showGrid ?? 1);
    const color = inputs.color instanceof THREE.Color ? inputs.color : asColor(params.color, new THREE.Color(0x94a3b8));
    const colorHex = color.getHex();

    (state.axisMesh.material as THREE.MeshBasicMaterial).color.set(color);
    state.axisMesh.scale.set(width * 0.01, maxHeight, width * 0.01);
    state.axisMesh.position.set(0, maxHeight / 2, 0);

    const tickValues: number[] = [];
    for (let v = min; v <= max + 1e-9; v += step) tickValues.push(v);

    for (let i = 0; i < tickValues.length; i++) {
      const value = tickValues[i];
      const y = ((value - min) / (max - min)) * maxHeight;

      const tick = pooledBoxMesh(state.ticksGroup, i, state.tickGeometry, colorHex, ctx.nodeId);
      tick.visible = true;
      (tick.material as THREE.MeshBasicMaterial).color.set(color);
      tick.scale.set(width * 0.03, width * 0.005, width * 0.03);
      tick.position.set(-width * 0.02, y, 0);

      if (showGrid) {
        const gridLine = pooledBoxMesh(state.gridGroup, i, state.gridGeometry, colorHex, ctx.nodeId);
        gridLine.visible = true;
        (gridLine.material as THREE.MeshBasicMaterial).color.set(color);
        (gridLine.material as THREE.MeshBasicMaterial).opacity = 0.25;
        gridLine.scale.set(width, width * 0.003, width * 0.003);
        gridLine.position.set(width / 2, y, 0);
      } else if (state.gridGroup.children[i]) {
        (state.gridGroup.children[i] as THREE.Mesh).visible = false;
      }

      let labelState = state.labels.get(i);
      if (!labelState) {
        labelState = createLabelMesh(ctx.nodeId);
        state.labelsGroup.add(labelState.mesh);
        state.labels.set(i, labelState);
      }
      labelState.mesh.visible = true;
      updateLabelText(labelState, value.toFixed(decimals), width * 0.08);
      labelState.mesh.position.set(-width * 0.12, y, 0);
    }

    // Hide leftover pooled ticks/grid-lines/labels from a previous, larger
    // tick count — same hide-don't-dispose pattern as Bar Graph's label pool.
    for (let i = tickValues.length; i < state.ticksGroup.children.length; i++) {
      state.ticksGroup.children[i].visible = false;
    }
    state.labels.forEach((label, idx) => {
      if (idx >= tickValues.length) label.mesh.visible = false;
    });

    return primitiveOutputs(state.group);
  },
};

/* ----------------------------------------------------------------------- */
/* Pie / Donut Chart                                                       */
/* ----------------------------------------------------------------------- */

interface PieChartState {
  group: THREE.Group;
  slices: THREE.Mesh[];
}

const pieChartCache = createNodeCache<PieChartState>((s) => disposeObject3D(s.group));

function pieChartState(nodeId: string): PieChartState {
  const existing = pieChartCache.get(nodeId);
  if (existing) return existing;
  const group = new THREE.Group();
  group.userData.nodeId = nodeId;
  const state: PieChartState = { group, slices: [] };
  pieChartCache.set(nodeId, state);
  return state;
}

function buildSliceGeometry(startAngle: number, endAngle: number, radius: number, innerRadius: number, depth: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  if (innerRadius > 0.001) {
    shape.absarc(0, 0, radius, startAngle, endAngle, false);
    shape.absarc(0, 0, innerRadius, endAngle, startAngle, true);
  } else {
    shape.moveTo(0, 0);
    shape.absarc(0, 0, radius, startAngle, endAngle, false);
    shape.lineTo(0, 0);
  }
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 32 });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

export const PIE_CHART_NODE: NodeDefinition = {
  type: "object/pie_chart",
  label: "Pie / Donut Chart",
  category: "dataviz",
  inputs: [
    { id: "values", label: "Values (List)", type: "list" },
    { id: "colors", label: "Slice Colors (List)", type: "list" },
    { id: "radius", label: "Radius", type: "value" },
    { id: "innerRadius", label: "Inner Radius (Donut)", type: "value" },
    { id: "depth", label: "Depth", type: "value" },
    { id: "gapDegrees", label: "Slice Gap (deg)", type: "value" },
    ...COMMON_PRIMITIVE_INPUTS,
  ],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: {
    radius: 2,
    innerRadius: 0,
    depth: 0.4,
    gapDegrees: 1,
    ...COMMON_DEFAULT_PARAMS,
  },
  paramFields: buildPrimitiveDynamicParamFields([
    { id: "radius", label: "Radius", kind: "number", step: 0.1 },
    { id: "innerRadius", label: "Inner Radius (Donut)", kind: "number", step: 0.1 },
    { id: "depth", label: "Depth", kind: "number", step: 0.05 },
    { id: "gapDegrees", label: "Slice Gap (deg)", kind: "number", step: 0.5 },
  ])(),
  dynamicParamFields: buildPrimitiveDynamicParamFields([
    { id: "radius", label: "Radius", kind: "number", step: 0.1 },
    { id: "innerRadius", label: "Inner Radius (Donut)", kind: "number", step: 0.1 },
    { id: "depth", label: "Depth", kind: "number", step: 0.05 },
    { id: "gapDegrees", label: "Slice Gap (deg)", kind: "number", step: 0.5 },
  ]),
  evaluate: (inputs, params, ctx) => {
    const state = pieChartState(ctx.nodeId);

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      state.group.matrixAutoUpdate = false;
      state.group.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    const rawValues = toNumberList(inputs.values);
    const values = (rawValues.length > 0 ? rawValues : [1, 1, 1, 1]).map((v) => Math.max(0, v));
    const total = values.reduce((a, b) => a + b, 0) || 1;
    const rawColors = toColorList(inputs.colors);

    const matParams = extractMaterialParams(inputs, params);
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);
    const radius = Math.max(0.01, numberInput(inputs.radius, params.radius, 2));
    const innerRadius = Math.max(0, Math.min(radius - 0.01, numberInput(inputs.innerRadius, params.innerRadius, 0)));
    const depth = Math.max(0.001, numberInput(inputs.depth, params.depth, 0.4));
    const gap = THREE.MathUtils.degToRad(Math.max(0, numberInput(inputs.gapDegrees, params.gapDegrees, 1)));

    while (state.slices.length < values.length) {
      const mesh = new THREE.Mesh(
        new THREE.BufferGeometry(),
        matParams.shadeless ? new THREE.MeshBasicMaterial({ color: 0xffffff }) : new THREE.MeshStandardMaterial({ color: 0xffffff }),
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.nodeId = ctx.nodeId;
      state.group.add(mesh);
      state.slices.push(mesh);
    }
    while (state.slices.length > values.length) {
      const mesh = state.slices.pop();
      if (!mesh) continue;
      state.group.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }

    let angle = -Math.PI / 2;
    for (let i = 0; i < values.length; i++) {
      const fraction = values[i] / total;
      const sweep = Math.max(0, fraction * Math.PI * 2 - (values.length > 1 ? gap : 0));
      const startAngle = angle + (values.length > 1 ? gap / 2 : 0);
      const endAngle = startAngle + sweep;

      const mesh = state.slices[i];
      mesh.geometry.dispose();
      mesh.geometry = buildSliceGeometry(startAngle, endAngle, radius, innerRadius, depth);

      const sliceColor = rawColors.length > 0 ? rawColors[i % rawColors.length] : new THREE.Color().setHSL((i / values.length) % 1, 0.6, 0.55);
      applyMaterialParams(mesh, { ...matParams, color: sliceColor }, THREE.DoubleSide, texParams);

      angle += fraction * Math.PI * 2;
    }

    return primitiveOutputs(state.group);
  },
};

/* ----------------------------------------------------------------------- */
/* Scatter Plot                                                            */
/* ----------------------------------------------------------------------- */

interface ScatterPlotState {
  group: THREE.Group;
  markerGeometry: THREE.SphereGeometry;
}

const scatterPlotCache = createNodeCache<ScatterPlotState>((s) => disposeObject3D(s.group));

function scatterPlotState(nodeId: string): ScatterPlotState {
  const existing = scatterPlotCache.get(nodeId);
  if (existing) return existing;
  const group = new THREE.Group();
  group.userData.nodeId = nodeId;
  const state: ScatterPlotState = { group, markerGeometry: new THREE.SphereGeometry(0.5, 12, 8) };
  scatterPlotCache.set(nodeId, state);
  return state;
}

export const SCATTER_PLOT_NODE: NodeDefinition = {
  type: "object/scatter_plot",
  label: "Scatter Plot",
  category: "dataviz",
  inputs: [
    { id: "xValues", label: "X Values (List)", type: "list" },
    { id: "yValues", label: "Y Values (List)", type: "list" },
    { id: "zValues", label: "Z Values (List)", type: "list" },
    { id: "colors", label: "Colors (List)", type: "list" },
    { id: "sizes", label: "Sizes (List)", type: "list" },
    { id: "markerSize", label: "Marker Size", type: "value" },
    { id: "scaleX", label: "Scale X", type: "value" },
    { id: "scaleY", label: "Scale Y", type: "value" },
    { id: "scaleZ", label: "Scale Z", type: "value" },
    ...COMMON_PRIMITIVE_INPUTS,
  ],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: {
    markerSize: 0.15,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    ...COMMON_DEFAULT_PARAMS,
  },
  paramFields: buildPrimitiveDynamicParamFields([
    { id: "markerSize", label: "Marker Size", kind: "number", step: 0.01 },
    { id: "scaleX", label: "Scale X", kind: "number", step: 0.1 },
    { id: "scaleY", label: "Scale Y", kind: "number", step: 0.1 },
    { id: "scaleZ", label: "Scale Z", kind: "number", step: 0.1 },
  ])(),
  dynamicParamFields: buildPrimitiveDynamicParamFields([
    { id: "markerSize", label: "Marker Size", kind: "number", step: 0.01 },
    { id: "scaleX", label: "Scale X", kind: "number", step: 0.1 },
    { id: "scaleY", label: "Scale Y", kind: "number", step: 0.1 },
    { id: "scaleZ", label: "Scale Z", kind: "number", step: 0.1 },
  ]),
  evaluate: (inputs, params, ctx) => {
    const state = scatterPlotState(ctx.nodeId);

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      state.group.matrixAutoUpdate = false;
      state.group.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    const xValues = toNumberList(inputs.xValues);
    const yValues = toNumberList(inputs.yValues);
    const zValues = toNumberList(inputs.zValues);
    const rawColors = toColorList(inputs.colors);
    const sizes = toNumberList(inputs.sizes);

    const count = Math.max(xValues.length, yValues.length, zValues.length);

    const matParams = extractMaterialParams(inputs, params);
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);
    const markerSize = Math.max(0.001, numberInput(inputs.markerSize, params.markerSize, 0.15));
    const scaleX = numberInput(inputs.scaleX, params.scaleX, 1);
    const scaleY = numberInput(inputs.scaleY, params.scaleY, 1);
    const scaleZ = numberInput(inputs.scaleZ, params.scaleZ, 1);

    while (state.group.children.length < count) {
      const mesh = new THREE.Mesh(
        state.markerGeometry,
        matParams.shadeless ? new THREE.MeshBasicMaterial({ color: 0xffffff }) : new THREE.MeshStandardMaterial({ color: 0xffffff }),
      );
      mesh.castShadow = true;
      mesh.userData.nodeId = ctx.nodeId;
      state.group.add(mesh);
    }
    while (state.group.children.length > count) {
      const child = state.group.children[state.group.children.length - 1];
      state.group.remove(child);
      if (child instanceof THREE.Mesh && child.material) (child.material as THREE.Material).dispose();
    }

    for (let i = 0; i < count; i++) {
      const marker = state.group.children[i] as THREE.Mesh;
      const x = (xValues[i % Math.max(1, xValues.length)] ?? 0) * scaleX;
      const y = (yValues[i % Math.max(1, yValues.length)] ?? 0) * scaleY;
      const z = (zValues[i % Math.max(1, zValues.length)] ?? 0) * scaleZ;
      marker.position.set(x, y, z);

      const size = markerSize * (sizes.length > 0 ? sizes[i % sizes.length] || 1 : 1);
      marker.scale.setScalar(size);

      const markerColor = rawColors.length > 0 ? rawColors[i % rawColors.length] : matParams.color;
      applyMaterialParams(marker, { ...matParams, color: markerColor }, THREE.FrontSide, texParams);
    }

    return primitiveOutputs(state.group);
  },
};

/* ----------------------------------------------------------------------- */
/* Point Cloud (metadata: per-point color)                                 */
/* ----------------------------------------------------------------------- */

interface PointCloudState {
  points: THREE.Points;
  material: THREE.PointsMaterial;
  /** Everything the last build was computed from — a static cloud skips the per-frame rebuild entirely. */
  last?: {
    file: unknown;
    x: unknown;
    y: unknown;
    z: unknown;
    colors: unknown;
    pointSize: number;
    scaleX: number;
    scaleY: number;
    scaleZ: number;
    emissive: number;
    fallback: number;
  };
  /** The resolved arrays last handed back as outputs, reused while `last` still matches. */
  built?: {
    xValues: number[];
    yValues: number[];
    zValues: number[];
    colors: THREE.Color[];
  };
}

const pointCloudCache = createNodeCache<PointCloudState>((s) => {
  s.points.geometry.dispose();
  s.material.dispose();
});

function pointCloudState(nodeId: string): PointCloudState {
  const existing = pointCloudCache.get(nodeId);
  if (existing) return existing;
  const material = new THREE.PointsMaterial({ size: 0.05, vertexColors: true, sizeAttenuation: true });
  const points = new THREE.Points(new THREE.BufferGeometry(), material);
  points.userData.nodeId = nodeId;
  const state: PointCloudState = { points, material };
  pointCloudCache.set(nodeId, state);
  return state;
}

/**
 * Bulk data — thousands of points, each colored by its own metadata (a
 * scan, a point-cloud import, a per-sample classification) — rendered as a
 * single GPU `THREE.Points` draw call instead of Scatter Plot's one-mesh-
 * per-point pool, which stops making sense much past a few hundred markers.
 * Trades individual pickability/variable-size markers for scale.
 */
export const POINT_CLOUD_NODE: NodeDefinition = {
  type: "object/point_cloud",
  label: "Point Cloud",
  category: "primitives",
  inputs: [
    { id: "xValues", label: "X Values (List)", type: "list" },
    { id: "yValues", label: "Y Values (List)", type: "list" },
    { id: "zValues", label: "Z Values (List)", type: "list" },
    { id: "colors", label: "Colors (List)", type: "list" },
    { id: "pointSize", label: "Point Size", type: "value" },
    { id: "scaleX", label: "Scale X", type: "value" },
    { id: "scaleY", label: "Scale Y", type: "value" },
    { id: "scaleZ", label: "Scale Z", type: "value" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  outputs: [
    ...COMMON_PRIMITIVE_OUTPUTS,
    { id: "xValues", label: "X Values (List)", type: "list" },
    { id: "yValues", label: "Y Values (List)", type: "list" },
    { id: "zValues", label: "Z Values (List)", type: "list" },
    { id: "colors", label: "Colors (List)", type: "list" },
  ],
  defaultParams: {
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    filePath: "",
    pointSize: 0.05,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    color: new THREE.Color(0x38bdf8),
    emissiveIntensity: 1.0,
  },
  // Loading a .xyz file is the same "the file IS the dataset" shape as CSV
  // Reader (see csv.ts) — no column to pick, so the file field's onLoaded
  // just parses straight into xyzStore. If nothing is wired into the
  // xValues/yValues/zValues inputs, evaluate() below falls back to whatever
  // was loaded; wiring anything into them (a CSV Reader's column, List
  // Math, ...) still overrides the file, same priority Bar Graph gives its
  // own inputs over params.
  dynamicParamFields: () => [
    { id: "location", label: "Location", kind: "vector", group: "Transform" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true, group: "Transform" },
    {
      id: "filePath",
      label: "XYZ File",
      kind: "file",
      accept: [".xyz", ".txt"],
      onLoaded: (nodeId, _path, content) => {
        setXyz(nodeId, parseXyzText(String(content)));
      },
    },
    { id: "pointSize", label: "Point Size", kind: "number", step: 0.005 },
    { id: "scaleX", label: "Scale X", kind: "number", step: 0.1 },
    { id: "scaleY", label: "Scale Y", kind: "number", step: 0.1 },
    { id: "scaleZ", label: "Scale Z", kind: "number", step: 0.1 },
    { id: "color", label: "Fallback Color", kind: "color" },
    { id: "emissiveIntensity", label: "Emissive Intensity", kind: "number", step: 0.1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = pointCloudState(ctx.nodeId);

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      state.points.matrixAutoUpdate = false;
      state.points.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    const inputX = toNumberList(inputs.xValues);
    const inputY = toNumberList(inputs.yValues);
    const inputZ = toNumberList(inputs.zValues);
    const fileData = getXyz(ctx.nodeId);
    const useFile = inputX.length === 0 && inputY.length === 0 && inputZ.length === 0 && !!fileData;

    const xValues = useFile ? fileData!.x : inputX;
    const yValues = useFile ? fileData!.y : inputY;
    const zValues = useFile ? fileData!.z : inputZ;

    const fallbackColor = asColor(params.color, new THREE.Color(0x38bdf8));
    const pointSize = Math.max(0.001, numberInput(inputs.pointSize, params.pointSize, 0.05));
    const scaleX = numberInput(inputs.scaleX, params.scaleX, 1);
    const scaleY = numberInput(inputs.scaleY, params.scaleY, 1);
    const scaleZ = numberInput(inputs.scaleZ, params.scaleZ, 1);
    const emissiveIntensity = Math.max(0, numberInput(undefined, params.emissiveIntensity, 1.0));

    state.material.size = pointSize;

    const fallbackHex = fallbackColor.getHex();
    const last = state.last;
    const unchanged =
      !!last &&
      last.file === fileData &&
      last.x === inputs.xValues &&
      last.y === inputs.yValues &&
      last.z === inputs.zValues &&
      last.colors === inputs.colors &&
      last.pointSize === pointSize &&
      last.scaleX === scaleX &&
      last.scaleY === scaleY &&
      last.scaleZ === scaleZ &&
      last.emissive === emissiveIntensity &&
      last.fallback === fallbackHex;

    if (unchanged && state.built) {
      return {
        ...primitiveOutputs(state.points),
        xValues: state.built.xValues,
        yValues: state.built.yValues,
        zValues: state.built.zValues,
        colors: state.built.colors,
      };
    }

    const inputColors = toColorList(inputs.colors);
    const fileColors = useFile && fileData!.colors ? fileData!.colors.map(([r, g, b]) => new THREE.Color(r, g, b)) : [];
    const activeColors = inputColors.length > 0 ? inputColors : fileColors;

    const count = Math.max(xValues.length, yValues.length, zValues.length);

    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (xValues[i % Math.max(1, xValues.length)] ?? 0) * scaleX;
      positions[i * 3 + 1] = (yValues[i % Math.max(1, yValues.length)] ?? 0) * scaleY;
      positions[i * 3 + 2] = (zValues[i % Math.max(1, zValues.length)] ?? 0) * scaleZ;

      const c = activeColors.length > 0 ? activeColors[i % activeColors.length] : fallbackColor;
      colors[i * 3] = c.r * emissiveIntensity;
      colors[i * 3 + 1] = c.g * emissiveIntensity;
      colors[i * 3 + 2] = c.b * emissiveIntensity;
    }

    state.points.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    state.points.geometry = geometry;

    const colorsOut = activeColors.length > 0 ? activeColors : Array.from({ length: count }, () => fallbackColor);

    state.last = {
      file: fileData,
      x: inputs.xValues,
      y: inputs.yValues,
      z: inputs.zValues,
      colors: inputs.colors,
      pointSize,
      scaleX,
      scaleY,
      scaleZ,
      emissive: emissiveIntensity,
      fallback: fallbackHex,
    };
    state.built = { xValues, yValues, zValues, colors: colorsOut };

    return {
      ...primitiveOutputs(state.points),
      xValues,
      yValues,
      zValues,
      colors: colorsOut,
    };
  },
};
