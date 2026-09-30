import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  computeFaceNormal,
  createQuadBox,
  deleteEdges,
  deleteFaces,
  deleteVertices,
  extractFaces,
  extrudeFaces,
  getQuadMeshEdges,
  insetFaces,
  loopCut,
  QuadMesh,
  quadMeshSignature,
  transformSelection,
} from "../quadMesh";
import { bevelEdges } from "./bevel";
import { catmullClarkQuadMesh } from "./subdivide";
import { duplicateFaces, extrudeEdges, extrudeFacesIndividual, extrudeVertices, flipFaces, insetRegion, mergeByDistance, subdivideFaces } from "./tools";

/** A unit box (faces 0..5) plus one loose edge well away from it. */
function boxWithLooseEdge(): QuadMesh {
  const box = createQuadBox(1, 1, 1);
  const a = box.positions.length;
  box.positions.push([5, 0, 0], [6, 0, 0]);
  box.edges = [[a, a + 1]];
  return box;
}

/** The loose edges, by where their ends are — indices move with every operation. */
function looseByPosition(mesh: QuadMesh): string[] {
  return (mesh.edges ?? [])
    .map(([a, b]) => [mesh.positions[a], mesh.positions[b]].map((p) => p.map((c) => c.toFixed(3)).join(",")).sort().join("|"))
    .sort();
}

const LOOSE = ["5.000,0.000,0.000|6.000,0.000,0.000"];

describe("loose edges", () => {
  it("are part of the mesh's edges and of its signature", () => {
    const mesh = boxWithLooseEdge();
    expect(getQuadMeshEdges(mesh)).toHaveLength(12 + 1);
    const without = { ...mesh, edges: [] };
    expect(quadMeshSignature(mesh)).not.toBe(quadMeshSignature(without));
  });

  it("survive every operation that leaves their vertices alone", () => {
    const ops: [string, (m: QuadMesh) => QuadMesh][] = [
      ["extrude", (m) => extrudeFaces(m, [0], 0.5).mesh],
      ["extrude individual", (m) => extrudeFacesIndividual(m, [0, 1], 0.5).mesh],
      ["inset", (m) => insetFaces(m, [0], 0.25).mesh],
      ["inset region", (m) => insetRegion(m, [0], 0.1).mesh],
      ["loop cut", (m) => loopCut(m, [m.faces[0][0], m.faces[0][1]], 1).mesh],
      ["bevel", (m) => bevelEdges(m, [[m.faces[0][0], m.faces[0][1]]], 0.1).mesh],
      ["subdivide faces", (m) => subdivideFaces(m, [0]).mesh],
      ["duplicate", (m) => duplicateFaces(m, [0]).mesh],
      ["flip", (m) => flipFaces(m, [0])],
      ["delete faces", (m) => deleteFaces(m, [0])],
      ["merge by distance", (m) => mergeByDistance(m, 1e-4).mesh],
      [
        "move faces",
        (m) =>
          transformSelection(
            m,
            "faces",
            [0],
            { position: new THREE.Vector3(0, 0, 1), rotation: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) },
            new THREE.Vector3(),
          ),
      ],
      ["catmull-clark", (m) => catmullClarkQuadMesh(m, 1)],
    ];
    const failures = ops.filter(([, op]) => JSON.stringify(looseByPosition(op(boxWithLooseEdge()))) !== JSON.stringify(LOOSE)).map(([name]) => name);
    expect(failures).toEqual([]);
  });

  it("stay behind when faces are separated off", () => {
    const piece = extractFaces(boxWithLooseEdge(), [0]);
    expect(piece.edges ?? []).toEqual([]);
    expect(piece.positions).toHaveLength(4);
  });
});

