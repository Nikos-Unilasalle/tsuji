import * as THREE from "three";
import type { NodeDefinition, ParamFieldDef } from "../types";
import type { PolyMesh } from "../quadMesh";
import {
  ATTR_DOMAINS,
  domainEdges,
  domainSize,
  readAttribute,
  setAttribute,
  setGroup,
  isValidAttributeName,
  type AttrDomain,
} from "../mesh/polyAttributes";
import { promoteMask, promoteValues } from "../mesh/promote";
import { withAttributes } from "../mesh/propagate";
import { elementPositions, hash01 } from "../mesh/selectOps";
import { valueNoise3 } from "../../math/valueNoise";
import {
  appendMesh,
  boundingBox,
  boxToMesh,
  decimateMesh,
  divideFaces,
  dualMesh,
  hullMesh,
  permuteFaces,
  permutePoints,
  pokeFaces,
  scaleElements,
  smoothPositions,
  subsetMesh,
  type DivideMode,
  type SmoothWeighting,
  type V3,
} from "../mesh/modelingAlgos";
import { definePolyNode, type PolyRunContext } from "./polyModifier";

/*
 * Phase 5 of docs/parametric-modeling-plan.md — the modelling operations
 * that are new algorithms rather than wrappers of the Edit Mesh kernel:
 * smoothing, displacement, element transforms, dual / poke / divide
 * tessellations, convex hull, bounding boxes, decimation, sorting, Keep
 * Group and edge marks. The geometry lives in mesh/modelingAlgos.ts.
 *
 * Every node takes the standard Group field and leaves everything outside
 * it alone. Deformers also read an optional Weight Attribute — a float point
 * attribute such as the `weight` Select Distance writes — that scales their
 * effect per point, so a soft selection drives a soft deformation.
 *
 * Topology-changing nodes go through withAttributes() with the explicit
 * point/face provenance the kernel reports, so groups and attributes
 * survive exactly.
 */

const CATEGORY = "modeling" as const;

function domainParam(run: PolyRunContext, fallback: AttrDomain): AttrDomain {
  const d = run.str("domain", fallback);
  return (ATTR_DOMAINS as readonly string[]).includes(d) ? (d as AttrDomain) : fallback;
}

/** The Group (on the chosen domain) as a 0/1 mask on points. */
function pointMask(run: PolyRunContext, mesh: PolyMesh, fallback: AttrDomain = "point"): Uint8Array {
  const domain = domainParam(run, fallback);
  const { mask } = run.group(domain);
  return domain === "point" ? mask : promoteMask(mesh, domain, "point", mask);
}

/** A float point attribute by name (promoted from another domain if that's where it lives), or null. */
function pointValues(mesh: PolyMesh, name: string): { values: Float64Array; size: number } | null {
  const own = readAttribute(mesh, "point", name);
  if (own) return { values: own.values, size: own.size };
  for (const d of ["face", "edge", "corner"] as const) {
    const other = readAttribute(mesh, d, name);
    if (other) return { values: promoteValues(mesh, d, "point", other.values, other.size), size: other.size };
  }
  return null;
}

/**
 * Per-point influence 0..1: the group mask times the Weight Attribute when
 * one is named. A missing attribute is reported and ignored (influence = the
 * group) rather than zeroing the effect: a typo shouldn't look like a no-op.
 */
function pointInfluence(run: PolyRunContext, mesh: PolyMesh, fallback: AttrDomain = "point"): Float64Array {
  const mask = pointMask(run, mesh, fallback);
  const out = new Float64Array(mesh.positions.length);
  for (let i = 0; i < out.length; i++) out[i] = mask[i] ? 1 : 0;
  const name = run.str("weightAttr", "").trim();
  if (!name) return out;
  const attr = pointValues(mesh, name);
  if (!attr) {
    run.note(`Weight: no attribute "${name}" — using the group alone`, true);
    return out;
  }
  for (let i = 0; i < out.length; i++) {
    const v = attr.values[i * attr.size];
    out[i] *= Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
  }
  return out;
}

const WEIGHT_FIELD: ParamFieldDef = { id: "weightAttr", label: "Weight Attribute (point float)", kind: "text", group: "Group" };

function faceMaskIndices(run: PolyRunContext): number[] {
  return run.group("face").indices;
}

