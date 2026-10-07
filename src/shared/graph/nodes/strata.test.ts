import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { EvalContext } from "../types";
import { SCATTER_ON_CURVES_NODE, STRATA_HATCH_NODE } from "./strata";
import { RIDGE_LAYERS_NODE } from "./silhouetteLayers";
import { CURVE_FILL_NODE, INK_STROKE_NODE } from "./ink";
import { INSTANCE_ON_POINTS_NODE } from "./instanceOnPoints";
import { valueNoise3 } from "../../math/valueNoise";
import { createPRNG } from "../../math/random";
import { deserializeProject } from "../storage";

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

  test("Clip the Top caps every shape at the clip height", () => {
    const out = RIDGE_LAYERS_NODE.evaluate({}, { ...params, envelope: "bell", clipTop: true, height: 2, chop: 0.5 }, ctx("ridge-d"));
    for (const layer of out.layers as THREE.CatmullRomCurve3[]) {
      expect(Math.max(...layer.points.map((p) => p.y))).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  test("a drawn envelope shapes the silhouette", () => {
    const flatTop = [{ x: 0, y: 1 }, { x: 1, y: 1 }];
    const out = RIDGE_LAYERS_NODE.evaluate({}, { ...params, envelope: "curve", envelopeCurve: flatTop, layers: 1, frequency: 0 }, ctx("ridge-e"));
    // Frequency 0 reads one noise value everywhere, so a flat envelope gives a level line.
    const ys = (out.outlines as THREE.CatmullRomCurve3[])[0].points.map((p) => p.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1e-9);
  });
});

/**
 * The four formulas Ridge Layers hard-coded before it became generic, copied
 * verbatim. Files saved then carry only `profile`; upgradeParams has to spell
 * each one out so exactly that the drawing does not move by a hair.
 */
function legacyStack(profile: string, anchor: THREE.Vector3, width: number, height: number, layers: number, resolution: number, frequency: number, shrink: number, drop: number, chop: number, noiseSeed: number, rng: () => number): THREE.Vector3[][] {
  const stack: THREE.Vector3[][] = [];
  let sink = 0;
  for (let j = 0; j < layers; j++) {
    sink += rng() * drop;
    const p = 1 - (j / layers) * shrink;
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < resolution; i++) {
      const t = i / (resolution - 1);
      let x = (t - 0.5) * width;
      let y = 0;
      if (profile === "peak") {
        const a = (t - 0.5) * Math.PI;
        y = Math.cos(a) * valueNoise3(a * frequency + 10, j * 0.15, noiseSeed) * height * p;
        x *= p;
      } else if (profile === "plateau") {
        const a = (t - 0.5) * Math.PI;
        y = (Math.cos(a * 2) + 1) * valueNoise3(a * frequency + 10, j * 0.1, noiseSeed) * height * p;
        y = Math.min(y, height * chop);
        x *= p;
      } else if (profile === "range") {
        y = valueNoise3(x * 0.5 * frequency, j * 0.3, noiseSeed) * Math.sqrt(Math.sin(Math.PI * t)) * height * p;
        x *= p;
      } else {
        y = (valueNoise3(x * frequency, j * 0.5, noiseSeed) - 0.47) * height;
      }
      points.push(new THREE.Vector3(anchor.x + x, anchor.y + y - sink, anchor.z));
    }
    stack.push(points);
  }
  return stack;
}

