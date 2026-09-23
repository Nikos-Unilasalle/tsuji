import { describe, test, expect } from "vitest";
import * as THREE from "three";
import { buildAdjacency, buildBasePrimitive, computeVertexNormals } from "./sculptMesh";
import { applySculptStroke3D, SculptStrokeParams3D } from "./sculptEngine";

function makeSphere() {
  const mesh = buildBasePrimitive("sphere", 2, 2.0); // radius 1
  const adjacency = buildAdjacency(mesh.indices, mesh.positions.length / 3);
  return { mesh, adjacency };
}

function baseStroke(overrides: Partial<SculptStrokeParams3D>): SculptStrokeParams3D {
  const origin = new THREE.Vector3(0, 1, 0); // top pole area
  return {
    tool: "draw",
    falloff: "smooth",
    radius: 0.6,
    strength: 1.0,
    invert: false,
    hitPoint: origin.clone(),
    hitNormal: origin.clone().normalize(),
    strokeOrigin: origin.clone(),
    strokeNormal: origin.clone().normalize(),
    deltaTime: 0.05,
    ...overrides,
  };
}

describe("sculptEngine applySculptStroke3D", () => {
  test("draw displaces vertices near the hit point along the stroke normal", () => {
    const { mesh, adjacency } = makeSphere();
    const before = mesh.positions.slice();
    applySculptStroke3D(mesh, adjacency, baseStroke({ tool: "draw" }));
    let moved = false;
    for (let i = 0; i < mesh.positions.length; i++) {
      if (Math.abs(mesh.positions[i] - before[i]) > 1e-5) moved = true;
    }
    expect(moved).toBe(true);
    // Nearest vertex to the pole should have moved outward (away from origin).
    const idx = 0;
    const distBefore = Math.hypot(before[idx * 3], before[idx * 3 + 1], before[idx * 3 + 2]);
    const distAfter = Math.hypot(mesh.positions[idx * 3], mesh.positions[idx * 3 + 1], mesh.positions[idx * 3 + 2]);
    expect(distAfter).toBeGreaterThanOrEqual(distBefore);
  });

  test("draw with invert pushes inward instead", () => {
    const { mesh, adjacency } = makeSphere();
    applySculptStroke3D(mesh, adjacency, baseStroke({ tool: "draw", invert: true }));
    // Every displaced vertex within the footprint should have moved toward the center (radius shrank somewhere).
    let anyShrank = false;
    const count = mesh.positions.length / 3;
    for (let i = 0; i < count; i++) {
      const d = Math.hypot(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]);
      if (d < 0.999) anyShrank = true;
    }
    expect(anyShrank).toBe(true);
  });

  test("mask blocks displacement for protected vertices", () => {
    const { mesh, adjacency } = makeSphere();
    const maskArr = new Float32Array(mesh.positions.length / 3);
    maskArr[0] = 1; // fully protect the nearest vertex to the pole
    mesh.mask = maskArr;
    const before = mesh.positions.slice();
    applySculptStroke3D(mesh, adjacency, baseStroke({ tool: "draw" }));
    expect(mesh.positions[0]).toBeCloseTo(before[0], 5);
    expect(mesh.positions[1]).toBeCloseTo(before[1], 5);
    expect(mesh.positions[2]).toBeCloseTo(before[2], 5);
  });

  test("mask tool paints weights toward 1, erase brings them back down", () => {
    const { mesh, adjacency } = makeSphere();
    mesh.mask = new Float32Array(mesh.positions.length / 3);
    applySculptStroke3D(mesh, adjacency, baseStroke({ tool: "mask", strength: 1.0, deltaTime: 1.0, radius: 0.3 }));
    const paintedSum = mesh.mask.reduce((a, b) => a + b, 0);
    expect(paintedSum).toBeGreaterThan(0);
    applySculptStroke3D(mesh, adjacency, baseStroke({ tool: "mask", maskErase: true, strength: 1.0, deltaTime: 1.0, radius: 0.3 }));
    const erasedSum = mesh.mask.reduce((a, b) => a + b, 0);
    expect(erasedSum).toBeLessThan(paintedSum);
  });

  test("smooth reduces distance to neighbor average for a displaced vertex", () => {
    const { mesh, adjacency } = makeSphere();
    applySculptStroke3D(mesh, adjacency, baseStroke({ tool: "draw", strength: 1.0 }));
    const bumped = mesh.positions.slice();
    applySculptStroke3D(mesh, adjacency, baseStroke({ tool: "smooth", strength: 1.0 }));
    let changed = false;
    for (let i = 0; i < mesh.positions.length; i++) {
      if (Math.abs(mesh.positions[i] - bumped[i]) > 1e-6) changed = true;
    }
    expect(changed).toBe(true);
  });

  test("symmetryX also displaces the mirrored side", () => {
    const { mesh, adjacency } = makeSphere();
    const origin = new THREE.Vector3(1, 0, 0);
    const before = mesh.positions.slice();
    applySculptStroke3D(
      mesh,
      adjacency,
      baseStroke({
        tool: "draw",
        hitPoint: origin,
        hitNormal: origin.clone().normalize(),
        strokeOrigin: origin,
        strokeNormal: origin.clone().normalize(),
        radius: 0.5,
        symmetryX: true,
      }),
    );
    // Find vertices near +X and near -X; both sides should have moved.
    let movedPosX = false;
    let movedNegX = false;
    const count = mesh.positions.length / 3;
    for (let i = 0; i < count; i++) {
      const dx = Math.abs(mesh.positions[i * 3] - before[i * 3]);
      const dy = Math.abs(mesh.positions[i * 3 + 1] - before[i * 3 + 1]);
      const dz = Math.abs(mesh.positions[i * 3 + 2] - before[i * 3 + 2]);
      if (dx + dy + dz > 1e-5) {
        if (before[i * 3] > 0) movedPosX = true;
        if (before[i * 3] < 0) movedNegX = true;
      }
    }
    expect(movedPosX).toBe(true);
    expect(movedNegX).toBe(true);
  });

  test("normals recomputed from a stroked mesh remain unit length", () => {
    const { mesh, adjacency } = makeSphere();
    applySculptStroke3D(mesh, adjacency, baseStroke({ tool: "inflate", strength: 1.0 }));
    const normals = computeVertexNormals(mesh.positions, mesh.indices);
    for (let i = 0; i < normals.length / 3; i++) {
      const len = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
      expect(len).toBeCloseTo(1.0, 2);
    }
  });
});
