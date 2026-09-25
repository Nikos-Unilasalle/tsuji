import React, { useState, useRef, useCallback, useEffect } from "react";
import { GpToolMode, TransformGizmoMode, TransformPatch, Viewport } from "./Viewport";
import { EvalResult } from "../graph/evaluate";
import { Graph, KeyframeStore, NodeRegistry } from "../graph/types";
import type { PreviewCameraPose } from "../ipc";
import "./viewport.css";


/**
 * Shift+Tab cycles: viewport (free orbit) -> split (editor + camera preview)
 * -> full camera view -> full-canvas graph (no 3D pane at all) -> viewport.
 * Controlled from App.tsx, not owned here — "graph" unmounts every Viewport
 * this component would render, so the App.tsx div wrapping SplitViewport is
 * what actually has to react to it (collapsing to 0 height), and the
 * keyboard shortcut has to live somewhere that stays mounted regardless.
 */
export type SplitViewMode = "viewport" | "split" | "camera" | "graph";

interface SplitViewportProps {
  graph: Graph;
  registry: NodeRegistry;
  renderNodeId: string;
  epochMs?: number;
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string | null) => void;
  onTransformChange?: (transformNodeId: string, patch: TransformPatch) => void;
  onTransformStart?: () => void;
  onCameraChange?: (pose: PreviewCameraPose) => void;
  previewCameraPose?: PreviewCameraPose | null;
  currentFrame?: number;
  onEvaluatedResults?: (results: Map<string, Record<string, unknown>>) => void;
  isPlaying?: boolean;
  /** Timeline length, for the pane that drives playback — see Viewport's `onFrameChange`. */
  totalFrames?: number;
  /**
   * Handed to the primary pane only, and only while it is on screen, so
   * exactly one viewport ever advances the playhead. In graph-only view both
   * panes are hidden and suspended, so nothing drives and the caller's own
   * timer takes back over.
   */
  onFrameChange?: (frame: number) => void;
  onHubChange?: (nodeId: string, patch: Partial<{ x: number; y: number; rotation: number; scale: number }>) => void;
  /** Freezes both panes while a video export runs — see Viewport's `suspended`. */
  suspended?: boolean;
  viewMode?: SplitViewMode;
  onCycleViewMode?: () => void;
  show3DView?: boolean;
  showCameraView?: boolean;
  /** Third, independent pane — the `view2d` node's texture, full-bleed. Shares this row with 3D/Camera rather than living elsewhere, since it's "a space like any other." */
  show2DView?: boolean;
  view2DNodeId?: string;
  /** Editor pane's pinned param HUD — see ViewportParamHUD. Not passed to the output/camera-preview pane. */
  keyframes?: KeyframeStore;
  keyframesEnabled?: boolean;
  evaluatedResults?: EvalResult | null;
  onParamChange?: (
    paramId: string | Record<string, unknown>,
    value?: unknown,
    targetNodeId?: string,
    options?: { coalesce?: boolean },
  ) => void;
  onParamAction?: (nodeId: string, action: string) => void;
  onUnpinParam?: (nodeId: string, paramId: string) => void;
  onRenameExposedParam?: (nodeId: string, paramId: string, label: string) => void;
  mode2D?: boolean;
  onToggle2DMode?: () => void;
  snapElevation?: boolean;
  onToggleSnapElevation?: () => void;
  gpTool?: GpToolMode;
  onGpToolChange?: (mode: GpToolMode) => void;
  transformMode?: TransformGizmoMode;
  onTransformModeChange?: (mode: TransformGizmoMode) => void;
}

