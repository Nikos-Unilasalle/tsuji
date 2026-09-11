import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { clockInput, numberInput } from "./object";
import { asVector3 } from "./transform";
import { accelerateHorizontal, applyFriction } from "../../three/controls/capsuleController";
import {
  COLLIDER_SHAPES,
  ColliderGeometry,
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
  scaleColliderGeometry,
  worldMatrixOf,
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
  /** Which simulation epoch this world was built in — see simulationEpoch.ts. */
  epoch: number;
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

    const epoch = ctx.simulationEpoch ?? 0;
    let state = worldCache.get(ctx.nodeId);
    const resetting = Number(inputs.reset !== undefined ? inputs.reset : params.reset) > 0.5;
    const rewound = state?.lastTime !== undefined && time < state.lastTime - REWIND_THRESHOLD;
    const staleEpoch = state !== undefined && state.epoch !== epoch;

    // Gravity is baked into the world at construction, and a scrub means the
    // whole simulation's history no longer applies — both are rebuilds. Bodies
    // notice through `generation` and re-create themselves.
    if (state && (state.signature !== signature || resetting || rewound || staleEpoch)) {
      const generation = state.handle.generation + 1;
      state.handle.dispose();
      state = { handle: createPhysicsWorld(api, ctx.nodeId, gravity, generation), signature, epoch };
      worldCache.set(ctx.nodeId, state);
    } else if (!state) {
      state = { handle: createPhysicsWorld(api, ctx.nodeId, gravity, 0), signature, epoch };
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

/** One simulated body, and where its pose is written back on screen. */
interface BodyEntry {
  body: RAPIER.RigidBody;
  /** The mesh that draws it — an InstancedMesh when this is one instance of many. */
  mesh: THREE.Mesh;
  /** Which instance, or -1 for a mesh that stands on its own. */
  instanceIndex: number;
  /** Preserved scale from authoring time. */
  scale: THREE.Vector3;
}

/** Where a body had got to, so a rebuild can pick the simulation back up rather than restart it. */
interface MotionSnapshot {
  translation: RAPIER.Vector;
  rotation: RAPIER.Rotation;
  linvel: RAPIER.Vector;
  angvel: RAPIER.Vector;
}

interface BodyState {
  entries: BodyEntry[];
  worldNodeId: string;
  generation: number;
  signature: string;
}

const bodyCache = createNodeCache<BodyState>();

function asBodyType(value: unknown): BodyType {
  return (BODY_TYPES as readonly string[]).includes(value as string) ? (value as BodyType) : "dynamic";
}

function asShape(value: unknown): ColliderShape {
  return (COLLIDER_SHAPES as readonly string[]).includes(value as string) ? (value as ColliderShape) : "auto";
}

export const BODY_SPLIT_MODES = ["per-child", "whole"] as const;
export type BodySplitMode = (typeof BODY_SPLIT_MODES)[number];

function asSplit(value: unknown): BodySplitMode {
  return (BODY_SPLIT_MODES as readonly string[]).includes(value as string)
    ? (value as BodySplitMode)
    : "per-child";
}

/** One thing that should become a body: a mesh, or one instance of an instanced mesh. */
interface BodyTarget {
  mesh: THREE.Mesh;
  instanceIndex: number;
  /** World pose it starts at. */
  matrix: THREE.Matrix4;
}

const _instanceMatrix = new THREE.Matrix4();

export function collectBodyTargets(root: THREE.Object3D, split: BodySplitMode): BodyTarget[] {
  if (split === "whole") {
    // One body for the lot: a car chassis built from five meshes is one rigid
    // body, not five that immediately shove each other apart.
    const mesh = root as THREE.Mesh;
    return [{ mesh, instanceIndex: -1, matrix: worldMatrixOf(root) }];
  }

  const targets: BodyTarget[] = [];
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.attributes?.position) return;

    const instanced = mesh as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) {
      const instancedWorld = worldMatrixOf(instanced);
      for (let i = 0; i < instanced.count; i++) {
        instanced.getMatrixAt(i, _instanceMatrix);
        targets.push({
          mesh: instanced,
          instanceIndex: i,
          matrix: new THREE.Matrix4().multiplyMatrices(instancedWorld, _instanceMatrix),
        });
      }
      return;
    }

    targets.push({ mesh, instanceIndex: -1, matrix: worldMatrixOf(mesh) });
  });

  return targets;
}

const _shapeScale = new THREE.Vector3();

/**
 * What one target *is*, in terms that survive the object being rebuilt.
 *
 * Not the geometry uuid, which was the obvious choice and the wrong one: a
 * uuid is identity, and several nodes hand back a freshly built
 * BufferGeometry every frame even when nothing changed (Edit Mesh, Wave
 * Ripple, Facet Explode, Lattice Deform, Curve Deform — see
 * nodeContracts.test.ts). Keying on it made the physics correct only for as
 * long as every upstream node happened to cache well, and a body behind one
 * that did not was destroyed and re-created before it could ever move.
 *
 * So: the producing node's id where there is one, plus enough of the shape to
 * notice a real edit —
 *
 *  - **vertex and index counts** catch a re-subdivided, extruded or
 *    re-topologised mesh;
 *  - **world scale** catches a box resized through its own scale param, which
 *    changes no counts at all but does change the collider, since
 *    extractColliderGeometry bakes scale into the vertices.
 *
 * What it deliberately does *not* notice is vertices moving with the counts
 * unchanged — a lattice or a ripple deforming over time. That leaves the
 * collider slightly behind the visible surface, which is the cheaper of the
 * two errors by a wide margin: the alternative is resetting the body sixty
 * times a second, which is not "slightly" anything.
 */
