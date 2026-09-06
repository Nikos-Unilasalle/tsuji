import * as THREE from "three";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { getUnusedAxes } from "./vector";
import { NodeDefinition } from "../types";

const ZERO = new THREE.Vector3(0, 0, 0);
const ONE = new THREE.Vector3(1, 1, 1);

export function asVector3(v: unknown, fallback: THREE.Vector3): THREE.Vector3 {
  if (v instanceof THREE.Vector3) return v;
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const x = Number(obj.x);
    const y = Number(obj.y);
    const z = Number(obj.z);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      return new THREE.Vector3(x, y, z);
    }
  }
  if (Array.isArray(v)) {
    const x = Number(v[0]);
    const y = Number(v[1]);
    const z = Number(v[2]);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      return new THREE.Vector3(x, y, z);
    }
  }
  return fallback;
}

/**
 * Which axes were disabled in a producing Compose Vector node, if any. A
 * disabled axis means "leave this property at its identity value" — 0 for a
 * location/rotation axis, 1 for a scale axis. Tracked off-band so a real,
 * wanted value on a legitimately-used axis (e.g. scale -1 for a flip, or
 * z = -1 for a location) is never mistaken for an unused axis.
 */
function isUnused(v: THREE.Vector3, axis: string): boolean {
  return getUnusedAxes(v).includes(axis);
}

export function resolveLocationVector(v: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(
    isUnused(v, "x") ? 0 : v.x,
    isUnused(v, "y") ? 0 : v.y,
    isUnused(v, "z") ? 0 : v.z,
  );
}

export function resolveRotationVector(v: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(
    isUnused(v, "x") ? 0 : v.x,
    isUnused(v, "y") ? 0 : v.y,
    isUnused(v, "z") ? 0 : v.z,
  );
}

export function resolveScaleVector(v: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(
    isUnused(v, "x") ? 1 : v.x,
    isUnused(v, "y") ? 1 : v.y,
    isUnused(v, "z") ? 1 : v.z,
  );
}

/** location/rotation(Euler, radians)/scale -> a single composed Matrix4 — the LSR-to-matrix convention every transform-producing node in this file shares. */
export function composeTransform(location: THREE.Vector3, rotation: THREE.Vector3, scale: THREE.Vector3): THREE.Matrix4 {
  const loc = resolveLocationVector(location);
  const rot = resolveRotationVector(rotation);
  const scl = resolveScaleVector(scale);
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot.x, rot.y, rot.z));
  return new THREE.Matrix4().compose(loc, quaternion, scl);
}

/**
 * Where a parent's rotation or scale turns and grows the child from.
 *
 *   "parent" — the parent's own origin, the plain scene-graph rule: growing
 *              the parent pushes the child away from it, turning the parent
 *              swings the child around it. Blender and Three.js parenting.
 *   "self"   — the child's own origin. The child still follows every move of
 *              the parent and still takes its rotation and scale *amounts*,
 *              but applies them in place, so it grows on the spot and spins
 *              where it stands instead of orbiting.
 *   "none"   — not taken at all; the child keeps its own rotation or scale.
 */
export type InheritPivot = "parent" | "self" | "none";

export interface InheritModes {
  rotation: InheritPivot;
  scale: InheritPivot;
}

function asInheritPivot(v: unknown): InheritPivot {
  return v === "self" || v === "none" ? v : "parent";
}

/** The two inherit modes off a node's params, defaulting to plain parenting. */
export function readInheritModes(params?: Record<string, unknown>): InheritModes {
  return {
    rotation: asInheritPivot(params?.inheritRotation),
    scale: asInheritPivot(params?.inheritScale),
  };
}

