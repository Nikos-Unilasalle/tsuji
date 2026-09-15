import * as THREE from "three";
import { NodeDefinition, ParamFieldDef } from "../types";
import { createNodeCache } from "../nodeCaches";
import { growingSockets } from "../dynamicInputs";
import { clockInput, createModifierMesh, emitModifiedMesh, numberInput } from "./object";
import { asVector3 } from "./transform";
import { clearMeshWarning, findFirstMesh, warnMeshRequired } from "../meshRequired";
import { worldMatrixOf } from "../objectPosition";
import {
  CLOTH_SHADE_MODES,
  ClothCollider,
  ClothOutput,
  ClothPin,
  ClothShade,
  ClothState,
  buildClothOutput,
  buildClothTopology,
  createClothState,
  nearestParticle,
  resetCloth,
  stepCloth,
  writeClothToOutput,
} from "../../three/physics/clothSolver";

const PIN_PREFIX = "pin";
const COLLIDER_PREFIX = "collider";

/** Same scrub threshold the integrators, Spring and Capsule Controller use. */
const REWIND_THRESHOLD = 0.5;

interface ClothNodeState {
  mesh?: THREE.Mesh;
  output?: ClothOutput;
  sim?: ClothState;
  /** Which geometry the sim was built from — a different one is a different cloth. */
  sourceGeometryId?: string;
  /** Particle each pin socket grabbed, by socket id. Bound once, on the pose the cloth was reset to. */
  pinned: Map<string, number>;
  lastTime?: number;
  epoch?: number;
}

const clothCache = createNodeCache<ClothNodeState>((state) => {
  state.output?.geometry.dispose();
});

function asShade(value: unknown): ClothShade {
  return (CLOTH_SHADE_MODES as readonly string[]).includes(value as string) ? (value as ClothShade) : "smooth";
}

const restWorldCache = new WeakMap<ClothState, Float32Array>();

function getState(nodeId: string): ClothNodeState {
  let state = clothCache.get(nodeId);
  if (!state) {
    state = { pinned: new Map() };
    clothCache.set(nodeId, state);
  }
  return state;
}

/**
 * A sphere standing in for whatever was wired in. The reference library's
 * colliders are bone-parented spheres; here they are objects, and an Empty —
 * whose own pick shape is a 0.5-radius sphere — scales into exactly the
 * collider an author wants without a dedicated node for it.
 */
function colliderFrom(object: THREE.Object3D): ClothCollider | null {
  const mesh = findFirstMesh(object);
  const world = worldMatrixOf(mesh ?? object);
  const scale = new THREE.Vector3().setFromMatrixScale(world);
  const uniform = Math.max(scale.x, scale.y, scale.z);

  if (!mesh?.geometry) return null;
  if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
  const sphere = mesh.geometry.boundingSphere;
  if (!sphere) return null;

  return { center: sphere.center.clone().applyMatrix4(world), radius: Math.max(1e-4, sphere.radius * uniform) };
}

function collectPrefixed(inputs: Record<string, unknown>, prefix: string): { socket: string; object: THREE.Object3D }[] {
  const found: { socket: string; object: THREE.Object3D }[] = [];
  for (const [socket, value] of Object.entries(inputs)) {
    if (!socket.startsWith(prefix)) continue;
    if (!Number.isInteger(Number(socket.slice(prefix.length)))) continue;
    if (value instanceof THREE.Object3D) found.push({ socket, object: value });
  }
  return found;
}

const CLOTH_PARAM_FIELDS: ParamFieldDef[] = [
  { id: "shade", label: "Shade", kind: "select", options: [...CLOTH_SHADE_MODES], group: "Shading" },
  { id: "gravity", label: "Gravity", kind: "vector", step: 0.5, group: "Forces" },
  { id: "wind", label: "Wind", kind: "vector", step: 0.1, group: "Forces" },
  { id: "windFlutter", label: "Wind Flutter", kind: "number", step: 0.05, group: "Forces" },
  { id: "damping", label: "Damping", kind: "number", step: 0.01, group: "Solver" },
  { id: "stiffness", label: "Stiffness (hold to rest shape)", kind: "number", step: 0.02, group: "Solver" },
  { id: "iterations", label: "Relaxation Passes", kind: "number", step: 1, group: "Solver" },
  { id: "weldDistance", label: "Weld Distance", kind: "number", step: 0.0001, group: "Solver" },
  {
    id: "maskNote",
    label:
      "A vertex-color red channel is the cloth mask: red = free cloth, white = held on the rest shape. No color attribute means cloth everywhere.",
    kind: "note",
    group: "Solver",
  },
];

