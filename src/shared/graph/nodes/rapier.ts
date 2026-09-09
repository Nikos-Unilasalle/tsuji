import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { clockInput, numberInput } from "./object";
import { asVector3 } from "./transform";
import {
  COLLIDER_SHAPES,
  ColliderShape,
  PhysicsWorldHandle,
  bodyMatrix,
  bodyPosition,
  bodyVelocity,
  buildColliderDesc,
  createPhysicsWorld,
  extractColliderGeometry,
  getRapier,
  initRapier,
  isPhysicsWorld,
  isRapierReady,
  resolveShape,
  stepPhysicsWorld,
} from "../../three/physics/rapierRuntime";

/** Same scrub threshold the integrators, Spring and the capsule controller use. */
const REWIND_THRESHOLD = 0.5;

/* -------------------------------------------------------------------------- */
/* World                                                                      */
/* -------------------------------------------------------------------------- */

interface WorldState {
  handle: PhysicsWorldHandle;
  signature: string;
  lastTime?: number;
}

const worldCache = createNodeCache<WorldState>((state) => state.handle.dispose());

/**
 * Physics World — the rigid-body simulation everything else joins.
 *
 * Rapier, not a hand-rolled solver: stacking, resting contacts, friction and
 * joints are each individually hard and collectively a research project, and
 * the capsule controller already covers the one case where a solver is the
 * wrong tool (a character, which wants exact control rather than momentum).
 * This is for everything else — crates, debris, ragdolls, vehicles.
 *
 * It is stepped at a **fixed timestep** with the leftover carried between
 * frames. A variable step makes a stack of boxes settle differently at 60 and
 * 144 fps and makes an export disagree with the preview it was authored in.
 *
 * The engine is WASM and compiles asynchronously, so the first few frames
 * report `Ready = 0` and every body passes through untouched. Nothing blocks,
 * nothing throws; the simulation simply begins a moment later.
 */
