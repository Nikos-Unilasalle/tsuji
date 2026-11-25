import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { EvalContext, NodeDefinition } from "../types";
import { createQuadBox, createQuadPlane, type PolyMesh } from "../quadMesh";
import { polyMeshToGeometry, readPolyMesh } from "../mesh/polyIO";
import { domainEdges, readAttribute, setAttribute, setGroup } from "../mesh/polyAttributes";
import { faceNormalOf } from "../mesh/modelingKernel";
import { buildTopology } from "../mesh/topology";
import {
  BEVEL_NODE,
  BRIDGE_NODE,
  CLIP_NODE,
  DISSOLVE_NODE,
  EXTRACT_NODE,
  FILL_HOLES_NODE,
  FLIP_FACES_NODE,
  FUSE_NODE,
  INSET_NODE,
  MIRROR_NODE,
  MODELING_OPS_NODES,
  QUADRANGULATE_NODE,
  REVOLVE_NODE,
  SPLIT_EDGES_NODE,
  SUBDIVIDE_FACES_NODE,
  TRIANGULATE_NODE,
} from "./modelingOps";
import { polyNodeStatus } from "./polyModifier";

let n = 0;
const ctx = (): EvalContext => ({ time: 0, step: 0, nodeId: `mod-${n++}` });
const meshObj = (m: PolyMesh) => new THREE.Mesh(polyMeshToGeometry(m), new THREE.MeshStandardMaterial());

function run(def: NodeDefinition, input: PolyMesh, params: Record<string, unknown> = {}) {
  const c = ctx();
  const out = def.evaluate({ geometry: meshObj(input) }, { ...def.defaultParams, ...params }, c);
  const mesh = readPolyMesh(out.geometry as THREE.Object3D)!.mesh;
  return { out, mesh, status: polyNodeStatus(c.nodeId) };
}
const count = (m: PolyMesh, domain: "point" | "edge" | "face", name: string) =>
  Array.from(readAttribute(m, domain, name)?.values ?? []).filter((v) => v).length;
const normalY = (m: PolyMesh, f: number) => faceNormalOf(m.positions, m.faces[f])[1];

/** A box with a `top` and `bottom` face group, a `tag` face attribute (its index) and a `w` point attribute (its height). */
function taggedBox(): PolyMesh {
  let m = createQuadBox();
  m = setGroup(m, "face", "top", m.faces.map((_, f) => (normalY(m, f) > 0.9 ? 1 : 0)));
  m = setGroup(m, "face", "bottom", m.faces.map((_, f) => (normalY(m, f) < -0.9 ? 1 : 0)));
  m = setAttribute(m, "face", "tag", "float", m.faces.map((_, f) => f + 1));
  m = setAttribute(m, "point", "w", "float", m.positions.map((p) => p[1]));
  const edges = domainEdges(m);
  m = setGroup(m, "edge", "topedges", edges.map(([a, b]) => (m.positions[a][1] > 0 && m.positions[b][1] > 0 ? 1 : 0)));
  m = setGroup(m, "point", "corner", m.positions.map((_, i) => (i === 0 ? 1 : 0)));
  return m;
}
const topIndex = (m: PolyMesh) => m.faces.findIndex((_, f) => normalY(m, f) > 0.9);
const isClosed = (m: PolyMesh) => {
  const t = buildTopology(m);
  return t.edges.every((_, id) => !t.isBoundaryEdge(id)) && t.nonManifoldEdgeCount === 0 && t.inconsistentEdgeCount === 0;
};

