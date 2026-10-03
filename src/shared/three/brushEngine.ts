import * as brush from "p5.brush/standalone";
import { BrushPath, BrushScene } from "./brushScene";

/**
 * The one place p5.brush touches the app. p5.brush keeps a single active
 * target in module state, and every target is its own WebGL2 context —
 * browsers cap live contexts at ~16 and three.js already holds one — so
 * everything renders through ONE shared offscreen GL canvas, then gets copied
 * into the caller's own 2D canvas. That copy is what a CanvasTexture wraps.
 * Scenes are capped at BRUSH_ENGINE_MAX_SIZE on each side.
 */

/** Side of the one GL canvas; also the largest scene the engine can paint. */
export const BRUSH_ENGINE_MAX_SIZE = 2048;

interface EngineState {
  canvas: HTMLCanvasElement;
  appliedScale: number;
}

// The GL canvas is created and loaded exactly once, at a fixed size, and
// every scene paints into its top-left corner. In the standalone build each
// brush.load() mints a fresh renderer — new shader program, new framebuffers,
// none of the old ones freed — and after a resize watercolor fills stop
// compositing at all. Never reloading sidesteps both.
//
// The state lives on globalThis because p5.brush's own state does: a second
// copy of this module (HMR, a test harness) must reuse the canvas p5.brush is
// bound to, and the brush scale it has already applied.
const ENGINE_KEY = "__tsujiBrushEngine";
let warned = false;

function engine(): EngineState {
  const slot = globalThis as unknown as Record<string, EngineState | undefined>;
  let state = slot[ENGINE_KEY];
  if (!state) {
    const canvas = document.createElement("canvas");
    canvas.width = BRUSH_ENGINE_MAX_SIZE;
    canvas.height = BRUSH_ENGINE_MAX_SIZE;
    brush.load(canvas);
    brush.angleMode(brush.DEGREES);
    state = { canvas, appliedScale: 1 };
    slot[ENGINE_KEY] = state;
  }
  return state;
}

export function brushEngineAvailable(): boolean {
  return typeof document !== "undefined" && typeof WebGL2RenderingContext !== "undefined";
}

// scaleBrushes() multiplies every registered brush in place, so it is
// cumulative — track what's applied and only ever send the ratio.
function applyBrushScale(state: EngineState, scale: number): void {
  const target = Math.max(0.05, scale);
  if (Math.abs(target - state.appliedScale) < 1e-6) return;
  brush.scaleBrushes(target / state.appliedScale);
  state.appliedScale = target;
}

function applyField(scene: BrushScene): void {
  if (scene.field !== "none") {
    brush.field(scene.field);
    brush.refreshField(scene.fieldTime);
  } else if (scene.wiggle > 0) {
    brush.wiggle(scene.wiggle);
  } else {
    brush.noField();
  }
}

function applyStyle(scene: BrushScene, path: BrushPath): void {
  const stroke = path.stroke ? { ...scene.stroke, ...path.stroke } : scene.stroke;
  const fill = path.fill ? { ...scene.fill, ...path.fill } : scene.fill;
  const { hatch } = scene;
  if (stroke.enabled) {
    const color = scene.useStrokeColors && path.color ? path.color : stroke.color;
    brush.set(stroke.brush, color, stroke.weight);
  } else {
    brush.noStroke();
  }

  brush.noFill();
  brush.noWash();
  if (fill.mode === "watercolor") {
    brush.fill(fill.color, Math.max(1, fill.opacity));
    brush.fillBleed(fill.bleed, fill.bleedDirection, fill.bleedAngle ?? undefined);
    brush.fillTexture(fill.texture, fill.border, fill.scatter);
  } else if (fill.mode === "wash") {
    brush.wash(fill.color, Math.max(1, fill.opacity));
  }

  if (hatch.enabled) {
    brush.hatch(hatch.distance, hatch.angle, { rand: hatch.rand || false, gradient: hatch.gradient || false });
    brush.hatchStyle(hatch.brush, hatch.color, hatch.weight);
  } else {
    brush.noHatch();
  }
}