/**
 * `final = parent(wiredMatrix) × local(location/rotation/scale)` — for a node
 * that owns its own initial pose (an object or light's native
 * location/rotation/scale params) but still accepts an incoming `matrix` to
 * move that pose without cancelling it.
 *
 * Parent-first, exactly the scene-graph convention Blender and Three.js use:
 * the wired matrix acts in the frame *outside* the object, and the object's
 * own params stay its untouched local pose. Wiring one object's Matrix output
 * into another's Matrix input therefore parents the second to the first, which
 * is what the wire looks like it should do.
 *
 * The reverse order (`local × parent`) applies the wire *inside* the object's
 * own rotated frame, so a child rotated -90° turns an incoming Z translation
 * into a Y one — the wire stops behaving like a parent the moment the child
 * has any orientation of its own.
 *
 * `params` carries the two inherit modes (see InheritPivot). Both default to
 * "parent", which takes the identity-fast-path below and composes exactly as
 * the paragraph above describes — every existing scene is untouched. Moving a
 * channel to "self" splits the parent apart and re-applies that half *after*
 * the child's own translation, which is the whole difference: the child's
 * position stops being swept along by the parent's rotation and scale, so it
 * turns and grows about itself while still following the parent around.
 */
export function composeNativeMatrix(
  wiredMatrix: unknown,
  location: unknown,
  rotation: unknown,
  scale: unknown,
  params?: Record<string, unknown>,
): THREE.Matrix4 {
  return composeNativeMatrixWithPivot(wiredMatrix, location, rotation, scale, params?.pivot, params);
}

/**
 * Splits the parent into position / rotation / scale and re-assembles the
 * whole transform around the child's own translation:
 *
 *   parentPos × [parent-pivot halves] × childTranslation × [self-pivot halves] × childRotScale
 *
 * A half placed before the child's translation sweeps that translation along
 * with it (orbit, push away); placed after, it acts where the child already
 * stands. "none" drops the half entirely. The parent's position is always
 * inherited — that is what following a parent means, and it is the part that
 * was never in question.
 */
function applyInherited(
  parent: THREE.Matrix4,
  localTranslation: THREE.Matrix4,
  localRotScale: THREE.Matrix4,
  inherit: InheritModes,
): THREE.Matrix4 {
  const pPos = new THREE.Vector3();
  const pQuat = new THREE.Quaternion();
  const pScale = new THREE.Vector3();
  parent.decompose(pPos, pQuat, pScale);

  const parentRotation = new THREE.Matrix4().makeRotationFromQuaternion(pQuat);
  const parentScale = new THREE.Matrix4().makeScale(pScale.x, pScale.y, pScale.z);

  const out = new THREE.Matrix4().makeTranslation(pPos.x, pPos.y, pPos.z);
  // Rotation before scale on each side, the order plain parenting already used.
  if (inherit.rotation === "parent") out.multiply(parentRotation);
  if (inherit.scale === "parent") out.multiply(parentScale);
  out.multiply(localTranslation);
  if (inherit.rotation === "self") out.multiply(parentRotation);
  if (inherit.scale === "self") out.multiply(parentScale);
  return out.multiply(localRotScale);
}

/**
 * Same contract as composeNativeMatrix, but rotation/scale pivot around an
 * arbitrary point instead of always the node's local origin — for geometry
 * whose own origin isn't where the user wants to rotate/scale from. An
 * imported .OBJ is the chief case: the format has no pivot concept at all,
 * so wherever the exporting app happened to leave (0,0,0) is where a plain
 * Transform would pivot from, and that's rarely the base/handle/center the
 * artist actually modeled around. Same translate-to-origin /
 * rotate-and-scale / translate-back-plus-offset formula as
 * PIVOT_TRANSFORM_NODE below, just producing a native base matrix instead of
 * modifying an already-composed one.
 */
