import * as THREE from "three";
import { NodeDefinition } from "../types";

/**
 * Tracks which axes a VECTOR_COMPOSE_NODE left disabled. Stored out-of-band
 * (a WeakMap keyed by the Vector3 reference) rather than poisoned into a real
 * axis value, so a legitimate -1 on an enabled axis (e.g. a scale flip or a
 * location z = -1) is never mistaken for "unused". The Vector3 flows through
 * the graph by reference, so the flag survives the trip from the producer to
 * the transform consumer.
 */
const unusedAxesByVector = new WeakMap<THREE.Vector3, string[]>();

export function markUnusedAxes(v: THREE.Vector3, unused: string[]): void {
  if (unused.length > 0) unusedAxesByVector.set(v, unused);
}

export function getUnusedAxes(v: THREE.Vector3): string[] {
  return unusedAxesByVector.get(v) ?? [];
}

/** Three Values -> one Vector. What lets a single scalar (Time's seconds, a sensor reading) drive one axis of a Transform. */
export const VECTOR_COMPOSE_NODE: NodeDefinition = {
  type: "vector/compose",
  label: "Compose Vector",
  category: "compose",
  pure: true,
  inputs: [
    { id: "x", label: "X", type: "value" },
    { id: "y", label: "Y", type: "value" },
    { id: "z", label: "Z", type: "value" },
  ],
  outputs: [{ id: "out", label: "Out", type: "vector" }],
  defaultParams: { x: 0, y: 0, z: 0, useX: true, useY: true, useZ: true },
  paramFields: [
    { id: "x", label: "X", kind: "number" },
    { id: "y", label: "Y", kind: "number" },
    { id: "z", label: "Z", kind: "number" },
  ],
  evaluate: (inputs, params) => {
    const useX = params.useX !== undefined ? Boolean(params.useX) : true;
    const useY = params.useY !== undefined ? Boolean(params.useY) : true;
    const useZ = params.useZ !== undefined ? Boolean(params.useZ) : true;

    const valX = inputs.x !== undefined ? Number(inputs.x) : (Number(params.x) || 0);
    const valY = inputs.y !== undefined ? Number(inputs.y) : (Number(params.y) || 0);
    const valZ = inputs.z !== undefined ? Number(inputs.z) : (Number(params.z) || 0);

    const out = new THREE.Vector3(
      useX ? (Number.isFinite(valX) ? valX : 0) : 0,
      useY ? (Number.isFinite(valY) ? valY : 0) : 0,
      useZ ? (Number.isFinite(valZ) ? valZ : 0) : 0,
    );

    // Which axes the user left disabled. A disabled axis must resolve to the
    // identity value (0 for location/rotation, 1 for scale) downstream, and
    // telling the consumer off-band (rather than poisoning a real data value
    // like -1) lets a legitimate -1 pass through untouched — e.g. a scale flip.
    const unused: string[] = [];
    if (!useX) unused.push("x");
    if (!useY) unused.push("y");
    if (!useZ) unused.push("z");
    markUnusedAxes(out, unused);

    return { out };
  },
};

/** Inverse of Compose — a Vector's own axes as three separate Values. */
export const VECTOR_DECOMPOSE_NODE: NodeDefinition = {
  type: "vector/decompose",
  label: "Decompose Vector",
  category: "compose",
  pure: true,
  inputs: [{ id: "vector", label: "Vector", type: "vector" }],
  outputs: [
    { id: "x", label: "X", type: "value" },
    { id: "y", label: "Y", type: "value" },
    { id: "z", label: "Z", type: "value" },
  ],
  defaultParams: {},
  evaluate: (inputs) => {
    const v = inputs.vector instanceof THREE.Vector3 ? inputs.vector : new THREE.Vector3();
    return { x: v.x, y: v.y, z: v.z };
  },
};

const VECTOR_OPS = [
  "add",
  "subtract",
  "multiply",
  "divide",
  "dot",
  "cross",
  "normalize",
  "length",
  "distance",
  "scale",
  "lerp",
];

function safeVector3(v: unknown): THREE.Vector3 {
  return v instanceof THREE.Vector3 ? v : new THREE.Vector3();
}

/** Vector Math operations: vector-vector or vector-scalar operations. */
export const VECTOR_MATH_NODE: NodeDefinition = {
  type: "vector/math",
  label: "Vector Math",
  category: "math",
  pure: true,
  inputs: [
    { id: "a", label: "A", type: "vector" },
    { id: "b", label: "B", type: "vector" },
    { id: "factor", label: "Factor", type: "value" },
  ],
  outputs: [
    { id: "out", label: "Out", type: "vector" },
    { id: "val", label: "Value", type: "value" },
  ],
  defaultParams: { op: "add", factor: 1 },
  paramFields: [
    { id: "op", label: "Operation", kind: "select", options: VECTOR_OPS },
    { id: "factor", label: "Factor (fallback)", kind: "number" },
  ],
  evaluate: (inputs, params) => {
    const a = safeVector3(inputs.a);
    const b = safeVector3(inputs.b);
    const factor = inputs.factor !== undefined ? Number(inputs.factor) || 0 : Number(params.factor) || 0;
    const op = String(params.op || "add");

    let out = new THREE.Vector3();
    let val = 0;

    switch (op) {
      case "add":
        out = a.clone().add(b);
        break;
      case "subtract":
        out = a.clone().sub(b);
        break;
      case "multiply":
        out = new THREE.Vector3(a.x * b.x, a.y * b.y, a.z * b.z);
        break;
      case "divide":
        out = new THREE.Vector3(
          b.x === 0 ? 0 : a.x / b.x,
          b.y === 0 ? 0 : a.y / b.y,
          b.z === 0 ? 0 : a.z / b.z,
        );
        break;
      case "dot":
        val = a.dot(b);
        break;
      case "cross":
        out = a.clone().cross(b);
        break;
      case "normalize":
        out = a.clone();
        if (out.lengthSq() > 0) out.normalize();
        break;
      case "length":
        val = a.length();
        break;
      case "distance":
        val = a.distanceTo(b);
        break;
      case "scale":
        out = a.clone().multiplyScalar(factor);
        break;
      case "lerp":
        out = a.clone().lerp(b, factor);
        break;
      default:
        out = a.clone().add(b);
    }

    return { out, val };
  },
};

