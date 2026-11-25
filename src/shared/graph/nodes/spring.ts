import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { springCoefficients, stepDampedSpring, SpringState } from "../springDamper";
import { clockInput, numberInput } from "./object";
import { asVector3 } from "./transform";
import { writePointsToMesh } from "./pointsGeometry";
import { findFirstMesh } from "../meshRequired";

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

interface SpringNodeState {
  lastTime?: number;
  x: SpringState;
  y: SpringState;
  z: SpringState;
}

const springStateCache = createNodeCache<SpringNodeState>();

function getSpringState(nodeId: string, seed: THREE.Vector3): SpringNodeState {
  let state = springStateCache.get(nodeId);
  if (!state) {
    state = { x: { value: seed.x, velocity: 0 }, y: { value: seed.y, velocity: 0 }, z: { value: seed.z, velocity: 0 } };
    springStateCache.set(nodeId, state);
  }
  return state;
}

/**
 * Advances one axis's spring and folds in the same rewound/reseed handling
 * Squash & Stretch uses: a real scrub backwards (or the very first frame)
 * snaps straight to the target instead of springing across the jump, since
 * there's no meaningful "velocity" to integrate across a discontinuity.
 */
function advance(axis: SpringState, target: number, dt: number, rewound: boolean, smoothing: number, bounciness: number): SpringState {
  if (rewound) return { value: target, velocity: 0 };
  return stepDampedSpring(axis, target, dt, smoothing, bounciness);
}

/**
 * Spring — the same damped-spring integrator behind Squash & Stretch's
 * Smoothing/Bounciness, exposed on its own so any value or vector can chase
 * a moving target with lag and (optionally) overshoot: a camera easing
 * toward a target position, a UI value settling with a bit of bounce, a
 * light's intensity following a trigger without snapping. Unlike Squash &
 * Stretch this isn't derived from measured velocity — it springs directly
 * toward whatever's wired into Target.
 */
export const SPRING_NODE: NodeDefinition = {
  type: "math/spring",
  label: "Spring",
  category: "time",
  inputs: [
    { id: "target", label: "Target", type: "value" },
    { id: "time", label: "Time", type: "value" },
    { id: "smoothing", label: "Smoothing", type: "value" },
    { id: "bounciness", label: "Bounciness", type: "value" },
  ],
  outputs: [{ id: "value", label: "Value", type: "value" }],
  defaultParams: {
    time: 0,
    target: 0,
    smoothing: 0.4,
    bounciness: 0.3,
  },
  paramFields: [
    { id: "target", label: "Target (fallback)", kind: "number", step: 0.1, group: "Spring" },
    { id: "smoothing", label: "Smoothing (response speed)", kind: "number", step: 0.05, group: "Spring" },
    { id: "bounciness", label: "Bounciness (0 = no overshoot)", kind: "number", step: 0.05, group: "Spring" },
  ],
  evaluate: (inputs, params, ctx) => {
    const target = numberInput(inputs.target, params.target, 0);
    const state = getSpringState(ctx.nodeId, new THREE.Vector3(target, 0, 0));

    const time = clockInput(inputs, params, ctx);
    const smoothing = clamp01(numberInput(inputs.smoothing, params.smoothing, 0.4));
    const bounciness = clamp01(numberInput(inputs.bounciness, params.bounciness, 0.3));

    const rewound = state.lastTime !== undefined && time < state.lastTime - 0.5;
    const dt = state.lastTime === undefined || rewound ? 0 : Math.max(0, time - state.lastTime);
    const reseed = rewound || state.lastTime === undefined;
    state.lastTime = time;

    state.x = advance(state.x, target, dt, reseed, smoothing, bounciness);
    return { value: state.x.value };
  },
};

/**
 * Per-point spring state, held as flat typed arrays (3 lanes per point,
 * x/y/z interleaved) rather than the obvious `{value, velocity}[][]`.
 *
 * This mode routinely runs one independent spring per *vertex* of a real
 * mesh — an 80k-face OBJ is ~240k points, so the object-per-axis shape cost
 * ~720k live JS objects sitting in this cache, plus another ~720k garbage
 * objects every frame from the integrator returning fresh `{value,
 * velocity}` records. Two Float64Arrays hold exactly the same numbers with
 * zero per-point object overhead and no per-frame garbage at all, which is
 * the difference between "heavy mesh is slow" and "heavy mesh triggers a GC
 * death spiral" (see springDamper.ts for the divergence half of that story).
 *
 * `out` is likewise allocated once and mutated in place each frame: every
 * consumer of a points list reads it during the same evaluation that
 * produced it (Points to Mesh / this node's own write-back, the viewport's
 * handle sync), so there's nothing to preserve across frames — the same
 * reuse convention `writePointsToMesh` already uses for its cached Mesh.
 */
