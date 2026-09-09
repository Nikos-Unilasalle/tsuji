import * as THREE from "three";
import { NodeCategory } from "./categories";
import { SocketDef } from "./sockets";

/** Read-only context every node's evaluate function receives — the only source of "now." */
export interface EvalContext {
  /** Seconds, from the deterministic clock — see clock.ts. Never Date.now() inside a node. */
  time: number;
  /** Frame/step count since the graph's epoch. Whole-number, useful for per-step (not per-second) logic. */
  step: number;
  /**
   * The instance currently being evaluated. `evaluate` is otherwise meant to
   * be pure (no reads from outside its own inputs/params/ctx), but a node
   * that owns a GPU resource — an Object node's THREE.Mesh, a Particle
   * node's simulation texture — needs a *stable* object across frames, not a
   * fresh one every evaluation. This id is the key such a node uses into its
   * own module-level cache (mirrors OpenVMap's texture cache: the cache
   * lives outside the pure calculation, keyed by a stable id, refcounted/
   * cleaned up separately). Nodes that don't own external resources ignore it.
   */
  nodeId: string;
  /**
   * The node whose mesh is currently being dragged by the viewport's
   * TransformControls gizmo, if any — the one narrow, documented exception
   * to `evaluate` being otherwise pure. The graph re-evaluates every node
   * every frame (see evaluate.ts), which normally means an Object node's
   * mesh gets its matrix overwritten from the graph on the very next frame
   * — fine, except *during* a gizmo drag that overwrite would fight the
   * drag and the mesh would flicker back to its pre-drag pose 60 times a
   * second. A node whose id matches this one skips that overwrite for the
   * frame, leaving whatever the gizmo just set. Ignored by nodes that don't
   * own a mesh.
   */
  liveEditNodeId?: string | null;
  /**
   * The window's own WebGLRenderer, when one exists — only a node that owns
   * a GPU resource needing a live renderer to construct (a Particle Simulate
   * node's GPUComputationRenderer) reads this; every other node ignores it,
   * same as liveEditNodeId. Absent in contexts with no renderer at all
   * (tests, a headless evaluate call) — those nodes degrade gracefully
   * rather than throwing.
   */
  renderer?: THREE.WebGLRenderer;
  /**
   * The pose of the camera currently driving the output, resolved from the
   * previous frame's results — a node like Fly To reads it so a flight with
   * no wired Camera A starts from wherever the active camera already is
   * rather than the origin. Absent (or null) when there is no active camera,
   * or in contexts that don't arbitrate one (tests, a headless evaluate call).
   */
  activeCameraPose?: { matrix: THREE.Matrix4; fov: number } | null;
  /**
   * The render node's output resolution (width × height in px) — what defines
   * the scene's coordinate space. HUD (hub/*) nodes position their elements in
   * these pixels. Absent when there is no render node, or in a headless call.
   */
  renderSize?: { width: number; height: number };
  /**
   * Which render loop is evaluating. Several viewports run the same graph
   * concurrently on different clocks (editor pane, split preview, the
   * offscreen export viewport), and the evaluator carries one frame of state
   * forward per session so a real-time preview frame can't stand in as the
   * "previous frame" of a deterministic export frame. Omitted in headless
   * calls, which all share one implicit session.
   */
  sessionId?: string;
  /**
   * True while the frame being evaluated is a *captured* export frame, not a
   * live preview one. Nodes whose animation would otherwise run on wall-clock
   * time (hub/*, whose enter/exit must finish even when the timeline is
   * paused) switch to `time` here, so what gets encoded is exactly frame
   * `currentFrame` and not "whatever performance.now() said when the encoder
   * got round to it".
   */
  capturing?: boolean;
  /**
   * The Render node's frame rate. Needed by any node that has to turn a
   * timeline frame into a duration in seconds — an Audio Player anchored to a
   * frame, for one. Absent in headless calls, where 30 is assumed.
   */
  fps?: number;
  /** Active animation current frame index. */
  currentFrame?: number;
  /** Active keyframe store. */
  keyframes?: KeyframeStore;
  /**
   * Which of this node's input sockets actually have a wire in them.
   *
   * Almost no node needs this: the usual `inputs.x !== undefined ? inputs.x
   * : params.x` idiom works precisely because the evaluator fills *every*
   * declared socket, falling back to the param when nothing is connected —
   * so reading `inputs.x` already gives "the wire if there is one, the param
   * otherwise".
   *
   * The catch is that the same fill-in makes `inputs.x !== undefined` a
   * useless test for "is this wired", since it is always true. A node whose
   * *behaviour* (not just its value) forks on whether something is driving a
   * socket has to ask here instead. Fly To is the case that found this: it
   * runs its own flight timer unless Progress is being driven from outside,
   * and testing `inputs.progress !== undefined` meant the timer branch was
   * unreachable in the real app while unit tests calling `evaluate()`
   * directly — with no `progress` key at all — passed happily.
   *
   * Absent when a node is evaluated outside a graph (a direct `evaluate()`
   * call in a test); treat that as "nothing wired".
   */
  connectedInputs?: ReadonlySet<string>;
  /**
   * Which node feeds each connected input socket, by socket id.
   *
   * Rarer still than connectedInputs, and for one reason: a node that has to
   * act on *another node* rather than on a value. Fly To is the case — when
   * a flight lands it hands the active camera over to whichever Camera node
   * is wired into Camera B, and a pose alone cannot say which node that was.
   *
   * Reading a value out of this is not the point and would be a mistake —
   * `inputs` already carries every value. It exists to name a node.
   */
  inputSources?: ReadonlyMap<string, string>;
  /**
   * Bumped when the author asks every simulation to start over.
   *
   * A node holding accumulated state — a physics world, a fluid grid, an
   * integrator's running total — records the epoch it was built at and
   * rebuilds when this no longer matches. That state is history, not something
   * derivable from the current frame, so discarding it is the only way back to
   * a known starting point.
   *
   * Carried here rather than read from a module by each node so it flows
   * through the evaluator: an export pins it, a headless call leaves it
   * undefined (treated as 0), and two viewports on one graph cannot disagree.
   */
  simulationEpoch?: number;
  /** The graph's timeline markers — see the Marker node in nodes/marker.ts. */
  markers?: Marker[];
  /**
   * The scene this frame is being assembled into, for the one kind of node
   * that has to *photograph* the world rather than add to it — a Light Probe
   * sampling its surroundings through a cube camera.
   *
   * What it holds during evaluation is the previous frame's scene: membership
   * is applied from this frame's results afterwards. That is fine for a probe
   * (lighting one frame stale is imperceptible) and would not be fine for
   * anything needing this frame's geometry — which is the reason this is
   * documented as narrowly as `renderer` is, rather than offered as a general
   * handle on the world.
   */
  scene?: THREE.Scene;
}