export function composeNativeMatrixWithPivot(
  wiredMatrix: unknown,
  location: unknown,
  rotation: unknown,
  scale: unknown,
  pivot: unknown,
  params?: Record<string, unknown>,
): THREE.Matrix4 {
  const parent = wiredMatrix instanceof THREE.Matrix4 ? wiredMatrix : new THREE.Matrix4();
  const loc = asVector3(location, ZERO);
  const rot = asVector3(rotation, ZERO);
  const scl = asVector3(scale, ONE);
  const piv = asVector3(pivot, ZERO);

  const mPivotInv = new THREE.Matrix4().makeTranslation(-piv.x, -piv.y, -piv.z);
  const mRotScale = composeTransform(ZERO, rot, scl);
  const mPivotLoc = new THREE.Matrix4().makeTranslation(piv.x + loc.x, piv.y + loc.y, piv.z + loc.z);

  const inherit = readInheritModes(params);
  if (inherit.rotation === "parent" && inherit.scale === "parent") {
    const local = new THREE.Matrix4().multiply(mPivotLoc).multiply(mRotScale).multiply(mPivotInv);
    return new THREE.Matrix4().multiplyMatrices(parent, local);
  }

  // The pivot offset rides with the node's own rotation/scale rather than with
  // its translation: it is the child's business where it turns from, and an
  // inherited half must land outside it, not between it and the geometry.
  const localRotScale = new THREE.Matrix4().multiply(mRotScale).multiply(mPivotInv);
  return applyInherited(parent, mPivotLoc, localRotScale, inherit);
}

/**
 * The flagship node — almost everything else in a scene ends up feeding
 * this one. location/scale/rotate in, a single composed Matrix out, matching
 * Blender's LSR-to-matrix convention. Rotation travels as a Vector of Euler
 * angles (radians) rather than a dedicated quaternion socket type — simpler
 * type system, and gimbal lock is not a practical concern for VJ-scale
 * single-axis-at-a-time animation.
 */
export const TRANSFORM_NODE: NodeDefinition = {
  type: "transform",
  label: "Compose Matrix",
  category: "compose",
  inputs: [
    { id: "location", label: "Location", type: "vector" },
    { id: "rotation", label: "Rotation", type: "vector" },
    { id: "scale", label: "Scale", type: "vector" },
  ],
  outputs: [{ id: "matrix", label: "Matrix", type: "matrix" }],
  defaultParams: {
    location: ZERO.clone(),
    rotation: ZERO.clone(),
    scale: ONE.clone(),
    useLOCATION: true,
    useROTATION: true,
    useSCALE: true,
  },
  paramFields: [
    { id: "location", label: "Location (fallback)", kind: "vector" },
    { id: "rotation", label: "Rotation (°, fallback)", kind: "vector", step: 1, degrees: true },
    { id: "scale", label: "Scale (fallback)", kind: "vector" },
  ],
  evaluate: (inputs, params) => {
    // A channel unchecked here is dropped entirely — even a wired input is
    // ignored — so this node can output e.g. "rotation + scale only, no
    // location", to parent an object's orientation to something without
    // also dragging its position along.
    const useLocation = params.useLOCATION !== undefined ? Boolean(params.useLOCATION) : true;
    const useRotation = params.useROTATION !== undefined ? Boolean(params.useROTATION) : true;
    const useScale = params.useSCALE !== undefined ? Boolean(params.useSCALE) : true;

    const location = useLocation ? asVector3(inputs.location, ZERO) : ZERO.clone();
    const rotation = useRotation ? asVector3(inputs.rotation, ZERO) : ZERO.clone();
    const scale = useScale ? asVector3(inputs.scale, ONE) : ONE.clone();
    return { matrix: composeTransform(location, rotation, scale) };
  },
};

/** Matrix -> separate location/rotation(Euler)/scale vectors — the inverse of Transform. */
export const DECOMPOSE_MATRIX_NODE: NodeDefinition = {
  type: "matrix/decompose",
  label: "Decompose Matrix",
  category: "compose",
  inputs: [{ id: "matrix", label: "Matrix", type: "matrix" }],
  outputs: [
    { id: "location", label: "Location", type: "vector" },
    { id: "rotation", label: "Rotation", type: "vector" },
    { id: "scale", label: "Scale", type: "vector" },
  ],
  defaultParams: {},
  evaluate: (inputs) => {
    const matrix = inputs.matrix instanceof THREE.Matrix4 ? inputs.matrix : new THREE.Matrix4();
    const location = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(location, quaternion, scale);
    const euler = new THREE.Euler().setFromQuaternion(quaternion);

    return { location, rotation: new THREE.Vector3(euler.x, euler.y, euler.z), scale };
  },
};