describe("deleting vertices and edges, Blender's way", () => {
  // A single quad: 0 (0,0) 1 (1,0) 2 (1,1) 3 (0,1).
  const quad = (): QuadMesh => ({
    positions: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
    faces: [[0, 1, 2, 3]],
  });

  it("a deleted vertex takes its face and its two edges, and leaves the other two edges loose", () => {
    const out = deleteVertices(quad(), [0]);
    expect(out.faces).toEqual([]);
    expect(out.positions).toHaveLength(3);
    expect(looseByPosition(out)).toEqual(
      ["1.000,0.000,0.000|1.000,1.000,0.000", "0.000,1.000,0.000|1.000,1.000,0.000"].sort(),
    );
  });

  it("a deleted edge takes its face; the other three edges stay loose, every vertex with them", () => {
    const out = deleteEdges(quad(), [[1, 0]]);
    expect(out.faces).toEqual([]);
    expect(out.positions).toHaveLength(4);
    expect(out.edges).toHaveLength(3);
  });

  it("deleting a loose edge drops the vertices it alone was using", () => {
    const mesh = boxWithLooseEdge();
    const [a, b] = mesh.edges![0];
    const out = deleteEdges(mesh, [[a, b]]);
    expect(out.edges ?? []).toEqual([]);
    expect(out.positions).toHaveLength(8);
    expect(out.faces).toHaveLength(6);
  });

  it("an edge still used by a surviving face never turns loose", () => {
    // Deleting the top vertex of a box: the three faces around it go; the
    // edges they shared with the three remaining faces aren't loose.
    const box = createQuadBox(1, 1, 1);
    const out = deleteVertices(box, [0]);
    expect(out.faces).toHaveLength(3);
    const faceEdges = new Set(getQuadMeshEdges({ ...out, edges: [] }).map(([x, y]) => `${Math.min(x, y)}_${Math.max(x, y)}`));
    for (const [x, y] of out.edges ?? []) expect(faceEdges.has(`${x}_${y}`)).toBe(false);
    // The removed faces' edges away from vertex 0 that the kept faces don't use: none on a box.
    expect(out.edges ?? []).toEqual([]);
  });
});

describe("extruding vertices and edges, Blender's way", () => {
  const hexagon = (): QuadMesh => {
    const positions: [number, number, number][] = [];
    const edges: [number, number][] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      positions.push([Math.cos(a), Math.sin(a), 0]);
      edges.push([i, (i + 1) % 6].sort((x, y) => x - y) as [number, number]);
    }
    return { positions, faces: [], edges };
  };

  it("a vertex sprouts a copy on top of it, joined by a loose edge", () => {
    const r = extrudeVertices(hexagon(), [0, 3]);
    expect(r.newVertices).toEqual([6, 7]);
    expect(r.mesh.positions[6]).toEqual(r.mesh.positions[0]);
    expect(r.mesh.edges).toHaveLength(6 + 2);
    expect(r.mesh.edges).toContainEqual([0, 6]);
    expect(r.mesh.edges).toContainEqual([3, 7]);
  });

  it("an outline of loose edges grows a wall: one quad per edge, sharing the copied corners", () => {
    const all = hexagon().edges!;
    const r = extrudeEdges(hexagon(), all);
    expect(r.newFaces).toHaveLength(6);
    expect(r.mesh.positions).toHaveLength(12);
    expect(r.newEdges).toHaveLength(6);
    // The extruded edges are the wall's now, not loose.
    expect(r.mesh.edges).toEqual([]);
    expect(r.mesh.faceUVs).toHaveLength(6);
  });

  it("a border edge's new quad faces the same way as the face it grows from", () => {
    // One quad in the XY plane, normal +Z; extrude its right edge and pull it along +X.
    const quad: QuadMesh = { positions: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], faces: [[0, 1, 2, 3]] };
    const r = extrudeEdges(quad, [[1, 2]]);
    const moved = { ...r.mesh, positions: r.mesh.positions.map((p, i) => (i >= 4 ? [p[0] + 1, p[1], p[2]] : p) as [number, number, number]) };
    const n = computeFaceNormal(moved.positions, moved.faces[r.newFaces[0]]);
    expect(n.z).toBeCloseTo(1);
  });
});
