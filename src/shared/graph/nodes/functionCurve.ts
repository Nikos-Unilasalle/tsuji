import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { NodeDefinition, NodeInstance, ParamFieldDef } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { toBoolean } from "../sockets";
import { asColor, clockInput, numberInput } from "./object";
import { polylineCurve } from "../curveLists";
import { readSpace } from "../mathSpace";
import { ExpressionError } from "../../math/expression";
import { cachedExpression, formulaErrorField } from "./expression";
import { fillToAxis, fillToOrigin } from "../areaFill";

const MODES = ["function", "parametric", "polar"] as const;
type Mode = (typeof MODES)[number];

/** What each mode's formula may read. */
const VARIABLES: Record<Mode, string[]> = {
  function: ["x", "t", "a", "b", "c", "d"],
  parametric: ["t", "a", "b", "c", "d"],
  polar: ["theta", "θ", "t", "a", "b", "c", "d"],
};

interface CurveState {
  root: THREE.Group;
  fill: THREE.Mesh;
  area: number;
  line: LineSegments2;
  material: LineMaterial;
  signature?: string;
  segments: THREE.Vector3[][];
  curves: THREE.CatmullRomCurve3[];
  points: THREE.Vector3[];
  /** Whether anything is left to draw — kept apart from Visible, which the user toggles. */
  hasPoints: boolean;
}

const curveCache = createNodeCache<CurveState>((s) => disposeObject3D(s.root));

function curveState(nodeId: string): CurveState {
  let state = curveCache.get(nodeId);
  if (state) return state;
  const material = new LineMaterial({ color: 0x1f6feb, linewidth: 3 });
  const line = new LineSegments2(new LineSegmentsGeometry(), material);
  line.userData.nodeId = nodeId;
  line.frustumCulled = false;
  const fill = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }),
  );
  fill.userData.nodeId = nodeId;
  fill.frustumCulled = false;
  // The area sits under its own outline.
  fill.renderOrder = -1;
  const root = new THREE.Group();
  root.userData.nodeId = nodeId;
  root.add(fill, line);
  state = { root, fill, area: 0, line, material, segments: [], curves: [], points: [], hasPoints: false };
  curveCache.set(nodeId, state);
  return state;
}

/**
 * Samples the formula into runs of math-space points. A run ends where the
 * value leaves the y window or stops being a number — the asymptote of tan x,
 * the gap of √x below 0 — with a point placed exactly on the window's edge,
 * so a steep branch reaches the border instead of stopping short of it.
 */
