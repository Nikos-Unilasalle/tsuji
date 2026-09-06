import * as THREE from "three";
import { NodeDefinition } from "../types";
import { ColorRamp, DEFAULT_COLOR_RAMP, sampleColorRamp } from "../colorRamp";
import { toBoolean } from "../sockets";

/** Get List Item node — retrieves an element from a list at the specified index, with dynamic typing supporting any element type (Geometry, Vector, Matrix, Color, Value, Text). */
export const GET_LIST_ITEM_NODE: NodeDefinition = {
  type: "list/get-item",
  label: "Get List Item",
  category: "list",
  inputs: [
    { id: "list", label: "List", type: "list" },
    { id: "index", label: "Index", type: "value" },
  ],
  outputs: [
    { id: "item", label: "Item", type: "any" },
    { id: "val", label: "Value", type: "value" },
  ],
  dynamicOutputs: (_connections, connectionTypes) => {
    const listConn = connectionTypes?.find((c) => c.connection.toSocket === "list");
    const sourceType = listConn?.sourceSocketType;
    return [
      { id: "item", label: "Item", type: sourceType && sourceType !== "list" ? sourceType : "any" },
      { id: "val", label: "Value", type: "value" },
    ];
  },
  defaultParams: { index: 0 },
  paramFields: [{ id: "index", label: "Index", kind: "number", step: 1 }],
  evaluate: (inputs, params) => {
    const list = Array.isArray(inputs.list) ? inputs.list : [];
    const index = Math.floor(inputs.index !== undefined ? Number(inputs.index) || 0 : Number(params.index) || 0);

    if (list.length === 0) return { item: 0, val: 0 };

    // Wrap around index defensively using modulo
    const safeIndex = ((index % list.length) + list.length) % list.length;
    const raw = list[safeIndex];
    const val = typeof raw === "number" ? raw : Number(raw) || 0;

    return { item: raw, val };
  },
};

/** List Length node — outputs the total number of items in a list. */
export const LIST_LENGTH_NODE: NodeDefinition = {
  type: "list/length",
  label: "List Length",
  category: "list",
  inputs: [{ id: "list", label: "List", type: "list" }],
  outputs: [{ id: "length", label: "Length", type: "value" }],
  defaultParams: {},
  evaluate: (inputs) => {
    const list = Array.isArray(inputs.list) ? inputs.list : [];
    return { length: list.length };
  },
};

/** Generate List node — generates an arithmetic sequence of numbers [start, start + step, ...]. */
export const GENERATE_LIST_NODE: NodeDefinition = {
  type: "list/generate",
  label: "Generate List",
  category: "list",
  inputs: [
    { id: "count", label: "Count", type: "value" },
    { id: "start", label: "Start", type: "value" },
    { id: "step", label: "Step", type: "value" },
  ],
  outputs: [{ id: "list", label: "List", type: "list" }],
  defaultParams: { count: 10, start: 0, step: 1 },
  paramFields: [
    { id: "count", label: "Count", kind: "number", step: 1 },
    { id: "start", label: "Start Value", kind: "number" },
    { id: "step", label: "Step Size", kind: "number", step: 0.1 },
  ],
  evaluate: (inputs, params) => {
    const count = Math.max(0, Math.min(1000, Math.floor(inputs.count !== undefined ? Number(inputs.count) || 0 : Number(params.count) || 10)));
    const start = inputs.start !== undefined ? Number(inputs.start) || 0 : Number(params.start) || 0;
    const step = inputs.step !== undefined ? Number(inputs.step) || 0 : Number(params.step) || 1;

    const list: number[] = [];
    for (let i = 0; i < count; i++) {
      list.push(start + i * step);
    }

    return { list };
  },
};

const LIST_OPS = [
  "add",
  "subtract",
  "multiply",
  "divide",
  "min",
  "max",
  "power",
  "mod",
  "clamp",
  "abs",
  "remap_01",
  "reverse",
  "sort_asc",
  "sort_desc",
];

function toNumericList(val: unknown): number[] {
  if (Array.isArray(val)) {
    return val.map((x) => Number(x) || 0);
  }
  if (val !== undefined && val !== null) {
    const num = Number(val);
    if (!isNaN(num)) return [num];
  }
  return [];
}

