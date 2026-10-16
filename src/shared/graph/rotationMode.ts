import * as THREE from "three";
import type { SocketDef } from "./sockets";
import type { ParamFieldDef } from "./types";

/**
 * How a Rotation vector turns into an orientation — Blender's Rotation Mode.
 *
 * The Euler names read as Blender's do: the letters are the order the turns
 * are *applied in*, first to last. "XYZ" turns about X first, then Y, then Z,
 * so X is the object's own axis and Z the outer one. (three.js names the same
 * thing back to front — its "XYZ" applies Z first — which is why the names
 * here never go straight into a THREE.Euler; see threeOrder.)
 *
 * The default, XZY, is Blender's XYZ moved into this Y-up world: X first, then
 * the depth axis, then the vertical axis last. Last is outermost, so turning
 * an object about the vertical always turns it about the world's up, and X —
 * a car wheel's axle — is always the object's own: spin the wheel on X and
 * steer it on Y, as in Blender.
 *
 * "AXIS_ANGLE" reads Rotation as an axis and turns by `rotationAngle` about it.
 *
 * A file saved before modes existed keeps "ZYX" on every node (storage.ts),
 * which is exactly how rotations were composed then.
 */
export type RotationMode = "XYZ" | "XZY" | "YXZ" | "YZX" | "ZXY" | "ZYX" | "AXIS_ANGLE";

export const DEFAULT_ROTATION_MODE: RotationMode = "XZY";

/** The composition every rotation used before Rotation Mode existed — three.js's default Euler order. */
export const LEGACY_ROTATION_MODE: RotationMode = "ZYX";

const EULER_MODES: RotationMode[] = ["XZY", "XYZ", "YXZ", "YZX", "ZXY", "ZYX"];

export const ROTATION_MODE_OPTIONS: RotationMode[] = [...EULER_MODES, "AXIS_ANGLE"];

const ROTATION_MODE_LABELS: Record<RotationMode, string> = {
  XZY: "XZY Euler (Blender XYZ, Y up)",
  XYZ: "XYZ Euler",
  YXZ: "YXZ Euler",
  YZX: "YZX Euler",
  ZXY: "ZXY Euler",
  ZYX: "ZYX Euler (older files)",
  AXIS_ANGLE: "Axis Angle",
};

export function readRotationMode(params?: Record<string, unknown>): RotationMode {
  const mode = params?.rotationMode;
  return typeof mode === "string" && (ROTATION_MODE_OPTIONS as string[]).includes(mode)
    ? (mode as RotationMode)
    : LEGACY_ROTATION_MODE;
}

/** three.js names an Euler order outermost-first; Blender, and these modes, innermost-first. */
function threeOrder(mode: RotationMode): THREE.EulerOrder {
  return mode.split("").reverse().join("") as THREE.EulerOrder;
}

function finiteNumber(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Rotation vector (radians, or an axis) → quaternion, in the node's mode.
 * `params` is the node's params with defaults merged; a node that has no
 * Rotation Mode at all composes the legacy way.
 */
export function rotationToQuaternion(rotation: THREE.Vector3, params?: Record<string, unknown>): THREE.Quaternion {
  const mode = readRotationMode(params);
  if (mode === "AXIS_ANGLE") {
    const axis = rotation.clone();
    const angle = finiteNumber(params?.rotationAngle, 0);
    if (axis.lengthSq() < 1e-12 || angle === 0) return new THREE.Quaternion();
    return new THREE.Quaternion().setFromAxisAngle(axis.normalize(), angle);
  }
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation.x, rotation.y, rotation.z, threeOrder(mode)));
}

/**
 * Quaternion → the params that express it in the node's mode: a Rotation
 * vector, plus the angle in Axis Angle. What a gizmo drag or a Decompose
 * writes back.
 */
