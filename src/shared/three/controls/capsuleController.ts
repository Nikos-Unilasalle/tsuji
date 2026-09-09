import * as THREE from "three";
import { ExtendedTriangle } from "three-mesh-bvh";
import type { MeshBVH } from "three-mesh-bvh";
import { getBoundsTree, initBvhRaycast } from "../bvh";

/**
 * A kinematic capsule character: the thing that turns a movement vector into
 * a body that stands on the floor, slides along walls and climbs steps.
 *
 * Kinematic rather than rigid-body on purpose. A physics engine would give
 * momentum and joints for free, at the cost of a solver whose result is only
 * loosely controllable — and character movement is the one case where the
 * author wants *exact* control: this speed, this jump height, no bouncing off
 * a wall, no tipping over. Every game that ships a rigid-body character ends up
 * fighting it back into behaving kinematically. So the body is moved directly
 * and collisions are resolved by pushing it back out of whatever it entered.
 *
 * The maths that decides how it *feels* — acceleration, friction, what counts
 * as a walkable slope, how a velocity slides along a surface — is pure and
 * lives at the top of this file, testable without a scene. The BVH sweep below
 * is the only part that needs geometry, and it needs no renderer either, so it
 * is testable too.
 */

export interface CapsuleParams {
  /** Radius of the capsule, and of both its caps. */
  radius: number;
  /** Total height including the caps, so a 1.8 m character is 1.8 here. */
  height: number;
  /** Top speed on the ground, in units per second. */
  walkSpeed: number;
  /** How fast the character reaches walk speed, in units per second squared. */
  acceleration: number;
  /** Ground friction as a per-second rate constant — not a per-frame multiplier. */
  friction: number;
  gravity: number;
  /** Take-off speed of a jump, in units per second. */
  jumpSpeed: number;
  /** Steepest slope that still counts as ground, in radians. */
  maxSlope: number;
  /** How much control the character keeps in the air, 0–1. */
  airControl: number;
  /** Depenetration passes per frame. More is more robust in tight corners. */
  iterations: number;
}

export const DEFAULT_CAPSULE_PARAMS: CapsuleParams = {
  radius: 0.35,
  height: 1.8,
  walkSpeed: 5,
  acceleration: 40,
  friction: 12,
  gravity: 22,
  jumpSpeed: 7,
  maxSlope: THREE.MathUtils.degToRad(50),
  airControl: 0.3,
  iterations: 4,
};

export interface CapsuleMotionState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  grounded: boolean;
  groundNormal: THREE.Vector3;
}

export function createCapsuleState(position = new THREE.Vector3()): CapsuleMotionState {
  return {
    position: position.clone(),
    velocity: new THREE.Vector3(),
    grounded: false,
    groundNormal: new THREE.Vector3(0, 1, 0),
  };
}

/* -------------------------------------------------------------------------- */
/* The feel: pure, testable                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A surface counts as ground when it is no steeper than `maxSlope`.
 *
 * Comparing the normal's Y against the cosine of the angle rather than taking
 * an `acos` per contact: same test, no trigonometry in the inner loop.
 */
export function isWalkable(normal: THREE.Vector3, maxSlope: number): boolean {
  return normal.y >= Math.cos(Math.min(Math.PI / 2, Math.max(0, maxSlope)));
}

/**
 * Moves the horizontal velocity toward its target without overshooting it.
 *
 * Clamping to the remaining distance is what keeps acceleration framerate
 * independent at the top end: a large `dt` would otherwise sail past the
 * target and oscillate around it.
 */
export function accelerateHorizontal(
  velocity: THREE.Vector3,
  target: THREE.Vector3,
  acceleration: number,
  dt: number,
): THREE.Vector3 {
  const dx = target.x - velocity.x;
  const dz = target.z - velocity.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 1e-6) {
    velocity.x = target.x;
    velocity.z = target.z;
    return velocity;
  }

  const step = Math.min(distance, Math.max(0, acceleration) * Math.max(0, dt));
  velocity.x += (dx / distance) * step;
  velocity.z += (dz / distance) * step;
  return velocity;
}

/**
 * Exponential ground friction, expressed per second.
 *
 * Same reasoning as the Integrate node's damping and the Action Map's
 * smoothing: a per-frame multiplier makes a character slide further on a slow
 * machine than on a fast one.
 */
