import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { stepDampedSpring } from "../springDamper";
import { clockInput, numberInput } from "./object";

interface SquashState {
  prevPos?: THREE.Vector3;
  lastTime?: number;
  lastDir?: THREE.Vector3;
  /**
   * Last measured speed, normalized against Max Speed. The *speed* is cached
   * rather than the stretch factor so that turning Intensity while paused
   * still changes the deformation — the factor is derived from both, every
   * call.
   */
  lastSpeed?: number;
  /**
   * The damped-spring's own position and velocity, chasing `lastSpeed` as its
   * target — separate from `lastSpeed` itself so Smoothing can lag behind a
   * speed change instead of snapping to it. Signed and unclamped-past-target:
   * an underdamped spring (Bounciness > 0) legitimately overshoots past 0 when
   * the target drops suddenly, and *that* overshoot — the spring's position
   * running momentarily negative — is what reads as a squash on impact.
   */
  springValue?: number;
  springVelocity?: number;
}

const squashStateCache = createNodeCache<SquashState>();

function getSquashState(nodeId: string): SquashState {
  let state = squashStateCache.get(nodeId);
  if (!state) {
    state = {};
    squashStateCache.set(nodeId, state);
  }
  return state;
}

const squashGroupCache = createNodeCache<THREE.Group>();

