import * as THREE from "three";
import { NodeDefinition } from "../types";
import { isRealMesh } from "../../three/objectKinds";
import { clearMeshWarning, warnMeshRequired } from "../meshRequired";
import { createNodeCache } from "../nodeCaches";
import { getBoundsTree, sampleSurfacePoints, sampleVolumePoints } from "../../three/bvh";
import { asColor, numberInput } from "./object";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

/** Raycast Node — casts a single ray against a mesh surface (BVH-accelerated). */
function asVector3(val: unknown, fallback: THREE.Vector3): THREE.Vector3 {
  if (val instanceof THREE.Vector3) return val;
  if (val instanceof THREE.Matrix4) return new THREE.Vector3().setFromMatrixPosition(val);
  if (val instanceof THREE.Object3D) {
    return new THREE.Vector3().setFromMatrixPosition(val.matrixWorld);
  }
  // Params loaded from a .tsuji file carry plain {x, y, z} objects, not Vector3s.
  if (val && typeof val === "object" && "x" in val && "y" in val && "z" in val) {
    const v = val as { x: number; y: number; z: number };
    return new THREE.Vector3(v.x, v.y, v.z);
  }
  return fallback.clone();
}

/**
 * The raycastable meshes of an object, with their world matrices refreshed and
 * their BVH built. Ray Burst fires thousands of rays at the *same* object, and
 * both of those are per-object work, not per-ray — doing them inside the ray
 * loop made every frame O(rays x meshes) matrix walks.
 */
function collectTargets(object: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  object.traverse((child) => {
    if (!isRealMesh(child) || !child.geometry?.attributes?.position) return;
    // updateWorldMatrix (NOT updateMatrix): graph-driven meshes carry their
    // pose in `matrix` with matrixAutoUpdate off — updateMatrix() would
    // recompute `matrix` from the untouched defaults and destroy it. `force`
    // is required since matrix.copy() never sets matrixWorldNeedsUpdate.
    child.updateWorldMatrix(true, false, true);
    // Opt the geometry into the accelerated raycast (builds its BVH once).
    getBoundsTree(child.geometry);
    meshes.push(child);
  });
  return meshes;
}

/** The ray hits across a prepared mesh set, sorted by distance. */
function castRayAgainst(
  meshes: THREE.Mesh[],
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  maxDistance: number,
  firstHitOnly: boolean,
): THREE.Intersection[] {
  const raycaster = new THREE.Raycaster(origin.clone(), direction.clone().normalize(), 0, maxDistance);
  raycaster.firstHitOnly = firstHitOnly;

  const hits: THREE.Intersection[] = [];
  for (const mesh of meshes) {
    const h = raycaster.intersectObject(mesh, false);
    if (h.length > 0) hits.push(...h);
  }
  hits.sort((a, b) => a.distance - b.distance);
  return hits;
}

/** The nearest ray hit across every mesh of an object, sorted by distance. */
function castRay(
  object: THREE.Object3D,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  maxDistance: number,
  firstHitOnly: boolean,
): THREE.Intersection[] {
  return castRayAgainst(collectTargets(object), origin, direction, maxDistance, firstHitOnly);
}

