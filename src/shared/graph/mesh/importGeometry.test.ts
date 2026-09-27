import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { bufferGeometryToQuadMesh } from "../quadMesh";
import { validateQuadMesh } from "./validate";

const counts = (faces: number[][]) => ({
  quads: faces.filter((f) => f.length === 4).length,
  tris: faces.filter((f) => f.length === 3).length,
});

describe("bufferGeometryToQuadMesh (import)", () => {
  it("rebuilds a UV sphere as quads, triangles only at the poles", () => {
    // Nearly coplanar pairs only, taken in Map order, used to leave most of
    // a sphere as triangles.
    const mesh = bufferGeometryToQuadMesh(new THREE.SphereGeometry(1, 16, 12));
    expect(counts(mesh.faces)).toEqual({ quads: 16 * 10, tris: 32 });
    const report = validateQuadMesh(mesh);
    expect(report.errors).toEqual([]);
    expect(report.inconsistentEdges).toBe(0);
  });

  it("rebuilds a subdivided plane as a clean quad grid", () => {
    const mesh = bufferGeometryToQuadMesh(new THREE.PlaneGeometry(2, 2, 4, 4));
    expect(counts(mesh.faces)).toEqual({ quads: 16, tris: 0 });
    expect(mesh.positions).toHaveLength(25);
  });

  it("welds relative to the object's size", () => {
    // At 1/1000 scale every vertex sits closer than the old fixed 1e-4
    // tolerance to its neighbours, which welded the whole grid into a heap.
    const tiny = new THREE.PlaneGeometry(0.002, 0.002, 4, 4);
    const mesh = bufferGeometryToQuadMesh(tiny);
    expect(mesh.positions).toHaveLength(25);
    expect(counts(mesh.faces).quads).toBe(16);
  });

  it("closes a box, keeps its UV seams and its material groups", () => {
    const mesh = bufferGeometryToQuadMesh(new THREE.BoxGeometry(1, 1, 1));
    expect(mesh.positions).toHaveLength(8);
    expect(counts(mesh.faces)).toEqual({ quads: 6, tris: 0 });
    expect(mesh.faceMaterials?.slice().sort()).toEqual([0, 1, 2, 3, 4, 5]);
    const report = validateQuadMesh(mesh);
    expect(report.errors).toEqual([]);
    expect(report.boundaryEdges).toBe(0);
    // Every face still spans the full 0..1 UV square of its own.
    for (const uvs of mesh.faceUVs!) {
      expect(Math.min(...uvs.map((uv) => uv[0]))).toBeCloseTo(0, 6);
      expect(Math.max(...uvs.map((uv) => uv[0]))).toBeCloseTo(1, 6);
    }
  });

  it("won't pair triangles across a UV seam or a material change", () => {
    const geometry = new THREE.BufferGeometry();
    // Two triangles forming a unit square, non-indexed, sharing the 1–2 diagonal.
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0], 3),
    );
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
    expect(counts(bufferGeometryToQuadMesh(geometry).faces)).toEqual({ quads: 1, tris: 0 });

    const seam = geometry.clone();
    seam.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 5, 5, 6, 6, 5, 6], 2));
    expect(counts(bufferGeometryToQuadMesh(seam).faces)).toEqual({ quads: 0, tris: 2 });

    const twoMaterials = geometry.clone();
    twoMaterials.addGroup(0, 3, 0);
    twoMaterials.addGroup(3, 3, 1);
    const mesh = bufferGeometryToQuadMesh(twoMaterials);
    expect(counts(mesh.faces)).toEqual({ quads: 0, tris: 2 });
    expect(mesh.faceMaterials).toEqual([0, 1]);
  });

  it("is deterministic", () => {
    const a = bufferGeometryToQuadMesh(new THREE.SphereGeometry(1, 12, 8));
    const b = bufferGeometryToQuadMesh(new THREE.SphereGeometry(1, 12, 8));
    expect(a.faces).toEqual(b.faces);
  });
});