/** List Math node — performs math operations or transformations between two lists (A and B) or a list with factor and offset. */
export const LIST_MATH_NODE: NodeDefinition = {
  type: "list/math",
  label: "List Math",
  category: "list",
  inputs: [
    { id: "a", label: "A", type: "list" },
    { id: "b", label: "B", type: "list" },
    { id: "factor", label: "Factor", type: "value" },
    { id: "offset", label: "Offset", type: "value" },
  ],
  outputs: [{ id: "list", label: "List", type: "list" }],
  defaultParams: { op: "add", b: 0, factor: 1, offset: 0 },
  paramFields: [
    { id: "op", label: "Operation", kind: "select", options: LIST_OPS },
    { id: "b", label: "B (fallback)", kind: "number", step: 0.1 },
    { id: "factor", label: "Factor", kind: "number", step: 0.1 },
    { id: "offset", label: "Offset", kind: "number", step: 0.1 },
  ],
  evaluate: (inputs, params) => {
    const rawA = inputs.a !== undefined ? inputs.a : inputs.list;
    const listA = toNumericList(rawA);
    if (listA.length === 0) return { list: [] };

    const op = String(params.op || "add");

    const factor = inputs.factor !== undefined ? Number(inputs.factor) || 0 : (params.factor !== undefined ? Number(params.factor) : 1);
    const offset = inputs.offset !== undefined ? Number(inputs.offset) || 0 : (params.offset !== undefined ? Number(params.offset) : 0);

    // Unary & list transformation operations
    if (op === "remap_01") {
      let min = Infinity;
      let max = -Infinity;
      for (const n of listA) {
        if (n < min) min = n;
        if (n > max) max = n;
      }
      const span = max - min;
      return { list: listA.map((n) => (span === 0 ? 0 : (n - min) / span) * factor + offset) };
    }
    if (op === "abs") return { list: listA.map((n) => Math.abs(n) * factor + offset) };
    if (op === "reverse") return { list: [...listA].reverse().map((n) => n * factor + offset) };
    if (op === "sort_asc") return { list: [...listA].sort((x, y) => x - y).map((n) => n * factor + offset) };
    if (op === "sort_desc") return { list: [...listA].sort((x, y) => y - x).map((n) => n * factor + offset) };

    const hasBInput = inputs.b !== undefined || (params.b !== undefined && Number(params.b) !== 0);

    if (hasBInput) {
      const rawB = inputs.b;
      let listB = toNumericList(rawB);
      if (listB.length === 0) {
        listB = [Number(params.b) || 0];
      }

      const len = listB.length > 1 ? Math.max(listA.length, listB.length) : listA.length;
      const result: number[] = [];

      for (let i = 0; i < len; i++) {
        const valA = listA[i % listA.length];
        const valB = listB.length === 1 ? listB[0] : listB[i % listB.length];

        let val = 0;
        switch (op) {
          case "subtract":
            val = valA - valB;
            break;
          case "multiply":
            val = valA * valB;
            break;
          case "divide":
            val = valB === 0 ? 0 : valA / valB;
            break;
          case "min":
            val = Math.min(valA, valB);
            break;
          case "max":
            val = Math.max(valA, valB);
            break;
          case "power":
            val = Math.pow(valA, valB);
            break;
          case "mod": {
            if (valB === 0) {
              val = 0;
            } else {
              const absB = Math.abs(valB);
              val = ((valA % absB) + absB) % absB;
            }
            break;
          }
          case "clamp": {
            const lower = Math.min(0, valB);
            const upper = Math.max(0, valB);
            val = Math.min(upper, Math.max(lower, valA));
            break;
          }
          case "add":
          default:
            val = valA + valB;
            break;
        }

        result.push(val * factor + offset);
      }

      return { list: result };
    }

    // Single list math (fallback when B is not supplied)
    switch (op) {
      case "add":
        return { list: listA.map((n) => n + offset) };
      case "subtract":
        return { list: listA.map((n) => n - offset) };
      case "divide":
        return { list: listA.map((n) => (factor === 0 ? 0 : n / factor) + offset) };
      case "power":
        return { list: listA.map((n) => Math.pow(n, factor) + offset) };
      case "clamp": {
        const lower = Math.min(offset, factor);
        const upper = Math.max(offset, factor);
        return { list: listA.map((n) => Math.min(upper, Math.max(lower, n))) };
      }
      case "multiply":
      default:
        return { list: listA.map((n) => n * factor + offset) };
    }
  },
};

