import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { PROFILED_TUBES_NODE } from "./profiledTubes";
import { EvalContext } from "../types";
import { createTubeGeometry, smoothSeams, vertsPerStrand, writeTube } from "../tubes/tubeMesh";

const ctx = (nodeId: string): EvalContext => ({ nodeId, time: 0, step: 0 });
const line = (n: number, dx = -0.2, z = 0) => Array.from({ length: n }, (_, k) => new THREE.Vector3(k * dx, 0, z));
const params = (overrides: Record<string, unknown> = {}) => ({ ...(PROFILED_TUBES_NODE.defaultParams as Record<string, unknown>), ...overrides });

describe("tube mesh", () => {
  test("normals face outwards, seams included", () => {
    const geometry = createTubeGeometry([6], 8);
    const pts = new Float64Array(line(6).flatMap((v) => [v.x, v.y, v.z]));
    const ones = new Float64Array(6).fill(1);
    writeTube(geometry.getAttribute("position") as THREE.BufferAttribute, 0, pts, 6, 8, ones, ones, { radius: 0.1, heightRatio: 0.6, upright: true });
    geometry.computeVertexNormals();
    smoothSeams(geometry, [6], 8);
    const pos = geometry.getAttribute("position");
    const nrm = geometry.getAttribute("normal");
    for (let v = 1; v < vertsPerStrand(6, 8) - 1; v++) {
      // The strand runs along X, so a ring vertex's outward direction is its own Y/Z.
      expect(pos.getY(v) * nrm.getY(v) + pos.getZ(v) * nrm.getZ(v)).toBeGreaterThan(0);
    }
  });

  test("Keep Upright holds the flat side horizontal; off, a vertical strand still gets round rings", () => {
    const geometry = createTubeGeometry([4], 8);
    const pts = new Float64Array([0, 0, 0, 0, -0.3, 0, 0, -0.6, 0, 0, -0.9, 0]);
    const ones = new Float64Array(4).fill(1);
    writeTube(geometry.getAttribute("position") as THREE.BufferAttribute, 0, pts, 4, 8, ones, ones, { radius: 0.1, heightRatio: 1, upright: false });
    const pos = geometry.getAttribute("position");
    for (let v = 1; v < vertsPerStrand(4, 8) - 1; v++) {
      expect(Math.hypot(pos.getX(v), pos.getZ(v))).toBeCloseTo(0.1, 6);
    }
  });
});

describe("PROFILED_TUBES_NODE", () => {
  test("with nothing wired, returns an empty but valid mesh", () => {
    const out = PROFILED_TUBES_NODE.evaluate({}, params(), ctx("tubes-empty"));
    expect(out.geometry).toBeInstanceOf(THREE.Mesh);
  });

  test("one tube per list, the same mesh and geometry while the layout holds", () => {
    const a = PROFILED_TUBES_NODE.evaluate({ pointLists: [line(5), line(5, -0.2, 2)] }, params(), ctx("tubes-two")).geometry as THREE.Mesh;
    const g = a.geometry;
    expect(g.getAttribute("position").count).toBe(2 * vertsPerStrand(5, 10));
    const b = PROFILED_TUBES_NODE.evaluate({ pointLists: [line(5, -0.3), line(5, -0.3, 2)] }, params(), ctx("tubes-two")).geometry as THREE.Mesh;
    expect(b).toBe(a);
    expect(b.geometry).toBe(g);
  });

  test("lists too short or full of junk are skipped", () => {
    const out = PROFILED_TUBES_NODE.evaluate({ pointLists: [[new THREE.Vector3()], ["x", null], line(3)] }, params(), ctx("tubes-junk"));
    expect((out.geometry as THREE.Mesh).geometry.getAttribute("position").count).toBe(vertsPerStrand(3, 10));
  });

  test("Radius × Strand Length scales each tube with its own strand", () => {
    const out = PROFILED_TUBES_NODE.evaluate(
      { pointLists: [line(5, -0.5), line(5, -0.25, 3)] },
      params({ relativeRadius: true, radius: 0.1, widthProfile: [{ x: 0, y: 1 }, { x: 1, y: 1 }], heightRatio: 1 }),
      ctx("tubes-relative"),
    );
    const pos = (out.geometry as THREE.Mesh).geometry.getAttribute("position");
    const per = vertsPerStrand(5, 10);
    expect(Math.hypot(pos.getY(1), pos.getZ(1))).toBeCloseTo(0.2, 5);
    expect(Math.hypot(pos.getY(per + 1), pos.getZ(per + 1) - 3)).toBeCloseTo(0.1, 5);
  });

  test("patches paint vertex colours, off leaves them white", () => {
    const on = PROFILED_TUBES_NODE.evaluate({ pointLists: [line(8)] }, params({ patches: true }), ctx("tubes-patch")).geometry as THREE.Mesh;
    const colors = Array.from(on.geometry.getAttribute("color").array as Float32Array);
    expect(colors.some((c) => c < 0.9)).toBe(true);
    expect((on.material as THREE.MeshStandardMaterial).vertexColors).toBe(true);
    const off = PROFILED_TUBES_NODE.evaluate({ pointLists: [line(8)] }, params({ patches: false }), ctx("tubes-patch")).geometry as THREE.Mesh;
    expect(Array.from(off.geometry.getAttribute("color").array as Float32Array).every((c) => c === 1)).toBe(true);
    expect((off.material as THREE.MeshStandardMaterial).vertexColors).toBe(false);
  });
});