/** Matrix parent node — multiplies Parent Matrix * Child Matrix. */
export const PARENT_NODE: NodeDefinition = {
  type: "transform/parent",
  label: "Parent",
  category: "transform",
  inputs: [
    { id: "parent", label: "Parent", type: "matrix" },
    { id: "child", label: "Child", type: "matrix" },
  ],
  outputs: [{ id: "matrix", label: "Matrix", type: "matrix" }],
  defaultParams: {},
  evaluate: (inputs) => {
    const parent = inputs.parent instanceof THREE.Matrix4 ? inputs.parent : new THREE.Matrix4();
    const child = inputs.child instanceof THREE.Matrix4 ? inputs.child : new THREE.Matrix4();
    const matrix = new THREE.Matrix4().multiplyMatrices(parent, child);
    return { matrix };
  },
};

export function extractPositionFromInput(val: unknown, fallback: THREE.Vector3): THREE.Vector3 {
  if (val instanceof THREE.Vector3) return val.clone();
  // A Matrix4 is a perfectly good way to point at a place — it is what every
  // Transform node hands downstream. Without this it fell through to
  // asVector3, which sees no x/y/z on a matrix and quietly returned the
  // fallback, so a matrix-driven Target aimed at the origin instead.
  if (val instanceof THREE.Matrix4) return new THREE.Vector3().setFromMatrixPosition(val);
  if (val instanceof THREE.Object3D) {
    val.updateMatrixWorld(true);
    let target: THREE.Object3D = val;
    while (target instanceof THREE.Group && target.children.length > 0) {
      target = target.children[0];
      target.updateMatrixWorld(true);
    }
    const pos = new THREE.Vector3();
    target.getWorldPosition(pos);
    return pos;
  }
  return asVector3(val, fallback);
}

const groupCache = createNodeCache<THREE.Group>(disposeObject3D);
function getGroup(nodeId: string): THREE.Group {
  let group = groupCache.get(nodeId);
  if (!group) {
    group = new THREE.Group();
    groupCache.set(nodeId, group);
  }
  return group;
}

function cloneObject(source: THREE.Object3D): THREE.Object3D {
  const clone = source.clone(true);
  clone.matrixAutoUpdate = source.matrixAutoUpdate;
  clone.matrix.copy(source.matrix);
  clone.matrixWorldNeedsUpdate = true;
  return clone;
}

const DEFAULT_TARGET = new THREE.Vector3(0, 0, -1);
const DEFAULT_UP = new THREE.Vector3(0, 1, 0);

/** Look At node — transforms an incoming Geometry (or Eye position) to orient towards Target with an Up vector. */
export const LOOK_AT_NODE: NodeDefinition = {
  type: "transform/look-at",
  label: "Look At",
  category: "transform",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "target", label: "Target", type: "any" },
    { id: "up", label: "Up", type: "vector" },
    { id: "eye", label: "Eye / Pos", type: "any" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: { eye: ZERO.clone(), target: DEFAULT_TARGET.clone(), up: DEFAULT_UP.clone() },
  paramFields: [
    { id: "eye", label: "Eye (fallback)", kind: "vector" },
    { id: "target", label: "Target (fallback)", kind: "vector" },
    { id: "up", label: "Up (fallback)", kind: "vector" },
  ],
  evaluate: (inputs, params, ctx) => {
    const group = getGroup(ctx.nodeId);
    group.clear();

    const source = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    const defaultEye = source ? extractPositionFromInput(source, ZERO) : ZERO;
    const eye = extractPositionFromInput(inputs.eye, source ? defaultEye : asVector3(params?.eye, ZERO));
    const target = extractPositionFromInput(inputs.target, asVector3(params?.target, DEFAULT_TARGET));
    const up = asVector3(inputs.up, asVector3(params?.up, DEFAULT_UP));

    const matrix = new THREE.Matrix4().lookAt(eye, target, up);
    matrix.setPosition(eye);

    if (source) {
      const clone = cloneObject(source);
      const wrapper = new THREE.Group();
      wrapper.matrixAutoUpdate = false;
      wrapper.matrix.copy(matrix);
      wrapper.add(clone);
      group.add(wrapper);
    }

    return { geometry: group, matrix };
  },
};

