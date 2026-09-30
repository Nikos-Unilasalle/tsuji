import * as THREE from "three";
import { UV_DENSITY } from "./uv";

/**
 * UVs for a surface built from nothing that has any (a weld's distance field,
 * metaballs, an extrusion of a mesh with no UVs): each vertex projected along
 * the axis its normal is closest to, in object space at UV_DENSITY — the same
 * rule and scale as a QuadMesh's box projection, so the texture neither
 * slides nor rescales when the surface moves or grows.
 *
 * Per vertex, because these surfaces share vertices between faces: it seams
 * wherever the dominant axis flips, which is why Triplanar exists for them.
 * Writes into the geometry's existing uv attribute when it has room.
 */
export function projectGeometryUVs(geometry: THREE.BufferGeometry, count?: number): void {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  if (!position || !normal) return;
  const n = Math.min(count ?? position.count, position.count, normal.count);
  const existing = geometry.getAttribute("uv") as THREE.BufferAttribute | undefined;
  const uv = existing && existing.count >= n ? existing : new THREE.BufferAttribute(new Float32Array(position.count * 2), 2);
  const d = UV_DENSITY;
  for (let i = 0; i < n; i++) {
    const px = position.getX(i) * d;
    const py = position.getY(i) * d;
    const pz = position.getZ(i) * d;
    const ax = Math.abs(normal.getX(i));
    const ay = Math.abs(normal.getY(i));
    const az = Math.abs(normal.getZ(i));
    const [u, v] = ax >= ay && ax >= az ? [pz, py] : ay >= az ? [px, pz] : [px, py];
    uv.setXY(i, u + 0.5, v + 0.5);
  }
  if (uv !== existing) geometry.setAttribute("uv", uv);
  uv.needsUpdate = true;
}