const moved = (mesh: PolyMesh, positions: V3[]): PolyMesh => ({ ...mesh, positions });

// ============================================================ Smooth / Relax

export const SMOOTH_WEIGHTINGS: SmoothWeighting[] = ["uniform", "edge-length", "cotangent"];

export const SMOOTH_NODE = definePolyNode({
  type: "modeling/smooth",
  label: "Smooth / Relax",
  category: CATEGORY,
  group: { domain: "choose", defaultDomain: "point" },
  inputs: [{ id: "strength", label: "Strength", type: "value" }],
  defaultParams: { domain: "point", weightAttr: "", iterations: 10, strength: 0.5, weighting: "uniform", preserveVolume: false, pinBoundary: true },
  paramFields: [
    WEIGHT_FIELD,
    { id: "iterations", label: "Iterations", kind: "number", step: 1, group: "Smooth" },
    { id: "strength", label: "Strength", kind: "number", step: 0.05, group: "Smooth" },
    { id: "weighting", label: "Weighting", kind: "select", options: SMOOTH_WEIGHTINGS, group: "Smooth" },
    { id: "preserveVolume", label: "Preserve Volume (Taubin)", kind: "boolean", group: "Smooth" },
    { id: "pinBoundary", label: "Pin Boundary", kind: "boolean", group: "Smooth" },
  ],
  run: (run) => {
    const mesh = run.mesh;
    const weighting = run.str("weighting", "uniform") as SmoothWeighting;
    const positions = smoothPositions(mesh, {
      iterations: run.num("iterations", 10),
      strength: run.num("strength", 0.5),
      weighting: SMOOTH_WEIGHTINGS.includes(weighting) ? weighting : "uniform",
      preserveVolume: run.bool("preserveVolume", false),
      pinBoundary: run.bool("pinBoundary", true),
      weights: pointInfluence(run, mesh),
    });
    return moved(mesh, positions);
  },
});

// ============================================================ Displace

export const DISPLACE_SOURCES = ["constant", "attribute", "noise"] as const;
export const DISPLACE_DIRECTIONS = ["normal", "vector"] as const;

export const DISPLACE_NODE = definePolyNode({
  type: "modeling/displace",
  label: "Displace",
  category: CATEGORY,
  group: { domain: "choose", defaultDomain: "point" },
  inputs: [
    { id: "amount", label: "Amount", type: "value" },
    { id: "vector", label: "Vector", type: "vector" },
  ],
  defaultParams: {
    domain: "point",
    weightAttr: "",
    source: "constant",
    direction: "normal",
    amount: 0.1,
    vector: new THREE.Vector3(0, 1, 0),
    attribute: "",
    scale: 2,
    seed: 0,
    octaves: 3,
  },
  paramFields: [
    WEIGHT_FIELD,
    { id: "source", label: "Source", kind: "select", options: [...DISPLACE_SOURCES], group: "Displace" },
    { id: "direction", label: "Direction", kind: "select", options: [...DISPLACE_DIRECTIONS], group: "Displace" },
    { id: "amount", label: "Amount / Amplitude", kind: "number", step: 0.01, group: "Displace" },
    { id: "vector", label: "Vector", kind: "vector", step: 0.1, group: "Displace" },
    { id: "attribute", label: "Attribute (float, or vec3 = offset)", kind: "text", group: "Displace" },
    { id: "scale", label: "Noise Scale", kind: "number", step: 0.1, group: "Noise" },
    { id: "seed", label: "Noise Seed", kind: "number", step: 1, group: "Noise" },
    { id: "octaves", label: "Noise Octaves", kind: "number", step: 1, group: "Noise" },
  ],
  run: (run) => {
    const mesh = run.mesh;
    const influence = pointInfluence(run, mesh);
    const amount = run.num("amount", 0.1);
    const source = run.str("source", "constant");
    const alongVector = run.str("direction", "normal") === "vector";
    const vec = run.vec("vector", [0, 1, 0]);
    const vl = vec.length();
    const dir: V3 = vl > 1e-12 ? [vec.x / vl, vec.y / vl, vec.z / vl] : [0, 0, 0];
    const normals = readAttribute(mesh, "point", "N")!.values;

    let attr: { values: Float64Array; size: number } | null = null;
    if (source === "attribute") {
      const name = run.str("attribute", "").trim();
      attr = name ? pointValues(mesh, name) : null;
      if (!attr) {
        run.note(name ? `No attribute "${name}"` : "Name a point attribute to displace by", true);
        return mesh;
      }
    }
    const scale = run.num("scale", 2);
    const octaves = Math.max(1, Math.min(8, Math.round(run.num("octaves", 3))));
    const seed = run.num("seed", 0);
    const sx = seed * 17.317, sy = seed * 31.731, sz = seed * 7.123;

    const positions = mesh.positions.map((p, i): V3 => {
      const w = influence[i];
      if (!w) return [p[0], p[1], p[2]];
      let d: V3 = alongVector ? dir : [normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]];
      let magnitude = amount;
      if (attr) {
        if (attr.size === 3) {
          // A vector attribute is the offset itself, scaled by Amount.
          d = [attr.values[i * 3], attr.values[i * 3 + 1], attr.values[i * 3 + 2]];
        } else magnitude = amount * attr.values[i];
      } else if (source === "noise") {
        // valueNoise3 sits around 0.47; centre it so the surface moves both ways.
        const n = valueNoise3(p[0] * scale + sx, p[1] * scale + sy, p[2] * scale + sz, octaves);
        magnitude = amount * (n - 0.47) * 2;
      }
      const k = magnitude * w;
      const out: V3 = [p[0] + d[0] * k, p[1] + d[1] * k, p[2] + d[2] * k];
      return Number.isFinite(out[0] + out[1] + out[2]) ? out : [p[0], p[1], p[2]];
    });
    return moved(mesh, positions);
  },
});

