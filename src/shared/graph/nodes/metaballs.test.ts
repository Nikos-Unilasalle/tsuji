import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { METABALLS_NODE } from "./metaballs";
import { EvalContext } from "../types";

function ctx(nodeId: string): EvalContext {
  return { time: 0, step: 0, nodeId, simulationEpoch: 0 };
}

function run(
  inputs: Record<string, unknown>,
  nodeId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const params = { ...(METABALLS_NODE.defaultParams as Record<string, unknown>), ...overrides };
  return METABALLS_NODE.evaluate(inputs, params, ctx(nodeId));
}

function meshOf(out: Record<string, unknown>): THREE.Mesh {
  return out.geometry as THREE.Mesh;
}

function vertexCount(out: Record<string, unknown>): number {
  return meshOf(out).geometry.drawRange.count;
}

function bounds(out: Record<string, unknown>): THREE.Box3 {
  const geometry = meshOf(out).geometry;
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const box = new THREE.Box3();
  for (let i = 0; i < geometry.drawRange.count; i++) {
    box.expandByPoint(new THREE.Vector3(position.getX(i), position.getY(i), position.getZ(i)));
  }
  return box;
}

describe("METABALLS_NODE", () => {
  test("one ball meshes a blob centred on the point", () => {
    const out = run({ points: [new THREE.Vector3(2, 1, -1)] }, "mb-one");
    expect(vertexCount(out)).toBeGreaterThan(0);
    expect(out.count).toBe(1);

    const center = bounds(out).getCenter(new THREE.Vector3());
    expect(center.x).toBeCloseTo(2, 1);
    expect(center.y).toBeCloseTo(1, 1);
    expect(center.z).toBeCloseTo(-1, 1);
  });

  test("radius sets the size of the blob in world units", () => {
    const small = run({ points: [new THREE.Vector3(0, 0, 0)] }, "mb-small", { radius: 0.5 });
    const smallSize = bounds(small).getSize(new THREE.Vector3()).x;
    const big = run({ points: [new THREE.Vector3(0, 0, 0)] }, "mb-big", { radius: 1.5 });
    const bigSize = bounds(big).getSize(new THREE.Vector3()).x;

    expect(smallSize).toBeGreaterThan(0.5);
    expect(smallSize).toBeLessThan(1.6);
    expect(bigSize).toBeGreaterThan(smallSize * 2);
  });

  test("two near points fuse into one blob, far ones stay separate", () => {
    const near = run({ points: [new THREE.Vector3(-0.3, 0, 0), new THREE.Vector3(0.3, 0, 0)] }, "mb-near");
    const far = run({ points: [new THREE.Vector3(-6, 0, 0), new THREE.Vector3(6, 0, 0)] }, "mb-far");

    // The fused pair is wider than tall; two islands 12 apart are far wider still.
    const nearBox = bounds(near).getSize(new THREE.Vector3());
    expect(nearBox.x).toBeGreaterThan(nearBox.y);
    expect(nearBox.x).toBeLessThan(3);
    expect(bounds(far).getSize(new THREE.Vector3()).x).toBeGreaterThan(11);
  });

  test("a geometry wire uses its children as centres", () => {
    const group = new THREE.Group();
    for (const x of [-0.4, 0.4]) {
      const child = new THREE.Mesh(new THREE.SphereGeometry(0.1), new THREE.MeshStandardMaterial());
      child.position.set(x, 0, 0);
      group.add(child);
    }
    group.updateMatrixWorld(true);

    const out = run({ geometry: group }, "mb-geom");
    expect(out.count).toBe(2);
    expect(vertexCount(out)).toBeGreaterThan(0);
  });

  test("no centres wired gives an empty mesh, not a throw", () => {
    const out = run({}, "mb-empty");
    expect(out.count).toBe(0);
    expect(vertexCount(out)).toBe(0);
    expect(meshOf(out).geometry.getAttribute("position").count).toBe(0);
  });

  test("returns the same mesh and geometry every evaluation", () => {
    const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.5, 0, 0)];
    const first = run({ points }, "mb-identity");
    const second = run({ points }, "mb-identity");
    expect(second.geometry).toBe(first.geometry);
    expect(meshOf(second).geometry).toBe(meshOf(first).geometry);
  });

  test("moving a centre moves the mesh", () => {
    const before = run({ points: [new THREE.Vector3(0, 0, 0)] }, "mb-move");
    const beforeX = bounds(before).getCenter(new THREE.Vector3()).x;
    const after = run({ points: [new THREE.Vector3(3, 0, 0)] }, "mb-move");
    expect(bounds(after).getCenter(new THREE.Vector3()).x).toBeGreaterThan(beforeX + 2);
  });

  test("garbage in the point list is skipped, not meshed", () => {
    const out = run({ points: [null, "nope", { x: 0, y: 0, z: 0 }, new THREE.Vector3(NaN, 0, 0)] }, "mb-garbage");
    expect(out.count).toBe(1);
    expect(Number.isFinite(bounds(out).getCenter(new THREE.Vector3()).x)).toBe(true);
  });

  test("extreme params stay finite", () => {
    const points = [new THREE.Vector3(0, 0, 0)];
    for (const overrides of [
      { radius: 0 },
      { radius: -5 },
      { smooth: 1 },
      { smooth: 0 },
      { smooth: 1000 },
      { resolution: 0 },
      { resolution: 10000 },
      { autoFit: false, fieldSize: 0 },
    ]) {
      const out = run({ points }, `mb-extreme-${JSON.stringify(overrides)}`, overrides);
      const position = meshOf(out).geometry.getAttribute("position") as THREE.BufferAttribute;
      // One assertion for the whole buffer: a per-float expect() on a 96³
      // field is hundreds of thousands of them, which is seconds of runtime.
      let allFinite = true;
      for (let i = 0; i < position.count * 3; i++) {
        if (!Number.isFinite(position.array[i])) allFinite = false;
      }
      expect(allFinite, `non-finite vertex with ${JSON.stringify(overrides)}`).toBe(true);
    }
  });
});
