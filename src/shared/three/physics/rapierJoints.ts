import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorldHandle } from "./rapierRuntime";

/**
 * Joints between Rapier bodies, and the bookkeeping that goes with them.
 *
 * Everything here is world-space in, body-space out: a joint is authored as
 * "hinge about this axis through this point" and Rapier wants "this anchor in
 * A's frame, that anchor in B's frame, with these two frames agreeing". Getting
 * from one to the other once, at creation, is most of the file.
 */

export const JOINT_KINDS = ["hinge", "fixed", "ball", "slider", "spring", "rope"] as const;
export type JointKind = (typeof JOINT_KINDS)[number];

/** Kinds joined at one shared point, as opposed to two ends with a distance between them. */
export function isPivotKind(kind: JointKind): boolean {
  return kind === "hinge" || kind === "fixed" || kind === "ball" || kind === "slider";
}

/** Kinds with one free coordinate (an angle, or a distance) that can be limited and driven by a motor. */
export function isUnitKind(kind: JointKind): boolean {
  return kind === "hinge" || kind === "slider";
}

export const MOTOR_MODES = ["off", "velocity", "position"] as const;
export type MotorMode = (typeof MOTOR_MODES)[number];

/** What a joint needs to know about itself, all in world space and decided at creation. */
export interface JointSpec {
  kind: JointKind;
  /** Where the joint attaches on body A and on body B. Equal for the pivot kinds. */
  anchorA: THREE.Vector3;
  anchorB: THREE.Vector3;
  /** Free axis of a hinge or slider. */
  axis: THREE.Vector3;
  /** Spring rest length / rope length; <= 0 means "as far apart as they are now". */
  length: number;
  stiffness: number;
  damping: number;
  collideConnected: boolean;
}

export interface JointRecord {
  joint: RAPIER.ImpulseJoint;
  a: RAPIER.RigidBody;
  b: RAPIER.RigidBody;
  kind: JointKind;
  broken: boolean;
  /** Resolved rest/rope length, so a rebuild with the same layout can keep it. */
  length: number;
}

const _qA = new THREE.Quaternion();
const _qB = new THREE.Quaternion();
const _v = new THREE.Vector3();

function quatOf(body: RAPIER.RigidBody, target: THREE.Quaternion): THREE.Quaternion {
  const r = body.rotation();
  return target.set(r.x, r.y, r.z, r.w);
}

/** A world point expressed in a body's own frame. */
function toLocal(body: RAPIER.RigidBody, point: THREE.Vector3, quat: THREE.Quaternion): RAPIER.Vector {
  const t = body.translation();
  _v.set(point.x - t.x, point.y - t.y, point.z - t.z).applyQuaternion(quat.clone().invert());
  return { x: _v.x, y: _v.y, z: _v.z };
}

/**
 * Builds one joint between two bodies, latched to the poses they have right
 * now — whatever relative position and orientation they are in when this runs
 * is the joint's rest state, with angle 0 and offset 0.
 *
 * The frames are set explicitly rather than left to Rapier's defaults. Handed
 * only an axis, Rapier builds the same frame on both bodies, which is only
 * right if they happen to be oriented alike: with B rotated relative to A the
 * joint would spend its first step wrenching the two into line (and a hinge's
 * zero angle would sit wherever the arbitrary perpendicular happened to fall,
 * which is what a limit is measured from).
 */
export function createJoint(
  api: typeof RAPIER,
  world: RAPIER.World,
  a: RAPIER.RigidBody,
  b: RAPIER.RigidBody,
  spec: JointSpec,
): { joint: RAPIER.ImpulseJoint; length: number } {
  quatOf(a, _qA);
  quatOf(b, _qB);
  const localA = toLocal(a, spec.anchorA, _qA);
  const localB = toLocal(b, spec.anchorB, _qB);
  const axis = spec.axis.lengthSq() > 1e-12 ? spec.axis.clone().normalize() : new THREE.Vector3(0, 1, 0);
  const axisA = axis.clone().applyQuaternion(_qA.clone().invert());
  const axisAVec = { x: axisA.x, y: axisA.y, z: axisA.z };
  // Rotation of A's frame as seen from B, which makes the two frames coincide in the world.
  const relative = _qB.clone().invert().multiply(_qA);
  const relativeRot = { x: relative.x, y: relative.y, z: relative.z, w: relative.w };

  let length = 0;
  let data: RAPIER.JointData;
  switch (spec.kind) {
    case "fixed":
      data = api.JointData.fixed(localA, { x: 0, y: 0, z: 0, w: 1 }, localB, relativeRot);
      break;
    case "ball":
      data = api.JointData.spherical(localA, localB);
      break;
    case "hinge":
      data = api.JointData.revolute(localA, localB, axisAVec);
      break;
    case "slider":
      data = api.JointData.prismatic(localA, localB, axisAVec);
      break;
    case "spring":
    case "rope": {
      const apart = spec.anchorA.distanceTo(spec.anchorB);
      length = spec.length > 0 ? spec.length : apart;
      data =
        spec.kind === "spring"
          ? api.JointData.spring(length, spec.stiffness, spec.damping, localA, localB)
          : api.JointData.rope(length, localA, localB);
      break;
    }
  }

  const joint = world.createImpulseJoint(data, a, b, true);
  if (spec.kind === "hinge" || spec.kind === "slider") {
    // Same X-aligned frame on both ends to start with; turn B's to match where
    // B actually is relative to A.
    const f1 = joint.frameX1();
    const f1q = new THREE.Quaternion(f1.x, f1.y, f1.z, f1.w);
    const f2 = _qB.clone().invert().multiply(_qA).multiply(f1q);
    joint.setLocalFrame2(localB, { x: f2.x, y: f2.y, z: f2.z, w: f2.w });
  }
  joint.setContactsEnabled(spec.collideConnected);
  return { joint, length };
}