export const PHYSICS_WORLD_NODE: NodeDefinition = {
  type: "physics/world",
  label: "Physics World",
  category: "physics",
  inputs: [
    { id: "gravity", label: "Gravity", type: "vector" },
    { id: "time", label: "Time", type: "value" },
    { id: "paused", label: "Paused", type: "value" },
    { id: "reset", label: "Reset", type: "value" },
  ],
  outputs: [
    { id: "world", label: "World", type: "any" },
    { id: "ready", label: "Ready", type: "value" },
    { id: "bodies", label: "Body Count", type: "value" },
    { id: "steps", label: "Steps This Frame", type: "value" },
  ],
  defaultParams: {
    gravity: new THREE.Vector3(0, -9.81, 0),
    timestep: 1 / 60,
    maxSteps: 4,
    paused: 0,
    reset: 0,
  },
  paramFields: [
    { id: "gravity", label: "Gravity", kind: "vector" },
    { id: "timestep", label: "Fixed Timestep (s)", kind: "number", step: 0.001 },
    { id: "maxSteps", label: "Max Steps per Frame", kind: "number", step: 1 },
    { id: "paused", label: "Paused", kind: "boolean" },
    {
      id: "note",
      label:
        "The engine is WebAssembly and compiles in the background: Ready stays 0 for the first few frames, " +
        "and bodies pass through untouched until it is up.",
      kind: "note",
    },
  ],
  evaluate: (inputs, params, ctx) => {
    // Idempotent, and the only place the load is ever kicked off.
    void initRapier();
    const api = getRapier();

    const gravity = asVector3(inputs.gravity, asVector3(params.gravity, new THREE.Vector3(0, -9.81, 0)));

    if (!api) {
      return { world: null, ready: 0, bodies: 0, steps: 0 };
    }

    const time = clockInput(inputs, params, ctx);
    const signature = `${gravity.x},${gravity.y},${gravity.z}`;

    let state = worldCache.get(ctx.nodeId);
    const resetting = Number(inputs.reset !== undefined ? inputs.reset : params.reset) > 0.5;
    const rewound = state?.lastTime !== undefined && time < state.lastTime - REWIND_THRESHOLD;

    // Gravity is baked into the world at construction, and a scrub means the
    // whole simulation's history no longer applies — both are rebuilds. Bodies
    // notice through `generation` and re-create themselves.
    if (state && (state.signature !== signature || resetting || rewound)) {
      const generation = state.handle.generation + 1;
      state.handle.dispose();
      state = { handle: createPhysicsWorld(api, ctx.nodeId, gravity, generation), signature };
      worldCache.set(ctx.nodeId, state);
    } else if (!state) {
      state = { handle: createPhysicsWorld(api, ctx.nodeId, gravity, 0), signature };
      worldCache.set(ctx.nodeId, state);
    }

    state.lastTime = time;

    const paused = Number(inputs.paused !== undefined ? inputs.paused : params.paused) > 0.5;
    const timestep = Math.max(1 / 480, numberInput(undefined, params.timestep, 1 / 60));
    const maxSteps = Math.max(0, Math.min(16, Math.floor(numberInput(undefined, params.maxSteps, 4))));

    // Stepped before the bodies read their poses back, so what they publish is
    // the state the solver just produced.
    const steps = paused ? 0 : stepPhysicsWorld(state.handle, time, timestep, maxSteps);
    if (paused) state.handle.lastTime = time;

    return {
      world: state.handle,
      ready: 1,
      bodies: state.handle.bodies.size,
      steps,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Rigid Body                                                                 */
/* -------------------------------------------------------------------------- */

export const BODY_TYPES = ["dynamic", "fixed", "kinematic"] as const;
export type BodyType = (typeof BODY_TYPES)[number];

interface BodyState {
  body: RAPIER.RigidBody;
  worldNodeId: string;
  generation: number;
  signature: string;
  object: THREE.Object3D;
}

const bodyCache = createNodeCache<BodyState>();

function asBodyType(value: unknown): BodyType {
  return (BODY_TYPES as readonly string[]).includes(value as string) ? (value as BodyType) : "dynamic";
}

function asShape(value: unknown): ColliderShape {
  return (COLLIDER_SHAPES as readonly string[]).includes(value as string) ? (value as ColliderShape) : "auto";
}

/**
 * Rigid Body — hands a piece of geometry to the physics world and moves it
 * with whatever the solver decides.
 *
 * The shape defaults to a convex hull for a dynamic body and a triangle mesh
 * for a fixed one: a hull is cheap, always closed, and stacks predictably,
 * while a trimesh is the only shape that can represent a level exactly and its
 * lack of volume only matters for something that moves.
 *
 * The body is rebuilt when its *shape* changes and left alone otherwise, so
 * dragging friction or restitution never restarts the simulation, while
 * switching from a box to a hull does.
 */
export const RIGID_BODY_NODE: NodeDefinition = {
  type: "physics/rigid-body",
  label: "Rigid Body",
  category: "physics",
  inputs: [
    { id: "world", label: "World", type: "any" },
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "force", label: "Force", type: "vector" },
    { id: "target", label: "Kinematic Target", type: "vector" },
    { id: "mass", label: "Mass", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "position", label: "Position", type: "vector" },
    { id: "velocity", label: "Velocity", type: "vector" },
    { id: "speed", label: "Speed", type: "value" },
  ],
  defaultParams: {
    bodyType: "dynamic",
    shape: "auto",
    mass: 1,
    friction: 0.7,
    restitution: 0.1,
    linearDamping: 0.05,
    angularDamping: 0.05,
    gravityScale: 1,
    ccd: false,
  },
  paramFields: [
    { id: "bodyType", label: "Body Type", kind: "select", options: [...BODY_TYPES] },
    { id: "shape", label: "Collider Shape", kind: "select", options: [...COLLIDER_SHAPES] },
    { id: "mass", label: "Mass", kind: "number", step: 0.1, group: "Material" },
    { id: "friction", label: "Friction", kind: "number", step: 0.05, group: "Material" },
    { id: "restitution", label: "Bounciness", kind: "number", step: 0.05, group: "Material" },
    { id: "linearDamping", label: "Linear Damping", kind: "number", step: 0.01, group: "Material" },
    { id: "angularDamping", label: "Angular Damping", kind: "number", step: 0.01, group: "Material" },
    { id: "gravityScale", label: "Gravity Scale", kind: "number", step: 0.1, group: "Material" },
    {
      id: "ccd",
      label: "Continuous Collision (fast movers)",
      kind: "boolean",
      group: "Material",
    },
  ],
  evaluate: (inputs, params, ctx) => {
    const object = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    const handle = isPhysicsWorld(inputs.world) ? inputs.world : null;
    const api = getRapier();

    // No world, no engine, or nothing to simulate: hand the geometry straight
    // back so the scene still renders while physics warms up.
    if (!object || !handle || !api || !isRapierReady()) {
      return {
        geometry: object,
        matrix: object ? object.matrix.clone() : new THREE.Matrix4(),
        position: object ? object.position.clone() : new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        speed: 0,
      };
    }

    const bodyType = asBodyType(params.bodyType);
    const isDynamic = bodyType === "dynamic";
    const shape = resolveShape(asShape(params.shape), isDynamic);
    const signature = `${bodyType}|${shape}|${handle.generation}`;

    let state = bodyCache.get(ctx.nodeId);

    if (!state || state.signature !== signature || state.worldNodeId !== handle.nodeId) {
      if (state && state.worldNodeId === handle.nodeId && state.generation === handle.generation) {
        handle.world.removeRigidBody(state.body);
        handle.bodies.delete(ctx.nodeId);
      }

      const geometry = extractColliderGeometry(object);
      if (!geometry) {
        return {
          geometry: object,
          matrix: object.matrix.clone(),
          position: object.position.clone(),
          velocity: new THREE.Vector3(),
          speed: 0,
        };
      }

      // The body starts where the graph has already put the object, so an
      // author positions it with the same Transform they use for everything
      // else rather than a physics-only field.
      object.updateWorldMatrix(true, false);
      const start = new THREE.Vector3();
      const rotation = new THREE.Quaternion();
      object.matrixWorld.decompose(start, rotation, new THREE.Vector3());

      const desc =
        bodyType === "fixed"
          ? api.RigidBodyDesc.fixed()
          : bodyType === "kinematic"
            ? api.RigidBodyDesc.kinematicPositionBased()
            : api.RigidBodyDesc.dynamic();
      desc.setTranslation(start.x, start.y, start.z);
      desc.setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w });

      const body = handle.world.createRigidBody(desc);
      const colliderDesc = buildColliderDesc(api, shape, geometry);
      if (colliderDesc) handle.world.createCollider(colliderDesc, body);

      handle.bodies.set(ctx.nodeId, body);
      state = { body, worldNodeId: handle.nodeId, generation: handle.generation, signature, object };
      bodyCache.set(ctx.nodeId, state);
    }

    const { body } = state;

    body.setLinearDamping(Math.max(0, numberInput(undefined, params.linearDamping, 0.05)));
    body.setAngularDamping(Math.max(0, numberInput(undefined, params.angularDamping, 0.05)));
    body.setGravityScale(numberInput(undefined, params.gravityScale, 1), true);
    body.enableCcd(Boolean(params.ccd));

    const collider = body.collider(0);
    if (collider) {
      collider.setFriction(Math.max(0, numberInput(undefined, params.friction, 0.7)));
      collider.setRestitution(Math.max(0, numberInput(undefined, params.restitution, 0.1)));
    }

    if (isDynamic) {
      const mass = numberInput(inputs.mass, params.mass, 1);
      if (mass > 0) body.setAdditionalMass(mass, true);

      const force = asVector3(inputs.force, new THREE.Vector3());
      if (force.lengthSq() > 1e-12) {
        body.addForce({ x: force.x, y: force.y, z: force.z }, true);
      }
    }

    if (bodyType === "kinematic" && inputs.target instanceof THREE.Vector3) {
      body.setNextKinematicTranslation({
        x: inputs.target.x,
        y: inputs.target.y,
        z: inputs.target.z,
      });
    }

    // The solver owns the pose now: write it onto the object rather than
    // letting the graph's own transform fight it.
    const matrix = bodyMatrix(body);
    object.matrixAutoUpdate = false;
    object.matrix.copy(matrix);
    matrix.decompose(object.position, object.quaternion, object.scale);
    object.matrixWorldNeedsUpdate = true;

    const velocity = bodyVelocity(body);

    return {
      geometry: object,
      matrix: matrix.clone(),
      position: bodyPosition(body),
      velocity,
      speed: velocity.length(),
    };
  },
};
