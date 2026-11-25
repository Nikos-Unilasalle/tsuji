import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { EvalContext, NodeDefinition } from "../types";
import { createQuadBox, createQuadPlane, createQuadSphere, type PolyMesh } from "../quadMesh";
import { polyMeshToGeometry, readPolyMesh } from "../mesh/polyIO";
import { readAttribute, setAttribute } from "../mesh/polyAttributes";
import {
  COPY_TO_POINTS_NODE,
  GEODESIC_DISTANCE_NODE,
  HEIGHTFIELD_ERODE_NODE,
  LSYSTEM_NODE,
  PROCEDURAL_NODES,
  RAY_PROJECT_NODE,
} from "./proceduralNodes";

let n = 0;
const ctx = (): EvalContext => ({ time: 0, step: 0, nodeId: `proc-${n++}` });
const meshObj = (m: PolyMesh) => new THREE.Mesh(polyMeshToGeometry(m), new THREE.MeshStandardMaterial());
const run = (def: NodeDefinition, inputs: Record<string, unknown>, params: Record<string, unknown> = {}) =>
  def.evaluate(inputs, { ...def.defaultParams, ...params }, ctx());
const polyOf = (o: unknown) => readPolyMesh(o as THREE.Object3D)!.mesh;

describe("procedural nodes", () => {
  it("are modeling nodes", () => {
    expect(PROCEDURAL_NODES.map((d) => d.type)).toEqual([
      "modeling/ray-project",
      "modeling/copy-to-points",
      "modeling/l-system",
      "modeling/heightfield-erode",
      "modeling/geodesic-distance",
    ]);
    for (const d of PROCEDURAL_NODES) expect(d.category).toBe("modeling");
  });

  it("shrinkwrap puts every point on the sphere", () => {
    const out = run(RAY_PROJECT_NODE, { geometry: meshObj(createQuadBox(3, 3, 3)), target: meshObj(createQuadSphere(1, 12)) }, { mode: "nearest" });
    const mesh = polyOf(out.geometry);
    expect(out.hits).toBe(8);
    for (const p of mesh.positions) expect(Math.hypot(...p)).toBeGreaterThan(0.97), expect(Math.hypot(...p)).toBeLessThan(1.001);
    const hit = readAttribute(mesh, "point", "hit")!.values;
    expect(Array.from(hit).every((v) => v === 1)).toBe(true);
    expect(readAttribute(mesh, "point", "hitdist")!.values[0]).toBeGreaterThan(1);
  });

  it("projects along a direction and reports misses", () => {
    const grid = createQuadPlane(4, 4, 4, 4);
    const flat = [0, 1, 2].find((k) => grid.positions.every((p) => Math.abs(p[k]) < 1e-9))!;
    const dir = new THREE.Vector3();
    dir.setComponent(flat, -1);
    const lifted = meshObj(createQuadPlane(4, 4, 4, 4));
    lifted.position.setComponent(flat, 2);
    lifted.updateMatrix();
    const out = run(RAY_PROJECT_NODE, { geometry: lifted, target: meshObj(createQuadSphere(1, 12)) }, { mode: "direction", direction: dir, bidirectional: false });
    const mesh = polyOf(out.geometry);
    const hit = readAttribute(mesh, "point", "hit")!.values;
    const hits = Array.from(hit).filter(Boolean).length;
    expect(hits).toBeGreaterThan(0);
    expect(hits).toBeLessThan(25);
    // Miss: point unchanged and hitdist -1.
    const miss = Array.from(hit).indexOf(0);
    expect(readAttribute(mesh, "point", "hitdist")!.values[miss]).toBe(-1);
  });

  it("copy to points: count = points × source faces, with copy attribute", () => {
    const target = createQuadPlane(1, 1, 2, 2); // 9 points
    const source = createQuadBox(0.1, 0.1, 0.1); // 6 faces
    const out = run(COPY_TO_POINTS_NODE, { geometry: meshObj(target), source: meshObj(source) });
    const mesh = polyOf(out.geometry);
    expect(out.copies).toBe(9);
    expect(mesh.faces.length).toBe(9 * 6);
    expect(mesh.positions.length).toBe(9 * 8);
    const copy = readAttribute(mesh, "face", "copy")!.values;
    expect(copy[0]).toBe(0);
    expect(copy[6 * 8]).toBe(8);
  });

  it("copy to points: variants, pscale and target attributes", () => {
    let target: PolyMesh = { positions: [[0, 0, 0], [5, 0, 0], [10, 0, 0]], faces: [] };
    target = setAttribute(target, "point", "variant", "int", [0, 1, 0]);
    target = setAttribute(target, "point", "pscale", "float", [1, 2, 1]);
    target = setAttribute(target, "point", "heat", "float", [0.1, 0.2, 0.3]);
    const box = createQuadBox(1, 1, 1);
    const tri: PolyMesh = { positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]] };
    const out = run(
      COPY_TO_POINTS_NODE,
      { geometry: meshObj(target), source: meshObj(box), sources: [meshObj(tri)] },
      { orient: "none", copyAttributes: true },
    );
    const mesh = polyOf(out.geometry);
    expect(mesh.faces.length).toBe(6 + 1 + 6);
    const xs = mesh.positions.filter((_, i) => readAttribute(mesh, "point", "copy")!.values[i] === 1).map((p) => p[0]);
    expect(Math.max(...xs)).toBeCloseTo(7, 6); // triangle scaled by pscale 2 at x = 5
    const heat = readAttribute(mesh, "point", "heat")!.values;
    expect(heat[mesh.positions.length - 1]).toBeCloseTo(0.3, 6);
  });

  it("L-system builds tubes and a skeleton", () => {
    const out = run(LSYSTEM_NODE, {}, { axiom: "F", rules: "F=F[+F]F", iterations: 2, angle: 30, sides: 4, caps: false });
    expect(out.segments).toBe(9);
    const tubes = polyOf(out.geometry);
    expect(tubes.faces.length).toBe(9 * 4);
    expect(readAttribute(tubes, "point", "depth")).toBeTruthy();
    expect(String(out.string)).toBe("F[+F]F[+F[+F]F]F[+F]F");
    const skel = (out.skeleton as THREE.Mesh).geometry.userData.quadMesh as PolyMesh;
    expect(skel.edges!.length).toBe(9);
  });

  it("heightfield erode lowers peaks, keeps the vertex count, writes flow/sediment", () => {
    const grid = createQuadPlane(4, 4, 20, 20);
    const flat = [0, 1, 2].find((k) => grid.positions.every((p) => Math.abs(p[k]) < 1e-9))!;
    const positions = grid.positions.map((p) => {
      const q = [...p] as [number, number, number];
      q[flat] = Math.max(0, 1.2 - Math.hypot(p[(flat + 1) % 3], p[(flat + 2) % 3]));
      return q;
    });
    const input = { ...grid, positions };
    const out = run(HEIGHTFIELD_ERODE_NODE, { geometry: meshObj(input) }, { up: "xyz"[flat], iterations: 3, droplets: 200 });
    const mesh = polyOf(out.geometry);
    expect(mesh.positions.length).toBe(positions.length);
    const peak = Math.max(...positions.map((p) => p[flat]));
    expect(Math.max(...mesh.positions.map((p) => p[flat]))).toBeLessThan(peak);
    expect(readAttribute(mesh, "point", "flow")).toBeTruthy();
    expect(readAttribute(mesh, "point", "sediment")).toBeTruthy();
  });

  it("geodesic distance on a plane ≈ euclidean", () => {
    const plane = createQuadPlane(2, 2, 16, 16);
    const center = plane.positions.findIndex((p) => Math.hypot(...p) < 1e-9);
    const out = run(GEODESIC_DISTANCE_NODE, { geometry: meshObj(plane) }, { group: String(center), name: "d" });
    const mesh = polyOf(out.geometry);
    const d = readAttribute(mesh, "point", "d")!.values;
    mesh.positions.forEach((p, i) => {
      const r = Math.hypot(...p);
      if (r > 0.3 && r < 0.9) expect(Math.abs(d[i] - r) / r).toBeLessThan(0.15);
    });
    expect(out.maxDistance).toBeGreaterThan(1.2);
  });
});