export function sampleFunction(
  mode: Mode,
  evaluate: (scope: Record<string, number>, out: number[]) => number[],
  scope: Record<string, number>,
  from: number,
  to: number,
  samples: number,
  yMin: number,
  yMax: number,
): THREE.Vector3[][] {
  const runs: THREE.Vector3[][] = [];
  let run: THREE.Vector3[] = [];
  let prev: THREE.Vector3 | null = null;
  let prevInside = false;
  const out = [0, 0, 0];
  const inside = (p: THREE.Vector3) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) && p.y >= yMin && p.y <= yMax;
  const edge = (a: THREE.Vector3, b: THREE.Vector3) => {
    // Where the segment a→b crosses the window's top or bottom.
    const limit = b.y > yMax || a.y > yMax ? yMax : yMin;
    const k = (limit - a.y) / (b.y - a.y);
    return a.clone().lerp(b, Math.max(0, Math.min(1, k)));
  };
  for (let i = 0; i <= samples; i++) {
    const s = from + ((to - from) * i) / samples;
    out[0] = out[1] = out[2] = 0;
    let p: THREE.Vector3;
    if (mode === "function") {
      scope.x = s;
      p = new THREE.Vector3(s, evaluate(scope, out)[0], 0);
    } else if (mode === "polar") {
      scope.theta = scope["θ"] = s;
      const r = evaluate(scope, out)[0];
      p = new THREE.Vector3(r * Math.cos(s), r * Math.sin(s), 0);
    } else {
      scope.t = s;
      const v = evaluate(scope, out);
      p = new THREE.Vector3(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
    }
    const isIn = inside(p);
    if (!isIn && !prevInside && prev && Number.isFinite(prev.y) && Number.isFinite(p.y) && (prev.y - yMax) * (p.y - yMax) < 0 && (prev.y - yMin) * (p.y - yMin) < 0) {
      // Both ends outside, on opposite sides: a steep piece crosses the whole
      // window between two samples — a near-vertical tangent, a line sampled
      // sparsely. Keep the part that crosses.
      const enter = prev.clone().lerp(p, ((prev.y > yMax ? yMax : yMin) - prev.y) / (p.y - prev.y));
      const leave = prev.clone().lerp(p, ((p.y > yMax ? yMax : yMin) - prev.y) / (p.y - prev.y));
      runs.push([enter, leave]);
    }
    if (isIn) {
      if (!prevInside && prev && Number.isFinite(prev.y)) run.push(edge(p, prev));
      run.push(p);
    } else if (prevInside && prev) {
      if (Number.isFinite(p.y)) run.push(edge(prev, p));
      if (run.length >= 2) runs.push(run);
      run = [];
    }
    prev = p;
    prevInside = isIn;
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

/** The first `progress` (0–1) of the runs' total length — the rest not yet drawn. */
function trimToProgress(runs: THREE.Vector3[][], progress: number): THREE.Vector3[][] {
  if (progress >= 1) return runs;
  const lengths = runs.map((r) => r.reduce((sum, p, i) => (i ? sum + p.distanceTo(r[i - 1]) : 0), 0));
  let budget = Math.max(0, progress) * lengths.reduce((a, b) => a + b, 0);
  const out: THREE.Vector3[][] = [];
  for (let k = 0; k < runs.length && budget > 0; k++) {
    const r = runs[k];
    const kept = [r[0]];
    for (let i = 1; i < r.length; i++) {
      const d = r[i].distanceTo(r[i - 1]);
      if (d <= budget) {
        kept.push(r[i]);
        budget -= d;
      } else {
        kept.push(r[i - 1].clone().lerp(r[i], budget / d));
        budget = 0;
        break;
      }
    }
    if (kept.length >= 2) out.push(kept);
  }
  return out;
}

/**
 * The area between the graph and the x-axis (or, for a polar curve, the
 * origin) from Fill From to Fill To — an integral's region, coloured by sign —
 * and its signed value. Sampled on its own over just that interval, so a
 * moving bound sweeps smoothly; swapped bounds give the opposite sign, as
 * ∫ from b to a does.
 */
function buildFill(
  state: CurveState,
  mode: Mode,
  evaluate: ((scope: Record<string, number>, out: number[]) => number[]) | null,
  scope: Record<string, number>,
  from: number, to: number, samples: number, yMin: number, yMax: number,
  fillFrom: number, fillTo: number,
  space: THREE.Matrix4, above: THREE.Color, below: THREE.Color,
): void {
  const geometry = new THREE.BufferGeometry();
  state.area = 0;
  const lo = Math.max(Math.min(fillFrom, fillTo), Math.min(from, to));
  const hi = Math.min(Math.max(fillFrom, fillTo), Math.max(from, to));
  if (evaluate && mode !== "parametric" && hi > lo) {
    const n = Math.max(2, Math.round((samples * (hi - lo)) / Math.max(1e-9, Math.abs(to - from))));
    const runs = sampleFunction(mode, evaluate, { ...scope }, lo, hi, n, Math.min(yMin, yMax), Math.max(yMin, yMax));
    const filled = mode === "polar" ? fillToOrigin(runs) : fillToAxis(runs);
    state.area = filled.area * (fillTo < fillFrom ? -1 : 1);
    const positions = new Float32Array(filled.positions.length);
    const colors = new Float32Array(filled.positions.length);
    const p = new THREE.Vector3();
    for (let i = 0; i < filled.positions.length; i += 3) {
      p.set(filled.positions[i], filled.positions[i + 1], filled.positions[i + 2]).applyMatrix4(space);
      positions[i] = p.x; positions[i + 1] = p.y; positions[i + 2] = p.z;
      const c = filled.above[i / 3] ? above : below;
      colors[i] = c.r; colors[i + 1] = c.g; colors[i + 2] = c.b;
    }
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  }
  state.fill.geometry.dispose();
  state.fill.geometry = geometry;
}

const FIELDS: ParamFieldDef[] = [
  { id: "mode", label: "Kind", kind: "select", options: [...MODES], optionLabels: ["y = f(x)", "Parametric", "Polar"], group: "Formula" },
  { id: "formula", label: "Formula", kind: "text", group: "Formula" },
  { id: "from", label: "From", kind: "number", step: 0.5, group: "Formula" },
  { id: "to", label: "To", kind: "number", step: 0.5, group: "Formula" },
  { id: "samples", label: "Samples", kind: "number", step: 50, group: "Formula" },
  { id: "yMin", label: "Cut below y", kind: "number", step: 1, group: "Formula" },
  { id: "yMax", label: "Cut above y", kind: "number", step: 1, group: "Formula" },
  { id: "a", label: "a", kind: "number", step: 0.1, group: "Parameters" },
  { id: "b", label: "b", kind: "number", step: 0.1, group: "Parameters" },
  { id: "c", label: "c", kind: "number", step: 0.1, group: "Parameters" },
  { id: "d", label: "d", kind: "number", step: 0.1, group: "Parameters" },
  { id: "progress", label: "Drawn", kind: "number", step: 0.05, group: "Style" },
  { id: "color", label: "Color", kind: "color", group: "Style" },
  { id: "width", label: "Width", kind: "number", step: 0.5, group: "Style" },
  { id: "dashed", label: "Dashed", kind: "boolean", group: "Style" },
  { id: "visible", label: "Visible", kind: "boolean", group: "Style" },
  { id: "fill", label: "Fill Area", kind: "boolean", group: "Area" },
  { id: "fillFrom", label: "Fill From", kind: "number", step: 0.5, group: "Area" },
  { id: "fillTo", label: "Fill To", kind: "number", step: 0.5, group: "Area" },
  { id: "fillColor", label: "Color Above", kind: "color", group: "Area" },
  { id: "fillNegativeColor", label: "Color Below", kind: "color", group: "Area" },
  { id: "fillOpacity", label: "Opacity", kind: "number", step: 0.05, group: "Area" },
];

/**
 * Function Curve — the graph of a formula: y = f(x), a parametric curve
 * (x(t), y(t), z(t)) — a helix, a Lissajous figure, a projectile's path — or
 * a polar curve r(θ). Typed as on paper (see Expression), with a–d as
 * parameters to animate and t as the timeline in the y = f(x) and polar
 * kinds.
 *
 * Wire an Axes' Space and the curve sits on those axes. The curve is drawn
 * as it is (colour, width in pixels, dashes); Drawn traces it progressively,
 * and Curves / Points hand it on to Write On, Curve Fill, Curve Sample and
 * the rest. Values outside the y cut, or not numbers at all, break the curve
 * instead of joining across an asymptote.
 */
export const FUNCTION_CURVE_NODE: NodeDefinition = {
  type: "math/function-curve",
  label: "Function Curve",
  category: "math",
  inputs: [
    { id: "space", label: "Space", type: "matrix" },
    { id: "a", label: "a", type: "value" },
    { id: "b", label: "b", type: "value" },
    { id: "c", label: "c", type: "value" },
    { id: "d", label: "d", type: "value" },
    { id: "progress", label: "Drawn", type: "value" },
    { id: "t", label: "t", type: "value" },
    { id: "fillFrom", label: "Fill From", type: "value" },
    { id: "fillTo", label: "Fill To", type: "value" },
    { id: "visible", label: "Visible", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "curve", label: "Curve", type: "curve" },
    { id: "curves", label: "Curves", type: "list" },
    { id: "points", label: "Points", type: "list" },
    { id: "area", label: "Area", type: "value" },
  ],
  defaultParams: {
    mode: "function",
    formula: "sin(x)",
    from: -5,
    to: 5,
    samples: 400,
    yMin: -10,
    yMax: 10,
    a: 1, b: 0, c: 0, d: 0,
    progress: 1,
    color: new THREE.Color(0x1f6feb),
    width: 3,
    dashed: false,
    visible: true,
    fill: false,
    fillFrom: -1,
    fillTo: 1,
    fillColor: new THREE.Color(0x1f6feb),
    fillNegativeColor: new THREE.Color(0xe5484d),
    fillOpacity: 0.3,
  },
  paramFields: FIELDS,
  dynamicParamFields: (instance: NodeInstance) => {
    const mode = (MODES as readonly string[]).includes(String(instance.params.mode)) ? (instance.params.mode as Mode) : "function";
    return [...formulaErrorField("formula", instance.params.formula, VARIABLES[mode]), ...FIELDS];
  },
  evaluate: (inputs, params, ctx) => {
    const state = curveState(ctx.nodeId);
    const mode = (MODES as readonly string[]).includes(String(params.mode)) ? (params.mode as Mode) : "function";
    const compiled = cachedExpression(String(params.formula ?? ""), VARIABLES[mode]);
    const space = readSpace(inputs.space);

    const scope: Record<string, number> = {
      a: numberInput(inputs.a, params.a, 1),
      b: numberInput(inputs.b, params.b, 0),
      c: numberInput(inputs.c, params.c, 0),
      d: numberInput(inputs.d, params.d, 0),
    };
    if (mode !== "parametric") scope.t = clockInput(inputs, params, ctx, "t");
    const from = numberInput(undefined, params.from, -5);
    const to = numberInput(undefined, params.to, 5);
    const samples = Math.max(2, Math.min(5000, Math.round(numberInput(undefined, params.samples, 400))));
    const yMin = numberInput(undefined, params.yMin, -10);
    const yMax = numberInput(undefined, params.yMax, 10);
    const progress = Math.max(0, Math.min(1, numberInput(inputs.progress, params.progress, 1)));

    // Only what the formula reads can change it: a static curve on a playing timeline is not resampled every frame.
    const reads = compiled instanceof ExpressionError ? [] : compiled.variables;
    const live = Object.fromEntries(Object.entries(scope).filter(([k]) => reads.includes(k)));
    const fillOn = toBoolean(params.fill);
    const fillFrom = numberInput(inputs.fillFrom, params.fillFrom, -1);
    const fillTo = numberInput(inputs.fillTo, params.fillTo, 1);
    const above = asColor(params.fillColor, new THREE.Color(0x1f6feb));
    const below = asColor(params.fillNegativeColor, new THREE.Color(0xe5484d));
    const signature = JSON.stringify([params.formula, mode, live, from, to, samples, yMin, yMax, progress, space.elements, fillOn, fillFrom, fillTo, above.getHex(), below.getHex()]);
    if (state.signature !== signature) {
      state.signature = signature;
      const math = compiled instanceof ExpressionError ? [] : sampleFunction(mode, (s, out) => compiled.evaluate(s, out), scope, from, to, samples, Math.min(yMin, yMax), Math.max(yMin, yMax));
      const drawn = trimToProgress(math, progress);
      state.segments = drawn.map((run) => run.map((p) => p.clone().applyMatrix4(space)));
      state.curves = state.segments.map((run) => polylineCurve(run));
      state.points = state.segments.flat();
      const positions: number[] = [];
      for (const run of state.segments) {
        for (let i = 1; i < run.length; i++) positions.push(run[i - 1].x, run[i - 1].y, run[i - 1].z, run[i].x, run[i].y, run[i].z);
      }
      state.line.geometry.dispose();
      state.line.geometry = new LineSegmentsGeometry().setPositions(positions.length ? positions : [0, 0, 0, 0, 0, 0]);
      state.line.computeLineDistances();
      state.hasPoints = positions.length > 0;
      buildFill(state, mode, compiled instanceof ExpressionError ? null : (sc, out) => compiled.evaluate(sc, out), scope, from, to, samples, yMin, yMax, fillFrom, fillTo, space, above, below);
    }
    state.fill.visible = fillOn && (state.fill.geometry.getAttribute("position")?.count ?? 0) > 0;
    (state.fill.material as THREE.MeshBasicMaterial).opacity = Math.max(0, Math.min(1, numberInput(undefined, params.fillOpacity, 0.3)));

    const { material, line } = state;
    material.color.copy(asColor(params.color, new THREE.Color(0x1f6feb)));
    material.linewidth = Math.max(0.1, numberInput(undefined, params.width, 3));
    const dashed = toBoolean(params.dashed);
    if (material.dashed !== dashed) {
      material.dashed = dashed;
      material.dashSize = 0.15;
      material.gapSize = 0.1;
      material.needsUpdate = true;
    }
    const size = new THREE.Vector2(1920, 1080);
    if (ctx.renderer) {
      ctx.renderer.getSize(size);
      if (size.x <= 0 || size.y <= 0) size.set(1920, 1080);
    }
    material.resolution.copy(size);
    line.visible = state.hasPoints;
    state.root.visible = toBoolean(inputs.visible ?? params.visible ?? true);

    return { geometry: state.root, curve: state.curves[0] ?? null, curves: state.curves, points: state.points, area: state.area };
  },
};