/**
 * UI hints for the param panel — optional, purely presentational. A node
 * with no `paramFields` still works fine (its `defaultParams` are still the
 * fallback for unconnected inputs), it just shows nothing in the panel.
 * `id` must match a key in `defaultParams`.
 */
export type ParamFieldDef =
  /**
   * `degrees` is a *display* unit only: the param itself, and every socket
   * carrying the same quantity, stay in radians so an Oscillator or Value
   * Math node can feed a rotation input without unit gymnastics. It only
   * tells the panel to show and accept degrees, which is what anyone
   * dialling in an angle by hand actually wants to type.
   */
  /** `percent` is the same display-only convention as `degrees` — shows/edits the value ×100, stores it unscaled (0-1 fraction). Mutually exclusive with `degrees`. */
  | { id: string; label: string; kind: "number"; step?: number; degrees?: boolean; percent?: boolean; group?: string }
  | { id: string; label: string; kind: "boolean"; group?: string }
  | { id: string; label: string; kind: "select"; options: string[]; group?: string }
  | { id: string; label: string; kind: "color"; group?: string }
  | { id: string; label: string; kind: "vector"; step?: number; degrees?: boolean; group?: string }
  | { id: string; label: string; kind: "text"; group?: string }
  /**
   * Read-only message with no control attached — a full-width, wrapping,
   * selectable block. For text that has to be *read* rather than edited: a
   * loader's failure reason, say, which is too long to survive as a field
   * label (they truncate to the panel's width with nothing to hover).
   */
  | { id: string; label: string; kind: "note"; tone?: "warn"; group?: string }
  | { id: string; label: string; kind: "curve_profile"; group?: string }
  | { id: string; label: string; kind: "color_ramp"; group?: string }
  | {
      id: string;
      label: string;
      kind: "file";
      accept?: string[];
      group?: string;
      /**
       * Called with the instance's id, the picked path, and the file's text
       * content right after a successful pick — before `onChange(id, path)`
       * stores the path itself. This is how a node parses/caches what it
       * actually needs (CSV Reader's csvStore, say) without the generic
       * param panel needing to know anything CSV-specific.
       */
      onLoaded?: (nodeId: string, path: string, content: any) => void;
    }
  | {
      id: string;
      label: string;
      kind: "button";
      group?: string;
      /** Identifies the effect to the app shell (App.tsx's onAction) — the field itself carries no side effect. */
      action: string;
    };

