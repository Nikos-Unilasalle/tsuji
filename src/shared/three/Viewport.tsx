import { MutableRefObject, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { ClockState, createClock, STEP_SECONDS, tickClock } from "../graph/clock";
import { EvalResult, disposeEvalSession, evaluateGraph } from "../graph/evaluate";
import { CAMERA_FLY_TO_NODE, CAMERA_NODE } from "../graph/nodes/camera";
import { HubElement } from "../graph/nodes/hub";
import { asVector3, composeNativeMatrixWithPivot, PIVOT_TRANSFORM_NODE } from "../graph/nodes/transform";
import { resetAllParticleSimulations } from "../graph/particleRuntime";
import { resolveCurveEditTarget } from "../graph/curveLookup";
import { resolveSceneRoots } from "../graph/sceneRoots";
import { findFirstMesh } from "../graph/meshRequired";
import { insertCurvePointAfter, removeCurvePoint } from "../graph/curvePoints";
import { GizmoTarget, resolveGizmoTarget } from "../graph/transformLookup";
import { CLIP_BOX_NODE, VISUAL_SLICE_NODE } from "../graph/nodes/visualSlice";
import { DECAL_NODE } from "../graph/nodes/decal";
import { createCurvePointHandles } from "./curveHandles";
import { createPointCloudHandles } from "./pointCloudHandles";
import { createSceneMembership, isSelfOrDescendantOf } from "./sceneMembership";
import {
  LATTICE_DEFORM_NODE,
  latticeBasePointForTarget,
  latticeEvaluatedPoints,
} from "../graph/nodes/lattice";
import { POINTS_SELECTION_NODE } from "../graph/nodes/pointsSelection";
import { applyWeldedPointMoves, EDIT_MESH_POINTS_NODE } from "../graph/nodes/editMeshPoints";
import { POINTS_INFLUENCE_NODE, POINTS_INFLUENCE_DISCRETE_LEVELS, PointsInfluenceMode } from "../graph/nodes/pointsInfluence";
import { FACE_SELECTION_NODE } from "../graph/nodes/meshEdit";
import { createFaceSelectionHandles } from "./faceSelectionHandles";
import { createPostProcessChain } from "./postProcessChain";
import { computeGizmoWriteback, TransformGizmoMode, TransformPatch } from "./gizmoWriteback";

// Re-exported so call sites (App.tsx, SplitViewport) keep importing these
// from the component they belong to, not from its internals.
export type { TransformGizmoMode, TransformPatch };
export type GpToolMode = "pen" | "eraser_hard" | "eraser_soft" | "tint" | "select";
import { createElevationHUD, snapElevationValue } from "./elevationGizmo";
import { GREASE_PENCIL_NODE, KeyframeDrawing, GreaseStroke, StrokePoint, parseColorHex } from "../graph/nodes/greasePencil";
import { PAINT_ON_GEOMETRY_NODE } from "../graph/nodes/paintOnGeometry";
import {
  calculateSimulatedPressure,
  applyStrokeTaper,
  projectScreenToDrawingPlane,
  projectScreenToTargetGeometry,
  addStrokeToFrames,
  duplicateDrawing,
  createBlankDrawing,
  clearDrawingAtFrame,
  eraseStrokesAtPosition,
  eraseStrokesSoft,
  tintStrokesAtPosition,
  smoothStrokePoints,
} from "./greasePencilDrawing";
import type { GreaseBrushType } from "../graph/nodes/greasePencil";

function isPaintOrGreaseNode(node: { type: string } | null | undefined): boolean {
  if (!node) return false;
  return node.type === GREASE_PENCIL_NODE.type || node.type === PAINT_ON_GEOMETRY_NODE.type;
}

function getTargetGeometryForNode(
  node: { id: string; type: string },
  graph: Graph,
  latestResults: Map<string, Record<string, unknown>> | null | undefined,
): THREE.Object3D | null {
  if (node.type !== PAINT_ON_GEOMETRY_NODE.type) return null;
  const incoming = graph.connections.find((c) => c.toNode === node.id && c.toSocket === "geometry");
  if (!incoming) return null;
  const res = latestResults?.get(incoming.fromNode);
  if (res?.geometry instanceof THREE.Object3D) {
    return res.geometry;
  }
  return null;
}

function resolvePointerPoint(
  clientX: number,
  clientY: number,
  node: NodeInstance,
  graph: Graph,
  latestResults: Map<string, Record<string, unknown>> | null | undefined,
  camera: THREE.Camera,
  domElement: HTMLElement,
  mode2D: boolean,
): { pos: THREE.Vector3; normal?: THREE.Vector3 } | null {
  if (node.type === PAINT_ON_GEOMETRY_NODE.type) {
    const targetObj = getTargetGeometryForNode(node, graph, latestResults);
    const paintGroup = (latestResults?.get(node.id)?.geometry as THREE.Object3D) || null;
    if (targetObj) {
      const hit = projectScreenToTargetGeometry(clientX, clientY, camera, domElement, targetObj, paintGroup);
      if (hit) {
        return { pos: hit.point, normal: hit.normal };
      }
      return null;
    }
  }

  const worldPos = projectScreenToDrawingPlane(clientX, clientY, {
    camera,
    domElement,
    elevationY: node.params.location instanceof THREE.Vector3 ? node.params.location.y : 0,
    mode2D,
    objectPosition: node.params.location instanceof THREE.Vector3 ? node.params.location : undefined,
  });

  return worldPos ? { pos: worldPos } : null;
}
import { createBackgroundBlur } from "./backgroundBlur";
import { applyEnvironment, resolveActiveEnvironment } from "./environmentSync";
import {
  buildMainSceneGridAndAxes,
  createGizmoScene,
  createViewportBackground,
  disposeMainSceneGridAndAxes,
  disposeGizmoScene,
  GIZMO_ACTIVE_COLOR,
  GIZMO_X_COLOR,
  GIZMO_Y_COLOR,
  GIZMO_Z_COLOR,
} from "./viewportScenery";
import { disposeObject3D } from "../graph/nodeCaches";
import { registerPointerViewport } from "../graph/pointerStore";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { createMotionBlur } from "./motionBlur";
import { advancePlayhead, IDLE_PLAYHEAD, PlayheadState } from "./playhead";
import { PostProcessConfig } from "../graph/nodes/postprocessing";
import { Graph, KeyframeStore, NodeInstance, NodeRegistry } from "../graph/types";
import { isViewportZone, setInputZone } from "../graph/inputZoneStore";
import { isTauri } from "../ipc";
import type { PreviewCameraPose } from "../ipc";
import { ViewportParamHUD } from "../../windows/ViewportParamHUD";
import "./viewport.css";

// HUD elements are CSS/DOM overlays, which video export (which captures the
// WebGL canvas) would otherwise omit. These helpers redraw each element onto a
// 2D canvas so the export includes the HUD.
/**
 * Cold-blue (0) to hot-red (1) heatmap for Points Influence handles — the
 * "dégradé de couleur" the painted gradient needs to actually read as a
 * gradient rather than a binary on/off dot.
 */
function influenceColor(v: number): number {
  const t = Math.max(0, Math.min(1, v));
  const cold = new THREE.Color(0x2563eb);
  const hot = new THREE.Color(0xef4444);
  return cold.clone().lerp(hot, t).getHex();
}

/** The 5 discrete-mode level colors, in the same order as POINTS_INFLUENCE_DISCRETE_LEVELS. */
const DISCRETE_LEVEL_COLORS = POINTS_INFLUENCE_DISCRETE_LEVELS.map((v) => influenceColor(v));

/** Hands each mounted viewport its own evaluator session id. */
let nextSessionOrdinal = 0;

/** At 60fps, one second of grace before an undecodable HUD image is given up on. */
const MAX_CAPTURE_WAIT_TICKS = 60;

/**
 * Edit Mesh Points reuses curveHandles — one draggable THREE.Mesh per point —
 * which is exactly right at a curve's handful of control points and
 * "catastrophic" (see pointCloudHandles.ts) at real mesh vertex counts. Past
 * this many points the handles are skipped rather than hanging the viewport;
 * a low-poly primitive (a Box, a coarse Sphere) stays well under it.
 */
const EDIT_MESH_POINTS_HANDLE_CAP = 2000;
let editMeshPointsCapWarned = false;

const exportImageCache = new Map<string, HTMLImageElement>();
function getExportImage(url: string): HTMLImageElement | null {
  let img = exportImageCache.get(url);
  if (!img) {
    img = new Image();
    img.src = url;
    exportImageCache.set(url, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/**
 * True once every HUD image in `elements` has decoded. Decoding is async and
 * starts on first use, so without this gate the opening frames of an export
 * encoded with the image elements simply missing — the very frames a title
 * card lives on.
 */
function hubImagesReady(elements: HubElement[]): boolean {
  for (const el of elements) {
    if (!el.visible || el.cssOpacity <= 0) continue;
    if (el.imageUrl && !getExportImage(el.imageUrl)) return false;
  }
  return true;
}

/** Drops cached decodes for object URLs no element references any more. */
function pruneExportImages(elements: HubElement[]): void {
  if (exportImageCache.size === 0) return;
  const live = new Set<string>();
  for (const el of elements) if (el.imageUrl) live.add(el.imageUrl);
  for (const url of exportImageCache.keys()) {
    if (!live.has(url)) exportImageCache.delete(url);
  }
}

/**
 * The animation part of a hub element's CSS transform — everything before the
 * `translate(-50%, -50%)` that merely centres it. The CSS overlay gets these
 * for free; the export canvas has to reproduce them, and not doing so meant
 * every animation except `fade` was invisible in the encoded video.
 */
function parseHubAnimationTransform(
  transform: string,
  frameWidth: number,
  frameHeight: number,
): { dx: number; dy: number; scale: number } {
  let dx = 0;
  let dy = 0;
  let scale = 1;
  const tx = transform.match(/translateX\((-?[\d.]+)vw\)/);
  if (tx) dx = (parseFloat(tx[1]) / 100) * frameWidth;
  const ty = transform.match(/translateY\((-?[\d.]+)vh\)/);
  if (ty) dy = (parseFloat(ty[1]) / 100) * frameHeight;
  const sc = transform.match(/scale\((-?[\d.]+)\)/);
  if (sc) scale = parseFloat(sc[1]);
  return { dx, dy, scale };
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawHubElement(
  ctx: CanvasRenderingContext2D,
  el: HubElement,
  frameWidth: number,
  frameHeight: number,
): void {
  if (!el.visible || el.cssOpacity <= 0) return;
  const anim = parseHubAnimationTransform(el.transform, frameWidth, frameHeight);
  if (anim.scale === 0) return;
  ctx.save();
  ctx.translate(el.x + anim.dx, el.y + anim.dy);
  if (anim.scale !== 1) ctx.scale(anim.scale, anim.scale);
  ctx.rotate((el.rotation * Math.PI) / 180);
  ctx.globalAlpha = el.cssOpacity;
  // `filter` carries the blur animation. Not every 2D context implements it,
  // so only set it when the property exists — the element still draws (sharp)
  // where it doesn't, rather than throwing mid-frame.
  if (el.filter && "filter" in ctx) ctx.filter = el.filter;

  if (el.imageUrl) {
    const img = getExportImage(el.imageUrl);
    if (img) {
      const w = (el.imageWidth ?? 200) * el.scale;
      const h = w / Math.max(1, img.naturalWidth / Math.max(1, img.naturalHeight));
      ctx.save();
      roundRectPath(ctx, -w / 2, -h / 2, w, h, el.borderRadius);
      ctx.clip();
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.restore();
      if (el.borderColor) {
        ctx.strokeStyle = el.borderColor;
        ctx.lineWidth = el.borderWidth;
        roundRectPath(ctx, -w / 2, -h / 2, w, h, el.borderRadius);
        ctx.stroke();
      }
    }
  } else {
    const fontSize = Math.max(1, el.fontSize * el.scale);
    ctx.font = `${fontSize}px ${el.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const tw = ctx.measureText(el.text).width;
    const bh = fontSize * 1.2 + 8;
    const bw = tw + 20;
    if (el.backgroundColor) {
      ctx.fillStyle = el.backgroundColor;
      roundRectPath(ctx, -bw / 2, -bh / 2, bw, bh, el.borderRadius);
      ctx.fill();
    }
    if (el.borderColor) {
      ctx.strokeStyle = el.borderColor;
      ctx.lineWidth = el.borderWidth;
      roundRectPath(ctx, -bw / 2, -bh / 2, bw, bh, el.borderRadius);
      ctx.stroke();
    }
    if (el.textShadow) {
      const m = el.textShadow.match(/(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(.*)$/);
      if (m) {
        ctx.shadowOffsetX = parseFloat(m[1]);
        ctx.shadowOffsetY = parseFloat(m[2]);
        ctx.shadowBlur = parseFloat(m[3]);
        ctx.shadowColor = m[4].trim();
      }
    }
    ctx.fillStyle = el.color;
    ctx.fillText(el.text, 0, 0);
  }
  ctx.restore();
}

/** Multiplies every `<n>px` token in a CSS string by `s` (HUD size scaling). */
function scalePxString(value: string | null | undefined, s: number): string | undefined {
  if (!value) return undefined;
  return value.replace(/(-?\d+(?:\.\d+)?)px/g, (_m, n: string) => `${(parseFloat(n) * s).toFixed(2)}px`);
}

/**
 * Copy a light's live state onto another instance of the same type. The
 * viewport's output pane holds its own clone of each graph light (they are
 * cached per node id at module scope and can only have one parent — see the * comment next to the clone in tick()), and this keeps that clone in step
 * with the shared original every frame, instead of re-cloning (which would
 * allocate a fresh shadow render target per frame).
 */
function copyLightState(src: THREE.Light, dst: THREE.Light) {
  dst.color.copy(src.color);
  dst.intensity = src.intensity;  dst.castShadow = src.castShadow;
  dst.position.copy(src.position);
  dst.quaternion.copy(src.quaternion);
  dst.scale.copy(src.scale);

  if (src instanceof THREE.PointLight && dst instanceof THREE.PointLight) {
    dst.distance = src.distance;
    dst.decay = src.decay;
  }
  if (src instanceof THREE.SpotLight && dst instanceof THREE.SpotLight) {
    dst.distance = src.distance;
    dst.decay = src.decay;
    dst.angle = src.angle;
    dst.penumbra = src.penumbra;
  }

  const srcTarget = (src as THREE.DirectionalLight | THREE.SpotLight).target;
  const dstTarget = (dst as THREE.DirectionalLight | THREE.SpotLight).target;
  if (srcTarget && dstTarget) {
    dstTarget.position.copy(srcTarget.position);
    dstTarget.updateMatrixWorld(true);
  }
  dst.updateMatrixWorld(true);
}


/**
 * The camera result currently driving the output — the same arbitration the
 * render loop uses to decide whose matrix positions the view: an active Fly
 * To wins over every Camera node, then the first active Camera, then the
 * first Camera regardless of its Active toggle. Extracted so the *previous*
 * frame's answer can be fed back into the next evaluation (see
 * EvalContext.activeCameraPose) without duplicating the rules.
 */
function resolveActiveCameraResult(
  results: Map<string, Record<string, unknown>>,
  graph: Graph,
): Record<string, unknown> | undefined {
  for (const node of graph.nodes) {
    if (node.type !== CAMERA_FLY_TO_NODE.type) continue;
    const res = results.get(node.id);
    if (res && res.active !== 0 && res.active !== false) return res;
  }

  const cameraNodes = graph.nodes.filter((n) => n.type === CAMERA_NODE.type);
  for (const node of cameraNodes) {
    const res = results.get(node.id);
    if (res && res.active !== 0 && res.active !== false) return res;
  }
  if (cameraNodes.length > 0) return results.get(cameraNodes[0].id);
  return undefined;
}

function activeCameraPoseFrom(result: Record<string, unknown> | undefined): { matrix: THREE.Matrix4; fov: number } | null {
  if (!result || !(result.matrix instanceof THREE.Matrix4)) return null;
  return { matrix: result.matrix, fov: typeof result.fov === "number" ? result.fov : 50 };
}


interface ViewportProps {
  graph: Graph;
  registry: NodeRegistry;
  /**
   * Which node in the graph is the `render` node. Not a gate on what gets
   * drawn any more (see sceneRoots.ts) — it supplies the output settings,
   * the environment and the post-process chain, and its own subtree is what
   * the outline pass and the passe-partout guide treat as "the output".
   */
  renderNodeId: string;
  epochMs?: number;
  /**
   * True for the projector-facing output window: no dev HUD, no orientation
   * gizmo, no debug ground grid/axis arrows baked into the projected image
   * — just the rendered scene. Default false (the editor's own viewport).
   */
  outputMode?: boolean;
  /**
   * Freezes this viewport's render loop entirely — no evaluation, no draw.
   * Set on the editor panes while a video export runs: stateful nodes
   * (particle sims, Ray Burst, hub triggers, Fly To) keep their state in
   * module-level caches keyed only by node id, so a preview pane ticking on
   * real time between two captured frames advanced the very state the export
   * was trying to sample deterministically.
   */
  suspended?: boolean;
  /** Drives which object shows a transform gizmo — shared with GraphEditor's own node selection (see App.tsx), so clicking an object here and clicking its node in the graph select the same thing. */
  selectedNodeId?: string | null;
  /** Fired on a click (not a drag) that hits a selectable mesh, or null on an empty-space click — mirrors GraphEditor's onSelectNode. Omit to disable click-to-select and the gizmo entirely. */
  onSelectNode?: (nodeId: string | null) => void;
  /** Fired continuously while dragging the gizmo, once the selected object's `matrix` input traces back to a plain Transform node (see transformLookup.ts) — nothing fires for an object with no such upstream node. */
  onTransformChange?: (transformNodeId: string, patch: TransformPatch) => void;
  /** Fired once when a gizmo drag begins — the parent records one undo step for the whole drag (see App.tsx). */
  onTransformStart?: () => void;
  /** Editor-only: fired on every orbit-camera change (and once on mount), so the output window can mirror the current view when there's no Camera node to lock onto instead — see the `previewCameraPose` prop below. */
  onCameraChange?: (pose: PreviewCameraPose) => void;
  /** Output-only: the editor's last-broadcast orbit pose. Applied only when there's no Camera node driving the camera (see the calibrationMatrix branch in tick()) — a Camera node's calibrated lock always wins. */
  previewCameraPose?: PreviewCameraPose | null;
  isSplitView?: boolean;
  onToggleSplitView?: () => void;
  currentFrame?: number;
  onEvaluatedResults?: (results: Map<string, Record<string, unknown>>) => void;
  isPlaying?: boolean;
  /**
   * Total timeline length. Only needed by the viewport that drives playback
   * (see `onFrameChange`); without it the incoming `currentFrame` is used as-is.
   */
  totalFrames?: number;
  /**
   * Set to make this viewport own the playhead while playing, advancing it off
   * the same clock it renders on and reporting each new frame back out.
   *
   * Keyframed motion only moves when `currentFrame` changes, so when an
   * outside timer pushed that frame in, two consecutive renders could land on
   * the same one. Motion blur's velocity buffer compares each render with the
   * one before it, so those duplicate renders measured no movement at all and
   * came out sharp — the reason a keyframed scene barely blurred while a
   * Time-node-driven one, running on this same clock, always did.
   *
   * Exactly one viewport should be given this.
   */
  onFrameChange?: (frame: number) => void;
  /** Fired continuously while dragging the 2D HUD gizmo on the camera view — writes the element's position/rotation/scale back to its hub node. */
  onHubChange?: (nodeId: string, patch: Partial<{ x: number; y: number; rotation: number; scale: number }>) => void;
  /**
   * Populated (by this component, into the ref the caller passed in) once
   * the render loop is up — see videoExport.ts. `captureFrame` forces the
   * *next* tick() to use `frameIndex/fps` for both the deterministic clock
   * (so Time-node/oscillator/particle output matches that instant rather
   * than real elapsed time) and keyframe evaluation, in place of whatever
   * live playback would have used that frame, then resolves once that
   * frame has been drawn.
   */
  exportHandleRef?: MutableRefObject<ViewportExportHandle | null>;
  /** Editor-only: the pinned viewport param HUD — see ViewportParamHUD. Not shown in outputMode. */
  keyframes?: KeyframeStore;
  keyframesEnabled?: boolean;
  evaluatedResults?: EvalResult | null;
  onParamChange?: (paramId: string, value: unknown, targetNodeId?: string) => void;
  onUnpinParam?: (nodeId: string, paramId: string) => void;
  onRenameExposedParam?: (nodeId: string, paramId: string, label: string) => void;
  mode2D?: boolean;
  elevationView?: boolean;
  snapElevation?: boolean;
  onToggleSnapElevation?: () => void;
  cameraView?: boolean;
  gpTool?: GpToolMode;
  onGpToolChange?: (mode: GpToolMode) => void;
  transformMode?: TransformGizmoMode;
  onTransformModeChange?: (mode: TransformGizmoMode) => void;
}

export interface ViewportExportHandle {
  getCanvas: () => HTMLCanvasElement | null;
  captureFrame: (frameIndex: number, fps: number) => Promise<void>;
}



export function Viewport({
  graph,
  registry,
  renderNodeId,
  epochMs = 0,
  outputMode = false,
  suspended = false,
  onSelectNode,
  selectedNodeId = null,
  onTransformChange,
  onTransformStart,
  onCameraChange,
  previewCameraPose = null,
  isSplitView = false,
  onToggleSplitView,
  currentFrame = -1,
  onEvaluatedResults,
  isPlaying = false,
  totalFrames = 0,
  onFrameChange,
  exportHandleRef,
  onHubChange,
  keyframes,
  keyframesEnabled = true,
  evaluatedResults = null,
  onParamChange,
  onUnpinParam,
  onRenameExposedParam,
  mode2D = false,
  elevationView = false,
  snapElevation = false,
  onToggleSnapElevation,
  cameraView = false,
  gpTool: gpToolProp,
  onGpToolChange,
  transformMode: transformModeProp,
  onTransformModeChange,
}: ViewportProps) {
  const [showUiOverlay, setShowUiOverlay] = useState(true);
  const showUiOverlayRef = useRef(showUiOverlay);
  showUiOverlayRef.current = showUiOverlay;

  const currentFrameRef = useRef(currentFrame);
  currentFrameRef.current = currentFrame;
  const totalFramesRef = useRef(totalFrames);
  totalFramesRef.current = totalFrames;
  const onFrameChangeRef = useRef(onFrameChange);
  onFrameChangeRef.current = onFrameChange;

  /** Ties the timeline to the render clock while playing — see playhead.ts. */
  const playheadRef = useRef<PlayheadState>(IDLE_PLAYHEAD);

  // Set by captureFrame(), read (and cleared) by the very next tick() —
  // see ViewportExportHandle's own doc comment above.
  const pendingCaptureRef = useRef<{
    frameIndex: number;
    fps: number;
    resolve: () => void;
    /** Ticks this frame has been held waiting on HUD image decodes. */
    waited?: number;
  } | null>(null);
  const onEvaluatedResultsRef = useRef(onEvaluatedResults);
  onEvaluatedResultsRef.current = onEvaluatedResults;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  // One evaluator session per mounted viewport — see EvalContext.sessionId.
  const sessionIdRef = useRef<string>("");
  if (!sessionIdRef.current) {
    sessionIdRef.current = `viewport-${nextSessionOrdinal++}`;
  }

  const [showEnvInEditor, setShowEnvInEditor] = useState(Boolean(mode2D));
  const showEnvInEditorRef = useRef(showEnvInEditor);
  showEnvInEditorRef.current = showEnvInEditor;

  const [isCameraView, setIsCameraView] = useState(Boolean(cameraView));
  const isCameraViewRef = useRef(isCameraView);
  isCameraViewRef.current = isCameraView;

  useEffect(() => {
    setIsCameraView(Boolean(cameraView));
  }, [cameraView]);

  const [lockCameraToView, setLockCameraToView] = useState(false);
  const lockCameraToViewRef = useRef(lockCameraToView);
  lockCameraToViewRef.current = lockCameraToView;

  const [hubElements, setHubElements] = useState<HubElement[]>([]);
  const hubSigRef = useRef<string>("");
  // The render node's output resolution — HUD elements are positioned in these
  // pixels. Non-null means a render node exists (which enables the HUD).
  const [renderSize, setRenderSize] = useState<{ width: number; height: number } | null>(null);
  const renderSizeRef = useRef<{ width: number; height: number } | null>(null);
  // The on-screen rectangle the render frame occupies (viewport px). When the
  // output window's aspect doesn't match the render's, the frame is letterboxed
  // (see the scissor block in tick) and the HUD must live INSIDE that frame so
  // positions in render-pixels map exactly to the exported frame.
  const [renderFrame, setRenderFrame] = useState({ x: 0, y: 0, width: 1, height: 1 });
  const renderFrameRef = useRef({ x: 0, y: 0, width: 1, height: 1 });
  const renderFrameStateRef = useRef({ x: 0, y: 0, width: 1, height: 1 });
  // Whether the render node's holdout is on (blacks out the area outside the render frame).
  const holdoutRef = useRef(false);

  const hubDragRef = useRef<{
    mode: "move" | "rotate" | "size";
    startClientX: number;
    startClientY: number;
    originClientX: number;
    originClientY: number;
    baseX: number;
    baseY: number;
    baseRot: number;
    baseScale: number;
  } | null>(null);
  // Set once a drag actually moves the pointer — used to distinguish a real
  // drag from a plain click so a drag doesn't also trigger select.
  const hubDragMovedRef = useRef(false);

  const [marqueeBox, setMarqueeBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [gradientLine, setGradientLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  // Grease Pencil drawing state
  const onParamChangeRef = useRef(onParamChange);
  onParamChangeRef.current = onParamChange;
  const [internalGpTool, setInternalGpTool] = useState<GpToolMode>("pen");
  const gpTool = gpToolProp !== undefined ? gpToolProp : internalGpTool;
  const setGpTool = (action: React.SetStateAction<GpToolMode>) => {
    const next = typeof action === "function" ? action(gpTool) : action;
    setInternalGpTool(next);
    onGpToolChange?.(next);
  };
  const gpToolRef = useRef<GpToolMode>(gpTool);
  gpToolRef.current = gpTool;
  const [gpBrushType, setGpBrushType] = useState<GreaseBrushType>("ink_pen");
  const gpBrushTypeRef = useRef<GreaseBrushType>("ink_pen");
  gpBrushTypeRef.current = gpBrushType;
  const [gpSolidFill, setGpSolidFill] = useState<boolean>(false);
  const gpSolidFillRef = useRef<boolean>(false);
  gpSolidFillRef.current = gpSolidFill;
  const [isGpDrawing, setIsGpDrawing] = useState(false);
  const isGpDrawingRef = useRef(false);
  const [gpLivePreview, setGpLivePreview] = useState<{ screenX: number; screenY: number }[]>([]);
  const gpLivePreviewRef = useRef<{ screenX: number; screenY: number }[]>([]);
  const gpPrevPointerRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const gpActivePointsRef = useRef<StrokePoint[]>([]);
  const gpShiftAtStartRef = useRef(false);
  const gpCtrlAtStartRef = useRef(false);
  const gpPressureModifierRef = useRef(1.0);
  const gpWorkingFramesRef = useRef<KeyframeDrawing[] | null>(null);
  const gpSmoothedWorldPosRef = useRef<THREE.Vector3 | null>(null);

  const snapSelectedCameraToEditorRef = useRef<() => void>(() => {});
  const cameraGuideRef = useRef<HTMLDivElement>(null);

  // Drives the 2D HUD gizmo: window-level pointermove/up translate a drag on a
  // selected hub element into x/y (move) or rotation (rotate) patches.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = hubDragRef.current;
      const nodeId = selectedNodeIdRef.current;
      if (!drag || !nodeId || !onHubChange || !hostRef.current) return;
      const frame = renderFrameRef.current;
      const rs = renderSizeRef.current;
      if (!rs) return;
      if (drag.mode === "move") {
        hubDragMovedRef.current = true;
        // Pointer delta in viewport px, scaled to the render-node resolution
        // through the actual frame (so a letterboxed output stays precise).
        const nx = drag.baseX + ((e.clientX - drag.startClientX) / frame.width) * rs.width;
        const ny = drag.baseY + ((e.clientY - drag.startClientY) / frame.height) * rs.height;
        onHubChange(nodeId, { x: nx, y: ny });
      } else if (drag.mode === "rotate") {
        const angle = Math.atan2(e.clientY - drag.originClientY, e.clientX - drag.originClientX) * (180 / Math.PI);
        const startAngle = Math.atan2(drag.startClientY - drag.originClientY, drag.startClientX - drag.originClientX) * (180 / Math.PI);
        const rot = (drag.baseRot + angle - startAngle + 360) % 360;
        onHubChange(nodeId, { rotation: rot });
      } else {
        const ns = Math.max(0.05, Math.min(4, drag.baseScale + (e.clientX - drag.startClientX) / 200));
        onHubChange(nodeId, { scale: ns });
      }
    };
    const onUp = () => {
      hubDragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [onHubChange]);

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

      // Plain Tab only — Shift+Tab (cycling Viewport/Split/Camera/Graph) is
      // handled globally in App.tsx now, not here, since one of those four
      // states (full-canvas Graph) unmounts every Viewport instance and a
      // listener that lives inside one can't fire once none are mounted.
      if ((e.key === "Tab" || e.code === "Tab") && !e.shiftKey) {
        e.preventDefault();
        setShowUiOverlay((prev) => !prev);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const hostRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const registryRef = useRef(registry);
  registryRef.current = registry;
  const renderNodeIdRef = useRef(renderNodeId);
  renderNodeIdRef.current = renderNodeId;
  const resetCameraRef = useRef<() => void>(() => {});
  const setAxisViewRef = useRef<(axis: "x" | "y" | "z", sign: 1 | -1) => void>(() => {});
  /** Which side each axis button last snapped to, so clicking it again flips to the opposite view (Left <-> Right, and so on). */
  const axisSideRef = useRef<Record<"x" | "y" | "z", 1 | -1>>({ x: -1, y: 1, z: 1 });
  const resetSimulationRef = useRef<() => void>(() => {});
  /** Snaps the orbit target + distance to frame a given node's object — see the selectedNodeId auto-focus effect below. */
  const focusOnNodeRef = useRef<(nodeId: string) => void>(() => {});
  /** Refreshed every tick() with that frame's evaluation results, so the focus effect (which runs on React's own schedule, not the render loop) can look up whatever a given node's own evaluate() produced — see focusOnNodeRef. */
  const latestResultsRef = useRef<EvalResult | null>(null);
  const selectedNodeIdRef = useRef(selectedNodeId);
  selectedNodeIdRef.current = selectedNodeId;
  const onSelectNodeRef = useRef(onSelectNode);
  onSelectNodeRef.current = onSelectNode;
  const onTransformChangeRef = useRef(onTransformChange);
  onTransformChangeRef.current = onTransformChange;
  const onTransformStartRef = useRef(onTransformStart);
  onTransformStartRef.current = onTransformStart;
  const onCameraChangeRef = useRef(onCameraChange);
  onCameraChangeRef.current = onCameraChange;
  const previewCameraPoseRef = useRef(previewCameraPose);
  previewCameraPoseRef.current = previewCameraPose;
  const [internalTransformMode, setInternalTransformMode] = useState<TransformGizmoMode>("translate");
  const transformMode = transformModeProp !== undefined ? transformModeProp : internalTransformMode;
  const setTransformMode = (action: React.SetStateAction<TransformGizmoMode>) => {
    const next = typeof action === "function" ? action(transformMode) : action;
    setInternalTransformMode(next);
    onTransformModeChange?.(next);
  };
  const transformModeRef = useRef(transformMode);
  transformModeRef.current = transformMode;

  const [isOrthographic, setIsOrthographic] = useState(false);
  const isOrthographicRef = useRef(isOrthographic);
  isOrthographicRef.current = isOrthographic;
  const toggleCameraModeRef = useRef<(isOrtho: boolean) => void>(() => {});
  const [isAxisView, setIsAxisView] = useState(false);
  const isAxisViewRef = useRef(false);
  const [isViewLocked, setIsViewLocked] = useState(false);
  const isViewLockedRef = useRef(false);
  const setViewLockRef = useRef<(locked: boolean) => void>(() => {});
  const setIsIsometricElevationRef = useRef<() => void>(() => {});

  useEffect(() => {
    toggleCameraModeRef.current(isOrthographic);
  }, [isOrthographic]);

  const prevMode2DRef = useRef(mode2D);
  useEffect(() => {
    if (mode2D) {
      setShowEnvInEditor(true);
      showEnvInEditorRef.current = true;
      setAxisViewRef.current?.("y", 1);
      setViewLockRef.current?.(true);
      setIsViewLocked(true);
    } else if (prevMode2DRef.current) {
      // Returning from 2D mode to 3D mode:
      // 1. unlock view
      setViewLockRef.current?.(false);
      setIsViewLocked(false);
      setLockCameraToView(false);
      setIsCameraView(false);
      isAxisViewRef.current = false;
      setIsAxisView(false);
      // 2. toggle environnement OFF
      setShowEnvInEditor(false);
      showEnvInEditorRef.current = false;
      // 3. Reset 3D camera view
      setIsOrthographic(false);
      resetCameraRef.current?.();
    } else if (elevationView) {
      setIsIsometricElevationRef.current?.();
      setViewLockRef.current?.(false);
      setIsViewLocked(false);
    }
    prevMode2DRef.current = mode2D;
  }, [mode2D, elevationView]);

  const toggleViewLock = () => {
    setIsViewLocked((prev) => {
      const next = !prev;
      isViewLockedRef.current = next;
      setViewLockRef.current(next);
      return next;
    });
  };

  useEffect(() => {
    if (!hostRef.current) return;
    const host: HTMLDivElement = hostRef.current;

    // stencil: true — three.js leaves this off by default; the Clip Box /
    // Visual Slice "solid cap" draws (clipCaps.ts) need a real stencil buffer
    // or their stencil ops are silent no-ops and no cap ever appears.
    const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
    // The native app can afford 2x on a retina display; the browser build is
    // CPU/GPU-bound, so cap it lower there — a big fill-rate saving on a 2x
    // display (4x pixels → 2.25x at 1.5) for a barely perceptible softness.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, isTauri() ? 2 : 1.5));
    renderer.autoClear = false;
    renderer.shadowMap.enabled = true;
    // PCFSoftShadowMap is deprecated as of three r180 and three itself
    // silently falls back to PCFShadowMap (with a console warning every
    // renderer construction) — asking for it directly gets the exact same
    // shadows with no warning.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    host.appendChild(renderer.domElement);

    // Composite canvas for video export: the WebGL frame + the 2D HUD overlay,
    // since MediaRecorder can only capture a canvas, not the CSS HUD.
    const exportCanvas = document.createElement("canvas");
    const exportCtx = exportCanvas.getContext("2d");

    const viewportBackground = createViewportBackground();
    const scene = new THREE.Scene();
    const bgScene = new THREE.Scene();
    bgScene.background = viewportBackground;
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
    scene.add(ambientLight);
    const sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
    sunLight.position.set(3, 5, 4);
    scene.add(sunLight);

    // Editor UI Overlay Scene — holds grid, transform controls, light helpers outside of main postprocess pipeline
    const editorUiScene = new THREE.Scene();
    let gridAndAxes: THREE.Group | null = null;

    // Grid & Origin Axes Helper — editor-only, never baked into the projected output
    if (!outputMode) {
      gridAndAxes = buildMainSceneGridAndAxes();
      editorUiScene.add(gridAndAxes);
    }
    const elevationHUD = createElevationHUD();
    editorUiScene.add(elevationHUD.group);

    const perspectiveCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    perspectiveCamera.position.set(3, 3, 5);
    perspectiveCamera.lookAt(0, 0, 0);

    const orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    orthographicCamera.position.set(3, 3, 5);
    orthographicCamera.lookAt(0, 0, 0);

    let activeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera = isOrthographic
      ? orthographicCamera
      : perspectiveCamera;
    let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = activeCamera;

    // Publish this pane as a pointer target, so the Mouse node can unproject
    // the cursor through the camera actually rendering it — the graph's
    // Camera-node pose is null whenever the pane is being flown by this
    // editor camera, which is most of the time. See pointerStore.ts.
    const unregisterPointerViewport = registerPointerViewport({
      element: renderer.domElement,
      getCamera: () => camera,
    });

    const composer = new EffectComposer(renderer);
    const renderPass = new RenderPass(scene, activeCamera);
    const outputPass = new OutputPass();
    composer.addPass(renderPass);
    composer.addPass(outputPass);

    const controls = new OrbitControls(activeCamera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    toggleCameraModeRef.current = (isOrtho: boolean) => {
      const nextCam = isOrtho ? orthographicCamera : perspectiveCamera;
      const prevCam = isOrtho ? perspectiveCamera : orthographicCamera;

      nextCam.position.copy(prevCam.position);
      nextCam.quaternion.copy(prevCam.quaternion);
      nextCam.up.copy(prevCam.up);

      const { clientWidth, clientHeight } = host;
      const aspect = clientWidth && clientHeight ? clientWidth / clientHeight : 1;

      if (isOrtho) {
        const d = nextCam.position.distanceTo(controls.target) || 5;
        const fovRad = THREE.MathUtils.degToRad(perspectiveCamera.fov);
        const halfHeight = Math.tan(fovRad / 2) * d;
        const halfWidth = halfHeight * aspect;
        orthographicCamera.left = -halfWidth;
        orthographicCamera.right = halfWidth;
        orthographicCamera.top = halfHeight;
        orthographicCamera.bottom = -halfHeight;
        orthographicCamera.updateProjectionMatrix();
      } else {
        perspectiveCamera.aspect = aspect;
        perspectiveCamera.updateProjectionMatrix();
      }

      activeCamera = nextCam;
      camera = activeCamera;
      controls.object = camera;
      renderPass.camera = camera;
      if (transformControls) transformControls.camera = camera;
      controls.update();
    };

    resetCameraRef.current = () => {
      perspectiveCamera.position.set(3, 3, 5);
      perspectiveCamera.up.set(0, 1, 0);
      perspectiveCamera.lookAt(0, 0, 0);

      orthographicCamera.position.set(3, 3, 5);
      orthographicCamera.up.set(0, 1, 0);
      orthographicCamera.lookAt(0, 0, 0);

      controls.target.set(0, 0, 0);
      controls.update();
      // Reset leaves the fixed axis view and releases the lock.
      isAxisSnapped = false;
      setViewLockRef.current(false);
      setIsViewLocked(false);
      isAxisViewRef.current = false;
      setIsAxisView(false);
    };

    /**
     * Frames a node's object: pans the orbit target to its bounding-sphere
     * center and dollies to a distance that fits it comfortably, keeping the
     * current viewing *direction* (same reasoning as setAxisViewRef above —
     * reframe what's already being looked at, don't reset the angle).
     * Damping (already enabled on `controls`) smooths the jump over the next
     * few frames on its own; no manual animation needed.
     */
    focusOnNodeRef.current = (nodeId: string) => {
      // Not every node with a selectable transform is a scene *root* (most
      // aren't — a Box feeding a Render is one link in a chain, not an entry
      // in sceneRoots' output map), so this reads the node's own evaluate()
      // record instead and takes whichever output happens to be an
      // Object3D — the one thing every geometry/light/camera/Empty node's
      // result has in common, regardless of which key it's under.
      const nodeResult = latestResultsRef.current?.get(nodeId);
      const object = nodeResult && (Object.values(nodeResult).find((v) => v instanceof THREE.Object3D) as THREE.Object3D | undefined);
      if (!object) return;

      const box = new THREE.Box3().setFromObject(object);
      const center = box.isEmpty() ? object.getWorldPosition(new THREE.Vector3()) : box.getCenter(new THREE.Vector3());
      const radius = box.isEmpty() ? 0 : box.getSize(new THREE.Vector3()).length() / 2;
      const comfortableRadius = Math.max(radius, 0.75);

      const direction = activeCamera.position.clone().sub(controls.target).normalize();
      if (direction.lengthSq() === 0) direction.set(0.6, 0.6, 1).normalize();

      const fovRad = THREE.MathUtils.degToRad(perspectiveCamera.fov);
      const distance = (comfortableRadius / Math.sin(fovRad / 2)) * 1.4;

      perspectiveCamera.position.copy(center).addScaledVector(direction, distance);
      perspectiveCamera.lookAt(center);
      orthographicCamera.position.copy(center).addScaledVector(direction, distance);
      orthographicCamera.lookAt(center);

      if (activeCamera === orthographicCamera) {
        const { clientWidth, clientHeight } = host;
        const aspect = clientWidth && clientHeight ? clientWidth / clientHeight : 1;
        const halfHeight = Math.tan(fovRad / 2) * distance;
        const halfWidth = halfHeight * aspect;
        orthographicCamera.left = -halfWidth;
        orthographicCamera.right = halfWidth;
        orthographicCamera.top = halfHeight;
        orthographicCamera.bottom = -halfHeight;
        orthographicCamera.updateProjectionMatrix();
      }

      controls.target.copy(center);
      controls.update();
    };

    // While the view is locked, orbit is disabled so the user can work
    // serenely in the fixed axis view. The component toggle reaches the
    // controls through this ref (they live in this mount-only closure).
    setViewLockRef.current = (locked: boolean) => {
      isViewLockedRef.current = locked;
      controls.enableRotate = !locked;
    };

    let isAxisSnapped = false;

    /**
     * Snaps to an axis-aligned view, the way Blender's numpad views work.
     * Keeps the current orbit target and distance, so it reframes what you
     * were already looking at instead of jumping back to the origin.
     */
    setAxisViewRef.current = (axis, sign) => {
      isAxisSnapped = true;
      isAxisViewRef.current = true;
      setIsAxisView(true);
      const target = controls.target.clone();
      const distance = activeCamera.position.distanceTo(target) || 5;
      const direction = new THREE.Vector3(
        axis === "x" ? sign : 0,
        axis === "y" ? sign : 0,
        axis === "z" ? sign : 0,
      );
      const upVector = new THREE.Vector3(0, axis === "y" ? 0 : 1, axis === "y" ? -sign : 0);

      perspectiveCamera.up.copy(upVector);
      perspectiveCamera.position.copy(target).addScaledVector(direction, distance);
      perspectiveCamera.lookAt(target);

      orthographicCamera.up.copy(upVector);
      orthographicCamera.position.copy(target).addScaledVector(direction, distance);
      orthographicCamera.lookAt(target);

      setIsOrthographic(true);
      controls.update();
    };

    setIsIsometricElevationRef.current = () => {
      isAxisSnapped = false;
      isAxisViewRef.current = false;
      setIsAxisView(false);
      const target = controls.target.clone();
      const distance = 35;
      const direction = new THREE.Vector3(1, 1, 1).normalize();
      const upVector = new THREE.Vector3(0, 1, 0);

      perspectiveCamera.up.copy(upVector);
      perspectiveCamera.position.copy(target).addScaledVector(direction, distance);
      perspectiveCamera.lookAt(target);

      orthographicCamera.up.copy(upVector);
      orthographicCamera.position.copy(target).addScaledVector(direction, distance);
      orthographicCamera.lookAt(target);

      setIsOrthographic(true);
      controls.enableRotate = true;
      controls.update();
    };

    function emitCameraPose() {
      onCameraChangeRef.current?.({
        position: [activeCamera.position.x, activeCamera.position.y, activeCamera.position.z],
        quaternion: [activeCamera.quaternion.x, activeCamera.quaternion.y, activeCamera.quaternion.z, activeCamera.quaternion.w],
      });
      if (lockCameraToViewRef.current) {
        snapSelectedCameraToEditorRef.current?.();
      }
    }

    const handleOrbitStart = () => {
      // While locked, orbit can't even start (enableRotate is off) and pan/
      // zoom don't break the axis alignment — so they must not exit the
      // fixed view either. Only an unlocked orbit returns to perspective.
      if (isViewLockedRef.current) return;
      if (isAxisSnapped) {
        isAxisSnapped = false;
        isAxisViewRef.current = false;
        setIsAxisView(false);
        setIsOrthographic(false);
      }
    };

    if (!outputMode) {
      controls.addEventListener("start", handleOrbitStart);
      controls.addEventListener("change", emitCameraPose);
      emitCameraPose();
    }

    const gizmo = outputMode ? null : createGizmoScene();

    const raycaster = outputMode ? null : new THREE.Raycaster();
    const transformControls = outputMode ? null : new TransformControls(activeCamera, renderer.domElement);
    transformControls?.setColors(GIZMO_X_COLOR, GIZMO_Y_COLOR, GIZMO_Z_COLOR, GIZMO_ACTIVE_COLOR);
    let attachedObjectNodeId: string | null = null;
    let attachedGizmoTarget: GizmoTarget | null = null;

    // Curve control-point editing. `selectedPointIndices` holds the active
    // selection of control points (single or multiple via marquee/shift).
    // The gizmo belongs to the selected object when empty, and attaches to
    // the picked handle or multi-point centroid when non-empty.
    const curveHandles = createCurvePointHandles();
    let curvePointsNodeId: string | null = null;
    let selectedPointIndices = new Set<number>();
    let isMarqueeDragging = false;
    let marqueeStartPos: { x: number; y: number } | null = null;

    let dragStartCentroidPos = new THREE.Vector3();
    let dragStartCentroidQuat = new THREE.Quaternion();
    let dragStartCentroidScale = new THREE.Vector3(1, 1, 1);
    let dragStartPointPositions = new Map<number, THREE.Vector3>();

    // Points Selection editing — click/marquee-select a subset of a live
    // Points list (e.g. from Mesh to Points) in the viewport, no dragging:
    // this only ever writes `selectedIndices` back onto the selected Points
    // Selection node, immediately on click/marquee-release (curve points
    // write back on gizmo-release instead, since those actually move).
    // Parallel to, and mutually exclusive with, curve editing above — the
    // two share the marquee overlay and the click/drag-distance heuristic
    // but never both have handles active at once (only one node can be
    // selected in the graph at a time).
    //
    // Point *cloud* handles, not curve handles: these track a mesh's whole
    // vertex buffer, which is a scale curve handles' one-Mesh-per-point
    // design cannot survive (see pointCloudHandles.ts).
    const pointsSelectionHandles = createPointCloudHandles();
    let pointsSelectionNodeId: string | null = null;
    let selectedPointsSelectionIndices = new Set<number>();

    // Face Selection editing — Shift+left-click selects the face under the
    // cursor on the mesh feeding the selected Face Selection node, Shift+right
    // deselects it; the selected faces are drawn green by faceSelectionHandles.
    // The picked indices live in the node's `selectedFaces` param (same
    // save/undo-friendly convention as Points Selection's `selectedIndices`).
    const faceSelectionHandles = createFaceSelectionHandles();
    let faceSelectionNodeId: string | null = null;
    let faceSelectionSourceNodeId: string | null = null;
    let selectedFacesSet = new Set<number>();
    /**
     * Whether the node is in interactive mode, tracked locally as well as in
     * the param so the first click switches the highlight over immediately —
     * the param only comes back a frame later, through React.
     */
    let faceSelectionInteractive = false;
    /**
     * The `selectedFaces` param as this viewport last saw it. Re-seeding the
     * working set whenever the param differs is what lets an undo (or the
     * operator clearing the field) actually take effect: without it the stale
     * local set would silently re-commit itself on the very next click.
     */
    let lastCommittedFaceKey = "";

    // Points Influence editing — same generic point-cloud handles again, this
    // time colored as a heatmap of a graded 0-1 influence instead of a
    // binary selected/unselected. Three gestures write into the same
    // `influences` param map, every one of them gated behind Cmd/Ctrl (a
    // plain drag always stays camera orbit, same convention as curve/Points
    // Selection marquee):
    // - Brush: Cmd+drag paints continuously, falloff from the cursor, capped
    //   at whichever of the 5 HUD levels is armed — see isBrushPainting.
    // - Discrete: Cmd-click/marquee assigns the armed level flat, no falloff.
    // - Gradient: one Cmd-drag sets a straight-line projection over every
    //   point at once (1 at the start, 0 at the end) — see isGradientDragging.
    // Mutually exclusive with curve/Points Selection editing by the same
    // "only one node selected at a time" construction.
    const pointsInfluenceHandles = createPointCloudHandles();
    let pointsInfluenceNodeId: string | null = null;
    let pointsInfluenceMode: PointsInfluenceMode = "brush";
    let pointsInfluenceMap = new Map<number, number>();
    let isBrushPainting = false;
    let isGradientDragging = false;
    let gradientStartPos: { x: number; y: number } | null = null;

    // A Pivot Transform node's `pivot` isn't a pose you can drag through the
    // usual translate/rotate/scale gizmo math (see gizmoWriteback.ts): with
    // rotation/scale/location all neutral, the pivot cancels out of its own
    // matrix entirely (translate(pivot) * identity * translate(-pivot) =
    // identity) — dragging the object it feeds wouldn't move anything on
    // screen no matter what pivot was written. It needs its own visible,
    // independently-draggable point, so it reuses the exact same
    // single-marker machinery curve control points use, just for one point
    // instead of a polyline (see the sync() call for it below).
    const pivotHandle = createCurvePointHandles();
    let pivotHandleNodeId: string | null = null;

    // Visual Slice's plane isn't a mesh's pose — it has no location/
    // rotation/scale of its own for resolveGizmoTarget's "native" case to
    // find (its own `geometry` output is just the upstream mesh passed
    // through untouched, clipped). It gets the same "own draggable proxy,
    // not the normal gizmo" treatment as Pivot Transform's pivot marker
    // above, except this one needs full translate *and* rotate (a plane is
    // a point plus a normal direction), so it rides the real
    // TransformControls via the pickedCurveHandle path below rather than
    // pivotHandle's position-only marker. A translucent quad, rather than
    // pivotHandle's bare point, so the plane's current orientation is
    // visible before you start dragging it.
    const SLICE_NORMAL_AXIS = new THREE.Vector3(0, 1, 0); // matches DEFAULT_NORMAL in visualSlice.ts
    const sliceProxy = new THREE.Object3D();
    const sliceVisualGeometry = new THREE.PlaneGeometry(3, 3);
    const sliceVisual = new THREE.Mesh(
      sliceVisualGeometry,
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
    );
    // PlaneGeometry faces +Z by default; rotate so the *unrotated* proxy
    // faces +Y, matching DEFAULT_NORMAL — then sliceProxy.quaternion alone
    // (set from SLICE_NORMAL_AXIS -> the plane's actual normal below) is the
    // complete story of the visual's orientation.
    sliceVisual.rotation.x = -Math.PI / 2;
    const sliceVisualEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(sliceVisualGeometry),
      new THREE.LineBasicMaterial({ color: 0x38bdf8 }),
    );
    sliceVisualEdges.rotation.copy(sliceVisual.rotation);
    sliceProxy.add(sliceVisual, sliceVisualEdges);
    sliceProxy.visible = false;
    let sliceProxyNodeId: string | null = null;

    // Clip Box's proxy — the same story as sliceProxy, one dimension up. The
    // cut is a whole oriented volume rather than a plane, so this one also
    // takes the gizmo's *scale* mode (writing the node's Box Size), and it
    // draws as a wireframe: six translucent faces stacked in depth read as
    // fog, while the edges show exactly where the volume starts and stops.
    const clipBoxProxy = new THREE.Object3D();
    const clipBoxGeometry = new THREE.BoxGeometry(1, 1, 1);
    const clipBoxVisual = new THREE.Mesh(
      clipBoxGeometry,
      new THREE.MeshBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false }),
    );
    const clipBoxEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(clipBoxGeometry),
      new THREE.LineBasicMaterial({ color: 0xf59e0b }),
    );
    clipBoxProxy.add(clipBoxVisual, clipBoxEdges);
    clipBoxProxy.visible = false;
    let clipBoxProxyNodeId: string | null = null;

    // Decal's projector box — the same proxy idea again. A decal's own output
    // is world-space geometry sitting at the origin, so the normal gizmo path
    // would put the handles nowhere near the thing being aimed; this shows the
    // projector volume where it actually is and drags its params instead.
    const decalProxy = new THREE.Object3D();
    const decalProxyGeometry = new THREE.BoxGeometry(1, 1, 1);
    const decalProxyEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(decalProxyGeometry),
      new THREE.LineBasicMaterial({ color: 0x4ade80 }),
    );
    // A single filled face marks which way the projector points: the box alone
    // is symmetrical, and aiming it is the whole job.
    const decalProxyFace = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
    );
    decalProxyFace.position.z = 0.5;
    decalProxy.add(decalProxyEdges, decalProxyFace);
    decalProxy.visible = false;
    let decalProxyNodeId: string | null = null;

    // Force Field 3D proxy: shows interactive position & direction helper for particles/force-field
    const forceFieldProxy = new THREE.Object3D();
    const forceFieldCoreGeo = new THREE.SphereGeometry(0.18, 16, 16);
    const forceFieldCoreMat = new THREE.MeshBasicMaterial({ color: 0xec4899, depthWrite: false });
    const forceFieldCore = new THREE.Mesh(forceFieldCoreGeo, forceFieldCoreMat);
    const forceFieldRingGeo = new THREE.RingGeometry(0.4, 0.45, 32);
    const forceFieldRingMat = new THREE.MeshBasicMaterial({ color: 0xec4899, side: THREE.DoubleSide, depthWrite: false });
    const forceFieldRing1 = new THREE.Mesh(forceFieldRingGeo, forceFieldRingMat);
    forceFieldRing1.rotation.x = Math.PI / 2;
    const forceFieldRing2 = new THREE.Mesh(forceFieldRingGeo, forceFieldRingMat);
    forceFieldRing2.rotation.y = Math.PI / 2;
    const forceFieldArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), 1.2, 0xec4899, 0.3, 0.15);
    forceFieldProxy.add(forceFieldCore, forceFieldRing1, forceFieldRing2, forceFieldArrow);
    forceFieldProxy.visible = false;
    let forceFieldProxyNodeId: string | null = null;

    // Particle Emitter proxy: translate moves position, rotate directs velocity
    const emitterProxy = new THREE.Object3D();
    const emitterCoreGeo = new THREE.SphereGeometry(0.18, 16, 16);
    const emitterCoreMat = new THREE.MeshBasicMaterial({ color: 0x06b6d4, depthWrite: false });
    const emitterCore = new THREE.Mesh(emitterCoreGeo, emitterCoreMat);
    const emitterRingGeo = new THREE.RingGeometry(0.35, 0.4, 32);
    const emitterRingMat = new THREE.MeshBasicMaterial({ color: 0x06b6d4, side: THREE.DoubleSide, depthWrite: false });
    const emitterRing = new THREE.Mesh(emitterRingGeo, emitterRingMat);
    emitterRing.rotation.x = Math.PI / 2;
    const emitterArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), 1.0, 0x06b6d4, 0.25, 0.12);
    emitterProxy.add(emitterCore, emitterRing, emitterArrow);
    emitterProxy.visible = false;
    let emitterProxyNodeId: string | null = null;
    let emitterVelocityLength = 1;

    // Pivot proxy for native objects: anchors TransformControls directly on the pivot point
    const gizmoPivotProxy = new THREE.Object3D();
    gizmoPivotProxy.visible = false;
    let gizmoPivotProxyNodeId: string | null = null;
    let gizmoPivotProxyRealObject: THREE.Object3D | null = null;

    // Yellow Pivot Cross Helper: displayed above geometry (depthTest: false) for objects with showPivot === true
    const pivotCrossGroup = new THREE.Group();
    const PIVOT_CROSS_SIZE = 0.35;
    const pivotCrossPositions = new Float32Array([
      -PIVOT_CROSS_SIZE, 0, 0,  PIVOT_CROSS_SIZE, 0, 0,
      0, -PIVOT_CROSS_SIZE, 0,  0, PIVOT_CROSS_SIZE, 0,
      0, 0, -PIVOT_CROSS_SIZE,  0, 0, PIVOT_CROSS_SIZE,
    ]);
    const pivotCrossGeo = new THREE.BufferGeometry();
    pivotCrossGeo.setAttribute("position", new THREE.BufferAttribute(pivotCrossPositions, 3));
    const pivotCrossMat = new THREE.LineBasicMaterial({
      color: 0xffe600,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    const pivotCrossPool: THREE.LineSegments[] = [];

    if (!outputMode) {
      editorUiScene.add(curveHandles.group);
      editorUiScene.add(pointsSelectionHandles.group);
      editorUiScene.add(pointsInfluenceHandles.group);
      editorUiScene.add(pivotHandle.group);
      editorUiScene.add(sliceProxy);
      editorUiScene.add(clipBoxProxy);
      editorUiScene.add(decalProxy);
      editorUiScene.add(forceFieldProxy);
      editorUiScene.add(emitterProxy);
      editorUiScene.add(gizmoPivotProxy);
      editorUiScene.add(pivotCrossGroup);
      // The face-selection highlight lives in the *main* scene (not the
      // editor overlay, which clears depth and would show every selected face
      // through the object) so it is occluded like the surface it sits on.
      // Empty when no Face Selection node is selected, so it never renders.
      scene.add(faceSelectionHandles.group);
    }
    // Refreshed every tick() — the 'objectChange' listener needs the
    // *current* base matrix for an "offset" target (see below), and this is
    // the cheapest way to get it without re-running evaluateGraph itself.
    let latestResults: EvalResult | null = null;
    // Tracks whether the postprocess chain was active last frame. When it goes
    // inactive we release the chain once; repeating that every idle frame would
    // destroy and re-compile all the cached passes on the next activation
    // (their render targets and shaders are expensive to rebuild).
    let postChainWasActive = false;

    // Hold Shift to snap the gizmo to fixed increments — 1 unit for
    // move/scale, 15° for rotate. Three's TransformControls has no built-in
    // modifier-key toggle; it just reads translationSnap/rotationSnap/
    // scaleSnap fresh on every pointermove (see its own source), so setting
    // them live on keydown/keyup is enough to make snapping track the key
    // in real time, including toggling mid-drag.
    const TRANSLATION_SNAP = 1;
    const ROTATION_SNAP = THREE.MathUtils.degToRad(15);
    const SCALE_SNAP = 1;

    // translationSnap is deliberately NEVER set on transformControls itself —
    // its world-space snap path calls object.getWorldPosition(), which goes
    // through updateWorldMatrix(). Every graph-driven mesh has
    // matrixAutoUpdate = false (see object.ts), which makes updateWorldMatrix
    // skip recomputing .matrix from the position TransformControls just set —
    // so it read back the *previous* frame's stale world position every time,
    // snapped that unchanging value, and wrote it straight back: the object
    // never appeared to move at all while translating with snap on. rotate's
    // snap (an internal angle accumulator) and scale's snap (mode='scale'
    // forces local space, a plain .scale round with no matrixWorld involved)
    // don't touch matrixWorld and so don't hit this — hence only translate
    // needed a workaround. Snapping translation ourselves, in objectChange
    // below, right before we call object.updateMatrix(), sidesteps the whole
    // stale-matrixWorld path: we round the position TransformControls *did*
    // just set correctly, not a stale re-derived one.
    let snapEnabled = false;

    function setSnapEnabled(enabled: boolean) {
      snapEnabled = enabled;
      if (!transformControls) return;
      transformControls.rotationSnap = enabled ? ROTATION_SNAP : null;
      transformControls.scaleSnap = enabled ? SCALE_SNAP : null;
    }

    function isInputElement(el: Element | null): boolean {
      if (!el) return false;
      const tagName = el.tagName.toLowerCase();
      return tagName === "input" || tagName === "textarea" || (el as HTMLElement).isContentEditable;
    }

    /**
     * Add or remove a control point on the curve whose handles are showing —
     * the only way to change how many points a curve has, since `pointsList`
     * has no param-panel field of its own. A no-op unless a handle is
     * actually picked, so A and D stay free for everything else.
     */
    function editPickedCurvePoint(operation: "insert" | "remove"): boolean {
      if (selectedPointIndices.size === 0 || !curvePointsNodeId) return false;
      const node = graphRef.current.nodes.find((n) => n.id === curvePointsNodeId);
      if (!node || !onTransformChangeRef.current) return false;
      // Fixed topology: every pointsList entry has to keep lining up with the
      // source mesh's own vertex index for writePointsToMesh's write-back to
      // mean anything — unlike a curve, there is no legal insert/remove here.
      if (node.type === EDIT_MESH_POINTS_NODE.type) return false;

      const index = Array.from(selectedPointIndices)[0];
      const nextPoints =
        operation === "insert"
          ? insertCurvePointAfter(node.params.pointsList, index)
          : removeCurvePoint(node.params.pointsList, index);
      // Null means the edit isn't legal — removing the last two points, say.
      if (!nextPoints) return false;

      // One discrete edit, one undo step (a drag records its own on start).
      onTransformStartRef.current?.();
      onTransformChangeRef.current(node.id, { pointsList: nextPoints });
      // Keep a point selected either way: the one just inserted, or the
      // neighbour that took the removed one's place.
      const newIdx = operation === "insert" ? index + 1 : Math.min(index, nextPoints.length - 1);
      selectedPointIndices = new Set([newIdx]);
      return true;
    }

    function onViewportKeyDown(e: KeyboardEvent) {
      if (isInputElement(document.activeElement)) return;

      // Blender-style shortcut: Ctrl+Alt+0 (or Cmd+Alt+0) to Align Active Camera to View
      if ((e.ctrlKey || e.metaKey) && e.altKey && (e.code === "Numpad0" || e.code === "Digit0" || e.key === "0")) {
        e.preventDefault();
        snapSelectedCameraToEditorRef.current?.();
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key.toLowerCase();

      // Curve control point editing — checked before the gizmo/camera keys so
      // they only take over while a point is picked.
      if (key === "a" && editPickedCurvePoint("insert")) {
        e.preventDefault();
        return;
      }
      if (key === "d" && editPickedCurvePoint("remove")) {
        e.preventDefault();
        return;
      }

      // Gizmo mode shortcuts: G (translate), R (rotate), S (scale)
      if (key === "g") {
        e.preventDefault();
        setTransformMode("translate");
        if (transformControls) transformControls.setMode("translate");
      } else if (key === "r") {
        e.preventDefault();
        setTransformMode("rotate");
        if (transformControls) transformControls.setMode("rotate");
      } else if (key === "s") {
        e.preventDefault();
        setTransformMode("scale");
        if (transformControls) transformControls.setMode("scale");
      }
      // Camera axis snapping shortcuts: X (Right), Y (Top), Z (Front)
      else if (key === "x") {
        e.preventDefault();
        setAxisViewRef.current?.("x", 1);
      } else if (key === "y") {
        e.preventDefault();
        setAxisViewRef.current?.("y", 1);
      } else if (key === "z") {
        e.preventDefault();
        setAxisViewRef.current?.("z", 1);
      } else if (key === "l" && isAxisViewRef.current) {
        // Lock the fixed axis view (toggle) — only meaningful in an X/Y/Z view.
        e.preventDefault();
        toggleViewLock();
      }
    }

    function onSnapKeyDown(e: KeyboardEvent) {
      if (e.key === "Shift") setSnapEnabled(true);
    }
    function onSnapKeyUp(e: KeyboardEvent) {
      if (e.key === "Shift") setSnapEnabled(false);
    }
    // Alt-tabbing away mid-drag fires no keyup for whatever was held — without
    // this, snapping could get stuck on until the next Shift press-and-release.
    function onSnapWindowBlur() {
      setSnapEnabled(false);
    }
    if (!outputMode) {
      window.addEventListener("keydown", onSnapKeyDown);
      window.addEventListener("keydown", onViewportKeyDown);
      window.addEventListener("keyup", onSnapKeyUp);
      window.addEventListener("blur", onSnapWindowBlur);
    }

    if (transformControls) {
      editorUiScene.add(transformControls.getHelper());

      // The textbook three.js idiom: disable orbit for the whole gesture the
      // instant a gizmo handle is grabbed, synchronously within the same
      // pointerdown dispatch OrbitControls itself is listening to — by the
      // time OrbitControls would act on a subsequent pointermove, `enabled`
      // is already false. tick()'s own loop (below) is what keeps it false
      // for the rest of the drag, since this only fires on state *changes*.
      transformControls.addEventListener("dragging-changed", (event) => {
        controls.enabled = !event.value;
        if (event.value) {
          onTransformStartRef.current?.();
          if (transformControls.object?.userData?.isCurveCentroidHandle) {
            const centroid = transformControls.object;
            dragStartCentroidPos.copy(centroid.position);
            dragStartCentroidQuat.copy(centroid.quaternion);
            dragStartCentroidScale.copy(centroid.scale);
            dragStartPointPositions.clear();
            const node = graphRef.current.nodes.find((n) => n.id === curvePointsNodeId);
            const rawList = Array.isArray(node?.params.pointsList) ? node!.params.pointsList : [];
            selectedPointIndices.forEach((idx) => {
              const handle = curveHandles.handleAt(idx);
              const pos = handle ? handle.position.clone() : asVector3(rawList[idx], new THREE.Vector3());
              dragStartPointPositions.set(idx, pos);
            });
          }
        }
        if (!event.value) suppressNextClick = true;
      });

      transformControls.addEventListener("objectChange", () => {
        const object = transformControls.object;
        if (!object) return;

        // Manual translation snap — see the comment by TRANSLATION_SNAP's
        // declaration for why this can't just be transformControls'
        // own translationSnap. .position here is what TransformControls'
        // translate math just set correctly this frame (a plain local
        // assignment, no matrixWorld involved) — rounding it directly, before
        // updateMatrix() below, is what makes the *displayed* mesh snap, not
        // just whatever eventually gets written back to the graph.
        if (snapEnabled && transformModeRef.current === "translate") {
          object.position.set(
            Math.round(object.position.x / TRANSLATION_SNAP) * TRANSLATION_SNAP,
            Math.round(object.position.y / TRANSLATION_SNAP) * TRANSLATION_SNAP,
            Math.round(object.position.z / TRANSLATION_SNAP) * TRANSLATION_SNAP,
          );
        } else if (elevationView && snapElevation && transformModeRef.current === "translate") {
          object.position.y = snapElevationValue(object.position.y, 0.5);
        }

        // object.ts sets matrixAutoUpdate = false on every graph-driven mesh
        // (so it can hold an exact matrix.copy() from the graph), which also
        // means nothing recomputes .matrix from position/quaternion/scale
        // automatically. TransformControls mutates those three directly but
        // never calls this itself — without it the drag was inert on
        // screen: the mesh only ever snapped to its new pose once dragging
        // ended and evaluateGraph's own matrix.copy() ran again next frame.
        object.updateMatrix();

        // The pivot marker drag: same "already in the right space" story as
        // a curve point (see below), just written to `pivot` on the Pivot
        // Transform node instead of a pointsList entry. Checked before the
        // generic isCurvePointHandle branch below — pivotHandle reuses the
        // same handle factory, so its one marker carries that same flag.
        if (object === pivotHandle.handleAt(0) && pivotHandleNodeId && onTransformChangeRef.current) {
          onTransformChangeRef.current(pivotHandleNodeId, { pivot: object.position.clone() });
          return;
        }

        // Visual Slice's plane proxy: translate moves `point`, rotate turns
        // `direction` (derived from the proxy's current orientation either
        // way, since only one of the two actually changed this drag).
        if (object === sliceProxy && sliceProxyNodeId && onTransformChangeRef.current) {
          const direction = SLICE_NORMAL_AXIS.clone().applyQuaternion(object.quaternion).normalize();
          onTransformChangeRef.current(sliceProxyNodeId, { point: object.position.clone(), direction });
          return;
        }

        // Clip Box's volume proxy: all three modes write back at once, since
        // only whichever one the drag actually changed differs from what the
        // params already hold. Scale is taken as an absolute — TransformControls
        // will happily drag an axis through zero into a negative, which would
        // flip the box inside out rather than shrink it.
        if (object === clipBoxProxy && clipBoxProxyNodeId && onTransformChangeRef.current) {
          const euler = new THREE.Euler().setFromQuaternion(object.quaternion);
          onTransformChangeRef.current(clipBoxProxyNodeId, {
            location: object.position.clone(),
            rotation: new THREE.Vector3(euler.x, euler.y, euler.z),
            size: new THREE.Vector3(Math.abs(object.scale.x), Math.abs(object.scale.y), Math.abs(object.scale.z)),
          });
          return;
        }

        // Decal's projector proxy: its pose *is* the projection, so all three
        // channels go back at once and the decal re-projects next evaluate.
        if (object === decalProxy && decalProxyNodeId && onTransformChangeRef.current) {
          const euler = new THREE.Euler().setFromQuaternion(object.quaternion);
          onTransformChangeRef.current(decalProxyNodeId, {
            location: object.position.clone(),
            rotation: new THREE.Vector3(euler.x, euler.y, euler.z),
            scale: new THREE.Vector3(Math.abs(object.scale.x), Math.abs(object.scale.y), Math.abs(object.scale.z)),
          });
          return;
        }

        // Force Field's 3D proxy: translate moves `position`, rotate turns `axis`
        if (object === forceFieldProxy && forceFieldProxyNodeId && onTransformChangeRef.current) {
          const direction = new THREE.Vector3(0, 1, 0).applyQuaternion(object.quaternion).normalize();
          onTransformChangeRef.current(forceFieldProxyNodeId, {
            position: object.position.clone(),
            axis: direction,
          });
          return;
        }

        // Particle Emitter's 3D proxy: translate moves `position`, rotate turns `velocity`
        if (object === emitterProxy && emitterProxyNodeId && onTransformChangeRef.current) {
          const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(object.quaternion).normalize();
          const newVelocity = dir.multiplyScalar(emitterVelocityLength);
          onTransformChangeRef.current(emitterProxyNodeId, {
            position: object.position.clone(),
            velocity: newVelocity,
          });
          return;
        }

        // Native object gizmo anchored directly at the pivot point
        if (object === gizmoPivotProxy && gizmoPivotProxyNodeId && gizmoPivotProxyRealObject && onTransformChangeRef.current) {
          const node = graphRef.current.nodes.find((n) => n.id === gizmoPivotProxyNodeId);
          const piv =
            gizmoPivotProxyRealObject.userData && gizmoPivotProxyRealObject.userData.pivot
              ? asVector3(gizmoPivotProxyRealObject.userData.pivot, new THREE.Vector3())
              : asVector3(node.params.pivot, new THREE.Vector3());
          const targetNodeId = gizmoPivotProxyNodeId;
          const deltaConn = graphRef.current.connections.find((c) => c.toNode === targetNodeId && c.toSocket === "matrix");
          const upstreamNodeId = deltaConn ? deltaConn.fromNode : null;
          const upstreamResult = upstreamNodeId ? latestResults?.get(upstreamNodeId)?.matrix : undefined;
          const upstream = upstreamResult instanceof THREE.Matrix4 ? upstreamResult : new THREE.Matrix4();
          const upstreamInv = upstream.clone().invert();

          const worldMatrix = new THREE.Matrix4().compose(gizmoPivotProxy.position, gizmoPivotProxy.quaternion, gizmoPivotProxy.scale);
          const parentMatrix = upstreamInv.clone().multiply(worldMatrix);

          const parentPos = new THREE.Vector3();
          const parentQuat = new THREE.Quaternion();
          const parentScale = new THREE.Vector3();
          parentMatrix.decompose(parentPos, parentQuat, parentScale);

          const solvedLocation = parentPos.clone().sub(piv);
          const euler = new THREE.Euler().setFromQuaternion(parentQuat);
          const solvedRotation = new THREE.Vector3(euler.x, euler.y, euler.z);
          const solvedScale = parentScale.clone();

          const wiredSockets = new Set(
            graphRef.current.connections.filter((c) => c.toNode === targetNodeId).map((c) => c.toSocket),
          );

          const patch: TransformPatch = {};
          if (transformModeRef.current === "translate" && !wiredSockets.has("location")) {
            if (elevationView && snapElevation) {
              solvedLocation.y = snapElevationValue(solvedLocation.y, 0.5);
            }
            patch.location = solvedLocation;
          }
          if (transformModeRef.current === "rotate" && !wiredSockets.has("rotation")) {
            patch.rotation = solvedRotation;
          }
          if (transformModeRef.current === "scale" && !wiredSockets.has("scale")) {
            patch.scale = solvedScale;
          }

          const loc = patch.location ?? asVector3(node.params.location, new THREE.Vector3());
          const rot = patch.rotation ?? asVector3(node.params.rotation, new THREE.Vector3());
          const scl = patch.scale ?? asVector3(node.params.scale, new THREE.Vector3(1, 1, 1));
          const localMatrix = composeNativeMatrixWithPivot(undefined, loc, rot, scl, piv, node.params);
          gizmoPivotProxyRealObject.matrix.multiplyMatrices(upstream, localMatrix);
          gizmoPivotProxyRealObject.updateMatrixWorld(true);

          if (Object.keys(patch).length > 0) {
            onTransformChangeRef.current(targetNodeId, patch);
          }
          return;
        }

        // A single curve control point drag: `object.position` is already
        // in the curve's own space (the handles' group carries the drawing
        // object's world matrix — see curveHandles.ts), which is exactly what
        // `pointsList` stores, so it goes back verbatim.
        if (object.userData?.isCurvePointHandle) {
          const pointIdx = object.userData.pointIndex as number;
          const node = graphRef.current.nodes.find((n) => n.id === curvePointsNodeId);
          if (!node || !onTransformChangeRef.current) return;
          const rawList = Array.isArray(node.params.pointsList) ? [...node.params.pointsList] : [];
          if (pointIdx < 0 || pointIdx >= rawList.length) return;
          // A mesh's stored points are raw vertex-buffer entries, so a corner
          // is several coincident ones — the drag has to carry all of them or
          // the mesh tears open along its seams (see applyWeldedPointMoves).
          if (node.type === EDIT_MESH_POINTS_NODE.type) {
            const welded = applyWeldedPointMoves(rawList, new Map([[pointIdx, object.position.clone()]]));
            onTransformChangeRef.current(node.id, { pointsList: welded });
            return;
          }
          // A lattice handle is drawn on the deformed cage, so where it was
          // dropped is not what `pointsList` stores — the base point that
          // lands there once the modulators run is. Storing the handle
          // position verbatim would bake the modulator in and then apply it
          // a second time on the next evaluation.
          rawList[pointIdx] =
            node.type === LATTICE_DEFORM_NODE.type
              ? latticeBasePointForTarget(node.params, pointIdx, object.position)
              : object.position.clone();
          onTransformChangeRef.current(node.id, { pointsList: rawList });
          return;
        }

        // Multi-point centroid drag: applies relative translation, rotation, and scaling
        // around the selection center to all selected control points simultaneously.
        if (object.userData?.isCurveCentroidHandle) {
          const node = graphRef.current.nodes.find((n) => n.id === curvePointsNodeId);
          if (!node || !onTransformChangeRef.current) return;
          const rawList = Array.isArray(node.params.pointsList) ? [...node.params.pointsList] : [];

          const deltaQuat = new THREE.Quaternion().copy(object.quaternion).multiply(dragStartCentroidQuat.clone().invert());
          const deltaScaleX = dragStartCentroidScale.x !== 0 ? object.scale.x / dragStartCentroidScale.x : 1;
          const deltaScaleY = dragStartCentroidScale.y !== 0 ? object.scale.y / dragStartCentroidScale.y : 1;
          const deltaScaleZ = dragStartCentroidScale.z !== 0 ? object.scale.z / dragStartCentroidScale.z : 1;

          // Collected rather than written straight into rawList, so the mesh
          // case below can weld coincident vertices against the *pre-drag*
          // positions — see applyWeldedPointMoves.
          const moves = new Map<number, THREE.Vector3>();
          for (const [idx, initialPos] of dragStartPointPositions.entries()) {
            if (idx < 0 || idx >= rawList.length) continue;
            const offset = new THREE.Vector3().subVectors(initialPos, dragStartCentroidPos);
            offset.x *= deltaScaleX;
            offset.y *= deltaScaleY;
            offset.z *= deltaScaleZ;
            offset.applyQuaternion(deltaQuat);
            const newPos = new THREE.Vector3().addVectors(object.position, offset);
            moves.set(idx, newPos);
            const handle = curveHandles.handleAt(idx);
            if (handle) handle.position.copy(newPos);
          }

          if (node.type === EDIT_MESH_POINTS_NODE.type) {
            onTransformChangeRef.current(node.id, { pointsList: applyWeldedPointMoves(rawList, moves) });
            return;
          }

          for (const [idx, newPos] of moves) {
            // Same deformed-cage conversion as the single-handle path above.
            rawList[idx] =
              node.type === LATTICE_DEFORM_NODE.type
                ? latticeBasePointForTarget(node.params, idx, newPos)
                : newPos;
          }

          onTransformChangeRef.current(node.id, { pointsList: rawList });
          return;
        }

        if (!attachedGizmoTarget || !onTransformChangeRef.current) return;

        // Which node id actually owns the params a drag writes into — the
        // upstream Transform/MatrixTransform for "absolute"/"offset", or the
        // object itself for "native" (see transformLookup.ts).
        const targetNodeId =
          attachedGizmoTarget.kind === "native" ? attachedGizmoTarget.objectNodeId : attachedGizmoTarget.transformNodeId;

        // What sits upstream of the pose being solved for: the base an
        // "offset" delta is applied on top of, or the delta a "native" base
        // is composed with. Null when nothing is wired, which each node's own
        // evaluate treats as identity.
        const upstreamNodeId =
          attachedGizmoTarget.kind === "offset"
            ? attachedGizmoTarget.baseSourceNodeId
            : attachedGizmoTarget.kind === "native"
              ? attachedGizmoTarget.deltaSourceNodeId
              : null;
        const upstreamResult = upstreamNodeId ? latestResults?.get(upstreamNodeId)?.matrix : undefined;

        const nodeForPivot = graphRef.current.nodes.find((n) => n.id === targetNodeId);
        const patch = computeGizmoWriteback({
          target: attachedGizmoTarget,
          mode: transformModeRef.current,
          object,
          upstreamMatrix: upstreamResult instanceof THREE.Matrix4 ? upstreamResult : null,
          wiredSockets: new Set(
            graphRef.current.connections.filter((c) => c.toNode === targetNodeId).map((c) => c.toSocket),
          ),
          pivot: nodeForPivot ? asVector3(nodeForPivot.params?.pivot, new THREE.Vector3()) : undefined,
        });

        if (elevationView && snapElevation && patch.location) {
          patch.location.y = snapElevationValue(patch.location.y, 0.5);
        }

        if (Object.keys(patch).length > 0) {
          onTransformChangeRef.current(targetNodeId, patch);
        }
      });
    }

    // Click vs orbit-drag: a pointerup that moved less than this, and wasn't
    // the tail end of a gizmo drag (see suppressNextClick above), counts as
    // a selection click.
    const CLICK_MOVE_THRESHOLD_PX = 6;
    let pointerDownAt: { x: number; y: number } | null = null;
    let suppressNextClick = false;

    // Points Selection has no drag/gizmo step to defer to — a click or a
    // marquee release IS the commit, immediately, unlike curve points which
    // write back only when a drag ends.
    function commitPointsSelection() {
      if (pointsSelectionNodeId && onTransformChangeRef.current) {
        onTransformChangeRef.current(pointsSelectionNodeId, { selectedIndices: Array.from(selectedPointsSelectionIndices) });
      }
    }

    function commitFaceSelection() {
      if (faceSelectionNodeId && onTransformChangeRef.current) {
        const faces = Array.from(selectedFacesSet).sort((a, b) => a - b);
        // Remember what we just wrote, so the graph update this triggers is
        // recognised as our own and doesn't re-seed the working set from
        // under the operator mid-edit (see lastCommittedFaceKey).
        lastCommittedFaceKey = faces.join(",");
        faceSelectionInteractive = true;
        onTransformChangeRef.current(faceSelectionNodeId, {
          selectedFaces: faces,
          interactive: true,
        });
      }
    }

    function commitPointsInfluence() {
      if (pointsInfluenceNodeId && onTransformChangeRef.current) {
        onTransformChangeRef.current(pointsInfluenceNodeId, { influences: Object.fromEntries(pointsInfluenceMap) });
      }
    }

    function getActiveInfluenceLevel(): number {
      const raw = graphRef.current.nodes.find((n) => n.id === pointsInfluenceNodeId)?.params.activeLevel;
      return typeof raw === "number" ? raw : POINTS_INFLUENCE_DISCRETE_LEVELS[2];
    }

    /** Falloff of a brush stroke centered at `centerPx`: `cap` (the armed preset level) at the center, 0 at the edge of brushRadius. */
    function paintInfluenceAt(centerPx: { x: number; y: number }, radiusPx: number, cap: number, erase: boolean) {
      const hits = pointsInfluenceHandles.pickCircle(centerPx, radiusPx, camera, renderer.domElement.clientWidth, renderer.domElement.clientHeight);
      if (hits.length === 0) return;
      for (const { index, distance } of hits) {
        const falloff = (1 - distance / radiusPx) * cap;
        if (erase) {
          const next = Math.max(0, (pointsInfluenceMap.get(index) ?? 0) - falloff);
          if (next <= 0) pointsInfluenceMap.delete(index);
          else pointsInfluenceMap.set(index, next);
        } else {
          const next = Math.max(pointsInfluenceMap.get(index) ?? 0, falloff);
          pointsInfluenceMap.set(index, next);
        }
      }
    }

    /**
     * Gradient tool: a single straight Cmd-drag sets every point's influence
     * to its own projection onto that line — 1 at the start, 0 at the end,
     * linear in between — a full-object dégradé (e.g. top-to-bottom) in one
     * stroke. Unlike Brush this REPLACES every point's value, including ones
     * the drag never came near (they resolve to 0 and drop out of the sparse
     * map), since a gradient is meant to redefine the whole field at once.
     */
    function applyGradientInfluence(start: { x: number; y: number }, end: { x: number; y: number }) {
      const rect = renderer.domElement.getBoundingClientRect();
      const projected = pointsInfluenceHandles.projectAll(camera, rect.width, rect.height);
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lenSq = dx * dx + dy * dy || 1;
      for (const { index, x, y } of projected) {
        const t = ((x - start.x) * dx + (y - start.y) * dy) / lenSq;
        const value = 1 - Math.max(0, Math.min(1, t));
        if (value <= 0) pointsInfluenceMap.delete(index);
        else pointsInfluenceMap.set(index, value);
      }
    }

    function onCanvasPointerDown(e: PointerEvent) {
      if (e.ctrlKey && !e.metaKey && e.button === 0) {
        try {
          Object.defineProperty(e, "ctrlKey", { get: () => false });
        } catch {
          // ignore
        }
      }

      pointerDownAt = { x: e.clientX, y: e.clientY };

      const isMarqueeModifier = e.metaKey;
      const infActive = pointsInfluenceHandles.count() > 0 && !outputMode;

      const gpNode = selectedNodeIdRef.current
        ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && isPaintOrGreaseNode(n))
        : null;

      const isDrawingOrModifying =
        gpToolRef.current === "pen" ||
        gpToolRef.current === "eraser_hard" ||
        gpToolRef.current === "eraser_soft" ||
        gpToolRef.current === "tint";

      if (gpNode && !outputMode && !elevationView && isDrawingOrModifying && e.button === 0 && !isMarqueeModifier && !e.altKey) {
        isGpDrawingRef.current = true;
        setIsGpDrawing(true);
        gpShiftAtStartRef.current = e.shiftKey || Boolean(e.getModifierState && e.getModifierState("Shift"));
        gpCtrlAtStartRef.current = Boolean(e.getModifierState && e.getModifierState("Control"));
        gpPressureModifierRef.current = gpShiftAtStartRef.current ? 0.45 : gpCtrlAtStartRef.current ? 1.75 : 1.0;
        controls.enabled = false;
        const rect = renderer.domElement.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        const now = performance.now();
        gpPrevPointerRef.current = { x: screenX, y: screenY, time: now };

        const ptData = resolvePointerPoint(
          e.clientX,
          e.clientY,
          gpNode,
          graphRef.current,
          latestResultsRef.current,
          camera,
          renderer.domElement,
          mode2D,
        );
        const worldPos = ptData?.pos ?? null;

        gpWorkingFramesRef.current = (gpNode.params.frames as KeyframeDrawing[]) || [];
        const bSize = Number(gpNode.params.brushSize) || 4;
        const toolRadius = Math.max(0.85, bSize * 0.1);

        if (worldPos) {
          const currentFrames = gpWorkingFramesRef.current;
          const targetFrame = currentFrameRef.current >= 0 ? currentFrameRef.current : 0;
          if (gpToolRef.current === "eraser_hard") {
            const erased = eraseStrokesAtPosition(currentFrames, targetFrame, worldPos, toolRadius);
            gpWorkingFramesRef.current = erased;
            onParamChangeRef.current?.("frames", erased, gpNode.id);
          } else if (gpToolRef.current === "eraser_soft") {
            const softErased = eraseStrokesSoft(currentFrames, targetFrame, worldPos, toolRadius, 0.3);
            gpWorkingFramesRef.current = softErased;
            onParamChangeRef.current?.("frames", softErased, gpNode.id);
          } else if (gpToolRef.current === "tint") {
            const activeColorHex = parseColorHex(gpNode.params.activeColor, "#38bdf8");
            const tinted = tintStrokesAtPosition(currentFrames, targetFrame, worldPos, activeColorHex, toolRadius, 0.4);
            gpWorkingFramesRef.current = tinted;
            onParamChangeRef.current?.("frames", tinted, gpNode.id);
          } else {
            let basePr = calculateSimulatedPressure(null, { x: screenX, y: screenY, time: now }, e.pressure);
            const pressure = Math.max(0.04, Math.min(2.5, basePr * gpPressureModifierRef.current));
            gpActivePointsRef.current = [
              {
                x: worldPos.x,
                y: worldPos.y,
                z: worldPos.z,
                pressure,
                nx: ptData?.normal?.x,
                ny: ptData?.normal?.y,
                nz: ptData?.normal?.z,
              },
            ];
            gpSmoothedWorldPosRef.current = worldPos.clone();
            gpLivePreviewRef.current = [{ screenX, screenY }];
            setGpLivePreview([{ screenX, screenY }]);
          }
        }
        e.stopImmediatePropagation();
        return;
      }

      // Every Points Influence gesture is gated behind Cmd/Ctrl, same as
      // curve marquee and Points Selection marquee — a plain drag always
      // stays camera orbit, never hijacked by whichever tool is armed.
      if (isMarqueeModifier && infActive && pointsInfluenceMode === "brush") {
        isBrushPainting = true;
        controls.enabled = false;
        const rect = renderer.domElement.getBoundingClientRect();
        const radius = Number(graphRef.current.nodes.find((n) => n.id === pointsInfluenceNodeId)?.params.brushRadius) || 40;
        paintInfluenceAt({ x: e.clientX - rect.left, y: e.clientY - rect.top }, radius, getActiveInfluenceLevel(), e.shiftKey);
        commitPointsInfluence();
        e.stopImmediatePropagation();
        return;
      }

      if (isMarqueeModifier && infActive && pointsInfluenceMode === "gradient") {
        isGradientDragging = true;
        controls.enabled = false;
        const rect = renderer.domElement.getBoundingClientRect();
        gradientStartPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        setGradientLine({ x1: gradientStartPos.x, y1: gradientStartPos.y, x2: gradientStartPos.x, y2: gradientStartPos.y });
        e.stopImmediatePropagation();
        return;
      }

      if (isMarqueeModifier && (curveHandles.count() > 0 || pointsSelectionHandles.count() > 0 || (infActive && pointsInfluenceMode === "discrete")) && !outputMode) {
        isMarqueeDragging = true;
        marqueeStartPos = { x: e.clientX, y: e.clientY };
        controls.enabled = false;
        e.stopImmediatePropagation();
      }
    }

    function onCanvasPointerMove(e: PointerEvent) {
      const gpNode = selectedNodeIdRef.current
        ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && isPaintOrGreaseNode(n))
        : null;

      if (isGpDrawingRef.current && gpNode && host) {
        const rect = renderer.domElement.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        const now = performance.now();

        const ptData = resolvePointerPoint(
          e.clientX,
          e.clientY,
          gpNode,
          graphRef.current,
          latestResultsRef.current,
          camera,
          renderer.domElement,
          mode2D,
        );
        const worldPos = ptData?.pos ?? null;

        if (worldPos) {
          const currentFrames = gpWorkingFramesRef.current || (gpNode.params.frames as KeyframeDrawing[]) || [];
          const targetFrame = currentFrameRef.current >= 0 ? currentFrameRef.current : 0;
          const bSize = Number(gpNode.params.brushSize) || 4;
          const toolRadius = Math.max(0.85, bSize * 0.1);
          if (gpToolRef.current === "eraser_hard") {
            const erased = eraseStrokesAtPosition(currentFrames, targetFrame, worldPos, toolRadius);
            gpWorkingFramesRef.current = erased;
            onParamChangeRef.current?.("frames", erased, gpNode.id);
          } else if (gpToolRef.current === "eraser_soft") {
            const softErased = eraseStrokesSoft(currentFrames, targetFrame, worldPos, toolRadius, 0.25);
            gpWorkingFramesRef.current = softErased;
            onParamChangeRef.current?.("frames", softErased, gpNode.id);
          } else if (gpToolRef.current === "tint") {
            const activeColorHex = parseColorHex(gpNode.params.activeColor, "#38bdf8");
            const tinted = tintStrokesAtPosition(currentFrames, targetFrame, worldPos, activeColorHex, toolRadius, 0.35);
            gpWorkingFramesRef.current = tinted;
            onParamChangeRef.current?.("frames", tinted, gpNode.id);
          } else {
            const isShift = e.shiftKey || Boolean(e.getModifierState && e.getModifierState("Shift"));
            const isCtrl = Boolean(e.getModifierState && e.getModifierState("Control"));
            const targetMod = isShift ? 0.35 : isCtrl ? 1.85 : 1.0;
            gpPressureModifierRef.current = THREE.MathUtils.lerp(gpPressureModifierRef.current, targetMod, 0.12);
            let basePr = calculateSimulatedPressure(gpPrevPointerRef.current, { x: screenX, y: screenY, time: now }, e.pressure);
            const pressure = Math.max(0.04, Math.min(2.5, basePr * gpPressureModifierRef.current));

            // Sub-stepping for Paint on geometry to wrap smoothly around curved surfaces / sharp corners
            if (gpPrevPointerRef.current && gpNode.type === PAINT_ON_GEOMETRY_NODE.type) {
              const dx = screenX - gpPrevPointerRef.current.x;
              const dy = screenY - gpPrevPointerRef.current.y;
              const dist = Math.hypot(dx, dy);
              if (dist > 8) {
                const steps = Math.min(6, Math.floor(dist / 6));
                for (let s = 1; s < steps; s++) {
                  const t = s / steps;
                  const subClientX = e.clientX - (1 - t) * dx;
                  const subClientY = e.clientY - (1 - t) * dy;
                  const subPt = resolvePointerPoint(
                    subClientX,
                    subClientY,
                    gpNode,
                    graphRef.current,
                    latestResultsRef.current,
                    camera,
                    renderer.domElement,
                    mode2D,
                  );
                  if (subPt) {
                    gpActivePointsRef.current.push({
                      x: subPt.pos.x,
                      y: subPt.pos.y,
                      z: subPt.pos.z,
                      pressure,
                      nx: subPt.normal?.x,
                      ny: subPt.normal?.y,
                      nz: subPt.normal?.z,
                    });
                  }
                }
              }
            }

            gpPrevPointerRef.current = { x: screenX, y: screenY, time: now };

            const smoothing = Math.max(0, Math.min(1, Number(gpNode.params.smoothing ?? 0.2)));
            let ptPos = worldPos;
            if (smoothing > 0.01 && gpSmoothedWorldPosRef.current) {
              const alpha = Math.max(0.15, 1.0 - smoothing * 0.75);
              gpSmoothedWorldPosRef.current.lerp(worldPos, alpha);
              ptPos = gpSmoothedWorldPosRef.current.clone();
            } else {
              gpSmoothedWorldPosRef.current = worldPos.clone();
            }

            const lastPt = gpActivePointsRef.current[gpActivePointsRef.current.length - 1];
            if (!lastPt || (Math.hypot(lastPt.x - ptPos.x, lastPt.y - ptPos.y, lastPt.z - ptPos.z) > 0.02)) {
              gpActivePointsRef.current.push({
                x: ptPos.x,
                y: ptPos.y,
                z: ptPos.z,
                pressure,
                nx: ptData?.normal?.x,
                ny: ptData?.normal?.y,
                nz: ptData?.normal?.z,
              });
              const nextPreview = [...gpLivePreviewRef.current, { screenX, screenY }];
              gpLivePreviewRef.current = nextPreview;
              setGpLivePreview(nextPreview);
            }
          }
        }
        return;
      }

      if (isBrushPainting && host) {
        const rect = renderer.domElement.getBoundingClientRect();
        const radius = Number(graphRef.current.nodes.find((n) => n.id === pointsInfluenceNodeId)?.params.brushRadius) || 40;
        paintInfluenceAt({ x: e.clientX - rect.left, y: e.clientY - rect.top }, radius, getActiveInfluenceLevel(), e.shiftKey);
        commitPointsInfluence();
        return;
      }
      if (isGradientDragging && gradientStartPos && host) {
        const rect = renderer.domElement.getBoundingClientRect();
        const x2 = e.clientX - rect.left;
        const y2 = e.clientY - rect.top;
        setGradientLine({ x1: gradientStartPos.x, y1: gradientStartPos.y, x2, y2 });
        return;
      }
      if (isMarqueeDragging && marqueeStartPos && host) {
        const rect = host.getBoundingClientRect();
        const x1 = Math.min(marqueeStartPos.x, e.clientX) - rect.left;
        const x2 = Math.max(marqueeStartPos.x, e.clientX) - rect.left;
        const y1 = Math.min(marqueeStartPos.y, e.clientY) - rect.top;
        const y2 = Math.max(marqueeStartPos.y, e.clientY) - rect.top;
        setMarqueeBox({
          left: x1,
          top: y1,
          width: Math.max(1, x2 - x1),
          height: Math.max(1, y2 - y1),
        });
      }
    }

    function onCanvasPointerUp(e: PointerEvent) {
      const gpNode = selectedNodeIdRef.current
        ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && isPaintOrGreaseNode(n))
        : null;

      if (isGpDrawingRef.current) {
        isGpDrawingRef.current = false;
        setIsGpDrawing(false);
        controls.enabled = true;
        setGpLivePreview([]);
        gpLivePreviewRef.current = [];

        if (gpToolRef.current === "pen" && gpActivePointsRef.current.length >= 1 && gpNode) {
          if (gpActivePointsRef.current.length === 1) {
            const p = gpActivePointsRef.current[0];
            gpActivePointsRef.current.push({ x: p.x + 0.002, y: p.y, z: p.z + 0.002, pressure: p.pressure });
          }
          const taperStart = gpShiftAtStartRef.current;
          const taperEnd = e.shiftKey || Boolean(e.getModifierState && e.getModifierState("Shift"));
          const widenStart = gpCtrlAtStartRef.current;
          const widenEnd = Boolean(e.getModifierState && e.getModifierState("Control"));
          gpShiftAtStartRef.current = false;
          gpCtrlAtStartRef.current = false;

          const smoothing = Math.max(0, Math.min(1, Number(gpNode.params.smoothing ?? 0.2)));
          const smoothedPoints = smoothStrokePoints(gpActivePointsRef.current, smoothing);

          const finalPoints = (taperStart || taperEnd || widenStart || widenEnd)
            ? applyStrokeTaper(smoothedPoints, taperStart, taperEnd, widenStart, widenEnd)
            : smoothedPoints;
          const strokeColor = parseColorHex(gpNode.params.activeColor, "#38bdf8");
          const customFillColor = parseColorHex(gpNode.params.fillColor, "");
          const fillColorVal = customFillColor || strokeColor;

          const newStroke: GreaseStroke = {
            id: `stroke_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            points: finalPoints,
            color: strokeColor,
            width: Number(gpNode.params.brushSize) || 4,
            brushType: gpBrushTypeRef.current,
            fill: gpSolidFillRef.current,
            fillColor: gpSolidFillRef.current ? fillColorVal : undefined,
          };

          const currentFrames = (gpNode.params.frames as KeyframeDrawing[]) || [];
          const targetFrame = currentFrameRef.current >= 0 ? currentFrameRef.current : 0;
          const nextFrames = addStrokeToFrames(currentFrames, targetFrame, newStroke);
          onParamChangeRef.current?.("frames", nextFrames, gpNode.id);
        }
        gpActivePointsRef.current = [];
        gpWorkingFramesRef.current = null;
        return;
      }
      if (isBrushPainting) {
        isBrushPainting = false;
        controls.enabled = true;
        return;
      }
      if (isGradientDragging) {
        isGradientDragging = false;
        controls.enabled = true;
        setGradientLine(null);
        if (gradientStartPos) {
          const rect = renderer.domElement.getBoundingClientRect();
          const end = { x: e.clientX - rect.left, y: e.clientY - rect.top };
          if (Math.hypot(end.x - gradientStartPos.x, end.y - gradientStartPos.y) > CLICK_MOVE_THRESHOLD_PX) {
            applyGradientInfluence(gradientStartPos, end);
            commitPointsInfluence();
          }
        }
        gradientStartPos = null;
        pointerDownAt = null;
        return;
      }
      if (isMarqueeDragging) {
        isMarqueeDragging = false;
        setMarqueeBox(null);
        controls.enabled = true;

        if (marqueeStartPos) {
          const rect = renderer.domElement.getBoundingClientRect();
          const minX = Math.min(marqueeStartPos.x, e.clientX) - rect.left;
          const maxX = Math.max(marqueeStartPos.x, e.clientX) - rect.left;
          const minY = Math.min(marqueeStartPos.y, e.clientY) - rect.top;
          const maxY = Math.max(marqueeStartPos.y, e.clientY) - rect.top;

          if (Math.hypot(e.clientX - marqueeStartPos.x, e.clientY - marqueeStartPos.y) > CLICK_MOVE_THRESHOLD_PX) {
            if (pointsInfluenceHandles.count() > 0 && pointsInfluenceMode === "discrete") {
              const picked = pointsInfluenceHandles.pickRect({ minX, minY, maxX, maxY }, camera, rect.width, rect.height);
              const level = e.shiftKey ? 0 : getActiveInfluenceLevel();
              picked.forEach((idx) => {
                if (level <= 0) pointsInfluenceMap.delete(idx);
                else pointsInfluenceMap.set(idx, level);
              });
              commitPointsInfluence();
            } else if (pointsSelectionHandles.count() > 0) {
              const picked = pointsSelectionHandles.pickRect({ minX, minY, maxX, maxY }, camera, rect.width, rect.height);
              if (e.shiftKey) {
                picked.forEach((idx) => selectedPointsSelectionIndices.add(idx));
              } else {
                selectedPointsSelectionIndices = new Set(picked);
              }
              commitPointsSelection();
            } else {
              const picked = curveHandles.pickRect({ minX, minY, maxX, maxY }, camera, rect.width, rect.height);
              if (e.shiftKey) {
                picked.forEach((idx) => selectedPointIndices.add(idx));
              } else {
                selectedPointIndices = new Set(picked);
              }
            }
            pointerDownAt = null;
            return;
          }
        }
      }

      const down = pointerDownAt;
      pointerDownAt = null;
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      if (!down || !onSelectNodeRef.current || !raycaster) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_MOVE_THRESHOLD_PX) return;

      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      raycaster.params.Line = { threshold: 0.3 };
      raycaster.params.Points = { threshold: 0.3 };

      // Face Selection editing: Shift+left selects the face under the cursor,
      // Shift+right deselects it — but only when the hit lands on the mesh
      // feeding the selected Face Selection node (so a click on the extruded
      // tree sitting on that mesh is still just a normal object click).
      if (!outputMode && faceSelectionNodeId && e.shiftKey && (e.button === 0 || e.button === 2)) {
        // Same walk as the object-picking raycast below: an ancestor being
        // hidden has to disqualify the hit even when the tagged node itself
        // is visible, so the whole chain is checked rather than stopping at
        // the first nodeId. (The green overlay carries no nodeId at all, so
        // it can never steal the click meant for the face under it.)
        const hit = raycaster
          ? raycaster.intersectObjects(scene.children, true).find((i) => {
              let curr: THREE.Object3D | null = i.object;
              let taggedNode = false;
              while (curr) {
                if (curr.visible === false) return false;
                if (curr.userData?.nodeId) taggedNode = true;
                curr = curr.parent;
              }
              return taggedNode;
            })
          : undefined;
        if (hit && faceSelectionSourceNodeId && typeof hit.faceIndex === "number") {
          let hitNodeId: string | null = null;
          let curr: THREE.Object3D | null = hit.object;
          while (curr) {
            if (curr.userData?.nodeId) {
              hitNodeId = curr.userData.nodeId;
              break;
            }
            curr = curr.parent;
          }
          if (hitNodeId === faceSelectionSourceNodeId) {
            // faceIndex is the triangle number, matching the selection's own
            // per-face order on the source geometry.
            const face = hit.faceIndex;
            if (e.button === 0) selectedFacesSet.add(face);
            else selectedFacesSet.delete(face);
            commitFaceSelection();
            return;
          }
        }
      }

      // Curve control points win over whatever is behind them — a handle sits
      // on (or inside) the very mesh it shapes, so a raycast against the scene
      // would swallow every click meant for one. tick() does the actual gizmo
      // attach off this index, so it survives the next frame's re-evaluation.
      if (curveHandles.count() > 0) {
        const pickedIdx = curveHandles.pick(ndc, camera, rect.width, rect.height);
        if (pickedIdx !== null) {
          if (e.shiftKey) {
            if (selectedPointIndices.has(pickedIdx)) {
              selectedPointIndices.delete(pickedIdx);
            } else {
              selectedPointIndices.add(pickedIdx);
            }
          } else {
            selectedPointIndices = new Set([pickedIdx]);
          }
          return;
        }
      }
      if (pointsSelectionHandles.count() > 0) {
        const pickedIdx = pointsSelectionHandles.pick(ndc, camera, rect.width, rect.height);
        if (pickedIdx !== null) {
          if (e.shiftKey) {
            if (selectedPointsSelectionIndices.has(pickedIdx)) {
              selectedPointsSelectionIndices.delete(pickedIdx);
            } else {
              selectedPointsSelectionIndices.add(pickedIdx);
            }
          } else {
            selectedPointsSelectionIndices = new Set([pickedIdx]);
          }
          commitPointsSelection();
          return;
        }
        // Missed every handle: clear the selection and fall through to the
        // generic scene raycast below, same as curve editing does — a click
        // on empty space (or another object) shouldn't trap the operator in
        // Points Selection mode.
        if (selectedPointsSelectionIndices.size > 0) {
          selectedPointsSelectionIndices.clear();
          commitPointsSelection();
        }
      }
      // Discrete-mode Points Influence: a plain click assigns (or, with
      // Shift, erases) the currently armed level to the single nearest
      // point, same missed-click fallthrough as Points Selection above.
      if (pointsInfluenceHandles.count() > 0 && pointsInfluenceMode === "discrete") {
        const pickedIdx = pointsInfluenceHandles.pick(ndc, camera, rect.width, rect.height);
        if (pickedIdx !== null) {
          const level = e.shiftKey ? 0 : getActiveInfluenceLevel();
          if (level <= 0) pointsInfluenceMap.delete(pickedIdx);
          else pointsInfluenceMap.set(pickedIdx, level);
          commitPointsInfluence();
          return;
        }
      }
      // Clicking anywhere else drops the point and hands the gizmo back to
      // the object.
      selectedPointIndices.clear();

      // three's Raycaster hits invisible objects too — it only skips them if
      // you filter yourself — so a hidden object would otherwise still be
      // clickable, and would steal clicks from whatever is visible behind it.
      const hit = raycaster
        ? raycaster.intersectObjects(scene.children, true).find((i) => {
            let curr: THREE.Object3D | null = i.object;
            let taggedNode = false;
            while (curr) {
              if (curr.visible === false) return false;
              if (curr.userData?.nodeId) taggedNode = true;
              curr = curr.parent;
            }
            return taggedNode;
          })
        : undefined;

      let hitNodeId: string | null = null;
      if (hit) {
        let curr: THREE.Object3D | null = hit.object;
        while (curr) {
          if (curr.userData?.nodeId) {
            hitNodeId = curr.userData.nodeId;
            break;
          }
          curr = curr.parent;
        }
      }
      onSelectNodeRef.current(hitNodeId);
    }

    let removeContextMenu: (() => void) | null = null;

    if (!outputMode) {
      renderer.domElement.addEventListener("pointerdown", onCanvasPointerDown, { capture: true });
      window.addEventListener("pointermove", onCanvasPointerMove);
      window.addEventListener("pointerup", onCanvasPointerUp);
      window.addEventListener("pointercancel", onCanvasPointerUp);
      // No browser context menu over the 3D view, ever. OrbitControls already
      // suppresses it — but only while `controls.enabled` is true, and tick()
      // turns that off whenever a Camera node drives the view. Every such gap
      // used to reach Chrome's canvas menu ("Save image as…"), which is fatal
      // to Face Selection's Shift+right-click deselect: once the native menu
      // opens the browser swallows the pointerup that gesture is read from,
      // so the menu appears *and* the face stays selected. Gating this on a
      // Face Selection node being active reopened the same gap one frame at a
      // time (faceSelectionNodeId is only assigned inside tick()), so it is
      // unconditional — right-click in a viewport is a camera/edit gesture,
      // never a request to save the canvas as a PNG.
      const onCanvasContextMenu = (e: MouseEvent) => e.preventDefault();
      renderer.domElement.addEventListener("contextmenu", onCanvasContextMenu);
      removeContextMenu = () => renderer.domElement.removeEventListener("contextmenu", onCanvasContextMenu);
    }

    const motionBlurEffect = createMotionBlur(host.clientWidth || 1, host.clientHeight || 1);

    function resize() {
      const { clientWidth, clientHeight } = host;
      if (clientWidth === 0 || clientHeight === 0) return;
      const aspect = clientWidth / clientHeight;
      renderer.setSize(clientWidth, clientHeight);
      composer.setSize(clientWidth, clientHeight);
      motionBlurEffect.setSize(clientWidth, clientHeight);

      perspectiveCamera.aspect = aspect;
      perspectiveCamera.updateProjectionMatrix();

      const d = activeCamera.position.distanceTo(controls.target) || 5;
      const fovRad = THREE.MathUtils.degToRad(perspectiveCamera.fov);
      const halfHeight = Math.tan(fovRad / 2) * d;
      const halfWidth = halfHeight * aspect;
      orthographicCamera.left = -halfWidth;
      orthographicCamera.right = halfWidth;
      orthographicCamera.top = halfHeight;
      orthographicCamera.bottom = -halfHeight;
      orthographicCamera.updateProjectionMatrix();
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    let currentObject: THREE.Object3D | null = null;
    let cachedRootsGraph: Graph | null = null;
    let cachedRoots: string[] = [];
    const activeLights = new Map<string, THREE.Light>();
    const activeLightHelpers = new Map<string, THREE.Object3D>();
    // Everything this viewport puts into a scene goes through one of these,
    // so nothing can be added without also being removable — see
    // sceneMembership.ts. `sceneContents` holds the render output plus any
    // standalone Empty anchors; `editorHelpers` holds the editor-only camera
    // helpers (never shown in the output window).
    const sceneContents = createSceneMembership(scene);
    const editorHelpers = createSceneMembership(editorUiScene);

    // A parking scene for gizmo targets that belong to no scene at all.
    //
    // TransformControls requires its attached object to be in a scene graph:
    // its pointerdown path calls `object.parent.updateMatrixWorld()` with no
    // null check, and its own updateMatrixWorld() logs "The attached 3D
    // object must be a part of the scene graph." A node whose geometry is
    // consumed by a *cloning* node (Array, Look At — see array.ts, which
    // clones its source rather than reparenting it) is exactly that case:
    // the clones are what get drawn, and the node's own object sits
    // parentless. Attaching to it gave a gizmo that drew but threw on the
    // first click, so it read as visible but dead.
    //
    // This scene is never rendered — it exists only to give such an object a
    // valid parent and a matrixWorld that tracks its matrix, without drawing
    // it a second time (which is the duplicate-render bug in the other
    // direction) and without touching `visible`, which the cloning nodes
    // copy onto their clones.
    const gizmoAnchorScene = new THREE.Scene();
    const postChain = createPostProcessChain({ renderer, composer, renderPass, outputPass, motionBlurEffect });

    const backgroundBlur = createBackgroundBlur(renderer);

    let clock: ClockState = createClock(epochMs ?? Date.now());
    let frameId = 0;

    // Restarts the deterministic clock at "now" and drops every cached GPU
    // particle simulation (see particleRuntime.ts) — the next tick()
    // rebuilds everything fresh from each node's *current* params, same as
    // a first load. Only rewinds time and runtime state, not graph edits —
    // matches "reset the animation," not "revert my changes."
    resetSimulationRef.current = () => {
      clock = createClock(Date.now());
      resetAllParticleSimulations();
    };

    if (exportHandleRef) {
      exportHandleRef.current = {
        getCanvas: () => exportCanvas,
        captureFrame: (frameIndex, fps) =>
          new Promise<void>((resolve) => {
            pendingCaptureRef.current = { frameIndex, fps, resolve };
          }),
      };
    }

    snapSelectedCameraToEditorRef.current = () => {
      if (!onTransformChangeRef.current) return;

      // Target selected camera node if selected, otherwise find the active or first camera node in graph
      let targetNode = selectedNodeIdRef.current
        ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && n.type === CAMERA_NODE.type)
        : undefined;

      if (!targetNode) {
        const cameraNodes = graphRef.current.nodes.filter((n) => n.type === CAMERA_NODE.type);
        if (cameraNodes.length === 0) return;

        targetNode =
          cameraNodes.find((n) => {
            const res = latestResultsRef.current?.get(n.id);
            return res && (res.active === 1 || res.active === true);
          }) || cameraNodes[0];
      }

      activeCamera.updateMatrixWorld(true);
      const mat = activeCamera.matrixWorld;
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      mat.decompose(pos, quat, scale);

      const euler = new THREE.Euler().setFromQuaternion(quat, "YXZ");

      const location = new THREE.Vector3(
        Math.round(pos.x * 100) / 100,
        Math.round(pos.y * 100) / 100,
        Math.round(pos.z * 100) / 100,
      );
      const rotation = new THREE.Vector3(
        euler.x,
        euler.y,
        euler.z,
      );

      const targetPos = controls.target.clone();
      const target = new THREE.Vector3(
        Math.round(targetPos.x * 100) / 100,
        Math.round(targetPos.y * 100) / 100,
        Math.round(targetPos.z * 100) / 100,
      );

      const isOrtho = isOrthographicRef.current;
      const fov = activeCamera instanceof THREE.PerspectiveCamera ? Math.round(activeCamera.fov) : undefined;

      onTransformStartRef.current?.();
      const patch: Record<string, unknown> = {
        location,
        rotation,
        target,
        up: activeCamera.up.clone(),
        projectionType: isOrtho ? "orthographic" : "perspective",
      };
      if (fov !== undefined && !isOrtho) patch.fov = fov;

      onTransformChangeRef.current(targetNode.id, patch);
    };

    // A copied-in projection matrix stays copied in until something rebuilds
    // it — switching the Camera node back to manual, or deleting it, would
    // otherwise leave the viewport stuck on the last solved frustum.
    let projectionOverridden = false;
    function restoreProjection() {
      if (!projectionOverridden) return;
      camera.updateProjectionMatrix();
      projectionOverridden = false;
    }

    let isDisposed = false;

    function tick() {
      if (isDisposed) return;
      try {
        tickInner();
      } catch (err) {
        console.error("Viewport tick uncaught error:", err);
      } finally {
        if (!isDisposed) {
          frameId = requestAnimationFrame(tick);
        }
      }
    }

    function tickInner() {
      // Frozen while this pane is hidden (SplitViewport keeps every pane
      // mounted now rather than unmounting on a view-mode switch — see its
      // own comment — so this can stay true for as long as the operator is
      // just looking at the graph or the other pane) or another viewport is
      // capturing an export. Keep the rAF alive so the pane picks straight
      // back up once visible again, but touch nothing else in between —
      // except re-anchoring the clock epoch every suspended frame, the same
      // reason the paused branch below does it: epochMs is what `time`/`step`
      // are computed *from* on the next real tick, and if it's left pointing
      // at whenever playback last started, resuming after a long suspension
      // computes step from every second that passed while hidden, backlog
      // included — the exact clock-jump bug already fixed for pause,
      // reachable a second way now that suspension can last minutes instead
      // of one export's worth of frames.
      if (suspendedRef.current) {
        clock = { epochMs: Date.now() - clock.time * 1000, step: clock.step, time: clock.time };
        return;
      }

      // A pending captureFrame() call wins over live playback entirely: the
      // clock is forced to exactly frameIndex/fps (not real elapsed time —
      // Time-node/oscillator/particle output must match that instant, not
      // whenever this tick happened to run), and keyframe evaluation uses
      // frameIndex directly rather than racing the currentFrame prop's own
      // React commit.
      const capture = pendingCaptureRef.current;
      const exportFrameIndex = capture?.frameIndex ?? currentFrameRef.current;
      if (capture) {
        const stepSeconds = 1 / capture.fps;
        const time = capture.frameIndex * stepSeconds;
        clock = { epochMs: clock.epochMs, step: Math.round(time / STEP_SECONDS), time };
      } else if (isPlayingRef.current) {
        clock = tickClock(clock, Date.now());
      } else {
        // Freeze at the step matching the already-frozen `time` — NOT 0.
        // Forcing step to 0 (the previous behavior here) reads as "the
        // clock just jumped backward in time" to anything that compares
        // steps monotonically, GPUComputationRenderer particle sims chief
        // among them: particleRuntime.ts's `rewound` check
        // (currentStep < sim.lastSteppedStep) fires on literally every
        // pause once playback has advanced past step 0, tearing down and
        // rebuilding the whole simulation from its staggered-fresh-start
        // state — which is what actually produced the reported burst on
        // resume, not (only) the catch-up cap. Re-anchoring epochMs here
        // too keeps wall-clock time from accruing underneath the pause, so
        // tickClock's next call on resume continues smoothly from this same
        // step instead of computing one from everything elapsed since
        // playback originally started.
        clock = { epochMs: Date.now() - clock.time * 1000, step: Math.round(clock.time / STEP_SECONDS), time: clock.time };
      }

      // Suppress the graph-driven matrix overwrite for exactly the mesh the
      // gizmo is dragging this frame (see EvalContext.liveEditNodeId and
      // object.ts) — `transformControls.dragging` is set synchronously by
      // its own pointer handlers, so this is already current by the time
      // any given frame runs, no extra bookkeeping needed.
      const liveEditNodeId = transformControls?.dragging ? attachedObjectNodeId : null;

      // The active camera from last frame, so a Fly To with no wired Camera A
      // can lift off from the current view instead of the origin. Resolved
      // from the previous results (there is no "active" answer until a frame
      // has been evaluated) — one frame of lag on a flight's *start* pose,
      // which is imperceptible.
      const activeCameraPose = latestResults
        ? activeCameraPoseFrom(resolveActiveCameraResult(latestResults, graphRef.current))
        : null;

      let results;
      try {
        // Feed the previous frame's render resolution to hub/* nodes so they
        // can default their pixel positions to the scene centre.
        const prevRender = renderNodeIdRef.current && latestResults ? latestResults.get(renderNodeIdRef.current) : undefined;
        const renderSize =
          prevRender && typeof prevRender.width === "number" && typeof prevRender.height === "number"
            ? { width: prevRender.width as number, height: prevRender.height as number }
            : undefined;
        const renderFps = typeof prevRender?.fps === "number" ? (prevRender.fps as number) : undefined;

        // Advance the playhead here, off this same clock, rather than taking
        // whatever an outside timer last pushed in — see playhead.ts. Export
        // is untouched: it forces its own frame index above.
        let timelineFrame = exportFrameIndex;
        if (!capture) {
          const stepped = advancePlayhead(playheadRef.current, {
            driving: onFrameChangeRef.current !== undefined,
            playing: isPlayingRef.current,
            totalFrames: totalFramesRef.current,
            incomingFrame: currentFrameRef.current,
            fps: renderFps ?? 30,
            clockTime: clock.time,
          });
          playheadRef.current = stepped.state;
          timelineFrame = stepped.frame;
        }
        if (!capture && timelineFrame !== currentFrameRef.current) {
          // Keep our own view of it current for the rest of this frame: the
          // prop only comes back after React has committed, which is one or
          // more renders away, and every read until then must agree with what
          // was actually evaluated.
          currentFrameRef.current = timelineFrame;
          onFrameChangeRef.current?.(timelineFrame);
        }

        results = evaluateGraph(graphRef.current, registryRef.current, {
          time: clock.time,
          step: clock.step,
          nodeId: "",
          liveEditNodeId,
          renderer,
          activeCameraPose,
          renderSize,
          fps: renderFps,
          sessionId: sessionIdRef.current,
          capturing: capture !== null,
          currentFrame: capture ? exportFrameIndex : currentFrameRef.current,
          keyframes: graphRef.current.keyframes,
          scene,
        });
      } catch (err) {
        console.error("graph evaluation failed", err);
        if (capture) {
          pendingCaptureRef.current = null;
          capture.resolve();
        }
        return;
      }
      latestResults = results;
      latestResultsRef.current = results;
      onEvaluatedResultsRef.current?.(results);

      // Evaluate and sync ALL 3D Lights & Light Helpers in the scene (standalone or array instances)
      const detectedLights = new Map<string, { light: THREE.Light; nodeId: string }>();
      for (const [nodeId, res] of results.entries()) {
        const obj = (res.light || res.geometry) as THREE.Object3D;
        if (obj instanceof THREE.Object3D) {
          obj.traverse((child) => {
            if (child instanceof THREE.Light) {
              const ownerId = child.userData.nodeId || nodeId;
              detectedLights.set(child.uuid, { light: child, nodeId: ownerId });
            }
          });
        }
      }

      const activeLightUUIDs = new Set<string>();
      for (const [uuid, { light, nodeId }] of detectedLights.entries()) {
        activeLightUUIDs.add(uuid);

        if (!activeLights.has(uuid)) {
          // Light objects are cached per node id at module scope (see
          // nodeCaches.ts), so the split view's two panes would otherwise
          // fight over the single shared instance — three.js gives an
          // Object3D exactly one parent, and whichever scene.add() ran last
          // silently rips the light out of the other pane's scene. The
          // output pane holds its own disposable clone instead (same rule
          // as the geometry clones further down in tick()); it needs no
          // stable identity, and copyLightState() below keeps it in sync.
          const toAdd = outputMode ? light.clone() : light;
          if (!toAdd.parent) {
            scene.add(toAdd);
          }
          if ((toAdd as THREE.DirectionalLight | THREE.SpotLight).target && !(toAdd as THREE.DirectionalLight | THREE.SpotLight).target.parent) {
            scene.add((toAdd as THREE.DirectionalLight | THREE.SpotLight).target);
          }
          activeLights.set(uuid, toAdd);

          if (!outputMode) {
            let helper: THREE.Object3D | null = null;
            if (light instanceof THREE.DirectionalLight) {
              helper = new THREE.DirectionalLightHelper(light, 1, light.color);
            } else if (light instanceof THREE.PointLight) {
              helper = new THREE.PointLightHelper(light, 0.5, light.color);
            } else if (light instanceof THREE.SpotLight) {
              helper = new THREE.SpotLightHelper(light, light.color);
            }

            if (helper) {
              helper.userData.nodeId = nodeId;
              helper.traverse((c) => {
                c.userData.nodeId = nodeId;
              });
              editorUiScene.add(helper);
              activeLightHelpers.set(uuid, helper);
            }
          }
        }

        // Keep the output pane's clone in step with the shared original
        // (color, intensity, transform, spot/point params, aim target) so
        // live edits still show up in the preview pane.
        const sceneLight = activeLights.get(uuid);
        if (outputMode && sceneLight && sceneLight !== light) {
          copyLightState(light, sceneLight);
        }

        const helper = activeLightHelpers.get(uuid);
        if (helper) {
          if (typeof (helper as any).update === "function") {
            (helper as any).update();
          }
          if ((helper as any).color) {
            (helper as any).color.copy(light.color);
          }
        }
      }

      // Cleanup stale lights removed from graph
      for (const [uuid, light] of activeLights.entries()) {
        if (!activeLightUUIDs.has(uuid)) {
          if (light.parent === scene) {
            scene.remove(light);
          }
          const targetObj = (light as THREE.DirectionalLight | THREE.SpotLight).target;
          if (targetObj && targetObj.parent === scene) {
            scene.remove(targetObj);
          }
          activeLights.delete(uuid);
          const helper = activeLightHelpers.get(uuid);
          if (helper) {
            editorUiScene.remove(helper);
            activeLightHelpers.delete(uuid);
          }
        }
      }

      // Sync Camera 3D Helpers in editorUiScene (editor view only). Routed
      // through editorHelpers so a camera node that's been deleted — or a
      // whole graph replaced by "New" — takes its helper with it; these used
      // to be added and never removed, leaving the last camera floating in
      // an otherwise empty scene.
      const activeCameraHelpers = new Map<string, THREE.Object3D>();
      for (const [nodeId, res] of results.entries()) {
        const node = graphRef.current.nodes.find((n) => n.id === nodeId);
        if ((node?.type === CAMERA_NODE.type || node?.type === CAMERA_FLY_TO_NODE.type) && res.geometry instanceof THREE.Object3D) {
          activeCameraHelpers.set(nodeId, res.geometry as THREE.Object3D);
        }
      }
      editorHelpers.sync(outputMode ? new Map() : activeCameraHelpers);

      // A Camera or Fly To node drives the camera directly from its Matrix/
      // FOV (or its DLT solve) — but only in the *output* window. That is
      // the one view that has to show exactly what the real projector will
      // show, which orbit navigation would otherwise fight every frame. The
      // editor's own viewport stays freely orbitable regardless of a Camera
      // node's presence or mode, since it's for building/inspecting the
      // scene, not for judging alignment — that judgment only means
      // anything against the actual projected output (see OutputWindow).
      // Prioritize Fly To if active or in flight, then fallback to Camera nodes.
      const activeCameraResult = resolveActiveCameraResult(results, graphRef.current);

      const cameraResult = activeCameraResult;

      // The render node defines the scene's coordinate space (its output
      // resolution) and its presence is what enables the 2D HUD overlay.
      const hubRenderResult = renderNodeIdRef.current ? results.get(renderNodeIdRef.current) : undefined;
      const rs =
        hubRenderResult && typeof hubRenderResult.width === "number" && typeof hubRenderResult.height === "number"
          ? { width: hubRenderResult.width as number, height: hubRenderResult.height as number }
          : null;
      if (
        (rs === null) !== (renderSizeRef.current === null) ||
        (rs && renderSizeRef.current && (rs.width !== renderSizeRef.current.width || rs.height !== renderSizeRef.current.height))
      ) {
        renderSizeRef.current = rs;
        setRenderSize(rs);
      }

      // Keep the export canvas at the render-node resolution (not the live
      // viewport size) so captureStream produces a full-resolution video.
      if (rs && exportCtx && (exportCanvas.width !== rs.width || exportCanvas.height !== rs.height)) {
        exportCanvas.width = Math.round(rs.width);
        exportCanvas.height = Math.round(rs.height);
      }

      // Collect HUD elements produced by hub/* nodes this frame. Only re-render
      // React when their serialized appearance actually changed (text/style, or
      // an active animation moving opacity/transform), so idle frames don't churn.
      const collectedHub: HubElement[] = [];
      for (const [, res] of results.entries()) {
        const hud = res.hud;
        if (hud && typeof hud === "object") collectedHub.push(hud as HubElement);
      }
      const hubSig = JSON.stringify(collectedHub);
      if (hubSigRef.current !== hubSig) {
        hubSigRef.current = hubSig;
        // Start decoding any new HUD image now rather than on the first
        // captured frame, and let go of the ones no element points at.
        for (const el of collectedHub) if (el.imageUrl) getExportImage(el.imageUrl);
        pruneExportImages(collectedHub);
        setHubElements(collectedHub);
      }

      const shouldDriveCamera = outputMode || isCameraViewRef.current;
      // Only sync the ortho/perspective toggle to the active Camera node's
      // own projectionType while something is actually looking through that
      // camera (output window, or the editor's camera-preview pane) — same
      // gate as calibrationMatrix below. Ungated, this ran on every frame
      // regardless of view mode: a graph with an active perspective Camera
      // node fought the free-orbit editor's own ortho toggle and axis-view
      // snap (Numpad/X/Y/Z), reverting them to perspective the instant they
      // were set, even though nothing was rendering through that camera.
      if (shouldDriveCamera && cameraResult && typeof cameraResult.projectionType === "string") {
        const wantsOrtho = cameraResult.projectionType === "orthographic";
        if (wantsOrtho !== isOrthographicRef.current) {
          setIsOrthographic(wantsOrtho);
        }
      }
      const calibrationMatrix =
        shouldDriveCamera && cameraResult?.matrix instanceof THREE.Matrix4 ? cameraResult.matrix as THREE.Matrix4 : null;

      if (calibrationMatrix) {
        controls.enabled = false;
        const position = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        calibrationMatrix.decompose(position, quaternion, scale);
        camera.position.copy(position);
        camera.quaternion.copy(quaternion);

        // A solved projector has an off-centre principal point (lens shift),
        // which `fov` structurally cannot express — it forces a symmetric
        // frustum. So when the Camera node hands back a full projection
        // matrix, it is copied in directly, overriding whatever
        // updateProjectionMatrix built from fov/aspect. The copy happens
        // every frame, which is also what keeps it winning over the resize
        // handler's own updateProjectionMatrix call.
        const projection = cameraResult?.projection;
        if (projection instanceof THREE.Matrix4) {
          camera.projectionMatrix.copy(projection);
          camera.projectionMatrixInverse.copy(projection).invert();
          projectionOverridden = true;
        } else if (camera instanceof THREE.PerspectiveCamera) {
          const fov = Number(cameraResult?.fov) || camera.fov;
          if (camera.fov !== fov) camera.fov = fov;
          restoreProjection();
        } else {
          restoreProjection();
        }
      } else if (outputMode && previewCameraPoseRef.current) {
        // Motion design: no Camera node exists to lock onto, so mirror
        // whatever the editor's own orbit camera is currently looking at
        // instead of sitting on a fixed default angle nobody chose. Applied
        // directly rather than through OrbitControls (the output window
        // has no pointer interaction of its own to reconcile with).
        controls.enabled = false;
        const [px, py, pz] = previewCameraPoseRef.current.position;
        const [qx, qy, qz, qw] = previewCameraPoseRef.current.quaternion;
        camera.position.set(px, py, pz);
        camera.quaternion.set(qx, qy, qz, qw);
        restoreProjection();
      } else {
        // Don't stomp the gizmo's own disable — tick() runs every animation
        // frame regardless of pointer state, and would otherwise flip
        // `enabled` back to true mid-drag within one frame of the
        // 'dragging-changed' listener turning it off.
        const selectedGpNode = graphRef.current.nodes.find(
          (n) => n.id === selectedNodeIdRef.current && isPaintOrGreaseNode(n),
        );
        if (!selectedGpNode && isGpDrawingRef.current) {
          isGpDrawingRef.current = false;
          setIsGpDrawing(false);
          controls.enabled = true;
        }

        if (!transformControls?.dragging && !isMarqueeDragging) {
          if (!isGpDrawingRef.current) {
            controls.enabled = true;
          }
          if (!Number.isFinite(controls.target.x) || !Number.isFinite(controls.target.y) || !Number.isFinite(controls.target.z)) {
            controls.target.set(0, 0, 0);
          }
          if (!Number.isFinite(camera.position.x) || !Number.isFinite(camera.position.y) || !Number.isFinite(camera.position.z)) {
            camera.position.set(0, 5, 10);
          }
          controls.update();
        }
        restoreProjection();
      }

      // Holdout: when the render node's holdout is on, the clear colour is
      // opaque black, so anything not drawn by the scene (the letterbox around
      // the render frame) is black instead of the editor background.
      const renderOut = renderNodeIdRef.current ? results.get(renderNodeIdRef.current) : undefined;
      const holdoutEnabled = !!renderOut?.holdout;
      if (holdoutRef.current !== holdoutEnabled) {
        holdoutRef.current = holdoutEnabled;
        renderer.setClearColor(holdoutEnabled ? 0x000000 : 0x000000, holdoutEnabled ? 1 : 0);
      }

      // Sync corner Gizmo camera orientation with main camera — derived from
      // the camera's own quaternion (not position-minus-controls.target,
      // which is only meaningful in orbit mode and would be stale while a
      // Camera node is driving the camera directly).
      if (gizmo) {
        const cameraForward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        gizmo.gizmoCamera.position.copy(cameraForward).multiplyScalar(-3);
        gizmo.gizmoCamera.lookAt(0, 0, 0);
      }

      // Everything this viewport shows, in one reconciliation: the object of
      // every node that is a scene root — one whose geometry nothing
      // downstream has taken ownership of (see sceneRoots.ts). A Render node
      // is one root among others rather than the only door into the scene,
      // which is what the Empty and light exemptions here were already
      // working around.
      //
      // The containment check is the safety net for *reparenting* owners: a
      // Merge pulls its inputs into its own group, and adding one to the
      // scene again would tear it back out (three.js gives an Object3D
      // exactly one parent). Cloning owners — Array, Look At, Spawner — are
      // covered by the ownership declaration instead, since their source is
      // never inside their output and no runtime check could tell the
      // resulting duplicate from a legitimate second object.
      // Only the graph's shape decides this, and it changes on an edit, not
      // on a frame — recomputing it 60 times a second would walk every
      // connection of every node for nothing.
      if (cachedRootsGraph !== graphRef.current) {
        cachedRootsGraph = graphRef.current;
        cachedRoots = resolveSceneRoots(graphRef.current, registryRef.current);
      }

      const rootObjects: { nodeId: string; object: THREE.Object3D }[] = [];
      for (const nodeId of cachedRoots) {
        const geometry = results.get(nodeId)?.geometry;
        if (!(geometry instanceof THREE.Object3D)) continue;
        rootObjects.push({ nodeId, object: geometry });
      }

      const desiredContents = new Map<string, THREE.Object3D>();
      for (const { nodeId, object } of rootObjects) {
        const insideAnotherRoot = rootObjects.some(
          (other) => other.object !== object && isSelfOrDescendantOf(object, other.object),
        );
        if (insideAnotherRoot) continue;

        // Split View's right pane (and the separate Output Window) run their
        // own tick() loop against the *same* graph, but every object/
        // instance/merge node hands back one THREE.Object3D cached per node
        // id at module scope (see nodeCaches.ts) — there is only ever one
        // such object for the whole process, not one per Viewport. three.js
        // gives an Object3D exactly one parent, so the instant a second
        // Viewport's scene.add() runs on it, it's silently ripped out of
        // whichever scene had it first: the editor pane's own scene.add()
        // this frame gets undone by the output pane's the next, leaving the
        // editor empty until the object's identity happens to change again.
        //
        // This pane has no TransformControls (outputMode skips that whole
        // block below) needing a *stable* object identity to attach to
        // across frames, so it's free to hold its own disposable clone
        // instead of fighting over the shared original. Object3D.clone(true)
        // deep-copies the hierarchy but shares geometry/material by
        // reference — cheap, and nothing GPU-owned needs disposing when the
        // old clone is dropped.
        desiredContents.set(nodeId, outputMode ? object.clone(true) : object);
      }
      sceneContents.sync(desiredContents);

      // What post-processing outlines and what the passe-partout guide frames
      // is still the Render node's own subtree — "the output" is a narrower
      // idea than "everything in the scene", and that is exactly what a
      // Render node is for.
      const renderOutput = results.get(renderNodeIdRef.current)?.geometry;
      currentObject = renderOutput instanceof THREE.Object3D ? (desiredContents.get(renderNodeIdRef.current) ?? renderOutput) : null;

      // Curve control-point handles for the selected curve, drawn through the
      // world matrix of whatever object draws that curve so they track the
      // tube when it is moved, rotated or scaled.
      const curveTarget = outputMode ? null : resolveCurveEditTarget(graphRef.current, selectedNodeIdRef.current);
      const curveNode = curveTarget ? graphRef.current.nodes.find((n) => n.id === curveTarget.pointsNodeId) : undefined;
      // A lattice's handles go on its *deformed* cage, not on the raw stored
      // grid: the stored points are the grid before taper/twist/bend are
      // applied, so with any of those dialled in, handles drawn there float
      // off the cage they are meant to be editing. A drag is converted back
      // through latticeBasePointForTarget below.
      const isLatticeNode = curveNode?.type === LATTICE_DEFORM_NODE.type;
      const curvePoints = isLatticeNode
        ? latticeEvaluatedPoints(curveNode!.params)
        : (Array.isArray(curveNode?.params.pointsList) ? curveNode.params.pointsList : []).map((p) =>
            asVector3(p, new THREE.Vector3()),
          );

      const isEditMeshPointsNode = curveNode?.type === EDIT_MESH_POINTS_NODE.type;
      const overMeshPointsCap = isEditMeshPointsNode && curvePoints.length > EDIT_MESH_POINTS_HANDLE_CAP;
      if (overMeshPointsCap && !editMeshPointsCapWarned) {
        editMeshPointsCapWarned = true;
        console.warn(
          `Edit Mesh Points: ${curvePoints.length} vertices is too many for draggable handles (cap ${EDIT_MESH_POINTS_HANDLE_CAP}) — showing no handles for this node. Use it on lower-poly meshes.`,
        );
      }

      if (curveTarget && curveNode && curvePoints.length >= 2 && !overMeshPointsCap) {
        if (curvePointsNodeId !== curveNode.id) {
          curvePointsNodeId = curveNode.id;
          selectedPointIndices.clear();
        }
        // An index past the end of the list is left alone rather than
        // cleared: adding a point selects it one frame before the graph state
        // carrying it arrives here. handleAt() returns null for an index with
        // no handle, so the gizmo simply sits out that frame.

        // The pose the curve is drawn at. `matrix.copy()` on a graph-driven
        // mesh never flags matrixWorld as stale (see the gizmo block below),
        // so it has to be recomputed rather than read.
        const spaceObject = results.get(curveTarget.spaceNodeId)?.geometry;
        const spaceMatrix = new THREE.Matrix4();
        if (spaceObject instanceof THREE.Object3D) {
          spaceObject.updateWorldMatrix(true, false, true);
          spaceMatrix.copy(spaceObject.matrixWorld);
        }

        const isDraggingHandle =
          transformControls?.dragging &&
          (transformControls.object?.userData?.isCurvePointHandle ||
            transformControls.object?.userData?.isCurveCentroidHandle);
        const frozenIndices = isDraggingHandle ? selectedPointIndices : null;
        // Curve-from-points draws its own dark-gray curve via a geometry output
        // (see curve.ts), so skip the straight control-polygon line here. A
        // mesh's vertex-buffer order isn't a path either — a line through it
        // would zigzag across the mesh rather than trace anything meaningful.
        const hideStraightLine = isLatticeNode || curveNode?.type === "curve/from_points" || isEditMeshPointsNode;
        curveHandles.sync(curvePoints, spaceMatrix, selectedPointIndices, frozenIndices, !hideStraightLine, camera, host.clientHeight);
      } else if (curveHandles.count() > 0) {
        curveHandles.clear();
        curvePointsNodeId = null;
        selectedPointIndices.clear();
      }

      // Points Selection handles — same rendering/hit-testing machinery as
      // curve handles (createCurvePointHandles is generic point-cloud dots,
      // nothing curve-specific about it), but the points themselves come
      // from this node's own *live evaluated* output (Points is an input,
      // not a stored param — it's whatever Mesh to Points/upstream produced
      // this frame), and there's no polyline (showLine=false) or drag/gizmo
      // support: this feature only selects, it never moves a point.
      const pointsSelNode = !outputMode
        ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && n.type === POINTS_SELECTION_NODE.type)
        : undefined;
      if (pointsSelNode) {
        if (pointsSelectionNodeId !== pointsSelNode.id) {
          pointsSelectionNodeId = pointsSelNode.id;
          selectedPointsSelectionIndices = new Set(
            Array.isArray(pointsSelNode.params.selectedIndices) ? (pointsSelNode.params.selectedIndices as number[]) : [],
          );
        }
        const nodeResult = results.get(pointsSelNode.id);
        const rawPoints = Array.isArray(nodeResult?.points) ? (nodeResult.points as unknown[]) : [];
        const selPoints = rawPoints.map((p) => asVector3(p, new THREE.Vector3()));
        const selMatrix = nodeResult?.matrix instanceof THREE.Matrix4 ? (nodeResult.matrix as THREE.Matrix4) : new THREE.Matrix4();

        if (selPoints.length > 0) {
          pointsSelectionHandles.sync(selPoints, selMatrix, selectedPointsSelectionIndices);
        } else if (pointsSelectionHandles.count() > 0) {
          pointsSelectionHandles.clear();
        }
      } else if (pointsSelectionHandles.count() > 0) {
        pointsSelectionHandles.clear();
        pointsSelectionNodeId = null;
        selectedPointsSelectionIndices.clear();
      }

      // Points Influence handles — same live-evaluated point source as
      // Points Selection above, colored as a heatmap of the painted
      // influence instead of plain selected/unselected.
      const pointsInfNode = !outputMode
        ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && n.type === POINTS_INFLUENCE_NODE.type)
        : undefined;
      if (pointsInfNode) {
        pointsInfluenceMode =
          pointsInfNode.params.mode === "discrete" || pointsInfNode.params.mode === "gradient" ? pointsInfNode.params.mode : "brush";
        if (pointsInfluenceNodeId !== pointsInfNode.id) {
          pointsInfluenceNodeId = pointsInfNode.id;
          const stored = pointsInfNode.params.influences;
          pointsInfluenceMap = new Map(
            stored && typeof stored === "object" ? Object.entries(stored as Record<string, number>).map(([k, v]) => [Number(k), v]) : [],
          );
        }
        const nodeResult = results.get(pointsInfNode.id);
        const rawPoints = Array.isArray(nodeResult?.points) ? (nodeResult.points as unknown[]) : [];
        const infPoints = rawPoints.map((p) => asVector3(p, new THREE.Vector3()));
        const infMatrix = nodeResult?.matrix instanceof THREE.Matrix4 ? (nodeResult.matrix as THREE.Matrix4) : new THREE.Matrix4();

        if (infPoints.length > 0) {
          pointsInfluenceHandles.sync(infPoints, infMatrix, null, (idx) => influenceColor(pointsInfluenceMap.get(idx) ?? 0));
        } else if (pointsInfluenceHandles.count() > 0) {
          pointsInfluenceHandles.clear();
        }
      } else if (pointsInfluenceHandles.count() > 0) {
        pointsInfluenceHandles.clear();
        pointsInfluenceNodeId = null;
        pointsInfluenceMap.clear();
      }

      // Face Selection editing — the green highlight follows the selected
      // Face Selection node's source geometry. The local pick set is seeded
      // once per node from its current *effective* selection (the formula
      // result before the first click), then becomes the operator's own
      // working set, committed to the node's `selectedFaces` param.
      const faceSelNode = !outputMode
        ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && n.type === FACE_SELECTION_NODE.type)
        : undefined;
      if (faceSelNode) {
        // The working set comes from the node's own stored `selectedFaces`
        // param, NOT from its evaluated `selection` output — same convention
        // as Points Selection's selectedIndices above, and for the same
        // reason: the evaluated output of a fresh node is the *formula*
        // result, which under the default "all" mode is every face, so
        // seeding from it would make the operator's first Shift+click hand
        // Extrude the entire mesh instead of the one face they clicked.
        const paramFaces = Array.isArray(faceSelNode.params.selectedFaces) ? (faceSelNode.params.selectedFaces as number[]) : [];
        const paramKey = paramFaces.join(",");
        if (faceSelectionNodeId !== faceSelNode.id || paramKey !== lastCommittedFaceKey) {
          faceSelectionNodeId = faceSelNode.id;
          selectedFacesSet = new Set<number>(paramFaces);
          lastCommittedFaceKey = paramKey;
          faceSelectionInteractive = faceSelNode.params.interactive === true;
        }
        faceSelectionSourceNodeId =
          graphRef.current.connections.find((c) => c.toNode === faceSelNode.id && c.toSocket === "geometry")?.fromNode ?? null;

        // What the green overlay shows is whatever is actually driving the
        // node's output: the operator's picks once interactive, otherwise a
        // live preview of the formula, so "Select: normal / Threshold" can be
        // dialled in visually before any clicking. Reading the picks from the
        // local set (rather than the evaluated result) keeps the highlight in
        // step with the click that just happened instead of a frame behind.
        let highlight: Set<number>;
        if (faceSelectionInteractive) {
          highlight = selectedFacesSet;
        } else {
          const rawSel = Array.isArray(results.get(faceSelNode.id)?.selection)
            ? (results.get(faceSelNode.id)!.selection as unknown[])
            : [];
          highlight = new Set<number>();
          rawSel.forEach((v, i) => {
            if (Boolean(v)) highlight.add(i);
          });
        }

        const srcObj = results.get(faceSelNode.id)?.geometry;
        const srcMesh = srcObj instanceof THREE.Object3D ? findFirstMesh(srcObj) : null;
        if (srcMesh) srcMesh.updateMatrixWorld(true);
        faceSelectionHandles.sync(srcMesh, highlight);
      } else if (faceSelectionNodeId !== null || faceSelectionHandles.count() > 0) {
        faceSelectionHandles.clear();
        faceSelectionNodeId = null;
        faceSelectionSourceNodeId = null;
        faceSelectionInteractive = false;
        lastCommittedFaceKey = "";
        selectedFacesSet.clear();
      }

      // Pivot Transform's single draggable pivot marker — see the comment by
      // pivotHandle's declaration for why it can't ride the normal gizmo.
      const selectedNodeForPivot = graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current);
      if (!outputMode && selectedNodeForPivot?.type === PIVOT_TRANSFORM_NODE.type) {
        pivotHandleNodeId = selectedNodeForPivot.id;
        const pivotPoint = asVector3(selectedNodeForPivot.params.pivot, new THREE.Vector3());
        // The same coordinate space `pivot` itself is defined in: whatever
        // feeds this node's own `matrix` input (its "base" — see
        // PIVOT_TRANSFORM_NODE's evaluate). Identity when nothing is wired,
        // matching that same fallback.
        const baseConnection = graphRef.current.connections.find(
          (c) => c.toNode === selectedNodeForPivot.id && c.toSocket === "matrix",
        );
        const baseObject = baseConnection ? results.get(baseConnection.fromNode)?.geometry : undefined;
        const pivotSpaceMatrix = new THREE.Matrix4();
        if (baseObject instanceof THREE.Object3D) {
          baseObject.updateWorldMatrix(true, false, true);
          pivotSpaceMatrix.copy(baseObject.matrixWorld);
        }
        pivotHandle.sync([pivotPoint], pivotSpaceMatrix, new Set([0]), null, false, camera, host.clientHeight);
      } else if (pivotHandle.count() > 0) {
        pivotHandle.clear();
        pivotHandleNodeId = null;
      }

      // Visual Slice's plane proxy — see its declaration above for why this
      // can't ride resolveGizmoTarget's normal object-pose path.
      if (!outputMode && selectedNodeForPivot?.type === VISUAL_SLICE_NODE.type) {
        sliceProxyNodeId = selectedNodeForPivot.id;
        sliceProxy.visible = true;
        // Not synced from params while a drag is live — that would fight
        // the drag itself with the pre-drag pose every frame.
        if (!transformControls?.dragging || transformControls.object !== sliceProxy) {
          const point = asVector3(selectedNodeForPivot.params.point, new THREE.Vector3());
          const direction = asVector3(selectedNodeForPivot.params.direction, SLICE_NORMAL_AXIS.clone());
          if (direction.lengthSq() < 1e-12) direction.copy(SLICE_NORMAL_AXIS);
          direction.normalize();
          sliceProxy.position.copy(point);
          sliceProxy.quaternion.setFromUnitVectors(SLICE_NORMAL_AXIS, direction);
        }
      } else if (sliceProxyNodeId) {
        sliceProxy.visible = false;
        sliceProxyNodeId = null;
      }

      // Clip Box's volume proxy — same contract as the slice plane above,
      // plus scale, since Box Size is part of the pose being dragged.
      if (!outputMode && selectedNodeForPivot?.type === CLIP_BOX_NODE.type) {
        clipBoxProxyNodeId = selectedNodeForPivot.id;
        clipBoxProxy.visible = true;
        if (!transformControls?.dragging || transformControls.object !== clipBoxProxy) {
          const location = asVector3(selectedNodeForPivot.params.location, new THREE.Vector3());
          const rotation = asVector3(selectedNodeForPivot.params.rotation, new THREE.Vector3());
          const size = asVector3(selectedNodeForPivot.params.size, new THREE.Vector3(1, 1, 1));
          clipBoxProxy.position.copy(location);
          clipBoxProxy.quaternion.setFromEuler(new THREE.Euler(rotation.x, rotation.y, rotation.z));
          // A zero on any axis collapses the proxy to nothing and leaves the
          // gizmo with no handle left to grab it back by.
          clipBoxProxy.scale.set(size.x || 1e-3, size.y || 1e-3, size.z || 1e-3);
        }
      } else if (clipBoxProxyNodeId) {
        clipBoxProxy.visible = false;
        clipBoxProxyNodeId = null;
      }

      // Decal's projector proxy — same contract as the clip box above.
      if (!outputMode && selectedNodeForPivot?.type === DECAL_NODE.type) {
        decalProxyNodeId = selectedNodeForPivot.id;
        decalProxy.visible = true;
        if (!transformControls?.dragging || transformControls.object !== decalProxy) {
          const location = asVector3(selectedNodeForPivot.params.location, new THREE.Vector3());
          const rotation = asVector3(selectedNodeForPivot.params.rotation, new THREE.Vector3());
          const size = asVector3(selectedNodeForPivot.params.scale, new THREE.Vector3(1, 1, 1));
          decalProxy.position.copy(location);
          decalProxy.quaternion.setFromEuler(new THREE.Euler(rotation.x, rotation.y, rotation.z));
          decalProxy.scale.set(size.x || 1e-3, size.y || 1e-3, size.z || 1e-3);
        }
      } else if (decalProxyNodeId) {
        decalProxy.visible = false;
        decalProxyNodeId = null;
      }

      // Force Field proxy — position and axis gizmo
      if (!outputMode && (selectedNodeForPivot?.type === "particles/force-field" || selectedNodeForPivot?.type === "particles/curl-noise")) {
        forceFieldProxyNodeId = selectedNodeForPivot.id;
        forceFieldProxy.visible = true;
        if (!transformControls?.dragging || transformControls.object !== forceFieldProxy) {
          const pos = asVector3(selectedNodeForPivot.params.position, new THREE.Vector3());
          const axis = asVector3(selectedNodeForPivot.params.axis, new THREE.Vector3(0, 1, 0)).clone().normalize();
          if (axis.lengthSq() < 1e-4) axis.set(0, 1, 0);
          forceFieldProxy.position.copy(pos);
          forceFieldProxy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
        }
      } else if (forceFieldProxyNodeId) {
        forceFieldProxy.visible = false;
        forceFieldProxyNodeId = null;
      }

      // Particle Emitter proxy — position and velocity gizmo
      if (!outputMode && selectedNodeForPivot?.type === "particles/emitter") {
        emitterProxyNodeId = selectedNodeForPivot.id;
        emitterProxy.visible = true;
        if (!transformControls?.dragging || transformControls.object !== emitterProxy) {
          const pos = asVector3(selectedNodeForPivot.params.position, new THREE.Vector3());
          const vel = asVector3(selectedNodeForPivot.params.velocity, new THREE.Vector3());
          const velLen = vel.length();
          emitterVelocityLength = velLen > 1e-4 ? velLen : 1;
          const dir = velLen > 1e-4 ? vel.clone().normalize() : new THREE.Vector3(0, 1, 0);
          emitterProxy.position.copy(pos);
          emitterProxy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        }
      } else if (emitterProxyNodeId) {
        emitterProxy.visible = false;
        emitterProxyNodeId = null;
      }

      // Update yellow pivot crosses for any object with showPivot === true
      if (!outputMode) {
        let activeCrossCount = 0;
        for (const node of graphRef.current.nodes) {
          if (node.params?.showPivot) {
            let cross = pivotCrossPool[activeCrossCount];
            if (!cross) {
              cross = new THREE.LineSegments(pivotCrossGeo, pivotCrossMat);
              cross.renderOrder = 99999;
              pivotCrossPool.push(cross);
              pivotCrossGroup.add(cross);
            }
            cross.visible = true;

            // Find object's world matrix
            let targetObj: THREE.Object3D | undefined;
            scene.traverse((obj) => {
              if (!targetObj && obj.userData?.nodeId === node.id) targetObj = obj;
            });
            const pivOffset =
              targetObj && targetObj.userData && targetObj.userData.pivot
                ? asVector3(targetObj.userData.pivot, new THREE.Vector3())
                : asVector3(node.params?.pivot, new THREE.Vector3());
            const foundObj: THREE.Object3D | undefined = targetObj;
            if (foundObj) {
              foundObj.updateWorldMatrix(true, false);
              cross.position.copy(pivOffset).applyMatrix4(foundObj.matrixWorld);
            } else {
              const loc = asVector3(node.params?.location, new THREE.Vector3());
              cross.position.copy(loc).add(pivOffset);
            }
            activeCrossCount++;
          }
        }
        for (let i = activeCrossCount; i < pivotCrossPool.length; i++) {
          pivotCrossPool[i].visible = false;
        }
      }

      // Move/rotate/scale gizmo: attach to selected mesh, Empty, Light,
      // to the picked control point / multi-point centroid proxy, or to the
      // pivot marker when a Pivot Transform is selected
      let targetObject: THREE.Object3D | null = null;
      let pickedCurveHandle: THREE.Object3D | null = null;
      if (transformControls) {
        if (selectedPointIndices.size === 1) {
          const singleIdx = Array.from(selectedPointIndices)[0];
          pickedCurveHandle = curveHandles.handleAt(singleIdx);
        } else if (selectedPointIndices.size > 1) {
          pickedCurveHandle = curveHandles.getCentroidHandle();
        } else if (pivotHandleNodeId) {
          pickedCurveHandle = pivotHandle.handleAt(0);
        } else if (sliceProxyNodeId) {
          pickedCurveHandle = sliceProxy;
        } else if (clipBoxProxyNodeId) {
          pickedCurveHandle = clipBoxProxy;
        } else if (decalProxyNodeId) {
          pickedCurveHandle = decalProxy;
        } else if (forceFieldProxyNodeId) {
          pickedCurveHandle = forceFieldProxy;
        } else if (emitterProxyNodeId) {
          pickedCurveHandle = emitterProxy;
        }
      }

      if (transformControls && !transformControls.dragging && pickedCurveHandle) {
        targetObject = pickedCurveHandle;
        if (transformControls.object !== pickedCurveHandle) transformControls.attach(pickedCurveHandle);
        transformControls.setMode(transformModeRef.current);
        attachedObjectNodeId = null;
        attachedGizmoTarget = null;
        for (const parked of [...gizmoAnchorScene.children]) gizmoAnchorScene.remove(parked);
      } else if (transformControls && !transformControls.dragging) {
        const isGp = selectedNodeIdRef.current
          ? isPaintOrGreaseNode(graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current))
          : false;
        if (selectedNodeIdRef.current) {
          // The selected node's own result first — it is the authoritative
          // answer to "which object does this node drive", and the only one
          // that can't be a copy. The scene traversals below match on
          // `userData.nodeId`, which Object3D.clone() duplicates along with
          // everything else in userData: an Array's 16 copies of a Box, or a
          // Look At wrapper's clone of its input, each carry the *source*
          // node's id. Searching the scene first therefore latched the gizmo
          // onto whichever clone happened to be reached first, so dragging
          // moved a copy that the graph overwrote on the next frame while
          // the params were written back to a node whose real object never
          // moved. They stay as fallbacks for nodes with no geometry output
          // of their own (lights, camera helpers).
          if (isGp && gpToolRef.current !== "select") {
            targetObject = null;
            if (transformControls.object) transformControls.detach();
            if (gizmoPivotProxyNodeId) {
              gizmoPivotProxy.visible = false;
              gizmoPivotProxyNodeId = null;
              gizmoPivotProxyRealObject = null;
            }
          } else {
            const ownResult = results.get(selectedNodeIdRef.current);
            if (ownResult?.geometry instanceof THREE.Object3D) {
              targetObject = ownResult.geometry;
            }
            if (!targetObject) {
              const light = activeLights.get(selectedNodeIdRef.current);
              if (light) targetObject = light;
            }
            if (!targetObject) {
              const camHelper = activeCameraHelpers.get(selectedNodeIdRef.current);
              if (camHelper) targetObject = camHelper;
            }
            if (!targetObject) {
              scene.traverse((obj) => {
                if (!targetObject && obj.userData.nodeId === selectedNodeIdRef.current) targetObject = obj;
              });
            }
          }
        }
        const gizmoTarget = targetObject ? resolveGizmoTarget(graphRef.current, selectedNodeIdRef.current!) : null;

        if (targetObject && gizmoTarget) {
          if (gizmoTarget.kind === "native") {
            gizmoPivotProxyNodeId = selectedNodeIdRef.current;
            gizmoPivotProxyRealObject = targetObject;
            gizmoPivotProxy.visible = true;

            if (!transformControls?.dragging || transformControls.object !== gizmoPivotProxy) {
              targetObject.updateWorldMatrix(true, false);
              const node = graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current);
              const pivOffset =
                targetObject.userData && targetObject.userData.pivot
                  ? asVector3(targetObject.userData.pivot, new THREE.Vector3())
                  : asVector3(node?.params?.pivot, new THREE.Vector3());
              const worldPivot = pivOffset.clone().applyMatrix4(targetObject.matrixWorld);
              gizmoPivotProxy.position.copy(worldPivot);
              targetObject.getWorldQuaternion(gizmoPivotProxy.quaternion);
              targetObject.getWorldScale(gizmoPivotProxy.scale);
              gizmoPivotProxy.updateMatrixWorld(true);
            }

            if (attachedObjectNodeId !== selectedNodeIdRef.current || transformControls.object !== gizmoPivotProxy) {
              transformControls.attach(gizmoPivotProxy);
              attachedObjectNodeId = selectedNodeIdRef.current;
            }
            attachedGizmoTarget = gizmoTarget;
            targetObject = gizmoPivotProxy;
          } else {
            if (gizmoPivotProxyNodeId) {
              gizmoPivotProxy.visible = false;
              gizmoPivotProxyNodeId = null;
              gizmoPivotProxyRealObject = null;
            }
            // Give a parentless target a home before attaching — see
            // gizmoAnchorScene's own comment for why TransformControls cannot
            // work with one that has no parent.
            if (!targetObject.parent) {
              gizmoAnchorScene.add(targetObject);
            }

            // Re-attach when the *object* changes too, not just the selection:
            // a node that rebuilds its mesh (Text on an edit, Line Graph on a
            // new point count) hands back a different instance under the same
            // node id, and the gizmo would otherwise stay bound to the
            // discarded one and appear to drag nothing.
            if (attachedObjectNodeId !== selectedNodeIdRef.current || transformControls.object !== targetObject) {
              transformControls.attach(targetObject);
              attachedObjectNodeId = selectedNodeIdRef.current;
            }
            attachedGizmoTarget = gizmoTarget;
          }
          transformControls.setMode(transformModeRef.current);
          if (mode2D) {
            transformControls.showX = true;
            transformControls.showY = false;
            transformControls.showZ = true;
            if (transformModeRef.current === "rotate") {
              transformControls.showX = false;
              transformControls.showY = true;
              transformControls.showZ = false;
            } else if (transformModeRef.current === "scale") {
              transformControls.showX = true;
              transformControls.showY = false;
              transformControls.showZ = true;
            }
          } else if (elevationView) {
            if (isGp) {
              transformControls.showX = true;
              transformControls.showY = true;
              transformControls.showZ = true;
            } else {
              transformControls.showX = false;
              transformControls.showY = true;
              transformControls.showZ = false;
            }
          } else {
            transformControls.showX = true;
            transformControls.showY = true;
            transformControls.showZ = true;
          }

          // object.ts drives these meshes by `matrix.copy(...)` with
          // matrixAutoUpdate off, which never touches position/quaternion/
          // scale — they sit at their defaults (origin, identity, 1) no
          // matter where the graph actually puts the object. TransformControls
          // reads exactly those on pointerdown (`_positionStart.copy(
          // object.position)`) and then sets `position = offset +
          // _positionStart`, so a drag started from the origin instead of the
          // object's real pose: the mesh snapped to its untransformed self
          // for the duration of the drag, then jumped back when the graph
          // reclaimed the matrix on release.
          //
          // Refreshed every frame rather than once at attach, so an object
          // being animated by the graph is still handed the pose it actually
          // has the moment a drag begins. This block only runs while the
          // gizmo is *not* dragging, so it can never fight the drag itself.
          if (targetObject !== gizmoPivotProxy && !targetObject.matrixAutoUpdate) {
            targetObject.matrix.decompose(targetObject.position, targetObject.quaternion, targetObject.scale);
          }

          // Nothing traverses the parking scene during rendering, so its
          // contents' matrixWorld would otherwise stay at whatever it was
          // when the object was last drawn — or identity if it never was.
          // TransformControls does all of its drag math in world space, so a
          // stale one is what makes a drag come out wrong rather than
          // simply not start. (`matrix.copy()` never sets
          // matrixWorldNeedsUpdate, so this has to be forced.)
          if (targetObject.parent === gizmoAnchorScene) {
            gizmoAnchorScene.updateMatrixWorld(true);
          }
        } else if (transformControls.object) {
          // `transformControls.object` rather than attachedObjectNodeId: the
          // gizmo may currently be holding a curve point handle, which owns no
          // node id of its own.
          transformControls.detach();
          attachedObjectNodeId = null;
          attachedGizmoTarget = null;
          if (gizmoPivotProxyNodeId) {
            gizmoPivotProxy.visible = false;
            gizmoPivotProxyNodeId = null;
            gizmoPivotProxyRealObject = null;
          }
        }

        // Release anything left parked once it is no longer the gizmo's
        // target — the parking scene should only ever hold the object being
        // edited right now. (An object that goes back to being drawn gets
        // reparented by scene.add() anyway; this just keeps the scene from
        // accumulating every object ever selected.)
        for (const parked of [...gizmoAnchorScene.children]) {
          if (parked !== targetObject) gizmoAnchorScene.remove(parked);
        }
      }

      if (transformControls?.dragging && transformControls.object) {
        targetObject = transformControls.object;
      }

      // Sync Environment & HDRI / Background Color
      const renderResult = results.get(renderNodeIdRef.current);
      const activeEnv = resolveActiveEnvironment(results, renderNodeIdRef.current);
      const applyEnv = outputMode || showEnvInEditorRef.current;
      applyEnvironment(
        applyEnv ? activeEnv : null,
        { scene, bgScene, fallbackBackground: viewportBackground, ambientLight, sunLight },
        backgroundBlur,
        host.clientWidth,
        host.clientHeight,
      );

      // Toggle helper visibility (AxesHelper / Empty crosshairs / camera
      // frustums / Light target helpers). Controlled by showUiOverlay (Tab),
      // and always hidden in the physical output window.
      const hideSceneHelpers = outputMode || !showUiOverlayRef.current;
      scene.traverse((obj) => {
        if (obj.userData?.isHelper || obj instanceof THREE.AxesHelper || obj instanceof THREE.CameraHelper) {
          obj.visible = !hideSceneHelpers;
        }
      });

      // 1. Render Main Scene (with Post-Processing pipeline if active)
      const width = host.clientWidth;
      const height = host.clientHeight;

      let viewX = 0;
      let viewY = 0;
      let viewWidth = width;
      let viewHeight = height;

      const targetAspect = typeof renderResult?.aspect === "number" && renderResult.aspect > 0 ? (renderResult.aspect as number) : null;

      if ((outputMode || isCameraViewRef.current) && targetAspect && targetAspect > 0) {
        const containerAspect = width / height;
        if (containerAspect > targetAspect) {
          viewHeight = height;
          viewWidth = height * targetAspect;
          viewX = (width - viewWidth) / 2;
        } else {
          viewWidth = width;
          viewHeight = width / targetAspect;
          viewY = (height - viewHeight) / 2;
        }
        if (camera instanceof THREE.PerspectiveCamera) {
          if (camera.aspect !== targetAspect) {
            camera.aspect = targetAspect;
            camera.updateProjectionMatrix();
          }
        }
      } else if (camera instanceof THREE.PerspectiveCamera && !projectionOverridden) {
        const aspect = width / height;
        if (camera.aspect !== aspect) {
          camera.aspect = aspect;
          camera.updateProjectionMatrix();
        }
      }

      // Passe-partout guide: the editor's own camera keeps this pane's live
      // aspect ratio (free orbit, unconstrained by any Camera node — see the
      // comment above the calibrationMatrix branch), but "Aligner Caméra"
      // captures only the vertical FOV, which reproduces the wrong framing
      // whenever the output's aspect (targetAspect) differs from this pane's.
      // Drawing the target-aspect crop as a guide, rather than actually
      // letterboxing the editor's render, lets you compose within the
      // correct bounds before hitting Align without losing free navigation.
      const guideEl = cameraGuideRef.current;
      if (guideEl) {
        const selectedIsCamera =
          !!selectedNodeIdRef.current &&
          graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current)?.type === CAMERA_NODE.type;
        if (!outputMode && !isCameraViewRef.current && selectedIsCamera && targetAspect && targetAspect > 0) {
          const containerAspect = width / height;
          let guideWidth = width;
          let guideHeight = height;
          if (containerAspect > targetAspect) {
            guideHeight = height;
            guideWidth = height * targetAspect;
          } else {
            guideWidth = width;
            guideHeight = width / targetAspect;
          }
          guideEl.style.display = "block";
          guideEl.style.width = `${guideWidth}px`;
          guideEl.style.height = `${guideHeight}px`;
          guideEl.style.left = `${(width - guideWidth) / 2}px`;
          guideEl.style.top = `${(height - guideHeight) / 2}px`;
        } else {
          guideEl.style.display = "none";
        }
      }

      renderer.setViewport(viewX, viewY, viewWidth, viewHeight);
      renderer.setScissor(viewX, viewY, viewWidth, viewHeight);
      renderer.setScissorTest((outputMode || isCameraViewRef.current) && targetAspect !== null);

      // The HUD must map onto the actual rendered frame. When a render node
      // defines a target aspect, that region (possibly letterboxed) is the
      // frame HUD coordinates live in — in the editor's camera view the 3D
      // render still fills the pane, but snapping the HUD to the target-aspect
      // region keeps positions pixel-exact against the exported frame. Kept in
      // a ref for the drag handlers and mirrored to state so React re-renders.
      let frameX = 0;
      let frameY = 0;
      let frameW = width;
      let frameH = height;
      if (targetAspect && targetAspect > 0) {
        const containerAspect = width / height;
        if (containerAspect > targetAspect) {
          frameH = height;
          frameW = height * targetAspect;
          frameX = (width - frameW) / 2;
        } else {
          frameW = width;
          frameH = width / targetAspect;
          frameY = (height - frameH) / 2;
        }
      }
      const frame = { x: frameX, y: frameY, width: frameW, height: frameH };
      renderFrameRef.current = frame;
      if (
        renderFrameStateRef.current.x !== frame.x ||
        renderFrameStateRef.current.y !== frame.y ||
        renderFrameStateRef.current.width !== frame.width ||
        renderFrameStateRef.current.height !== frame.height
      ) {
        renderFrameStateRef.current = frame;
        setRenderFrame(frame);
      }

      const postConfigs = Array.isArray(renderResult?.postprocess)
        ? (renderResult.postprocess as PostProcessConfig[])
        : [];

      // Motion blur lives on the Render node itself rather than in the
      // postprocess chain (it's a property of the output, not an effect a
      // graph wires up), so it can switch the composer path on by itself
      // even with no postprocess node connected at all.
      const motionBlur = typeof renderResult?.motionBlur === "number" ? renderResult.motionBlur : 0;

      if (postChain.isActive(postConfigs, motionBlur)) {
        postChainWasActive = true;
        scene.background = bgScene.background;
        postChain.render({
          scene,
          camera,
          configs: postConfigs,
          motionBlur,
          width,
          height,
          outlineTarget: currentObject,
          time: clock.time,
        });
      } else {
        // Nothing in the chain this frame — release the passes once we actually
        // turn the chain off (not every idle frame, which would re-allocate all
        // the cached passes the moment an effect switches back on).
        if (postChainWasActive) {
          postChain.dispose();
          postChainWasActive = false;
        }

        scene.fog = null;
        scene.background = bgScene.background;
        (scene as any).backgroundBlurriness = (bgScene as any).backgroundBlurriness ?? 0;
        renderer.clear();
        renderer.render(scene, camera);
      }

      // 1b. Render Editor UI Overlay (Grid, Transform Controls, Light Helpers) - isolated from Postprocess
      if (!outputMode && showUiOverlayRef.current) {
        elevationHUD.update(targetObject, Boolean(elevationView));
        renderer.clearDepth();
        renderer.render(editorUiScene, camera);
      }

      // 2. Render Corner 3D Orientation Gizmo HUD (110x110 px in bottom-left)
      if (gizmo && !outputMode && showUiOverlayRef.current) {
        const gizmoSize = 110;
        renderer.clearDepth();
        renderer.setScissorTest(true);
        renderer.setScissor(12, 12, gizmoSize, gizmoSize);
        renderer.setViewport(12, 12, gizmoSize, gizmoSize);
        renderer.render(gizmo.gizmoScene, gizmo.gizmoCamera);
        renderer.setScissorTest(false);
      }

      if (capture) {
        // Hold the frame until every HUD image has decoded — the capture is
        // only resolved below, so exportVideo simply waits one more tick and
        // this same frame index is rendered again. Bounded so a broken image
        // can never wedge the export.
        capture.waited = (capture.waited ?? 0) + 1;
        if (capture.waited < MAX_CAPTURE_WAIT_TICKS && !hubImagesReady(collectedHub)) {
          return;
        }
        // Composite the WebGL frame + the 2D HUD overlay onto the export
        // canvas, which is what MediaRecorder actually captures.
        if (exportCtx) {
          const src = renderer.domElement;
          exportCtx.clearRect(0, 0, exportCanvas.width, exportCanvas.height);
          // Scale the (possibly dpr-sized) WebGL frame to fill the export
          // canvas, preserving aspect.
          const scale = Math.min(
            exportCanvas.width / Math.max(1, src.width),
            exportCanvas.height / Math.max(1, src.height),
          );
          const dw = src.width * scale;
          const dh = src.height * scale;
          const dx = (exportCanvas.width - dw) / 2;
          const dy = (exportCanvas.height - dh) / 2;
          exportCtx.drawImage(src, dx, dy, dw, dh);
          const rs = renderSizeRef.current;
          if (rs && rs.width > 0 && rs.height > 0) {
            const sx = exportCanvas.width / rs.width;
            const sy = exportCanvas.height / rs.height;
            exportCtx.save();
            exportCtx.scale(sx, sy);
            for (const el of collectedHub) drawHubElement(exportCtx, el, rs.width, rs.height);
            exportCtx.restore();
          }
        }
        pendingCaptureRef.current = null;
        capture.resolve();
      }
    }

    frameId = requestAnimationFrame(tick);

    return () => {
      isDisposed = true;
      cancelAnimationFrame(frameId);
      disposeEvalSession(sessionIdRef.current);
      unregisterPointerViewport();
      resizeObserver.disconnect();
      if (!outputMode) {
        renderer.domElement.removeEventListener("pointerdown", onCanvasPointerDown, { capture: true });
        window.removeEventListener("pointermove", onCanvasPointerMove);
        window.removeEventListener("pointerup", onCanvasPointerUp);
        window.removeEventListener("pointercancel", onCanvasPointerUp);
        removeContextMenu?.();
        controls.removeEventListener("start", handleOrbitStart);
        controls.removeEventListener("change", emitCameraPose);
        window.removeEventListener("keydown", onSnapKeyDown);
        window.removeEventListener("keydown", onViewportKeyDown);
        window.removeEventListener("keyup", onSnapKeyUp);
        window.removeEventListener("blur", onSnapWindowBlur);
      }
      transformControls?.dispose();
      elevationHUD.dispose();
      curveHandles.clear();
      pointsSelectionHandles.clear();
      pointsInfluenceHandles.clear();
      pivotHandle.clear();
      sliceProxy.removeFromParent();
      sliceVisualGeometry.dispose();
      sliceVisual.material.dispose();
      sliceVisualEdges.geometry.dispose();
      sliceVisualEdges.material.dispose();
      clipBoxProxy.removeFromParent();
      clipBoxGeometry.dispose();
      clipBoxVisual.material.dispose();
      clipBoxEdges.geometry.dispose();
      clipBoxEdges.material.dispose();
      decalProxy.removeFromParent();
      decalProxyGeometry.dispose();
      decalProxyEdges.geometry.dispose();
      decalProxyEdges.material.dispose();
      decalProxyFace.geometry.dispose();
      decalProxyFace.material.dispose();
      forceFieldProxy.removeFromParent();
      forceFieldCoreGeo.dispose();
      forceFieldCoreMat.dispose();
      forceFieldRingGeo.dispose();
      forceFieldRingMat.dispose();
      emitterProxy.removeFromParent();
      emitterCoreGeo.dispose();
      emitterCoreMat.dispose();
      emitterRingGeo.dispose();
      emitterRingMat.dispose();
      gizmoPivotProxy.removeFromParent();
      pivotCrossGroup.removeFromParent();
      pivotCrossGeo.dispose();
      pivotCrossMat.dispose();
      controls.dispose();
      // Per-viewport editor furniture (grid/axes, corner gizmo, zoom-scrub
      // bar) is not part of the shared per-node caches — it is built fresh for
      // this viewport and must release its GPU buffers on unmount, or every
      // StrictMode remount / split-view toggle leaks geometry & materials.
      if (gridAndAxes) disposeMainSceneGridAndAxes(gridAndAxes);
      if (gizmo) disposeGizmoScene(gizmo);
      // These objects are cached per node id at module scope and outlive
      // this viewport (see nodeCaches.ts) — hand them back rather than
      // leaving them parented to a scene that's about to be thrown away.
      sceneContents.clear();
      editorHelpers.clear();
      // Lights get the same hand-back treatment as the geometry above:
      // without it a cached light would keep pointing at this dead scene,
      // and the next viewport's `!light.parent` guard would refuse to add
      // it — the very "lights stay off after closing the split view" bug.
      // In outputMode the entries are this pane's own disposable clones;
      // detach those too and free their shadow render targets.
      for (const [, light] of activeLights) {
        if (light.parent === scene) {
          scene.remove(light);
        }
        const target = (light as THREE.DirectionalLight | THREE.SpotLight).target;
        if (target && target.parent === scene) {
          scene.remove(target);
        }
        if (outputMode) {
          light.dispose();
        }
      }
      for (const helper of activeLightHelpers.values()) {
        if (helper.parent) {
          helper.parent.remove(helper);
        }
        // Light helpers own their own geometry/material; release them here.
        disposeObject3D(helper);
      }
      activeLights.clear();
      activeLightHelpers.clear();
      postChain.dispose();
      viewportBackground.dispose();
      motionBlurEffect.dispose();
      backgroundBlur.dispose();
      renderer.dispose();
      if (host.contains(renderer.domElement)) {
        host.removeChild(renderer.domElement);
      }
    };
  }, [epochMs, outputMode]);

  // "F" frames the selected object — only while the mouse is actually over
  // this pane (its own "F" binding lives in GraphEditor.tsx for the canvas).
  useEffect(() => {
    if (outputMode) return;
    const handleFrameKey = (e: KeyboardEvent) => {
      if (!isViewportZone() || e.key.toLowerCase() !== "f" || e.metaKey || e.ctrlKey || e.altKey) return;
      const activeEl = document.activeElement;
      const isInput =
        activeEl &&
        (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA" || (activeEl as HTMLElement).isContentEditable);
      if (isInput || !selectedNodeIdRef.current) return;
      e.preventDefault();
      focusOnNodeRef.current(selectedNodeIdRef.current);
    };
    window.addEventListener("keydown", handleFrameKey);
    return () => window.removeEventListener("keydown", handleFrameKey);
  }, [outputMode]);

  return (
    <div
      className="viewport-container"
      ref={hostRef}
      onMouseEnter={outputMode ? undefined : () => setInputZone("viewport")}
      onMouseLeave={outputMode ? undefined : () => setInputZone(null)}
    >
      {/* Rectangular Marquee Selection Overlay (Cmd+Drag) */}
      {!outputMode && marqueeBox && (
        <div
          style={{
            position: "absolute",
            left: `${marqueeBox.left}px`,
            top: `${marqueeBox.top}px`,
            width: `${marqueeBox.width}px`,
            height: `${marqueeBox.height}px`,
            border: "1.5px dashed #38bdf8",
            backgroundColor: "rgba(56, 189, 248, 0.18)",
            pointerEvents: "none",
            zIndex: 40,
          }}
        />
      )}
      {/* Points Influence — the 5 preset level buttons, shared by Brush
          (caps each dab's strength) and Discrete (the flat value a
          click/marquee assigns). Gradient mode has no use for a fixed
          level — its whole point is a continuous 0-1 sweep — so no HUD
          there; Brush Radius still lives in ParamPanel like any other
          param. */}
      {!outputMode &&
        selectedNodeId &&
        (() => {
          const infNode = graph.nodes.find((n) => n.id === selectedNodeId && n.type === POINTS_INFLUENCE_NODE.type);
          if (!infNode || (infNode.params.mode !== "discrete" && infNode.params.mode !== "brush")) return null;
          const activeLevel = typeof infNode.params.activeLevel === "number" ? infNode.params.activeLevel : POINTS_INFLUENCE_DISCRETE_LEVELS[2];
          return (
            <div className="viewport-influence-hud">
              <span className="viewport-influence-hud-label">Influence</span>
              {POINTS_INFLUENCE_DISCRETE_LEVELS.map((level, i) => (
                <button
                  key={level}
                  type="button"
                  className={`viewport-influence-hud-level ${activeLevel === level ? "viewport-influence-hud-level-active" : ""}`}
                  style={{ backgroundColor: `#${DISCRETE_LEVEL_COLORS[i].toString(16).padStart(6, "0")}` }}
                  title={
                    infNode.params.mode === "brush"
                      ? `${Math.round(level * 100)}% — caps how strong Cmd+drag paints, Shift to erase`
                      : `${Math.round(level * 100)}% — Cmd-click/marquee a point to assign, Shift to erase`
                  }
                  onClick={() => onTransformChange?.(infNode.id, { activeLevel: level })}
                >
                  {Math.round(level * 100)}
                </button>
              ))}
            </div>
          );
        })()}
      {/* Gradient mode's live drag preview — a straight line from the
          Cmd-drag's start to the current cursor, matching the marquee
          overlay's z-index/pointer-events convention. */}
      {!outputMode && gradientLine && (
        <svg
          style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 40 }}
          width="100%"
          height="100%"
        >
          <line
            x1={gradientLine.x1}
            y1={gradientLine.y1}
            x2={gradientLine.x2}
            y2={gradientLine.y2}
            stroke="#38bdf8"
            strokeWidth={2}
            strokeDasharray="6 4"
          />
          <circle cx={gradientLine.x1} cy={gradientLine.y1} r={4} fill="#2563eb" />
          <circle cx={gradientLine.x2} cy={gradientLine.y2} r={4} fill="#ef4444" />
        </svg>
      )}
      {/* Grease Pencil live stroke drag preview */}
      {!outputMode && isGpDrawing && gpLivePreview.length > 1 && (
        <svg
          style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 42 }}
          width="100%"
          height="100%"
        >
          {gpSolidFill && gpLivePreview.length >= 3 && (
            <polygon
              points={gpLivePreview.map((p) => `${p.screenX},${p.screenY}`).join(" ")}
              fill={
                parseColorHex(
                  graph.nodes.find((n) => n.id === selectedNodeId)?.params.fillColor,
                  "",
                ) ||
                parseColorHex(
                  graph.nodes.find((n) => n.id === selectedNodeId)?.params.activeColor,
                  "#38bdf8",
                )
              }
              fillOpacity={0.35}
            />
          )}
          <polyline
            points={gpLivePreview.map((p) => `${p.screenX},${p.screenY}`).join(" ")}
            fill="none"
            stroke={parseColorHex(
              graph.nodes.find((n) => n.id === selectedNodeId)?.params.activeColor,
              "#38bdf8",
            )}
            strokeWidth={
              Number(graph.nodes.find((n) => n.id === selectedNodeId)?.params.brushSize) || 4
            }
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {/* Passe-partout guide: target-output-aspect crop, shown while a Camera
          node is selected so "Aligner Caméra" reproduces what's actually
          framed — see the comment in tick() next to cameraGuideRef. */}
      {!outputMode && <div className="viewport-camera-guide" ref={cameraGuideRef} />}
      {/* Grease Pencil Floating Toolbar */}
      {!outputMode &&
        !elevationView &&
        selectedNodeId &&
        (() => {
          const gpNode = graph.nodes.find(
            (n) => n.id === selectedNodeId && isPaintOrGreaseNode(n),
          );
          if (!gpNode) return null;
          const activeColor = parseColorHex(gpNode.params.activeColor, "#38bdf8");
          const fillColor = parseColorHex(gpNode.params.fillColor, "");
          const brushSize = Number(gpNode.params.brushSize) || 4;
          const onionSkin = Boolean(gpNode.params.onionSkin ?? true);

          return (
            <div
              className="viewport-gp-hud"
              style={{
                position: "absolute",
                bottom: 16,
                left: "50%",
                transform: "translateX(-50%)",
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "5px 12px",
                background: "rgba(24, 28, 38, 0.95)",
                backdropFilter: "blur(12px)",
                border: "1px solid rgba(56, 189, 248, 0.4)",
                borderRadius: "8px",
                boxShadow:
                  "0 8px 24px rgba(0, 0, 0, 0.5), 0 0 16px rgba(56, 189, 248, 0.2)",
                color: "#ffffff",
                fontSize: "12px",
                zIndex: 45,
                pointerEvents: "auto",
              }}
            >
              {/* Frame Indicator */}
              <div
                style={{
                  fontSize: "11px",
                  fontWeight: 700,
                  color: "#38bdf8",
                  padding: "2px 8px",
                  background: "rgba(56, 189, 248, 0.15)",
                  borderRadius: "4px",
                  letterSpacing: "0.02em",
                  userSelect: "none",
                }}
                title="Current frame"
              >
                {currentFrame >= 0 ? currentFrame : 0}
              </div>

              <div
                style={{
                  width: 1,
                  height: 16,
                  background: "rgba(255, 255, 255, 0.15)",
                }}
              />

              {/* Tool: Pen */}
              <button
                type="button"
                className={`viewport-hud-button ${gpTool === "pen" ? "viewport-hud-button-active" : ""}`}
                onClick={() => setGpTool("pen")}
                title="Pen (freehand drawing — hold Shift at start/end to taper)"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  <path d="m15 5 4 4" />
                </svg>
              </button>

              {/* Brush Preset Selector */}
              <select
                value={gpBrushType}
                onChange={(e) => {
                  const b = e.target.value as GreaseBrushType;
                  setGpBrushType(b);
                  onParamChange?.("brushType", b, gpNode.id);
                }}
                style={{
                  background: "rgba(255, 255, 255, 0.08)",
                  color: "#f1f5f9",
                  border: "1px solid rgba(255, 255, 255, 0.15)",
                  borderRadius: 4,
                  fontSize: "11px",
                  height: 24,
                  padding: "0 6px",
                  outline: "none",
                  cursor: "pointer",
                }}
                title="Brush preset: Ink Pen, Ink Pen Rough, Marker Bold, Airbrush"
              >
                <option value="ink_pen" style={{ background: "#1e293b", color: "#fff" }}>Ink Pen</option>
                <option value="ink_pen_rough" style={{ background: "#1e293b", color: "#fff" }}>Ink Pen Rough</option>
                <option value="marker_bold" style={{ background: "#1e293b", color: "#fff" }}>Marker Bold</option>
                <option value="airbrush" style={{ background: "#1e293b", color: "#fff" }}>Airbrush</option>
              </select>

              {/* Solid Fill Toggle */}
              <button
                type="button"
                className={`viewport-hud-button ${gpSolidFill ? "viewport-hud-button-active" : ""}`}
                onClick={() => {
                  const next = !gpSolidFill;
                  setGpSolidFill(next);
                  onParamChange?.("solidFill", next, gpNode.id);
                }}
                title="Solid Fill (toggle shape interior fill)"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill={gpSolidFill ? "currentColor" : "none"}
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="12 2 2 22 22 22" />
                </svg>
              </button>

              {/* Tool: Hard Eraser */}
              <button
                type="button"
                className={`viewport-hud-button ${gpTool === "eraser_hard" ? "viewport-hud-button-active" : ""}`}
                onClick={() => setGpTool("eraser_hard")}
                title="Hard Eraser (erase entire stroke on contact)"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
                  <path d="M22 21H7" />
                  <path d="m5 11 9 9" />
                </svg>
              </button>

              {/* Tool: Soft Eraser */}
              <button
                type="button"
                className={`viewport-hud-button ${gpTool === "eraser_soft" ? "viewport-hud-button-active" : ""}`}
                onClick={() => setGpTool("eraser_soft")}
                title="Soft Eraser (gradually thin and fade strokes)"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray="2 2"
                >
                  <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
                  <path d="M22 21H7" strokeDasharray="none" />
                  <path d="m5 11 9 9" />
                </svg>
              </button>

              {/* Tool: Tint */}
              <button
                type="button"
                className={`viewport-hud-button ${gpTool === "tint" ? "viewport-hud-button-active" : ""}`}
                onClick={() => setGpTool("tint")}
                title="Tint (paint over strokes to blend their color with active color)"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11Z" />
                  <path d="m5 2 5 5" />
                  <circle cx="19" cy="19" r="3" />
                </svg>
              </button>

              <div
                style={{
                  width: 1,
                  height: 16,
                  background: "rgba(255, 255, 255, 0.15)",
                }}
              />

              {/* Stroke Color picker */}
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  cursor: "pointer",
                }}
                title="Stroke color (outline)"
              >
                <input
                  type="color"
                  value={activeColor}
                  onChange={(e) =>
                    onParamChange?.("activeColor", e.target.value, gpNode.id)
                  }
                  style={{
                    width: 18,
                    height: 18,
                    padding: 0,
                    border: "1px solid rgba(255,255,255,0.4)",
                    borderRadius: "50%",
                    cursor: "pointer",
                    backgroundColor: "transparent",
                  }}
                />
              </label>

              {/* Fill Color picker */}
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  cursor: "pointer",
                  opacity: gpSolidFill ? 1 : 0.4,
                }}
                title={gpSolidFill ? "Fill color (interior shape color)" : "Fill color (enable Solid Fill to activate)"}
              >
                <input
                  type="color"
                  value={fillColor || activeColor}
                  onChange={(e) =>
                    onParamChange?.("fillColor", e.target.value, gpNode.id)
                  }
                  style={{
                    width: 18,
                    height: 18,
                    padding: 0,
                    border: "1px solid rgba(255,255,255,0.4)",
                    borderRadius: 4,
                    cursor: "pointer",
                    backgroundColor: "transparent",
                  }}
                />
              </label>

              {/* Brush Size Slider */}
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span
                  style={{
                    fontSize: "11px",
                    color: "#94a3b8",
                    minWidth: 24,
                    textAlign: "right",
                  }}
                >
                  {brushSize}px
                </span>
                <input
                  type="range"
                  min={1}
                  max={32}
                  value={brushSize}
                  onChange={(e) =>
                    onParamChange?.(
                      "brushSize",
                      Number(e.target.value),
                      gpNode.id,
                    )
                  }
                  style={{
                    width: 56,
                    accentColor: "#38bdf8",
                    cursor: "pointer",
                  }}
                  title="Brush thickness"
                />
              </div>

              <div
                style={{
                  width: 1,
                  height: 16,
                  background: "rgba(255, 255, 255, 0.15)",
                }}
              />

              {/* Stroke Smoothing Slider */}
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span
                  style={{
                    fontSize: "11px",
                    color: "#94a3b8",
                    minWidth: 42,
                    textAlign: "right",
                  }}
                  title="Stroke smoothing to remove involuntary hand tremors"
                >
                  Smooth {Math.round(Math.max(0, Math.min(1, Number(gpNode.params.smoothing ?? 0.2))) * 100)}%
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={Math.max(0, Math.min(1, Number(gpNode.params.smoothing ?? 0.2)))}
                  onChange={(e) =>
                    onParamChange?.(
                      "smoothing",
                      Number(e.target.value),
                      gpNode.id,
                    )
                  }
                  style={{
                    width: 50,
                    accentColor: "#38bdf8",
                    cursor: "pointer",
                  }}
                  title="Stroke smoothing (eliminates involuntary hand tremors during drawing)"
                />
              </div>

              <div
                style={{
                  width: 1,
                  height: 16,
                  background: "rgba(255, 255, 255, 0.15)",
                }}
              />

              {/* Lock / Keyframe Button */}
              <button
                type="button"
                className="viewport-hud-button"
                onClick={() => {
                  const currentFrames =
                    (gpNode.params.frames as KeyframeDrawing[]) || [];
                  const targetFrame =
                    currentFrame >= 0 ? currentFrame : 0;
                  const updated = duplicateDrawing(
                    currentFrames,
                    targetFrame,
                    targetFrame,
                  );
                  onParamChange?.("frames", updated, gpNode.id);
                }}
                title="Insert keyframe at current frame"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </button>

              {/* Blank Next Button */}
              <button
                type="button"
                className="viewport-hud-button"
                onClick={() => {
                  const targetFrame =
                    (currentFrame >= 0 ? currentFrame : 0) + 1;
                  const currentFrames =
                    (gpNode.params.frames as KeyframeDrawing[]) || [];
                  const updated = createBlankDrawing(
                    currentFrames,
                    targetFrame,
                  );
                  onParamChange?.("frames", updated, gpNode.id);
                  onFrameChange?.(targetFrame);
                }}
                title="Blank keyframe at next frame"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 12h14" />
                  <path d="m12 5 7 7-7 7" />
                </svg>
              </button>

              {/* Duplicate Next Button */}
              <button
                type="button"
                className="viewport-hud-button"
                onClick={() => {
                  const curF = currentFrame >= 0 ? currentFrame : 0;
                  const targetFrame = curF + 1;
                  const currentFrames =
                    (gpNode.params.frames as KeyframeDrawing[]) || [];
                  const updated = duplicateDrawing(
                    currentFrames,
                    curF,
                    targetFrame,
                  );
                  onParamChange?.("frames", updated, gpNode.id);
                  onFrameChange?.(targetFrame);
                }}
                title="Duplicate drawing to next frame"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                </svg>
              </button>

              {/* Clear Button */}
              <button
                type="button"
                className="viewport-hud-button"
                onClick={() => {
                  const curF = currentFrame >= 0 ? currentFrame : 0;
                  const currentFrames =
                    (gpNode.params.frames as KeyframeDrawing[]) || [];
                  const updated = clearDrawingAtFrame(currentFrames, curF);
                  onParamChange?.("frames", updated, gpNode.id);
                }}
                title="Clear drawing at current frame"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 6h18" />
                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                </svg>
              </button>

              <div
                style={{
                  width: 1,
                  height: 16,
                  background: "rgba(255, 255, 255, 0.15)",
                }}
              />

              {/* Onion Skin toggle */}
              <button
                type="button"
                className={`viewport-hud-button ${onionSkin ? "viewport-hud-button-active" : ""}`}
                onClick={() => {
                  onParamChange?.("onionSkin", !onionSkin, gpNode.id);
                }}
                title={
                  onionSkin
                    ? "Disable onion skinning"
                    : "Enable onion skinning (ghosting)"
                }
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <circle cx="12" cy="6" r="6" />
                  <circle cx="12" cy="2" r="2" />
                </svg>
              </button>

              <div
                style={{
                  width: 1,
                  height: 16,
                  background: "rgba(255, 255, 255, 0.15)",
                }}
              />

              {/* Tool: Gizmo / Transform */}
              <button
                type="button"
                className={`viewport-hud-button ${gpTool === "select" ? "viewport-hud-button-active" : ""}`}
                onClick={() =>
                  setGpTool((prev) => (prev === "select" ? "pen" : "select"))
                }
                title={
                  gpTool === "select"
                    ? "Gizmo active (modify object transform, drawing disabled — click to return to Pen)"
                    : "Gizmo (transform object in 3D without drawing)"
                }
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="5 9 2 12 5 15" />
                  <polyline points="9 5 12 2 15 5" />
                  <polyline points="15 19 12 22 9 19" />
                  <polyline points="19 9 22 12 19 15" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                  <line x1="12" y1="2" x2="12" y2="22" />
                </svg>
              </button>
            </div>
          );
        })()}
      {/* Top-Left Viewport HUD & Controls — editor-only, never shown in the output window */}
      {!outputMode && (
        <div className="viewport-hud">
          {!elevationView && (
            <>
          {graph.nodes.some((n) => n.type === CAMERA_NODE.type) && (
            <>
              <button
                type="button"
                className="viewport-hud-button viewport-hud-button-active"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#38bdf8",
                  backgroundColor: "rgba(56, 189, 248, 0.15)",
                  borderColor: "#38bdf8",
                }}
                onClick={() => snapSelectedCameraToEditorRef.current?.()}
                title="Align Active Camera to current 3D View (Ctrl+Alt+0)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
              </button>
              <button
                type="button"
                className={`viewport-hud-button ${lockCameraToView ? "viewport-hud-button-active" : ""}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: lockCameraToView ? "#f59e0b" : "#94a3b8",
                  backgroundColor: lockCameraToView ? "rgba(245, 158, 11, 0.2)" : undefined,
                  borderColor: lockCameraToView ? "#f59e0b" : undefined,
                }}
                onClick={() => {
                  setLockCameraToView((prev) => {
                    const next = !prev;
                    if (next) {
                      snapSelectedCameraToEditorRef.current?.();
                    }
                    return next;
                  });
                }}
                title={
                  lockCameraToView
                    ? "Camera lock active: camera tracks viewport in real-time (Lock Camera to View)"
                    : "Lock camera to 3D viewport continuously (Lock Camera to View)"
                }
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d={lockCameraToView ? "M7 11V7a5 5 0 0 1 10 0v4" : "M7 11V7a5 5 0 0 1 9.9-1"} />
                </svg>
              </button>
            </>
          )}
          <button
            type="button"
            className={`viewport-hud-button ${showUiOverlay ? "viewport-hud-button-active" : ""}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              color: showUiOverlay ? "#38bdf8" : "#cbd5e1",
              backgroundColor: showUiOverlay ? "rgba(56, 189, 248, 0.15)" : undefined,
              borderColor: showUiOverlay ? "#38bdf8" : undefined,
            }}
            onClick={() => setShowUiOverlay((prev) => !prev)}
            title={
              showUiOverlay
                ? "Hide construction elements / helpers (Tab)"
                : "Show construction elements / helpers (Tab)"
            }
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {showUiOverlay ? (
                <>
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </>
              ) : (
                <>
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </>
              )}
            </svg>
          </button>
          <button
            type="button"
            className={`viewport-hud-button ${isOrthographic ? "viewport-hud-button-active" : ""}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              color: isOrthographic ? "#38bdf8" : "#cbd5e1",
            }}
            onClick={() => setIsOrthographic((prev) => !prev)}
            title={
              isOrthographic
                ? "Orthographic View (click to switch to Perspective)"
                : "Perspective View (click to switch to Orthographic)"
            }
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {isOrthographic ? (
                <>
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M3 9h18M3 15h18M9 3v18M15 3v18" opacity="0.4" />
                </>
              ) : (
                <>
                  <polygon points="12 2 2 7 12 12 22 7 12 2" />
                  <polyline points="2 17 12 22 22 17" />
                  <polyline points="2 12 12 17 22 12" />
                </>
              )}
            </svg>
          </button>
          <button
            type="button"
            className={`viewport-hud-button ${showEnvInEditor ? "viewport-hud-button-active" : ""}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              color: showEnvInEditor ? "#38bdf8" : "#cbd5e1",
            }}
            onClick={() => setShowEnvInEditor((prev) => !prev)}
            title="Toggle Environment (HDRI / Background)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          </button>
          <div className="viewport-hud-legend">
            {(
              [
                { axis: "x", label: "X", views: ["Right", "Left"] },
                { axis: "y", label: "Y", views: ["Top", "Bottom"] },
                { axis: "z", label: "Z", views: ["Front", "Back"] },
              ] as const
            ).map(({ axis, label, views }) => (
              <button
                key={axis}
                type="button"
                className={`viewport-hud-axis viewport-hud-axis-${axis}`}
                title={`View ${views[0]} / ${views[1]} (click to toggle)`}
                onClick={() => {
                  const sign = axisSideRef.current[axis];
                  setAxisViewRef.current(axis, sign);
                  axisSideRef.current[axis] = (sign === 1 ? -1 : 1) as 1 | -1;
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {isAxisView && (
            <button
              type="button"
              className={`viewport-hud-button ${isViewLocked ? "viewport-hud-button-active" : ""}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: isViewLocked ? "#38bdf8" : "#cbd5e1",
                backgroundColor: isViewLocked ? "rgba(56, 189, 248, 0.15)" : undefined,
                borderColor: isViewLocked ? "#38bdf8" : undefined,
              }}
              onClick={toggleViewLock}
              title={
                isViewLocked
                  ? "Unlock view — orbit re-enabled"
                  : "Lock view — disable orbit (work serenely in this fixed view)"
              }
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="11" width="16" height="10" rx="2" />
                {isViewLocked ? (
                  <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                ) : (
                  <path d="M8 11V7a4 4 0 0 1 7.9-3.6" />
                )}
              </svg>
            </button>
          )}
          </>
          )}
          <button
            type="button"
            className="viewport-hud-button"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => resetCameraRef.current()}
            title="Reset 3D Camera view"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
          {elevationView && onToggleSnapElevation && (
            <button
              type="button"
              className={`viewport-hud-button ${snapElevation ? "viewport-hud-button-active" : ""}`}
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
              onClick={onToggleSnapElevation}
              title={snapElevation ? "Elevation snapping active (0.5)" : "Enable elevation snapping (0.5)"}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 3v7a6 6 0 0 0 12 0V3" />
                <line x1="4" y1="3" x2="8" y2="3" />
                <line x1="16" y1="3" x2="20" y2="3" />
              </svg>
            </button>
          )}
          {!elevationView && onToggleSplitView && (
            <button
              type="button"
              className={`viewport-hud-button ${isSplitView ? "viewport-hud-button-active" : ""}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: isSplitView ? "#38bdf8" : "#cbd5e1",
              }}
              onClick={onToggleSplitView}
              title="Cycle View: Viewport / Split / Camera / Full Canvas (Shift+Tab)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="12" y1="3" x2="12" y2="21" />
              </svg>
            </button>
          )}
          {onSelectNode && (
            <div className="viewport-hud-gizmo-modes">
              {(["translate", "rotate", "scale"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={
                    "viewport-hud-button" + (transformMode === mode ? " viewport-hud-button-active" : "")
                  }
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                  onClick={() => setTransformMode(mode)}
                  title={
                    mode === "translate"
                      ? "Gizmo: Translate (W)"
                      : mode === "rotate"
                      ? "Gizmo: Rotate (E)"
                      : "Gizmo: Scale (R)"
                  }
                >
                  {mode === "translate" ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="5 9 2 12 5 15" />
                      <polyline points="9 5 12 2 15 5" />
                      <polyline points="15 19 12 22 9 19" />
                      <polyline points="19 9 22 12 19 15" />
                      <line x1="2" y1="12" x2="22" y2="12" />
                      <line x1="12" y1="2" x2="12" y2="22" />
                    </svg>
                  ) : mode === "rotate" ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21.5 2v6h-6" />
                      <path d="M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="15 3 21 3 21 9" />
                      <polyline points="9 21 3 21 3 15" />
                      <line x1="21" y1="3" x2="14" y2="10" />
                      <line x1="3" y1="21" x2="10" y2="14" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Pinned params HUD — the editor's own free-orbit pane only, never the
          output/camera-preview pane, so it lives here rather than as an
          App.tsx-level overlay: this is the one place naturally scoped to
          just that pane's bounds (absolute within .viewport-container) and
          naturally unmounted whenever this pane isn't on screen at all
          (full-canvas Graph view). */}
      {!outputMode && onParamChange && onUnpinParam && (graph.exposedParams?.length ?? 0) > 0 && (
        <ViewportParamHUD
          graph={graph}
          registry={registry}
          evaluatedResults={evaluatedResults}
          keyframes={keyframes}
          currentFrame={currentFrame}
          keyframesEnabled={keyframesEnabled}
          onChange={onParamChange}
          onUnpin={onUnpinParam}
          onRename={onRenameExposedParam}
        />
      )}

      {/* 2D HUD overlay — shown over the camera view whenever a render node
          exists (its resolution defines the elements' pixel coordinate space).
          The overlay is inset to the actual rendered frame (letterboxed in the
          output window) and element sizes scale with the frame, so a HUD laid
          out at render resolution (0..1920) renders exactly as exported. */}
      {(outputMode || isCameraView) && renderSize && hubElements.length > 0 && (
        <div
          className="viewport-hub-overlay"
          style={{ left: renderFrame.x, top: renderFrame.y, width: renderFrame.width, height: renderFrame.height }}
        >
          {hubElements.map((el) => {
            const s = renderSize.width > 0 ? renderFrame.width / renderSize.width : 1;
            return (
              <div
                key={el.id}
                className={"viewport-hub-element" + (el.id === selectedNodeId ? " viewport-hub-element-selected" : "")}
                style={{
                  left: `${(el.x / renderSize.width) * 100}%`,
                  top: `${(el.y / renderSize.height) * 100}%`,
                  fontFamily: el.fontFamily,
                  fontSize: `${el.fontSize * el.scale * s}px`,
                  color: el.color,
                  textShadow: scalePxString(el.textShadow, s),
                  background: el.backgroundColor ?? undefined,
                  border: el.borderColor ? `${(el.borderWidth * s).toFixed(2)}px solid ${el.borderColor}` : undefined,
                  borderRadius: `${(el.borderRadius * s).toFixed(2)}px`,
                  boxShadow: scalePxString(el.shadow, s),
                  opacity: el.cssOpacity,
                  transform: el.transform,
                  filter: el.filter,
                  display: el.visible ? "block" : "none",
                  pointerEvents: onSelectNode ? "auto" : "none",
                  cursor: el.id === selectedNodeId ? "default" : "pointer",
                  padding: el.imageUrl ? 0 : undefined,
                }}
                onPointerDown={(e) => {
                  // Drag directly on the element to move it (no move handle).
                  if (!onHubChange || !hostRef.current) return;
                  e.stopPropagation();
                  hubDragMovedRef.current = false;
                  hubDragRef.current = {
                    mode: "move",
                    startClientX: e.clientX,
                    startClientY: e.clientY,
                    originClientX: 0,
                    originClientY: 0,
                    baseX: el.x,
                    baseY: el.y,
                    baseRot: el.rotation,
                    baseScale: el.scale,
                };
              }}
              onClick={(e) => {
                e.stopPropagation();
                // A real drag shouldn't also select the node.
                if (hubDragMovedRef.current) {
                  hubDragMovedRef.current = false;
                  return;
                }
                onSelectNode?.(el.id);
              }}
            >
              {el.imageUrl ? (
                <img
                  src={el.imageUrl}
                  alt=""
                  draggable={false}
                  className="viewport-hub-element-img"
                  style={{ width: `${(el.imageWidth ?? 200) * el.scale * s}px`, borderRadius: `${(el.borderRadius * s).toFixed(2)}px` }}
                />
              ) : (
                el.text
              )}
              {el.id === selectedNodeId && onHubChange && (
                <>
                  <div
                    className="viewport-hub-gizmo-rotate"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      if (!hostRef.current) return;
                      const frame = renderFrameRef.current;
                      const rs = renderSizeRef.current;
                      hubDragRef.current = {
                        mode: "rotate",
                        startClientX: e.clientX,
                        startClientY: e.clientY,
                        originClientX: frame.x + (el.x / (rs?.width ?? 1)) * frame.width,
                        originClientY: frame.y + (el.y / (rs?.height ?? 1)) * frame.height,
                        baseX: el.x,
                        baseY: el.y,
                        baseRot: el.rotation,
                        baseScale: el.scale,
                      };
                    }}
                    title="Drag to rotate"
                  />
                  <div
                    className="viewport-hub-gizmo-size"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      if (!hostRef.current) return;
                      hubDragRef.current = {
                        mode: "size",
                        startClientX: e.clientX,
                        startClientY: e.clientY,
                        originClientX: 0,
                        originClientY: 0,
                        baseX: el.x,
                        baseY: el.y,
                        baseRot: el.rotation,
                        baseScale: el.scale,
                      };
                    }}
                    title="Drag to resize"
                  />
                </>
              )}
            </div>
          );
          })}
        </div>
      )}
    </div>
  );
}
