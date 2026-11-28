import * as THREE from "three";
import type { EvalContext, NodeDefinition, ParamFieldDef } from "../types";
import type { SocketDef } from "../sockets";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { getCurveNodePose, setCurveNodePose } from "../curvePoseStore";
import { flattenCurves } from "../curveLists";
import { worldMatrixOf } from "../objectPosition";
import { polyMeshToGeometry, readPolyMesh } from "../mesh/polyIO";
import { evaluateGroup } from "../mesh/groupExpr";
import { domainEdges } from "../mesh/polyAttributes";
import type { PolyMesh, QuadMeshShading } from "../quadMesh";
import {
  attachCurveAttributes,
  cloneCurveShape,
  curveControlParams,
  curveIsClosed,
  curvePointAttribute,
  getCurveAttributes,
  resampleAttributes,
  safeLength,
  type Curve3,
  type CurveAttributeTrack,
} from "../curveAttributes";
import {
  buildSweepMesh,
  builtinProfile,
  chainEdges,
  cumulativeLengths,
  curveToPolyline,
  filletPolyline,
  isPolylineCurve,
  makePolylineCurve,
  offsetPolyline2D,
  profileFromPolyline,
  resamplePolyline,
  trimPolyline,
  valueAtLength,
  type OffsetJoin,
  type Polyline,
  type SweepRing,
  type V3,
} from "../curveKernel";
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

/*
 * Curve operations (Phase 6 of docs/parametric-modeling-plan.md): per-point
 * radius / tilt, Resample, Trim, Reverse, Fillet, Offset 2D, Sweep (a Curve
 * to Mesh that writes a PolyMesh with groups), Mesh Edges to Curves and Curve
 * Info. The geometry lives in curveKernel.ts; attributes in
 * curveAttributes.ts.
 *
 * Every curve → curve node takes a single `curve` and/or a `curves` list and
 * maps over them, so it slots into either family (Curve from Points, or the
 * list producers: SVG, Grease Pencil, Write-on, Mesh Edges to Curves). It
 * forwards the upstream curve node's pose (curvePoseStore) under its own id —
 * a curve is a path in its source's local space, and Curve to Mesh, Curve to
 * Points and friends look the pose up by whichever node is wired into them.
 */

// ---------------------------------------------------------------- shared

type Reader = {
  num(id: string, fallback: number): number;
  bool(id: string, fallback: boolean): boolean;
  str(id: string, fallback: string): string;
};

function reader(inputs: Record<string, unknown>, params: Record<string, unknown>, defaults: Record<string, unknown>): Reader {
  const raw = (id: string) => (inputs[id] !== undefined && inputs[id] !== null ? inputs[id] : params[id] !== undefined ? params[id] : defaults[id]);
  return {
    num: (id, fb) => {
      const v = raw(id);
      const n = typeof v === "boolean" ? (v ? 1 : 0) : Number(v);
      return v === undefined || v === null || v === "" || !Number.isFinite(n) ? fb : n;
    },
    bool: (id, fb) => {
      const v = raw(id);
      if (v === undefined || v === null) return fb;
      if (typeof v === "number") return v !== 0;
      if (typeof v === "string") return v !== "" && v !== "0" && v !== "false";
      return Boolean(v);
    },
    str: (id, fb) => {
      const v = raw(id);
      return v === undefined || v === null ? fb : String(v);
    },
  };
}

const asCurve = (v: unknown): Curve3 | null => (v instanceof THREE.Curve ? (v as Curve3) : null);

function upstreamPose(ctx: EvalContext, ...sockets: string[]): THREE.Matrix4 | undefined {
  for (const s of sockets) {
    const source = ctx.inputSources?.get(s);
    const pose = source ? getCurveNodePose(source) : undefined;
    if (pose) return pose;
  }
  return undefined;
}

const PREVIEW_COLOR = 0x9ca3af;

interface PreviewState {
  line?: THREE.LineSegments;
  signature?: string;
}
const previews = createNodeCache<PreviewState>((s) => {
  if (s.line) disposeObject3D(s.line);
});

/**
 * The grey wire a curve node draws itself with (cf. Curve from Points'
 * preview line), one object per node, its buffer rebuilt only when the
 * sampled points change. An editing aid: hidden in the camera view.
 */
function curvesPreview(nodeId: string, curves: Curve3[], pose: THREE.Matrix4 | undefined): THREE.LineSegments {
  let state = previews.get(nodeId);
  if (!state) {
    state = {};
    previews.set(nodeId, state);
  }
  if (!state.line) {
    state.line = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: PREVIEW_COLOR }));
    state.line.userData.nodeId = nodeId;
    state.line.userData.isHelper = true;
    state.line.matrixAutoUpdate = false;
  }
  const segments: number[] = [];
  for (const curve of curves) {
    const pts = previewPoints(curve);
    for (let i = 0; i + 1 < pts.length; i++) segments.push(pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
  }
  let h = 0x811c9dc5;
  for (const v of segments) {
    h ^= Math.round(v * 1e4) | 0;
    h = Math.imul(h, 0x01000193);
  }
  const signature = `${segments.length}:${h >>> 0}`;
  if (signature !== state.signature) {
    state.signature = signature;
    state.line.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(segments, 3));
    state.line.geometry = geometry;
  }
  state.line.matrix.copy(pose ?? new THREE.Matrix4());
  return state.line;
}

