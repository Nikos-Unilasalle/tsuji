import { describe, expect, it } from "vitest";
import { createQuadBox, createQuadPlane, QuadMesh } from "../quadMesh";
import { unwrapFaces } from "./lscm";
import { faceUVIslands, packFaceIslands } from "./pack";
import { cylinderProject, followActiveQuads, sphereProject, viewProject } from "./project";
import { smartUnwrap } from "./unwrap";
import type { UV } from "./uv";

type V3 = [number, number, number];

/** An open tube of `n` quads round the Y axis, radius r, height h, with one vertical seam (between the last and first quad). */
function tube(n: number, r = 1, h = 2): QuadMesh {
  const positions: V3[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    positions.push([Math.sin(a) * r, 0, Math.cos(a) * r], [Math.sin(a) * r, h, Math.cos(a) * r]);
  }
  const faces: number[][] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push([i * 2, j * 2, j * 2 + 1, i * 2 + 1]);
  }
  return { positions, faces, seamEdges: [[0, 1]] };
}

const uvOf = (mesh: QuadMesh, f: number, v: number): UV => mesh.faceUVs![f][mesh.faces[f].indexOf(v)] as UV;
const dist3 = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dist2 = (a: UV, b: UV) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const allUVs = (mesh: QuadMesh, faces = mesh.faces.map((_, f) => f)) => faces.flatMap((f) => mesh.faceUVs![f] as UV[]);

/** Signed UV area of each face (fan from corner 0). */
function signedAreas(mesh: QuadMesh): number[] {
  return mesh.faces.map((face, f) => {
    const uv = mesh.faceUVs![f] as UV[];
    let a = 0;
    for (let i = 1; i + 1 < face.length; i++) {
      a += (uv[i][0] - uv[0][0]) * (uv[i + 1][1] - uv[0][1]) - (uv[i + 1][0] - uv[0][0]) * (uv[i][1] - uv[0][1]);
    }
    return a / 2;
  });
}

describe("Unwrap (LSCM)", () => {
  it("flattens a flat grid without distortion: every edge keeps its proportion", () => {
    const plane = createQuadPlane(2, 1, 4, 2);
    const r = unwrapFaces(plane, null);
    expect(r.islands).toBe(1);
    const ratios: number[] = [];
    plane.faces.forEach((face, f) =>
      face.forEach((v, i) => {
        const w = face[(i + 1) % face.length];
        ratios.push(dist2(uvOf(r.mesh, f, v), uvOf(r.mesh, f, w)) / dist3(plane.positions[v], plane.positions[w]));
      }),
    );
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    for (const k of ratios) expect(Math.abs(k / mean - 1)).toBeLessThan(1e-3);
  });

  it("unrolls a tube cut by one seam into one strip, circumference by height, nothing folded", () => {
    const n = 16;
    const r = unwrapFaces(tube(n), null);
    expect(r.islands).toBe(1);
    // Every face the same way up — no fold-over.
    const areas = signedAreas(r.mesh);
    expect(areas.every((a) => a > 0) || areas.every((a) => a < 0)).toBe(true);
    // Circumference 2πr·(chord factor) ≈ 6.24, height 2: a long strip.
    const uvs = allUVs(r.mesh);
    const w = Math.max(...uvs.map((u) => u[0])) - Math.min(...uvs.map((u) => u[0]));
    const h = Math.max(...uvs.map((u) => u[1])) - Math.min(...uvs.map((u) => u[1]));
    const perimeter = n * 2 * Math.sin(Math.PI / n);
    expect(Math.max(w, h) / Math.min(w, h)).toBeCloseTo(perimeter / 2, 1);
    // The seam: the two faces either side give vertex 0 different UVs.
    expect(dist2(uvOf(r.mesh, 0, 0), uvOf(r.mesh, n - 1, 0))).toBeGreaterThan(0.1);
  });

  it("cuts a closed box with no seams into flat pieces instead of crushing it", () => {
    const r = unwrapFaces(createQuadBox(1, 1, 1), null);
    expect(r.islands).toBe(6);
    for (const a of signedAreas(r.mesh)) expect(Math.abs(a)).toBeGreaterThan(1e-3);
  });

  it("packs into 0..1 and leaves unselected faces' UVs alone", () => {
    const box = smartUnwrap(createQuadBox(1, 1, 1));
    const r = unwrapFaces(box, [0, 1]);
    for (const [u, v] of allUVs(r.mesh, [0, 1])) {
      expect(u).toBeGreaterThanOrEqual(-1e-9);
      expect(u).toBeLessThanOrEqual(1 + 1e-9);
      expect(v).toBeGreaterThanOrEqual(-1e-9);
      expect(v).toBeLessThanOrEqual(1 + 1e-9);
    }
    for (let f = 2; f < 6; f++) expect(r.mesh.faceUVs![f]).toEqual(box.faceUVs![f]);
  });
});

