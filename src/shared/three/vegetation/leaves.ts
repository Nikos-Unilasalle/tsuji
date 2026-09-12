import * as THREE from "three";
import { WindFieldDescriptor, sampleWind } from "./windField";
import { GroundHeightField, sampleGroundHeight } from "./groundHeight";

/**
 * Port of the leaf field from brunosimon/folio-2025 (sources/Game/World/Leaves.js).
 *
 * That one runs as a WebGPU compute pass over instanced buffers. This is the same simulation on
 * the CPU over typed arrays, which at a few thousand leaves costs less than the plumbing a
 * GPUComputationRenderer pass would need — and keeps the whole thing testable without a context.
 */

/** A leaf: a quad with its two far corners pulled in, lying flat. */
export function createLeafGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(1, 1);
  const positions = geometry.attributes.position.array as Float32Array;

  positions[0] += 0.15;
  positions[3] += 0.15;
  positions[6] -= 0.15;
  positions[9] -= 0.15;

  geometry.rotateX(-Math.PI * 0.5);
  return geometry;
}

export interface LeavesState {
  count: number;
  /** xyz per leaf. */
  positions: Float32Array;
  velocities: Float32Array;
  /** How heavily a leaf hangs: it scales both the wind that catches it and the gravity on it. */
  weights: Float32Array;
  scales: Float32Array;
  baseRotations: Float32Array;
}

function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

/** Scatters `count` leaves over a square of `size` centred on `focus`. */
export function seedLeaves(count: number, size: number, seed: number, focusX = 0, focusZ = 0): LeavesState {
  const state: LeavesState = {
    count,
    positions: new Float32Array(count * 3),
    velocities: new Float32Array(count * 3),
    weights: new Float32Array(count),
    scales: new Float32Array(count),
    baseRotations: new Float32Array(count),
  };

  for (let i = 0; i < count; i++) {
    state.positions[i * 3] = focusX + (hash(i + seed * 977) - 0.5) * size;
    state.positions[i * 3 + 1] = 0;
    state.positions[i * 3 + 2] = focusZ + (hash(i + 1 + seed * 977) - 0.5) * size;

    state.weights[i] = hash(i + 31.7 + seed) * 0.1 + 0.1;
    state.scales[i] = hash(i + 57.3 + seed) * 0.5 + 0.5;
    state.baseRotations[i] = hash(i + 91.1 + seed) * Math.PI * 2;
  }

  return state;
}

export interface LeavesPush {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** How hard the mover's own velocity is handed to a leaf. */
  multiplier: number;
  /** How hard leaves are shoved out of the mover's way, regardless of its heading. */
  sidewaysMultiplier: number;
}

export interface LeavesBlast {
  x: number;
  z: number;
  radius: number;
  strength: number;
}

export interface LeavesForces {
  dt: number;
  focusX: number;
  focusZ: number;
  size: number;
  wind: WindFieldDescriptor | null;
  windMultiplier: number;
  upwardMultiplier: number;
  gravity: number;
  damping: number;
  floorOffset: number;
  ground: GroundHeightField | null;
  push: LeavesPush | null;
  blast: LeavesBlast | null;
}

function remapClamp(value: number, low: number, high: number, toLow: number, toHigh: number): number {
  if (high === low) return toLow;
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return toLow + t * (toHigh - toLow);
}

const _gust = new THREE.Vector2();

