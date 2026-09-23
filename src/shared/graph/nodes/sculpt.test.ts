import { describe, test, expect } from "vitest";
import * as THREE from "three";
import { SCULPT_NODE } from "./sculpt";

describe("SCULPT_NODE", () => {
  test("evaluates to a mesh tagged isSculpt with base primitive geometry", () => {
    const ctx = { nodeId: "sculpt_test_1" };
    const out = SCULPT_NODE.evaluate({}, { ...SCULPT_NODE.defaultParams, primitive: "sphere", size: 2, baseResolution: 1 }, ctx as any);
    expect(out.geometry).toBeInstanceOf(THREE.Mesh);
    const mesh = out.geometry as THREE.Mesh;
    expect(mesh.userData.isSculpt).toBe(true);
    expect(mesh.geometry.attributes.position.count).toBeGreaterThan(0);
    expect(mesh.userData.sculptMeshData.positions.length).toBe(mesh.geometry.attributes.position.count * 3);
  });

  test("rebuilds when primitive changes and there's no sculpted data yet", () => {
    const ctx = { nodeId: "sculpt_test_2" };
    const params1 = { ...SCULPT_NODE.defaultParams, primitive: "sphere", baseResolution: 1 };
    const out1 = SCULPT_NODE.evaluate({}, params1, ctx as any);
    const countSphere = (out1.geometry as THREE.Mesh).geometry.attributes.position.count;

    const params2 = { ...SCULPT_NODE.defaultParams, primitive: "cube", baseResolution: 2 };
    const out2 = SCULPT_NODE.evaluate({}, params2, ctx as any);
    const countCube = (out2.geometry as THREE.Mesh).geometry.attributes.position.count;

    expect(countCube).not.toBe(countSphere);
  });

  test("syncs a committed sculptMesh param into the live geometry", () => {
    const ctx = { nodeId: "sculpt_test_3" };
    const base = SCULPT_NODE.evaluate({}, { ...SCULPT_NODE.defaultParams, baseResolution: 0 }, ctx as any);
    const mesh = base.geometry as THREE.Mesh;
    const positions = Array.from(mesh.geometry.attributes.position.array as Float32Array);
    const indices = Array.from((mesh.geometry.index!.array as Uint32Array));
    // Bump one vertex, simulate a committed stroke.
    positions[1] += 5;
    const committed = {
      ...SCULPT_NODE.defaultParams,
      baseResolution: 0,
      sculptMesh: { positions, indices },
    };
    const out = SCULPT_NODE.evaluate({}, committed, ctx as any);
    const outMesh = out.geometry as THREE.Mesh;
    expect(outMesh.geometry.attributes.position.array[1]).toBeCloseTo(positions[1], 4);
  });
});
