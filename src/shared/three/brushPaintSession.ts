import { BrushPath, BrushScene } from "./brushScene";
import { brushEngineAvailable, renderBrushScene } from "./brushEngine";

/**
 * Interactive p5.brush painting onto a Texture Paint canvas.
 *
 * p5.brush draws a stroke from its *whole* path — the pressure envelope, the
 * watercolor bleed and the edge darkening are all functions of the complete
 * shape — so it cannot stamp segment by segment like the native brushes. A
 * session instead snapshots the canvas when the gesture starts and, while it
 * grows, repaints snapshot + whole stroke so far. Repaints are throttled
 * (a watercolor pass costs tens of ms); the last one always runs on end.
 */

export type BrushPaintTool = "brush" | "watercolor";

export interface BrushPaintStyle {
  brush: string;
  color: string;
  /** Native brush radius in canvas px — mapped onto p5.brush's weight. */
  size: number;
  opacity: number;
  bleed: number;
  texture: number;
  border: number;
  symmetryX: boolean;
}

interface Session {
  tool: BrushPaintTool;
  style: BrushPaintStyle;
  seed: number;
  snapshot: HTMLCanvasElement;
  layer: HTMLCanvasElement;
  points: Array<[number, number, number]>;
  lastRender: number;
  dirty: boolean;
}

const sessions = new WeakMap<HTMLCanvasElement, Session>();
const REPAINT_INTERVAL_MS = 45;
const MIN_POINT_SPACING_PX = 3;
const BRUSH_SCALE_REFERENCE = 200;
// A native radius of 24px reads about like p5.brush weight 2 at 1024².
const SIZE_TO_WEIGHT = 1 / 12;

export function isBrushPaintTool(tool: string): tool is BrushPaintTool {
  return tool === "brush" || tool === "watercolor";
}

function mirrored(points: Array<[number, number, number]>, width: number): Array<[number, number, number]> {
  return points.map(([x, y, p]) => [width - x, y, p]);
}

export function buildPaintScene(
  tool: BrushPaintTool,
  style: BrushPaintStyle,
  points: Array<[number, number, number]>,
  width: number,
  height: number,
  seed: number,
): BrushScene {
  const isWatercolor = tool === "watercolor";
  const paths: BrushPath[] = [{ points, closed: isWatercolor }];
  if (style.symmetryX) paths.push({ points: mirrored(points, width), closed: isWatercolor });
  const opacity = Math.max(0, Math.min(1, style.opacity));
  return {
    width,
    height,
    background: null,
    seed,
    brushScale: Math.min(width, height) / BRUSH_SCALE_REFERENCE,
    field: "none",
    fieldTime: 0,
    wiggle: 0,
    curvature: 0.5,
    useStrokeColors: false,
    stroke: {
      enabled: !isWatercolor,
      brush: style.brush,
      color: style.color,
      weight: Math.max(0.05, style.size * SIZE_TO_WEIGHT),
    },
    fill: {
      mode: isWatercolor ? "watercolor" : "none",
      color: style.color,
      opacity: 30 + opacity * 170,
      bleed: style.bleed,
      bleedDirection: "out",
      bleedAngle: null,
      texture: style.texture,
      border: style.border,
      scatter: true,
    },
    hatch: {
      enabled: false,
      brush: style.brush,
      color: style.color,
      weight: 1,
      distance: 8,
      angle: 45,
      rand: 0,
      gradient: 0,
    },
    paths,
  };
}

function copyCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const copy = document.createElement("canvas");
  copy.width = source.width;
  copy.height = source.height;
  copy.getContext("2d")?.drawImage(source, 0, 0);
  return copy;
}

function repaint(canvas: HTMLCanvasElement, session: Session): void {
  session.dirty = false;
  session.lastRender = performance.now();
  const minPoints = session.tool === "watercolor" ? 3 : 2;
  if (session.points.length < minPoints) return;
  const scene = buildPaintScene(session.tool, session.style, session.points, canvas.width, canvas.height, session.seed);
  if (!renderBrushScene(session.layer, scene)) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.save();
  ctx.globalCompositeOperation = "copy";
  ctx.drawImage(session.snapshot, 0, 0);
  // Pigment is subtractive: multiply darkens the paper under a wash the way
  // layered watercolor does, instead of laying an opaque coat on top.
  ctx.globalCompositeOperation = session.tool === "watercolor" ? "multiply" : "source-over";
  ctx.drawImage(session.layer, 0, 0);
  ctx.restore();
}

/** Feeds one pointer sample; starts a session when `isStart`. Returns true when the canvas changed. */
export function brushPaintSample(
  canvas: HTMLCanvasElement,
  tool: BrushPaintTool,
  style: BrushPaintStyle,
  x: number,
  y: number,
  pressure: number,
  isStart: boolean,
): boolean {
  if (!brushEngineAvailable()) return false;
  let session = sessions.get(canvas);
  if (isStart || !session) {
    if (session) repaint(canvas, session);
    session = {
      tool,
      style,
      seed: Math.floor(Math.random() * 1e9),
      snapshot: copyCanvas(canvas),
      layer: document.createElement("canvas"),
      points: [],
      lastRender: 0,
      dirty: false,
    };
    sessions.set(canvas, session);
  }
  const last = session.points[session.points.length - 1];
  if (last && Math.hypot(last[0] - x, last[1] - y) < MIN_POINT_SPACING_PX) return false;
  session.points.push([x, y, Math.max(0.05, Math.min(1.5, pressure))]);
  session.dirty = true;
  if (performance.now() - session.lastRender < REPAINT_INTERVAL_MS) return false;
  repaint(canvas, session);
  return true;
}

/** Final repaint with every sample; call on pointer up. Returns true when the canvas changed. */
export function endBrushPaint(canvas: HTMLCanvasElement): boolean {
  const session = sessions.get(canvas);
  if (!session) return false;
  sessions.delete(canvas);
  if (!session.dirty) return false;
  repaint(canvas, session);
  return true;
}