// ============================================================ Transform Elements

export const TRANSFORM_PIVOTS = ["group-centroid", "piece", "face", "origin", "custom"] as const;

export const TRANSFORM_ELEMENTS_NODE = definePolyNode({
  type: "modeling/transform-elements",
  label: "Transform Elements",
  category: CATEGORY,
  group: { domain: "choose", defaultDomain: "face" },
  inputs: [
    { id: "translate", label: "Translate", type: "vector" },
    { id: "rotate", label: "Rotate", type: "vector" },
    { id: "scale", label: "Scale", type: "vector" },
    { id: "pivotPoint", label: "Pivot", type: "vector" },
  ],
  defaultParams: {
    domain: "face",
    weightAttr: "",
    translate: new THREE.Vector3(0, 0, 0),
    rotate: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    pivot: "group-centroid",
    pivotPoint: new THREE.Vector3(0, 0, 0),
  },
  paramFields: [
    WEIGHT_FIELD,
    { id: "translate", label: "Translate", kind: "vector", step: 0.1, group: "Transform" },
    { id: "rotate", label: "Rotate", kind: "vector", step: 1, degrees: true, group: "Transform" },
    { id: "scale", label: "Scale", kind: "vector", step: 0.1, group: "Transform" },
    { id: "pivot", label: "Pivot", kind: "select", options: [...TRANSFORM_PIVOTS], group: "Transform" },
    { id: "pivotPoint", label: "Custom Pivot", kind: "vector", step: 0.1, group: "Transform" },
  ],
  run: (run) => {
    const mesh = run.mesh;
    const domain = domainParam(run, "face");
    const influence = pointInfluence(run, mesh, "face");
    const n = mesh.positions.length;
    const t = run.vec("translate", [0, 0, 0]);
    const r = run.vec("rotate", [0, 0, 0]);
    const s = run.vec("scale", [1, 1, 1]);
    const rot = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(r.x, r.y, r.z));
    const pivotMode = run.str("pivot", "group-centroid");
    const v = new THREE.Vector3();
    const apply = (p: readonly number[], pivot: readonly number[]): V3 => {
      v.set(p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]).multiply(s).applyMatrix4(rot);
      return [v.x + pivot[0] + t.x, v.y + pivot[1] + t.y, v.z + pivot[2] + t.z];
    };

    const centroid = (points: Iterable<number>): V3 => {
      const c: V3 = [0, 0, 0];
      let k = 0;
      for (const i of points) {
        for (let a = 0; a < 3; a++) c[a] += mesh.positions[i][a];
        k++;
      }
      return k ? [c[0] / k, c[1] / k, c[2] / k] : c;
    };
    const inGroup: number[] = [];
    for (let i = 0; i < n; i++) if (influence[i] > 0) inGroup.push(i);
    const groupCentre = centroid(inGroup);

    // Each point's transformed position (before weighting).
    const target: (V3 | null)[] = new Array(n).fill(null);
    if (pivotMode === "face") {
      // Each selected face around its own centroid; a point shared by several takes the average.
      const faceMask = domain === "face" ? run.group("face").mask : promoteMask(mesh, "point", "face", pointMask(run, mesh, "face"));
      const acc = new Float64Array(n * 3);
      const cnt = new Float64Array(n);
      mesh.faces.forEach((face, f) => {
        if (!faceMask[f] || face.length === 0) return;
        const c = centroid(new Set(face));
        for (const i of new Set(face)) {
          const q = apply(mesh.positions[i], c);
          acc[i * 3] += q[0];
          acc[i * 3 + 1] += q[1];
          acc[i * 3 + 2] += q[2];
          cnt[i]++;
        }
      });
      for (const i of inGroup) target[i] = cnt[i] ? [acc[i * 3] / cnt[i], acc[i * 3 + 1] / cnt[i], acc[i * 3 + 2] / cnt[i]] : apply(mesh.positions[i], groupCentre);
    } else if (pivotMode === "piece") {
      // Pieces of the group: group points linked by an edge whose ends are both in the group.
      const parent = new Int32Array(n).map((_, i) => i);
      const find = (x: number): number => {
        while (parent[x] !== x) x = parent[x] = parent[parent[x]];
        return x;
      };
      for (const [a, b] of domainEdges(mesh)) {
        if (influence[a] > 0 && influence[b] > 0) {
          const ra = find(a), rb = find(b);
          if (ra !== rb) parent[ra] = rb;
        }
      }
      const pieces = new Map<number, number[]>();
      for (const i of inGroup) {
        const root = find(i);
        const list = pieces.get(root);
        if (list) list.push(i);
        else pieces.set(root, [i]);
      }
      for (const list of pieces.values()) {
        const c = centroid(list);
        for (const i of list) target[i] = apply(mesh.positions[i], c);
      }
      run.note(`${pieces.size} piece${pieces.size === 1 ? "" : "s"}`);
    } else {
      const pivot: V3 =
        pivotMode === "origin" ? [0, 0, 0] : pivotMode === "custom" ? (run.vec("pivotPoint", [0, 0, 0]).toArray() as V3) : groupCentre;
      for (const i of inGroup) target[i] = apply(mesh.positions[i], pivot);
    }

    const positions = mesh.positions.map((p, i): V3 => {
      const q = target[i];
      const w = influence[i];
      if (!q || !w) return [p[0], p[1], p[2]];
      const out: V3 = [p[0] + (q[0] - p[0]) * w, p[1] + (q[1] - p[1]) * w, p[2] + (q[2] - p[2]) * w];
      return Number.isFinite(out[0] + out[1] + out[2]) ? out : [p[0], p[1], p[2]];
    });
    return moved(mesh, positions);
  },
});

