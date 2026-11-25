import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { EvalContext, NodeDefinition } from "../types";
import { createQuadBox, createQuadSphere, type PolyMesh } from "../quadMesh";
import { polyMeshToGeometry, readPolyMesh } from "../mesh/polyIO";
import { readAttribute, setAttribute } from "../mesh/polyAttributes";
import { sampleSdf, sdfInsideVolume } from "../mesh/sdfGrid";
import {
  MESH_TO_SDF_NODE,
  POINTS_TO_SDF_NODE,
  SDF_COMBINE_NODE,
  SDF_NOISE_NODE,
  SDF_OFFSET_NODE,
  SDF_SMOOTH_NODE,
  SDF_TO_MESH_NODE,
  VOLUME_NODES,
  VOXEL_REMESH_NODE,
  readSdfGrid,
} from "./volumeNodes";

let n = 0;
const ctx = (): EvalContext => ({ time: 0, step: 0, nodeId: `vol-${n++}` });
const meshObj = (m: PolyMesh) => new THREE.Mesh(polyMeshToGeometry(m), new THREE.MeshStandardMaterial());

function run(def: NodeDefinition, inputs: Record<string, unknown>, params: Record<string, unknown> = {}, c = ctx()) {
  return def.evaluate(inputs, { ...def.defaultParams, ...params }, c);
}
const polyOf = (o: unknown) => readPolyMesh(o as THREE.Object3D)!.mesh;