describe("Pack Islands", () => {
  it("moves each island whole: its shape survives, at one scale for all", () => {
    const tubeMesh = unwrapFaces(tube(8), null).mesh;
    // Scatter the island far away, then pack it back.
    const scattered: QuadMesh = { ...tubeMesh, faceUVs: tubeMesh.faceUVs!.map((uvs) => uvs.map(([u, v]) => [u * 3 + 7, v * 3 - 5] as UV)) };
    const packed = packFaceIslands(scattered, scattered.faces.map((_, f) => f));
    expect(faceUVIslands(packed, packed.faces.map((_, f) => f))).toHaveLength(1);
    for (const [u, v] of allUVs(packed)) {
      expect(u).toBeGreaterThanOrEqual(-1e-9);
      expect(u).toBeLessThanOrEqual(1 + 1e-9);
      expect(v).toBeGreaterThanOrEqual(-1e-9);
      expect(v).toBeLessThanOrEqual(1 + 1e-9);
    }
    // Same shape: ratios of edge lengths unchanged.
    const e = (m: QuadMesh, f: number) => dist2(uvOf(m, f, m.faces[f][0]), uvOf(m, f, m.faces[f][1]));
    const k = e(packed, 0) / e(scattered, 0);
    for (let f = 1; f < packed.faces.length; f++) expect(e(packed, f) / e(scattered, f)).toBeCloseTo(k, 6);
  });
});

describe("projections", () => {
  it("Cylinder: arc length round the axis by height, and no face stretched back across the seam", () => {
    const n = 12;
    const m = cylinderProject(tube(n), [], "y");
    const period = 2 * Math.PI;
    for (let f = 0; f < n; f++) {
      const us = (m.faceUVs![f] as UV[]).map((uv) => uv[0]);
      expect(Math.max(...us) - Math.min(...us)).toBeLessThan(period / 2);
      const vs = (m.faceUVs![f] as UV[]).map((uv) => uv[1]);
      expect(Math.max(...vs) - Math.min(...vs)).toBeCloseTo(2);
    }
  });

  it("Sphere: latitude runs pole to pole over half a turn", () => {
    const box = createQuadBox(2, 2, 2);
    const m = sphereProject(box, [], "y");
    const vs = allUVs(m).map((uv) => uv[1]);
    const radius = Math.sqrt(3); // every corner of the box
    expect(Math.max(...vs)).toBeLessThanOrEqual((Math.PI / 2) * radius + 1e-9);
    expect(Math.min(...vs)).toBeGreaterThanOrEqual(-(Math.PI / 2) * radius - 1e-9);
  });

  it("From View: what the view shows, fitted into 0..1 with its proportions", () => {
    const plane = createQuadPlane(2, 1, 2, 1);
    const m = viewProject(plane, [], (p) => [p[0], p[1] + p[2]]);
    const uvs = allUVs(m);
    const w = Math.max(...uvs.map((u) => u[0])) - Math.min(...uvs.map((u) => u[0]));
    expect(w).toBeCloseTo(1);
    for (const [u, v] of uvs) {
      expect(u).toBeGreaterThanOrEqual(-1e-9);
      expect(v).toBeGreaterThanOrEqual(-1e-9);
      expect(v).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("Follow Active Quads: a bent strip comes out as one continuous run from the active face", () => {
    // Four quads bending round a corner.
    const positions: V3[] = [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 0], [2, 0, 0], [2, 1, 0], [2, 0, 1], [2, 1, 1], [2, 0, 2], [2, 1, 2]];
    const faces = [[0, 2, 3, 1], [2, 4, 5, 3], [4, 6, 7, 5], [6, 8, 9, 7]];
    const mesh: QuadMesh = { positions, faces, faceUVs: faces.map((face) => face.map(() => [0, 0] as UV)) };
    mesh.faceUVs![0] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const m = followActiveQuads(mesh, [0, 1, 2, 3], 0);
    expect(m.faceUVs![0]).toEqual(mesh.faceUVs![0]);
    for (let f = 1; f < 4; f++) {
      const shared = faces[f].filter((v) => faces[f - 1].includes(v));
      for (const v of shared) {
        const [a, b] = [uvOf(m, f, v), uvOf(m, f - 1, v)];
        expect(dist2(a, b)).toBeLessThan(1e-9);
      }
    }
    // Straight: every face one unit further along U.
    const us = (f: number) => (m.faceUVs![f] as UV[]).map((uv) => uv[0]);
    for (let f = 0; f < 4; f++) {
      expect(Math.min(...us(f))).toBeCloseTo(f);
      expect(Math.max(...us(f))).toBeCloseTo(f + 1);
    }
  });
});
