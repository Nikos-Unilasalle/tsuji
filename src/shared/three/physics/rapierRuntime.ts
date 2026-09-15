import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { worldMatrixOf } from "../../graph/objectPosition";

/**
 * Rigid-body physics, on Rapier.
 *
 * The engine is a WASM module that has to be compiled before anything can be
 * built with it, and a graph evaluates synchronously sixty times a second — so
 * the two are joined by a promise started once and a `ready` flag the nodes
 * poll. Until it resolves, physics nodes pass their input through untouched
 * rather than throwing or blocking; the viewport re-evaluates every frame, so
 * the world simply starts a few frames late and nobody notices.
 *
 * The `-compat` build is deliberate: it inlines the WASM and initialises
 * asynchronously, which means no `vite-plugin-wasm`, no top-level await in the
 * bundle, and no separate asset to get lost on the way into a Tauri build.
 */

let rapier: typeof RAPIER | null = null;
let loading: Promise<typeof RAPIER> | null = null;

/** Starts (or joins) the one-time WASM init. Safe to call from anywhere, repeatedly. */
export function initRapier(): Promise<typeof RAPIER> {
  if (rapier) return Promise.resolve(rapier);
  if (!loading) {
    loading = import("@dimforge/rapier3d-compat").then(async (module) => {
      const api = module.default ?? (module as unknown as typeof RAPIER);
      await api.init();
      rapier = api;
      return api;
    });
  }
  return loading;
}

/** The engine, or null while it is still compiling. Nodes check this and degrade. */
export function getRapier(): typeof RAPIER | null {
  return rapier;
}

export function isRapierReady(): boolean {
  return rapier !== null;
}

/** Test seam — lets a test hand in an already-initialised module synchronously. */
export function setRapierForTesting(api: typeof RAPIER | null): void {
  rapier = api;
}

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

export const COLLIDER_SHAPES = ["auto", "box", "sphere", "capsule", "hull", "trimesh"] as const;
export type ColliderShape = (typeof COLLIDER_SHAPES)[number];

/**
 * Picks a shape when the author has not.
 *
 * A convex hull is the right default for a *dynamic* body: it is cheap, always
 * closed, and rolls and stacks predictably. A triangle mesh is the right
 * default for a *fixed* one: it is the only shape that can represent a level
 * exactly, and its cost — no volume, no inertia — only matters for something
 * that moves.
 */
export function resolveShape(shape: ColliderShape, isDynamic: boolean): Exclude<ColliderShape, "auto"> {
  if (shape !== "auto") return shape;
  return isDynamic ? "hull" : "trimesh";
}

/** The vertex/index data a collider needs, in the mesh's own space, scale baked in. */
export interface ColliderGeometry {
  vertices: Float32Array;
  indices: Uint32Array;
  box: THREE.Box3;
}

const _position = new THREE.Vector3();

/**
 * An object's world matrix, derived from the chain of *local* matrices rather
 * than read from `matrixWorld`.
 *
 * Nodes in this graph set `object.matrix` directly and leave
 * `matrixAutoUpdate` off; nothing guarantees anyone has refreshed
 * `matrixWorld` by the time a downstream node looks, and three's
 * `updateWorldMatrix` does not reliably reach a child that was re-parented
 * earlier in the same evaluation. Trusting the cached value put every body at
 * the origin and left a 24-unit floor with a 1-unit collider, so a scene
 * assembled through a Merge collapsed onto one spot and everything fell
 * through the ground.
 *
 * Re-exported rather than implemented here: this file used to carry its own
 * copy that skipped `updateMatrix()`, so the *other* half of the same bug
 * survived the fix above — an object still posed through `.position` rather
 * than a written `.matrix` reported the origin, and its body was built there.
 */
export { worldMatrixOf };

/**
 * Flattens an object's meshes into one vertex soup, in the object's own space
 * minus its translation and rotation — but **with its scale baked in**.
 *
 * The scale has to be baked because a Rapier body has none: it carries a
 * position and a rotation, and nothing else. Leaving the object's own scale out
 * turns a floor built as a unit cube scaled 30 × 1 × 30 — which is what every
 * `object/box` level is made of — into a 1 × 1 × 1 collider, and everything
 * lands beside it rather than on it.
 *
 * Translation and rotation are excluded for the opposite reason: those the body
 * *does* carry, and baking them in as well would apply them twice.
 */
