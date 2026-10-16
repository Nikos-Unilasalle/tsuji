import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROTATION_MODE,
  ROTATION_MODE_OPTIONS,
  quaternionToRotation,
  readRotationMode,
  rotationToQuaternion,
  withRotationModeFields,
} from "./rotationMode";

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);

describe("Rotation Mode", () => {
  it("names Euler orders the Blender way: the first letter is the object's own axis", () => {
    // Tip 90° about X, then turn about Y. In XYZ, X is applied first.
    const q = rotationToQuaternion(new THREE.Vector3(Math.PI / 2, 0.7, 0), { rotationMode: "XYZ" });
    const expected = new THREE.Quaternion().setFromAxisAngle(Y, 0.7).multiply(new THREE.Quaternion().setFromAxisAngle(X, Math.PI / 2));
    expect(q.angleTo(expected)).toBeLessThan(1e-6);
  });

  it("defaults to X first and the vertical last: a wheel spins on X and steers on Y", () => {
    expect(DEFAULT_ROTATION_MODE).toBe("XZY");
    const steer = 0.6;
    for (const spin of [0.3, 1.9, -2.5]) {
      const q = rotationToQuaternion(new THREE.Vector3(spin, steer, 0), { rotationMode: DEFAULT_ROTATION_MODE });
      // Whatever the spin, the axle stays where steering put it.
      expect(X.clone().applyQuaternion(q).distanceTo(new THREE.Vector3(Math.cos(steer), 0, -Math.sin(steer)))).toBeLessThan(1e-9);
    }
  });

  it("a node without a mode composes as rotations always were", () => {
    expect(readRotationMode({})).toBe("ZYX");
    const r = new THREE.Vector3(0.3, -0.8, 1.1);
    const legacy = new THREE.Quaternion().setFromEuler(new THREE.Euler(r.x, r.y, r.z));
    expect(rotationToQuaternion(r, {}).angleTo(legacy)).toBeLessThan(1e-6);
  });

  it("every mode round-trips through a quaternion", () => {
    const target = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -0.9, 0.25, "YXZ"));
    for (const mode of ROTATION_MODE_OPTIONS) {
      const params: Record<string, unknown> = { rotationMode: mode };
      const back = quaternionToRotation(target, params);
      const again = rotationToQuaternion(back.rotation, { ...params, rotationAngle: back.rotationAngle });
      expect(again.angleTo(target), mode).toBeLessThan(1e-6);
    }
  });

  it("Axis Angle turns by the angle about the axis, and no angle is no turn", () => {
    const q = rotationToQuaternion(new THREE.Vector3(0, 2, 0), { rotationMode: "AXIS_ANGLE", rotationAngle: Math.PI / 2 });
    expect(X.clone().applyQuaternion(q).distanceTo(new THREE.Vector3(0, 0, -1))).toBeLessThan(1e-9);
    expect(rotationToQuaternion(new THREE.Vector3(0, 1, 0), { rotationMode: "AXIS_ANGLE", rotationAngle: 0 }).angleTo(new THREE.Quaternion())).toBe(0);
  });

  it("puts the mode before Rotation, and the angle after it only in Axis Angle", () => {
    const fields = [
      { id: "location", label: "Location", kind: "vector" as const },
      { id: "rotation", label: "Rotation (°)", kind: "vector" as const, degrees: true },
    ];
    expect(withRotationModeFields(fields, { rotationMode: "XZY" }).map((f) => f.id)).toEqual(["location", "rotationMode", "rotation"]);
    const axisAngle = withRotationModeFields(fields, { rotationMode: "AXIS_ANGLE" });
    expect(axisAngle.map((f) => f.id)).toEqual(["location", "rotationMode", "rotation", "rotationAngle"]);
    expect(axisAngle[2].label).toBe("Axis");
  });
});