function drawPath(scene: BrushScene, path: BrushPath): void {
  applyStyle(scene, path);
  // BrushScene is top-left-origin canvas pixels; p5.brush keeps p5 WEBGL's
  // centre origin even in its standalone build, and the scene sits in the
  // engine canvas's top-left corner.
  const half = BRUSH_ENGINE_MAX_SIZE / 2;
  const points = path.points.map(([x, y, p]): [number, number, number] => [x - half, y - half, p]);
  const fillMode = path.fill?.mode ?? scene.fill.mode;
  const strokeEnabled = path.stroke?.enabled ?? scene.stroke.enabled;
  const fillsInterior = fillMode !== "none" || scene.hatch.enabled;
  if (!path.closed && !fillsInterior) {
    if (strokeEnabled) brush.spline(points, scene.curvature);
    return;
  }
  // An open path still gets filled as if closed — that's how a single
  // Grease Pencil gesture becomes a watercolor blot.
  brush.beginShape(scene.curvature);
  for (const [x, y, p] of points) brush.vertex(x, y, p);
  brush.endShape(true);
}

interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Strokes wander off their path by scatter, bleed and edge texture; a vector
// field can carry them anywhere, so only a field-free scene gets a tight box.
function inkRegion(scene: BrushScene): Region {
  const full = { x: 0, y: 0, w: scene.width, h: scene.height };
  if (scene.field !== "none" || scene.wiggle > 0) return full;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of scene.paths) {
    for (const [x, y] of path.points) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  const pad = Math.max(64, 0.12 * Math.max(scene.width, scene.height));
  const x = Math.max(0, Math.floor(minX - pad));
  const y = Math.max(0, Math.floor(minY - pad));
  return {
    x,
    y,
    w: Math.min(scene.width, Math.ceil(maxX + pad)) - x,
    h: Math.min(scene.height, Math.ceil(maxY + pad)) - y,
  };
}

/**
 * Un-composites the white paper back out (GIMP's colour-to-alpha against
 * white): the most transparent colour that, laid over white, gives the
 * pixel. p5.brush can't render onto a transparent target itself — its
 * clear() writes (1,1,1,0), which is not a valid premultiplied colour, and
 * browsers composite it as opaque white.
 */
function whiteToAlpha(ctx: CanvasRenderingContext2D, scene: BrushScene, region: Region): void {
  const image = region.w > 0 && region.h > 0 ? ctx.getImageData(region.x, region.y, region.w, region.h) : null;
  ctx.clearRect(0, 0, scene.width, scene.height);
  if (!image) return;
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const ir = 255 - d[i];
    const ig = 255 - d[i + 1];
    const ib = 255 - d[i + 2];
    const a = Math.max(ir, ig, ib);
    if (a === 0) {
      d[i + 3] = 0;
      continue;
    }
    const k = 255 / a;
    d[i] = 255 - ir * k;
    d[i + 1] = 255 - ig * k;
    d[i + 2] = 255 - ib * k;
    d[i + 3] = a;
  }
  ctx.putImageData(image, region.x, region.y);
}

/**
 * Renders the scene into `target` (resized to match). A null background
 * yields real transparency. Returns false when p5.brush could not run —
 * headless, no WebGL2, or a brush error.
 */
export function renderBrushScene(target: HTMLCanvasElement, scene: BrushScene): boolean {
  if (!brushEngineAvailable()) return false;
  try {
    if (scene.width > BRUSH_ENGINE_MAX_SIZE || scene.height > BRUSH_ENGINE_MAX_SIZE) return false;
    const state = engine();
    const source = state.canvas;
    applyBrushScale(state, scene.brushScale);
    brush.seed(scene.seed);
    brush.noiseSeed(scene.seed);
    brush.clear(scene.background ?? "#ffffff");
    applyField(scene);
    for (const path of scene.paths) drawPath(scene, path);
    brush.render();

    if (target.width !== scene.width) target.width = scene.width;
    if (target.height !== scene.height) target.height = scene.height;
    const ctx = target.getContext("2d", { willReadFrequently: !scene.background });
    if (!ctx) return false;
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(source, 0, 0, scene.width, scene.height, 0, 0, scene.width, scene.height);
    if (!scene.background) whiteToAlpha(ctx, scene, inkRegion(scene));
    return true;
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn("[brushEngine] p5.brush render failed:", err);
    }
    return false;
  }
}
