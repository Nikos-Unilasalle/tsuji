import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { STEP_SECONDS, stepsSince } from "../clock";
import { toBoolean } from "../sockets";
import { findFirstMesh } from "../meshRequired";
import { numberInput } from "./object";
import { asVector3 } from "./transform";
import {
  callFlock,
  createFlockState,
  FlockParams,
  FlockState,
  flockCentroid,
  MAX_AGENTS,
  resizeFlock,
  scatterFlock,
} from "../flock/state";
import { stepFlock } from "../flock/steering";

const DEG = Math.PI / 180;
/** Same catch-up ceiling as the other step-driven simulations: a stall advances visibly instead of hanging. */
const MAX_CATCHUP_STEPS = 10;
const FORWARD_AXES = ["+Z", "-Z", "+X", "-X"];

interface FlockNodeState {
  sim: FlockState;
  epoch: number;
  lastStep: number;
  seed: number;
  prevCall: boolean;
  prevScatter: boolean;
  mesh?: THREE.InstancedMesh;
  meshKey?: string;
  points: THREE.Vector3[];
  rotations: THREE.Vector3[];
  headings: THREE.Vector3[];
  speeds: number[];
  phases: number[];
}

/** Disposes only the geometry: the material is the Shape's (or the shared default), borrowed by reference. */
const flockCache = createNodeCache<FlockNodeState>((state) => state.mesh?.geometry.dispose());

let defaultBody: THREE.BufferGeometry | null = null;
let defaultMaterial: THREE.Material | null = null;

/** A flattened teardrop, head at +Z and tapering to the tail — a fish from above, a bird from below, before a Shape is wired. */
function bodyGeometry(): THREE.BufferGeometry {
  if (!defaultBody) {
    const body = new THREE.SphereGeometry(0.5, 16, 10);
    body.scale(0.34, 0.2, 1);
    const position = body.getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      const z = position.getZ(i);
      const taper = z < 0 ? 1 + z * 1.2 : 1;
      position.setX(i, position.getX(i) * taper);
      position.setY(i, position.getY(i) * taper);
    }
    body.computeVertexNormals();
    defaultBody = body;
  }
  return defaultBody;
}

function koiMaterial(): THREE.Material {
  if (!defaultMaterial) defaultMaterial = new THREE.MeshStandardMaterial({ color: 0xe8743b, roughness: 0.55 });
  return defaultMaterial;
}

function readParams(inputs: Record<string, unknown>, params: Record<string, unknown>): FlockParams {
  const center = asVector3(inputs.boundsCenter ?? params.boundsCenter, new THREE.Vector3(0, 0, 0));
  const size = asVector3(inputs.boundsSize ?? params.boundsSize, new THREE.Vector3(10, 1, 6));
  const target = asVector3(inputs.target ?? params.target, new THREE.Vector3(0, 0, 0));
  const nonNeg = (v: number) => Math.max(0, v);
  return {
    mode: params.mode === "Volume (3D)" ? "volume" : "plane",
    seed: numberInput(undefined, params.seed, 1),
    swimStates: toBoolean(params.swimStates ?? true),
    speed: nonNeg(numberInput(inputs.speed, params.speed, 1.2)),
    turnRate: nonNeg(numberInput(undefined, params.turnRate, 120)) * DEG,
    variation: Math.min(1, nonNeg(numberInput(undefined, params.variation, 0.35))),
    wander: nonNeg(numberInput(undefined, params.wander, 0.6)),
    cohesion: nonNeg(numberInput(undefined, params.cohesion, 0.5)),
    alignment: nonNeg(numberInput(undefined, params.alignment, 0.6)),
    separation: nonNeg(numberInput(undefined, params.separation, 1.4)),
    edge: nonNeg(numberInput(undefined, params.edge, 2)),
    neighborRadius: Math.max(0.01, numberInput(undefined, params.neighborRadius, 1.5)),
    separationDistance: Math.max(0.01, numberInput(undefined, params.separationDistance, 0.5)),
    boundsCenter: { x: center.x, y: center.y, z: center.z },
    boundsSize: { x: Math.abs(size.x), y: Math.abs(size.y), z: Math.abs(size.z) },
    edgeMargin: nonNeg(numberInput(undefined, params.edgeMargin, 1)),
    target: { x: target.x, y: target.y, z: target.z },
    targetWeight: nonNeg(numberInput(inputs.targetWeight, params.targetWeight, 0)),
    circle: numberInput(undefined, params.circle, 0.6),
    arriveRadius: Math.max(0.01, numberInput(undefined, params.arriveRadius, 1)),
    callDuration: nonNeg(numberInput(undefined, params.callDuration, 4)),
    callSpread: nonNeg(numberInput(undefined, params.callSpread, 0.6)),
    maxPitch: nonNeg(numberInput(undefined, params.maxPitch, 35)) * DEG,
    bank: numberInput(undefined, params.bank, 0.5),
  };
}