export function applyFriction(velocity: THREE.Vector3, friction: number, dt: number): THREE.Vector3 {
  if (friction <= 0 || dt <= 0) return velocity;
  const decay = Math.exp(-friction * dt);
  velocity.x *= decay;
  velocity.z *= decay;
  return velocity;
}

/**
 * Removes the part of a velocity that points into a surface, leaving the part
 * that slides along it.
 *
 * This is what stops a character dead against a wall while still letting them
 * walk along it — zeroing the whole velocity instead would make walls sticky,
 * and reflecting it would make them bouncy.
 */
export function slideAlong(velocity: THREE.Vector3, normal: THREE.Vector3): THREE.Vector3 {
  const into = velocity.dot(normal);
  if (into >= 0) return velocity;
  return velocity.addScaledVector(normal, -into);
}

/* -------------------------------------------------------------------------- */
/* The collision sweep                                                        */
/* -------------------------------------------------------------------------- */

export interface CapsuleCollider {
  bvh: MeshBVH;
  /** Mesh → world. The capsule is taken into mesh space to be tested. */
  matrixWorld: THREE.Matrix4;
}

/**
 * Collects the colliders under an object, building each BVH once and reusing
 * it after — see `getBoundsTree`, which rebuilds only when vertices actually
 * changed.
 */
export function collectColliders(root: THREE.Object3D | null | undefined): CapsuleCollider[] {
  if (!root) return [];
  // `getBoundsTree` calls a prototype method that the BVH patch installs. The
  // viewport installs it on mount, but a headless evaluation never goes
  // through the viewport — and this is idempotent, so asking here costs a
  // boolean check and removes the ordering dependency.
  initBvhRaycast();
  const colliders: CapsuleCollider[] = [];

  root.updateWorldMatrix(true, true);
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.attributes?.position) return;
    if (mesh.visible === false) return;
    colliders.push({ bvh: getBoundsTree(mesh.geometry), matrixWorld: mesh.matrixWorld.clone() });
  });

  return colliders;
}

const _segment = new THREE.Line3();
const _box = new THREE.Box3();
const _localBox = new THREE.Box3();
const _triPoint = new THREE.Vector3();
const _capsulePoint = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _inverse = new THREE.Matrix4();
const _worldTriangle = new ExtendedTriangle();

export interface DepenetrationResult {
  /** How far the capsule had to be pushed to leave the geometry. */
  offset: THREE.Vector3;
  /** The most floor-like contact normal found, or null when nothing was touched. */
  normal: THREE.Vector3 | null;
}

/**
 * Pushes a capsule out of everything it is inside, and reports the most
 * upward-facing surface it touched.
 *
 * The capsule is reduced to a segment plus a radius, so "am I inside this
 * triangle" becomes "is the closest point on this triangle nearer than the
 * radius" — one closest-point query per candidate triangle, and the BVH means
 * only the triangles near the capsule are ever candidates.
 *
 * **The test runs in world space, with each candidate triangle brought to it.**
 * The tempting alternative — taking the capsule into the mesh's local space,
 * one transform instead of three per triangle — silently breaks on any collider
 * with a non-uniform scale, which in this engine is *most* of them: an
 * `object/box` floor is a unit cube scaled 16 × 1 × 16 by its matrix. In that
 * space the capsule is no longer a capsule, there is no single radius that
 * describes it, and the character falls straight through the floor. Only the
 * bounds culling stays local, where being approximate is free.
 *
 * Contacts are resolved as they are found rather than accumulated and averaged:
 * moving the segment immediately means the next triangle is tested against the
 * position the capsule has already been pushed to, which is what stops two
 * walls in a corner from each pushing out of the other and cancelling.
 *
 * Known limit: "outwards" is read as the direction from the triangle to the
 * capsule's axis, so a capsule whose *centre* is already past a face resolves
 * the wrong way and is pushed further in. A character stepped forward frame by
 * frame never reaches that state — it is stopped at the face long before — but
 * teleporting one into a wall will not push it back out.
 */