describe("Silhouette Layers reads files saved as Ridge Layers", () => {
  // The Shan Shui demo's four landforms, as they were saved.
  const saved: Record<string, unknown>[] = [
    { profile: "peak", width: 6, height: 4.8, frequency: 1, shrink: 1, drop: 0.03, chop: 0.55, layers: 10, resolution: 50, sizeJitter: 0.35, seed: 4 },
    { profile: "range", width: 20, height: 4.3, frequency: 1.825, shrink: 0, drop: 0, layers: 1, resolution: 120, sizeJitter: 0.23063, seed: 8 },
    { profile: "plateau", width: 9, height: 1, frequency: 1, shrink: 0.6, drop: 0.04, chop: 0.6, layers: 5, resolution: 50, sizeJitter: 0.25, seed: 12 },
    { profile: "flat", width: 13.375, height: 1.725, frequency: 0.275, shrink: 0, drop: 0.09, chop: 4.75, layers: 10, resolution: 160, sizeJitter: 0.05137, seed: 30 },
    { profile: "flat", width: 4, height: 1, shrink: 0.8, layers: 4, resolution: 30, seed: 2 },
  ];
  const anchors = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(7, -1, -3)];
  const scales = [1, 0.6];

  for (const old of saved) {
    test(`${old.profile} (seed ${old.seed}) draws exactly what it did`, () => {
      const params = { ...RIDGE_LAYERS_NODE.defaultParams, ...RIDGE_LAYERS_NODE.upgradeParams!({ ...old }) };
      const out = RIDGE_LAYERS_NODE.evaluate({ anchors, scales }, params, ctx(`legacy-${old.profile}-${old.seed}`));
      const p = { ...RIDGE_LAYERS_NODE.defaultParams, ...old } as Record<string, number>;
      const seed = p.seed;
      anchors.forEach((anchor, m) => {
        const rng = createPRNG(seed * 7919 + m * 104729 + 1);
        const w = p.width * scales[m] * (1 + p.sizeJitter * (rng() * 2 - 1));
        const h = p.height * scales[m] * (1 + p.sizeJitter * (rng() * 2 - 1));
        const expected = legacyStack(String(old.profile), anchor, w, h, p.layers, p.resolution, p.frequency, p.shrink, p.drop, p.chop, seed * 13.7 + m * 3.17, rng);
        const actual = (out.stacks as THREE.CatmullRomCurve3[][])[m].map((c) => c.points);
        expect(actual.length).toBe(expected.length);
        actual.forEach((layer, j) => layer.forEach((pt, i) => expect(pt.distanceTo(expected[j][i])).toBeLessThan(1e-9)));
      });
    });
  }

  test("upgrading leaves params already in the new shape alone", () => {
    const current = { ...RIDGE_LAYERS_NODE.defaultParams, envelope: "dome", height: 7 };
    expect(RIDGE_LAYERS_NODE.upgradeParams!(current)).toBe(current);
  });

  test("a loaded file is upgraded, inside groups too", () => {
    const file = JSON.stringify({
      canvases: [{
        nodes: [
          { id: "r", type: "curve/ridge-layers", position: { x: 0, y: 0 }, params: { profile: "plateau", height: 1, chop: 0.6 } },
          {
            id: "g", type: "structure/group", position: { x: 0, y: 0 }, params: {},
            subgraph: { nodes: [{ id: "r2", type: "curve/ridge-layers", position: { x: 0, y: 0 }, params: { profile: "range" } }], connections: [] },
          },
        ],
        connections: [],
      }],
      activeCanvas: 0,
    });
    const nodes = deserializeProject(file).canvases[0].nodes;
    expect(nodes[0].params).toMatchObject({ envelope: "bell", height: 2, chop: 0.3, clipTop: true });
    expect(nodes[1].subgraph!.nodes[0].params).toMatchObject({ envelope: "dome", noiseSpace: "world", frequency: 0.5 });
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

  test("a drawn width curve sets the width along the stroke", () => {
    const params = { ...INK_STROKE_NODE.defaultParams, profile: "curve", profileCurve: [{ x: 0, y: 1 }, { x: 1, y: 1 }], widthNoise: 0, minWidth: 0, width: 0.05 };
    const pos = (INK_STROKE_NODE.evaluate({ curve: line }, params, ctx("ink-d")).geometry as THREE.Mesh).geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i += 2) expect(Math.abs(pos.getY(i) - pos.getY(i + 1))).toBeCloseTo(0.1, 6);
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

  test("Ups lean each copy so its own up follows the direction given", () => {
    // A thin post standing on +Y: its tip shows where the copy's up points.
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.01, 2, 0.01).translate(0, 1, 0), new THREE.MeshBasicMaterial());
    const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0)];
    const ups = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)];
    const out = INSTANCE_ON_POINTS_NODE.evaluate({ geometry: post, points, ups }, INSTANCE_ON_POINTS_NODE.defaultParams, ctx("iop-ups"));
    const pos = ((out.geometry as THREE.Group).children[0] as THREE.Mesh).geometry.getAttribute("position");
    const per = pos.count / 2;
    let leaned = 0, upright = 0;
    for (let v = 0; v < per; v++) leaned = Math.max(leaned, pos.getX(v));
    for (let v = per; v < pos.count; v++) upright = Math.max(upright, pos.getY(v));
    expect(leaned).toBeCloseTo(2, 2);
    expect(upright).toBeCloseTo(2, 2);
  });

  test("copies that only move are rewritten in place, not re-merged", () => {
    const source = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
    const a = INSTANCE_ON_POINTS_NODE.evaluate({ geometry: source, points: [new THREE.Vector3(0, 0, 0)] }, INSTANCE_ON_POINTS_NODE.defaultParams, ctx("iop-move"));
    const geometry = ((a.geometry as THREE.Group).children[0] as THREE.Mesh).geometry;
    const b = INSTANCE_ON_POINTS_NODE.evaluate({ geometry: source, points: [new THREE.Vector3(3, 0, 0)] }, INSTANCE_ON_POINTS_NODE.defaultParams, ctx("iop-move"));
    const moved = ((b.geometry as THREE.Group).children[0] as THREE.Mesh).geometry;
    expect(moved).toBe(geometry);
    moved.computeBoundingBox();
    expect(moved.boundingBox!.min.x).toBeCloseTo(2.5, 6);
    const c = INSTANCE_ON_POINTS_NODE.evaluate({ geometry: source, points: [new THREE.Vector3(), new THREE.Vector3(1, 0, 0)] }, INSTANCE_ON_POINTS_NODE.defaultParams, ctx("iop-move"));
    expect(((c.geometry as THREE.Group).children[0] as THREE.Mesh).geometry.getAttribute("position").count).toBe(8);
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