function freshState(epoch: number, step: number, seed: number): FlockNodeState {
  // lastStep one behind so the very first evaluation advances a step instead of freezing.
  return { sim: createFlockState(), epoch, lastStep: step - 1, seed, prevCall: false, prevScatter: false, points: [], rotations: [], headings: [], speeds: [], phases: [] };
}

function axisAlignment(axis: string): THREE.Quaternion {
  const from = axis === "-Z" ? new THREE.Vector3(0, 0, -1) : axis === "+X" ? new THREE.Vector3(1, 0, 0) : axis === "-X" ? new THREE.Vector3(-1, 0, 0) : new THREE.Vector3(0, 0, 1);
  return new THREE.Quaternion().setFromUnitVectors(from, new THREE.Vector3(0, 0, 1));
}

/** Per-agent size factor from its index alone, so resizing the flock never reshuffles sizes. */
function sizeFactor(i: number, seed: number, variation: number): number {
  const h = Math.sin((i + 1) * 12.9898 + seed * 78.233) * 43758.5453;
  return 1 + (h - Math.floor(h) - 0.5) * 0.6 * variation;
}

const basis = new THREE.Matrix4();
const look = new THREE.Quaternion();
const rollQ = new THREE.Quaternion();
const xAxis = new THREE.Vector3();
const yAxis = new THREE.Vector3();
const zAxis = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);
const scaleV = new THREE.Vector3();
const matrix = new THREE.Matrix4();
const euler = new THREE.Euler();

/** Agent orientation: heading as forward, world up as up, then rolled about the heading, then the Shape's own forward axis. */
function orientation(sim: FlockState, i: number, align: THREE.Quaternion, out: THREE.Quaternion): THREE.Quaternion {
  const b = i * 3;
  zAxis.set(sim.dir[b], sim.dir[b + 1], sim.dir[b + 2]);
  xAxis.crossVectors(up, zAxis);
  if (xAxis.lengthSq() < 1e-8) xAxis.set(1, 0, 0);
  xAxis.normalize();
  yAxis.crossVectors(zAxis, xAxis);
  basis.makeBasis(xAxis, yAxis, zAxis);
  look.setFromRotationMatrix(basis);
  rollQ.setFromAxisAngle(zAxis, sim.roll[i]);
  return out.copy(rollQ).multiply(look).multiply(align);
}

function syncList<T>(list: T[], n: number, make: () => T): void {
  for (let i = list.length; i < n; i++) list.push(make());
  list.length = n;
}

/**
 * Flock — a school, swarm or flock of self-steering agents.
 *
 * Each agent wanders, keeps loosely with its neighbours (cohesion, alignment,
 * separation), turns back before the bounds and, when asked, heads for the
 * Target. Swim States add Nagomi's koi moods — glide, coast, hover, burst,
 * pivot — on each agent's own clock, and every agent carries a small
 * personality, so the group never moves in lockstep.
 *
 * Call (a rising edge, e.g. Click's Pressed) summons the flock to the Target
 * as it is at that moment: each agent answers after its own delay, bursts,
 * rises to the top of the bounds in Plane mode, and circles the point rather
 * than piling onto it. Scatter sends everyone bolting away from the flock's
 * centre.
 *
 * Draws its own instanced copies of Shape (a teardrop body until one is wired), and
 * hands out per-agent lists — Points, Rotations (Euler °, the convention
 * Instance on Points reads), Headings, Speeds and Swim Phase (radians,
 * quicker when swimming harder, for a tail wiggle) — for anything else.
 */
