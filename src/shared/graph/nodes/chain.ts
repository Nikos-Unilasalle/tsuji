import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { numberInput } from "./object";
import { asVector3 } from "./transform";
import { isSimulating } from "./rapier";
import {
  JointGroup,
  JointKind,
  bodyId,
  createAnchorBody,
  createJoint,
} from "../../three/physics/rapierJoints";
import {
  PhysicsBodiesHandle,
  PhysicsWorldHandle,
  getRapier,
  isPhysicsBodies,
  isPhysicsWorld,
  isRapierReady,
} from "../../three/physics/rapierRuntime";

export const CHAIN_LINK_SHAPES = ["capsule", "box"] as const;
export type ChainLinkShape = (typeof CHAIN_LINK_SHAPES)[number];
export const CHAIN_JOINTS = ["ball", "hinge"] as const;
export type ChainJoint = (typeof CHAIN_JOINTS)[number];

function asShape(value: unknown): ChainLinkShape {
  return (CHAIN_LINK_SHAPES as readonly string[]).includes(value as string) ? (value as ChainLinkShape) : "capsule";
}

function asJoint(value: unknown): ChainJoint {
  return (CHAIN_JOINTS as readonly string[]).includes(value as string) ? (value as ChainJoint) : "ball";
}

/**
 * Collision groups for a chain's links: they belong to group 15 and do not
 * collide with it, but collide with everything else (whose default groups are
 * "all of them"). A chain therefore never fights itself over the overlap at
 * its joints, nor another chain — and still lands on the floor.
 */
const LINK_GROUPS = ((0x8000 << 16) | 0x7fff) >>> 0;

/** One link as laid out before anything simulates it: a segment between two of the chain's points. */
export interface LinkLayout {
  center: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
}

/**
 * Segments between consecutive points, as links.
 *
 * A link's local Y runs from its start point to its end point. Its local X is
 * `across` made perpendicular to that — the width of a plank, and the axis a
 * hinge chain folds about — and where `across` is parallel to the segment (or
 * not given) any perpendicular will do.
 *
 * Segments shorter than a hair are dropped: a zero-length capsule has no
 * direction to orient by, and Rapier has no use for one.
 */