/** The joint's free coordinate: an angle (rad) for a hinge, a distance for a slider, the length of a spring or rope; 0 otherwise. */
export function jointCoordinate(record: JointRecord): number {
  const { joint, a, b, kind } = record;
  if (kind === "hinge") {
    const f1 = joint.frameX1();
    const f2 = joint.frameX2();
    const q1 = quatOf(a, new THREE.Quaternion()).multiply(new THREE.Quaternion(f1.x, f1.y, f1.z, f1.w));
    const q2 = quatOf(b, new THREE.Quaternion()).multiply(new THREE.Quaternion(f2.x, f2.y, f2.z, f2.w));
    const rel = q1.invert().multiply(q2);
    // Hemisphere fix so a long way round does not read as a short way back.
    const sign = rel.w < 0 ? -1 : 1;
    let angle = 2 * Math.atan2(sign * rel.x, sign * rel.w);
    if (angle > Math.PI) angle -= 2 * Math.PI;
    return angle;
  }
  if (kind === "slider" || kind === "spring" || kind === "rope") {
    const p1 = worldAnchor(a, joint.anchor1());
    const p2 = worldAnchor(b, joint.anchor2());
    if (kind !== "slider") return p1.distanceTo(p2);
    const f1 = joint.frameX1();
    const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(
      quatOf(a, new THREE.Quaternion()).multiply(new THREE.Quaternion(f1.x, f1.y, f1.z, f1.w)),
    );
    return p2.sub(p1).dot(axis);
  }
  return 0;
}

function worldAnchor(body: RAPIER.RigidBody, local: RAPIER.Vector): THREE.Vector3 {
  const t = body.translation();
  return new THREE.Vector3(local.x, local.y, local.z).applyQuaternion(quatOf(body, new THREE.Quaternion())).add(new THREE.Vector3(t.x, t.y, t.z));
}

/** Limits and motor of a hinge or slider; the other kinds have neither. */
export interface UnitSettings {
  limits: boolean;
  min: number;
  max: number;
  motor: MotorMode;
  target: number;
  stiffness: number;
  damping: number;
  maxForce: number;
}

export function applyUnitSettings(record: JointRecord, s: UnitSettings): void {
  if (!isUnitKind(record.kind) || record.broken) return;
  const joint = record.joint as RAPIER.UnitImpulseJoint;
  if (s.limits) joint.setLimits(Math.min(s.min, s.max), Math.max(s.min, s.max));

  if (s.motor === "velocity") {
    joint.configureMotorVelocity(s.target, s.damping);
  } else if (s.motor === "position") {
    joint.configureMotorPosition(s.target, s.stiffness, s.damping);
  }
  // No motor means no call at all: a motor configured to zero is not "no
  // motor" — it holds the joint at zero velocity and measurably brakes a free
  // hinge. Switching one off therefore rebuilds the joint (see the layout key
  // in constraint.ts) rather than trying to zero it.
  if (s.motor !== "off" && s.maxForce > 0) joint.setMotorMaxForce(s.maxForce);
  if (s.motor !== "off") {
    record.a.wakeUp();
    record.b.wakeUp();
  }
}

/* -------------------------------------------------------------------------- */
/* A set of joints owned by one node                                          */
/* -------------------------------------------------------------------------- */