/**
 * Matrix Transform node — transforms an existing base Matrix4 by applying
 * incremental translation (Location), rotation (Euler), and scaling (Scale).
 */
export const MATRIX_TRANSFORM_NODE: NodeDefinition = {
  type: "transform/matrix-transform",
  label: "Matrix Transform",
  category: "transform",
  inputs: [
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "location", label: "Location", type: "vector" },
    { id: "rotation", label: "Rotation", type: "vector" },
    { id: "scale", label: "Scale", type: "vector" },
  ],
  outputs: [{ id: "matrix", label: "Matrix", type: "matrix" }],
  defaultParams: { location: ZERO.clone(), rotation: ZERO.clone(), scale: ONE.clone() },
  paramFields: [
    { id: "location", label: "Location Offset", kind: "vector" },
    { id: "rotation", label: "Rotation Offset (°)", kind: "vector", step: 1, degrees: true },
    { id: "scale", label: "Scale Multiplier", kind: "vector" },
  ],
  evaluate: (inputs) => {
    const baseMatrix = inputs.matrix instanceof THREE.Matrix4 ? inputs.matrix : new THREE.Matrix4();
    const location = asVector3(inputs.location, ZERO);
    const rotation = asVector3(inputs.rotation, ZERO);
    const scale = asVector3(inputs.scale, ONE);
    const deltaMatrix = composeTransform(location, rotation, scale);

    const matrix = new THREE.Matrix4().multiplyMatrices(baseMatrix, deltaMatrix);
    return { matrix };
  },
};

/**
 * Transform Vector node — multiplies a 3D Vector by a Matrix4 transform.
 */