function describeTarget(target: BodyTarget): string {
  const mesh = target.mesh;
  const nodeId = typeof mesh.userData?.nodeId === "string" ? mesh.userData.nodeId : null;
  const identity = nodeId ?? mesh.geometry?.uuid ?? mesh.uuid;
  const vertices = mesh.geometry?.attributes?.position?.count ?? 0;
  const indices = mesh.geometry?.getIndex()?.count ?? 0;
  target.matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), _shapeScale);
  const scale = `${_shapeScale.x.toFixed(4)},${_shapeScale.y.toFixed(4)},${_shapeScale.z.toFixed(4)}`;
  return `${identity}:${vertices}/${indices}:${scale}`;
}

/**
 * What the set of targets *is*, rather than where they have got to.
 *
 * Rebuilding on every pose change would restart the simulation every frame;
 * rebuilding on none of them would miss a crate being added. Counting shapes
 * catches the second without noticing the first.
 */
export function describeTargets(targets: readonly BodyTarget[]): string {
  const counts = new Map<string, number>();
  for (const target of targets) {
    const key = describeTarget(target);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => `${key}x${count}`).join("|");
}

const _parentInverse = new THREE.Matrix4();
const _parentWorld = new THREE.Matrix4();
const _pose = new THREE.Vector3();
const _poseQuat = new THREE.Quaternion();
const _poseScale = new THREE.Vector3();
const _boxSize = new THREE.Vector3();