export function quaternionToRotation(
  quaternion: THREE.Quaternion,
  params?: Record<string, unknown>,
): { rotation: THREE.Vector3; rotationAngle?: number } {
  const mode = readRotationMode(params);
  if (mode === "AXIS_ANGLE") {
    const q = quaternion.clone().normalize();
    if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
    const angle = 2 * Math.acos(Math.min(1, q.w));
    const s = Math.sqrt(Math.max(0, 1 - q.w * q.w));
    // No turn has no axis of its own; keep the one the node already had, so
    // zeroing the angle does not throw the axis away.
    const fallback = params?.rotation instanceof THREE.Vector3 ? params.rotation.clone() : new THREE.Vector3(0, 1, 0);
    const axis = s < 1e-9 ? fallback : new THREE.Vector3(q.x / s, q.y / s, q.z / s);
    return { rotation: axis, rotationAngle: angle };
  }
  const euler = new THREE.Euler().setFromQuaternion(quaternion, threeOrder(mode));
  return { rotation: new THREE.Vector3(euler.x, euler.y, euler.z) };
}

/** The Rotation Mode select, for a node's panel. */
export const ROTATION_MODE_FIELD: ParamFieldDef = {
  id: "rotationMode",
  label: "Rotation Mode",
  kind: "select",
  options: ROTATION_MODE_OPTIONS,
  optionLabels: ROTATION_MODE_OPTIONS.map((m) => ROTATION_MODE_LABELS[m]),
};

/**
 * For a node that *outputs* a Rotation vector: the Euler order to write it
 * in, which has to be the order of whatever reads it. No Axis Angle here — a
 * vector alone cannot carry the angle.
 */
export const ROTATION_ORDER_FIELD: ParamFieldDef = {
  id: "rotationMode",
  label: "Rotation Order",
  kind: "select",
  options: EULER_MODES,
  optionLabels: EULER_MODES.map((m) => ROTATION_MODE_LABELS[m]),
};

/** The angle an Axis Angle rotation turns by — only shown in that mode. */
export const ROTATION_ANGLE_FIELD: ParamFieldDef = {
  id: "rotationAngle",
  label: "Angle (°)",
  kind: "number",
  step: 1,
  degrees: true,
};

/**
 * A panel's fields with Rotation Mode placed just before Rotation, and the
 * Axis Angle's angle just after it while that mode is on. Rotation is
 * relabelled Axis in that mode, which is what it then holds.
 */
export function withRotationModeFields(fields: ParamFieldDef[], params?: Record<string, unknown>): ParamFieldDef[] {
  const axisAngle = readRotationMode(params) === "AXIS_ANGLE";
  const out: ParamFieldDef[] = [];
  let placed = false;
  for (const field of fields) {
    if (field.id === "rotationMode" || field.id === "rotationAngle") continue;
    if (field.id === "rotation" && !placed) {
      placed = true;
      const group = "group" in field ? field.group : undefined;
      out.push(group ? { ...ROTATION_MODE_FIELD, group } : ROTATION_MODE_FIELD);
      if (axisAngle) {
        out.push({ ...field, label: "Axis", kind: "vector", degrees: false } as ParamFieldDef);
        out.push(group ? { ...ROTATION_ANGLE_FIELD, group } : ROTATION_ANGLE_FIELD);
        continue;
      }
    }
    out.push(field);
  }
  return out;
}

/** The Angle socket an Axis Angle rotation gets — degrees on the wire, like every value-typed angle socket. */
export const ROTATION_ANGLE_SOCKET: SocketDef = { id: "rotationAngle", label: "Angle (°)", type: "value" };

/** `inputs` with the Angle socket after Rotation, while the node is in Axis Angle. */
export function withRotationAngleSocket(inputs: SocketDef[], params?: Record<string, unknown>): SocketDef[] {
  if (readRotationMode(params) !== "AXIS_ANGLE" || inputs.some((s) => s.id === "rotationAngle")) return inputs;
  const at = inputs.findIndex((s) => s.id === "rotation");
  if (at < 0) return [...inputs, ROTATION_ANGLE_SOCKET];
  return [...inputs.slice(0, at + 1), ROTATION_ANGLE_SOCKET, ...inputs.slice(at + 1)];
}

/**
 * A wired Angle lands in `params.rotationAngle`, converted from the degrees
 * the wire carries to the radians the param is stored in. Only a real wire:
 * `inputs` also carries the stored param when nothing is connected.
 */
export function applyWiredRotationAngle(
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
  connected: ReadonlySet<string> | undefined,
): void {
  if (!connected?.has("rotationAngle")) return;
  const degrees = Number(inputs.rotationAngle);
  if (Number.isFinite(degrees)) params.rotationAngle = (degrees * Math.PI) / 180;
}
