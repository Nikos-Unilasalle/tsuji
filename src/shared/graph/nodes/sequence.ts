import { Connection, NodeDefinition, NodeInstance, ParamFieldDef } from "../types";
import type { SocketDef } from "../sockets";
import { createNodeCache } from "../nodeCaches";
import { toBoolean } from "../sockets";
import { clockInput, numberInput } from "./object";
import { perSession, sessionKey } from "../sessionState";

export const EASES = ["smooth", "linear", "in", "out", "back"] as const;
export type Ease = (typeof EASES)[number];

export interface Step {
  name: string;
  duration: number;
  ease: Ease;
  /** Starts at this marker's time (by label), or at these seconds, instead of after the step before. */
  at?: string | number;
  /** What the step's output reads before it starts and after it ends — 0 and 1 unless set. */
  from: number;
  to: number;
}

/** Shapes a linear 0–1 into the step's feel. `smooth` eases in and out, Manim's default. */
export function ease(kind: Ease, x: number): number {
  const t = Math.max(0, Math.min(1, x));
  switch (kind) {
    case "linear": return t;
    case "in": return t * t * t;
    case "out": return 1 - Math.pow(1 - t, 3);
    case "back": { const c = 1.70158; const u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; }
    default: return t * t * (3 - 2 * t);
  }
}

/** When each step starts on the timeline: after the one before, unless it names its own start. */
export function stepStarts(steps: Step[], markerTime: (label: string) => number | undefined, offset = 0): number[] {
  const starts: number[] = [];
  let cursor = offset;
  for (const step of steps) {
    let start = cursor;
    if (typeof step.at === "number") start = step.at;
    else if (typeof step.at === "string") start = markerTime(step.at) ?? cursor;
    starts.push(start);
    cursor = start + step.duration;
  }
  return starts;
}

const PREFIX = "step";
const DEFAULT_STEPS = 3;

/** Index of a step output id (`step4` → 4), or −1. */
function outputIndex(id: string): number {
  const m = /^step(\d+)$/.exec(id);
  return m ? Number(m[1]) : -1;
}

/**
 * How many steps this node has: as many as its Steps field asks for, but
 * never fewer than its last wired step output or its last step with a
 * setting of its own — so wiring the spare output, or naming a step, is
 * enough to make it real. `wired` lists output ids known to carry a wire.
 */
export function stepCount(params: Record<string, unknown> | undefined, wired: Iterable<string>): number {
  let count = Math.max(1, Math.floor(numberInput(undefined, params?.steps, DEFAULT_STEPS)));
  for (const id of wired) count = Math.max(count, outputIndex(id) + 1);
  for (const key of Object.keys(params ?? {})) {
    const m = /^step(\d+)(Name|Duration|Ease|Start|From|To)$/.exec(key);
    if (m) count = Math.max(count, Number(m[1]) + 1);
  }
  return Math.min(count, 64);
}

function wiredOutputs(connections: Connection[] | undefined): string[] {
  return (connections ?? []).map((c) => c.fromSocket).filter((id) => outputIndex(id) >= 0);
}

/** Step `i` as set in the panel, with defaults for anything left unset. */
export function readStep(params: Record<string, unknown> | undefined, i: number): Step {
  const name = String(params?.[`${PREFIX}${i}Name`] ?? "").trim() || `step ${i + 1}`;
  const duration = Math.max(0, numberInput(undefined, params?.[`${PREFIX}${i}Duration`], 1));
  const rawEase = String(params?.[`${PREFIX}${i}Ease`] ?? "smooth");
  const kind = ((EASES as readonly string[]).includes(rawEase) ? rawEase : "smooth") as Ease;
  const rawStart = String(params?.[`${PREFIX}${i}Start`] ?? "").trim().replace(/^@/, "");
  const at = rawStart === "" ? undefined : Number.isFinite(Number(rawStart)) ? Number(rawStart) : rawStart;
  const from = numberInput(undefined, params?.[`${PREFIX}${i}From`], 0);
  const to = numberInput(undefined, params?.[`${PREFIX}${i}To`], 1);
  return { name, duration, ease: kind, at, from, to };
}