function previewPoints(curve: Curve3): V3[] {
  try {
    const line = curveToPolyline(curve);
    return line.closed && line.points.length > 1 ? [...line.points, line.points[0]] : line.points;
  } catch {
    return [];
  }
}

/** A new polyline curve, carrying `source`'s attributes resampled at its points. */
function polylineResult(source: Curve3, points: V3[], closed: boolean, sourceParams: number[]): Curve3 {
  const curve = makePolylineCurve(points, closed && points.length >= 3);
  const knots = curveControlParams(curve);
  if (Object.keys(getCurveAttributes(source)).length && knots.length === sourceParams.length) {
    attachCurveAttributes(curve, resampleAttributes(source, sourceParams, knots, curveIsClosed(curve)));
  }
  return curve;
}

/** The source parameter at arc length `s` of a polyline read from a curve. */
function paramAt(line: Polyline, cum: number[], s: number): number {
  return valueAtLength(line.params, line.closed, cum, s, 1);
}

const CURVE_INPUTS: SocketDef[] = [
  { id: "curve", label: "Curve", type: "curve" },
  { id: "curves", label: "Curves", type: "list" },
];
const CURVE_OUTPUTS: SocketDef[] = [
  { id: "curve", label: "Curve", type: "curve" },
  { id: "curves", label: "Curves", type: "list" },
  { id: "geometry", label: "Curve Preview", type: "geometry" },
];

interface CurveOpSpec {
  type: string;
  label: string;
  inputs?: SocketDef[];
  defaultParams: Record<string, unknown>;
  paramFields: ParamFieldDef[];
  op(curve: Curve3, p: Reader, inputs: Record<string, unknown>): Curve3;
}

/**
 * A curve → curve node: maps `op` over the wired curve and list. An op that
 * throws hands its input through unchanged (and logs), so one odd curve in a
 * list never blanks the rest.
 */
function defineCurveOp(spec: CurveOpSpec): NodeDefinition {
  return {
    type: spec.type,
    label: spec.label,
    category: "curve",
    pure: true,
    inputs: [...CURVE_INPUTS, ...(spec.inputs ?? [])],
    outputs: CURVE_OUTPUTS,
    defaultParams: spec.defaultParams,
    paramFields: spec.paramFields,
    evaluate: (inputs, params, ctx) => {
      const p = reader(inputs, params, spec.defaultParams);
      const apply = (c: Curve3): Curve3 => {
        try {
          return spec.op(c, p, inputs);
        } catch (e) {
          console.warn(`${spec.label}:`, e);
          return c;
        }
      };
      const single = asCurve(inputs.curve);
      const list = flattenCurves(inputs.curves).map(apply);
      const curve = single ? apply(single) : (list[0] ?? null);
      const pose = upstreamPose(ctx, "curve", "curves");
      if (pose) setCurveNodePose(ctx.nodeId, pose);
      const shown = single ? [curve as Curve3, ...list] : list;
      return { curve, curves: list, geometry: curvesPreview(ctx.nodeId, shown, pose) };
    },
  };
}

// ---------------------------------------------------------------- set radius / tilt / attribute

function attributeSetter(type: string, label: string, attr: "radius" | "tilt" | null): NodeDefinition {
  const isTilt = attr === "tilt";
  const unit = isTilt ? " (°)" : "";
  const fallback = attr === "radius" ? 1 : 0;
  const defaults: Record<string, unknown> = {
    mode: "constant",
    value: fallback,
    start: fallback,
    end: attr === "radius" ? 0 : fallback,
    ...(attr ? {} : { name: "weight" }),
  };
  return defineCurveOp({
    type,
    label,
    inputs: [
      { id: "value", label: `Value${unit}`, type: "value" },
      { id: "start", label: "Start", type: "value" },
      { id: "end", label: "End", type: "value" },
      { id: "values", label: "Values (List)", type: "list" },
    ],
    defaultParams: defaults,
    paramFields: [
      ...(attr ? [] : [{ id: "name", label: "Attribute Name", kind: "text" } as ParamFieldDef]),
      {
        id: "mode",
        label: "Mode",
        kind: "select",
        options: ["constant", "ramp", "list"],
        optionLabels: ["Constant", "Ramp (start → end, by length)", "List (one per control point)"],
      },
      { id: "value", label: `Value${unit}`, kind: "number", step: isTilt ? 5 : 0.05 },
      { id: "start", label: `Start${unit}`, kind: "number", step: isTilt ? 5 : 0.05 },
      { id: "end", label: `End${unit}`, kind: "number", step: isTilt ? 5 : 0.05 },
    ],
    op: (curve, p, inputs) => {
      const name = attr ?? sanitizeName(p.str("name", "weight"));
      // Tilt is typed in degrees and stored in radians, as Blender does.
      const scale = isTilt ? Math.PI / 180 : 1;
      const knots = curveControlParams(curve);
      const closed = curveIsClosed(curve);
      const mode = p.str("mode", "constant");
      let track: CurveAttributeTrack;
      if (mode === "list") {
        const values = Array.isArray(inputs.values) ? (inputs.values as unknown[]).map((v) => Number(v)) : [];
        track = listTrack(values, knots, closed, fallback);
      } else if (mode === "ramp") {
        const a = p.num("start", fallback);
        const b = p.num("end", fallback);
        const fractions = knotLengthFractions(curve, knots);
        track = { knots, values: fractions.map((f) => a + (b - a) * f), closed };
        // A curve with no inner control points (a line, one Bezier) still ramps — linearly in t.
      } else {
        track = { knots: [0], values: [p.num("value", fallback)], closed };
      }
      track = { ...track, values: track.values.map((v) => v * scale) };
      const out = cloneCurveShape(curve);
      return attachCurveAttributes(out, { ...getCurveAttributes(curve), [name]: track });
    },
  });
}

