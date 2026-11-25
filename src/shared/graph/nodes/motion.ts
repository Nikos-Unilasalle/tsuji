import * as THREE from "three";
import { NodeDefinition, EasingType } from "../types";
import { computeSegmentEasing } from "../evaluate";
import { clockInput, numberInput } from "./object";
import { extractPositionFromInput } from "./transform";

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** The easings a node can offer as a plain dropdown — bezier needs control points. */
export const EASE_OPTIONS = ["smooth", "linear", "hold", "expo", "back", "bounce", "elastic"];

/**
 * How many items a cascade covers, taken from whatever is wired into `source`:
 * a list, or a geometry pack (an Array/Spawner group, whose children are the
 * instances). Falls back to the Count param when nothing is wired, so the node
 * still works standalone.
 */
function resolveCount(source: unknown, fallback: number): number {
  if (Array.isArray(source)) return source.length;
  if (source instanceof THREE.Group && source.children.length > 0) return source.children.length;
  if (source instanceof THREE.Object3D) return 1;
  return fallback;
}

const STAGGER_ORDERS = ["forward", "reverse", "center", "edges", "random"];

/**
 * The order items enter in — the rank each index takes in the cascade, not the
 * index itself. `rank[i] = 0` means item i goes first.
 *
 * "center" fires the middle items first and spreads outwards; "edges" is its
 * mirror, both ends racing towards the middle. "random" is seeded, so the
 * scatter is the same on every replay and every export — a cascade that
 * reshuffles itself each time you scrub is not a cascade.
 */
function staggerRanks(count: number, order: string, seed: number): number[] {
  const ranks = new Array<number>(count);

  if (order === "reverse") {
    for (let i = 0; i < count; i++) ranks[i] = count - 1 - i;
    return ranks;
  }

  if (order === "center" || order === "edges") {
    const mid = (count - 1) / 2;
    // Distance from the middle, ordered into dense ranks so the cascade has no
    // gaps: two items equidistant from the centre share a distance but must
    // still get consecutive ranks.
    const byDistance = Array.from({ length: count }, (_, i) => i).sort((a, b) => {
      const da = Math.abs(a - mid);
      const db = Math.abs(b - mid);
      return da === db ? a - b : da - db;
    });
    if (order === "edges") byDistance.reverse();
    byDistance.forEach((index, rank) => {
      ranks[index] = rank;
    });
    return ranks;
  }

  if (order === "random") {
    const order2 = Array.from({ length: count }, (_, i) => i);
    // Fisher-Yates driven by a small deterministic PRNG (the same Lehmer
    // generator the physics nodes use), so `seed` fully describes the shuffle.
    let s = Math.floor(Math.abs(seed)) % 2147483647;
    if (s <= 0) s = 1;
    const rand = () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };
    for (let i = count - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order2[i], order2[j]] = [order2[j], order2[i]];
    }
    order2.forEach((index, rank) => {
      ranks[index] = rank;
    });
    return ranks;
  }

  for (let i = 0; i < count; i++) ranks[i] = i;
  return ranks;
}

/**
 * Stagger Node — the cascade entrance of motion design. Every item in a pack
 * runs the same animation, each starting a little after the one before.
 *
 * The primary output is `values`: the item's own animated number, already eased
 * and already mapped from `From` to `To`. Wire it straight into Set Instance
 * Transform (scale, posY, rotation…) — no List Math in between. `progress`
 * (0–1), `active` (0/1) and `delays` are still there for anything that needs
 * the raw shape of the cascade.
 *
 * Timing can be expressed either way round: give it the per-item Stagger delay,
 * or give it a Total time and let it space the items to fit. The second is what
 * you actually want when the cascade has to land on a beat.
 */
