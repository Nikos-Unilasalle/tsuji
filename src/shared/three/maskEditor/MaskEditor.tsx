import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactElement } from "react";
import * as THREE from "three";
import { EvalResult } from "../../graph/evaluate";
import { Graph, NodeInstance } from "../../graph/types";
import {
  MASK_MODES,
  MaskLayer,
  MaskPoint,
  closestOnPath,
  createLayer,
  createPaintLayer,
  freehandPoints,
  insertPoint,
  isPaintLayer,
  sanitizeLayers,
  segmentAt,
  toggleSmooth,
} from "../../graph/maskShapes";
import { decodeBitmap, emptyBitmap, encodeBitmap } from "../../graph/maskBitmap";
import { maskRasterSize } from "../../graph/nodes/maskRoto";
import { strokeBrush, toBytes, toWorking } from "./maskBrush";
import { HudBar, HudSeparator, HudToolColumn } from "../HudToolbars";
import {
  deletePoints,
  isSmooth,
  isTinyDrag,
  moveHandle,
  penAdd,
  penDrag,
  reindexAfterDelete,
  shapeFromDrag,
  translatePoints,
} from "./maskEditing";
import {
  UvFrame,
  findMaskSurfaces,
  frameAspect,
  pixelsPerUv,
  screenToUv,
  uvFrameOf,
  uvToScreen,
} from "./maskSurface";

/**
 * The drawing palette a selected Roto Mask puts in the viewport.
 *
 * Self-contained on purpose: the viewport is one very large component, and
 * this is an overlay that needs only a camera, the evaluation results (to find
 * the surface the mask cuts) and a way to write params back. It draws in SVG
 * over the canvas and takes pointer events only when it must — with the Select
 * tool, only on the shapes and handles themselves, so the camera still orbits
 * on empty space; with a drawing tool, over the whole view.
 *
 * Shapes are drawn in UV on the mesh the mask feeds, so a click is a ray
 * through the camera onto that surface (see maskSurface.ts).
 */

type Tool = "select" | "pen" | "ellipse" | "rect" | "freehand" | "brush" | "eraser";

const ACCENT = "#38bdf8";
const MODE_LABELS: Record<string, string> = {
  add: "Add",
  subtract: "Subtract",
  intersect: "Intersect",
  difference: "Difference",
};

export interface MaskEditorProps {
  node: NodeInstance;
  graph: Graph;
  getResults: () => EvalResult | null | undefined;
  getCamera: () => THREE.Camera | null;
  /** Writes params of the mask node. Never keyframed: shapes are not animated values. */
  onParamsChange: (updates: Record<string, unknown>, options?: { coalesce?: boolean }) => void;
  hudMaxRows: number;
  hudLeft: number;
}

interface View {
  frame: UvFrame;
  camera: THREE.Camera;
  rect: DOMRect;
}

interface Selection {
  layerId: string | null;
  points: Set<number>;
}

const controlStyle: CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  color: "#fff",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 4,
  fontSize: 11,
  padding: "2px 4px",
};

function NumberField({
  value,
  onChange,
  title,
  min,
  max,
  step,
  width = 50,
}: {
  value: number;
  onChange: (v: number) => void;
  title: string;
  min: number;
  max: number;
  step: number;
  width?: number;
}) {
  return (
    <input
      type="number"
      title={title}
      value={Math.round(value * 1000) / 1000}
      min={min}
      max={max}
      step={step}
      style={{ ...controlStyle, width }}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
      }}
    />
  );
}

const ICONS: Record<Tool, ReactElement> = {
  select: <path d="M5 3l14 8-6 2-3 6z" />,
  pen: (
    <>
      <path d="M12 19l7-7-4-4-7 7z" />
      <path d="M8 15L4 20l5-1" />
    </>
  ),
  ellipse: <ellipse cx="12" cy="12" rx="8" ry="6" />,
  rect: <rect x="4" y="6" width="16" height="12" rx="1" />,
  freehand: <path d="M3 17c3-8 5-8 7-3s4 4 8-6" />,
  brush: (
    <>
      <path d="M18 3l3 3-9 9-3-3z" />
      <path d="M9 12c-3 0-4 2-4 4 0 2-1 3-2 4 3 1 7 0 7-4" />
    </>
  ),
  eraser: (
    <>
      <path d="M8 20l-5-5 11-11 7 7-8 8z" />
      <path d="M8 20h12" />
      <path d="M8 9l7 7" />
    </>
  ),
};

