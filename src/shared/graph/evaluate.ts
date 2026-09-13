import * as THREE from "three";
import { resolveDefinition } from "./groups";
import { Connection, EasingType, EvalContext, Graph, Keyframe, KeyframeStore, NodeInstance, NodeRegistry } from "./types";

export interface TopoResult {
  /** Node ids in dependency order — safe to evaluate front to back. */
  order: string[];
  /** Node ids that could not be ordered because they sit in a connection cycle. */
  cyclic: string[];
}

function bounceEaseOut(p: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  let x = p;
  if (x < 1 / d1) {
    return n1 * x * x;
  }
  if (x < 2 / d1) {
    return n1 * (x -= 1.5 / d1) * x + 0.75;
  }
  if (x < 2.5 / d1) {
    return n1 * (x -= 2.25 / d1) * x + 0.9375;
  }
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}

function elasticEaseOut(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const c4 = (2 * Math.PI) / 3;
  return Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * c4) + 1;
}

function backEaseOut(p: number, s: number): number {
  const c3 = s + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + s * Math.pow(p - 1, 2);
}

function expoEaseOut(p: number, k: number): number {
  return p >= 1 ? 1 : 1 - Math.pow(2, -k * p);
}

function sineEaseInOut(p: number): number {
  return (1 - Math.cos(Math.PI * p)) / 2;
}

/** Cubic bezier with P0=(0,0), P3=(1,1): solve x(t)=p by bisection, return y(t). */
function cubicBezierY(p: number, x1: number, y1: number, x2: number, y2: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const x = ((ax * mid + bx) * mid + cx) * mid;
    if (x < p) lo = mid;
    else hi = mid;
  }
  const t = (lo + hi) / 2;
  return ((ay * t + by) * t + cy) * t;
}

/** Named bezier presets — the classic motion-design palette. */
export const BEZIER_PRESETS: Record<string, [number, number, number, number]> = {
  "Ease (in-out)": [0.42, 0, 0.58, 1],
  "Ease Out (quart)": [0.25, 1, 0.5, 1],
  "Ease In (quart)": [0.5, 0, 0.75, 0],
  "Ease Out (back)": [0.34, 1.56, 0.64, 1],
  "Ease Out (expo)": [0.16, 1, 0.3, 1],
  "Snap": [0.68, -0.6, 0.32, 1.6],
};

/**
 * Softens an eased curve toward linear: s = 1 keeps the full curve, s = 0 is
 * purely linear. The "strength" knob for the easings whose natural parameter
 * isn't an exponent.
 */
function blendToLinear(eased: number, linear: number, s: number): number {
  return linear + (eased - linear) * s;
}

/**
 * The easing applied to the segment that ARRIVES at a keyframe. Each keyframe
 * carries exactly one easing (its arrival) — there is no departure easing: the
 * segment K1→K2 is shaped entirely by K2's arrival curve.
 *
 * "smooth" is a symmetric ease-in-out (velocity is continuous through every
 * keyframe, the classic motion-design default). The expressive ones all settle
 * ON the keyframe value (ease-out variants), which is what "arriving" means:
 * expo decelerates exponentially, back overshoots once, bounce bounces, elastic
 * springs.
 *
 * `strength` is interpreted per easing (the default matches the standard curve
 * whenever the keyframe doesn't set one):
 *   smooth / bounce / elastic — 0..1 blend toward linear (1 = full curve)
 *   expo                     — the exponent k (higher = more contrast)
 *   back                     — the overshoot amount s
 */
