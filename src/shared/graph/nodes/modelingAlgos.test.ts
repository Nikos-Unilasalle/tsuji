import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { EvalContext, NodeDefinition } from "../types";
import { createQuadBox, createQuadPlane, createQuadSphere, type PolyMesh } from "../quadMesh";
import { polyMeshToGeometry, readPolyMesh } from "../mesh/polyIO";
import { faceNormals, readAttribute, setAttribute, setGroup } from "../mesh/polyAttributes";
import { buildTopology } from "../mesh/topology";
import { convexHull, decimateMesh, divideFaces, dualMesh } from "../mesh/modelingAlgos";
import { polyNodeStatus } from "./polyModifier";
import {
  BOUNDING_BOX_NODE,
  CONVEX_HULL_NODE,
  DECIMATE_NODE,
  DISPLACE_NODE,
  DIVIDE_NODE,
  DUAL_MESH_NODE,
  EDGE_MARK_NODE,
  KEEP_GROUP_NODE,
  MODELING_ALGO_NODES,
  POKE_NODE,
  SCALE_ELEMENTS_NODE,
  SMOOTH_NODE,
  SORT_NODE,
  TRANSFORM_ELEMENTS_NODE,
} from "./modelingAlgos";

let n = 0;
const ctx = (): EvalContext => ({ time: 0, step: 0, nodeId: `model-${n++}` });
const meshObj = (m: PolyMesh) => new THREE.Mesh(polyMeshToGeometry(m), new THREE.MeshStandardMaterial());

function run(def: NodeDefinition, input: PolyMesh, params: Record<string, unknown> = {}, inputs: Record<string, unknown> = {}) {
  const c = ctx();
  const out = def.evaluate({ geometry: meshObj(input), ...inputs }, { ...def.defaultParams, ...params }, c);
  const mesh = readPolyMesh(out.geometry as THREE.Object3D)!.mesh;
  return { out, mesh, status: polyNodeStatus(c.nodeId) };
}

const values = (m: PolyMesh, domain: "point" | "edge" | "face", name: string) => Array.from(readAttribute(m, domain, name)?.values ?? []);
const sum = (a: number[]) => a.reduce((x, y) => x + (y ? 1 : 0), 0);
/** A box with the top face (+Y) in group "top". */
const boxWithTop = () => {
  const box = createQuadBox();
  const fn = faceNormals(box);
  return setGroup(box, "face", "top", box.faces.map((_, f) => (fn[f * 3 + 1] > 0.9 ? 1 : 0)));
};
const finiteMesh = (m: PolyMesh) => m.positions.every((p) => p.every(Number.isFinite));
const outwardClosed = (m: PolyMesh) => {
  // Every face normal points away from the centroid of a convex closed mesh.
  const c = [0, 0, 0];
  for (const p of m.positions) for (let k = 0; k < 3; k++) c[k] += p[k] / m.positions.length;
  const fn = faceNormals(m);
  return m.faces.every((face, f) => {
    const p = m.positions[face[0]];
    return (p[0] - c[0]) * fn[f * 3] + (p[1] - c[1]) * fn[f * 3 + 1] + (p[2] - c[2]) * fn[f * 3 + 2] > 0;
  });
};

describe("MODELING_ALGO_NODES", () => {
  it("are all modeling/* nodes with a Group field, and survive no input", () => {
    for (const def of MODELING_ALGO_NODES) {
      expect(def.type.startsWith("modeling/")).toBe(true);
      expect(def.category).toBe("modeling");
      expect(def.paramFields?.some((f) => f.id === "group")).toBe(true);
      const out = def.evaluate({}, def.defaultParams ?? {}, ctx());
      expect(out.geometry).toBeNull();
    }
  });
  it("never throw on an empty mesh or an empty group", () => {
    const empty: PolyMesh = { positions: [], faces: [] };
    for (const def of MODELING_ALGO_NODES) {
      expect(() => run(def, empty)).not.toThrow();
      const { mesh } = run(def, createQuadBox(), { group: "nothing_here" });
      expect(finiteMesh(mesh)).toBe(true);
    }
  });
});

