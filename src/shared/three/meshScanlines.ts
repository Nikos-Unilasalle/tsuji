import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { getBoundsTree, initBvhRaycast } from "./bvh";
import { isRealMesh } from "./objectKinds";
import type { MeshBVH } from "three-mesh-bvh";

export type SliceAxis = "x" | "y" | "z";
export type MorphEasing = "backInOut" | "easeInOut" | "linear";
export type ScanStyle = "ribbons" | "lines" | "tubes" | "curves";

export interface ScanOptions {
  numRings: number;
  samplesPerRing: number;
  axis?: SliceAxis;
  minCoord?: number;
  maxCoord?: number;
  boundsCenter?: THREE.Vector3;
  outerRadiusMultiplier?: number;
}

export interface RingData {
  rings: Float32Array[];
  actives: boolean[];
  bounds: THREE.Box3;
  center: THREE.Vector3;
  outerRadius: number;
  minCoord: number;
  maxCoord: number;
  axis: SliceAxis;
  numRings: number;
  samplesPerRing: number;
}

export interface MorphOptions {
  progress: number;
  stagger?: number;
  bulge?: number;
  easing?: MorphEasing;
}

function easeBackInOut(t: number): number {
  const c1 = 1.70158;
  const c2 = c1 * 1.525;
  if (t < 0.5) {
    return (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2;
  }
  return (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function evaluateEasing(t: number, easing: MorphEasing): number {
  const clamped = Math.max(0, Math.min(1, t));
  if (easing === "linear") return clamped;
  if (easing === "easeInOut") return easeInOutCubic(clamped);
  return easeBackInOut(clamped);
}

interface MeshBvhEntry {
  mesh: THREE.Mesh;
  invMat: THREE.Matrix4;
}

/**
 * Collects all real meshes within an Object3D hierarchy and ensures each has a MeshBVH.
 */
function collectMeshBvhs(root: THREE.Object3D): { entries: MeshBvhEntry[]; overallBox: THREE.Box3 } {
  initBvhRaycast();
  root.updateWorldMatrix(true, true);

  const entries: MeshBvhEntry[] = [];
  const overallBox = new THREE.Box3();
  const tempBox = new THREE.Box3();

  root.traverse((child) => {
    if (!isRealMesh(child) || !child.geometry) return;
    const geom = child.geometry;
    getBoundsTree(geom);

    if (!geom.boundingBox) geom.computeBoundingBox();
    if (geom.boundingBox) {
      tempBox.copy(geom.boundingBox).applyMatrix4(child.matrixWorld);
      overallBox.union(tempBox);
    }

    entries.push({
      mesh: child,
      invMat: new THREE.Matrix4().copy(child.matrixWorld).invert(),
    });
  });

  return { entries, overallBox };
}

/**
 * Slices an Object3D into radial contour rings using BVH raycasting,
 * inspired by Makio64's venus.js demo.
 */
export function scanMeshRings(root: THREE.Object3D, options: ScanOptions): RingData {
  const axis = options.axis ?? "y";
  const numRings = Math.max(2, Math.round(options.numRings));
  const samplesPerRing = Math.max(3, Math.round(options.samplesPerRing));
  const outerMultiplier = options.outerRadiusMultiplier ?? 1.3;

  const { entries, overallBox } = collectMeshBvhs(root);

  if (entries.length === 0 || overallBox.isEmpty()) {
    const fallbackRings: Float32Array[] = [];
    const fallbackActives: boolean[] = [];
    for (let r = 0; r < numRings; r++) {
      fallbackRings.push(new Float32Array(samplesPerRing * 3));
      fallbackActives.push(false);
    }
    return {
      rings: fallbackRings,
      actives: fallbackActives,
      bounds: overallBox,
      center: new THREE.Vector3(),
      outerRadius: 1,
      minCoord: 0,
      maxCoord: 1,
      axis,
      numRings,
      samplesPerRing,
    };
  }

  const center = new THREE.Vector3();
  overallBox.getCenter(center);
  const size = new THREE.Vector3();
  overallBox.getSize(size);

  const minVal = options.minCoord ?? (axis === "x" ? overallBox.min.x : axis === "z" ? overallBox.min.z : overallBox.min.y);
  const maxVal = options.maxCoord ?? (axis === "x" ? overallBox.max.x : axis === "z" ? overallBox.max.z : overallBox.max.y);
  const span = Math.max(1e-5, maxVal - minVal);

  const radialSpan = axis === "x"
    ? Math.hypot(size.y, size.z) * 0.5
    : axis === "z"
      ? Math.hypot(size.x, size.y) * 0.5
      : Math.hypot(size.x, size.z) * 0.5;
  const outerRadius = Math.max(0.1, radialSpan * outerMultiplier);

  const rings: Float32Array[] = [];
  const actives: boolean[] = [];

  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const target = new THREE.Vector3();
  const ray = new THREE.Ray();
  const localRay = new THREE.Ray();

  for (let r = 0; r < numRings; r++) {
    const t = numRings > 1 ? r / (numRings - 1) : 0.5;
    const coord = minVal + t * span;
    const ring = new Float32Array(samplesPerRing * 3);

    let cx = center.x;
    let cy = center.y;
    let cz = center.z;

    if (axis === "x") {
      cx = coord;
      target.set(coord, cy, cz);
    } else if (axis === "z") {
      cz = coord;
      target.set(cx, cy, coord);
    } else {
      cy = coord;
      target.set(cx, coord, cz);
    }

    // Generate rays for this ring
    const rays: { origin: THREE.Vector3; dir: THREE.Vector3; hit: THREE.Vector3 | null; distance: number }[] = [];
    for (let s = 0; s < samplesPerRing; s++) {
      const angle = (s / samplesPerRing) * Math.PI * 2;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);

      if (axis === "x") {
        dir.set(0, cosA, sinA);
        origin.set(cx, cy + cosA * outerRadius, cz + sinA * outerRadius);
      } else if (axis === "z") {
        dir.set(cosA, sinA, 0);
        origin.set(cx + cosA * outerRadius, cy + sinA * outerRadius, cz);
      } else {
        dir.set(cosA, 0, sinA);
        origin.set(cx + cosA * outerRadius, cy, cz + sinA * outerRadius);
      }

      dir.negate();
      rays.push({
        origin: origin.clone(),
        dir: dir.clone(),
        hit: null,
        distance: Infinity,
      });
    }

    // Raycast across all mesh BVHs
    let ringHasHit = false;
    for (const { mesh, invMat } of entries) {
      const bvh = mesh.geometry.boundsTree as MeshBVH | undefined;
      if (!bvh) continue;

      for (const rayData of rays) {
        if (rayData.distance < 0.05) continue; // Early exit on very close hit

        ray.set(rayData.origin, rayData.dir);
        localRay.copy(ray);
        localRay.applyMatrix4(invMat);

        const hit = bvh.raycastFirst(localRay, THREE.DoubleSide);
        if (hit && hit.distance < rayData.distance) {
          const worldPoint = hit.point.clone().applyMatrix4(mesh.matrixWorld);
          rayData.hit = worldPoint;
          rayData.distance = hit.distance;
          ringHasHit = true;
        }
      }
    }

    // Resolve hits and maintain closed loop continuity
    let prevPoint = new THREE.Vector3();
    let hasHit = false;
    let firstHitIndex = -1;
    let lastHitPoint = new THREE.Vector3();

    for (let s = 0; s < samplesPerRing; s++) {
      const rayData = rays[s];
      let p: THREE.Vector3;

      if (rayData.hit) {
        p = rayData.hit;
        hasHit = true;
        if (firstHitIndex < 0) firstHitIndex = s;
        lastHitPoint.copy(p);
      } else if (hasHit) {
        // Fallback to previous hit along the contour
        p = prevPoint;
      } else {
        // Fallback to slight offset from target
        p = target.clone().addScaledVector(rayData.dir, -0.05);
      }

      prevPoint.copy(p);
      const o = s * 3;
      ring[o] = p.x;
      ring[o + 1] = p.y;
      ring[o + 2] = p.z;
    }

    // Fill leading non-hit indices with the first valid hit for clean closure
    if (firstHitIndex > 0) {
      for (let s = 0; s < firstHitIndex; s++) {
        const o = s * 3;
        ring[o] = lastHitPoint.x;
        ring[o + 1] = lastHitPoint.y;
        ring[o + 2] = lastHitPoint.z;
      }
    }

    rings.push(ring);
    actives.push(ringHasHit);
  }

  return {
    rings,
    actives,
    bounds: overallBox,
    center,
    outerRadius,
    minCoord: minVal,
    maxCoord: maxVal,
    axis,
    numRings,
    samplesPerRing,
  };
}

/**
 * Interpolates between two ring data sets (A and B) with vertical wave stagger
 * and outward bulge, matching Makio64's venus.js transition math.
 */
export function interpolateRings(
  dataA: RingData,
  dataB: RingData | null,
  options: MorphOptions,
): Float32Array[] {
  const numRings = dataA.numRings;
  const samples = dataA.samplesPerRing;
  const progress = Math.max(0, Math.min(1, options.progress));
  const stagger = Math.max(0, options.stagger ?? 0.5);
  const bulge = options.bulge ?? 0.3;
  const easing = options.easing ?? "backInOut";

  // If no target B or progress is 0, return A
  if (!dataB || progress <= 0) {
    return dataA.rings.map((r) => new Float32Array(r));
  }

  // If progress is 1, return B
  if (progress >= 1) {
    return dataB.rings.map((r) => new Float32Array(r));
  }

  const result: Float32Array[] = [];
  const axis = dataA.axis;

  for (let r = 0; r < numRings; r++) {
    const ringA = dataA.rings[r];
    const ringB = dataB.rings[r] ?? ringA;
    const ringOut = new Float32Array(samples * 3);

    const yNorm = numRings > 1 ? r / (numRings - 1) : 0.5;

    // Staggered vertical progression
    const pStagger = stagger > 0
      ? (progress * (1 + stagger) - (1 - yNorm) * stagger)
      : progress;
    const clampedP = Math.max(0, Math.min(1, pStagger));
    const easedT = evaluateEasing(clampedP, easing);

    // Bulge factor peaks around the transition midpoint
    // |1 - 2*|t - 0.5|| peaks at 1 when t=0.5, and is 0 when t=0 or 1
    const extraBulge = Math.abs(1 - 2 * Math.abs(clampedP - 0.5));
    const bulgeMultiplier = 1 + extraBulge * bulge;

    // Center reference for radial bulge expansion
    const cx = (1 - easedT) * dataA.center.x + easedT * dataB.center.x;
    const cy = (1 - easedT) * dataA.center.y + easedT * dataB.center.y;
    const cz = (1 - easedT) * dataA.center.z + easedT * dataB.center.z;

    for (let s = 0; s < samples; s++) {
      const o = s * 3;
      let px = (1 - easedT) * ringA[o] + easedT * ringB[o];
      let py = (1 - easedT) * ringA[o + 1] + easedT * ringB[o + 1];
      let pz = (1 - easedT) * ringA[o + 2] + easedT * ringB[o + 2];

      // Apply radial bulge perpendicular to the slice axis
      if (bulgeMultiplier !== 1) {
        if (axis === "x") {
          py = cy + (py - cy) * bulgeMultiplier;
          pz = cz + (pz - cz) * bulgeMultiplier;
        } else if (axis === "z") {
          px = cx + (px - cx) * bulgeMultiplier;
          py = cy + (py - cy) * bulgeMultiplier;
        } else {
          px = cx + (px - cx) * bulgeMultiplier;
          pz = cz + (pz - cz) * bulgeMultiplier;
        }
      }

      ringOut[o] = px;
      ringOut[o + 1] = py;
      ringOut[o + 2] = pz;
    }

    result.push(ringOut);
  }

  return result;
}

/**
 * Builds a 3D ribbon mesh (quad strips) from the contour rings.
 * Each ring has width/thickness along the slice axis, with UVs and normals.
 */
export function buildRibbonGeometry(
  rings: Float32Array[],
  ribbonWidth: number,
  axis: SliceAxis = "y",
  flipNormals: boolean = false,
): THREE.BufferGeometry {
  const numRings = rings.length;
  if (numRings === 0) return new THREE.BufferGeometry();

  const samples = rings[0].length / 3;
  const halfWidth = Math.max(0.0001, ribbonWidth * 0.5);

  const totalVertices = numRings * samples * 2;
  const totalQuads = numRings * samples;
  const totalIndices = totalQuads * 6;

  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const uvs = new Float32Array(totalVertices * 2);
  const indices = new Uint32Array(totalIndices);

  let vOffset = 0;
  let iOffset = 0;

  for (let r = 0; r < numRings; r++) {
    const ring = rings[r];
    const ringV = numRings > 1 ? r / (numRings - 1) : 0.5;
    const ringStartVert = r * samples * 2;

    for (let s = 0; s < samples; s++) {
      const o = s * 3;
      const x = ring[o];
      const y = ring[o + 1];
      const z = ring[o + 2];
      const u = s / samples;

      // Top vertex
      const topIdx = vOffset;
      const topO = topIdx * 3;
      positions[topO] = axis === "x" ? x + halfWidth : x;
      positions[topO + 1] = axis === "y" ? y + halfWidth : y;
      positions[topO + 2] = axis === "z" ? z + halfWidth : z;
      uvs[topIdx * 2] = u;
      uvs[topIdx * 2 + 1] = ringV + 0.05;
      vOffset++;

      // Bottom vertex
      const botIdx = vOffset;
      const botO = botIdx * 3;
      positions[botO] = axis === "x" ? x - halfWidth : x;
      positions[botO + 1] = axis === "y" ? y - halfWidth : y;
      positions[botO + 2] = axis === "z" ? z - halfWidth : z;
      uvs[botIdx * 2] = u;
      uvs[botIdx * 2 + 1] = ringV - 0.05;
      vOffset++;

      // Quad indices connecting s and (s+1)%samples
      const nextS = (s + 1) % samples;
      const t0 = ringStartVert + s * 2;
      const b0 = t0 + 1;
      const t1 = ringStartVert + nextS * 2;
      const b1 = t1 + 1;

      // Outward-facing winding: for axis 'y', (t0, t1, b1) + (t0, b1, b0)
      // For axis 'x' or 'z', (t0, b0, b1) + (t0, b1, t1)
      let flip = axis === "y";
      if (flipNormals) flip = !flip;

      if (flip) {
        // Triangle 1: t0, t1, b1
        indices[iOffset++] = t0;
        indices[iOffset++] = t1;
        indices[iOffset++] = b1;

        // Triangle 2: t0, b1, b0
        indices[iOffset++] = t0;
        indices[iOffset++] = b1;
        indices[iOffset++] = b0;
      } else {
        // Triangle 1: t0, b0, b1
        indices[iOffset++] = t0;
        indices[iOffset++] = b0;
        indices[iOffset++] = b1;

        // Triangle 2: t0, b1, t1
        indices[iOffset++] = t0;
        indices[iOffset++] = b1;
        indices[iOffset++] = t1;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  return geometry;
}

/**
 * Builds an indexed LineSegments geometry from the contour rings.
 */
export function buildLinesGeometry(rings: Float32Array[]): THREE.BufferGeometry {
  const numRings = rings.length;
  if (numRings === 0) return new THREE.BufferGeometry();

  const samples = rings[0].length / 3;
  const totalVertices = numRings * samples;
  const totalIndices = numRings * samples * 2;

  const positions = new Float32Array(totalVertices * 3);
  const indices = new Uint32Array(totalIndices);

  let vOffset = 0;
  let iOffset = 0;

  for (let r = 0; r < numRings; r++) {
    const ring = rings[r];
    const ringStartVert = r * samples;

    for (let s = 0; s < samples; s++) {
      const o = s * 3;
      const idx = vOffset;
      const vo = idx * 3;
      positions[vo] = ring[o];
      positions[vo + 1] = ring[o + 1];
      positions[vo + 2] = ring[o + 2];
      vOffset++;

      const nextS = (s + 1) % samples;
      indices[iOffset++] = ringStartVert + s;
      indices[iOffset++] = ringStartVert + nextS;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  return geometry;
}

/**
 * Builds smooth 3D tube geometries wrapping around each contour ring.
 */
export function buildTubesGeometry(
  rings: Float32Array[],
  radius: number,
  radialSegments: number = 6,
): THREE.BufferGeometry {
  const tubes: THREE.BufferGeometry[] = [];
  const rClamped = Math.max(0.001, radius);

  for (const ring of rings) {
    const samples = ring.length / 3;
    if (samples < 3) continue;

    const points: THREE.Vector3[] = [];
    for (let s = 0; s < samples; s++) {
      const o = s * 3;
      points.push(new THREE.Vector3(ring[o], ring[o + 1], ring[o + 2]));
    }

    const curve = new THREE.CatmullRomCurve3(points, true);
    tubes.push(new THREE.TubeGeometry(curve, samples, rClamped, radialSegments, true));
  }

  if (tubes.length === 0) return new THREE.BufferGeometry();
  const merged = mergeGeometries(tubes, false) ?? new THREE.BufferGeometry();
  for (const tube of tubes) tube.dispose();
  return merged;
}

/**
 * Converts contour rings to an array of point lists (Vector3[][]) for curve nodes.
 */
export function ringsToPointLists(rings: Float32Array[]): THREE.Vector3[][] {
  const result: THREE.Vector3[][] = [];
  for (const ring of rings) {
    const samples = ring.length / 3;
    const pts: THREE.Vector3[] = [];
    for (let s = 0; s < samples; s++) {
      const o = s * 3;
      pts.push(new THREE.Vector3(ring[o], ring[o + 1], ring[o + 2]));
    }
    result.push(pts);
  }
  return result;
}

/**
 * Converts contour rings to an array of closed THREE.CatmullRomCurve3 curves.
 */
export function ringsToCurves(rings: Float32Array[]): THREE.CatmullRomCurve3[] {
  const result: THREE.CatmullRomCurve3[] = [];
  for (const ring of rings) {
    const samples = ring.length / 3;
    if (samples < 3) continue;
    const pts: THREE.Vector3[] = [];
    for (let s = 0; s < samples; s++) {
      const o = s * 3;
      pts.push(new THREE.Vector3(ring[o], ring[o + 1], ring[o + 2]));
    }
    result.push(new THREE.CatmullRomCurve3(pts, true));
  }
  return result;
}