export function computeSegmentEasing(
  t: number,
  easing?: EasingType,
  strength?: number,
  bezier?: [number, number, number, number],
): number {
  const p = Math.max(0, Math.min(1, t));
  const s = strength !== undefined && Number.isFinite(strength) ? strength : undefined;
  switch (easing) {
    case "linear":
      return p;
    case "hold":
      return p >= 1 ? 1 : 0;
    case "smooth":
      return blendToLinear(sineEaseInOut(p), p, s ?? 1);
    case "expo": {
      const k = s !== undefined && s > 0 ? s : 10;
      return expoEaseOut(p, k);
    }
    case "back":
      return backEaseOut(p, s !== undefined && s >= 0 ? s : 1.70158);
    case "bounce":
      return blendToLinear(bounceEaseOut(p), p, s ?? 1);
    case "elastic":
      return blendToLinear(elasticEaseOut(p), p, s ?? 1);
    case "bezier": {
      const b = bezier ?? [0.42, 0, 0.58, 1];
      return cubicBezierY(p, b[0], b[1], b[2], b[3]);
    }
    default:
      // No easing recorded on the keyframe — the "smooth" default, and it
      // honours `strength` the same way an explicit "smooth" does.
      return blendToLinear(sineEaseInOut(p), p, s ?? 1);
  }
}

/**
 * Keyframe value interpolation applying the target keyframe's arrival easing.
 */
export function interpolateValue(
  v1: any,
  v2: any,
  t: number,
  easing?: EasingType,
  strength?: number,
  bezier?: [number, number, number, number],
): any {
  const ease = computeSegmentEasing(t, easing, strength, bezier);

  if (typeof v1 === "number" && typeof v2 === "number") {
    return v1 + (v2 - v1) * ease;
  }

  if (v1 instanceof THREE.Vector3 || (typeof v1 === "object" && v1 !== null && "x" in v1)) {
    const vec1 = v1 instanceof THREE.Vector3 ? v1 : new THREE.Vector3(v1.x ?? 0, v1.y ?? 0, v1.z ?? 0);
    const vec2 = v2 instanceof THREE.Vector3 ? v2 : new THREE.Vector3(v2.x ?? 0, v2.y ?? 0, v2.z ?? 0);
    return new THREE.Vector3().lerpVectors(vec1, vec2, ease);
  }

  if (v1 instanceof THREE.Color || (typeof v1 === "object" && v1 !== null && "r" in v1 && "g" in v1 && "b" in v1)) {
    const c1 = v1 instanceof THREE.Color ? v1 : new THREE.Color(v1.r ?? 1, v1.g ?? 1, v1.b ?? 1);
    const c2 = v2 instanceof THREE.Color ? v2 : new THREE.Color(v2.r ?? 1, v2.g ?? 1, v2.b ?? 1);
    return new THREE.Color().lerpColors(c1, c2, ease);
  }

  // Curve control points (a node's `pointsList` param) — element-wise lerp
  // when both keyframes have the same point count. A point added/removed
  // between the two keyframes can't be smoothly matched up, so that case
  // keeps the snap fallback below.
  if (Array.isArray(v1) && Array.isArray(v2) && v1.length === v2.length && v1.length > 0) {
    return v1.map((p1, i) => interpolateValue(p1, v2[i], t, easing, strength, bezier));
  }

  return ease >= 0.5 ? v2 : v1;
}

function parseVector3(value: unknown): THREE.Vector3 {
  if (value instanceof THREE.Vector3) return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const x = Number(obj.x);
    const y = Number(obj.y);
    const z = Number(obj.z);
    return new THREE.Vector3(
      Number.isFinite(x) ? x : 0,
      Number.isFinite(y) ? y : 0,
      Number.isFinite(z) ? z : 0,
    );
  }
  if (Array.isArray(value)) {
    const x = Number(value[0]);
    const y = Number(value[1]);
    const z = Number(value[2]);
    return new THREE.Vector3(
      Number.isFinite(x) ? x : 0,
      Number.isFinite(y) ? y : 0,
      Number.isFinite(z) ? z : 0,
    );
  }
  return new THREE.Vector3(0, 0, 0);
}

/** Clone the mutable types the keyframe store can hold so a caller mutating the
 * value it received can't corrupt the live store (which owns these instances).
 * A plain scalar (number/string/boolean) is returned as-is. */
function cloneKeyframeValue(value: any): any {
  if (value instanceof THREE.Vector3) return value.clone();
  if (value instanceof THREE.Color) return value.clone();
  if (value instanceof THREE.Euler) return value.clone();
  if (value instanceof THREE.Quaternion) return value.clone();
  if (Array.isArray(value)) return value.map(cloneKeyframeValue);
  return value;
}