describe("Modeling ops", () => {
  it("every node is a modeling node with a Group field", () => {
    for (const def of MODELING_OPS_NODES) {
      expect(def.category).toBe("modeling");
      expect(def.type.startsWith("modeling/")).toBe(true);
      expect(def.defaultParams.group).toBe("");
    }
  });

  it("never throws on an empty mesh or a group that matches nothing", () => {
    const empty: PolyMesh = { positions: [], faces: [] };
    for (const def of MODELING_OPS_NODES) {
      expect(() => run(def, empty)).not.toThrow();
      const { mesh, status } = run(def, taggedBox(), { group: "nosuchgroup" });
      // Extract keeps the group: nothing.
      expect(mesh.faces.length).toBe(def === EXTRACT_NODE ? 0 : 6);
      expect(status?.lines.some((l) => l.text.startsWith("Error"))).toBe(false);
    }
  });

  it("survives odd meshes and junk params without an error note", () => {
    const ngon: PolyMesh = { positions: Array.from({ length: 7 }, (_, i) => [Math.cos(i), 0, Math.sin(i * 1.3)] as [number, number, number]), faces: [[0, 1, 2, 3, 4, 5, 6]] };
    const mixed: PolyMesh = {
      positions: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [2, 2, 2], [3, 3, 3], [0.5, 2, 0]],
      faces: [[0, 1, 2, 3], [3, 2, 6]],
      edges: [[4, 5]],
    };
    const degenerate: PolyMesh = { positions: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], faces: [[0, 1, 2]] };
    const junk = { width: NaN, thickness: "x", depth: Infinity, segments: -5, twist: NaN, angle: NaN, distance: -1, offset: NaN, tolerance: NaN, normal: [0, 0, 0], point: [NaN, 0, 0], iterations: 99, maxSides: -3, maxAngle: NaN };
    const meshes = [taggedBox(), createQuadPlane(1, 1, 3, 3), ngon, mixed, degenerate];
    for (const def of MODELING_OPS_NODES) {
      for (const m of meshes) {
        for (const params of [{}, junk, { mode: "limited", affect: "vertices", keep: "both", elements: "faces" }]) {
          const { mesh, status } = run(def, m, params);
          expect(status?.lines.filter((l) => l.text.startsWith("Error")) ?? [], `${def.type}`).toEqual([]);
          expect(mesh.positions.every((p) => p.every(Number.isFinite)), def.type).toBe(true);
          expect(mesh.faces.every((f) => f.every((v) => v >= 0 && v < mesh.positions.length)), def.type).toBe(true);
        }
      }
    }
  });

  it("Bevel edges of a group, keeping attributes", () => {
    const { mesh } = run(BEVEL_NODE, taggedBox(), { group: "topedges", width: 0.1 });
    expect(count(mesh, "face", "bevel_faces")).toBeGreaterThanOrEqual(4);
    expect(mesh.faces.length).toBeGreaterThan(6);
    // New faces inherit from the face they grew beside (as in Houdini).
    expect(count(mesh, "face", "top")).toBeGreaterThanOrEqual(1);
    expect(isClosed(mesh)).toBe(true);
    const tag = readAttribute(mesh, "face", "tag")!.values;
    expect(tag.length).toBe(mesh.faces.length);
    // The bottom face is untouched by a bevel of the top edges.
    const bottom = mesh.faces.findIndex((_, f) => normalY(mesh, f) < -0.9);
    expect(tag[bottom]).toBe(taggedBox().faces.findIndex((_, f) => normalY(taggedBox(), f) < -0.9) + 1);
  });

  it("Bevel a vertex: a corner becomes a triangle", () => {
    const { mesh } = run(BEVEL_NODE, taggedBox(), { affect: "vertices", group: "corner", width: 0.2 });
    expect(mesh.faces.length).toBe(7);
    expect(mesh.positions.length).toBe(10);
    expect(count(mesh, "face", "bevel_faces")).toBe(1);
    expect(isClosed(mesh)).toBe(true);
    expect(readAttribute(mesh, "point", "w")!.values.length).toBe(10);
  });

  it("Inset writes inner and side groups", () => {
    const { mesh } = run(INSET_NODE, taggedBox(), { group: "top", thickness: 0.1, depth: -0.1 });
    expect(mesh.faces.length).toBe(10);
    expect(count(mesh, "face", "inset_inner")).toBe(1);
    expect(count(mesh, "face", "inset_side")).toBe(4);
    expect(count(mesh, "face", "top")).toBeGreaterThanOrEqual(1);
    const inner = Array.from(readAttribute(mesh, "face", "inset_inner")!.values).indexOf(1);
    expect(readAttribute(mesh, "face", "top")!.values[inner]).toBe(1);
    expect(isClosed(mesh)).toBe(true);
  });

  it("Bridge two face groups into a tunnel", () => {
    const { mesh } = run(BRIDGE_NODE, taggedBox(), { elements: "faces", group: "top", groupB: "bottom", segments: 2 });
    expect(mesh.faces.length).toBe(6 - 2 + 8);
    expect(count(mesh, "face", "bridge_faces")).toBe(8);
    expect(mesh.positions.length).toBe(12);
    expect(isClosed(mesh)).toBe(true);
  });

  it("Bridge two edge loops, twisted", () => {
    // Two square loops of loose edges, one above the other.
    const sq = (y: number): [number, number, number][] => [[-1, y, -1], [1, y, -1], [1, y, 1], [-1, y, 1]];
    let m: PolyMesh = { positions: [...sq(0), ...sq(1)], faces: [], edges: [[0, 1], [1, 2], [2, 3], [0, 3], [4, 5], [5, 6], [6, 7], [4, 7]] };
    const edges = domainEdges(m);
    m = setGroup(m, "edge", "low", edges.map(([a]) => (a < 4 ? 1 : 0)));
    m = setGroup(m, "edge", "high", edges.map(([a]) => (a >= 4 ? 1 : 0)));
    const { mesh } = run(BRIDGE_NODE, m, { group: "low", groupB: "high", twist: 1 });
    expect(mesh.faces.length).toBe(4);
    // Blank Group B: Group A must split into two loops itself.
    const both = run(BRIDGE_NODE, m, { group: "low high" });
    expect(both.mesh.faces.length).toBe(4);
    expect(run(BRIDGE_NODE, m, { group: "low" }).mesh.faces.length).toBe(0);
  });

  it("Revolve a wire profile, welding a full turn", () => {
    let m: PolyMesh = { positions: [[1, 0, 0], [1, 1, 0], [0.5, 1.5, 0], [3, 0, 0], [3, 1, 0]], faces: [], edges: [[0, 1], [1, 2], [3, 4]] };
    m = setGroup(m, "edge", "profile", domainEdges(m).map(([a]) => (a < 3 ? 1 : 0)));
    const full = run(REVOLVE_NODE, m, { group: "profile", angle: 360, segments: 8 });
    expect(full.mesh.faces.length).toBe(16);
    expect(count(full.mesh, "face", "revolve_faces")).toBe(16);
    // 3 profile points × 8 + the 2 points of the edge left out.
    expect(full.mesh.positions.length).toBe(26);
    expect(full.mesh.edges?.length).toBe(1);
    const half = run(REVOLVE_NODE, m, { group: "profile", angle: 180, segments: 8 });
    expect(half.mesh.positions.length).toBe(3 * 9 + 2);
    // Outward normals: the first strip faces +x/-z, away from the axis.
    const f0 = full.mesh.faces[0];
    const nrm = faceNormalOf(full.mesh.positions, f0);
    const c = f0.reduce((acc, v) => [acc[0] + full.mesh.positions[v][0], acc[1] + full.mesh.positions[v][2]], [0, 0]);
    expect(nrm[0] * c[0] + nrm[2] * c[1]).toBeGreaterThan(0);
  });

  it("Mirror welds the seam and flips the copies", () => {
    const plane = createQuadPlane(1, 1, 2, 2);
    const shifted: PolyMesh = { ...plane, positions: plane.positions.map((p) => [p[0] + 0.5, p[1], p[2]]) };
    const { mesh } = run(MIRROR_NODE, shifted, { axis: "x" });
    expect(mesh.faces.length).toBe(8);
    expect(mesh.positions.length).toBe(15);
    expect(count(mesh, "face", "mirror_faces")).toBe(4);
    const t = buildTopology(mesh);
    expect(t.inconsistentEdgeCount).toBe(0);
    const unwelded = run(MIRROR_NODE, shifted, { axis: "x", weld: false });
    expect(unwelded.mesh.positions.length).toBe(18);
  });

  it("Symmetrize a box from its +x half", () => {
    const box = createQuadBox();
    // Push the +x side out: symmetrize must copy it over the -x side.
    const m: PolyMesh = { ...box, positions: box.positions.map((p) => [p[0] > 0 ? 1 : p[0], p[1], p[2]]) };
    const { mesh } = run(MIRROR_NODE, m, { mode: "symmetrize", axis: "x" });
    expect(mesh.faces.length).toBe(10);
    expect(mesh.positions.length).toBe(12);
    expect(Math.min(...mesh.positions.map((p) => p[0]))).toBeCloseTo(-1);
    expect(isClosed(mesh)).toBe(true);
  });

  it("Fuse welds what Split Edges took apart, within the group only", () => {
    const split = run(SPLIT_EDGES_NODE, taggedBox()).mesh;
    expect(split.positions.length).toBe(24);
    expect(split.faces.length).toBe(6);
    const fused = run(FUSE_NODE, split, { distance: 1e-4 });
    expect(fused.mesh.positions.length).toBe(8);
    expect(fused.out.removed).toBe(16);
    expect(isClosed(fused.mesh)).toBe(true);
    expect(readAttribute(fused.mesh, "point", "w")!.values.length).toBe(8);
    const partial = run(FUSE_NODE, split, { distance: 1e-4, group: "@P.y>0" });
    expect(partial.mesh.positions.length).toBe(4 + 12);
  });

  it("Split Edges only along the group", () => {
    const { mesh } = run(SPLIT_EDGES_NODE, taggedBox(), { group: "topedges" });
    expect(mesh.positions.length).toBe(12);
    expect(count(mesh, "face", "top")).toBe(1);
  });

  it("Dissolve faces, edges and limited", () => {
    let grid = createQuadPlane(1, 1, 2, 2);
    grid = setGroup(grid, "face", "left", grid.faces.map((face) => (face.every((v) => grid.positions[v][0] <= 1e-9) ? 1 : 0)));
    expect(run(DISSOLVE_NODE, grid).mesh.faces.length).toBe(1);
    const left = run(DISSOLVE_NODE, grid, { group: "left" });
    expect(left.mesh.faces.length).toBe(3);
    expect(count(left.mesh, "face", "dissolve_faces")).toBe(1);
    expect(count(left.mesh, "face", "left")).toBe(1);
    const topo = buildTopology(grid);
    const inner = topo.edges.findIndex((_, id) => !topo.isBoundaryEdge(id));
    const edges = run(DISSOLVE_NODE, grid, { mode: "edges", group: String(inner) });
    expect(edges.mesh.faces.length).toBe(3);
    const limited = run(DISSOLVE_NODE, grid, { mode: "limited" });
    expect(limited.mesh.faces.length).toBe(1);
    expect(limited.mesh.positions.length).toBe(4);
    // A box's edges are all 90°: nothing goes.
    expect(run(DISSOLVE_NODE, taggedBox(), { mode: "limited" }).mesh.faces.length).toBe(6);
  });

  it("Extract keeps or deletes the group, with attributes", () => {
    const kept = run(EXTRACT_NODE, taggedBox(), { group: "top" }).mesh;
    expect(kept.faces.length).toBe(1);
    expect(kept.positions.length).toBe(4);
    expect(readAttribute(kept, "face", "tag")!.values[0]).toBe(topIndex(taggedBox()) + 1);
    expect(Array.from(readAttribute(kept, "point", "w")!.values).every((w) => w > 0)).toBe(true);
    const deleted = run(EXTRACT_NODE, taggedBox(), { group: "top", mode: "delete" }).mesh;
    expect(deleted.faces.length).toBe(5);
    expect(count(deleted, "face", "top")).toBe(0);
    expect(count(deleted, "face", "bottom")).toBe(1);
  });

  it("Fill Holes closes open borders, respecting max sides", () => {
    const open = run(EXTRACT_NODE, taggedBox(), { group: "top", mode: "delete" }).mesh;
    const filled = run(FILL_HOLES_NODE, open);
    expect(filled.mesh.faces.length).toBe(6);
    expect(count(filled.mesh, "face", "fill_faces")).toBe(1);
    expect(isClosed(filled.mesh)).toBe(true);
    expect(run(FILL_HOLES_NODE, open, { maxSides: 3 }).mesh.faces.length).toBe(5);
    expect(run(FILL_HOLES_NODE, open, { group: "nosuchgroup" }).mesh.faces.length).toBe(5);
  });

  it("Clip keeps a side and caps it", () => {
    const { mesh } = run(CLIP_NODE, taggedBox(), { point: [0, 0, 0], normal: [0, 1, 0] });
    expect(mesh.faces.length).toBe(6);
    expect(count(mesh, "face", "cap")).toBe(1);
    expect(count(mesh, "edge", "cut")).toBe(4);
    expect(count(mesh, "face", "top")).toBe(1);
    expect(Math.min(...mesh.positions.map((p) => p[1]))).toBeCloseTo(0);
    expect(isClosed(mesh)).toBe(true);
    const cap = Array.from(readAttribute(mesh, "face", "cap")!.values).indexOf(1);
    expect(normalY(mesh, cap)).toBeLessThan(-0.9);

    const both = run(CLIP_NODE, taggedBox(), { keep: "both" }).mesh;
    expect(both.faces.length).toBe(10);
    expect(count(both, "face", "clip_above")).toBe(5);
    expect(count(both, "face", "clip_below")).toBe(5);
    expect(isClosed(both)).toBe(true);

    // Tilted plane through a corner region; n-gons and triangles come out.
    const tilted = run(CLIP_NODE, taggedBox(), { point: [0.3, 0.3, 0.3], normal: [1, 1, 1] }).mesh;
    expect(isClosed(tilted)).toBe(true);
    expect(count(tilted, "face", "cap")).toBe(1);
  });

  it("Clip restricted to a group cuts only those faces", () => {
    const { mesh } = run(CLIP_NODE, taggedBox(), { group: "top", normal: [1, 0, 0], cap: false });
    // The top face loses its -x half; the other five stay (with the cut points on their shared edges).
    expect(mesh.faces.length).toBe(6);
    const top = mesh.faces.findIndex((_, f) => normalY(mesh, f) > 0.9);
    expect(Math.min(...mesh.faces[top].map((v) => mesh.positions[v][0]))).toBeCloseTo(0);
  });

  it("Clip splits a concave n-gon into its pieces", () => {
    // A U shape crossed by the plane y = 0.5 through both arms.
    const u: PolyMesh = { positions: [[0, 0, 0], [3, 0, 0], [3, 1, 0], [2, 1, 0], [2, 0.2, 0], [1, 0.2, 0], [1, 1, 0], [0, 1, 0]], faces: [[0, 1, 2, 3, 4, 5, 6, 7]] };
    const { mesh } = run(CLIP_NODE, u, { point: [0, 0.5, 0], normal: [0, 1, 0], cap: false });
    expect(mesh.faces.length).toBe(2);
    expect(mesh.faces.every((f) => f.length === 4)).toBe(true);
  });

  it("Triangulate the group, then Quadrangulate back", () => {
    const tri = run(TRIANGULATE_NODE, taggedBox(), { group: "top" }).mesh;
    expect(tri.faces.length).toBe(7);
    expect(count(tri, "face", "top")).toBe(2);
    const all = run(TRIANGULATE_NODE, taggedBox()).mesh;
    expect(all.faces.length).toBe(12);
    const quads = run(QUADRANGULATE_NODE, all);
    expect(quads.mesh.faces.length).toBe(6);
    expect(quads.out.merged).toBe(6);
    expect(count(quads.mesh, "face", "top")).toBe(1);
    expect(isClosed(quads.mesh)).toBe(true);
    // Only the group's triangles pair up.
    expect(run(QUADRANGULATE_NODE, all, { group: "top" }).mesh.faces.length).toBe(11);
  });

  it("Subdivide Faces of the group only", () => {
    const one = run(SUBDIVIDE_FACES_NODE, taggedBox(), { group: "top" }).mesh;
    expect(one.faces.length).toBe(9);
    expect(count(one, "face", "subdivide_faces")).toBe(4);
    expect(count(one, "face", "top")).toBe(4);
    expect(isClosed(one)).toBe(true);
    const two = run(SUBDIVIDE_FACES_NODE, taggedBox(), { group: "top", iterations: 2 }).mesh;
    expect(two.faces.length).toBe(5 + 16);
    expect(count(two, "face", "subdivide_faces")).toBe(16);
  });

  it("Flip Faces of the group", () => {
    const { mesh } = run(FLIP_FACES_NODE, taggedBox(), { group: "top" });
    const top = Array.from(readAttribute(mesh, "face", "top")!.values).indexOf(1);
    expect(normalY(mesh, top)).toBeLessThan(-0.9);
    expect(buildTopology(mesh).inconsistentEdgeCount).toBe(4);
  });
});
