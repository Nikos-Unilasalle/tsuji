import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { NodeDefinition } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { toBoolean } from "../sockets";
import { composeNativeMatrix } from "./transform";
import {
  applyMaterialParams,
  buildPrimitiveDynamicParamFields,
  COMMON_DEFAULT_PARAMS,
  COMMON_PRIMITIVE_INPUTS,
  COMMON_PRIMITIVE_OUTPUTS,
  extractMaterialParams,
  extractTextureParams,
  primitiveOutputs,
} from "./object";

function asVector3(v: unknown, fallback: THREE.Vector3): THREE.Vector3 {
  if (v instanceof THREE.Vector3) return v;
  if (v && typeof v === "object" && "x" in v && "y" in v && "z" in v) {
    const p = v as { x: number; y: number; z: number };
    return new THREE.Vector3(p.x, p.y, p.z);
  }
  return fallback;
}

function numberInput(input: unknown, param: unknown, fallback: number): number {
  const raw = input !== undefined ? input : param;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

interface NodeState {
  mesh?: THREE.Mesh;
  geometrySignature?: string;
  curves?: THREE.Curve<THREE.Vector3>[];
}

const stateCache = createNodeCache<NodeState>((s) => {
  if (s.mesh) disposeObject3D(s.mesh);
});

function getState(nodeId: string): NodeState {
  let state = stateCache.get(nodeId);
  if (!state) {
    state = {};
    stateCache.set(nodeId, state);
  }
  return state;
}

const EXTRA_FIELDS = [
  { id: "radius", label: "Tube Radius", kind: "number" as const, step: 0.01, group: "Geometry" },
  { id: "radialSegments", label: "Radial Sides", kind: "number" as const, step: 1, group: "Geometry" },
  { id: "tubularSegments", label: "Length Segments", kind: "number" as const, step: 4, group: "Geometry" },
  { id: "closed", label: "Closed (loop each curve)", kind: "boolean" as const, group: "Geometry" },
];

/**
 * Curves from Point Lists Node — the fan-out this app's graph doesn't have a
 * generic "for each" for (see the connect-nearby/capture-trails family):
 * Capture Trails' Point Lists output (Vector3[][], one sub-list per live
 * particle) becomes one tube per sub-list, merged into a single mesh. A
 * purpose-built node instead of a generic per-item subgraph loop — the
 * latter would need the evaluator itself to support nesting and injecting a
 * "current item" into a sub-graph's context, well past what this actually
 * needs (list of point-lists in, one merged tube mesh out).
 *
 * One THREE.Mesh, not one per curve: this app's particle scale is a handful
 * of curves (per Capture Trails' own docs), but there's no reason to pay a
 * draw call per tube when BufferGeometryUtils.mergeGeometries makes it one.
 * Every curve shares the same material — Capture Trails' own per-vertex
 * color fade lives on its LineSegments2 preview, not here; this node is the
 * "turn the paths into real geometry" step, styled as one PBR material like
 * every other primitive node.
 */
export const CURVES_FROM_POINT_LISTS_NODE: NodeDefinition = {
  type: "curve/from_point_lists",
  label: "Curves from Point Lists",
  category: "curve",
  inputs: [{ id: "pointLists", label: "Point Lists (List of Lists)", type: "list" }, ...COMMON_PRIMITIVE_INPUTS],
  outputs: [{ id: "curves", label: "Curves (List)", type: "list" }, ...COMMON_PRIMITIVE_OUTPUTS],
  defaultParams: {
    ...COMMON_DEFAULT_PARAMS,
    radius: 0.1,
    radialSegments: 8,
    tubularSegments: 48,
    closed: false,
  },
  paramFields: buildPrimitiveDynamicParamFields(EXTRA_FIELDS)(),
  dynamicParamFields: buildPrimitiveDynamicParamFields(EXTRA_FIELDS),
  evaluate: (inputs, params, ctx) => {
    const state = getState(ctx.nodeId);

    const pointLists = Array.isArray(inputs.pointLists) ? (inputs.pointLists as unknown[]) : [];
    const radius = Math.max(0.001, numberInput(inputs.radius, params.radius, 0.1));
    const radialSegments = Math.max(3, Math.round(numberInput(undefined, params.radialSegments, 8)));
    const tubularSegments = Math.max(2, Math.round(numberInput(undefined, params.tubularSegments, 48)));
    const closed = toBoolean(params.closed ?? 0);

    if (!state.mesh) {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: 0xffffff }));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.nodeId = ctx.nodeId;
      state.mesh = mesh;
    }
    const mesh = state.mesh;

    if (ctx.nodeId !== ctx.liveEditNodeId) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(composeNativeMatrix(inputs.matrix, params.location, params.rotation, params.scale, params));
    }

    // Every sub-list's points, flattened — cheap enough to stringify at this
    // node's target scale (a handful of curves) and skips rebuilding the
    // merged tube geometry on a frame where nothing actually moved.
    const signature = JSON.stringify({
      pointLists: pointLists.map((list) =>
        Array.isArray(list) ? list.map((p) => { const v = asVector3(p, new THREE.Vector3()); return [v.x, v.y, v.z]; }) : [],
      ),
      radius,
      radialSegments,
      tubularSegments,
      closed,
    });

    if (signature !== state.geometrySignature) {
      state.geometrySignature = signature;
      mesh.geometry.dispose();

      const tubes: THREE.BufferGeometry[] = [];
      const curves: THREE.Curve<THREE.Vector3>[] = [];
      for (const list of pointLists) {
        if (!Array.isArray(list) || list.length < 2) continue;
        const points = list.map((p) => asVector3(p, new THREE.Vector3()));
        const curve = new THREE.CatmullRomCurve3(points, closed);
        curves.push(curve);
        tubes.push(new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, closed));
      }

      mesh.geometry = tubes.length > 0 ? (mergeGeometries(tubes, false) ?? new THREE.BufferGeometry()) : new THREE.BufferGeometry();
      for (const tube of tubes) tube.dispose();
      // Same array identity until the signature changes, so downstream curve
      // consumers can cache on it.
      state.curves = curves;
    }

    const matParams = extractMaterialParams(inputs, params);
    const texParams = extractTextureParams(inputs, params, ctx.nodeId);
    applyMaterialParams(mesh, matParams, THREE.FrontSide, texParams);

    return { curves: state.curves ?? [], ...primitiveOutputs(mesh) };
  },
};
