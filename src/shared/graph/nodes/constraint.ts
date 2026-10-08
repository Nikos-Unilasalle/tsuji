import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { NodeDefinition, ParamFieldDef } from "../types";
import { createNodeCache } from "../nodeCaches";
import { numberInput } from "./object";
import { asVector3 } from "./transform";
import { isSimulating } from "./rapier";
import {
  JOINT_KINDS,
  JointGroup,
  JointKind,
  JointSpec,
  MOTOR_MODES,
  MotorMode,
  UnitSettings,
  applyUnitSettings,
  bodyId,
  createAnchorBody,
  createJoint,
  isPivotKind,
  isUnitKind,
  jointCoordinate,
} from "../../three/physics/rapierJoints";
import {
  PhysicsWorldHandle,
  getRapier,
  isPhysicsBodies,
  isPhysicsWorld,
  isRapierReady,
} from "../../three/physics/rapierRuntime";

/* -------------------------------------------------------------------------- */
/* Pairing: which bodies a Constraint joins to which                          */
/* -------------------------------------------------------------------------- */

export const PAIRINGS = ["single", "pairwise", "sequence", "each-to-one"] as const;
export type Pairing = (typeof PAIRINGS)[number];

function asPairing(value: unknown): Pairing {
  return (PAIRINGS as readonly string[]).includes(value as string) ? (value as Pairing) : "single";
}

function asKind(value: unknown): JointKind {
  return (JOINT_KINDS as readonly string[]).includes(value as string) ? (value as JointKind) : "hinge";
}

function asMotor(value: unknown): MotorMode {
  return (MOTOR_MODES as readonly string[]).includes(value as string) ? (value as MotorMode) : "off";
}

/** One joint to make. A null end is the world. */
interface Pair {
  a: RAPIER.RigidBody | null;
  b: RAPIER.RigidBody | null;
}

/** An index into a list, where negative counts from the end (-1 is the last). */
export function resolveIndex(index: number, length: number): number | null {
  if (length <= 0) return null;
  const i = Math.floor(index);
  const resolved = i < 0 ? length + i : i;
  return resolved >= 0 && resolved < length ? resolved : null;
}

/**
 * Lists of bodies -> the pairs to join.
 *
 *  - **single**: one body of A to one body of B (picked by Index A / Index B).
 *  - **pairwise**: A[i] to B[i], as far as both go.
 *  - **sequence**: A[i] to A[i+1] — a row of planks, a string of beads.
 *  - **each-to-one**: every body of A to the one body of B at Index B (or to
 *    the world when B is unwired) — twenty crates all hinged to one wall.
 *
 * An unwired side is `null`, which means the world; both unwired is no pair.
 */