export const STAGGER_NODE: NodeDefinition = {
  type: "list/stagger",
  label: "Stagger",
  category: "list",
  ownershipPassThrough: true,
  inputs: [
    { id: "time", label: "Time", type: "value" },
    { id: "source", label: "Source (List / Geometry)", type: "any" },
    { id: "count", label: "Count", type: "value" },
    { id: "duration", label: "Duration (s)", type: "value" },
    { id: "offset", label: "Stagger (s)", type: "value" },
    { id: "total", label: "Total (s)", type: "value" },
    { id: "from", label: "From", type: "value" },
    { id: "to", label: "To", type: "value" },
    { id: "startAt", label: "First Start (s)", type: "value" },
  ],
  outputs: [
    { id: "values", label: "Values", type: "list" },
    { id: "progress", label: "Progress (0–1)", type: "list" },
    { id: "active", label: "Active (0/1)", type: "list" },
    { id: "delays", label: "Start Times", type: "list" },
    { id: "count", label: "Count", type: "value" },
  ],
  defaultParams: {
    time: 0,
    count: 10,
    duration: 1,
    offset: 0.1,
    total: 2,
    spacing: "offset",
    order: "forward",
    seed: 1,
    ease: "smooth" as EasingType,
    easeStrength: 1,
    from: 0,
    to: 1,
    startAt: 0,
  },
  dynamicParamFields: () => [
    { id: "count", label: "Count (when no Source wired)", kind: "number", step: 1 },
    { id: "duration", label: "Duration per item (s)", kind: "number", step: 0.05 },
    { id: "spacing", label: "Spacing", kind: "select", options: ["offset", "total"] },
    { id: "offset", label: "Stagger (s) — spacing: offset", kind: "number", step: 0.05 },
    { id: "total", label: "Total (s) — spacing: total", kind: "number", step: 0.1 },
    { id: "startAt", label: "First Start (s)", kind: "number", step: 0.05 },
    { id: "order", label: "Order", kind: "select", options: STAGGER_ORDERS, group: "Cascade" },
    { id: "seed", label: "Seed (order: random)", kind: "number", step: 1, group: "Cascade" },
    { id: "ease", label: "Easing", kind: "select", options: EASE_OPTIONS, group: "Value" },
    { id: "easeStrength", label: "Easing Strength", kind: "number", step: 0.05, group: "Value" },
    { id: "from", label: "From", kind: "number", step: 0.1, group: "Value" },
    { id: "to", label: "To", kind: "number", step: 0.1, group: "Value" },
  ],
  evaluate: (inputs, params, ctx) => {
    const time = clockInput(inputs, params, ctx);
    const count = Math.max(
      1,
      Math.min(10000, Math.round(resolveCount(inputs.source, numberInput(inputs.count, params.count, 10)))),
    );
    const duration = Math.max(0.0001, numberInput(inputs.duration, params.duration, 1));
    const startAt = numberInput(inputs.startAt, params.startAt, 0);
    const from = numberInput(inputs.from, params.from, 0);
    const to = numberInput(inputs.to, params.to, 1);
    const ease = String(params.ease || "smooth") as EasingType;
    const strength = numberInput(undefined, params.easeStrength, 1);
    const order = String(params.order || "forward");
    const seed = numberInput(undefined, params.seed, 1);

    const ranks = staggerRanks(count, order, seed);
    const maxRank = Math.max(1, count - 1);

    // Two ways to say the same thing. "total" is the whole cascade start-to-
    // finish, so the last item has to *finish* at `total` — its start is
    // total - duration, which is what the step has to reach.
    let step: number;
    if (String(params.spacing || "offset") === "total") {
      const total = Math.max(0, numberInput(inputs.total, params.total, 2));
      step = Math.max(0, (total - duration) / maxRank);
    } else {
      step = Math.max(0, numberInput(inputs.offset, params.offset, 0.1));
    }

    const values: number[] = [];
    const progress: number[] = [];
    const active: number[] = [];
    const delays: number[] = [];
    for (let i = 0; i < count; i++) {
      const start = startAt + ranks[i] * step;
      const raw = clamp01((time - start) / duration);
      const eased = computeSegmentEasing(raw, ease, strength);
      delays.push(start);
      progress.push(eased);
      values.push(from + (to - from) * eased);
      active.push(time >= start && time < start + duration ? 1 : 0);
    }
    return { values, progress, active, delays, count };
  },
};

