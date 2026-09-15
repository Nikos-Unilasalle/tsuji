import * as THREE from "three";

/**
 * Isosurface extraction from a scalar field, by Naive Surface Nets.
 *
 * Marching Cubes is the better-known algorithm for this and was the obvious
 * first choice, but it places its vertices *on* the grid edges: a surface that
 * cuts a cell diagonally comes out as a staircase of long thin triangles whose
 * normals alternate, which is exactly the look a smooth weld is supposed to
 * avoid. Surface Nets places one vertex per cell, at the average of that cell's
 * edge crossings, and connects neighbouring cell vertices into quads — the
 * vertex is free to sit anywhere inside the cell, so a flat region comes out
 * flat and a blend comes out smooth, at a quarter of the triangle count.
 *
 * The tradeoff is the opposite one: sharp features (a cube's corner) get
 * rounded off at roughly one voxel. Dual Contouring fixes that by solving a
 * QEF per cell from the field's gradient — not worth the machinery here, since
 * the caller's whole intent is rounding things off anyway.
 */

/** A regular scalar sampling lattice: `nx * ny * nz` samples, `spacing` apart, starting at `origin`. */
export interface VoxelGrid {
  nx: number;
  ny: number;
  nz: number;
  origin: THREE.Vector3;
  spacing: number;
}

/** Sample count for a grid — the length every field array over it must have. */
export function gridSampleCount(grid: VoxelGrid): number {
  return grid.nx * grid.ny * grid.nz;
}

/** Index into a field array laid out x-fastest, which is the order every sampler here fills. */
export function gridIndex(grid: VoxelGrid, x: number, y: number, z: number): number {
  return x + grid.nx * (y + grid.ny * z);
}

const CORNERS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];

const EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/** The two axes completing `axis` into a right-handed triple, so quad winding stays consistent. */
const OTHER_AXES: ReadonlyArray<readonly [number, number]> = [
  [1, 2],
  [2, 0],
  [0, 1],
];

/**
 * The zero-crossing surface of `field` over `grid`, as an indexed triangle
 * geometry with vertex normals. Negative is inside.
 *
 * Returns an empty geometry when the field never changes sign — a caller that
 * placed its grid badly gets nothing to draw rather than an exception.
 */
