import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { EvalContext } from "../types";
import { RIDGE_LAYERS_NODE, SCATTER_ON_CURVES_NODE, STRATA_HATCH_NODE } from "./strata";
import { CURVE_FILL_NODE, INK_STROKE_NODE } from "./ink";
import { INSTANCE_ON_POINTS_NODE } from "./instanceOnPoints";
import { valueNoise3 } from "../../math/valueNoise";

const ctx = (nodeId: string): EvalContext => ({ time: 0, step: 0, nodeId });

function allFinite(geometry: THREE.BufferGeometry): boolean {
  return Array.from(geometry.getAttribute("position").array as Float32Array).every(Number.isFinite);
}

describe("valueNoise3", () => {
  test("stays in Processing's range and is deterministic", () => {
    for (let i = 0; i < 500; i++) {
      const n = valueNoise3(i * 0.37 - 40, i * 0.11, i * 0.05);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(0.94);
      expect(valueNoise3(i * 0.37 - 40, i * 0.11, i * 0.05)).toBe(n);
    }
  });

  test("bad input gives 0, not NaN", () => {
    expect(valueNoise3(NaN, 1, 2)).toBe(0);
    expect(valueNoise3(Infinity)).toBe(0);
  });
});

describe("RIDGE_LAYERS_NODE", () => {
  const params = RIDGE_LAYERS_NODE.defaultParams;

  test("unconnected: one peak stack whose outline sits on the baseline at its ends", () => {
    const out = RIDGE_LAYERS_NODE.evaluate({}, params, ctx("ridge-a"));
    const stacks = out.stacks as THREE.Curve<THREE.Vector3>[][];
    expect(stacks).toHaveLength(1);
    expect(stacks[0]).toHaveLength(10);
    const outline = (out.outlines as THREE.Curve<THREE.Vector3>[])[0];
    expect(Math.abs(outline.getPoint(0).y)).toBeLessThan(0.05);
    expect(Math.abs(outline.getPoint(1).y)).toBeLessThan(0.05);
    expect(Math.max(...outline.getPoints(50).map((p) => p.y))).toBeGreaterThan(0.2);
  });

  test("one stack per anchor, carried to the anchor's position and depth", () => {
    const anchors = [new THREE.Vector3(-10, 1, -3), new THREE.Vector3(10, -1, 2)];
    const out = RIDGE_LAYERS_NODE.evaluate({ anchors, scales: [1, 0.5] }, params, ctx("ridge-b"));
    const outlines = out.outlines as THREE.Curve<THREE.Vector3>[];
    expect(out.count).toBe(2);
    expect(outlines[0].getPoint(0.5).x).toBeCloseTo(-10, 0);
    expect(outlines[1].getPoint(0.5).z).toBe(2);
    expect((out.layers as unknown[]).length).toBe(20);
  });

  test("same inputs hand back the same lists", () => {
    const a = RIDGE_LAYERS_NODE.evaluate({}, params, ctx("ridge-c"));
    const b = RIDGE_LAYERS_NODE.evaluate({}, params, ctx("ridge-c"));
    expect(b.stacks).toBe(a.stacks);
  });

  test("plateau tops are clipped flat", () => {
    const out = RIDGE_LAYERS_NODE.evaluate({}, { ...params, profile: "plateau", height: 2, chop: 0.5 }, ctx("ridge-d"));
    const ys = (out.outlines as THREE.Curve<THREE.Vector3>[])[0].getPoints(100).map((p) => p.y);
    expect(Math.max(...ys)).toBeLessThanOrEqual(1.0001 + 0.01);
  });
});

describe("STRATA_HATCH_NODE", () => {
  test("threads strokes through each stack", () => {
    const ridge = RIDGE_LAYERS_NODE.evaluate({}, RIDGE_LAYERS_NODE.defaultParams, ctx("hatch-src"));
    const out = STRATA_HATCH_NODE.evaluate({ stacks: ridge.stacks }, { ...STRATA_HATCH_NODE.defaultParams, count: 100 }, ctx("hatch-a"));
    const curves = out.curves as THREE.Curve<THREE.Vector3>[];
    expect(curves.length).toBeGreaterThan(50);
    for (const c of curves) expect(Number.isFinite(c.getPoint(0.5).y)).toBe(true);
  });

  test("nothing wired gives an empty list", () => {
    expect(STRATA_HATCH_NODE.evaluate({}, STRATA_HATCH_NODE.defaultParams, ctx("hatch-b")).curves).toEqual([]);
  });
});

