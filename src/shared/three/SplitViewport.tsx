import React, { useState, useRef, useCallback, useEffect } from "react";
import { GpToolMode, TransformGizmoMode, TransformPatch, Viewport } from "./Viewport";
import { EvalResult } from "../graph/evaluate";
import { Graph, KeyframeStore, NodeRegistry } from "../graph/types";
import type { PreviewCameraPose } from "../ipc";

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
  viewMode: SplitViewMode;
  onCycleViewMode: () => void;
  /** Editor pane's pinned param HUD — see ViewportParamHUD. Not passed to the output/camera-preview pane. */
  keyframes?: KeyframeStore;
  keyframesEnabled?: boolean;
  evaluatedResults?: EvalResult | null;
  onParamChange?: (paramId: string | Record<string, unknown>, value?: unknown, targetNodeId?: string) => void;
  onParamAction?: (nodeId: string, action: string) => void;
  onUnpinParam?: (nodeId: string, paramId: string) => void;
  onRenameExposedParam?: (nodeId: string, paramId: string, label: string) => void;
  mode2D?: boolean;
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
  keyframes,
  keyframesEnabled,
  evaluatedResults,
  onParamChange,
  onParamAction,
  onUnpinParam,
  onRenameExposedParam,
  mode2D = false,
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

  const [sharedCameraPose, setSharedCameraPose] = useState<PreviewCameraPose | null>(null);
  const handlePrimaryCameraChange = useCallback(
    (pose: PreviewCameraPose) => {
      setSharedCameraPose(pose);
      onCameraChange?.(pose);
    },
    [onCameraChange],
  );

  const isDraggingRef = useRef(false);
  // Held so an unmount while the splitter is pressed can remove the global
  // window listeners — otherwise they'd linger until the next mouseup and
  // keep calling setState on a component that no longer exists.
  const dragHandlersRef = useRef<{ move: (e: MouseEvent) => void; up: () => void } | null>(null);

  useEffect(
    () => () => {
      if (dragHandlersRef.current) {
        window.removeEventListener("mousemove", dragHandlersRef.current.move);
        window.removeEventListener("mouseup", dragHandlersRef.current.up);
        dragHandlersRef.current = null;
      }
    },
    [],
  );

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const container = document.getElementById("split-viewport-container");
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;

      const newPercent = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      // Clamped so neither pane can be dragged to 0 width.
      setSplitPercent(Math.max(15, Math.min(85, newPercent)));
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      dragHandlersRef.current = null;
    };

    dragHandlersRef.current = { move: onMouseMove, up: onMouseUp };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, []);

  const isGraph = viewMode === "graph";
  const isSplit = viewMode === "split";
  const isCamera = viewMode === "camera";
  const isSplitActive = isSplit || is2D;

  const primaryVisible = !isGraph;
  const secondaryVisible = isSplitActive;
  const everSplitRef = useRef(isSplitActive);
  if (isSplitActive) everSplitRef.current = true;

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

      {/* Draggable Splitter — only meaningful (and visible) in split or 2D mode */}
      <div
        onMouseDown={handleMouseDown}
        style={{
          width: "2px",
          height: "100%",
          cursor: "col-resize",
          backgroundColor: is2D ? "#00f3ff" : "#000000",
          zIndex: 20,
          flexShrink: 0,
          display: isSplitActive ? "block" : "none",
        }}
      />

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
            previewCameraPose={previewCameraPose ?? sharedCameraPose}
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
  );
}