/**
 * Rigid Body — hands geometry to the physics world and moves it with whatever
 * the solver decides.
 *
 * **Split defaults to per-child**, so one node handles a whole Merge: twenty
 * crates wired into a Merge become twenty bodies behind a single Rigid Body
 * node. An InstancedMesh contributes one body per instance, so an Array of a
 * hundred boxes simulates without a hundred nodes. Switch to `whole` for the
 * opposite case — a chassis built from several meshes has to be *one* body, or
 * its parts shove each other apart on the first frame.
 *
 * The shape defaults to a convex hull for a dynamic body and a triangle mesh
 * for a fixed one: a hull is cheap, always closed, and stacks predictably,
 * while a trimesh is the only shape that can represent a level exactly and its
 * lack of volume only matters for something that moves.
 *
 * Bodies are rebuilt when the *set* of them changes — shape, body type, split,
 * or a mesh appearing — and left alone otherwise, so dragging friction never
 * restarts the simulation.
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
    { id: "count", label: "Body Count", type: "value" },
  ],
  defaultParams: {
    bodyType: "dynamic",
    shape: "auto",
    split: "per-child",
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
    {
      id: "split",
      label: "Split",
      kind: "select",
      options: [...BODY_SPLIT_MODES],
    },
    {
      id: "splitNote",
      label:
        "per-child: every mesh — and every instance of an instanced mesh — becomes its own body, " +
        "so one node handles a whole Merge or Array. whole: one body for the lot, for a chassis " +
        "built from several meshes.",
      kind: "note",
    },
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

    const idle = () => ({
      geometry: object,
      matrix: object ? object.matrix.clone() : new THREE.Matrix4(),
      position: object ? object.position.clone() : new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      speed: 0,
      count: 0,
    });

    // No world, no engine, or nothing to simulate: hand the geometry straight
    // back so the scene still renders while physics warms up.
    if (!object || !handle || !api || !isRapierReady()) return idle();

    const bodyType = asBodyType(params.bodyType);
    const isDynamic = bodyType === "dynamic";
    const shape = resolveShape(asShape(params.shape), isDynamic);
    const split = asSplit(params.split);

    const targets = collectBodyTargets(object, split);
    if (targets.length === 0) return idle();

    const signature = `${bodyType}|${shape}|${split}|${handle.generation}|${describeTargets(targets)}`;
    let state = bodyCache.get(ctx.nodeId);

    if (!state || state.signature !== signature || state.worldNodeId !== handle.nodeId) {
      // A rebuild must not be a reset. The shape changed (or an upstream node
      // churned its geometry) — that is no reason for a crate halfway to the
      // floor to teleport back to where it was authored and start again, which
      // is exactly what a body re-created from its target's matrix does.
      // Carried only within the same world and generation: a Reset rebuilds
      // the world itself, and there the whole point is to start over.
      let carried: MotionSnapshot[] | null = null;
      if (state && state.worldNodeId === handle.nodeId && state.generation === handle.generation) {
        carried = state.entries.map((entry) => ({
          translation: entry.body.translation(),
          rotation: entry.body.rotation(),
          linvel: entry.body.linvel(),
          angvel: entry.body.angvel(),
        }));
        for (const entry of state.entries) handle.world.removeRigidBody(entry.body);
        handle.bodies.delete(ctx.nodeId);
      }

      // One collider shape per source mesh, reused across its instances: the
      // hull of a crate is the same hull whichever copy of it is falling.
      const shapes = new Map<string, ColliderGeometry | null>();
      const entries: BodyEntry[] = [];

      for (const target of targets) {
        let base = shapes.get(target.mesh.uuid);
        if (base === undefined) {
          base = extractColliderGeometry(target.mesh);
          // A geometry with no volume (a box scaled to 0 on an axis, a
          // degenerate merge) has nothing for a convex hull to wrap — feeding
          // it to Rapier anyway risks a WASM-side panic that corrupts the
          // *whole* physics world, not just this target, which is a far
          // worse failure than one crate quietly having no collider.
          if (base && (base.box.isEmpty() || base.box.getSize(_boxSize).lengthSq() < 1e-10)) {
            console.warn(`physics/rigid-body: skipping a degenerate (zero-volume) collider on "${target.mesh.name || target.mesh.uuid}"`);
            base = null;
          }
          shapes.set(target.mesh.uuid, base);
        }
        if (!base) continue;

        target.matrix.decompose(_pose, _poseQuat, _poseScale);

        // One bad target must not cost every other one in this same Merge its
        // body — an exception here is caught per-target, not left to unwind
        // out of the whole rebuild.
        try {
          const desc =
            bodyType === "fixed"
              ? api.RigidBodyDesc.fixed()
              : bodyType === "kinematic"
                ? api.RigidBodyDesc.kinematicPositionBased()
                : api.RigidBodyDesc.dynamic();
          desc.setTranslation(_pose.x, _pose.y, _pose.z);
          desc.setRotation({ x: _poseQuat.x, y: _poseQuat.y, z: _poseQuat.z, w: _poseQuat.w });

          const previous = carried?.[entries.length];
          if (previous) {
            desc.setTranslation(previous.translation.x, previous.translation.y, previous.translation.z);
            desc.setRotation(previous.rotation);
          }

          const body = handle.world.createRigidBody(desc);
          if (previous && bodyType === "dynamic") {
            body.setLinvel(previous.linvel, true);
            body.setAngvel(previous.angvel, true);
          }
          // An instance's scale lives in its matrix and a collider has none, so
          // each distinct size needs its own scaled copy of the shape.
          const scaled =
            target.instanceIndex >= 0 ? scaleColliderGeometry(base, _poseScale) : base;
          const colliderDesc = buildColliderDesc(api, shape, scaled);
          if (colliderDesc) handle.world.createCollider(colliderDesc, body);

          entries.push({
            body,
            mesh: target.mesh,
            instanceIndex: target.instanceIndex,
            scale: _poseScale.clone(),
          });
        } catch (err) {
          console.error(`physics/rigid-body: failed to create a body for "${target.mesh.name || target.mesh.uuid}"`, err);
        }
      }

      if (entries.length === 0) return idle();

      handle.bodies.set(ctx.nodeId, entries[0].body);
      state = { entries, worldNodeId: handle.nodeId, generation: handle.generation, signature };
      bodyCache.set(ctx.nodeId, state);
    } else {
      // Re-bind to the objects that exist *now*. An Array rebuilds its clones
      // every frame, so the meshes a body was created against are already in
      // the bin; writing poses into them would move nothing on screen.
      for (let i = 0; i < state.entries.length && i < targets.length; i++) {
        state.entries[i].mesh = targets[i].mesh;
        state.entries[i].instanceIndex = targets[i].instanceIndex;
      }
    }

    const linearDamping = Math.max(0, numberInput(undefined, params.linearDamping, 0.05));
    const angularDamping = Math.max(0, numberInput(undefined, params.angularDamping, 0.05));
    const gravityScale = numberInput(undefined, params.gravityScale, 1);
    const ccd = Boolean(params.ccd);
    const friction = Math.max(0, numberInput(undefined, params.friction, 0.7));
    const restitution = Math.max(0, numberInput(undefined, params.restitution, 0.1));
    const mass = numberInput(inputs.mass, params.mass, 1);
    const force = asVector3(inputs.force, new THREE.Vector3());
    const hasForce = force.lengthSq() > 1e-12;
    const kinematicTarget = inputs.target instanceof THREE.Vector3 ? inputs.target : null;

    const touchedInstances = new Set<THREE.InstancedMesh>();

    for (const entry of state.entries) {
      const { body } = entry;

      body.setLinearDamping(linearDamping);
      body.setAngularDamping(angularDamping);
      body.setGravityScale(gravityScale, true);
      body.enableCcd(ccd);

      const collider = body.collider(0);
      if (collider) {
        collider.setFriction(friction);
        collider.setRestitution(restitution);
      }

      if (isDynamic) {
        if (mass > 0) body.setAdditionalMass(mass, true);
        if (hasForce) body.addForce({ x: force.x, y: force.y, z: force.z }, true);
      }

      if (bodyType === "kinematic" && kinematicTarget) {
        body.setNextKinematicTranslation({
          x: kinematicTarget.x,
          y: kinematicTarget.y,
          z: kinematicTarget.z,
        });
      }

      // The solver owns the pose now: write it back rather than letting the
      // graph's own transform fight it.
      const matrix = bodyMatrix(body, undefined, entry.scale);
      if (entry.instanceIndex >= 0) {
        const instanced = entry.mesh as THREE.InstancedMesh;
        // The instance matrix is relative to its InstancedMesh, and the solver
        // works in world space.
        const toLocal = worldMatrixOf(instanced, _parentWorld).invert();
        instanced.setMatrixAt(entry.instanceIndex, toLocal.multiply(matrix));
        touchedInstances.add(instanced);
      } else {
        // The solver works in world space and `matrix` is a *local* one. A mesh
        // wired straight into this node has no parent transform and the two are
        // the same, which is why this went unnoticed — but Merge and Array both
        // wrap their children in transformed Groups, and there the world matrix
        // written as a local one collapses everything toward the origin.
        const parent = entry.mesh.parent;
        if (parent) {
          _parentInverse.copy(worldMatrixOf(parent, _parentWorld)).invert().multiply(matrix);
        } else {
          _parentInverse.copy(matrix);
        }

        entry.mesh.matrixAutoUpdate = false;
        entry.mesh.matrix.copy(_parentInverse);
        _parentInverse.decompose(entry.mesh.position, entry.mesh.quaternion, entry.mesh.scale);
        entry.mesh.matrixWorldNeedsUpdate = true;
      }
    }

    for (const instanced of touchedInstances) {
      instanced.instanceMatrix.needsUpdate = true;
      // The instances no longer sit where they were authored, so the bounds
      // computed from those positions would cull them at the wrong moment.
      instanced.frustumCulled = false;
    }

    const first = state.entries[0]?.body;
    const velocity = first ? bodyVelocity(first) : new THREE.Vector3();

    return {
      geometry: object,
      matrix: first ? bodyMatrix(first, undefined, state.entries[0]?.scale) : (object ? object.matrix.clone() : new THREE.Matrix4()),
      position: first ? bodyPosition(first) : (object ? object.position.clone() : new THREE.Vector3()),
      velocity,
      speed: velocity.length(),
      count: state.entries.length,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Character                                                                  */
