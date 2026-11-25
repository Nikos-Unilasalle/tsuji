import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { EvalContext, NodeDefinition } from "../types";
import { createQuadPlane, type PolyMesh } from "../quadMesh";
import { polyMeshToGeometry, readPolyMesh } from "../mesh/polyIO";
import { evaluateGroup } from "../mesh/groupExpr";
import { readAttribute } from "../mesh/polyAttributes";
import { curveControlParams, curveIsClosed, curvePointAttribute, safeLength } from "../curveAttributes";
import { canRebuildCurve } from "../curveClasses";
import { curveToPolyline, makePolylineCurve } from "../curveKernel";
import { setCurveNodePose } from "../curvePoseStore";
import {
  CURVE_INFO_NODE,
  CURVE_OPS_NODES,
  FILLET_CURVE_NODE,
  MESH_EDGES_TO_CURVES_NODE,
  OFFSET_CURVE_2D_NODE,
  RESAMPLE_CURVE_NODE,
  REVERSE_CURVE_NODE,
  SET_CURVE_ATTRIBUTE_NODE,
  SET_CURVE_RADIUS_NODE,
  SET_CURVE_TILT_NODE,
  SWEEP_CURVE_NODE,
  TRIM_CURVE_NODE,
} from "./curveOps";

let n = 0;
const ctx = (sources?: Record<string, string>): EvalContext => ({
  time: 0,
  step: 0,
  nodeId: `curveops-${n++}`,
  ...(sources ? { inputSources: new Map(Object.entries(sources)) } : {}),
});
const v = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z);
const run = (def: NodeDefinition, inputs: Record<string, unknown>, params: Record<string, unknown> = {}, c = ctx()) =>
  def.evaluate(inputs, { ...def.defaultParams, ...params }, c);
const curveOut = (def: NodeDefinition, curve: THREE.Curve<THREE.Vector3>, params: Record<string, unknown> = {}, inputs: Record<string, unknown> = {}) =>
  run(def, { curve, ...inputs }, params).curve as THREE.Curve<THREE.Vector3>;
const square = (s = 1) => makePolylineCurve([v(-s, -s), v(s, -s), v(s, s), v(-s, s)], true);
const line = (len = 4) => makePolylineCurve([v(0, 0), v(len, 0)], false);
const meshObj = (m: PolyMesh) => new THREE.Mesh(polyMeshToGeometry(m), new THREE.MeshStandardMaterial());