export function extractColliderGeometry(object: THREE.Object3D): ColliderGeometry | null {
  const vertices: number[] = [];
  const indices: number[] = [];
  const box = new THREE.Box3();

  const translation = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const objectWorld = worldMatrixOf(object);
  objectWorld.decompose(translation, rotation, scale);

  const unscaled = new THREE.Matrix4().compose(translation, rotation, new THREE.Vector3(1, 1, 1));
  const toLocal = unscaled.invert();
  const transform = new THREE.Matrix4();
  const meshWorld = new THREE.Matrix4();

  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const attribute = mesh.geometry?.attributes?.position as THREE.BufferAttribute | undefined;
    if (!attribute) return;

    transform.multiplyMatrices(toLocal, worldMatrixOf(mesh, meshWorld));
    const offset = vertices.length / 3;

    for (let i = 0; i < attribute.count; i++) {
      _position.fromBufferAttribute(attribute, i).applyMatrix4(transform);
      vertices.push(_position.x, _position.y, _position.z);
      box.expandByPoint(_position);
    }

    const index = mesh.geometry.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i++) indices.push(offset + index.getX(i));
    } else {
      for (let i = 0; i < attribute.count; i++) indices.push(offset + i);
    }
  });

  if (vertices.length === 0) return null;
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices), box };
}

/**
 * The same geometry scaled about its own origin.
 *
 * Instances carry their scale in their matrix, and a Rapier collider has no
 * scale of its own — so a row of crates at different sizes needs one scaled
 * copy of the shape per distinct size, not one shared collider that fits none
 * of them.
 */
export function scaleColliderGeometry(geometry: ColliderGeometry, scale: THREE.Vector3): ColliderGeometry {
  if (Math.abs(scale.x - 1) < 1e-6 && Math.abs(scale.y - 1) < 1e-6 && Math.abs(scale.z - 1) < 1e-6) {
    return geometry;
  }

  const vertices = new Float32Array(geometry.vertices.length);
  for (let i = 0; i < geometry.vertices.length; i += 3) {
    vertices[i] = geometry.vertices[i] * scale.x;
    vertices[i + 1] = geometry.vertices[i + 1] * scale.y;
    vertices[i + 2] = geometry.vertices[i + 2] * scale.z;
  }

  const box = geometry.box.clone();
  box.min.multiply(scale);
  box.max.multiply(scale);
  // A negative scale flips min past max, which every downstream size query
  // then reads as a negative extent.
  const fixed = new THREE.Box3().setFromPoints([box.min, box.max]);

  return { vertices, indices: geometry.indices, box: fixed };
}

/**
 * Builds the collider description for a shape.
 *
 * Returns null when the geometry cannot support the requested shape — a
 * trimesh needs triangles, a hull needs enough points to enclose a volume —
 * so the caller can fall back rather than hand Rapier something it will
 * reject.
 */
export function buildColliderDesc(
  api: typeof RAPIER,
  shape: Exclude<ColliderShape, "auto">,
  geometry: ColliderGeometry,
): RAPIER.ColliderDesc | null {
  const size = geometry.box.getSize(new THREE.Vector3());
  const centre = geometry.box.getCenter(new THREE.Vector3());
  const half = size.clone().multiplyScalar(0.5);

  let desc: RAPIER.ColliderDesc | null = null;

  switch (shape) {
    case "box":
      desc = api.ColliderDesc.cuboid(Math.max(1e-4, half.x), Math.max(1e-4, half.y), Math.max(1e-4, half.z));
      break;
    case "sphere":
      desc = api.ColliderDesc.ball(Math.max(1e-4, Math.max(half.x, half.y, half.z)));
      break;
    case "capsule": {
      const radius = Math.max(1e-4, Math.max(half.x, half.z));
      // Rapier's capsule half-height excludes the caps, so a shape shorter
      // than its own diameter degenerates to a sphere rather than inverting.
      const halfHeight = Math.max(1e-4, half.y - radius);
      desc = api.ColliderDesc.capsule(halfHeight, radius);
      break;
    }
    case "hull":
      desc = api.ColliderDesc.convexHull(geometry.vertices);
      break;
    case "trimesh":
      desc = api.ColliderDesc.trimesh(geometry.vertices, geometry.indices);
      break;
  }

  if (!desc) return null;

  // Primitive shapes are built around the origin; the geometry may not be.
  if (shape === "box" || shape === "sphere" || shape === "capsule") {
    desc.setTranslation(centre.x, centre.y, centre.z);
  }

  return desc;
}

/* -------------------------------------------------------------------------- */
/* The world                                                                  */
/* -------------------------------------------------------------------------- */

