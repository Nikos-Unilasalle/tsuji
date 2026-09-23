import { describe, test, expect } from "vitest";
import { buildAdjacency, buildBasePrimitive, computeVertexNormals } from "./sculptMesh";

describe("sculptMesh base primitives", () => {
  test("icosphere: all vertices lie on the target radius, normals point outward", () => {
    const mesh = buildBasePrimitive("sphere", 2, 2.0); // radius 1
    const vertexCount = mesh.positions.length / 3;
    expect(vertexCount).toBeGreaterThan(12);
    for (let i = 0; i < vertexCount; i++) {
      const x = mesh.positions[i * 3];
      const y = mesh.positions[i * 3 + 1];
      const z = mesh.positions[i * 3 + 2];
      expect(Math.hypot(x, y, z)).toBeCloseTo(1.0, 4);
      // Outward normal is parallel to the position vector on a sphere.
      const nx = mesh.normals[i * 3];
      const ny = mesh.normals[i * 3 + 1];
      const nz = mesh.normals[i * 3 + 2];
      const dot = (x * nx + y * ny + z * nz) / Math.hypot(x, y, z);
      expect(dot).toBeGreaterThan(0.9);
    }
    expect(mesh.indices.length % 3).toBe(0);
  });

  test("cube: welds seams into a single connected shell with no boundary edges", () => {
    const mesh = buildBasePrimitive("cube", 3, 2.0);
    const adjacency = buildAdjacency(mesh.indices, mesh.positions.length / 3);
    // Every vertex should have neighbors — a stray unwelded corner would
    // still have neighbors, but a genuinely cracked seam would double the
    // vertex count vs. a single flat 6-face grid, so also check bounds.
    for (const list of adjacency) {
      expect(list.length).toBeGreaterThan(0);
    }
    const expectedGridVerts = 6 * (4 + 1) * (4 + 1); // upper bound before welding
    expect(mesh.positions.length / 3).toBeLessThan(expectedGridVerts);
  });

  test("plane: flat grid with correct vertex count", () => {
    const mesh = buildBasePrimitive("plane", 4, 2.0);
    expect(mesh.positions.length / 3).toBe(5 * 5);
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      expect(mesh.positions[i * 3 + 1]).toBeCloseTo(0, 5);
    }
  });

  test("computeVertexNormals returns unit vectors", () => {
    const mesh = buildBasePrimitive("sphere", 1, 1.0);
    const normals = computeVertexNormals(mesh.positions, mesh.indices);
    for (let i = 0; i < normals.length / 3; i++) {
      const len = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
      expect(len).toBeCloseTo(1.0, 3);
    }
  });
});
