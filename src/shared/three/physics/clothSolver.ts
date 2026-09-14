import * as THREE from "three";

/**
 * A Verlet mass-spring cloth, on the CPU.
 *
 * The reference this is built from (three-simplecloth, and the three.js
 * webgpu_compute_cloth example under it) runs the same solver as a WGSL
 * compute pass over a skinned mesh. Neither half of that transfers here: the
 * viewport is a WebGLRenderer, and this engine has no skeletal animation at
 * all — so a skinned-mesh API with bone-parented sphere colliders describes
 * nothing an author could wire up. What does transfer is the model: positions
 * integrated by Verlet, distance constraints relaxed a few times per step, a
 * per-vertex mask deciding how much of each vertex is cloth, and spheres to
 * collide with. That is what lives here.
 *
 * CPU rather than GPGPU on purpose. A GPU solver keeps positions in a texture,
 * which means either a readback every frame (the thing GPGPU exists to avoid)
 * or a vertex shader that samples them — and the latter would break the
 * appearance contract every mesh modifier in this engine honours, since the
 * source's own material has to draw the result. At the vertex counts an
 * author actually paints cloth onto (a few thousand), a few relaxation passes
 * cost less than the readback would.
 */

/** Particles above this are refused rather than simulated — see stepCloth's caller. */
export const MAX_CLOTH_PARTICLES = 20000;

export interface ClothTopology {
  /** Simulated particles. Fewer than the geometry's vertices: seam-split vertices weld into one. */
  count: number;
  /** Particle index for each geometry vertex. */
  vertexToParticle: Uint32Array;
  /** Particle rest positions, in the source mesh's local space. */
  rest: Float32Array;
  /** Distance-constraint pairs, particle indices. */
  edges: Uint32Array;
  restLengths: Float32Array;
  /** 0 = welded to the rest shape, 1 = free cloth. Red vertex-color channel when the mesh has one. */
  influence: Float32Array;
}

export interface ClothState {
  topology: ClothTopology;
  /** World space — gravity and wind are world quantities, and the source mesh may be moving. */
  position: Float32Array;
  previous: Float32Array;
  lastTime?: number;
  epoch?: number;
  /** The geometry this was bound to; a different one means rebuild. */
  sourceGeometryId?: string;
}

export interface ClothPin {
  particle: number;
  position: THREE.Vector3;
}

export interface ClothCollider {
  center: THREE.Vector3;
  radius: number;
}

export interface ClothStepParams {
  dt: number;
  time: number;
  gravity: THREE.Vector3;
  wind: THREE.Vector3;
  /** How much the wind flutters per particle, 0 = a steady push. */
  windFlutter: number;
  /** Velocity kept between steps, 0.9-0.99 in practice. */
  damping: number;
  /** Pull back toward the rest shape, on top of what `influence` already holds. 0 = free cloth. */
  stiffness: number;
  iterations: number;
  /** The rest shape in world space this frame — the source mesh's pose, what `influence` holds vertices to. */
  restWorld: Float32Array;
  pins: ClothPin[];
  colliders: ClothCollider[];
}

function edgeKey(a: number, b: number): number {
  return a < b ? a * MAX_CLOTH_PARTICLES + b : b * MAX_CLOTH_PARTICLES + a;
}

/**
 * Welds by position so that UV/normal seams — which split one physical vertex
 * into several — do not tear at the seam. Without this an imported garment
 * comes apart along every UV island boundary the moment it moves.
 */