/* -------------------------------------------------------------------------- */

interface CharacterState {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  controller: RAPIER.KinematicCharacterController;
  worldNodeId: string;
  generation: number;
  signature: string;
  velocity: THREE.Vector3;
  grounded: boolean;
  lastTime?: number;
  epoch?: number;
}

const characterCache = createNodeCache<CharacterState>();

/**
 * Character (Physics) — a capsule that walks the physics world.
 *
 * The sibling of `physics/capsule-controller`, and the one to reach for once a
 * Physics World is in the graph. Both are kinematic — a character wants exact
 * control, not momentum — but this one is moved by Rapier's own character
 * controller, which brings the three things a hand-rolled sweep does not get
 * for free:
 *
 * - **Auto-step.** Stairs and kerbs are climbed instead of blocking, without
 *   the author modelling invisible ramps over every step.
 * - **Snap to ground.** Walking down a slope keeps contact instead of
 *   launching into a little arc at every break in the surface.
 * - **Impulses to dynamic bodies.** The character can shove crates around,
 *   which is the whole point of having a solver in the scene.
 *
 * It collides against everything in the world, so its level is whatever
 * `physics/rigid-body` nodes have been added — no separate collider input to
 * keep in sync with what is on screen.
 */
export const PHYSICS_CHARACTER_NODE: NodeDefinition = {
  type: "physics/character",
  label: "Character (Physics)",
  category: "physics",
  inputs: [
    { id: "world", label: "World", type: "any" },
    { id: "move", label: "Move (XZ)", type: "vector" },
    { id: "jump", label: "Jump", type: "value" },
    { id: "walkSpeed", label: "Walk Speed", type: "value" },
    { id: "time", label: "Time", type: "value" },
    { id: "reset", label: "Reset", type: "value" },
  ],
  outputs: [
    { id: "position", label: "Position", type: "vector" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "grounded", label: "Grounded", type: "value" },
    { id: "velocity", label: "Velocity", type: "vector" },
    { id: "speed", label: "Speed", type: "value" },
  ],
  defaultParams: {
    startPosition: new THREE.Vector3(0, 2, 0),
    radius: 0.35,
    height: 1.8,
    walkSpeed: 5,
    acceleration: 40,
    friction: 12,
    airControl: 0.3,
    gravity: 22,
    jumpSpeed: 7,
    maxSlope: THREE.MathUtils.degToRad(50),
    minSlideSlope: THREE.MathUtils.degToRad(40),
    autostep: 0.35,
    autostepMinWidth: 0.15,
    autostepDynamic: true,
    snapToGround: 0.3,
    pushBodies: true,
    characterMass: 80,
    offset: 0.02,
    respawnBelow: -50,
    jump: 0,
    reset: 0,
  },
  paramFields: [
    { id: "startPosition", label: "Start Position", kind: "vector" },
    { id: "radius", label: "Capsule Radius", kind: "number", step: 0.05, group: "Body" },
    { id: "height", label: "Capsule Height", kind: "number", step: 0.1, group: "Body" },
    { id: "offset", label: "Skin Offset", kind: "number", step: 0.005, group: "Body" },
    { id: "walkSpeed", label: "Walk Speed (units/s)", kind: "number", step: 0.5, group: "Movement" },
    { id: "acceleration", label: "Acceleration", kind: "number", step: 1, group: "Movement" },
    { id: "friction", label: "Ground Friction", kind: "number", step: 0.5, group: "Movement" },
    { id: "airControl", label: "Air Control (0–1)", kind: "number", step: 0.05, group: "Movement" },
    { id: "gravity", label: "Gravity", kind: "number", step: 0.5, group: "Jump & Gravity" },
    { id: "jumpSpeed", label: "Jump Speed", kind: "number", step: 0.5, group: "Jump & Gravity" },
    { id: "maxSlope", label: "Max Slope (°)", kind: "number", step: 1, degrees: true, group: "Jump & Gravity" },
    {
      id: "minSlideSlope",
      label: "Slide Above (°)",
      kind: "number",
      step: 1,
      degrees: true,
      group: "Jump & Gravity",
    },
    { id: "autostep", label: "Auto-step Height (0 = off)", kind: "number", step: 0.05, group: "Stairs & Ground" },
    { id: "autostepMinWidth", label: "Auto-step Min Width", kind: "number", step: 0.05, group: "Stairs & Ground" },
    { id: "autostepDynamic", label: "Step onto Dynamic Bodies", kind: "boolean", group: "Stairs & Ground" },
    { id: "snapToGround", label: "Snap to Ground (0 = off)", kind: "number", step: 0.05, group: "Stairs & Ground" },
    { id: "pushBodies", label: "Push Dynamic Bodies", kind: "boolean", group: "Interaction" },
    { id: "characterMass", label: "Character Mass (for pushing)", kind: "number", step: 5, group: "Interaction" },
    { id: "respawnBelow", label: "Respawn Below Y", kind: "number", step: 1, group: "Solver" },
  ],
  evaluate: (inputs, params, ctx) => {
    const handle = isPhysicsWorld(inputs.world) ? inputs.world : null;
    const api = getRapier();
    const start = asVector3(params.startPosition, new THREE.Vector3(0, 2, 0));

    if (!handle || !api) {
      return {
        position: start.clone(),
        matrix: new THREE.Matrix4().setPosition(start),
        grounded: 0,
        velocity: new THREE.Vector3(),
        speed: 0,
      };
    }

    const radius = Math.max(0.01, numberInput(undefined, params.radius, 0.35));
    const height = Math.max(2 * radius + 0.01, numberInput(undefined, params.height, 1.8));
    const offset = Math.max(0.001, numberInput(undefined, params.offset, 0.02));
    const signature = `${radius}|${height}|${offset}|${handle.generation}`;

    let state = characterCache.get(ctx.nodeId);

    if (!state || state.signature !== signature || state.worldNodeId !== handle.nodeId) {
      if (state && state.worldNodeId === handle.nodeId && state.generation === handle.generation) {
        handle.world.removeCharacterController(state.controller);
        handle.world.removeRigidBody(state.body);
      }

      const desc = api.RigidBodyDesc.kinematicPositionBased().setTranslation(start.x, start.y, start.z);
      const body = handle.world.createRigidBody(desc);
      // Rapier's capsule half-height excludes the caps, same as everywhere else.
      const collider = handle.world.createCollider(
        api.ColliderDesc.capsule(Math.max(0.001, height / 2 - radius), radius),
        body,
      );
      const controller = handle.world.createCharacterController(offset);
      controller.setUp({ x: 0, y: 1, z: 0 });

      state = {
        body,
        collider,
        controller,
        worldNodeId: handle.nodeId,
        generation: handle.generation,
        signature,
        velocity: new THREE.Vector3(),
        grounded: false,
      };
      characterCache.set(ctx.nodeId, state);
    }

    const { body, collider, controller } = state;

    controller.setMaxSlopeClimbAngle(numberInput(undefined, params.maxSlope, THREE.MathUtils.degToRad(50)));
    controller.setMinSlopeSlideAngle(numberInput(undefined, params.minSlideSlope, THREE.MathUtils.degToRad(40)));
    controller.setApplyImpulsesToDynamicBodies(Boolean(params.pushBodies ?? true));
    controller.setCharacterMass(Math.max(0, numberInput(undefined, params.characterMass, 80)));

    const autostep = Math.max(0, numberInput(undefined, params.autostep, 0.35));
    if (autostep > 0) {
      controller.enableAutostep(
        autostep,
        Math.max(0, numberInput(undefined, params.autostepMinWidth, 0.15)),
        Boolean(params.autostepDynamic ?? true),
      );
    } else {
      controller.disableAutostep();
    }

    const snap = Math.max(0, numberInput(undefined, params.snapToGround, 0.3));
    if (snap > 0) controller.enableSnapToGround(snap);
    else controller.disableSnapToGround();

    const epoch = ctx.simulationEpoch ?? 0;
    const staleEpoch = state.epoch !== undefined && state.epoch !== epoch;
    state.epoch = epoch;

    const time = clockInput(inputs, params, ctx);
    const rewound = state.lastTime !== undefined && time < state.lastTime - REWIND_THRESHOLD;
    const first = state.lastTime === undefined;
    // Clamped for the same reason as everywhere else: one long stall must not
    // become one enormous step.
    const dt = first || rewound ? 0 : Math.min(0.1, Math.max(0, time - state.lastTime!));
    state.lastTime = time;

    const resetting = Number(inputs.reset !== undefined ? inputs.reset : params.reset) > 0.5;

    if (first || rewound || staleEpoch || resetting) {
      body.setNextKinematicTranslation({ x: start.x, y: start.y, z: start.z });
      body.setTranslation({ x: start.x, y: start.y, z: start.z }, true);
      state.velocity.set(0, 0, 0);
      state.grounded = false;
    } else if (dt > 0) {
      const walkSpeed = Math.max(0, numberInput(inputs.walkSpeed, params.walkSpeed, 5));
      const control = state.grounded ? 1 : THREE.MathUtils.clamp(numberInput(undefined, params.airControl, 0.3), 0, 1);

      const move = asVector3(inputs.move, new THREE.Vector3());
      const target = new THREE.Vector3(move.x, 0, move.z);
      if (target.lengthSq() > 1) target.normalize();
      target.multiplyScalar(walkSpeed);

      if (target.lengthSq() > 1e-8) {
        accelerateHorizontal(
          state.velocity,
          target,
          Math.max(0, numberInput(undefined, params.acceleration, 40)) * control,
          dt,
        );
      } else if (state.grounded) {
        applyFriction(state.velocity, Math.max(0, numberInput(undefined, params.friction, 12)), dt);
      }

      const jumping = Number(inputs.jump !== undefined ? inputs.jump : params.jump) > 0.5;
      if (jumping && state.grounded) {
        state.velocity.y = numberInput(undefined, params.jumpSpeed, 7);
        state.grounded = false;
      }

      state.velocity.y -= numberInput(undefined, params.gravity, 22) * dt;

      const desired = state.velocity.clone().multiplyScalar(dt);
      controller.computeColliderMovement(collider, { x: desired.x, y: desired.y, z: desired.z });

      const corrected = controller.computedMovement();
      state.grounded = controller.computedGrounded();

      const current = body.translation();
      const next = {
        x: current.x + corrected.x,
        y: current.y + corrected.y,
        z: current.z + corrected.z,
      };
      body.setNextKinematicTranslation(next);
      // Kinematic bodies only adopt their next translation when the world
      // steps; setting it directly keeps the graph's readings in step with the
      // controller rather than a frame behind it.
      body.setTranslation(next, true);

      // Resting on the floor still accumulates gravity frame after frame; left
      // alone, stepping off a ledge after standing still would launch the
      // character at terminal velocity.
      if (state.grounded && state.velocity.y < 0) state.velocity.y = 0;

      const floor = numberInput(undefined, params.respawnBelow, -50);
      if (next.y < floor) {
        body.setTranslation({ x: start.x, y: start.y, z: start.z }, true);
        state.velocity.set(0, 0, 0);
      }
    }

    const position = bodyPosition(body);
    return {
      position,
      matrix: new THREE.Matrix4().setPosition(position),
      grounded: state.grounded ? 1 : 0,
      velocity: state.velocity.clone(),
      speed: Math.hypot(state.velocity.x, state.velocity.z),
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Vehicle                                                                    */
/* -------------------------------------------------------------------------- */

interface VehicleState {
  body: RAPIER.RigidBody;
  controller: RAPIER.DynamicRayCastVehicleController;
  worldNodeId: string;
  generation: number;
  signature: string;
  object: THREE.Object3D;
  scale: THREE.Vector3;
}

const vehicleCache = createNodeCache<VehicleState>();

/** Front wheels steer, rear wheels drive — the arrangement almost every car uses. */
const WHEEL_LAYOUT = [
  { front: true, side: -1 },
  { front: true, side: 1 },
  { front: false, side: -1 },
  { front: false, side: 1 },
] as const;

/**
 * Vehicle — a four-wheeled car on Rapier's raycast vehicle controller.
 *
 * Not four rigid-body wheels with joints: a raycast vehicle casts a ray down
 * from each wheel mount and applies suspension, drive and side friction forces
 * to the chassis from the hit. That is how nearly every driving game does it,
 * because simulated wheels jitter at rest, catch on seams between triangles,
 * and need a solver tolerance nobody wants to tune. Here the chassis is one
 * rigid body and the wheels are maths.
 *
 * The wheels come out as a list of matrices rather than as meshes, so the look
 * of the car is the author's business — wire them into a Spawn or Set Instance
 * Transform with whatever geometry the scene wants. They already carry
 * steering angle and rolling rotation.
 *
 * Rapier does not advance a vehicle inside `world.step()`, so the node leaves a
 * closure on the world that runs immediately before each fixed step. A node
 * evaluating once per frame could not otherwise keep up with a frame that runs
 * three steps.
 */
export const VEHICLE_NODE: NodeDefinition = {
  type: "physics/vehicle",
  label: "Vehicle",
  category: "physics",
  inputs: [
    { id: "world", label: "World", type: "any" },
    { id: "chassis", label: "Chassis", type: "geometry", owns: true },
    { id: "throttle", label: "Throttle (-1…1)", type: "value" },
    { id: "steer", label: "Steer (-1 left … 1 right)", type: "value" },
    { id: "brake", label: "Brake (0…1)", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "position", label: "Position", type: "vector" },
    { id: "wheels", label: "Wheel Matrices", type: "list" },
    { id: "speed", label: "Speed", type: "value" },
    { id: "grounded", label: "Wheels on Ground", type: "value" },
  ],
  defaultParams: {
    mass: 800,
    centerOfMass: -0.3,
    wheelRadius: 0.35,
    wheelBase: 1.3,
    trackWidth: 0.8,
    wheelHeight: -0.25,
    suspensionRest: 0.35,
    suspensionStiffness: 30,
    suspensionCompression: 0.85,
    suspensionRelaxation: 0.9,
    suspensionTravel: 0.25,
    frictionSlip: 3.5,
    engineForce: 2500,
    brakeForce: 900,
    maxSteer: THREE.MathUtils.degToRad(32),
    throttle: 0,
    steer: 0,
    brake: 0,
  },
  paramFields: [
    { id: "mass", label: "Chassis Mass (kg)", kind: "number", step: 25, group: "Chassis" },
    {
      id: "centerOfMass",
      label: "Centre of Mass Height (lower = more stable)",
      kind: "number",
      step: 0.05,
      group: "Chassis",
    },
    { id: "engineForce", label: "Engine Force", kind: "number", step: 100, group: "Drive" },
    { id: "brakeForce", label: "Brake Force", kind: "number", step: 50, group: "Drive" },
    { id: "maxSteer", label: "Max Steering (°)", kind: "number", step: 1, degrees: true, group: "Drive" },
    { id: "wheelRadius", label: "Wheel Radius", kind: "number", step: 0.05, group: "Wheels" },
    { id: "wheelBase", label: "Wheelbase (front to rear)", kind: "number", step: 0.1, group: "Wheels" },
    { id: "trackWidth", label: "Track Width (left to right)", kind: "number", step: 0.1, group: "Wheels" },
    { id: "wheelHeight", label: "Mount Height (chassis-relative)", kind: "number", step: 0.05, group: "Wheels" },
    { id: "frictionSlip", label: "Tyre Grip", kind: "number", step: 0.1, group: "Wheels" },
    { id: "suspensionRest", label: "Suspension Rest Length", kind: "number", step: 0.05, group: "Suspension" },
    { id: "suspensionStiffness", label: "Stiffness", kind: "number", step: 1, group: "Suspension" },
    { id: "suspensionCompression", label: "Compression Damping", kind: "number", step: 0.05, group: "Suspension" },
    { id: "suspensionRelaxation", label: "Relaxation Damping", kind: "number", step: 0.05, group: "Suspension" },
    { id: "suspensionTravel", label: "Max Travel", kind: "number", step: 0.05, group: "Suspension" },
  ],
  evaluate: (inputs, params, ctx) => {
    const object = inputs.chassis instanceof THREE.Object3D ? inputs.chassis : null;
    const handle = isPhysicsWorld(inputs.world) ? inputs.world : null;
    const api = getRapier();

    if (!object || !handle || !api) {
      return {
        geometry: object,
        matrix: object ? object.matrix.clone() : new THREE.Matrix4(),
        position: object ? object.position.clone() : new THREE.Vector3(),
        wheels: [],
        speed: 0,
        grounded: 0,
      };
    }

    const wheelRadius = Math.max(0.02, numberInput(undefined, params.wheelRadius, 0.35));
    const wheelBase = Math.max(0.1, numberInput(undefined, params.wheelBase, 1.3));
    const trackWidth = Math.max(0.1, numberInput(undefined, params.trackWidth, 0.8));
    const mountHeight = numberInput(undefined, params.wheelHeight, -0.25);
    const suspensionRest = Math.max(0.01, numberInput(undefined, params.suspensionRest, 0.35));

    const signature = `${wheelRadius}|${wheelBase}|${trackWidth}|${mountHeight}|${suspensionRest}|${numberInput(undefined, params.mass, 800)}|${numberInput(undefined, params.centerOfMass, -0.3)}|${handle.generation}`;

    let state = vehicleCache.get(ctx.nodeId);

    if (!state || state.signature !== signature || state.worldNodeId !== handle.nodeId) {
      if (state && state.worldNodeId === handle.nodeId && state.generation === handle.generation) {
        handle.preStep.delete(ctx.nodeId);
        handle.world.removeVehicleController(state.controller);
        handle.world.removeRigidBody(state.body);
      }

      const geometry = extractColliderGeometry(object);
      if (!geometry) {
        return {
          geometry: object,
          matrix: object.matrix.clone(),
          position: object.position.clone(),
          wheels: [],
          speed: 0,
          grounded: 0,
        };
      }

      object.updateWorldMatrix(true, false);
      const start = new THREE.Vector3();
      const rotation = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      object.matrixWorld.decompose(start, rotation, scale);

      const body = handle.world.createRigidBody(
        api.RigidBodyDesc.dynamic()
          .setTranslation(start.x, start.y, start.z)
          .setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w })
          // A car that can flip is a car that spends the session on its roof;
          // damping keeps it settled without pinning its rotation outright.
          .setAngularDamping(0.6)
          .setLinearDamping(0.05),
      );

      const colliderDesc = buildColliderDesc(api, "hull", geometry);
      if (colliderDesc) {
        // Mass lives on the body, not the collider, so the centre of mass can
        // be moved independently of the shape — see below.
        colliderDesc.setMass(0);
        handle.world.createCollider(colliderDesc, body);
      }

      // A car's centre of mass sits low, and a raycast vehicle is *very*
      // sensitive to it: leave it at the chassis centre and hard acceleration
      // pitches the car back onto two wheels, which then have no grip. Inertia
      // is the box equivalent of the chassis bounds, which is close enough for
      // something whose handling is tuned by feel anyway.
      const mass = Math.max(1, numberInput(undefined, params.mass, 800));
      const extents = geometry.box.getSize(new THREE.Vector3());
      const inertia = new THREE.Vector3(
        (mass / 12) * (extents.y * extents.y + extents.z * extents.z),
        (mass / 12) * (extents.x * extents.x + extents.z * extents.z),
        (mass / 12) * (extents.x * extents.x + extents.y * extents.y),
      );
      body.setAdditionalMassProperties(
        mass,
        { x: 0, y: numberInput(undefined, params.centerOfMass, -0.3), z: 0 },
        { x: inertia.x, y: inertia.y, z: inertia.z },
        { x: 0, y: 0, z: 0, w: 1 },
        true,
      );

      const controller = handle.world.createVehicleController(body);
      for (const wheel of WHEEL_LAYOUT) {
        controller.addWheel(
          { x: wheel.side * (trackWidth / 2), y: mountHeight, z: wheel.front ? wheelBase / 2 : -wheelBase / 2 },
          { x: 0, y: -1, z: 0 }, // suspension points down
          { x: -1, y: 0, z: 0 }, // wheels turn about the chassis X axis
          suspensionRest,
          wheelRadius,
        );
      }

      // Rapier steps vehicles separately from bodies; this is what keeps the
      // two in phase however many steps a frame runs.
      handle.preStep.set(ctx.nodeId, (dt) => controller.updateVehicle(dt));

      state = {
        body,
        controller,
        worldNodeId: handle.nodeId,
        generation: handle.generation,
        signature,
        object,
        scale,
      };
      vehicleCache.set(ctx.nodeId, state);
    }

    const { body, controller } = state;

    const throttle = THREE.MathUtils.clamp(numberInput(inputs.throttle, params.throttle, 0), -1, 1);
    const steer = THREE.MathUtils.clamp(numberInput(inputs.steer, params.steer, 0), -1, 1);
    const brake = Math.max(0, numberInput(inputs.brake, params.brake, 0));

    const engineForce = throttle * Math.max(0, numberInput(undefined, params.engineForce, 4500));
    const brakeForce = brake * Math.max(0, numberInput(undefined, params.brakeForce, 900));
    // Negated so that positive Steer turns right, which is what "steer right"
    // has to mean for a Move Input's X axis to drop in without an inverter.
    const steerAngle = -steer * numberInput(undefined, params.maxSteer, THREE.MathUtils.degToRad(32));

    const stiffness = Math.max(0, numberInput(undefined, params.suspensionStiffness, 30));
    const compression = Math.max(0, numberInput(undefined, params.suspensionCompression, 0.85));
    const relaxation = Math.max(0, numberInput(undefined, params.suspensionRelaxation, 0.9));
    const travel = Math.max(0, numberInput(undefined, params.suspensionTravel, 0.25));
    const grip = Math.max(0, numberInput(undefined, params.frictionSlip, 3.5));

    let wheelsOnGround = 0;
    for (let i = 0; i < WHEEL_LAYOUT.length; i++) {
      const wheel = WHEEL_LAYOUT[i];
      // Rear-wheel drive, front-wheel steering.
      controller.setWheelEngineForce(i, wheel.front ? 0 : engineForce);
      controller.setWheelSteering(i, wheel.front ? steerAngle : 0);
      controller.setWheelBrake(i, brakeForce);
      controller.setWheelSuspensionStiffness(i, stiffness);
      controller.setWheelSuspensionCompression(i, compression);
      controller.setWheelSuspensionRelaxation(i, relaxation);
      controller.setWheelMaxSuspensionTravel(i, travel);
      controller.setWheelFrictionSlip(i, grip);
      if (controller.wheelIsInContact(i)) wheelsOnGround++;
    }

    const chassisMatrix = bodyMatrix(body, undefined, state.scale);
    object.matrixAutoUpdate = false;
    object.matrix.copy(chassisMatrix);
    chassisMatrix.decompose(object.position, object.quaternion, object.scale);
    object.matrixWorldNeedsUpdate = true;

    // Wheel poses, in world space and ready to hang geometry on: mount point,
    // pushed down by however far the suspension is currently extended, turned
    // by its steering angle and rolled by however far it has travelled.
    const wheels: THREE.Matrix4[] = [];
    for (let i = 0; i < WHEEL_LAYOUT.length; i++) {
      const connection = controller.wheelChassisConnectionPointCs(i);
      const suspension = controller.wheelSuspensionLength(i) ?? suspensionRest;
      const steering = controller.wheelSteering(i) ?? 0;
      const roll = controller.wheelRotation(i) ?? 0;
      if (!connection) continue;

      const local = new THREE.Matrix4()
        .makeTranslation(connection.x, connection.y - suspension, connection.z)
        .multiply(new THREE.Matrix4().makeRotationY(steering))
        .multiply(new THREE.Matrix4().makeRotationX(roll));

      wheels.push(new THREE.Matrix4().multiplyMatrices(chassisMatrix, local));
    }

    return {
      geometry: object,
      matrix: chassisMatrix.clone(),
      position: bodyPosition(body),
      wheels,
      speed: Math.abs(controller.currentVehicleSpeed()),
      grounded: wheelsOnGround,
    };
  },
};
