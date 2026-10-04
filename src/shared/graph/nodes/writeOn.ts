import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { getCurveNodePose, setCurveNodePose } from "../curvePoseStore";
import { curveStrokeMeta } from "../../three/brushScene";
import { Curve3, flattenCurves, samplePressure, strokesSignature } from "../curveLists";

function num(input: unknown, param: unknown, fallback: number): number {
  const n = Number(input !== undefined ? input : param);
  return Number.isFinite(n) ? n : fallback;
}

/** One stroke, sampled evenly along its length once, so trimming it each frame is just slicing. */
interface SampledStroke {
  points: THREE.Vector3[];
  pressures: number[];
  length: number;
  color?: string;
  /** The whole stroke as handed on once it is finished — the same object every frame. */
  whole: THREE.CatmullRomCurve3;
}

interface WriteOnState {
  ref?: unknown;
  signature?: string;
  strokes: SampledStroke[];
}

const writeOnCache = createNodeCache<WriteOnState>();

/** Spacing of the samples a stroke is cut along, in world units. */
const SAMPLE_SPACING = 0.01;

function strokeCurve(points: THREE.Vector3[], pressures: number[], color?: string): THREE.CatmullRomCurve3 {
  const curve = new THREE.CatmullRomCurve3(points, false, "centripetal");
  curveStrokeMeta.set(curve, { pressures, color });
  return curve;
}

function sampleStroke(curve: Curve3): SampledStroke | null {
  const sampled = samplePressure(curve, SAMPLE_SPACING);
  if (!sampled) return null;
  const color = curveStrokeMeta.get(curve)?.color;
  return { ...sampled, color, whole: strokeCurve(sampled.points, sampled.pressures, color) };
}

/** The first `fraction` of a stroke, cut between two samples so the tip moves smoothly. */
function trimStroke(stroke: SampledStroke, fraction: number): THREE.CatmullRomCurve3 {
  const last = stroke.points.length - 1;
  const at = Math.max(0, Math.min(1, fraction)) * last;
  const whole = Math.floor(at);
  const points = stroke.points.slice(0, whole + 1);
  const pressures = stroke.pressures.slice(0, whole + 1);
  const rest = at - whole;
  if (rest > 1e-4 && whole < last) {
    points.push(stroke.points[whole].clone().lerp(stroke.points[whole + 1], rest));
    pressures.push(stroke.pressures[whole] + (stroke.pressures[whole + 1] - stroke.pressures[whole]) * rest);
  }
  if (points.length < 2) {
    points.push(stroke.points[Math.min(1, last)].clone().lerp(stroke.points[0], 0.999));
    pressures.push(stroke.pressures[0]);
  }
  return strokeCurve(points, pressures, stroke.color);
}

const EASES: Record<string, (x: number) => number> = {
  linear: (x) => x,
  // A brush lands, accelerates through the stroke and slows to lift or press.
  brush: (x) => x * x * (3 - 2 * x),
  "ease-out": (x) => 1 - (1 - x) * (1 - x),
  "ease-in": (x) => x * x,
};

export interface WriteOnTiming {
  starts: number[];
  durations: number[];
  total: number;
}

/**
 * When each stroke starts and how long it takes. Duration follows length (a
 * long sweep takes longer than a dot); Pause is the time the brush is lifted
 * between strokes; Overlap starts the next stroke before the last one ends —
 * 0 is one stroke after another, 1 draws them all at once.
 */
export function writeOnTiming(lengths: number[], speed: number, pause: number, overlap: number): WriteOnTiming {
  const starts: number[] = [];
  const durations = lengths.map((l) => l / Math.max(1e-6, speed));
  let cursor = 0;
  let total = 0;
  durations.forEach((d, i) => {
    if (i > 0) cursor += (durations[i - 1] + pause) * (1 - overlap);
    starts.push(cursor);
    total = Math.max(total, cursor + d);
  });
  return { starts, durations, total };
}

/**
 * Write On — reveals curves one after another, the way a hand writes them:
 * Blender's Build modifier, After Effects' Write-on. The order is the order
 * of the list (a Grease Pencil drawing's stroke order; a character's stroke
 * order). Each stroke grows from its start with an easing of its own, and a
 * drawn stroke's pressure is cut along with it, so Brush Canvas paints a
 * half-written stroke that still swells and tapers like the whole one.
 *
 * Driven either by Progress (0–1 over the whole drawing) or by the timeline
 * clock from Start Time on, at Speed world units per second — Duration says
 * how long that takes, to size the timeline to it.
 */