function sanitizeName(name: string): string {
  const clean = name.trim().replace(/[^A-Za-z0-9_]/g, "_");
  return clean && !/^[0-9]/.test(clean) ? clean : "weight";
}

/**
 * One value per control point when the list matches their count; otherwise
 * the values are spread evenly along the curve's parameter — a list of 3
 * radii on a 10-point curve still means start, middle, end.
 */
function listTrack(values: number[], knots: number[], closed: boolean, fallback: number): CurveAttributeTrack {
  const vals = values.map((v) => (Number.isFinite(v) ? v : fallback));
  if (vals.length === 0) return { knots: [0], values: [fallback], closed };
  if (vals.length === knots.length) return { knots: [...knots], values: vals, closed };
  const denom = closed ? vals.length : Math.max(1, vals.length - 1);
  return { knots: vals.map((_, i) => (vals.length === 1 ? 0 : i / denom)), values: vals, closed };
}

/** How far along the curve's length each knot sits (0..1). */
function knotLengthFractions(curve: Curve3, knots: number[]): number[] {
  const lengths = curve.getLengths();
  const total = lengths[lengths.length - 1];
  if (!(total > 0)) return knots.map((k) => k);
  const div = lengths.length - 1;
  return knots.map((t) => {
    const x = Math.max(0, Math.min(1, t)) * div;
    const i = Math.min(div - 1, Math.floor(x));
    const l = lengths[i] + (lengths[i + 1] - lengths[i]) * (x - i);
    return Math.max(0, Math.min(1, l / total));
  });
}

export const SET_CURVE_RADIUS_NODE = attributeSetter("curve/set-radius", "Set Curve Radius", "radius");
export const SET_CURVE_TILT_NODE = attributeSetter("curve/set-tilt", "Set Curve Tilt", "tilt");
export const SET_CURVE_ATTRIBUTE_NODE = attributeSetter("curve/set-attribute", "Set Curve Attribute", null);

// ---------------------------------------------------------------- resample

export const RESAMPLE_CURVE_NODE = defineCurveOp({
  type: "curve/resample",
  label: "Resample Curve",
  inputs: [
    { id: "count", label: "Count", type: "value" },
    { id: "length", label: "Segment Length", type: "value" },
  ],
  defaultParams: { mode: "count", count: 16, length: 0.25 },
  paramFields: [
    { id: "mode", label: "Mode", kind: "select", options: ["count", "length"], optionLabels: ["Count", "Segment Length"] },
    { id: "count", label: "Count (points)", kind: "number", step: 1 },
    { id: "length", label: "Segment Length", kind: "number", step: 0.05 },
  ],
  op: (curve, p) => {
    const mode = p.str("mode", "count");
    const count = Math.max(2, Math.min(10000, Math.round(p.num("count", 16))));
    // Smooth curves are read finely enough that the even spacing is even along the true curve, not a coarse chord.
    const line = curveToPolyline(curve, isPolylineCurve(curve) ? undefined : Math.min(4096, Math.max(256, count * 8)));
    if (line.points.length < 2) return curve;
    const cum = cumulativeLengths(line.points, line.closed);
    const result =
      mode === "length"
        ? resamplePolyline(line.points, line.closed, { spacing: Math.max(1e-4, Math.abs(p.num("length", 0.25))) })
        : resamplePolyline(line.points, line.closed, { count });
    return polylineResult(curve, result.points, line.closed, result.at.map((s) => paramAt(line, cum, s)));
  },
});

// ---------------------------------------------------------------- trim