/**
 * Cloth — a mesh that falls, swings and settles instead of holding its pose.
 *
 * Wire a mesh in and it becomes cloth: every edge of the geometry is a
 * distance constraint, gravity and wind push on it, wired Empties pin it in
 * place and wired objects act as sphere colliders it cannot pass through. The
 * solver itself is in clothSolver.ts, including why it runs on the CPU.
 *
 * Pins grab the particle nearest the pinned object's pivot at bind time and
 * hold it there for as long as the pin stays wired — so moving the Empty
 * drags that corner of the cloth around, which is how a flag, a curtain or a
 * cape gets attached to anything the graph can move.
 */
export const CLOTH_NODE: NodeDefinition = {
  type: "physics/cloth",
  label: "Cloth",
  category: "physics",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "visible", label: "Visible", type: "value" },
    { id: "gravity", label: "Gravity", type: "vector" },
    { id: "wind", label: "Wind", type: "vector" },
    { id: "stiffness", label: "Stiffness", type: "value" },
    { id: "damping", label: "Damping", type: "value" },
    { id: "time", label: "Time", type: "value" },
    { id: "reset", label: "Reset", type: "value" },
    { id: `${PIN_PREFIX}0`, label: "Pin 1", type: "geometry" },
    { id: `${COLLIDER_PREFIX}0`, label: "Collider 1", type: "geometry" },
  ],
  dynamicInputs: (connections) => [
    { id: "geometry", label: "Geometry", type: "geometry" as const, owns: true },
    { id: "visible", label: "Visible", type: "value" as const },
    { id: "gravity", label: "Gravity", type: "vector" as const },
    { id: "wind", label: "Wind", type: "vector" as const },
    { id: "stiffness", label: "Stiffness", type: "value" as const },
    { id: "damping", label: "Damping", type: "value" as const },
    { id: "time", label: "Time", type: "value" as const },
    { id: "reset", label: "Reset", type: "value" as const },
    ...growingSockets(connections, PIN_PREFIX, (i) => ({
      id: `${PIN_PREFIX}${i}`,
      label: `Pin ${i + 1}`,
      type: "geometry",
    })),
    ...growingSockets(connections, COLLIDER_PREFIX, (i) => ({
      id: `${COLLIDER_PREFIX}${i}`,
      label: `Collider ${i + 1}`,
      type: "geometry",
    })),
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    gravity: new THREE.Vector3(0, -9.81, 0),
    wind: new THREE.Vector3(0, 0, 0),
    windFlutter: 0.5,
    damping: 0.97,
    stiffness: 0,
    iterations: 6,
    shade: "smooth",
    // Tight enough to keep two genuinely different vertices apart at the
    // scales this engine works in, loose enough to weld a UV seam.
    weldDistance: 0.0001,
  },
  paramFields: CLOTH_PARAM_FIELDS,
  evaluate: (inputs, params, ctx) => {
    const inputObj = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    const srcMesh = inputObj ? findFirstMesh(inputObj) : null;
    if (!inputObj || !srcMesh) {
      warnMeshRequired(ctx.nodeId, "Cloth", inputObj);
      return { geometry: inputObj ?? undefined, matrix: new THREE.Matrix4() };
    }
    clearMeshWarning(ctx.nodeId);

    const state = getState(ctx.nodeId);
    const sourceGeometryId = srcMesh.geometry.uuid;
    const weldDistance = Math.max(1e-6, numberInput(undefined, params.weldDistance, 0.0001));
    const sourceWorld = worldMatrixOf(srcMesh);

    const shade = asShade(params.shade);

    let rebuilt = false;
    if (!state.sim || state.sourceGeometryId !== sourceGeometryId) {
      const topology = buildClothTopology(srcMesh.geometry, weldDistance);
      if (!topology) {
        warnMeshRequired(ctx.nodeId, "Cloth", inputObj);
        return { geometry: inputObj, matrix: new THREE.Matrix4() };
      }
      state.output?.geometry.dispose();
      state.output = buildClothOutput(srcMesh.geometry, topology, shade);
      state.sim = createClothState(topology, sourceWorld);
      state.sourceGeometryId = sourceGeometryId;
      state.pinned.clear();
      rebuilt = true;
    } else if (state.output!.shade !== shade) {
      // Flat and smooth are different vertex counts, so switching is a new
      // geometry — but not a new simulation: the cloth keeps hanging where it
      // hung rather than snapping back to its rest shape mid-shot.
      state.output!.geometry.dispose();
      state.output = buildClothOutput(srcMesh.geometry, state.sim.topology, shade);
    }

    const sim = state.sim;
    let restWorld = restWorldCache.get(sim);
    if (!restWorld || restWorld.length !== sim.position.length) {
      restWorld = new Float32Array(sim.position.length);
      restWorldCache.set(sim, restWorld);
    }
    const point = new THREE.Vector3();
    for (let p = 0; p < sim.topology.count; p++) {
      point
        .set(sim.topology.rest[p * 3], sim.topology.rest[p * 3 + 1], sim.topology.rest[p * 3 + 2])
        .applyMatrix4(sourceWorld);
      restWorld[p * 3] = point.x;
      restWorld[p * 3 + 1] = point.y;
      restWorld[p * 3 + 2] = point.z;
    }

    const epoch = ctx.simulationEpoch ?? 0;
    const staleEpoch = state.epoch !== undefined && state.epoch !== epoch;
    state.epoch = epoch;

    const time = clockInput(inputs, params, ctx);
    const rewound = state.lastTime !== undefined && time < state.lastTime - REWIND_THRESHOLD;
    const first = state.lastTime === undefined;
    // Clamped: one long stall (a background tab, a shader compile) would
    // otherwise fling the cloth inside out in a single step.
    const dt = first || rewound ? 0 : Math.min(0.05, Math.max(0, time - state.lastTime!));
    state.lastTime = time;

    const resetting = numberInput(inputs.reset, params.reset, 0) > 0.5;
    const held = rebuilt || first || rewound || staleEpoch || resetting;
    if (held) {
      // Everything the cloth holds is history, so a scrub has exactly one
      // reproducible answer: the shape it was bound in.
      resetCloth(sim, restWorld);
      state.pinned.clear();
    }

    const pins: ClothPin[] = [];
    for (const { socket, object } of collectPrefixed(inputs, PIN_PREFIX)) {
      const anchor = new THREE.Vector3().setFromMatrixPosition(worldMatrixOf(object));
      let particle = state.pinned.get(socket);
      if (particle === undefined) {
        particle = nearestParticle(sim, anchor);
        state.pinned.set(socket, particle);
      }
      pins.push({ particle, position: anchor });
    }
    for (const socket of [...state.pinned.keys()]) {
      if (!(inputs[socket] instanceof THREE.Object3D)) state.pinned.delete(socket);
    }

    const colliders: ClothCollider[] = [];
    for (const { object } of collectPrefixed(inputs, COLLIDER_PREFIX)) {
      const collider = colliderFrom(object);
      if (collider) colliders.push(collider);
    }

    // A held Reset is "stay on the rest shape", not "restart every frame and
    // fall for one step" — which reads as a cloth sagging a few millimetres
    // and staying there.
    stepCloth(sim, {
      dt: held ? 0 : dt,
      time,
      gravity: asVector3(inputs.gravity, asVector3(params.gravity, new THREE.Vector3(0, -9.81, 0))),
      wind: asVector3(inputs.wind, asVector3(params.wind, new THREE.Vector3())),
      windFlutter: Math.max(0, numberInput(undefined, params.windFlutter, 0.5)),
      damping: numberInput(inputs.damping, params.damping, 0.97),
      stiffness: numberInput(inputs.stiffness, params.stiffness, 0),
      iterations: Math.max(1, Math.min(32, numberInput(undefined, params.iterations, 6))),
      restWorld,
      pins,
      colliders,
    });

    if (!state.mesh) state.mesh = createModifierMesh();
    const output = state.output!;
    writeClothToOutput(sim, output, new THREE.Matrix4().copy(sourceWorld).invert());

    return emitModifiedMesh(state.mesh, {
      inputObj,
      srcMesh,
      geometry: output.geometry !== state.mesh.geometry ? output.geometry : undefined,
      nodeId: ctx.nodeId,
    });
  },
};