// ============================================================ Scale Elements

export const SCALE_ELEMENTS_NODE = definePolyNode({
  type: "modeling/scale-elements",
  label: "Scale Elements",
  category: CATEGORY,
  group: { domain: "face" },
  inputs: [{ id: "scale", label: "Scale", type: "value" }],
  defaultParams: { weightAttr: "", scale: 0.8, axes: new THREE.Vector3(1, 1, 1), mode: "face", disconnect: false },
  paramFields: [
    WEIGHT_FIELD,
    { id: "scale", label: "Scale", kind: "number", step: 0.05, group: "Scale" },
    { id: "axes", label: "Per-Axis Scale", kind: "vector", step: 0.1, group: "Scale" },
    { id: "mode", label: "Each", kind: "select", options: ["face", "piece"], group: "Scale" },
    { id: "disconnect", label: "Disconnect", kind: "boolean", group: "Scale" },
  ],
  run: (run) => {
    const mesh = run.mesh;
    const faces = faceMaskIndices(run);
    if (faces.length === 0) return mesh;
    const k = run.num("scale", 0.8);
    const axes = run.vec("axes", [1, 1, 1]);
    const name = run.str("weightAttr", "").trim();
    const weights = name ? pointInfluence(run, mesh, "face") : undefined;
    return withAttributes(mesh, (m) =>
      scaleElements(m, faces, [k * axes.x, k * axes.y, k * axes.z], {
        mode: run.str("mode", "face") === "piece" ? "piece" : "face",
        disconnect: run.bool("disconnect", false),
        weights,
      }),
    );
  },
});

