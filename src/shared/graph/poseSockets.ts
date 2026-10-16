import * as THREE from "three";
import { getUnusedAxes } from "./nodes/vector";
import { GIZMO_SELECTABLE_TYPES } from "./transformLookup";
import {
  DEFAULT_ROTATION_MODE,
  applyWiredRotationAngle,
  readRotationMode,
  rotationToQuaternion,
  withRotationAngleSocket,
  withRotationModeFields,
} from "./rotationMode";
import type { SocketDef } from "./sockets";
import type { NodeDefinition } from "./types";

/**
 * Location, Rotation and Scale as input sockets on every object — the
 * Blender way of animating one: drive the object's own channels, and the
 * object turns and grows about its own origin.
 *
 * Before these, the only way in was the `matrix` input, which is a *parent*:
 * it acts outside the object, in the frame of the world origin, so a rotation
 * wired there swung the object around 0,0,0 instead of turning it in place.
 * That input stays (it is how one object follows another), labelled Parent so
 * it says what it does.
 *
 * Added here, once, rather than in each of the fifty-odd definitions: every
 * node that owns a native pose already reads `params.location/rotation/scale`
 * through composeNativeMatrix, so a wire only has to land in those params —
 * see applyPoseSockets, called by the evaluator.
 */
export const POSE_SOCKET_IDS = ["location", "rotation", "scale"] as const;

const POSE_SOCKETS: SocketDef[] = [
  { id: "location", label: "Location", type: "vector" },
  { id: "rotation", label: "Rotation", type: "vector" },
  { id: "scale", label: "Scale", type: "vector" },
];

const POSE_TYPES = new Set<string>(GIZMO_SELECTABLE_TYPES);

/** Whether this definition owns a native pose the sockets can drive. */
function ownsNativePose(def: NodeDefinition): boolean {
  if (!POSE_TYPES.has(def.type)) return false;
  const params = def.defaultParams ?? {};
  if (!("location" in params && "rotation" in params && "scale" in params)) return false;
  const ids = def.inputs.map((s) => s.id);
  // A node with its own Location/Rotation/Scale sockets already gives them a
  // meaning of its own (Laser Beam, Strange Attractor) — leave it alone.
  return ids.includes("matrix") && !POSE_SOCKET_IDS.some((id) => ids.includes(id));
}

/** Parent, then Location / Rotation / Scale, where Matrix was. */
function withPoseInputs(inputs: SocketDef[]): SocketDef[] {
  if (inputs.some((s) => s.id === "location")) return inputs;
  const out: SocketDef[] = [];
  for (const socket of inputs) {
    if (socket.id === "matrix") {
      out.push({ ...socket, label: "Parent" }, ...POSE_SOCKETS);
    } else {
      out.push(socket);
    }
  }
  return out;
}

/**
 * Gives a pose-owning definition its pose sockets and its Rotation Mode, in
 * place. Idempotent.
 */
export function addPoseSockets(def: NodeDefinition): void {
  if (def.poseSockets || !ownsNativePose(def)) return;
  def.poseSockets = true;
  def.inputs = withPoseInputs(def.inputs);
  def.defaultParams = { ...def.defaultParams, rotationMode: DEFAULT_ROTATION_MODE, rotationAngle: 0 };

  // The Angle socket appears in Axis Angle, so the inputs depend on params.
  const dynamic = def.dynamicInputs;
  const staticInputs = def.inputs;
  def.dynamicInputs = (connections, types, params) =>
    withRotationAngleSocket(dynamic ? withPoseInputs(dynamic(connections, types, params)) : staticInputs, params);

  const fields = def.paramFields;
  const dynamicFields = def.dynamicParamFields;
  const defaults = def.defaultParams;
  if (fields) def.paramFields = withRotationModeFields(fields);
  if (fields || dynamicFields) {
    def.dynamicParamFields = (instance, connections) =>
      withRotationModeFields(dynamicFields ? dynamicFields(instance, connections) : (fields ?? []), {
        ...defaults,
        ...instance.params,
      });
  }
}

function asVector(v: unknown): THREE.Vector3 | null {
  if (v instanceof THREE.Vector3) return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const x = Number(o.x);
    const y = Number(o.y);
    const z = Number(o.z);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) return new THREE.Vector3(x, y, z);
  }
  return null;
}

/**
 * Lands each wired pose channel in its param, before the node evaluates.
 *
 * Per axis: an axis a Compose Vector left unticked keeps the param's own
 * value, so wiring Time into just Rotation Y spins the object while the X and
 * Z typed in the panel still hold — one channel driven, like a Blender driver.
 */