/**
 * The static description of a node *type* — shared by every instance of it.
 * `evaluate` is pure: same inputs/params/time in, same outputs out, no
 * reaching into global state. That purity is what makes the engine testable
 * without a renderer and safe to re-run every frame without accumulating state.
 *
 * `params` is deliberately untyped (`Record<string, unknown>`) rather than a
 * generic `P`: a registry holds definitions of many different node types
 * together in one collection, and TypeScript can't make a function-shaped
 * generic covariant enough for that to type-check without `any` at the
 * registry boundary anyway. Each node's own `evaluate` reads and casts the
 * specific keys it expects.
 */
export interface NodeDefinition {
  type: string;
  label: string;
  /** Drives the node header color, the param panel color, and which palette section it appears in. */
  category: NodeCategory;
  inputs: SocketDef[];
  outputs: SocketDef[];
  /** Per-instance knobs — also supplies the fallback value for an input socket left unconnected. */
  defaultParams: Record<string, unknown>;
  /** See ParamFieldDef — omit for a node with nothing worth exposing in the panel. */
  paramFields?: ParamFieldDef[];
  /**
   * When present, overrides `paramFields` for a specific instance — for a
   * node like CSV Reader whose "which column" dropdown can't be known until
   * a file has actually been loaded for *this* instance. Takes the
   * instance itself (so it can key into whatever module-level cache the
   * node's own file keeps its loaded state in, the same "cache outside the
   * pure calculation, keyed by a stable id" pattern as `EvalContext.nodeId`).
   */
  dynamicParamFields?: (instance: NodeInstance) => ParamFieldDef[];
  /**
   * When present, overrides `inputs` for a specific instance based on its
   * own current connections — for a node like Merge whose socket count
   * grows as wires are added or Logic Bridge whose inputs change socket type.
   */
  dynamicInputs?: (
    connections: Connection[],
    connectionTypes?: { connection: Connection; sourceSocketType: import("./sockets").SocketType }[],
  ) => SocketDef[];
  /**
   * When present, overrides `outputs` for a specific instance based on its
   * own current connections — for a node like Logic Bridge whose output type
   * adapts to match its connected input type.
   */
  dynamicOutputs?: (
    connections: Connection[],
    connectionTypes?: { connection: Connection; sourceSocketType: import("./sockets").SocketType }[],
  ) => SocketDef[];
  evaluate: (
    inputs: Record<string, unknown>,
    params: Record<string, unknown>,
    ctx: EvalContext,
  ) => Record<string, unknown>;
}

export type NodeRegistry = Map<string, NodeDefinition>;

export function createRegistry(definitions: NodeDefinition[]): NodeRegistry {
  const registry: NodeRegistry = new Map();
  for (const def of definitions) registry.set(def.type, def);
  return registry;
}