/**
 * Which easing shapes the segment from `list[index]` to `list[index + 1]`.
 *
 * Only the *arrival* easing shapes a segment — K2's. The easeOut fallback
 * reads pre-simplification .tsuji files that stored a departure easing only.
 * The FIRST keyframe has no arrival segment, so its own easing shapes the
 * first segment instead — that way changing any keyframe always affects a
 * curve.
 *
 * Exported because the motion graph has to *draw* exactly what the evaluator
 * *plays*: the rule used to be written out twice, and the two copies had
 * already drifted apart once.
 */
export function resolveSegmentEasing(
  list: Keyframe[],
  index: number,
): { easing: EasingType; strength?: number; bezier?: [number, number, number, number] } {
  const k1 = list[index];
  const k2 = list[index + 1];
  const first = index === 0 && k1?.easeIn !== undefined;
  if (first) {
    return { easing: k1.easeIn as EasingType, strength: k1.easeStrength, bezier: k1.easeBezier };
  }
  const easing = k2?.easeIn ?? (k2 as { easeOut?: EasingType } | undefined)?.easeOut ?? "smooth";
  return { easing, strength: k2?.easeStrength, bezier: k2?.easeBezier };
}

function evaluateKeyframeList(list: Keyframe[], currentFrame: number, fallback: any): any {
  if (list.length === 0) return fallback;
  if (list.length === 1) return cloneKeyframeValue(list[0].value);
  if (currentFrame <= list[0].frame) return cloneKeyframeValue(list[0].value);
  if (currentFrame >= list[list.length - 1].frame) return cloneKeyframeValue(list[list.length - 1].value);

  for (let i = 0; i < list.length - 1; i++) {
    const k1 = list[i];
    const k2 = list[i + 1];
    if (currentFrame >= k1.frame && currentFrame <= k2.frame) {
      if (k1.frame === k2.frame) return cloneKeyframeValue(k1.value);
      const t = (currentFrame - k1.frame) / (k2.frame - k1.frame);
      const { easing, strength, bezier } = resolveSegmentEasing(list, i);
      return interpolateValue(k1.value, k2.value, t, easing, strength, bezier);
    }
  }

  return fallback;
}

export function evaluateKeyframeValue(
  keyframes: KeyframeStore | undefined,
  nodeId: string,
  paramKey: string,
  currentFrame: number,
  fallbackValue: any,
): any {
  if (!keyframes || currentFrame === undefined || currentFrame < 0) return fallbackValue;
  const nodeKeyframes = keyframes[nodeId];
  if (!nodeKeyframes) return fallbackValue;

  const directList = nodeKeyframes[paramKey];
  if (directList && directList.length > 0) {
    return evaluateKeyframeList(directList, currentFrame, fallbackValue);
  }

  const xList = nodeKeyframes[`${paramKey}.x`];
  const yList = nodeKeyframes[`${paramKey}.y`];
  const zList = nodeKeyframes[`${paramKey}.z`];

  if (xList || yList || zList) {
    const baseVec = parseVector3(fallbackValue);
    const resultVec = baseVec.clone();

    if (xList && xList.length > 0) {
      resultVec.x = evaluateKeyframeList(xList, currentFrame, baseVec.x);
    }
    if (yList && yList.length > 0) {
      resultVec.y = evaluateKeyframeList(yList, currentFrame, baseVec.y);
    }
    if (zList && zList.length > 0) {
      resultVec.z = evaluateKeyframeList(zList, currentFrame, baseVec.z);
    }

    return resultVec;
  }

  return fallbackValue;
}

/**
 * Kahn's algorithm. A node graph editor lets a user wire a cycle by mistake
 * sooner or later — this reports which nodes are caught in one rather than
 * hanging (a naive DFS-based sort would recurse forever on a cycle).
 * Dangling connections (referencing a node id no longer in the graph — the
 * editor deleted a node without cleaning up its wires) are silently ignored
 * rather than crashing the sort; the connection is just dead weight.
 */
