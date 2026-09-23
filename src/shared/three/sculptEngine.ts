import * as THREE from "three";
import { SculptMeshData } from "./sculptMesh";
import { BrushFalloff, calculateFalloff, strokeBaseStrength } from "./brushFalloff";

export type SculptBrushTool =
  | "draw"
  | "clay"
  | "inflate"
  | "smooth"
  | "flatten"
  | "grab"
  | "pinch"
  | "crease"
  | "mask";

export interface SculptStrokeParams3D {
  tool: SculptBrushTool;
  falloff: BrushFalloff;
  radius: number;
  strength: number;
  invert: boolean;
  /** Current raycast hit, local space — the brush footprint is centered here every call (matches Terrain's convention). */
  hitPoint: THREE.Vector3;
  /** Current raycast hit normal, local space. */
  hitNormal: THREE.Vector3;
  /** Frozen at stroke start — Draw/Flatten/Crease/Grab all anchor to this instead of the (moving) current hit, so a stroke doesn't drift. */
  strokeOrigin: THREE.Vector3;
  strokeNormal: THREE.Vector3;
  /** Incremental local-space pointer movement since the last call — only used by Grab. */
  moveDelta?: THREE.Vector3;
  deltaTime?: number;
  maskErase?: boolean;
  symmetryX?: boolean;
  symmetryY?: boolean;
  symmetryZ?: boolean;
}