describe("volume nodes", () => {
  it("are all modeling nodes under volume/", () => {
    expect(VOLUME_NODES).toHaveLength(8);
    for (const def of VOLUME_NODES) {
      expect(def.category).toBe("modeling");
      expect(def.type.startsWith("volume/")).toBe(true);
    }
  });

  it("sphere: mesh to SDF to mesh lands near the radius", () => {
    const sdf = run(MESH_TO_SDF_NODE, { geometry: meshObj(createQuadSphere(1, 8)) }, { resolution: 24 });
    const grid = readSdfGrid(sdf.geometry)!;
    expect(grid).toBeTruthy();
    expect(sampleSdf(grid, 0, 0, 0)).toBeLessThan(-0.8);
    const out = run(SDF_TO_MESH_NODE, { geometry: sdf.geometry }, { relax: 2 });
    const mesh = polyOf(out.geometry);
    expect(readSdfGrid(out.geometry)).toBeNull();
    expect(mesh.faces.length).toBeGreaterThan(50);
    expect(mesh.faces.every((f) => f.length === 4)).toBe(true);
    // The quad sphere's flat faces sit slightly inside the unit radius.
    for (const p of mesh.positions) expect(Math.abs(Math.hypot(...p) - 0.98)).toBeLessThan(0.08);
  });

  it("points to SDF from a vector list and pscale", () => {
    const out = run(POINTS_TO_SDF_NODE, { points: [new THREE.Vector3(0, 0, 0), new THREE.Vector3(3, 0, 0)] }, { radius: 0.5, resolution: 32 });
    expect(out.count).toBe(2);
    const grid = readSdfGrid(out.geometry)!;
    // Trilinear across the cone tip at the centre reads a little shallow.
    expect(sampleSdf(grid, 3, 0, 0)).toBeLessThan(-0.4);

    let pts: PolyMesh = { positions: [[0, 0, 0], [2, 0, 0]], faces: [] };
    pts = setAttribute(pts, "point", "pscale", "float", [1, 2]);
    const scaled = run(POINTS_TO_SDF_NODE, { geometry: meshObj(pts) }, { radius: 0.25, resolution: 32 });
    const g2 = readSdfGrid(scaled.geometry)!;
    expect(sampleSdf(g2, 0, 0, 0)).toBeCloseTo(-0.25, 1);
    expect(sampleSdf(g2, 2, 0, 0)).toBeCloseTo(-0.5, 1);
  });

  it("combine: union grows, subtract shrinks, poses respected", () => {
    const a = run(POINTS_TO_SDF_NODE, { points: [new THREE.Vector3(0, 0, 0)] }, { radius: 1, sizing: "voxel", voxel: 0.1 }).geometry;
    const b = run(POINTS_TO_SDF_NODE, { points: [new THREE.Vector3(1, 0, 0)] }, { radius: 1, sizing: "voxel", voxel: 0.1 }).geometry;
    const va = sdfInsideVolume(readSdfGrid(a)!);
    const u = sdfInsideVolume(readSdfGrid(run(SDF_COMBINE_NODE, { geometry: a, b }, { operation: "union" }).geometry)!);
    const s = sdfInsideVolume(readSdfGrid(run(SDF_COMBINE_NODE, { geometry: a, b }, { operation: "subtract" }).geometry)!);
    expect(u).toBeGreaterThan(va * 1.4);
    expect(s).toBeLessThan(va * 0.8);

    // B posed far away: the union is two separate balls (twice the volume).
    const sphere = meshObj(createQuadSphere(0.5, 6));
    const moved = meshObj(createQuadSphere(0.5, 6));
    moved.position.set(5, 0, 0);
    const far = run(SDF_COMBINE_NODE, { geometry: sphere, b: moved }, { operation: "union", resolution: 24 });
    const gFar = readSdfGrid(far.geometry)!;
    expect(sampleSdf(gFar, 5, 0, 0)).toBeLessThan(0);
    expect(sampleSdf(gFar, 2.5, 0, 0)).toBeGreaterThan(0);
  });

  it("offset, smooth, noise keep a grid and stay finite", () => {
    const a = run(POINTS_TO_SDF_NODE, { points: [new THREE.Vector3(0, 0, 0)] }, { radius: 1, resolution: 24 }).geometry;
    const off = readSdfGrid(run(SDF_OFFSET_NODE, { geometry: a }, { distance: 0.3 }).geometry)!;
    expect(sampleSdf(off, 1.3, 0, 0)).toBeCloseTo(0, 1);
    const sm = readSdfGrid(run(SDF_SMOOTH_NODE, { geometry: a }, { iterations: 2 }).geometry)!;
    expect(sm.values.every(Number.isFinite)).toBe(true);
    const nz = run(SDF_NOISE_NODE, { geometry: a }, { amplitude: 0.1 });
    expect(readSdfGrid(nz.geometry)!.values.every(Number.isFinite)).toBe(true);
    expect(polyOf(nz.geometry).faces.length).toBeGreaterThan(0);
  });

  it("accepts a plain mesh where an SDF is expected", () => {
    const out = run(SDF_OFFSET_NODE, { geometry: meshObj(createQuadBox(1, 1, 1)) }, { distance: 0.1, resolution: 24 });
    const grid = readSdfGrid(out.geometry)!;
    expect(sampleSdf(grid, 0.55, 0, 0)).toBeLessThan(0);
    expect(sampleSdf(grid, 0.65, 0, 0)).toBeGreaterThan(0);
  });

  it("voxel remesh keeps the bounds and carries attributes", () => {
    let box = createQuadBox(1, 2, 1);
    box = setAttribute(box, "point", "heat", "float", box.positions.map((p) => p[1]));
    const out = run(VOXEL_REMESH_NODE, { geometry: meshObj(box) }, { voxel: 0.1, relax: 1 });
    const mesh = polyOf(out.geometry);
    expect(mesh.faces.length).toBeGreaterThan(100);
    const b = new THREE.Box3().setFromPoints(mesh.positions.map((p) => new THREE.Vector3(...p)));
    expect(b.max.y).toBeCloseTo(1, 1);
    expect(b.min.y).toBeCloseTo(-1, 1);
    expect(b.max.x).toBeCloseTo(0.5, 1);
    const heat = readAttribute(mesh, "point", "heat")!;
    const top = mesh.positions.findIndex((p) => p[1] > 0.9);
    expect(heat.values[top]).toBeCloseTo(1, 5);
  });

  it("memoises on the input signature", () => {
    const c = ctx();
    const input = meshObj(createQuadSphere(1, 6));
    const first = readSdfGrid(run(MESH_TO_SDF_NODE, { geometry: input }, { resolution: 16 }, c).geometry);
    const second = readSdfGrid(run(MESH_TO_SDF_NODE, { geometry: input }, { resolution: 16 }, c).geometry);
    expect(second).toBe(first);
    const third = readSdfGrid(run(MESH_TO_SDF_NODE, { geometry: input }, { resolution: 20 }, c).geometry);
    expect(third).not.toBe(first);
  });
});