export function topoSort(graph: Graph): TopoResult {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const inDegree = new Map<string, number>();
  const downstream = new Map<string, string[]>();
  for (const id of nodeIds) {
    inDegree.set(id, 0);
    downstream.set(id, []);
  }

  for (const conn of graph.connections) {
    if (!nodeIds.has(conn.fromNode) || !nodeIds.has(conn.toNode)) continue;
    downstream.get(conn.fromNode)!.push(conn.toNode);
    inDegree.set(conn.toNode, (inDegree.get(conn.toNode) ?? 0) + 1);
  }

  const queue = [...inDegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  const order: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of downstream.get(id) ?? []) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  const ordered = new Set(order);
  const cyclic = graph.nodes.map((n) => n.id).filter((id) => !ordered.has(id));
  return { order, cyclic };
}

/** Per-node outputs from the most recent evaluation, keyed by node id then socket id. */
export type EvalResult = Map<string, Record<string, unknown>>;

export function connectionInto(connections: Connection[], nodeId: string, socketId: string): Connection | undefined {
  return connections.find((c) => c.toNode === nodeId && c.toSocket === socketId);
}

/**
 * Evaluates every node once, in dependency order, eagerly — not the
 * lazy/memoized pull model Blender's node trees use. In a real-time context
 * the Time node changes every frame and most of the graph depends on it
 * transitively anyway, so "evaluate everything every frame" is both simpler
 * and rarely more expensive than the bookkeeping a dirty-tracking pull model
 * would need. Revisit only if profiling on a real graph says otherwise.
 *
 * Cyclic nodes are still evaluated — appended after the proper order, in
 * whatever order they appear in the graph — rather than silently skipped:
 * a node with no output is worse to debug than a node with a wrong one, and
 * "wrong" here usually still reads as "wrong in an obvious way" (e.g. reading
 * last frame's value from a node that isn't ready yet).
 */
/**
 * The one input socket the evaluator handles itself rather than leaving to
 * each node: hiding an object is the same operation for every node that has
 * one, and doing it here means a node only has to *declare* the socket to
 * get it — wireable from a Logic node, keyframable, and hierarchical (a
 * hidden Merge hides everything in it) because three.js already works that
 * way.
 *
 * Visibility is scene membership, not a look: unlike an opacity of 0 it
 * costs nothing to draw, applies to objects with no material of their own,
 * and takes the whole subtree with it.
 */
const VISIBILITY_SOCKET = "visible";

function applyVisibility(geometry: unknown, value: unknown): void {
  // undefined means the node never declared the socket — leave it alone.
  if (value === undefined || !(geometry instanceof THREE.Object3D)) return;
  const asNumber = Number(value);
  geometry.visible = Number.isFinite(asNumber) ? asNumber !== 0 : Boolean(value);
}

// The previous frame's per-node socket outputs, carried across calls so that a
// connected input whose source failed or hasn't resolved yet this frame (a
// cyclic node, a throwing node, an unknown type) still sees the last value it
// actually produced — instead of silently falling back to a static param. This
// is what the cyclic-node comment below has always promised but `results` is a
// fresh Map each pass, so it needed an explicit home to survive between frames.
//
// Keyed by session, not global: several viewports evaluate the same graph in
// their own render loops (the editor pane, the split preview, the offscreen
// export viewport), each on its own clock. Sharing one slot meant a real-time
// preview frame became "last frame" for the deterministic export frame that
// followed it.
// Keyed by session *and* scope: a group evaluates its subgraph through a
// nested evaluateGraph call on the same session, and a single slot per session
// meant the inner pass overwrote the outer graph's carried-over frame with the
// subgraph's — so every node in the parent lost its "last value" the moment a
// group existed anywhere in the document.
const previousFrameOutputsBySession = new Map<string, EvalResult>();

const DEFAULT_SESSION = "default";

function frameSlotKey(ctx: EvalContext): string {
  const sessionId = ctx.sessionId ?? DEFAULT_SESSION;
  return ctx.evalScope ? `${sessionId}::${ctx.evalScope}` : sessionId;
}

/**
 * Forgets a session's carried-over frames — call when its viewport unmounts.
 * Drops the nested scopes belonging to it too (one per group instance), which
 * would otherwise outlive the viewport that created them.
 */