/**
 * Time Remap Node — maps an input time range onto an output range through an
 * easing curve. The classic tool for slow-motion, speed ramps, holds and
 * reversal: feed `time` from the clock and drive a node's local time.
 */
export const TIME_REMAP_NODE: NodeDefinition = {
  type: "time/remap",
  label: "Time Remap",
  category: "time",
  inputs: [
    { id: "time", label: "Time", type: "value" },
    { id: "inStart", label: "Input Start", type: "value" },
    { id: "inEnd", label: "Input End", type: "value" },
    { id: "outStart", label: "Output Start", type: "value" },
    { id: "outEnd", label: "Output End", type: "value" },
    { id: "loop", label: "Loop", type: "value" },
  ],
  outputs: [{ id: "time", label: "Remapped Time", type: "value" }],
  defaultParams: {
    time: 0,
    inStart: 0,
    inEnd: 1,
    outStart: 0,
    outEnd: 1,
    ease: "smooth" as EasingType,
    loop: 0,
  },
  dynamicParamFields: () => [
    { id: "inStart", label: "Input Start", kind: "number", step: 0.05 },
    { id: "inEnd", label: "Input End", kind: "number", step: 0.05 },
    { id: "outStart", label: "Output Start", kind: "number", step: 0.05 },
    { id: "outEnd", label: "Output End", kind: "number", step: 0.05 },
    { id: "ease", label: "Easing", kind: "select", options: EASE_OPTIONS },
    { id: "loop", label: "Loop", kind: "boolean" },
  ],
  evaluate: (inputs, params, ctx) => {
    const time = clockInput(inputs, params, ctx);
    const inStart = numberInput(inputs.inStart, params.inStart, 0);
    const inEnd = numberInput(inputs.inEnd, params.inEnd, 1);
    const outStart = numberInput(inputs.outStart, params.outStart, 0);
    const outEnd = numberInput(inputs.outEnd, params.outEnd, 1);
    const ease = (String(params.ease || "smooth") as EasingType);
    const loop = inputs.loop !== undefined ? Number(inputs.loop) > 0 : Boolean(params.loop);

    const span = inEnd - inStart;
    if (span === 0) return { time: outStart };

    let t = (time - inStart) / span;
    if (loop) {
      t = t - Math.floor(t);
    } else {
      t = Math.max(0, Math.min(1, t));
    }
    const eased = computeSegmentEasing(t, ease);
    return { time: outStart + (outEnd - outStart) * eased };
  },
};

const ORBIT_AXES = ["Y", "X", "Z"];

/** Unit normal of the orbit plane, plus the two in-plane axes angle 0 and 90° point along. */
function orbitBasis(axis: string): { normal: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3 } {
  switch (axis) {
    // Orbit in the YZ plane, starting on +Y.
    case "X":
      return {
        normal: new THREE.Vector3(1, 0, 0),
        u: new THREE.Vector3(0, 1, 0),
        v: new THREE.Vector3(0, 0, 1),
      };
    // Orbit in the XY plane, starting on +X.
    case "Z":
      return {
        normal: new THREE.Vector3(0, 0, 1),
        u: new THREE.Vector3(1, 0, 0),
        v: new THREE.Vector3(0, 1, 0),
      };
    // "Y" — the horizontal orbit, in the XZ plane, starting on +X.
    default:
      return {
        normal: new THREE.Vector3(0, 1, 0),
        u: new THREE.Vector3(1, 0, 0),
        v: new THREE.Vector3(0, 0, -1),
      };
  }
}

