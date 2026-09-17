import * as THREE from "three";
import { beforeAll, describe, expect, test } from "vitest";
import { initBvhRaycast } from "../../three/bvh";
import {
  buildLinesGeometry,
  buildRibbonGeometry,
  buildTubesGeometry,
  interpolateRings,
  ringsToCurves,
  ringsToPointLists,
  scanMeshRings,
} from "../../three/meshScanlines";
import { EvalContext } from "../types";
import { CONTOUR_SCAN_NODE } from "./contourScan";

const CTX = { time: 0, step: 0, nodeId: "contour-scan-test" } as EvalContext;

beforeAll(() => {
  initBvhRaycast();
});

describe("meshScanlines", () => {
  test("scanMeshRings slices a sphere into radial rings", () => {
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16));
    sphere.updateMatrixWorld(true);

    const result = scanMeshRings(sphere, {
      numRings: 16,
      samplesPerRing: 32,
      axis: "y",
    });

    expect(result.numRings).toBe(16);
    expect(result.samplesPerRing).toBe(32);
    expect(result.rings.length).toBe(16);
    expect(result.rings[0].length).toBe(32 * 3);

    // Mid ring (equator) should have radius close to 1
    const equatorRing = result.rings[8];
    const r0 = Math.hypot(equatorRing[0], equatorRing[2]);
    expect(r0).toBeGreaterThan(0.85);
    expect(r0).toBeLessThan(1.05);

    // Every ring should be marked active for a solid sphere
    expect(result.actives.some((a) => a)).toBe(true);
  });

  test("interpolateRings interpolates between two ring sets with stagger and bulge", () => {
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16));
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));

    const scanA = scanMeshRings(sphere, { numRings: 8, samplesPerRing: 16, axis: "y" });
    const scanB = scanMeshRings(box, { numRings: 8, samplesPerRing: 16, axis: "y" });

    // Progress 0 matches A
    const rings0 = interpolateRings(scanA, scanB, { progress: 0 });
    expect(rings0[4][0]).toBeCloseTo(scanA.rings[4][0], 4);

    // Progress 1 matches B
    const rings1 = interpolateRings(scanA, scanB, { progress: 1 });
    expect(rings1[4][0]).toBeCloseTo(scanB.rings[4][0], 4);

    // Mid-progress with bulge expands outward
    const ringsMidNoBulge = interpolateRings(scanA, scanB, { progress: 0.5, bulge: 0, stagger: 0 });
    const ringsMidWithBulge = interpolateRings(scanA, scanB, { progress: 0.5, bulge: 0.5, stagger: 0 });

    const radiusFlat = Math.hypot(ringsMidNoBulge[4][0], ringsMidNoBulge[4][2]);
    const radiusBulged = Math.hypot(ringsMidWithBulge[4][0], ringsMidWithBulge[4][2]);
    expect(radiusBulged).toBeGreaterThan(radiusFlat);
  });

  test("buildRibbonGeometry creates quad strip mesh with outward normals", () => {
    const rings = [
      new Float32Array([1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, -1]),
      new Float32Array([1, 1, 0, 0, 1, 1, -1, 1, 0, 0, 1, -1]),
    ];
    const geom = buildRibbonGeometry(rings, 0.1, "y");

    expect(geom.getAttribute("position")).toBeDefined();
    expect(geom.getAttribute("normal")).toBeDefined();
    expect(geom.getAttribute("uv")).toBeDefined();
    expect(geom.getIndex()).toBeDefined();

    // Outward normal at vertex at (1, 0, 0): normal.x should be positive (> 0)
    const nx = geom.getAttribute("normal").getX(0);
    expect(nx).toBeGreaterThan(0.5);

    // 2 rings * 4 samples * 2 vertices = 16 vertices
    expect(geom.getAttribute("position").count).toBe(16);
    // 2 rings * 4 quads * 6 indices = 48 indices
    expect(geom.getIndex()!.count).toBe(48);
  });

  test("buildRibbonGeometry respects flipNormals", () => {
    const rings = [
      new Float32Array([1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, -1]),
    ];
    const geomFlipped = buildRibbonGeometry(rings, 0.1, "y", true);
    const nx = geomFlipped.getAttribute("normal").getX(0);
    expect(nx).toBeLessThan(-0.5);
  });

  test("buildLinesGeometry creates indexed line segments", () => {
    const rings = [
      new Float32Array([1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, -1]),
    ];
    const geom = buildLinesGeometry(rings);

    expect(geom.getAttribute("position").count).toBe(4);
    // 4 segments * 2 indices = 8 indices
    expect(geom.getIndex()!.count).toBe(8);
  });

  test("buildTubesGeometry creates merged tubes geometry", () => {
    const rings = [
      new Float32Array([1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, -1]),
    ];
    const geom = buildTubesGeometry(rings, 0.05, 4);
    expect(geom.getAttribute("position").count).toBeGreaterThan(0);
  });

  test("ringsToCurves converts rings to closed CatmullRomCurve3 instances", () => {
    const rings = [
      new Float32Array([1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, -1]),
    ];
    const curves = ringsToCurves(rings);
    expect(curves.length).toBe(1);
    expect(curves[0]).toBeInstanceOf(THREE.CatmullRomCurve3);
    expect(curves[0].closed).toBe(true);
    expect(curves[0].points.length).toBe(4);
  });

  test("ringsToPointLists converts rings to Vector3 arrays", () => {
    const rings = [
      new Float32Array([1, 2, 3, 4, 5, 6]),
    ];
    const lists = ringsToPointLists(rings);
    expect(lists.length).toBe(1);
    expect(lists[0].length).toBe(2);
    expect(lists[0][0]).toEqual(new THREE.Vector3(1, 2, 3));
    expect(lists[0][1]).toEqual(new THREE.Vector3(4, 5, 6));
  });
});

