import { createPRNG } from "../../math/random";
import type { Avoider } from "../obstacles";

/**
 * Flock — the agent simulation behind the Flock node, kept free of
 * THREE and of the node graph so it can be stepped and tested on its own.
 *
 * The behaviour follows Nagomi's koi pond (github.com/msk1039/nagomi) more
 * than textbook boids: besides the three classic rules every agent carries a
 * small personality (speed, turn and reaction multipliers) and a swim state
 * that changes on its own clock, which is what keeps a school from moving as
 * one rigid block. Agents never set their heading or speed directly — they
 * turn toward a desired direction at a bounded rate and ease toward a target
 * speed — because snapping either is what makes animals read as sliding
 * icons.
 *
 * Everything lives in flat typed arrays: a few hundred agents stepped sixty
 * times a second must not leave a trail of per-agent objects behind them.
 */

export type FlockMode = "plane" | "volume";

export const SWIM_STATES = ["glide", "coast", "hover", "burst", "pivot"] as const;
export type SwimState = (typeof SWIM_STATES)[number];

export const GLIDE = 0;
export const BURST = 3;

/** Speed multiplier, turn multiplier and duration range (s) per swim state. */
export const STATE_PROFILE: { speed: number; turn: number; min: number; max: number; weight: number }[] = [
  { speed: 1, turn: 1, min: 2.5, max: 6, weight: 6 },
  { speed: 0.55, turn: 0.6, min: 1.5, max: 3.5, weight: 3 },
  { speed: 0.12, turn: 0.4, min: 1, max: 2.5, weight: 1.2 },
  { speed: 2.3, turn: 1.4, min: 0.4, max: 0.9, weight: 0.8 },
  { speed: 0.45, turn: 2.6, min: 0.5, max: 1.1, weight: 1 },
];
/** Turn multiplier floor and top speed multiplier while answering a call. */
export const CALLED_TURN = 1.5;
export const CALLED_DASH = 2.3;
const STATE_WEIGHT_TOTAL = STATE_PROFILE.reduce((sum, p) => sum + p.weight, 0);

