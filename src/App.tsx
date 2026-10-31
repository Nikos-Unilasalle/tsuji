import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { CAMERA_FLY_TO_NODE, CAMERA_NODE } from "./shared/graph/nodes/camera";
import { asVector3, composeTransform } from "./shared/graph/nodes/transform";
import { DEFAULT_REGISTRY } from "./shared/graph/nodes";
import { toBoolean } from "./shared/graph/sockets";
import { BAKE_INSTANCES_ACTION, bakeInstancesToGeometryData } from "./shared/graph/nodes/particleInstances";
import { EXPLODE_GLTF_ACTION, ExplodedTexture, explodeGltfToMeshData, GLTF_CHOOSE_FOLDER_ACTION, gltfSourceDirectory } from "./shared/graph/nodes/gltfLoader";
import { addBrowserFiles, filesFromDrop, requestProjectFolder } from "./shared/graph/browserFiles";
import { isTauri } from "./shared/isTauri";
import { TOGGLE_POINTS_KEYFRAME_ACTION } from "./shared/graph/nodes/curve";
import { EDIT_MESH_POINTS_NODE, RESEED_MESH_POINTS_ACTION } from "./shared/graph/nodes/editMeshPoints";
import { isIkControlNode } from "./shared/graph/curveLookup";
import {
  EDIT_MESH_NODE,
  EDIT_MESH_RESEED_ACTION,
  EDIT_MESH_EXTRUDE_ACTION,
  EDIT_MESH_INSET_ACTION,
  EDIT_MESH_UNWRAP_UVS_ACTION,
  EDIT_MESH_SMART_UNWRAP_ACTION,
  EDIT_MESH_DELETE_FACES_ACTION,
  EDIT_MESH_SEPARATE_FACES_ACTION,
  resolveEditMeshData,
  readEditMeshSelection,
} from "./shared/graph/nodes/editMesh";
import {
  QuadMesh,
  QuadMeshShading,
  cloneQuadMesh,
  createQuadBox,
  boxProjectUVs,
  bufferGeometryToQuadMesh,
  geometrySignature,
  quadMeshToBufferGeometry,
  extrudeFaces,
  deleteFaces,
  extractFaces,
} from "./shared/graph/quadMesh";
import { insetRegion } from "./shared/graph/mesh/tools";
import { smartUnwrap } from "./shared/graph/mesh/unwrap";
import { extractPointsFromMesh } from "./shared/graph/nodes/pointsGeometry";
import { findFirstMesh } from "./shared/graph/meshRequired";
import { computePointInfluences, POINTS_INFLUENCE_COMPUTE_ACTION } from "./shared/graph/nodes/pointsInfluence";
import { UV_UNWRAP_ACTION } from "./shared/graph/nodes/uvUnwrap";
import {
  freezeObjectToGeometryData,
  FROZEN_UNWRAP_UVS_ACTION,
  OBJECT_FROZEN_NODE,
} from "./shared/graph/nodes/frozenGeometry";
import type { KeyframeDrawing } from "./shared/graph/nodes/greasePencil";
import { randomId } from "./shared/randomId";
import { buildDroppedNodes, DroppedImage, droppedKind, isDroppableMedia, projectDrop } from "./shared/graph/imageDrop";
import { findRenderNode, findRenderNodeId } from "./shared/graph/nodes/render";
import { findView2DNodeId } from "./shared/graph/nodes/view2d";
import { rehydrateFileNodesFromDisk } from "./shared/graph/rehydrateFiles";
import { cloneGraph, cloneParams, cloneParamValue } from "./shared/graph/cloneGraph";
import { consumeCameraHandoffRequest } from "./shared/graph/cameraHandoffStore";
import { consumeCanvasSwitchRequest } from "./shared/graph/canvasSwitchStore";
import { computeSkinWeightTargets, consumeSkinBindRequests, SKIN_COMPUTE_ACTION, SKIN_REWEIGH_ACTION, skinReweighParams } from "./shared/graph/nodes/skin";
import { isGraphZone } from "./shared/graph/inputZoneStore";
import { onSimulationReset, resetSimulations } from "./shared/graph/simulationEpoch";
import {
  collectKeyboardBindings,
  isKeyReservedForPlayback,
  setGraphKeyBindings,
  setPlaybackActive,
} from "./shared/graph/playbackKeys";
import { collectAllNodeIds, findNodeDeep, findNodeWithGraph, nodeConnections, resolveDefinition, updateGraphHolding, updateNodeDeep } from "./shared/graph/groups";
import { disposeNodeCaches } from "./shared/graph/nodeCaches";
import { AutosaveRecord, projectHasContent, readAutosave, writeAutosave } from "./shared/graph/autosave";
import { rehydrateGraphParams } from "./shared/graph/rehydrateParams";
import { createStarterGraph } from "./shared/graph/starterGraph";
import { connectedSocketIds, paramPanelValues } from "./shared/graph/paramPanelValues";
import {
  LATTICE_DEFORM_NODE,
  LATTICE_GRID_PARAM_IDS,
  latticeParamsWithRebuiltGrid,
} from "./shared/graph/nodes/lattice";
import {
  CANVAS_COUNT,
  EasingType,
  emptyGraph,
  Graph,
  isCanvasEmpty,
  Keyframe,
  KeyframeStore,
  Marker,
  NodeInstance,
  normalizeCanvases,
  ParamFieldDef,
  Project,
} from "./shared/graph/types";
import {
  TOPOGRAPHY_BAKE_ACTION,
  TOPOGRAPHY_PRESETS,
  TOPOGRAPHY_PRESET_ACTION_PREFIX,
  getHeightSlopeMixState,
} from "./shared/graph/nodes/textureHeightSlopeMix";
import { TEXTURE_MIX_PAINT_NODE } from "./shared/graph/nodes/textureMixPaint";
import { serializeSplatToPng } from "./shared/three/splatSerialization";
import { broadcastCamera, broadcastGraph, maximizeMainWindow, PreviewCameraPose, startBroadcasting } from "./shared/ipc";
import { createCanvasTour, type CanvasTour } from "./shared/export/canvasTour";
import { exportVideo, mimeToExtension, saveVideoBlob } from "./shared/export/videoExport";
import { exportVideoWebCodecs, supportsWebCodecsExport } from "./shared/export/webCodecsExport";
import { exportPngSequence, saveZipBlob } from "./shared/export/imageSequenceExport";
import { renderGraphToSvg, saveGraphSvg } from "./shared/export/graphSvg";
import { TransformPatch, Viewport, ViewportExportHandle } from "./shared/three/Viewport";
import { exportWornTextures, WORN_BAKE_ACTION } from "./shared/graph/nodes/materialWorn";
import { NODE_APPLY_TRANSFORM_ACTION, NODE_FREEZE_ACTION, NODE_RESET_PARAMS_ACTION, nodeResetPatch } from "./shared/graph/nodeActions";
import { applyRotationScalePatch } from "./shared/graph/poseSockets";
import { SplitViewport } from "./shared/three/SplitViewport";
import "./shared/three/viewport.css";
import { GIZMO_SELECTABLE_TYPES, resolveGizmoTarget } from "./shared/graph/transformLookup";
import { CalibrationOverlay } from "./windows/CalibrationOverlay";
import { GraphEditor } from "./windows/GraphEditor";
import { OutputWindow } from "./windows/OutputWindow";
import { View2DWindow } from "./windows/View2DWindow";
import { parseVector3, ParamPanel } from "./windows/ParamPanel";
import { TimelineBar } from "./windows/TimelineBar";
import { TimelineDrawer } from "./windows/TimelineDrawer";
import { KeyframeClipboardItem } from "./windows/timelineUtils";
import { TopBar } from "./windows/TopBar";
import {
  getEvaluatedResults,
  getPlayheadFrame,
  resetPlayheadFrames,
  setEvaluatedResults,
  setPlayheadFrame,
  usePlayheadFrame,
  usePlayheadStore,
} from "./shared/graph/playheadStore";
import { useShallow } from "zustand/react/shallow";
import { useStableHandler } from "./shared/useStableHandler";
import type { ExportSource } from "./windows/ShareMenu";

export interface WorkspaceSpaces {
  view3D: boolean;
  camera: boolean;
  view2D: boolean;
  canvas: boolean;
  timeline: boolean;
}

/** A node's params with its type's defaults under them — a saved file need not carry a param added since. */
function withDefaultParams(node: { type: string; params: Record<string, unknown> }): Record<string, unknown> {
  return { ...(DEFAULT_REGISTRY.get(node.type)?.defaultParams ?? {}), ...node.params };
}

/**
 * Keyframe values are stored in the graph and round-trip through the .tsuji as
 * plain JSON, so a THREE.Vector3/Color is kept as its own plain fields —
 * rehydrateParams.ts turns those back into class instances on load, and
 * interpolateValue (evaluate.ts) blends either form.
 */
function serializeKeyframeValue(value: unknown): unknown {
  if (value === undefined) return 0;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Shared by onParamChange and onTransformChange (the gizmo drag / "Aligner
 * Caméra" path — see Viewport.tsx): if `paramId` (or, for a Vector3, any of
 * its `.x`/`.y`/`.z` components) already has a keyframe track on this node,
 * writes `value` into that track at `currentFrame` instead of leaving it to
 * fall back to the base param. Deliberately does NOT create a *new* track —
 * only a "K" press does that (see ParamPanel) — so editing an unkeyframed
 * field elsewhere still just edits its static value, same as before any
 * keyframe exists. Returns `keyframes` unchanged (same reference) if nothing
 * on this node was actually keyframed, so callers can no-op cheaply.
 */
function applyKeyframedParamUpdate(
  keyframes: KeyframeStore | undefined,
  nodeId: string,
  paramId: string,
  value: unknown,
  currentFrame: number,
): KeyframeStore | undefined {
  const nodeKeys = keyframes?.[nodeId];
  if (!nodeKeys) return keyframes;

  const updatedNodeKeys = { ...nodeKeys };
  let modified = false;

  const updateOrInsertKeyframe = (key: string, val: unknown) => {
    const list = updatedNodeKeys[key] || [];
    const idx = list.findIndex((k) => k.frame === currentFrame);
    let newList: Keyframe[];
    if (idx >= 0) {
      newList = [...list];
      newList[idx] = { frame: currentFrame, value: val };
    } else {
      newList = [...list, { frame: currentFrame, value: val }].sort((a, b) => a.frame - b.frame);
    }
    updatedNodeKeys[key] = newList;
    modified = true;
  };

  if (updatedNodeKeys[paramId] && updatedNodeKeys[paramId].length > 0) {
    // Whole-value track. It only holds a number when the param *is* a
    // number: a Vector3 or Color track holds the composite, which
    // interpolateValue (see evaluate.ts) knows how to blend. Coercing
    // everything through Number() here turned every non-scalar update into
    // NaN and then stored a literal 0, quietly flattening the track.
    const valNum = Number(value);
    const isScalar = typeof value === "number" || (typeof value === "string" && Number.isFinite(valNum));
    updateOrInsertKeyframe(paramId, isScalar ? valNum : serializeKeyframeValue(value));
  }

  if (value instanceof THREE.Vector3 || (typeof value === "object" && value !== null && ("x" in value || "y" in value || "z" in value))) {
    const vec = parseVector3(value);
    for (const comp of ["x", "y", "z"] as const) {
      const fullKey = `${paramId}.${comp}`;
      if (updatedNodeKeys[fullKey] && updatedNodeKeys[fullKey].length > 0) {
        updateOrInsertKeyframe(fullKey, vec[comp]);
      }
    }
  }

  return modified ? { ...keyframes, [nodeId]: updatedNodeKeys } : keyframes;
}


/** Undo depth. */
const HISTORY_LIMIT = 50;
/** Consecutive edits to the same control within this window collapse into one undo step. */
const HISTORY_COALESCE_MS = 600;

/**
 * A discrete gesture (a whole paint/sculpt stroke, committed once on
 * pointer-up) must always be its own undo step — coalescing by key is for
 * continuous inputs like a slider drag that fire many onParamChange calls
 * per gesture and want just one. Passing `{ coalesce: false }` opts out so
 * back-to-back strokes within HISTORY_COALESCE_MS don't fuse into one undo.
 */
function coalesceKeyFor(nodeId: string | null, paramId: string, options?: { coalesce?: boolean }): string | undefined {
  return options?.coalesce === false ? undefined : `${nodeId}:${paramId}`;
}

/** `graph` with params merged into the nodes named in `patches`, inside groups too; the same graph when none is there. */
function withNodeParams(graph: Graph, patches: Map<string, Record<string, unknown>>): Graph {
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    const patch = patches.get(node.id);
    const subgraph = node.subgraph ? withNodeParams(node.subgraph, patches) : node.subgraph;
    if (!patch && subgraph === node.subgraph) return node;
    changed = true;
    return { ...node, ...(patch ? { params: { ...node.params, ...patch } } : {}), ...(subgraph !== node.subgraph ? { subgraph } : {}) };
  });
  return changed ? { ...graph, nodes } : graph;
}

/** Quiet time after the last edit before the document is written to localStorage. */
const AUTOSAVE_DEBOUNCE_MS = 800;

const MIN_PANE_PERCENT = 15;
const MAX_PANE_PERCENT = 85;

/**
 * Hands `children` one canvas's playhead, subscribing only this subtree to
 * it: App itself doesn't re-render when the frame advances (see
 * playheadStore).
 */
function WithPlayhead({ canvas, children }: { canvas: number; children: (frame: number) => React.ReactNode }) {
  return <>{children(usePlayheadFrame(canvas))}</>;
}

/**
 * Hands `children` the playhead and whatever `select` derives from it and the
 * latest evaluation results. Results arrive every evaluated frame; a shallow
 * compare of the selection keeps this subtree from re-rendering unless what
 * it shows actually changed.
 */
function WithEvaluation<T extends object>({
  canvas,
  select,
  children,
}: {
  canvas: number;
  select: (frame: number, results: Map<string, Record<string, unknown>> | null) => T;
  children: (frame: number, selected: T) => React.ReactNode;
}) {
  const frame = usePlayheadFrame(canvas);
  const selected = usePlayheadStore(useShallow((state) => select(state.frames[canvas] ?? 0, state.evaluatedResults)));
  return <>{children(frame, selected)}</>;
}

/**
 * The first Sound Player's clip, as the timeline's waveform strip draws it
 * (music sync).
 *
 * Read from the evaluation results, not from the audio store: the store is a
 * module cache filled asynchronously once the file has decoded, and nothing
 * about that write reaches React. `url` is a socket, so it arrives with every
 * frame's results like any other value. Flat primitives so a shallow compare
 * can tell an unchanged clip apart from a new frame's results.
 */
function waveformClipOf(nodes: NodeInstance[], evaluatedResults: Map<string, Record<string, unknown>> | null) {
  if (!evaluatedResults) return undefined;
  for (const node of nodes) {
    if (node.type !== "sound/player") continue;
    const res = evaluatedResults.get(node.id);
    const url = res?.url;
    if (typeof url !== "string" || !url) continue;
    // A trigger-driven clip (startFrame -1) has no knowable position on the
    // timeline, so it is drawn from frame 0 rather than not at all.
    const start = Number(res?.startFrame);
    const anchored = Number.isFinite(start) && start >= 0;
    // The strip is drawn where the file's first second would sit: a start point pushes it before the start frame.
    const fileStart = anchored ? start - (Number(res?.clipOffsetFrames) || 0) : 0;
    const endFrames = Number(res?.clipEndFrames) || 0;
    return {
      url,
      startFrame: fileStart,
      duration: Number(res?.duration) || 0,
      // Only this part of the file will sound: from the start frame to the stop point, or on to the end of the
      // timeline when the region loops.
      activeFrom: anchored ? start : -Infinity,
      activeTo: anchored ? (Number(res?.loop) > 0 || endFrames <= 0 ? Infinity : fileStart + endFrames) : Infinity,
    };
  }
  return undefined;
}

/**
 * The bottom timeline bar, subscribed to the playhead and to the waveform
 * clip — the clip only re-renders it when one of its values actually
 * changes, not on every frame's fresh results map.
 */
function LiveTimelineBar({
  canvas,
  nodes,
  ...props
}: Omit<
  React.ComponentProps<typeof TimelineBar>,
  "currentFrame" | "waveformUrl" | "waveformStartFrame" | "waveformDuration" | "waveformActive"
> & { canvas: number; nodes: NodeInstance[] }) {
  const currentFrame = usePlayheadFrame(canvas);
  const clip = usePlayheadStore(useShallow((state) => waveformClipOf(nodes, state.evaluatedResults)));
  const active = useMemo(() => (clip ? { from: clip.activeFrom, to: clip.activeTo } : undefined), [clip]);
  return (
    <TimelineBar
      {...props}
      currentFrame={currentFrame}
      waveformUrl={clip?.url}
      waveformStartFrame={clip?.startFrame}
      waveformDuration={clip?.duration}
      waveformActive={active}
    />
  );
}