/** List Statistics node — aggregates a list into sum, average, min, max, median, and count scalar values. */
export const LIST_STATISTICS_NODE: NodeDefinition = {
  type: "list/statistics",
  label: "List Statistics",
  category: "list",
  inputs: [{ id: "list", label: "List", type: "list" }],
  outputs: [
    { id: "sum", label: "Sum", type: "value" },
    { id: "average", label: "Average", type: "value" },
    { id: "min", label: "Min", type: "value" },
    { id: "max", label: "Max", type: "value" },
    { id: "median", label: "Median", type: "value" },
    { id: "count", label: "Count", type: "value" },
  ],
  defaultParams: {},
  evaluate: (inputs) => {
    const rawList = Array.isArray(inputs.list) ? inputs.list : [];
    const numbers = rawList.map((x) => Number(x) || 0);

    if (numbers.length === 0) {
      return { sum: 0, average: 0, min: 0, max: 0, median: 0, count: 0 };
    }

    let sum = 0;
    let min = Infinity;
    let max = -Infinity;

    for (const n of numbers) {
      sum += n;
      if (n < min) min = n;
      if (n > max) max = n;
    }

    const count = numbers.length;
    const average = sum / count;

    const sorted = [...numbers].sort((a, b) => a - b);
    const mid = Math.floor(count / 2);
    const median = count % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

    return { sum, average, min, max, median, count };
  },
};

const COMBINE_LIST_OPS = ["add", "subtract", "multiply", "divide", "min", "max"];

/** Combine Lists Math node — performs term-by-term math operations between two lists (A and B). */
export const LIST_COMBINE_MATH_NODE: NodeDefinition = {
  type: "list/combine-math",
  label: "Combine Lists Math",
  category: "list",
  inputs: [
    { id: "a", label: "A", type: "list" },
    { id: "b", label: "B", type: "list" },
  ],
  outputs: [{ id: "list", label: "List", type: "list" }],
  defaultParams: { op: "add" },
  paramFields: [{ id: "op", label: "Operation", kind: "select", options: COMBINE_LIST_OPS }],
  evaluate: (inputs, params) => {
    const listA = Array.isArray(inputs.a) ? inputs.a.map((x) => Number(x) || 0) : [];
    const listB = Array.isArray(inputs.b) ? inputs.b.map((x) => Number(x) || 0) : [];
    const op = String(params.op || "add");

    const length = Math.max(listA.length, listB.length);
    const result: number[] = [];

    for (let i = 0; i < length; i++) {
      const valA = listA[i] ?? 0;
      const valB = listB[i] ?? 0;

      let res = 0;
      switch (op) {
        case "add":
          res = valA + valB;
          break;
        case "subtract":
          res = valA - valB;
          break;
        case "multiply":
          res = valA * valB;
          break;
        case "divide":
          res = valB === 0 ? 0 : valA / valB;
          break;
        case "min":
          res = Math.min(valA, valB);
          break;
        case "max":
          res = Math.max(valA, valB);
          break;
        default:
          res = valA + valB;
      }
      result.push(res);
    }

    return { list: result };
  },
};


/** Color Palette List node — generates a list of interpolated THREE.Colors between Start Color and End Color. */
export const COLOR_PALETTE_LIST_NODE: NodeDefinition = {
  type: "list/color-palette",
  label: "Color Palette List",
  category: "list",
  inputs: [{ id: "count", label: "Count", type: "value" }],
  outputs: [{ id: "list", label: "Colors", type: "list" }],

  defaultParams: {
    count: 10,
    ramp: DEFAULT_COLOR_RAMP,
  },
  paramFields: [
    { id: "count", label: "Count", kind: "number", step: 1 },
    { id: "ramp", label: "Ramp", kind: "color_ramp" },
  ],
  evaluate: (inputs, params) => {
    const count = Math.max(1, Math.min(500, Math.floor(inputs.count !== undefined ? Number(inputs.count) || 0 : Number(params.count) || 10)));
    const ramp = params.ramp && typeof params.ramp === "object" ? (params.ramp as ColorRamp) : DEFAULT_COLOR_RAMP;

    const list: THREE.Color[] = [];
    for (let i = 0; i < count; i++) {
      const t = count > 1 ? i / (count - 1) : 0;
      list.push(sampleColorRamp(ramp, t));
    }

    return { list };
  },
};

