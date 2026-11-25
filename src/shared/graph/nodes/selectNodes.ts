import * as THREE from "three";
import type { ParamFieldDef } from "../types";
import type { PolyMesh } from "../quadMesh";
import { proportionalWeight, type ProportionalFalloff } from "../quadMesh";
import {
  ATTR_DOMAINS,
  domainEdges,
  domainSize,
  readAttribute,
  setAttribute,
  setGroup,
  isValidAttributeName,
  facePieces,
  type AttrDomain,
} from "../mesh/polyAttributes";
import { evaluateGroup, maskIndices } from "../mesh/groupExpr";
import { promoteMask, promoteValues, type PromoteRule } from "../mesh/promote";
import {
  edgeDistances,
  elementNormals,
  elementPositions,
  makeClosestPoint,
  makeInsideTest,
  maskToSelection,
  meshTriangles,
  modeOf,
  nonManifoldEdgeMask,
  pathEdgeMask,
  pointValence,
  randomMask,
  selectionToMask,
  shortestPath,
} from "../mesh/selectOps";
import { flatFaces, growSelection, linkedSelection, shrinkSelection } from "../mesh/selection";
import { edgeLoop, edgeRing } from "../mesh/loops";
import { getTopology } from "../mesh/topology";
import { valueNoise3 } from "../../math/valueNoise";
import { definePolyNode, type PolyRunContext } from "./polyModifier";

/*
 * Parametric selection (phase 2 of docs/parametric-modeling-plan.md).
 *
 * Every Select node takes a geometry and hands it back with a *group* — a
 * named bool attribute — written on one domain. Modifiers downstream pick it
 * up by name in their Group field. Nothing here changes the shape.
 *
 * Shared fields: Name (the group written), Domain, Write (replace / add /
 * intersect / subtract against a group of that name already there), Invert.
 */

export const WRITE_MODES = ["replace", "add", "intersect", "subtract"] as const;
type WriteMode = (typeof WRITE_MODES)[number];

const OUTPUT_FIELDS: ParamFieldDef[] = [
  { id: "name", label: "Group Name", kind: "text", group: "Output" },
  { id: "domain", label: "Domain", kind: "select", options: [...ATTR_DOMAINS], group: "Output" },
  { id: "write", label: "Write", kind: "select", options: [...WRITE_MODES], group: "Output" },
  { id: "invert", label: "Invert", kind: "boolean", group: "Output" },
];

const OUTPUT_DEFAULTS = { name: "selected", domain: "face", write: "replace", invert: false };

const COUNT_OUTPUTS = [
  { id: "count", label: "Selected Count", type: "value" as const },
  { id: "mask", label: "Mask (list)", type: "list" as const },
];

function domainParam(run: PolyRunContext, fallback: AttrDomain = "face"): AttrDomain {
  const d = run.str("domain", fallback);
  return (ATTR_DOMAINS as readonly string[]).includes(d) ? (d as AttrDomain) : fallback;
}

/** Combines a fresh mask with what the named group already holds, writes it, and builds the node result. */
export function writeSelection(run: PolyRunContext, mesh: PolyMesh, domain: AttrDomain, fresh: Uint8Array, extra?: { weights?: Float64Array; weightName?: string }) {
  const name = run.str("name", "selected").trim() || "selected";
  if (!isValidAttributeName(name)) {
    run.note(`"${name}" is not a valid group name (letters, digits, _)`, true);
    return { mesh, outputs: { count: 0, mask: [] as number[] } };
  }
  const invert = run.bool("invert", false);
  const mode = run.str("write", "replace") as WriteMode;
  const count = fresh.length;
  const current = readAttribute(mesh, domain, name);
  const mask = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const v = invert ? (fresh[i] ? 0 : 1) : fresh[i] ? 1 : 0;
    const old = current ? (current.values[i * current.size] ? 1 : 0) : 0;
    mask[i] = mode === "add" ? old | v : mode === "intersect" ? old & v : mode === "subtract" ? old & (v ^ 1) : v;
  }
  let out = setGroup(mesh, domain, name, mask);
  if (extra?.weights && extra.weightName && isValidAttributeName(extra.weightName)) {
    out = setAttribute(out, domain, extra.weightName, "float", extra.weights);
  }
  const selected = maskIndices(mask).length;
  run.note(`${selected} / ${count} ${domain}s → "${name}"`);
  return { mesh: out, outputs: { count: selected, mask: Array.from(mask) } };
}

function toSpace(run: PolyRunContext, positions: Float64Array): Float64Array {
  if (run.str("space", "world") !== "world") return positions;
  const m = run.worldMatrix;
  const v = new THREE.Vector3();
  const out = new Float64Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    v.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(m);
    out[i] = v.x;
    out[i + 1] = v.y;
    out[i + 2] = v.z;
  }
  return out;
}

