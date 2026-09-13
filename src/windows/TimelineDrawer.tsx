import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CATEGORY_COLOR, UNKNOWN_CATEGORY_COLOR } from "../shared/graph/categories";
import { resolveDefinition } from "../shared/graph/groups";
import { isTimelineZone, setInputZone } from "../shared/graph/inputZoneStore";
import { EasingType, Graph, Marker, NodeRegistry } from "../shared/graph/types";
import {
  copyKeyframesToClipboard,
  formatParamValue,
  formatTimecode,
  getClipboardKeyframes,
  KeyframeClipboardItem,
  makeKeyframeId,
  parseKeyframeId,
  SelectedKeyframeKey,
} from "./timelineUtils";
import { EasingPopover, EASING_OPTIONS, EASING_STRENGTH_CONFIG, strengthForEasing } from "./EasingPopover";
import { DragNumberInput } from "./DragNumberInput";
import {
  DragTransform,
  IDENTITY_DRAG,
  TimelineDragMode,
  applyDragTransform,
  buildDragTransform,
  formatDragTransform,
  isNoOpDrag,
} from "./timelineDrag";
import { MotionGraph } from "./MotionGraph";
import "./timeline-drawer.css";

export interface TimelineDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  currentFrame: number;
  totalFrames: number;
  isPlaying: boolean;
  keyframesEnabled: boolean;
  graph: Graph;
  registry: NodeRegistry;
  selectedNodeIds: string[];
  onSelectNode: (nodeId: string | null) => void;
  onFrameChange: (frame: number) => void;
  onTogglePlay: () => void;
  onToggleKeyframe: (nodeId: string, paramKey: string, frame: number, currentValue: any) => void;
  onBatchMoveKeyframes: (
    moves: { nodeId: string; paramKey: string; oldFrame: number; newFrame: number }[],
    coalesceKey?: string,
  ) => void;
  onBatchDeleteKeyframes: (targets: { nodeId: string; paramKey: string; frame: number }[]) => void;
  onBatchDuplicateKeyframes: (
    duplicates: { nodeId: string; paramKey: string; sourceFrame: number; targetFrame: number }[],
  ) => void;
  onBatchUpdateEasing: (
    targets: { nodeId: string; paramKey: string; frame: number }[],
    easeIn: EasingType,
    easeStrength?: number,
    easeBezier?: [number, number, number, number],
  ) => void;
  onChangeKeyframeValue?: (nodeId: string, paramKey: string, frame: number, value: number) => void;
  /** One atomic pass over a set of keyframes — the motion graph's drag commit. */
  onEditKeyframes: (
    edits: {
      nodeId: string;
      paramKey: string;
      oldFrame: number;
      newFrame: number;
      value?: number;
      easeBezier?: [number, number, number, number];
    }[],
  ) => void;
  onPasteKeyframes: (items: KeyframeClipboardItem[], targetBaseFrame: number) => void;
  /** The Render node's frame rate — what the timecode is counted in. */
  fps?: number;
  markers?: Marker[];
  onToggleMarker?: (frame: number) => void;
  onMoveMarker?: (oldFrame: number, newFrame: number) => void;
  onRenameMarker?: (frame: number, label: string) => void;
  evaluatedResults?: Map<string, Record<string, unknown>>;
  drawerHeight: number;
  onDrawerHeightChange: (height: number) => void;
  onSplitHandleMouseDown: (e: React.MouseEvent) => void;
}

function renderKeyframeGlyph(easeIn: EasingType = "smooth", isSummary = false) {
  if (isSummary) {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" className="kf-glyph-svg">
        <polygon points="6,1.5 10.5,6 6,10.5 1.5,6" fill="#f8fafc" stroke="#0f172a" strokeWidth="1" />
      </svg>
    );
  }
  if (easeIn === "hold") {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" className="kf-glyph-svg">
        <rect x="2" y="2" width="8" height="8" rx="1" fill="#76C560" stroke="#0f172a" strokeWidth="1" />
      </svg>
    );
  }
  if (easeIn === "linear") {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" className="kf-glyph-svg">
        <circle cx="6" cy="6" r="4" fill="#76C560" stroke="#0f172a" strokeWidth="1" />
      </svg>
    );
  }
  if (easeIn === "bounce" || easeIn === "elastic") {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" className="kf-glyph-svg">
        <polygon points="6,1 11,6 6,11 1,6" fill="#76C560" stroke="#0f172a" strokeWidth="1" />
        <path d="M 4 6 Q 6 4 8 6" stroke="#0f172a" strokeWidth="1.2" fill="none" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" className="kf-glyph-svg">
      <polygon points="6,1 11,6 6,11 1,6" fill="#76C560" stroke="#0f172a" strokeWidth="1" />
    </svg>
  );
}

