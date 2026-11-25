import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { objectWorldPosition } from "../objectPosition";
import { clockInput, numberInput } from "./object";

interface TrailSample {
  t: number;
  x: number;
  y: number;
  z: number;
}

interface TrailState {
  samples: TrailSample[];
  lastTime?: number;
}

const trailCache = createNodeCache<TrailState>();

function getTrailState(nodeId: string): TrailState {
  let state = trailCache.get(nodeId);
  if (!state) {
    state = { samples: [] };
    trailCache.set(nodeId, state);
  }
  return state;
}

/**
 * Trail Node — samples an animated object's world position over time and hands
 * back the recent path as a list of world points.
 *
 * It draws nothing itself. The path goes to Curve from Points (then Curve to
 * Line / Curve to Mesh, or a Spawner) so the look — width, dashes, taper,
 * material — is chosen by the nodes that already own those decisions, instead
 * of being duplicated as a second, weaker set of line controls here.
 */
export const TRAIL_NODE: NodeDefinition = {
  type: "structure/trail",
  label: "Trail",
  category: "fx",
  inputs: [
    // NOT owns: the trail only *reads* the object's position, like a Look At
    // target — declaring ownership would yank the source object out of the
    // scene whenever it isn't merged somewhere else too.
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "time", label: "Time", type: "value" },
    { id: "history", label: "History (s)", type: "value" },
    { id: "segments", label: "Segments", type: "value" },
  ],
  outputs: [{ id: "points", label: "Points (World)", type: "list" }],
  defaultParams: {
    time: 0,
    history: 2,
    segments: 96,
  },
  dynamicParamFields: () => [
    { id: "time", label: "Time", kind: "number", step: 0.05 },
    { id: "history", label: "History (s)", kind: "number", step: 0.1 },
    { id: "segments", label: "Segments", kind: "number", step: 8 },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getTrailState(ctx.nodeId);

    const object = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    const time = clockInput(inputs, params, ctx);
    const history = Math.max(0.05, numberInput(inputs.history, params.history, 2));
    const segments = Math.max(3, Math.min(400, Math.round(numberInput(inputs.segments, params.segments, 96))));

    if (!object) return { points: [] };

    // Not `setFromMatrixPosition(object.matrixWorld)`: what arrives on the
    // wire is usually a wrapper Group sitting at the origin whose child
    // carries the pose (Geometry Transform, Set Instance Transform, Squash &
    // Stretch all return one), and matrixWorld is stale mid-evaluation
    // anyway. Both traps are what objectWorldPosition exists for — without
    // it the trail sampled (0,0,0) every frame and drew nothing at all.
    const pos = objectWorldPosition(object);

    // Time went backward (scrub / export restart): start the trail afresh.
    // The threshold is deliberately loose — the editor and output panes both
    // evaluate this node with their own clocks, so the shared state sees
    // small interleaved backward steps every frame; only a real rewind
    // (> 0.5s) wipes the trail, otherwise the reset would empty it forever.
    if (state.lastTime !== undefined && time < state.lastTime - 0.5) {
      state.samples = [];
    }
    state.lastTime = time;

    // Drop anything outside the window. `s.t <= time` is not redundant with the
    // age test: a small scrub backwards doesn't trip the rewind reset above, and
    // a sample ahead of the playhead has a *negative* age, which passes the age
    // test happily — the trail used to keep drawing the path still to come.
    if (state.samples.length > 0) {
      const oldest = state.samples[0];
      const newest = state.samples[state.samples.length - 1];
      if (time - oldest.t > history || newest.t > time) {
        state.samples = state.samples.filter((s) => s.t <= time && time - s.t <= history);
      }
    }

    // Append a sample only when time actually advanced.
    if (state.samples.length === 0 || time - state.samples[state.samples.length - 1].t > 1e-4) {
      state.samples.push({ t: time, x: pos.x, y: pos.y, z: pos.z });
    }
    if (state.samples.length > segments) {
      state.samples.splice(0, state.samples.length - segments);
    }

    return { points: state.samples.map((s) => new THREE.Vector3(s.x, s.y, s.z)) };
  },
};