function normalsToSpace(run: PolyRunContext, normals: Float64Array): Float64Array {
  if (run.str("space", "world") !== "world") return normals;
  const nm = new THREE.Matrix3().getNormalMatrix(run.worldMatrix);
  const v = new THREE.Vector3();
  const out = new Float64Array(normals.length);
  for (let i = 0; i < normals.length; i += 3) {
    v.set(normals[i], normals[i + 1], normals[i + 2]).applyMatrix3(nm).normalize();
    out[i] = v.x;
    out[i + 1] = v.y;
    out[i + 2] = v.z;
  }
  return out;
}

const SPACE_FIELD: ParamFieldDef = { id: "space", label: "Space", kind: "select", options: ["world", "local"], group: "Selection" };

// ============================================================ Select

export const SELECT_MODES = ["all", "expression", "random", "box", "sphere", "plane", "axis-range", "normal", "inside-object", "noise"] as const;

export const SELECT_NODE = definePolyNode({
  type: "select/basic",
  label: "Select",
  category: "selection",
  dependsOnPose: true,
  inputs: [
    { id: "center", label: "Center", type: "vector" },
    { id: "size", label: "Size", type: "vector" },
    { id: "radius", label: "Radius", type: "value" },
    { id: "direction", label: "Direction / Normal", type: "vector" },
    { id: "angle", label: "Angle", type: "value" },
    { id: "fraction", label: "Fraction", type: "value" },
    { id: "seed", label: "Seed", type: "value" },
    { id: "min", label: "Min", type: "value" },
    { id: "max", label: "Max", type: "value" },
    { id: "threshold", label: "Threshold", type: "value" },
    { id: "object", label: "Object (inside)", type: "geometry" },
  ],
  outputs: COUNT_OUTPUTS,
  defaultParams: {
    ...OUTPUT_DEFAULTS,
    mode: "box",
    space: "world",
    expression: "",
    center: new THREE.Vector3(0, 0, 0),
    size: new THREE.Vector3(1, 1, 1),
    radius: 0.5,
    direction: new THREE.Vector3(0, 1, 0),
    angle: 30,
    fraction: 0.5,
    seed: 1,
    axis: "y",
    min: 0,
    max: 1,
    threshold: 0.5,
    noiseScale: 2,
  },
  paramFields: [
    { id: "mode", label: "Mode", kind: "select", options: [...SELECT_MODES], group: "Selection" },
    SPACE_FIELD,
    { id: "expression", label: "Expression (mode expression)", kind: "text", group: "Selection" },
    { id: "center", label: "Center / Plane Point", kind: "vector", step: 0.1, group: "Selection" },
    { id: "size", label: "Box Size", kind: "vector", step: 0.1, group: "Selection" },
    { id: "radius", label: "Sphere Radius", kind: "number", step: 0.05, group: "Selection" },
    { id: "direction", label: "Direction / Plane Normal", kind: "vector", step: 0.1, group: "Selection" },
    { id: "angle", label: "Normal Angle (°)", kind: "number", step: 1, group: "Selection" },
    { id: "axis", label: "Axis (axis-range)", kind: "select", options: ["x", "y", "z"], group: "Selection" },
    { id: "min", label: "Min (axis-range)", kind: "number", step: 0.1, group: "Selection" },
    { id: "max", label: "Max (axis-range)", kind: "number", step: 0.1, group: "Selection" },
    { id: "fraction", label: "Fraction (random)", kind: "number", step: 0.05, percent: true, group: "Selection" },
    { id: "seed", label: "Seed", kind: "number", step: 1, group: "Selection" },
    { id: "noiseScale", label: "Noise Scale", kind: "number", step: 0.1, group: "Selection" },
    { id: "threshold", label: "Noise Threshold", kind: "number", step: 0.05, group: "Selection" },
    ...OUTPUT_FIELDS,
  ],
  run: (run) => {
    const mesh = run.mesh;
    const domain = domainParam(run);
    const count = domainSize(mesh, domain);
    const mode = run.str("mode", "box");
    const fresh = new Uint8Array(count);
    const pos = () => toSpace(run, elementPositions(mesh, domain));

    switch (mode) {
      case "all":
        fresh.fill(1);
        break;
      case "expression": {
        const r = evaluateGroup(mesh, domain, run.str("expression", ""));
        if (r.error) run.note(`Expression: ${r.error}`, true);
        if (r.unknown.length) run.note(`Unknown: ${r.unknown.join(", ")}`, true);
        fresh.set(r.mask);
        break;
      }
      case "random":
        fresh.set(randomMask(count, Math.max(0, Math.min(1, run.num("fraction", 0.5))), run.num("seed", 1)));
        break;
      case "box": {
        const c = run.vec("center", [0, 0, 0]);
        const s = run.vec("size", [1, 1, 1]);
        const p = pos();
        for (let i = 0; i < count; i++) {
          fresh[i] =
            Math.abs(p[i * 3] - c.x) <= Math.abs(s.x) / 2 && Math.abs(p[i * 3 + 1] - c.y) <= Math.abs(s.y) / 2 && Math.abs(p[i * 3 + 2] - c.z) <= Math.abs(s.z) / 2
              ? 1
              : 0;
        }
        break;
      }
      case "sphere": {
        const c = run.vec("center", [0, 0, 0]);
        const r = Math.abs(run.num("radius", 0.5));
        const p = pos();
        for (let i = 0; i < count; i++) fresh[i] = Math.hypot(p[i * 3] - c.x, p[i * 3 + 1] - c.y, p[i * 3 + 2] - c.z) <= r ? 1 : 0;
        break;
      }
      case "plane": {
        const c = run.vec("center", [0, 0, 0]);
        const n = run.vec("direction", [0, 1, 0]).normalize();
        const p = pos();
        for (let i = 0; i < count; i++) fresh[i] = (p[i * 3] - c.x) * n.x + (p[i * 3 + 1] - c.y) * n.y + (p[i * 3 + 2] - c.z) * n.z >= 0 ? 1 : 0;
        break;
      }
      case "axis-range": {
        const k = ["x", "y", "z"].indexOf(run.str("axis", "y"));
        const lo = Math.min(run.num("min", 0), run.num("max", 1));
        const hi = Math.max(run.num("min", 0), run.num("max", 1));
        const p = pos();
        for (let i = 0; i < count; i++) fresh[i] = p[i * 3 + Math.max(0, k)] >= lo && p[i * 3 + Math.max(0, k)] <= hi ? 1 : 0;
        break;
      }
      case "normal": {
        const d = run.vec("direction", [0, 1, 0]).normalize();
        const cos = Math.cos((Math.max(0, Math.min(180, run.num("angle", 30))) * Math.PI) / 180) - 1e-9;
        const n = normalsToSpace(run, elementNormals(mesh, domain));
        for (let i = 0; i < count; i++) fresh[i] = n[i * 3] * d.x + n[i * 3 + 1] * d.y + n[i * 3 + 2] * d.z >= cos ? 1 : 0;
        break;
      }
      case "inside-object": {
        const other = run.otherMesh("object");
        if (!other) {
          run.note("Wire a closed mesh into Object", true);
          break;
        }
        const inside = makeInsideTest(other);
        const p = elementPositions(mesh, domain); // otherMesh() is already in this mesh's local space
        for (let i = 0; i < count; i++) fresh[i] = inside(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) ? 1 : 0;
        break;
      }
      case "noise": {
        const scale = run.num("noiseScale", 2);
        const t = run.num("threshold", 0.5);
        const seed = run.num("seed", 1);
        const p = pos();
        for (let i = 0; i < count; i++) {
          fresh[i] = valueNoise3(p[i * 3] * scale + seed * 13.7, p[i * 3 + 1] * scale + seed * 3.1, p[i * 3 + 2] * scale, 3) >= t ? 1 : 0;
        }
        break;
      }
      default:
        run.note(`Unknown mode "${mode}"`, true);
    }
    return writeSelection(run, mesh, domain, fresh);
  },
});

