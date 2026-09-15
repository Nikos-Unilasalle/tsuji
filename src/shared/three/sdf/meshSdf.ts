import * as THREE from "three";
import { getBoundsTree } from "../bvh";
import { VoxelGrid, gridIndex, gridSampleCount } from "./surfaceNets";

/**
 * Turning a triangle mesh into a signed distance field sampled on a voxel grid.
 *
 * Distance itself is a BVH closest-point query per sample. The *sign* is the
 * expensive half done naively — an inside/outside test per sample is a raycast
 * per sample, N^3 of them. It is done here one grid row at a time instead: a
 * single ray along +X through a whole row crosses the surface at a set of
 * points, and every sample on that row is inside exactly when an odd number of
 * those crossings lies behind it. That is N^2 rays for N^3 samples.
 *
 * Parity needs every crossing, front and back faces alike, so the cast is
 * DoubleSide. It also assumes the mesh is watertight — an open surface has no
 * meaningful inside, and the field will read as solid on one side of the hole.
 */

/** A grid covering `box` (already padded by the caller) at roughly `resolution` samples along its longest axis. */
export function voxelGridFor(box: THREE.Box3, resolution: number): VoxelGrid {
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  // A degenerate box (a flat or empty input) would otherwise divide by zero
  // and ask for an infinite grid.
  const spacing = longest > 0 ? longest / Math.max(2, resolution) : 1;
  return {
    nx: Math.max(2, Math.ceil(size.x / spacing) + 1),
    ny: Math.max(2, Math.ceil(size.y / spacing) + 1),
    nz: Math.max(2, Math.ceil(size.z / spacing) + 1),
    origin: box.min.clone(),
    spacing,
  };
}

/**
 * The signed distance to `geometry` at every sample of `grid`, negative inside.
 *
 * Distances are clamped to ±`band`: past that the exact value is not used for
 * anything (no isosurface, and no blend — see the band note in smoothUnion),
 * and the clamp is what makes it affordable, since a bounded query lets the BVH
 * reject whole subtrees instead of descending to the nearest triangle.
 *
 * `geometry` must be in the same space as the grid; the caller bakes world
 * transforms in first.
 */
export function sampleSignedDistance(geometry: THREE.BufferGeometry, grid: VoxelGrid, band: number): Float32Array {
  const bvh = getBoundsTree(geometry);
  const field = new Float32Array(gridSampleCount(grid)).fill(band);
  const { nx, ny, nz, origin, spacing } = grid;

  const point = new THREE.Vector3();
  const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(1, 0, 0));
  const startX = origin.x - spacing;

  for (let z = 0; z < nz; z++) {
    const pz = origin.z + z * spacing;
    for (let y = 0; y < ny; y++) {
      const py = origin.y + y * spacing;
      ray.origin.set(startX, py, pz);
      const crossings = bvh
        .raycast(ray, THREE.DoubleSide)
        .map((hit: THREE.Intersection) => startX + hit.distance)
        .sort((a: number, b: number) => a - b);

      let next = 0;
      let inside = false;
      for (let x = 0; x < nx; x++) {
        const px = origin.x + x * spacing;
        while (next < crossings.length && crossings[next] <= px) {
          inside = !inside;
          next++;
        }
        const hit = bvh.closestPointToPoint(point.set(px, py, pz), target, 0, band);
        const distance = hit ? hit.distance : band;
        field[gridIndex(grid, x, y, z)] = inside ? -distance : distance;
      }
    }
  }
  return field;
}

/**
 * Polynomial smooth minimum (Inigo Quilez). `k` is the radius of the fillet:
 * the two fields blend where they come within `k` of each other, and the result
 * is plain `min` — a hard union — everywhere else, so `k = 0` degenerates to a
 * boolean union exactly.
 *
 * The quadratic form rather than the exponential one: it reaches the untouched
 * `min` at a finite distance instead of asymptotically, which is what lets the
 * band clamp in sampleSignedDistance be safe.
 */
export function smoothMin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b + (a - b) * h - k * h * (1 - h);
}

/** Smooth maximum, the same fillet on the other side — intersection, and (with a negated field) subtraction. */
export function smoothMax(a: number, b: number, k: number): number {
  return -smoothMin(-a, -b, k);
}