export function SplitViewport({
  graph,
  registry,
  renderNodeId,
  epochMs = 0,
  selectedNodeId = null,
  onSelectNode,
  onTransformChange,
  onTransformStart,
  onCameraChange,
  previewCameraPose = null,
  currentFrame,
  totalFrames,
  onFrameChange,
  onEvaluatedResults,
  isPlaying,
  onHubChange,
  suspended = false,
  viewMode,
  onCycleViewMode: cycleMode,
  show3DView,
  showCameraView,
  show2DView = false,
  view2DNodeId,
  keyframes,
  keyframesEnabled,
  evaluatedResults,
  onParamChange,
  onParamAction,
  onUnpinParam,
  onRenameExposedParam,
  mode2D = false,
  onToggle2DMode,
  snapElevation = false,
  onToggleSnapElevation,
  gpTool: gpToolProp,
  onGpToolChange,
  transformMode: transformModeProp,
  onTransformModeChange,
}: SplitViewportProps) {
  const is2D = Boolean(mode2D);
  const [splitPercent, setSplitPercent] = useState(is2D ? 72 : 50);

  useEffect(() => {
    if (is2D) {
      setSplitPercent(72);
    }
  }, [is2D]);

  const [internalGpTool, setInternalGpTool] = useState<GpToolMode>("pen");
  const gpTool = gpToolProp !== undefined ? gpToolProp : internalGpTool;
  const handleGpToolChange = useCallback(
    (tool: GpToolMode) => {
      setInternalGpTool(tool);
      onGpToolChange?.(tool);
    },
    [onGpToolChange],
  );

  const [internalTransformMode, setInternalTransformMode] = useState<TransformGizmoMode>("translate");
  const transformMode = transformModeProp !== undefined ? transformModeProp : internalTransformMode;
  const handleTransformModeChange = useCallback(
    (mode: TransformGizmoMode) => {
      setInternalTransformMode(mode);
      onTransformModeChange?.(mode);
    },
    [onTransformModeChange],
  );

  const handlePrimaryCameraChange = useCallback(
    (pose: PreviewCameraPose) => {
      onCameraChange?.(pose);
    },
    [onCameraChange],
  );

  const isDraggingRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const ghostLineRef = useRef<HTMLDivElement>(null);
  const lastClampedXRef = useRef(0);

  // Share of the row's total width given to the 3D/Camera group, when the
  // 2D pane is also showing — the 2D pane gets the rest. Independent of
  // `splitPercent` above, which only divides the 3D/Camera group *between
  // themselves*.
  const [groupPercent, setGroupPercent] = useState(70);
  const isDragging2DRef = useRef(false);
  const [isDragging2D, setIsDragging2D] = useState(false);
  const ghostLine2DRef = useRef<HTMLDivElement>(null);
  const lastClampedX2DRef = useRef(0);

  // Held so an unmount while the splitter is pressed can remove the global
  // window listeners — otherwise they'd linger until the next mouseup and
  // keep calling setState on a component that no longer exists.
  const dragHandlersRef = useRef<{ move: (e: MouseEvent | PointerEvent) => void; up: () => void } | null>(null);
  const dragHandlers2DRef = useRef<{ move: (e: MouseEvent | PointerEvent) => void; up: () => void } | null>(null);

  useEffect(
    () => () => {
      if (dragHandlersRef.current) {
        window.removeEventListener("mousemove", dragHandlersRef.current.move);
        window.removeEventListener("mouseup", dragHandlersRef.current.up);
        window.removeEventListener("pointermove", dragHandlersRef.current.move);
        window.removeEventListener("pointerup", dragHandlersRef.current.up);
        window.removeEventListener("pointercancel", dragHandlersRef.current.up);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        dragHandlersRef.current = null;
      }
      if (dragHandlers2DRef.current) {
        window.removeEventListener("mousemove", dragHandlers2DRef.current.move);
        window.removeEventListener("mouseup", dragHandlers2DRef.current.up);
        window.removeEventListener("pointermove", dragHandlers2DRef.current.move);
        window.removeEventListener("pointerup", dragHandlers2DRef.current.up);
        window.removeEventListener("pointercancel", dragHandlers2DRef.current.up);
        dragHandlers2DRef.current = null;
      }
    },
    [],
  );

  const handleMouseDown = useCallback((e: React.MouseEvent | React.PointerEvent) => {
    if ("button" in e && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    isDraggingRef.current = true;
    lastClampedXRef.current = e.clientX;
    setIsDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (moveEvent: MouseEvent | PointerEvent) => {
      if (!isDraggingRef.current) return;
      // Measured against the 3D/Camera group's own sub-container, not the
      // whole row — when the 2D pane is also showing, the group only owns
      // part of the row's width (see split-viewport-group below).
      const container = document.getElementById("split-viewport-group");
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;

      const minX = rect.left + rect.width * 0.15;
      const maxX = rect.left + rect.width * 0.85;
      const clampedX = Math.min(maxX, Math.max(minX, moveEvent.clientX));
      lastClampedXRef.current = clampedX;
      if (ghostLineRef.current) {
        ghostLineRef.current.style.transform = `translateX(${clampedX - rect.left}px)`;
      }
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("pointermove", onMouseMove);
      window.removeEventListener("pointerup", onMouseUp);
      window.removeEventListener("pointercancel", onMouseUp);
      dragHandlersRef.current = null;

      const container = document.getElementById("split-viewport-group");
      if (container) {
        const rect = container.getBoundingClientRect();
        if (rect.width > 0) {
          const newPercent = ((lastClampedXRef.current - rect.left) / rect.width) * 100;
          setSplitPercent(Math.max(15, Math.min(85, newPercent)));
        }
      }
      setIsDragging(false);
    };

    dragHandlersRef.current = { move: onMouseMove, up: onMouseUp };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("pointermove", onMouseMove);
    window.addEventListener("pointerup", onMouseUp);
    window.addEventListener("pointercancel", onMouseUp);
  }, []);

  const handleMouseDown2D = useCallback((e: React.MouseEvent | React.PointerEvent) => {
    if ("button" in e && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    isDragging2DRef.current = true;
    lastClampedX2DRef.current = e.clientX;
    setIsDragging2D(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (moveEvent: MouseEvent | PointerEvent) => {
      if (!isDragging2DRef.current) return;
      const container = document.getElementById("split-viewport-container");
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;

      const minX = rect.left + rect.width * 0.15;
      const maxX = rect.left + rect.width * 0.85;
      const clampedX = Math.min(maxX, Math.max(minX, moveEvent.clientX));
      lastClampedX2DRef.current = clampedX;
      if (ghostLine2DRef.current) {
        ghostLine2DRef.current.style.transform = `translateX(${clampedX - rect.left}px)`;
      }
    };

    const onMouseUp = () => {
      isDragging2DRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("pointermove", onMouseMove);
      window.removeEventListener("pointerup", onMouseUp);
      window.removeEventListener("pointercancel", onMouseUp);
      dragHandlers2DRef.current = null;

      const container = document.getElementById("split-viewport-container");
      if (container) {
        const rect = container.getBoundingClientRect();
        if (rect.width > 0) {
          const newPercent = ((lastClampedX2DRef.current - rect.left) / rect.width) * 100;
          setGroupPercent(Math.max(15, Math.min(85, newPercent)));
        }
      }
      setIsDragging2D(false);
    };

    dragHandlers2DRef.current = { move: onMouseMove, up: onMouseUp };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("pointermove", onMouseMove);
    window.addEventListener("pointerup", onMouseUp);
    window.addEventListener("pointercancel", onMouseUp);
  }, []);

  const hasExplicitSpaces = show3DView !== undefined || showCameraView !== undefined;
  const show3D = hasExplicitSpaces ? Boolean(show3DView) : (viewMode === "viewport" || viewMode === "split");
  const showCam = hasExplicitSpaces ? Boolean(showCameraView) : (viewMode === "camera" || viewMode === "split");
  const isSplitActive = (show3D && showCam) || is2D;

  const primaryVisible = show3D || (showCam && !isSplitActive);
  const isCamera = !show3D && showCam;
  const secondaryVisible = isSplitActive;
  const everSplitRef = useRef(isSplitActive);
  if (isSplitActive) everSplitRef.current = true;

  // The 2D pane is a third, independent space in this same row — "a space
  // like any other," not tucked behind a menu. It only needs its own
  // divider (and only takes width away from the 3D/Camera group) when both
  // sides of the row are actually showing at once.
  const groupVisible = show3D || showCam;
  const bothRowGroupsVisible = groupVisible && show2DView;
  const everShown2DRef = useRef(show2DView);
  if (show2DView) everShown2DRef.current = true;

  return (
    <div
      id="split-viewport-container"
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        overflow: "hidden",
        backgroundColor: "#090d16",
      }}
    >
      <div
        id="split-viewport-group"
        style={{
          width: bothRowGroupsVisible ? `${groupPercent}%` : groupVisible ? "100%" : "0%",
          height: "100%",
          display: "flex",
          position: "relative",
          minWidth: 0,
        }}
      >
      <div
        style={{
          width: isSplitActive ? `${splitPercent}%` : "100%",
          height: "100%",
          position: "relative",
          minWidth: 0,
          display: primaryVisible ? "block" : "none",
        }}
      >
        <Viewport
          suspended={suspended || !primaryVisible}
          graph={graph}
          registry={registry}
          renderNodeId={renderNodeId}
          epochMs={epochMs}
          outputMode={false}
          cameraView={isCamera}
          mode2D={is2D}
          onToggle2DMode={onToggle2DMode}
          elevationView={false}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
          onTransformChange={onTransformChange}
          onTransformStart={onTransformStart}
          onCameraChange={handlePrimaryCameraChange}
          previewCameraPose={previewCameraPose}
          isSplitView={isSplitActive}
          onToggleSplitView={cycleMode}
          currentFrame={currentFrame}
          totalFrames={totalFrames}
          // Only while this pane is actually on screen: hidden, it is
          // suspended and would drive nothing, so the caller's fallback timer
          // has to be free to take over.
          onFrameChange={primaryVisible ? onFrameChange : undefined}
          onEvaluatedResults={onEvaluatedResults}
          isPlaying={isPlaying}
          onHubChange={onHubChange}
          keyframes={keyframes}
          keyframesEnabled={keyframesEnabled}
          evaluatedResults={evaluatedResults}
          onParamChange={onParamChange}
          onParamAction={onParamAction}
          onUnpinParam={onUnpinParam}
          onRenameExposedParam={onRenameExposedParam}
          gpTool={gpTool}
          onGpToolChange={handleGpToolChange}
          transformMode={transformMode}
          onTransformModeChange={handleTransformModeChange}
        />
      </div>

      {/* Draggable Splitter — between 3D View and Camera View (split or 2D mode) */}
      <div
        className="viewport-split-divider"
        onMouseDown={handleMouseDown}
        onPointerDown={handleMouseDown}
        style={{
          backgroundColor: is2D ? "var(--accent-color, #38bdf8)" : undefined,
          display: isSplitActive ? "block" : "none",
        }}
        title="Resize viewports (drag horizontally)"
      >
        <button
          type="button"
          className="viewport-split-handle-btn viewport-split-handle-btn-top"
          onMouseDown={handleMouseDown}
          onPointerDown={handleMouseDown}
          title="Resize viewports (drag horizontally)"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="7 8 3 12 7 16" />
            <polyline points="17 8 21 12 17 16" />
            <line x1="3" y1="12" x2="21" y2="12" />
          </svg>
        </button>
      </div>

      <div
        style={{
          width: isSplitActive ? `${100 - splitPercent}%` : "100%",
          height: "100%",
          position: "relative",
          minWidth: 0,
          display: secondaryVisible ? "block" : "none",
        }}
      >
        {everSplitRef.current && (
          <Viewport
            suspended={suspended || !secondaryVisible}
            graph={graph}
            registry={registry}
            renderNodeId={renderNodeId}
            epochMs={epochMs}
            outputMode={!is2D}
            mode2D={false}
            elevationView={is2D}
            snapElevation={snapElevation}
            onToggleSnapElevation={onToggleSnapElevation}
            selectedNodeId={selectedNodeId}
            onSelectNode={onSelectNode}
            onTransformChange={onTransformChange}
            onTransformStart={onTransformStart}
            previewCameraPose={null}
            currentFrame={currentFrame}
            onEvaluatedResults={onEvaluatedResults}
            isPlaying={isPlaying}
            onHubChange={onHubChange}
            keyframes={keyframes}
            keyframesEnabled={keyframesEnabled}
            evaluatedResults={evaluatedResults}
            onParamChange={onParamChange}
            onUnpinParam={onUnpinParam}
            gpTool={gpTool}
            onGpToolChange={handleGpToolChange}
            transformMode={transformMode}
            onTransformModeChange={handleTransformModeChange}
          />
        )}
      </div>
      </div>

      {/* Draggable Splitter — between the 3D/Camera group and the 2D pane */}
      <div
        className="viewport-split-divider"
        onMouseDown={handleMouseDown2D}
        onPointerDown={handleMouseDown2D}
        style={{ display: bothRowGroupsVisible ? "block" : "none" }}
        title="Resize 2D View (drag horizontally)"
      >
        <button
          type="button"
          className="viewport-split-handle-btn viewport-split-handle-btn-top"
          onMouseDown={handleMouseDown2D}
          onPointerDown={handleMouseDown2D}
          title="Resize 2D View (drag horizontally)"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="7 8 3 12 7 16" />
            <polyline points="17 8 21 12 17 16" />
            <line x1="3" y1="12" x2="21" y2="12" />
          </svg>
        </button>
      </div>

      <div
        style={{
          width: bothRowGroupsVisible ? `${100 - groupPercent}%` : show2DView ? "100%" : "0%",
          height: "100%",
          position: "relative",
          minWidth: 0,
          display: show2DView ? "block" : "none",
        }}
      >
        {view2DNodeId ? (
          everShown2DRef.current && (
            <Viewport
              suspended={suspended || !show2DView}
              graph={graph}
              registry={registry}
              renderNodeId={renderNodeId}
              view2DNodeId={view2DNodeId}
              epochMs={epochMs}
              outputMode
              currentFrame={currentFrame}
              isPlaying={isPlaying}
              keyframes={keyframes}
              keyframesEnabled={keyframesEnabled}
            />
          )
        ) : (
          // No `view2d` node yet: an empty Viewport with no view2DNodeId
          // would silently fall back to a normal 3D render (see its own
          // early-return guard) — showing a second, redundant 3D view
          // instead of nothing is far more confusing than an empty state.
          show2DView && (
            <div
              style={{
                width: "100%",
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-secondary, #64748b)",
                fontSize: 13,
                textAlign: "center",
                padding: 24,
              }}
            >
              Add a "2D View" node (Structure category) and wire a texture into it.
            </div>
          )
        )}
      </div>

      {isDragging2D && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 99999,
            cursor: "col-resize",
            userSelect: "none",
            pointerEvents: "auto",
          }}
        >
          <div
            ref={ghostLine2DRef}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              width: 1,
              background: "var(--accent-color, #38bdf8)",
              transform: `translateX(${lastClampedX2DRef.current - (document.getElementById("split-viewport-container")?.getBoundingClientRect().left ?? 0)}px)`,
              pointerEvents: "none",
            }}
          />
        </div>
      )}

      {isDragging && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 99999,
            cursor: "col-resize",
            userSelect: "none",
            pointerEvents: "auto",
          }}
        >
          <div
            ref={ghostLineRef}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              width: 1,
              background: "var(--accent-color, #38bdf8)",
              transform: `translateX(${lastClampedXRef.current - (document.getElementById("split-viewport-container")?.getBoundingClientRect().left ?? 0)}px)`,
              pointerEvents: "none",
            }}
          />
        </div>
      )}
    </div>
  );
}

