import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { createNodeCache } from "../nodeCaches";
import { NodeDefinition, ParamFieldDef } from "../types";
import { numberInput } from "./object";
import { asVector3 } from "./transform";
import { toBoolean } from "../sockets";
import { findFirstMesh } from "../meshRequired";
import { worldMatrixOf } from "../objectPosition";
import {
  COLLIDER_SHAPES,
  ColliderShape,
  bodyMatrix,
  buildColliderDesc,
  extractColliderGeometry,
  getRapier,
  isPhysicsWorld,
  isRapierReady,
  resolveShape,
  scaleColliderGeometry,
} from "../../three/physics/rapierRuntime";

interface SpawnerState {
  mesh: THREE.InstancedMesh | null;
  bodies: RAPIER.RigidBody[];
  /** How many have been launched, so an unused slot can stay hidden rather than sitting at the origin. */
  launched: boolean[];
  signature: string;
  worldNodeId: string;
  nextIndex: number;
  spawned: number;
  prevTrigger: boolean;
  epoch: number;
}

const spawnerCache = createNodeCache<SpawnerState>((state) => {
  state.mesh?.geometry.dispose();
});

/** Deterministic per-launch jitter: the same shot fires the same way every time the graph replays. */
function hash11(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

function asShape(value: unknown): ColliderShape {
  return (COLLIDER_SHAPES as readonly string[]).includes(value as string) ? (value as ColliderShape) : "auto";
}

/**
 * Where a shot leaves the barrel, and how hard.
 *
 * Pulled out of the node so the aiming can be tested without rapier, which is WebAssembly and
 * never loads under test. `shot` is the launch counter: every value is scattered differently and
 * always the same way, so replaying a graph fires the same shots in the same directions.
 */
export function launchImpulse(
  shot: number,
  direction: THREE.Vector3,
  speed: number,
  spread: number,
  mass: number,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  const rand = (salt: number) => hash11(shot * 7.13 + salt) - 0.5;

  // A direction of zero has no aim to scatter, so the shot goes down +Z rather than nowhere.
  if (direction.lengthSq() > 0) target.copy(direction).normalize();
  else target.set(0, 0, 1);

  target.x += rand(4) * spread;
  target.y += rand(5) * spread;
  target.z += rand(6) * spread;

  // Impulse, not velocity: a heavy object leaves the barrel slower than a light one for the same
  // shot, and the launch reads as a push — which is what the original does.
  return target.normalize().multiplyScalar(speed * mass);
}

/** The spawn point for a shot, scattered by `jitter` so a burst does not stack in one place. */
export function launchOrigin(
  shot: number,
  point: THREE.Vector3,
  jitter: number,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  const rand = (salt: number) => hash11(shot * 7.13 + salt) - 0.5;
  return target.set(point.x + rand(1) * jitter, point.y + rand(2) * jitter, point.z + rand(3) * jitter);
}

const SPAWNER_PARAM_FIELDS: ParamFieldDef[] = [
  { id: "count", label: "Pool Size", kind: "number", step: 1, group: "Pool" },
  {
    id: "poolNote",
    label:
      "The bodies are all built once and reused in a ring: launching the pool's worth of objects "
      + "recycles the oldest one rather than creating another. Pool Size is therefore also the "
      + "most that can be in flight at a time.",
    kind: "note",
    group: "Pool",
  },
  { id: "shape", label: "Collider Shape", kind: "select", options: [...COLLIDER_SHAPES], group: "Pool" },

  { id: "position", label: "Spawn Point", kind: "vector", group: "Launch" },
  { id: "direction", label: "Direction", kind: "vector", group: "Launch" },
  { id: "speed", label: "Launch Speed (m/s)", kind: "number", step: 0.5, group: "Launch" },
  { id: "spread", label: "Spread", kind: "number", step: 0.05, group: "Launch" },
  { id: "jitter", label: "Spawn Jitter", kind: "number", step: 0.05, group: "Launch" },
  { id: "spin", label: "Spin", kind: "number", step: 0.05, group: "Launch" },

  { id: "mass", label: "Mass", kind: "number", step: 0.1, group: "Material" },
  { id: "friction", label: "Friction", kind: "number", step: 0.05, group: "Material" },
  { id: "restitution", label: "Bounciness", kind: "number", step: 0.05, group: "Material" },
  { id: "linearDamping", label: "Linear Damping", kind: "number", step: 0.01, group: "Material" },
  { id: "angularDamping", label: "Angular Damping", kind: "number", step: 0.01, group: "Material" },
  { id: "ccd", label: "Continuous Collision (fast movers)", kind: "boolean", group: "Material" },
];

/**
 * Spawner — launches copies of an object into the physics world, one per trigger.
 *
 * Modelled on the cookie launcher in brunosimon/folio-2025 (World/Areas/CookieArea.js), which is
 * built the way a launcher has to be: every body exists from the start, disabled and parked, and
 * firing takes the next one in a ring, moves it to the spawn point and pushes it. Nothing is
 * created or destroyed while the scene runs, so there is no allocation to hitch on and the
 * instanced draw never has to be rebuilt.
 *
 * The `world` socket passes through, so this can sit between Physics World and anything that has
 * to come after it.
 */
export const PHYSICS_SPAWNER_NODE: NodeDefinition = {
  type: "physics/spawner",
  label: "Spawner",
  category: "physics",
  inputs: [
    { id: "world", label: "World", type: "any" },
    { id: "prototype", label: "Object", type: "geometry", owns: true },
    { id: "trigger", label: "Trigger", type: "value" },
    { id: "position", label: "Spawn Point", type: "vector" },
    { id: "direction", label: "Direction", type: "vector" },
    { id: "speed", label: "Launch Speed", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "world", label: "World", type: "any" },
    { id: "alive", label: "In Flight", type: "value" },
    { id: "spawned", label: "Spawned", type: "value" },
  ],
  defaultParams: {
    count: 20,
    shape: "auto",

    position: new THREE.Vector3(0, 2, 0),
    direction: new THREE.Vector3(0, 0.35, 1),
    speed: 6,
    spread: 0.15,
    jitter: 0.25,
    spin: 0.4,

    mass: 1,
    friction: 0.7,
    restitution: 0.2,
    linearDamping: 0.05,
    angularDamping: 0.05,
    ccd: false,
  },
  paramFields: SPAWNER_PARAM_FIELDS,
  evaluate: (inputs, params, ctx) => {
    const handle = isPhysicsWorld(inputs.world) ? inputs.world : null;
    const passthrough = inputs.world ?? null;
    const prototype = inputs.prototype instanceof THREE.Object3D ? inputs.prototype : null;
    const api = getRapier();

    let state = spawnerCache.get(ctx.nodeId);

    const idle = () => ({
      geometry: state?.mesh ?? prototype,
      world: passthrough,
      alive: 0,
      spawned: state?.spawned ?? 0,
    });

    if (!handle || !prototype || !api || !isRapierReady()) return idle();

    const srcMesh = findFirstMesh(prototype);
    if (!srcMesh || !srcMesh.geometry.attributes.position) return idle();

    const count = Math.max(1, Math.min(2048, Math.floor(numberInput(undefined, params.count, 20))));
    const shape = resolveShape(asShape(params.shape), true);
    const epoch = ctx.simulationEpoch ?? 0;
    const signature = `${count}|${shape}|${srcMesh.geometry.uuid}|${handle.generation}|${epoch}`;

    if (!state || state.signature !== signature || state.worldNodeId !== handle.nodeId) {
      // A rebuild takes the old bodies out with it: leaving them in the world would pile up an
      // invisible copy of the pool every time the prototype or the world changed.
      if (state) {
        for (const body of state.bodies) handle.world.removeRigidBody(body);
        state.mesh?.geometry.dispose();
      }

      const geometry = extractColliderGeometry(prototype);
      if (!geometry) return idle();

      const matrix = worldMatrixOf(srcMesh);
      const scale = new THREE.Vector3().setFromMatrixScale(matrix);
      const desc = buildColliderDesc(api, shape, scaleColliderGeometry(geometry, scale));
      if (!desc) return idle();

      const bodies: RAPIER.RigidBody[] = [];
      for (let i = 0; i < count; i++) {
        // Disabled and at the origin: a body only ever appears once it is fired.
        const body = handle.world.createRigidBody(api.RigidBodyDesc.dynamic().setEnabled(false));
        handle.world.createCollider(desc, body);
        bodies.push(body);
      }

      const mesh = new THREE.InstancedMesh(srcMesh.geometry.clone(), srcMesh.material, count);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.userData.nodeId = ctx.nodeId;

      state = {
        mesh,
        bodies,
        launched: new Array(count).fill(false),
        signature,
        worldNodeId: handle.nodeId,
        nextIndex: 0,
        spawned: state?.spawned ?? 0,
        prevTrigger: state?.prevTrigger ?? false,
        epoch,
      };
      spawnerCache.set(ctx.nodeId, state);
    }

    const mass = Math.max(0.0001, numberInput(undefined, params.mass, 1));
    const friction = Math.max(0, numberInput(undefined, params.friction, 0.7));
    const restitution = Math.max(0, numberInput(undefined, params.restitution, 0.2));
    const linearDamping = Math.max(0, numberInput(undefined, params.linearDamping, 0.05));
    const angularDamping = Math.max(0, numberInput(undefined, params.angularDamping, 0.05));
    const ccd = Boolean(params.ccd ?? false);

    for (const body of state.bodies) {
      body.setLinearDamping(linearDamping);
      body.setAngularDamping(angularDamping);
      body.enableCcd(ccd);
      const collider = body.collider(0);
      if (collider) {
        collider.setFriction(friction);
        collider.setRestitution(restitution);
      }
      // Same route Rigid Body takes: the collider keeps the mass its density gives it, and Mass
      // is added on top. Setting the collider's mass directly never reaches the body. Rapier
      // folds this in during the next step, so `body.mass()` keeps reporting the old value until
      // then — which is why the launch below reads the mass rather than assuming it.
      if (mass > 0) body.setAdditionalMass(mass, true);
    }

    const trigger = toBoolean(inputs.trigger);
    const fired = trigger && !state.prevTrigger;
    state.prevTrigger = trigger;

    if (fired) {
      const spawnPoint = asVector3(inputs.position, asVector3(params.position, new THREE.Vector3(0, 2, 0)));
      const direction = asVector3(inputs.direction, asVector3(params.direction, new THREE.Vector3(0, 0.35, 1)));
      const speed = numberInput(inputs.speed, params.speed, 6);
      const spread = Math.max(0, numberInput(undefined, params.spread, 0.15));
      const jitter = Math.max(0, numberInput(undefined, params.jitter, 0.25));
      const spin = numberInput(undefined, params.spin, 0.4);

      const shot = state.spawned;
      const rand = (salt: number) => hash11(shot * 7.13 + salt) - 0.5;
      const origin = launchOrigin(shot, spawnPoint, jitter);

      const body = state.bodies[state.nextIndex];
      body.setTranslation({ x: origin.x, y: origin.y, z: origin.z }, false);
      body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, false);
      body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      body.setEnabled(true);

      // Scaled by the body's *actual* mass, not by the Mass parameter: rapier gives a collider
      // mass of its own from its density, so reading it back is the only way Speed can mean a
      // launch speed in metres per second rather than an impulse in unknown units.
      const bodyMass = body.mass() > 0 ? body.mass() : mass;
      const aim = launchImpulse(shot, direction, speed, spread, bodyMass);
      body.applyImpulse({ x: aim.x, y: aim.y, z: aim.z }, true);
      if (spin !== 0) {
        body.applyTorqueImpulse(
          { x: rand(7) * spin * bodyMass, y: rand(8) * spin * bodyMass, z: rand(9) * spin * bodyMass },
          true,
        );
      }

      state.launched[state.nextIndex] = true;
      state.nextIndex = (state.nextIndex + 1) % state.bodies.length;
      state.spawned += 1;
    }

    const mesh = state.mesh!;
    const matrix = new THREE.Matrix4();
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    let alive = 0;

    for (let i = 0; i < state.bodies.length; i++) {
      if (!state.launched[i]) {
        // InstancedMesh has no per-instance visibility, so an unfired slot is scaled away.
        mesh.setMatrixAt(i, hidden);
        continue;
      }
      alive++;
      mesh.setMatrixAt(i, bodyMatrix(state.bodies[i], matrix));
    }
    mesh.instanceMatrix.needsUpdate = true;

    return { geometry: mesh, world: passthrough, alive, spawned: state.spawned };
  },
};