// ============================================================ Select Topology

export const TOPOLOGY_MODES = ["boundary", "non-manifold", "sharp", "valence", "sides", "piece", "largest-piece", "flat-region", "seam", "loose"] as const;
const COMPARE_OPS = ["==", "!=", "<", "<=", ">", ">="] as const;

function cmp(v: number, op: string, x: number): boolean {
  switch (op) {
    case "==":
      return v === x;
    case "!=":
      return v !== x;
    case "<":
      return v < x;
    case "<=":
      return v <= x;
    case ">":
      return v > x;
    default:
      return v >= x;
  }
}

export const SELECT_TOPOLOGY_NODE = definePolyNode({
  type: "select/topology",
  label: "Select Topology",
  category: "selection",
  inputs: [
    { id: "value", label: "Value", type: "value" },
    { id: "angle", label: "Angle", type: "value" },
  ],
  outputs: COUNT_OUTPUTS,
  defaultParams: { ...OUTPUT_DEFAULTS, domain: "edge", mode: "boundary", op: "==", value: 4, angle: 30, seeds: "" },
  paramFields: [
    { id: "mode", label: "Mode", kind: "select", options: [...TOPOLOGY_MODES], group: "Selection" },
    { id: "op", label: "Compare (valence / sides / piece)", kind: "select", options: [...COMPARE_OPS], group: "Selection" },
    { id: "value", label: "Value", kind: "number", step: 1, group: "Selection" },
    { id: "angle", label: "Angle (sharp / flat-region, °)", kind: "number", step: 1, group: "Selection" },
    { id: "seeds", label: "Seed Group (flat-region)", kind: "text", group: "Selection" },
    ...OUTPUT_FIELDS,
  ],
  run: (run) => {
    const mesh = run.mesh;
    const domain = domainParam(run, "edge");
    const mode = run.str("mode", "boundary");
    const op = run.str("op", "==");
    const value = run.num("value", 4);
    const angle = run.num("angle", 30);
    // Each mode is computed on its natural domain and promoted.
    let natural: AttrDomain = "edge";
    let mask: Uint8Array;
    switch (mode) {
      case "boundary": {
        // Points/edges on an open border; faces touching one.
        const b = readAttribute(mesh, "edge", "boundary")!;
        mask = Uint8Array.from(b.values, (v) => (v ? 1 : 0));
        if (domain === "face") {
          const pts = promoteMask(mesh, "edge", "point", mask, "any");
          mask = promoteMask(mesh, "point", "face", pts, "any");
          natural = "face";
        }
        break;
      }
      case "non-manifold":
        mask = nonManifoldEdgeMask(mesh);
        break;
      case "sharp": {
        const a = readAttribute(mesh, "edge", "angle")!;
        mask = Uint8Array.from(a.values, (v) => (v >= angle ? 1 : 0));
        break;
      }
      case "seam": {
        const a = readAttribute(mesh, "edge", "seam")!;
        mask = Uint8Array.from(a.values, (v) => (v ? 1 : 0));
        break;
      }
      case "valence": {
        natural = "point";
        mask = Uint8Array.from(pointValence(mesh), (v) => (cmp(v, op, value) ? 1 : 0));
        break;
      }
      case "loose": {
        natural = "point";
        const used = new Uint8Array(mesh.positions.length);
        for (const f of mesh.faces) for (const v of f) used[v] = 1;
        mask = Uint8Array.from(used, (u) => (u ? 0 : 1));
        break;
      }
      case "sides": {
        natural = "face";
        mask = Uint8Array.from(mesh.faces, (f) => (cmp(f.length, op, value) ? 1 : 0));
        break;
      }
      case "piece": {
        natural = "face";
        mask = Uint8Array.from(facePieces(mesh), (p) => (cmp(p, op, value) ? 1 : 0));
        break;
      }
      case "largest-piece": {
        natural = "face";
        const pieces = facePieces(mesh);
        const area = readAttribute(mesh, "face", "area")!.values;
        const total = new Map<number, number>();
        pieces.forEach((p, f) => total.set(p, (total.get(p) ?? 0) + area[f]));
        let best = -1, bestA = -1;
        for (const [p, a] of total) if (a > bestA) (bestA = a), (best = p);
        mask = Uint8Array.from(pieces, (p) => (p === best ? 1 : 0));
        break;
      }
      case "flat-region": {
        natural = "face";
        const seedsExpr = run.str("seeds", "");
        if (!seedsExpr.trim()) run.note("Name a face group in Seed Group to grow from", true);
        const seeds = maskIndices(evaluateGroup(mesh, "face", seedsExpr.trim() ? seedsExpr : "!*").mask);
        mask = new Uint8Array(mesh.faces.length);
        for (const f of flatFaces(mesh, seeds, angle)) mask[f] = 1;
        break;
      }
      default:
        run.note(`Unknown mode "${mode}"`, true);
        mask = new Uint8Array(domainSize(mesh, natural));
    }
    const fresh = natural === domain ? mask : promoteMask(mesh, natural, domain, mask, natural === "edge" && domain === "point" ? "any" : undefined);
    return writeSelection(run, mesh, domain, fresh);
  },
});