// ============================================================ Dual / Poke / Divide

export const DUAL_MESH_NODE = definePolyNode({
  type: "modeling/dual-mesh",
  label: "Dual Mesh",
  category: CATEGORY,
  group: { domain: "face" },
  defaultParams: { keepBoundary: true },
  paramFields: [{ id: "keepBoundary", label: "Keep Boundary", kind: "boolean", group: "Dual" }],
  run: (run) => {
    const faces = faceMaskIndices(run);
    if (faces.length === 0) return run.mesh;
    return withAttributes(run.mesh, (m) => dualMesh(m, faces, run.bool("keepBoundary", true)));
  },
});

export const POKE_NODE = definePolyNode({
  type: "modeling/poke",
  label: "Poke Faces",
  category: CATEGORY,
  group: { domain: "face" },
  inputs: [{ id: "offset", label: "Offset", type: "value" }],
  defaultParams: { offset: 0 },
  paramFields: [{ id: "offset", label: "Centre Offset (along normal)", kind: "number", step: 0.01, group: "Poke" }],
  run: (run) => {
    const faces = faceMaskIndices(run);
    if (faces.length === 0) return run.mesh;
    return withAttributes(run.mesh, (m) => pokeFaces(m, faces, run.num("offset", 0)));
  },
});

export const DIVIDE_NODE = definePolyNode({
  type: "modeling/divide",
  label: "Divide / Tessellate",
  category: CATEGORY,
  group: { domain: "face" },
  inputs: [{ id: "cuts", label: "Cuts", type: "value" }],
  defaultParams: { cuts: 2, mode: "quads" },
  paramFields: [
    { id: "cuts", label: "Segments per Edge", kind: "number", step: 1, group: "Divide" },
    { id: "mode", label: "Pattern", kind: "select", options: ["quads", "triangles"], group: "Divide" },
  ],
  run: (run) => {
    const faces = faceMaskIndices(run);
    if (faces.length === 0) return run.mesh;
    const mode: DivideMode = run.str("mode", "quads") === "triangles" ? "triangles" : "quads";
    const cuts = Math.max(1, Math.min(64, Math.round(run.num("cuts", 2))));
    if (cuts * cuts * faces.length > 2_000_000) {
      run.note("Too many faces — lower the segments", true);
      return run.mesh;
    }
    return withAttributes(run.mesh, (m) => divideFaces(m, faces, cuts, mode));
  },
});

// ============================================================ Convex Hull / Bounding Box

const SHAPE_OUTPUTS = ["shape", "shape + input"] as const;

/** The hull / box as the node's output, alone or appended to the input, with its faces in a group. */
function emitShape(run: PolyRunContext, shape: PolyMesh, pointSource: ArrayLike<number> | null): PolyMesh {
  const mesh = run.mesh;
  const merged = run.str("output", "shape") === "shape + input";
  const groupName = run.str("groupName", "").trim();
  let out: PolyMesh;
  let shapeFaceStart = 0;
  if (merged) {
    out = withAttributes(mesh, (m) => appendMesh(m, shape));
    shapeFaceStart = mesh.faces.length;
  } else {
    const point = Int32Array.from({ length: shape.positions.length }, (_, i) => (pointSource ? pointSource[i] : -1));
    out = withAttributes(mesh, () => ({ mesh: shape, maps: { point, face: new Int32Array(shape.faces.length).fill(-1) } }));
  }
  if (groupName) {
    if (!isValidAttributeName(groupName)) run.note(`"${groupName}" is not a valid group name`, true);
    else {
      const mask = new Uint8Array(out.faces.length);
      for (let f = shapeFaceStart; f < out.faces.length; f++) mask[f] = 1;
      out = setGroup(out, "face", groupName, mask);
    }
  }
  return out;
}