export function buildClothTopology(geometry: THREE.BufferGeometry, weldDistance: number): ClothTopology | null {
  const posAttr = geometry.getAttribute("position");
  if (!posAttr) return null;

  const vertexCount = posAttr.count;
  const cell = Math.max(1e-6, weldDistance);
  const lookup = new Map<string, number>();
  const vertexToParticle = new Uint32Array(vertexCount);
  const restList: number[] = [];

  for (let v = 0; v < vertexCount; v++) {
    const x = posAttr.getX(v);
    const y = posAttr.getY(v);
    const z = posAttr.getZ(v);
    const key = `${Math.round(x / cell)},${Math.round(y / cell)},${Math.round(z / cell)}`;
    let particle = lookup.get(key);
    if (particle === undefined) {
      particle = restList.length / 3;
      lookup.set(key, particle);
      restList.push(x, y, z);
    }
    vertexToParticle[v] = particle;
  }

  const count = restList.length / 3;
  if (count === 0 || count > MAX_CLOTH_PARTICLES) return null;

  const index = geometry.getIndex();
  const triCount = index ? index.count / 3 : vertexCount / 3;
  const seen = new Set<number>();
  const edgeList: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const ia = index ? index.getX(t * 3) : t * 3;
    const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const pa = vertexToParticle[ia];
    const pb = vertexToParticle[ib];
    const pc = vertexToParticle[ic];
    for (const [p, q] of [[pa, pb], [pb, pc], [pc, pa]]) {
      if (p === q) continue;
      const key = edgeKey(p, q);
      if (seen.has(key)) continue;
      seen.add(key);
      edgeList.push(p, q);
    }
  }

  const rest = Float32Array.from(restList);
  const edges = Uint32Array.from(edgeList);
  const restLengths = new Float32Array(edges.length / 2);
  for (let e = 0; e < restLengths.length; e++) {
    const a = edges[e * 2] * 3;
    const b = edges[e * 2 + 1] * 3;
    const dx = rest[a] - rest[b];
    const dy = rest[a + 1] - rest[b + 1];
    const dz = rest[a + 2] - rest[b + 2];
    restLengths[e] = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // The red channel is the same mask the reference library paints in Blender:
  // red = cloth, white = stays on the rest shape. A mesh with no color
  // attribute is cloth everywhere, which is what a plain plane should do.
  const influence = new Float32Array(count).fill(1);
  const colorAttr = geometry.getAttribute("color");
  if (colorAttr && colorAttr.itemSize >= 3) {
    const seenParticle = new Uint8Array(count);
    for (let v = 0; v < vertexCount && v < colorAttr.count; v++) {
      const particle = vertexToParticle[v];
      if (seenParticle[particle]) continue;
      seenParticle[particle] = 1;
      influence[particle] = Math.min(1, Math.max(0, colorAttr.getX(v)));
    }
  }

  return { count, vertexToParticle, rest, edges, restLengths, influence };
}

/** Binds the cloth to a pose: every particle starts at rest, at zero velocity. */
export function createClothState(topology: ClothTopology, bindMatrix: THREE.Matrix4): ClothState {
  const position = new Float32Array(topology.count * 3);
  const point = new THREE.Vector3();
  for (let p = 0; p < topology.count; p++) {
    point.set(topology.rest[p * 3], topology.rest[p * 3 + 1], topology.rest[p * 3 + 2]).applyMatrix4(bindMatrix);
    position[p * 3] = point.x;
    position[p * 3 + 1] = point.y;
    position[p * 3 + 2] = point.z;
  }
  return { topology, position, previous: position.slice() };
}

/** Snaps every particle back onto the rest shape — a scrub, a reset, a new epoch. */
export function resetCloth(state: ClothState, restWorld: Float32Array): void {
  state.position.set(restWorld);
  state.previous.set(restWorld);
}

