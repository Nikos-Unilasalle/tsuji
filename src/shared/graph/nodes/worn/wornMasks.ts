import * as THREE from "three";
import type { WornEntry } from "./wornGeometry";

/*
 * The Worn masks on the CPU, so the rest of the graph can use them: where the
 * wear is, where the dirt settled — to grow moss in the grime, shed dust
 * from the dirty parts, scatter rust flakes along the chipped edges.
 *
 * The same inputs as the shader (the baked edges, curvature, occlusion, the
 * painted masks) and the same falloffs, minus the noise: the bands come out
 * clean where on screen they break up, so this is the shape of the
 * weathering rather than its every chip.
 */

export const WORN_MASKS = ["wear", "dirt", "dust", "occlusion"] as const;
export type WornMask = (typeof WORN_MASKS)[number];

type Uniforms = Record<string, { value: any }>;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Distance from p to the segment a–b. */
function segmentDistance(p: THREE.Vector3, edges: Float32Array, o: number): number {
  const ax = edges[o], ay = edges[o + 1], az = edges[o + 2];
  const abx = edges[o + 4] - ax, aby = edges[o + 5] - ay, abz = edges[o + 6] - az;
  const len2 = Math.max(abx * abx + aby * aby + abz * abz, 1e-12);
  const t = Math.max(0, Math.min(1, ((p.x - ax) * abx + (p.y - ay) * aby + (p.z - az) * abz) / len2));
  return Math.hypot(p.x - (ax + abx * t), p.y - (ay + aby * t), p.z - (az + abz * t));
}

export interface WornSurfacePoint {
  /** Which triangle of the prepared geometry, and where on it (rest space). */
  triangle: number;
  rest: THREE.Vector3;
  /** Curvature ×size, occlusion (1 open), painted colour. */
  curvature: number;
  open: number;
  paint: THREE.Vector3;
  /** World-space normal. */
  normal: THREE.Vector3;
}

/** The value of one mask at one point of a prepared geometry, 0–1. */
export function wornMaskAt(entry: WornEntry, u: Uniforms, mask: WornMask, point: WornSurfacePoint): number {
  if (mask === "occlusion") return 1 - point.open;

  const paintOn = u.uPaintMask.value > 0.5;
  const pr = paintOn ? point.paint.x : 0, pg = paintOn ? point.paint.y : 0, pb = paintOn ? point.paint.z : 0;
  const guard = 1 - Math.max(0, Math.min(1, pb - Math.max(pr, pg)));
  const occlusion = 1 - point.open;

  if (mask === "dust") {
    const up = smoothstep(0.25, 0.9, point.normal.y);
    return Math.min(1, (up * 0.85 + occlusion * 0.6) * u.uDustAmount.value) * guard;
  }

  // Edge bands: the triangle's listed feature edges, combined as the shader does.
  const wearing = mask === "wear";
  const amount = wearing ? u.uWearAmount.value : u.uDirtAmount.value;
  const width = Math.max(0.0001, amount * 0.25 * u.uWidthScale.value);
  const { edges, lists, listStarts, listCounts } = entry.data;
  let band = 0;
  if (amount > 0.001) {
    for (let i = 0; i < listCounts[point.triangle]; i++) {
      const e = lists[listStarts[point.triangle] * 4 + i];
      if (e < 0) continue;
      const angle = edges[e * 8 + 3];
      if (wearing !== angle > 0) continue;
      const strength = smoothstep(u.uEdgeAngle.value, u.uEdgeAngle.value + 30, Math.abs(angle));
      if (strength <= 0) continue;
      const f = smoothstep(width, 0, segmentDistance(point.rest, edges, e * 8)) * strength;
      band = 1 - (1 - band) * (1 - f);
    }
  }
  const contrast = u.uContrast.value;
  if (contrast > 0.1 && contrast !== 1) band = Math.pow(band, contrast);

  const curv = point.curvature * u.uCurveSensitivity.value;
  let value = band;
  if (wearing) {
    value = Math.max(value, smoothstep(0.6, 2.2, curv) * u.uCurveWear.value);
    value = Math.max(value, Math.max(0, Math.min(1, pr - Math.max(pg, pb))));
  } else {
    value = Math.max(value, smoothstep(0.6, 2.2, -curv) * u.uCurveDirt.value);
    value = Math.max(value, smoothstep(0.12, 0.65, occlusion) * u.uCavityDirt.value);
    value = Math.max(value, Math.max(0, Math.min(1, pg - Math.max(pr, pb))));
  }
  return Math.min(1, value) * guard;
}