function groupPoints(run: PolyRunContext): number[] {
  const mask = pointMask(run, run.mesh, "point");
  const out: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) out.push(i);
  return out;
}

export const CONVEX_HULL_NODE = definePolyNode({
  type: "modeling/convex-hull",
  label: "Convex Hull",
  category: CATEGORY,
  group: { domain: "choose", defaultDomain: "point" },
  outputs: [{ id: "faces", label: "Hull Faces", type: "value" }],
  defaultParams: { domain: "point", mergeCoplanar: true, output: "shape", groupName: "hull" },
  paramFields: [
    { id: "mergeCoplanar", label: "Merge Coplanar Triangles", kind: "boolean", group: "Hull" },
    { id: "output", label: "Output", kind: "select", options: [...SHAPE_OUTPUTS], group: "Hull" },
    { id: "groupName", label: "Hull Face Group", kind: "text", group: "Hull" },
  ],
  run: (run) => {
    const ids = groupPoints(run);
    const { mesh: hull, source } = hullMesh(
      ids.map((i) => run.mesh.positions[i]),
      run.bool("mergeCoplanar", true),
    );
    if (hull.faces.length === 0) run.note("Fewer than three non-collinear points — no hull", true);
    const pointSource = Array.from(source, (k) => ids[k]);
    return { mesh: emitShape(run, hull, pointSource), outputs: { faces: hull.faces.length } };
  },
});

export const BOUNDING_BOX_NODE = definePolyNode({
  type: "modeling/bounding-box",
  label: "Bounding Box",
  category: CATEGORY,
  group: { domain: "choose", defaultDomain: "point" },
  outputs: [
    { id: "center", label: "Center", type: "vector" },
    { id: "size", label: "Size", type: "vector" },
  ],
  defaultParams: { domain: "point", oriented: false, padding: 0, output: "shape", groupName: "bbox" },
  paramFields: [
    { id: "oriented", label: "Oriented (PCA)", kind: "boolean", group: "Box" },
    { id: "padding", label: "Padding", kind: "number", step: 0.01, group: "Box" },
    { id: "output", label: "Output", kind: "select", options: [...SHAPE_OUTPUTS], group: "Box" },
    { id: "groupName", label: "Box Face Group", kind: "text", group: "Box" },
  ],
  run: (run) => {
    const ids = groupPoints(run);
    const box = boundingBox(
      ids.map((i) => run.mesh.positions[i]),
      run.bool("oriented", false),
    );
    const pad = Math.max(0, run.num("padding", 0));
    box.half = [box.half[0] + pad, box.half[1] + pad, box.half[2] + pad];
    if (ids.length === 0) run.note("No points in the group", true);
    return {
      mesh: emitShape(run, boxToMesh(box), null),
      outputs: {
        center: new THREE.Vector3(...box.center),
        size: new THREE.Vector3(box.half[0] * 2, box.half[1] * 2, box.half[2] * 2),
      },
    };
  },
});

// ============================================================ Decimate

export const DECIMATE_NODE = definePolyNode({
  type: "modeling/decimate",
  label: "Decimate",
  category: CATEGORY,
  group: { domain: "face" },
  inputs: [{ id: "ratio", label: "Ratio", type: "value" }],
  outputs: [{ id: "triangles", label: "Triangles", type: "value" }],
  defaultParams: { target: "ratio", ratio: 0.5, count: 1000, preserveBoundary: true },
  paramFields: [
    { id: "target", label: "Target", kind: "select", options: ["ratio", "count"], group: "Decimate" },
    { id: "ratio", label: "Ratio (of triangles)", kind: "number", step: 0.05, group: "Decimate" },
    { id: "count", label: "Triangle Count", kind: "number", step: 100, group: "Decimate" },
    { id: "preserveBoundary", label: "Preserve Boundary", kind: "boolean", group: "Decimate" },
  ],
  run: (run) => {
    const mesh = run.mesh;
    const faces = faceMaskIndices(run);
    if (faces.length === 0) return { mesh, outputs: { triangles: 0 } };
    let triangles = 0;
    for (const f of faces) triangles += Math.max(0, mesh.faces[f].length - 2);
    const target =
      run.str("target", "ratio") === "count"
        ? Math.max(0, Math.round(run.num("count", 1000)))
        : Math.round(triangles * Math.max(0, Math.min(1, run.num("ratio", 0.5))));
    let reached = 0;
    const out = withAttributes(mesh, (m) => {
      const r = decimateMesh(m, faces, { targetTriangles: target, preserveBoundary: run.bool("preserveBoundary", true) });
      reached = r.triangles;
      return r;
    });
    run.note(`${triangles} → ${reached} triangles (target ${target})`, reached > target + 2);
    return { mesh: out, outputs: { triangles: reached } };
  },
});