describe("SCATTER_ON_CURVES_NODE", () => {
  const ridge = RIDGE_LAYERS_NODE.evaluate({}, RIDGE_LAYERS_NODE.defaultParams, ctx("scatter-src"));

  test("an open mask keeps every sample in the height band", () => {
    const params = { ...SCATTER_ON_CURVES_NODE.defaultParams, threshold: 10, layerMax: 0, resolution: 20 };
    const out = SCATTER_ON_CURVES_NODE.evaluate({ curves: ridge.stacks }, params, ctx("scatter-a"));
    expect(out.count).toBe(20);
    expect((out.scales as number[]).every((s) => s === 1)).toBe(true);
  });

  test("a closed mask keeps nothing; height band filters", () => {
    const closed = SCATTER_ON_CURVES_NODE.evaluate({ curves: ridge.stacks }, { ...SCATTER_ON_CURVES_NODE.defaultParams, threshold: 0 }, ctx("scatter-b"));
    expect(closed.count).toBe(0);
    const high = SCATTER_ON_CURVES_NODE.evaluate(
      { curves: ridge.stacks },
      { ...SCATTER_ON_CURVES_NODE.defaultParams, threshold: 10, heightMin: 0.5, layerMax: 0, resolution: 20 },
      ctx("scatter-c"),
    );
    expect(high.count).toBeGreaterThan(0);
    expect(high.count).toBeLessThan(20);
  });

  test("offset moves every point", () => {
    const params = { ...SCATTER_ON_CURVES_NODE.defaultParams, threshold: 10, layerMax: 0, offset: new THREE.Vector3(0, 0, -1) };
    const out = SCATTER_ON_CURVES_NODE.evaluate({ curves: ridge.stacks }, params, ctx("scatter-d"));
    expect((out.points as THREE.Vector3[]).every((p) => p.z === -1)).toBe(true);
  });
});

describe("INK_STROKE_NODE", () => {
  const line = new THREE.LineCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 0, 0));

  test("a ribbon two vertices wide along the curve, thin at the ends", () => {
    const out = INK_STROKE_NODE.evaluate({ curve: line }, { ...INK_STROKE_NODE.defaultParams, minWidth: 0 }, ctx("ink-a"));
    const mesh = out.geometry as THREE.Mesh;
    const pos = mesh.geometry.getAttribute("position");
    expect(pos.count % 2).toBe(0);
    expect(pos.count).toBeGreaterThanOrEqual(32);
    expect(allFinite(mesh.geometry)).toBe(true);
    expect(Math.abs(pos.getY(0) - pos.getY(1))).toBeLessThan(1e-6);
    const mid = pos.count / 2;
    expect(Math.abs(pos.getY(mid) - pos.getY(mid + 1))).toBeGreaterThan(0.005);
  });

  test("unchanged curves keep the same geometry, even from a fresh array", () => {
    const a = INK_STROKE_NODE.evaluate({ curves: [line] }, INK_STROKE_NODE.defaultParams, ctx("ink-b")).geometry as THREE.Mesh;
    const geometry = a.geometry;
    const b = INK_STROKE_NODE.evaluate({ curves: [line.clone()] }, INK_STROKE_NODE.defaultParams, ctx("ink-b")).geometry as THREE.Mesh;
    expect(b).toBe(a);
    expect(b.geometry).toBe(geometry);
  });

  test("nothing wired: an empty mesh, no throw", () => {
    const mesh = INK_STROKE_NODE.evaluate({}, INK_STROKE_NODE.defaultParams, ctx("ink-c")).geometry as THREE.Mesh;
    expect(mesh.geometry.getAttribute("position").count).toBe(0);
  });
});

describe("CURVE_FILL_NODE", () => {
  test("fills an open arc, with a skirt when Base Drop is set", () => {
    const arc = new THREE.CatmullRomCurve3([new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)]);
    const plain = CURVE_FILL_NODE.evaluate({ curve: arc }, CURVE_FILL_NODE.defaultParams, ctx("fill-a")).geometry as THREE.Mesh;
    const n = plain.geometry.getAttribute("position").count;
    expect(plain.geometry.getIndex()!.count / 3).toBe(n - 2);
    const skirt = CURVE_FILL_NODE.evaluate({ curve: arc }, { ...CURVE_FILL_NODE.defaultParams, baseDrop: 0.5 }, ctx("fill-b")).geometry as THREE.Mesh;
    const pos = skirt.geometry.getAttribute("position");
    expect(pos.count).toBe(n + 2);
    expect(pos.getY(pos.count - 1)).toBeCloseTo(-0.5);
  });
});

describe("INSTANCE_ON_POINTS_NODE", () => {
  test("merges one copy per point and shares the source material", () => {
    const material = new THREE.MeshBasicMaterial();
    const source = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(5, 0, 0), new THREE.Vector3(0, 5, 0)];
    const out = INSTANCE_ON_POINTS_NODE.evaluate({ geometry: source, points }, INSTANCE_ON_POINTS_NODE.defaultParams, ctx("iop-a"));
    const mesh = (out.geometry as THREE.Group).children[0] as THREE.Mesh;
    expect(out.count).toBe(3);
    expect(mesh.material).toBe(material);
    expect(mesh.geometry.getAttribute("position").count).toBe(12);
    expect(mesh.geometry.getIndex()!.count).toBe(18);
    mesh.geometry.computeBoundingBox();
    expect(mesh.geometry.boundingBox!.max.x).toBeCloseTo(5.5);
  });

  test("no points wired: a single copy at the origin", () => {
    const source = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
    const out = INSTANCE_ON_POINTS_NODE.evaluate({ geometry: source }, INSTANCE_ON_POINTS_NODE.defaultParams, ctx("iop-b"));
    expect(((out.geometry as THREE.Group).children[0] as THREE.Mesh).geometry.getAttribute("position").count).toBe(4);
  });
});