/**
 * List Map Range node — the list counterpart of Map Range (valueMath.ts):
 * remaps every item from a *chosen* input range to a chosen output range,
 * rather than List Math's `remap_01`, which normalizes to the list's own
 * min/max and refits every frame as the data changes. A distances list needs
 * the fixed version — "0 to radius" has to mean the same span every frame, or
 * a halo driven by it would compress and stretch as the mouse moved closer to
 * or further from the grid's edge.
 *
 * Deliberately generic: the output range is just numbers, so the same node
 * drives a scale factor, a height offset, a rotation in degrees, an opacity
 * multiplier — whatever channel the remapped list ends up wired into.
 */
export const LIST_MAP_RANGE_NODE: NodeDefinition = {
  type: "list/map-range",
  label: "List Map Range",
  category: "list",
  inputs: [
    { id: "list", label: "List", type: "list" },
    { id: "inMin", label: "In Min", type: "value" },
    { id: "inMax", label: "In Max", type: "value" },
    { id: "outMin", label: "Out Min", type: "value" },
    { id: "outMax", label: "Out Max", type: "value" },
  ],
  outputs: [{ id: "list", label: "List", type: "list" }],
  defaultParams: { inMin: 0, inMax: 1, outMin: 0, outMax: 1, clamp: 1, power: 1 },
  paramFields: [
    { id: "inMin", label: "In Min", kind: "number", step: 0.1 },
    { id: "inMax", label: "In Max", kind: "number", step: 0.1 },
    { id: "outMin", label: "Out Min", kind: "number", step: 0.1 },
    { id: "outMax", label: "Out Max", kind: "number", step: 0.1 },
    { id: "clamp", label: "Clamp", kind: "boolean" },
    // Shapes the falloff between the two ends without needing a second node:
    // <1 spreads the transition wider, >1 holds outMin longer then snaps.
    { id: "power", label: "Power", kind: "number", step: 0.1 },
  ],
  evaluate: (inputs, params) => {
    const list = toNumericList(inputs.list);
    if (list.length === 0) return { list: [] };

    const inMin = inputs.inMin !== undefined ? Number(inputs.inMin) || 0 : Number(params.inMin) || 0;
    const inMax = inputs.inMax !== undefined ? Number(inputs.inMax) || 0 : Number(params.inMax) || 0;
    const outMin = inputs.outMin !== undefined ? Number(inputs.outMin) || 0 : Number(params.outMin) || 0;
    const outMax = inputs.outMax !== undefined ? Number(inputs.outMax) || 0 : Number(params.outMax) || 0;
    const doClamp = inputs.clamp !== undefined ? toBoolean(inputs.clamp) : Boolean(params.clamp);
    const power = Number(params.power) || 1;
    const span = inMax - inMin;

    const result = list.map((n) => {
      let t = span === 0 ? 0 : (n - inMin) / span;
      if (doClamp) t = Math.min(1, Math.max(0, t));
      if (power !== 1) t = Math.pow(Math.max(0, t), power);
      return outMin + t * (outMax - outMin);
    });

    return { list: result };
  },
};

/**
 * Distance Gradient List node — turns a list of distances (e.g. from the
 * Distances node) into a same-length list of colors sampled off a ramp, so
 * feeding it straight into Set Instance Color's `colors` input paints a halo
 * around whatever the distances were measured from (a Mouse node's point,
 * most often) instead of a single instance flipping color.
 */
export const GRADIENT_LIST_NODE: NodeDefinition = {
  type: "list/gradient",
  label: "Gradient List",
  category: "list",
  inputs: [
    { id: "values", label: "Values", type: "list" },
    { id: "radius", label: "Radius / Max", type: "value" },
  ],
  dynamicInputs: (connections) => {
    const hasDistancesConn = connections.some((c) => c.toSocket === "distances");
    if (hasDistancesConn) {
      return [
        { id: "values", label: "Values", type: "list" },
        { id: "distances", label: "Distances (Legacy)", type: "list" },
        { id: "radius", label: "Radius / Max", type: "value" },
      ];
    }
    return [
      { id: "values", label: "Values", type: "list" },
      { id: "radius", label: "Radius / Max", type: "value" },
    ];
  },
  outputs: [{ id: "list", label: "Colors", type: "list" }],
  defaultParams: {
    radius: 3,
    power: 1,
    ramp: DEFAULT_COLOR_RAMP,
  },
  paramFields: [
    { id: "radius", label: "Radius / Max", kind: "number", step: 0.1 },
    // <1 widens the halo (fades in gently), >1 tightens it (stays at ramp-end
    // color until close, then snaps in) — the falloff shape, not the reach.
    { id: "power", label: "Falloff Power", kind: "number", step: 0.1 },
    { id: "ramp", label: "Ramp (Near → Far)", kind: "color_ramp" },
  ],
  evaluate: (inputs, params) => {
    const rawList = Array.isArray(inputs.values)
      ? inputs.values
      : Array.isArray(inputs.distances)
      ? inputs.distances
      : [];
    const radius = Math.max(0.0001, inputs.radius !== undefined ? Number(inputs.radius) || 0 : Number(params.radius) || 3);
    const power = Number(params.power) || 1;
    const ramp = params.ramp && typeof params.ramp === "object" ? (params.ramp as ColorRamp) : DEFAULT_COLOR_RAMP;

    const list: THREE.Color[] = rawList.map((d) => {
      const raw = Math.max(0, Math.min(1, (Number(d) || 0) / radius));
      const t = power !== 1 ? Math.pow(raw, power) : raw;
      return sampleColorRamp(ramp, t);
    });

    return { list };
  },
};