// ============================================================ Sort Elements

export const SORT_KEYS = ["axis", "distance", "random", "attribute", "reverse"] as const;

export const SORT_NODE = definePolyNode({
  type: "modeling/sort",
  label: "Sort Elements",
  category: CATEGORY,
  group: { domain: "choose", defaultDomain: "point" },
  inputs: [{ id: "point", label: "Point", type: "vector" }],
  defaultParams: { domain: "point", by: "axis", axis: "y", point: new THREE.Vector3(0, 0, 0), seed: 0, attribute: "", descending: false },
  paramFields: [
    { id: "by", label: "Sort By", kind: "select", options: [...SORT_KEYS], group: "Sort" },
    { id: "axis", label: "Axis", kind: "select", options: ["x", "y", "z"], group: "Sort" },
    { id: "point", label: "Distance To", kind: "vector", step: 0.1, group: "Sort" },
    { id: "seed", label: "Seed", kind: "number", step: 1, group: "Sort" },
    { id: "attribute", label: "Attribute", kind: "text", group: "Sort" },
    { id: "descending", label: "Descending", kind: "boolean", group: "Sort" },
  ],
  run: (run) => {
    const mesh = run.mesh;
    const domain = domainParam(run, "point");
    if (domain !== "point" && domain !== "face") {
      run.note("Sort reorders points or faces", true);
      return mesh;
    }
    const count = domainSize(mesh, domain);
    const { mask } = run.group(domain);
    const by = run.str("by", "axis");
    const key = new Float64Array(count);
    const pos = by === "axis" || by === "distance" ? elementPositions(mesh, domain) : null;
    if (by === "axis") {
      const a = Math.max(0, ["x", "y", "z"].indexOf(run.str("axis", "y")));
      for (let i = 0; i < count; i++) key[i] = pos![i * 3 + a];
    } else if (by === "distance") {
      const p = run.vec("point", [0, 0, 0]);
      for (let i = 0; i < count; i++) key[i] = Math.hypot(pos![i * 3] - p.x, pos![i * 3 + 1] - p.y, pos![i * 3 + 2] - p.z);
    } else if (by === "random") {
      const seed = run.num("seed", 0);
      for (let i = 0; i < count; i++) key[i] = hash01(i, seed);
    } else if (by === "attribute") {
      const name = run.str("attribute", "").trim();
      const attr = name ? readAttribute(mesh, domain, name) : null;
      if (!attr) {
        run.note(name ? `No ${domain} attribute "${name}"` : "Name an attribute to sort by", true);
        return mesh;
      }
      for (let i = 0; i < count; i++) {
        key[i] = attr.size === 1 ? attr.values[i] : Math.hypot(attr.values[i * 3], attr.values[i * 3 + 1], attr.values[i * 3 + 2]);
      }
    } else {
      for (let i = 0; i < count; i++) key[i] = -i;
    }
    for (let i = 0; i < count; i++) if (!Number.isFinite(key[i])) key[i] = 0;
    const sign = run.bool("descending", false) ? -1 : 1;
    // Only group elements move, among the slots group elements occupied.
    const slots: number[] = [];
    for (let i = 0; i < count; i++) if (mask[i]) slots.push(i);
    const sorted = [...slots].sort((a, b) => sign * (key[a] - key[b]) || a - b);
    const order = new Int32Array(count).map((_, i) => i);
    slots.forEach((slot, k) => (order[slot] = sorted[k]));
    return withAttributes(mesh, (m) => (domain === "point" ? permutePoints(m, order) : permuteFaces(m, order)));
  },
});

// ============================================================ Keep Group