export function surfaceNets(field: Float32Array, grid: VoxelGrid): THREE.BufferGeometry {
  const { nx, ny, nz, spacing, origin } = grid;
  const cellsX = nx - 1;
  const cellsY = ny - 1;
  const cellsZ = nz - 1;
  const positions: number[] = [];
  const indices: number[] = [];

  if (cellsX < 1 || cellsY < 1 || cellsZ < 1) {
    return new THREE.BufferGeometry();
  }

  // -1 = this cell has no vertex (the field does not change sign across it).
  const cellVertex = new Int32Array(cellsX * cellsY * cellsZ).fill(-1);
  const cellIndex = (x: number, y: number, z: number) => x + cellsX * (y + cellsY * z);

  const corner = new Float64Array(8);
  for (let z = 0; z < cellsZ; z++) {
    for (let y = 0; y < cellsY; y++) {
      for (let x = 0; x < cellsX; x++) {
        let negatives = 0;
        for (let c = 0; c < 8; c++) {
          const [dx, dy, dz] = CORNERS[c];
          const value = field[gridIndex(grid, x + dx, y + dy, z + dz)];
          corner[c] = value;
          if (value < 0) negatives++;
        }
        if (negatives === 0 || negatives === 8) continue;

        let sx = 0;
        let sy = 0;
        let sz = 0;
        let crossings = 0;
        for (const [a, b] of EDGES) {
          const va = corner[a];
          const vb = corner[b];
          if (va < 0 === vb < 0) continue;
          // va === vb is impossible here: they straddle zero, so the divisor
          // is non-zero whenever this line is reached.
          const t = va / (va - vb);
          const ca = CORNERS[a];
          const cb = CORNERS[b];
          sx += ca[0] + (cb[0] - ca[0]) * t;
          sy += ca[1] + (cb[1] - ca[1]) * t;
          sz += ca[2] + (cb[2] - ca[2]) * t;
          crossings++;
        }

        cellVertex[cellIndex(x, y, z)] = positions.length / 3;
        positions.push(
          origin.x + (x + sx / crossings) * spacing,
          origin.y + (y + sy / crossings) * spacing,
          origin.z + (z + sz / crossings) * spacing,
        );
      }
    }
  }

  if (positions.length === 0) return new THREE.BufferGeometry();

  // One quad per sign-changing grid edge, from the four cells sharing it.
  const sample = [0, 0, 0];
  const cell = [0, 0, 0];
  const cellLimit = [cellsX, cellsY, cellsZ];
  const sampleLimit = [nx, ny, nz];
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        sample[0] = x;
        sample[1] = y;
        sample[2] = z;
        const here = field[gridIndex(grid, x, y, z)];
        for (let axis = 0; axis < 3; axis++) {
          if (sample[axis] + 1 >= sampleLimit[axis]) continue;
          const [u, v] = OTHER_AXES[axis];
          // The four cells around this edge are (u-1|u, v-1|v); all four must exist.
          if (sample[u] < 1 || sample[u] > cellLimit[u] - 1) continue;
          if (sample[v] < 1 || sample[v] > cellLimit[v] - 1) continue;

          sample[axis] += 1;
          const there = field[gridIndex(grid, sample[0], sample[1], sample[2])];
          sample[axis] -= 1;
          if (here < 0 === there < 0) continue;

          cell[0] = sample[0];
          cell[1] = sample[1];
          cell[2] = sample[2];
          cell[u] -= 1;
          cell[v] -= 1;
          const v00 = cellVertex[cellIndex(cell[0], cell[1], cell[2])];
          cell[u] += 1;
          const v10 = cellVertex[cellIndex(cell[0], cell[1], cell[2])];
          cell[v] += 1;
          const v11 = cellVertex[cellIndex(cell[0], cell[1], cell[2])];
          cell[u] -= 1;
          const v01 = cellVertex[cellIndex(cell[0], cell[1], cell[2])];
          if (v00 < 0 || v10 < 0 || v11 < 0 || v01 < 0) continue;

          // Wound so the face points from inside to outside, whichever end of
          // the edge the solid is on.
          if (here < 0) {
            indices.push(v00, v10, v11, v00, v11, v01);
          } else {
            indices.push(v00, v11, v10, v00, v01, v11);
          }
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Laplacian smoothing, in place, over the geometry's own edges.
 *
 * Surface Nets already produces a smooth blend; this is for the one-voxel
 * ripple left on surfaces that sit nearly parallel to a grid plane, where each
 * cell vertex snaps to a slightly different offset. A couple of passes at low
 * strength removes it. More than that starts eating volume — this is an
 * unweighted (umbrella) Laplacian, which shrinks convex shapes by design.
 */
export function relaxGeometry(geometry: THREE.BufferGeometry, passes: number, strength: number): void {
  const index = geometry.getIndex();
  const position = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!index || !position || passes < 1 || strength <= 0) return;

  const count = position.count;
  const neighbours: number[][] = Array.from({ length: count }, () => []);
  const array = index.array;
  for (let i = 0; i < array.length; i += 3) {
    const a = array[i];
    const b = array[i + 1];
    const c = array[i + 2];
    neighbours[a].push(b, c);
    neighbours[b].push(a, c);
    neighbours[c].push(a, b);
  }

  const src = position.array as Float32Array;
  let current = src;
  let next = new Float32Array(src.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < count; i++) {
      const list = neighbours[i];
      if (list.length === 0) {
        next[i * 3] = current[i * 3];
        next[i * 3 + 1] = current[i * 3 + 1];
        next[i * 3 + 2] = current[i * 3 + 2];
        continue;
      }
      let ax = 0;
      let ay = 0;
      let az = 0;
      for (const n of list) {
        ax += current[n * 3];
        ay += current[n * 3 + 1];
        az += current[n * 3 + 2];
      }
      ax /= list.length;
      ay /= list.length;
      az /= list.length;
      next[i * 3] = current[i * 3] + (ax - current[i * 3]) * strength;
      next[i * 3 + 1] = current[i * 3 + 1] + (ay - current[i * 3 + 1]) * strength;
      next[i * 3 + 2] = current[i * 3 + 2] + (az - current[i * 3 + 2]) * strength;
    }
    const swap = current;
    current = next;
    next = swap;
  }

  if (current !== src) src.set(current);
  position.needsUpdate = true;
  geometry.computeVertexNormals();
}