// ============================================================ Select Measure

export const MEASURES = ["area", "perimeter", "edge-length", "height", "curvature", "thickness"] as const;

export const SELECT_MEASURE_NODE = definePolyNode({
  type: "select/measure",
  label: "Select Measure",
  category: "selection",
  dependsOnPose: true,
  inputs: [
    { id: "min", label: "Min", type: "value" },
    { id: "max", label: "Max", type: "value" },
  ],
  outputs: [...COUNT_OUTPUTS, { id: "values", label: "Measured (list)", type: "list" }],
  defaultParams: { ...OUTPUT_DEFAULTS, measure: "area", relative: true, min: 0.5, max: 1, axis: "y", writeMeasure: false },
  paramFields: [
    { id: "measure", label: "Measure", kind: "select", options: [...MEASURES], group: "Selection" },
    { id: "relative", label: "Relative (0 = smallest, 1 = largest)", kind: "boolean", group: "Selection" },
    { id: "min", label: "Min", kind: "number", step: 0.05, group: "Selection" },
    { id: "max", label: "Max", kind: "number", step: 0.05, group: "Selection" },
    { id: "axis", label: "Axis (height)", kind: "select", options: ["x", "y", "z"], group: "Selection" },
    { id: "writeMeasure", label: "Also write the measure as an attribute", kind: "boolean", group: "Output" },
    ...OUTPUT_FIELDS,
  ],
  run: (run) => {
    const mesh = run.mesh;
    const domain = domainParam(run);
    const measure = run.str("measure", "area");
    const values = measureValues(mesh, domain, measure, run);
    let lo = Math.min(run.num("min", 0.5), run.num("max", 1));
    let hi = Math.max(run.num("min", 0.5), run.num("max", 1));
    if (run.bool("relative", true)) {
      let vmin = Infinity, vmax = -Infinity;
      for (const v of values) if (Number.isFinite(v)) (vmin = Math.min(vmin, v)), (vmax = Math.max(vmax, v));
      const span = vmax - vmin || 1;
      lo = vmin + lo * span;
      hi = vmin + hi * span;
    }
    const fresh = Uint8Array.from(values, (v) => (v >= lo - 1e-9 && v <= hi + 1e-9 ? 1 : 0));
    const result = writeSelection(run, mesh, domain, fresh, run.bool("writeMeasure", false) ? { weights: values, weightName: measure.replace("-", "_") } : undefined);
    return { mesh: result.mesh, outputs: { ...result.outputs, values: Array.from(values) } };
  },
});