function outputSockets(params: Record<string, unknown> | undefined, wired: Iterable<string>): SocketDef[] {
  const count = stepCount(params, wired);
  const steps = Array.from({ length: count }, (_, i) => readStep(params, i));
  return [
    ...steps.map((s, i) => ({ id: `${PREFIX}${i}`, label: s.name, type: "value" as const })),
    // Always one spare: wiring it is how a step is added.
    { id: `${PREFIX}${count}`, label: "+", type: "value" as const },
    { id: "index", label: "Current Step", type: "value" as const },
    { id: "current", label: "Current Step Name", type: "text" as const },
    { id: "local", label: "Current Step Progress", type: "value" as const },
    { id: "progresses", label: "All Progresses", type: "list" as const },
    { id: "total", label: "Total Duration", type: "value" as const },
  ];
}

const BASE_FIELDS: ParamFieldDef[] = [
  { id: "steps", label: "Steps", kind: "number", step: 1 },
  {
    id: "mode",
    label: "Play",
    kind: "select",
    options: ["timeline", "trigger"],
    optionLabels: ["Timeline", "Trigger"],
  },
  { id: "offset", label: "Start At", kind: "number", step: 0.5 },
];

function stepFields(count: number): ParamFieldDef[] {
  const fields: ParamFieldDef[] = [];
  for (let i = 0; i < count; i++) {
    const group = `Step ${i + 1}`;
    fields.push(
      { id: `${PREFIX}${i}Name`, label: "Name", kind: "text", group },
      { id: `${PREFIX}${i}Duration`, label: "Duration", kind: "number", step: 0.25, group },
      { id: `${PREFIX}${i}Ease`, label: "Ease", kind: "select", options: [...EASES], optionLabels: ["Smooth", "Linear", "In", "Out", "Back"], group },
      { id: `${PREFIX}${i}Start`, label: "Start", kind: "text", group },
      { id: `${PREFIX}${i}From`, label: "From", kind: "number", step: 0.1, group },
      { id: `${PREFIX}${i}To`, label: "To", kind: "number", step: 0.1, group },
    );
  }
  return fields;
}

/**
 * Before steps had their own fields they were one line of text —
 * `curve: 2; tangent: 1 out @zoom` — and a file saved then still says so.
 * Spelled out into one set of fields per step, the line itself dropped.
 */
function upgradeSequenceParams(params: Record<string, unknown>): Record<string, unknown> {
  if (typeof params.steps !== "string") return params;
  const out: Record<string, unknown> = { ...params };
  let i = 0;
  for (const raw of params.steps.split(/[;\n]/)) {
    const part = raw.trim();
    if (!part) continue;
    const colon = part.indexOf(":");
    const words = (colon >= 0 ? part.slice(colon + 1) : part).trim().split(/[\s,]+/).filter(Boolean);
    const duration = words.map((w) => Number(w.replace("s", ""))).find((n) => Number.isFinite(n));
    if (duration === undefined) continue;
    out[`${PREFIX}${i}Name`] = colon >= 0 ? part.slice(0, colon).trim() : "";
    out[`${PREFIX}${i}Duration`] = duration;
    out[`${PREFIX}${i}Ease`] = words.find((w) => (EASES as readonly string[]).includes(w.toLowerCase()))?.toLowerCase() ?? "smooth";
    out[`${PREFIX}${i}Start`] = (words.find((w) => w.startsWith("@")) ?? "").slice(1);
    i++;
  }
  out.steps = Math.max(1, i);
  return out;
}

/** Trigger mode's memory, per render loop: when each step was set off. */
interface TriggerRun {
  started: number[];
  prevNext: boolean;
  prevBack: boolean;
  epoch: number;
}

const triggerCache = createNodeCache<Map<string, TriggerRun>>();