export const TimelineDrawer: React.FC<TimelineDrawerProps> = ({
  isOpen,
  onClose,
  currentFrame,
  totalFrames,
  isPlaying,
  keyframesEnabled: _keyframesEnabled,
  graph,
  registry,
  selectedNodeIds,
  onSelectNode,
  onFrameChange,
  onTogglePlay,
  onToggleKeyframe,
  onBatchMoveKeyframes,
  onBatchDeleteKeyframes,
  onBatchDuplicateKeyframes,
  onBatchUpdateEasing,
  onChangeKeyframeValue: _onChangeKeyframeValue,
  onEditKeyframes,
  onPasteKeyframes,
  fps = 30,
  markers = [],
  onToggleMarker,
  onMoveMarker: _onMoveMarker,
  onRenameMarker,
  evaluatedResults,
  drawerHeight,
  onDrawerHeightChange,
  onSplitHandleMouseDown,
}) => {
  const [viewMode, setViewMode] = useState<"selected" | "all">("selected");
  const [pixelsPerFrame, setPixelsPerFrame] = useState(6);
  const [leftPaneWidth, setLeftPaneWidth] = useState(260);
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());
  const [selectedKeyframeIds, setSelectedKeyframeIds] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; targetFrame?: number } | null>(null);
  const [easingPopover, setEasingPopover] = useState<{
    targets: SelectedKeyframeKey[];
    easeIn: EasingType;
    strength: number;
    easeBezier: [number, number, number, number];
    x: number;
    y: number;
  } | null>(null);

  // Marquee selection state
  const [marquee, setMarquee] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    isActive: boolean;
  } | null>(null);

  /** Whether a keyframe drag slides the selection or retimes its spacing — see timelineDrag.ts. */
  const [dragMode, setDragMode] = useState<TimelineDragMode>("move");

  // Dragging keyframes state
  const [draggingKeyframes, setDraggingKeyframes] = useState<{
    startFrame: number;
    transform: DragTransform;
    isAltDuplicate: boolean;
    initialKeys: SelectedKeyframeKey[];
  } | null>(null);

  // Refs
  const gridViewportRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const motionGraphScrollRef = useRef<HTMLDivElement>(null);
  // Off by default: opening the Timeline should land on the dope sheet (the
  // track list everyone starts from), not on the curve editor. The Graph
  // button in the toolbar swaps to it — see the body below, where the two
  // are mutually exclusive rather than stacked.
  const [motionGraphOpen, setMotionGraphOpen] = useState(false);
  const [motionGraphHeight, setMotionGraphHeight] = useState(190);
  const drawerRootRef = useRef<HTMLDivElement>(null);
  const isDraggingRulerRef = useRef(false);
  const isResizingDrawerRef = useRef(false);
  const drawerTopRef = useRef(0);
  const isResizingSplitterRef = useRef(false);
  const [isResizingDrawer, setIsResizingDrawer] = useState(false);

  // On open, default the zoom so the scene's frames spread across the whole
  // visible timeline width (rather than the fixed 6px/frame).
  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => {
      const vp = gridViewportRef.current;
      if (vp && totalFrames > 0) {
        setPixelsPerFrame(Math.max(0.5, (vp.clientWidth - 30) / totalFrames));
      }
    }, 50);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Compute active nodes to display
  const displayedNodes = useMemo(() => {
    if (viewMode === "all") {
      // All nodes that either have keyframes or are in selectedNodeIds
      const animatedNodeIds = new Set(Object.keys(graph.keyframes || {}));
      for (const id of selectedNodeIds) animatedNodeIds.add(id);
      return graph.nodes.filter((n) => animatedNodeIds.has(n.id));
    }
    // Only selected nodes (or if none selected, all animated nodes as fallback)
    if (selectedNodeIds.length > 0) {
      return graph.nodes.filter((n) => selectedNodeIds.includes(n.id));
    }
    const animatedNodeIds = new Set(Object.keys(graph.keyframes || {}));
    return graph.nodes.filter((n) => animatedNodeIds.has(n.id));
  }, [graph.keyframes, graph.nodes, selectedNodeIds, viewMode]);

  // The graph plots exactly the tracks the grid below lists — including the
  // "nothing selected, so show everything animated" fallback and the All Nodes
  // mode. Following the canvas selection alone left the graph blank while the
  // grid was full of rows.
  const motionGraphNodeIds = useMemo(() => displayedNodes.map((n) => n.id), [displayedNodes]);

  // Expand / collapse helper
  const toggleNodeCollapse = (nodeId: string) => {
    setCollapsedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  // Synchronize horizontal scroll between ruler, motion graph and grid.
  const onGridScroll = () => {
    const left = gridViewportRef.current?.scrollLeft ?? 0;
    if (rulerRef.current) rulerRef.current.scrollLeft = left;
    if (motionGraphScrollRef.current) motionGraphScrollRef.current.scrollLeft = left;
  };

  const onMotionGraphScroll = (scrollLeft: number) => {
    if (gridViewportRef.current) gridViewportRef.current.scrollLeft = scrollLeft;
    if (rulerRef.current) rulerRef.current.scrollLeft = scrollLeft;
  };

  // Convert clientX to frame in the grid
  const clientXToFrame = useCallback(
    (clientX: number, targetElem: HTMLElement) => {
      const rect = targetElem.getBoundingClientRect();
      const scrollOffset = gridViewportRef.current ? gridViewportRef.current.scrollLeft : 0;
      const x = clientX - rect.left + scrollOffset;
      const frame = Math.round(x / pixelsPerFrame);
      return Math.max(0, Math.min(totalFrames, frame));
    },
    [pixelsPerFrame, totalFrames],
  );

  // Jump to prev/next keyframes across displayed tracks
  const allKeyframeFrames = useMemo(() => {
    const frames = new Set<number>();
    for (const node of displayedNodes) {
      const nodeKeys = graph.keyframes?.[node.id];
      if (!nodeKeys) continue;
      for (const list of Object.values(nodeKeys)) {
        for (const kf of list) frames.add(kf.frame);
      }
    }
    return Array.from(frames).sort((a, b) => a - b);
  }, [displayedNodes, graph.keyframes]);

  const jumpToPrevKeyframe = () => {
    const prev = [...allKeyframeFrames].reverse().find((f) => f < currentFrame);
    if (prev !== undefined) onFrameChange(prev);
    else onFrameChange(0);
  };

  const jumpToNextKeyframe = () => {
    const next = allKeyframeFrames.find((f) => f > currentFrame);
    if (next !== undefined) onFrameChange(next);
    else onFrameChange(totalFrames);
  };

  // Selected keyframe objects
  const selectedKeyObjects: SelectedKeyframeKey[] = useMemo(() => {
    const res: SelectedKeyframeKey[] = [];
    for (const id of selectedKeyframeIds) {
      const parsed = parseKeyframeId(id);
      if (parsed) res.push(parsed);
    }
    return res;
  }, [selectedKeyframeIds]);

  // Keyframe Selection handlers
  const handleKeyframeClick = (e: React.MouseEvent, nodeId: string, paramKey: string, frame: number) => {
    e.stopPropagation();
    const id = makeKeyframeId(nodeId, paramKey, frame);
    if (e.shiftKey) {
      setSelectedKeyframeIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    } else {
      setSelectedKeyframeIds(new Set([id]));
    }
  };

  // Open the easing popover (same UI as the mini timeline) for the selected keyframes
  const openEasingPopover = (menu: { x: number; y: number }) => {
    const targets = selectedKeyObjects.length > 0 ? selectedKeyObjects : [];
    if (targets.length === 0) return;

    const ins = new Set<EasingType>();
    const strengths = new Set<number>();
    const beziers = new Set<string>();
    for (const k of targets) {
      const kf = graph.keyframes?.[k.nodeId]?.[k.paramKey]?.find((f) => f.frame === k.frame);
      ins.add(kf?.easeIn || "smooth");
      if (kf?.easeStrength !== undefined) strengths.add(kf.easeStrength);
      if (kf?.easeBezier) beziers.add(JSON.stringify(kf.easeBezier));
    }
    const easeIn = ins.size === 1 ? [...ins][0] : "smooth";
    const strength = strengths.size === 1 ? [...strengths][0] : (EASING_STRENGTH_CONFIG[easeIn]?.defaultValue ?? 1);
    const easeBezier = beziers.size === 1 ? (JSON.parse([...beziers][0]) as [number, number, number, number]) : ([0.42, 0, 0.58, 1] as [number, number, number, number]);

    setContextMenu(null);
    setEasingPopover({
      targets,
      easeIn,
      strength,
      easeBezier,
      x: Math.max(160, Math.min(window.innerWidth - 160, menu.x)),
      y: menu.y - 40,
    });
  };

  const handleSelectEasing = (newType: EasingType) => {
    if (!easingPopover) return;
    const strength = strengthForEasing(newType, easingPopover.easeIn, easingPopover.strength);
    setEasingPopover((prev) => (prev ? { ...prev, easeIn: newType, strength: strength ?? prev.strength } : null));
    onBatchUpdateEasing(easingPopover.targets, newType, strength, easingPopover.easeBezier);
  };

  const handleStrengthChange = (value: number) => {
    if (!easingPopover) return;
    if (!Number.isFinite(value) || value <= 0) return;
    setEasingPopover((prev) => (prev ? { ...prev, strength: value } : null));
    onBatchUpdateEasing(easingPopover.targets, easingPopover.easeIn, value, easingPopover.easeBezier);
  };

  const handleBezierChange = (b: [number, number, number, number]) => {
    if (!easingPopover) return;
    setEasingPopover((prev) => (prev ? { ...prev, easeBezier: b } : null));
    onBatchUpdateEasing(easingPopover.targets, "bezier", easingPopover.strength, b);
  };

  const handleDeleteEasingKeyframes = () => {
    if (!easingPopover) return;
    onBatchDeleteKeyframes(easingPopover.targets);
    setSelectedKeyframeIds(new Set());
    setEasingPopover(null);
  };

  // Dragging / Retiming Keyframes
  const handleKeyframeMouseDown = (
    e: React.MouseEvent,
    nodeId: string,
    paramKey: string,
    frame: number,
    isSummary = false,
  ) => {
    e.stopPropagation();
    const clickedId = makeKeyframeId(nodeId, paramKey, frame);
    let keysToDrag: SelectedKeyframeKey[] = [];

    if (isSummary) {
      // Summary keyframe dragged -> select & drag all child params at this frame for this node
      const nodeKeys = graph.keyframes?.[nodeId] || {};
      const newSelectedIds = new Set(selectedKeyframeIds);
      for (const [pKey, list] of Object.entries(nodeKeys)) {
        if (list.some((k) => k.frame === frame)) {
          const kId = makeKeyframeId(nodeId, pKey, frame);
          newSelectedIds.add(kId);
          keysToDrag.push({ nodeId, paramKey: pKey, frame });
        }
      }
      setSelectedKeyframeIds(newSelectedIds);
    } else {
      if (!selectedKeyframeIds.has(clickedId) && !e.shiftKey) {
        setSelectedKeyframeIds(new Set([clickedId]));
        keysToDrag = [{ nodeId, paramKey, frame }];
      } else {
        keysToDrag = selectedKeyObjects;
        if (!selectedKeyframeIds.has(clickedId)) {
          keysToDrag.push({ nodeId, paramKey, frame });
        }
      }
    }

    setDraggingKeyframes({
      startFrame: frame,
      transform: { ...IDENTITY_DRAG, mode: dragMode, pivot: currentFrame },
      isAltDuplicate: e.altKey,
      initialKeys: keysToDrag,
    });
  };

  // Global mouse move & up for dragging keyframes, ruler scrubbing, drawer resizing, splitter resizing
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      // Drawer height resize (bottom edge only)
      if (isResizingDrawerRef.current) {
        const newHeight = e.clientY - drawerTopRef.current;
        onDrawerHeightChange(Math.max(160, Math.min(650, newHeight)));
        return;
      }

      // Splitter resize
      if (isResizingSplitterRef.current) {
        setLeftPaneWidth(Math.max(160, Math.min(450, e.clientX)));
        return;
      }

      // Ruler scrub
      if (isDraggingRulerRef.current && rulerRef.current) {
        const frame = clientXToFrame(e.clientX, rulerRef.current);
        onFrameChange(frame);
        return;
      }

      // Keyframe drag
      if (draggingKeyframes && gridViewportRef.current) {
        const currentFrameAtMouse = clientXToFrame(e.clientX, gridViewportRef.current);
        setDraggingKeyframes((prev) =>
          prev
            ? {
                ...prev,
                transform: buildDragTransform(prev.transform.mode, prev.startFrame, currentFrameAtMouse, prev.transform.pivot),
                isAltDuplicate: e.altKey,
              }
            : null,
        );
        return;
      }

      // Marquee selection drag
      if (marquee && marquee.isActive && gridViewportRef.current) {
        const rect = gridViewportRef.current.getBoundingClientRect();
        const currentX = e.clientX - rect.left + gridViewportRef.current.scrollLeft;
        const currentY = e.clientY - rect.top + gridViewportRef.current.scrollTop;
        setMarquee((prev) => (prev ? { ...prev, currentX, currentY } : null));
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      isResizingDrawerRef.current = false;
      setIsResizingDrawer(false);
      isResizingSplitterRef.current = false;
      isDraggingRulerRef.current = false;

      // Commit Keyframe Drag / Duplicate
      if (draggingKeyframes) {
        const transform = draggingKeyframes.transform;
        if (!isNoOpDrag(transform)) {
          if (draggingKeyframes.isAltDuplicate || e.altKey) {
            // Duplicate
            const duplicates = draggingKeyframes.initialKeys.map((k) => ({
              nodeId: k.nodeId,
              paramKey: k.paramKey,
              sourceFrame: k.frame,
              targetFrame: Math.max(0, Math.min(totalFrames, applyDragTransform(k.frame, transform))),
            }));
            onBatchDuplicateKeyframes(duplicates);
          } else {
            // Move
            const moves = draggingKeyframes.initialKeys.map((k) => ({
              nodeId: k.nodeId,
              paramKey: k.paramKey,
              oldFrame: k.frame,
              newFrame: Math.max(0, Math.min(totalFrames, applyDragTransform(k.frame, transform))),
            }));
            onBatchMoveKeyframes(moves);
          }
        }
        setDraggingKeyframes(null);
      }

      // Commit Marquee Selection
      if (marquee && marquee.isActive) {
        const minX = Math.min(marquee.startX, marquee.currentX);
        const maxX = Math.max(marquee.startX, marquee.currentX);
        const minY = Math.min(marquee.startY, marquee.currentY);
        const maxY = Math.max(marquee.startY, marquee.currentY);

        if (maxX - minX > 4 || maxY - minY > 4) {
          // Calculate which keyframes are within the box
          const selected = new Set(e.shiftKey ? selectedKeyframeIds : []);
          let currentY = 0;

          for (const node of displayedNodes) {
            // Node row height = 28px
            const isCollapsed = collapsedNodes.has(node.id);
            currentY += 28;

            if (!isCollapsed) {
              const nodeKeys = graph.keyframes?.[node.id] || {};
              for (const [paramKey, list] of Object.entries(nodeKeys)) {
                // Param row height = 24px
                const rowTop = currentY;
                const rowBottom = currentY + 24;
                currentY += 24;

                if (rowBottom >= minY && rowTop <= maxY) {
                  for (const kf of list) {
                    const kfX = kf.frame * pixelsPerFrame;
                    if (kfX >= minX && kfX <= maxX) {
                      selected.add(makeKeyframeId(node.id, paramKey, kf.frame));
                    }
                  }
                }
              }
            }
          }
          setSelectedKeyframeIds(selected);
        }
        setMarquee(null);
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [
    clientXToFrame,
    collapsedNodes,
    displayedNodes,
    draggingKeyframes,
    graph.keyframes,
    marquee,
    onBatchDuplicateKeyframes,
    onBatchMoveKeyframes,
    onDrawerHeightChange,
    onFrameChange,
    pixelsPerFrame,
    selectedKeyframeIds,
    totalFrames,
  ]);

  // Keyboard Shortcuts inside Timeline Drawer
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      // Timeline shortcuts only act while the cursor is over the timeline, so a
      // Delete/select-all aimed at the canvas doesn't touch keyframes.
      if (!isTimelineZone()) return;

      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        onTogglePlay();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (e.shiftKey) {
          onFrameChange(Math.max(0, currentFrame - 10));
        } else {
          jumpToPrevKeyframe();
        }
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (e.shiftKey) {
          onFrameChange(Math.min(totalFrames, currentFrame + 10));
        } else {
          jumpToNextKeyframe();
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedKeyObjects.length > 0) {
          e.preventDefault();
          onBatchDeleteKeyframes(selectedKeyObjects);
          setSelectedKeyframeIds(new Set());
        }
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        const allIds = new Set<string>();
        for (const node of displayedNodes) {
          const nodeKeys = graph.keyframes?.[node.id] || {};
          for (const [paramKey, list] of Object.entries(nodeKeys)) {
            for (const kf of list) allIds.add(makeKeyframeId(node.id, paramKey, kf.frame));
          }
        }
        setSelectedKeyframeIds(allIds);
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C")) {
        if (selectedKeyObjects.length > 0) {
          e.preventDefault();
          copyKeyframesToClipboard(selectedKeyObjects, graph.keyframes);
        }
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "v" || e.key === "V")) {
        const clip = getClipboardKeyframes();
        if (clip) {
          e.preventDefault();
          onPasteKeyframes(clip.items, currentFrame);
        }
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "d" || e.key === "D")) {
        if (selectedKeyObjects.length > 0) {
          e.preventDefault();
          const duplicates = selectedKeyObjects.map((k) => ({
            nodeId: k.nodeId,
            paramKey: k.paramKey,
            sourceFrame: k.frame,
            targetFrame: Math.min(totalFrames, k.frame + 10),
          }));
          onBatchDuplicateKeyframes(duplicates);
        }
      } else if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "g" || e.key === "G")) {
        // Blender's own dope-sheet keys, and free here. Bare (no modifier)
        // only, so ⌘G and friends keep whatever they mean elsewhere.
        e.preventDefault();
        setDragMode("move");
      } else if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        setDragMode("scale");
      } else if (e.key === "Escape") {
        if (easingPopover) setEasingPopover(null);
        else if (contextMenu) setContextMenu(null);
        else if (selectedKeyframeIds.size > 0) setSelectedKeyframeIds(new Set());
        else onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    contextMenu,
    currentFrame,
    displayedNodes,
    graph.keyframes,
    isOpen,
    jumpToNextKeyframe,
    jumpToPrevKeyframe,
    onBatchDeleteKeyframes,
    onBatchDuplicateKeyframes,
    onClose,
    onFrameChange,
    onPasteKeyframes,
    onTogglePlay,
    selectedKeyObjects,
    selectedKeyframeIds.size,
    totalFrames,
    easingPopover,
  ]);

  if (!isOpen) return null;

  const totalContentWidth = Math.max(800, (totalFrames + 10) * pixelsPerFrame);

  return (
    <div
      ref={drawerRootRef}
      className={`timeline-drawer-root ${isResizingDrawer ? "resizing" : ""} ${isOpen ? "open" : "closed"}`}
      style={{ height: `${drawerHeight}px` }}
      onMouseEnter={() => setInputZone("timeline")}
      onMouseLeave={() => setInputZone(null)}
      onClick={() => {
        if (contextMenu) setContextMenu(null);
      }}
    >
      {/* Top Edge Resizer (left-drag, same as the mini timeline split handle) */}
      <div
        className="timeline-drawer-resizer"
        title="Drag to resize panels"
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          onSplitHandleMouseDown(e);
        }}
      />

      {/* --- HEADER TOOLBAR --- */}
      <div className="timeline-drawer-header">
        {/* Left Badge & Mode filter */}
        <div className="timeline-drawer-title-area">
          <div className="timeline-drawer-badge">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8" />
            </svg>
            TIMELINE
          </div>
          <button
            className={`timeline-filter-btn ${viewMode === "selected" ? "active" : ""}`}
            onClick={() => setViewMode("selected")}
            title="Show only selected nodes"
          >
            Selection ({selectedNodeIds.length})
          </button>
          <button
            className={`timeline-filter-btn ${viewMode === "all" ? "active" : ""}`}
            onClick={() => setViewMode("all")}
            title="Show all animated nodes"
          >
            All Nodes
          </button>
        </div>

        {/* Center Transport & Timecode */}
        <div className="timeline-drawer-transport">
          <button className="timeline-ctrl-btn" onClick={() => onFrameChange(0)} title="Go to start">
            ⏮
          </button>
          <button className="timeline-ctrl-btn" onClick={jumpToPrevKeyframe} title="Previous keyframe (←)">
            |◁
          </button>
          <button
            className="timeline-ctrl-btn"
            onClick={() => onFrameChange(Math.max(0, currentFrame - 1))}
            title="Previous frame (Shift+←)"
          >
            ◀
          </button>
          <button
            className={`timeline-ctrl-btn timeline-play-btn-large ${isPlaying ? "playing" : ""}`}
            onClick={onTogglePlay}
            title="Play / Pause (Space)"
          >
            {isPlaying ? "❚❚" : "▶"}
          </button>
          <button
            className="timeline-ctrl-btn"
            onClick={() => onFrameChange(Math.min(totalFrames, currentFrame + 1))}
            title="Next frame (Shift+→)"
          >
            ▶
          </button>
          <button className="timeline-ctrl-btn" onClick={jumpToNextKeyframe} title="Next keyframe (→)">
            ▷|
          </button>
          <button className="timeline-ctrl-btn" onClick={() => onFrameChange(totalFrames)} title="Go to end">
            ⏭
          </button>

          {/* Timecode & Frame Input */}
          <div className="timeline-timecode-box">
            <DragNumberInput
              value={currentFrame}
              step={1}
              min={0}
              max={totalFrames}
              onChange={(v) => onFrameChange(Math.round(v))}
            />
            <span>/ {totalFrames}</span>
            <span className="timeline-timecode-tc">({formatTimecode(currentFrame, fps)})</span>
          </div>
        </div>

        {/* Right Actions & Zoom */}
        <div className="timeline-drawer-actions">
          {/* What a keyframe drag does — see timelineDrag.ts. Scale needs the
              playhead to lever against, so its title says where it pivots. */}
          <button
            className={`timeline-action-btn ${dragMode === "move" ? "active" : ""}`}
            onClick={() => setDragMode("move")}
            title="Drag moves keyframes, keeping their spacing (G)"
          >
            Move
          </button>
          <button
            className={`timeline-action-btn ${dragMode === "scale" ? "active" : ""}`}
            onClick={() => setDragMode("scale")}
            title={`Drag retimes the spacing between keyframes, around the playhead at frame ${currentFrame} (S)`}
          >
            Scale
          </button>
          <button
            className={`timeline-action-btn ${motionGraphOpen ? "active" : ""}`}
            onClick={() => setMotionGraphOpen((o) => !o)}
            title={motionGraphOpen ? "Hide motion graph" : "Show motion graph"}
          >
            Graph
          </button>
          <button
            className="timeline-action-btn"
            onClick={() => {
              if (selectedKeyObjects.length > 0) {
                copyKeyframesToClipboard(selectedKeyObjects, graph.keyframes);
              }
            }}
            disabled={selectedKeyObjects.length === 0}
            title="Copy keyframes (⌘C)"
          >
            Copy
          </button>
          <button
            className="timeline-action-btn"
            onClick={() => {
              const clip = getClipboardKeyframes();
              if (clip) onPasteKeyframes(clip.items, currentFrame);
            }}
            disabled={!getClipboardKeyframes()}
            title="Paste at playhead (⌘V)"
          >
            Paste
          </button>
          <button
            className="timeline-action-btn"
            onClick={() => {
              if (selectedKeyObjects.length > 0) {
                const duplicates = selectedKeyObjects.map((k) => ({
                  nodeId: k.nodeId,
                  paramKey: k.paramKey,
                  sourceFrame: k.frame,
                  targetFrame: Math.min(totalFrames, k.frame + 10),
                }));
                onBatchDuplicateKeyframes(duplicates);
              }
            }}
            disabled={selectedKeyObjects.length === 0}
            title="Duplicate keyframes (⌘D)"
          >
            Duplicate
          </button>
          <button
            className="timeline-action-btn btn-delete"
            onClick={() => {
              if (selectedKeyObjects.length > 0) {
                onBatchDeleteKeyframes(selectedKeyObjects);
                setSelectedKeyframeIds(new Set());
              }
            }}
            disabled={selectedKeyObjects.length === 0}
            title="Delete selected keyframes (⌫)"
          >
            Delete
          </button>

          {/* Easing Dropdown */}
          <select
            className="timeline-easing-select"
            defaultValue=""
            onChange={(e) => {
              const val = e.target.value as EasingType;
              if (val && selectedKeyObjects.length > 0) {
                onBatchUpdateEasing(selectedKeyObjects, val);
                e.target.value = "";
              }
            }}
            title="Change interpolation of selected keyframes"
          >
            <option value="" disabled>
              Easing curve...
            </option>
            {EASING_OPTIONS.map((opt) => (
              <option key={opt.type} value={opt.type}>
                {opt.label}
              </option>
            ))}
          </select>

          {/* Zoom Slider */}
          <div className="timeline-zoom-group">
            <span style={{ fontSize: 10, color: "#94a3b8" }}>Zoom:</span>
            <input
              type="range"
              min="1"
              max="24"
              step="0.5"
              value={pixelsPerFrame}
              onChange={(e) => setPixelsPerFrame(parseFloat(e.target.value))}
              className="timeline-zoom-slider"
            />
          </div>

          <button className="timeline-btn-close" onClick={onClose} title="Close timeline">
            ✕
          </button>
        </div>
      </div>

      {/* --- BODY: LEFT TRACK TREE & RIGHT GRID --- */}
      <div className="timeline-drawer-body">
        {/* Motion graph — value curves of the selected node, draggable. Its X
            axis follows the timeline's pixels-per-frame and horizontal scroll,
            so switching between the two views keeps keyframes at the same
            horizontal position. The Graph button in the toolbar swaps which
            of the two is showing: the curve editor *replaces* the dope sheet
            rather than stacking above it, so whichever one is up gets the
            drawer's whole height. */}
        {motionGraphOpen ? (
          <MotionGraph
            graph={graph}
            registry={registry}
            nodeIds={motionGraphNodeIds}
            currentFrame={currentFrame}
            totalFrames={totalFrames}
            pixelsPerFrame={pixelsPerFrame}
            onPixelsPerFrameChange={setPixelsPerFrame}
            scrollRef={motionGraphScrollRef}
            onScrollSync={onMotionGraphScroll}
            onFrameChange={onFrameChange}
            selectedKeyframeIds={selectedKeyframeIds}
            onSelectionChange={setSelectedKeyframeIds}
            onEditKeyframes={onEditKeyframes}
            onOpenEasing={(x, y) => openEasingPopover({ x, y })}
            height={motionGraphHeight}
            onHeightChange={setMotionGraphHeight}
            fill
          />
        ) : (
        <div className="timeline-drawer-body-row">
        {/* Left Tracks Column */}
        <div className="timeline-tracks-pane" style={{ width: `${leftPaneWidth}px` }}>
          <div className="timeline-tracks-header">
            <span>Nodes & Parameters</span>
            <span style={{ fontSize: 10 }}>{displayedNodes.length} track(s)</span>
          </div>

          <div className="timeline-tracks-list">
            {displayedNodes.length === 0 ? (
              <div className="timeline-empty-message">
                Select a node on the canvas or enable the "All Nodes" view.
              </div>
            ) : (
              displayedNodes.map((nodeInstance) => {
                const def = resolveDefinition(nodeInstance, registry);
                const categoryColor = def?.category ? CATEGORY_COLOR[def.category] : UNKNOWN_CATEGORY_COLOR;
                const isCollapsed = collapsedNodes.has(nodeInstance.id);
                const isSelected = selectedNodeIds.includes(nodeInstance.id);

                // Collect animated parameter keys for this node
                const nodeKeyStore = graph.keyframes?.[nodeInstance.id] || {};
                const paramKeys = Object.keys(nodeKeyStore);
                const totalKeyframesCount = Object.values(nodeKeyStore).reduce((acc, list) => acc + list.length, 0);

                return (
                  <div key={nodeInstance.id}>
                    {/* Node Header Row */}
                    <div
                      className={`timeline-node-row ${isSelected ? "selected" : ""}`}
                      onClick={() => onSelectNode(nodeInstance.id)}
                    >
                      <span
                        className="timeline-expand-icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleNodeCollapse(nodeInstance.id);
                        }}
                      >
                        {isCollapsed ? "▶" : "▼"}
                      </span>
                      <div className="timeline-category-dot" style={{ background: categoryColor }} />
                      <span className="timeline-node-label" title={`${def?.label || nodeInstance.type}`}>
                        {def?.label || nodeInstance.type}
                      </span>
                      {totalKeyframesCount > 0 && (
                        <span className="timeline-node-kf-count">{totalKeyframesCount} kf</span>
                      )}
                    </div>

                    {/* Sub-parameters Rows */}
                    {!isCollapsed &&
                      paramKeys.map((pKey) => {
                        const list = nodeKeyStore[pKey] || [];
                        const hasKfAtPlayhead = list.some((k) => k.frame === currentFrame);
                        const evalVal = evaluatedResults?.get(nodeInstance.id)?.[pKey] ?? nodeInstance.params[pKey];

                        return (
                          <div key={pKey} className="timeline-param-row">
                            <span className="timeline-param-name" title={pKey}>
                              {pKey}
                            </span>
                            <span className="timeline-param-val" title={String(evalVal)}>
                              {formatParamValue(evalVal)}
                            </span>
                            <button
                              className={`timeline-param-kf-toggle ${hasKfAtPlayhead ? "has-kf" : ""}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                onToggleKeyframe(nodeInstance.id, pKey, currentFrame, evalVal ?? 0);
                              }}
                              title="Add / Remove keyframe at this frame"
                            >
                              <svg width="10" height="10" viewBox="0 0 10 10">
                                <polygon
                                  points="5,0.5 9.5,5 5,9.5 0.5,5"
                                  fill={hasKfAtPlayhead ? "#76C560" : "none"}
                                  stroke="currentColor"
                                  strokeWidth="1.2"
                                />
                              </svg>
                            </button>
                          </div>
                        );
                      })}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Splitter Resizer between Left Pane and Right Grid */}
        <div
          className="timeline-pane-splitter"
          onMouseDown={(e) => {
            e.preventDefault();
            isResizingSplitterRef.current = true;
          }}
        />

        {/* Right Grid Pane */}
        <div className="timeline-grid-pane">
          {/* Header Time Ruler */}
          <div
            ref={rulerRef}
            className="timeline-ruler-container"
            onMouseDown={(e) => {
              isDraggingRulerRef.current = true;
              const frame = clientXToFrame(e.clientX, rulerRef.current!);
              onFrameChange(frame);
            }}
            onDoubleClick={(e) => {
              if (onToggleMarker && rulerRef.current) {
                const frame = clientXToFrame(e.clientX, rulerRef.current);
                onToggleMarker(frame);
              }
            }}
          >
            <div style={{ width: `${totalContentWidth}px`, height: "100%", position: "relative" }}>
              {/* Ruler Tick marks & Labels */}
              {Array.from({ length: Math.ceil(totalFrames / 5) + 1 }).map((_, idx) => {
                const f = idx * 5;
                const isMajor = f % 30 === 0 || f % 10 === 0;
                const leftPx = f * pixelsPerFrame;
                if (leftPx > totalContentWidth) return null;

                return (
                  <div
                    key={f}
                    style={{
                      position: "absolute",
                      left: `${leftPx}px`,
                      bottom: 0,
                      height: isMajor ? "16px" : "8px",
                      width: "1px",
                      background: isMajor ? "#94a3b8" : "#475569",
                      pointerEvents: "none",
                    }}
                  >
                    {isMajor && (
                      <span
                        style={{
                          position: "absolute",
                          left: "3px",
                          top: "-12px",
                          fontSize: "9px",
                          fontFamily: "monospace",
                          color: "#94a3b8",
                          userSelect: "none",
                        }}
                      >
                        {f}
                      </span>
                    )}
                  </div>
                );
              })}

              {/* Project Markers */}
              {markers.map((marker) => (
                <div
                  key={marker.frame}
                  className="timeline-marker-pin"
                  style={{ left: `${marker.frame * pixelsPerFrame}px` }}
                  title={`${marker.label ? `"${marker.label}" ` : ""}Marker at frame ${marker.frame} — double-click to label`}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    onFrameChange(marker.frame);
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (!onRenameMarker) return;
                    const next = window.prompt("Marker label", marker.label ?? "");
                    if (next !== null) onRenameMarker(marker.frame, next.trim());
                  }}
                >
                  {marker.label && <span className="timeline-marker-pin-label">{marker.label}</span>}
                </div>
              ))}

              {/* Playhead Red Cursor on Ruler */}
              <div className="timeline-playhead-head" style={{ left: `${currentFrame * pixelsPerFrame - 6}px` }} />
            </div>
          </div>

          {/* Dope Sheet Grid Matrix Viewport */}
          <div
            ref={gridViewportRef}
            className="timeline-grid-viewport"
            onScroll={onGridScroll}
            onMouseDown={(e) => {
              // Start Marquee selection on empty background
              if (e.button === 0 && gridViewportRef.current) {
                const rect = gridViewportRef.current.getBoundingClientRect();
                const startX = e.clientX - rect.left + gridViewportRef.current.scrollLeft;
                const startY = e.clientY - rect.top + gridViewportRef.current.scrollTop;
                setMarquee({ startX, startY, currentX: startX, currentY: startY, isActive: true });
                if (!e.shiftKey) {
                  setSelectedKeyframeIds(new Set());
                }
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              if (gridViewportRef.current) {
                const frame = clientXToFrame(e.clientX, gridViewportRef.current);
                setContextMenu({ x: e.clientX, y: e.clientY, targetFrame: frame });
              }
            }}
          >
            <div
              className="timeline-grid-content"
              style={{ width: `${totalContentWidth}px`, minHeight: "100%", position: "relative" }}
            >
              {/* Vertical Frame Grid Lines */}
              {Array.from({ length: Math.ceil(totalFrames / 10) + 1 }).map((_, idx) => {
                const f = idx * 10;
                const leftPx = f * pixelsPerFrame;
                return (
                  <div
                    key={f}
                    style={{
                      position: "absolute",
                      left: `${leftPx}px`,
                      top: 0,
                      bottom: 0,
                      width: "1px",
                      background: f % 30 === 0 ? "rgba(255, 255, 255, 0.08)" : "rgba(255, 255, 255, 0.03)",
                      pointerEvents: "none",
                    }}
                  />
                );
              })}

              {/* Red Playhead Vertical Line */}
              <div
                className="timeline-playhead-line"
                style={{ left: `${currentFrame * pixelsPerFrame}px` }}
              />

              {/* Tracks Grid Rows */}
              {displayedNodes.map((nodeInstance) => {
                const isCollapsed = collapsedNodes.has(nodeInstance.id);
                const nodeKeyStore = graph.keyframes?.[nodeInstance.id] || {};
                const paramKeys = Object.keys(nodeKeyStore);

                // Collect summary frames
                const summaryFrames = new Set<number>();
                for (const list of Object.values(nodeKeyStore)) {
                  for (const kf of list) summaryFrames.add(kf.frame);
                }

                return (
                  <div key={nodeInstance.id}>
                    {/* Node Summary Grid Row */}
                    <div className="timeline-grid-row-node">
                      {Array.from(summaryFrames).map((sFrame) => {
                        const isSelected = paramKeys.some((pKey) =>
                          selectedKeyframeIds.has(makeKeyframeId(nodeInstance.id, pKey, sFrame)),
                        );
                        const effectiveFrame =
                          draggingKeyframes && isSelected
                            ? applyDragTransform(sFrame, draggingKeyframes.transform)
                            : sFrame;

                        return (
                          <div
                            key={sFrame}
                            className={`timeline-keyframe-item summary-node ${isSelected ? "selected" : ""}`}
                            style={{ left: `${effectiveFrame * pixelsPerFrame}px` }}
                            onClick={(e) => {
                              e.stopPropagation();
                              const newSelected = new Set(e.shiftKey ? selectedKeyframeIds : []);
                              for (const p of paramKeys) {
                                newSelected.add(makeKeyframeId(nodeInstance.id, p, sFrame));
                              }
                              setSelectedKeyframeIds(newSelected);
                            }}
                            onMouseDown={(e) =>
                              handleKeyframeMouseDown(e, nodeInstance.id, paramKeys[0] || "", sFrame, true)
                            }
                            title={`Node ${nodeInstance.type} @ frame ${sFrame}`}
                          >
                            {renderKeyframeGlyph("smooth", true)}
                          </div>
                        );
                      })}
                    </div>

                    {/* Parameter Grid Rows */}
                    {!isCollapsed &&
                      paramKeys.map((pKey) => {
                        const list = nodeKeyStore[pKey] || [];
                        return (
                          <div key={pKey} className="timeline-grid-row-param">
                            {list.map((kf) => {
                              const kId = makeKeyframeId(nodeInstance.id, pKey, kf.frame);
                              const isSelected = selectedKeyframeIds.has(kId);
                              const effectiveFrame =
                                draggingKeyframes && isSelected
                                  ? applyDragTransform(kf.frame, draggingKeyframes.transform)
                                  : kf.frame;

                              return (
                                <div
                                  key={kf.frame}
                                  className={`timeline-keyframe-item ${isSelected ? "selected" : ""}`}
                                  style={{ left: `${effectiveFrame * pixelsPerFrame}px` }}
                                  onClick={(e) => handleKeyframeClick(e, nodeInstance.id, pKey, kf.frame)}
                                  onMouseDown={(e) => handleKeyframeMouseDown(e, nodeInstance.id, pKey, kf.frame)}
                                  title={`Param: ${pKey}\nFrame: ${kf.frame}\nValue: ${JSON.stringify(kf.value)}\nEase: ${kf.easeIn || "smooth"}${kf.easeStrength !== undefined && EASING_STRENGTH_CONFIG[kf.easeIn || "smooth"] ? ` (strength ${kf.easeStrength})` : ""}`}
                                >
                                  {renderKeyframeGlyph(kf.easeIn || "smooth", false)}
                                  {/* Drag delta badge */}
                                  {draggingKeyframes && isSelected && !isNoOpDrag(draggingKeyframes.transform) && (
                                    <div className="timeline-drag-delta-badge">
                                      {formatDragTransform(draggingKeyframes.transform)} ({effectiveFrame})
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        );
                      })}
                  </div>
                );
              })}

              {/* Marquee Selection Rectangle */}
              {marquee && marquee.isActive && (
                <div
                  className="timeline-marquee-box"
                  style={{
                    left: `${Math.min(marquee.startX, marquee.currentX)}px`,
                    top: `${Math.min(marquee.startY, marquee.currentY)}px`,
                    width: `${Math.abs(marquee.currentX - marquee.startX)}px`,
                    height: `${Math.abs(marquee.currentY - marquee.startY)}px`,
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </div>
      )}
      </div>

      {/* --- CONTEXT MENU --- */}
      {contextMenu && (
        <div
          className="timeline-context-menu"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y - 120}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className={`timeline-menu-item ${selectedKeyObjects.length === 0 ? "disabled" : ""}`}
            onClick={() => {
              copyKeyframesToClipboard(selectedKeyObjects, graph.keyframes);
              setContextMenu(null);
            }}
          >
            <span>Copy keyframes</span>
            <span className="timeline-menu-shortcut">⌘C</span>
          </div>

          <div
            className={`timeline-menu-item ${!getClipboardKeyframes() ? "disabled" : ""}`}
            onClick={() => {
              const clip = getClipboardKeyframes();
              if (clip && contextMenu.targetFrame !== undefined) {
                onPasteKeyframes(clip.items, contextMenu.targetFrame);
              }
              setContextMenu(null);
            }}
          >
            <span>Paste at this frame</span>
            <span className="timeline-menu-shortcut">⌘V</span>
          </div>

          <div
            className={`timeline-menu-item ${selectedKeyObjects.length === 0 ? "disabled" : ""}`}
            onClick={() => {
              const duplicates = selectedKeyObjects.map((k) => ({
                nodeId: k.nodeId,
                paramKey: k.paramKey,
                sourceFrame: k.frame,
                targetFrame: Math.min(totalFrames, k.frame + 10),
              }));
              onBatchDuplicateKeyframes(duplicates);
              setContextMenu(null);
            }}
          >
            <span>Duplicate</span>
            <span className="timeline-menu-shortcut">⌘D</span>
          </div>

          <div
            className={`timeline-menu-item ${selectedKeyObjects.length === 0 ? "disabled" : ""}`}
            onClick={() => {
              onBatchDeleteKeyframes(selectedKeyObjects);
              setSelectedKeyframeIds(new Set());
              setContextMenu(null);
            }}
          >
            <span style={{ color: "#f87171" }}>Delete</span>
            <span className="timeline-menu-shortcut">⌫</span>
          </div>

          <div className="timeline-menu-separator" />

          <div
            className={`timeline-menu-item ${selectedKeyObjects.length === 0 ? "disabled" : ""}`}
            onClick={() => openEasingPopover(contextMenu)}
          >
            <span>Interpolation</span>
          </div>

          <div className="timeline-menu-separator" />

          {contextMenu.targetFrame !== undefined && (
            <div
              className="timeline-menu-item"
              onClick={() => {
                onFrameChange(contextMenu.targetFrame!);
                setContextMenu(null);
              }}
            >
              <span>Move playhead to {contextMenu.targetFrame}</span>
            </div>
          )}

          {contextMenu.targetFrame !== undefined && onToggleMarker && (
            <div
              className="timeline-menu-item"
              onClick={() => {
                onToggleMarker(contextMenu.targetFrame!);
                setContextMenu(null);
              }}
            >
              <span>Add / Remove marker</span>
            </div>
          )}
        </div>
      )}

      {/* Bottom Edge Resizer (left-drag) */}
      <div
        className="timeline-drawer-resizer timeline-drawer-resizer-bottom"
        title="Drag to resize timeline"
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          const rect = drawerRootRef.current?.getBoundingClientRect();
          drawerTopRef.current = rect?.top ?? 0;
          isResizingDrawerRef.current = true;
          setIsResizingDrawer(true);
        }}
      />

      {/* Easing Popover (same as the mini timeline) */}
      {easingPopover && (
        <EasingPopover
          x={easingPopover.x}
          y={easingPopover.y}
          badge={`Keyframes ${easingPopover.targets.length}`}
          subtitle={easingPopover.targets
            .map((k) => k.frame)
            .filter((f, i, a) => a.indexOf(f) === i)
            .join(", ")}
          easeIn={easingPopover.easeIn}
          strength={easingPopover.strength}
          easeBezier={easingPopover.easeBezier}
          onSelectEasing={handleSelectEasing}
          onStrengthChange={handleStrengthChange}
          onBezierChange={handleBezierChange}
          onDelete={handleDeleteEasingKeyframes}
          onClose={() => setEasingPopover(null)}
        />
      )}
    </div>
  );
};