/** One number per element of `domain`: the chosen measure. */
export function measureValues(mesh: PolyMesh, domain: AttrDomain, measure: string, run?: PolyRunContext): Float64Array {
  const n = domainSize(mesh, domain);
  const fromFaces = (faceValues: ArrayLike<number>) =>
    domain === "face" ? Float64Array.from(faceValues) : promoteValuesLocal(mesh, "face", domain, faceValues);
  switch (measure) {
    case "area":
      return fromFaces(readAttribute(mesh, "face", "area")!.values);
    case "perimeter":
      return fromFaces(
        mesh.faces.map((f) => {
          let s = 0;
          for (let i = 0; i < f.length; i++) {
            const a = mesh.positions[f[i]], b = mesh.positions[f[(i + 1) % f.length]];
            s += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
          }
          return s;
        }),
      );
    case "edge-length": {
      const len = readAttribute(mesh, "edge", "length")!.values;
      return domain === "edge" ? Float64Array.from(len) : promoteValuesLocal(mesh, "edge", domain, len);
    }
    case "height": {
      const k = Math.max(0, ["x", "y", "z"].indexOf(run?.str("axis", "y") ?? "y"));
      const p = run ? toSpace(run, elementPositions(mesh, domain)) : elementPositions(mesh, domain);
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = p[i * 3 + k];
      return out;
    }
    case "curvature": {
      // Mean dihedral angle (signed: convex +, concave -) of the edges around each element.
      const angle = readAttribute(mesh, "edge", "angle")!.values;
      const signed = signedEdgeAngles(mesh, angle);
      return domain === "edge" ? signed : promoteValuesLocal(mesh, "edge", domain, signed);
    }
    case "thickness": {
      // Distance to the surface along the inverted normal (ray against own triangles).
      const p = elementPositions(mesh, domain);
      const nrm = elementNormals(mesh, domain);
      const out = new Float64Array(n);
      const tris = trianglesOf(mesh);
      for (let i = 0; i < n; i++) {
        out[i] = rayDistance(tris, [p[i * 3] - nrm[i * 3] * 1e-4, p[i * 3 + 1] - nrm[i * 3 + 1] * 1e-4, p[i * 3 + 2] - nrm[i * 3 + 2] * 1e-4], [-nrm[i * 3], -nrm[i * 3 + 1], -nrm[i * 3 + 2]]);
        if (!Number.isFinite(out[i])) out[i] = 0;
      }
      return out;
    }
    default:
      return new Float64Array(n);
  }
}

function promoteValuesLocal(mesh: PolyMesh, from: AttrDomain, to: AttrDomain, values: ArrayLike<number>): Float64Array {
  return promoteValues(mesh, from, to, values, 1);
}

function signedEdgeAngles(mesh: PolyMesh, angle: ArrayLike<number>): Float64Array {
  const topo = getTopology(mesh);
  const edges = domainEdges(mesh);
  const fp = readAttribute(mesh, "face", "P")!.values;
  const fn = readAttribute(mesh, "face", "N")!.values;
  return Float64Array.from(edges, ([a, b], i) => {
    const faces = topo.edgeFaces(a, b);
    if (faces.length !== 2) return 0;
    const [f, g] = faces;
    // convex when g's centroid is behind f's plane
    const d = (fp[g * 3] - fp[f * 3]) * fn[f * 3] + (fp[g * 3 + 1] - fp[f * 3 + 1]) * fn[f * 3 + 1] + (fp[g * 3 + 2] - fp[f * 3 + 2]) * fn[f * 3 + 2];
    return d <= 0 ? angle[i] : -angle[i];
  });
}

function trianglesOf(mesh: PolyMesh): Float64Array {
  return meshTriangles(mesh).coords;
}