interface SpringPointsState {
  lastTime?: number;
  count: number;
  /** Current spring position, 3 per point (x,y,z interleaved). */
  values: Float64Array;
  /** Matching velocity lane for each entry of `values`. */
  velocities: Float64Array;
  /** Reused output vectors, one per point. */
  out: THREE.Vector3[];
}

const springPointsCache = createNodeCache<SpringPointsState>();

function getSpringPointsState(nodeId: string): SpringPointsState {
  let state = springPointsCache.get(nodeId);
  if (!state) {
    state = { count: 0, values: new Float64Array(0), velocities: new Float64Array(0), out: [] };
    springPointsCache.set(nodeId, state);
  }
  return state;
}

/** Reads x/y/z off a Vector3 or any plain `{x,y,z}` without allocating one (the non-allocating half of asVector3). */
function readPoint(raw: unknown, into: { x: number; y: number; z: number }): void {
  if (raw && typeof raw === "object") {
    const o = raw as { x?: unknown; y?: unknown; z?: unknown };
    const x = Number(o.x);
    const y = Number(o.y);
    const z = Number(o.z);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      into.x = x;
      into.y = y;
      into.z = z;
      return;
    }
  }
  into.x = 0;
  into.y = 0;
  into.z = 0;
}

const scratchPoint = { x: 0, y: 0, z: 0 };
/** Reused so the world->local matrix inversion doesn't allocate a Matrix4 per frame. */
const scratchInverse = new THREE.Matrix4();

/**
 * Springs each point in a list independently — the "Individual Points" mode
 * that lets Spring Vector drive a *subset* of a mesh (via Mesh to Points /
 * Points Selection / Points to Mesh) while the rest stays rigid. Mask is a
 * continuous 0-1 influence, not a binary switch: every point's spring is
 * always fully integrated (so a low-influence point still carries real
 * velocity/energy underneath), and the influence just blends the *output*
 * between the raw target (0 = rigid, exactly where Points Influence painted
 * it) and the full spring result (1) — a mid-value point visibly springs
 * with reduced amplitude, matching a painted gradient rather than snapping
 * in or out at a threshold.
 *
 * A point count change (the upstream mesh/selection changed shape) reseeds
 * every spring at its new target rather than trying to carry old state across
 * an index space that may no longer mean the same thing — a visible but rare
 * and honest discontinuity, versus silently misapplying stale velocity to
 * the wrong vertex.
 *
 * When `matrixWorld`/`inverse` are given, the whole local -> world -> spring
 * -> local round trip happens inside this one pass, reading straight from
 * the raw input objects and writing straight into the reused output vectors.
 * Done as separate `.map()` stages (the readable version) it cost four full
 * intermediate arrays of freshly-cloned Vector3s per frame; fused, it costs
 * none. Same math, same result, an order of magnitude less memory traffic on
 * exactly the meshes big enough to care.
 */