/**
 * A stretch of another curve, parameterised by length: getPoint(t) is t of
 * the way from `u0` to `u1` (arc-length fractions of the base). Smooth
 * curves stay smooth, which a sampled polyline would not. On a closed base
 * the window wraps round. toJSON names everything, so Curve to Mesh's rebuild
 * signature changes as the window moves (an animated growing line).
 */
export class TrimmedCurve3 extends THREE.Curve<THREE.Vector3> {
  constructor(
    readonly base: Curve3,
    readonly u0: number,
    readonly u1: number,
    readonly wrap: boolean,
  ) {
    super();
    (this as { type: string }).type = "TrimmedCurve3";
  }

  getPoint(t: number, target: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    let u = this.u0 + (this.u1 - this.u0) * t;
    u = this.wrap ? u - Math.floor(u) : Math.max(0, Math.min(1, u));
    const p = this.base.getPointAt(Math.min(1, Math.max(0, u)));
    return p ? target.copy(p) : target;
  }

  toJSON(): THREE.CurveJSON & { base: unknown; u0: number; u1: number } {
    return { ...super.toJSON(), base: this.base.toJSON(), u0: this.u0, u1: this.u1 };
  }
}

export const TRIM_CURVE_NODE = defineCurveOp({
  type: "curve/trim",
  label: "Trim Curve",
  inputs: [
    { id: "start", label: "Start", type: "value" },
    { id: "end", label: "End", type: "value" },
  ],
  defaultParams: { mode: "factor", start: 0, end: 1 },
  paramFields: [
    { id: "mode", label: "Mode", kind: "select", options: ["factor", "length"], optionLabels: ["Factor (0–1)", "Length"] },
    { id: "start", label: "Start", kind: "number", step: 0.01 },
    { id: "end", label: "End", kind: "number", step: 0.01 },
  ],
  op: (curve, p) => {
    const total = safeLength(curve);
    if (!(total > 1e-9)) return curve;
    const byLength = p.str("mode", "factor") === "length";
    let a = p.num("start", 0);
    let b = p.num("end", byLength ? total : 1);
    if (byLength) {
      a /= total;
      b /= total;
    }
    const closed = curveIsClosed(curve);
    if (b < a) [a, b] = [b, a];
    if (!closed) {
      a = Math.max(0, Math.min(1, a));
      b = Math.max(0, Math.min(1, b));
    } else if (b - a > 1) {
      b = a + 1;
    }
    if (isPolylineCurve(curve)) {
      const line = curveToPolyline(curve);
      const cum = cumulativeLengths(line.points, line.closed);
      const len = cum[cum.length - 1];
      const res = trimPolyline(line.points, line.closed, a * len, b * len);
      const wholeLoop = line.closed && b - a >= 1 - 1e-9;
      const pts = wholeLoop ? res.points.slice(0, -1) : res.points;
      const at = wholeLoop ? res.at.slice(0, -1) : res.at;
      // A window sliding round a loop runs past the seam; read those points one lap back.
      return polylineResult(curve, pts, wholeLoop, at.map((s) => paramAt(line, cum, s > len ? s - len : s)));
    }
    const out = new TrimmedCurve3(curve, a, b, closed);
    const attrs = getCurveAttributes(curve);
    if (Object.keys(attrs).length) {
      const n = 32;
      const ts = Array.from({ length: n + 1 }, (_, i) => i / n);
      const srcParams = ts.map((t) => {
        const u = a + (b - a) * t;
        return curve.getUtoTmapping(closed ? u - Math.floor(u) : u, 0);
      });
      attachCurveAttributes(out, resampleAttributes(curve, srcParams, ts, false));
    }
    return out;
  },
});

// ---------------------------------------------------------------- reverse

/** Another curve run backwards: getPoint(t) = base.getPoint(1 − t). */
export class ReversedCurve3 extends THREE.Curve<THREE.Vector3> {
  constructor(readonly base: Curve3) {
    super();
    (this as { type: string }).type = "ReversedCurve3";
  }

  getPoint(t: number, target: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    const p = this.base.getPoint(1 - Math.max(0, Math.min(1, t)));
    return p ? target.copy(p) : target;
  }

  toJSON(): THREE.CurveJSON & { base: unknown } {
    return { ...super.toJSON(), base: this.base.toJSON() };
  }
}

/**
 * The same shape, run the other way, as the same kind of curve where three's
 * classes allow it (so the worker can still rebuild it). A closed curve keeps
 * its start point, as Blender's Reverse Curve does: [p0, pn-1, …, p1].
 */