export interface PhysicsWorldHandle {
  kind: "physics-world";
  /** Which node owns it, so a body can tell two worlds apart. */
  nodeId: string;
  world: RAPIER.World;
  bodies: Map<string, RAPIER.RigidBody>;
  /**
   * Callbacks run immediately before each fixed step, keyed by the node that
   * registered one.
   *
   * Rapier's vehicle controller is not advanced by `world.step()` — it has to
   * be updated just before it, every step, or the wheels never get a chance to
   * apply their forces. A node evaluating once per *frame* cannot do that
   * itself when the frame runs three steps, so it leaves a closure here
   * instead.
   */
  preStep: Map<string, (dt: number) => void>;
  /** Leftover time not yet consumed by a fixed step. */
  accumulator: number;
  lastTime: number | undefined;
  /** Bumped whenever the world is rebuilt, so bodies know to re-register. */
  generation: number;
  dispose: () => void;
}

export function isPhysicsWorld(value: unknown): value is PhysicsWorldHandle {
  return Boolean(value) && (value as PhysicsWorldHandle).kind === "physics-world";
}

export function createPhysicsWorld(
  api: typeof RAPIER,
  nodeId: string,
  gravity: THREE.Vector3,
  generation: number,
): PhysicsWorldHandle {
  const world = new api.World({ x: gravity.x, y: gravity.y, z: gravity.z });
  return {
    kind: "physics-world",
    nodeId,
    world,
    bodies: new Map(),
    preStep: new Map(),
    accumulator: 0,
    lastTime: undefined,
    generation,
    dispose: () => {
      world.free();
    },
  };
}

/**
 * How many fixed steps to run for the time that has passed.
 *
 * Physics is stepped at a fixed rate and the leftover is carried, rather than
 * stepped by the frame's own delta: a variable timestep makes a stack of boxes
 * settle differently at 60 and 144 fps, and makes an export disagree with the
 * preview it was authored in. The step count is capped so that one long stall
 * — a background tab, a shader compile — is dropped rather than simulated all
 * at once in a spiral the machine never catches up from.
 */
export function planSteps(
  accumulator: number,
  elapsed: number,
  timestep: number,
  maxSteps: number,
): { steps: number; remainder: number } {
  if (timestep <= 0) return { steps: 0, remainder: 0 };

  const budget = accumulator + Math.max(0, elapsed);
  const wanted = Math.floor(budget / timestep);
  const steps = Math.min(Math.max(0, maxSteps), wanted);

  // Time belonging to dropped steps is discarded, not banked: banking it would
  // guarantee the next frame is over budget too.
  const remainder = steps === wanted ? budget - steps * timestep : 0;
  return { steps, remainder };
}

/** Advances the world, returning how many fixed steps actually ran. */
export function stepPhysicsWorld(
  handle: PhysicsWorldHandle,
  time: number,
  timestep: number,
  maxSteps: number,
): number {
  const elapsed = handle.lastTime === undefined ? 0 : time - handle.lastTime;
  handle.lastTime = time;

  const { steps, remainder } = planSteps(handle.accumulator, elapsed, timestep, maxSteps);
  handle.accumulator = remainder;

  handle.world.timestep = timestep;
  for (let i = 0; i < steps; i++) {
    for (const before of handle.preStep.values()) before(timestep);
    handle.world.step();
  }
  return steps;
}

/* -------------------------------------------------------------------------- */
/* Reading a body back                                                        */
/* -------------------------------------------------------------------------- */

const _quaternion = new THREE.Quaternion();
const _translation = new THREE.Vector3();
const _unitScale = new THREE.Vector3(1, 1, 1);

/** Copies a body's pose into a matrix the graph can carry. */
export function bodyMatrix(
  body: RAPIER.RigidBody,
  target = new THREE.Matrix4(),
  scale: THREE.Vector3 = _unitScale,
): THREE.Matrix4 {
  const t = body.translation();
  const r = body.rotation();
  _translation.set(t.x, t.y, t.z);
  _quaternion.set(r.x, r.y, r.z, r.w);
  return target.compose(_translation, _quaternion, scale);
}

export function bodyPosition(body: RAPIER.RigidBody, target = new THREE.Vector3()): THREE.Vector3 {
  const t = body.translation();
  return target.set(t.x, t.y, t.z);
}

export function bodyVelocity(body: RAPIER.RigidBody, target = new THREE.Vector3()): THREE.Vector3 {
  const v = body.linvel();
  return target.set(v.x, v.y, v.z);
}
