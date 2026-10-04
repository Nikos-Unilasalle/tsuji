import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { CurvePaint, curveStrokeMeta } from "../../three/brushScene";
import { Curve3, curvePlane, flattenCurves, fromPlane, samplePressure, strokesSignature, toPlane } from "../curveLists";
import { asColor } from "./object";

function num(input: unknown, param: unknown, fallback: number): number {
  const n = Number(input !== undefined ? input : param);
  return Number.isFinite(n) ? n : fallback;
}

/* -------------------------------------------------------------------------- */
/* Stroke Outline                                                             */
/* -------------------------------------------------------------------------- */

interface OutlineOptions {
  width: number;
  minWidth: number;
  spread: number;
  usePressure: boolean;
  roundCaps: boolean;
}

const CAP_SEGMENTS = 8;

/**
 * The closed shape a stroke covers: its centreline pushed out to each side by
 * half its width — the pressure's, when it was drawn with one — with round or
 * square ends. Built in the stroke's own drawing plane.
 */
export function outlineStroke(curve: Curve3, o: OutlineOptions): THREE.CatmullRomCurve3 | null {
  const sampled = samplePressure(curve, 0.03);
  if (!sampled) return null;
  const plane = curvePlane(sampled.points);
  const flat = sampled.points.map((p) => toPlane(plane, p));
  const n = flat.length;
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  const half: number[] = [];
  const tangents: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = flat[Math.max(0, i - 1)];
    const b = flat[Math.min(n - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const tu = (b[0] - a[0]) / len;
    const tv = (b[1] - a[1]) / len;
    const w = o.spread + Math.max(o.minWidth, o.width * (o.usePressure ? sampled.pressures[i] : 1));
    half.push(w);
    tangents.push([tu, tv]);
    left.push([flat[i][0] - tv * w, flat[i][1] + tu * w]);
    right.push([flat[i][0] + tv * w, flat[i][1] - tu * w]);
  }
  // A half-turn around an end: from the side `from` points to, through the
  // direction `ahead` points to, to the opposite side.
  const cap = (i: number, from: [number, number], ahead: [number, number]): [number, number][] => {
    const out: [number, number][] = [];
    for (let k = 1; k < CAP_SEGMENTS; k++) {
      const a = (Math.PI * k) / CAP_SEGMENTS;
      const du = from[0] * Math.cos(a) + ahead[0] * Math.sin(a);
      const dv = from[1] * Math.cos(a) + ahead[1] * Math.sin(a);
      out.push([flat[i][0] + du * half[i], flat[i][1] + dv * half[i]]);
    }
    return out;
  };
  const [eu, ev] = tangents[n - 1];
  const [su, sv] = tangents[0];
  const ring: [number, number][] = [...left];
  if (o.roundCaps) ring.push(...cap(n - 1, [-ev, eu], [eu, ev]));
  ring.push(...right.reverse());
  if (o.roundCaps) ring.push(...cap(0, [sv, -su], [-su, -sv]));
  const depth = flat.reduce((s, p) => s + p[2], 0) / n;
  const points = ring.map(([u, v]) => fromPlane(plane, u, v, depth));
  const outline = new THREE.CatmullRomCurve3(points, true, "centripetal");
  const color = curveStrokeMeta.get(curve)?.color;
  curveStrokeMeta.set(outline, { color });
  return outline;
}

interface OutlineState {
  ref?: unknown;
  signature?: string;
  curves: THREE.CatmullRomCurve3[];
}

const outlineCache = createNodeCache<OutlineState>();

/**
 * Stroke Outline — turns strokes into the closed shapes they cover, so what
 * fills a shape can follow a line: a wash under a brush stroke, a halo, a
 * filled ribbon. A Grease Pencil stroke's own pressure sets the width when
 * there is one; Spread grows every shape by the same amount.
 */
export const STROKE_OUTLINE_NODE: NodeDefinition = {
  type: "curve/stroke-outline",
  label: "Stroke Outline",
  category: "curve",
  inputs: [
    { id: "curves", label: "Curves", type: "curve" },
    { id: "list", label: "Curves (List)", type: "list" },
    { id: "width", label: "Width", type: "value" },
    { id: "spread", label: "Spread", type: "value" },
  ],
  outputs: [
    { id: "curves", label: "Outlines", type: "curve" },
    { id: "list", label: "Outlines (List)", type: "list" },
  ],
  defaultParams: { width: 0.1, minWidth: 0.01, spread: 0, usePressure: true, caps: "round" },
  paramFields: [
    { id: "width", label: "Half Width (full pressure)", kind: "number", step: 0.01 },
    { id: "minWidth", label: "Min Half Width", kind: "number", step: 0.005 },
    { id: "spread", label: "Spread (added all round)", kind: "number", step: 0.01 },
    { id: "usePressure", label: "Width Follows Pressure", kind: "boolean" },
    { id: "caps", label: "Ends", kind: "select", options: ["round", "square"], optionLabels: ["Round", "Square"] },
  ],
  evaluate: (inputs, params, ctx) => {
    let state = outlineCache.get(ctx.nodeId);
    if (!state) {
      state = { curves: [] };
      outlineCache.set(ctx.nodeId, state);
    }
    const options: OutlineOptions = {
      width: Math.max(0, num(inputs.width, params.width, 0.1)),
      minWidth: Math.max(0, num(undefined, params.minWidth, 0.01)),
      spread: Math.max(0, num(inputs.spread, params.spread, 0)),
      usePressure: params.usePressure !== false,
      roundCaps: params.caps !== "square",
    };
    const ref = [inputs.curves, inputs.list];
    const sameRef = Array.isArray(state.ref) && state.ref[0] === ref[0] && state.ref[1] === ref[1];
    const optionsSig = JSON.stringify(options);
    if (!sameRef || !state.signature?.endsWith(optionsSig)) {
      state.ref = ref;
      const curves = flattenCurves(inputs.curves, inputs.list);
      const signature = `${strokesSignature(curves)}|${optionsSig}`;
      if (signature !== state.signature) {
        state.signature = signature;
        state.curves = curves.map((c) => outlineStroke(c, options)).filter((c): c is THREE.CatmullRomCurve3 => c !== null);
      }
    }
    return { curves: state.curves, list: state.curves };
  },
};

/* -------------------------------------------------------------------------- */
/* Stroke Style                                                               */
/* -------------------------------------------------------------------------- */

interface StyleState {
  /** This node's own copy of each curve it was handed, so its paint does not leak onto the source's. */
  copies: WeakMap<Curve3, Curve3>;
}

const styleCache = createNodeCache<StyleState>();

function itemAt(list: unknown, i: number, fallback: number): number {
  if (!Array.isArray(list) || list.length === 0) return fallback;
  const n = Number(list[Math.min(i, list.length - 1)]);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Stroke Style — gives each curve paint of its own, for the painter (Brush
 * Canvas) to apply curve by curve: the curve counterpart of Set Instance
 * Color. Lists set one value per curve, in order, the last value repeating;
 * unwired, the field below applies to all. Wire Write On's per-stroke lists
 * in and a wash can rise under each stroke as it is finished.
 *
 * Opacity multiplies the painter's pigment (0 leaves a curve out entirely),
 * Weight multiplies its stroke weight; Bleed and Fill Color replace the
 * painter's own when switched on.
 */
export const STROKE_STYLE_NODE: NodeDefinition = {
  type: "curve/stroke-style",
  label: "Stroke Style",
  category: "curve",
  inputs: [
    { id: "curves", label: "Curves", type: "curve" },
    { id: "list", label: "Curves (List)", type: "list" },
    { id: "opacities", label: "Opacity (List)", type: "list" },
    { id: "bleeds", label: "Bleed (List)", type: "list" },
    { id: "weights", label: "Weight (List)", type: "list" },
    { id: "fillColor", label: "Fill Color", type: "color" },
  ],
  outputs: [
    { id: "curves", label: "Curves", type: "curve" },
    { id: "list", label: "Curves (List)", type: "list" },
  ],
  defaultParams: {
    opacity: 1,
    weight: 1,
    setBleed: false,
    bleed: 0.3,
    setFillColor: false,
    fillColor: new THREE.Color(0x6b6b6b),
  },
  paramFields: [
    { id: "opacity", label: "Opacity (all)", kind: "number", step: 0.05, percent: true },
    { id: "weight", label: "Weight (all)", kind: "number", step: 0.05 },
    { id: "setBleed", label: "Set Bleed", kind: "boolean" },
    { id: "bleed", label: "Bleed (all)", kind: "number", step: 0.05 },
    { id: "setFillColor", label: "Set Fill Color", kind: "boolean" },
    { id: "fillColor", label: "Fill Color", kind: "color" },
  ],
  evaluate: (inputs, params, ctx) => {
    let state = styleCache.get(ctx.nodeId);
    if (!state) {
      state = { copies: new WeakMap() };
      styleCache.set(ctx.nodeId, state);
    }
    const curves = flattenCurves(inputs.curves, inputs.list);
    const bleedWired = Array.isArray(inputs.bleeds) && inputs.bleeds.length > 0;
    const colorSet = Boolean(params.setFillColor) || ctx.connectedInputs?.has("fillColor") === true;
    const fillColor = colorSet ? `#${asColor(inputs.fillColor ?? params.fillColor, new THREE.Color(0x6b6b6b)).getHexString()}` : undefined;
    const out = curves.map((curve, i) => {
      let copy = state!.copies.get(curve);
      if (!copy) {
        copy = curve.clone() as Curve3;
        state!.copies.set(curve, copy);
      }
      const source = curveStrokeMeta.get(curve);
      const paint: CurvePaint = {
        opacity: Math.max(0, itemAt(inputs.opacities, i, num(undefined, params.opacity, 1))),
        weight: Math.max(0, itemAt(inputs.weights, i, num(undefined, params.weight, 1))),
        bleed: bleedWired || params.setBleed ? itemAt(inputs.bleeds, i, num(undefined, params.bleed, 0.3)) : source?.bleed,
        fillColor: fillColor ?? source?.fillColor,
      };
      curveStrokeMeta.set(copy, { ...source, ...paint });
      return copy;
    });
    return { curves: out, list: out };
  },
};
