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

  test("loads with sculpted data on the very first evaluation", () => {
    const ctx = { nodeId: "sculpt_test_4" };
    const probe = SCULPT_NODE.evaluate({}, { ...SCULPT_NODE.defaultParams, baseResolution: 0 }, { nodeId: "sculpt_probe" } as any);
    const m = probe.geometry as THREE.Mesh;
    const positions = Array.from(m.geometry.attributes.position.array as Float32Array);
    const indices = Array.from(m.geometry.index!.array as Uint32Array);
    positions[1] += 3;
    const out = SCULPT_NODE.evaluate(
      {},
      { ...SCULPT_NODE.defaultParams, baseResolution: 0, sculptMesh: { positions, indices } },
      ctx as any,
    );
    expect((out.geometry as THREE.Mesh).geometry.attributes.position.array[1]).toBeCloseTo(positions[1], 4);
  });

  test("Reset (sculptMesh back to null) restores the base mesh", () => {
    const ctx = { nodeId: "sculpt_test_5" };
    const base = SCULPT_NODE.evaluate({}, { ...SCULPT_NODE.defaultParams, baseResolution: 0 }, ctx as any);
    const mesh = base.geometry as THREE.Mesh;
    const original = Array.from(mesh.geometry.attributes.position.array as Float32Array);
    const positions = original.slice();
    positions[1] += 5;
    const indices = Array.from(mesh.geometry.index!.array as Uint32Array);
    SCULPT_NODE.evaluate({}, { ...SCULPT_NODE.defaultParams, baseResolution: 0, sculptMesh: { positions, indices } }, ctx as any);
    const out = SCULPT_NODE.evaluate({}, { ...SCULPT_NODE.defaultParams, baseResolution: 0, sculptMesh: null }, ctx as any);
    expect((out.geometry as THREE.Mesh).geometry.attributes.position.array[1]).toBeCloseTo(original[1], 4);
  });

  test("a wired Geometry input replaces the primitive as the base mesh", () => {
    const ctx = { nodeId: "sculpt_test_6" };
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2, 3, 3, 3));
    const out = SCULPT_NODE.evaluate({ geometry: box }, { ...SCULPT_NODE.defaultParams }, ctx as any);
    const mesh = out.geometry as THREE.Mesh;
    // 4x4x4 lattice surface = 56 welded vertices.
    expect(mesh.geometry.attributes.position.count).toBe(56);
  });

  test("cube primitive starts fine enough to sculpt at the default level", () => {
    const out = SCULPT_NODE.evaluate({}, { ...SCULPT_NODE.defaultParams, primitive: "cube" }, { nodeId: "sculpt_test_7" } as any);
    expect((out.geometry as THREE.Mesh).geometry.attributes.position.count).toBeGreaterThan(200);
  });
});
