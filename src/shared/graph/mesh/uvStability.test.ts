import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createQuadBox, createQuadPlane, extrudeFaces, QuadMesh, quadMeshToBufferGeometry, withFaceUVs } from "../quadMesh";
import { smartUnwrap } from "./unwrap";
import { extrudeEdges } from "./tools";
import { fillNewFaceUVs } from "./uv";

type UV = [number, number];

/** Rendered UV at each rendered corner, keyed by its position. */
function uvByPosition(geometry: THREE.BufferGeometry): Map<string, string[]> {
  const pos = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  const out = new Map<string, string[]>();
  for (let i = 0; i < pos.count; i++) {
    const key = [pos.getX(i), pos.getY(i), pos.getZ(i)].map((c) => c.toFixed(4)).join(",");
    const list = out.get(key) ?? [];
    list.push(`${uv.getX(i).toFixed(4)},${uv.getY(i).toFixed(4)}`);
    out.set(key, list);
  }
  return out;
}

/** The UV a face gives vertex v. */
const uvAt = (mesh: QuadMesh, f: number, v: number): UV => mesh.faceUVs![f][mesh.faces[f].indexOf(v)] as UV;

describe("UVs stay put", () => {
  it("moving a vertex changes no other face's UVs — with stored UVs or none", () => {
    for (const base of [createQuadPlane(2, 2, 2, 2), { ...createQuadBox(1, 1, 1), faceUVs: undefined }]) {
      const moved: QuadMesh = { ...base, positions: base.positions.map((p, i) => (i === 0 ? [p[0] - 10, p[1] + 3, p[2]] : p) as [number, number, number]) };
      // What the geometry builds from: the same UVs for every face away from the moved vertex.
      const before = withFaceUVs(base).faceUVs!;
      const after = withFaceUVs(moved).faceUVs!;
      const untouched = base.faces.map((_, f) => f).filter((f) => !base.faces[f].includes(0));
      expect(untouched.length).toBeGreaterThan(0);
      for (const f of untouched) expect(after[f], `face ${f}`).toEqual(before[f]);
      // And the geometry really is built from those (the plane keeps its grid).
      const rendered = uvByPosition(quadMeshToBufferGeometry(moved, "auto"));
      const key = moved.positions[1].map((c) => c.toFixed(4)).join(",");
      expect(rendered.get(key)).toBeDefined();
    }
  });

  it("the shading mode doesn't change a plane's UVs", () => {
    const plane = createQuadPlane(2, 2, 2, 2);
    const auto = uvByPosition(quadMeshToBufferGeometry(plane, "auto"));
    const smooth = uvByPosition(quadMeshToBufferGeometry(plane, "smooth"));
    for (const [key, uvs] of smooth) expect(new Set(auto.get(key)), key).toEqual(new Set(uvs));
  });
});

describe("new faces continue their neighbours' UVs", () => {
  it("extrusion leaves existing UVs alone, and its walls run on from the faces around them at the same scale", () => {
    const box = createQuadBox(1, 1, 1);
    const r = extrudeFaces(box, [0], 0.5);
    for (let f = 1; f < 6; f++) expect(r.mesh.faceUVs![f]).toEqual(box.faceUVs![f]);

    const walls = r.mesh.faces.map((_, f) => f).slice(6);
    expect(walls).toHaveLength(4);
    for (const w of walls) {
      const face = r.mesh.faces[w];
      // The wall's base edge (original vertices): same UVs as the side face it continues.
      const base = face.filter((v) => v < box.positions.length);
      const neighbour = [1, 2, 3, 4, 5].find((f) => base.every((v) => box.faces[f].includes(v)))!;
      expect(neighbour).toBeDefined();
      for (const v of base) {
        const [u1, v1] = uvAt(r.mesh, w, v);
        const [u2, v2] = uvAt(r.mesh, neighbour, v);
        expect(u1).toBeCloseTo(u2);
        expect(v1).toBeCloseTo(v2);
      }
      // Height 0.5 in space, 0.5 in UV — the fixed density the rest has.
      const uvs = r.mesh.faceUVs![w] as UV[];
      const spread = Math.max(
        Math.max(...uvs.map((uv) => uv[0])) - Math.min(...uvs.map((uv) => uv[0])),
        Math.max(...uvs.map((uv) => uv[1])) - Math.min(...uvs.map((uv) => uv[1])),
      );
      expect(spread).toBeCloseTo(1); // the unit-wide side
    }
  });

  it("after Smart Unwrap, walls sit against their island instead of across the whole layout", () => {
    const unwrapped = smartUnwrap(createQuadBox(1, 1, 1));
    const r = extrudeFaces(unwrapped, [0], 0.25);
    const islandSize = Math.max(...(unwrapped.faceUVs!.flat() as UV[]).map((uv) => uv[0])) / 2; // two islands per row at most
    for (const w of r.mesh.faces.map((_, f) => f).slice(6)) {
      const uvs = r.mesh.faceUVs![w] as UV[];
      const spreadU = Math.max(...uvs.map((uv) => uv[0])) - Math.min(...uvs.map((uv) => uv[0]));
      const spreadV = Math.max(...uvs.map((uv) => uv[1])) - Math.min(...uvs.map((uv) => uv[1]));
      // A 1 × 0.25 wall at the island's scale — nowhere near spanning 0..1.
      expect(Math.max(spreadU, spreadV)).toBeLessThanOrEqual(islandSize + 1e-6);
      expect(Math.min(spreadU, spreadV)).toBeGreaterThan(0);
    }
  });

  it("an edges-only outline extruded into a strip gets one continuous run of UVs", () => {
    const positions: [number, number, number][] = [];
    const edges: [number, number][] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      positions.push([Math.cos(a), 0, Math.sin(a)]);
      edges.push([i, (i + 1) % 6].sort((x, y) => x - y) as [number, number]);
    }
    const r = extrudeEdges({ positions, faces: [], edges }, edges);
    // Lift the copies, then fill the walls' UVs as the move does.
    const lifted: QuadMesh = { ...r.mesh, positions: r.mesh.positions.map((p, i) => (i >= 6 ? [p[0], 1, p[2]] : p) as [number, number, number]) };
    fillNewFaceUVs(lifted, r.newFaces);
    // Neighbouring walls agree on the UVs of every vertex they share, bar one seam.
    let seams = 0;
    for (const f of r.newFaces) {
      for (const g of r.newFaces) {
        if (g <= f) continue;
        const shared = lifted.faces[f].filter((v) => lifted.faces[g].includes(v));
        if (shared.length !== 2) continue;
        const agree = shared.every((v) => uvAt(lifted, f, v).every((c, k) => Math.abs(c - uvAt(lifted, g, v)[k]) < 1e-6));
        if (!agree) seams++;
      }
    }
    expect(seams).toBeLessThanOrEqual(1);
  });
});