/** The particle nearest a world-space point — how an Empty's pivot picks what it pins. */
export function nearestParticle(state: ClothState, point: THREE.Vector3): number {
  let best = -1;
  let bestDist = Infinity;
  for (let p = 0; p < state.topology.count; p++) {
    const dx = state.position[p * 3] - point.x;
    const dy = state.position[p * 3 + 1] - point.y;
    const dz = state.position[p * 3 + 2] - point.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

/** Cheap per-particle flutter — a whole fbm sample per particle per frame is not worth its cost here. */
function flutter(index: number, time: number): number {
  return Math.sin(index * 1.7 + time * 3.1) * Math.sin(index * 0.31 + time * 1.7);
}

export function stepCloth(state: ClothState, params: ClothStepParams): void {
  const { topology, position, previous } = state;
  const { dt, restWorld } = params;
  if (dt <= 0) return;

  const count = topology.count;
  const damping = Math.min(1, Math.max(0, params.damping));
  const stiffness = Math.min(1, Math.max(0, params.stiffness));
  const dtSq = dt * dt;

  const pinned = new Uint8Array(count);
  for (const pin of params.pins) {
    if (pin.particle < 0 || pin.particle >= count) continue;
    pinned[pin.particle] = 1;
    position[pin.particle * 3] = pin.position.x;
    position[pin.particle * 3 + 1] = pin.position.y;
    position[pin.particle * 3 + 2] = pin.position.z;
    previous[pin.particle * 3] = pin.position.x;
    previous[pin.particle * 3 + 1] = pin.position.y;
    previous[pin.particle * 3 + 2] = pin.position.z;
  }

  for (let p = 0; p < count; p++) {
    if (pinned[p]) continue;
    const i = p * 3;
    const gust = 1 + flutter(p, params.time) * params.windFlutter;
    const ax = params.gravity.x + params.wind.x * gust;
    const ay = params.gravity.y + params.wind.y * gust;
    const az = params.gravity.z + params.wind.z * gust;

    const px = position[i];
    const py = position[i + 1];
    const pz = position[i + 2];

    position[i] = px + (px - previous[i]) * damping + ax * dtSq;
    position[i + 1] = py + (py - previous[i + 1]) * damping + ay * dtSq;
    position[i + 2] = pz + (pz - previous[i + 2]) * damping + az * dtSq;

    previous[i] = px;
    previous[i + 1] = py;
    previous[i + 2] = pz;
  }

  // Frame-rate independent: the same hold reads the same at 30fps and 120.
  const iterations = Math.max(1, Math.round(params.iterations));
  for (let it = 0; it < iterations; it++) {
    for (let e = 0; e < topology.restLengths.length; e++) {
      const a = topology.edges[e * 2];
      const b = topology.edges[e * 2 + 1];
      const wa = pinned[a] ? 0 : 1;
      const wb = pinned[b] ? 0 : 1;
      const sum = wa + wb;
      if (sum === 0) continue;

      const ia = a * 3;
      const ib = b * 3;
      const dx = position[ib] - position[ia];
      const dy = position[ib + 1] - position[ia + 1];
      const dz = position[ib + 2] - position[ia + 2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 1e-9) continue;

      const correction = (dist - topology.restLengths[e]) / dist / sum;
      position[ia] += dx * correction * wa;
      position[ia + 1] += dy * correction * wa;
      position[ia + 2] += dz * correction * wa;
      position[ib] -= dx * correction * wb;
      position[ib + 1] -= dy * correction * wb;
      position[ib + 2] -= dz * correction * wb;
    }
  }

  for (let p = 0; p < count; p++) {
    if (pinned[p]) continue;
    const i = p * 3;

    const hold = Math.max(1 - topology.influence[p], stiffness);
    if (hold > 0) {
      const blend = 1 - Math.pow(1 - Math.min(0.999, hold), dt * 60);
      position[i] += (restWorld[i] - position[i]) * blend;
      position[i + 1] += (restWorld[i + 1] - position[i + 1]) * blend;
      position[i + 2] += (restWorld[i + 2] - position[i + 2]) * blend;
    }

    for (const collider of params.colliders) {
      const dx = position[i] - collider.center.x;
      const dy = position[i + 1] - collider.center.y;
      const dz = position[i + 2] - collider.center.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist >= collider.radius || dist < 1e-9) continue;
      const push = collider.radius / dist;
      position[i] = collider.center.x + dx * push;
      position[i + 1] = collider.center.y + dy * push;
      position[i + 2] = collider.center.z + dz * push;
    }

    if (!Number.isFinite(position[i]) || !Number.isFinite(position[i + 1]) || !Number.isFinite(position[i + 2])) {
      position[i] = restWorld[i];
      position[i + 1] = restWorld[i + 1];
      position[i + 2] = restWorld[i + 2];
      previous[i] = restWorld[i];
      previous[i + 1] = restWorld[i + 1];
      previous[i + 2] = restWorld[i + 2];
    }
  }
}

/** Blender's two shading modes, minus Auto Smooth — see buildClothOutput. */
export const CLOTH_SHADE_MODES = ["smooth", "flat"] as const;
export type ClothShade = (typeof CLOTH_SHADE_MODES)[number];

export interface ClothOutput {
  geometry: THREE.BufferGeometry;
  /** Particle behind each of *this* geometry's vertices — flat mode has more of them than the source. */
  vertexToParticle: Uint32Array;
  shade: ClothShade;
  /** Reused per frame so smoothing does not allocate one accumulator per frame. */
  normalAccumulator: Float32Array;
}

/**
 * The geometry the node hands downstream, in the shape the shading mode needs.
 *
 * Flat shading needs one vertex per corner of per face — an averaged normal is
 * exactly what an indexed mesh's shared vertices force — so it is built
 * non-indexed once, here, rather than by re-splitting a deforming mesh sixty
 * times a second. Auto Smooth (the Shade node's third mode) is deliberately
 * absent: which edges count as hard changes as the cloth moves, so it would
 * mean re-splitting the geometry every frame, which is the cost this avoids.
 */
export function buildClothOutput(
  source: THREE.BufferGeometry,
  topology: ClothTopology,
  shade: ClothShade,
): ClothOutput {
  const normalAccumulator = new Float32Array(topology.count * 3);
  if (shade === "smooth") {
    const geometry = source.clone();
    return { geometry, vertexToParticle: topology.vertexToParticle, shade, normalAccumulator };
  }

  const index = source.getIndex();
  const geometry = source.clone().toNonIndexed();
  const vertexToParticle = new Uint32Array(geometry.getAttribute("position").count);
  for (let v = 0; v < vertexToParticle.length; v++) {
    vertexToParticle[v] = topology.vertexToParticle[index ? index.getX(v) : v];
  }
  return { geometry, vertexToParticle, shade, normalAccumulator };
}

function writeFlatNormals(position: THREE.BufferAttribute, normal: THREE.BufferAttribute): void {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let f = 0; f < position.count; f += 3) {
    a.fromBufferAttribute(position, f);
    b.fromBufferAttribute(position, f + 1);
    c.fromBufferAttribute(position, f + 2);
    c.sub(b);
    a.sub(b);
    c.cross(a);
    if (c.lengthSq() > 1e-24) c.normalize();
    else c.set(0, 1, 0);
    normal.setXYZ(f, c.x, c.y, c.z);
    normal.setXYZ(f + 1, c.x, c.y, c.z);
    normal.setXYZ(f + 2, c.x, c.y, c.z);
  }
}

