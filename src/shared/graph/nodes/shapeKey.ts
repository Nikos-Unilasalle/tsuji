import * as THREE from "three";
import { NodeDefinition, Connection } from "../types";
import { SocketDef, SocketType } from "../sockets";
import { growingSockets } from "../dynamicInputs";
import { extractPointsFromMesh, writePointsToMesh } from "./pointsGeometry";

const TARGET_PREFIX = "target";
const WEIGHT_PREFIX = "weight";

function asNumber(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * `target{i}` and `weight{i}` grow together, one pair per shape key target —
 * `growingSockets` alone only tracks `target{i}` connections, so the paired
 * weight sockets are generated for the same index range by hand below.
 */
function targetSockets(connections: Connection[], targetType: SocketType): SocketDef[] {
  const targets = growingSockets(connections, TARGET_PREFIX, (i) => ({
    id: `${TARGET_PREFIX}${i}`,
    label: `Target ${i + 1}`,
    type: targetType,
  }));
  const sockets: SocketDef[] = [];
  for (let i = 0; i < targets.length; i++) {
    sockets.push(targets[i], { id: `${WEIGHT_PREFIX}${i}`, label: `Weight ${i + 1}`, type: "value" });
  }
  return sockets;
}

/** Every declared input socket is resolved (wired value, or its keyframed/static param fallback) before `evaluate` runs — see evaluate.ts's per-socket loop — so an unwired weight already reads 0 via its (absent) default param. */
function weightAt(inputs: Record<string, unknown>, i: number): number {
  return asNumber(inputs[`${WEIGHT_PREFIX}${i}`], 0);
}

/**
 * Standard delta shape-key blend: target 0 IS the basis (weight has no
 * effect on it), every other wired target is blended in as
 * `basis + weight * (target - basis)` — Blender's own shape key semantics.
 */
function blendPoints(basis: THREE.Vector3[], targets: (THREE.Vector3[] | undefined)[], weights: number[]): THREE.Vector3[] {
  const result = basis.map((p) => p.clone());
  for (let t = 0; t < targets.length; t++) {
    const target = targets[t];
    const weight = weights[t];
    if (!target || weight === 0 || target.length !== basis.length) continue;
    for (let i = 0; i < result.length; i++) {
      result[i].addScaledVector(target[i].clone().sub(basis[i]), weight);
    }
  }
  return result;
}

/** Curve Shape Key — blends control-point layouts across N target curves, driven by a per-target weight (each independently keyframable). */
export const CURVE_SHAPE_KEY_NODE: NodeDefinition = {
  type: "curve/shape_key",
  label: "Curve Shape Key",
  category: "curve",
  inputs: [
    { id: "basis", label: "Basis", type: "curve" },
    { id: `${TARGET_PREFIX}0`, label: "Target 1", type: "curve" },
    { id: `${WEIGHT_PREFIX}0`, label: "Weight 1", type: "value" },
  ],
  dynamicInputs: (connections) => [
    { id: "basis", label: "Basis", type: "curve" as const },
    ...targetSockets(connections, "curve"),
  ],
  outputs: [
    { id: "curve", label: "Curve", type: "curve" },
    { id: "geometry", label: "Preview", type: "geometry" },
  ],
  defaultParams: {
    closed: false,
    tension: 0.5,
    resolution: 32,
  },
  paramFields: [
    { id: "closed", label: "Closed", kind: "boolean" },
    { id: "tension", label: "Tension", kind: "number", step: 0.05 },
    { id: "resolution", label: "Sample Resolution", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params, ctx) => {
    const basisCurve = inputs.basis as THREE.Curve<THREE.Vector3> | undefined;
    if (!basisCurve) return { curve: null, geometry: null };

    const resolution = Math.max(2, Math.round(asNumber(params.resolution, 32)));
    const basisPoints = basisCurve.getPoints(resolution);

    const targetKeys = Object.keys(inputs)
      .filter((k) => k.startsWith(TARGET_PREFIX))
      .sort((a, b) => Number(a.slice(TARGET_PREFIX.length)) - Number(b.slice(TARGET_PREFIX.length)));

    const targetPoints = targetKeys.map((k) => {
      const curve = inputs[k] as THREE.Curve<THREE.Vector3> | undefined;
      return curve ? curve.getPoints(resolution) : undefined;
    });
    const weights = targetKeys.map((k) => weightAt(inputs, Number(k.slice(TARGET_PREFIX.length))));

    const blended = blendPoints(basisPoints, targetPoints, weights);
    const closed = Boolean(params.closed);
    const curve = new THREE.CatmullRomCurve3(blended, closed, "catmullrom", asNumber(params.tension, 0.5));

    const geometry = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(closed ? [...blended, blended[0]] : blended),
      new THREE.LineBasicMaterial({ color: 0x84cc16 }),
    );
    geometry.userData.nodeId = ctx.nodeId;

    return { curve, geometry };
  },
};

/** Mesh Shape Key — blends vertex positions across N target meshes (must share the basis's vertex topology), driven by a per-target weight. */
export const MESH_SHAPE_KEY_NODE: NodeDefinition = {
  type: "object/shape_key",
  label: "Mesh Shape Key",
  category: "deform",
  inputs: [
    { id: "basis", label: "Basis", type: "geometry", owns: true },
    { id: `${TARGET_PREFIX}0`, label: "Target 1", type: "geometry" },
    { id: `${WEIGHT_PREFIX}0`, label: "Weight 1", type: "value" },
  ],
  dynamicInputs: (connections) => [
    { id: "basis", label: "Basis", type: "geometry" as const, owns: true },
    ...targetSockets(connections, "geometry"),
  ],
  outputs: [{ id: "geometry", label: "Geometry", type: "geometry" }],
  defaultParams: {},
  evaluate: (inputs, _params, ctx) => {
    const basisObj = inputs.basis as THREE.Object3D | undefined;
    if (!basisObj) return { geometry: null };

    const basis = extractPointsFromMesh(basisObj, ctx.nodeId, "Mesh Shape Key");
    if (!basis) return { geometry: basisObj };

    const targetKeys = Object.keys(inputs)
      .filter((k) => k.startsWith(TARGET_PREFIX))
      .sort((a, b) => Number(a.slice(TARGET_PREFIX.length)) - Number(b.slice(TARGET_PREFIX.length)));

    const targetPoints = targetKeys.map((k, idx) => {
      const obj = inputs[k] as THREE.Object3D | undefined;
      if (!obj) return undefined;
      const extracted = extractPointsFromMesh(obj, ctx.nodeId, `Mesh Shape Key Target ${idx + 1}`);
      if (!extracted) return undefined;
      if (extracted.count !== basis.count) {
        console.warn(
          `[Mesh Shape Key] Target ${idx + 1} has ${extracted.count} vertices, basis has ${basis.count} — ignoring this target (topology must match).`,
        );
        return undefined;
      }
      return extracted.points;
    });
    const weights = targetKeys.map((k) => weightAt(inputs, Number(k.slice(TARGET_PREFIX.length))));

    const blended = blendPoints(basis.points, targetPoints, weights);
    const result = writePointsToMesh(ctx.nodeId, basisObj, blended, "Mesh Shape Key");

    return { geometry: result };
  },
};
