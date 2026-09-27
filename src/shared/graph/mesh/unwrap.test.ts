import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { bufferGeometryToQuadMesh, createQuadBox, createQuadPlane } from "../quadMesh";
import { smartUnwrap } from "./unwrap";
import { setEdgeFlag } from "./attributes";

/** UV-space area per unit of surface area, per face. */
function density(mesh: ReturnType<typeof createQuadBox>) {
  return mesh.faces.map((face, f) => {
    const uv = mesh.faceUVs![f];
    const p = face.map((v) => new THREE.Vector3(...mesh.positions[v]));
    let a3 = 0, a2 = 0;
    for (let i = 1; i < face.length - 1; i++) {
      a3 += p[i].clone().sub(p[0]).cross(p[i + 1].clone().sub(p[0])).length() / 2;
      a2 += Math.abs((uv[i][0] - uv[0][0]) * (uv[i + 1][1] - uv[0][1]) - (uv[i][1] - uv[0][1]) * (uv[i + 1][0] - uv[0][0])) / 2;
    }
    return a2 / a3;
  });
}

describe("smartUnwrap", () => {
  it("lays a cube out as six non-overlapping, equally dense squares in 0..1", () => {
    const out = smartUnwrap(createQuadBox(1, 2, 3));
    for (const uvs of out.faceUVs!) for (const [u, v] of uvs) {
      expect(u).toBeGreaterThanOrEqual(-1e-9);
      expect(u).toBeLessThanOrEqual(1 + 1e-9);
      expect(v).toBeGreaterThanOrEqual(-1e-9);
      expect(v).toBeLessThanOrEqual(1 + 1e-9);
    }
    const d = density(out);
    for (const x of d) expect(x).toBeCloseTo(d[0], 6);
    // Bounding boxes of the six faces don't overlap.
    const boxes = out.faceUVs!.map((uvs) => new THREE.Box2().setFromPoints(uvs.map(([u, v]) => new THREE.Vector2(u, v))));
    for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) {
      const overlap = boxes[i].clone().intersect(boxes[j]);
      expect(overlap.isEmpty() || overlap.getSize(new THREE.Vector2()).x * overlap.getSize(new THREE.Vector2()).y < 1e-9).toBe(true);
    }
  });

  it("keeps a flat grid one connected island", () => {
    const plane = createQuadPlane(2, 1, 4, 2);
    const out = smartUnwrap(plane);
    // Shared vertices get the same UV in every face using them.
    const seen = new Map<number, string>();
    out.faces.forEach((face, f) => face.forEach((v, i) => {
      const key = out.faceUVs![f][i].map((x) => x.toFixed(6)).join(",");
      if (seen.has(v)) expect(seen.get(v)).toBe(key);
      seen.set(v, key);
    }));
  });

  it("cuts along seams", () => {
    const plane = createQuadPlane(2, 1, 2, 1); // two quads sharing edge 1–4
    const cut = smartUnwrap(setEdgeFlag(plane, "seamEdges", [[1, 4]]));
    const uvOf = (f: number, v: number) => cut.faceUVs![f][cut.faces[f].indexOf(v)].join(",");
    expect(uvOf(0, 1)).not.toBe(uvOf(1, 1));
  });

  it("doesn't fold a cylinder onto itself", () => {
    const out = smartUnwrap(bufferGeometryToQuadMesh(new THREE.CylinderGeometry(1, 1, 2, 16, 1, true)));
    for (const x of density(out)) expect(x).toBeGreaterThan(0);
    // Faces on opposite sides project onto the same spot if the side is one
    // island; as separate islands their UVs don't overlap.
    const normal = (f: number) => {
      const p = out.faces[f].map((v) => new THREE.Vector3(...out.positions[v]));
      return p[1].clone().sub(p[0]).cross(p[2].clone().sub(p[0])).normalize();
    };
    let opposite = 1;
    for (let f = 1; f < out.faces.length; f++) if (normal(f).dot(normal(0)) < normal(opposite).dot(normal(0))) opposite = f;
    const box = (f: number) => new THREE.Box2().setFromPoints(out.faceUVs![f].map(([u, v]) => new THREE.Vector2(u, v)));
    const overlap = box(0).intersect(box(opposite));
    expect(overlap.isEmpty() || overlap.getSize(new THREE.Vector2()).x * overlap.getSize(new THREE.Vector2()).y < 1e-9).toBe(true);
  });
});