/** A small, fast, seeded generator (mulberry32). */
function random(seed: number) {
  let a = (Math.floor(seed) * 2654435761) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface WornPointsOptions {
  mask: WornMask;
  count: number;
  /** Points only where the mask is at least this. */
  threshold: number;
  seed: number;
}

export interface WornPointsResult {
  x: number[];
  y: number[];
  z: number[];
  /** Share of the surface area the mask covers (its mean, area-weighted). */
  coverage: number;
}

interface Target {
  mesh: THREE.Mesh;
  entry: WornEntry;
  u: Uniforms;
  areas: Float64Array;
  total: number;
}

function wornTargets(root: THREE.Object3D): Target[] {
  const targets: Target[] = [];
  root.updateWorldMatrix(true, true);
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) return;
    const entry = mesh.geometry?.userData?.__wornEntry as WornEntry | undefined;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const u = materials.map((m) => (m as any)?.__wornUniforms).find(Boolean) as Uniforms | undefined;
    if (!entry || !u) return;
    const pos = mesh.geometry.getAttribute("position");
    const triangles = Math.floor(pos.count / 3);
    const areas = new Float64Array(triangles);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    let total = 0;
    for (let t = 0; t < triangles; t++) {
      a.fromBufferAttribute(pos, t * 3).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, t * 3 + 1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, t * 3 + 2).applyMatrix4(mesh.matrixWorld);
      total += b.sub(a).cross(c.sub(a)).length() / 2;
      areas[t] = total;
    }
    if (total > 0) targets.push({ mesh, entry, u, areas, total });
  });
  return targets;
}

/**
 * Points scattered over every Worn-drawn mesh under `root`, as many as asked
 * where the mask is (denser where it is stronger), in world space.
 */
export function sampleWornPoints(root: THREE.Object3D, options: WornPointsOptions): WornPointsResult {
  const result: WornPointsResult = { x: [], y: [], z: [], coverage: 0 };
  const targets = wornTargets(root);
  const total = targets.reduce((s, t) => s + t.total, 0);
  if (total <= 0) return result;

  const rand = random(options.seed);
  const point: WornSurfacePoint = {
    triangle: 0, rest: new THREE.Vector3(), curvature: 0, open: 1, paint: new THREE.Vector3(), normal: new THREE.Vector3(),
  };
  const world = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  let maskSum = 0;
  let tries = 0;
  const count = Math.max(0, Math.floor(options.count));
  const maxTries = Math.max(400, count * 40);
  while (tries < maxTries && (result.x.length < count || tries < 400)) {
    tries++;
    // A point uniformly over the whole area: a mesh, a triangle, a spot on it.
    let pick = rand() * total;
    let target = targets[0];
    for (const t of targets) {
      if (pick <= t.total) { target = t; break; }
      pick -= t.total;
    }
    let lo = 0, hi = target.areas.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (target.areas[mid] < pick) lo = mid + 1;
      else hi = mid;
    }
    const tri = lo;
    let r1 = rand(), r2 = rand();
    if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
    const w = [1 - r1 - r2, r1, r2];

    const g = target.mesh.geometry;
    const blend = (name: string, out: THREE.Vector3, size: number) => {
      const attr = g.getAttribute(name);
      out.set(0, 0, 0);
      if (!attr) return out;
      for (let k = 0; k < 3; k++) {
        const i = tri * 3 + k;
        out.x += attr.getX(i) * w[k];
        if (size > 1) out.y += attr.getY(i) * w[k];
        if (size > 2) out.z += attr.getZ(i) * w[k];
      }
      return out;
    };
    point.triangle = tri;
    blend("aWornRest", point.rest, 3);
    blend("aWornSurface", tmp, 2);
    point.curvature = tmp.x;
    point.open = tmp.y;
    blend("aWornPaint", point.paint, 3);
    normalMatrix.getNormalMatrix(target.mesh.matrixWorld);
    blend("normal", point.normal, 3).applyMatrix3(normalMatrix).normalize();

    const value = wornMaskAt(target.entry, target.u, options.mask, point);
    if (tries <= 400) maskSum += value;
    if (result.x.length >= count || value < options.threshold || rand() > value) continue;
    blend("position", world, 3).applyMatrix4(target.mesh.matrixWorld);
    result.x.push(world.x);
    result.y.push(world.y);
    result.z.push(world.z);
  }
  result.coverage = maskSum / Math.min(tries, 400);
  return result;
}