export function depenetrateCapsule(
  colliders: CapsuleCollider[],
  position: THREE.Vector3,
  radius: number,
  height: number,
): DepenetrationResult {
  const half = Math.max(0, height / 2 - radius);
  // The segment runs between the two cap centres; everything within `radius`
  // of it is inside the capsule.
  _segment.start.set(position.x, position.y - half, position.z);
  _segment.end.set(position.x, position.y + half, position.z);

  const before = _segment.start.clone();
  let bestNormal: THREE.Vector3 | null = null;
  let bestY = -Infinity;

  for (const collider of colliders) {
    _inverse.copy(collider.matrixWorld).invert();

    // Cull in the mesh's own space, where the BVH's bounds live. Transforming
    // the capsule's world box and taking the result's AABB over-estimates the
    // region, which for a rejection test is the safe direction to be wrong in.
    _box.makeEmpty();
    _box.expandByPoint(_segment.start);
    _box.expandByPoint(_segment.end);
    _box.min.addScalar(-radius);
    _box.max.addScalar(radius);
    _localBox.copy(_box).applyMatrix4(_inverse);

    collider.bvh.shapecast({
      intersectsBounds: (bounds) => bounds.intersectsBox(_localBox),
      intersectsTriangle: (tri: ExtendedTriangle) => {
        _worldTriangle.copy(tri);
        _worldTriangle.a.applyMatrix4(collider.matrixWorld);
        _worldTriangle.b.applyMatrix4(collider.matrixWorld);
        _worldTriangle.c.applyMatrix4(collider.matrixWorld);
        _worldTriangle.needsUpdate = true;

        const distance = _worldTriangle.closestPointToSegment(_segment, _triPoint, _capsulePoint);
        if (distance >= radius) return false;

        const depth = radius - distance;
        _delta.copy(_capsulePoint).sub(_triPoint);
        // Exactly on the surface gives a zero-length direction; the triangle's
        // own normal is the only sensible way out.
        if (_delta.lengthSq() < 1e-12) {
          _worldTriangle.getNormal(_delta);
        }
        _delta.normalize();

        _segment.start.addScaledVector(_delta, depth);
        _segment.end.addScaledVector(_delta, depth);

        if (_delta.y > bestY) {
          bestY = _delta.y;
          bestNormal = _delta.clone();
        }
        return false;
      },
    });
  }

  return { offset: _segment.start.clone().sub(before), normal: bestNormal };
}

/* -------------------------------------------------------------------------- */
/* One frame                                                                  */
/* -------------------------------------------------------------------------- */

export interface CapsuleInput {
  /** Desired movement on the ground plane. Length 0–1; longer is clamped. */
  move: THREE.Vector3;
  jump: boolean;
}

const _target = new THREE.Vector3();

/**
 * Advances the character one frame: intent, gravity, move, then push back out.
 *
 * Order matters. Moving first and resolving after is what makes this robust at
 * any speed — the alternative, testing before moving, has to guess how far it
 * is safe to go and gets it wrong exactly when the frame is long.
 */
export function stepCapsule(
  state: CapsuleMotionState,
  input: CapsuleInput,
  colliders: CapsuleCollider[],
  params: CapsuleParams,
  dt: number,
): CapsuleMotionState {
  if (dt <= 0) return state;

  const control = state.grounded ? 1 : THREE.MathUtils.clamp(params.airControl, 0, 1);

  _target.set(input.move.x, 0, input.move.z);
  // Clamped rather than normalised: a half-pushed stick should walk at half
  // speed, and only a fully pushed one at walk speed.
  if (_target.lengthSq() > 1) _target.normalize();
  _target.multiplyScalar(params.walkSpeed);

  if (_target.lengthSq() > 1e-8) {
    accelerateHorizontal(state.velocity, _target, params.acceleration * control, dt);
  } else if (state.grounded) {
    applyFriction(state.velocity, params.friction, dt);
  }

  if (input.jump && state.grounded) {
    state.velocity.y = params.jumpSpeed;
    state.grounded = false;
  }

  state.velocity.y -= params.gravity * dt;
  state.position.addScaledVector(state.velocity, dt);

  let grounded = false;
  const groundNormal = new THREE.Vector3(0, 1, 0);

  const iterations = Math.max(1, Math.floor(params.iterations));
  for (let i = 0; i < iterations; i++) {
    const { offset, normal } = depenetrateCapsule(colliders, state.position, params.radius, params.height);
    if (offset.lengthSq() < 1e-12) break;

    state.position.add(offset);

    if (normal) {
      if (isWalkable(normal, params.maxSlope)) {
        grounded = true;
        groundNormal.copy(normal);
      }
      slideAlong(state.velocity, normal);
    }
  }

  state.grounded = grounded;
  state.groundNormal.copy(groundNormal);

  // Resting on the floor still accumulates downward velocity frame after
  // frame; left alone, stepping off a ledge after standing still for a minute
  // would launch the character at terminal velocity.
  if (grounded && state.velocity.y < 0) state.velocity.y = 0;

  return state;
}
