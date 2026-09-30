import type { QuadMesh } from "../quadMesh";

export type UV = [number, number];

export interface UVBounds {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
  span: number;
}

export function uvBounds(mesh: QuadMesh): UVBounds {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const p of mesh.positions) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
    if (p[2] < minZ) minZ = p[2];
    if (p[2] > maxZ) maxZ = p[2];
  }
  const span = Math.max(maxX - minX || 1, maxY - minY || 1, maxZ - minZ || 1) || 1;
  return { minX, maxX, minY, maxY, minZ, maxZ, span };
}

/**
 * UV units per scene unit for every projection made when there is nothing
 * better to go on (a face with no neighbour to continue, a mesh with no UVs).
 * Fixed, rather than fitted to the mesh's current extent: a face's projected
 * UVs then depend on that face alone, so moving a vertex, extruding or growing
 * the mesh never shifts or rescales the texture anywhere else, and every face
 * has the same texel density. The +0.5 lines a unit-sized object centred on
 * its origin up with the 0..1 square, as the old fitted projection did.
 */
export const UV_DENSITY = 1;
const UV_OFFSET = 0.5;

/**
 * Box-projection UVs for one face: projected on the plane its normal is
 * closest to, in object space at UV_DENSITY.
 */
export function boxProjectFace(mesh: QuadMesh, face: number[], normal: { x: number; y: number; z: number }): UV[] {
  const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
  const d = UV_DENSITY;
  return face.map((vIdx) => {
    const p = mesh.positions[vIdx];
    if (ax >= ay && ax >= az) {
      // Right (+X): U along -Z; Left (-X): U along +Z. V along +Y.
      return [(normal.x > 0 ? -p[2] : p[2]) * d + UV_OFFSET, p[1] * d + UV_OFFSET];
    }
    if (ay >= ax && ay >= az) {
      // Top (+Y): V along -Z; Bottom (-Y): V along +Z. U along +X.
      return [p[0] * d + UV_OFFSET, (normal.y > 0 ? -p[2] : p[2]) * d + UV_OFFSET];
    }
    // Front (+Z): U along +X; Back (-Z): U along -X. V along +Y.
    return [(normal.z > 0 ? p[0] : -p[0]) * d + UV_OFFSET, p[1] * d + UV_OFFSET];
  });
}

type V3 = [number, number, number];
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: readonly number[]) => Math.sqrt(dot(a, a));
const scaled = (a: readonly number[], s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];

/** A face's unit normal (Newell's method: robust for n-gons), or zero for a degenerate face. */
function faceNormal(mesh: QuadMesh, face: number[]): V3 {
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < face.length; i++) {
    const a = mesh.positions[face[i]];
    const b = mesh.positions[face[(i + 1) % face.length]];
    if (!a || !b) continue;
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = length(n);
  return l > 1e-12 ? scaled(n, 1 / l) : [0, 0, 0];
}

const edgeKeyOf = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);

/**
 * Face `f`'s UVs unfolded flat across its edge a–b from neighbour `g`, which
 * has UVs: a and b keep exactly `g`'s UVs there (no seam along that edge), the
 * rest of `f` lands on the far side of the edge from `g`, at the same scale
 * as `g` has along the edge. Null when the edge is degenerate in 3D or in UV.
 */
function unfoldAcross(mesh: QuadMesh, f: number, g: number, a: number, b: number): UV[] | null {
  const F = mesh.faces[f];
  const G = mesh.faces[g];
  const gUVs = mesh.faceUVs![g];
  const uvA = gUVs[G.indexOf(a)];
  const uvB = gUVs[G.indexOf(b)];
  const pa = mesh.positions[a];
  const pb = mesh.positions[b];
  if (!uvA || !uvB || !pa || !pb) return null;

  const edge = sub(pb, pa);
  const edgeLength = length(edge);
  const du = uvB[0] - uvA[0];
  const dv = uvB[1] - uvA[1];
  const uvLength = Math.hypot(du, dv);
  if (edgeLength < 1e-12 || uvLength < 1e-12) return null;
  const scale = uvLength / edgeLength;
  const along = scaled(edge, 1 / edgeLength);
  const dUV: UV = [du / uvLength, dv / uvLength];
  const nUV: UV = [-dUV[1], dUV[0]];

  // The in-plane direction across the edge, in 3D.
  let across = cross(faceNormal(mesh, F), along);
  const acrossLength = length(across);
  if (acrossLength < 1e-12) {
    // A face with no area yet (an extrusion before it moves): flat along the edge.
    across = [0, 0, 0];
  } else {
    across = scaled(across, 1 / acrossLength);
  }

  // Which side of the edge g covers in UV, and which side f covers in 3D.
  let gSide = 0;
  for (let i = 0; i < G.length && gSide === 0; i++) {
    const c = gUVs[i];
    if (G[i] === a || G[i] === b || !c) continue;
    gSide = Math.sign(du * (c[1] - uvA[1]) - dv * (c[0] - uvA[0]));
  }
  let fSide = 0;
  for (const v of F) {
    if (v === a || v === b || !mesh.positions[v]) continue;
    fSide = Math.sign(dot(sub(mesh.positions[v], pa), across));
    if (fSide !== 0) break;
  }
  // f goes on the side g doesn't cover.
  const flip = -(gSide || 1) * (fSide || 1);

  return F.map((v) => {
    const d = sub(mesh.positions[v] ?? pa, pa);
    const s = dot(d, along) * scale;
    const t = dot(d, across) * scale * flip;
    return [uvA[0] + dUV[0] * s + nUV[0] * t, uvA[1] + dUV[1] * s + nUV[1] * t];
  });
}