export function disposeEvalSession(sessionId: string): void {
  previousFrameOutputsBySession.delete(sessionId);
  const prefix = `${sessionId}::`;
  for (const key of previousFrameOutputsBySession.keys()) {
    if (key.startsWith(prefix)) previousFrameOutputsBySession.delete(key);
  }
}

// Cache the topological order and structural lookups by graph reference: playback
// re-runs the graph every frame without mutating it, and recomputing the order,
// node lookups, and connection filtering every frame is pure waste.
interface GraphStructuralCache {
  topo: TopoResult;
  nodesById: Map<string, NodeInstance>;
  connectionsByToNode: Map<string, Connection[]>;
  connectionByToNodeSocket: Map<string, Connection>;
}

// One entry per live graph rather than a single "last graph" slot: a group
// evaluates its subgraph in the middle of the parent's pass, so with one slot
// the parent and every subgraph evicted each other and the order was
// recomputed from scratch on every graph, every frame. A WeakMap also lets a
// canvas that is no longer being evaluated drop its entry on its own.
const structuralCaches = new WeakMap<Graph, GraphStructuralCache>();

function getGraphStructuralCache(graph: Graph): GraphStructuralCache {
  const cached = structuralCaches.get(graph);
  if (cached) return cached;
  const topo = topoSort(graph);
  const nodesById = new Map<string, NodeInstance>();
  for (let i = 0; i < graph.nodes.length; i++) {
    const n = graph.nodes[i];
    nodesById.set(n.id, n);
  }

  const connectionsByToNode = new Map<string, Connection[]>();
  const connectionByToNodeSocket = new Map<string, Connection>();

  for (let i = 0; i < graph.connections.length; i++) {
    const conn = graph.connections[i];
    let list = connectionsByToNode.get(conn.toNode);
    if (!list) {
      list = [];
      connectionsByToNode.set(conn.toNode, list);
    }
    list.push(conn);
    connectionByToNodeSocket.set(`${conn.toNode}:${conn.toSocket}`, conn);
  }

  const cache: GraphStructuralCache = {
    topo,
    nodesById,
    connectionsByToNode,
    connectionByToNodeSocket,
  };
  structuralCaches.set(graph, cache);
  return cache;
}

const mutableKeysCache = new WeakMap<Record<string, unknown>, string[]>();

function getMutableDefaultKeys(defaultParams: Record<string, unknown>): string[] {
  let keys = mutableKeysCache.get(defaultParams);
  if (!keys) {
    keys = [];
    const allKeys = Object.keys(defaultParams);
    for (let i = 0; i < allKeys.length; i++) {
      const key = allKeys[i];
      const v = defaultParams[key];
      if (
        v instanceof THREE.Vector3 ||
        v instanceof THREE.Color ||
        v instanceof THREE.Euler ||
        v instanceof THREE.Quaternion
      ) {
        keys.push(key);
      }
    }
    mutableKeysCache.set(defaultParams, keys);
  }
  return keys;
}

// Object pooling for connectedInputs and inputSources to eliminate GC churn at 60 fps
const pooledConnectedInputs = new Set<string>();
const pooledInputSources = new Map<string, string>();
const EMPTY_CONNECTIONS: Connection[] = [];

