import * as THREE from "three";
import { NodeDefinition } from "../types";

/**
 * The operations, in the order they appear in the dropdown. Matrix product is
 * not commutative, so both orders are offered explicitly rather than leaving
 * people to discover which way round "multiply" happened to mean — getting it
 * backwards is the single most common matrix mistake, and it looks like a
 * pivot bug rather than an ordering one.
 */
const MATRIX_OPS = ["multiply", "multiply-reverse", "delta", "inverse", "transpose", "mix"];

function asMatrix(v: unknown): THREE.Matrix4 {
  return v instanceof THREE.Matrix4 ? v.clone() : new THREE.Matrix4();
}

/**
 * `Matrix4.invert()` returns the *zero* matrix for a singular input, which
 * downstream collapses every vertex onto the origin — a scale of 0 on one axis
 * is enough to trigger it, and the result reads as "my object vanished" rather
 * than "that matrix has no inverse". Identity is the honest neutral answer.
 */
function safeInvert(m: THREE.Matrix4): { matrix: THREE.Matrix4; ok: boolean } {
  const det = m.determinant();
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    return { matrix: new THREE.Matrix4(), ok: false };
  }
  return { matrix: m.clone().invert(), ok: true };
}

/**
 * Blends two transforms the only way that keeps them transforms: decompose
 * both, interpolate position and scale linearly, and *slerp* the rotations.
 *
 * Interpolating the sixteen numbers directly — the obvious implementation —
 * does not produce a rotation halfway between two rotations. It shears, and it
 * shrinks anything turning through a wide angle, because the straight line
 * between two points on the rotation manifold cuts through the inside of it.
 */
function mixMatrices(a: THREE.Matrix4, b: THREE.Matrix4, t: number): THREE.Matrix4 {
  const posA = new THREE.Vector3();
  const quatA = new THREE.Quaternion();
  const scaleA = new THREE.Vector3();
  a.decompose(posA, quatA, scaleA);

  const posB = new THREE.Vector3();
  const quatB = new THREE.Quaternion();
  const scaleB = new THREE.Vector3();
  b.decompose(posB, quatB, scaleB);

  return new THREE.Matrix4().compose(
    posA.lerp(posB, t),
    quatA.slerp(quatB, t),
    scaleA.lerp(scaleB, t),
  );
}

/**
 * Matrix Math node — the missing member of the Math family.
 *
 * Compose Matrix builds one and Decompose Matrix takes one apart, but until
 * now two matrices could never be combined: stacking transforms meant chaining
 * Matrix Transform nodes, and going from a world matrix back to a local one
 * was not expressible at all.
 *
 * - **multiply** — `A × B`: B happens first, then A. The parent × child order,
 *   so wire the parent into A.
 * - **multiply-reverse** — `B × A`, for when it is the other way round.
 * - **delta** — `A⁻¹ × B`: the transform that takes you *from* A *to* B. Feed
 *   an object's matrix and a target's, and out comes the move between them.
 * - **inverse** — undoes a transform: world space back into A's local space.
 * - **transpose** — the rotation-only inverse, and the row/column swap that
 *   some imported data needs.
 * - **mix** — blends A into B by Factor, rotations included (see mixMatrices).
 */
export const MATRIX_MATH_NODE: NodeDefinition = {
  type: "matrix/math",
  label: "Matrix Math",
  category: "math",
  pure: true,
  inputs: [
    { id: "a", label: "A", type: "matrix" },
    { id: "b", label: "B", type: "matrix" },
    { id: "factor", label: "Factor (mix)", type: "value" },
  ],
  outputs: [
    { id: "out", label: "Out", type: "matrix" },
    { id: "determinant", label: "Determinant", type: "value" },
  ],
  defaultParams: { op: "multiply", factor: 0.5 },
  paramFields: [
    { id: "op", label: "Operation", kind: "select", options: MATRIX_OPS },
    { id: "factor", label: "Factor (mix, 0–1)", kind: "number", step: 0.05 },
  ],
  evaluate: (inputs, params) => {
    // An unwired socket is the identity, so a half-wired node passes its one
    // input through untouched instead of zeroing the scene.
    const a = asMatrix(inputs.a);
    const b = asMatrix(inputs.b);
    const rawFactor = inputs.factor !== undefined ? Number(inputs.factor) : Number(params.factor);
    // Clamped: past the ends, the interpolated scale walks through zero and
    // turns the object inside out, which is never what a blend was asked for.
    const factor = Number.isFinite(rawFactor) ? Math.max(0, Math.min(1, rawFactor)) : 0.5;
    const op = String(params.op || "multiply");

    let out: THREE.Matrix4;
    switch (op) {
      case "multiply-reverse":
        out = new THREE.Matrix4().multiplyMatrices(b, a);
        break;
      case "delta": {
        const { matrix: inverseA } = safeInvert(a);
        out = inverseA.multiply(b);
        break;
      }
      case "inverse":
        out = safeInvert(a).matrix;
        break;
      case "transpose":
        out = a.clone().transpose();
        break;
      case "mix":
        out = mixMatrices(a, b, factor);
        break;
      case "multiply":
      default:
        out = new THREE.Matrix4().multiplyMatrices(a, b);
        break;
    }

    return { out, determinant: out.determinant() };
  },
};