function reverseShape(curve: Curve3, closed: boolean): Curve3 {
  if (curve instanceof THREE.CatmullRomCurve3) {
    const pts = curve.points.map((q) => q.clone());
    const rev = closed && curve.closed ? [pts[0], ...pts.slice(1).reverse()] : pts.reverse();
    return new THREE.CatmullRomCurve3(rev, curve.closed, curve.curveType, curve.tension);
  }
  if (curve instanceof THREE.LineCurve3) return new THREE.LineCurve3(curve.v2.clone(), curve.v1.clone());
  if (curve instanceof THREE.QuadraticBezierCurve3) return new THREE.QuadraticBezierCurve3(curve.v2.clone(), curve.v1.clone(), curve.v0.clone());
  if (curve instanceof THREE.CubicBezierCurve3) {
    return new THREE.CubicBezierCurve3(curve.v3.clone(), curve.v2.clone(), curve.v1.clone(), curve.v0.clone());
  }
  if (curve instanceof THREE.CurvePath) {
    const parts = (curve.curves as Curve3[]).map((c) => reverseShape(c, false));
    if (parts.every((c) => !(c instanceof ReversedCurve3))) {
      const path = new THREE.CurvePath<THREE.Vector3>();
      path.autoClose = curve.autoClose;
      for (const c of parts.reverse()) path.add(c);
      // A closed path's last piece ends where the first starts, so read backwards it still starts there.
      return path;
    }
  }
  return new ReversedCurve3(curve);
}

export const REVERSE_CURVE_NODE = defineCurveOp({
  type: "curve/reverse",
  label: "Reverse Curve",
  defaultParams: {},
  paramFields: [],
  op: (curve) => {
    const closed = curveIsClosed(curve);
    const out = reverseShape(curve, closed);
    const attrs = getCurveAttributes(curve);
    if (Object.keys(attrs).length) {
      const flipped: Record<string, CurveAttributeTrack> = {};
      const flip = (k: number) => {
        const r = 1 - k;
        return closed ? (r >= 1 - 1e-12 ? 0 : r) : r;
      };
      for (const [name, tr] of Object.entries(attrs)) flipped[name] = { knots: tr.knots.map(flip), values: [...tr.values], closed: tr.closed };
      attachCurveAttributes(out, flipped);
    }
    return out;
  },
});

// ---------------------------------------------------------------- fillet / offset

export const FILLET_CURVE_NODE = defineCurveOp({
  type: "curve/fillet",
  label: "Fillet Curve",
  inputs: [
    { id: "radius", label: "Radius", type: "value" },
    { id: "segments", label: "Segments", type: "value" },
  ],
  defaultParams: { radius: 0.25, segments: 6 },
  paramFields: [
    { id: "radius", label: "Radius", kind: "number", step: 0.05 },
    { id: "segments", label: "Segments per Corner", kind: "number", step: 1 },
  ],
  op: (curve, p) => {
    const line = curveToPolyline(curve);
    if (line.points.length < 3) return curve;
    const res = filletPolyline(line.points, line.closed, Math.max(0, p.num("radius", 0.25)), p.num("segments", 6));
    return polylineResult(curve, res.points, line.closed, res.source.map((i) => line.params[i] ?? 0));
  },
});

export const OFFSET_CURVE_2D_NODE = defineCurveOp({
  type: "curve/offset-2d",
  label: "Offset Curve 2D",
  inputs: [{ id: "distance", label: "Distance", type: "value" }],
  defaultParams: { distance: 0.25, join: "miter", miterLimit: 4, roundSegments: 4 },
  paramFields: [
    { id: "distance", label: "Distance (+ out / right)", kind: "number", step: 0.05 },
    { id: "join", label: "Corners", kind: "select", options: ["miter", "round", "bevel"], optionLabels: ["Miter", "Round", "Bevel"] },
    { id: "miterLimit", label: "Miter Limit", kind: "number", step: 0.5 },
    { id: "roundSegments", label: "Round Segments (per 90°)", kind: "number", step: 1 },
  ],
  op: (curve, p) => {
    const line = curveToPolyline(curve);
    if (line.points.length < 2) return curve;
    const join = p.str("join", "miter") as OffsetJoin;
    const res = offsetPolyline2D(line.points, line.closed, p.num("distance", 0.25), {
      join: join === "round" || join === "bevel" ? join : "miter",
      miterLimit: p.num("miterLimit", 4),
      roundSegments: p.num("roundSegments", 4),
    });
    return polylineResult(curve, res.points, line.closed, res.source.map((i) => line.params[i] ?? 0));
  },
});

// ---------------------------------------------------------------- sweep

interface SweepState {
  mesh?: THREE.Mesh;
  signature?: string;
}
const sweepStates = createNodeCache<SweepState>((s) => {
  if (s.mesh) disposeObject3D(s.mesh);
});