/** Nearest hit distance of a ray against triangles (Möller–Trumbore), Infinity if none. */
export function rayDistance(tris: Float64Array, o: readonly number[], d: readonly number[]): number {
  let best = Infinity;
  for (let t = 0; t < tris.length; t += 9) {
    const e1x = tris[t + 3] - tris[t], e1y = tris[t + 4] - tris[t + 1], e1z = tris[t + 5] - tris[t + 2];
    const e2x = tris[t + 6] - tris[t], e2y = tris[t + 7] - tris[t + 1], e2z = tris[t + 8] - tris[t + 2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const sx = o[0] - tris[t], sy = o[1] - tris[t + 1], sz = o[2] - tris[t + 2];
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (dist > 1e-6 && dist < best) best = dist;
  }
  return best;
}

// ============================================================ Select Distance (soft)

export const DISTANCE_TARGETS = ["point", "object", "group"] as const;
export const FALLOFFS = ["smooth", "sphere", "root", "linear", "sharp", "constant"] as const;

export const SELECT_DISTANCE_NODE = definePolyNode({
  type: "select/distance",
  label: "Select Distance",
  category: "selection",
  dependsOnPose: true,
  inputs: [
    { id: "center", label: "Point", type: "vector" },
    { id: "object", label: "Object", type: "geometry" },
    { id: "radius", label: "Radius", type: "value" },
  ],
  outputs: [...COUNT_OUTPUTS, { id: "weights", label: "Weights (list)", type: "list" }],
  defaultParams: {
    ...OUTPUT_DEFAULTS,
    domain: "point",
    target: "point",
    metric: "euclidean",
    center: new THREE.Vector3(0, 0, 0),
    radius: 1,
    falloff: "smooth",
    threshold: 0.001,
    seeds: "",
    weightName: "weight",
    space: "world",
  },
  paramFields: [
    { id: "target", label: "Distance To", kind: "select", options: [...DISTANCE_TARGETS], group: "Selection" },
    { id: "metric", label: "Metric", kind: "select", options: ["euclidean", "surface"], optionLabels: ["Straight line", "Along the surface"], group: "Selection" },
    SPACE_FIELD,
    { id: "center", label: "Point", kind: "vector", step: 0.1, group: "Selection" },
    { id: "seeds", label: "Group (target group)", kind: "text", group: "Selection" },
    { id: "radius", label: "Radius", kind: "number", step: 0.05, group: "Selection" },
    { id: "falloff", label: "Falloff", kind: "select", options: [...FALLOFFS], group: "Selection" },
    { id: "threshold", label: "In group when weight >", kind: "number", step: 0.05, group: "Selection" },
    { id: "weightName", label: "Weight Attribute", kind: "text", group: "Output" },
    ...OUTPUT_FIELDS,
  ],
  run: (run) => {
    const mesh = run.mesh;
    const domain = domainParam(run, "point");
    const n = domainSize(mesh, domain);
    const radius = Math.max(1e-9, Math.abs(run.num("radius", 1)));
    const target = run.str("target", "point");
    const metric = run.str("metric", "euclidean");
    const dist = new Float64Array(n).fill(Infinity);

    if (metric === "surface") {
      // Seeds = the points nearest the target, then Dijkstra along edges.
      let seeds: number[] = [];
      if (target === "group") {
        seeds = maskIndices(evaluateGroup(mesh, "point", run.str("seeds", "") || "!*").mask);
      } else {
        const pts = elementPositions(mesh, "point");
        let goal: number[] | null = null;
        if (target === "object") {
          const other = run.otherMesh("object");
          if (other) {
            const closest = makeClosestPoint(other);
            let best = Infinity;
            for (let i = 0; i < mesh.positions.length; i++) {
              const r = closest(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
              if (r && r.distance < best) (best = r.distance), (goal = [i]);
            }
          }
        } else {
          const c = localPoint(run, run.vec("center", [0, 0, 0]));
          let best = Infinity;
          for (let i = 0; i < mesh.positions.length; i++) {
            const d = Math.hypot(pts[i * 3] - c.x, pts[i * 3 + 1] - c.y, pts[i * 3 + 2] - c.z);
            if (d < best) (best = d), (goal = [i]);
          }
        }
        seeds = goal ?? [];
      }
      const pd = edgeDistances(mesh, seeds, radius * 1.0001).dist;
      const onDomain = domain === "point" ? pd : minOverDomain(mesh, domain, pd);
      dist.set(onDomain);
    } else {
      const p = elementPositions(mesh, domain);
      if (target === "object") {
        const other = run.otherMesh("object");
        if (!other) run.note("Wire a mesh into Object", true);
        else {
          const closest = makeClosestPoint(other);
          for (let i = 0; i < n; i++) dist[i] = closest(p[i * 3], p[i * 3 + 1], p[i * 3 + 2])?.distance ?? Infinity;
        }
      } else if (target === "group") {
        const seeds = maskIndices(evaluateGroup(mesh, "point", run.str("seeds", "") || "!*").mask);
        const sp = elementPositions(mesh, "point");
        for (let i = 0; i < n; i++) {
          for (const s of seeds) {
            const d = Math.hypot(p[i * 3] - sp[s * 3], p[i * 3 + 1] - sp[s * 3 + 1], p[i * 3 + 2] - sp[s * 3 + 2]);
            if (d < dist[i]) dist[i] = d;
          }
        }
      } else {
        const c = localPoint(run, run.vec("center", [0, 0, 0]));
        for (let i = 0; i < n; i++) dist[i] = Math.hypot(p[i * 3] - c.x, p[i * 3 + 1] - c.y, p[i * 3 + 2] - c.z);
      }
    }

    const falloff = run.str("falloff", "smooth") as ProportionalFalloff;
    const weights = Float64Array.from(dist, (d) => (d > radius ? 0 : proportionalWeight(d / radius, falloff)));
    const threshold = run.num("threshold", 0.001);
    const fresh = Uint8Array.from(weights, (w) => (w > threshold ? 1 : 0));
    const result = writeSelection(run, mesh, domain, fresh, { weights, weightName: run.str("weightName", "weight").trim() });
    return { mesh: result.mesh, outputs: { ...result.outputs, weights: Array.from(weights) } };
  },
});

/** A world-space point brought into the mesh's local space when Space is world. */
function localPoint(run: PolyRunContext, p: THREE.Vector3): THREE.Vector3 {
  if (run.str("space", "world") !== "world") return p;
  return p.clone().applyMatrix4(run.worldMatrix.clone().invert());
}

function minOverDomain(mesh: PolyMesh, domain: AttrDomain, pointValues: Float64Array): Float64Array {
  if (domain === "face") return Float64Array.from(mesh.faces, (f) => Math.min(...f.map((v) => pointValues[v])));
  if (domain === "edge") return Float64Array.from(domainEdges(mesh), ([a, b]) => Math.min(pointValues[a], pointValues[b]));
  const out: number[] = [];
  for (const f of mesh.faces) for (const v of f) out.push(pointValues[v]);
  return Float64Array.from(out);
}

// ============================================================ Group Combine

export const GROUP_COMBINE_NODE = definePolyNode({
  type: "group/combine",
  label: "Group Combine",
  category: "selection",
  outputs: COUNT_OUTPUTS,
  defaultParams: { ...OUTPUT_DEFAULTS, expression: "a & !b" },
  paramFields: [{ id: "expression", label: "Expression", kind: "text", group: "Selection" }, ...OUTPUT_FIELDS],
  run: (run) => {
    const domain = domainParam(run);
    const r = evaluateGroup(run.mesh, domain, run.str("expression", ""));
    if (r.error) run.note(`Expression: ${r.error}`, true);
    if (r.unknown.length) run.note(`Unknown: ${r.unknown.join(", ")}`, true);
    return writeSelection(run, run.mesh, domain, r.mask);
  },
});

// ============================================================ Group Expand

export const EXPAND_MODES = ["grow", "shrink", "linked", "promote", "border"] as const;

export const GROUP_EXPAND_NODE = definePolyNode({
  type: "group/expand",
  label: "Group Expand",
  category: "selection",
  inputs: [{ id: "steps", label: "Steps", type: "value" }],
  outputs: COUNT_OUTPUTS,
  defaultParams: { ...OUTPUT_DEFAULTS, source: "selected", sourceDomain: "face", mode: "grow", steps: 1, rule: "auto" },
  paramFields: [
    { id: "source", label: "Source Group", kind: "text", group: "Selection" },
    { id: "sourceDomain", label: "Source Domain", kind: "select", options: [...ATTR_DOMAINS], group: "Selection" },
    { id: "mode", label: "Mode", kind: "select", options: [...EXPAND_MODES], group: "Selection" },
    { id: "steps", label: "Steps (grow / shrink)", kind: "number", step: 1, group: "Selection" },
    { id: "rule", label: "Promote Rule", kind: "select", options: ["auto", "any", "all"], group: "Selection" },
    ...OUTPUT_FIELDS,
  ],
  run: (run) => {
    const mesh = run.mesh;
    const from = (ATTR_DOMAINS as readonly string[]).includes(run.str("sourceDomain", "face")) ? (run.str("sourceDomain", "face") as AttrDomain) : "face";
    const to = domainParam(run, from);
    const mode = run.str("mode", "grow");
    const src = evaluateGroup(mesh, from, run.str("source", "selected"));
    if (src.error) run.note(`Source: ${src.error}`, true);
    if (src.unknown.length) run.note(`Unknown: ${src.unknown.join(", ")}`, true);
    const ruleParam = run.str("rule", "auto");
    const rule: PromoteRule | undefined = ruleParam === "any" || ruleParam === "all" ? ruleParam : undefined;
    // Work in the corner-free domain set Edit Mesh's tools understand.
    const workDomain: AttrDomain = from === "corner" ? "face" : from;
    let mask = from === "corner" ? promoteMask(mesh, "corner", "face", src.mask) : src.mask;
    if (mode === "grow" || mode === "shrink") {
      const steps = Math.max(0, Math.min(1000, Math.round(run.num("steps", 1))));
      let sel = maskToSelection(mesh, workDomain, mask);
      for (let i = 0; i < steps; i++) sel = mode === "grow" ? growSelection(mesh, modeOf(workDomain), sel) : shrinkSelection(mesh, modeOf(workDomain), sel);
      mask = selectionToMask(mesh, workDomain, sel);
    } else if (mode === "linked") {
      mask = selectionToMask(mesh, workDomain, linkedSelection(mesh, modeOf(workDomain), maskToSelection(mesh, workDomain, mask)));
    } else if (mode === "border") {
      // The edges (or points) where the region meets the rest: edges with exactly one selected face side.
      const faceMask = workDomain === "face" ? mask : promoteMask(mesh, workDomain, "face", mask);
      const topo = getTopology(mesh);
      const edgeMask = Uint8Array.from(domainEdges(mesh), ([a, b]) => {
        const faces = topo.edgeFaces(a, b);
        const inside = faces.filter((f) => faceMask[f]).length;
        return inside > 0 && inside < faces.length ? 1 : faces.length === 1 && inside === 1 ? 1 : 0;
      });
      const fresh = to === "edge" ? edgeMask : promoteMask(mesh, "edge", to, edgeMask, "any");
      return writeSelection(run, mesh, to, fresh);
    }
    const fresh = workDomain === to ? mask : promoteMask(mesh, workDomain, to, mask, rule);
    return writeSelection(run, mesh, to, fresh);
  },
});

// ============================================================ Group Path

export const PATH_MODES = ["shortest-path", "edge-loop", "edge-ring", "boundary-loop"] as const;

export const GROUP_PATH_NODE = definePolyNode({
  type: "group/path",
  label: "Group Path",
  category: "selection",
  outputs: [...COUNT_OUTPUTS, { id: "points", label: "Path Points (list)", type: "list" }],
  defaultParams: { ...OUTPUT_DEFAULTS, domain: "edge", mode: "shortest-path", start: "start", end: "end", seeds: "selected" },
  paramFields: [
    { id: "mode", label: "Mode", kind: "select", options: [...PATH_MODES], group: "Selection" },
    { id: "start", label: "Start Point Group (shortest-path)", kind: "text", group: "Selection" },
    { id: "end", label: "End Point Group (shortest-path)", kind: "text", group: "Selection" },
    { id: "seeds", label: "Seed Edge Group (loops / rings)", kind: "text", group: "Selection" },
    ...OUTPUT_FIELDS,
  ],
  run: (run) => {
    const mesh = run.mesh;
    const domain = domainParam(run, "edge");
    const mode = run.str("mode", "shortest-path");
    let edgeMask: Uint8Array;
    let pathPoints: number[] = [];
    if (mode === "shortest-path") {
      const a = evaluateGroup(mesh, "point", run.str("start", "start"));
      const b = evaluateGroup(mesh, "point", run.str("end", "end"));
      for (const r of [a, b]) if (r.unknown.length) run.note(`Unknown: ${r.unknown.join(", ")}`, true);
      pathPoints = shortestPath(mesh, maskIndices(a.mask), maskIndices(b.mask));
      if (pathPoints.length === 0) run.note("No path between the two groups", true);
      edgeMask = pathEdgeMask(mesh, [pathPoints]);
    } else if (mode === "boundary-loop") {
      const b = readAttribute(mesh, "edge", "boundary")!;
      const seeds = evaluateGroup(mesh, "edge", run.str("seeds", ""));
      edgeMask = Uint8Array.from(b.values, (v, i) => (v && seeds.mask[i] ? 1 : 0));
      // grow along connected boundary edges
      const edges = domainEdges(mesh);
      const touch = new Uint8Array(mesh.positions.length);
      let changed = true;
      while (changed) {
        changed = false;
        edges.forEach(([u, v], i) => {
          if (edgeMask[i]) (touch[u] = 1), (touch[v] = 1);
        });
        edges.forEach(([u, v], i) => {
          if (!edgeMask[i] && b.values[i] && (touch[u] || touch[v])) (edgeMask[i] = 1), (changed = true);
        });
      }
    } else {
      const seeds = evaluateGroup(mesh, "edge", run.str("seeds", "selected"));
      if (seeds.unknown.length) run.note(`Unknown: ${seeds.unknown.join(", ")}`, true);
      const edges = domainEdges(mesh);
      const index = new Map(edges.map(([a, b], i) => [`${a}_${b}`, i]));
      edgeMask = new Uint8Array(edges.length);
      for (const e of maskIndices(seeds.mask)) {
        const [a, b] = edges[e];
        const walk = mode === "edge-loop" ? edgeLoop(mesh, a, b) : edgeRing(mesh, a, b);
        for (const [u, v] of walk) {
          const i = index.get(u < v ? `${u}_${v}` : `${v}_${u}`);
          if (i !== undefined) edgeMask[i] = 1;
        }
      }
    }
    const fresh = domain === "edge" ? edgeMask : promoteMask(mesh, "edge", domain, edgeMask, domain === "point" ? "any" : "all");
    const result = writeSelection(run, mesh, domain, fresh);
    return { mesh: result.mesh, outputs: { ...result.outputs, points: pathPoints } };
  },
});

export const SELECT_NODES = [
  SELECT_NODE,
  SELECT_TOPOLOGY_NODE,
  SELECT_MEASURE_NODE,
  SELECT_DISTANCE_NODE,
  GROUP_COMBINE_NODE,
  GROUP_EXPAND_NODE,
  GROUP_PATH_NODE,
];