export const WRITE_ON_NODE: NodeDefinition = {
  type: "curve/write-on",
  label: "Write On",
  category: "curve",
  inputs: [
    { id: "curves", label: "Curves", type: "curve" },
    { id: "list", label: "Curves (List)", type: "list" },
    { id: "progress", label: "Progress (0-1)", type: "value" },
    { id: "speed", label: "Speed", type: "value" },
  ],
  outputs: [
    { id: "curves", label: "Curves", type: "curve" },
    { id: "list", label: "Curves (List)", type: "list" },
    // One entry per input stroke, in order, whether started or not — to drive
    // whatever should follow each stroke (Stroke Style's wash, a seal…).
    { id: "progress", label: "Progress (List)", type: "list" },
    { id: "age", label: "Seconds Since Done (List)", type: "list" },
    { id: "tip", label: "Brush Tip", type: "vector" },
    { id: "active", label: "Active Stroke", type: "value" },
    { id: "done", label: "Done", type: "value" },
    { id: "duration", label: "Duration (s)", type: "value" },
  ],
  defaultParams: {
    timing: "time",
    progress: 1,
    startTime: 0,
    speed: 3,
    pause: 0.25,
    overlap: 0,
    ease: "brush",
  },
  paramFields: [
    {
      id: "timing",
      label: "Driven By",
      kind: "select",
      options: ["time", "progress"],
      optionLabels: ["Timeline (Speed)", "Progress (0-1)"],
    },
    { id: "progress", label: "Progress", kind: "number", step: 0.01, percent: true },
    { id: "startTime", label: "Start Time (s)", kind: "number", step: 0.1 },
    { id: "speed", label: "Speed (units/s)", kind: "number", step: 0.1 },
    { id: "pause", label: "Pause Between Strokes (s)", kind: "number", step: 0.05 },
    { id: "overlap", label: "Overlap", kind: "number", step: 0.05, percent: true },
    {
      id: "ease",
      label: "Stroke Easing",
      kind: "select",
      options: Object.keys(EASES),
      optionLabels: ["Linear", "Brush (slow in and out)", "Fast Start", "Slow Start"],
    },
  ],
  evaluate: (inputs, params, ctx) => {
    let state = writeOnCache.get(ctx.nodeId);
    if (!state) {
      state = { strokes: [] };
      writeOnCache.set(ctx.nodeId, state);
    }
    const ref = [inputs.curves, inputs.list];
    const sameRef = Array.isArray(state.ref) && state.ref[0] === ref[0] && state.ref[1] === ref[1];
    if (!sameRef) {
      state.ref = ref;
      const curves = flattenCurves(inputs.curves, inputs.list);
      const signature = strokesSignature(curves);
      if (signature !== state.signature) {
        state.signature = signature;
        state.strokes = curves.map(sampleStroke).filter((s): s is SampledStroke => s !== null);
      }
    }

    const source = ctx.inputSources?.get("curves") ?? ctx.inputSources?.get("list");
    const pose = source ? getCurveNodePose(source) : undefined;
    if (pose) setCurveNodePose(ctx.nodeId, pose);

    const speed = Math.max(1e-3, num(inputs.speed, params.speed, 3));
    const pause = Math.max(0, num(undefined, params.pause, 0.25));
    const overlap = Math.max(0, Math.min(1, num(undefined, params.overlap, 0)));
    const ease = EASES[String(params.ease)] ?? EASES.brush;
    const timing = writeOnTiming(state.strokes.map((s) => s.length), speed, pause, overlap);
    const t =
      params.timing === "progress"
        ? Math.max(0, Math.min(1, num(inputs.progress, params.progress, 1))) * timing.total
        : ctx.time - num(undefined, params.startTime, 0);

    const out: THREE.CatmullRomCurve3[] = [];
    const progress: number[] = [];
    const age: number[] = [];
    let active = -1;
    let tip = new THREE.Vector3();
    state.strokes.forEach((stroke, i) => {
      const raw = (t - timing.starts[i]) / Math.max(1e-6, timing.durations[i]);
      progress.push(Math.max(0, Math.min(1, raw)));
      age.push(Math.max(0, t - timing.starts[i] - timing.durations[i]));
      if (raw <= 0) return;
      if (raw >= 1) {
        out.push(stroke.whole);
        tip = stroke.points[stroke.points.length - 1].clone();
        return;
      }
      const curve = trimStroke(stroke, ease(raw));
      out.push(curve);
      active = i;
      tip = curve.points[curve.points.length - 1].clone();
    });
    if (pose) tip.applyMatrix4(pose);

    return {
      curves: out,
      list: out,
      progress,
      age,
      tip,
      active,
      done: state.strokes.length > 0 && t >= timing.total ? 1 : 0,
      duration: timing.total,
    };
  },
};