describe("Smooth / Relax", () => {
  it("smooths a noisy plane, pins its boundary, and respects the group", () => {
    const plane = createQuadPlane(2, 2, 6, 6);
    const noisy: PolyMesh = { ...plane, positions: plane.positions.map((p, i) => [p[0], p[1], (i * 7919) % 5 === 0 ? 0.3 : 0]) };
    const { mesh } = run(SMOOTH_NODE, noisy, { iterations: 20, strength: 0.5 });
    const maxZ = (m: PolyMesh) => m.positions.reduce((acc, p) => acc + Math.abs(p[2]), 0);
    expect(maxZ(mesh)).toBeLessThan(maxZ(noisy));
    // Boundary points (pinned) didn't move.
    expect(mesh.positions[0]).toEqual(noisy.positions[0]);
    // Group restriction: only point 24 may move.
    const { mesh: one } = run(SMOOTH_NODE, noisy, { group: "24", iterations: 5 });
    one.positions.forEach((p, i) => i !== 24 && expect(p).toEqual(noisy.positions[i]));
  });
  it("Taubin keeps a sphere's volume better than plain Laplacian", () => {
    const sphere = createQuadSphere(1, 6);
    const radius = (m: PolyMesh) => m.positions.reduce((s, p) => s + Math.hypot(...p), 0) / m.positions.length;
    const plain = run(SMOOTH_NODE, sphere, { iterations: 10, strength: 0.5 }).mesh;
    const taubin = run(SMOOTH_NODE, sphere, { iterations: 10, strength: 0.5, preserveVolume: true }).mesh;
    expect(Math.abs(radius(taubin) - 1)).toBeLessThan(Math.abs(radius(plain) - 1));
    const cot = run(SMOOTH_NODE, sphere, { iterations: 5, weighting: "cotangent" }).mesh;
    expect(finiteMesh(cot)).toBe(true);
  });
  it("a weight attribute scales the effect", () => {
    const plane = createQuadPlane(2, 2, 4, 4);
    const bumped: PolyMesh = { ...plane, positions: plane.positions.map((p, i) => [p[0], p[1], i === 12 ? 1 : 0]) };
    const zero = setAttribute(bumped, "point", "w", "float", bumped.positions.map(() => 0));
    expect(run(SMOOTH_NODE, zero, { weightAttr: "w" }).mesh.positions[12][2]).toBe(1);
    expect(run(SMOOTH_NODE, bumped, {}).mesh.positions[12][2]).toBeLessThan(1);
  });
});

describe("Displace", () => {
  it("moves points along their normals, by group", () => {
    const { mesh } = run(DISPLACE_NODE, boxWithTop(), { group: "top", amount: 0.5 });
    // Top face points push out along their (averaged) normals, the bottom stays.
    expect(Math.max(...mesh.positions.map((p) => p[1]))).toBeGreaterThan(0.6);
    expect(Math.min(...mesh.positions.map((p) => p[1]))).toBeCloseTo(-0.5);
  });
  it("along a vector, by attribute, and by noise", () => {
    const plane = createQuadPlane(1, 1, 3, 3);
    const v = run(DISPLACE_NODE, plane, { direction: "vector", vector: new THREE.Vector3(2, 0, 0), amount: 1 }).mesh;
    expect(v.positions[0][0]).toBeCloseTo(plane.positions[0][0] + 1);
    const withH = setAttribute(plane, "point", "h", "float", plane.positions.map((_, i) => i));
    const a = run(DISPLACE_NODE, withH, { source: "attribute", attribute: "h", amount: 0.1 }).mesh;
    expect(a.positions[5][2]).toBeCloseTo(0.5);
    const noise = run(DISPLACE_NODE, plane, { source: "noise", amount: 1, scale: 3 }).mesh;
    expect(new Set(noise.positions.map((p) => p[2].toFixed(5))).size).toBeGreaterThan(3);
    expect(run(DISPLACE_NODE, plane, { source: "attribute", attribute: "missing" }).status!.lines.some((l) => l.warn)).toBe(true);
  });
});