function getSquashGroup(nodeId: string): THREE.Group {
  let group = squashGroupCache.get(nodeId);
  if (!group) {
    group = new THREE.Group();
    group.userData.nodeId = nodeId;
    squashGroupCache.set(nodeId, group);
  }
  return group;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Squash & Stretch Node — automatic, velocity-driven deformation. The object is
 * stretched along its direction of motion (and squashed perpendicularly,
 * volume-preserving) proportionally to its speed, with a single Intensity knob.
 * Wire `time` from the clock so the node can measure per-frame velocity; the
 * deformation settles back to identity the moment the object stops.
 *
 * Smoothing/Bounciness run the stretch amount through a damped spring instead
 * of applying the speed-derived target instantly. Both default to 0, which
 * collapses the spring to a direct pass-through — byte-identical to this
 * node's behaviour before they existed. Dialling in Bounciness makes that
 * spring underdamped, so it doesn't just lag the target, it *overshoots* past
 * it — and since the target is "stretch amount," overshooting past a target
 * that just dropped to 0 (a sudden deceleration) means the spring swings
 * negative for a moment. A negative stretch amount is a squash: compressed
 * along the direction of travel, bulged perpendicular, same volume-preserving
 * math as the stretch case. That single mechanism is deliberately what
 * produces the "hard stop squashes the object" look, rather than a second,
 * separate acceleration-triggered code path.
 */
export const SQUASH_STRETCH_NODE: NodeDefinition = {
  type: "modifier/squash-stretch",
  label: "Squash & Stretch",
  category: "deform",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "time", label: "Time", type: "value" },
    { id: "intensity", label: "Intensity", type: "value" },
    { id: "maxSpeed", label: "Max Speed", type: "value" },
    { id: "smoothing", label: "Smoothing", type: "value" },
    { id: "bounciness", label: "Bounciness", type: "value" },
  ],
  outputs: [{ id: "geometry", label: "Geometry", type: "geometry" }],
  defaultParams: {
    time: 0,
    intensity: 0.6,
    maxSpeed: 3,
    smoothing: 0,
    bounciness: 0,
  },
  dynamicParamFields: () => [
    // Explicit group on every field: without one, ParamPanel's fallback
    // grouping heuristic (getGroupName) catches "intensity" by substring
    // match and silently files it under "Light Settings" — this node has
    // nothing to do with lights.
    { id: "time", label: "Time", kind: "number", step: 0.05, group: "Squash & Stretch" },
    { id: "intensity", label: "Intensity (0–1)", kind: "number", step: 0.05, group: "Squash & Stretch" },
    { id: "maxSpeed", label: "Max Speed (units/s)", kind: "number", step: 0.5, group: "Squash & Stretch" },
    { id: "smoothing", label: "Smoothing (0 = instant)", kind: "number", step: 0.05, group: "Squash & Stretch" },
    {
      id: "bounciness",
      label: "Bounciness (overshoot → squash on stop)",
      kind: "number",
      step: 0.05,
      group: "Squash & Stretch",
    },
  ],
  evaluate: (inputs, params, ctx) => {
    const group = getSquashGroup(ctx.nodeId);
    const state = getSquashState(ctx.nodeId);
    const object = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;

    const time = clockInput(inputs, params, ctx);
    const intensity = clamp01(numberInput(inputs.intensity, params.intensity, 0.6));
    const maxSpeed = Math.max(0.01, numberInput(inputs.maxSpeed, params.maxSpeed, 3));

    group.clear();
    if (!object) return { geometry: group };
    group.add(object);

    object.updateWorldMatrix(true, false, true);
    const pos = new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);

    // clone, not the cached instance: `dir.copy(...)` below would otherwise
    // rewrite the cache in place before it has been read.
    const dir = state.lastDir ? state.lastDir.clone() : new THREE.Vector3(0, 1, 0);
    // Re-evaluating the same instant must be a no-op, so the speed carries over
    // by default. The editor and the camera-preview pane evaluate this node
    // once each per frame off the same clock: the second pass saw
    // `time === lastTime`, concluded "not moving", and reset the deformation to
    // identity — on the Group *both* panes share, so the squash was wiped every
    // frame and the node did nothing at all in split view.
    let normalized = state.lastSpeed ?? 0;

    const rewound = state.lastTime !== undefined && time < state.lastTime - 0.5;
    let dt = 0;
    if (rewound || state.lastTime === undefined || !state.prevPos) {
      // First frame, or a real scrub backwards: reseed rather than measure a
      // velocity across the jump.
      normalized = 0;
      state.prevPos = pos.clone();
      state.lastTime = time;
      state.springValue = 0;
      state.springVelocity = 0;
    } else if (time > state.lastTime) {
      dt = time - state.lastTime;
      const vel = new THREE.Vector3().subVectors(pos, state.prevPos).divideScalar(dt);
      const speed = vel.length();
      if (speed > 1e-6) dir.copy(vel).normalize();
      normalized = Math.min(1, speed / maxSpeed);
      state.prevPos = pos.clone();
      state.lastTime = time;
    }

    state.lastDir = dir.clone();
    state.lastSpeed = normalized;

    const smoothing = clamp01(numberInput(inputs.smoothing, params.smoothing, 0));
    const bounciness = clamp01(numberInput(inputs.bounciness, params.bounciness, 0));

    // Smoothing 0 is a direct pass-through — identical to this node before
    // the spring existed. Above 0, `normalized` becomes the spring's target
    // instead of the stretch amount itself, and the spring — not the target —
    // drives the deformation. See the node-level doc comment for why letting
    // it go underdamped (Bounciness) is the whole squash-on-impact mechanism.
    let stretchAmount = normalized;
    if (smoothing > 0) {
      const spring = stepDampedSpring(
        { value: state.springValue ?? normalized, velocity: state.springVelocity ?? 0 },
        normalized,
        dt,
        smoothing,
        bounciness,
      );
      state.springValue = spring.value;
      state.springVelocity = spring.velocity;
      stretchAmount = spring.value;
    } else {
      state.springValue = normalized;
      state.springVelocity = 0;
    }

    // stretchFactor along motion; volume-preserving inverse sideways.
    // `stretchAmount` can go negative — an underdamped spring overshooting
    // past a target that just dropped to 0 — and a negative amount here is
    // exactly a squash: compressed along the direction of travel, bulged
    // perpendicular, same math as the positive/stretch case below.
    const factor = Math.max(0.15, 1 + intensity * 0.5 * stretchAmount);

    if (Math.abs(factor - 1) < 1e-4) {
      group.matrix.identity();
      group.matrixAutoUpdate = false;
      return { geometry: group };
    }

    // Orthonormal basis built on the motion direction.
    const ref = Math.abs(dir.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const v = new THREE.Vector3().crossVectors(dir, ref).normalize();
    const w = new THREE.Vector3().crossVectors(dir, v).normalize();
    const inv = 1 / Math.sqrt(factor);

    const U = new THREE.Matrix4().makeBasis(dir, v, w);
    const D = new THREE.Matrix4().makeScale(factor, inv, inv);
    const Uinv = new THREE.Matrix4().copy(U).invert();
    const S = new THREE.Matrix4().multiplyMatrices(U, D).multiply(Uinv);

    // Pin the deformation at the object's world origin so it deforms in place.
    const T = new THREE.Matrix4().makeTranslation(pos.x, pos.y, pos.z);
    const Tneg = new THREE.Matrix4().makeTranslation(-pos.x, -pos.y, -pos.z);

    group.matrixAutoUpdate = false;
    group.matrix.multiplyMatrices(T, S).multiply(Tneg);

    return { geometry: group };
  },
};