export const TRANSFORM_VECTOR_NODE: NodeDefinition = {
  type: "transform/transform-vector",
  label: "Transform Vector",
  category: "transform",
  inputs: [
    { id: "vector", label: "Vector", type: "vector" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  outputs: [{ id: "vector", label: "Vector", type: "vector" }],
  defaultParams: { vector: ZERO.clone() },
  paramFields: [{ id: "vector", label: "Vector (fallback)", kind: "vector" }],
  evaluate: (inputs) => {
    const v = asVector3(inputs.vector, ZERO);
    const m = inputs.matrix instanceof THREE.Matrix4 ? inputs.matrix : new THREE.Matrix4();
    return { vector: v.clone().applyMatrix4(m) };
  },
};

/**
 * Pivot Transform node — transforms an existing base Matrix4 (or identity)
 * by applying rotation, scale, and location offset relative to an arbitrary Pivot Point.
 */
export const PIVOT_TRANSFORM_NODE: NodeDefinition = {
  type: "transform/pivot",
  label: "Pivot Transform",
  category: "transform",
  inputs: [
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "pivot", label: "Pivot", type: "vector" },
    { id: "location", label: "Location", type: "vector" },
    { id: "rotation", label: "Rotation", type: "vector" },
    { id: "scale", label: "Scale", type: "vector" },
  ],
  outputs: [{ id: "matrix", label: "Matrix", type: "matrix" }],
  defaultParams: {
    pivot: ZERO.clone(),
    location: ZERO.clone(),
    rotation: ZERO.clone(),
    scale: ONE.clone(),
  },
  paramFields: [
    { id: "pivot", label: "Pivot Point", kind: "vector" },
    { id: "location", label: "Location Offset", kind: "vector" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true },
    { id: "scale", label: "Scale Multiplier", kind: "vector" },
  ],
  evaluate: (inputs) => {
    const baseMatrix = inputs.matrix instanceof THREE.Matrix4 ? inputs.matrix : new THREE.Matrix4();
    const pivot = asVector3(inputs.pivot, ZERO);
    const location = asVector3(inputs.location, ZERO);
    const rotation = asVector3(inputs.rotation, ZERO);
    const scale = asVector3(inputs.scale, ONE);

    const mPivotInv = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
    const mRotScale = composeTransform(ZERO, rotation, scale);
    const mPivotLoc = new THREE.Matrix4().makeTranslation(pivot.x + location.x, pivot.y + location.y, pivot.z + location.z);

    const deltaMatrix = new THREE.Matrix4()
      .multiply(mPivotLoc)
      .multiply(mRotScale)
      .multiply(mPivotInv);

    const matrix = new THREE.Matrix4().multiplyMatrices(baseMatrix, deltaMatrix);
    return { matrix };
  },
};

interface DelaySample {
  frame: number;
  matrix: THREE.Matrix4;
}

/**
 * Recorded poses, keyed by node and then by evaluation session.
 *
 * The outer key is the node id, so `disposeNodeCaches` can drop a deleted
 * Delay's history — a composite key would slip past it, and node ids are
 * stable across save/undo, so an old history would come back with the node.
 *
 * The inner key is the session. Several viewports evaluate the same graph on
 * their own clocks (editor pane, split preview, the offscreen export one), so
 * one shared buffer would take a sample per pane per frame and run the delay
 * several times too fast. Trail keeps its samples per node only, and its own
 * comment records the interleaving that causes.
 */
const delayCache = createNodeCache<Map<string, DelaySample[]>>();

function getDelayHistory(nodeId: string, sessionId: string): DelaySample[] {
  let bySession = delayCache.get(nodeId);
  if (!bySession) {
    bySession = new Map();
    delayCache.set(nodeId, bySession);
  }
  let samples = bySession.get(sessionId);
  if (!samples) {
    samples = [];
    bySession.set(sessionId, samples);
  }
  return samples;
}

/**
 * Blends two poses. Decomposed rather than lerped element by element:
 * interpolating the sixteen numbers directly shears a rotating matrix instead
 * of turning it.
 */
function blendMatrices(a: THREE.Matrix4, b: THREE.Matrix4, t: number): THREE.Matrix4 {
  const pa = new THREE.Vector3();
  const qa = new THREE.Quaternion();
  const sa = new THREE.Vector3();
  a.decompose(pa, qa, sa);
  const pb = new THREE.Vector3();
  const qb = new THREE.Quaternion();
  const sb = new THREE.Vector3();
  b.decompose(pb, qb, sb);
  return new THREE.Matrix4().compose(pa.lerp(pb, t), qa.slerp(qb, t), sa.lerp(sb, t));
}

/** The recorded pose at `frame`, blending the two samples either side of it. */
function sampleAt(samples: DelaySample[], frame: number): THREE.Matrix4 | null {
  if (samples.length === 0) return null;
  // Before anything recorded: the node has not been running long enough to
  // owe a delayed pose yet, so it holds at the oldest one it has.
  if (frame <= samples[0].frame) return samples[0].matrix.clone();
  const last = samples[samples.length - 1];
  if (frame >= last.frame) return last.matrix.clone();

  for (let i = 0; i < samples.length - 1; i++) {
    const s1 = samples[i];
    const s2 = samples[i + 1];
    if (frame >= s1.frame && frame <= s2.frame) {
      const span = s2.frame - s1.frame;
      if (span <= 0) return s1.matrix.clone();
      return blendMatrices(s1.matrix, s2.matrix, (frame - s1.frame) / span);
    }
  }
  return last.matrix.clone();
}

/**
 * Matrix Delay node — hands back the pose this matrix held a number of frames
 * ago, so one object can follow another at a lag.
 *
 * Wire a leader's Matrix through this into a follower's Matrix and the
 * follower trails it; chain several with rising delays for a train. A
 * fractional delay interpolates, which is what lets a row of followers sit at
 * 2.5, 5 and 7.5 frames back rather than snapping to whole frames.
 *
 * The history is recorded as the graph plays, rather than re-evaluating the
 * upstream chain at `frame - delay`: the upstream may itself be stateful (a
 * Trail, a Spring, a particle sim) and re-running those at an arbitrary past
 * time is not defined. The cost is that the delay has nothing to give until it
 * has watched those frames go by — playing from the start and exporting both
 * build the history in order, but dropping the playhead into the middle of a
 * scene passes the pose through undelayed until the buffer fills.
 */
export const MATRIX_DELAY_NODE: NodeDefinition = {
  type: "transform/delay",
  label: "Matrix Delay",
  category: "transform",
  inputs: [
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "frames", label: "Delay (frames)", type: "value" },
  ],
  outputs: [{ id: "matrix", label: "Matrix", type: "matrix" }],
  defaultParams: { frames: 6 },
  paramFields: [{ id: "frames", label: "Delay (frames)", kind: "number", step: 1 }],
  evaluate: (inputs, params, ctx) => {
    const incoming = inputs.matrix instanceof THREE.Matrix4 ? inputs.matrix : new THREE.Matrix4();
    const rawFrames = inputs.frames !== undefined ? Number(inputs.frames) : Number(params.frames);
    const frames = Math.max(0, Number.isFinite(rawFrames) ? rawFrames : 0);

    // No timeline frame to index by (a headless call) — nothing to delay
    // against, so pass the pose through rather than inventing a history.
    const now = ctx.currentFrame;
    if (frames === 0 || now === undefined || !Number.isFinite(now)) {
      return { matrix: incoming.clone() };
    }

    const samples = getDelayHistory(ctx.nodeId, ctx.sessionId ?? "default");

    // Scrubbing backwards leaves samples ahead of the playhead, which would
    // otherwise be read as the "past" once it moves forward again.
    while (samples.length > 0 && samples[samples.length - 1].frame > now) {
      samples.pop();
    }

    const newest = samples[samples.length - 1];
    if (!newest || newest.frame < now) {
      // Cloned on the way in: an upstream node that reuses one Matrix4 across
      // frames would otherwise rewrite every sample already recorded.
      samples.push({ frame: now, matrix: incoming.clone() });
    } else if (newest.frame === now) {
      // The same frame evaluated again (a redraw, another pane on this
      // session): update in place instead of stacking duplicates.
      newest.matrix.copy(incoming);
    }

    // Bounded to the window the delay can actually reach back into, plus slack
    // so the interpolation always has a sample on either side.
    const keep = Math.ceil(frames) + 2;
    if (samples.length > keep) samples.splice(0, samples.length - keep);

    // Cloned on the way out for the reason primitiveOutputs clones: a
    // downstream node mutating what it receives must not rewrite the history.
    return { matrix: sampleAt(samples, now - frames) ?? incoming.clone() };
  },
};