export function applyPoseSockets(
  def: NodeDefinition,
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
  connected: ReadonlySet<string>,
): void {
  if (!def.poseSockets) return;
  applyWiredRotationAngle(inputs, params, connected);
  for (const id of POSE_SOCKET_IDS) {
    if (!connected.has(id)) continue;
    const wired = asVector(inputs[id]);
    if (!wired) continue;
    const own = asVector(params[id]) ?? (id === "scale" ? new THREE.Vector3(1, 1, 1) : new THREE.Vector3());
    const unused = getUnusedAxes(wired);
    params[id] = new THREE.Vector3(
      unused.includes("x") ? own.x : wired.x,
      unused.includes("y") ? own.y : wired.y,
      unused.includes("z") ? own.z : wired.z,
    );
  }
}

/**
 * Apply Rotation & Scale — Blender's Ctrl+A for a node's own pose.
 *
 * The object keeps exactly where and how it stands, but its Rotation goes to
 * zero and its Scale to one: that turn and stretch move into
 * `appliedTransform`, applied to the geometry under the pose (see
 * applyBakedTransform). From then on the object's own axes are the ones it is
 * drawn along, so a tipped wheel's axle becomes its X and wiring Time into
 * Rotation X spins it in place.
 *
 * With a pivot p, the pose is T(p+l)·R·S·T(-p)·A. Folding R·S into A keeps it
 * identical when location and pivot move with it: l' = l + p − RS·p and
 * p' = RS·p (the pivot is in the geometry's frame, which RS has just turned).
 *
 * `params` must carry the type's defaults. Returns the params to write.
 */
export function applyRotationScalePatch(params: Record<string, unknown>): Record<string, unknown> {
  const rotation = asVector(params.rotation) ?? new THREE.Vector3();
  const scale = asVector(params.scale) ?? new THREE.Vector3(1, 1, 1);
  const location = asVector(params.location) ?? new THREE.Vector3();
  const pivot = asVector(params.pivot) ?? new THREE.Vector3();

  const rs = new THREE.Matrix4().compose(new THREE.Vector3(), rotationToQuaternion(rotation, params), scale);
  const applied = new THREE.Matrix4().multiplyMatrices(rs, readAppliedTransform(params) ?? new THREE.Matrix4());
  const turnedPivot = pivot.clone().applyMatrix4(rs);

  const patch: Record<string, unknown> = {
    appliedTransform: applied.toArray(),
    location: location.clone().add(pivot).sub(turnedPivot),
    scale: new THREE.Vector3(1, 1, 1),
  };
  if (readRotationMode(params) === "AXIS_ANGLE") {
    patch.rotationAngle = 0;
  } else {
    patch.rotation = new THREE.Vector3();
  }
  if (pivot.lengthSq() > 0) patch.pivot = turnedPivot;
  return patch;
}

/** The turn and stretch an Apply moved under the pose, or null when there is none. */
export function readAppliedTransform(params: Record<string, unknown>): THREE.Matrix4 | null {
  const raw = params.appliedTransform;
  if (!Array.isArray(raw) || raw.length !== 16 || !raw.every((v) => Number.isFinite(Number(v)))) return null;
  const m = new THREE.Matrix4().fromArray(raw.map(Number));
  return m.equals(new THREE.Matrix4()) ? null : m;
}

/**
 * Draws an applied transform under the pose the node just composed:
 * `matrix = pose × A`, published as `userData.poseOffset` so the gizmo and the
 * pivot marker work on the pose alone (Viewport's nativePoseWorldMatrix).
 *
 * Every pose node recomposes its matrix on evaluate, but not always — a live
 * gizmo drag leaves the viewport in charge of it, and that already appends
 * the offset — so the matrix this step produced is remembered and a matrix
 * still equal to it is left alone rather than offset twice.
 */
export function applyBakedTransform(
  def: NodeDefinition,
  params: Record<string, unknown>,
  outputs: Record<string, unknown>,
  live: boolean,
): void {
  if (!def.poseSockets || live) return;
  const obj = outputs.geometry;
  if (!(obj instanceof THREE.Object3D)) return;
  const applied = readAppliedTransform(params);
  const data = obj.userData;
  if (!applied) {
    if (data.bakedResult) {
      delete data.bakedResult;
      delete data.poseOffset;
    }
    return;
  }
  if (data.bakedResult instanceof THREE.Matrix4 && obj.matrix.equals(data.bakedResult)) return;
  // The Matrix output is the pose children follow, without the applied part
  // — a node handing out its object's own matrix would otherwise see it
  // change under it.
  if (outputs.matrix === obj.matrix) outputs.matrix = obj.matrix.clone();
  if (obj.matrixAutoUpdate) {
    // An object three.js recomposes from its position/rotation/scale: put the
    // result there instead, or the next render would undo it.
    obj.updateMatrix();
    obj.matrix.multiply(applied).decompose(obj.position, obj.quaternion, obj.scale);
  } else {
    obj.matrix.multiply(applied);
  }
  data.poseOffset = applied;
  data.bakedResult = obj.matrix.clone();
}