export function makePairs(
  mode: Pairing,
  a: RAPIER.RigidBody[] | null,
  b: RAPIER.RigidBody[] | null,
  indexA: number,
  indexB: number,
): Pair[] {
  const pick = (list: RAPIER.RigidBody[] | null, index: number): { body: RAPIER.RigidBody | null; ok: boolean } => {
    if (!list) return { body: null, ok: true };
    const i = resolveIndex(index, list.length);
    return i === null ? { body: null, ok: false } : { body: list[i], ok: true };
  };

  switch (mode) {
    case "single": {
      const ka = pick(a, indexA);
      const kb = pick(b, indexB);
      if (!ka.ok || !kb.ok || (!ka.body && !kb.body)) return [];
      return [{ a: ka.body, b: kb.body }];
    }
    case "pairwise": {
      if (!a || !b) return [];
      const n = Math.min(a.length, b.length);
      return Array.from({ length: n }, (_, i) => ({ a: a[i], b: b[i] }));
    }
    case "sequence": {
      const list = a ?? b;
      if (!list) return [];
      return list.slice(0, -1).map((body, i) => ({ a: body, b: list[i + 1] }));
    }
    case "each-to-one": {
      if (!a) return [];
      const kb = pick(b, indexB);
      if (!kb.ok) return [];
      return a.map((body) => ({ a: body, b: kb.body }));
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The node                                                                   */
/* -------------------------------------------------------------------------- */

interface ConstraintState {
  group: JointGroup;
  /** Everything that, changed, means a different set of joints. */
  signature: string;
  /** The same minus the knobs that should not undo what a spring has learned about its rest length. */
  layout: string;
  lengths: number[];
}

const constraintCache = createNodeCache<ConstraintState>((state) => state.group.dispose());

function release(nodeId: string) {
  const state = constraintCache.get(nodeId);
  if (!state) return;
  state.group.dispose();
  constraintCache.delete(nodeId);
}

/** The bodies behind a socket, or null if it carries nothing usable from *this* world. */
function bodiesFrom(value: unknown, handle: PhysicsWorldHandle): RAPIER.RigidBody[] | null {
  if (!isPhysicsBodies(value) || value.world !== handle) return null;
  const live = value.bodies.filter((body) => body.isValid());
  return live.length > 0 ? live : null;
}

function centerOf(body: RAPIER.RigidBody, target: THREE.Vector3): THREE.Vector3 {
  const t = body.translation();
  return target.set(t.x, t.y, t.z);
}

/** A body-local offset as a world point. */
function offsetPoint(body: RAPIER.RigidBody | null, offset: THREE.Vector3): THREE.Vector3 {
  if (!body) return offset.clone();
  const r = body.rotation();
  return offset.clone().applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w)).add(centerOf(body, new THREE.Vector3()));
}

function vecKey(v: THREE.Vector3): string {
  return `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
}

/**
 * Constraint — a joint between two bodies, or between a body and the world.
 *
 * One node, six kinds, because they are the same job (take two bodies, remove
 * some of their freedom) and a palette of six near-identical nodes would hide
 * that:
 *
 *  - **Hinge** — turns about one axis: a door, a wheel, a lid. Optional angle
 *    limits and a motor.
 *  - **Fixed** — welds them. With a Break Force, debris that holds until hit.
 *  - **Ball** — free to swivel about a point: a pendulum, a shoulder.
 *  - **Slider** — slides along one axis: a piston, a drawer. Limits, motor.
 *  - **Spring** — pulls two points toward a rest distance, with damping.
 *  - **Rope** — keeps two points no further apart than a length; slack is free.
 *
 * Wire **Body** from a Rigid Body (or a Chain) into A and B. Leave one
 * unwired and that end is the world. A Rigid Body with many bodies behind it
 * (a Merge, an Array) gives this node many bodies to choose among — see
 * Pairing.
 *
 * The joint is **latched to the poses the bodies have when it is made**: that
 * is its rest state, angle 0 and offset 0, whatever the bodies' orientation.
 * Anchor, axis and the kind itself are therefore read at creation; changing
 * one rebuilds the joint (re-latching where the bodies are by then). Limits,
 * motor and Break Force are live.
 *
 * Nothing is built while the editor is idle — the joints appear when Play
 * starts, with the bodies, and go with them.
 */
export const CONSTRAINT_NODE: NodeDefinition = {
  type: "physics/constraint",
  label: "Constraint",
  category: "physics",
  inputs: [
    { id: "world", label: "World", type: "any" },
    { id: "bodyA", label: "Body A", type: "any" },
    { id: "bodyB", label: "Body B", type: "any" },
    { id: "anchor", label: "Anchor (world point)", type: "vector" },
    { id: "axis", label: "Axis", type: "vector" },
    { id: "offsetA", label: "Offset A", type: "vector" },
    { id: "offsetB", label: "Offset B", type: "vector" },
    { id: "target", label: "Motor Target", type: "value" },
  ],
  outputs: [
    { id: "position", label: "Angle / Distance", type: "value" },
    { id: "stress", label: "Stress (N)", type: "value" },
    { id: "broken", label: "Broken", type: "value" },
    { id: "count", label: "Joint Count", type: "value" },
  ],
  defaultParams: {
    jointType: "hinge",
    pairing: "single",
    indexA: 0,
    indexB: 0,
    anchor: new THREE.Vector3(0, 0, 0),
    axis: new THREE.Vector3(0, 1, 0),
    offsetA: new THREE.Vector3(0, 0, 0),
    offsetB: new THREE.Vector3(0, 0, 0),
    collideConnected: false,
    limits: false,
    angleMin: -Math.PI / 2,
    angleMax: Math.PI / 2,
    distanceMin: -1,
    distanceMax: 1,
    motor: "off",
    target: 0,
    motorStiffness: 200,
    motorDamping: 20,
    motorMaxForce: 0,
    restLength: 0,
    stiffness: 60,
    damping: 4,
    ropeLength: 0,
    breakForce: 0,
  },
  paramFields: [],
  dynamicParamFields: (instance) => constraintFields(asKind(instance.params.jointType)),
  evaluate: (inputs, params, ctx) => {
    const idle = (): Record<string, unknown> => ({ position: 0, stress: 0, broken: 0, count: 0 });
    const handle = isPhysicsWorld(inputs.world) ? inputs.world : null;
    const api = getRapier();

    if (!handle || !api || !isRapierReady() || !isSimulating(ctx)) {
      release(ctx.nodeId);
      return idle();
    }

    const wired = (id: string) => (ctx.connectedInputs ? ctx.connectedInputs.has(id) : inputs[id] !== undefined);
    const listA = bodiesFrom(inputs.bodyA, handle);
    const listB = bodiesFrom(inputs.bodyB, handle);
    // Wired but not (yet) delivering bodies: wait, rather than quietly
    // pinning that end to the world.
    if ((wired("bodyA") && !listA) || (wired("bodyB") && !listB)) {
      release(ctx.nodeId);
      return idle();
    }

    const kind = asKind(params.jointType);
    const pairing = asPairing(params.pairing);
    const indexA = numberInput(undefined, params.indexA, 0);
    const indexB = numberInput(undefined, params.indexB, 0);
    const pairs = makePairs(pairing, listA, listB, indexA, indexB);
    if (pairs.length === 0) {
      release(ctx.nodeId);
      return idle();
    }

    const anchor = asVector3(inputs.anchor, asVector3(params.anchor, new THREE.Vector3()));
    const axis = asVector3(inputs.axis, asVector3(params.axis, new THREE.Vector3(0, 1, 0)));
    const offsetA = asVector3(inputs.offsetA, asVector3(params.offsetA, new THREE.Vector3()));
    const offsetB = asVector3(inputs.offsetB, asVector3(params.offsetB, new THREE.Vector3()));
    const collideConnected = Boolean(params.collideConnected);
    const limits = Boolean(params.limits);
    const stiffness = Math.max(0, numberInput(undefined, params.stiffness, 60));
    const damping = Math.max(0, numberInput(undefined, params.damping, 4));
    const restLength = Math.max(0, numberInput(undefined, params.restLength, 0));
    const ropeLength = Math.max(0, numberInput(undefined, params.ropeLength, 0));

    const layout = [
      kind,
      pairing,
      handle.generation,
      pairs.map((p) => `${p.a ? bodyId(p.a) : "w"}-${p.b ? bodyId(p.b) : "w"}`).join(","),
      isPivotKind(kind) ? vecKey(anchor) : `${vecKey(offsetA)}/${vecKey(offsetB)}`,
      isUnitKind(kind) ? vecKey(axis) : "",
      collideConnected ? "c" : "",
      // Whether limits and a motor exist at all is fixed at creation; where the
      // limits sit and what the motor aims at is live.
      limits ? "l" : "",
      isUnitKind(kind) && asMotor(params.motor) !== "off" ? "m" : "",
    ].join("|");
    const signature = `${layout}|${kind === "spring" ? `${stiffness},${damping},${restLength}` : ""}|${kind === "rope" ? ropeLength : ""}`;

    let state = constraintCache.get(ctx.nodeId);
    if (!state || state.signature !== signature || state.group.handle !== handle) {
      // A spring rebuilt only because its stiffness was dragged keeps the rest
      // length it was made with; one rebuilt because the layout changed
      // measures afresh.
      const keepLengths = state && state.layout === layout && state.group.handle === handle ? state.lengths : null;
      release(ctx.nodeId);
      state = buildJoints({
        api,
        handle,
        nodeId: ctx.nodeId,
        kind,
        pairing,
        pairs,
        anchor,
        axis,
        offsetA,
        offsetB,
        stiffness,
        damping,
        restLength: restLength > 0 ? restLength : ropeLength,
        keepLengths,
        collideConnected,
        signature,
        layout,
      });
      constraintCache.set(ctx.nodeId, state);
    }

    const { group } = state;
    group.breakForce = Math.max(0, numberInput(undefined, params.breakForce, 0));

    if (isUnitKind(kind)) {
      const hinge = kind === "hinge";
      const settings: UnitSettings = {
        limits,
        min: hinge ? numberInput(undefined, params.angleMin, -Math.PI / 2) : numberInput(undefined, params.distanceMin, -1),
        max: hinge ? numberInput(undefined, params.angleMax, Math.PI / 2) : numberInput(undefined, params.distanceMax, 1),
        motor: asMotor(params.motor),
        target: numberInput(inputs.target, params.target, 0),
        stiffness: Math.max(0, numberInput(undefined, params.motorStiffness, 200)),
        damping: Math.max(0, numberInput(undefined, params.motorDamping, 20)),
        maxForce: Math.max(0, numberInput(undefined, params.motorMaxForce, 0)),
      };
      for (const record of group.records) applyUnitSettings(record, settings);
    }

    const first = group.records.find((record) => !record.broken) ?? group.records[0];
    return {
      position: first ? jointCoordinate(first) : 0,
      stress: group.takePeak(),
      broken: group.brokenCount,
      count: group.records.length - group.brokenCount,
    };
  },
};

interface BuildArgs {
  api: NonNullable<ReturnType<typeof getRapier>>;
  handle: PhysicsWorldHandle;
  nodeId: string;
  kind: JointKind;
  pairing: Pairing;
  pairs: Pair[];
  anchor: THREE.Vector3;
  axis: THREE.Vector3;
  offsetA: THREE.Vector3;
  offsetB: THREE.Vector3;
  stiffness: number;
  damping: number;
  restLength: number;
  keepLengths: number[] | null;
  collideConnected: boolean;
  signature: string;
  layout: string;
}

function buildJoints(args: BuildArgs): ConstraintState {
  const { api, handle, kind, pairing, pairs } = args;
  const group = new JointGroup(handle, `__joints:${args.nodeId}`);
  const lengths: number[] = [];
  const mid = new THREE.Vector3();

  pairs.forEach((pair, i) => {
    let anchorA: THREE.Vector3;
    let anchorB: THREE.Vector3;
    if (isPivotKind(kind)) {
      // One shared point. Alone, it is the Anchor; among many it is the
      // Anchor as an offset from where the pair naturally meets — midway
      // between them, or at A when they all join one thing.
      if (pairing === "single") {
        anchorA = args.anchor.clone();
      } else {
        const ca = pair.a ? centerOf(pair.a, new THREE.Vector3()) : null;
        const cb = pair.b ? centerOf(pair.b, new THREE.Vector3()) : null;
        if (ca && cb && pairing !== "each-to-one") mid.copy(ca).add(cb).multiplyScalar(0.5);
        else mid.copy(ca ?? cb ?? mid.set(0, 0, 0));
        anchorA = mid.clone().add(args.anchor);
      }
      anchorB = anchorA;
    } else {
      anchorA = offsetPoint(pair.a, args.offsetA);
      anchorB = offsetPoint(pair.b, args.offsetB);
    }

    // An unwired end is a fixed, collider-less body standing at the anchor.
    const a = pair.a ?? createAnchor(api, handle, group, anchorA);
    const b = pair.b ?? createAnchor(api, handle, group, anchorB);

    const spec: JointSpec = {
      kind,
      anchorA,
      anchorB,
      axis: args.axis,
      length: args.keepLengths?.[i] ?? args.restLength,
      stiffness: args.stiffness,
      damping: args.damping,
      collideConnected: args.collideConnected,
    };
    try {
      const { joint, length } = createJoint(api, handle.world, a, b, spec);
      lengths.push(length);
      group.add({ joint, a, b, kind, broken: false, length });
    } catch (err) {
      console.error("physics/constraint: failed to create a joint", err);
    }
  });

  return { group, signature: args.signature, layout: args.layout, lengths };
}

function createAnchor(
  api: BuildArgs["api"],
  handle: PhysicsWorldHandle,
  group: JointGroup,
  at: THREE.Vector3,
): RAPIER.RigidBody {
  const body = createAnchorBody(api, handle.world, at);
  group.anchorBodies.push(body);
  return body;
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                      */
/* -------------------------------------------------------------------------- */

function constraintFields(kind: JointKind): ParamFieldDef[] {
  const fields: ParamFieldDef[] = [
    {
      id: "jointType",
      label: "Kind",
      kind: "select",
      options: [...JOINT_KINDS],
      optionLabels: ["Hinge", "Fixed", "Ball", "Slider", "Spring", "Rope"],
    },
    {
      id: "pairing",
      label: "Pairing",
      kind: "select",
      options: [...PAIRINGS],
      optionLabels: ["Single", "Pairwise (A[i] ↔ B[i])", "Sequence (A[i] ↔ A[i+1])", "Each of A to one of B"],
    },
    { id: "indexA", label: "Index A (-1 = last)", kind: "number", step: 1 },
    { id: "indexB", label: "Index B (-1 = last)", kind: "number", step: 1 },
    {
      id: "pairNote",
      label:
        "An unwired Body is the world. A Rigid Body with many bodies behind it (a Merge, an Array) offers them in " +
        "order — Index picks one, the other pairings join many at once, with the anchor placed midway between each pair.",
      kind: "note",
    },
  ];

  if (isPivotKind(kind)) {
    fields.push({ id: "anchor", label: "Anchor (world point)", kind: "vector", step: 0.1, group: "Joint" });
  } else {
    fields.push(
      { id: "offsetA", label: "Offset on A (in A's frame)", kind: "vector", step: 0.1, group: "Joint" },
      { id: "offsetB", label: "Offset on B (in B's frame)", kind: "vector", step: 0.1, group: "Joint" },
    );
  }
  if (isUnitKind(kind)) fields.push({ id: "axis", label: "Axis (world)", kind: "vector", step: 0.1, group: "Joint" });
  fields.push({ id: "collideConnected", label: "Collide Connected Bodies", kind: "boolean", group: "Joint" });

  if (isUnitKind(kind)) {
    fields.push({ id: "limits", label: "Limits", kind: "boolean", group: "Limits" });
    if (kind === "hinge") {
      fields.push(
        { id: "angleMin", label: "Min Angle", kind: "number", step: 1, degrees: true, group: "Limits" },
        { id: "angleMax", label: "Max Angle", kind: "number", step: 1, degrees: true, group: "Limits" },
      );
    } else {
      fields.push(
        { id: "distanceMin", label: "Min Distance", kind: "number", step: 0.05, group: "Limits" },
        { id: "distanceMax", label: "Max Distance", kind: "number", step: 0.05, group: "Limits" },
      );
    }
    fields.push(
      { id: "motor", label: "Motor", kind: "select", options: [...MOTOR_MODES], group: "Motor" },
      {
        id: "target",
        label: kind === "hinge" ? "Target (velocity rad/s, or angle rad)" : "Target (velocity m/s, or distance m)",
        kind: "number",
        step: 0.1,
        group: "Motor",
      },
      { id: "motorStiffness", label: "Stiffness (position mode)", kind: "number", step: 10, group: "Motor" },
      { id: "motorDamping", label: "Damping / Strength", kind: "number", step: 1, group: "Motor" },
      { id: "motorMaxForce", label: "Max Force (0 = unlimited)", kind: "number", step: 10, group: "Motor" },
    );
  }

  if (kind === "spring") {
    fields.push(
      { id: "restLength", label: "Rest Length (0 = as placed)", kind: "number", step: 0.05, group: "Spring" },
      { id: "stiffness", label: "Stiffness", kind: "number", step: 1, group: "Spring" },
      { id: "damping", label: "Damping", kind: "number", step: 0.5, group: "Spring" },
    );
  }
  if (kind === "rope") {
    fields.push({ id: "ropeLength", label: "Length (0 = as placed)", kind: "number", step: 0.05, group: "Rope" });
  }

  fields.push(
    { id: "breakForce", label: "Break Force (N, 0 = unbreakable)", kind: "number", step: 10, group: "Breaking" },
    {
      id: "breakNote",
      label:
        "Stress is estimated from how hard the bodies it joins are being accelerated, contacts included. " +
        "A load hanging from one joint reads its tension; a link inside a chain reads the force on the link.",
      kind: "note",
      group: "Breaking",
    },
  );
  return fields;
}