/**
 * Three windows, one bundle: the Rust side (`output_window.rs`,
 * `view2d_window.rs`) opens the projector-facing output window at
 * `index.html#/output` and the 2D Render window at `index.html#/view2d` — the
 * hash is the sole discriminator between "I'm the main editor" and "I'm one
 * of the secondary windows," same pattern OpenVMap 2D uses. No router
 * library needed for three routes.
 */
function App() {
  if (window.location.hash === "#/output") {
    return <OutputWindow />;
  }
  if (window.location.hash === "#/view2d") {
    return <View2DWindow />;
  }
  return <MainEditor />;
}

function MainEditor() {
  // The whole document. `graph` below is a view onto the active one — every
  // existing edit path (params, gizmo, undo, the editor itself) still speaks
  // in terms of one Graph and needs to know nothing about canvases.
  // A recovered autosave wins over the smoke-test graph: the browser build has
  // no other persistence, so a reload used to be indistinguishable from
  // discarding the session. Read once, in the initializer, so the recovered
  // document is what renders on the first frame rather than flashing the
  // starter graph first.
  const recoveredRef = useRef<AutosaveRecord | null | undefined>(undefined);
  if (recoveredRef.current === undefined) {
    const record = readAutosave(DEFAULT_REGISTRY);
    recoveredRef.current = record && projectHasContent(record.project) ? record : null;
  }
  const recovered = recoveredRef.current;

  const [canvases, setCanvases] = useState<Graph[]>(() =>
    recovered
      ? normalizeCanvases(recovered.project.canvases).map((canvas) =>
          rehydrateGraphParams(canvas, DEFAULT_REGISTRY),
        )
      : normalizeCanvases([createStarterGraph()]),
  );
  const [activeCanvas, setActiveCanvas] = useState(recovered ? recovered.project.activeCanvas : 0);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const selectedNodeIdRef = useRef<string | null>(null);
  selectedNodeIdRef.current = selectedNodeId;
  const selectedNodeIdsRef = useRef<string[]>([]);
  const [timelineDrawerHeight, setTimelineDrawerHeight] = useState(280);
  const [splitPercent, setSplitPercent] = useState(50);
  const [is2DMode, setIs2DMode] = useState(false);
  const [snapElevation, setSnapElevation] = useState(false);
  const toggle2DMode = useCallback(() => setIs2DMode((prev) => !prev), []);
  const toggleSnapElevation = useCallback(() => setSnapElevation((prev) => !prev), []);

  // Workspaces state (3D View, Camera, Canvas, Timeline) — persisted in localStorage
  const [spaces, setSpaces] = useState<WorkspaceSpaces>(() => {
    try {
      const saved = localStorage.getItem("tsuji_active_spaces_v1");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (
          typeof parsed.view3D === "boolean" &&
          typeof parsed.camera === "boolean" &&
          typeof parsed.canvas === "boolean"
        ) {
          if (parsed.view3D || parsed.camera || parsed.view2D || parsed.canvas || parsed.timeline) {
            return {
              view3D: parsed.view3D,
              camera: parsed.camera,
              view2D: Boolean(parsed.view2D),
              canvas: parsed.canvas,
              timeline: parsed.timeline !== undefined ? Boolean(parsed.timeline) : true,
            };
          }
        }
      }
    } catch {}
    return { view3D: true, camera: false, view2D: false, canvas: true, timeline: true };
  });

  const toggleSpace = useCallback((space: keyof WorkspaceSpaces) => {
    setSpaces((prev) => {
      const next = { ...prev, [space]: !prev[space] };
      // Prevent disabling all spaces: if all spaces would become hidden, activate canvas or view3D!
      if (!next.view3D && !next.camera && !next.view2D && !next.canvas && !next.timeline) {
        return { ...next, [space === "view3D" ? "canvas" : "view3D"]: true };
      }
      try {
        localStorage.setItem("tsuji_active_spaces_v1", JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);
  const [currentFilename, setCurrentFilename] = useState(recovered?.filename ?? "project_v1.tsuji");
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingSplit = useRef(false);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const ghostLineRef = useRef<HTMLDivElement>(null);
  const lastClampedYRef = useRef<number>(0);

  const draggingDrawer = useRef(false);
  const [isDraggingDrawer, setIsDraggingDrawer] = useState(false);
  const ghostDrawerLineRef = useRef<HTMLDivElement>(null);
  const lastClampedDrawerYRef = useRef<number>(0);
  const drawerStartYRef = useRef<number>(0);
  const drawerStartHeightRef = useRef<number>(0);

  const graph = canvases[activeCanvas] ?? emptyGraph();
  const project: Project = { canvases, activeCanvas };

  // Read through a ref rather than the captured value: setGraph is handed to
  // callbacks that outlive the render they were made in (the gizmo's
  // per-frame writes, most of all), and a stale index would write the edit
  // into whichever canvas was open when the callback was created.
  const activeCanvasRef = useRef(activeCanvas);
  activeCanvasRef.current = activeCanvas;
  const canvasesRef = useRef(canvases);
  canvasesRef.current = canvases;

  const setGraph = useCallback((nextOrUpdater: Graph | ((prev: Graph) => Graph)) => {
    setCanvases((prev) =>
      prev.map((canvas, i) =>
        i === activeCanvasRef.current
          ? typeof nextOrUpdater === "function"
            ? (nextOrUpdater as (prev: Graph) => Graph)(canvas)
            : nextOrUpdater
          : canvas,
      ),
    );
  }, []);

  const switchCanvas = useCallback((index: number) => {
    if (index < 0 || index >= CANVAS_COUNT) return;
    setActiveCanvas((prev) => {
      if (prev === index) return prev;
      // The ref leads the state: setGraph and the history helpers read it,
      // and anything that fires between this call and the re-render (a gizmo
      // frame, a pending param write) must already be aimed at the canvas
      // being switched to.
      activeCanvasRef.current = index;
      return index;
    });
    setSelectedNodeId(null);
    setSelectedNodeIds([]);
  }, []);

  const handleSelectNode = useCallback((id: string | null) => {
    setSelectedNodeId(id);
    setSelectedNodeIds(id ? [id] : []);
  }, []);

  const handleSelectNodes = useCallback((ids: string[]) => {
    setSelectedNodeIds(ids);
    setSelectedNodeId(ids[0] ?? null);
  }, []);

  const renderNodeInstance = findRenderNode(graph);
  const rawFrameCount = Number(renderNodeInstance?.params?.frameCount);
  const totalFrames = renderNodeInstance
    ? Number.isFinite(rawFrameCount) && rawFrameCount > 0
      ? Math.round(rawFrameCount)
      : 120
    : 0;
  // Boolean params round-trip as 0/1 (see booleanField in ParamPanel.tsx), not
  // real booleans — `0 !== false` is true in JS, so a strict `!== false` check
  // here never actually caught the checkbox being unchecked.
  const timelineParamEnabled = Number(renderNodeInstance?.params?.timelineEnabled ?? 1) !== 0;
  const keyframesEnabled = !!renderNodeInstance && timelineParamEnabled;
  const exportFps = Math.max(1, Number(renderNodeInstance?.params?.fps) || 30);
  const exportWidth = Math.max(1, Number(renderNodeInstance?.params?.width) || 1920);
  const exportHeight = Math.max(1, Number(renderNodeInstance?.params?.height) || 1080);

  /**
   * A dedicated, offscreen `outputMode` Viewport mounted only while an
   * export is running (see the JSX below) — separate from the editor's own
   * viewport and from SplitViewport's preview pane, neither of which are
   * guaranteed to be mounted/visible while exporting, and both of which
   * would otherwise fight the export's own deterministic clock (see
   * captureFrame in Viewport.tsx) with real-time playback. `exportHandleRef`
   * is filled in by that Viewport once its render loop is up.
   */
  const exportHandleRef = useRef<ViewportExportHandle | null>(null);
  const exportCancelledRef = useRef(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportMode, setExportMode] = useState<"video" | "sequence" | null>(null);
  const [exportSource, setExportSource] = useState<ExportSource>("3d");
  const [exportProgress, setExportProgress] = useState(0);
  // Canvas the export is rendering. Starts on the active one and follows Go To
  // Canvas nodes frame by frame, without touching the editor's own canvas.
  const [exportCanvas, setExportCanvas] = useState(0);
  const exportGraph = canvases[exportCanvas] ?? graph;
  const exportTourRef = useRef<CanvasTour | null>(null);
  const onExportEvaluated = useCallback(() => {
    const requested = consumeCanvasSwitchRequest();
    const tour = exportTourRef.current;
    if (requested === null || !tour || requested < 0 || requested >= CANVAS_COUNT) return;
    tour.switchTo(requested);
    setExportCanvas(requested);
  }, []);

  /**
   * Wraps the export viewport's handle so every frame reads its canvas's own
   * timeline, and says when the tour is over — see canvasTour.ts. Handed to
   * the exporters in place of the raw handle; `isCancelled` doubles as their
   * "scene chain finished" check.
   */
  const startCanvasTour = useCallback((handle: ViewportExportHandle) => {
    const tour = createCanvasTour(
      canvasesRef.current.map((c) => {
        const render = findRenderNode(c);
        const raw = Number(render?.params?.frameCount);
        return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 120;
      }),
      activeCanvasRef.current,
    );
    exportTourRef.current = tour;
    const tourHandle: ViewportExportHandle = {
      getCanvas: () => handle.getCanvas(),
      captureFrame: (frameIndex, fps) => handle.captureFrame(frameIndex, fps, tour.timelineFrame(frameIndex)),
    };
    return {
      handle: tourHandle,
      totalFrames: tour.maxFrames,
      isCancelled: () => exportCancelledRef.current || tour.done(),
      onProgress: (done: number) => setExportProgress(Math.min(1, done / Math.max(done, tour.expectedFrames()))),
    };
  }, []);

  const waitForExportHandle = useCallback(async () => {
    // Wait for the hidden export Viewport to mount and expose its handle
    const start = Date.now();
    while (!exportHandleRef.current && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const handle = exportHandleRef.current;
    if (!handle) throw new Error("Export view is not ready — retry.");
    // Extra tick to let the WebGL context, shaders, and initial layout settle
    await new Promise((r) => setTimeout(r, 100));
    return handle;
  }, []);

  /** Shared preflight for both export kinds; false means the export can't start. */
  const beginExport = useCallback(
    (mode: "video" | "sequence", source: ExportSource): boolean => {
      if (!renderNodeInstance || totalFrames <= 0) {
        alert("Add a Render node with at least one frame before exporting.");
        return false;
      }
      if (source === "2d" && !findView2DNodeId(graph)) {
        alert("Add a 2D Render node and wire a texture into it before exporting the 2D render.");
        return false;
      }
      // The export Viewport is remounted per export; a handle left over from
      // the previous one points at a dead render loop and would never resolve.
      exportHandleRef.current = null;
      exportCancelledRef.current = false;
      consumeCanvasSwitchRequest(); // drop any stale request left by the editor
      exportTourRef.current = null;
      setExportCanvas(activeCanvasRef.current);
      setExportSource(source);
      setIsExporting(true);
      setExportMode(mode);
      return true;
    },
    [renderNodeInstance, totalFrames, graph],
  );

  const handleExportVideo = useCallback(async (source: ExportSource = "3d") => {
    if (!beginExport("video", source)) return;
    setExportProgress(0);
    try {
      const handle = await waitForExportHandle();

      const tour = startCanvasTour(handle);
      const videoOpts = {
        totalFrames: tour.totalFrames,
        fps: exportFps,
        onProgress: tour.onProgress,
        isCancelled: tour.isCancelled,
      };
      // Frame-exact WebCodecs encode first; MediaRecorder only where the webview can't encode any codec at this size.
      const exact = supportsWebCodecsExport() ? await exportVideoWebCodecs(tour.handle, videoOpts) : null;
      let blob = exact;
      console.info(`Video export: ${exact ? "WebCodecs (frame-exact)" : "MediaRecorder fallback"}`);
      if (!blob) {
        // A fresh tour: the probe above already advanced the first one.
        const retry = startCanvasTour(handle);
        blob = await exportVideo(retry.handle, { ...videoOpts, totalFrames: retry.totalFrames, onProgress: retry.onProgress, isCancelled: retry.isCancelled });
      }

      const base = (currentFilename.replace(/\.[^.]+$/, "") || "export") + (source === "2d" ? "_2d" : "");
      const suggested = `${base}.${mimeToExtension(blob.type)}`;
      await saveVideoBlob(blob, suggested);
    } catch (err) {
      // Tauri command failures reject with a plain string, not an Error, so
      // `(err as Error).message` was reliably undefined for exactly the
      // errors this needs to surface (a failed writeFile/dialog call).
      console.error("Video export failed:", err);
      const message = err instanceof Error ? err.message : String(err);
      alert("Video export failed: " + message);
    } finally {
      setIsExporting(false);
      setExportMode(null);
    }
  }, [beginExport, startCanvasTour, exportFps, currentFilename, waitForExportHandle]);

  const handleExportSequence = useCallback(async (source: ExportSource = "3d") => {
    if (!beginExport("sequence", source)) return;
    setExportProgress(0);
    try {
      const handle = await waitForExportHandle();

      const tour = startCanvasTour(handle);
      const blob = await exportPngSequence(tour.handle, {
        totalFrames: tour.totalFrames,
        fps: exportFps,
        onProgress: tour.onProgress,
        isCancelled: tour.isCancelled,
      });

      const base = (currentFilename.replace(/\.[^.]+$/, "") || "export") + (source === "2d" ? "_2d" : "");
      const suggested = `${base}_frames.zip`;
      await saveZipBlob(blob, suggested);
    } catch (err) {
      console.error("Image sequence export failed:", err);
      const message = err instanceof Error ? err.message : String(err);
      alert("Image sequence export failed: " + message);
    } finally {
      setIsExporting(false);
      setExportMode(null);
    }
  }, [beginExport, startCanvasTour, exportFps, currentFilename, waitForExportHandle]);

  const handleExportGraphSvg = useCallback(async () => {
    if (graph.nodes.length === 0) {
      alert("Nothing to export — this canvas is empty.");
      return;
    }
    try {
      // A multi-node selection exports just that subset (a focused schema for
      // docs); no selection (or a single node, which isn't a "subset" worth
      // isolating) exports the whole canvas.
      const onlyIds = selectedNodeIds.length > 1 ? new Set(selectedNodeIds) : undefined;
      const svg = renderGraphToSvg(graph, DEFAULT_REGISTRY, {
        title: currentFilename.replace(/\.[^.]+$/, ""),
        onlyIds,
      });
      const base = (currentFilename.replace(/\.[^.]+$/, "") || "graph") + (onlyIds ? "_selection" : "");
      await saveGraphSvg(svg, `${base}.svg`);
    } catch (err) {
      console.error("Graph SVG export failed:", err);
      const message = err instanceof Error ? err.message : String(err);
      alert("Graph SVG export failed: " + message);
    }
  }, [graph, selectedNodeIds, currentFilename]);

  const [isPlaying, setIsPlaying] = useState(false);
  // Per canvas: each has its own Render node and so its own frame count, and
  // coming back to a canvas should find it where you left it rather than
  // wherever another canvas's playhead happens to be.
  //
  // Kept in playheadStore, outside React state, together with the latest
  // evaluation results: both change every frame, and as App state they
  // re-rendered the whole editor — node canvas included — on every one.
  // Callbacks read them when they run; only the panels that display them
  // subscribe.
  const setCurrentFrame = useCallback((nextOrUpdater: number | ((prev: number) => number)) => {
    setPlayheadFrame(activeCanvasRef.current, nextOrUpdater);
  }, []);

  /**
   * Runs after every evaluation the viewport does. A Go To Canvas node can't
   * reach React state from inside `evaluate`, so it leaves its request in a
   * module slot (canvasSwitchStore) and it gets collected here — the same
   * indirection the Inspector node already uses to publish live values.
   */
  /**
   * Makes `nodeId` the active camera, every other Camera/Fly To node
   * inactive — the same exclusivity the Active checkbox enforces, reached
   * from the graph rather than the panel.
   *
   * Plain setGraph, not setGraphWithHistory: this fires when a Fly To
   * flight lands, so putting it in the undo stack would mean every flight
   * left an undo step nobody asked for, and Cmd+Z would rewind the camera
   * hand-off rather than the operator's last real edit.
   */
  const activateCameraNode = useCallback((nodeId: string) => {
    setGraph((prevGraph) => {
      const target = prevGraph.nodes.find((n) => n.id === nodeId);
      if (!target) return prevGraph;
      const isCameraLike = (type: string) => type === CAMERA_NODE.type || type === CAMERA_FLY_TO_NODE.type;
      if (!isCameraLike(target.type)) return prevGraph;
      if (target.params.active === true && prevGraph.nodes.every((n) => n.id === nodeId || !isCameraLike(n.type) || n.params.active !== true)) {
        // Already the sole active camera — returning the same graph keeps
        // this off the render path entirely.
        return prevGraph;
      }

      return {
        ...prevGraph,
        nodes: prevGraph.nodes.map((n) => {
          if (n.id === nodeId) return { ...n, params: { ...n.params, active: true } };
          if (isCameraLike(n.type)) return { ...n, params: { ...n.params, active: false } };
          return n;
        }),
      };
    });
  }, [setGraph]);

  const onEvaluatedResults = useCallback(
    (results: Map<string, Record<string, unknown>>) => {
      setEvaluatedResults(results);
      const requestedCanvas = consumeCanvasSwitchRequest();
      if (requestedCanvas !== null) switchCanvas(requestedCanvas);
      const handoff = consumeCameraHandoffRequest();
      if (handoff !== null) activateCameraNode(handoff);
      // Skin's bind pose, taken as a rig was connected: kept with the node, but not an undo step of its own.
      const binds = consumeSkinBindRequests();
      if (binds.length > 0) setGraph((prev) => withNodeParams(prev, new Map(binds.map((b) => [b.nodeId, b.params]))));
    },
    [switchCanvas, activateCameraNode, setGraph],
  );

  useEffect(() => {
    void maximizeMainWindow();
  }, []);

  /**
   * Hand the editor's shortcut handlers what they need to get out of the way
   * of a running scene: whether it is running, and which keys it listens for.
   *
   * Kept in a module rather than passed down because the handlers that have to
   * consult it live in three different trees — App, Viewport and the graph
   * canvas — and only one of them is a child of this component.
   */
  useEffect(() => {
    setPlaybackActive(isPlaying);
  }, [isPlaying]);

  /**
   * Throws away every simulation's accumulated state and returns to the start.
   *
   * Both halves matter. A physics world or a fluid grid holds history that
   * cannot be recomputed from the current frame, so it has to be rebuilt; and
   * rebuilding without rewinding would leave frame 120 showing a simulation
   * that has only ever run one frame, which is a state nothing else in the
   * timeline agrees with.
   */
  const handleResetSimulations = useCallback(() => {
    resetSimulations();
  }, []);

  /**
   * The rewind half lives here rather than in the button, so that whoever asks for a reset gets
   * both halves — the toolbar, the shortcut, and the Reset Simulations node, which can only reach
   * the epoch and has no way to move the playhead itself.
   */
  useEffect(() => onSimulationReset(() => setCurrentFrame(0)), [setCurrentFrame]);

  useEffect(() => {
    setGraphKeyBindings(collectKeyboardBindings(graph.nodes));
  }, [graph.nodes]);

  useEffect(() => {
    if (keyframesEnabled && totalFrames > 0) {
      setCurrentFrame((prev) => Math.max(0, Math.min(totalFrames - 1, prev)));
    }
  }, [totalFrames, keyframesEnabled, setCurrentFrame]);

  useEffect(() => {
    // No Render node, or Frame Count off: there is no timeline length left to
    // scrub or keyframe against, so the drawer can't stay open behind the
    // author's back — but Play/Pause is untouched, since it drives the live
    // scene (wind, physics, gamepad) regardless of any timeline length.
    if (!keyframesEnabled) {
      setSpaces((prev) => (prev.timeline ? { ...prev, timeline: false } : prev));
    }
  }, [keyframesEnabled]);

  /**
   * When the viewport last advanced the playhead itself. See the fallback
   * timer below, and Viewport's `onFrameChange`.
   */
  const viewportDrivenAtRef = useRef(0);
  const onViewportFrame = useCallback(
    (frame: number) => {
      // With the timeline off (Render's Frame Count checkbox), there is no
      // fixed length to advance a playhead along — the scrubber stays put
      // instead of silently ticking in the background.
      if (!keyframesEnabled) return;
      viewportDrivenAtRef.current = Date.now();
      setCurrentFrame(frame);
    },
    [keyframesEnabled, setCurrentFrame],
  );

  /**
   * Fallback playhead, for when no viewport is rendering to advance it —
   * graph-only view suspends both panes.
   *
   * A visible viewport drives the timeline off the very clock it renders on
   * (Viewport's `onFrameChange`), which is what keeps keyframed motion moving
   * between one render and the next; this timer stepping in at the same time
   * would put a second, unsynchronised clock back on the playhead and undo
   * that. So it yields whenever the viewport has reported recently.
   */
  useEffect(() => {
    if (!keyframesEnabled || !isPlaying || totalFrames <= 0) return;
    const interval = setInterval(() => {
      if (Date.now() - viewportDrivenAtRef.current < 200) return;
      setCurrentFrame((prev) => (prev + 1) % totalFrames);
    }, 1000 / 60);
    return () => clearInterval(interval);
  }, [keyframesEnabled, isPlaying, totalFrames, setCurrentFrame]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const activeEl = document.activeElement;
      const isInput =
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          activeEl.tagName === "SELECT" ||
          (activeEl as HTMLElement).isContentEditable);

      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      const code = e.code;

      // Reset is a chord, so it survives a scene that has claimed Space —
      // see isKeyReservedForPlayback, which never reserves a modified key.
      if (!isInput && !isCmdOrCtrl && e.shiftKey && (code === "Space" || e.key === " ")) {
        e.preventDefault();
        handleResetSimulations();
        return;
      }

      // A running scene owns the keys it listens for — see playbackKeys.ts.
      // Escape is the way out, since Space may now be the character's jump.
      if (!isInput && !isCmdOrCtrl && isKeyReservedForPlayback(e)) {
        if (e.key === "Escape") setIsPlaying(false);
        return;
      }
      if (!isInput && e.key === "Escape") {
        e.preventDefault();
        setIsPlaying(false);
        setGraphWithHistory((prevGraph) => {
          if (!selectedNodeId) return prevGraph;
          const instance = findNodeDeep(prevGraph, selectedNodeId);
          if (
            instance &&
            (instance.type === EDIT_MESH_NODE.type || instance.type === EDIT_MESH_POINTS_NODE.type)
          ) {
            const pts = instance.params.selectedPoints;
            const fcs = instance.params.selectedFaces;
            if ((Array.isArray(pts) && pts.length > 0) || (Array.isArray(fcs) && fcs.length > 0)) {
              return updateNodeDeep(prevGraph, instance.id, (n) => ({
                ...n,
                params: { ...n.params, selectedPoints: [], selectedFaces: [] },
              }));
            }
          }
          return prevGraph;
        });
        return;
      }

      // Space plays / pauses the whole engine — cloth, soft bodies, wind,
      // gamepad input, all of it — not just keyframe playback, so it works
      // with no Render node and with Frame Count off. keyframesEnabled only
      // gates the *scrub bar and keyframe drawer*, which need an actual
      // timeline length to make sense of.
      if (!isInput && (code === "Space" || e.key === " ") && !isCmdOrCtrl) {
        e.preventDefault();
        setIsPlaying((prev) => !prev);
      } else if (!isInput && (e.key === "t" || e.key === "T") && !isCmdOrCtrl && !isGraphZone()) {
        e.preventDefault();
        // No Render node, or Frame Count off: there is no timeline length to
        // scrub or keyframe against, so the timeline space stays closed.
        if (keyframesEnabled) toggleSpace("timeline");
      } else if (
        !isInput &&
        !isCmdOrCtrl &&
        !e.altKey &&
        (e.key === "1" || code === "Digit1" || code === "Numpad1")
      ) {
        if (!isKeyReservedForPlayback(e)) {
          e.preventDefault();
          toggleSpace("canvas");
        }
      } else if (
        !isInput &&
        !isCmdOrCtrl &&
        !e.altKey &&
        (e.key === "2" || code === "Digit2" || code === "Numpad2")
      ) {
        if (!isKeyReservedForPlayback(e)) {
          e.preventDefault();
          toggleSpace("view3D");
        }
      } else if (
        !isInput &&
        !isCmdOrCtrl &&
        !e.altKey &&
        (e.key === "3" || code === "Digit3" || code === "Numpad3")
      ) {
        if (!isKeyReservedForPlayback(e)) {
          e.preventDefault();
          toggleSpace("camera");
        }
      } else if (
        !isInput &&
        !isCmdOrCtrl &&
        !e.altKey &&
        (e.key === "4" || code === "Digit4" || code === "Numpad4")
      ) {
        if (!isKeyReservedForPlayback(e)) {
          e.preventDefault();
          toggleSpace("timeline");
        }
      } else if (
        !isInput &&
        !isCmdOrCtrl &&
        !e.altKey &&
        (e.key === "5" || code === "Digit5" || code === "Numpad5")
      ) {
        if (!isKeyReservedForPlayback(e)) {
          e.preventDefault();
          toggleSpace("view2D");
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [keyframesEnabled, handleResetSimulations, toggleSpace]);

  const onToggleKeyframe = useCallback(
    (nodeId: string, paramKey: string, frame: number, currentValue: any) => {
      setGraph((prevGraph) => {
        const currentKeyframes = prevGraph.keyframes || {};
        const nodeKeyframes = currentKeyframes[nodeId] || {};
        const paramList = nodeKeyframes[paramKey] || [];

        const existingIndex = paramList.findIndex((k) => k.frame === frame);
        let nextList: Keyframe[];

        if (existingIndex >= 0) {
          nextList = paramList.filter((_, idx) => idx !== existingIndex);
        } else {
          const newKeyframe: Keyframe = { frame, value: serializeKeyframeValue(currentValue) };
          nextList = [...paramList, newKeyframe].sort((a, b) => a.frame - b.frame);
        }

        const nextNodeKeyframes = { ...nodeKeyframes };
        if (nextList.length > 0) {
          nextNodeKeyframes[paramKey] = nextList;
        } else {
          delete nextNodeKeyframes[paramKey];
        }

        const nextKeyframeStore = { ...currentKeyframes, [nodeId]: nextNodeKeyframes };
        if (Object.keys(nextNodeKeyframes).length === 0) {
          delete nextKeyframeStore[nodeId];
        }

        return {
          ...prevGraph,
          keyframes: nextKeyframeStore,
        };
      });
    },
    [],
  );

  // One epoch per session, not per edit — clock.ts's Time node just needs
  // both windows agreeing on a shared "when did frame 0 happen," there's no
  // discontinuous world state here to restart (unlike OpenVMap 2D's physics
  // epoch, which *does* get re-stamped on structural physics changes).
  const [epochMs] = useState(() => Date.now());
  const graphRef = useRef(graph);
  graphRef.current = graph;

  /**
   * Free the cached mesh/texture/toggle state of any node that has left the
   * graph, whatever made it leave.
   *
   * Node ids are stable — saved into the .tsuji, restored identically by undo
   * — so a cache entry that outlives its node is not just a leak: the next
   * node to carry that id silently inherits it (see nodeCaches.ts). This
   * used to be handled in exactly one place, the editor's own onNodesDelete
   * callback, which meant every *other* way a node can vanish leaked: undo
   * of an add, redo of a delete, New, Open, or any programmatic graph
   * replacement. Reconciling against the graph itself covers all of them,
   * and needs no cooperation from whatever did the removing.
   */
  const knownNodeIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // Across *every* canvas, not just the open one: a node in a canvas that
    // isn't on screen has not left the document, and reconciling against the
    // active canvas alone would free the meshes of all five others the
    // moment you switched — the exact opposite of what makes switching
    // instant.
    // Interiors included: a group holds real nodes owning real meshes, and
    // deleting the group is the only thing that ever removes them.
    const currentIds = new Set(canvases.flatMap((canvas) => collectAllNodeIds(canvas)));
    const departed = [...knownNodeIdsRef.current].filter((id) => !currentIds.has(id));
    if (departed.length > 0) disposeNodeCaches(departed);
    knownNodeIdsRef.current = currentIds;
  }, [canvases]);
  // Not React state on purpose — this changes at orbit-drag frequency, and
  // nothing in this component's own render output depends on it (only the
  // outgoing broadcast does). A state variable here would re-render
  // MainEditor's whole tree on every orbit tick for no visual benefit.
  const previewCameraRef = useRef<PreviewCameraPose | null>(null);

  // Deep: the selection can be a node inside a group the editor has dived
  // into, and the param panel has to reach it the same way it reaches any
  // other node.
  const selectedInstance = (selectedNodeId ? findNodeDeep(graph, selectedNodeId) : undefined) ?? null;
  const selectedDef = resolveDefinition(selectedInstance ?? undefined, DEFAULT_REGISTRY);
  // Which node's calibration handles the output window should draw, if any —
  // broadcast alongside the graph so the operator can align against the
  // real room through the actual projection, not just the editor preview.
  const calibratingNodeId = selectedInstance && selectedInstance.type === CAMERA_NODE.type ? selectedInstance.id : null;
  // A selectable object with nothing to drag — worth telling the operator
  // why the gizmo didn't show up, rather than leaving it a silent no-op.
  const needsTransformHint =
    !!selectedInstance &&
    GIZMO_SELECTABLE_TYPES.includes(selectedInstance.type) &&
    resolveGizmoTarget(graph, selectedInstance.id) === null;

  // Handshake responder: an output window that opens after this one already
  // has state emits "output:ready" on mount; this answers with current
  // state, previewCameraRef included so a late-opened output window gets
  // the editor's current view immediately rather than a stale default.
  useEffect(
    () =>
      startBroadcasting(() => ({
        graph: graphRef.current,
        epochMs,
        calibratingNodeId,
        previewCamera: previewCameraRef.current,
      })),
    [epochMs, calibratingNodeId],
  );
  // Push broadcast on every structural graph change or calibration-target
  // change — not per frame; each window's own render loop derives per-frame
  // animation locally from the shared epoch (see clock.ts), so this is the
  // only IPC that happens on its own. The camera pose broadcasts
  // separately, imperatively, from onPreviewCameraChange below — it
  // changes at orbit-drag frequency, entirely decoupled from graph edits.
  useEffect(() => {
    broadcastGraph({ graph, epochMs, calibratingNodeId, previewCamera: previewCameraRef.current });
  }, [graph, epochMs, calibratingNodeId]);

  // Video mapping wires up a Camera node and the output locks to its
  // calibrated pose — orbiting here must never disturb that (see
  // Viewport.tsx's calibrationMatrix branch). Motion design has no
  // projector to align against; there the output is a preview monitor, and
  // mirroring whatever the editor is currently looking at (Blender's
  // viewport/render relationship) beats a fixed angle nobody chose. The
  // output window itself decides which of the two applies — it already
  // knows whether a Camera node exists — this just keeps it fed either way.
  const onPreviewCameraChange = (pose: PreviewCameraPose) => {
    previewCameraRef.current = pose;
    broadcastCamera(pose);
  };

  interface HistoryEntry {
    graph: Graph;
    selectedNodeId: string | null;
    selectedNodeIds: string[];
  }

  /**
   * Undo history per canvas, keyed by canvas index. Cmd+Z after switching
   * canvases undoes the last edit made *in the canvas you're looking at* —
   * a single shared stack would have reached back into a tree that isn't on
   * screen, undoing something invisible.
   */
  const historyRef = useRef<Record<number, { past: HistoryEntry[]; future: HistoryEntry[] }>>({});
  const canvasHistory = useCallback(() => {
    const index = activeCanvasRef.current;
    return (historyRef.current[index] ??= { past: [], future: [] });
  }, []);
  /**
   * Which (node, param) a run of edits is currently touching, so one slider
   * drag or one typed number collapses into a single undo step. Without it
   * every wheel notch pushed its own snapshot and a couple of drags evicted
   * the whole 50-entry history.
   */
  const coalesceRef = useRef<{ key: string; at: number } | null>(null);
  /**
   * The exact graph object the top-of-stack snapshot was cloned *from*.
   * pushHistory compares against this to catch the "several edits landed in
   * one event batch, before graphRef caught up" case a content-equality
   * check used to guard with `JSON.stringify(top) === JSON.stringify(snapshot)`
   * — two full-graph stringifies, on top of the clone already taken, on
   * every single non-coalesced push. That's noise for a small graph and
   * ruinous for one carrying large baked arrays (an exploded glTF's
   * geometry): a reference check is exact here (React always hands back a
   * fresh object on a real change) and costs nothing.
   */
  const lastSnapshotSourceRef = useRef<Graph | null>(null);

  /**
   * Records the graph as it is *right now* as one undo step.
   *
   * Deliberately outside any `setGraph` updater: React invokes updaters twice
   * under StrictMode, so pushing from inside recorded every edit twice and
   * undo needed two presses per change in dev. Updaters have to stay pure.
   */
  const pushHistory = useCallback((coalesceKey?: string) => {
    const now = Date.now();
    const previous = coalesceRef.current;
    coalesceRef.current = coalesceKey ? { key: coalesceKey, at: now } : null;

    // Still dialling the same control — fold into the step already recorded.
    if (coalesceKey && previous && previous.key === coalesceKey && now - previous.at < HISTORY_COALESCE_MS) return;

    // Several edits can land in one event batch, before graphRef has caught
    // up — without this they'd each store the same pre-batch graph. See
    // lastSnapshotSourceRef's own comment for why this is a reference check
    // rather than the content-equality check it replaced.
    if (lastSnapshotSourceRef.current === graphRef.current) return;

    const history = canvasHistory();
    const snapshot: HistoryEntry = {
      graph: cloneGraph(graphRef.current),
      selectedNodeId: selectedNodeIdRef.current,
      selectedNodeIds: [...selectedNodeIdsRef.current],
    };
    history.past.push(snapshot);
    if (history.past.length > HISTORY_LIMIT) history.past.shift();
    history.future = [];
    lastSnapshotSourceRef.current = graphRef.current;
  }, [canvasHistory]);

  const setGraphWithHistory = useCallback(
    (nextGraphOrUpdater: Graph | ((prev: Graph) => Graph), coalesceKey?: string) => {
      pushHistory(coalesceKey);
      setGraph((prev) => (typeof nextGraphOrUpdater === "function" ? nextGraphOrUpdater(prev) : nextGraphOrUpdater));
    },
    [pushHistory, setGraph],
  );

  const undo = useCallback(() => {
    const history = canvasHistory();
    if (history.past.length === 0) return;
    const currentSelectedId = selectedNodeIdRef.current;
    const currentSelectedIds = [...selectedNodeIdsRef.current];
    const previous = history.past.pop()!;
    history.future.unshift({
      graph: cloneGraph(graphRef.current),
      selectedNodeId: currentSelectedId,
      selectedNodeIds: currentSelectedIds,
    });
    coalesceRef.current = null;
    setGraph(previous.graph);

    let targetId: string | null = null;
    let targetIds: string[] = [];
    if (currentSelectedId && previous.graph.nodes.some((n) => n.id === currentSelectedId)) {
      targetId = currentSelectedId;
      targetIds = currentSelectedIds.filter((id) => previous.graph.nodes.some((n) => n.id === id));
      if (targetIds.length === 0) targetIds = [currentSelectedId];
    } else if (previous.selectedNodeId && previous.graph.nodes.some((n) => n.id === previous.selectedNodeId)) {
      targetId = previous.selectedNodeId;
      targetIds = previous.selectedNodeIds.filter((id) => previous.graph.nodes.some((n) => n.id === id));
      if (targetIds.length === 0) targetIds = [targetId];
    }

    handleSelectNode(targetId);
    if (targetIds.length > 0) {
      handleSelectNodes(targetIds);
    }
    setEditorKey((k) => k + 1);
  }, [canvasHistory, handleSelectNode, handleSelectNodes, setGraph]);

  const redo = useCallback(() => {
    const history = canvasHistory();
    if (history.future.length === 0) return;
    const currentSelectedId = selectedNodeIdRef.current;
    const currentSelectedIds = [...selectedNodeIdsRef.current];
    const next = history.future.shift()!;
    history.past.push({
      graph: cloneGraph(graphRef.current),
      selectedNodeId: currentSelectedId,
      selectedNodeIds: currentSelectedIds,
    });
    coalesceRef.current = null;
    setGraph(next.graph);

    let targetId: string | null = null;
    let targetIds: string[] = [];
    if (currentSelectedId && next.graph.nodes.some((n) => n.id === currentSelectedId)) {
      targetId = currentSelectedId;
      targetIds = currentSelectedIds.filter((id) => next.graph.nodes.some((n) => n.id === id));
      if (targetIds.length === 0) targetIds = [currentSelectedId];
    } else if (next.selectedNodeId && next.graph.nodes.some((n) => n.id === next.selectedNodeId)) {
      targetId = next.selectedNodeId;
      targetIds = next.selectedNodeIds.filter((id) => next.graph.nodes.some((n) => n.id === id));
      if (targetIds.length === 0) targetIds = [targetId];
    }

    handleSelectNode(targetId);
    if (targetIds.length > 0) {
      handleSelectNodes(targetIds);
    }
    setEditorKey((k) => k + 1);
  }, [canvasHistory, handleSelectNode, handleSelectNodes, setGraph]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const activeEl = document.activeElement;
      const isInput =
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          activeEl.tagName === "SELECT" ||
          (activeEl as HTMLElement).isContentEditable);
      if (isInput) return;

      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      const isShift = e.shiftKey;
      const key = e.key.toLowerCase();

      if (isCmdOrCtrl && key === "z") {
        if (isShift) {
          e.preventDefault();
          redo();
        } else {
          e.preventDefault();
          undo();
        }
      } else if (isCmdOrCtrl && key === "y") {
        e.preventDefault();
        redo();
      } else if (isCmdOrCtrl && isShift && key === "e") {
        // Free — doesn't collide with Cmd/Ctrl+E (unused) or the plain Export
        // menu, which lives under Share instead of a shortcut.
        e.preventDefault();
        handleExportGraphSvg();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [undo, redo, handleExportGraphSvg]);

  /**
   * Dropping files on the window — the 3D view or the node canvas — creates, for each image or video, an Image Texture wired to a
   * Texture to Plane, and for each sound an Audio Player. On the node canvas the nodes land where the files were released; elsewhere they go beside the existing nodes.
   */
  const addDroppedImages = useCallback(
    (images: DroppedImage[], at: { clientX: number; clientY: number } | null) => {
      if (images.length === 0) return;
      setGraphWithHistory((prevGraph) => {
        const projected = at ? projectDrop(at.clientX, at.clientY) : null;
        const right = prevGraph.nodes.reduce((m, n) => Math.max(m, n.position.x), 0);
        const top = prevGraph.nodes.length ? Math.min(...prevGraph.nodes.map((n) => n.position.y)) : 0;
        const origin = projected ?? { x: prevGraph.nodes.length ? right + 360 : 120, y: prevGraph.nodes.length ? top : 120 };
        const added = buildDroppedNodes(images, origin);
        return { ...prevGraph, nodes: [...prevGraph.nodes, ...added.nodes], connections: [...prevGraph.connections, ...added.connections] };
      }, "drop:images");
    },
    [setGraphWithHistory],
  );

  useEffect(() => {
    const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onDragOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    // Browser build: the files arrive as File objects.
    const onDrop = async (e: DragEvent) => {
      if (!carriesFiles(e) || !e.dataTransfer) return;
      // Taken before anything is awaited: the event's data is gone once the handler yields.
      const transfer = e.dataTransfer;
      const at = { clientX: e.clientX, clientY: e.clientY };
      const hasFolder = Array.from(transfer.items ?? []).some((item) => item.webkitGetAsEntry?.()?.isDirectory);
      const top = Array.from(transfer.files ?? []).filter((f) => isDroppableMedia(f.name));
      if (top.length === 0 && !hasFolder) return;
      e.preventDefault();

      // A model rarely comes alone: a .gltf has its .bin and textures beside it, which a browser can only read if they were
      // dropped with it — the files, or the folder holding them. Everything in the drop is kept readable for the loaders.
      const all = hasFolder || top.some((f) => droppedKind(f.name) === "model") ? await filesFromDrop(transfer) : [];
      const models = all.filter(({ file }) => droppedKind(file.name) === "model");
      if (models.length > 0) addBrowserFiles(all);

      const chosen = models.length > 0 ? [...models, ...top.filter((f) => droppedKind(f.name) !== "model").map((file) => ({ path: file.name, file }))] : top.map((file) => ({ path: file.name, file }));
      if (chosen.length === 0) return;
      const images = await Promise.all(chosen.map(async ({ path, file }) => ({ path: path.split("/").pop() ?? file.name, bytes: new Uint8Array(await file.arrayBuffer()) })));
      addDroppedImages(images, at);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);

    // Desktop build: Tauri takes file drops over itself and reports real paths, in physical pixels.
    let unlisten: (() => void) | null = null;
    let disposed = false;
    if (isTauri()) {
      void (async () => {
        const [{ getCurrentWebview }, { readFile }] = await Promise.all([import("@tauri-apps/api/webview"), import("@tauri-apps/plugin-fs")]);
        const stop = await getCurrentWebview().onDragDropEvent(async (event) => {
          if (event.payload.type !== "drop") return;
          const paths = event.payload.paths.filter((p) => isDroppableMedia(p));
          if (paths.length === 0) return;
          const ratio = window.devicePixelRatio || 1;
          const images: DroppedImage[] = [];
          for (const path of paths) {
            try {
              images.push({ path, bytes: await readFile(path) });
            } catch (err) {
              console.error(`Drop: could not read ${path}:`, err);
            }
          }
          addDroppedImages(images, { clientX: event.payload.position.x / ratio, clientY: event.payload.position.y / ratio });
        });
        if (disposed) stop();
        else unlisten = stop;
      })();
    }
    return () => {
      disposed = true;
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      unlisten?.();
    };
  }, [addDroppedImages]);

  const handleLoadProject = (newProject: Project, filename?: string) => {
    historyRef.current = {};
    lastSnapshotSourceRef.current = null;
    hasUnsavedEditsRef.current = false;
    const rehydrated = normalizeCanvases(newProject.canvases).map((canvas) =>
      rehydrateGraphParams(canvas, DEFAULT_REGISTRY),
    );
    setCanvases(rehydrated);
    setActiveCanvas(newProject.activeCanvas);
    activeCanvasRef.current = newProject.activeCanvas;
    resetPlayheadFrames();
    setSelectedNodeId(null);
    setSelectedNodeIds([]);
    setEditorKey((k) => k + 1);
    if (filename) {
      setCurrentFilename(filename);
    }
    // File-backed nodes (CSV Reader, OBJ Model, Image Texture, Audio
    // Player, ...) only store the picked path in the graph, never the
    // loaded data itself — see rehydrateFileNodesFromDisk. Re-read every
    // such file from disk, then nudge state so the param panel (column
    // dropdowns, filenames) refreshes once the data lands; evaluate()
    // itself already re-reads each node's cache live every tick, so the
    // 3D view/audio alone would've caught up on their own. Every canvas is
    // re-read, not just the open one: switching to another canvas later must
    // not be the moment its files start loading.
    for (const canvas of rehydrated) {
      rehydrateFileNodesFromDisk(canvas).then(({ attempted }) => {
        // Refresh whenever a reload actually ran (whether a given file read
        // succeeded or failed) so the param panel drops its loading state;
        // a graph with no file nodes legitimately stays put.
        if (attempted > 0) setCanvases((prev) => [...prev]);
      });
    }
  };

  // ---------------------------------------------------------------------
  // Autosave + unload guard
  //
  // The browser build has no file behind the document, so until this existed a
  // refresh (or a lost WebGL context taking the tab with it) silently discarded
  // the session. The snapshot is debounced rather than written per keystroke:
  // a graph edit fires on every gizmo drag frame, and localStorage writes are
  // synchronous and would stall the render loop.
  // ---------------------------------------------------------------------
  const hasUnsavedEditsRef = useRef(false);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The autosave effect also runs once on mount, which is not an edit — without
  // this, merely opening the editor and closing the tab raised the browser's
  // "leave site?" prompt over a document nobody had touched.
  const autosaveSettledRef = useRef(false);

  /** Called after an explicit Save/Save As/Incremental Save writes a real file. */
  const handleProjectSaved = useCallback(() => {
    hasUnsavedEditsRef.current = false;
  }, []);

  useEffect(() => {
    if (autosaveSettledRef.current) hasUnsavedEditsRef.current = true;
    else autosaveSettledRef.current = true;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      writeAutosave({ canvases, activeCanvas }, currentFilename);
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [canvases, activeCanvas, currentFilename]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // Nothing to protect, and — since the snapshot is per-origin, not per-tab
      // — writing anyway would let a stale second tab clobber the tab that is
      // actually being worked in as it closes.
      if (!hasUnsavedEditsRef.current) return;
      // Flush synchronously: the debounce may still be pending, and this is the
      // last moment the document exists. beforeunload is one of the few places
      // a synchronous localStorage write is the right call.
      writeAutosave({ canvases, activeCanvas }, currentFilename);
      // Only the presence of preventDefault still decides whether the browser
      // shows its own "leave site?" dialog — the custom string was dropped
      // years ago, and returnValue is kept purely for older engines.
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [canvases, activeCanvas, currentFilename]);

  // A recovered document carries file-backed nodes (CSV, OBJ, textures, audio)
  // that only stored their *path*, exactly like a document opened from disk —
  // so it needs the same re-read pass. A no-op in the browser, where those
  // paths can't be reopened without the user re-picking the file.
  useEffect(() => {
    if (!recovered) return;
    for (const canvas of canvasesRef.current) {
      rehydrateFileNodesFromDisk(canvas).then(({ attempted }) => {
        if (attempted > 0) setCanvases((prev) => [...prev]);
      });
    }
    // Recovery runs once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFilenameChange = (name: string, path: string | null) => {
    setCurrentFilename(name);
    setCurrentFilePath(path);
  };

  const onParamChange = (
    paramId: string | Record<string, unknown>,
    value?: unknown,
    targetNodeId?: string,
    options?: { coalesce?: boolean },
  ) => {
    const currentFrame = getPlayheadFrame(activeCanvasRef.current);
    if (typeof paramId === "object" && paramId !== null) {
      const updates = paramId as Record<string, unknown>;
      const nodeIdToUpdate = (value as string | undefined) ?? selectedNodeId;
      if (!nodeIdToUpdate) return;
      setGraphWithHistory((prevGraph) => {
        const instance = findNodeDeep(prevGraph, nodeIdToUpdate);
        if (!instance) return prevGraph;
        const nextParams = { ...instance.params };
        for (const [k, v] of Object.entries(updates)) {
          nextParams[k] = cloneParamValue(v);
        }
        return updateNodeDeep(prevGraph, instance.id, (n) => ({ ...n, params: nextParams }));
      }, coalesceKeyFor(nodeIdToUpdate, "batch", options));
      return;
    }
    const nodeIdToUpdate = targetNodeId ?? selectedNodeId;
    setGraphWithHistory((prevGraph) => {
      const instance = nodeIdToUpdate ? findNodeDeep(prevGraph, nodeIdToUpdate) : undefined;
      if (!instance) return prevGraph;

      const isActivatingCamera =
        (instance.type === CAMERA_NODE.type || instance.type === CAMERA_FLY_TO_NODE.type) &&
        paramId === "active" &&
        (value === true || value === 1);

      let nextKeyframes =
        keyframesEnabled && currentFrame >= 0 && nodeIdToUpdate && paramId !== "frames"
          ? applyKeyframedParamUpdate(prevGraph.keyframes, nodeIdToUpdate, paramId, value, currentFrame)
          : prevGraph.keyframes;

      if (
        nodeIdToUpdate &&
        (instance.type === "curve/grease-pencil" || instance.type === "curve/paint-on-geometry") &&
        paramId === "frames" &&
        Array.isArray(value)
      ) {
        const gpFrames = value as KeyframeDrawing[];
        const currentStore = nextKeyframes ? { ...nextKeyframes } : {};
        const nodeStore = currentStore[nodeIdToUpdate] ? { ...currentStore[nodeIdToUpdate] } : {};
        nodeStore["frames"] = gpFrames
          .map((f) => ({
            frame: f.frame,
            value: f.frame,
            easeIn: "hold" as const,
          }))
          .sort((a, b) => a.frame - b.frame);
        currentStore[nodeIdToUpdate] = nodeStore;
        nextKeyframes = currentStore;
      }

      let nextParams = { ...instance.params };
      // Preserve THREE instances instead of JSON-round-tripping them: a
      // THREE.Color (the Color node's `color`, an Environment's `background`,
      // ...) flattened to a plain {r,g,b} fails every node's `instanceof`
      // guard and silently falls back to its default (white for the Color
      // node). cloneParamValue clones the same classes the undo/clipboard
      nextParams[paramId] = cloneParamValue(value);

      if (instance.type === EDIT_MESH_NODE.type && paramId === "shading") {
        const selectedFaces: number[] = Array.isArray(instance.params.selectedFaces)
          ? (instance.params.selectedFaces as number[])
          : [];
        const rawMesh = (instance.params.meshData as QuadMesh) || createQuadBox(1, 1, 1);
        const updatedMesh = cloneQuadMesh(rawMesh);
        const shadeMode = value as QuadMeshShading;
        if (selectedFaces.length > 0) {
          const faceShading: QuadMeshShading[] = updatedMesh.faceShading
            ? [...updatedMesh.faceShading]
            : new Array(updatedMesh.faces.length).fill(updatedMesh.shading || "auto");
          for (const f of selectedFaces) {
            faceShading[f] = shadeMode;
          }
          updatedMesh.faceShading = faceShading;
        } else {
          updatedMesh.shading = shadeMode;
          updatedMesh.faceShading = undefined;
        }
        nextParams["meshData"] = updatedMesh;
      }

      // When the pivot is moved, compensate location so that the geometry remains
      // completely stationary in world space.
      // local = T(piv + loc) * (R * S) * T(-piv) = T(loc + (I - R * S) * piv) * (R * S)
      // Maintaining geometry position across deltaPiv = newPiv - oldPiv requires:
      // deltaLoc = (R * S) * deltaPiv - deltaPiv
      if (paramId === "pivot" && "location" in instance.params) {
        const oldPiv = asVector3(instance.params.pivot, new THREE.Vector3());
        const newPiv = asVector3(value, new THREE.Vector3());
        const deltaPiv = new THREE.Vector3().subVectors(newPiv, oldPiv);
        if (deltaPiv.lengthSq() > 0) {
          const rot = asVector3(instance.params.rotation, new THREE.Vector3());
          const scl = asVector3(instance.params.scale, new THREE.Vector3(1, 1, 1));
          const mRotScale = composeTransform(new THREE.Vector3(), rot, scl, withDefaultParams(instance));
          const deltaPivRotScaled = deltaPiv.clone().applyMatrix4(mRotScale);
          const deltaLoc = new THREE.Vector3().subVectors(deltaPivRotScaled, deltaPiv);
          const oldLoc = asVector3(instance.params.location, new THREE.Vector3());
          const newLoc = oldLoc.clone().add(deltaLoc);
          nextParams.location = newLoc;

          if (nodeIdToUpdate && keyframesEnabled && currentFrame >= 0 && nextKeyframes?.[nodeIdToUpdate]?.["location"]) {
            nextKeyframes = applyKeyframedParamUpdate(
              nextKeyframes,
              nodeIdToUpdate,
              "location",
              newLoc,
              currentFrame,
            );
          }
        }
      }

      // A lattice's control points are stored as absolute positions, so the
      // grid they describe has to be rebuilt when its dimensions change —
      // the node's own evaluate is pure and cannot write them back. See
      // latticeParamsWithRebuiltGrid.
      if (
        instance.type === LATTICE_DEFORM_NODE.type &&
        (LATTICE_GRID_PARAM_IDS as readonly string[]).includes(paramId)
      ) {
        nextParams = latticeParamsWithRebuiltGrid(nextParams);
      }

      // Only one camera is active at a time, and that rule is about the
      // document, not a level of it — a camera inside a group counts.
      const withCamerasOff = isActivatingCamera
        ? {
            ...prevGraph,
            nodes: prevGraph.nodes.map((n) =>
              n.type === CAMERA_NODE.type || n.type === CAMERA_FLY_TO_NODE.type
                ? { ...n, params: { ...n.params, active: false } }
                : n,
            ),
          }
        : prevGraph;

      return {
        ...updateNodeDeep(withCamerasOff, instance.id, (n) => ({ ...n, params: nextParams })),
        keyframes: nextKeyframes,
      };
    }, coalesceKeyFor(nodeIdToUpdate, String(paramId), options));
  };

  const onToggleExposed = useCallback(
    (nodeId: string, paramId: string) => {
      setGraphWithHistory((prevGraph) => {
        const existing = prevGraph.exposedParams ?? [];
        const already = existing.some((e) => e.nodeId === nodeId && e.paramId === paramId);
        const next = already
          ? existing.filter((e) => !(e.nodeId === nodeId && e.paramId === paramId))
          : [...existing, { nodeId, paramId }];
        return { ...prevGraph, exposedParams: next };
      }, `exposeToggle:${nodeId}:${paramId}`);
    },
    [setGraphWithHistory],
  );

  // A blank label clears the override rather than storing "" — the HUD row
  // then falls back to the field's own label, same as a pin that was never
  // renamed at all, instead of rendering an empty row header forever.
  const onRenameExposed = useCallback(
    (nodeId: string, paramId: string, label: string) => {
      const trimmed = label.trim();
      setGraphWithHistory((prevGraph) => {
        const existing = prevGraph.exposedParams ?? [];
        const next = existing.map((e) =>
          e.nodeId === nodeId && e.paramId === paramId ? { ...e, label: trimmed || undefined } : e,
        );
        return { ...prevGraph, exposedParams: next };
      }, `exposeRename:${nodeId}:${paramId}`);
    },
    [setGraphWithHistory],
  );

  // Tab toggles the selected object's own Visible param — only while the
  // mouse is over the node graph canvas (isGraphZone), since the 3D
  // viewport already binds plain Tab to its own UI-overlay toggle (see
  // Viewport.tsx) and Shift+Tab to cycling views; without this gate both
  // fired on every Tab press regardless of where the mouse was. Also only
  // while a node with a Visible param is selected, so it doesn't fight the
  // browser's own focus-Tab otherwise. A separate effect from the Space/T
  // handler above (rather than folding this branch into it) because it
  // needs onParamChange, which isn't defined until after that one.
  useEffect(() => {
    function handleTab(e: KeyboardEvent) {
      const activeEl = document.activeElement;
      const isInput =
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          activeEl.tagName === "SELECT" ||
          (activeEl as HTMLElement).isContentEditable);
      if (isInput || e.key !== "Tab" || e.metaKey || e.ctrlKey || e.altKey || !selectedNodeId || !isGraphZone()) return;

      const instance = graph.nodes.find((n) => n.id === selectedNodeId);
      const def = resolveDefinition(instance, DEFAULT_REGISTRY);
      if (!instance || !def || !("visible" in def.defaultParams)) return;

      e.preventDefault();
      const current = instance.params.visible !== undefined ? instance.params.visible : def.defaultParams.visible;
      onParamChange("visible", toBoolean(current) ? 0 : 1, selectedNodeId);
    }
    window.addEventListener("keydown", handleTab);
    return () => window.removeEventListener("keydown", handleTab);
  }, [selectedNodeId, graph.nodes, onParamChange]);

  /** Handles a "button" ParamFieldDef click (see ParamPanel's onAction). */
  const onParamAction = useCallback(
    (nodeId: string, action: string) => {
      const currentFrame = getPlayheadFrame(activeCanvasRef.current);
      const evaluatedResults = getEvaluatedResults();
      if (action === TOGGLE_POINTS_KEYFRAME_ACTION) {
        const node = findNodeDeep(graph, nodeId);
        if (!node || currentFrame < 0) return;
        let points = node.params.pointsList;
        if (node.type === EDIT_MESH_POINTS_NODE.type && (!Array.isArray(points) || points.length === 0)) {
          const inputs = evaluatedResults?.get(nodeId)?.__evaluatedInputs as Record<string, unknown> | undefined;
          const basisObj = inputs?.basis;
          if (basisObj instanceof THREE.Object3D) {
            const extracted = extractPointsFromMesh(basisObj, nodeId, "Edit Mesh Points");
            if (extracted) {
              points = extracted.points;
              onParamChange("pointsList", extracted.points, nodeId);
            }
          }
        }
        // A skeleton still at rest stores no controls; keyframe the ones it shows.
        if (isIkControlNode(node) && (!Array.isArray(points) || points.length === 0)) {
          const derived = evaluatedResults?.get(nodeId)?.__controlPoints;
          if (Array.isArray(derived)) points = derived.map((p) => (p as THREE.Vector3).clone());
        }
        onToggleKeyframe(nodeId, "pointsList", currentFrame, points);
        return;
      }
      if (action === SKIN_COMPUTE_ACTION) {
        const node = findNodeDeep(graph, nodeId);
        const patch = node ? computeSkinWeightTargets(nodeId, node.params) : null;
        if (patch) onParamChange(patch, undefined, nodeId);
        return;
      }
      if (action === SKIN_REWEIGH_ACTION) {
        const node = findNodeDeep(graph, nodeId);
        if (node) onParamChange(skinReweighParams(node.params), undefined, nodeId);
        return;
      }
      if (action === RESEED_MESH_POINTS_ACTION) {
        // The exact Basis object this node last resolved and rendered from —
        // evaluate.ts stores every node's resolved inputs alongside its
        // outputs precisely so a case like this can read back what a socket
        // actually saw, without re-deriving it from the graph.
        const inputs = evaluatedResults?.get(nodeId)?.__evaluatedInputs as Record<string, unknown> | undefined;
        const basisObj = inputs?.basis;
        if (!(basisObj instanceof THREE.Object3D)) {
          console.warn("Edit Mesh Points: nothing wired into Basis yet.");
          return;
        }
        const extracted = extractPointsFromMesh(basisObj, nodeId, "Edit Mesh Points");
        if (!extracted) return;
        onParamChange({ pointsList: extracted.points, selectedPoints: [] }, nodeId);
        return;
      }
      if (action === EDIT_MESH_RESEED_ACTION) {
        const inputs = evaluatedResults?.get(nodeId)?.__evaluatedInputs as Record<string, unknown> | undefined;
        const geomObj = inputs?.geometry;
        const mesh = geomObj instanceof THREE.Object3D ? findFirstMesh(geomObj) : null;
        let quadMesh: QuadMesh;
        if (mesh && mesh.geometry) {
          quadMesh = bufferGeometryToQuadMesh(mesh.geometry);
          quadMesh.sourceSignature = geometrySignature(mesh.geometry);
        } else {
          quadMesh = createQuadBox(1, 1, 1);
        }
        onParamChange({
          meshData: quadMesh,
          selectMode: "faces",
          selectedFaces: [],
          selectedPoints: [],
        }, nodeId);
        return;
      }
      if (action === EDIT_MESH_EXTRUDE_ACTION) {
        const node = findNodeDeep(graph, nodeId);
        if (!node) return;
        // A face operation: a points/edges selection would silently act on
        // whatever face list was left over from the last face selection.
        if (readEditMeshSelection(node).mode !== "faces") return;
        const meshData: QuadMesh = resolveEditMeshData(node, evaluatedResults);
        const selectedFaces: number[] = Array.isArray(node.params.selectedFaces)
          ? (node.params.selectedFaces as number[])
          : [];
        const dist = Number(node.params.extrudeDistance) || 0.5;
        const result = extrudeFaces(meshData, selectedFaces, dist);
        onParamChange({
          meshData: result.mesh,
          selectMode: "faces",
          selectedFaces: result.newFaces,
        }, nodeId);
        return;
      }
      if (action === EDIT_MESH_INSET_ACTION) {
        const node = findNodeDeep(graph, nodeId);
        if (!node) return;
        // A face operation: a points/edges selection would silently act on
        // whatever face list was left over from the last face selection.
        if (readEditMeshSelection(node).mode !== "faces") return;
        const meshData: QuadMesh = resolveEditMeshData(node, evaluatedResults);
        const selectedFaces: number[] = Array.isArray(node.params.selectedFaces)
          ? (node.params.selectedFaces as number[])
          : [];
        const thickness = Number.isFinite(Number(node.params.insetThickness)) ? Number(node.params.insetThickness) : 0.1;
        const depth = Number(node.params.insetDepth) || 0;
        const result = insetRegion(meshData, selectedFaces, thickness, depth);
        onParamChange({
          meshData: result.mesh,
          selectMode: "faces",
          selectedFaces: result.newFaces,
        }, nodeId);
        return;
      }
      if (action.startsWith(TOPOGRAPHY_PRESET_ACTION_PREFIX)) {
        const preset = TOPOGRAPHY_PRESETS[action.slice(TOPOGRAPHY_PRESET_ACTION_PREFIX.length)];
        if (preset) onParamChange({ ...preset }, nodeId);
        return;
      }
      if (action === TOPOGRAPHY_BAKE_ACTION) {
        const node = findNodeDeep(graph, nodeId);
        if (!node) return;

        // Hand the procedural result over to the paintable node: same
        // textures, same tiling, same names, and the weights it just computed
        // as a starting point to touch up by hand.
        const state = getHeightSlopeMixState(nodeId);
        if (!state.splatBuffer || !state.res) {
          console.warn("Topography Texture Mix: nothing baked yet.");
          return;
        }
        const layerCount = state.layerCount ?? 3;
        const splatData = serializeSplatToPng(state.splatBuffer, state.res, state.res, layerCount);

        const carried: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(node.params)) {
          if (key.startsWith("uvScale") || key.startsWith("layerName")) carried[key] = value;
        }

        const mixNode: NodeInstance = {
          id: `node_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          type: TEXTURE_MIX_PAINT_NODE.type,
          position: { x: (node.position?.x ?? 0) + 260, y: (node.position?.y ?? 0) + 40 },
          params: {
            ...cloneParams(TEXTURE_MIX_PAINT_NODE.defaultParams),
            ...carried,
            resolution: state.res,
            splatData,
          },
        };

        // Rewire the textures and the geometry the topography node was fed,
        // so the new node lands ready to paint rather than unconnected.
        const carriedConnections = graph.connections
          .filter((c) => c.toNode === nodeId && (c.toSocket === "geometry" || c.toSocket.startsWith("texture")))
          .map((c) => ({
            id: `conn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${c.toSocket}`,
            fromNode: c.fromNode,
            fromSocket: c.fromSocket,
            toNode: mixNode.id,
            toSocket: c.toSocket,
          }));

        setGraphWithHistory((prev) => ({
          ...prev,
          nodes: [...prev.nodes, mixNode],
          connections: [...prev.connections, ...carriedConnections],
        }));
        setSelectedNodeId(mixNode.id);
        return;
      }
      if (action === WORN_BAKE_ACTION) {
        void exportWornTextures(nodeId, evaluatedResults, findNodeDeep(graph, nodeId)?.params);
        return;
      }
      if (action === EDIT_MESH_SMART_UNWRAP_ACTION) {
        const node = findNodeDeep(graph, nodeId);
        if (!node) return;
        const meshData: QuadMesh = resolveEditMeshData(node, evaluatedResults);
        const angle = Number(node.params.uvAngleLimit) || 66;
        onParamChange("meshData", smartUnwrap(meshData, { angleLimitDeg: angle }), nodeId);
        return;
      }
      if (action === EDIT_MESH_UNWRAP_UVS_ACTION) {
        const node = findNodeDeep(graph, nodeId);
        if (!node) return;
        const meshData: QuadMesh = resolveEditMeshData(node, evaluatedResults);
        const unwrapped = boxProjectUVs(meshData);
        onParamChange("meshData", unwrapped, nodeId);
        return;
      }
      if (action === UV_UNWRAP_ACTION) {
        const node = findNodeDeep(graph, nodeId);
        if (!node) return;
        onParamChange("unwrapRequest", (Number(node.params.unwrapRequest) || 0) + 1, nodeId);
        return;
      }
      if (action === POINTS_INFLUENCE_COMPUTE_ACTION) {
        // The painted map read under each vertex of the node's first mesh —
        // the points are those vertices, index for index.
        const geomObj = evaluatedResults?.get(nodeId)?.geometry;
        const mesh = geomObj instanceof THREE.Object3D ? findFirstMesh(geomObj) : null;
        if (!mesh) {
          console.warn("Points Influence: Compute needs a mesh wired into Geometry — a bare point list has no surface to paint.");
          return;
        }
        const influences = computePointInfluences(nodeId, mesh.geometry);
        if (!influences) {
          console.warn("Points Influence: this mesh has no UVs, so the painted map cannot be read back onto its points.");
          return;
        }
        onParamChange("influences", influences, nodeId);
        return;
      }
      if (action === FROZEN_UNWRAP_UVS_ACTION) {
        const node = findNodeDeep(graph, nodeId);
        if (!node) return;
        const positions = Array.isArray(node.params.positions) ? (node.params.positions as number[]) : [];
        const index = Array.isArray(node.params.index) ? (node.params.index as number[]) : null;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        if (index) geometry.setIndex(index);
        const quadMesh = bufferGeometryToQuadMesh(geometry);
        const unwrapped = quadMeshToBufferGeometry(boxProjectUVs(quadMesh));
        onParamChange({
          positions: Array.from(unwrapped.attributes.position.array),
          normals: Array.from(unwrapped.attributes.normal.array),
          uvs: Array.from(unwrapped.attributes.uv.array),
          index: unwrapped.index ? Array.from(unwrapped.index.array) : null,
        }, nodeId);
        geometry.dispose();
        unwrapped.dispose();
        return;
      }
      if (action === EDIT_MESH_DELETE_FACES_ACTION) {
        const node = findNodeDeep(graph, nodeId);
        if (!node) return;
        // Face operations: only on a face selection.
        if (readEditMeshSelection(node).mode !== "faces") return;
        const selectedFaces: number[] = Array.isArray(node.params.selectedFaces)
          ? (node.params.selectedFaces as number[])
          : [];
        if (selectedFaces.length === 0) return;

        const meshData: QuadMesh = resolveEditMeshData(node, evaluatedResults);
        const remainingMesh = deleteFaces(meshData, selectedFaces);
        onParamChange({
          meshData: cloneQuadMesh(remainingMesh),
          selectedFaces: [],
          selectedPoints: [],
        }, nodeId);
        return;
      }
      if (action === EDIT_MESH_SEPARATE_FACES_ACTION) {
        const node = findNodeDeep(graph, nodeId);
        if (!node) return;
        // Face operations: only on a face selection.
        if (readEditMeshSelection(node).mode !== "faces") return;
        const selectedFaces: number[] = Array.isArray(node.params.selectedFaces)
          ? (node.params.selectedFaces as number[])
          : [];
        if (selectedFaces.length === 0) return;

        const meshData: QuadMesh = resolveEditMeshData(node, evaluatedResults);
        const separatedMesh = extractFaces(meshData, selectedFaces);
        const remainingMesh = deleteFaces(meshData, selectedFaces);

        const newNodeId = randomId();
        const newNode = {
          id: newNodeId,
          type: EDIT_MESH_NODE.type,
          params: {
            // Starts from the original's own params (not defaultParams) so the
            // separated piece keeps the same location/rotation/scale/pivot —
            // otherwise it snaps back to the identity pose and visibly jumps
            // away from where its faces used to sit.
            ...cloneParams(node.params),
            meshData: cloneQuadMesh(separatedMesh),
            shading: node.params.shading ?? "auto",
            selectMode: "faces",
            selectedFaces: Array.from({ length: separatedMesh.faces.length }, (_, i) => i),
            selectedPoints: [],
            name: typeof node.params.name === "string" && node.params.name ? `${node.params.name} (Separated)` : "Separated Mesh",
          },
          position: {
            x: node.position.x + 280,
            y: node.position.y + 60,
          },
        };

        // Every input wired into the original (Geometry/Matrix for the pose
        // parent, Material and the texture maps) gets the same wire on the
        // new node, so the separated piece renders with the identical pose
        // and look instead of falling back to an unposed default-clay mesh.
        // Both are the same node type, so every wire the original has —
        // dynamic material slots included — is valid on the copy. And both
        // live on the original's own level: inside its group, if it's in one.
        setGraphWithHistory((prevGraph) =>
          updateGraphHolding(prevGraph, nodeId, (holder) => {
            const clonedConnections = holder.connections
              .filter((c) => c.toNode === nodeId)
              .map((c) => ({ id: randomId(), fromNode: c.fromNode, fromSocket: c.fromSocket, toNode: newNodeId, toSocket: c.toSocket }));
            const updatedNodes = holder.nodes.map((n) =>
              n.id === nodeId
                ? {
                    ...n,
                    params: {
                      ...n.params,
                      meshData: cloneQuadMesh(remainingMesh),
                      selectedFaces: [],
                      selectedPoints: [],
                    },
                  }
                : n,
            );
            return {
              ...holder,
              nodes: [...updatedNodes, newNode],
              connections: [...holder.connections, ...clonedConnections],
            };
          }),
          `separate:${nodeId}`,
        );
        return;
      }
      if (action === GLTF_CHOOSE_FOLDER_ACTION) {
        // From the button's own click: the folder picker needs that gesture.
        requestProjectFolder({ needed: 0, pick: true });
        return;
      }
      if (action === EXPLODE_GLTF_ACTION) {
        const meshes = explodeGltfToMeshData(nodeId);
        if (meshes.length === 0) {
          console.warn("glTF Model: nothing to explode yet — load a model first.");
          return;
        }

        // Ids are picked up front, outside the graph updater: the texture
        // fields' onLoaded() calls below need a real id to key their
        // module-level cache by, and they run alongside the graph commit
        // rather than inside it (that updater must stay a pure function of
        // prevGraph — see pushHistory's own comment on why nothing here can
        // reach into it).
        const ids = meshes.map(() => randomId());
        const frozenFields = OBJECT_FROZEN_NODE.dynamicParamFields?.(
          { id: "", type: OBJECT_FROZEN_NODE.type, params: {}, position: { x: 0, y: 0 } },
        ) ?? [];
        const textureField = frozenFields.find((f) => f.id === "texturePath" && f.kind === "file") as
          | (ParamFieldDef & { kind: "file" })
          | undefined;
        const normalField = frozenFields.find((f) => f.id === "normalMapPath" && f.kind === "file") as
          | (ParamFieldDef & { kind: "file" })
          | undefined;
        const roughnessField = frozenFields.find((f) => f.id === "roughnessMapPath" && f.kind === "file") as
          | (ParamFieldDef & { kind: "file" })
          | undefined;

        // Where (if anywhere) exploded textures can be written as real
        // sibling files rather than staying session-only: next to the model
        // itself, so the *existing*, generic file-rehydration pass (any node
        // with a "file" field gets re-read from its stored path on project
        // load — see rehydrateFileNodesFromDisk) picks them back up for
        // free, no glTF-specific reload logic needed. Only possible with
        // real filesystem access and a model that has a real path — a
        // browser pick or a model with no textures skips straight to the
        // session-only fallback below.
        const sourceDir = isTauri() ? gltfSourceDirectory(nodeId) : null;
        const writes: Promise<void>[] = [];

        /** Feeds one baked texture through the exact path a manual file pick already takes, and best-effort persists it. */
        const applyTexture = (
          field: (ParamFieldDef & { kind: "file" }) | undefined,
          texture: ExplodedTexture | null,
          newNodeId: string,
        ): string | undefined => {
          if (!field || !texture) return undefined;
          const targetPath = sourceDir ? `${sourceDir}/${texture.fileName}` : texture.fileName;
          // Populates the live in-memory texture cache immediately, so the
          // map shows up on screen this frame — independent of, and not
          // waiting on, the disk write below.
          field.onLoaded?.(newNodeId, targetPath, texture.bytes);
          if (sourceDir) {
            writes.push(
              import("@tauri-apps/plugin-fs")
                .then(({ writeFile }) => writeFile(targetPath, texture.bytes))
                .catch((err) => console.error(`Explode into Nodes: failed to save ${targetPath}:`, err)),
            );
          }
          return targetPath;
        };

        const newNodes = meshes.map((mesh, i) => {
          const newNodeId = ids[i];
          const texturePath = applyTexture(textureField, mesh.map, newNodeId);
          const normalMapPath = applyTexture(normalField, mesh.normalMap, newNodeId);
          const roughnessMapPath = applyTexture(roughnessField, mesh.roughnessMap, newNodeId);
          return {
            id: newNodeId,
            type: OBJECT_FROZEN_NODE.type,
            params: {
              ...cloneParams(OBJECT_FROZEN_NODE.defaultParams),
              positions: mesh.positions,
              normals: mesh.normals,
              uvs: mesh.uvs,
              index: mesh.index,
              color: new THREE.Color(mesh.color),
              roughness: mesh.roughness,
              metalness: mesh.metalness,
              opacity: mesh.opacity,
              emissive: new THREE.Color(mesh.emissive),
              emissiveIntensity: mesh.emissiveIntensity,
              doubleSided: mesh.doubleSided ? 1 : 0,
              shadeless: mesh.shadeless ? 1 : 0,
              ...(texturePath ? { texturePath } : {}),
              ...(normalMapPath ? { normalMapPath } : {}),
              ...(roughnessMapPath ? { roughnessMapPath } : {}),
            },
            position: { x: 0, y: 0 }, // set below, once baseX/baseY are known
          };
        });

        setGraphWithHistory((prevGraph) => {
          const source = prevGraph.nodes.find((n) => n.id === nodeId);
          const baseX = (source?.position.x ?? 300) + 340;
          const baseY = source?.position.y ?? 200;
          // A grid rather than a single column: a real model can explode into
          // dozens of pieces, and a mile-long vertical strip is unnavigable.
          const COLUMNS = 4;
          const SPACING_X = 260;
          const SPACING_Y = 200;
          const positioned = newNodes.map((node, i) => ({
            ...node,
            position: {
              x: baseX + (i % COLUMNS) * SPACING_X,
              y: baseY + Math.floor(i / COLUMNS) * SPACING_Y,
            },
          }));
          return { ...prevGraph, nodes: [...prevGraph.nodes, ...positioned] };
        }, `explode:${nodeId}`);

        if (writes.length > 0) {
          void Promise.all(writes).then(() => {
            console.info(`Explode into Nodes: saved ${writes.length} texture(s) beside the model.`);
          });
        }
        return;
      }
      if (action !== BAKE_INSTANCES_ACTION) return;
      const data = bakeInstancesToGeometryData(nodeId);
      if (!data) {
        console.warn("Bake to Mesh: no live instances to bake yet.");
        return;
      }
      setGraphWithHistory((prevGraph) => {
        const source = prevGraph.nodes.find((n) => n.id === nodeId);
        const position = source ? { x: source.position.x + 260, y: source.position.y + 40 } : { x: 300, y: 180 };
        const newNode = {
          id: randomId(),
          type: OBJECT_FROZEN_NODE.type,
          params: { ...cloneParams(OBJECT_FROZEN_NODE.defaultParams), ...data },
          position,
        };
        return { ...prevGraph, nodes: [...prevGraph.nodes, newNode] };
      }, `bake:${nodeId}`);
    },
    [setGraphWithHistory, graph.nodes, onToggleKeyframe, onParamChange],
  );

  /**
   * Freeze — snapshot the selected node's current geometry into a new,
   * standalone Frozen Geometry node.
   *
   * The point is to cut a long chain of expensive modifiers loose once its
   * result is settled: the new node stores plain arrays and re-evaluates for
   * free, and being a real single Mesh it is accepted by Edit Mesh Points,
   * Boolean and Subdivide — none of which take a Group.
   *
   * It reads the node's *evaluated output* rather than re-deriving anything
   * from the graph, the same way Reset Points from Basis does: whatever was
   * on screen is exactly what gets frozen.
   */
  const onFreezeNode = useCallback(
    (nodeId: string) => {
      const output = getEvaluatedResults()?.get(nodeId)?.geometry;
      if (!(output instanceof THREE.Object3D)) {
        console.warn("Freeze: this node has not produced any geometry yet.");
        return;
      }
      const data = freezeObjectToGeometryData(output);
      if (!data) {
        console.warn("Freeze: nothing meshy to freeze here — a point cloud or a line has no faces to bake.");
        return;
      }
      setGraphWithHistory((prevGraph) => {
        const source = prevGraph.nodes.find((n) => n.id === nodeId);
        const position = source ? { x: source.position.x + 260, y: source.position.y + 40 } : { x: 300, y: 180 };
        const newNode = {
          id: randomId(),
          type: OBJECT_FROZEN_NODE.type,
          // Baked in world space and left at the origin, so the frozen copy
          // lands exactly where the original was without replaying the
          // upstream transform chain onto it.
          params: { ...cloneParams(OBJECT_FROZEN_NODE.defaultParams), ...data },
          position,
        };
        return { ...prevGraph, nodes: [...prevGraph.nodes, newNode] };
      }, `freeze:${nodeId}`);
    },
    [setGraphWithHistory],
  );

  /**
   * Apply Rotation & Scale — Blender's Ctrl+A on the node's own pose (see
   * applyRotationScalePatch). A turn or size that is wired or keyframed is
   * not a fixed amount that could be set into the shape, so those are left
   * as they are and nothing is applied.
   */
  const onApplyTransform = useCallback(
    (nodeId: string) => {
      setGraphWithHistory((prevGraph) => {
        const found = findNodeWithGraph(prevGraph, nodeId);
        if (!found) return prevGraph;
        const driven = ["rotation", "rotationAngle", "scale"].filter(
          (id) =>
            found.graph.connections.some((c) => c.toNode === nodeId && c.toSocket === id) ||
            (found.graph.keyframes?.[nodeId]?.[id]?.length ?? 0) > 0,
        );
        if (driven.length > 0) {
          console.warn(`Apply: ${driven.join(", ")} is wired or keyframed on this node, so there is no fixed turn or size to apply.`);
          return prevGraph;
        }
        const patch = applyRotationScalePatch(withDefaultParams(found.instance));
        return updateNodeDeep(prevGraph, nodeId, (n) => ({ ...n, params: { ...n.params, ...patch } }));
      }, `apply:${nodeId}`);
    },
    [setGraphWithHistory],
  );

  /** The icons under a node on hover (see nodeActions.ts): Freeze, Apply, Reset, or a node's own reset action. */
  // Stable, so the memoized GraphEditor doesn't re-render on its account.
  const onNodeAction = useStableHandler((nodeId: string, action: string) => {
    if (action === NODE_FREEZE_ACTION) return onFreezeNode(nodeId);
    if (action === NODE_APPLY_TRANSFORM_ACTION) return onApplyTransform(nodeId);
    if (action === NODE_RESET_PARAMS_ACTION) {
      const node = findNodeDeep(graph, nodeId);
      const patch = node ? nodeResetPatch(resolveDefinition(node, DEFAULT_REGISTRY)) : null;
      if (patch) onParamChange(patch, nodeId);
      return;
    }
    onParamAction(nodeId, action);
  });
  const emptyCanvases = useMemo(() => canvases.map(isCanvasEmpty), [canvases]);

  // Same functional-updater reasoning as onParamChange, but writing all
  // three fields in one setGraph call rather than three separate
  // onParamChange calls — the gizmo fires this every frame of a drag, and
  // three sequential setGraph calls would hit the exact stale-closure
  // overwrite bug that onParamChange's own comment documents, just via a
  // different call site.
  /**
   * Everything about the graph except where the nodes sit on the canvas.
   *
   * GraphEditor commits on every frame of a node drag, so without this a
   * single drag across the canvas pushed dozens of undo steps and evicted the
   * real history. Two commits sharing this signature differ only by position
   * — one continuous move — so they collapse into one step, while a delete,
   * a rewire or an added node changes it and starts a fresh one.
   */
  const structuralKey = useCallback(
    (g: Graph) =>
      JSON.stringify([g.nodes.map((n) => [n.id, n.type]), g.connections.map((c) => c.id)]),
    [],
  );

  const onGraphChange = useCallback(
    (next: Graph) =>
      setGraphWithHistory(
        (prev) => ({
          ...next,
          keyframes: next.keyframes ?? prev.keyframes ?? {},
          markers: next.markers ?? prev.markers ?? [],
        }),
        `structure:${structuralKey(next)}`,
      ),
    [setGraphWithHistory, structuralKey],
  );

  // A gizmo drag writes every frame, so it records its undo step once when
  // the drag *starts* instead. Before this it went through plain setGraph and
  // was simply not undoable at all — Cmd+Z after moving an object skipped
  // straight past it to some older edit.
  const onTransformStart = useCallback(() => pushHistory(), [pushHistory]);

  const onTransformChange = (transformNodeId: string, patch: TransformPatch) => {
    const currentFrame = getPlayheadFrame(activeCanvasRef.current);
    setGraph((prevGraph) => {
      let fullPatch = { ...patch };
      if (fullPatch.pivot && !fullPatch.location) {
        const node = findNodeDeep(prevGraph, transformNodeId);
        if (node && "location" in node.params) {
          const oldPiv = asVector3(node.params.pivot, new THREE.Vector3());
          const newPiv = asVector3(fullPatch.pivot, new THREE.Vector3());
          const deltaPiv = new THREE.Vector3().subVectors(newPiv, oldPiv);
          if (deltaPiv.lengthSq() > 0) {
            const rot = asVector3(node.params.rotation, new THREE.Vector3());
            const scl = asVector3(node.params.scale, new THREE.Vector3(1, 1, 1));
            const mRotScale = composeTransform(new THREE.Vector3(), rot, scl, withDefaultParams(node));
            const deltaPivRotScaled = deltaPiv.clone().applyMatrix4(mRotScale);
            const deltaLoc = new THREE.Vector3().subVectors(deltaPivRotScaled, deltaPiv);
            const oldLoc = asVector3(node.params.location, new THREE.Vector3());
            fullPatch.location = oldLoc.clone().add(deltaLoc);
          }
        }
      }

      // Same keyframe-track-if-one-already-exists rule as onParamChange —
      // otherwise a gizmo drag (or "Aligner Caméra", which reuses this same
      // path) always wrote straight to the base param, which keyframe
      // playback then overrode right back on the next frame: no way to pose
      // a camera (or any keyframed object) differently at different times
      // by dragging it, only by typing numbers into the param panel field
      // by field. Each patch entry (location/rotation/scale, or fov from
      // the align button) is checked independently.
      let nextKeyframes = prevGraph.keyframes;
      if (keyframesEnabled && currentFrame >= 0) {
        for (const [key, value] of Object.entries(fullPatch)) {
          nextKeyframes = applyKeyframedParamUpdate(nextKeyframes, transformNodeId, key, value, currentFrame);
        }
      }

      // At any depth: the node may sit inside a group (an Edit Mesh edited
      // in there, whose drags and tool previews come through here).
      return {
        ...updateNodeDeep(prevGraph, transformNodeId, (n) => ({ ...n, params: { ...n.params, ...fullPatch } })),
        keyframes: nextKeyframes,
      };
    });
  };

  const handleHubChange = (nodeId: string, patch: Partial<{ x: number; y: number; rotation: number; scale: number }>) => {
    setGraph((prevGraph) => ({
      ...prevGraph,
      nodes: prevGraph.nodes.map((n) =>
        n.id === nodeId ? { ...n, params: { ...n.params, ...patch } } : n,
      ),
    }));
  };

  const onSplitHandleMouseDown = useCallback((e: React.MouseEvent | React.PointerEvent) => {
    if (e.shiftKey) return;
    e.preventDefault();
    if ("pointerId" in e && e.currentTarget && typeof (e.currentTarget as HTMLElement).setPointerCapture === "function") {
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {}
    }
    draggingSplit.current = true;
    lastClampedYRef.current = e.clientY;
    setIsDraggingSplit(true);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, []);

  const onDrawerSplitMouseDown = useCallback((e: React.MouseEvent | React.PointerEvent) => {
    if (e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    if ("pointerId" in e && e.currentTarget && typeof (e.currentTarget as HTMLElement).setPointerCapture === "function") {
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {}
    }
    draggingDrawer.current = true;
    drawerStartYRef.current = e.clientY;
    drawerStartHeightRef.current = timelineDrawerHeight;
    lastClampedDrawerYRef.current = e.clientY;
    setIsDraggingDrawer(true);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, [timelineDrawerHeight]);

  useEffect(() => {
    function onPointerMove(e: MouseEvent | PointerEvent) {
      if (draggingSplit.current && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const minTop = rect.top + (rect.height * MIN_PANE_PERCENT) / 100;
        const maxTop = rect.top + (rect.height * MAX_PANE_PERCENT) / 100;
        const clampedY = Math.min(maxTop, Math.max(minTop, e.clientY));
        lastClampedYRef.current = clampedY;
        if (ghostLineRef.current) {
          ghostLineRef.current.style.transform = `translateY(${clampedY}px)`;
        }
      } else if (draggingDrawer.current) {
        const delta = e.clientY - drawerStartYRef.current;
        const newHeight = Math.max(160, Math.min(650, drawerStartHeightRef.current + delta));
        const clampedY = drawerStartYRef.current + (newHeight - drawerStartHeightRef.current);
        lastClampedDrawerYRef.current = clampedY;
        if (ghostDrawerLineRef.current) {
          ghostDrawerLineRef.current.style.transform = `translateY(${clampedY}px)`;
        }
      }
    }

    function onPointerUp() {
      if (draggingSplit.current) {
        draggingSplit.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        if (containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          const percent = ((lastClampedYRef.current - rect.top) / rect.height) * 100;
          setSplitPercent(Math.min(MAX_PANE_PERCENT, Math.max(MIN_PANE_PERCENT, percent)));
        }
        setIsDraggingSplit(false);
      }
      if (draggingDrawer.current) {
        draggingDrawer.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        const delta = lastClampedDrawerYRef.current - drawerStartYRef.current;
        setTimelineDrawerHeight(Math.max(160, Math.min(650, drawerStartHeightRef.current + delta)));
        setIsDraggingDrawer(false);
      }
    }

    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("mouseup", onPointerUp);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("mousemove", onPointerMove);
      window.removeEventListener("mouseup", onPointerUp);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, []);


  const selectedKeyframesRecord = useMemo(() => {
    const map: Record<
      number,
      {
        paramKeys: string[];
        easeIn?: EasingType;
        easeStrength?: number;
        easeBezier?: [number, number, number, number];
      }
    > = {};
    if (selectedNodeId) {
      if (graph.keyframes?.[selectedNodeId]) {
        for (const [paramKey, list] of Object.entries(graph.keyframes[selectedNodeId])) {
          for (const kf of list) {
            if (!map[kf.frame]) {
              map[kf.frame] = {
                paramKeys: [paramKey],
                easeIn: kf.easeIn || "smooth",
                easeStrength: kf.easeStrength,
                easeBezier: kf.easeBezier,
              };
            } else {
              if (!map[kf.frame].paramKeys.includes(paramKey)) {
                map[kf.frame].paramKeys.push(paramKey);
              }
            }
          }
        }
      }

      // Also ensure any Grease Pencil keyframed drawings are directly reflected on the timeline
      const selectedNode = graph.nodes.find((n) => n.id === selectedNodeId);
      if (selectedNode?.type === "curve/grease-pencil" || selectedNode?.type === "curve/paint-on-geometry") {
        const frames = (selectedNode.params.frames as KeyframeDrawing[]) || [];
        for (const f of frames) {
          if (!map[f.frame]) {
            map[f.frame] = {
              paramKeys: ["frames"],
              easeIn: "hold",
            };
          } else if (!map[f.frame].paramKeys.includes("frames")) {
            map[f.frame].paramKeys.push("frames");
          }
        }
      }
    }
    return map;
  }, [selectedNodeId, graph.keyframes, graph.nodes]);

  const onMoveKeyframe = useCallback(
    (oldFrame: number, newFrame: number) => {
      if (!selectedNodeId) return;
      setGraphWithHistory((prevGraph) => {
        const currentKeyframes = prevGraph.keyframes || {};
        const nodeKeys = currentKeyframes[selectedNodeId];
        if (!nodeKeys) return prevGraph;

        const nextNodeKeys: Record<string, Keyframe[]> = {};
        let modified = false;

        for (const [paramKey, list] of Object.entries(nodeKeys)) {
          const kfToMove = list.find((k) => k.frame === oldFrame);
          if (!kfToMove) {
            nextNodeKeys[paramKey] = list;
            continue;
          }

          modified = true;
          const remaining = list.filter((k) => k.frame !== oldFrame && k.frame !== newFrame);
          const movedKf: Keyframe = {
            ...kfToMove,
            frame: newFrame,
          };
          nextNodeKeys[paramKey] = [...remaining, movedKf].sort((a, b) => a.frame - b.frame);
        }

        if (!modified) return prevGraph;

        return {
          ...prevGraph,
          keyframes: {
            ...currentKeyframes,
            [selectedNodeId]: nextNodeKeys,
          },
        };
      }, `keyframe:move:${oldFrame}->${newFrame}`);
    },
    [selectedNodeId, setGraphWithHistory],
  );

  const onUpdateKeyframeEasing = useCallback(
    (frame: number, easeIn: EasingType, easeStrength?: number, easeBezier?: [number, number, number, number]) => {
      if (!selectedNodeId) return;
      setGraphWithHistory((prevGraph) => {
        const currentKeyframes = prevGraph.keyframes || {};
        const nodeKeys = currentKeyframes[selectedNodeId];
        if (!nodeKeys) return prevGraph;

        const nextNodeKeys: Record<string, Keyframe[]> = {};
        let modified = false;

        for (const [paramKey, list] of Object.entries(nodeKeys)) {
          const nextList = list.map((kf) => {
            if (kf.frame === frame) {
              modified = true;
              return easeBezier !== undefined
                ? { ...kf, easeIn, easeStrength, easeBezier }
                : easeStrength !== undefined
                  ? { ...kf, easeIn, easeStrength }
                  : { ...kf, easeIn };
            }
            return kf;
          });
          nextNodeKeys[paramKey] = nextList;
        }

        if (!modified) return prevGraph;

        return {
          ...prevGraph,
          keyframes: {
            ...currentKeyframes,
            [selectedNodeId]: nextNodeKeys,
          },
        };
      }, `keyframe:easing:${frame}`);
    },
    [selectedNodeId, setGraphWithHistory],
  );

  const onChangeKeyframeValue = useCallback(
    (nodeId: string, paramKey: string, frame: number, value: number) => {
      setGraphWithHistory((prevGraph) => {
        const currentKeyframes = prevGraph.keyframes || {};
        const nodeKeys = currentKeyframes[nodeId] ? { ...currentKeyframes[nodeId] } : {};
        const list = nodeKeys[paramKey] ? [...nodeKeys[paramKey]] : [];
        const idx = list.findIndex((k) => k.frame === frame);
        if (idx < 0) return prevGraph;
        list[idx] = { ...list[idx], value };
        nodeKeys[paramKey] = list;
        return { ...prevGraph, keyframes: { ...currentKeyframes, [nodeId]: nodeKeys } };
      }, `keyframe:value:${nodeId}:${paramKey}:${frame}`);
    },
    [setGraphWithHistory],
  );

  const onDeleteKeyframe = useCallback(
    (frame: number) => {
      if (!selectedNodeId) return;
      setGraphWithHistory((prevGraph) => {
        const currentKeyframes = prevGraph.keyframes || {};
        const nodeKeys = currentKeyframes[selectedNodeId];

        const nextNodeKeys: Record<string, Keyframe[]> = {};
        let hasAny = false;

        if (nodeKeys) {
          for (const [paramKey, list] of Object.entries(nodeKeys)) {
            const filtered = list.filter((k) => k.frame !== frame);
            if (filtered.length > 0) {
              nextNodeKeys[paramKey] = filtered;
              hasAny = true;
            }
          }
        }

        const nextStore = { ...currentKeyframes };
        if (hasAny) {
          nextStore[selectedNodeId] = nextNodeKeys;
        } else {
          delete nextStore[selectedNodeId];
        }

        let nextNodes = prevGraph.nodes;
        const targetNode = prevGraph.nodes.find((n) => n.id === selectedNodeId);
        if (targetNode?.type === "curve/grease-pencil" || targetNode?.type === "curve/paint-on-geometry") {
          const currentFrames = (targetNode.params.frames as KeyframeDrawing[]) || [];
          const filteredFrames = currentFrames.filter((f) => f.frame !== frame);
          if (filteredFrames.length !== currentFrames.length) {
            nextNodes = prevGraph.nodes.map((n) =>
              n.id === selectedNodeId
                ? { ...n, params: { ...n.params, frames: filteredFrames } }
                : n,
            );
          }
        }

        return {
          ...prevGraph,
          nodes: nextNodes,
          keyframes: nextStore,
        };
      }, `keyframe:delete:${frame}`);
    },
    [selectedNodeId, setGraphWithHistory],
  );

  const onBatchMoveKeyframes = useCallback(
    (moves: { nodeId: string; paramKey: string; oldFrame: number; newFrame: number }[]) => {
      if (moves.length === 0) return;
      setGraphWithHistory((prevGraph) => {
        const currentKeyframes = prevGraph.keyframes || {};
        const nextStore = { ...currentKeyframes };

        const byNodeParam: Record<string, Record<string, { oldFrame: number; newFrame: number }[]>> = {};
        for (const m of moves) {
          if (!byNodeParam[m.nodeId]) byNodeParam[m.nodeId] = {};
          if (!byNodeParam[m.nodeId][m.paramKey]) byNodeParam[m.nodeId][m.paramKey] = [];
          byNodeParam[m.nodeId][m.paramKey].push(m);
        }

        let modified = false;
        let nextNodes = prevGraph.nodes;
        for (const [nodeId, paramsMap] of Object.entries(byNodeParam)) {
          const nodeKeys = nextStore[nodeId] ? { ...nextStore[nodeId] } : {};
          for (const [paramKey, moveList] of Object.entries(paramsMap)) {
            const list = nodeKeys[paramKey] || [];
            const oldFrames = new Set(moveList.map((m) => m.oldFrame));
            const moveMap = new Map(moveList.map((m) => [m.oldFrame, m.newFrame]));

            const movingKfs: Keyframe[] = [];
            const remainingKfs: Keyframe[] = [];

            for (const kf of list) {
              if (oldFrames.has(kf.frame)) {
                const newFrame = moveMap.get(kf.frame)!;
                movingKfs.push({ ...kf, frame: newFrame });
                modified = true;
              } else {
                remainingKfs.push(kf);
              }
            }

            const newFrames = new Set(movingKfs.map((k) => k.frame));
            const cleanRemaining = remainingKfs.filter((k) => !newFrames.has(k.frame));
            const combined = [...cleanRemaining, ...movingKfs].sort((a, b) => a.frame - b.frame);
            nodeKeys[paramKey] = combined;

            if (paramKey === "frames") {
              const targetNode = nextNodes.find((n) => n.id === nodeId);
              if (targetNode?.type === "curve/grease-pencil" || targetNode?.type === "curve/paint-on-geometry") {
                const currentFrames = (targetNode.params.frames as KeyframeDrawing[]) || [];
                const updatedFrames = currentFrames
                  .map((f) => (moveMap.has(f.frame) ? { ...f, frame: moveMap.get(f.frame)! } : f))
                  .sort((a, b) => a.frame - b.frame);
                nextNodes = nextNodes.map((n) =>
                  n.id === nodeId ? { ...n, params: { ...n.params, frames: updatedFrames } } : n,
                );
                modified = true;
              }
            }
          }
          nextStore[nodeId] = nodeKeys;
        }

        if (!modified) return prevGraph;
        return { ...prevGraph, nodes: nextNodes, keyframes: nextStore };
      }, `keyframes:batch_move:${moves.length}`);
    },
    [setGraphWithHistory],
  );

  /**
   * One atomic edit pass over a set of keyframes: a move in time, a new value,
   * new bezier control points, or any combination.
   *
   * The motion graph needs this because dragging a key changes its frame AND
   * its value at once. Doing that through onBatchMoveKeyframes followed by
   * onChangeKeyframeValue produced two undo entries, and the second call had to
   * address the key by its *new* frame — so if the move collided with an
   * existing key, the value landed on the wrong one.
   */
  const onEditKeyframes = useCallback(
    (
      edits: {
        nodeId: string;
        paramKey: string;
        oldFrame: number;
        newFrame: number;
        value?: number;
        easeBezier?: [number, number, number, number];
      }[],
    ) => {
      if (edits.length === 0) return;
      setGraphWithHistory((prevGraph) => {
        const currentKeyframes = prevGraph.keyframes || {};
        const nextStore = { ...currentKeyframes };

        const byNodeParam = new Map<string, typeof edits>();
        for (const e of edits) {
          const key = `${e.nodeId}\u0000${e.paramKey}`;
          const bucket = byNodeParam.get(key);
          if (bucket) bucket.push(e);
          else byNodeParam.set(key, [e]);
        }

        let modified = false;
        for (const [bucketKey, list] of byNodeParam) {
          const [nodeId, paramKey] = bucketKey.split("\u0000");
          const existing = nextStore[nodeId]?.[paramKey];
          if (!existing) continue;

          const editByOldFrame = new Map(list.map((e) => [e.oldFrame, e]));
          const moved: Keyframe[] = [];
          const untouched: Keyframe[] = [];

          for (const kf of existing) {
            const edit = editByOldFrame.get(kf.frame);
            if (!edit) {
              untouched.push(kf);
              continue;
            }
            modified = true;
            const next: Keyframe = { ...kf, frame: edit.newFrame };
            if (edit.value !== undefined && Number.isFinite(edit.value)) next.value = edit.value;
            if (edit.easeBezier) next.easeBezier = [...edit.easeBezier] as [number, number, number, number];
            moved.push(next);
          }

          if (moved.length === 0) continue;
          // A key dropped onto an occupied frame replaces the one already there
          // — the same rule the track grid's drag follows.
          const takenFrames = new Set(moved.map((k) => k.frame));
          const combined = [...untouched.filter((k) => !takenFrames.has(k.frame)), ...moved].sort(
            (a, b) => a.frame - b.frame,
          );

          const nodeKeys = { ...(nextStore[nodeId] || {}) };
          nodeKeys[paramKey] = combined;
          nextStore[nodeId] = nodeKeys;
        }

        if (!modified) return prevGraph;
        return { ...prevGraph, keyframes: nextStore };
      }, `keyframes:edit:${edits.length}`);
    },
    [setGraphWithHistory],
  );

  const onBatchDeleteKeyframes = useCallback(
    (targets: { nodeId: string; paramKey: string; frame: number }[]) => {
      if (targets.length === 0) return;
      setGraphWithHistory((prevGraph) => {
        const currentKeyframes = prevGraph.keyframes || {};
        const nextStore = { ...currentKeyframes };

        const byNodeParam: Record<string, Record<string, Set<number>>> = {};
        for (const t of targets) {
          if (!byNodeParam[t.nodeId]) byNodeParam[t.nodeId] = {};
          if (!byNodeParam[t.nodeId][t.paramKey]) byNodeParam[t.nodeId][t.paramKey] = new Set();
          byNodeParam[t.nodeId][t.paramKey].add(t.frame);
        }

        for (const [nodeId, paramsMap] of Object.entries(byNodeParam)) {
          if (!nextStore[nodeId]) continue;
          const nodeKeys = { ...nextStore[nodeId] };
          for (const [paramKey, framesSet] of Object.entries(paramsMap)) {
            const list = nodeKeys[paramKey] || [];
            const filtered = list.filter((k) => !framesSet.has(k.frame));
            if (filtered.length > 0) {
              nodeKeys[paramKey] = filtered;
            } else {
              delete nodeKeys[paramKey];
            }
          }
          if (Object.keys(nodeKeys).length > 0) {
            nextStore[nodeId] = nodeKeys;
          } else {
            delete nextStore[nodeId];
          }
        }

        return { ...prevGraph, keyframes: nextStore };
      }, `keyframes:batch_delete:${targets.length}`);
    },
    [setGraphWithHistory],
  );

  const onBatchDuplicateKeyframes = useCallback(
    (duplicates: { nodeId: string; paramKey: string; sourceFrame: number; targetFrame: number }[]) => {
      if (duplicates.length === 0) return;
      setGraphWithHistory((prevGraph) => {
        const currentKeyframes = prevGraph.keyframes || {};
        const nextStore = { ...currentKeyframes };

        for (const { nodeId, paramKey, sourceFrame, targetFrame } of duplicates) {
          const nodeKeys = nextStore[nodeId] ? { ...nextStore[nodeId] } : {};
          const list = nodeKeys[paramKey] ? [...nodeKeys[paramKey]] : [];
          const sourceKf = list.find((k) => k.frame === sourceFrame);
          if (!sourceKf) continue;

          const newKf: Keyframe = {
            ...sourceKf,
            frame: targetFrame,
            value: JSON.parse(JSON.stringify(sourceKf.value)),
          };
          const filtered = list.filter((k) => k.frame !== targetFrame);
          nodeKeys[paramKey] = [...filtered, newKf].sort((a, b) => a.frame - b.frame);
          nextStore[nodeId] = nodeKeys;
        }

        return { ...prevGraph, keyframes: nextStore };
      }, `keyframes:batch_duplicate:${duplicates.length}`);
    },
    [setGraphWithHistory],
  );

  const onBatchUpdateEasing = useCallback(
    (
      targets: { nodeId: string; paramKey: string; frame: number }[],
      easeIn: EasingType,
      easeStrength?: number,
      easeBezier?: [number, number, number, number],
    ) => {
      if (targets.length === 0) return;
      setGraphWithHistory((prevGraph) => {
        const currentKeyframes = prevGraph.keyframes || {};
        const nextStore = { ...currentKeyframes };

        const targetMap = new Map<string, boolean>();
        for (const t of targets) {
          targetMap.set(`${t.nodeId}::${t.paramKey}::${t.frame}`, true);
        }

        for (const nodeId of Object.keys(nextStore)) {
          const nodeKeys = { ...nextStore[nodeId] };
          let nodeModified = false;
          for (const [paramKey, list] of Object.entries(nodeKeys)) {
            let paramModified = false;
            const nextList = list.map((kf) => {
              if (targetMap.has(`${nodeId}::${paramKey}::${kf.frame}`)) {
                paramModified = true;
                return easeBezier !== undefined
                  ? { ...kf, easeIn, easeStrength, easeBezier }
                  : easeStrength !== undefined
                    ? { ...kf, easeIn, easeStrength }
                    : { ...kf, easeIn };
              }
              return kf;
            });
            if (paramModified) {
              nodeKeys[paramKey] = nextList;
              nodeModified = true;
            }
          }
          if (nodeModified) {
            nextStore[nodeId] = nodeKeys;
          }
        }

        return { ...prevGraph, keyframes: nextStore };
      }, `keyframes:batch_easing:${targets.length}`);
    },
    [setGraphWithHistory],
  );

  const onPasteKeyframes = useCallback(
    (items: KeyframeClipboardItem[], targetBaseFrame: number) => {
      if (items.length === 0) return;
      setGraphWithHistory((prevGraph) => {
        const currentKeyframes = prevGraph.keyframes || {};
        const nextStore = { ...currentKeyframes };

        for (const item of items) {
          const nodeId = item.nodeId;
          if (!nodeId) continue;
          const targetFrame = Math.max(0, targetBaseFrame + item.relativeFrame);
          const nodeKeys = nextStore[nodeId] ? { ...nextStore[nodeId] } : {};
          const list = nodeKeys[item.paramKey] ? [...nodeKeys[item.paramKey]] : [];

          const newKf: Keyframe = {
            frame: targetFrame,
            value: JSON.parse(JSON.stringify(item.value)),
            easeIn: item.easeIn,
            easeStrength: item.easeStrength,
            easeBezier: item.easeBezier,
          };
          const filtered = list.filter((k) => k.frame !== targetFrame);
          nodeKeys[item.paramKey] = [...filtered, newKf].sort((a, b) => a.frame - b.frame);
          nextStore[nodeId] = nodeKeys;
        }

        return { ...prevGraph, keyframes: nextStore };
      }, `keyframes:paste:${items.length}`);
    },
    [setGraphWithHistory],
  );

  const onToggleMarker = useCallback((frame: number) => {
    setGraphWithHistory((prevGraph) => {
      const currentMarkers = prevGraph.markers || [];
      const idx = currentMarkers.findIndex((m) => m.frame === frame);
      let nextMarkers: Marker[];
      if (idx >= 0) {
        nextMarkers = currentMarkers.filter((m) => m.frame !== frame);
      } else {
        nextMarkers = [...currentMarkers, { frame }].sort((a, b) => a.frame - b.frame);
      }
      return { ...prevGraph, markers: nextMarkers };
    }, `marker:toggle:${frame}`);
  }, [setGraphWithHistory]);

  const onMoveMarker = useCallback((oldFrame: number, newFrame: number) => {
    setGraphWithHistory((prevGraph) => {
      const currentMarkers = prevGraph.markers || [];
      const moved = currentMarkers.find((m) => m.frame === oldFrame);
      const filtered = currentMarkers.filter((m) => m.frame !== oldFrame && m.frame !== newFrame);
      const nextMarkers = [...filtered, { ...moved, frame: newFrame }].sort((a, b) => a.frame - b.frame);
      return { ...prevGraph, markers: nextMarkers };
    }, `marker:move:${oldFrame}->${newFrame}`);
  }, [setGraphWithHistory]);

  const onRenameMarker = useCallback((frame: number, label: string) => {
    setGraphWithHistory((prevGraph) => {
      const currentMarkers = prevGraph.markers || [];
      const nextMarkers = currentMarkers.map((m) =>
        m.frame === frame ? { ...m, ...(label ? { label } : { label: undefined }) } : m,
      );
      return { ...prevGraph, markers: nextMarkers };
    }, `marker:rename:${frame}`);
  }, [setGraphWithHistory]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--chrome-bg, #2f3641)",
      }}
    >
      <TopBar
        project={project}
        onLoadProject={handleLoadProject}
        onProjectSaved={handleProjectSaved}
        currentFilename={currentFilename}
        currentFilePath={currentFilePath}
        onFilenameChange={handleFilenameChange}
        onFilesLoaded={() => setCanvases((prev) => [...prev])}
        onUndo={undo}
        onRedo={redo}
        onExportVideo={keyframesEnabled ? handleExportVideo : undefined}
        onExportSequence={keyframesEnabled ? handleExportSequence : undefined}
        onExportGraphSvg={handleExportGraphSvg}
        isExporting={isExporting}
        exportMode={exportMode}
        exportProgress={exportProgress}
        isTimelineOpen={spaces.timeline}
        onToggleTimeline={keyframesEnabled ? () => toggleSpace("timeline") : undefined}
        is2DMode={is2DMode}
        onToggle2DMode={toggle2DMode}
        hasView2DNode={!!findView2DNodeId(graph)}
        isPlaying={isPlaying}
        onTogglePlay={() => setIsPlaying((p) => !p)}
        onResetSimulations={handleResetSimulations}
        spaces={spaces}
        onToggleSpace={toggleSpace}
      />
      {isExporting && (
        // Off-screen (not display:none, which some webviews suspend rAF
        // for), sized to the real export resolution so captureStream reads
        // full-quality pixels regardless of what the editor panes show.
        // A 2D export reads the 2D texture at its own size, so this canvas only needs to exist.
        <div
          style={{
            position: "fixed",
            left: -100000,
            top: 0,
            width: exportSource === "2d" ? 256 : exportWidth,
            height: exportSource === "2d" ? 256 : exportHeight,
          }}
        >
          <Viewport
            graph={exportGraph}
            registry={DEFAULT_REGISTRY}
            renderNodeId={findRenderNodeId(exportGraph) ?? ""}
            view2DNodeId={exportSource === "2d" ? findView2DNodeId(exportGraph) : undefined}
            epochMs={epochMs}
            outputMode
            exportHandleRef={exportHandleRef}
            onEvaluatedResults={onExportEvaluated}
          />
        </div>
      )}
      <div
        style={{
          display: spaces.view3D || spaces.camera || spaces.view2D ? "flex" : "none",
          flexDirection: "column",
          height:
            (spaces.view3D || spaces.camera || spaces.view2D) && (spaces.canvas || spaces.timeline)
              ? `${splitPercent}%`
              : spaces.view3D || spaces.camera || spaces.view2D
              ? "100%"
              : "0%",
          flex:
            (spaces.view3D || spaces.camera || spaces.view2D) && !(spaces.canvas || spaces.timeline)
              ? 1
              : undefined,
          minHeight: 0,
          position: "relative",
        }}
      >
        <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
          <WithPlayhead canvas={activeCanvas}>
            {(currentFrame) => (
          <SplitViewport
            graph={graph}
            registry={DEFAULT_REGISTRY}
            renderNodeId={findRenderNodeId(graph) ?? ""}
            epochMs={epochMs}
            selectedNodeId={selectedNodeId}
            onSelectNode={handleSelectNode}
            onTransformChange={onTransformChange}
            onTransformStart={onTransformStart}
            onCameraChange={onPreviewCameraChange}
            currentFrame={currentFrame}
            totalFrames={totalFrames}
            onFrameChange={onViewportFrame}
            onEvaluatedResults={onEvaluatedResults}
            isPlaying={isPlaying}
            onHubChange={handleHubChange}
            suspended={isExporting || (!spaces.view3D && !spaces.camera && !spaces.view2D)}
            show3DView={spaces.view3D}
            showCameraView={spaces.camera}
            show2DView={spaces.view2D}
            view2DNodeId={findView2DNodeId(graph)}
            onCycleViewMode={() => toggleSpace("camera")}
            keyframes={graph.keyframes}
            keyframesEnabled={keyframesEnabled}
            onParamChange={onParamChange}
            onParamAction={onParamAction}
            onUnpinParam={onToggleExposed}
            onRenameExposedParam={onRenameExposed}
            mode2D={is2DMode}
            snapElevation={snapElevation}
            onToggleSnapElevation={toggleSnapElevation}
          />
            )}
          </WithPlayhead>
          {needsTransformHint && (
            <div className="viewport-hint">Wire a Transform node into this object's Matrix to move it</div>
          )}
          {selectedInstance &&
            selectedInstance.type === CAMERA_NODE.type &&
            selectedInstance.params.mode === "calibrated" && (
              <CalibrationOverlay
                graph={graph}
                cameraNodeId={selectedInstance.id}
                storedPicks={selectedInstance.params.calibrationPicks}
                mode={selectedInstance.params.mode ?? DEFAULT_REGISTRY.get(selectedInstance.type)?.defaultParams.mode}
                onChange={onParamChange}
              />
            )}
        </div>
        {keyframesEnabled && (
          <LiveTimelineBar
            canvas={activeCanvas}
            nodes={graph.nodes}
            totalFrames={totalFrames}
            isPlaying={isPlaying}
            keyframesEnabled={keyframesEnabled}
            selectedKeyframes={selectedKeyframesRecord}
            markers={graph.markers ?? []}
            fps={exportFps}
            onToggleMarker={onToggleMarker}
            onMoveMarker={onMoveMarker}
            onRenameMarker={onRenameMarker}
            onMoveKeyframe={onMoveKeyframe}
            onUpdateKeyframeEasing={onUpdateKeyframeEasing}
            onDeleteKeyframe={onDeleteKeyframe}
            onFrameChange={setCurrentFrame}
            onSplitHandleMouseDown={
              (spaces.view3D || spaces.camera || spaces.view2D) && (spaces.canvas || spaces.timeline)
                ? onSplitHandleMouseDown
                : () => {}
            }
            canResizeSplit={Boolean((spaces.view3D || spaces.camera || spaces.view2D) && (spaces.canvas || spaces.timeline))}
            isDrawerOpen={spaces.timeline}
            onToggleDrawer={() => toggleSpace("timeline")}
          />
        )}
      </div>

      {/* Primary Split Divider with left & right resize handle buttons between 3D View and Lower Pane (only needed when mini timeline is disabled) */}
      {(spaces.view3D || spaces.camera || spaces.view2D) && (spaces.canvas || spaces.timeline) && !keyframesEnabled && (
        <div
          className="workspace-split-divider"
          onMouseDown={onSplitHandleMouseDown}
          onPointerDown={onSplitHandleMouseDown}
          title="Resize workspace split (drag vertically)"
        >
          <button
            type="button"
            className="timeline-split-handle-btn timeline-split-handle-btn-left"
            onMouseDown={onSplitHandleMouseDown}
            onPointerDown={onSplitHandleMouseDown}
            title="Resize workspace split (drag vertically)"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="8 7 12 3 16 7" />
              <polyline points="8 17 12 21 16 17" />
              <line x1="12" y1="3" x2="12" y2="21" />
            </svg>
          </button>
        </div>
      )}


      {/* True screen overlay, not scoped to the 3D-viewport pane above: a
          fixed-position sibling of every other pane (see param-panel.css),
          so it stays reachable in every Shift+Tab view state, full-canvas
          Graph included, where that pane collapses to 0 height. */}
      {selectedInstance && selectedDef && (
        <WithEvaluation
          canvas={activeCanvas}
          select={(frame, evaluatedResults) =>
            paramPanelValues(graph, selectedInstance, selectedDef, evaluatedResults, keyframesEnabled ? frame : undefined)
          }
        >
          {(currentFrame, paramValues) => (
        <ParamPanel
          nodeId={selectedInstance.id}
          label={selectedDef.label}
          category={selectedDef.category}
          fields={
            selectedDef.dynamicParamFields
              ? selectedDef.dynamicParamFields(selectedInstance, nodeConnections(graph, selectedInstance.id))
              : (selectedDef.paramFields ?? [])
          }
          params={paramValues}
          keyframes={graph.keyframes}
          currentFrame={keyframesEnabled ? currentFrame : -1}
          keyframesEnabled={keyframesEnabled}
          onChange={onParamChange}
          onToggleKeyframe={onToggleKeyframe}
          onAction={onParamAction}
          connectedSockets={connectedSocketIds(graph, selectedInstance.id)}
          exposedKeys={
            new Set((graph.exposedParams ?? []).filter((e) => e.nodeId === selectedInstance.id).map((e) => e.paramId))
          }
          onToggleExposed={onToggleExposed}
        />
          )}
        </WithEvaluation>
      )}
      <div
        style={{
          flex: spaces.canvas || spaces.timeline ? 1 : "none",
          minHeight: 0,
          display: spaces.canvas || spaces.timeline ? "flex" : "none",
          flexDirection: "column",
        }}
      >
        {spaces.timeline && (
          <WithPlayhead canvas={activeCanvas}>
            {(currentFrame) => (
          <TimelineDrawer
            isOpen={spaces.timeline}
            onClose={() => toggleSpace("timeline")}
            currentFrame={currentFrame}
            totalFrames={totalFrames}
            isPlaying={isPlaying}
            keyframesEnabled={keyframesEnabled}
            graph={graph}
            registry={DEFAULT_REGISTRY}
            selectedNodeIds={selectedNodeIds}
            onSelectNode={handleSelectNode}
            onFrameChange={setCurrentFrame}
            onTogglePlay={() => setIsPlaying((p) => !p)}
            onToggleKeyframe={onToggleKeyframe}
            onBatchMoveKeyframes={onBatchMoveKeyframes}
            onBatchDeleteKeyframes={onBatchDeleteKeyframes}
            onBatchDuplicateKeyframes={onBatchDuplicateKeyframes}
            onBatchUpdateEasing={onBatchUpdateEasing}
            onChangeKeyframeValue={onChangeKeyframeValue}
            onEditKeyframes={onEditKeyframes}
            fps={exportFps}
            onPasteKeyframes={onPasteKeyframes}
            markers={graph.markers ?? []}
            onToggleMarker={onToggleMarker}
            onMoveMarker={onMoveMarker}
            onRenameMarker={onRenameMarker}
            drawerHeight={timelineDrawerHeight}
            onDrawerHeightChange={setTimelineDrawerHeight}
            onSplitHandleMouseDown={
              (spaces.view3D || spaces.camera || spaces.view2D) && spaces.canvas
                ? onSplitHandleMouseDown
                : () => {}
            }
            isFullHeight={!spaces.canvas}
            isDraggingDrawer={isDraggingDrawer}
          />
            )}
          </WithPlayhead>
        )}
        {/* Secondary Split Divider with left & right resize handle buttons between Timeline and Canvas */}
        {spaces.timeline && spaces.canvas && (
          <div
            className="workspace-split-divider"
            onMouseDown={onDrawerSplitMouseDown}
            onPointerDown={onDrawerSplitMouseDown}
            title="Resize timeline height (drag vertically)"
          >
            <button
              type="button"
              className="timeline-split-handle-btn timeline-split-handle-btn-left"
              onMouseDown={onDrawerSplitMouseDown}
              onPointerDown={onDrawerSplitMouseDown}
              title="Resize timeline height (drag vertically)"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="8 7 12 3 16 7" />
                <polyline points="8 17 12 21 16 17" />
                <line x1="12" y1="3" x2="12" y2="21" />
              </svg>
            </button>
          </div>
        )}

        {spaces.canvas && (
          <div style={{ flex: 1, minHeight: 0 }}>
            <GraphEditor
              key={`${activeCanvas}:${editorKey}`}
              graph={graph}
              registry={DEFAULT_REGISTRY}
              onGraphChange={onGraphChange}
              onSelectNode={handleSelectNode}
              selectedNodeId={selectedNodeId}
              onSelectNodes={handleSelectNodes}
              selectedNodeIds={selectedNodeIds}
              canvasCount={CANVAS_COUNT}
              activeCanvas={activeCanvas}
              emptyCanvases={emptyCanvases}
              onSelectCanvas={switchCanvas}
              onNodeAction={onNodeAction}
            />
          </div>
        )}
      </div>
      {isDraggingSplit && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 99999,
            cursor: "row-resize",
            userSelect: "none",
            pointerEvents: "auto",
          }}
        >
          <div
            ref={ghostLineRef}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: 1,
              background: "var(--accent-color, #38bdf8)",
              transform: `translateY(${lastClampedYRef.current}px)`,
              pointerEvents: "none",
            }}
          />
        </div>
      )}
      {isDraggingDrawer && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 99999,
            cursor: "row-resize",
            userSelect: "none",
            pointerEvents: "auto",
          }}
        >
          <div
            ref={ghostDrawerLineRef}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: 1,
              background: "var(--accent-color, #38bdf8)",
              transform: `translateY(${lastClampedDrawerYRef.current}px)`,
              pointerEvents: "none",
            }}
          />
        </div>
      )}
    </div>
  );
}

export default App;
