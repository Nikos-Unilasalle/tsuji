import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { CAMERA_FLY_TO_NODE, CAMERA_NODE } from "./shared/graph/nodes/camera";
import { asVector3, composeTransform } from "./shared/graph/nodes/transform";
import { DEFAULT_REGISTRY } from "./shared/graph/nodes";
import { toBoolean } from "./shared/graph/sockets";
import { BAKE_INSTANCES_ACTION, bakeInstancesToGeometryData } from "./shared/graph/nodes/particleInstances";
import { EXPLODE_GLTF_ACTION, ExplodedTexture, explodeGltfToMeshData, gltfSourceDirectory } from "./shared/graph/nodes/gltfLoader";
import { isTauri } from "./shared/isTauri";
import { TOGGLE_POINTS_KEYFRAME_ACTION } from "./shared/graph/nodes/curve";
import { RESEED_MESH_POINTS_ACTION } from "./shared/graph/nodes/editMeshPoints";
import { extractPointsFromMesh } from "./shared/graph/nodes/pointsGeometry";
import { freezeObjectToGeometryData, OBJECT_FROZEN_NODE } from "./shared/graph/nodes/frozenGeometry";
import type { KeyframeDrawing } from "./shared/graph/nodes/greasePencil";
import { randomId } from "./shared/randomId";
import { findRenderNodeId } from "./shared/graph/nodes/render";
import { rehydrateFileNodesFromDisk } from "./shared/graph/rehydrateFiles";
import { cloneGraph, cloneParams, cloneParamValue } from "./shared/graph/cloneGraph";
import { consumeCameraHandoffRequest } from "./shared/graph/cameraHandoffStore";
import { consumeCanvasSwitchRequest } from "./shared/graph/canvasSwitchStore";
import { isGraphZone } from "./shared/graph/inputZoneStore";
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
  normalizeCanvases,
  ParamFieldDef,
  Project,
} from "./shared/graph/types";
import { broadcastGraph, maximizeMainWindow, PreviewCameraPose, startBroadcasting } from "./shared/ipc";
import { exportVideo, mimeToExtension, saveVideoBlob } from "./shared/export/videoExport";
import { exportPngSequence, saveZipBlob } from "./shared/export/imageSequenceExport";
import { TransformPatch, Viewport, ViewportExportHandle } from "./shared/three/Viewport";
import { SplitViewport, SplitViewMode } from "./shared/three/SplitViewport";
import "./shared/three/viewport.css";
import { GIZMO_SELECTABLE_TYPES, resolveGizmoTarget } from "./shared/graph/transformLookup";
import { CalibrationOverlay } from "./windows/CalibrationOverlay";
import { GraphEditor } from "./windows/GraphEditor";
import { OutputWindow } from "./windows/OutputWindow";
import { parseVector3, ParamPanel } from "./windows/ParamPanel";
import { TimelineBar } from "./windows/TimelineBar";
import { TimelineDrawer } from "./windows/TimelineDrawer";
import { KeyframeClipboardItem } from "./windows/timelineUtils";
import { TopBar } from "./windows/TopBar";


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

/** Quiet time after the last edit before the document is written to localStorage. */
const AUTOSAVE_DEBOUNCE_MS = 800;

const MIN_PANE_PERCENT = 15;
const MAX_PANE_PERCENT = 85;

/**
 * Two windows, one bundle: the Rust side (`output_window.rs`) opens the
 * projector-facing window at `index.html#/output` — this hash is the sole
 * discriminator between "I'm the main editor" and "I'm the output," same
 * pattern OpenVMap 2D uses. No router library needed for two routes.
 */
