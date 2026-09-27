type Vec3 = readonly [number, number, number];

/**
 * Splits one polygon face into triangles, as corner indices into the face
 * (not vertex indices), wound the same way as the face.
 *
 * A fan from corner 0 — what every consumer did before — is only right for a
 * convex face: a concave quad (a dart, a quad whose corner was dragged
 * inward) or an L-shaped n-gon folded over itself and rendered, picked and
 * highlighted a surface that isn't there.
 *
 * - Triangles: as-is.
 * - Quads: the 0–2 diagonal, unless it falls outside a concave quad, then 1–3.
 *   Keeping 0–2 for every convex quad means nothing changes for them.
 * - N-gons: ear clipping in the face's own plane (Newell normal), falling back
 *   to a fan if the polygon is too degenerate to clip.
 */
export function triangulateFace(
  positions: ReadonlyArray<Vec3>,
  face: ReadonlyArray<number>,
  /** The face's normal when the caller already has it (saves recomputing it per face). */
  knownNormal?: Vec3,
): [number, number, number][] {
  const n = face.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];

  const normal = knownNormal ?? newellNormal(positions, face);

  if (n === 4) {
    // The 0–2 split is valid when both of its triangles face the same way as
    // the quad: a reflex corner at 1 or 3 flips one of them.
    const ok02 = sameSide(positions, face, 0, 1, 2, normal) && sameSide(positions, face, 0, 2, 3, normal);
    if (ok02) return [[0, 1, 2], [0, 2, 3]];
    const ok13 = sameSide(positions, face, 0, 1, 3, normal) && sameSide(positions, face, 1, 2, 3, normal);
    return ok13 ? [[0, 1, 3], [1, 2, 3]] : [[0, 1, 2], [0, 2, 3]];
  }

  return earClip(positions, face, normal) ?? fan(n);
}

function fan(n: number): [number, number, number][] {
  const tris: [number, number, number][] = [];
  for (let i = 1; i < n - 1; i++) tris.push([0, i, i + 1]);
  return tris;
}

function newellNormal(positions: ReadonlyArray<Vec3>, face: ReadonlyArray<number>): Vec3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < face.length; i++) {
    const c = positions[face[i]];
    const d = positions[face[(i + 1) % face.length]];
    if (!c || !d) continue;
    x += (c[1] - d[1]) * (c[2] + d[2]);
    y += (c[2] - d[2]) * (c[0] + d[0]);
    z += (c[0] - d[0]) * (c[1] + d[1]);
  }
  const len = Math.hypot(x, y, z);
  return len > 1e-12 ? [x / len, y / len, z / len] : [0, 0, 1];
}

function sameSide(
  positions: ReadonlyArray<Vec3>,
  face: ReadonlyArray<number>,
  i: number,
  j: number,
  k: number,
  normal: Vec3,
): boolean {
  const a = positions[face[i]], b = positions[face[j]], c = positions[face[k]];
  if (!a || !b || !c) return true;
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  return cx * normal[0] + cy * normal[1] + cz * normal[2] >= 0;
}

/**
 * Ear clipping on the face projected into its own plane. With a Newell normal
 * the polygon is counter-clockwise in the (u, v) basis built below, so every
 * ear comes out with the face's winding.
 */
function earClip(
  positions: ReadonlyArray<Vec3>,
  face: ReadonlyArray<number>,
  normal: Vec3,
): [number, number, number][] | null {
  const n = face.length;
  // An in-plane basis: u perpendicular to the normal, v = normal × u.
  const [nx, ny, nz] = normal;
  let ux: number, uy: number, uz: number;
  if (Math.abs(nx) < 0.9) [ux, uy, uz] = [0, nz, -ny];
  else [ux, uy, uz] = [-nz, 0, nx];
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;

  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = positions[face[i]];
    if (!p) return null;
    px[i] = p[0] * ux + p[1] * uy + p[2] * uz;
    py[i] = p[0] * vx + p[1] * vy + p[2] * vz;
  }

  const cross = (a: number, b: number, c: number) =>
    (px[b] - px[a]) * (py[c] - py[a]) - (py[b] - py[a]) * (px[c] - px[a]);
  const inside = (p: number, a: number, b: number, c: number) =>
    cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;

  const remaining: number[] = Array.from({ length: n }, (_, i) => i);
  const tris: [number, number, number][] = [];
  let guard = n * n;
  while (remaining.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let r = 0; r < remaining.length; r++) {
      const a = remaining[(r + remaining.length - 1) % remaining.length];
      const b = remaining[r];
      const c = remaining[(r + 1) % remaining.length];
      if (cross(a, b, c) <= 1e-18) continue; // reflex or degenerate corner
      let blocked = false;
      for (const p of remaining) {
        if (p === a || p === b || p === c) continue;
        if (inside(p, a, b, c)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      tris.push([a, b, c]);
      remaining.splice(r, 1);
      clipped = true;
      break;
    }
    if (!clipped) return null;
  }
  if (remaining.length === 3) tris.push([remaining[0], remaining[1], remaining[2]]);
  return tris.length === n - 2 ? tris : null;
}
