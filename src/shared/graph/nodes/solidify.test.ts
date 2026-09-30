import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import { SOLIDIFY_NODE, solidifyGeometry, solidifyQuadMesh } from "./solidify";
import { boxProjectUVs, createQuadBox, createQuadPlane, QuadMesh } from "../quadMesh";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "solidify-test" };

describe("SOLIDIFY_NODE and Solidify functions", () => {
  it("solidifies a single quad plane into a closed 6-sided box with rim faces", () => {
    const plane = createQuadPlane(2, 2); // 4 vertices, 1 face
    expect(plane.faces.length).toBe(1);

    const solidified = solidifyQuadMesh(plane, { thickness: 0.5, offset: -1, rim: true });
    // 1 front face + 1 back face + 4 rim faces along boundary edges = 6 faces
    expect(solidified.faces.length).toBe(6);
    expect(solidified.positions.length).toBe(8); // 4 front + 4 back

    // Check depth
    const frontZ = solidified.positions[0][2];
    const backZ = solidified.positions[4][2];
    expect(Math.abs(frontZ - backZ)).toBeCloseTo(0.5);
  });

  it("omits rim faces when rim=false on an open plane", () => {
    const plane = createQuadPlane(1, 1);
    const solidified = solidifyQuadMesh(plane, { thickness: 0.2, rim: false });
    // Only 1 front + 1 back face
    expect(solidified.faces.length).toBe(2);
  });

  it("handles closed shapes (cube) with double walls and 0 rim faces", () => {
    const cube = createQuadBox(1, 1, 1); // 8 vertices, 6 faces, 0 open boundary edges
    const solidified = solidifyQuadMesh(cube, { thickness: 0.1, offset: -1, rim: true });
    // 6 front + 6 back + 0 rim = 12 faces
    expect(solidified.faces.length).toBe(12);
    expect(solidified.positions.length).toBe(16);
  });

  it("respects offset parameter (-1 inward, 0 centered, +1 outward)", () => {
    const plane = createQuadPlane(2, 2); // original z = 0, normal = (0, 0, 1)

    const inward = solidifyQuadMesh(plane, { thickness: 1.0, offset: -1.0 });
    expect(inward.positions[0][2]).toBeCloseTo(0); // front stays at 0
    expect(inward.positions[4][2]).toBeCloseTo(-1.0); // back at -1

    const centered = solidifyQuadMesh(plane, { thickness: 1.0, offset: 0.0 });
    expect(centered.positions[0][2]).toBeCloseTo(0.5); // front at +0.5
    expect(centered.positions[4][2]).toBeCloseTo(-0.5); // back at -0.5

    const outward = solidifyQuadMesh(plane, { thickness: 1.0, offset: 1.0 });
    expect(outward.positions[0][2]).toBeCloseTo(1.0); // front at +1
    expect(outward.positions[4][2]).toBeCloseTo(0.0); // back at 0
  });

  it("solidifies Three.js BufferGeometry directly", () => {
    const geom = new THREE.PlaneGeometry(2, 2); // 4 vertices, 2 triangles
    const solidified = solidifyGeometry(geom, { thickness: 0.4, offset: -1, rim: true });

    expect(solidified.getAttribute("position").count).toBe(8);
    // 2 front tris + 2 back tris + 4 boundary edges * 2 tris = 12 tris (36 indices)
    expect(solidified.index!.count).toBe(36);
  });

  it("evaluates SOLIDIFY_NODE on an incoming Mesh and preserves QuadMesh data", () => {
    const quadBox = createQuadBox(1, 1, 1);
    const geom = new THREE.BoxGeometry(1, 1, 1);
    geom.userData.quadMesh = quadBox;
    const mesh = new THREE.Mesh(geom);

    const res = SOLIDIFY_NODE.evaluate(
      { geometry: mesh },
      { thickness: 0.15, offset: -1, rim: true },
      CTX
    );

    const outMesh = res.geometry as THREE.Mesh;
    expect(outMesh).toBeInstanceOf(THREE.Mesh);
    expect(outMesh.geometry.userData.quadMesh).toBeDefined();
    const outQuad = outMesh.geometry.userData.quadMesh as QuadMesh;
    expect(outQuad.faces.length).toBe(12);
  });
});

describe("Solidify rim UVs", () => {
  it("the rim continues the front face's UVs at the thickness's scale, not the whole texture per strip", () => {
    const plane = boxProjectUVs(createQuadPlane(2, 2, 1, 1));
    const out = solidifyQuadMesh(plane, { thickness: 0.2, rim: true });
    const rims = out.faces.map((_, f) => f).slice(2);
    expect(rims).toHaveLength(4);
    for (const r of rims) {
      const uvs = out.faceUVs![r] as [number, number][];
      const spreadU = Math.max(...uvs.map((uv) => uv[0])) - Math.min(...uvs.map((uv) => uv[0]));
      const spreadV = Math.max(...uvs.map((uv) => uv[1])) - Math.min(...uvs.map((uv) => uv[1]));
      // A 2 × 0.2 strip at 1 UV per unit.
      expect(Math.max(spreadU, spreadV)).toBeCloseTo(2);
      expect(Math.min(spreadU, spreadV)).toBeCloseTo(0.2);
      // Its edge on the front face carries that face's own UVs there.
      const front = out.faces[r].filter((v) => v < plane.positions.length);
      for (const v of front) {
        const ours = uvs[out.faces[r].indexOf(v)];
        const theirs = out.faceUVs![0][out.faces[0].indexOf(v)];
        expect(ours[0]).toBeCloseTo(theirs[0]);
        expect(ours[1]).toBeCloseTo(theirs[1]);
      }
    }
  });
});