/**
 * Retrieve the pivot offset of a source object (from userData.pivot), or (0,0,0) if none is specified.
 */
export function getSourcePivot(obj: unknown): THREE.Vector3 {
  if (obj instanceof THREE.Object3D && obj.userData && obj.userData.pivot) {
    return asVector3(obj.userData.pivot, ZERO);
  }
  return ZERO;
}

/**
 * Preserves metadata, pivot, and pivot visibility from an input object onto a modifier's output object.
 */
export function preserveModifierUserData(
  outputObj: THREE.Object3D,
  inputObj: THREE.Object3D,
  srcMesh?: THREE.Mesh | null,
  nodeId?: string,
): void {
  const sourcePivot =
    (inputObj.userData && inputObj.userData.pivot ? getSourcePivot(inputObj) : null) ??
    (srcMesh && srcMesh.userData && srcMesh.userData.pivot ? getSourcePivot(srcMesh) : ZERO);
  const hasPivot = sourcePivot.lengthSq() > 1e-9;

  outputObj.userData = {
    ...inputObj.userData,
    ...(srcMesh?.userData ?? {}),
    ...(nodeId ? { nodeId } : {}),
  };

  if (hasPivot) {
    outputObj.userData.pivot = sourcePivot.clone();
  } else {
    delete outputObj.userData.pivot;
  }

  if (inputObj.userData?.showPivot || srcMesh?.userData?.showPivot) {
    outputObj.userData.showPivot = true;
  }
}