function App() {
  if (window.location.hash === "#/output") {
    return <OutputWindow />;
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
  selectedNodeIdsRef.current = selectedNodeIds;
  const [isTimelineDrawerOpen, setIsTimelineDrawerOpen] = useState(false);
  const [timelineDrawerHeight, setTimelineDrawerHeight] = useState(280);
  const [splitPercent, setSplitPercent] = useState(50);
  const [is2DMode, setIs2DMode] = useState(false);
  const [snapElevation, setSnapElevation] = useState(false);
  const toggle2DMode = useCallback(() => setIs2DMode((prev) => !prev), []);
  const toggleSnapElevation = useCallback(() => setSnapElevation((prev) => !prev), []);
  // Shift+Tab cycle — see SplitViewport.tsx's SplitViewMode doc comment for
  // why this lives here rather than inside SplitViewport itself.
  const [viewMode, setViewMode] = useState<SplitViewMode>("viewport");
  const cycleViewMode = useCallback(() => {
    setViewMode((m) => (m === "viewport" ? "split" : m === "split" ? "camera" : m === "camera" ? "graph" : "viewport"));
  }, []);
  const [currentFilename, setCurrentFilename] = useState(recovered?.filename ?? "project_v1.tsuji");
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingSplit = useRef(false);

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

  const renderNodeInstance = graph.nodes.find((n) => n.type === "render");
  const rawFrameCount = Number(renderNodeInstance?.params?.frameCount);
  const totalFrames = renderNodeInstance
    ? Number.isFinite(rawFrameCount) && rawFrameCount > 0
      ? Math.round(rawFrameCount)
      : 120
    : 0;
  const keyframesEnabled = !!renderNodeInstance;
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
  const [exportProgress, setExportProgress] = useState(0);

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

  const handleExportVideo = useCallback(async () => {
    if (!renderNodeInstance || totalFrames <= 0) {
      alert("Add a Render node with at least one frame before exporting.");
      return;
    }
    exportCancelledRef.current = false;
    setIsExporting(true);
    setExportMode("video");
    setExportProgress(0);
    try {
      const handle = await waitForExportHandle();

      const blob = await exportVideo(handle, {
        totalFrames,
        fps: exportFps,
        onProgress: (done, total) => setExportProgress(done / total),
        isCancelled: () => exportCancelledRef.current,
      });

      const base = currentFilename.replace(/\.[^.]+$/, "") || "export";
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
  }, [renderNodeInstance, totalFrames, exportFps, currentFilename, waitForExportHandle]);

  const handleExportSequence = useCallback(async () => {
    if (!renderNodeInstance || totalFrames <= 0) {
      alert("Add a Render node with at least one frame before exporting.");
      return;
    }
    exportCancelledRef.current = false;
    setIsExporting(true);
    setExportMode("sequence");
    setExportProgress(0);
    try {
      const handle = await waitForExportHandle();

      const blob = await exportPngSequence(handle, {
        totalFrames,
        fps: exportFps,
        onProgress: (done, total) => setExportProgress(done / total),
        isCancelled: () => exportCancelledRef.current,
      });

      const base = currentFilename.replace(/\.[^.]+$/, "") || "export";
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
  }, [renderNodeInstance, totalFrames, exportFps, currentFilename, waitForExportHandle]);

  const [isPlaying, setIsPlaying] = useState(false);
  // Per canvas: each has its own Render node and so its own frame count, and
  // coming back to a canvas should find it where you left it rather than
  // wherever another canvas's playhead happens to be.
  const [currentFrames, setCurrentFrames] = useState<number[]>(() => new Array(CANVAS_COUNT).fill(0));
  const currentFrame = currentFrames[activeCanvas] ?? 0;
  const setCurrentFrame = useCallback((nextOrUpdater: number | ((prev: number) => number)) => {
    setCurrentFrames((prev) =>
      prev.map((frame, i) =>
        i === activeCanvasRef.current
          ? typeof nextOrUpdater === "function"
            ? nextOrUpdater(frame)
            : nextOrUpdater
          : frame,
      ),
    );
  }, []);
  const [evaluatedResults, setEvaluatedResults] = useState<Map<string, Record<string, unknown>> | null>(null);

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
    },
    [switchCanvas, activateCameraNode],
  );

  useEffect(() => {
    void maximizeMainWindow();
  }, []);

  useEffect(() => {
    if (keyframesEnabled && totalFrames > 0) {
      setCurrentFrame((prev) => Math.max(0, Math.min(totalFrames - 1, prev)));
    }
  }, [totalFrames, keyframesEnabled, setCurrentFrame]);

  /**
   * When the viewport last advanced the playhead itself. See the fallback
   * timer below, and Viewport's `onFrameChange`.
   */
  const viewportDrivenAtRef = useRef(0);
  const onViewportFrame = useCallback(
    (frame: number) => {
      viewportDrivenAtRef.current = Date.now();
      setCurrentFrame(frame);
    },
    [setCurrentFrame],
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

      if (!isInput && (code === "Space" || e.key === " ") && !isCmdOrCtrl) {
        e.preventDefault();
        if (keyframesEnabled) {
          setIsPlaying((prev) => !prev);
        }
      } else if (!isInput && (e.key === "t" || e.key === "T") && !isCmdOrCtrl && !isGraphZone()) {
        e.preventDefault();
        setIsTimelineDrawerOpen((prev) => !prev);
      } else if (!isInput && (e.key === "Tab" || e.code === "Tab") && e.shiftKey) {
        // Global on purpose: one of the four states (full-canvas Graph)
        // unmounts every Viewport instance, so a listener living inside one
        // (the old approach) couldn't fire once none were left mounted.
        e.preventDefault();
        cycleViewMode();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [keyframesEnabled, cycleViewMode]);

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
    const currentIds = new Set(canvases.flatMap((canvas) => canvas.nodes.map((n) => n.id)));
    const departed = [...knownNodeIdsRef.current].filter((id) => !currentIds.has(id));
    if (departed.length > 0) disposeNodeCaches(departed);
    knownNodeIdsRef.current = currentIds;
  }, [canvases]);
  // Not React state on purpose — this changes at orbit-drag frequency, and
  // nothing in this component's own render output depends on it (only the
  // outgoing broadcast does). A state variable here would re-render
  // MainEditor's whole tree on every orbit tick for no visual benefit.
  const previewCameraRef = useRef<PreviewCameraPose | null>(null);

  const selectedInstance = graph.nodes.find((n) => n.id === selectedNodeId) ?? null;
  const selectedDef = selectedInstance ? DEFAULT_REGISTRY.get(selectedInstance.type) : undefined;
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
    broadcastGraph({ graph: graphRef.current, epochMs, calibratingNodeId, previewCamera: pose });
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
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [undo, redo]);

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
    setCurrentFrames(new Array(CANVAS_COUNT).fill(0));
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

  const onParamChange = (paramId: string, value: unknown, targetNodeId?: string) => {
    const nodeIdToUpdate = targetNodeId ?? selectedNodeId;
    setGraphWithHistory((prevGraph) => {
      const instance = prevGraph.nodes.find((n) => n.id === nodeIdToUpdate);
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
          const mRotScale = composeTransform(new THREE.Vector3(), rot, scl);
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

      return {
        ...prevGraph,
        keyframes: nextKeyframes,
        nodes: prevGraph.nodes.map((n) => {
          if (n.id === instance.id) {
            return { ...n, params: nextParams };
          }
          if (isActivatingCamera && (n.type === CAMERA_NODE.type || n.type === CAMERA_FLY_TO_NODE.type)) {
            return { ...n, params: { ...n.params, active: false } };
          }
          return n;
        }),
      };
    }, `${nodeIdToUpdate}:${paramId}`);
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
      const def = instance ? DEFAULT_REGISTRY.get(instance.type) : undefined;
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
      if (action === TOGGLE_POINTS_KEYFRAME_ACTION) {
        const node = graph.nodes.find((n) => n.id === nodeId);
        if (!node || currentFrame < 0) return;
        onToggleKeyframe(nodeId, "pointsList", currentFrame, node.params.pointsList);
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
        onParamChange("pointsList", extracted.points, nodeId);
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
    [setGraphWithHistory, graph.nodes, currentFrame, onToggleKeyframe, evaluatedResults, onParamChange],
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
      const output = evaluatedResults?.get(nodeId)?.geometry;
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
    [evaluatedResults, setGraphWithHistory],
  );

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
    setGraph((prevGraph) => {
      let fullPatch = { ...patch };
      if (fullPatch.pivot && !fullPatch.location) {
        const node = prevGraph.nodes.find((n) => n.id === transformNodeId);
        if (node && "location" in node.params) {
          const oldPiv = asVector3(node.params.pivot, new THREE.Vector3());
          const newPiv = asVector3(fullPatch.pivot, new THREE.Vector3());
          const deltaPiv = new THREE.Vector3().subVectors(newPiv, oldPiv);
          if (deltaPiv.lengthSq() > 0) {
            const rot = asVector3(node.params.rotation, new THREE.Vector3());
            const scl = asVector3(node.params.scale, new THREE.Vector3(1, 1, 1));
            const mRotScale = composeTransform(new THREE.Vector3(), rot, scl);
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

      return {
        ...prevGraph,
        keyframes: nextKeyframes,
        nodes: prevGraph.nodes.map((n) =>
          n.id === transformNodeId ? { ...n, params: { ...n.params, ...fullPatch } } : n,
        ),
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

  const onSplitHandleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.shiftKey) return;
    e.preventDefault();
    draggingSplit.current = true;
  }, []);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!draggingSplit.current || !containerRef.current) return;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      const rect = containerRef.current.getBoundingClientRect();
      const percent = ((e.clientY - rect.top) / rect.height) * 100;
      setSplitPercent(Math.min(MAX_PANE_PERCENT, Math.max(MIN_PANE_PERCENT, percent)));
    }
    function onMouseUp() {
      if (draggingSplit.current) {
        draggingSplit.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const selectedParamValues =
    selectedInstance && selectedDef
      ? paramPanelValues(
          graph,
          selectedInstance,
          selectedDef,
          evaluatedResults,
          keyframesEnabled ? currentFrame : undefined
        )
      : {};

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

  // The first sound/player node with a loaded file drives the timeline
  // waveform strip (music sync).
  //
  // Read from the evaluation results, not from the audio store: the store is a
  // module cache filled asynchronously once the file has decoded, and nothing
  // about that write reaches React. Keyed on graph.nodes, this memo never
  // recomputed after a project was reopened — the file loaded, the waveform
  // never appeared. `url` is a socket now, so it arrives with every frame's
  // results like any other value.
  const waveformClip = useMemo(() => {
    if (!evaluatedResults) return undefined;
    for (const node of graph.nodes) {
      if (node.type !== "sound/player") continue;
      const res = evaluatedResults.get(node.id);
      const url = res?.url;
      if (typeof url !== "string" || !url) continue;
      // A trigger-driven clip (startFrame -1) has no knowable position on the
      // timeline, so it is drawn from frame 0 rather than not at all.
      const start = Number(res?.startFrame);
      return {
        url,
        startFrame: Number.isFinite(start) && start >= 0 ? start : 0,
        duration: Number(res?.duration) || 0,
      };
    }
    return undefined;
  }, [graph.nodes, evaluatedResults]);

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
      style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column" }}
    >
      <TopBar
        project={project}
        onLoadProject={handleLoadProject}
        onProjectSaved={handleProjectSaved}
        currentFilename={currentFilename}
        currentFilePath={currentFilePath}
        onFilenameChange={handleFilenameChange}
        onUndo={undo}
        onRedo={redo}
        onExportVideo={keyframesEnabled ? handleExportVideo : undefined}
        onExportSequence={keyframesEnabled ? handleExportSequence : undefined}
        isExporting={isExporting}
        exportMode={exportMode}
        exportProgress={exportProgress}
        isTimelineOpen={isTimelineDrawerOpen}
        onToggleTimeline={() => setIsTimelineDrawerOpen((prev) => !prev)}
        is2DMode={is2DMode}
        onToggle2DMode={toggle2DMode}
      />
      {isExporting && (
        // Off-screen (not display:none, which some webviews suspend rAF
        // for), sized to the real export resolution so captureStream reads
        // full-quality pixels regardless of what the editor panes show.
        <div style={{ position: "fixed", left: -100000, top: 0, width: exportWidth, height: exportHeight }}>
          <Viewport
            graph={graph}
            registry={DEFAULT_REGISTRY}
            renderNodeId={findRenderNodeId(graph) ?? ""}
            epochMs={epochMs}
            outputMode
            exportHandleRef={exportHandleRef}
          />
        </div>
      )}
      <div style={{ height: viewMode === "graph" ? "0%" : `${splitPercent}%`, minHeight: 0, position: "relative" }}>
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
          suspended={isExporting}
          viewMode={viewMode}
          onCycleViewMode={cycleViewMode}
          keyframes={graph.keyframes}
          keyframesEnabled={keyframesEnabled}
          evaluatedResults={evaluatedResults}
          onParamChange={onParamChange}
          onUnpinParam={onToggleExposed}
          onRenameExposedParam={onRenameExposed}
          mode2D={is2DMode}
          snapElevation={snapElevation}
          onToggleSnapElevation={toggleSnapElevation}
        />
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
      {/* True screen overlay, not scoped to the 3D-viewport pane above: a
          fixed-position sibling of every other pane (see param-panel.css),
          so it stays reachable in every Shift+Tab view state, full-canvas
          Graph included, where that pane collapses to 0 height. */}
      {selectedInstance && selectedDef && (
        <ParamPanel
          nodeId={selectedInstance.id}
          label={selectedDef.label}
          category={selectedDef.category}
          fields={
            selectedDef.dynamicParamFields
              ? selectedDef.dynamicParamFields(selectedInstance)
              : (selectedDef.paramFields ?? [])
          }
          params={selectedParamValues}
          keyframes={graph.keyframes}
          currentFrame={keyframesEnabled ? currentFrame : -1}
          keyframesEnabled={keyframesEnabled}
          onChange={onParamChange}
          onToggleKeyframe={onToggleKeyframe}
          onAction={onParamAction}
          canFreeze={(selectedDef.outputs ?? []).some((o) => o.id === "geometry" && o.type === "geometry")}
          onFreeze={onFreezeNode}
          connectedSockets={connectedSocketIds(graph, selectedInstance.id)}
          exposedKeys={
            new Set((graph.exposedParams ?? []).filter((e) => e.nodeId === selectedInstance.id).map((e) => e.paramId))
          }
          onToggleExposed={onToggleExposed}
        />
      )}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {!isTimelineDrawerOpen && (
          <TimelineBar
            currentFrame={currentFrame}
            totalFrames={totalFrames}
            isPlaying={isPlaying}
            keyframesEnabled={keyframesEnabled}
            selectedKeyframes={selectedKeyframesRecord}
            markers={graph.markers ?? []}
            waveformUrl={waveformClip?.url}
            waveformStartFrame={waveformClip?.startFrame}
            waveformDuration={waveformClip?.duration}
            fps={exportFps}
            onToggleMarker={onToggleMarker}
            onMoveMarker={onMoveMarker}
            onRenameMarker={onRenameMarker}
            onMoveKeyframe={onMoveKeyframe}
            onUpdateKeyframeEasing={onUpdateKeyframeEasing}
            onDeleteKeyframe={onDeleteKeyframe}
            onFrameChange={setCurrentFrame}
            onTogglePlay={() => setIsPlaying((p) => !p)}
            onSplitHandleMouseDown={onSplitHandleMouseDown}
            isDrawerOpen={isTimelineDrawerOpen}
            onToggleDrawer={() => setIsTimelineDrawerOpen((prev) => !prev)}
          />
        )}
        <TimelineDrawer
          isOpen={isTimelineDrawerOpen}
          onClose={() => setIsTimelineDrawerOpen(false)}
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
          onSplitHandleMouseDown={onSplitHandleMouseDown}
        />
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
            emptyCanvases={canvases.map(isCanvasEmpty)}
            onSelectCanvas={switchCanvas}
          />
        </div>
      </div>
    </div>
  );
}

export default App;