/** One simulation step, in place. */
export function stepLeaves(state: LeavesState, forces: LeavesForces): void {
  const { positions, velocities, weights } = state;
  // A NaN dt would turn the whole field into NaN and never recover, so it is treated as a
  // frame that did not happen. The cap is what a tab returning from the background costs.
  const dt = Number.isFinite(forces.dt) ? Math.min(0.1, Math.max(0, forces.dt)) : 0;
  const halfSize = forces.size * 0.5;

  for (let i = 0; i < state.count; i++) {
    const p = i * 3;
    let x = positions[p];
    let y = positions[p + 1];
    let z = positions[p + 2];
    let vx = velocities[p];
    let vy = velocities[p + 1];
    let vz = velocities[p + 2];
    const weight = weights[i];

    // Pushed by whatever is moving through the field.
    if (forces.push) {
      const dx = x - forces.push.position.x;
      const dy = y - forces.push.position.y;
      const dz = z - forces.push.position.z;
      const distance = Math.hypot(dx, dy, dz);
      const nearness = remapClamp(distance, 0.5, 2, 1, 0);

      if (nearness > 0) {
        const speed = forces.push.velocity.length();
        const flat = Math.hypot(dx, dz) || 1;
        const sidewaysX = (dx / flat) * forces.push.sidewaysMultiplier;
        const sidewaysZ = (dz / flat) * forces.push.sidewaysMultiplier;

        vx += (forces.push.velocity.x * forces.push.multiplier + sidewaysX) * speed * nearness * dt;
        vz += (forces.push.velocity.z * forces.push.multiplier + sidewaysZ) * speed * nearness * dt;
      }
    }

    // Wind, from the scene's own Wind Field rather than the original's noise texture, so leaves
    // blow in the same gusts as the grass and the trees.
    if (forces.wind) {
      sampleWind(forces.wind, x, z, _gust);
      vx += _gust.x * weight * forces.windMultiplier * dt;
      vz += _gust.y * weight * forces.windMultiplier * dt;
    }

    // A blast shoves leaves outward: full push out to half the radius, fading to nothing at the
    // edge. The direction is the un-normalised offset, so leaves right at the centre — which have
    // no direction to be thrown in — barely move, and the ring around it takes the most.
    if (forces.blast) {
      const dx = x - forces.blast.x;
      const dz = z - forces.blast.z;
      const distance = Math.hypot(dx, dz);
      const falloff = remapClamp(distance, forces.blast.radius * 0.5, forces.blast.radius, 0.2, 0);

      vx += dx * falloff * forces.blast.strength;
      vz += dz * falloff * forces.blast.strength;
    }

    // Sideways speed is what lifts a leaf, and only while it is low: it skitters up off the
    // ground and stops climbing once it is properly in the air.
    const lift = remapClamp(y, 0, 6, 1, 0);
    vy = Math.min(Math.hypot(vx, vz), 2) * forces.upwardMultiplier * lift;

    const damping = Math.min(1, forces.damping * dt);
    vx *= 1 - damping;
    vy *= 1 - damping;
    vz *= 1 - damping;

    // Gravity as a terminal fall speed rather than an acceleration, as in the original: a leaf
    // does not accelerate downward, it sinks.
    vy -= forces.gravity * weight;

    x += vx * dt;
    y += vy * dt;
    z += vz * dt;

    let floor = forces.floorOffset;
    if (forces.ground) {
      const sample = sampleGroundHeight(forces.ground, x, z);
      if (sample.hit > 0) floor = sample.height + forces.floorOffset;
    }
    if (y < floor) y = floor;

    // The field follows the focus point: a leaf that walks off one edge comes back on the other,
    // so a finite number of them covers wherever the camera happens to be.
    x = ((((x - forces.focusX + halfSize) % forces.size) + forces.size) % forces.size) - halfSize + forces.focusX;
    z = ((((z - forces.focusZ + halfSize) % forces.size) + forces.size) % forces.size) - halfSize + forces.focusZ;

    positions[p] = x;
    positions[p + 1] = y;
    positions[p + 2] = z;
    velocities[p] = vx;
    velocities[p + 1] = vy;
    velocities[p + 2] = vz;
  }
}

const _matrix = new THREE.Matrix4();
const _euler = new THREE.Euler();
const _quaternion = new THREE.Quaternion();
const _translation = new THREE.Vector3();
const _scale = new THREE.Vector3();

/**
 * Writes the simulation into an InstancedMesh.
 *
 * The original tumbles each leaf in its vertex shader from the leaf's own position; the same
 * rotation is composed here into the instance matrix, which costs nothing extra now that the
 * positions are already on the CPU.
 */
export function writeLeafMatrices(
  state: LeavesState,
  mesh: THREE.InstancedMesh,
  scale: number,
  rotationFrequency: number,
  rotationElevation: number,
): void {
  for (let i = 0; i < state.count; i++) {
    const p = i * 3;
    const x = state.positions[p];
    const y = state.positions[p + 1];
    const z = state.positions[p + 2];

    // Flat on the ground, tumbling once it is up in the air.
    const tumble = Math.max(y * rotationElevation, 0);
    _euler.set(
      Math.sin(z * rotationFrequency) * tumble,
      state.baseRotations[i],
      Math.sin(x * rotationFrequency) * tumble,
      "YXZ",
    );
    _quaternion.setFromEuler(_euler);

    const size = state.scales[i] * scale;
    _translation.set(x, y, z);
    _scale.set(size, size, size);
    mesh.setMatrixAt(i, _matrix.compose(_translation, _quaternion, _scale));
  }

  mesh.instanceMatrix.needsUpdate = true;
}

/** Per-leaf tint, mixed between the two colours by a hash, as in the original. */
export function writeLeafColors(state: LeavesState, mesh: THREE.InstancedMesh, colorA: THREE.Color, colorB: THREE.Color): void {
  const color = new THREE.Color();
  for (let i = 0; i < state.count; i++) {
    color.copy(colorA).lerp(colorB, hash(i + 99));
    mesh.setColorAt(i, color);
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}