/** One placed node in a graph — the type it is, plus whatever makes this instance different from another of the same type. */
export interface NodeInstance {
  id: string;
  type: string;
  /** Per-instance overrides of defaultParams, and fallback values for unconnected inputs, keyed by socket/param id. */
  params: Record<string, unknown>;
  /** Editor-only — the evaluator never reads this. */
  position: { x: number; y: number };
}

export interface Connection {
  id: string;
  fromNode: string;
  fromSocket: string;
  toNode: string;
  toSocket: string;
}

export type EasingType =
  | "smooth"
  | "linear"
  | "hold"
  | "expo"
  | "back"
  | "bounce"
  | "elastic"
  | "bezier";

export interface Keyframe {
  frame: number;
  value: any;
  /** The easing used to arrive at this keyframe — the only easing a keyframe carries. */
  easeIn?: EasingType;
  /** Expo contrast (1..~20, default 10). Higher = more aggressive exponential deceleration. Ignored for other easings. */
  easeStrength?: number;
  /** Custom cubic-bezier control points (x1, y1, x2, y2) — used when easeIn = "bezier". */
  easeBezier?: [number, number, number, number];
}

/** Keyframes store keyed by nodeId -> paramKey -> array of Keyframe sorted by frame ascending. */
export type KeyframeStore = Record<string, Record<string, Keyframe[]>>;

/** A param pinned to the viewport HUD, independent of graph selection. */
export interface ExposedParamRef {
  nodeId: string;
  paramId: string;
  /** Overrides field.label for the HUD row; falls back to the field's own label when absent. */
  label?: string;
}

/** A timeline marker — a labeled point in time, à la After Effects layer markers. */
export interface Marker {
  frame: number;
  label?: string;
}

export interface Graph {
  nodes: NodeInstance[];
  connections: Connection[];
  keyframes?: KeyframeStore;
  markers?: Marker[];
  exposedParams?: ExposedParamRef[];
}

export function emptyGraph(): Graph {
  return { nodes: [], connections: [], keyframes: {}, markers: [] as Marker[], exposedParams: [] };
}

/**
 * How many canvases a project holds. Fixed rather than grown on demand —
 * the same "scene list" model OpenVMap 2D already has, and what makes a
 * canvas addressable by a stable number from anywhere (the selector, a Go To
 * Canvas node, a key binding later) instead of by an identity that shifts as
 * canvases are added and removed.
 */
export const CANVAS_COUNT = 6;

/**
 * A whole document: several independent node trees, one shown at a time.
 *
 * Each canvas is a complete Graph of its own — its own nodes, wires,
 * keyframes and markers, its own Render node holding its output settings.
 * Not one big graph partitioned by a per-node tag: BIBLE.md's scene model is
 * "multiple independent trees, not one mega-graph", and it is what keeps a
 * canvas's membership a matter of *which tree a node is in* rather than
 * something that has to be wired or tagged.
 *
 * Only the active canvas is evaluated and drawn. Node ids are UUIDs
 * (GraphEditor.tsx), so the per-node-id caches that hold meshes and other GPU
 * resources (nodeCaches.ts) can't collide across canvases — an inactive
 * canvas keeps its objects, and switching back to it costs one evaluation
 * rather than a rebuild.
 */
export interface Project {
  canvases: Graph[];
  /** Index into `canvases` — the one being edited, evaluated and rendered. */
  activeCanvas: number;
}

export function emptyProject(): Project {
  return { canvases: Array.from({ length: CANVAS_COUNT }, emptyGraph), activeCanvas: 0 };
}

/** Pads/trims a canvas list to exactly CANVAS_COUNT — what a file loaded from any version gets normalized through. */
export function normalizeCanvases(canvases: Graph[]): Graph[] {
  return Array.from({ length: CANVAS_COUNT }, (_, i) => canvases[i] ?? emptyGraph());
}

/** True when nothing has been built in this canvas yet — drives the dimmed slots in the canvas selector. */
export function isCanvasEmpty(graph: Graph | undefined): boolean {
  return !graph || graph.nodes.length === 0;
}
