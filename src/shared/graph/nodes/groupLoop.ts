import * as THREE from "three";
import { evaluateGraph } from "../evaluate";
import { boundaryNodes, groupInputPorts, portsOf } from "../groups";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import type { EvalContext, Graph, NodeDefinition, ParamFieldDef } from "../types";
import type { PolyMesh } from "../quadMesh";
import { polyMeshToGeometry, readPolyMesh } from "../mesh/polyIO";
import { facePieces, readAttribute } from "../mesh/polyAttributes";
import { extractFacesWithAttributes } from "../mesh/subset";
import { joinMeshes } from "../mesh/join";
import { createModifierMesh, emitModifiedMesh } from "./object";
import { polyMeshInSpace, valueSignature } from "./polyModifier";
import { worldMatrixOf } from "../objectPosition";

/*
 * Loops (phase 7 of docs/parametric-modeling-plan.md), as a mode of the
 * Group node rather than a new kind of subgraph: a group already has an
 * interior, boundary ports and everything the editor needs to open it.
 *
 *  - Repeat (feedback): the interior runs N times; every output port whose
 *    id matches an input port feeds the next iteration's input — grow,
 *    erode, subdivide-and-displace, L-system-like recursion.
 *  - For Each Piece: the first geometry input is split by a face attribute
 *    (`piece` — connected pieces — by default); the interior runs once per
 *    piece and the pieces it returns are joined.
 *  - For Each Count: the interior runs N times on the same inputs and the
 *    N geometries are joined (variations driven by Loop Info's iteration).
 *
 * Loop Info gives the interior its iteration, count and value.
 *
 * Every iteration's geometry is snapshotted into a PolyMesh as soon as it is
 * produced: the interior's nodes keep one output object per node id, and
 * the next iteration would otherwise overwrite the previous one's in place.
 * The whole loop is cached on its inputs, parameters and interior, so a
 * still scene doesn't rerun it every frame (tick "Animated" if the interior
 * reads time).
 */

export const LOOP_MODES = ["none", "repeat", "for-each-piece", "for-each-count"] as const;
const MAX_ITERATIONS = 1000;

export const LOOP_PARAM_FIELDS: ParamFieldDef[] = [
  { id: "loop", label: "Loop", kind: "select", options: [...LOOP_MODES], optionLabels: ["None", "Repeat (feedback)", "For Each Piece", "For Each Count (merge)"], group: "Loop" },
  { id: "iterations", label: "Iterations", kind: "number", step: 1, group: "Loop" },
  { id: "pieceAttribute", label: "Piece Attribute (face, for-each-piece)", kind: "text", group: "Loop" },
  { id: "animated", label: "Animated (re-run every frame)", kind: "boolean", group: "Loop" },
];

export const LOOP_DEFAULTS = { loop: "none", iterations: 3, pieceAttribute: "piece", animated: false };

interface LoopState {
  key?: string;
  outputs?: Record<string, unknown>;
  mesh?: THREE.Mesh;
}
const loopStates = createNodeCache<LoopState>((s) => {
  if (s.mesh) disposeObject3D(s.mesh);
});

const subgraphIds = new WeakMap<Graph, number>();
let nextSubgraphId = 1;
function subgraphId(g: Graph): number {
  let id = subgraphIds.get(g);
  if (!id) {
    id = nextSubgraphId++;
    subgraphIds.set(g, id);
  }
  return id;
}

/** A geometry produced inside an iteration, frozen before the next iteration reuses its object. */
function snapshot(value: unknown): unknown {
  if (!(value instanceof THREE.Object3D)) return value;
  const read = readPolyMesh(value);
  if (!read) return value;
  const mesh = new THREE.Mesh(polyMeshToGeometry(read.mesh), read.srcMesh.material);
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(worldMatrixOf(read.srcMesh));
  return mesh;
}

function firstGeometryPort(ports: { id: string; type: string }[]): string | undefined {
  return ports.find((p) => p.type === "geometry")?.id;
}

