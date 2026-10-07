import * as THREE from "three";
import { getBoundsTree, initBvhRaycast } from "../three/bvh";
import { worldMatrixOf } from "./objectPosition";
import type { MeshBVH } from "three-mesh-bvh";

/**
 * Obstacles: any geometry — rocks, pillars, a character, a whole scene —
 * read as surfaces to keep away from or to stop at. Each mesh gets a BVH
 * (cached per geometry, rebuilt when its vertices change), so asking "how
 * close is the nearest surface, and which way is out?" costs a few tree
 * steps rather than a pass over every triangle. Flock steers its agents
 * around them; Ripple Field turns them into banks the waves bounce off.
 */

export interface ObstacleMesh {
  bvh: MeshBVH;
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  inverse: THREE.Matrix4;
  normalMatrix: THREE.Matrix3;
  /** Smallest axis scale of the mesh, to turn a world search radius into a local one. */
  minScale: number;
}

export interface Avoidance {
  /** Direction to push, world space, unit length. */
  x: number;
  y: number;
  z: number;
  /** 0 out of reach, 1 touching; above 1 when inside a closed obstacle. */
  weight: number;
  /** Inside a closed obstacle: the agent must be moved out, not just steered. */
  inside: boolean;
  /** Distance to the surface, world units. */
  distance: number;
}

export type Avoider = (x: number, y: number, z: number, out: Avoidance) => boolean;

const scale = new THREE.Vector3();

/** Every real mesh under `root`, with its world pose taken now. */
export function collectObstacles(root: unknown): ObstacleMesh[] {
  if (!(root instanceof THREE.Object3D)) return [];
  initBvhRaycast();
  const meshes: ObstacleMesh[] = [];
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !child.visible) return;
    const geometry = child.geometry as THREE.BufferGeometry;
    if (!geometry?.attributes?.position || geometry.attributes.position.count < 3) return;
    const matrix = worldMatrixOf(child);
    scale.setFromMatrixScale(matrix);
    meshes.push({
      bvh: getBoundsTree(geometry),
      geometry,
      matrix,
      inverse: matrix.clone().invert(),
      normalMatrix: new THREE.Matrix3().getNormalMatrix(matrix),
      minScale: Math.max(1e-6, Math.min(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z))),
    });
  });
  return meshes;
}

/** Changes when any obstacle moves, is reshaped or is swapped — for caching what is derived from them. */
export function obstaclesSignature(meshes: ObstacleMesh[]): string {
  return meshes
    .map((m) => `${m.geometry.uuid}:${(m.geometry.attributes.position as THREE.BufferAttribute).version}:${m.matrix.elements.map((e) => e.toFixed(4)).join(",")}`)
    .join("|");
}

const local = new THREE.Vector3();
const hitWorld = new THREE.Vector3();
const normal = new THREE.Vector3();
const a = new THREE.Vector3();
const b = new THREE.Vector3();
const c = new THREE.Vector3();
const hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };

function faceNormal(mesh: ObstacleMesh, faceIndex: number, out: THREE.Vector3): THREE.Vector3 {
  const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
  const index = mesh.geometry.index;
  const i0 = index ? index.getX(faceIndex * 3) : faceIndex * 3;
  const i1 = index ? index.getX(faceIndex * 3 + 1) : faceIndex * 3 + 1;
  const i2 = index ? index.getX(faceIndex * 3 + 2) : faceIndex * 3 + 2;
  a.fromBufferAttribute(pos, i0);
  b.fromBufferAttribute(pos, i1);
  c.fromBufferAttribute(pos, i2);
  return out.subVectors(c, b).cross(a.sub(b)).applyMatrix3(mesh.normalMatrix).normalize();
}

/**
 * The nearest surface within `radius` of a point, as a push: along the
 * surface normal there (outward for a closed mesh, so an agent that slipped
 * inside is pushed back out rather than deeper), strengthening as it gets
 * closer.
 */
export function makeAvoider(meshes: ObstacleMesh[], radius: number): Avoider | undefined {
  if (meshes.length === 0 || radius <= 0) return undefined;
  return (x, y, z, out) => {
    let best = Infinity;
    for (const mesh of meshes) {
      local.set(x, y, z).applyMatrix4(mesh.inverse);
      const found = mesh.bvh.closestPointToPoint(local, hit, 0, radius / mesh.minScale);
      if (!found) continue;
      hitWorld.copy(hit.point).applyMatrix4(mesh.matrix);
      const d = Math.hypot(x - hitWorld.x, y - hitWorld.y, z - hitWorld.z);
      if (d >= best || d > radius) continue;
      best = d;
      faceNormal(mesh, hit.faceIndex, normal);
      out.x = normal.x;
      out.y = normal.y;
      out.z = normal.z;
      out.distance = d;
      out.inside = (x - hitWorld.x) * normal.x + (y - hitWorld.y) * normal.y + (z - hitWorld.z) * normal.z < 0;
    }
    if (best === Infinity) return false;
    const closeness = 1 - best / radius;
    out.weight = out.inside ? 1 + closeness : closeness * closeness;
    return true;
  };
}
