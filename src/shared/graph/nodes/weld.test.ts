import * as THREE from "three";
import { beforeAll, describe, expect, test } from "vitest";
import { WELD_NODE, weldGeometries } from "./weld";
import { EvalContext } from "../types";
import { initBvhRaycast } from "../../three/bvh";

const CTX = { time: 0, step: 0, nodeId: "test" } as EvalContext;

const PARAMS = WELD_NODE.defaultParams as Record<string, unknown>;

// The distance sampler queries a MeshBVH, which lives on the prototype patch
// main.tsx installs at startup.
beforeAll(() => initBvhRaycast());

function sphereMesh(x: number, radius = 0.8): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 16));
  mesh.position.x = x;
  mesh.updateMatrixWorld(true);
  return mesh;
}

function bounds(geometry: THREE.BufferGeometry): THREE.Box3 {
  geometry.computeBoundingBox();
  return geometry.boundingBox!;
}

/** How far the surface reaches from the X axis in the plane the two shapes cross. */
function waist(geometry: THREE.BufferGeometry, tolerance: number): number {
  const position = geometry.getAttribute("position");
  let max = 0;
  for (let i = 0; i < position.count; i++) {
    if (Math.abs(position.getX(i)) > tolerance) continue;
    max = Math.max(max, Math.hypot(position.getY(i), position.getZ(i)));
  }
  return max;
}

describe("weldGeometries", () => {
  const a = new THREE.SphereGeometry(0.8, 24, 16).translate(-0.5, 0, 0);
  const b = new THREE.SphereGeometry(0.8, 24, 16).translate(0.5, 0, 0);

  test("welds two spheres into one closed surface spanning both", () => {
    const { geometry } = weldGeometries(a, b, { blend: 0.4, resolution: 32, operation: "add", relax: 0 });
    const box = bounds(geometry);
    expect(geometry.getAttribute("position").count).toBeGreaterThan(200);
    expect(box.min.x).toBeLessThan(-1.2);
    expect(box.max.x).toBeGreaterThan(1.2);
    // The fillet adds material at the seam, it must not inflate the silhouette.
    expect(box.max.y).toBeLessThan(0.95);
  });

  test("blend widens the seam a hard union leaves creased", () => {
    const hard = weldGeometries(a, b, { blend: 0, resolution: 32, operation: "add", relax: 0 });
    const soft = weldGeometries(a, b, { blend: 0.5, resolution: 32, operation: "add", relax: 0 });
    expect(waist(soft.geometry, soft.grid.spacing)).toBeGreaterThan(waist(hard.geometry, hard.grid.spacing) + 0.05);
  });

  test("subtract removes the second shape", () => {
    const { geometry } = weldGeometries(a, b, { blend: 0.2, resolution: 32, operation: "subtract", relax: 0 });
    const box = bounds(geometry);
    expect(box.min.x).toBeLessThan(-1.2);
    // Everything right of the second sphere's leading edge is gone.
    expect(box.max.x).toBeLessThan(0.3);
  });

  test("intersect keeps only the overlap", () => {
    const { geometry } = weldGeometries(a, b, { blend: 0.2, resolution: 32, operation: "intersect", relax: 0 });
    const box = bounds(geometry);
    expect(box.min.x).toBeGreaterThan(-0.5);
    expect(box.max.x).toBeLessThan(0.5);
  });

  test("the result carries UVs, so a textured material still draws", () => {
    const { geometry } = weldGeometries(a, b, { blend: 0.3, resolution: 24, operation: "add", relax: 0 });
    const uv = geometry.getAttribute("uv");
    expect(uv.count).toBe(geometry.getAttribute("position").count);
    for (let i = 0; i < uv.count; i++) {
      expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getX(i)).toBeLessThanOrEqual(1);
    }
  });
});

describe("WELD_NODE", () => {
  test("with nothing wired in it produces nothing", () => {
    expect(WELD_NODE.evaluate({}, PARAMS, CTX).geometry).toBeNull();
  });

  test("with only the first shape it passes that shape straight through", () => {
    const mesh = sphereMesh(0);
    expect(WELD_NODE.evaluate({ geometry: mesh }, PARAMS, CTX).geometry).toBe(mesh);
  });

  test("a non-mesh second input leaves the first untouched", () => {
    const mesh = sphereMesh(0);
    const points = new THREE.Points(new THREE.BufferGeometry());
    expect(WELD_NODE.evaluate({ geometry: mesh, weld: points }, PARAMS, CTX).geometry).toBe(mesh);
  });

  test("two overlapping meshes come back as one welded mesh, posed at the origin", () => {
    const inputs = { geometry: sphereMesh(-0.5), weld: sphereMesh(0.5), blend: 0.4 };
    const params = { ...PARAMS, resolution: 24 };
    const out = WELD_NODE.evaluate(inputs, params, { ...CTX, nodeId: "weld-pair" }).geometry as THREE.Mesh;

    expect(out.isMesh).toBe(true);
    expect(out.geometry.getAttribute("position").count).toBeGreaterThan(100);
    expect(out.matrixAutoUpdate).toBe(false);
    expect(out.matrix.equals(new THREE.Matrix4())).toBe(true);
    // The source meshes were baked in world space, so the weld spans both.
    const box = bounds(out.geometry);
    expect(box.min.x).toBeLessThan(-1.2);
    expect(box.max.x).toBeGreaterThan(1.2);
  });

  test("unchanged inputs hand back the same mesh and the same geometry", () => {
    const inputs = { geometry: sphereMesh(-0.5), weld: sphereMesh(0.5), blend: 0.4 };
    const params = { ...PARAMS, resolution: 24 };
    const ctx = { ...CTX, nodeId: "weld-cache" };
    const first = WELD_NODE.evaluate(inputs, params, ctx).geometry as THREE.Mesh;
    const geometry = first.geometry;
    const second = WELD_NODE.evaluate(inputs, params, ctx).geometry as THREE.Mesh;
    expect(second).toBe(first);
    expect(second.geometry).toBe(geometry);
  });

  test("changing the blend rebuilds", () => {
    const params = { ...PARAMS, resolution: 24 };
    const ctx = { ...CTX, nodeId: "weld-rebuild" };
    const a = sphereMesh(-0.5);
    const b = sphereMesh(0.5);
    const first = WELD_NODE.evaluate({ geometry: a, weld: b, blend: 0.2 }, params, ctx).geometry as THREE.Mesh;
    const geometry = first.geometry;
    const second = WELD_NODE.evaluate({ geometry: a, weld: b, blend: 0.6 }, params, ctx).geometry as THREE.Mesh;
    expect(second).toBe(first);
    expect(second.geometry).not.toBe(geometry);
  });

  test("the default params produce a finite, non-empty result", () => {
    const out = WELD_NODE.evaluate(
      { geometry: sphereMesh(-0.5), weld: sphereMesh(0.5) },
      PARAMS,
      { ...CTX, nodeId: "weld-defaults" },
    ).geometry as THREE.Mesh;
    const position = out.geometry.getAttribute("position");
    expect(position.count).toBeGreaterThan(0);
    for (let i = 0; i < position.count * 3; i++) {
      expect(Number.isFinite((position.array as Float32Array)[i])).toBe(true);
    }
  });
});
