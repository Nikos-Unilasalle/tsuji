import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { canRebuildCurve, curveFromJSON, RadialOffsetCurve3, SaggedLineCurve3 } from "../curveClasses";
import { CURVE_ARRAY_NODE, CURVE_FROM_POINTS_NODE, CURVE_PRIMITIVE_NODE, CURVE_TO_MESH_NODE } from "../nodes/curve";
import { DEFAULT_PROFILE_POINTS, ProfilePoint } from "../profileCurve";
import { createVariableThicknessTubeGeometry } from "../tubeGeometry";
import { EvalContext } from "../types";
import { sweepCurveTube } from "./curveTube";
import { setJobExecutor } from "./jobs";
import { CloningExecutor } from "./testing";

function ctx(nodeId: string): EvalContext {
  return { time: 0, step: 0, nodeId, simulationEpoch: 0 };
}

const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 2, 0), new THREE.Vector3(3, 1, 1), new THREE.Vector3(4, 3, -1)];

/** Curves of every class the curve nodes build, made by those nodes where they make them. */
function curves(): [string, THREE.Curve<THREE.Vector3>][] {
  const fromPoints = (params: Record<string, unknown>) =>
    CURVE_FROM_POINTS_NODE.evaluate({ points: pts }, { ...CURVE_FROM_POINTS_NODE.defaultParams, ...params }, ctx("fp")).curve as THREE.Curve<THREE.Vector3>;
  const primitive = (primitiveType: string, sag = 0) =>
    CURVE_PRIMITIVE_NODE.evaluate({}, { ...CURVE_PRIMITIVE_NODE.defaultParams, primitiveType, sag }, ctx("prim")).curve as THREE.Curve<THREE.Vector3>;
  const ring = (CURVE_ARRAY_NODE.evaluate({ curve: primitive("circle") }, { count: 3, spacing: 0.5, start: 1, step: 0.1 }, ctx("arr"))
    .curves as THREE.Curve<THREE.Vector3>[])[2];
  return [
    ["catmull-rom", fromPoints({ type: "catmull", tension: 0.3 })],
    ["closed catmull-rom", fromPoints({ type: "catmull", closed: true })],
    ["bezier path", fromPoints({ type: "bezier" })],
    ["linear path", fromPoints({ type: "linear" })],
    ["sagged linear path", fromPoints({ sag: 0.7 })],
    ["helix", primitive("helix")],
    ["sagged star", primitive("star", 0.3)],
    ["radial offset ring", ring],
    ["bare sagged segment", new SaggedLineCurve3(pts[0], pts[3], 1.2)],
    ["nested radial offset", new RadialOffsetCurve3(new RadialOffsetCurve3(new THREE.CatmullRomCurve3(pts), 2, 0.1), 0.5, 1)],
  ];
}

function expectSameGeometry(actual: THREE.BufferGeometry, expected: THREE.BufferGeometry): void {
  for (const name of ["position", "normal", "uv"]) {
    expect(actual.getAttribute(name)?.array, name).toEqual(expected.getAttribute(name)?.array);
  }
  expect(actual.index?.array).toEqual(expected.index?.array);
}

afterEach(() => setJobExecutor(null));

describe("curve tube kernel", () => {
  type Args = Required<Parameters<typeof createVariableThicknessTubeGeometry>>;
  const options: [string, Args][] = [];
  for (const [name, curve] of curves()) {
    options.push([`${name}`, [curve, 64, 12, 0.15, DEFAULT_PROFILE_POINTS, false, 0, 1, false]]);
    options.push([`${name}, trimmed, capped, profiled`, [curve, 40, 7, 0.3, [{ x: 0, y: 0.2 }, { x: 0.5, y: 1 }, { x: 1, y: 0.4 }], false, 0.1, 0.85, true]]);
  }

  it.each(options)("rebuilds and sweeps %s bit for bit like the live curve", (_name, args) => {
    const [curve, tubularSegments, radialSegments, thickness, profile, closed, startProgress, endProgress, caps] = args;
    const json = structuredClone(curve.toJSON());
    expect(canRebuildCurve(json)).toBe(true);
    expect(JSON.stringify(curveFromJSON(json).toJSON())).toBe(JSON.stringify(curve.toJSON()));

    const expected = createVariableThicknessTubeGeometry(...args);
    const result = sweepCurveTube({ curve: json, tubularSegments, radialSegments, thickness, profile, closed, startProgress, endProgress, caps });
    expect(result.position).toEqual(expected.getAttribute("position").array);
    expect(result.normal).toEqual(expected.getAttribute("normal").array);
    expect(result.uv).toEqual(expected.getAttribute("uv").array);
    expect(result.index).toEqual(expected.index!.array);
  });

  it("refuses a curve class it cannot rebuild", () => {
    class Custom extends THREE.Curve<THREE.Vector3> {
      constructor() {
        super();
      }
      getPoint(t: number, target = new THREE.Vector3()) {
        return target.set(t, t * t, 0);
      }
    }
    expect(canRebuildCurve(new Custom().toJSON())).toBe(false);
    const path = new THREE.CurvePath<THREE.Vector3>();
    path.add(new THREE.LineCurve3(pts[0], pts[1]));
    path.add(new Custom());
    expect(canRebuildCurve(path.toJSON())).toBe(false);
  });
});