export const RAYCAST_NODE: NodeDefinition = {
  type: "physics/raycast",
  label: "Raycast",
  category: "physics",
  inputs: [
    { id: "geometry", label: "Surface", type: "geometry" },
    { id: "origin", label: "Origin", type: "vector" },
    { id: "direction", label: "Direction", type: "vector" },
    { id: "maxDistance", label: "Max Distance", type: "value" },
  ],
  outputs: [
    { id: "hit", label: "Hit (0/1)", type: "value" },
    { id: "point", label: "Hit Point", type: "vector" },
    { id: "normal", label: "Hit Normal", type: "vector" },
    { id: "distance", label: "Distance", type: "value" },
  ],
  defaultParams: {
    origin: new THREE.Vector3(0, 0, 0),
    direction: new THREE.Vector3(0, 0, -1),
    maxDistance: 100,
    firstHitOnly: 1,
  },
  dynamicParamFields: () => [
    { id: "origin", label: "Origin", kind: "vector" },
    { id: "direction", label: "Direction", kind: "vector" },
    { id: "maxDistance", label: "Max Distance", kind: "number", step: 1 },
    { id: "firstHitOnly", label: "First Hit Only (Fast)", kind: "boolean" },
  ],
  evaluate: (inputs, params) => {
    const object = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    const zero = new THREE.Vector3();
    if (!object) return { hit: 0, point: zero.clone(), normal: zero.clone(), distance: 0 };

    const origin = asVector3(inputs.origin, params.origin as THREE.Vector3);
    const direction = asVector3(inputs.direction, params.direction as THREE.Vector3);
    if (direction.lengthSq() < 1e-12) return { hit: 0, point: origin.clone(), normal: zero.clone(), distance: 0 };

    const maxDistance = Math.max(0, numberInput(inputs.maxDistance, params.maxDistance, 100));
    const firstHitOnly = params.firstHitOnly !== undefined ? Boolean(params.firstHitOnly) : true;

    const hits = castRay(object, origin, direction, maxDistance, firstHitOnly);
    if (hits.length === 0) return { hit: 0, point: zero.clone(), normal: zero.clone(), distance: 0 };

    const h = hits[0];
    const normal = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : zero.clone();
    return { hit: 1, point: h.point.clone(), normal, distance: h.distance };
  },
};

interface BurstState {
  line?: LineSegments2;
  lineGeometry?: LineSegmentsGeometry;
  material?: LineMaterial;
  signature?: string;
  /** Seeded *unit* ray directions + their per-ray rotation axes — scaled by
   * `radius` per frame, so changing the radius never re-rolls the field. */
  baseDirs: THREE.Vector3[];
  axes: THREE.Vector3[];
  /** Reused per-frame position buffer — a segment is [x0,y0,z0, x1,y1,z1]. */
  positions: Float32Array;
  /** Reused per-frame dash-distance buffers (only meaningful when dashed). */
  startDist?: Float32Array;
  endDist?: Float32Array;
  lastDashed?: boolean;
  lastWorldUnits?: boolean;
}

const burstCache = createNodeCache<BurstState>((s) => {
  if (s.lineGeometry) s.lineGeometry.dispose();
  if (s.material) s.material.dispose();
  if (s.line) s.line.removeFromParent();
});

function getBurstState(nodeId: string): BurstState {
  let state = burstCache.get(nodeId);
  if (!state) {
    state = { baseDirs: [], axes: [], positions: new Float32Array(0) };
    burstCache.set(nodeId, state);
  }
  return state;
}

/** Recompute the per-segment cumulative distances the dash shader reads. */
function updateRayDistances(state: BurstState): void {
  const geo = state.lineGeometry;
  if (!geo) return;
  const start = geo.attributes.instanceStart as THREE.InterleavedBufferAttribute;
  const end = geo.attributes.instanceEnd as THREE.InterleavedBufferAttribute;
  const count = start.count;
  const sd = state.startDist!;
  const ed = state.endDist!;
  let total = 0;
  for (let i = 0; i < count; i++) {
    const dx = end.getX(i) - start.getX(i);
    const dy = end.getY(i) - start.getY(i);
    const dz = end.getZ(i) - start.getZ(i);
    sd[i] = total;
    total += Math.sqrt(dx * dx + dy * dy + dz * dz);
    ed[i] = total;
  }
  (geo.attributes.instanceDistanceStart as THREE.InstancedBufferAttribute).needsUpdate = true;
  (geo.attributes.instanceDistanceEnd as THREE.InstancedBufferAttribute).needsUpdate = true;
}

/**
 * A uniformly-distributed unit vector drawn from `prng`. THREE's own
 * `randomDirection()` is hardwired to Math.random(), which silently made the
 * node's Seed a no-op for the ray field itself.
 */
function randomUnitVector(prng: () => number): THREE.Vector3 {
  const z = prng() * 2 - 1;
  const theta = prng() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return new THREE.Vector3(r * Math.cos(theta), r * Math.sin(theta), z);
}