/** Backward-compatible alias for existing projects and demos */
export const DISTANCE_GRADIENT_LIST_NODE: NodeDefinition = {
  ...GRADIENT_LIST_NODE,
  type: "list/distance-gradient",
  label: "Distance Gradient List",
};

/** Slice List node — returns a sub-slice of an input list. */
export const SLICE_LIST_NODE: NodeDefinition = {
  type: "list/slice",
  label: "Slice List",
  category: "list",
  inputs: [
    { id: "list", label: "List", type: "list" },
    { id: "start", label: "Start", type: "value" },
    { id: "count", label: "Count", type: "value" },
  ],
  outputs: [{ id: "list", label: "List", type: "list" }],
  defaultParams: { start: 0, count: 10 },
  paramFields: [
    { id: "start", label: "Start Index", kind: "number", step: 1 },
    { id: "count", label: "Count", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params) => {
    const rawList = Array.isArray(inputs.list) ? inputs.list : [];
    const start = Math.max(0, Math.floor(inputs.start !== undefined ? Number(inputs.start) || 0 : Number(params.start) || 0));
    const count = Math.max(0, Math.floor(inputs.count !== undefined ? Number(inputs.count) || 0 : Number(params.count) || 10));

    const sliced = rawList.slice(start, start + count);
    return { list: sliced };
  },
};

/** Combine Vector Lists node — composes 3 scalar lists (X, Y, Z) into a list of THREE.Vector3 objects. */
export const COMBINE_VECTOR_LISTS_NODE: NodeDefinition = {
  type: "list/combine-vectors",
  label: "Combine Vectors",
  category: "list",
  inputs: [
    { id: "xList", label: "X List", type: "list" },
    { id: "yList", label: "Y List", type: "list" },
    { id: "zList", label: "Z List", type: "list" },
  ],
  outputs: [{ id: "vectorList", label: "Vector List", type: "list" }],
  defaultParams: { xDefault: 0, yDefault: 0, zDefault: 0 },
  paramFields: [
    { id: "xDefault", label: "X Default", kind: "number", step: 0.1 },
    { id: "yDefault", label: "Y Default", kind: "number", step: 0.1 },
    { id: "zDefault", label: "Z Default", kind: "number", step: 0.1 },
  ],
  evaluate: (inputs, params) => {
    const xList = Array.isArray(inputs.xList) ? inputs.xList : [];
    const yList = Array.isArray(inputs.yList) ? inputs.yList : [];
    const zList = Array.isArray(inputs.zList) ? inputs.zList : [];

    const xDefault = Number(params.xDefault) || 0;
    const yDefault = Number(params.yDefault) || 0;
    const zDefault = Number(params.zDefault) || 0;

    const count = Math.max(xList.length, yList.length, zList.length, 1);
    const vectorList: THREE.Vector3[] = [];

    for (let i = 0; i < count; i++) {
      const x = i < xList.length ? Number(xList[i]) : xDefault;
      const y = i < yList.length ? Number(yList[i]) : yDefault;
      const z = i < zList.length ? Number(zList[i]) : zDefault;
      vectorList.push(
        new THREE.Vector3(
          Number.isFinite(x) ? x : xDefault,
          Number.isFinite(y) ? y : yDefault,
          Number.isFinite(z) ? z : zDefault,
        ),
      );
    }

    return { vectorList };
  },
};

/** Split Vector List node — decomposes a list of THREE.Vector3 objects into 3 scalar number lists (X, Y, Z). */
export const SPLIT_VECTOR_LIST_NODE: NodeDefinition = {
  type: "list/split-vectors",
  label: "Split Vector List",
  category: "list",
  inputs: [{ id: "vectorList", label: "Vector List", type: "list" }],
  outputs: [
    { id: "xList", label: "X List", type: "list" },
    { id: "yList", label: "Y List", type: "list" },
    { id: "zList", label: "Z List", type: "list" },
  ],
  defaultParams: {},
  evaluate: (inputs) => {
    const rawList = Array.isArray(inputs.vectorList) ? inputs.vectorList : [];
    const xList: number[] = [];
    const yList: number[] = [];
    const zList: number[] = [];

    rawList.forEach((item) => {
      if (item instanceof THREE.Vector3) {
        xList.push(item.x);
        yList.push(item.y);
        zList.push(item.z);
      } else if (typeof item === "number") {
        xList.push(item);
        yList.push(item);
        zList.push(item);
      } else if (typeof item === "object" && item !== null && "x" in item && "y" in item) {
        const obj = item as { x: number; y: number; z?: number };
        xList.push(Number(obj.x) || 0);
        yList.push(Number(obj.y) || 0);
        zList.push(Number(obj.z) || 0);
      } else {
        xList.push(0);
        yList.push(0);
        zList.push(0);
      }
    });

    return { xList, yList, zList };
  },
};

function createPrng(seed: number) {
  let s = Math.floor(Math.abs(seed)) % 2147483647;
  if (s <= 0) s = 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Random Sample List node — randomly extracts N elements from a list. */
export const RANDOM_SAMPLE_LIST_NODE: NodeDefinition = {
  type: "list/random-sample",
  label: "Random Sample List",
  category: "list",
  inputs: [
    { id: "list", label: "List", type: "list" },
    { id: "count", label: "Count", type: "value" },
    { id: "seed", label: "Seed", type: "value" },
  ],
  outputs: [
    { id: "list", label: "Sampled List", type: "list" },
    { id: "indices", label: "Indices", type: "list" },
  ],
  dynamicOutputs: (_connections, connectionTypes) => {
    const listConn = connectionTypes?.find((c) => c.connection.toSocket === "list");
    const sourceType = listConn?.sourceSocketType;
    return [
      { id: "list", label: "Sampled List", type: sourceType || "list" },
      { id: "indices", label: "Indices", type: "list" },
    ];
  },
  defaultParams: {
    count: 5,
    seed: 1,
    withReplacement: false,
  },
  paramFields: [
    { id: "count", label: "Count", kind: "number", step: 1 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
    { id: "withReplacement", label: "Allow Duplicates (Replacement)", kind: "boolean" },
  ],
  evaluate: (inputs, params) => {
    const rawList = Array.isArray(inputs.list) ? inputs.list : [];
    if (rawList.length === 0) return { list: [], indices: [] };

    const rawCount = inputs.count !== undefined ? Number(inputs.count) : Number(params.count);
    const count = Math.max(0, Math.min(10000, Math.floor(Number.isFinite(rawCount) ? rawCount : 5)));
    const seed = inputs.seed !== undefined ? Number(inputs.seed) : Number(params.seed);
    const withReplacement = Boolean(params.withReplacement);

    const prng = createPrng(Number.isFinite(seed) ? seed : 1);
    const sampledList: unknown[] = [];
    const sampledIndices: number[] = [];

    if (withReplacement) {
      for (let i = 0; i < count; i++) {
        const idx = Math.floor(prng() * rawList.length);
        sampledIndices.push(idx);
        sampledList.push(rawList[idx]);
      }
    } else {
      const availableIndices = Array.from({ length: rawList.length }, (_, i) => i);
      const sampleCount = Math.min(count, rawList.length);

      for (let i = 0; i < sampleCount; i++) {
        const randomIndex = i + Math.floor(prng() * (availableIndices.length - i));
        const temp = availableIndices[i];
        availableIndices[i] = availableIndices[randomIndex];
        availableIndices[randomIndex] = temp;

        const pickedIdx = availableIndices[i];
        sampledIndices.push(pickedIdx);
        sampledList.push(rawList[pickedIdx]);
      }
    }

    return { list: sampledList, indices: sampledIndices };
  },
};


