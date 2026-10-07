import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { STEP_SECONDS, stepsSince } from "../clock";
import { toBoolean } from "../sockets";
import { numberInput } from "./object";
import { asVector3 } from "./transform";
import { perSession, sessionKey } from "../sessionState";
import { Avoidance, collectObstacles, makeAvoider } from "../obstacles";

/** Same catch-up ceiling as the other step-driven simulations. */
const MAX_CATCHUP_STEPS = 10;
/** Past this many points the pairwise spacing check stops fitting in a frame. */
const MAX_POINTS = 1000;
const BOUNDS_MODES = ["none", "bounce", "wrap", "clamp"] as const;

/** One render loop's points — see sessionState.ts for why each viewport keeps its own. */
interface DriftRun {
  count: number;
  pos: Float64Array;
  vel: Float64Array;
  epoch: number;
  lastStep: number;
}

interface DriftState {
  sessions: Map<string, DriftRun>;
  points: THREE.Vector3[];
  velocities: THREE.Vector3[];
  speeds: number[];
}

const driftCache = createNodeCache<DriftState>();

function freshRun(epoch: number, step: number): DriftRun {
  // lastStep one behind so the very first evaluation advances a step.
  return { count: 0, pos: new Float64Array(0), vel: new Float64Array(0), epoch, lastStep: step - 1 };
}

/** Grows or shrinks to the home list, keeping where existing points have drifted to; new ones start at home, at rest. */
function resize(run: DriftRun, homes: THREE.Vector3[]): void {
  const n = homes.length;
  if (n === run.count) return;
  const pos = new Float64Array(n * 3);
  const vel = new Float64Array(n * 3);
  pos.set(run.pos.subarray(0, Math.min(run.pos.length, pos.length)));
  vel.set(run.vel.subarray(0, Math.min(run.vel.length, vel.length)));
  for (let i = run.count; i < n; i++) {
    pos[i * 3] = homes[i].x;
    pos[i * 3 + 1] = homes[i].y;
    pos[i * 3 + 2] = homes[i].z;
  }
  run.pos = pos;
  run.vel = vel;
  run.count = n;
}

function readVectors(raw: unknown): THREE.Vector3[] {
  if (!Array.isArray(raw)) return [];
  const out: THREE.Vector3[] = [];
  for (const item of raw.slice(0, MAX_POINTS)) {
    const v = asVector3(item, new THREE.Vector3(Number.NaN, 0, 0));
    if (Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)) out.push(v);
  }
  return out;
}

function listVector(list: unknown, i: number, into: THREE.Vector3): THREE.Vector3 | null {
  if (!Array.isArray(list)) return null;
  const v = asVector3(list[i], new THREE.Vector3(Number.NaN, 0, 0));
  return Number.isFinite(v.x) ? into.copy(v) : null;
}

function listNumber(list: unknown, i: number, fallback: number): number {
  if (!Array.isArray(list)) return fallback;
  const n = Number(list[i]);
  return Number.isFinite(n) ? n : fallback;
}

const force = new THREE.Vector3();
const ownForce = new THREE.Vector3();
const hit: Avoidance = { x: 0, y: 0, z: 0, weight: 0, inside: false, distance: 0 };

/**
 * Drift — things that float, slide and settle: points pushed by forces,
 * slowed by drag, optionally tethered to where they started, kept from
 * overlapping each other, steered round obstacles and kept inside bounds.
 * Leaves on a pond, corks, debris on a current, lily pads on their stems,
 * buoys on a swell.
 *
 * Forces come per point (Ripple Field's Probe Normals push things downhill
 * off each wave, so they ride and gather in the troughs) and as one shared
 * Force (a current, a wind). Tether pulls each point back towards its home
 * once it has strayed further than Slack. Keep Height holds each point at its
 * home's height, for drift across a surface rather than through space.
 *
 * Points is read as the homes: a point added to the list starts at its home
 * at rest; moving a home moves where its tether pulls.
 */