describe("CONTOUR_SCAN_NODE", () => {
  const PARAMS = CONTOUR_SCAN_NODE.defaultParams as Record<string, unknown>;

  test("dynamicOutputs reveals curves and curve sockets when style is curves", () => {
    const outputsRibbons = CONTOUR_SCAN_NODE.dynamicOutputs!([], [], { style: "ribbons" });
    expect(outputsRibbons.map((s) => s.id)).toEqual(["geometry", "matrix"]);

    const outputsCurves = CONTOUR_SCAN_NODE.dynamicOutputs!([], [], { style: "curves" });
    expect(outputsCurves.map((s) => s.id)).toEqual(["geometry", "curves", "curve", "matrix"]);
  });

  test("evaluates single mesh into ribbon geometry and curves output", () => {
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16));
    const result = CONTOUR_SCAN_NODE.evaluate(
      { geometry: sphere },
      { ...PARAMS, numRings: 12, samplesPerRing: 24, style: "ribbons" },
      CTX,
    );

    expect(result.geometry).toBeInstanceOf(THREE.Mesh);
    const mesh = result.geometry as THREE.Mesh;
    expect(mesh.geometry.getAttribute("position").count).toBe(12 * 24 * 2);

    expect(Array.isArray(result.curves)).toBe(true);
    const curves = result.curves as THREE.CatmullRomCurve3[];
    expect(curves.length).toBe(12);
    expect(curves[0]).toBeInstanceOf(THREE.CatmullRomCurve3);
  });

  test("evaluates with curves style", () => {
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16));
    const result = CONTOUR_SCAN_NODE.evaluate(
      { geometry: sphere },
      { ...PARAMS, numRings: 8, samplesPerRing: 16, style: "curves" },
      { ...CTX, nodeId: "contour-scan-curves" },
    );

    expect(result.geometry).toBeInstanceOf(THREE.LineSegments);
    expect(Array.isArray(result.curves)).toBe(true);
    const curves = result.curves as THREE.CatmullRomCurve3[];
    expect(curves.length).toBe(8);
    expect(result.curve).toBeInstanceOf(THREE.CatmullRomCurve3);
  });

  test("evaluates with lines style", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const result = CONTOUR_SCAN_NODE.evaluate(
      { geometry: box },
      { ...PARAMS, numRings: 8, samplesPerRing: 16, style: "lines" },
      { ...CTX, nodeId: "contour-scan-lines" },
    );

    expect(result.geometry).toBeInstanceOf(THREE.LineSegments);
    const line = result.geometry as THREE.LineSegments;
    expect(line.geometry.getIndex()!.count).toBe(8 * 16 * 2);
  });

  test("evaluates with morph target and progress", () => {
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16));
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));

    const result = CONTOUR_SCAN_NODE.evaluate(
      { geometry: sphere, target: box, progress: 0.5 },
      { ...PARAMS, numRings: 10, samplesPerRing: 20, style: "ribbons", bulge: 0.4 },
      { ...CTX, nodeId: "contour-scan-morph" },
    );

    expect(result.geometry).toBeInstanceOf(THREE.Mesh);
    const mesh = result.geometry as THREE.Mesh;
    expect(mesh.geometry.getAttribute("position").count).toBe(10 * 20 * 2);
  });

  test("gracefully handles null geometry input", () => {
    const result = CONTOUR_SCAN_NODE.evaluate(
      { geometry: null },
      PARAMS,
      { ...CTX, nodeId: "contour-scan-null" },
    );
    expect(result.geometry).toBeNull();
    expect(result.curves).toEqual([]);
  });

  test("dynamicOutputs reveals curves and curve sockets when style is 'curves'", () => {
    const defaultOutputs = CONTOUR_SCAN_NODE.dynamicOutputs!([], [], { style: "ribbons" });
    expect(defaultOutputs.map((s) => s.id)).toEqual(["geometry", "matrix"]);

    const curveOutputs = CONTOUR_SCAN_NODE.dynamicOutputs!([], [], { style: "curves" });
    expect(curveOutputs.map((s) => s.id)).toEqual(["geometry", "curves", "curve", "matrix"]);
  });

  test("dynamicOutputs reveals curves socket when connected as curves or curve", () => {
    const connOutputs = CONTOUR_SCAN_NODE.dynamicOutputs!(
      [{ id: "e1", fromNode: "scan", fromSocket: "curves", toNode: "other", toSocket: "in" }],
      [],
      { style: "ribbons" },
    );
    expect(connOutputs.map((s) => s.id)).toEqual(["geometry", "curves", "curve", "matrix"]);
  });
});