export function layoutLinks(points: readonly THREE.Vector3[], across: THREE.Vector3 | null): LinkLayout[] {
  const links: LinkLayout[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const delta = points[i + 1].clone().sub(points[i]);
    const length = delta.length();
    if (length < 1e-4) continue;
    const y = delta.divideScalar(length);

    let x = across ? across.clone().addScaledVector(y, -across.dot(y)) : new THREE.Vector3();
    if (x.lengthSq() < 1e-8) {
      // Anything not parallel to y.
      x = Math.abs(y.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
      x.addScaledVector(y, -x.dot(y));
    }
    x.normalize();
    const z = new THREE.Vector3().crossVectors(x, y);
    const quaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    links.push({ center: points[i].clone().add(points[i + 1]).multiplyScalar(0.5), quaternion, length });
  }
  return links;
}

/** The points a chain runs through: a wired list, else a wired curve cut into `links` pieces, else a straight line. */
export function chainPoints(
  list: unknown,
  curve: unknown,
  links: number,
  start: THREE.Vector3,
  end: THREE.Vector3,
): THREE.Vector3[] {
  if (Array.isArray(list)) {
    const unset = new THREE.Vector3(NaN, NaN, NaN);
    const points = list.map((p) => asVector3(p, unset)).filter((p) => p !== unset);
    if (points.length >= 2) return points.map((p) => p.clone());
  }
  const n = Math.max(1, Math.min(400, Math.floor(links)));
  if (curve && typeof (curve as THREE.Curve<THREE.Vector3>).getSpacedPoints === "function") {
    return (curve as THREE.Curve<THREE.Vector3>).getSpacedPoints(n).map((p) => p.clone());
  }
  return Array.from({ length: n + 1 }, (_, i) => start.clone().lerp(end, i / n));
}

interface ChainState {
  group: JointGroup;
  bodies: RAPIER.RigidBody[];
  links: LinkLayout[];
  handle: PhysicsBodiesHandle;
  signature: string;
}

const chainCache = createNodeCache<ChainState>((state) => disposeChain(state));

function disposeChain(state: ChainState) {
  state.group.dispose();
  if (state.group.handle.disposed) return;
  for (const body of state.bodies) {
    try {
      if (body.isValid()) state.group.handle.world.removeRigidBody(body);
    } catch {
      // Gone already.
    }
  }
  state.group.handle.bodies.delete(state.group.key);
}

function release(nodeId: string) {
  const state = chainCache.get(nodeId);
  if (!state) return;
  disposeChain(state);
  chainCache.delete(nodeId);
}

const _q = new THREE.Quaternion();
const _t = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

function poseOf(body: RAPIER.RigidBody, length: number, stretch: boolean) {
  const t = body.translation();
  const r = body.rotation();
  _q.set(r.x, r.y, r.z, r.w);
  _t.set(t.x, t.y, t.z);
  const half = new THREE.Vector3(0, length / 2, 0).applyQuaternion(_q);
  return {
    matrix: new THREE.Matrix4().compose(_t, _q, stretch ? new THREE.Vector3(1, length, 1) : _one),
    start: _t.clone().sub(half),
    end: _t.clone().add(half),
  };
}

function authoredOutputs(links: LinkLayout[], points: THREE.Vector3[], stretch: boolean) {
  return {
    matrices: links.map((link) =>
      new THREE.Matrix4().compose(link.center, link.quaternion, stretch ? new THREE.Vector3(1, link.length, 1) : _one),
    ),
    points,
  };
}

/**
 * Chain — a rope, chain, bridge or curtain: a string of linked bodies.
 *
 * It runs through a list of points, a curve cut into pieces, or a straight
 * line between two points. Every segment becomes a rigid link, and neighbours
 * are joined where they meet — by a **ball** joint (rope, chain, necklace) or
 * a **hinge** about one fixed axis (a plank bridge, a flap curtain, a tail).
 *
 * The links come out as a list of matrices, so what they look like is the
 * author's business: wire them into an Array or Instance with a link mesh, or
 * wire the `points` output through a curve to draw a smooth rope. Pin the ends
 * to the world, or attach them to bodies from a Rigid Body — and the `body`
 * output lets a Constraint hang something from any link (Index -1 is the last).
 *
 * Like a Constraint it is latched to the layout it was made from and goes with
 * the world: nothing exists while the editor is idle (the outputs then show
 * the layout as authored), and changing the points rebuilds it.
 */
export const CHAIN_NODE: NodeDefinition = {
  type: "physics/chain",
  label: "Chain",
  category: "physics",
  inputs: [
    { id: "world", label: "World", type: "any" },
    { id: "points", label: "Points", type: "list" },
    { id: "curve", label: "Curve", type: "curve" },
    { id: "start", label: "Start", type: "vector" },
    { id: "end", label: "End", type: "vector" },
    { id: "attachStart", label: "Attach Start to", type: "any" },
    { id: "attachEnd", label: "Attach End to", type: "any" },
  ],
  outputs: [
    { id: "matrices", label: "Link Matrices", type: "list" },
    { id: "points", label: "Joint Points", type: "list" },
    { id: "body", label: "Body", type: "any" },
    { id: "count", label: "Link Count", type: "value" },
    { id: "stress", label: "Stress (N)", type: "value" },
    { id: "broken", label: "Broken", type: "value" },
  ],
  defaultParams: {
    links: 12,
    start: new THREE.Vector3(0, 4, 0),
    end: new THREE.Vector3(3, 4, 0),
    linkShape: "capsule",
    jointType: "ball",
    axis: new THREE.Vector3(0, 0, 1),
    radius: 0.06,
    width: 0.4,
    mass: 0.2,
    linearDamping: 0.1,
    angularDamping: 0.6,
    friction: 0.7,
    restitution: 0,
    selfCollide: false,
    pinStart: true,
    pinEnd: false,
    stretch: false,
    breakForce: 0,
  },
  paramFields: [
    { id: "links", label: "Links (curve or line)", kind: "number", step: 1, group: "Layout" },
    { id: "start", label: "Start (line)", kind: "vector", step: 0.1, group: "Layout" },
    { id: "end", label: "End (line)", kind: "vector", step: 0.1, group: "Layout" },
    {
      id: "layoutNote",
      label: "Points, then Curve, then the Start/End line — whichever is wired first. Links is the piece count for the last two.",
      kind: "note",
      group: "Layout",
    },
    { id: "pinStart", label: "Pin Start to the world", kind: "boolean", group: "Ends" },
    { id: "pinEnd", label: "Pin End to the world", kind: "boolean", group: "Ends" },
    {
      id: "endNote",
      label: "A body wired to Attach Start / End takes the place of the pin (its first body at the start, its last at the end).",
      kind: "note",
      group: "Ends",
    },
    { id: "linkShape", label: "Link Shape", kind: "select", options: [...CHAIN_LINK_SHAPES], group: "Links" },
    { id: "jointType", label: "Joints", kind: "select", options: [...CHAIN_JOINTS], optionLabels: ["Ball (rope)", "Hinge (bridge)"], group: "Links" },
    { id: "axis", label: "Hinge Axis / Plank Width Direction", kind: "vector", step: 0.1, group: "Links" },
    { id: "radius", label: "Radius / Thickness", kind: "number", step: 0.01, group: "Links" },
    { id: "width", label: "Plank Width (box)", kind: "number", step: 0.05, group: "Links" },
    { id: "stretch", label: "Scale matrices to link length (Y)", kind: "boolean", group: "Links" },
    { id: "mass", label: "Mass per Link", kind: "number", step: 0.05, group: "Material" },
    { id: "linearDamping", label: "Linear Damping", kind: "number", step: 0.05, group: "Material" },
    { id: "angularDamping", label: "Angular Damping", kind: "number", step: 0.05, group: "Material" },
    { id: "friction", label: "Friction", kind: "number", step: 0.05, group: "Material" },
    { id: "restitution", label: "Bounciness", kind: "number", step: 0.05, group: "Material" },
    { id: "selfCollide", label: "Links collide with each other", kind: "boolean", group: "Material" },
    { id: "breakForce", label: "Break Force per Joint (N, 0 = unbreakable)", kind: "number", step: 10, group: "Breaking" },
  ],
  evaluate: (inputs, params, ctx) => {
    const stretch = Boolean(params.stretch);
    const jointType = asJoint(params.jointType);
    const shape = asShape(params.linkShape);
    const across = jointType === "hinge" || shape === "box" ? asVector3(params.axis, new THREE.Vector3(0, 0, 1)) : null;

    const points = chainPoints(
      inputs.points,
      inputs.curve,
      numberInput(undefined, params.links, 12),
      asVector3(inputs.start, asVector3(params.start, new THREE.Vector3(0, 4, 0))),
      asVector3(inputs.end, asVector3(params.end, new THREE.Vector3(3, 4, 0))),
    );
    const links = layoutLinks(points, across);
    const authored = () => ({
      ...authoredOutputs(links, points, stretch),
      body: null,
      count: links.length,
      stress: 0,
      broken: 0,
    });

    const handle = isPhysicsWorld(inputs.world) ? inputs.world : null;
    const api = getRapier();
    if (!handle || !api || !isRapierReady() || !isSimulating(ctx) || links.length === 0) {
      release(ctx.nodeId);
      return authored();
    }

    const wired = (id: string) => (ctx.connectedInputs ? ctx.connectedInputs.has(id) : inputs[id] !== undefined);
    const attach = (value: unknown): RAPIER.RigidBody[] | null =>
      isPhysicsBodies(value) && value.world === handle ? value.bodies.filter((b) => b.isValid()) : null;
    const startBodies = attach(inputs.attachStart);
    const endBodies = attach(inputs.attachEnd);
    if ((wired("attachStart") && !startBodies?.length) || (wired("attachEnd") && !endBodies?.length)) {
      release(ctx.nodeId);
      return authored();
    }
    const startBody = startBodies?.[0] ?? null;
    const endBody = endBodies?.[endBodies.length - 1] ?? null;

    const radius = Math.max(0.005, numberInput(undefined, params.radius, 0.06));
    const width = Math.max(0.01, numberInput(undefined, params.width, 0.4));
    const mass = Math.max(0.001, numberInput(undefined, params.mass, 0.2));
    const pinStart = Boolean(params.pinStart);
    const pinEnd = Boolean(params.pinEnd);
    const selfCollide = Boolean(params.selfCollide);
    const friction = Math.max(0, numberInput(undefined, params.friction, 0.7));
    const restitution = Math.max(0, numberInput(undefined, params.restitution, 0));
    const axis = asVector3(params.axis, new THREE.Vector3(0, 0, 1));

    const key = (v: THREE.Vector3) => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    const signature = [
      handle.generation,
      jointType,
      shape,
      radius,
      width,
      mass,
      selfCollide,
      friction,
      restitution,
      jointType === "hinge" || shape === "box" ? key(axis) : "",
      pinStart,
      pinEnd,
      startBody ? bodyId(startBody) : "-",
      endBody ? bodyId(endBody) : "-",
      points.map(key).join(";"),
    ].join("|");

    let state = chainCache.get(ctx.nodeId);
    if (!state || state.signature !== signature || state.group.handle !== handle) {
      release(ctx.nodeId);
      state = buildChain({
        api,
        handle,
        nodeId: ctx.nodeId,
        links,
        points,
        shape,
        jointType,
        axis,
        radius,
        width,
        mass,
        selfCollide,
        friction,
        restitution,
        startBody,
        endBody,
        pinStart,
        pinEnd,
        signature,
      });
      chainCache.set(ctx.nodeId, state);
    }

    // Live knobs.
    const linearDamping = Math.max(0, numberInput(undefined, params.linearDamping, 0.1));
    const angularDamping = Math.max(0, numberInput(undefined, params.angularDamping, 0.6));
    state.group.breakForce = Math.max(0, numberInput(undefined, params.breakForce, 0));
    for (const body of state.bodies) {
      body.setLinearDamping(linearDamping);
      body.setAngularDamping(angularDamping);
    }

    const matrices: THREE.Matrix4[] = [];
    const joints: THREE.Vector3[] = [];
    state.bodies.forEach((body, i) => {
      const pose = poseOf(body, state.links[i].length, stretch);
      matrices.push(pose.matrix);
      if (i === 0) joints.push(pose.start);
      joints.push(pose.end);
    });

    return {
      matrices,
      points: joints,
      body: state.handle,
      count: state.bodies.length,
      stress: state.group.takePeak(),
      broken: state.group.brokenCount,
    };
  },
};

interface BuildArgs {
  api: NonNullable<ReturnType<typeof getRapier>>;
  handle: PhysicsWorldHandle;
  nodeId: string;
  links: LinkLayout[];
  points: THREE.Vector3[];
  shape: ChainLinkShape;
  jointType: ChainJoint;
  axis: THREE.Vector3;
  radius: number;
  width: number;
  mass: number;
  selfCollide: boolean;
  friction: number;
  restitution: number;
  startBody: RAPIER.RigidBody | null;
  endBody: RAPIER.RigidBody | null;
  pinStart: boolean;
  pinEnd: boolean;
  signature: string;
}

function buildChain(args: BuildArgs): ChainState {
  const { api, handle, links, jointType } = args;
  const group = new JointGroup(handle, `__chain:${args.nodeId}`);
  const bodies: RAPIER.RigidBody[] = [];

  for (const link of links) {
    const desc = api.RigidBodyDesc.dynamic()
      .setTranslation(link.center.x, link.center.y, link.center.z)
      .setRotation({ x: link.quaternion.x, y: link.quaternion.y, z: link.quaternion.z, w: link.quaternion.w });
    const body = handle.world.createRigidBody(desc);

    // Capsule length includes its caps, so the half-height is what is left of
    // half the segment once the radius is taken off each end.
    const collider =
      args.shape === "box"
        ? api.ColliderDesc.cuboid(args.width / 2, link.length / 2, args.radius)
        : api.ColliderDesc.capsule(Math.max(1e-3, link.length / 2 - args.radius), args.radius);
    collider.setMass(args.mass).setFriction(args.friction).setRestitution(args.restitution);
    if (!args.selfCollide) collider.setCollisionGroups(LINK_GROUPS);
    handle.world.createCollider(collider, body);
    bodies.push(body);
  }

  const kind: JointKind = jointType;
  const join = (a: RAPIER.RigidBody, b: RAPIER.RigidBody, at: THREE.Vector3, contacts: boolean) => {
    try {
      const { joint, length } = createJoint(api, handle.world, a, b, {
        kind,
        anchorA: at,
        anchorB: at,
        axis: args.axis,
        length: 0,
        stiffness: 0,
        damping: 0,
        collideConnected: contacts,
      });
      group.add({ joint, a, b, kind, broken: false, length });
    } catch (err) {
      console.error("physics/chain: failed to create a joint", err);
    }
  };

  // Where each link meets the next is the end of its segment.
  const ends = links.map((link) => link.center.clone().add(new THREE.Vector3(0, link.length / 2, 0).applyQuaternion(link.quaternion)));
  for (let i = 0; i + 1 < bodies.length; i++) join(bodies[i], bodies[i + 1], ends[i], args.selfCollide);

  const first = links[0];
  const firstPoint = first.center.clone().sub(new THREE.Vector3(0, first.length / 2, 0).applyQuaternion(first.quaternion));
  const lastPoint = ends[ends.length - 1];

  // A ball joint at an end, whatever the chain's own kind: a pin that turned
  // out to be a hinge would stop a rope from swinging sideways at its anchor.
  const pin = (body: RAPIER.RigidBody, other: RAPIER.RigidBody, at: THREE.Vector3) => {
    try {
      const { joint, length } = createJoint(api, handle.world, other, body, {
        kind: "ball",
        anchorA: at,
        anchorB: at,
        axis: args.axis,
        length: 0,
        stiffness: 0,
        damping: 0,
        collideConnected: false,
      });
      group.add({ joint, a: other, b: body, kind: "ball", broken: false, length });
    } catch (err) {
      console.error("physics/chain: failed to pin an end", err);
    }
  };

  const world = (at: THREE.Vector3) => {
    const anchor = createAnchorBody(api, handle.world, at);
    group.anchorBodies.push(anchor);
    return anchor;
  };

  if (args.startBody) pin(bodies[0], args.startBody, firstPoint);
  else if (args.pinStart) pin(bodies[0], world(firstPoint), firstPoint);
  if (args.endBody) pin(bodies[bodies.length - 1], args.endBody, lastPoint);
  else if (args.pinEnd) pin(bodies[bodies.length - 1], world(lastPoint), lastPoint);

  handle.bodies.set(group.key, bodies[0]);
  return {
    group,
    bodies,
    links,
    handle: { kind: "physics-bodies", world: handle, bodies },
    signature: args.signature,
  };
}
