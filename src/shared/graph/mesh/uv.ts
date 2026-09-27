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
 * Box-projection UVs for one face: projected on the plane its normal is
 * closest to, scaled by the whole mesh's uniform span (so faces stay
 * consistent with each other). The per-face half of boxProjectUVs.
 */
export function boxProjectFace(mesh: QuadMesh, face: number[], normal: { x: number; y: number; z: number }, b: UVBounds): UV[] {
  const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
  return face.map((vIdx) => {
    const p = mesh.positions[vIdx];
    if (ax >= ay && ax >= az) {
      // Right (+X): U along -Z; Left (-X): U along +Z. V along +Y.
      return [normal.x > 0 ? (b.maxZ - p[2]) / b.span : (p[2] - b.minZ) / b.span, (p[1] - b.minY) / b.span];
    }
    if (ay >= ax && ay >= az) {
      // Top (+Y): V along -Z; Bottom (-Y): V along +Z. U along +X.
      return [(p[0] - b.minX) / b.span, normal.y > 0 ? (b.maxZ - p[2]) / b.span : (p[2] - b.minZ) / b.span];
    }
    // Front (+Z): U along +X; Back (-Z): U along -X. V along +Y.
    return [normal.z > 0 ? (p[0] - b.minX) / b.span : (b.maxX - p[0]) / b.span, (p[1] - b.minY) / b.span];
  });
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