describe("Curve to Mesh off the main thread", () => {
  const tubeOf = (out: Record<string, unknown>) => (out.geometry as THREE.Group).children[0] as THREE.Mesh;
  const params: Record<string, unknown> = { ...CURVE_TO_MESH_NODE.defaultParams, caps: true, startProgress: 0.05 };

  it("matches the old inline sweep, a frame late while the curve moves, exact after", async () => {
    const exec = new CloningExecutor();
    setJobExecutor(exec);
    const [a, b] = [new THREE.CatmullRomCurve3(pts), new THREE.CatmullRomCurve3(pts.map((p) => p.clone().multiplyScalar(2)))];
    const inline = (curve: THREE.Curve<THREE.Vector3>) =>
      createVariableThicknessTubeGeometry(curve, 64, 12, 0.15, params.profile as ProfilePoint[], false, 0.05, 1, true);

    // First evaluation: nothing to show yet, so it runs inline.
    const first = tubeOf(CURVE_TO_MESH_NODE.evaluate({ curve: a }, params, ctx("ctm-async")));
    expectSameGeometry(first.geometry, inline(a));
    expect(exec.jobs).toBe(0);

    // The curve moved: the job goes to the worker, the old tube stays up.
    const shown = first.geometry;
    const pending = tubeOf(CURVE_TO_MESH_NODE.evaluate({ curve: b }, params, ctx("ctm-async")));
    expect(pending).toBe(first);
    expect(pending.geometry).toBe(shown);

    await exec.flush();
    const landed = tubeOf(CURVE_TO_MESH_NODE.evaluate({ curve: b }, params, ctx("ctm-async")));
    expect(landed).toBe(first);
    expectSameGeometry(landed.geometry, inline(b));
    expect(exec.jobs).toBe(1);
  });

  it("sweeps inline while capturing", () => {
    setJobExecutor(new CloningExecutor());
    const a = new THREE.CatmullRomCurve3(pts);
    const b = new THREE.CatmullRomCurve3(pts.map((p) => p.clone().setY(-p.y)));
    CURVE_TO_MESH_NODE.evaluate({ curve: a }, params, ctx("ctm-capture"));
    const out = tubeOf(CURVE_TO_MESH_NODE.evaluate({ curve: b }, params, { ...ctx("ctm-capture"), capturing: true }));
    expectSameGeometry(out.geometry, createVariableThicknessTubeGeometry(b, 64, 12, 0.15, params.profile as ProfilePoint[], false, 0.05, 1, true));
  });

  it("sweeps a curve it cannot serialize inline, as before", () => {
    class Custom extends THREE.Curve<THREE.Vector3> {
      constructor(private k: number) {
        super();
      }
      getPoint(t: number, target = new THREE.Vector3()) {
        return target.set(t * 4, Math.sin(t * this.k), 0);
      }
    }
    setJobExecutor(new CloningExecutor());
    const curve = new Custom(3);
    const out = tubeOf(CURVE_TO_MESH_NODE.evaluate({ curve }, params, ctx("ctm-custom")));
    expectSameGeometry(out.geometry, createVariableThicknessTubeGeometry(curve, 64, 12, 0.15, params.profile as ProfilePoint[], false, 0.05, 1, true));
  });
});