export function evaluateGroupLoop(
  subgraph: Graph,
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
  ctx: EvalContext,
  evalScope: string,
): Record<string, unknown> | null {
  const mode = String(params.loop ?? "none");
  if (mode === "none" || !(LOOP_MODES as readonly string[]).includes(mode) || !ctx.registry) return null;
  const output = boundaryNodes(subgraph).output;
  if (!output) return null;
  const outPorts = portsOf(output);
  const inPorts = groupInputPorts(subgraph);
  const iterations = Math.max(0, Math.min(MAX_ITERATIONS, Math.round(Number(params.iterations) || 0)));

  let state = loopStates.get(ctx.nodeId);
  if (!state) {
    state = {};
    loopStates.set(ctx.nodeId, state);
  }
  const keyParts = [mode, iterations, String(params.pieceAttribute ?? "piece"), subgraphId(subgraph)];
  for (const port of inPorts) keyParts.push(`${port.id}=${valueSignature(inputs[port.id])}`);
  if (params.animated) keyParts.push(`t=${ctx.time}`);
  const key = keyParts.join("|");
  if (state.key === key && state.outputs) return state.outputs;

  const run = (groupInputs: Record<string, unknown>, i: number, count: number, value: number) => {
    const results = evaluateGraph(subgraph, ctx.registry!, {
      ...ctx,
      nodeId: "",
      instance: undefined,
      evalScope,
      groupInputs,
      loopIteration: i,
      loopCount: count,
      loopValue: value,
    });
    const produced = results.get(output.id) ?? {};
    const frozen: Record<string, unknown> = {};
    for (const port of outPorts) frozen[port.id] = snapshot(produced[port.id]);
    return frozen;
  };

  let outputs: Record<string, unknown> = {};
  if (mode === "repeat") {
    let current: Record<string, unknown> = { ...inputs };
    for (const port of outPorts) outputs[port.id] = current[port.id];
    for (let i = 0; i < iterations; i++) {
      outputs = run(current, i, iterations, i);
      const next = { ...current };
      for (const port of outPorts) if (inPorts.some((p) => p.id === port.id) && outputs[port.id] !== undefined) next[port.id] = outputs[port.id];
      current = next;
    }
  } else {
    const geomIn = firstGeometryPort(inPorts);
    const geomOut = firstGeometryPort(outPorts);
    const source = geomIn ? inputs[geomIn] : undefined;
    const read = source instanceof THREE.Object3D ? readPolyMesh(source) : null;
    const pieces: { value: number; object: unknown }[] = [];

    if (mode === "for-each-piece") {
      if (!read || !geomIn) return state.outputs ?? {};
      const name = String(params.pieceAttribute ?? "piece").trim() || "piece";
      const attr = readAttribute(read.mesh, "face", name);
      const values = attr ? Array.from(attr.values, (v, i) => (i % attr.size === 0 ? Math.round(v) : NaN)).filter((v) => !Number.isNaN(v)) : Array.from(facePieces(read.mesh));
      const distinct = [...new Set(values)].sort((a, b) => a - b).slice(0, MAX_ITERATIONS);
      for (const value of distinct) {
        const mask = Uint8Array.from(values, (v) => (v === value ? 1 : 0));
        const piece = extractFacesWithAttributes(read.mesh, mask);
        const obj = new THREE.Mesh(polyMeshToGeometry(piece), read.srcMesh.material);
        obj.matrixAutoUpdate = false;
        obj.matrix.copy(worldMatrixOf(read.srcMesh));
        pieces.push({ value, object: obj });
      }
    } else {
      for (let i = 0; i < iterations; i++) pieces.push({ value: i, object: source });
    }

    const collected: PolyMesh[] = [];
    let last: Record<string, unknown> = {};
    pieces.forEach((p, i) => {
      const groupInputs = geomIn ? { ...inputs, [geomIn]: p.object } : { ...inputs };
      last = run(groupInputs, i, pieces.length, p.value);
      const g = geomOut ? last[geomOut] : undefined;
      if (g instanceof THREE.Object3D) {
        // Into the source's space (or the first result's), so the pieces land where they were drawn.
        const target = read?.srcMesh ?? null;
        const m = polyMeshInSpace(g, target);
        if (m) collected.push(m);
      }
    });
    outputs = { ...last };
    if (geomOut) {
      const joined = joinMeshes(collected);
      if (!state.mesh) state.mesh = createModifierMesh();
      const srcMesh = read?.srcMesh;
      if (srcMesh && source instanceof THREE.Object3D) {
        outputs[geomOut] = emitModifiedMesh(state.mesh, { inputObj: source, srcMesh, geometry: polyMeshToGeometry(joined), nodeId: ctx.nodeId }).geometry;
      } else {
        state.mesh.geometry?.dispose();
        state.mesh.geometry = polyMeshToGeometry(joined);
        state.mesh.userData.nodeId = ctx.nodeId;
        outputs[geomOut] = state.mesh;
      }
    }
  }

  state.key = key;
  state.outputs = outputs;
  return outputs;
}

/** The interior's view of the loop: which iteration this is. */
export const LOOP_INFO_NODE: NodeDefinition = {
  type: "structure/loop-info",
  label: "Loop Info",
  category: "structure",
  inputs: [],
  outputs: [
    { id: "iteration", label: "Iteration", type: "value" },
    { id: "count", label: "Count", type: "value" },
    { id: "fraction", label: "Fraction (0..1)", type: "value" },
    { id: "value", label: "Value (piece)", type: "value" },
  ],
  defaultParams: {},
  evaluate: (_inputs, _params, ctx) => {
    const i = ctx.loopIteration ?? 0;
    const n = ctx.loopCount ?? 1;
    return { iteration: i, count: n, fraction: n > 1 ? i / (n - 1) : 0, value: ctx.loopValue ?? i };
  },
};