export interface FlockParams {
  mode: FlockMode;
  seed: number;
  swimStates: boolean;
  /** Cruising speed, world units per second. */
  speed: number;
  /** Maximum turn rate, radians per second, before personality and state. */
  turnRate: number;
  /** 0-1: how far each agent's personality strays from the average. */
  variation: number;
  wander: number;
  cohesion: number;
  alignment: number;
  separation: number;
  edge: number;
  neighborRadius: number;
  separationDistance: number;
  boundsCenter: Vec3;
  boundsSize: Vec3;
  edgeMargin: number;
  target: Vec3;
  targetWeight: number;
  /** Tangential pull near the target, so a crowd circles it instead of piling up. */
  circle: number;
  arriveRadius: number;
  callDuration: number;
  /** Seconds of reaction delay spread across the flock when called. */
  callSpread: number;
  /** Radians, Volume mode only. */
  maxPitch: number;
  /** Roll into turns, 0 = none. */
  bank: number;
  /** How hard agents steer away from obstacles; 0 ignores them. */
  obstacle: number;
  /** Nearest obstacle surface around a point, if any is in reach — see obstacles.ts. */
  avoid?: Avoider;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface FlockState {
  count: number;
  capacity: number;
  pos: Float64Array;
  /** Unit heading, 3 per agent. */
  dir: Float64Array;
  speed: Float64Array;
  /** Personality: speed, turn, reaction multipliers. */
  speedMul: Float64Array;
  turnMul: Float64Array;
  reactMul: Float64Array;
  wander: Float64Array;
  wanderPitch: Float64Array;
  swimState: Uint8Array;
  stateTimer: Float64Array;
  depthTarget: Float64Array;
  depthTimer: Float64Array;
  roll: Float64Array;
  phase: Float64Array;
  /** Seconds until this agent answers the current call, or -1 when it isn't called. */
  callDelay: Float64Array;
  /** Seconds left in this agent's answer to the call. */
  callLeft: Float64Array;
  scatterLeft: Float64Array;
  callPoint: Vec3;
  scatterPoint: Vec3;
  rng: (() => number)[];
  /** Neighbour grid, rebuilt each step: agent indices sorted by cell. */
  cellStart: Int32Array;
  cellAgents: Int32Array;
  agentCell: Int32Array;
}

/** Ceiling on agents: past this the neighbour search stops fitting in a frame. */
export const MAX_AGENTS = 2000;

export function createFlockState(): FlockState {
  return {
    count: 0,
    capacity: 0,
    pos: new Float64Array(0),
    dir: new Float64Array(0),
    speed: new Float64Array(0),
    speedMul: new Float64Array(0),
    turnMul: new Float64Array(0),
    reactMul: new Float64Array(0),
    wander: new Float64Array(0),
    wanderPitch: new Float64Array(0),
    swimState: new Uint8Array(0),
    stateTimer: new Float64Array(0),
    depthTarget: new Float64Array(0),
    depthTimer: new Float64Array(0),
    roll: new Float64Array(0),
    phase: new Float64Array(0),
    callDelay: new Float64Array(0),
    callLeft: new Float64Array(0),
    scatterLeft: new Float64Array(0),
    callPoint: { x: 0, y: 0, z: 0 },
    scatterPoint: { x: 0, y: 0, z: 0 },
    rng: [],
    cellStart: new Int32Array(0),
    cellAgents: new Int32Array(0),
    agentCell: new Int32Array(0),
  };
}

function grow<T extends Float64Array | Uint8Array | Int32Array>(src: T, size: number): T {
  const out = new (src.constructor as new (n: number) => T)(size);
  out.set(src.subarray(0, Math.min(src.length, size)));
  return out;
}

export function pickState(rng: () => number): number {
  let r = rng() * STATE_WEIGHT_TOTAL;
  for (let s = 0; s < STATE_PROFILE.length; s++) {
    r -= STATE_PROFILE[s].weight;
    if (r <= 0) return s;
  }
  return GLIDE;
}

export function stateDuration(state: number, rng: () => number): number {
  const p = STATE_PROFILE[state];
  return p.min + (p.max - p.min) * rng();
}

/**
 * Grows or shrinks the flock to `count`, keeping every existing agent where it
 * is. A new agent's start depends only on the seed and its own index, so
 * dragging Count up and back down returns the same fish rather than a fresh
 * school.
 */
export function resizeFlock(state: FlockState, count: number, params: FlockParams): void {
  const n = Math.max(0, Math.min(MAX_AGENTS, Math.floor(count)));
  if (n > state.capacity) {
    const cap = Math.max(n, Math.ceil(state.capacity * 1.5));
    state.pos = grow(state.pos, cap * 3);
    state.dir = grow(state.dir, cap * 3);
    state.speed = grow(state.speed, cap);
    state.speedMul = grow(state.speedMul, cap);
    state.turnMul = grow(state.turnMul, cap);
    state.reactMul = grow(state.reactMul, cap);
    state.wander = grow(state.wander, cap);
    state.wanderPitch = grow(state.wanderPitch, cap);
    state.swimState = grow(state.swimState, cap);
    state.stateTimer = grow(state.stateTimer, cap);
    state.depthTarget = grow(state.depthTarget, cap);
    state.depthTimer = grow(state.depthTimer, cap);
    state.roll = grow(state.roll, cap);
    state.phase = grow(state.phase, cap);
    state.callDelay = grow(state.callDelay, cap);
    state.callLeft = grow(state.callLeft, cap);
    state.scatterLeft = grow(state.scatterLeft, cap);
    state.agentCell = grow(state.agentCell, cap);
    state.cellAgents = grow(state.cellAgents, cap);
    state.capacity = cap;
  }
  const { boundsCenter: c, boundsSize: s } = params;
  for (let i = state.count; i < n; i++) {
    const rng = createPRNG(Math.floor(params.seed) * 7919 + i * 104729 + 17);
    state.rng[i] = rng;
    const b = i * 3;
    state.pos[b] = c.x + (rng() - 0.5) * s.x * 0.8;
    state.pos[b + 1] = c.y + (rng() - 0.5) * s.y * 0.8;
    state.pos[b + 2] = c.z + (rng() - 0.5) * s.z * 0.8;
    const yaw = rng() * Math.PI * 2;
    state.dir[b] = Math.cos(yaw);
    state.dir[b + 1] = 0;
    state.dir[b + 2] = Math.sin(yaw);
    const v = params.variation;
    state.speedMul[i] = 1 + (rng() * 2 - 1) * 0.35 * v;
    state.turnMul[i] = 1 + (rng() * 2 - 1) * 0.4 * v;
    state.reactMul[i] = 1 + (rng() * 2 - 1) * 0.5 * v;
    state.speed[i] = params.speed * state.speedMul[i];
    state.wander[i] = 0;
    state.wanderPitch[i] = 0;
    state.swimState[i] = GLIDE;
    state.stateTimer[i] = rng() * STATE_PROFILE[GLIDE].max;
    state.depthTarget[i] = state.pos[b + 1];
    state.depthTimer[i] = rng() * 6;
    state.roll[i] = 0;
    state.phase[i] = rng() * Math.PI * 2;
    state.callDelay[i] = -1;
    state.callLeft[i] = 0;
    state.scatterLeft[i] = 0;
  }
  state.count = n;
  state.rng.length = Math.max(state.rng.length, n);
}

/** Starts a call: every agent answers after its own delay, nearer and more reactive ones first. */
export function callFlock(state: FlockState, point: Vec3, params: FlockParams): void {
  state.callPoint = { x: point.x, y: point.y, z: point.z };
  const reach = Math.max(1e-3, Math.hypot(params.boundsSize.x, params.boundsSize.z));
  for (let i = 0; i < state.count; i++) {
    const b = i * 3;
    const d = Math.hypot(state.pos[b] - point.x, state.pos[b + 2] - point.z) / reach;
    const delay = params.callSpread * (0.5 * d + 0.5 * state.rng[i]()) / Math.max(0.2, state.reactMul[i]);
    state.callDelay[i] = delay;
  }
}

/** Scatters the flock away from `point`, each agent in a short burst. */
export function scatterFlock(state: FlockState, point: Vec3): void {
  state.scatterPoint = { x: point.x, y: point.y, z: point.z };
  for (let i = 0; i < state.count; i++) {
    state.scatterLeft[i] = 0.8 + 0.6 * state.rng[i]();
    state.callDelay[i] = -1;
    state.callLeft[i] = 0;
    state.swimState[i] = BURST;
    state.stateTimer[i] = state.scatterLeft[i];
  }
}

/** The flock's centre of mass, or the bounds' centre when empty. */
export function flockCentroid(state: FlockState, params: FlockParams): Vec3 {
  if (state.count === 0) return { ...params.boundsCenter };
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < state.count; i++) {
    x += state.pos[i * 3];
    y += state.pos[i * 3 + 1];
    z += state.pos[i * 3 + 2];
  }
  return { x: x / state.count, y: y / state.count, z: z / state.count };
}