export const DRIFT_NODE: NodeDefinition = {
  type: "physics/drift",
  label: "Drift",
  category: "physics",
  inputs: [
    { id: "points", label: "Points", type: "list" },
    { id: "forces", label: "Forces", type: "list" },
    { id: "force", label: "Force", type: "vector" },
    { id: "radii", label: "Radii", type: "list" },
    { id: "obstacles", label: "Obstacles", type: "geometry" },
  ],
  outputs: [
    { id: "points", label: "Points", type: "list" },
    { id: "velocities", label: "Velocities", type: "list" },
    { id: "speeds", label: "Speeds", type: "list" },
    { id: "count", label: "Count", type: "value" },
  ],
  defaultParams: {
    force: new THREE.Vector3(0, 0, 0),
    forceScale: 1,
    drag: 1.5,
    maxSpeed: 3,
    tether: 0,
    slack: 0,
    radius: 0.25,
    spacing: 4,
    keepHeight: true,
    obstacleWeight: 6,
    boundsMode: "none",
    boundsCenter: new THREE.Vector3(0, 0, 0),
    boundsSize: new THREE.Vector3(10, 10, 10),
  },
  paramFields: [
    { id: "force", label: "Force", kind: "vector", group: "Forces" },
    { id: "forceScale", label: "Per-Point Force Scale", kind: "number", step: 0.1, group: "Forces" },
    { id: "drag", label: "Drag", kind: "number", step: 0.1, group: "Forces" },
    { id: "maxSpeed", label: "Max Speed", kind: "number", step: 0.1, group: "Forces" },
    { id: "tether", label: "Tether", kind: "number", step: 0.1, group: "Tether" },
    { id: "slack", label: "Slack", kind: "number", step: 0.05, group: "Tether" },
    { id: "radius", label: "Radius", kind: "number", step: 0.05, group: "Spacing" },
    { id: "spacing", label: "Spacing", kind: "number", step: 0.5, group: "Spacing" },
    { id: "obstacleWeight", label: "Obstacle Push", kind: "number", step: 0.5, group: "Spacing" },
    { id: "keepHeight", label: "Keep Height", kind: "boolean", group: "Space" },
    {
      id: "boundsMode",
      label: "Bounds",
      kind: "select",
      options: [...BOUNDS_MODES],
      optionLabels: ["None", "Bounce", "Wrap", "Clamp"],
      group: "Space",
    },
    { id: "boundsCenter", label: "Bounds Center", kind: "vector", group: "Space" },
    { id: "boundsSize", label: "Bounds Size", kind: "vector", group: "Space" },
  ],
  evaluate: (inputs, params, ctx) => {
    const homes = readVectors(inputs.points);
    const epoch = ctx.simulationEpoch ?? 0;
    let state = driftCache.get(ctx.nodeId);
    if (!state) {
      state = { sessions: new Map(), points: [], velocities: [], speeds: [] };
      driftCache.set(ctx.nodeId, state);
    }
    const key = sessionKey(ctx);
    let run = perSession(state.sessions, key, () => freshRun(epoch, ctx.step));
    // A scrub backwards or a reset: everything goes back home.
    if (run.epoch !== epoch || ctx.step < run.lastStep) {
      run = freshRun(epoch, ctx.step);
      state.sessions.set(key, run);
    }
    resize(run, homes);

    const shared = asVector3(inputs.force ?? params.force, new THREE.Vector3());
    const forceScale = numberInput(undefined, params.forceScale, 1);
    const drag = Math.max(0, numberInput(undefined, params.drag, 1.5));
    const maxSpeed = Math.max(0, numberInput(undefined, params.maxSpeed, 3));
    const tether = Math.max(0, numberInput(undefined, params.tether, 0));
    const slack = Math.max(0, numberInput(undefined, params.slack, 0));
    const radius = Math.max(0, numberInput(undefined, params.radius, 0.25));
    const spacing = Math.max(0, numberInput(undefined, params.spacing, 4));
    const keepHeight = toBoolean(params.keepHeight ?? true);
    const obstacleWeight = Math.max(0, numberInput(undefined, params.obstacleWeight, 6));
    const mode = String(params.boundsMode ?? "none");
    const center = asVector3(params.boundsCenter, new THREE.Vector3());
    const size = asVector3(params.boundsSize, new THREE.Vector3(10, 10, 10));
    const lo = center.clone().addScaledVector(size, -0.5);
    const hi = center.clone().addScaledVector(size, 0.5);
    const avoid = obstacleWeight > 0 ? makeAvoider(collectObstacles(inputs.obstacles), Math.max(radius * 2, 0.1)) : undefined;

    const n = run.count;
    const { pos, vel } = run;
    const dt = STEP_SECONDS;
    const keep = Math.exp(-drag * dt);
    const steps = stepsSince(run.lastStep, ctx.step, MAX_CATCHUP_STEPS);
    run.lastStep = Math.max(run.lastStep, ctx.step);
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < n; i++) {
        const b = i * 3;
        force.copy(shared);
        const own = listVector(inputs.forces, i, ownForce);
        if (own) force.addScaledVector(own, forceScale);

        if (tether > 0) {
          const hx = homes[i].x - pos[b], hy = keepHeight ? 0 : homes[i].y - pos[b + 1], hz = homes[i].z - pos[b + 2];
          const d = Math.hypot(hx, hy, hz);
          if (d > slack && d > 1e-9) {
            const pull = (tether * (d - slack)) / d;
            force.x += hx * pull; force.y += hy * pull; force.z += hz * pull;
          }
        }

        if (spacing > 0) {
          const ri = listNumber(inputs.radii, i, radius);
          for (let j = 0; j < n; j++) {
            if (j === i) continue;
            const c = j * 3;
            const dx = pos[b] - pos[c], dy = keepHeight ? 0 : pos[b + 1] - pos[c + 1], dz = pos[b + 2] - pos[c + 2];
            const reach = ri + listNumber(inputs.radii, j, radius);
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 >= reach * reach) continue;
            const d = Math.sqrt(d2);
            if (d < 1e-9) {
              // Exactly on top of each other: part them along a direction that depends on who is who.
              const a = (i * 2.399963) % (Math.PI * 2);
              force.x += Math.cos(a) * spacing * reach;
              force.z += Math.sin(a) * spacing * reach;
              continue;
            }
            const push = (spacing * (reach - d)) / d;
            force.x += dx * push; force.y += dy * push; force.z += dz * push;
          }
        }

        if (avoid && avoid(pos[b], pos[b + 1], pos[b + 2], hit)) {
          const push = obstacleWeight * hit.weight;
          force.x += hit.x * push;
          if (!keepHeight) force.y += hit.y * push;
          force.z += hit.z * push;
        }

        vel[b] = (vel[b] + force.x * dt) * keep;
        vel[b + 1] = keepHeight ? 0 : (vel[b + 1] + force.y * dt) * keep;
        vel[b + 2] = (vel[b + 2] + force.z * dt) * keep;
        const speed = Math.hypot(vel[b], vel[b + 1], vel[b + 2]);
        if (speed > maxSpeed && speed > 0) {
          const k = maxSpeed / speed;
          vel[b] *= k; vel[b + 1] *= k; vel[b + 2] *= k;
        }
        pos[b] += vel[b] * dt;
        pos[b + 1] = keepHeight ? homes[i].y : pos[b + 1] + vel[b + 1] * dt;
        pos[b + 2] += vel[b + 2] * dt;

        if (mode !== "none") {
          for (let a = 0; a < 3; a++) {
            if (a === 1 && keepHeight) continue;
            const min = lo.getComponent(a), max = hi.getComponent(a);
            if (!(max > min)) continue;
            if (mode === "wrap") {
              if (pos[b + a] < min) pos[b + a] += max - min;
              else if (pos[b + a] > max) pos[b + a] -= max - min;
            } else if (pos[b + a] < min || pos[b + a] > max) {
              pos[b + a] = Math.max(min, Math.min(max, pos[b + a]));
              vel[b + a] = mode === "bounce" ? -vel[b + a] * 0.6 : 0;
            }
          }
        }
      }
    }

    const { points, velocities, speeds } = state;
    for (let i = points.length; i < n; i++) points.push(new THREE.Vector3());
    for (let i = velocities.length; i < n; i++) velocities.push(new THREE.Vector3());
    points.length = n;
    velocities.length = n;
    speeds.length = n;
    for (let i = 0; i < n; i++) {
      const b = i * 3;
      points[i].set(pos[b], pos[b + 1], pos[b + 2]);
      velocities[i].set(vel[b], vel[b + 1], vel[b + 2]);
      speeds[i] = Math.hypot(vel[b], vel[b + 1], vel[b + 2]);
    }
    return { points, velocities, speeds, count: n };
  },
};
