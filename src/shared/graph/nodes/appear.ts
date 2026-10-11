import * as THREE from "three";
import { createNodeCache } from "../nodeCaches";
import { NodeDefinition } from "../types";
import { inheritSourceMaterial, numberInput, primitiveOutputs } from "./object";
import { asVector3, preserveModifierUserData } from "./transform";

const MODES = ["both", "opacity", "pop"] as const;
type AppearMode = (typeof MODES)[number];

const PIVOTS = ["center", "base", "origin"] as const;
type AppearPivot = (typeof PIVOTS)[number];

const DRIVES = ["progress", "trigger"] as const;
type AppearDrive = (typeof DRIVES)[number];

const ORDERS = ["index", "reverse", "random", "x", "y", "z", "distance"] as const;
type AppearOrder = (typeof ORDERS)[number];

/** Share of the progress range the fade takes in "both" mode — opaque early, so the overshoot is seen solid. */
const FADE_END_BOTH = 0.5;

/** `easeOutBack` with a tunable amount: 0 is a plain ease-out, 1 is the classic ~10% overshoot. */
export function easeOutBack(t: number, overshoot: number): number {
  const x = Math.min(1, Math.max(0, t));
  const s = 1.70158 * Math.max(0, overshoot);
  const u = x - 1;
  return 1 + (s + 1) * u * u * u + s * u * u;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * One item's progress once the staggered start is accounted for. `offset` is
 * the item's place in the sequence (0 = first, 1 = last): at stagger 0 every
 * item shares `progress`; at stagger 1 the last one only starts when the first
 * is done. Whatever the stagger, progress 0 hides everything and 1 shows it.
 */
export function localProgress(progress: number, offset: number, stagger: number): number {
  const s = Math.max(0, stagger);
  return Math.min(1, Math.max(0, progress * (1 + s) - offset * s));
}

/** The item's scale, opacity and lift offset for a local progress. */
export function appearPose(
  mode: AppearMode,
  p: number,
  overshoot: number,
  lift: number,
): { scale: number; alpha: number; dy: number } {
  const pops = mode !== "opacity";
  const fades = mode !== "pop";
  const eased = easeOutBack(p, overshoot);
  return {
    scale: pops ? Math.max(eased, 0) : 1,
    alpha: fades ? smoothstep(0, mode === "both" ? FADE_END_BOTH : 1, p) : 1,
    // Rises into place from `lift` below, riding the same overshoot — so it
    // pops a touch above rest before settling. Negative lift drops in instead.
    dy: pops ? lift * (eased - 1) : 0,
  };
}

interface Transition {
  from: number;
  target: number;
  startedAt: number;
}

/**
 * Where a self-timed transition stands at `time`, moving the state on when
 * `target` (0 or 1) has changed. A flip mid-way turns around from wherever the
 * item is, taking time in proportion to the distance left. The first call
 * starts at rest on the target, and a clock that runs backwards (Stop, a
 * scrub) snaps to it rather than replaying a stale transition.
 *
 * Idempotent for a given `time`, so several evaluations in one frame agree.
 */
export function advanceTransition(state: Transition | undefined, target: number, time: number, duration: number): { state: Transition; value: number } {
  const valueAt = (t: Transition, now: number): number => {
    const span = Math.abs(t.target - t.from) * duration;
    if (span <= 1e-9 || now < t.startedAt) return t.target;
    return t.from + (t.target - t.from) * Math.min(1, (now - t.startedAt) / span);
  };
  if (!state) {
    const rest = { from: target, target, startedAt: time };
    return { state: rest, value: target };
  }
  if (time < state.startedAt) {
    const rest = { from: target, target, startedAt: time };
    return { state: rest, value: target };
  }
  if (state.target === target) return { state, value: valueAt(state, time) };
  const turned = { from: valueAt(state, time), target, startedAt: time };
  return { state: turned, value: turned.from };
}

/** Deterministic per-item hash in [0,1) — evaluate() has to stay pure, so no Math.random. */
function hash01(i: number, seed: number): number {
  const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

interface AppearState {
  out?: THREE.Group;
  /** Stable stand-ins for leaf-mesh items, keyed by the source mesh's uuid. */
  proxies: Map<string, THREE.Mesh>;
  /** Faded copies of source materials. Never written onto the source: it is shared with other meshes. */
  fade: Map<THREE.Material, THREE.Material>;
  /** Trigger mode: the running transition. */
  transition?: Transition;
}

const stateCache = createNodeCache<AppearState>((s) => {
  s.out?.clear();
  s.proxies.clear();
  s.fade.forEach((m) => m.dispose());
  s.fade.clear();
  s.transition = undefined;
});

function getState(nodeId: string): AppearState {
  let state = stateCache.get(nodeId);
  if (!state) {
    state = { proxies: new Map(), fade: new Map() };
    stateCache.set(nodeId, state);
  }
  return state;
}

function isLeafMesh(obj: THREE.Object3D): obj is THREE.Mesh {
  return (obj as THREE.Mesh).isMesh === true && obj.children.length === 0;
}

const scratchBox = new THREE.Box3();

/** Grows `box` by everything drawn at or below `obj`, in the frame `obj`'s parent lives in. */
function expandBounds(obj: THREE.Object3D, parentToFrame: THREE.Matrix4, box: THREE.Box3): void {
  if (obj.matrixAutoUpdate) obj.updateMatrix();
  const m = parentToFrame.clone().multiply(obj.matrix);
  const geometry = (obj as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
  if (geometry?.attributes?.position) {
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (geometry.boundingBox && !geometry.boundingBox.isEmpty()) {
      box.union(scratchBox.copy(geometry.boundingBox).applyMatrix4(m));
    }
  }
  for (const child of obj.children) expandBounds(child, m, box);
}

function pivotOf(item: THREE.Object3D, pivot: AppearPivot): THREE.Vector3 {
  if (item.matrixAutoUpdate) item.updateMatrix();
  const origin = new THREE.Vector3().setFromMatrixPosition(item.matrix);
  if (pivot === "origin") return origin;
  const box = new THREE.Box3();
  expandBounds(item, new THREE.Matrix4(), box);
  if (box.isEmpty()) return origin;
  const c = box.getCenter(new THREE.Vector3());
  if (pivot === "base") c.y = box.min.y;
  return c;
}

/** Each item's place in the sequence, 0 (first) to 1 (last). */
function sequenceOffsets(
  pivots: THREE.Vector3[],
  order: AppearOrder,
  seed: number,
  from: THREE.Vector3,
): number[] {
  const n = pivots.length;
  if (n <= 1) return pivots.map(() => 0);

  let keys: number[];
  switch (order) {
    case "reverse":
      keys = pivots.map((_, i) => n - 1 - i);
      break;
    case "random":
      keys = pivots.map((_, i) => hash01(i, seed));
      break;
    case "x":
      keys = pivots.map((p) => p.x);
      break;
    case "y":
      keys = pivots.map((p) => p.y);
      break;
    case "z":
      keys = pivots.map((p) => p.z);
      break;
    case "distance":
      keys = pivots.map((p) => p.distanceTo(from));
      break;
    default:
      keys = pivots.map((_, i) => i);
  }
  const lo = Math.min(...keys);
  const hi = Math.max(...keys);
  return keys.map((k) => (hi - lo < 1e-9 ? 0 : (k - lo) / (hi - lo)));
}

function fadeOne(src: THREE.Material, alpha: number, state: AppearState): THREE.Material {
  let copy = state.fade.get(src);
  if (!copy) {
    copy = src.clone();
    state.fade.set(src, copy);
  } else {
    // The source is edited in place upstream (colour, maps, …) — follow it.
    copy.copy(src);
  }
  copy.transparent = true;
  copy.opacity = src.opacity * alpha;
  return copy;
}

function fadeMaterial(
  src: THREE.Material | THREE.Material[],
  alpha: number,
  state: AppearState,
): THREE.Material | THREE.Material[] {
  if (alpha >= 0.999) return src;
  return Array.isArray(src) ? src.map((m) => fadeOne(m, alpha, state)) : fadeOne(src, alpha, state);
}

function collectMaterials(obj: THREE.Object3D, into: Set<THREE.Material>): void {
  obj.traverse((child) => {
    const material = (child as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!material) return;
    for (const m of Array.isArray(material) ? material : [material]) into.add(m);
  });
}

const T = new THREE.Matrix4();
const S = new THREE.Matrix4();

/** `M' = T(c + dy) · S(scale) · T(−c) · M` — scales about `c`, then lifts. */
function poseAbout(local: THREE.Matrix4, c: THREE.Vector3, scale: number, dy: number, out: THREE.Matrix4): void {
  const s = Math.max(scale, 1e-6);
  out.copy(local);
  out.premultiply(T.makeTranslation(-c.x, -c.y, -c.z));
  out.premultiply(S.makeScale(s, s, s));
  out.premultiply(T.makeTranslation(c.x, c.y + dy, c.z));
}

/**
 * Makes its geometry appear or disappear: fade, "pop" (scale with overshoot
 * and a little rise), or both — driven by a single `progress` (0 = gone,
 * 1 = shown) that can be keyframed or wired to logic.
 *
 * A Merge's children are animated one by one, each about its own pivot, and
 * `stagger` spreads their starts across the progress range in the chosen
 * `order`. A lone mesh is a single item. Nested groups count as one item.
 *
 * Stateless in progress: running `progress` back down replays the curve in
 * reverse, which for the overshoot is an anticipation (swell, then shrink),
 * so a disappearance needs no setting of its own.
 */
export const APPEAR_NODE: NodeDefinition = {
  type: "modifier/appear",
  label: "Appear",
  category: "object",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "progress", label: "Progress", type: "value" },
    { id: "show", label: "Show (0/1)", type: "value" },
    { id: "stagger", label: "Stagger", type: "value" },
    { id: "origin", label: "Order Origin", type: "vector" },
  ],
  outputs: [{ id: "geometry", label: "Geometry", type: "geometry" }, { id: "matrix", label: "Matrix", type: "matrix" }],
  defaultParams: {
    progress: 1,
    drive: "progress",
    show: 1,
    duration: 0.6,
    mode: "both",
    overshoot: 1,
    lift: 0.3,
    pivot: "center",
    stagger: 0,
    order: "index",
    seed: 1,
    origin: new THREE.Vector3(0, 0, 0),
    hideAtZero: 1,
  },
  paramFields: [
    {
      id: "drive",
      label: "Drive",
      kind: "select",
      options: [...DRIVES],
    },
    {
      id: "driveNote",
      label:
        "progress: you set Progress (keyframe it or wire it). trigger: Show flips 0/1 and the node animates itself over Duration.",
      kind: "note",
    },
    { id: "progress", label: "Progress (drive = progress; 0 = hidden, 1 = shown)", kind: "number", step: 0.05 },
    { id: "show", label: "Show (drive = trigger)", kind: "boolean" },
    { id: "duration", label: "Duration (s, drive = trigger)", kind: "number", step: 0.1 },
    { id: "mode", label: "Mode", kind: "select", options: [...MODES] },
    { id: "overshoot", label: "Overshoot (0 = smooth)", kind: "number", step: 0.1, group: "Pop" },
    { id: "lift", label: "Lift (rise into place, − = drop in)", kind: "number", step: 0.05, group: "Pop" },
    { id: "pivot", label: "Scale Pivot (per item)", kind: "select", options: [...PIVOTS], group: "Pop" },
    { id: "stagger", label: "Stagger (0 = together, 1 = one after the other)", kind: "number", step: 0.05, group: "Stagger" },
    { id: "order", label: "Order", kind: "select", options: [...ORDERS], group: "Stagger" },
    { id: "seed", label: "Random Seed", kind: "number", step: 1, group: "Stagger" },
    { id: "origin", label: "Order Origin (distance)", kind: "vector", group: "Stagger" },
    { id: "hideAtZero", label: "Hide At Zero", kind: "boolean" },
  ],
  evaluate: (inputs, params, ctx) => {
    const state = getState(ctx.nodeId);
    if (!state.out) state.out = new THREE.Group();
    const out = state.out;
    out.clear();

    const root = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (!root) {
      out.userData.nodeId = ctx.nodeId;
      return primitiveOutputs(out);
    }

    const drive: AppearDrive = params.drive === "trigger" ? "trigger" : "progress";
    let progress: number;
    if (drive === "trigger") {
      const target = numberInput(inputs.show, params.show, 1) > 0.5 ? 1 : 0;
      const duration = Math.max(0, numberInput(params.duration, undefined, 0.6));
      const step = advanceTransition(state.transition, target, ctx.time, duration);
      state.transition = step.state;
      progress = step.value;
    } else {
      state.transition = undefined;
      progress = Math.min(1, Math.max(0, numberInput(inputs.progress, params.progress, 1)));
    }
    const stagger = Math.max(0, numberInput(inputs.stagger, params.stagger, 0));
    const overshoot = numberInput(params.overshoot, undefined, 1);
    const lift = numberInput(params.lift, undefined, 0.3);
    const seed = numberInput(params.seed, undefined, 1);
    const hideAtZero = Boolean(params.hideAtZero);
    const mode: AppearMode = (MODES as readonly string[]).includes(params.mode as string) ? (params.mode as AppearMode) : "both";
    const pivot: AppearPivot = (PIVOTS as readonly string[]).includes(params.pivot as string) ? (params.pivot as AppearPivot) : "center";
    const order: AppearOrder = (ORDERS as readonly string[]).includes(params.order as string) ? (params.order as AppearOrder) : "index";
    const from = asVector3(inputs.origin ?? params.origin, new THREE.Vector3());

    const leafRoot = isLeafMesh(root);
    const items = leafRoot ? [root] : root.children.slice();

    const pivots = items.map((item) => pivotOf(item, pivot));
    const offsets = sequenceOffsets(pivots, order, seed, from);

    const sources = new Set<THREE.Material>();
    const liveProxies = new Set<string>();
    const pose = new THREE.Matrix4();
    const results: THREE.Object3D[] = [];

    items.forEach((item, i) => {
      if (item.matrixAutoUpdate) item.updateMatrix();
      const p = localProgress(progress, offsets[i], stagger);
      const { scale, alpha, dy } = appearPose(mode, p, overshoot, lift);
      poseAbout(item.matrix, pivots[i], scale, dy, pose);
      const visible = item.visible && !(hideAtZero && p <= 0);
      collectMaterials(item, sources);

      if (isLeafMesh(item)) {
        let proxy = state.proxies.get(item.uuid);
        if (!proxy) {
          proxy = new THREE.Mesh(item.geometry, item.material);
          state.proxies.set(item.uuid, proxy);
        }
        liveProxies.add(item.uuid);
        proxy.geometry = item.geometry;
        proxy.castShadow = item.castShadow;
        proxy.receiveShadow = item.receiveShadow;
        proxy.renderOrder = item.renderOrder;
        proxy.name = item.name;
        inheritSourceMaterial(proxy, fadeMaterial(item.material, alpha, state));
        preserveModifierUserData(proxy, item, item, ctx.nodeId);
        proxy.matrixAutoUpdate = false;
        proxy.matrix.copy(pose);
        proxy.visible = visible;
        results.push(proxy);
        return;
      }

      const copy = item.clone(true);
      copy.matrixAutoUpdate = false;
      copy.matrix.copy(pose);
      copy.visible = visible;
      if (alpha < 0.999) {
        copy.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (mesh.isMesh && mesh.material) mesh.material = fadeMaterial(mesh.material, alpha, state);
        });
      }
      results.push(copy);
    });

    for (const key of [...state.proxies.keys()]) if (!liveProxies.has(key)) state.proxies.delete(key);
    for (const [src, copy] of [...state.fade]) {
      if (sources.has(src)) continue;
      copy.dispose();
      state.fade.delete(src);
    }

    if (leafRoot) return primitiveOutputs(results[0]);

    for (const r of results) out.add(r);
    out.matrixAutoUpdate = false;
    if (root.matrixAutoUpdate) root.updateMatrix();
    out.matrix.copy(root.matrix);
    preserveModifierUserData(out, root, null, ctx.nodeId);
    return primitiveOutputs(out);
  },
};