const SWEEP_FIELDS: ParamFieldDef[] = [
  {
    id: "profileType",
    label: "Profile",
    kind: "select",
    options: ["circle", "square", "flat", "curve"],
    optionLabels: ["Circle", "Square", "Flat (ribbon)", "Profile input"],
    group: "Sweep",
  },
  { id: "radius", label: "Radius (built-in profiles)", kind: "number", step: 0.01, group: "Sweep" },
  { id: "profileSegments", label: "Circle Sides", kind: "number", step: 1, group: "Sweep" },
  { id: "resolution", label: "Path Samples (0 = auto)", kind: "number", step: 4, group: "Sweep" },
  { id: "useRadius", label: "Use Curve Radius", kind: "boolean", group: "Sweep" },
  { id: "useTilt", label: "Use Curve Tilt", kind: "boolean", group: "Sweep" },
  { id: "scaleStart", label: "Scale at Start", kind: "number", step: 0.05, group: "Sweep" },
  { id: "scaleEnd", label: "Scale at End", kind: "number", step: 0.05, group: "Sweep" },
  { id: "twist", label: "Twist (° over the length)", kind: "number", step: 15, group: "Sweep" },
  { id: "caps", label: "Caps (fill open ends)", kind: "boolean", group: "Sweep" },
  { id: "shading", label: "Shading", kind: "select", options: ["auto", "smooth", "flat"], group: "Sweep" },
  { id: "doubleSided", label: "Double Sided", kind: "boolean", group: "Sweep" },
];

/**
 * Sweep — Curve to Mesh, the parametric way: any profile (a wired curve, or
 * a built-in circle / square / ribbon), per-point radius and tilt read from
 * the path's curve attributes, a scale ramp and a twist along the length,
 * optional caps. The result is a PolyMesh, so downstream modelling nodes see
 * real quads, the face groups `side` / `caps` and the point attributes `u`
 * (0..1 along the path) and `v` (0..1 round the profile). Pose and material
 * follow Curve to Mesh: the mesh is built in the path's local space and the
 * source curve's pose is composed into the node's own.
 */
export const SWEEP_CURVE_NODE: NodeDefinition = {
  type: "curve/sweep",
  label: "Sweep",
  category: "curve",
  inputs: [
    { id: "curve", label: "Path", type: "curve" },
    { id: "profile", label: "Profile", type: "curve" },
    { id: "radius", label: "Radius", type: "value" },
    { id: "twist", label: "Twist (°)", type: "value" },
    { id: "scaleStart", label: "Scale Start", type: "value" },
    { id: "scaleEnd", label: "Scale End", type: "value" },
    ...COMMON_PRIMITIVE_INPUTS,
  ],
  outputs: [...COMMON_PRIMITIVE_OUTPUTS, { id: "count", label: "Face Count", type: "value" }],
  defaultParams: {
    ...COMMON_DEFAULT_PARAMS,
    color: new THREE.Color(0x38bdf8),
    profileType: "circle",
    radius: 0.1,
    profileSegments: 12,
    resolution: 0,
    useRadius: true,
    useTilt: true,
    scaleStart: 1,
    scaleEnd: 1,
    twist: 0,
    caps: true,
    shading: "auto",
    doubleSided: false,
  },
  paramFields: buildPrimitiveDynamicParamFields(SWEEP_FIELDS)(),
  dynamicParamFields: buildPrimitiveDynamicParamFields(SWEEP_FIELDS),
  evaluate: (inputs, params, ctx) => {
    const p = reader(inputs, params, SWEEP_CURVE_NODE.defaultParams);
    let state = sweepStates.get(ctx.nodeId);
    if (!state) {
      state = {};
      sweepStates.set(ctx.nodeId, state);
    }
    if (!state.mesh) {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: 0x38bdf8 }));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.nodeId = ctx.nodeId;
      state.mesh = mesh;
    }
    const mesh = state.mesh;
    const path = asCurve(inputs.curve);

    let faceCount = 0;
    const built = path ? sweepInput(path, asCurve(inputs.profile), p) : null;
    const signature = built ? built.signature : "empty";
    if (signature !== state.signature) {
      state.signature = signature;
      const poly = built ? buildSweepMesh(built.options) : { positions: [], faces: [] };
      const shading = p.str("shading", "auto");
      mesh.geometry.dispose();
      mesh.geometry = polyMeshToGeometry(poly, (["auto", "smooth", "flat"].includes(shading) ? shading : "auto") as QuadMeshShading);
    }
    faceCount = (mesh.geometry.userData?.quadMesh?.faces?.length as number | undefined) ?? 0;

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
      const pose = upstreamPose(ctx, "curve");
      if (pose) mesh.matrix.multiply(pose);
    }
    const side = p.bool("doubleSided", false) ? THREE.DoubleSide : THREE.FrontSide;
    applyMaterialParams(mesh, extractMaterialParams(inputs, params), side, extractTextureParams(inputs, params, ctx.nodeId));
    return { ...primitiveOutputs(mesh, params), count: faceCount };
  },
};

