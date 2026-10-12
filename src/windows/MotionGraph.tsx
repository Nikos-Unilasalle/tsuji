import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Graph, Keyframe, NodeRegistry } from "../shared/graph/types";
import { resolveSegmentEasing } from "../shared/graph/evaluate";
import { makeKeyframeId } from "./timelineUtils";
import {
  bezierFromHandle,
  bezierHandlePositions,
  buildChannels,
  Channel,
  clamp,
  CurvePoint,
  DEFAULT_VALUE_VIEW,
  fitValueView,
  formatTick,
  makeNormalizer,
  makeValueAxis,
  niceTicks,
  sampleSegment,
  ValueView,
  zoomValueView,
} from "./motionGraphUtils";
import "./motion-graph.css";

/** One keyframe edit: a move in time, a change of value, or both. */
export interface KeyframeEdit {
  nodeId: string;
  paramKey: string;
  oldFrame: number;
  newFrame: number;
  value?: number;
  easeBezier?: [number, number, number, number];
}

export interface MotionGraphProps {
  graph: Graph;
  registry?: NodeRegistry;
  /** Whose curves to show — normally the canvas selection. */
  nodeIds: string[];
  currentFrame: number;
  totalFrames: number;
  pixelsPerFrame: number;
  /** Horizontal scroll is shared with the ruler and the track grid below. */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  onScrollSync?: (scrollLeft: number) => void;
  onFrameChange: (frame: number) => void;
  /** Ctrl+wheel zooms time, which is the drawer's zoom — the grid follows. */
  onPixelsPerFrameChange?: (ppf: number) => void;
  /** Shared with the track grid, so a key picked here is picked there too. */
  selectedKeyframeIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
  /** Applied as one undo step when a drag ends. */
  onEditKeyframes: (edits: KeyframeEdit[]) => void;
  /** Opens the drawer's own easing popover on the current selection. */
  onOpenEasing?: (clientX: number, clientY: number) => void;
  height: number;
  onHeightChange: (height: number) => void;
  /**
   * Fill the parent instead of standing at its own fixed `height`. Used when
   * the graph *replaces* the dope sheet rather than sitting above it: there
   * is then nothing below to resize against, so the panel measures itself
   * and its drag handle is dropped.
   */
  fill?: boolean;
}

const CHANNEL_PANE_WIDTH = 150;
const AXIS_GUTTER = 46;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 620;
const KEY_RADIUS = 4.5;
/** How close, in px, the pointer must come to a key or handle to grab it. */
const PICK_RADIUS = 9;

type AxisLock = "none" | "frame" | "value";

interface KeyRef {
  channelId: string;
  nodeId: string;
  paramKey: string;
  frame: number;
  value: number;
}

type DragState =
  | {
      kind: "keys";
      pointerId: number;
      startX: number;
      startY: number;
      /** Where each dragged key started out, so the delta is always absolute. */
      initial: KeyRef[];
      dx: number;
      dy: number;
      lock: AxisLock;
      precise: boolean;
      moved: boolean;
    }
  | {
      kind: "handle";
      pointerId: number;
      channelId: string;
      /** Index of the segment's LEFT keyframe within the channel. */
      segment: number;
      which: "out" | "in";
      bezier: [number, number, number, number];
      moved: boolean;
    }
  | {
      kind: "box";
      pointerId: number;
      startX: number;
      startY: number;
      x: number;
      y: number;
      additive: boolean;
    }
  | {
      kind: "pan";
      pointerId: number;
      startY: number;
      startCenter: number;
      startScrollLeft: number;
      startX: number;
    }
  | {
      kind: "scrub";
      pointerId: number;
    };

/** Playhead hit-test tolerance, in screen px either side of its exact x — wide enough to grab with the mouse, narrow enough to still leave the rest of the plot free for box-select. */
const PLAYHEAD_HIT_PX = 5;

/**
 * Motion graph — the keyframed parameters of the selected node(s) as editable
 * value curves, in the spirit of Blender's Graph Editor.
 *
 * Time is *not* an independent axis here: X stays locked to the timeline's
 * pixels-per-frame and shares its horizontal scroll, so a key in the graph sits
 * directly above the same key in the track grid. Zooming time from the graph
 * therefore zooms the whole drawer. The value axis, in contrast, is the graph's
 * own: it pans, zooms and fits independently of everything else.
 *
 * All curves share one value space rather than sitting in stacked lanes. That
 * is what makes them comparable — and what makes Normalize worth having, since
 * a rotation in degrees and an opacity in 0..1 are otherwise unplottable
 * together.
 *
 * Selection is the drawer's, not the graph's own: picking a key here selects it
 * in the track grid too, and the drawer's Delete / Copy / Paste / Duplicate
 * shortcuts and easing popover all act on it with nothing extra wired up.
 */
