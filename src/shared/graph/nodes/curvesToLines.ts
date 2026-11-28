import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { COMMON_MATERIAL_PARAM_FIELDS, extractMaterialParams, primitiveOutputs } from "./object";
import { composeNativeMatrix } from "./transform";

function asNumber(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Samples per curve — fixed, like Curve to Line: more samples never changes a curve's extent. */
const SAMPLES_PER_CURVE = 128;

interface CurvesToLinesState {
  line?: LineSegments2;
  lineGeometry?: LineSegmentsGeometry;
  material?: LineMaterial;
  /** Reference identity of the last `curves` array evaluated — skips rebuilding the geometry when the list is unchanged. */
  lastCurves?: unknown;
  lastDashed?: boolean;
  lastWorldUnits?: boolean;
}

const stateCache = createNodeCache<CurvesToLinesState>((s) => {
  if (s.lineGeometry) s.lineGeometry.dispose();
  if (s.material) s.material.dispose();
  if (s.line) disposeObject3D(s.line);
});

function getState(nodeId: string): CurvesToLinesState {
  let state = stateCache.get(nodeId);
  if (!state) {
    state = {};
    stateCache.set(nodeId, state);
  }
  return state;
}

/**
 * Curves to Lines — the list counterpart of Curve to Line (curve/to_line):
 * every curve in the list becomes a segment run of the same fat,
 * screen-space-width line (Line2/LineMaterial), all merged into one
 * LineSegments2 so a whole bundle draws in a single call instead of one
 * Line2 per curve. Mirrors Curves to Meshes (curve/to_mesh_list) — a list
 * of curves in, one merged renderable out.
 */
export const CURVES_TO_LINES_NODE: NodeDefinition = {
  type: "curve/to_line_list",
  label: "Curves to Lines",
  category: "curve",
  inputs: [
    { id: "curves", label: "Curves", type: "list" },
    { id: "material", label: "Material", type: "material" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "visible", label: "Visible", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    visible: 1,
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    linewidth: 2,
    dashed: false,
    dashRatio: 0.08,
    gapRatio: 0.04,
    dashSize: 3,
    gapSize: 1,
    dashScale: 1,
    worldUnits: false,
    color: new THREE.Color(0x38bdf8),
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 1.0,
    shadeless: 0,
    roughness: 0.4,
    metalness: 0.1,
    wireframe: 0,
    opacity: 1.0,
  },
  dynamicParamFields: () => [
    { id: "visible", label: "Visible", kind: "boolean", group: "Transform" },
    { id: "location", label: "Location", kind: "vector", group: "Transform" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true, group: "Transform" },
    { id: "scale", label: "Scale", kind: "vector", group: "Transform" },
    { id: "linewidth", label: "Width", kind: "number", step: 0.1, group: "Line" },
    { id: "dashed", label: "Dashed", kind: "boolean", group: "Line" },
    { id: "dashRatio", label: "Dash % per curve", kind: "number", step: 0.01, group: "Line" },
    { id: "gapRatio", label: "Gap % per curve", kind: "number", step: 0.01, group: "Line" },
    { id: "worldUnits", label: "World Units (width in scene units)", kind: "boolean", group: "Line" },
    ...COMMON_MATERIAL_PARAM_FIELDS.filter((f) => f.id !== "transmission" && f.id !== "thickness"),
  ],
  evaluate: (inputs, params, ctx) => {
    const curves = Array.isArray(inputs.curves)
      ? (inputs.curves as unknown[]).filter((c): c is THREE.Curve<THREE.Vector3> => c instanceof THREE.Curve)
      : [];

    const state = getState(ctx.nodeId);
    if (!state.material) state.material = new LineMaterial({ vertexColors: false, transparent: true });
    const material = state.material;

    if (!state.lineGeometry || state.lastCurves !== inputs.curves) {
      state.lastCurves = inputs.curves;

      // getPoints(N) returns N+1 points (N segments) — sizing the buffers off
      // a fixed "samples per curve" constant instead of the actual sampled
      // arrays under-allocated by one segment per curve. Harmless for the
      // first curve or two (the overflow just corrupts the next curve's
      // slots), but every curve after that drifted further out of its own
      // range, and the tail of the list fell off the end of the buffer
      // entirely (typed-array writes past the end are silently dropped, not
      // an error) — "not all curves are there". Sampling first, then sizing
      // from the real point counts, fixes both.
      const perCurvePoints = curves.map((curve) => {
        const curvePointsCount = (curve as any).points?.length;
        const curveCurvesCount = (curve as any).curves?.length;
        const samples = Math.max(SAMPLES_PER_CURVE, curvePointsCount ?? (curveCurvesCount ? curveCurvesCount * 2 : SAMPLES_PER_CURVE));
        return curve.getPoints(samples);
      });
      const segmentCount = perCurvePoints.reduce((sum, points) => sum + Math.max(0, points.length - 1), 0);
      const positions = new Float32Array(segmentCount * 6);
      const distStart = new Float32Array(segmentCount);
      const distEnd = new Float32Array(segmentCount);

      let seg = 0;
      for (const points of perCurvePoints) {
        let dist = 0;
        for (let i = 0; i < points.length - 1; i++) {
          const a = points[i];
          const b = points[i + 1];
          positions[seg * 6] = a.x;
          positions[seg * 6 + 1] = a.y;
          positions[seg * 6 + 2] = a.z;
          positions[seg * 6 + 3] = b.x;
          positions[seg * 6 + 4] = b.y;
          positions[seg * 6 + 5] = b.z;
          distStart[seg] = dist;
          dist += a.distanceTo(b);
          distEnd[seg] = dist;
          seg++;
        }
      }

      if (state.lineGeometry) state.lineGeometry.dispose();
      const lineGeometry = new LineSegmentsGeometry();
      lineGeometry.setPositions(positions);
      // Must be InstancedBufferAttribute (divisor 1, one value per segment) —
      // see Curve to Line's computeLineDistances for why a plain attribute
      // (shared across every segment) breaks dashing.
      lineGeometry.setAttribute("instanceDistanceStart", new THREE.InstancedBufferAttribute(distStart, 1));
      lineGeometry.setAttribute("instanceDistanceEnd", new THREE.InstancedBufferAttribute(distEnd, 1));
      delete (lineGeometry as any)._maxInstanceCount;
      state.lineGeometry = lineGeometry;

      if (state.line) {
        if (state.line.geometry) state.line.geometry.dispose();
        delete (state.line as any)._maxInstanceCount;
        state.line.geometry = lineGeometry;
      } else {
        state.line = new LineSegments2(lineGeometry, material);
        state.line.matrixAutoUpdate = false;
        // Same reasoning as Curve to Line: instanced fat-line geometry's
        // bounding sphere is easily stale, which frustum-culls the whole
        // bundle and visually truncates it.
        state.line.frustumCulled = false;
        state.line.userData.nodeId = ctx.nodeId;
      }
    }
    const line = state.line!;

    const matParams = extractMaterialParams(inputs, params);
    const lineColor = matParams.color.clone().add(matParams.emissive.clone().multiplyScalar(matParams.emissiveIntensity));
    material.color.set(lineColor);
    const opacity = Math.min(1, Math.max(0, matParams.opacity));
    material.uniforms.opacity.value = opacity;
    material.transparent = opacity < 0.999;
    material.linewidth = Math.max(0.1, asNumber(params.linewidth, 2));

    const dashRatio = Number(params.dashRatio);
    let dashSize = asNumber(params.dashSize, 3);
    let gapSize = asNumber(params.gapSize, 1);
    let dashScale = asNumber(params.dashScale, 1);
    if (Number.isFinite(dashRatio) && dashRatio > 0 && curves.length > 0) {
      // Dash/gap are world-unit lengths shared by every curve in the bundle,
      // scaled off the first curve's length — good enough when the bundle is
      // roughly uniform (the common case), and still sane, just not
      // per-curve-proportional, when it isn't.
      const sample = curves[0].getPoints(SAMPLES_PER_CURVE);
      let totalLength = 0;
      for (let i = 1; i < sample.length; i++) totalLength += sample[i].distanceTo(sample[i - 1]);
      if (totalLength <= 0) totalLength = 1;
      const gapRatioNum = Number(params.gapRatio);
      const gapRatio = Number.isFinite(gapRatioNum) && gapRatioNum >= 0 ? gapRatioNum : dashRatio * 0.5;
      dashSize = Math.max(0.0001, dashRatio * totalLength);
      gapSize = Math.max(0, gapRatio * totalLength);
      dashScale = 1;
    }
    material.dashScale = dashScale;
    material.dashSize = dashSize;
    material.gapSize = gapSize;
    const dashed = Boolean(params.dashed);
    if (state.lastDashed !== dashed) {
      state.lastDashed = dashed;
      material.dashed = dashed;
      material.needsUpdate = true;
    }
    const worldUnits = Boolean(params.worldUnits);
    if (state.lastWorldUnits !== worldUnits) {
      state.lastWorldUnits = worldUnits;
      material.worldUnits = worldUnits;
      material.needsUpdate = true;
    }

    const size = new THREE.Vector2(1920, 1080);
    if (ctx.renderer) {
      ctx.renderer.getSize(size);
      if (size.x <= 0 || size.y <= 0) size.set(1920, 1080);
    }
    material.resolution.copy(size);

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      line.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    return primitiveOutputs(line);
  },
};