function springPoints(
  nodeId: string,
  rawTargets: unknown[],
  rawMask: unknown[] | null,
  time: number,
  smoothing: number,
  bounciness: number,
  matrixWorld: THREE.Matrix4 | null,
  inverse: THREE.Matrix4 | null,
): THREE.Vector3[] {
  const state = getSpringPointsState(nodeId);
  const count = rawTargets.length;

  const rewound = state.lastTime !== undefined && time < state.lastTime - 0.5;
  const dt = state.lastTime === undefined || rewound ? 0 : Math.max(0, time - state.lastTime);
  const countChanged = state.count !== count;
  const globalReseed = rewound || state.lastTime === undefined || countChanged;
  state.lastTime = time;

  if (countChanged) {
    state.count = count;
    state.values = new Float64Array(count * 3);
    state.velocities = new Float64Array(count * 3);
    const out = state.out;
    out.length = count;
    for (let i = 0; i < count; i++) if (!out[i]) out[i] = new THREE.Vector3();
  }

  const { values, velocities, out } = state;

  // Hoisted out of the inner loop: every point in this call shares one dt,
  // smoothing and bounciness, so the coefficients (and the substep schedule
  // that keeps Euler stable) are computed once for all of them.
  const { omega, zeta, substeps, stepDt } = springCoefficients(dt, smoothing, bounciness);
  const omegaSq = omega * omega;
  const damping = 2 * zeta * omega;
  const integrate = !globalReseed && dt > 0;

  // Matrix elements hoisted into locals — applying a Matrix4 to loose x/y/z
  // numbers inline avoids materializing a Vector3 per point just to call
  // .applyMatrix4() on it.
  const m = matrixWorld?.elements;
  const inv = inverse?.elements;

  for (let i = 0; i < count; i++) {
    readPoint(rawTargets[i], scratchPoint);
    let tx = scratchPoint.x;
    let ty = scratchPoint.y;
    let tz = scratchPoint.z;

    if (m) {
      const w = 1 / (m[3] * tx + m[7] * ty + m[11] * tz + m[15]);
      const wx = (m[0] * tx + m[4] * ty + m[8] * tz + m[12]) * w;
      const wy = (m[1] * tx + m[5] * ty + m[9] * tz + m[13]) * w;
      const wz = (m[2] * tx + m[6] * ty + m[10] * tz + m[14]) * w;
      tx = wx;
      ty = wy;
      tz = wz;
    }

    const b = i * 3;
    let vx = values[b];
    let vy = values[b + 1];
    let vz = values[b + 2];

    if (integrate) {
      let dx = velocities[b];
      let dy = velocities[b + 1];
      let dz = velocities[b + 2];
      for (let s = 0; s < substeps; s++) {
        dx += (omegaSq * (tx - vx) - damping * dx) * stepDt;
        dy += (omegaSq * (ty - vy) - damping * dy) * stepDt;
        dz += (omegaSq * (tz - vz) - damping * dz) * stepDt;
        vx += dx * stepDt;
        vy += dy * stepDt;
        vz += dz * stepDt;
      }
      velocities[b] = dx;
      velocities[b + 1] = dy;
      velocities[b + 2] = dz;
    } else if (globalReseed) {
      // First frame, a real scrub backwards, or a changed point count: snap
      // to the target rather than integrating across a discontinuity.
      vx = tx;
      vy = ty;
      vz = tz;
      velocities[b] = 0;
      velocities[b + 1] = 0;
      velocities[b + 2] = 0;
    }
    values[b] = vx;
    values[b + 1] = vy;
    values[b + 2] = vz;

    const influence = rawMask !== null ? clamp01(Number(rawMask[i] ?? 1)) : 1;
    let ox = tx + (vx - tx) * influence;
    let oy = ty + (vy - ty) * influence;
    let oz = tz + (vz - tz) * influence;

    if (inv) {
      const w = 1 / (inv[3] * ox + inv[7] * oy + inv[11] * oz + inv[15]);
      const lx = (inv[0] * ox + inv[4] * oy + inv[8] * oz + inv[12]) * w;
      const ly = (inv[1] * ox + inv[5] * oy + inv[9] * oz + inv[13]) * w;
      const lz = (inv[2] * ox + inv[6] * oy + inv[10] * oz + inv[14]) * w;
      ox = lx;
      oy = ly;
      oz = lz;
    }

    out[i].set(ox, oy, oz);
  }
  return out;
}

/**
 * Spring Vector — Spring's per-axis sibling, matching the Wiggle / Wiggle
 * Number / Wiggle Vector split this codebase already uses: one node for a
 * bare scalar, one for a Vector3, both sharing the same underlying math.
 * Each axis runs its own independent spring (a target that only moves in X
 * shouldn't perturb Y or Z), which is also why this can't just be Spring
 * called three times — three separate node instances would each need their
 * own Time wiring and wouldn't share a single Smoothing/Bounciness pair.
 */