export function evaluateGraph(graph: Graph, registry: NodeRegistry, ctx: EvalContext): EvalResult {
  const { topo, nodesById, connectionsByToNode, connectionByToNodeSocket } = getGraphStructuralCache(graph);
  const { order, cyclic } = topo;
  const slotKey = frameSlotKey(ctx);
  const previousFrameOutputs = previousFrameOutputsBySession.get(slotKey) ?? null;
  const results: EvalResult = new Map();

  for (const nodeId of [...order, ...cyclic]) {
    const instance = nodesById.get(nodeId);
    if (!instance) continue;

    // Not registry.get: a group's sockets come from the subgraph it carries,
    // not from its type — see groups.ts.
    const def = resolveDefinition(instance, registry);
    if (!def) {
      console.error(`unknown node type "${instance.type}" on node ${nodeId} — skipped`);
      continue;
    }

    // Deep-clone the mutable values that live on the shared defaultParams (a
    // Vector3/Color instance is common to every node of this type). A plain
    // spread would hand each node the *same* object by reference, so any node
    // mutating params.location in place would corrupt every other instance
    // that didn't override it. Cloning here isolates them (keyframe
    // interpolation below already clones its own Vector3/Color).
    const params: Record<string, unknown> = { ...def.defaultParams, ...instance.params };

    // Clone the shared mutable defaults one level deep, but only for the keys
    // the instance did NOT override (using cached mutable keys list)
    const mutableKeys = getMutableDefaultKeys(def.defaultParams);
    for (let i = 0; i < mutableKeys.length; i++) {
      const key = mutableKeys[i];
      if (!(key in instance.params)) {
        const v = def.defaultParams[key] as THREE.Vector3 | THREE.Color | THREE.Euler | THREE.Quaternion;
        params[key] = v.clone();
      }
    }

    // Apply keyframe interpolation to params so that param-based properties
    // (location, rotation, scale, color, etc.) reflect their animated values
    // during evaluation — not just in the param panel.
    const kfStore = ctx.keyframes || graph.keyframes;
    const frame = ctx.currentFrame ?? -1;
    if (kfStore && frame >= 0 && kfStore[nodeId]) {
      for (const paramKey of Object.keys(params)) {
        if ((def.type === "curve/grease-pencil" || def.type === "curve/paint-on-geometry") && paramKey === "frames") continue;
        params[paramKey] = evaluateKeyframeValue(kfStore, nodeId, paramKey, frame, params[paramKey]);
      }
    }

    const nodeConnections = connectionsByToNode.get(nodeId) ?? EMPTY_CONNECTIONS;
    const socketDefs = def.dynamicInputs ? def.dynamicInputs(nodeConnections) : def.inputs;
    const inputs: Record<string, unknown> = {};

    // The pooled Set/Map are reused across nodes to keep the 60 fps loop from
    // allocating — safe as long as a node's evaluate is done with them before
    // the next node starts. A group breaks that: it re-enters evaluateGraph
    // for its subgraph, whose own loop would clear the very objects the group
    // is still holding. Groups are rare and already paying for a whole nested
    // pass, so they get their own.
    const nested = instance.subgraph !== undefined;
    const connectedInputs = nested ? new Set<string>() : pooledConnectedInputs;
    const inputSources = nested ? new Map<string, string>() : pooledInputSources;

    connectedInputs.clear();
    inputSources.clear();

    for (let i = 0; i < socketDefs.length; i++) {
      const socket = socketDefs[i];
      const conn = connectionByToNodeSocket.get(`${nodeId}:${socket.id}`);
      if (conn) {
        connectedInputs.add(socket.id);
        inputSources.set(socket.id, conn.fromNode);
        // Priority rule: Node connection l'emporte toujours sur les keyframes!
        const fresh = results.get(conn.fromNode)?.[conn.fromSocket];
        inputs[socket.id] =
          fresh !== undefined ? fresh : previousFrameOutputs?.get(conn.fromNode)?.[conn.fromSocket];
      } else {
        // Unconnected socket: evaluate keyframe interpolation if keyframes exist
        const fallback = params[socket.id];
        inputs[socket.id] = evaluateKeyframeValue(
          ctx.keyframes || graph.keyframes,
          nodeId,
          socket.id,
          ctx.currentFrame ?? -1,
          fallback,
        );
      }
    }

    try {
      const outputs =
        def.evaluate(inputs, params, {
          ...ctx,
          nodeId,
          instance,
          registry,
          connectedInputs,
          inputSources,
          markers: ctx.markers || graph.markers,
        }) || {};
      applyVisibility(outputs.geometry, inputs[VISIBILITY_SOCKET]);
      results.set(nodeId, {
        ...outputs,
        __evaluatedInputs: inputs,
      });
    } catch (err) {
      console.error(`node ${nodeId} (${instance.type}) failed to evaluate`, err);
      results.set(nodeId, {});
    }
  }

  previousFrameOutputsBySession.set(slotKey, results);
  return results;
}
