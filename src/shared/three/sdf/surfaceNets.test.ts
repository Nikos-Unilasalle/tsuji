import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { VoxelGrid, gridIndex, gridSampleCount, relaxGeometry, surfaceNets } from "./surfaceNets";
import { smoothMax, smoothMin } from "./meshSdf";

const GRID: VoxelGrid = { nx: 33, ny: 33, nz: 33, origin: new THREE.Vector3(-2, -2, -2), spacing: 0.125 };

function fill(grid: VoxelGrid, f: (p: THREE.Vector3) => number): Float32Array {
  const field = new Float32Array(gridSampleCount(grid));
  const p = new THREE.Vector3();
  for (let z = 0; z < grid.nz; z++) {
    for (let y = 0; y < grid.ny; y++) {
      for (let x = 0; x < grid.nx; x++) {
        p.set(grid.origin.x + x * grid.spacing, grid.origin.y + y * grid.spacing, grid.origin.z + z * grid.spacing);
        field[gridIndex(grid, x, y, z)] = f(p);
      }
    }
  }
  return field;
}

const sphere = (centre: THREE.Vector3, radius: number) => (p: THREE.Vector3) => p.distanceTo(centre) - radius;

/** The mean of `dot(normal, vertex - centre)`, positive when faces point away from an enclosed centre. */
function outwardness(geometry: THREE.BufferGeometry, centre: THREE.Vector3): number {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  let total = 0;
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i).sub(centre).normalize();
    n.fromBufferAttribute(normal, i);
    total += v.dot(n);
  }
  return total / position.count;
}

describe("surfaceNets", () => {
  test("extracts a sphere at the right radius", () => {
    const centre = new THREE.Vector3(0, 0, 0);
    const geometry = surfaceNets(fill(GRID, sphere(centre, 1)), GRID);
    const position = geometry.getAttribute("position");
    expect(position.count).toBeGreaterThan(100);

    const v = new THREE.Vector3();
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < position.count; i++) {
      const r = v.fromBufferAttribute(position, i).length();
      min = Math.min(min, r);
      max = Math.max(max, r);
    }
    expect(min).toBeGreaterThan(1 - GRID.spacing);
    expect(max).toBeLessThan(1 + GRID.spacing);
  });

  test("faces point outwards", () => {
    const geometry = surfaceNets(fill(GRID, sphere(new THREE.Vector3(), 1)), GRID);
    expect(outwardness(geometry, new THREE.Vector3())).toBeGreaterThan(0.9);
  });

  test("closed surface — every edge is shared by exactly two triangles", () => {
    const geometry = surfaceNets(fill(GRID, sphere(new THREE.Vector3(), 1)), GRID);
    const index = geometry.getIndex()!;
    const counts = new Map<string, number>();
    for (let i = 0; i < index.count; i += 3) {
      const tri = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      for (let e = 0; e < 3; e++) {
        const a = tri[e];
        const b = tri[(e + 1) % 3];
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    expect([...counts.values()].every((c) => c === 2)).toBe(true);
  });

  test("a field that never changes sign yields nothing to draw", () => {
    const geometry = surfaceNets(fill(GRID, () => 1), GRID);
    expect(geometry.getAttribute("position")).toBeUndefined();
  });

  test("a smooth union bulges at the seam where a hard union creases", () => {
    const a = sphere(new THREE.Vector3(-0.5, 0, 0), 0.8);
    const b = sphere(new THREE.Vector3(0.5, 0, 0), 0.8);
    const hard = surfaceNets(fill(GRID, (p) => smoothMin(a(p), b(p), 0)), GRID);
    const soft = surfaceNets(fill(GRID, (p) => smoothMin(a(p), b(p), 0.5)), GRID);

    // The waist: how far the surface reaches from the axis in the plane x = 0,
    // which is exactly where the two spheres cross.
    const waist = (geometry: THREE.BufferGeometry) => {
      const position = geometry.getAttribute("position");
      let max = 0;
      for (let i = 0; i < position.count; i++) {
        if (Math.abs(position.getX(i)) > GRID.spacing) continue;
        max = Math.max(max, Math.hypot(position.getY(i), position.getZ(i)));
      }
      return max;
    };
    // The hard union creases at the circle where the spheres cross (r = 0.62);
    // the k = 0.5 fillet pushes that out by most of a tenth of a unit.
    expect(waist(soft)).toBeGreaterThan(waist(hard) + 0.05);
  });

  test("relax keeps the surface on the sphere it came from", () => {
    const geometry = surfaceNets(fill(GRID, sphere(new THREE.Vector3(), 1)), GRID);
    relaxGeometry(geometry, 2, 0.5);
    const position = geometry.getAttribute("position");
    const v = new THREE.Vector3();
    let worst = 0;
    for (let i = 0; i < position.count; i++) {
      worst = Math.max(worst, Math.abs(v.fromBufferAttribute(position, i).length() - 1));
    }
    expect(worst).toBeLessThan(3 * GRID.spacing);
  });
});

describe("smoothMin", () => {
  test("k = 0 is a plain min", () => {
    expect(smoothMin(3, 7, 0)).toBe(3);
    expect(smoothMin(-2, 5, 0)).toBe(-2);
  });

  test("never exceeds the plain min, and dips furthest where the two are equal", () => {
    expect(smoothMin(1, 1, 1)).toBeCloseTo(1 - 0.25, 6);
    expect(smoothMin(0, 4, 1)).toBe(0);
    expect(smoothMin(0, 0.5, 1)).toBeLessThan(0);
  });

  test("smoothMax mirrors it", () => {
    expect(smoothMax(1, 1, 1)).toBeCloseTo(1.25, 6);
    expect(smoothMax(3, 7, 0)).toBe(7);
  });
});