/**
 * Orbit Node — a matrix that circles a target.
 *
 * The target is whatever you can point at: a geometry (its world position), a
 * matrix, or a plain vector. Out comes a Matrix ready for Matrix Transform, a
 * Camera, a Spawner — anything that takes one — plus the bare position for
 * when only the point matters.
 *
 * With `Face Target` on, the matrix also *aims*: -Z looks at the centre, the
 * camera convention, so wiring this into a Camera node gives a turntable with
 * nothing else attached. Off, the orbit only translates and the orbiting object
 * keeps its own orientation.
 */
export const ORBIT_NODE: NodeDefinition = {
  type: "transform/orbit",
  label: "Orbit",
  category: "transform",
  inputs: [
    { id: "target", label: "Target (Geometry / Matrix)", type: "any" },
    { id: "time", label: "Time", type: "value" },
    { id: "radius", label: "Radius", type: "value" },
    { id: "speed", label: "Speed (°/s)", type: "value" },
    { id: "phase", label: "Phase (°)", type: "value" },
    { id: "height", label: "Height", type: "value" },
  ],
  outputs: [
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "position", label: "Position", type: "vector" },
  ],
  defaultParams: {
    time: 0,
    radius: 5,
    speed: 45,
    phase: 0,
    height: 0,
    axis: "Y",
    tilt: 0,
    faceTarget: false,
  },
  dynamicParamFields: () => [
    { id: "radius", label: "Radius", kind: "number", step: 0.1 },
    { id: "speed", label: "Speed (°/s)", kind: "number", step: 1 },
    // Phase and Tilt are stored in degrees, matching Speed (°/s) beside them
    // and the `* DEG` each gets in evaluate. Marking them `degrees: true`
    // made the panel store radians instead, so a typed 90 became 1.5708 and
    // then 1.5708° — a quarter turn that moved the orbit by almost nothing.
    { id: "phase", label: "Phase (°)", kind: "number", step: 1 },
    { id: "height", label: "Height (along axis)", kind: "number", step: 0.1 },
    { id: "axis", label: "Orbit Axis", kind: "select", options: ORBIT_AXES },
    { id: "tilt", label: "Tilt (°)", kind: "number", step: 1 },
    { id: "faceTarget", label: "Face Target (aim -Z at the centre)", kind: "boolean" },
  ],
  evaluate: (inputs, params, ctx) => {
    const center = extractPositionFromInput(inputs.target, new THREE.Vector3(0, 0, 0));
    const time = clockInput(inputs, params, ctx);
    const radius = numberInput(inputs.radius, params.radius, 5);
    const speed = numberInput(inputs.speed, params.speed, 45);
    const phase = numberInput(inputs.phase, params.phase, 0);
    const height = numberInput(inputs.height, params.height, 0);
    const tilt = numberInput(undefined, params.tilt, 0);

    const DEG = Math.PI / 180;
    const { normal, u, v } = orbitBasis(String(params.axis || "Y"));

    // Tilting rotates the whole plane about the angle-0 axis, so the orbit
    // leans without its starting point moving.
    if (tilt !== 0) {
      const lean = new THREE.Quaternion().setFromAxisAngle(u, tilt * DEG);
      normal.applyQuaternion(lean);
      v.applyQuaternion(lean);
    }

    const angle = (phase + speed * time) * DEG;
    const position = center
      .clone()
      .addScaledVector(u, Math.cos(angle) * radius)
      .addScaledVector(v, Math.sin(angle) * radius)
      .addScaledVector(normal, height);

    const matrix = new THREE.Matrix4();
    if (Boolean(params.faceTarget)) {
      // lookAt builds the rotation that aims -Z at the target with `normal` as
      // up; the translation is written in afterwards because lookAt only fills
      // the rotation part.
      matrix.lookAt(position, center, normal);
      matrix.setPosition(position);
    } else {
      matrix.makeTranslation(position.x, position.y, position.z);
    }

    return { matrix, position };
  },
};