export const KEEP_GROUP_NODE = definePolyNode({
  type: "modeling/keep-group",
  label: "Keep Group",
  category: CATEGORY,
  group: { domain: "choose", defaultDomain: "face" },
  outputs: [{ id: "count", label: "Kept Count", type: "value" }],
  defaultParams: { domain: "face", invert: false },
  paramFields: [{ id: "invert", label: "Invert (delete the group)", kind: "boolean", group: "Keep" }],
  run: (run) => {
    const mesh = run.mesh;
    const domain = domainParam(run, "face");
    const raw = run.group(domain).mask;
    const invert = run.bool("invert", false);
    const mask = Uint8Array.from(raw, (v) => (invert ? (v ? 0 : 1) : v ? 1 : 0));
    let kept = 0;
    for (const v of mask) kept += v;
    let op: () => ReturnType<typeof subsetMesh>;
    if (domain === "face") op = () => subsetMesh(mesh, (f) => mask[f] === 1, null);
    else if (domain === "point") {
      op = () => subsetMesh(mesh, (f) => mesh.faces[f].every((v) => mask[v]), (v) => mask[v] === 1);
    } else if (domain === "edge") {
      const edges = domainEdges(mesh);
      const keepEdge = new Set<string>();
      const keptEdges: [number, number][] = [];
      edges.forEach(([a, b], i) => {
        if (!mask[i]) return;
        keepEdge.add(a < b ? `${a}_${b}` : `${b}_${a}`);
        keptEdges.push([a, b]);
      });
      const has = (a: number, b: number) => keepEdge.has(a < b ? `${a}_${b}` : `${b}_${a}`);
      op = () => subsetMesh(mesh, (f) => mesh.faces[f].every((v, i, face) => has(v, face[(i + 1) % face.length])), null, keptEdges);
    } else {
      // Corners: a face stays when all its corners are in.
      const faceMask = promoteMask(mesh, "corner", "face", mask, "all");
      op = () => subsetMesh(mesh, (f) => faceMask[f] === 1, null);
    }
    return { mesh: withAttributes(mesh, op), outputs: { count: kept } };
  },
});

// ============================================================ Edge Crease / Mark

export const EDGE_MARKS = ["crease", "sharp", "seam"] as const;

export const EDGE_MARK_NODE = definePolyNode({
  type: "modeling/edge-mark",
  label: "Edge Crease / Mark",
  category: CATEGORY,
  group: { domain: "edge" },
  inputs: [{ id: "value", label: "Crease", type: "value" }],
  outputs: [{ id: "count", label: "Edges", type: "value" }],
  defaultParams: { mark: "crease", value: 1, clear: false },
  paramFields: [
    { id: "mark", label: "Mark", kind: "select", options: [...EDGE_MARKS], group: "Mark" },
    { id: "value", label: "Crease Weight (0–1)", kind: "number", step: 0.1, group: "Mark" },
    { id: "clear", label: "Clear Instead", kind: "boolean", group: "Mark" },
  ],
  run: (run) => {
    const mesh = run.mesh;
    const mark = (EDGE_MARKS as readonly string[]).includes(run.str("mark", "crease")) ? run.str("mark", "crease") : "crease";
    const { indices } = run.group("edge");
    const current = readAttribute(mesh, "edge", mark)!;
    const values = Float64Array.from(current.values);
    const clear = run.bool("clear", false);
    const value = mark === "crease" ? Math.max(0, Math.min(1, run.num("value", 1))) : 1;
    for (const e of indices) values[e] = clear ? 0 : value;
    run.note(`${clear ? "Cleared" : "Marked"} ${indices.length} edge${indices.length === 1 ? "" : "s"} (${mark})`);
    return { mesh: setAttribute(mesh, "edge", mark, mark === "crease" ? "float" : "bool", values), outputs: { count: indices.length } };
  },
});

export const MODELING_ALGO_NODES: NodeDefinition[] = [
  SMOOTH_NODE,
  DISPLACE_NODE,
  TRANSFORM_ELEMENTS_NODE,
  SCALE_ELEMENTS_NODE,
  DUAL_MESH_NODE,
  POKE_NODE,
  DIVIDE_NODE,
  CONVEX_HULL_NODE,
  BOUNDING_BOX_NODE,
  DECIMATE_NODE,
  SORT_NODE,
  KEEP_GROUP_NODE,
  EDGE_MARK_NODE,
];