describe("Transform Elements", () => {
  it("translates and scales the group around its centroid", () => {
    const { mesh } = run(TRANSFORM_ELEMENTS_NODE, boxWithTop(), { group: "top", translate: new THREE.Vector3(0, 1, 0), scale: new THREE.Vector3(2, 1, 2) });
    const top = mesh.positions.filter((p) => p[1] > 1);
    expect(top).toHaveLength(4);
    top.forEach((p) => expect(Math.abs(p[0])).toBeCloseTo(1));
    expect(mesh.positions.filter((p) => p[1] < 0).every((p) => Math.abs(p[0]) === 0.5)).toBe(true);
  });
  it("pivot per face and per piece, with rotation", () => {
    const plane = createQuadPlane(2, 1, 2, 1);
    const { mesh } = run(TRANSFORM_ELEMENTS_NODE, plane, { pivot: "piece", rotate: new THREE.Vector3(0, 0, Math.PI) });
    // The whole plane is one piece: rotated 180° about its centre it covers the same points.
    const key = (m: PolyMesh) => m.positions.map((p) => p.map((x) => (Math.abs(x) < 1e-9 ? 0 : x).toFixed(4)).join(",")).sort();
    expect(key(mesh)).toEqual(key(plane));
    const perFace = run(TRANSFORM_ELEMENTS_NODE, plane, { pivot: "face", scale: new THREE.Vector3(0.5, 0.5, 0.5) }).mesh;
    expect(finiteMesh(perFace)).toBe(true);
    // The middle edge's points are shared by both faces: averaged, they don't move in x.
    expect(perFace.positions[1][0]).toBeCloseTo(0);
  });
});

describe("Scale Elements", () => {
  it("disconnected faces each shrink around their own centre", () => {
    const plane = setGroup(createQuadPlane(2, 2, 2, 2), "face", "tag", [1, 0, 0, 1]);
    const { mesh } = run(SCALE_ELEMENTS_NODE, plane, { scale: 0.5, disconnect: true });
    expect(mesh.faces).toHaveLength(4);
    expect(mesh.positions).toHaveLength(16);
    expect(values(mesh, "face", "tag")).toEqual([1, 0, 0, 1]);
    const connected = run(SCALE_ELEMENTS_NODE, plane, { scale: 0.5, group: "tag" }).mesh;
    expect(connected.positions).toHaveLength(9);
  });
});