export const MotionGraph: React.FC<MotionGraphProps> = ({
  graph,
  registry,
  nodeIds,
  currentFrame,
  totalFrames,
  pixelsPerFrame,
  scrollRef,
  onScrollSync,
  onFrameChange,
  onPixelsPerFrameChange,
  selectedKeyframeIds,
  onSelectionChange,
  onEditKeyframes,
  onOpenEasing,
  height,
  onHeightChange,
  fill = false,
}) => {
  const [view, setView] = useState<ValueView>(DEFAULT_VALUE_VIEW);
  const [normalize, setNormalize] = useState(false);
  const [showHandles, setShowHandles] = useState(true);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [drag, setDrag] = useState<DragState | null>(null);
  const plotRef = useRef<SVGSVGElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  // In fill mode the height comes from the layout, not the prop, so the SVG
  // still needs a concrete number to lay its plot out against.
  const [measuredHeight, setMeasuredHeight] = useState(height);
  useEffect(() => {
    if (!fill) return;
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setMeasuredHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fill]);
  /** Set once per node selection, so opening the graph frames the curves. */
  const autoFittedFor = useRef<string>("");

  const channels = useMemo(
    () => buildChannels(graph, nodeIds, registry),
    [graph, nodeIds, registry],
  );
  const visibleChannels = useMemo(
    () => channels.filter((c) => !hidden.has(c.id)),
    [channels, hidden],
  );

  const plotHeight = Math.max(1, (fill ? measuredHeight : height) - 30);
  const axis = useMemo(() => makeValueAxis(view, plotHeight), [view, plotHeight]);
  const normalizers = useMemo(() => {
    const map = new Map<string, ReturnType<typeof makeNormalizer>>();
    for (const c of channels) map.set(c.id, makeNormalizer(c, normalize));
    return map;
  }, [channels, normalize]);

  const frameX = useCallback((f: number) => f * pixelsPerFrame, [pixelsPerFrame]);
  const width = Math.max(1, (totalFrames + 1) * pixelsPerFrame);

  /** Screen Y of a key, through its channel's normalizer. */
  const keyY = useCallback(
    (channelId: string, value: number) => axis.toY(normalizers.get(channelId)?.forward(value) ?? value),
    [axis, normalizers],
  );

  // ---------------------------------------------------------------------
  // Framing
  // ---------------------------------------------------------------------

  const fitTo = useCallback(
    (only: Set<string> | null) => {
      const values: number[] = [];
      for (const c of visibleChannels) {
        const norm = normalizers.get(c.id);
        for (const k of c.keys) {
          if (only && !only.has(makeKeyframeId(c.nodeId, c.paramKey, k.frame))) continue;
          const v = Number(k.value);
          values.push(norm ? norm.forward(v) : v);
        }
      }
      setView(fitValueView(values));
    },
    [visibleChannels, normalizers],
  );

  // Frame the curves the first time a given selection shows up. Keyed on the
  // channel set rather than run on mount: the panel stays mounted while the
  // canvas selection changes under it, and an unframed curve off-screen reads
  // as "the graph is broken".
  useEffect(() => {
    const signature = `${normalize}|${visibleChannels.map((c) => c.id).join(",")}`;
    if (!signature || autoFittedFor.current === signature) return;
    autoFittedFor.current = signature;
    if (visibleChannels.length > 0) fitTo(null);
  }, [visibleChannels, normalize, fitTo]);

  // ---------------------------------------------------------------------
  // Picking
  // ---------------------------------------------------------------------

  const localPoint = useCallback((e: React.PointerEvent | React.MouseEvent) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  /** The nearest keyframe within PICK_RADIUS of a point, or null. */
  const pickKey = useCallback(
    (x: number, y: number): KeyRef | null => {
      let best: KeyRef | null = null;
      let bestDist = PICK_RADIUS;
      for (const c of visibleChannels) {
        for (const k of c.keys) {
          const v = Number(k.value);
          const d = Math.hypot(frameX(k.frame) - x, keyY(c.id, v) - y);
          if (d <= bestDist) {
            bestDist = d;
            best = { channelId: c.id, nodeId: c.nodeId, paramKey: c.paramKey, frame: k.frame, value: v };
          }
        }
      }
      return best;
    },
    [visibleChannels, frameX, keyY],
  );

  /**
   * A bezier control point near the pointer. Only segments whose arrival easing
   * is actually "bezier" carry draggable handles — the other easings are
   * parametric and have no control points to move.
   */
  const pickHandle = useCallback(
    (x: number, y: number) => {
      if (!showHandles) return null;
      for (const c of visibleChannels) {
        for (let i = 0; i < c.keys.length - 1; i++) {
          const { easing, bezier } = resolveSegmentEasing(c.keys, i);
          if (easing !== "bezier") continue;
          const handles = bezierHandlePositions(c.keys[i], c.keys[i + 1], bezier);
          for (const which of ["out", "in"] as const) {
            const p = handles[which];
            const d = Math.hypot(frameX(p.frame) - x, keyY(c.id, p.value) - y);
            if (d <= PICK_RADIUS) {
              return { channelId: c.id, segment: i, which, bezier: bezier ?? [0.42, 0, 0.58, 1] };
            }
          }
        }
      }
      return null;
    },
    [showHandles, visibleChannels, frameX, keyY],
  );

  // ---------------------------------------------------------------------
  // Live drag preview
  //
  // A drag is previewed locally and committed once, on release. Writing every
  // pointer move into the graph would make the store the source of the preview
  // — which spams undo, and (because moving a key onto an occupied frame
  // replaces it) would silently eat keys the pointer merely swept across.
  // ---------------------------------------------------------------------

  const previewOffsets = useMemo(() => {
    if (!drag || drag.kind !== "keys") return null;
    const dFrames = drag.lock === "value" ? 0 : Math.round(drag.dx / pixelsPerFrame);
    const dy = drag.lock === "frame" ? 0 : drag.dy * (drag.precise ? 0.2 : 1);
    return { dFrames, dy };
  }, [drag, pixelsPerFrame]);

  const draggedIds = useMemo(() => {
    if (!drag || drag.kind !== "keys") return null;
    return new Set(drag.initial.map((k) => makeKeyframeId(k.nodeId, k.paramKey, k.frame)));
  }, [drag]);

  /** A channel's keys with the in-flight drag applied, sorted by frame. */
  const previewKeys = useCallback(
    (c: Channel): Keyframe[] => {
      if (!drag) return c.keys;

      if (drag.kind === "handle" && drag.channelId === c.id) {
        const next = [...c.keys];
        // The segment's easing lives on its arrival key (resolveSegmentEasing).
        const owner = drag.segment + 1;
        if (next[owner]) next[owner] = { ...next[owner], easeBezier: drag.bezier };
        return next;
      }

      if (drag.kind !== "keys" || !previewOffsets || !draggedIds) return c.keys;
      const norm = normalizers.get(c.id);
      return c.keys
        .map((k) => {
          const id = makeKeyframeId(c.nodeId, c.paramKey, k.frame);
          if (!draggedIds.has(id)) return k;
          const v = Number(k.value);
          let value = v;
          if (previewOffsets.dy !== 0 && norm) {
            // Round-trip through the axis so the value follows the pointer by
            // the same amount on screen whatever the channel's own scale is.
            value = norm.inverse(axis.toValue(axis.toY(norm.forward(v)) + previewOffsets.dy));
          }
          return {
            ...k,
            frame: clamp(k.frame + previewOffsets.dFrames, 0, totalFrames),
            value,
          };
        })
        .sort((a, b) => a.frame - b.frame);
    },
    [drag, previewOffsets, draggedIds, normalizers, axis, totalFrames],
  );

  // ---------------------------------------------------------------------
  // Pointer handling
  // ---------------------------------------------------------------------

  const beginKeyDrag = (e: React.PointerEvent, picked: KeyRef) => {
    const id = makeKeyframeId(picked.nodeId, picked.paramKey, picked.frame);
    let selection = selectedKeyframeIds;
    if (e.shiftKey) {
      selection = new Set(selectedKeyframeIds);
      if (selection.has(id)) selection.delete(id);
      else selection.add(id);
      onSelectionChange(selection);
      // Shift-clicking to deselect must not then drag the key away.
      if (!selection.has(id)) return;
    } else if (!selectedKeyframeIds.has(id)) {
      selection = new Set([id]);
      onSelectionChange(selection);
    }

    const initial: KeyRef[] = [];
    for (const c of visibleChannels) {
      for (const k of c.keys) {
        if (!selection.has(makeKeyframeId(c.nodeId, c.paramKey, k.frame))) continue;
        initial.push({
          channelId: c.id,
          nodeId: c.nodeId,
          paramKey: c.paramKey,
          frame: k.frame,
          value: Number(k.value),
        });
      }
    }
    if (initial.length === 0) return;
    const { x, y } = localPoint(e);
    setDrag({
      kind: "keys",
      pointerId: e.pointerId,
      startX: x,
      startY: y,
      initial,
      dx: 0,
      dy: 0,
      lock: "none",
      precise: e.shiftKey,
      moved: false,
    });
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button === 2) return; // right-click opens the easing menu on pointerup
    const { x, y } = localPoint(e);
    plotRef.current?.setPointerCapture(e.pointerId);

    // Middle button, or space-less Alt-drag, pans the view.
    if (e.button === 1 || e.altKey) {
      setDrag({
        kind: "pan",
        pointerId: e.pointerId,
        startY: y,
        startX: x,
        startCenter: view.center,
        startScrollLeft: scrollRef?.current?.scrollLeft ?? 0,
      });
      return;
    }

    const handle = pickHandle(x, y);
    if (handle) {
      setDrag({ kind: "handle", pointerId: e.pointerId, ...handle, moved: false });
      return;
    }

    const picked = pickKey(x, y);
    if (picked) {
      beginKeyDrag(e, picked);
      return;
    }

    // Grabbing the playhead itself scrubs live as the mouse moves, not just
    // on release — same gesture as the dope sheet's own playhead handle.
    if (Math.abs(x - frameX(currentFrame)) <= PLAYHEAD_HIT_PX) {
      onFrameChange(clamp(Math.round(x / pixelsPerFrame), 0, totalFrames));
      setDrag({ kind: "scrub", pointerId: e.pointerId });
      return;
    }

    // Empty space: a plain drag boxes a selection, and a click that never moved
    // seeks the playhead (handled on release).
    setDrag({
      kind: "box",
      pointerId: e.pointerId,
      startX: x,
      startY: y,
      x,
      y,
      additive: e.shiftKey,
    });
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { x, y } = localPoint(e);

    if (drag.kind === "keys") {
      setDrag({ ...drag, dx: x - drag.startX, dy: y - drag.startY, precise: e.shiftKey, moved: true });
      return;
    }

    if (drag.kind === "handle") {
      const channel = channels.find((c) => c.id === drag.channelId);
      if (!channel) return;
      const k1 = channel.keys[drag.segment];
      const k2 = channel.keys[drag.segment + 1];
      if (!k1 || !k2) return;
      const norm = normalizers.get(channel.id);
      const point: CurvePoint = {
        frame: x / pixelsPerFrame,
        value: norm ? norm.inverse(axis.toValue(y)) : axis.toValue(y),
      };
      setDrag({ ...drag, bezier: bezierFromHandle(k1, k2, drag.which, point, drag.bezier), moved: true });
      return;
    }

    if (drag.kind === "box") {
      setDrag({ ...drag, x, y });
      return;
    }

    if (drag.kind === "pan") {
      setView((v) => ({ ...v, center: drag.startCenter + (y - drag.startY) * axis.unitsPerPixel }));
      if (scrollRef?.current) {
        scrollRef.current.scrollLeft = drag.startScrollLeft - (x - drag.startX);
      }
      return;
    }

    if (drag.kind === "scrub") {
      onFrameChange(clamp(Math.round(x / pixelsPerFrame), 0, totalFrames));
      return;
    }
  };

  const commitKeyDrag = (state: Extract<DragState, { kind: "keys" }>) => {
    if (!previewOffsets) return;
    const { dFrames, dy } = previewOffsets;
    if (dFrames === 0 && dy === 0) return;
    const edits: KeyframeEdit[] = state.initial.map((k) => {
      const norm = normalizers.get(k.channelId);
      const value =
        dy !== 0 && norm ? norm.inverse(axis.toValue(axis.toY(norm.forward(k.value)) + dy)) : undefined;
      return {
        nodeId: k.nodeId,
        paramKey: k.paramKey,
        oldFrame: k.frame,
        newFrame: clamp(k.frame + dFrames, 0, totalFrames),
        value,
      };
    });
    onEditKeyframes(edits);
    // Selection follows the keys to their new frames — the id encodes the
    // frame, so leaving it alone would deselect everything that just moved.
    const next = new Set<string>();
    for (const edit of edits) next.add(makeKeyframeId(edit.nodeId, edit.paramKey, edit.newFrame));
    onSelectionChange(next);
  };

  const commitHandleDrag = (state: Extract<DragState, { kind: "handle" }>) => {
    const channel = channels.find((c) => c.id === state.channelId);
    if (!channel) return;
    const key = channel.keys[state.segment + 1];
    if (!key) return;
    onEditKeyframes([
      {
        nodeId: channel.nodeId,
        paramKey: channel.paramKey,
        oldFrame: key.frame,
        newFrame: key.frame,
        easeBezier: state.bezier,
      },
    ]);
  };

  const commitBoxSelect = (state: Extract<DragState, { kind: "box" }>) => {
    const minX = Math.min(state.startX, state.x);
    const maxX = Math.max(state.startX, state.x);
    const minY = Math.min(state.startY, state.y);
    const maxY = Math.max(state.startY, state.y);
    const next = new Set(state.additive ? selectedKeyframeIds : []);
    for (const c of visibleChannels) {
      for (const k of c.keys) {
        const kx = frameX(k.frame);
        const ky = keyY(c.id, Number(k.value));
        if (kx >= minX && kx <= maxX && ky >= minY && ky <= maxY) {
          next.add(makeKeyframeId(c.nodeId, c.paramKey, k.frame));
        }
      }
    }
    onSelectionChange(next);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    try {
      plotRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      // The capture is already gone (the pointer left the window) — harmless.
    }

    if (drag.kind === "keys" && drag.moved) commitKeyDrag(drag);
    else if (drag.kind === "handle" && drag.moved) commitHandleDrag(drag);
    else if (drag.kind === "box") {
      const moved = Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 3;
      if (moved) commitBoxSelect(drag);
      else {
        // A bare click on empty space: clear the selection and seek.
        if (!drag.additive && selectedKeyframeIds.size > 0) onSelectionChange(new Set());
        onFrameChange(clamp(Math.round(drag.startX / pixelsPerFrame), 0, totalFrames));
      }
    }
    setDrag(null);
  };

  // Axis locking mid-drag, Blender-style: X pins the move to time, Y to value.
  useEffect(() => {
    if (!drag || drag.kind !== "keys") return;
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (key !== "x" && key !== "y" && key !== "escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (key === "escape") {
        setDrag(null);
        return;
      }
      const wanted: AxisLock = key === "x" ? "frame" : "value";
      setDrag((d) =>
        d && d.kind === "keys" ? { ...d, lock: d.lock === wanted ? "none" : wanted } : d,
      );
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [drag]);

  // Framing shortcuts. Scoped to the pointer being over the graph so they don't
  // fight the drawer's own keys or the 3D viewport's.
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (!hovered) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Home") {
        e.preventDefault();
        fitTo(null);
      } else if (e.key === ".") {
        e.preventDefault();
        fitTo(selectedKeyframeIds.size > 0 ? selectedKeyframeIds : null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hovered, fitTo, selectedKeyframeIds]);

  const handleWheel = (e: React.WheelEvent) => {
    // Ctrl+wheel is time zoom, which belongs to the whole drawer.
    if ((e.ctrlKey || e.metaKey) && onPixelsPerFrameChange) {
      e.preventDefault();
      onPixelsPerFrameChange(clamp(pixelsPerFrame * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 1, 60));
      return;
    }
    e.preventDefault();
    const { y } = localPoint(e);
    if (e.shiftKey) {
      setView((v) => ({ ...v, center: v.center + e.deltaY * axis.unitsPerPixel }));
    } else {
      const anchor = axis.toValue(y);
      setView((v) => zoomValueView(v, e.deltaY < 0 ? 1 / 1.15 : 1.15, anchor));
    }
  };

  // Panel resize — dragging the bottom edge, with window-level listeners so the
  // pointer can leave the strip mid-drag.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const state = resizeRef.current;
      if (!state) return;
      onHeightChange(clamp(state.startHeight + (e.clientY - state.startY), MIN_HEIGHT, MAX_HEIGHT));
    };
    const onUp = () => {
      resizeRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onHeightChange]);

  const toggleChannel = (id: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  const ticks = useMemo(() => {
    const top = axis.toValue(0);
    const bottom = axis.toValue(plotHeight);
    return niceTicks(bottom, top, Math.max(2, Math.floor(plotHeight / 34)));
  }, [axis, plotHeight]);
  const tickStep = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 1;

  const curves = useMemo(() => {
    return visibleChannels.map((c) => {
      const keys = previewKeys(c);
      const norm = normalizers.get(c.id);
      const toY = (v: number) => axis.toY(norm ? norm.forward(v) : v);
      let d = "";
      for (let i = 0; i < keys.length - 1; i++) {
        const spanPx = Math.abs(frameX(keys[i + 1].frame) - frameX(keys[i].frame));
        const pts = sampleSegment(keys, i, clamp(spanPx / 4, 4, 96));
        for (let n = 0; n < pts.length; n++) {
          // Segments share their end keys, so only the very first point of the
          // whole curve starts a subpath.
          const cmd = i === 0 && n === 0 ? "M" : "L";
          d += `${cmd}${frameX(pts[n].frame).toFixed(1)} ${toY(pts[n].value).toFixed(1)}`;
        }
      }
      // Extrapolation: the evaluator holds the end values outside the range, so
      // the graph draws them flat rather than stopping mid-air.
      let lead = "";
      let tail = "";
      if (keys.length > 0) {
        const first = keys[0];
        const last = keys[keys.length - 1];
        lead = `M0 ${toY(Number(first.value)).toFixed(1)}L${frameX(first.frame).toFixed(1)} ${toY(Number(first.value)).toFixed(1)}`;
        tail = `M${frameX(last.frame).toFixed(1)} ${toY(Number(last.value)).toFixed(1)}L${width} ${toY(Number(last.value)).toFixed(1)}`;
      }
      return { channel: c, keys, d, lead, tail, toY };
    });
  }, [visibleChannels, previewKeys, normalizers, axis, frameX, width]);

  const isEmpty = channels.length === 0;

  return (
    <div
      ref={rootRef}
      className="mg-root"
      style={fill ? { flex: 1, minHeight: 0 } : { height }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <div className="mg-toolbar">
        <span className="mg-title">GRAPH</span>
        <button
          className={`mg-tool ${normalize ? "on" : ""}`}
          onClick={() => setNormalize((n) => !n)}
          title="Normalize — fit every channel to the same -1..1 range so curves in different units can be compared"
        >
          Normalize
        </button>
        <button
          className={`mg-tool ${showHandles ? "on" : ""}`}
          onClick={() => setShowHandles((h) => !h)}
          title="Show bezier handles on segments using custom easing"
        >
          Handles
        </button>
        <button className="mg-tool" onClick={() => fitTo(null)} title="Frame all curves (Home)">
          Fit
        </button>
        <button
          className="mg-tool"
          onClick={() => fitTo(selectedKeyframeIds.size > 0 ? selectedKeyframeIds : null)}
          disabled={selectedKeyframeIds.size === 0}
          title="Frame the selected keys (.)"
        >
          Fit Sel
        </button>
        <span className="mg-hint">
          drag&nbsp;key · shift&nbsp;add · X/Y&nbsp;lock · wheel&nbsp;zoom · ⌥&nbsp;pan
        </span>
      </div>

      {isEmpty ? (
        <div className="mg-empty">
          {nodeIds.length === 0
            ? "Select a node to see its animation curves."
            : "This node has no keyframed numeric parameters yet."}
        </div>
      ) : (
        <div className="mg-body">
          <div className="mg-channels" style={{ width: CHANNEL_PANE_WIDTH }}>
            {channels.map((c) => {
              const isHidden = hidden.has(c.id);
              return (
                <button
                  key={c.id}
                  className={`mg-channel ${isHidden ? "off" : ""}`}
                  onClick={() => toggleChannel(c.id)}
                  title={isHidden ? `Show ${c.paramKey}` : `Hide ${c.paramKey}`}
                >
                  <span className="mg-swatch" style={{ background: c.color }} />
                  <span className="mg-channel-name">{c.label}</span>
                </button>
              );
            })}
          </div>

          <div className="mg-view">
            <div
              ref={scrollRef}
              className="mg-scroll"
              onScroll={(e) => onScrollSync?.(e.currentTarget.scrollLeft)}
            >
              <svg
                ref={plotRef}
                className="mg-plot"
                width={width}
                height={plotHeight}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onWheel={handleWheel}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (selectedKeyframeIds.size > 0) onOpenEasing?.(e.clientX, e.clientY);
                }}
              >
                {ticks.map((t) => (
                  <line
                    key={t}
                    className={`mg-gridline ${Math.abs(t) < 1e-9 ? "zero" : ""}`}
                    x1={0}
                    x2={width}
                    y1={axis.toY(t)}
                    y2={axis.toY(t)}
                  />
                ))}

                {curves.map(({ channel, keys, d, lead, tail, toY }) => (
                  <g key={channel.id}>
                    <path className="mg-extrap" d={lead} stroke={channel.color} />
                    <path className="mg-extrap" d={tail} stroke={channel.color} />
                    <path className="mg-curve" d={d} stroke={channel.color} />

                    {showHandles &&
                      keys.map((_k, i) => {
                        if (i >= keys.length - 1) return null;
                        const { easing, bezier } = resolveSegmentEasing(keys, i);
                        if (easing !== "bezier") return null;
                        const h = bezierHandlePositions(keys[i], keys[i + 1], bezier);
                        return (
                          <g key={`h${i}`} className="mg-handles">
                            <line
                              x1={frameX(keys[i].frame)}
                              y1={toY(Number(keys[i].value))}
                              x2={frameX(h.out.frame)}
                              y2={toY(h.out.value)}
                            />
                            <line
                              x1={frameX(keys[i + 1].frame)}
                              y1={toY(Number(keys[i + 1].value))}
                              x2={frameX(h.in.frame)}
                              y2={toY(h.in.value)}
                            />
                            <rect
                              className="mg-handle"
                              x={frameX(h.out.frame) - 3}
                              y={toY(h.out.value) - 3}
                              width={6}
                              height={6}
                            />
                            <rect
                              className="mg-handle"
                              x={frameX(h.in.frame) - 3}
                              y={toY(h.in.value) - 3}
                              width={6}
                              height={6}
                            />
                          </g>
                        );
                      })}

                    {keys.map((k) => {
                      // Selection is tracked by the key's ORIGINAL frame, which
                      // a preview move doesn't change until it is committed.
                      const original = draggedIds
                        ? channel.keys.find((o) => Math.abs(o.frame - k.frame) < 1e-9) ?? k
                        : k;
                      const id = makeKeyframeId(channel.nodeId, channel.paramKey, original.frame);
                      const selected = selectedKeyframeIds.has(id) || draggedIds?.has(id);
                      return (
                        <circle
                          key={`${channel.id}:${k.frame}`}
                          className={`mg-key ${selected ? "sel" : ""}`}
                          cx={frameX(k.frame)}
                          cy={toY(Number(k.value))}
                          r={KEY_RADIUS}
                          fill={selected ? "#fbbf24" : channel.color}
                        />
                      );
                    })}
                  </g>
                ))}

                {drag?.kind === "box" && (
                  <rect
                    className="mg-marquee"
                    x={Math.min(drag.startX, drag.x)}
                    y={Math.min(drag.startY, drag.y)}
                    width={Math.abs(drag.x - drag.startX)}
                    height={Math.abs(drag.y - drag.startY)}
                  />
                )}

                <line
                  className="mg-playhead"
                  x1={frameX(currentFrame)}
                  x2={frameX(currentFrame)}
                  y1={0}
                  y2={plotHeight}
                />
              </svg>
            </div>

            {/* Value axis — an overlay, not part of the scrolled surface, so the
                labels stay put when the timeline scrolls sideways. */}
            <div className="mg-axis" style={{ width: AXIS_GUTTER }}>
              {ticks.map((t) => (
                <span key={t} className="mg-axis-label" style={{ top: axis.toY(t) - 7 }}>
                  {formatTick(t, tickStep)}
                </span>
              ))}
            </div>

            {drag?.kind === "keys" && drag.lock !== "none" && (
              <div className="mg-lock-badge">{drag.lock === "frame" ? "X · time" : "Y · value"}</div>
            )}
          </div>
        </div>
      )}

      {!fill && (
        <div
          className="mg-resize"
          onMouseDown={(e) => {
            e.preventDefault();
            resizeRef.current = { startY: e.clientY, startHeight: height };
          }}
          title="Drag to resize the graph"
        />
      )}
    </div>
  );
};