/**
 * UVs for faces an operation just created (extrusion walls, bridges, bevel
 * strips, fills). Each continues the UV layout of a neighbour that has UVs —
 * unfolded flat across their shared edge, from the most coplanar neighbour
 * (the least distortion), so the texture runs on across it at the same scale
 * instead of restarting with a projection of its own. Faces reached only
 * through other new faces follow on from those; a group touching no UV'd face
 * at all (an edges-only outline extruded into a strip) starts from one
 * box-projected face and unfolds from there.
 */
export function fillNewFaceUVs(mesh: QuadMesh, faces: number[], sources?: ReadonlySet<number>): void {
  const pending = new Set(faces.filter((f) => mesh.faces[f]?.length >= 3));
  if (pending.size === 0) return;
  const faceUVs = mesh.faceUVs!;
  while (faceUVs.length < mesh.faces.length) faceUVs.push([]);

  const byEdge = new Map<string, number[]>();
  mesh.faces.forEach((face, f) => {
    for (let i = 0; i < face.length; i++) {
      const key = edgeKeyOf(face[i], face[(i + 1) % face.length]);
      const list = byEdge.get(key);
      if (list) list.push(f);
      else byEdge.set(key, [f]);
    }
  });
  const normals = new Map<number, V3>();
  const normalOf = (f: number) => {
    let n = normals.get(f);
    if (!n) normals.set(f, (n = faceNormal(mesh, mesh.faces[f])));
    return n;
  };
  // `sources`: when given, only those faces (and the ones filled here) may be continued from.
  const own = new Set(faces);
  const hasUVs = (g: number) =>
    !pending.has(g) && faceUVs[g]?.length === mesh.faces[g].length && (!sources || sources.has(g) || own.has(g));

  while (pending.size > 0) {
    let progressed = false;
    for (const f of [...pending]) {
      const face = mesh.faces[f];
      let best: { g: number; a: number; b: number } | null = null;
      let bestDot = -Infinity;
      for (let i = 0; i < face.length; i++) {
        const a = face[i];
        const b = face[(i + 1) % face.length];
        for (const g of byEdge.get(edgeKeyOf(a, b)) ?? []) {
          if (g === f || !hasUVs(g)) continue;
          const d = dot(normalOf(f), normalOf(g));
          // Ties (a rim square to both faces it joins) go to the older face — the
          // lower index, the original rather than a copy an operation made.
          if (d > bestDot + 1e-9 || (Math.abs(d - bestDot) <= 1e-9 && best && g < best.g)) {
            bestDot = d;
            best = { g, a, b };
          }
        }
      }
      const uvs = best && unfoldAcross(mesh, f, best.g, best.a, best.b);
      if (!uvs) continue;
      faceUVs[f] = uvs;
      pending.delete(f);
      progressed = true;
    }
    if (!progressed) {
      // Nothing left touches a face with UVs: seed one, the rest follow it.
      const [seed] = pending;
      const n = normalOf(seed);
      faceUVs[seed] = boxProjectFace(mesh, mesh.faces[seed], { x: n[0], y: n[1], z: n[2] });
      pending.delete(seed);
    }
  }
}

export const lerpUV = (a: UV, b: UV, t: number): UV => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

export function averageUV(uvs: UV[]): UV {
  let u = 0, v = 0;
  for (const uv of uvs) {
    u += uv[0];
    v += uv[1];
  }
  return uvs.length ? [u / uvs.length, v / uvs.length] : [0, 0];
}