describe("Dual / Poke / Divide", () => {
  it("dual of a cube is an octahedron, outward", () => {
    const { mesh } = run(DUAL_MESH_NODE, createQuadBox());
    expect(mesh.positions).toHaveLength(6);
    expect(mesh.faces).toHaveLength(8);
    expect(mesh.faces.every((f) => f.length === 3)).toBe(true);
    expect(outwardClosed(mesh)).toBe(true);
  });
  it("dual of an open grid keeps (or drops) its boundary", () => {
    const plane = createQuadPlane(2, 2, 3, 3);
    const kept = dualMesh(plane, plane.faces.map((_, f) => f), true).mesh;
    expect(kept.faces).toHaveLength(16);
    expect(faceNormals(kept)[2]).toBeGreaterThan(0.9);
    expect(dualMesh(plane, plane.faces.map((_, f) => f), false).mesh.faces).toHaveLength(4);
    expect(buildTopology(kept).inconsistentEdgeCount).toBe(0);
  });
  it("poke the group faces, groups follow", () => {
    const { mesh } = run(POKE_NODE, boxWithTop(), { group: "top", offset: 0.2 });
    expect(mesh.faces).toHaveLength(9);
    expect(mesh.positions).toHaveLength(9);
    expect(Math.max(...mesh.positions.map((p) => p[1]))).toBeCloseTo(0.7);
    expect(sum(values(mesh, "face", "top"))).toBe(4);
  });
  it("divide quads into N×N, triangles into a grid, without cracks", () => {
    const box = boxWithTop();
    const { mesh } = run(DIVIDE_NODE, box, { cuts: 3, group: "top" });
    expect(mesh.faces).toHaveLength(5 + 9);
    expect(sum(values(mesh, "face", "top"))).toBe(9);
    // Neighbours of the divided face got the new edge points: still closed.
    const topo = buildTopology(mesh);
    expect(topo.edges.every((_, e) => !topo.isBoundaryEdge(e))).toBe(true);
    const tri: PolyMesh = { positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]] };
    expect(divideFaces(tri, [0], 4).mesh.faces).toHaveLength(16);
    const all = run(DIVIDE_NODE, createQuadBox(), { cuts: 2, mode: "triangles" }).mesh;
    expect(all.faces).toHaveLength(6 * 8);
    const ngon: PolyMesh = { positions: [[0, 0, 0], [1, 0, 0], [1.5, 1, 0], [0.5, 1.6, 0], [-0.5, 1, 0]], faces: [[0, 1, 2, 3, 4]] };
    const dn = divideFaces(ngon, [0], 2).mesh;
    expect(dn.faces).toHaveLength(5 * 4);
    expect(buildTopology(dn).inconsistentEdgeCount).toBe(0);
  });
  it("divide interpolates UVs", () => {
    const plane = createQuadPlane(1, 1, 1, 1);
    const out = divideFaces(plane, [0], 2).mesh;
    const uvs = out.faceUVs!.flat();
    expect(uvs.some(([u, v]) => Math.abs(u - 0.5) < 1e-9 && Math.abs(v - 0.5) < 1e-9)).toBe(true);
  });
});

describe("Convex Hull", () => {
  it("hull of a cube's points: 8 points, 6 quads (or 12 triangles)", () => {
    const { mesh, out } = run(CONVEX_HULL_NODE, createQuadBox());
    expect(mesh.positions).toHaveLength(8);
    expect(mesh.faces).toHaveLength(6);
    expect(out.faces).toBe(6);
    expect(outwardClosed(mesh)).toBe(true);
    const tris = run(CONVEX_HULL_NODE, createQuadBox(), { mergeCoplanar: false }).mesh;
    expect(tris.faces).toHaveLength(12);
    expect(outwardClosed(tris)).toBe(true);
  });
  it("ignores interior points and handles random clouds", () => {
    const pts: number[][] = [];
    let s = 1;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let i = 0; i < 2000; i++) pts.push([rnd(), rnd(), rnd()]);
    const faces = convexHull(pts, false);
    // Euler: a closed triangulated hull has F = 2V - 4.
    const used = new Set(faces.flat());
    expect(faces.length).toBe(2 * used.size - 4);
    let worst = -Infinity;
    for (const face of faces) {
      const [a, b, c] = face.map((i) => pts[i]);
      const nrm = new THREE.Vector3().crossVectors(
        new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]),
        new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]),
      );
      // Every point is on or behind every face.
      for (const p of pts) worst = Math.max(worst, nrm.x * (p[0] - a[0]) + nrm.y * (p[1] - a[1]) + nrm.z * (p[2] - a[2]));
    }
    expect(worst).toBeLessThan(1e-6);
  });
  it("degenerate inputs: flat and collinear", () => {
    expect(convexHull([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0.5, 0.5, 0]])).toEqual([expect.any(Array)]);
    expect(convexHull([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0.5, 0.5, 0]])[0]).toHaveLength(4);
    expect(convexHull([[0, 0, 0], [1, 0, 0], [2, 0, 0]])).toEqual([]);
  });
  it("of the group only, merged with the input, carrying point attributes", () => {
    const plane = setAttribute(createQuadPlane(2, 2, 2, 2), "point", "id2", "float", [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const lifted: PolyMesh = { ...plane, positions: plane.positions.map((p, i) => [p[0], p[1], i === 4 ? 1 : 0]) };
    const { mesh } = run(CONVEX_HULL_NODE, lifted, { output: "shape + input" });
    expect(mesh.faces.length).toBe(4 + 5); // the plane + a pyramid (square base + 4 sides)
    expect(sum(values(mesh, "face", "hull"))).toBe(5);
    const only = run(CONVEX_HULL_NODE, lifted).mesh;
    expect(values(only, "point", "id2").sort((a, b) => a - b)).toEqual([0, 2, 4, 6, 8]);
  });
});