function sweepInput(path: Curve3, profileCurve: Curve3 | null, p: Reader) {
  const resolution = Math.max(0, Math.min(4096, Math.round(p.num("resolution", 0))));
  const line = curveToPolyline(path, resolution > 0 ? resolution : undefined);
  if (line.points.length < 2) return null;
  const cum = cumulativeLengths(line.points, line.closed);
  const total = cum[cum.length - 1];
  if (!(total > 1e-9)) return null;

  const type = profileCurve ? "curve" : p.str("profileType", "circle");
  let profile: { points: [number, number][]; closed: boolean };
  let profileScale = Math.max(0, p.num("radius", 0.1));
  if (type === "curve" && profileCurve) {
    const pl = curveToPolyline(profileCurve);
    profile = pl.points.length >= 2 ? profileFromPolyline(pl) : builtinProfile("circle", 12);
    // A drawn profile already has its size: Radius sizes the built-in ones only.
    profileScale = 1;
  } else {
    profile = builtinProfile(type === "curve" ? "circle" : type, p.num("profileSegments", 12));
  }

  const useRadius = p.bool("useRadius", true);
  const useTilt = p.bool("useTilt", true);
  const s0 = p.num("scaleStart", 1);
  const s1 = p.num("scaleEnd", 1);
  const twist = (p.num("twist", 0) * Math.PI) / 180;
  const rings: SweepRing[] = line.points.map((point, i) => {
    const u = cum[i] / total;
    const t = line.params[i] ?? u;
    const radius = useRadius ? curvePointAttribute(path, "radius", t) : 1;
    const tilt = useTilt ? curvePointAttribute(path, "tilt", t) : 0;
    return { point, u, scale: profileScale * radius * (s0 + (s1 - s0) * u), angle: tilt + twist * u };
  });
  const options = { rings, pathClosed: line.closed, profile: profile.points, profileClosed: profile.closed, caps: p.bool("caps", true) };

  let h = 0x811c9dc5;
  const mix = (n: number) => {
    h ^= Math.round((Number.isFinite(n) ? n : 0) * 1e5) | 0;
    h = Math.imul(h, 0x01000193);
  };
  for (const r of rings) {
    mix(r.point.x);
    mix(r.point.y);
    mix(r.point.z);
    mix(r.scale);
    mix(r.angle);
  }
  for (const [x, y] of profile.points) {
    mix(x);
    mix(y);
  }
  const signature = `${rings.length}:${profile.points.length}:${line.closed}:${profile.closed}:${options.caps}:${p.str("shading", "auto")}:${h >>> 0}`;
  return { options, signature };
}

// ---------------------------------------------------------------- mesh edges → curves

interface EdgeCurvesState {
  signature?: string;
  mesh?: PolyMesh;
  curves: Curve3[];
}
const edgeCurveStates = createNodeCache<EdgeCurvesState>(() => {});

/**
 * Mesh Edges to Curves — the edges of a group, chained into polylines
 * (Houdini's Polypath / Blender's Mesh to Curve). Edges mode takes an edge
 * group expression ("" = every edge, `boundary`, `sharp`, `seam`, a stored
 * edge group); Boundary mode takes a FACE group and follows its outline —
 * the open borders of the mesh with an empty group. Junctions split chains.
 * Boundary loops run the way the faces wind. Curves are in the mesh's local
 * space; its world pose is published as this node's curve pose.
 */
export const MESH_EDGES_TO_CURVES_NODE: NodeDefinition = {
  type: "curve/mesh-edges-to-curves",
  label: "Mesh Edges to Curves",
  category: "curve",
  inputs: [{ id: "geometry", label: "Geometry", type: "geometry" }],
  outputs: [
    { id: "curve", label: "First Curve", type: "curve" },
    { id: "curves", label: "Curves", type: "list" },
    { id: "count", label: "Count", type: "value" },
    { id: "geometry", label: "Curve Preview", type: "geometry" },
  ],
  defaultParams: { mode: "edges", group: "" },
  paramFields: [
    {
      id: "mode",
      label: "Mode",
      kind: "select",
      options: ["edges", "boundary"],
      optionLabels: ["Edges in group", "Boundary of face group"],
    },
    { id: "group", label: "Group", kind: "text", help: "group" },
  ],
  evaluate: (inputs, params, ctx) => {
    const obj = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    const read = obj ? readPolyMesh(obj) : null;
    let state = edgeCurveStates.get(ctx.nodeId);
    if (!state) {
      state = { curves: [] };
      edgeCurveStates.set(ctx.nodeId, state);
    }
    if (!read) {
      state.signature = undefined;
      state.curves = [];
      return { curve: null, curves: [], count: 0, geometry: curvesPreview(ctx.nodeId, [], undefined) };
    }
    const mode = params.mode === "boundary" ? "boundary" : "edges";
    const expr = String(params.group ?? "");
    const pose = worldMatrixOf(read.srcMesh);
    setCurveNodePose(ctx.nodeId, pose);
    // PolyMeshes are immutable once built, so identity is a sound cache key.
    const signature = `${mode}|${expr}`;
    if (state.signature !== signature || state.mesh !== read.mesh) {
      state.signature = signature;
      state.mesh = read.mesh;
      state.curves = meshEdgeCurves(read.mesh, mode, expr);
    }
    return { curve: state.curves[0] ?? null, curves: state.curves, count: state.curves.length, geometry: curvesPreview(ctx.nodeId, state.curves, pose) };
  },
};