/**
 * The joints (and the invisible world-anchor bodies) one node made, with the
 * after-step hook that measures how hard each is being pulled and snaps the
 * ones pulled past their break force.
 *
 * ## What "stress" is
 *
 * Rapier 0.20 does not hand back a joint's impulse, so this is an estimate
 * from the bodies it joins: the force a body needs to have received to move as
 * it did — mass × (acceleration − gravity) — measured each fixed step from the
 * change in velocity. For a load hanging from one joint that is the tension
 * exactly. It also counts contacts and *other* joints on the same body, so a
 * link in the middle of a chain reports the force on the link rather than the
 * tension through it. It is a good break trigger and a good thing to wire into
 * a colour; it is not a strain gauge.
 */
export class JointGroup {
  readonly records: JointRecord[] = [];
  /** Fixed bodies standing in for "the world" at an unwired end. */
  readonly anchorBodies: RAPIER.RigidBody[] = [];
  /** Highest stress seen in any step since it was last read. */
  peak = 0;
  /** Newtons; <= 0 means unbreakable. */
  breakForce = 0;
  private readonly previous = new Map<number, THREE.Vector3>();
  private installed = false;

  constructor(
    readonly handle: PhysicsWorldHandle,
    readonly key: string,
  ) {}

  /** Adds a joint and starts tracking the velocity of the bodies it joins. */
  add(record: JointRecord): void {
    this.records.push(record);
    for (const body of [record.a, record.b]) {
      if (!this.previous.has(body.handle)) this.previous.set(body.handle, linvel(body));
    }
    this.install();
  }

  private install(): void {
    if (this.installed) return;
    this.installed = true;
    this.handle.postStep ??= new Map();
    this.handle.postStep.set(this.key, () => this.measure());
  }

  get brokenCount(): number {
    let n = 0;
    for (const record of this.records) if (record.broken) n++;
    return n;
  }

  /** Reads and clears the peak. */
  takePeak(): number {
    const peak = this.peak;
    this.peak = 0;
    return peak;
  }

  private measure(): void {
    const world = this.handle.world;
    const dt = world.timestep;
    if (!(dt > 0)) return;
    const g = world.gravity;

    // One force per body per step, shared by every joint on it.
    const force = new Map<number, number>();
    for (const [handle, before] of this.previous) {
      const body = world.getRigidBody(handle);
      if (!body || !body.isValid()) continue;
      const now = linvel(body);
      if (body.isDynamic()) {
        const gs = body.gravityScale();
        const m = body.mass();
        force.set(
          handle,
          m *
            Math.hypot(
              (now.x - before.x) / dt - g.x * gs,
              (now.y - before.y) / dt - g.y * gs,
              (now.z - before.z) / dt - g.z * gs,
            ),
        );
      } else {
        force.set(handle, 0);
      }
      this.previous.set(handle, now);
    }

    for (const record of this.records) {
      if (record.broken) continue;
      const stress = Math.max(force.get(record.a.handle) ?? 0, force.get(record.b.handle) ?? 0);
      if (stress > this.peak) this.peak = stress;
      if (this.breakForce > 0 && stress > this.breakForce) this.snap(record);
    }
  }

  private snap(record: JointRecord): void {
    record.broken = true;
    try {
      if (record.joint.isValid()) this.handle.world.removeImpulseJoint(record.joint, true);
    } catch {
      // Already gone with one of its bodies.
    }
  }

  /** Removes every joint and anchor body, unless the world they lived in is already gone. */
  dispose(): void {
    this.handle.postStep?.delete(this.key);
    this.installed = false;
    if (this.handle.disposed) return;
    const world = this.handle.world;
    for (const record of this.records) {
      try {
        if (!record.broken && record.joint.isValid()) world.removeImpulseJoint(record.joint, true);
      } catch {
        // Its bodies were removed first, which removes the joint with them.
      }
    }
    for (const body of this.anchorBodies) {
      try {
        if (body.isValid()) world.removeRigidBody(body);
      } catch {
        // Same.
      }
    }
    this.records.length = 0;
    this.anchorBodies.length = 0;
    this.previous.clear();
  }
}

function linvel(body: RAPIER.RigidBody): THREE.Vector3 {
  const v = body.linvel();
  return new THREE.Vector3(v.x, v.y, v.z);
}

/** A fixed, collider-less body at a point: the "world" end of a joint. */
export function createAnchorBody(api: typeof RAPIER, world: RAPIER.World, at: THREE.Vector3): RAPIER.RigidBody {
  return world.createRigidBody(api.RigidBodyDesc.fixed().setTranslation(at.x, at.y, at.z));
}

/** Stable small integers for bodies, so a joint layout can be compared as a string. */
const bodyIds = new WeakMap<object, number>();
let nextBodyId = 1;
export function bodyId(body: RAPIER.RigidBody): number {
  let id = bodyIds.get(body);
  if (id === undefined) {
    id = nextBodyId++;
    bodyIds.set(body, id);
  }
  return id;
}