describe("Bounding Box", () => {
  it("axis-aligned box of the group", () => {
    const { mesh, out } = run(BOUNDING_BOX_NODE, boxWithTop(), { group: "top", domain: "face", padding: 0.1 });
    expect(mesh.positions).toHaveLength(8);
    expect(mesh.faces).toHaveLength(6);
    expect((out.size as THREE.Vector3).x).toBeCloseTo(1.2);
    expect((out.size as THREE.Vector3).y).toBeCloseTo(0.2);
    expect((out.center as THREE.Vector3).y).toBeCloseTo(0.5);
    expect(outwardClosed(mesh)).toBe(true);
  });
  it("oriented box fits a rotated slab tightly", () => {
    const slab = createQuadBox(4, 0.2, 1);
    const rot = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.3, 0.7, 0.2));
    const turned: PolyMesh = { ...slab, positions: slab.positions.map((p) => new THREE.Vector3(...p).applyMatrix4(rot).toArray() as [number, number, number]) };
    const { out, mesh } = run(BOUNDING_BOX_NODE, turned, { oriented: true });
    const size = (out.size as THREE.Vector3).toArray().sort((a, b) => a - b);
    expect(size[0]).toBeCloseTo(0.2, 3);
    expect(size[1]).toBeCloseTo(1, 3);
    expect(size[2]).toBeCloseTo(4, 3);
    expect(outwardClosed(mesh)).toBe(true);
    expect(run(BOUNDING_BOX_NODE, turned, { output: "shape + input" }).mesh.faces).toHaveLength(12);
  });
});

describe("Decimate", () => {
  it("hits its target on a 100×100 plane, fast", () => {
    const plane = createQuadPlane(10, 10, 100, 100);
    const t0 = performance.now();
    const r = decimateMesh(plane, plane.faces.map((_, f) => f), { targetTriangles: 2000, preserveBoundary: true });
    const ms = performance.now() - t0;
    expect(r.triangles).toBeLessThanOrEqual(2000);
    expect(r.triangles).toBeGreaterThanOrEqual(1998);
    expect(r.mesh.faces).toHaveLength(r.triangles);
    expect(ms).toBeLessThan(3000);
    // Flat stays flat, outline intact (all boundary points kept).
    expect(r.mesh.positions.every((p) => Math.abs(p[2]) < 1e-9)).toBe(true);
    expect(r.mesh.positions.filter((p) => Math.abs(Math.abs(p[0]) - 5) < 1e-9 || Math.abs(Math.abs(p[1]) - 5) < 1e-9)).toHaveLength(400);
    // Nothing flipped.
    const fn = faceNormals(r.mesh);
    for (let f = 0; f < r.mesh.faces.length; f++) expect(fn[f * 3 + 2]).toBeGreaterThan(0);
  });
  it("node: ratio on a sphere, group restricts, attributes follow", () => {
    const sphere = createQuadSphere(1, 8);
    const fn = faceNormals(sphere);
    const marked = setGroup(sphere, "face", "north", sphere.faces.map((_, f) => (fn[f * 3 + 1] > 0 ? 1 : 0)));
    const north = sphere.faces.filter((_, f) => fn[f * 3 + 1] > 0).length;
    const { mesh, out } = run(DECIMATE_NODE, marked, { group: "north", ratio: 0.25 });
    expect(out.triangles as number).toBeLessThanOrEqual(Math.round(north * 2 * 0.25));
    // The south half is untouched quads.
    expect(mesh.faces.filter((f) => f.length === 4)).toHaveLength(sphere.faces.length - north);
    expect(sum(values(mesh, "face", "north"))).toBe(out.triangles);
    expect(buildTopology(mesh).nonManifoldEdgeCount).toBe(0);
    // Still roughly a unit sphere.
    for (const p of mesh.positions) expect(Math.hypot(...p)).toBeGreaterThan(0.85);
  });
});