const TOOL_TITLES: Record<Tool, string> = {
  select:
    "Select: drag a point or a handle (Alt breaks the tangent), drag a shape's outline to move it, double-click an outline to add a point, double-click a point for corner ⇄ smooth. Delete removes the selected points.",
  pen: "Pen: click for a corner, click-and-drag for a smooth point. Click the first point, double-click or press Enter to close; Esc cancels.",
  ellipse: "Ellipse: drag a box. Shift for a circle, Alt from the centre.",
  rect: "Rectangle: drag a box. Shift for a square, Alt from the centre.",
  freehand: "Freehand: draw a closed outline by hand; it is smoothed into a few points.",
  brush:
    "Brush: paint the mask with a soft brush, into the active paint layer (a new one if the active layer is a shape). Hardness sets how soft the edge is; [ and ] resize.",
  eraser:
    "Eraser: erase from the active paint layer; on any other layer it paints a Subtract layer instead, so what it rubs out is cut from the mask. [ and ] resize.",
};

/** SVG path data for a layer's outline, from projected control points. */
function layerPath(points: readonly MaskPoint[], project: (x: number, y: number) => { x: number; y: number } | null): string | null {
  const n = points.length;
  if (n < 2) return null;
  const start = project(points[0].x, points[0].y);
  if (!start) return null;
  let d = `M${start.x.toFixed(1)} ${start.y.toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const s = segmentAt(points, i);
    const c1 = project(s.c1.x, s.c1.y);
    const c2 = project(s.c2.x, s.c2.y);
    const p = project(s.p1.x, s.p1.y);
    if (!c1 || !c2 || !p) return null;
    d += `C${c1.x.toFixed(1)} ${c1.y.toFixed(1)} ${c2.x.toFixed(1)} ${c2.y.toFixed(1)} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  }
  return d + "Z";
}

