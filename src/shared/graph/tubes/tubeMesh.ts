import * as THREE from "three";

/**
 * Tubes swept along point lists, one merged mesh for all of them, laid out so
 * a moving strand only rewrites positions: the index buffer and UVs depend on
 * how many points each strand has and nothing else, and are built once.
 *
 * Per strand: a start tip, then one ring of `radial + 1` vertices per point
 * (the last repeats the first so UVs wrap without a seam stretch), then an
 * end tip. Index 0 of a strand is its start — a spine's head, a tentacle's
 * root.
 */

export function vertsPerStrand(points: number, radial: number): number {
  return points * (radial + 1) + 2;
}

export function createTubeGeometry(counts: number[], radial: number): THREE.BufferGeometry {
  const ring = radial + 1;
  const total = Math.max(1, counts.reduce((sum, m) => sum + vertsPerStrand(m, radial), 0));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(total * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(total * 3).fill(1), 3));
  const uv = new Float32Array(total * 2);
  const index: number[] = [];
  let o = 0;
  for (const m of counts) {
    const at = (k: number, j: number) => o + 1 + k * ring + j;
    const end = o + vertsPerStrand(m, radial) - 1;
    uv[o * 2] = 0;
    uv[o * 2 + 1] = 0.5;
    for (let k = 0; k < m; k++) {
      for (let j = 0; j < ring; j++) {
        uv[at(k, j) * 2] = m > 1 ? k / (m - 1) : 0;
        uv[at(k, j) * 2 + 1] = j / radial;
      }
    }
    uv[end * 2] = 1;
    uv[end * 2 + 1] = 0.5;
    for (let j = 0; j < radial; j++) index.push(o, at(0, j + 1), at(0, j));
    for (let k = 0; k < m - 1; k++) {
      for (let j = 0; j < radial; j++) {
        const a = at(k, j), b = at(k, j + 1), d = at(k + 1, j), e = at(k + 1, j + 1);
        index.push(a, b, d, b, e, d);
      }
    }
    for (let j = 0; j < radial; j++) index.push(end, at(m - 1, j), at(m - 1, j + 1));
    o += vertsPerStrand(m, radial);
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(index);
  return geometry;
}

export interface TubeShape {
  /** Radius where the profile is 1. */
  radius: number;
  /** Height of the cross-section relative to its width: 1 round, below 1 flattened. */
  heightRatio: number;
  /**
   * Keep the cross-section's width horizontal, so a flattened body stays the
   * right way up however it turns — fish, snakes. Off, the frame is carried
   * along the strand without twisting, which suits strands that hang or
   * climb straight up (tentacles, vines) where "horizontal" stops existing.
   */
  upright: boolean;
}

/**
 * Writes one strand's tube. `points` holds its `m` points flat (x,y,z…) and
 * `width`/`height` the cross-section multipliers at each of them.
 */
export function writeTube(
  positions: THREE.BufferAttribute,
  offset: number,
  points: Float64Array,
  m: number,
  radial: number,
  width: Float64Array,
  height: Float64Array,
  shape: TubeShape,
): void {
  const ring = radial + 1;
  let fx = 1, fy = 0, fz = 0;
  let sx = 0, sy = 0, sz = 1;
  let first = true;
  for (let k = 0; k < m; k++) {
    const b = k * 3;
    if (m > 1) {
      const a0 = k > 0 ? b - 3 : b;
      const a1 = k > 0 ? b : b + 3;
      const dx = points[a0] - points[a1], dy = points[a0 + 1] - points[a1 + 1], dz = points[a0 + 2] - points[a1 + 2];
      const l = Math.hypot(dx, dy, dz);
      if (l > 1e-9) { fx = dx / l; fy = dy / l; fz = dz / l; }
    }
    const hl = Math.hypot(fx, fz);
    if (shape.upright || first) {
      if (hl > 1e-6) { sx = -fz / hl; sy = 0; sz = fx / hl; }
      else if (first) { sx = 1; sy = 0; sz = 0; }
    } else {
      // Parallel transport: last ring's side, minus whatever now points along the strand.
      const d = sx * fx + sy * fy + sz * fz;
      sx -= d * fx; sy -= d * fy; sz -= d * fz;
      const sl = Math.hypot(sx, sy, sz);
      if (sl > 1e-9) { sx /= sl; sy /= sl; sz /= sl; }
    }
    first = false;
    // up = side × forward
    const ux = sy * fz - sz * fy, uy = sz * fx - sx * fz, uz = sx * fy - sy * fx;
    const w = shape.radius * width[k];
    const h = shape.radius * shape.heightRatio * height[k];
    for (let j = 0; j < ring; j++) {
      const t = ((j % radial) / radial) * Math.PI * 2;
      const cw = Math.cos(t) * w, sh = Math.sin(t) * h;
      positions.setXYZ(offset + 1 + k * ring + j, points[b] + sx * cw + ux * sh, points[b + 1] + sy * cw + uy * sh, points[b + 2] + sz * cw + uz * sh);
    }
    // Tips stand off the end rings by most of their radius, rounding the ends instead of leaving them flat.
    if (k === 0) positions.setXYZ(offset, points[0] + fx * w * 0.9, points[1] + fy * w * 0.9, points[2] + fz * w * 0.9);
    if (k === m - 1) positions.setXYZ(offset + vertsPerStrand(m, radial) - 1, points[b] - fx * w * 0.9, points[b + 1] - fy * w * 0.9, points[b + 2] - fz * w * 0.9);
  }
}

/** The UV seam duplicates each ring's first vertex; averaging the pair's normals hides the crease that would leave. */
export function smoothSeams(geometry: THREE.BufferGeometry, counts: number[], radial: number): void {
  const normal = geometry.getAttribute("normal") as THREE.BufferAttribute;
  const ring = radial + 1;
  let o = 0;
  for (const m of counts) {
    for (let k = 0; k < m; k++) {
      const a = o + 1 + k * ring, b = a + radial;
      const x = normal.getX(a) + normal.getX(b), y = normal.getY(a) + normal.getY(b), z = normal.getZ(a) + normal.getZ(b);
      const l = Math.hypot(x, y, z) || 1;
      normal.setXYZ(a, x / l, y / l, z / l);
      normal.setXYZ(b, x / l, y / l, z / l);
    }
    o += vertsPerStrand(m, radial);
  }
  normal.needsUpdate = true;
}