/**
 * Smooth normals averaged per *particle* rather than per vertex, so a UV seam
 * — which splits one place into several vertices — does not show up as a
 * lighting crease down the middle of the cloth. three's own
 * computeVertexNormals cannot do this: it only shares across an index buffer,
 * and the seam is precisely where the index buffer stops sharing.
 */
function writeSmoothNormals(output: ClothOutput, position: THREE.BufferAttribute, normal: THREE.BufferAttribute): void {
  const { vertexToParticle, normalAccumulator, geometry } = output;
  normalAccumulator.fill(0);

  const index = geometry.getIndex();
  const cornerCount = index ? index.count : position.count;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let f = 0; f < cornerCount; f += 3) {
    const ia = index ? index.getX(f) : f;
    const ib = index ? index.getX(f + 1) : f + 1;
    const ic = index ? index.getX(f + 2) : f + 2;
    a.fromBufferAttribute(position, ia);
    b.fromBufferAttribute(position, ib);
    c.fromBufferAttribute(position, ic);
    c.sub(b);
    a.sub(b);
    c.cross(a);
    // Left unnormalized on purpose: the cross product's length is twice the
    // triangle's area, which is the weighting an area-weighted average wants.
    for (const corner of [ia, ib, ic]) {
      const p = vertexToParticle[corner] * 3;
      normalAccumulator[p] += c.x;
      normalAccumulator[p + 1] += c.y;
      normalAccumulator[p + 2] += c.z;
    }
  }

  for (let v = 0; v < position.count; v++) {
    const p = vertexToParticle[v] * 3;
    c.set(normalAccumulator[p], normalAccumulator[p + 1], normalAccumulator[p + 2]);
    if (c.lengthSq() > 1e-24) c.normalize();
    else c.set(0, 1, 0);
    normal.setXYZ(v, c.x, c.y, c.z);
  }
}

/** Writes the simulated world positions back into the output geometry, in its local space. */
export function writeClothToOutput(state: ClothState, output: ClothOutput, worldToLocal: THREE.Matrix4): void {
  const position = output.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!position) return;

  const particleCount = state.topology.count;
  const point = new THREE.Vector3();
  for (let v = 0; v < position.count; v++) {
    const p = output.vertexToParticle[v];
    if (p >= particleCount) continue;
    point.set(state.position[p * 3], state.position[p * 3 + 1], state.position[p * 3 + 2]).applyMatrix4(worldToLocal);
    position.setXYZ(v, point.x, point.y, point.z);
  }
  position.needsUpdate = true;

  let normal = output.geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
  if (!normal || normal.count !== position.count) {
    normal = new THREE.BufferAttribute(new Float32Array(position.count * 3), 3);
    output.geometry.setAttribute("normal", normal);
  }
  if (output.shade === "flat") writeFlatNormals(position, normal);
  else writeSmoothNormals(output, position, normal);
  normal.needsUpdate = true;

  output.geometry.computeBoundingSphere();
}