describe("Sort Elements", () => {
  it("sorts points by axis and keeps faces and attributes in step", () => {
    const plane = setAttribute(createQuadPlane(2, 2, 2, 2), "point", "tag", "float", [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const { mesh } = run(SORT_NODE, plane, { by: "axis", axis: "y", descending: true });
    const ys = mesh.positions.map((p) => p[1]);
    expect(ys).toEqual([...ys].sort((a, b) => b - a));
    // Each point keeps its tag: tag → original position.
    values(mesh, "point", "tag").forEach((t, i) => expect(mesh.positions[i]).toEqual(plane.positions[t]));
    // Faces still describe the same quads.
    const area = (m: PolyMesh) => m.faces.map((f) => f.map((v) => m.positions[v].join(",")).sort().join("|")).sort();
    expect(area(mesh)).toEqual(area(plane));
  });
  it("reverses faces, randomises, and leaves elements outside the group alone", () => {
    const box = setAttribute(createQuadBox(), "face", "k", "int", [0, 1, 2, 3, 4, 5]);
    expect(values(run(SORT_NODE, box, { domain: "face", by: "reverse" }).mesh, "face", "k")).toEqual([5, 4, 3, 2, 1, 0]);
    expect(values(run(SORT_NODE, box, { domain: "face", by: "reverse", group: "0-2" }).mesh, "face", "k")).toEqual([2, 1, 0, 3, 4, 5]);
    const r = values(run(SORT_NODE, box, { domain: "face", by: "random", seed: 3 }).mesh, "face", "k");
    expect([...r].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(values(run(SORT_NODE, box, { domain: "face", by: "attribute", attribute: "k", descending: true }).mesh, "face", "k")).toEqual([5, 4, 3, 2, 1, 0]);
  });
});

describe("Keep Group", () => {
  it("keeps faces, points and edges", () => {
    const box = boxWithTop();
    const faces = run(KEEP_GROUP_NODE, box, { group: "top" });
    expect(faces.mesh.faces).toHaveLength(1);
    expect(faces.mesh.positions).toHaveLength(4);
    expect(sum(values(faces.mesh, "face", "top"))).toBe(1);
    expect(run(KEEP_GROUP_NODE, box, { group: "top", invert: true }).mesh.faces).toHaveLength(5);
    const pts = run(KEEP_GROUP_NODE, box, { domain: "point", group: "0-3" }).mesh;
    expect(pts.positions).toHaveLength(4);
    expect(pts.faces).toHaveLength(1);
    const edges = run(KEEP_GROUP_NODE, box, { domain: "edge", group: "0" }).mesh;
    expect(edges.faces).toHaveLength(0);
    expect(edges.edges).toHaveLength(1);
  });
});

describe("Edge Crease / Mark", () => {
  it("writes crease, sharp and seam on the group's edges", () => {
    const box = boxWithTop();
    const creased = run(EDGE_MARK_NODE, box, { group: "top", value: 0.7 });
    expect(creased.out.count).toBe(4); // the top face's own edges
    expect(creased.mesh.edgeCreases!.every(([, , w]) => Math.abs(w - 0.7) < 1e-9)).toBe(true);
    const sharp = run(EDGE_MARK_NODE, box, { mark: "sharp", group: "0-3" }).mesh;
    expect(sharp.sharpEdges).toHaveLength(4);
    const cleared = run(EDGE_MARK_NODE, sharp, { mark: "sharp", group: "0", clear: true }).mesh;
    expect(cleared.sharpEdges).toHaveLength(3);
    expect(run(EDGE_MARK_NODE, box, { mark: "seam" }).mesh.seamEdges).toHaveLength(12);
  });
});