/** Finds the vertex nearest `point` by brute-force scan — fine at sculpt-mesh sizes; a spatial index is a documented perf fast-follow if this is ever too slow at high subdivision. */
function findNearestVertex(positions: Float32Array, point: THREE.Vector3): number {
  let best = 0;
  let bestDist = Infinity;
  const count = positions.length / 3;
  for (let i = 0; i < count; i++) {
    const dx = positions[i * 3] - point.x;
    const dy = positions[i * 3 + 1] - point.y;
    const dz = positions[i * 3 + 2] - point.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** BFS-expands from the nearest vertex to `center` out to `radius`, using real mesh adjacency — this is the 3D equivalent of Terrain's grid-bbox footprint. */
function gatherVerticesInRadius(
  positions: Float32Array,
  adjacency: number[][],
  center: THREE.Vector3,
  radius: number,
): Map<number, number> {
  const distByVertex = new Map<number, number>();
  const seed = findNearestVertex(positions, center);
  const seedDist = Math.hypot(
    positions[seed * 3] - center.x,
    positions[seed * 3 + 1] - center.y,
    positions[seed * 3 + 2] - center.z,
  );
  if (seedDist > radius) return distByVertex;

  const queue = [seed];
  distByVertex.set(seed, seedDist);
  while (queue.length > 0) {
    const v = queue.shift() as number;
    for (const n of adjacency[v] ?? []) {
      if (distByVertex.has(n)) continue;
      const d = Math.hypot(
        positions[n * 3] - center.x,
        positions[n * 3 + 1] - center.y,
        positions[n * 3 + 2] - center.z,
      );
      if (d <= radius) {
        distByVertex.set(n, d);
        queue.push(n);
      }
    }
  }
  return distByVertex;
}

function applyStrokeAtOrigin(
  mesh: SculptMeshData,
  adjacency: number[][],
  origin: THREE.Vector3,
  normal: THREE.Vector3,
  moveDelta: THREE.Vector3 | undefined,
  stroke: SculptStrokeParams3D,
  baseStrength: number,
): void {
  const { positions, normals, mask } = mesh;
  const r = Math.max(0.001, stroke.radius);

  const maskFor = (v: number) => (mask ? 1 - mask[v] : 1);
  const displace = (v: number, dx: number, dy: number, dz: number) => {
    const m = maskFor(v);
    if (m <= 0) return;
    positions[v * 3] += dx * m;
    positions[v * 3 + 1] += dy * m;
    positions[v * 3 + 2] += dz * m;
  };

  if (stroke.tool === "mask") {
    const verts = gatherVerticesInRadius(positions, adjacency, stroke.hitPoint, r);
    if (!mesh.mask) return;
    const dir = stroke.maskErase ? -1 : 1;
    const factor = baseStrength * 0.6;
    for (const [v, d] of verts) {
      const w = calculateFalloff(d / r, stroke.falloff);
      mesh.mask[v] = Math.max(0, Math.min(1, mesh.mask[v] + dir * w * factor));
    }
    return;
  }

  const center = stroke.tool === "flatten" || stroke.tool === "grab" || stroke.tool === "crease"
    ? origin
    : stroke.hitPoint;
  const verts = gatherVerticesInRadius(positions, adjacency, center, r);
  if (verts.size === 0) return;

  if (stroke.tool === "draw") {
    const dir = stroke.invert ? -1 : 1;
    // Scaled by radius, not just strength: an unscaled constant makes a tiny
    // brush spike a peak taller than its own footprint on first touch. Real
    // sculpt brushes read as "gentle bump the size of the brush", which this
    // keeps true across the whole radius range.
    const factor = dir * baseStrength * r * 0.15;
    for (const [v, d] of verts) {
      const w = calculateFalloff(d / r, stroke.falloff) * factor;
      displace(v, normal.x * w, normal.y * w, normal.z * w);
    }
    return;
  }

  if (stroke.tool === "inflate") {
    const dir = stroke.invert ? -1 : 1;
    const factor = dir * baseStrength * r * 0.12;
    for (const [v, d] of verts) {
      const w = calculateFalloff(d / r, stroke.falloff) * factor;
      displace(v, normals[v * 3] * w, normals[v * 3 + 1] * w, normals[v * 3 + 2] * w);
    }
    return;
  }

  if (stroke.tool === "smooth" || stroke.tool === "pinch") {
    const sign = stroke.tool === "pinch" ? -1 : 1;
    const factor = baseStrength * (stroke.tool === "pinch" ? 0.3 : 0.35) * sign;
    const deltas = new Map<number, THREE.Vector3>();
    for (const [v, d] of verts) {
      const neighbors = adjacency[v] ?? [];
      if (neighbors.length === 0) continue;
      let ax = 0, ay = 0, az = 0;
      for (const n of neighbors) {
        ax += positions[n * 3];
        ay += positions[n * 3 + 1];
        az += positions[n * 3 + 2];
      }
      ax /= neighbors.length;
      ay /= neighbors.length;
      az /= neighbors.length;
      const w = calculateFalloff(d / r, stroke.falloff) * factor;
      deltas.set(v, new THREE.Vector3(
        (ax - positions[v * 3]) * w,
        (ay - positions[v * 3 + 1]) * w,
        (az - positions[v * 3 + 2]) * w,
      ));
    }
    for (const [v, delta] of deltas) displace(v, delta.x, delta.y, delta.z);
    return;
  }

  if (stroke.tool === "flatten" || stroke.tool === "clay") {
    // Flatten projects onto the plane frozen at stroke start; Clay re-targets
    // the brush-local average along that same normal every call, building
    // material up instead of leveling to one fixed plane.
    let planeD = normal.dot(origin);
    if (stroke.tool === "clay") {
      let sum = 0;
      for (const v of verts.keys()) sum += normal.dot(new THREE.Vector3(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]));
      planeD = verts.size > 0 ? sum / verts.size : planeD;
    }
    const factor = baseStrength * (stroke.tool === "clay" ? 0.5 : 0.4);
    for (const [v, d] of verts) {
      const p = new THREE.Vector3(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
      const dist = normal.dot(p) - planeD;
      const w = calculateFalloff(d / r, stroke.falloff) * factor;
      displace(v, -normal.x * dist * w, -normal.y * dist * w, -normal.z * dist * w);
    }
    return;
  }

  if (stroke.tool === "crease") {
    let ax = 0, ay = 0, az = 0;
    for (const v of verts.keys()) {
      ax += positions[v * 3];
      ay += positions[v * 3 + 1];
      az += positions[v * 3 + 2];
    }
    if (verts.size > 0) {
      ax /= verts.size;
      ay /= verts.size;
      az /= verts.size;
    }
    const pinchFactor = baseStrength * 0.3;
    const dir = stroke.invert ? 1 : -1;
    const creaseFactor = dir * baseStrength * r * 0.15;
    for (const [v, d] of verts) {
      const w = calculateFalloff(d / r, stroke.falloff);
      const tightW = calculateFalloff(Math.min(1, (d / r) * 2), stroke.falloff);
      const px = positions[v * 3], py = positions[v * 3 + 1], pz = positions[v * 3 + 2];
      displace(
        v,
        (ax - px) * w * pinchFactor + normal.x * tightW * creaseFactor,
        (ay - py) * w * pinchFactor + normal.y * tightW * creaseFactor,
        (az - pz) * w * pinchFactor + normal.z * tightW * creaseFactor,
      );
    }
    return;
  }

  if (stroke.tool === "grab" && moveDelta) {
    for (const [v, d] of verts) {
      const w = calculateFalloff(d / r, stroke.falloff) * baseStrength;
      displace(v, moveDelta.x * w, moveDelta.y * w, moveDelta.z * w);
    }
    return;
  }
}

/**
 * Applies one 3D sculpt brush stroke, mirroring `terrainSculpt.ts`'s
 * `applySculptStroke` shape but operating on real per-vertex 3D positions
 * instead of a heightfield. Mutates `mesh.positions`/`mesh.mask` in place;
 * callers should recompute normals (see `computeVertexNormals`) after the
 * stroke settles, same "mutate live, sync once" cadence as Terrain.
 */
export function applySculptStroke3D(
  mesh: SculptMeshData,
  adjacency: number[][],
  stroke: SculptStrokeParams3D,
): void {
  const baseStrength = strokeBaseStrength(stroke.strength, stroke.deltaTime);
  applyStrokeAtOrigin(mesh, adjacency, stroke.strokeOrigin, stroke.strokeNormal, stroke.moveDelta, stroke, baseStrength);

  const mirrored = (v: THREE.Vector3, x: boolean, y: boolean, z: boolean) =>
    new THREE.Vector3(x ? -v.x : v.x, y ? -v.y : v.y, z ? -v.z : v.z);

  const axes: [boolean, boolean, boolean][] = [];
  if (stroke.symmetryX) axes.push([true, false, false]);
  if (stroke.symmetryY) axes.push([false, true, false]);
  if (stroke.symmetryZ) axes.push([false, false, true]);
  if (stroke.symmetryX && stroke.symmetryY) axes.push([true, true, false]);
  if (stroke.symmetryX && stroke.symmetryZ) axes.push([true, false, true]);
  if (stroke.symmetryY && stroke.symmetryZ) axes.push([false, true, true]);
  if (stroke.symmetryX && stroke.symmetryY && stroke.symmetryZ) axes.push([true, true, true]);

  for (const [mx, my, mz] of axes) {
    const mirroredStroke: SculptStrokeParams3D = {
      ...stroke,
      hitPoint: mirrored(stroke.hitPoint, mx, my, mz),
    };
    applyStrokeAtOrigin(
      mesh,
      adjacency,
      mirrored(stroke.strokeOrigin, mx, my, mz),
      mirrored(stroke.strokeNormal, mx, my, mz),
      stroke.moveDelta ? mirrored(stroke.moveDelta, mx, my, mz) : undefined,
      mirroredStroke,
      baseStrength,
    );
  }
}