describe("curve ops — no inputs", () => {
  it("every node evaluates on defaults without throwing or NaN", () => {
    for (const def of CURVE_OPS_NODES) {
      expect(def.type.startsWith("curve/")).toBe(true);
      expect(def.category).toBe("curve");
      const out = def.evaluate({}, def.defaultParams, ctx());
      for (const value of Object.values(out)) if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe("Set Curve Radius / Tilt / Attribute", () => {
  it("constant, ramp and list", () => {
    const base = makePolylineCurve([v(0, 0), v(1, 0), v(2, 0)], false);
    const c = curveOut(SET_CURVE_RADIUS_NODE, base, { mode: "constant", value: 0.3 });
    expect(c).not.toBe(base);
    expect(curvePointAttribute(base, "radius", 0.5)).toBe(1);
    expect(curvePointAttribute(c, "radius", 0.7)).toBeCloseTo(0.3);
    const ramp = curveOut(SET_CURVE_RADIUS_NODE, base, { mode: "ramp", start: 2, end: 0 });
    expect(curvePointAttribute(ramp, "radius", 0)).toBeCloseTo(2);
    expect(curvePointAttribute(ramp, "radius", 0.5)).toBeCloseTo(1);
    const list = curveOut(SET_CURVE_RADIUS_NODE, base, { mode: "list" }, { values: [1, 5, 1] });
    expect(curvePointAttribute(list, "radius", 0.5)).toBeCloseTo(5);
    const tilt = curveOut(SET_CURVE_TILT_NODE, list, { mode: "constant", value: 90 });
    expect(curvePointAttribute(tilt, "tilt", 0.2)).toBeCloseTo(Math.PI / 2);
    // Setting one attribute keeps the others.
    expect(curvePointAttribute(tilt, "radius", 0.5)).toBeCloseTo(5);
    const w = curveOut(SET_CURVE_ATTRIBUTE_NODE, base, { name: "heat", value: 7 });
    expect(curvePointAttribute(w, "heat", 0.1)).toBe(7);
  });

  it("maps over a list and keeps a smooth curve's class", () => {
    const cat = new THREE.CatmullRomCurve3([v(0, 0), v(1, 1), v(2, 0)]);
    const out = run(SET_CURVE_RADIUS_NODE, { curves: [cat, line()] }, { value: 2 });
    expect(out.curves as unknown[]).toHaveLength(2);
    expect((out.curves as unknown[])[0]).toBeInstanceOf(THREE.CatmullRomCurve3);
    expect(out.curve).toBe((out.curves as unknown[])[0]);
  });
});

describe("Resample Curve", () => {
  it("count gives evenly spaced points along a smooth curve", () => {
    // A half circle whose parameter runs unevenly (t²): equal arcs ⇔ equal chords here.
    class SkewedArc extends THREE.Curve<THREE.Vector3> {
      constructor() {
        super();
      }
      getPoint(t: number, target = new THREE.Vector3()) {
        const a = Math.PI * t * t;
        return target.set(Math.cos(a), Math.sin(a), 0);
      }
    }
    const arc = new SkewedArc();
    const out = curveOut(RESAMPLE_CURVE_NODE, arc, { mode: "count", count: 11 });
    const pts = curveToPolyline(out).points;
    expect(pts).toHaveLength(11);
    const d = pts.slice(1).map((p, i) => p.distanceTo(pts[i]));
    for (const x of d) expect(x).toBeCloseTo(2 * Math.sin(Math.PI / 20), 3);
    expect(canRebuildCurve(out.toJSON())).toBe(true);
  });

  it("by length on a closed loop keeps it closed and carries attributes", () => {
    const tagged = curveOut(SET_CURVE_RADIUS_NODE, square(), { mode: "list" }, { values: [1, 2, 3, 4] });
    const out = curveOut(RESAMPLE_CURVE_NODE, tagged, { mode: "length", length: 0.5 });
    expect(curveIsClosed(out)).toBe(true);
    expect(curveControlParams(out)).toHaveLength(16);
    expect(curvePointAttribute(out, "radius", 0)).toBeCloseTo(1);
    expect(curvePointAttribute(out, "radius", 0.25)).toBeCloseTo(2);
    expect(curvePointAttribute(out, "radius", 0.125)).toBeCloseTo(1.5);
  });
});

describe("Trim Curve", () => {
  it("factor and length on a polyline", () => {
    expect(safeLength(curveOut(TRIM_CURVE_NODE, line(4), { start: 0.25, end: 0.75 }))).toBeCloseTo(2);
    expect(safeLength(curveOut(TRIM_CURVE_NODE, line(4), { mode: "length", start: 1, end: 1.5 }))).toBeCloseTo(0.5);
    const grown = curveOut(TRIM_CURVE_NODE, line(4), {}, { end: 0 });
    expect(safeLength(grown)).toBeCloseTo(0);
  });

  it("an animated end grows a smooth curve", () => {
    const cat = new THREE.CatmullRomCurve3([v(0, 0), v(1, 1), v(2, 0), v(3, 1)]);
    const total = cat.getLength();
    const half = curveOut(TRIM_CURVE_NODE, cat, {}, { end: 0.5 });
    expect(half.getLength()).toBeCloseTo(total / 2, 2);
    expect(half.getPoint(0).distanceTo(cat.getPoint(0))).toBeLessThan(1e-6);
    // Different windows serialise differently, so Curve to Mesh's signature moves.
    const other = curveOut(TRIM_CURVE_NODE, cat, {}, { end: 0.6 });
    expect(JSON.stringify(half.toJSON())).not.toBe(JSON.stringify(other.toJSON()));
  });
});

describe("Reverse Curve", () => {
  it("swaps the ends, keeps a loop's start, flips attributes", () => {
    const base = makePolylineCurve([v(0, 0), v(1, 0), v(1, 2)], false);
    const tagged = curveOut(SET_CURVE_RADIUS_NODE, base, { mode: "ramp", start: 0, end: 3 });
    const rev = curveOut(REVERSE_CURVE_NODE, tagged);
    expect(rev.getPoint(0).distanceTo(v(1, 2))).toBeLessThan(1e-9);
    expect(rev.getPoint(1).distanceTo(v(0, 0))).toBeLessThan(1e-9);
    expect(curvePointAttribute(rev, "radius", 0)).toBeCloseTo(3);
    const loop = curveOut(REVERSE_CURVE_NODE, square());
    expect(loop.getPoint(0).distanceTo(v(-1, -1))).toBeLessThan(1e-9);
    expect(loop.getPoint(0.25).distanceTo(v(-1, 1))).toBeLessThan(1e-9);
    const cat = new THREE.CatmullRomCurve3([v(0, 0), v(1, 1), v(3, 0)]);
    const rc = curveOut(REVERSE_CURVE_NODE, cat);
    expect(rc.getPoint(0.3).distanceTo(cat.getPoint(0.7))).toBeLessThan(1e-6);
  });
});

describe("Fillet Curve", () => {
  it("keeps the ends and rounds the corners", () => {
    const l = makePolylineCurve([v(0, 0), v(2, 0), v(2, 2)], false);
    const out = curveOut(FILLET_CURVE_NODE, l, { radius: 0.5, segments: 4 });
    const pts = curveToPolyline(out).points;
    expect(pts[0].distanceTo(v(0, 0))).toBeLessThan(1e-9);
    expect(pts[pts.length - 1].distanceTo(v(2, 2))).toBeLessThan(1e-9);
    expect(pts).toHaveLength(7);
    expect(pts.every((p) => p.distanceTo(v(2, 0)) > 0.1)).toBe(true);
    const loop = curveToPolyline(curveOut(FILLET_CURVE_NODE, square(), { radius: 0.25, segments: 3 }));
    expect(loop.closed).toBe(true);
    expect(loop.points).toHaveLength(16);
  });
});

describe("Offset Curve 2D", () => {
  it("a square grows into a larger square", () => {
    const out = curveToPolyline(curveOut(OFFSET_CURVE_2D_NODE, square(), { distance: 0.5 }));
    expect(out.closed).toBe(true);
    expect(out.points).toHaveLength(4);
    for (const p of out.points) {
      expect(Math.abs(p.x)).toBeCloseTo(1.5);
      expect(Math.abs(p.y)).toBeCloseTo(1.5);
    }
    const rounded = curveToPolyline(curveOut(OFFSET_CURVE_2D_NODE, square(), { distance: 0.5, join: "round" }));
    expect(rounded.points.length).toBeGreaterThan(4);
  });
});

describe("Sweep", () => {
  it("builds a PolyMesh with side and cap groups and u/v", () => {
    const path = makePolylineCurve([v(0, 0), v(1, 0), v(2, 0)], false);
    const out = run(SWEEP_CURVE_NODE, { curve: path }, { profileType: "circle", profileSegments: 8, radius: 0.5, caps: true });
    const read = readPolyMesh(out.geometry as THREE.Object3D)!;
    expect(read.mesh.faces).toHaveLength(18);
    expect(out.count).toBe(18);
    expect(evaluateGroup(read.mesh, "face", "caps").mask.reduce((a, b) => a + b, 0)).toBe(2);
    expect(evaluateGroup(read.mesh, "face", "side").mask.reduce((a, b) => a + b, 0)).toBe(16);
    const u = readAttribute(read.mesh, "point", "u")!.values;
    expect(Math.max(...u)).toBe(1);
    expect(readAttribute(read.mesh, "point", "v")).not.toBeNull();
    // Radius 0.5 circle round the X axis.
    for (const p of read.mesh.positions) expect(Math.hypot(p[1], p[2])).toBeCloseTo(0.5);
  });

  it("reads radius and tilt from the path, closed path has no caps", () => {
    const tagged = curveOut(SET_CURVE_RADIUS_NODE, square(2), { mode: "list" }, { values: [1, 2, 1, 2] });
    const out = run(SWEEP_CURVE_NODE, { curve: tagged }, { profileType: "square", radius: 0.1, caps: true });
    const mesh = readPolyMesh(out.geometry as THREE.Object3D)!.mesh;
    expect(mesh.faces).toHaveLength(16);
    expect(evaluateGroup(mesh, "face", "caps").mask.reduce((a, b) => a + b, 0)).toBe(0);
    const ring0 = mesh.positions.slice(0, 4).map((p) => Math.hypot(p[0] + 2, p[1] + 2, p[2]));
    const ring1 = mesh.positions.slice(4, 8).map((p) => Math.hypot(p[0] - 2, p[1] + 2, p[2]));
    expect(Math.max(...ring1)).toBeCloseTo(2 * Math.max(...ring0));
  });

  it("returns the same mesh object while nothing changes, and a custom profile works", () => {
    const c = ctx();
    const path = line(2);
    const profile = makePolylineCurve([v(0.2, 0), v(0, 0.2), v(-0.2, 0)], false);
    const a = SWEEP_CURVE_NODE.evaluate({ curve: path, profile }, SWEEP_CURVE_NODE.defaultParams, c);
    const geomA = (a.geometry as THREE.Mesh).geometry;
    const b = SWEEP_CURVE_NODE.evaluate({ curve: path, profile }, SWEEP_CURVE_NODE.defaultParams, c);
    expect(b.geometry).toBe(a.geometry);
    expect((b.geometry as THREE.Mesh).geometry).toBe(geomA);
    expect(readPolyMesh(b.geometry as THREE.Object3D)!.mesh.faces).toHaveLength(2);
  });

  it("composes the source curve's pose", () => {
    setCurveNodePose("src-curve", new THREE.Matrix4().makeTranslation(5, 0, 0));
    const out = run(SWEEP_CURVE_NODE, { curve: line(1) }, {}, ctx({ curve: "src-curve" }));
    expect((out.matrix as THREE.Matrix4).elements[12]).toBeCloseTo(5);
  });
});

describe("Mesh Edges to Curves", () => {
  it("boundary of a plane is one closed loop of its perimeter", () => {
    const plane = meshObj(createQuadPlane(2, 2, 4, 4));
    const out = run(MESH_EDGES_TO_CURVES_NODE, { geometry: plane }, { mode: "boundary" });
    expect(out.count).toBe(1);
    const c = out.curve as THREE.Curve<THREE.Vector3>;
    expect(curveIsClosed(c)).toBe(true);
    expect(c.getLength()).toBeCloseTo(8);
    expect(curveControlParams(c)).toHaveLength(16);
  });

  it("edge group mode, and the outline of a face group", () => {
    const plane = meshObj(createQuadPlane(2, 2, 4, 4));
    const edges = run(MESH_EDGES_TO_CURVES_NODE, { geometry: plane }, { mode: "edges", group: "boundary" });
    expect(edges.count).toBe(1);
    expect((edges.curve as THREE.Curve<THREE.Vector3>).getLength()).toBeCloseTo(8);
    const one = run(MESH_EDGES_TO_CURVES_NODE, { geometry: plane }, { mode: "boundary", group: "0" });
    expect(one.count).toBe(1);
    expect((one.curve as THREE.Curve<THREE.Vector3>).getLength()).toBeCloseTo(2);
    // All interior + border edges of a 2×1 grid: junctions split the runs.
    const grid = meshObj(createQuadPlane(2, 1, 2, 1));
    const all = run(MESH_EDGES_TO_CURVES_NODE, { geometry: grid }, { mode: "edges" });
    expect(all.count).toBe(3);
    const total = (all.curves as THREE.Curve<THREE.Vector3>[]).reduce((s, c) => s + c.getLength(), 0);
    expect(total).toBeCloseTo(7);
  });
});

describe("Curve Info", () => {
  it("reports length, points, closed, ends and tangents", () => {
    const out = run(CURVE_INFO_NODE, { curve: makePolylineCurve([v(0, 0), v(3, 0), v(3, 4)], false) });
    expect(out.length).toBeCloseTo(7);
    expect(out.pointCount).toBe(3);
    expect(out.closed).toBe(0);
    expect((out.end as THREE.Vector3).distanceTo(v(3, 4))).toBeLessThan(1e-9);
    expect((out.startTangent as THREE.Vector3).distanceTo(v(1, 0))).toBeLessThan(1e-6);
    expect((out.endTangent as THREE.Vector3).distanceTo(v(0, 1))).toBeLessThan(1e-6);
    expect(run(CURVE_INFO_NODE, { curve: square() }).closed).toBe(1);
  });
});
