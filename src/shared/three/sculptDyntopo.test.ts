import { describe, test, expect } from "vitest";
import * as THREE from "three";
import { buildBasePrimitive } from "./sculptMesh";
import { refineNearBrush } from "./sculptDyntopo";

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
        expect(Math.max(ab, bc, ca)).toBeLessThanOrEqual(detailSize + 1e-6);
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
});
