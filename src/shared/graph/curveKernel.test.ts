import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  bestFitNormal,
  buildSweepMesh,
  builtinProfile,
  chainEdges,
  cumulativeLengths,
  curveToPolyline,
  filletPolyline,
  makePolylineCurve,
  offsetPolyline2D,
  polylineLength,
  resamplePolyline,
  rotationMinimizingFrames,
  trimPolyline,
} from "./curveKernel";
import {
  attachCurveAttributes,
  cloneCurveShape,
  curveControlParams,
  curveIsClosed,
  curvePointAttribute,
} from "./curveAttributes";
import { readAttribute } from "./mesh/polyAttributes";

const v = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z);
const square = (s = 1) => [v(-s, -s), v(s, -s), v(s, s), v(-s, s)];
const spans = (pts: THREE.Vector3[], closed: boolean) => {
  const out: number[] = [];
  for (let i = 0; i + 1 < pts.length; i++) out.push(pts[i].distanceTo(pts[i + 1]));
  if (closed) out.push(pts[pts.length - 1].distanceTo(pts[0]));
  return out;
};

describe("curve attributes", () => {
  it("defaults, interpolation and closed wrap", () => {
    const curve = makePolylineCurve([v(0, 0), v(1, 0), v(2, 0)], false);
    expect(curvePointAttribute(curve, "radius", 0.5)).toBe(1);
    expect(curvePointAttribute(curve, "tilt", 0.5)).toBe(0);
    attachCurveAttributes(curve, { radius: { knots: curveControlParams(curve), values: [0, 2, 4], closed: false } });
    expect(curvePointAttribute(curve, "radius", 0.25)).toBeCloseTo(1);
    expect(curvePointAttribute(curve, "radius", 1)).toBeCloseTo(4);
    const loop = makePolylineCurve(square(), true);
    expect(curveIsClosed(loop)).toBe(true);
    expect(curveControlParams(loop)).toEqual([0, 0.25, 0.5, 0.75]);
    attachCurveAttributes(loop, { w: { knots: [0, 0.25, 0.5, 0.75], values: [0, 1, 2, 3], closed: true } });
    expect(curvePointAttribute(loop, "w", 0.875)).toBeCloseTo(1.5);
  });

  it("clones keep shape and drop nothing", () => {
    const cat = new THREE.CatmullRomCurve3([v(0, 0), v(1, 1), v(2, 0)]);
    const c = cloneCurveShape(cat);
    expect(c).not.toBe(cat);
    expect(c.getPoint(0.3).distanceTo(cat.getPoint(0.3))).toBeLessThan(1e-9);
  });
});