/**
 * Sequence — named steps played one after another, each giving a 0–1
 * progress to drive anything: draw a curve, fade a label, morph a shape,
 * move the camera. The `play(...)`, `wait(...)` of a math animation script,
 * without the script — and as useful for a title sequence or a cue list.
 *
 * Every step has an output, named after it; the spare output at the end
 * adds a step when wired. Each step's name, duration, ease, start (after
 * the step before, at a timeline marker, or at a given second) and the
 * values its output travels between — From and To, 0 and 1 unless set —
 * are set in the panel.
 *
 * Timeline mode is exact and exportable: scrubbing shows any moment.
 * Trigger mode is for the classroom: each rising edge on Next starts the
 * next step (a key, a click, a remote), Back takes the last one back.
 */
export const SEQUENCE_NODE: NodeDefinition = {
  type: "time/sequence",
  label: "Sequence",
  category: "time",
  inputs: [
    { id: "time", label: "Time", type: "value" },
    { id: "next", label: "Next", type: "value" },
    { id: "back", label: "Back", type: "value" },
  ],
  outputs: outputSockets(undefined, []),
  dynamicOutputs: (connections, _types, params) => outputSockets(params, wiredOutputs(connections)),
  defaultParams: { steps: DEFAULT_STEPS, mode: "timeline", offset: 0, time: 0 },
  upgradeParams: upgradeSequenceParams,
  paramFields: [...BASE_FIELDS, ...stepFields(DEFAULT_STEPS)],
  dynamicParamFields: (instance: NodeInstance, connections?: Connection[]) => [
    ...BASE_FIELDS,
    ...stepFields(stepCount(instance.params, wiredOutputs(connections?.filter((c) => c.fromNode === instance.id)))),
  ],
  evaluate: (inputs, params, ctx) => {
    const count = stepCount(params, ctx.connectedOutputs ?? []);
    const steps = Array.from({ length: count }, (_, i) => readStep(params, i));
    const time = clockInput(inputs, params, ctx, "time");
    const fps = ctx.fps || 30;
    const markers = ctx.markers ?? [];
    const markerTime = (label: string) => {
      const m = markers.find((mk) => mk.label === label);
      return m ? m.frame / fps : undefined;
    };

    let starts: number[];
    if (params.mode === "trigger") {
      let sessions = triggerCache.get(ctx.nodeId);
      if (!sessions) triggerCache.set(ctx.nodeId, (sessions = new Map()));
      const key = sessionKey(ctx);
      const epoch = ctx.simulationEpoch ?? 0;
      let run = perSession(sessions, key, () => ({ started: [] as number[], prevNext: false, prevBack: false, epoch }));
      if (run.epoch !== epoch) {
        run = { started: [], prevNext: false, prevBack: false, epoch };
        sessions.set(key, run);
      }
      const next = toBoolean(inputs.next);
      const back = toBoolean(inputs.back);
      if (next && !run.prevNext && run.started.length < steps.length) run.started.push(time);
      if (back && !run.prevBack) run.started.pop();
      run.prevNext = next;
      run.prevBack = back;
      // Steps not set off yet wait in the future.
      starts = steps.map((_, i) => run.started[i] ?? Infinity);
    } else {
      starts = stepStarts(steps, markerTime, numberInput(undefined, params.offset, 0));
    }

    const out: Record<string, unknown> = {};
    const progresses: number[] = [];
    let index = -1;
    steps.forEach((step, i) => {
      const elapsed = time - starts[i];
      const raw = step.duration > 0 ? elapsed / step.duration : elapsed >= 0 ? 1 : 0;
      const p = Number.isFinite(raw) ? ease(step.ease, raw) : 0;
      // The output travels From → To; the progress lists stay 0–1.
      out[`${PREFIX}${i}`] = step.from + (step.to - step.from) * p;
      progresses.push(p);
      if (elapsed >= 0) index = i;
    });
    // The spare output reads 0 until it is wired, and so becomes a step.
    out[`${PREFIX}${count}`] = 0;
    const end = steps.reduce((max, s, i) => (Number.isFinite(starts[i]) ? Math.max(max, starts[i] + s.duration) : max), 0);
    out.index = index;
    out.current = index >= 0 ? steps[index].name : "";
    out.local = index >= 0 ? progresses[index] : 0;
    out.progresses = progresses;
    out.total = end;
    return out;
  },
};