function createPrng(seed: number) {
  let s = Math.floor(Math.abs(seed)) % 2147483647;
  if (s <= 0) s = 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * Ray Burst Node — reproduces the three.js `webgl_raycaster_bvh` effect: a field
 * of rays fanning out from random directions towards a mesh's centre, showing
 * where each one hits. Outputs the rays as a LineSegments geometry plus lists of
 * hit points/normals/distances for markers (instance-transform) or logic.
 */
export const RAY_BURST_NODE: NodeDefinition = {
  type: "physics/ray-burst",
  label: "Ray Burst",
  category: "physics",
  inputs: [
    { id: "geometry", label: "Target", type: "geometry" },
    { id: "origin", label: "Center", type: "vector" },
    { id: "count", label: "Ray Count", type: "value" },
    { id: "radius", label: "Radius", type: "value" },
    { id: "seed", label: "Seed", type: "value" },
    { id: "rotate", label: "Rotate (°/s)", type: "value" },
    { id: "time", label: "Time", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Rays (Lines)", type: "geometry" },
    { id: "rayOrigins", label: "Ray Origins", type: "list" },
    { id: "hitPoints", label: "Hit Points", type: "list" },
    { id: "hitNormals", label: "Hit Normals", type: "list" },
    { id: "hits", label: "Hits (0/1)", type: "list" },
    { id: "distances", label: "Distances", type: "list" },
  ],
  defaultParams: {
    origin: new THREE.Vector3(0, 0, 0),
    count: 150,
    radius: 3.75,
    seed: 1,
    rotate: 18,
    time: 0,
    color: new THREE.Color(0x444444),
    opacity: 0.35,
    linewidth: 2,
    worldUnits: false,
    dashed: false,
    dashSize: 0.5,
    gapSize: 0.25,
  },
  dynamicParamFields: () => [
    { id: "origin", label: "Center", kind: "vector" },
    { id: "count", label: "Ray Count", kind: "number", step: 10 },
    { id: "radius", label: "Radius", kind: "number", step: 0.1 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
    { id: "rotate", label: "Rotate (°/s)", kind: "number", step: 1 },
    { id: "color", label: "Color", kind: "color", group: "Style" },
    { id: "opacity", label: "Opacity", kind: "number", step: 0.05, group: "Style" },
    { id: "linewidth", label: "Width", kind: "number", step: 0.1, group: "Line" },
    { id: "worldUnits", label: "World Units (width in scene units)", kind: "boolean", group: "Line" },
    { id: "dashed", label: "Dashed", kind: "boolean", group: "Line" },
    { id: "dashSize", label: "Dash Size", kind: "number", step: 0.05, group: "Line" },
    { id: "gapSize", label: "Gap Size", kind: "number", step: 0.05, group: "Line" },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getBurstState(ctx.nodeId);

    const object = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    const origin = asVector3(inputs.origin, params.origin as THREE.Vector3);
    const count = Math.max(0, Math.min(4000, Math.round(numberInput(inputs.count, params.count, 150))));
    const radius = Math.max(0, numberInput(inputs.radius, params.radius, 3.75));
    const seed = numberInput(inputs.seed, params.seed, 1);
    const rotate = numberInput(inputs.rotate, params.rotate, 18);
    const time = numberInput(inputs.time, params.time, 0);
    const color = asColor(inputs.color, asColor(params.color, new THREE.Color(0x444444)));

    // Only what genuinely invalidates the cached buffers and the random field.
    // radius, origin, colour and the target's own geometry are all applied per
    // frame further down — putting them here re-rolled every ray direction (and
    // reallocated the geometry) on any frame that animated one of them.
    const signature = JSON.stringify([count, seed]);

    if (signature !== state.signature) {
      state.signature = signature;

      if (state.lineGeometry) {
        state.lineGeometry.dispose();
        state.lineGeometry = undefined;
      }
      if (!state.material) {
        state.material = new LineMaterial({ color: 0x444444, transparent: true, depthWrite: false });
      }

      const positions = new Float32Array(count * 6);
      state.positions = positions;
      const lineGeometry = new LineSegmentsGeometry();
      lineGeometry.setPositions(positions);
      // The dash shader reads instanceDistanceStart/End — build them once and
      // keep them updated in place as the rays move.
      state.startDist = new Float32Array(count);
      state.endDist = new Float32Array(count);
      lineGeometry.setAttribute(
        "instanceDistanceStart",
        new THREE.InstancedBufferAttribute(state.startDist, 1),
      );
      lineGeometry.setAttribute(
        "instanceDistanceEnd",
        new THREE.InstancedBufferAttribute(state.endDist, 1),
      );
      state.lineGeometry = lineGeometry;

      const prng = createPrng(seed);
      state.baseDirs = [];
      state.axes = [];
      for (let i = 0; i < count; i++) {
        state.baseDirs.push(randomUnitVector(prng));
        state.axes.push(randomUnitVector(prng));
      }

      if (!state.line) {
        state.line = new LineSegments2(lineGeometry, state.material);
        state.line.frustumCulled = false;
        state.line.userData.nodeId = ctx.nodeId;
      } else {
        state.line.geometry = lineGeometry;
      }
    }

    const line = state.line!;
    const lineGeometry = state.lineGeometry!;
    const positions = state.positions;
    const startAttr = lineGeometry.attributes.instanceStart as THREE.InterleavedBufferAttribute;

    const rayOrigins: THREE.Vector3[] = [];
    const hitPoints: THREE.Vector3[] = [];
    const hitNormals: THREE.Vector3[] = [];
    const hits: number[] = [];
    const distances: number[] = [];

    // World matrices + BVHs are refreshed once for the whole burst, not once
    // per ray (see collectTargets).
    const targets = object ? collectTargets(object) : [];
    if (object && targets.length === 0) warnMeshRequired(ctx.nodeId, "Ray Burst", object);
    else clearMeshWarning(ctx.nodeId);

    const rotateRad = (rotate * Math.PI) / 180;
    for (let i = 0; i < count; i++) {
      const rotated = state.baseDirs[i]
        .clone()
        .applyAxisAngle(state.axes[i], time * rotateRad)
        .multiplyScalar(radius);
      const rayOrigin = origin.clone().add(rotated);
      rayOrigins.push(rayOrigin.clone());

      let end: THREE.Vector3;
      // Every output list stays index-aligned with the ray that produced it:
      // a miss contributes the ray's far end and a zero normal rather than
      // being skipped, so `hitPoints[i]`, `hits[i]` and `rayOrigins[i]` always
      // describe ray i. Downstream `Set Instance Transform` reads them
      // positionally, and a compacted list silently paired markers with the
      // wrong rays. Filter on `hits` to keep only the ones that landed.
      if (targets.length > 0) {
        const direction = origin.clone().sub(rayOrigin).normalize();
        const result = castRayAgainst(targets, rayOrigin, direction, Infinity, true);
        if (result.length > 0) {
          const h = result[0];
          end = h.point;
          hitPoints.push(h.point.clone());
          hitNormals.push(h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3());
          hits.push(1);
          distances.push(h.distance);
        } else {
          end = origin.clone();
          hitPoints.push(end.clone());
          hitNormals.push(new THREE.Vector3());
          hits.push(0);
          // A miss reports the full ray length, not Infinity — List Statistics
          // and List Math had no way to survive an Infinity in the stream.
          distances.push(rayOrigin.distanceTo(end));
        }
      } else {
        end = origin.clone();
        hitPoints.push(end.clone());
        hitNormals.push(new THREE.Vector3());
        hits.push(0);
        distances.push(rayOrigin.distanceTo(end));
      }

      positions[i * 6] = rayOrigin.x;
      positions[i * 6 + 1] = rayOrigin.y;
      positions[i * 6 + 2] = rayOrigin.z;
      positions[i * 6 + 3] = end.x;
      positions[i * 6 + 4] = end.y;
      positions[i * 6 + 5] = end.z;
    }
    // instanceStart and instanceEnd share the same interleaved buffer.
    startAttr.needsUpdate = true;

    // Appearance — uniforms are cheap to set per frame; only toggling dashed /
    // worldUnits recompiles the shader.
    const material = state.material!;
    material.color.set(color);
    const opacity = Math.min(1, Math.max(0, numberInput(inputs.opacity, params.opacity, 0.35)));
    material.uniforms.opacity.value = opacity;
    material.transparent = opacity < 0.999;
    material.linewidth = Math.max(0.1, numberInput(inputs.linewidth, params.linewidth, 2));
    material.dashSize = Math.max(0.0001, numberInput(inputs.dashSize, params.dashSize, 0.5));
    material.gapSize = Math.max(0, numberInput(inputs.gapSize, params.gapSize, 0.25));

    const dashed = Boolean(params.dashed);
    if (state.lastDashed !== dashed) {
      state.lastDashed = dashed;
      material.dashed = dashed;
      material.needsUpdate = true; // toggles USE_DASH -> recompile
    }
    const worldUnits = Boolean(params.worldUnits);
    if (state.lastWorldUnits !== worldUnits) {
      state.lastWorldUnits = worldUnits;
      material.worldUnits = worldUnits;
      material.needsUpdate = true;
    }

    const size = new THREE.Vector2(1920, 1080);
    if (ctx.renderer) {
      ctx.renderer.getSize(size);
      if (size.x <= 0 || size.y <= 0) size.set(1920, 1080);
    }
    material.resolution.copy(size);

    if (dashed) updateRayDistances(state);

    return {
      geometry: line,
      rayOrigins,
      hitPoints,
      hitNormals,
      hits,
      distances,
    };
  },
};

/** Sample Surface Node — N random points + normals over a mesh's surface (area-weighted). */
export const SAMPLE_SURFACE_NODE: NodeDefinition = {
  type: "physics/sample",
  label: "Surface Scatter",
  category: "instance",
  inputs: [
    { id: "geometry", label: "Surface", type: "geometry" },
    { id: "count", label: "Count", type: "value" },
    { id: "seed", label: "Seed", type: "value" },
  ],
  outputs: [
    { id: "points", label: "Points", type: "list" },
    { id: "normals", label: "Normals", type: "list" },
  ],
  defaultParams: {
    count: 50,
    seed: 1,
  },
  dynamicParamFields: () => [
    { id: "count", label: "Count", kind: "number", step: 5 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const object = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (!object) return { points: [], normals: [] };

    const count = Math.max(0, Math.min(20000, Math.round(numberInput(inputs.count, params.count, 50))));
    const seed = numberInput(inputs.seed, params.seed, 1);
    const prng = createPrng(seed);

    const { positions, normals } = sampleSurfacePoints(object, count, prng);
    if (positions.length === 0 && count > 0) warnMeshRequired(ctx.nodeId, "Sample Surface", object);
    else clearMeshWarning(ctx.nodeId);
    return { points: positions, normals };
  },
};

/** Volume Scatter Node — N random points + normals inside a mesh's 3D volume. */
export const VOLUME_SCATTER_NODE: NodeDefinition = {
  type: "physics/volume_scatter",
  label: "Volume Scatter",
  category: "instance",
  inputs: [
    { id: "geometry", label: "Volume", type: "geometry" },
    { id: "count", label: "Count", type: "value" },
    { id: "seed", label: "Seed", type: "value" },
  ],
  outputs: [
    { id: "points", label: "Points", type: "list" },
    { id: "normals", label: "Normals", type: "list" },
  ],
  defaultParams: {
    count: 50,
    seed: 1,
  },
  dynamicParamFields: () => [
    { id: "count", label: "Count", kind: "number", step: 5 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const object = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (!object) return { points: [], normals: [] };

    const count = Math.max(0, Math.min(20000, Math.round(numberInput(inputs.count, params.count, 50))));
    const seed = numberInput(inputs.seed, params.seed, 1);
    const prng = createPrng(seed);

    const { positions, normals } = sampleVolumePoints(object, count, prng);
    if (positions.length === 0 && count > 0) warnMeshRequired(ctx.nodeId, "Volume Scatter", object);
    else clearMeshWarning(ctx.nodeId);
    return { points: positions, normals };
  },
};