export function MaskEditor({ node, graph, getResults, getCamera, onParamsChange, hudMaxRows, hudLeft }: MaskEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [selection, setSelection] = useState<Selection>({ layerId: null, points: new Set() });
  const [draft, setDraft] = useState<MaskPoint[]>([]);
  const [stroke, setStroke] = useState<{ x: number; y: number }[]>([]);
  const [preview, setPreview] = useState<MaskPoint[] | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  /** The brush cursor, in pixels within the overlay. */
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [, setViewTick] = useState(0);

  const layers = useMemo(() => sanitizeLayers(node.params.masks), [node.params.masks]);
  const activeIndex = Math.max(0, Math.min(layers.length - 1, Math.round(Number(node.params.activeLayer) || 0)));
  const active: MaskLayer | undefined = layers[activeIndex];
  const drawMode = (MASK_MODES as readonly string[]).includes(node.params.drawMode as string)
    ? (node.params.drawMode as MaskLayer["mode"])
    : "add";
  const brushSize = Math.max(2, Math.min(600, Number(node.params.brushSize) || 48));
  const brushHardness = Math.max(0, Math.min(1, Number(node.params.brushHardness ?? 0.3)));
  const brushFlow = Math.max(0.01, Math.min(1, Number(node.params.brushFlow ?? 1)));

  // Handlers read the latest of these without being re-created on every render.
  const live = useRef({ layers, activeIndex, tool, selection, draft, drawMode, nodeId: node.id, brushSize, brushHardness, brushFlow, resolution: node.params.resolution });
  live.current = { layers, activeIndex, tool, selection, draft, drawMode, nodeId: node.id, brushSize, brushHardness, brushFlow, resolution: node.params.resolution };
  const emit = useRef(onParamsChange);
  emit.current = onParamsChange;

  /** The surface this mask is drawn on, the camera looking at it, and the overlay's size on screen. */
  const getView = useCallback((): View | null => {
    const camera = getCamera();
    const svg = svgRef.current;
    if (!camera || !svg) return null;
    const found = findMaskSurfaces(graph, getResults(), node.id);
    const frame = found ? uvFrameOf(found.meshes[0]) : null;
    if (!frame) return null;
    return { frame, camera, rect: svg.getBoundingClientRect() };
  }, [getCamera, getResults, graph, node.id]);
  const getViewRef = useRef(getView);
  getViewRef.current = getView;

  // Re-render when the camera or the surface moves, and only then.
  useEffect(() => {
    let frameId = 0;
    let last = "";
    const loop = () => {
      const view = getViewRef.current();
      let key = "none";
      if (view) {
        const m = view.camera.matrixWorldInverse.elements;
        const p = (view.camera as THREE.PerspectiveCamera).projectionMatrix.elements;
        key = [...m, ...p, view.frame.origin.x, view.frame.origin.y, view.frame.origin.z, view.frame.u.x, view.frame.u.y, view.frame.u.z, view.frame.v.x, view.frame.v.y, view.frame.v.z, view.rect.width, view.rect.height].join(",");
      }
      if (key !== last) {
        last = key;
        setViewTick((n) => n + 1);
      }
      frameId = requestAnimationFrame(loop);
    };
    frameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameId);
  }, []);

  const view = getView();

  // A mask has no size of its own: the surface it is drawn on tells it its shape.
  const surfaceAspect = view ? frameAspect(view.frame) : null;
  const hasReference = graph.connections.some((c) => c.toNode === node.id && c.toSocket === "reference");
  useEffect(() => {
    if (surfaceAspect === null || hasReference) return;
    if (Math.abs(surfaceAspect - (Number(node.params.aspect) || 1)) > 0.01) {
      emit.current({ aspect: Math.round(surfaceAspect * 1000) / 1000 });
    }
  }, [surfaceAspect, hasReference, node.params.aspect]);

  /* ------------------------------ editing --------------------------------- */

  const commitLayers = useCallback((next: MaskLayer[], extra: Record<string, unknown> = {}, coalesce = false) => {
    emit.current({ masks: next, ...extra }, coalesce ? { coalesce: true } : undefined);
  }, []);

  const toUv = useCallback((clientX: number, clientY: number) => {
    const v = getViewRef.current();
    if (!v) return null;
    return screenToUv(v.frame, v.camera, v.rect, clientX - v.rect.left, clientY - v.rect.top);
  }, []);

  const updateLayer = useCallback(
    (index: number, patch: Partial<MaskLayer>, coalesce = true) => {
      const { layers: current } = live.current;
      if (!current[index]) return;
      commitLayers(current.map((l, i) => (i === index ? { ...l, ...patch } : l)), {}, coalesce);
    },
    [commitLayers],
  );

  const addLayer = useCallback(
    (points: MaskPoint[]) => {
      const { layers: current, drawMode: mode } = live.current;
      if (points.length < 3) return;
      const layer = createLayer(points, { name: `Mask ${current.length + 1}`, mode });
      commitLayers([...current, layer], { activeLayer: current.length });
      setSelection({ layerId: layer.id, points: new Set() });
      setDraft([]);
      setStroke([]);
      setPreview(null);
      setTool("select");
    },
    [commitLayers],
  );

  const finishPen = useCallback(() => {
    const { draft: d } = live.current;
    if (d.length >= 3) addLayer(d);
    else setDraft([]);
  }, [addLayer]);

  /** Drags run on the window, so they survive leaving the overlay and work whichever element started them. */
  const trackDrag = useCallback((onMove: (e: PointerEvent) => void, onEnd?: (e: PointerEvent) => void) => {
    const move = (e: PointerEvent) => onMove(e);
    const up = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      onEnd?.(e);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, []);

  const deleteSelectedPoints = useCallback(() => {
    const { layers: current, selection: sel, activeIndex: index } = live.current;
    const layer = current[index];
    if (!layer || sel.points.size === 0) return false;
    const next = deletePoints(layer.points, sel.points);
    if (!next) {
      // Fewer than three points is no shape: the layer goes.
      const remaining = current.filter((_, i) => i !== index);
      commitLayers(remaining, { activeLayer: Math.max(0, Math.min(remaining.length - 1, index)) });
      setSelection({ layerId: null, points: new Set() });
    } else {
      commitLayers(current.map((l, i) => (i === index ? { ...l, points: next } : l)));
      setSelection({ layerId: layer.id, points: reindexAfterDelete(layer.points.length, sel.points, new Set()) });
    }
    return true;
  }, [commitLayers]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      const { tool: t, draft: d, selection: sel } = live.current;
      if ((t === "brush" || t === "eraser") && (e.key === "[" || e.key === "]")) {
        const size = live.current.brushSize;
        emit.current({ brushSize: Math.max(2, Math.min(600, Math.round(size * (e.key === "]" ? 1.15 : 1 / 1.15) + (e.key === "]" ? 1 : -1)))) });
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (e.key === "Escape") {
        if (d.length > 0 || stroke.length > 0) {
          setDraft([]);
          setStroke([]);
          setPreview(null);
          e.preventDefault();
          e.stopImmediatePropagation();
        } else if (sel.points.size > 0) {
          setSelection({ ...sel, points: new Set() });
          e.stopImmediatePropagation();
        } else if (t !== "select") {
          setTool("select");
          e.stopImmediatePropagation();
        }
        return;
      }
      if (e.key === "Enter" && t === "pen" && d.length > 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        finishPen();
        return;
      }
      // Delete is the graph's "delete the selected node" too: take it only
      // when there are points selected to delete.
      if ((e.key === "Delete" || e.key === "Backspace") && sel.points.size > 0) {
        if (deleteSelectedPoints()) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      }
    };
    // Capture phase, so this runs before the graph editor's own Delete.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [deleteSelectedPoints, finishPen, stroke.length]);

  /* ------------------------------ painting -------------------------------- */

  /**
   * One brush stroke, from press to release. The pixels are worked on in a
   * private Float32 buffer and written back to the node's params (coalesced
   * into one undo step) at most once per animation frame — encoding a
   * megapixel every pointer event would be wasteful, and the mask can only
   * redraw once a frame anyway.
   */
  const startPaintStroke = (
    e: ReactPointerEvent<SVGSVGElement>,
    erase: boolean,
    startUv: { x: number; y: number },
    v: View,
    ppu: { x: number; y: number },
  ) => {
    const { layers: current, activeIndex: index, drawMode: mode, resolution, brushSize: size, brushHardness: hardness, brushFlow: flow } = live.current;
    const existing = current[index];
    const onPaint = existing && isPaintLayer(existing) && existing.bitmap !== undefined;

    // Which layer takes the paint, at which size.
    let layers = current;
    let targetIndex = index;
    let bitmap = onPaint ? existing.bitmap! : null;
    if (!bitmap) {
      const [bw, bh] = maskRasterSize(resolution, frameAspect(v.frame));
      bitmap = emptyBitmap(bw, bh);
      const fresh = createPaintLayer(bitmap, {
        name: erase ? `Erase ${current.length + 1}` : `Paint ${current.length + 1}`,
        // Rubbing out something that is not a paint layer is subtracting from the mask.
        mode: erase ? "subtract" : mode,
      });
      layers = [...current, fresh];
      targetIndex = current.length;
    }
    const targetId = layers[targetIndex].id;
    const { w, h } = bitmap;
    const working = toWorking(decodeBitmap(bitmap));
    // A brush that is `size` px across on screen, in bitmap pixels: the bitmap
    // has the surface's aspect, so one number serves both axes.
    const settings = {
      radius: ((size / 2) * w) / Math.max(1e-6, ppu.x),
      hardness,
      flow,
      erase: erase && Boolean(onPaint),
    };

    setSelection({ layerId: targetId, points: new Set() });
    let last: { x: number; y: number } | null = null;
    let frame = 0;
    let lastFlush = 0;
    const dab = (uv: { x: number; y: number }) => {
      const at = { x: uv.x * w, y: uv.y * h };
      strokeBrush(working, w, h, last, at, settings);
      last = at;
    };
    const flush = () => {
      frame = 0;
      lastFlush = performance.now();
      const next = layers.map((l) => (l.id === targetId ? { ...l, bitmap: encodeBitmap(w, h, toBytes(working)) } : l));
      emit.current({ masks: next, activeLayer: targetIndex }, { coalesce: true });
    };
    dab(startUv);
    flush();
    trackDrag(
      (ev) => {
        const rect = svgRef.current?.getBoundingClientRect();
        if (rect) setCursor({ x: ev.clientX - rect.left, y: ev.clientY - rect.top });
        const now = toUv(ev.clientX, ev.clientY);
        if (!now) return;
        dab(now);
        // At most about 25 writes a second: each one encodes the bitmap and
        // re-composites the mask, and the brush can run ahead of that.
        const schedule = () => {
          frame = requestAnimationFrame(() => (performance.now() - lastFlush < 40 ? schedule() : flush()));
        };
        if (!frame) schedule();
      },
      () => {
        if (frame) cancelAnimationFrame(frame);
        flush();
      },
    );
    e.preventDefault();
  };

  /* ------------------------- drawing tools: pointer down ------------------- */

  const onBackgroundDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const { tool: t } = live.current;
    const v = getViewRef.current();
    const uv = toUv(e.clientX, e.clientY);
    if (!v || !uv || t === "select") return;
    e.preventDefault();
    e.stopPropagation();
    const ppu = pixelsPerUv(v.frame, v.camera, v.rect);
    const aspect = frameAspect(v.frame);

    if (t === "ellipse" || t === "rect") {
      const start = uv;
      trackDrag(
        (ev) => {
          const now = toUv(ev.clientX, ev.clientY);
          if (now) setPreview(shapeFromDrag(t, start, now, { aspect, fromCenter: ev.altKey, constrain: ev.shiftKey }));
        },
        (ev) => {
          const end = toUv(ev.clientX, ev.clientY);
          setPreview(null);
          if (end && !isTinyDrag(start, end, ppu)) {
            addLayer(shapeFromDrag(t, start, end, { aspect, fromCenter: ev.altKey, constrain: ev.shiftKey }));
          }
        },
      );
    } else if (t === "freehand") {
      let points = [uv];
      setStroke(points);
      trackDrag(
        (ev) => {
          const now = toUv(ev.clientX, ev.clientY);
          if (!now) return;
          const last = points[points.length - 1];
          if (Math.hypot((now.x - last.x) * ppu.x, (now.y - last.y) * ppu.y) < 2) return;
          points = [...points, now];
          setStroke(points);
        },
        () => {
          const tolerance = 2.5 / Math.max(1, (ppu.x + ppu.y) / 2);
          setStroke([]);
          addLayer(freehandPoints(points, tolerance));
        },
      );
    } else if (t === "brush" || t === "eraser") {
      startPaintStroke(e, t === "eraser", uv, v, ppu);
    } else if (t === "pen") {
      const { draft: d } = live.current;
      // Clicking the first point closes the shape.
      if (d.length >= 3) {
        const first = uvToScreen(v.frame, v.camera, v.rect, d[0].x, d[0].y);
        if (first && Math.hypot(first.x - (e.clientX - v.rect.left), first.y - (e.clientY - v.rect.top)) < 10) {
          finishPen();
          return;
        }
      }
      // A double-click's second press lands on the point the first one placed.
      const last = d[d.length - 1];
      if (last && Math.hypot((uv.x - last.x) * ppu.x, (uv.y - last.y) * ppu.y) < 2) return;

      let next = penAdd(d, uv);
      setDraft(next);
      const startX = e.clientX;
      const startY = e.clientY;
      let dragged = false;
      trackDrag((ev) => {
        if (!dragged && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
        dragged = true;
        const now = toUv(ev.clientX, ev.clientY);
        if (now) {
          next = penDrag(next, now);
          setDraft(next);
        }
      });
    }
  };

  const onBackgroundMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const { tool: t, draft: d } = live.current;
    if (t === "pen" && d.length > 0) setHover(toUv(e.clientX, e.clientY));
    if (t === "brush" || t === "eraser") {
      const rect = svgRef.current?.getBoundingClientRect();
      if (rect) setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    }
  };

  /* ----------------------- select tool: points and outlines ---------------- */

  const startPointDrag = (e: ReactPointerEvent, layerIndex: number, index: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const { layers: current, selection: sel } = live.current;
    const layer = current[layerIndex];
    if (!layer) return;
    let indices: Set<number>;
    if (e.shiftKey) {
      indices = new Set(sel.layerId === layer.id ? sel.points : []);
      if (indices.has(index)) indices.delete(index);
      else indices.add(index);
    } else {
      indices = sel.layerId === layer.id && sel.points.has(index) ? new Set(sel.points) : new Set([index]);
    }
    setSelection({ layerId: layer.id, points: indices });
    if (layerIndex !== live.current.activeIndex) commitLayers(current, { activeLayer: layerIndex });

    const start = toUv(e.clientX, e.clientY);
    const original = layer.points;
    if (!start) return;
    trackDrag((ev) => {
      const now = toUv(ev.clientX, ev.clientY);
      if (!now) return;
      const next = translatePoints(original, indices, now.x - start.x, now.y - start.y);
      updateLayer(layerIndex, { points: next });
    });
  };

  const startHandleDrag = (e: ReactPointerEvent, layerIndex: number, index: number, which: "in" | "out") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const layer = live.current.layers[layerIndex];
    if (!layer) return;
    const base = layer.points[index];
    trackDrag((ev) => {
      const now = toUv(ev.clientX, ev.clientY);
      if (!now) return;
      updateLayer(layerIndex, { points: moveHandle(layer.points, index, which, { x: now.x - base.x, y: now.y - base.y }, ev.altKey) });
    });
  };

  const startLayerDrag = (e: ReactPointerEvent, layerIndex: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const { layers: current } = live.current;
    const layer = current[layerIndex];
    if (!layer) return;
    setSelection({ layerId: layer.id, points: new Set() });
    if (layerIndex !== live.current.activeIndex) commitLayers(current, { activeLayer: layerIndex });
    const start = toUv(e.clientX, e.clientY);
    if (!start) return;
    const all = new Set(layer.points.map((_, i) => i));
    const startX = e.clientX;
    const startY = e.clientY;
    trackDrag((ev) => {
      // A click is a click, not a nudge.
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
      const now = toUv(ev.clientX, ev.clientY);
      if (now) updateLayer(layerIndex, { points: translatePoints(layer.points, all, now.x - start.x, now.y - start.y) });
    });
  };

  const onOutlineDoubleClick = (e: ReactMouseEvent, layerIndex: number) => {
    const v = getViewRef.current();
    const uv = toUv(e.clientX, e.clientY);
    const layer = live.current.layers[layerIndex];
    if (!v || !uv || !layer) return;
    e.stopPropagation();
    const ppu = pixelsPerUv(v.frame, v.camera, v.rect);
    const hit = closestOnPath(layer.points, uv, ppu.x, ppu.y);
    if (!hit) return;
    const next = insertPoint(layer.points, hit.segment, hit.t);
    updateLayer(layerIndex, { points: next }, false);
    setSelection({ layerId: layer.id, points: new Set([hit.segment + 1]) });
  };

  /* ------------------------------- rendering ------------------------------- */

  const project = (x: number, y: number) => (view ? uvToScreen(view.frame, view.camera, view.rect, x, y) : null);
  const selecting = tool === "select";
  const drawingCursor = !selecting;

  const layerNodes = view
    ? layers.map((layer, li) => {
        if (!layer.visible || isPaintLayer(layer)) return null;
        const d = layerPath(layer.points, project);
        if (!d) return null;
        const isActive = li === activeIndex;
        return (
          <g key={layer.id}>
            <path d={d} fill={isActive ? "rgba(56,189,248,0.08)" : "none"} stroke="rgba(0,0,0,0.6)" strokeWidth={3} pointerEvents="none" />
            <path
              d={d}
              fill="none"
              stroke={isActive ? ACCENT : "rgba(255,255,255,0.55)"}
              strokeWidth={1.5}
              strokeDasharray={layer.mode === "subtract" ? "5 3" : undefined}
              pointerEvents="none"
            />
            {selecting && (
              <path
                d={d}
                fill="none"
                stroke="transparent"
                strokeWidth={12}
                style={{ pointerEvents: "stroke", cursor: "move" }}
                onPointerDown={(e) => startLayerDrag(e, li)}
                onDoubleClick={(e) => onOutlineDoubleClick(e, li)}
              />
            )}
          </g>
        );
      })
    : null;

  const handleNodes: ReactElement[] = [];
  if (view && selecting && active && active.visible && !isPaintLayer(active)) {
    active.points.forEach((p, i) => {
      const at = project(p.x, p.y);
      if (!at) return;
      const selected = selection.layerId === active.id && selection.points.has(i);
      if (selected) {
        for (const which of ["in", "out"] as const) {
          const hx = which === "in" ? p.ix : p.ox;
          const hy = which === "in" ? p.iy : p.oy;
          if (hx === 0 && hy === 0) continue;
          const h = project(p.x + hx, p.y + hy);
          if (!h) continue;
          handleNodes.push(
            <g key={`h${i}${which}`}>
              <line x1={at.x} y1={at.y} x2={h.x} y2={h.y} stroke={ACCENT} strokeWidth={1} pointerEvents="none" />
              <circle
                cx={h.x}
                cy={h.y}
                r={4}
                fill="#0b1220"
                stroke={ACCENT}
                strokeWidth={1.5}
                style={{ pointerEvents: "all", cursor: "pointer" }}
                onPointerDown={(e) => startHandleDrag(e, activeIndex, i, which)}
              />
            </g>,
          );
        }
      }
      const smooth = isSmooth(p);
      const common = {
        fill: selected ? ACCENT : "#0b1220",
        stroke: selected ? "#fff" : ACCENT,
        strokeWidth: 1.5,
        style: { pointerEvents: "all", cursor: "pointer" } as CSSProperties,
        onPointerDown: (e: ReactPointerEvent) => startPointDrag(e, activeIndex, i),
        onDoubleClick: (e: ReactMouseEvent) => {
          e.stopPropagation();
          updateLayer(activeIndex, { points: toggleSmooth(active.points, i) }, false);
        },
      };
      handleNodes.push(
        smooth ? (
          <circle key={`p${i}`} cx={at.x} cy={at.y} r={5} {...common} />
        ) : (
          <rect key={`p${i}`} x={at.x - 4.5} y={at.y - 4.5} width={9} height={9} {...common} />
        ),
      );
    });
  }

  // What is being drawn right now.
  const draftNodes: ReactElement[] = [];
  if (view && draft.length > 0) {
    const pts = hover && !draft.some((p) => p.ox !== 0 || p.oy !== 0) ? [...draft, { x: hover.x, y: hover.y, ix: 0, iy: 0, ox: 0, oy: 0 }] : draft;
    // An open path: the closed-path helper with the closing segment dropped.
    const open = layerPath(pts, project);
    if (open) draftNodes.push(<path key="draft" d={open.replace(/C[^C]*Z$/, "")} fill="none" stroke={ACCENT} strokeWidth={1.5} pointerEvents="none" />);
    draft.forEach((p, i) => {
      const at = project(p.x, p.y);
      if (at) draftNodes.push(<circle key={`d${i}`} cx={at.x} cy={at.y} r={i === 0 ? 6 : 4} fill={i === 0 ? ACCENT : "#0b1220"} stroke="#fff" strokeWidth={1.5} pointerEvents="none" />);
    });
  }
  if (view && stroke.length > 1) {
    const pts = stroke.map((p) => project(p.x, p.y)).filter((p): p is { x: number; y: number } => p !== null);
    draftNodes.push(<polyline key="stroke" points={pts.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={ACCENT} strokeWidth={1.5} pointerEvents="none" />);
  }
  if (view && preview) {
    const d = layerPath(preview, project);
    if (d) draftNodes.push(<path key="preview" d={d} fill="rgba(56,189,248,0.1)" stroke={ACCENT} strokeWidth={1.5} strokeDasharray="4 3" pointerEvents="none" />);
  }

  const hasLayers = layers.length > 0;
  const toolButton = (t: Tool) => (
    <button
      key={t}
      type="button"
      className={`viewport-hud-button ${tool === t ? "viewport-hud-button-active" : ""}`}
      title={TOOL_TITLES[t]}
      onClick={() => {
        setTool(t);
        setDraft([]);
        setStroke([]);
        setPreview(null);
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round">
        {ICONS[t]}
      </svg>
    </button>
  );

  const moveLayer = (from: number, to: number) => {
    if (to < 0 || to >= layers.length) return;
    const next = layers.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    commitLayers(next, { activeLayer: to });
  };

  return (
    <>
      <svg
        ref={svgRef}
        className="viewport-mask-editor"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          zIndex: 40,
          pointerEvents: drawingCursor && view ? "auto" : "none",
          cursor: drawingCursor ? "crosshair" : "default",
          touchAction: "none",
        }}
        onPointerDown={onBackgroundDown}
        onPointerMove={onBackgroundMove}
        onPointerLeave={() => setCursor(null)}
        onDoubleClick={() => {
          if (live.current.tool === "pen") finishPen();
        }}
      >
        {layerNodes}
        {draftNodes}
        {handleNodes}
        {view && cursor && (tool === "brush" || tool === "eraser") && (
          <g pointerEvents="none">
            <circle cx={cursor.x} cy={cursor.y} r={brushSize / 2} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={2.5} />
            <circle cx={cursor.x} cy={cursor.y} r={brushSize / 2} fill="none" stroke={tool === "eraser" ? "#fb7185" : "#fff"} strokeWidth={1} />
            {brushHardness > 0.02 && brushHardness < 0.98 && (
              <circle cx={cursor.x} cy={cursor.y} r={(brushSize / 2) * brushHardness} fill="none" stroke={tool === "eraser" ? "#fb7185" : "#fff"} strokeWidth={1} strokeDasharray="2 3" opacity={0.8} />
            )}
          </g>
        )}
      </svg>

      <HudToolColumn maxRows={hudMaxRows} left={hudLeft}>
        {(["select", "pen", "ellipse", "rect", "freehand", "brush", "eraser"] as Tool[]).map(toolButton)}
      </HudToolColumn>

      <HudBar>
        <div
          style={{ fontSize: 11, fontWeight: 700, color: ACCENT, padding: "2px 8px", background: "rgba(56,189,248,0.15)", borderRadius: 4, letterSpacing: "0.04em", userSelect: "none" }}
          title="Roto Mask"
        >
          MASK
        </div>

        {!view && (
          <span style={{ fontSize: 11, opacity: 0.8, maxWidth: 360 }}>
            Connect this mask to a Texture to Plane (or any surface with UVs) to draw on it.
          </span>
        )}

        {view && !hasLayers && <span style={{ fontSize: 11, opacity: 0.8 }}>Pick a tool and draw on the image.</span>}

        {hasLayers && active && (
          <>
            <select
              title="Layer"
              style={{ ...controlStyle, maxWidth: 130 }}
              value={activeIndex}
              onChange={(e) => {
                const i = Number(e.target.value);
                commitLayers(layers, { activeLayer: i });
                setSelection({ layerId: layers[i]?.id ?? null, points: new Set() });
              }}
            >
              {layers.map((l, i) => (
                <option key={l.id} value={i}>
                  {i + 1}. {isPaintLayer(l) ? "✎ " : ""}
                  {l.name}
                </option>
              ))}
            </select>
            <input
              title="Layer name"
              value={active.name}
              style={{ ...controlStyle, width: 80 }}
              onChange={(e) => updateLayer(activeIndex, { name: e.target.value })}
            />
            <button type="button" className="viewport-hud-button" title="Move down the stack (applied earlier)" onClick={() => moveLayer(activeIndex, activeIndex - 1)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M6 13l6 6 6-6" /></svg>
            </button>
            <button type="button" className="viewport-hud-button" title="Move up the stack (applied later)" onClick={() => moveLayer(activeIndex, activeIndex + 1)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
            </button>
            <button
              type="button"
              className={`viewport-hud-button ${active.visible ? "viewport-hud-button-active" : ""}`}
              title={active.visible ? "Visible — click to hide this layer" : "Hidden — click to show"}
              onClick={() => updateLayer(activeIndex, { visible: !active.visible }, false)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" /><circle cx="12" cy="12" r="3" /></svg>
            </button>
            <button
              type="button"
              className="viewport-hud-button"
              title="Delete this layer"
              onClick={() => {
                const remaining = layers.filter((_, i) => i !== activeIndex);
                commitLayers(remaining, { activeLayer: Math.max(0, Math.min(remaining.length - 1, activeIndex)) });
                setSelection({ layerId: null, points: new Set() });
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
            </button>

            <HudSeparator />

            <select
              title="How this layer combines with the ones below it"
              style={controlStyle}
              value={active.mode}
              onChange={(e) => updateLayer(activeIndex, { mode: e.target.value as MaskLayer["mode"] }, false)}
            >
              {MASK_MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABELS[m]}
                </option>
              ))}
            </select>
            <label style={{ display: "flex", alignItems: "center", gap: 3 }} title="Opacity (%)">
              Op
              <NumberField title="Opacity (%)" value={active.opacity * 100} min={0} max={100} step={5} onChange={(v) => updateLayer(activeIndex, { opacity: v / 100 })} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 3 }} title="Soft edge, centred on the outline, as a percentage of the image's long side">
              Feather
              <NumberField title="Feather (% of the long side)" value={active.feather * 100} min={0} max={50} step={0.5} onChange={(v) => updateLayer(activeIndex, { feather: v / 100 })} />
            </label>
            {!isPaintLayer(active) && (
              <label style={{ display: "flex", alignItems: "center", gap: 3 }} title="Grow (+) or shrink (−) the shape, as a percentage of the image's long side">
                Expand
                <NumberField title="Expansion (% of the long side)" value={active.expansion * 100} min={-50} max={50} step={0.5} onChange={(v) => updateLayer(activeIndex, { expansion: v / 100 })} />
              </label>
            )}
            {isPaintLayer(active) && (
              <button
                type="button"
                className="viewport-hud-button"
                title="Clear everything painted on this layer"
                onClick={() => {
                  const b = active.bitmap;
                  if (b) updateLayer(activeIndex, { bitmap: emptyBitmap(b.w, b.h) }, false);
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 5l14 14M19 5L5 19" /></svg>
              </button>
            )}
            <button
              type="button"
              className={`viewport-hud-button ${active.invert ? "viewport-hud-button-active" : ""}`}
              title="Invert this layer"
              onClick={() => updateLayer(activeIndex, { invert: !active.invert }, false)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" /></svg>
            </button>
          </>
        )}

        {(tool === "brush" || tool === "eraser") && (
          <>
            <HudSeparator />
            <label style={{ display: "flex", alignItems: "center", gap: 3 }} title="Brush diameter on screen, in px ([ and ] change it)">
              Size
              <NumberField title="Brush size (px)" value={brushSize} min={2} max={600} step={2} onChange={(v) => emit.current({ brushSize: v })} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 3 }} title="Hardness: 0 % is a soft falloff from the centre, 100 % a crisp edge">
              Hardness
              <NumberField title="Hardness (%)" value={brushHardness * 100} min={0} max={100} step={5} onChange={(v) => emit.current({ brushHardness: v / 100 })} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 3 }} title="Flow: how much one pass adds. Low flow builds up gradually">
              Flow
              <NumberField title="Flow (%)" value={brushFlow * 100} min={1} max={100} step={5} onChange={(v) => emit.current({ brushFlow: v / 100 })} />
            </label>
          </>
        )}

        <HudSeparator />

        <label style={{ display: "flex", alignItems: "center", gap: 3 }} title="Mode given to the next shape you draw">
          New
          <select style={controlStyle} value={drawMode} onChange={(e) => commitLayers(layers, { drawMode: e.target.value })}>
            {MASK_MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={`viewport-hud-button ${node.params.showFull ? "viewport-hud-button-active" : ""}`}
          title="Show the whole image while you draw, mask or no mask"
          onClick={() => emit.current({ showFull: !node.params.showFull })}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="14" rx="1" /><circle cx="12" cy="12" r="4" strokeDasharray="2 2" /></svg>
        </button>
      </HudBar>
    </>
  );
}