describe("integration with the rest of Tsuji", () => {
  test("Ink Stroke draws a ground (XZ) curve flat on the ground, not on its edge", () => {
    const ground = new THREE.LineCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -2));
    const mesh = INK_STROKE_NODE.evaluate({ curve: ground }, INK_STROKE_NODE.defaultParams, ctx("int-a")).geometry as THREE.Mesh;
    const pos = mesh.geometry.getAttribute("position");
    const mid = pos.count / 2;
    expect(Math.abs(pos.getX(mid) - pos.getX(mid + 1))).toBeGreaterThan(0.005);
    expect(Math.abs(pos.getY(mid) - 0.002)).toBeLessThan(1e-6);
  });

  test("Ink Stroke owns a native pose and hands back its matrix; a live gizmo drag is left alone", () => {
    const line = new THREE.LineCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0));
    const params = { ...INK_STROKE_NODE.defaultParams, location: new THREE.Vector3(3, 0, 0) };
    const out = INK_STROKE_NODE.evaluate({ curve: line }, params, ctx("int-b"));
    expect((out.matrix as THREE.Matrix4).elements[12]).toBe(3);
    const mesh = out.geometry as THREE.Mesh;
    mesh.matrix.makeTranslation(9, 0, 0);
    INK_STROKE_NODE.evaluate({ curve: line }, params, { ...ctx("int-b"), liveEditNodeId: "int-b" });
    expect(mesh.matrix.elements[12]).toBe(9);
  });

  test("a wired Material sets the ink colour and opacity", () => {
    const line = new THREE.LineCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0));
    const material = { color: new THREE.Color(0xff0000), opacity: 0.25 };
    const mesh = CURVE_FILL_NODE.evaluate({ curve: line, material }, CURVE_FILL_NODE.defaultParams, ctx("int-c")).geometry as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshBasicMaterial
    >;
    expect(mesh.material.color.getHex()).toBe(0xff0000);
    expect(mesh.material.opacity).toBe(0.25);
    expect(mesh.material.transparent).toBe(true);
  });

  test("Ridge Layers: its pose moves the curves it hands on, and its preview carries that pose", () => {
    const params = { ...RIDGE_LAYERS_NODE.defaultParams, location: new THREE.Vector3(10, 0, -2) };
    const out = RIDGE_LAYERS_NODE.evaluate({}, params, ctx("int-d"));
    const outline = (out.outlines as THREE.Curve<THREE.Vector3>[])[0];
    expect(outline.getPoint(0.5).x).toBeCloseTo(10, 0);
    expect(outline.getPoint(0.5).z).toBeCloseTo(-2);
    const preview = out.geometry as THREE.LineSegments;
    expect(preview.userData.isHelper).toBe(true);
    expect(preview.userData.nodeId).toBe("int-d");
    expect(preview.matrix.elements[12]).toBe(10);
    preview.geometry.computeBoundingBox();
    expect(Math.abs(preview.geometry.boundingBox!.getCenter(new THREE.Vector3()).x)).toBeLessThan(0.5);
  });

  test("Scatter reads height in a ground drawing's own plane", () => {
    const params = { ...RIDGE_LAYERS_NODE.defaultParams, rotation: new THREE.Vector3(-Math.PI / 2, 0, 0) };
    const ridge = RIDGE_LAYERS_NODE.evaluate({}, params, ctx("int-e"));
    const out = SCATTER_ON_CURVES_NODE.evaluate(
      { curves: ridge.stacks },
      { ...SCATTER_ON_CURVES_NODE.defaultParams, threshold: 10, heightMin: 0.5, layerMax: 0, resolution: 20 },
      ctx("int-e2"),
    );
    expect(out.count).toBeGreaterThan(0);
    expect(out.count).toBeLessThan(20);
  });

  test("Instance on Points: vector rotations are Euler degrees, like Instance Transform", () => {
    const source = new THREE.Mesh(new THREE.PlaneGeometry(2, 0.01), new THREE.MeshBasicMaterial());
    const out = INSTANCE_ON_POINTS_NODE.evaluate(
      { geometry: source, points: [new THREE.Vector3()], rotations: [new THREE.Vector3(0, 0, 90)] },
      INSTANCE_ON_POINTS_NODE.defaultParams,
      ctx("int-f"),
    );
    const geometry = ((out.geometry as THREE.Group).children[0] as THREE.Mesh).geometry;
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.max.y).toBeCloseTo(1);
    expect(geometry.boundingBox!.max.x).toBeCloseTo(0.005);
  });
});