describe("polylines", () => {
  it("reads straight-piece curves exactly and smooth ones by length", () => {
    const line = curveToPolyline(makePolylineCurve([v(0, 0), v(1, 0), v(1, 1)], false));
    expect(line.points.length).toBe(3);
    expect(line.params).toEqual([0, 0.5, 1]);
    const loop = curveToPolyline(makePolylineCurve(square(), true));
    expect(loop.closed).toBe(true);
    expect(loop.points.length).toBe(4);
    const cat = curveToPolyline(new THREE.CatmullRomCurve3([v(0, 0), v(1, 1), v(2, 0), v(3, 1)]), 30);
    expect(cat.points.length).toBe(31);
  });

  it("resamples to equal spacing", () => {
    const pts = [v(0, 0), v(3, 0), v(3, 1)];
    const { points } = resamplePolyline(pts, false, { count: 9 });
    expect(points.length).toBe(9);
    expect(points[8].distanceTo(v(3, 1))).toBeLessThan(1e-9);
    // Arc spacing is 0.5; chords differ only at the corner span.
    const cum = cumulativeLengths(pts, false);
    expect(cum[2]).toBe(4);
    const byLen = resamplePolyline(square(), true, { spacing: 0.5 });
    expect(byLen.points.length).toBe(16);
    for (const d of spans(byLen.points, true)) expect(d).toBeCloseTo(0.5);
  });

  it("trims by length, wrapping on loops", () => {
    const pts = [v(0, 0), v(4, 0)];
    const t = trimPolyline(pts, false, 1, 3);
    expect(polylineLength(t.points, false)).toBeCloseTo(2);
    const loop = trimPolyline(square(), true, 7, 9);
    expect(polylineLength(loop.points, false)).toBeCloseTo(2);
    expect(loop.points[0].distanceTo(v(-1, 0))).toBeLessThan(1e-9);
  });

  it("fillets corners, keeps open ends", () => {
    const pts = [v(0, 0), v(2, 0), v(2, 2)];
    const { points } = filletPolyline(pts, false, 0.5, 8);
    expect(points[0].equals(v(0, 0))).toBe(true);
    expect(points[points.length - 1].equals(v(2, 2))).toBe(true);
    expect(points.some((p) => p.distanceTo(v(2, 0)) < 1e-6)).toBe(false);
    const center = v(1.5, 0.5);
    for (const p of points.slice(1, -1)) expect(p.distanceTo(center)).toBeCloseTo(0.5);
    // A radius too big for the spans shrinks to fit instead of overshooting.
    const big = filletPolyline(square(), true, 10, 4).points;
    for (const p of big) expect(Math.max(Math.abs(p.x), Math.abs(p.y))).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("offsets a square to a larger square, either winding", () => {
    for (const pts of [square(), square().reverse()]) {
      const out = offsetPolyline2D(pts, true, 0.5).points;
      expect(out.length).toBe(4);
      for (const p of out) {
        expect(Math.abs(p.x)).toBeCloseTo(1.5);
        expect(Math.abs(p.y)).toBeCloseTo(1.5);
      }
      const inner = offsetPolyline2D(pts, true, -0.5).points;
      for (const p of inner) expect(Math.abs(p.x)).toBeCloseTo(0.5);
    }
    const round = offsetPolyline2D(square(), true, 0.5, { join: "round", roundSegments: 4 }).points;
    expect(round.length).toBe(20);
    for (const p of round) expect(Math.max(Math.abs(p.x), Math.abs(p.y))).toBeLessThanOrEqual(1.5 + 1e-9);
    // A square on the ground (XZ) works the same: the plane is found.
    const ground = square().map((p) => v(p.x, 2, p.y));
    for (const p of offsetPolyline2D(ground, true, 0.5).points) {
      expect(Math.abs(p.x)).toBeCloseTo(1.5);
      expect(p.y).toBeCloseTo(2);
    }
  });

  it("best-fit normal of an open ground curve points up", () => {
    const n = bestFitNormal([v(0, 0, 0), v(1, 0, 1), v(2, 0, 0), v(3, 0, 2)].map((p) => v(p.x, 0, p.z)), false);
    expect(n.y).toBeCloseTo(1);
  });
});

describe("chainEdges", () => {
  it("chains a loop, an open run, and splits at junctions", () => {
    const loop = chainEdges([[0, 1], [2, 3], [1, 2], [3, 0]]);
    expect(loop).toHaveLength(1);
    expect(loop[0].closed).toBe(true);
    expect(loop[0].verts).toHaveLength(4);
    const open = chainEdges([[5, 6], [6, 7]]);
    expect(open).toEqual([{ verts: [5, 6, 7], closed: false }]);
    const tee = chainEdges([[0, 1], [1, 2], [1, 3]]);
    expect(tee).toHaveLength(3);
    expect(tee.every((c) => !c.closed && c.verts.length === 2)).toBe(true);
  });
});

describe("sweep", () => {
  it("frames don't twist on a planar path", () => {
    const frames = rotationMinimizingFrames([v(0, 0, 0), v(1, 0, 0), v(2, 0, 1), v(3, 0, 1)], false);
    for (const f of frames) expect(Math.abs(f.n.y)).toBeCloseTo(1);
  });

  it("builds quads, caps, groups and u/v", () => {
    const prof = builtinProfile("circle", 8);
    const rings = [0, 1, 2].map((x) => ({ point: v(x, 0, 0), scale: 0.5, angle: 0, u: x / 2 }));
    const mesh = buildSweepMesh({ rings, pathClosed: false, profile: prof.points, profileClosed: true, caps: true });
    expect(mesh.positions.length).toBe(24);
    expect(mesh.faces.length).toBe(18);
    const sides = Array.from(readAttribute(mesh, "face", "side")!.values);
    const caps = Array.from(readAttribute(mesh, "face", "caps")!.values);
    expect(sides.filter(Boolean).length).toBe(16);
    expect(caps.filter(Boolean).length).toBe(2);
    const u = Array.from(readAttribute(mesh, "point", "u")!.values);
    expect(u[0]).toBe(0);
    expect(u[23]).toBe(1);
    // Side faces point away from the axis, caps away from the middle.
    mesh.faces.forEach((face, f) => {
      const [a, b, c] = face.map((i) => v(...mesh.positions[i]));
      const n = b.clone().sub(a).cross(c.clone().sub(a));
      const centroid = face.reduce((acc, i) => acc.add(v(...mesh.positions[i])), v(0, 0)).divideScalar(face.length);
      const out = caps[f] ? v(centroid.x - 1, 0, 0) : v(0, centroid.y, centroid.z);
      expect(n.dot(out)).toBeGreaterThan(0);
    });
  });

  it("a clockwise profile gives the same outward faces", () => {
    const prof = builtinProfile("circle", 6).points.reverse();
    const rings = [0, 1].map((x) => ({ point: v(x, 0, 0), scale: 1, angle: 0, u: x }));
    const mesh = buildSweepMesh({ rings, pathClosed: false, profile: prof, profileClosed: true, caps: false });
    const face = mesh.faces[0];
    const [a, b, c] = face.map((i) => v(...mesh.positions[i]));
    const n = b.clone().sub(a).cross(c.clone().sub(a));
    const centroid = face.reduce((acc, i) => acc.add(v(...mesh.positions[i])), v(0, 0)).divideScalar(4);
    expect(n.dot(v(0, centroid.y, centroid.z))).toBeGreaterThan(0);
  });
});