export const FLOCK_NODE: NodeDefinition = {
  type: "particles/flock",
  label: "Flock",
  category: "particles",
  inputs: [
    { id: "shape", label: "Shape (Mesh)", type: "geometry" },
    { id: "count", label: "Count", type: "value" },
    { id: "target", label: "Target", type: "vector" },
    { id: "targetWeight", label: "Target Pull", type: "value" },
    { id: "call", label: "Call (rising edge)", type: "value" },
    { id: "scatter", label: "Scatter (rising edge)", type: "value" },
    { id: "speed", label: "Speed", type: "value" },
    { id: "boundsCenter", label: "Bounds Center", type: "vector" },
    { id: "boundsSize", label: "Bounds Size", type: "vector" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "points", label: "Points", type: "list" },
    { id: "rotations", label: "Rotations (Euler °)", type: "list" },
    { id: "headings", label: "Headings", type: "list" },
    { id: "speeds", label: "Speeds", type: "list" },
    { id: "phases", label: "Swim Phase", type: "list" },
    { id: "count", label: "Count", type: "value" },
  ],
  defaultParams: {
    count: 40,
    mode: "Plane (XZ)",
    seed: 1,
    swimStates: true,
    speed: 1.2,
    turnRate: 120,
    variation: 0.35,
    wander: 0.6,
    cohesion: 0.5,
    alignment: 0.6,
    separation: 1.4,
    edge: 2,
    neighborRadius: 1.5,
    separationDistance: 0.5,
    boundsCenter: new THREE.Vector3(0, 0, 0),
    boundsSize: new THREE.Vector3(10, 1, 6),
    edgeMargin: 1,
    target: new THREE.Vector3(0, 0, 0),
    targetWeight: 0,
    circle: 0.6,
    arriveRadius: 1,
    callDuration: 4,
    callSpread: 0.6,
    maxPitch: 35,
    bank: 0.5,
    scale: 0.4,
    forwardAxis: "+Z",
    visible: true,
  },
  paramFields: [
    { id: "count", label: "Count", kind: "number", step: 1, group: "Flock" },
    {
      id: "mode",
      label: "Space",
      kind: "select",
      options: ["Plane (XZ)", "Volume (3D)"],
      optionLabels: ["Plane — fish in a pond, depth drifts within Bounds Y", "Volume — birds, insects, free in 3D"],
      group: "Flock",
    },
    { id: "seed", label: "Seed", kind: "number", step: 1, group: "Flock" },
    { id: "swimStates", label: "Swim States (glide, coast, hover, burst, pivot)", kind: "boolean", group: "Flock" },
    { id: "speed", label: "Speed (units/s)", kind: "number", step: 0.1, group: "Motion" },
    { id: "turnRate", label: "Turn Rate (°/s)", kind: "number", step: 5, group: "Motion" },
    { id: "variation", label: "Personality Variation (0-1)", kind: "number", step: 0.05, group: "Motion" },
    { id: "bank", label: "Bank into Turns", kind: "number", step: 0.05, group: "Motion" },
    { id: "maxPitch", label: "Max Pitch (°, Volume)", kind: "number", step: 5, group: "Motion" },
    { id: "wander", label: "Wander", kind: "number", step: 0.05, group: "Behaviour" },
    { id: "cohesion", label: "Cohesion", kind: "number", step: 0.05, group: "Behaviour" },
    { id: "alignment", label: "Alignment", kind: "number", step: 0.05, group: "Behaviour" },
    { id: "separation", label: "Separation", kind: "number", step: 0.05, group: "Behaviour" },
    { id: "edge", label: "Edge Avoidance", kind: "number", step: 0.1, group: "Behaviour" },
    { id: "neighborRadius", label: "Neighbour Radius", kind: "number", step: 0.1, group: "Behaviour" },
    { id: "separationDistance", label: "Personal Space", kind: "number", step: 0.05, group: "Behaviour" },
    { id: "boundsCenter", label: "Bounds Center", kind: "vector", group: "Bounds" },
    { id: "boundsSize", label: "Bounds Size", kind: "vector", group: "Bounds" },
    { id: "edgeMargin", label: "Edge Margin", kind: "number", step: 0.1, group: "Bounds" },
    { id: "target", label: "Target (fallback)", kind: "vector", group: "Target" },
    { id: "targetWeight", label: "Target Pull (0 = ignore)", kind: "number", step: 0.1, group: "Target" },
    { id: "arriveRadius", label: "Arrive Radius", kind: "number", step: 0.1, group: "Target" },
    { id: "circle", label: "Circling", kind: "number", step: 0.05, group: "Target" },
    { id: "callDuration", label: "Call Duration (s)", kind: "number", step: 0.1, group: "Target" },
    { id: "callSpread", label: "Call Reaction Spread (s)", kind: "number", step: 0.05, group: "Target" },
    { id: "scale", label: "Agent Scale", kind: "number", step: 0.05, group: "Shape" },
    { id: "forwardAxis", label: "Shape Forward Axis", kind: "select", options: FORWARD_AXES, group: "Shape" },
    { id: "visible", label: "Visible", kind: "boolean", group: "Shape" },
  ],
  evaluate: (inputs, params, ctx) => {
    const p = readParams(inputs, params);
    const epoch = ctx.simulationEpoch ?? 0;
    let state = flockCache.get(ctx.nodeId);
    // A scrub backwards, a reset or a new seed: the flock's history no longer
    // belongs to this timeline, so start the school over rather than replay it.
    if (state && (state.epoch !== epoch || ctx.step < state.lastStep || state.seed !== p.seed)) {
      const keep = state;
      state = freshState(epoch, ctx.step, p.seed);
      state.mesh = keep.mesh;
      state.meshKey = keep.meshKey;
      flockCache.set(ctx.nodeId, state);
    }
    if (!state) {
      state = freshState(epoch, ctx.step, p.seed);
      flockCache.set(ctx.nodeId, state);
    }
    const sim = state.sim;

    const count = Math.max(0, Math.min(MAX_AGENTS, Math.floor(numberInput(inputs.count, params.count, 40))));
    if (count !== sim.count) resizeFlock(sim, count, p);

    const call = toBoolean(inputs.call);
    if (call && !state.prevCall) callFlock(sim, p.target, p);
    state.prevCall = call;
    const scatter = toBoolean(inputs.scatter);
    if (scatter && !state.prevScatter) scatterFlock(sim, flockCentroid(sim, p));
    state.prevScatter = scatter;

    const steps = stepsSince(state.lastStep, ctx.step, MAX_CATCHUP_STEPS);
    for (let s = 0; s < steps; s++) stepFlock(sim, p, STEP_SECONDS);
    state.lastStep = Math.max(state.lastStep, ctx.step);

    const shapeMesh = inputs.shape instanceof THREE.Object3D ? findFirstMesh(inputs.shape) : null;
    const sourceGeometry = shapeMesh?.geometry ?? bodyGeometry();
    const material = shapeMesh ? shapeMesh.material : koiMaterial();
    const capacity = Math.max(1, sim.capacity);
    const meshKey = `${shapeMesh ? sourceGeometry.uuid : "__default"}:${capacity}`;
    if (!state.mesh || state.meshKey !== meshKey) {
      state.mesh?.geometry.dispose();
      // Cloned: an InstancedMesh owns its geometry for disposal, and the Shape node still draws the original.
      const mesh = new THREE.InstancedMesh(sourceGeometry.clone(), material, capacity);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.userData.nodeId = ctx.nodeId;
      state.mesh = mesh;
      state.meshKey = meshKey;
    }
    const mesh = state.mesh;
    if (mesh.material !== material) mesh.material = material;
    mesh.visible = toBoolean(params.visible ?? true);

    const align = axisAlignment(String(params.forwardAxis ?? "+Z"));
    const scale = Math.max(0, numberInput(undefined, params.scale, 0.4));
    const n = sim.count;
    syncList(state.points, n, () => new THREE.Vector3());
    syncList(state.rotations, n, () => new THREE.Vector3());
    syncList(state.headings, n, () => new THREE.Vector3());
    state.speeds.length = n;
    state.phases.length = n;
    const q = new THREE.Quaternion();
    for (let i = 0; i < n; i++) {
      const b = i * 3;
      const pt = state.points[i].set(sim.pos[b], sim.pos[b + 1], sim.pos[b + 2]);
      state.headings[i].set(sim.dir[b], sim.dir[b + 1], sim.dir[b + 2]);
      orientation(sim, i, align, q);
      euler.setFromQuaternion(q, "XYZ");
      state.rotations[i].set(euler.x / DEG, euler.y / DEG, euler.z / DEG);
      state.speeds[i] = sim.speed[i];
      state.phases[i] = sim.phase[i];
      scaleV.setScalar(scale * sizeFactor(i, p.seed, p.variation));
      mesh.setMatrixAt(i, matrix.compose(pt, q, scaleV));
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;

    return {
      geometry: mesh,
      points: state.points,
      rotations: state.rotations,
      headings: state.headings,
      speeds: state.speeds,
      phases: state.phases,
      count: n,
    };
  },
};