export function meshEdgeCurves(mesh: PolyMesh, mode: "edges" | "boundary", expr: string): Curve3[] {
  const pairs: [number, number][] = [];
  const directed = new Set<string>();
  if (mode === "boundary") {
    const faces = evaluateGroup(mesh, "face", expr).mask;
    const uses = new Map<string, number>();
    mesh.faces.forEach((face, f) => {
      if (!faces[f]) return;
      for (let i = 0; i < face.length; i++) {
        const a = face[i];
        const b = face[(i + 1) % face.length];
        if (a === b) continue;
        directed.add(`${a}>${b}`);
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        uses.set(key, (uses.get(key) ?? 0) + 1);
      }
    });
    for (const [key, count] of uses) {
      if (count !== 1) continue;
      const [a, b] = key.split("_").map(Number);
      pairs.push([a, b]);
    }
  } else {
    const mask = evaluateGroup(mesh, "edge", expr).mask;
    domainEdges(mesh).forEach(([a, b], i) => {
      if (mask[i]) pairs.push([a, b]);
    });
  }
  const pos = mesh.positions;
  return chainEdges(pairs)
    .filter((c) => c.verts.length >= 2)
    .map((chain) => {
      let verts = chain.verts;
      if (mode === "boundary" && verts.length >= 2 && !directed.has(`${verts[0]}>${verts[1]}`)) {
        verts = chain.closed ? [verts[0], ...verts.slice(1).reverse()] : [...verts].reverse();
      }
      const pts = verts.filter((v) => pos[v]).map((v) => new THREE.Vector3(pos[v][0], pos[v][1], pos[v][2]));
      return makePolylineCurve(pts, chain.closed);
    });
}

// ---------------------------------------------------------------- info

/**
 * Curve Info — length, control point count, closedness and the two ends with
 * their tangents. Positions and tangents are in world space, the source
 * curve's pose applied (as Curve to Points does), so they line up with what
 * is drawn; Length is measured after the pose too.
 */
export const CURVE_INFO_NODE: NodeDefinition = {
  type: "curve/info",
  label: "Curve Info",
  category: "curve",
  pure: true,
  inputs: [{ id: "curve", label: "Curve", type: "curve" }],
  outputs: [
    { id: "length", label: "Length", type: "value" },
    { id: "pointCount", label: "Point Count", type: "value" },
    { id: "closed", label: "Closed", type: "value" },
    { id: "start", label: "Start", type: "vector" },
    { id: "end", label: "End", type: "vector" },
    { id: "startTangent", label: "Start Tangent", type: "vector" },
    { id: "endTangent", label: "End Tangent", type: "vector" },
    { id: "radius", label: "Radius at Start", type: "value" },
  ],
  defaultParams: {},
  paramFields: [],
  evaluate: (inputs, _params, ctx) => {
    const curve = asCurve(inputs.curve);
    const empty = {
      length: 0,
      pointCount: 0,
      closed: 0,
      start: new THREE.Vector3(),
      end: new THREE.Vector3(),
      startTangent: new THREE.Vector3(1, 0, 0),
      endTangent: new THREE.Vector3(1, 0, 0),
      radius: 1,
    };
    if (!curve) return empty;
    try {
      const pose = upstreamPose(ctx, "curve");
      const line = curveToPolyline(curve);
      const pts = pose ? line.points.map((q) => q.clone().applyMatrix4(pose)) : line.points;
      const cum = cumulativeLengths(pts, line.closed);
      const length = cum[cum.length - 1] ?? 0;
      const at = (t: number) => {
        const q = curve.getPoint(t);
        const v = q && Number.isFinite(q.x) ? q.clone() : new THREE.Vector3();
        return pose ? v.applyMatrix4(pose) : v;
      };
      const tangent = (t: number) => {
        const v = curve.getTangent(t)?.clone() ?? new THREE.Vector3(1, 0, 0);
        if (pose) v.transformDirection(pose);
        return v.lengthSq() > 0 && Number.isFinite(v.x) ? v.normalize() : new THREE.Vector3(1, 0, 0);
      };
      return {
        length: Number.isFinite(length) ? length : 0,
        pointCount: curveControlParams(curve).length,
        closed: curveIsClosed(curve) ? 1 : 0,
        start: at(0),
        end: at(1),
        startTangent: tangent(0),
        endTangent: tangent(1),
        radius: curvePointAttribute(curve, "radius", 0),
      };
    } catch (e) {
      console.warn("Curve Info:", e);
      return empty;
    }
  },
};

export const CURVE_OPS_NODES: NodeDefinition[] = [
  SET_CURVE_RADIUS_NODE,
  SET_CURVE_TILT_NODE,
  SET_CURVE_ATTRIBUTE_NODE,
  RESAMPLE_CURVE_NODE,
  TRIM_CURVE_NODE,
  REVERSE_CURVE_NODE,
  FILLET_CURVE_NODE,
  OFFSET_CURVE_2D_NODE,
  SWEEP_CURVE_NODE,
  MESH_EDGES_TO_CURVES_NODE,
  CURVE_INFO_NODE,
];
