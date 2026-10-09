import { describe, test, expect } from "vitest";
import * as THREE from "three";
import { buildAdjacency, buildBasePrimitive } from "./sculptMesh";
import { refineNearBrush } from "./sculptDyntopo";
import { applySculptStroke3D } from "./sculptEngine";

function triangleStats(mesh: ReturnType<typeof buildBasePrimitive>, near: THREE.Vector3, within: number) {
  let worstAspect = 0;
  let longest = 0;
  let count = 0;
  const p = mesh.positions;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
    const d = (i: number, j: number) => Math.hypot(p[i * 3] - p[j * 3], p[i * 3 + 1] - p[j * 3 + 1], p[i * 3 + 2] - p[j * 3 + 2]);
    const cx = (p[a * 3] + p[b * 3] + p[c * 3]) / 3 - near.x;
    const cy = (p[a * 3 + 1] + p[b * 3 + 1] + p[c * 3 + 1]) / 3 - near.y;
    const cz = (p[a * 3 + 2] + p[b * 3 + 2] + p[c * 3 + 2]) / 3 - near.z;
    if (Math.hypot(cx, cy, cz) > within) continue;
    const e = [d(a, b), d(b, c), d(c, a)];
    longest = Math.max(longest, ...e);
    worstAspect = Math.max(worstAspect, Math.max(...e) / Math.max(1e-9, Math.min(...e)));
    count++;
  }
  return { worstAspect, longest, count };
}

