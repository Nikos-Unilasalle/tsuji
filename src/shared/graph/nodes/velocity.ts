import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { clockInput } from "./object";

interface VelocityState {
  prevPos?: THREE.Vector3;
  lastTime?: number;
  /** Carried over on a same-instant re-evaluate (see Squash & Stretch's identical note) rather than recomputed as 0 — the editor and camera-preview pane both evaluate this node once per frame off the same clock. */
  lastSpeed: number;
  lastVelocity: THREE.Vector3;
}

const velocityCache = createNodeCache<VelocityState>();

function getState(nodeId: string): VelocityState {
  let state = velocityCache.get(nodeId);
  if (!state) {
    state = { lastSpeed: 0, lastVelocity: new THREE.Vector3() };
    velocityCache.set(nodeId, state);
  }
  return state;
}

/**
 * Velocity — measures how fast (and which way) a Matrix's position is
 * moving, frame to frame. The same measurement Squash & Stretch does
 * internally, pulled out as its own reusable node: wire an object's Matrix
 * output in, get a Speed and Velocity Vector out, and drive anything with
 * it — Spring's Target for a wobble-on-stop effect, an emission rate, a
 * material's emissive intensity, whatever wants "how fast is this moving"
 * as a plain number instead of writing that measurement over again.
 */
export const VELOCITY_NODE: NodeDefinition = {
  type: "math/velocity",
  label: "Velocity",
  category: "time",
  inputs: [
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "time", label: "Time", type: "value" },
  ],
  outputs: [
    { id: "speed", label: "Speed (units/s)", type: "value" },
    { id: "velocity", label: "Velocity Vector", type: "vector" },
  ],
  defaultParams: { time: 0 },
  paramFields: [],
  evaluate: (inputs, params, ctx) => {
    const state = getState(ctx.nodeId);
    const time = clockInput(inputs, params, ctx);

    const matrix = inputs.matrix instanceof THREE.Matrix4 ? inputs.matrix : new THREE.Matrix4();
    const pos = new THREE.Vector3().setFromMatrixPosition(matrix);

    const rewound = state.lastTime !== undefined && time < state.lastTime - 0.5;
    if (rewound || state.lastTime === undefined || !state.prevPos) {
      // First frame, or a real scrub backwards: reseed rather than measure
      // a velocity across the jump.
      state.prevPos = pos.clone();
      state.lastTime = time;
      state.lastSpeed = 0;
      state.lastVelocity.set(0, 0, 0);
    } else if (time > state.lastTime) {
      const dt = time - state.lastTime;
      const vel = new THREE.Vector3().subVectors(pos, state.prevPos).divideScalar(dt);
      state.lastVelocity.copy(vel);
      state.lastSpeed = vel.length();
      state.prevPos = pos.clone();
      state.lastTime = time;
    }
    // time === state.lastTime (a same-instant re-evaluate): fall through
    // with the previous measurement unchanged, same reasoning as Squash &
    // Stretch — recomputing here would read "not moving" every second time
    // split view evaluates this frame and wipe a real, ongoing velocity.

    return { speed: state.lastSpeed, velocity: state.lastVelocity.clone() };
  },
};