export const SPRING_VECTOR_NODE: NodeDefinition = {
  type: "vector/spring",
  label: "Spring Vector",
  category: "time",
  inputs: [
    { id: "target", label: "Target", type: "vector" },
    // Wiring Points switches this node into "Individual Points" mode: Target
    // is ignored and every point in the list gets its own independent spring
    // instead. Mask (same length, 1 = spring / 0 = hold still) is what lets
    // only *some* of those points move — see springPoints' doc comment.
    { id: "points", label: "Points (Individual)", type: "list" },
    { id: "mask", label: "Influence (1=spring, 0=hold, continuous)", type: "list" },
    // The shortcut that makes "OBJ -> Points Selection -> Spring Vector"
    // work with no other nodes: wire Points Selection's own Geometry
    // passthrough in here alongside Points/Mask, and this node writes the
    // sprung result straight back into a mesh on its own Geometry output —
    // same round-trip Points to Mesh does, just folded in so the operator
    // never sees a points list at all. Points/Mask/Vector outputs still
    // update normally, for anyone who wants the raw values instead.
    //
    // Also switches the spring from local space to WORLD space: Points is
    // always in the mesh's own local space, which is constant for a static
    // mesh no matter how its Location/Rotation/Scale/wired Matrix animates —
    // springing there has nothing to react to. With Geometry wired, the
    // object's *current* world transform is folded in before springing and
    // divided back out afterward, so the selection genuinely lags/overshoots
    // behind the object's own motion (secondary motion / follow-through —
    // an antenna or a cloth corner trailing behind the body it's attached
    // to) while every unselected vertex still rides along perfectly rigid.
    { id: "geometry", label: "Geometry (optional passthrough)", type: "geometry" },
    { id: "time", label: "Time", type: "value" },
    { id: "smoothing", label: "Smoothing", type: "value" },
    { id: "bounciness", label: "Bounciness", type: "value" },
  ],
  outputs: [
    { id: "vector", label: "Vector", type: "vector" },
    { id: "points", label: "Points", type: "list" },
    { id: "geometry", label: "Geometry (when Geometry is wired)", type: "geometry" },
  ],
  defaultParams: {
    time: 0,
    target: new THREE.Vector3(0, 0, 0),
    smoothing: 0.4,
    bounciness: 0.3,
  },
  paramFields: [
    { id: "target", label: "Target (fallback)", kind: "vector", group: "Spring" },
    { id: "smoothing", label: "Smoothing (response speed)", kind: "number", step: 0.05, group: "Spring" },
    { id: "bounciness", label: "Bounciness (0 = no overshoot)", kind: "number", step: 0.05, group: "Spring" },
  ],
  evaluate: (inputs, params, ctx) => {
    const time = clockInput(inputs, params, ctx);
    const smoothing = clamp01(numberInput(inputs.smoothing, params.smoothing, 0.4));
    const bounciness = clamp01(numberInput(inputs.bounciness, params.bounciness, 0.3));

    if (Array.isArray(inputs.points)) {
      const rawTargets = inputs.points as unknown[];
      const rawMask = Array.isArray(inputs.mask) ? (inputs.mask as unknown[]) : null;

      // With Geometry wired, spring in WORLD space, not the mesh's own local
      // space: Points is always local (Mesh to Points / Points Selection's
      // convention), so a static local vertex position gives the spring
      // nothing to react to even while the *object* is animated (moved,
      // rotated, wiggled...) upstream — the whole point of wiring Geometry
      // in the first place is "let selected points lag/jiggle behind the
      // object's own motion while the rest stays rigid," and that motion
      // only shows up in the WORLD position, not the constant local one.
      // Springing in world space and converting back afterward is also what
      // keeps a masked-out (held) point exactly rigid with the object even
      // though it round-trips through world space too: local -> world ->
      // (held exactly at that same world target) -> local is the identity
      // transform for an unmoved point, by construction.
      const mesh = inputs.geometry instanceof THREE.Object3D ? findFirstMesh(inputs.geometry) : null;
      if (mesh) {
        const geomObj = inputs.geometry as THREE.Object3D;
        geomObj.updateMatrixWorld(true);
        const matrixWorld = mesh.matrixWorld;
        const inverse = scratchInverse.copy(matrixWorld).invert();

        // One fused pass does local -> world -> spring -> local; see
        // springPoints' doc comment for why it isn't three chained .map()s.
        const points = springPoints(ctx.nodeId, rawTargets, rawMask, time, smoothing, bounciness, matrixWorld, inverse);
        const geometry = writePointsToMesh(ctx.nodeId, geomObj, points, "Spring Vector");
        return { vector: points[0]?.clone() ?? new THREE.Vector3(0, 0, 0), points, geometry };
      }

      const points = springPoints(ctx.nodeId, rawTargets, rawMask, time, smoothing, bounciness, null, null);
      return { vector: points[0]?.clone() ?? new THREE.Vector3(0, 0, 0), points };
    }

    const target = asVector3(inputs.target ?? params.target, new THREE.Vector3(0, 0, 0));
    const state = getSpringState(ctx.nodeId, target);

    const rewound = state.lastTime !== undefined && time < state.lastTime - 0.5;
    const dt = state.lastTime === undefined || rewound ? 0 : Math.max(0, time - state.lastTime);
    state.lastTime = time;

    const reseed = rewound || state.lastTime === undefined;
    state.x = advance(state.x, target.x, dt, reseed, smoothing, bounciness);
    state.y = advance(state.y, target.y, dt, reseed, smoothing, bounciness);
    state.z = advance(state.z, target.z, dt, reseed, smoothing, bounciness);

    const vector = new THREE.Vector3(state.x.value, state.y.value, state.z.value);
    return { vector, points: [vector] };
  },
};
