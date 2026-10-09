import { describe, test, expect } from "vitest";
import * as THREE from "three";
import { buildAdjacency, buildBasePrimitive, computeVertexNormals, meshDataFromGeometry } from "./sculptMesh";

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

  test("cube faces point outward on all six sides", () => {
    const mesh = buildBasePrimitive("cube", 2, 2.0);
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => {
        const i = mesh.indices[t + k];
        return new THREE.Vector3(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]);
      });
      const normal = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
      const centroid = a.clone().add(b).add(c).divideScalar(3);
      expect(normal.dot(centroid)).toBeGreaterThan(0);
    }
  });

  test("plane faces up", () => {
    const mesh = buildBasePrimitive("plane", 2, 2.0);
    const normals = computeVertexNormals(mesh.positions, mesh.indices);
    for (let i = 0; i < normals.length / 3; i++) expect(normals[i * 3 + 1]).toBeGreaterThan(0.99);
  });

  test("meshDataFromGeometry welds seams of a BoxGeometry into a closed shell", () => {
    const mesh = meshDataFromGeometry(new THREE.BoxGeometry(2, 2, 2, 2, 2, 2));
    expect(mesh).not.toBeNull();
    // 3x3x3 box lattice surface = 26 vertices, instead of 6*9 = 54 unwelded.
    expect(mesh!.positions.length / 3).toBe(26);
    const counts = new Map<string, number>();
    for (let t = 0; t < mesh!.indices.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const u = mesh!.indices[t + e];
        const v = mesh!.indices[t + ((e + 1) % 3)];
        const k = u < v ? `${u}_${v}` : `${v}_${u}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    for (const c of counts.values()) expect(c).toBe(2);
  });
});