function boundaryEdgeCount(mesh: ReturnType<typeof buildBasePrimitive>): number {
  const counts = new Map<string, number>();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const u = mesh.indices[t + e];
      const v = mesh.indices[t + ((e + 1) % 3)];
      const k = u < v ? `${u}_${v}` : `${v}_${u}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const c of counts.values()) if (c !== 2) bad++;
  return bad;
}

describe("sculptDyntopo refineNearBrush", () => {
  test("splits coarse triangles near the hit point, leaving far ones untouched", () => {
    const mesh = buildBasePrimitive("sphere", 1, 4.0); // coarse: radius 2
    const beforeTriCount = mesh.indices.length / 3;
    const hitPoint = new THREE.Vector3(mesh.positions[0], mesh.positions[1], mesh.positions[2]);

    const refined = refineNearBrush(mesh, hitPoint, 0.8, 0.2);
    const afterTriCount = refined.indices.length / 3;

    expect(afterTriCount).toBeGreaterThan(beforeTriCount);
  });

  test("is bounded: edges within the brush radius end up at or below detailSize", () => {
    // One call performs one split round (matching the real per-stroke-call
    // cadence in Viewport.tsx); a stroke that needs several halvings
    // converges over repeated calls, same as a continuous drag would.
    let mesh = buildBasePrimitive("sphere", 1, 4.0);
    const hitPoint = new THREE.Vector3(mesh.positions[0], mesh.positions[1], mesh.positions[2]);
    const detailSize = 0.15;
    for (let i = 0; i < 6; i++) {
      mesh = refineNearBrush(mesh, hitPoint, 0.5, detailSize);
    }
    const refined = mesh;

    for (let t = 0; t < refined.indices.length; t += 3) {
      const a = refined.indices[t], b = refined.indices[t + 1], c = refined.indices[t + 2];
      const centerDist = (v: number) =>
        Math.hypot(
          refined.positions[v * 3] - hitPoint.x,
          refined.positions[v * 3 + 1] - hitPoint.y,
          refined.positions[v * 3 + 2] - hitPoint.z,
        );
      // Only assert on triangles safely inside the brush (away from the
      // propagation boundary, where a triangle may legitimately still be
      // large because it's the edge of the refined region).
      if (centerDist(a) < 0.2 && centerDist(b) < 0.2 && centerDist(c) < 0.2) {
        const ax = refined.positions[a * 3], ay = refined.positions[a * 3 + 1], az = refined.positions[a * 3 + 2];
        const bx = refined.positions[b * 3], by = refined.positions[b * 3 + 1], bz = refined.positions[b * 3 + 2];
        const cx = refined.positions[c * 3], cy = refined.positions[c * 3 + 1], cz = refined.positions[c * 3 + 2];
        const ab = Math.hypot(bx - ax, by - ay, bz - az);
        const bc = Math.hypot(cx - bx, cy - by, cz - bz);
        const ca = Math.hypot(ax - cx, ay - cy, az - cz);
        expect(Math.max(ab, bc, ca)).toBeLessThanOrEqual(detailSize * (4 / 3) + 1e-6);
      }
    }
  });

  test("nothing qualifies when the hit point is far from the mesh: geometry untouched", () => {
    const mesh = buildBasePrimitive("sphere", 2, 4.0);
    const hitPoint = new THREE.Vector3(1000, 1000, 1000);
    const refined = refineNearBrush(mesh, hitPoint, 0.5, 0.001);
    expect(refined.indices.length).toBe(mesh.indices.length);
    expect(refined.positions.length).toBe(mesh.positions.length);
  });

  test("one dab on a coarse default sphere leaves well-shaped, brush-sized triangles", () => {
    const base = buildBasePrimitive("sphere", 2, 2.0); // radius 1, edges ~0.4
    const hit = new THREE.Vector3(0, 1, 0);
    const radius = 0.3;
    const refined = refineNearBrush(base, hit, radius * 1.5, radius * 0.25);
    const stats = triangleStats(refined, hit, radius);
    expect(stats.count).toBeGreaterThan(20);
    // Nothing under the brush is much bigger than the brush itself, and no slivers.
    expect(stats.longest).toBeLessThan(radius * 0.25 * (4 / 3) + 1e-6);
    expect(stats.worstAspect).toBeLessThan(4);
  });

  test("refinement keeps the surface watertight and consistently oriented", () => {
    for (const kind of ["sphere", "cube"] as const) {
      const base = buildBasePrimitive(kind, kind === "sphere" ? 2 : 8, 2.0);
      const hit = new THREE.Vector3(0, 1, 0);
      const refined = refineNearBrush(base, hit, 0.45, 0.075);
      expect(boundaryEdgeCount(refined)).toBe(0);
      // Every directed edge appears once -> orientation is globally consistent.
      const directed = new Set<string>();
      for (let t = 0; t < refined.indices.length; t += 3) {
        for (let e = 0; e < 3; e++) {
          const k = `${refined.indices[t + e]}>${refined.indices[t + ((e + 1) % 3)]}`;
          expect(directed.has(k)).toBe(false);
          directed.add(k);
        }
      }
    }
  });

  test("a dab on a cube keeps it a cube (no sphere-projection bulge)", () => {
    const base = buildBasePrimitive("cube", 8, 2.0);
    const refined = refineNearBrush(base, new THREE.Vector3(1, 1, 1), 0.6, 0.08);
    for (let i = 0; i < refined.positions.length; i += 3) {
      const m = Math.max(Math.abs(refined.positions[i]), Math.abs(refined.positions[i + 1]), Math.abs(refined.positions[i + 2]));
      expect(m).toBeCloseTo(1, 4);
    }
  });

  test("sculpting right after a refine keeps neighbouring triangles proportioned", () => {
    const base = buildBasePrimitive("sphere", 2, 2.0);
    const hit = new THREE.Vector3(0, 1, 0);
    const radius = 0.3;
    const refined = refineNearBrush(base, hit, radius * 1.5, radius * 0.25);
    const adjacency = buildAdjacency(refined.indices, refined.positions.length / 3);
    applySculptStroke3D(refined, adjacency, {
      tool: "draw",
      falloff: "smooth",
      radius,
      strength: 0.5,
      invert: false,
      hitPoint: hit,
      hitNormal: new THREE.Vector3(0, 1, 0),
      strokeOrigin: hit,
      strokeNormal: new THREE.Vector3(0, 1, 0),
      deltaTime: 0.03,
    });
    expect(triangleStats(refined, new THREE.Vector3(0, 1, 0), radius * 1.5).worstAspect).toBeLessThan(6);
  });
});
