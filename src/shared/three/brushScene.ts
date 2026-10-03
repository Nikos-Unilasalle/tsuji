import * as THREE from "three";

/**
 * Pure description of one p5.brush drawing pass, in canvas pixels (origin
 * top-left, y down). Kept free of p5.brush itself so it can be built and
 * tested headless; brushEngine.ts is the only module that turns it into
 * pixels.
 */

export const BRUSH_NAMES = [
  "HB",
  "2B",
  "2H",
  "cpencil",
  "pen",
  "rotring",
  "pastel",
  "crayon",
  "charcoal",
  "marker",
  "spray",
] as const;

export const BRUSH_FIELDS = ["none", "hand", "curved", "zigzag", "waves", "seabed", "spiral", "columns"] as const;

export type BrushFillMode = "none" | "watercolor" | "wash";

export interface BrushPath {
  /** [x, y, pressure] in canvas pixels. */
  points: Array<[number, number, number]>;
  closed: boolean;
  /** Per-path stroke colour override (Grease Pencil strokes carry their own). */
  color?: string;
  /** Per-path style overrides, merged over the scene's — for drawings that mix media. */
  stroke?: Partial<BrushStrokeStyle>;
  fill?: Partial<BrushFillStyle>;
}

export interface BrushStrokeStyle {
  enabled: boolean;
  brush: string;
  color: string;
  weight: number;
}

export interface BrushFillStyle {
  mode: BrushFillMode;
  color: string;
  /** 0..255, p5.brush's own unit. */
  opacity: number;
  bleed: number;
  bleedDirection: "in" | "out";
  /** Degrees, or null for a random wash direction per shape. */
  bleedAngle: number | null;
  texture: number;
  border: number;
  scatter: boolean;
}

export interface BrushHatchStyle {
  enabled: boolean;
  brush: string;
  color: string;
  weight: number;
  distance: number;
  /** Degrees. */
  angle: number;
  rand: number;
  gradient: number;
}

export interface BrushScene {
  width: number;
  height: number;
  /** null = transparent. */
  background: string | null;
  seed: number;
  /** Multiplier on p5.brush's built-in brush sizes, already resolution-aware. */
  brushScale: number;
  field: string;
  fieldTime: number;
  wiggle: number;
  curvature: number;
  useStrokeColors: boolean;
  stroke: BrushStrokeStyle;
  fill: BrushFillStyle;
  hatch: BrushHatchStyle;
  paths: BrushPath[];
}

/** Optional per-curve data a producer can attach (Grease Pencil does). */
export interface CurveStrokeMeta {
  pressures?: number[];
  color?: string;
}

export const curveStrokeMeta = new WeakMap<THREE.Curve<THREE.Vector3>, CurveStrokeMeta>();

export interface BrushFrame {
  mode: "auto" | "fixed";
  /** Fraction of the short side left empty around auto-fitted content. */
  margin: number;
  center: THREE.Vector3;
  /** World units spanning the canvas width in fixed mode. */
  size: number;
}

const MAX_POINTS_PER_PATH = 240;
const PIXELS_PER_SAMPLE = 6;

export function asCurveList(input: unknown): THREE.Curve<THREE.Vector3>[] {
  if (input instanceof THREE.Curve) return [input as THREE.Curve<THREE.Vector3>];
  if (!Array.isArray(input)) return [];
  return input.filter((c): c is THREE.Curve<THREE.Vector3> => c instanceof THREE.Curve);
}

function curveIsClosed(curve: THREE.Curve<THREE.Vector3>): boolean {
  if (curve instanceof THREE.CatmullRomCurve3) return curve.closed;
  const a = curve.getPoint(0);
  const b = curve.getPoint(1);
  return a.distanceToSquared(b) < 1e-10;
}

function pressureAt(pressures: number[] | undefined, t: number): number {
  if (!pressures || pressures.length === 0) return 1;
  const f = t * (pressures.length - 1);
  const i = Math.floor(f);
  const a = pressures[i] ?? 1;
  const b = pressures[Math.min(pressures.length - 1, i + 1)] ?? a;
  const p = a + (b - a) * (f - i);
  return Number.isFinite(p) ? Math.max(0.05, Math.min(2, p)) : 1;
}

interface WorldPath {
  points: THREE.Vector3[];
  pressures: number[];
  closed: boolean;
  color?: string;
}

export type DrawingPlane = "xy" | "xz" | "yz";

/**
 * The axis plane a drawing lies in: the one across which it is flattest.
 * Curve primitives and ground-drawn Grease Pencil strokes live in XZ, a
 * front-view drawing in XY. Ties go to XY.
 */
export function dominantPlane(points: Iterable<{ x: number; y: number; z: number }>): DrawingPlane {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    const c = [p.x, p.y, p.z];
    for (let i = 0; i < 3; i++) {
      if (c[i] < min[i]) min[i] = c[i];
      if (c[i] > max[i]) max[i] = c[i];
    }
  }
  const span = min.map((m, i) => (Number.isFinite(m) ? max[i] - m : 0));
  if (span[2] <= span[1] && span[2] <= span[0]) return "xy";
  return span[1] <= span[0] ? "xz" : "yz";
}

/**
 * In-plane coordinates, oriented the way the plane is normally looked at:
 * XY from the front, XZ from above (-Z is up), YZ from +X (-Z is right).
 */
export function planeCoords(plane: DrawingPlane, p: { x: number; y: number; z: number }): [number, number] {
  if (plane === "xz") return [p.x, -p.z];
  if (plane === "yz") return [-p.z, p.y];
  return [p.x, p.y];
}

function sampleCurves(curves: THREE.Curve<THREE.Vector3>[], pose?: THREE.Matrix4): WorldPath[] {
  const out: WorldPath[] = [];
  for (const curve of curves) {
    const length = curve.getLength();
    if (!Number.isFinite(length) || length <= 0) continue;
    const meta = curveStrokeMeta.get(curve);
    // Sample count is refined later against the pixel scale; this coarse pass
    // only has to be dense enough to find the bounding box.
    const ownPoints = curve instanceof THREE.CatmullRomCurve3 ? curve.points.length : 0;
    const count = Math.min(MAX_POINTS_PER_PATH, Math.max(16, ownPoints * 2));
    const points = curve.getSpacedPoints(count);
    if (pose) for (const p of points) p.applyMatrix4(pose);
    const pressures = points.map((_, i) => pressureAt(meta?.pressures, i / count));
    out.push({ points, pressures, closed: curveIsClosed(curve), color: meta?.color });
  }
  return out;
}

/** Maps world XY into canvas pixels; y is flipped (canvas y grows down). */
export function computeFrameTransform(
  paths: { points: THREE.Vector3[] }[],
  frame: BrushFrame,
  width: number,
  height: number,
): { scale: number; offsetX: number; offsetY: number } {
  if (frame.mode === "fixed") {
    const scale = width / Math.max(1e-6, frame.size);
    return {
      scale,
      offsetX: width / 2 - frame.center.x * scale,
      offsetY: height / 2 + frame.center.y * scale,
    };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of paths) {
    for (const p of path.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return { scale: 1, offsetX: width / 2, offsetY: height / 2 };
  const margin = Math.max(0, Math.min(0.45, frame.margin));
  const usableW = width * (1 - 2 * margin);
  const usableH = height * (1 - 2 * margin);
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const scale = Math.min(usableW / spanX, usableH / spanY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { scale, offsetX: width / 2 - cx * scale, offsetY: height / 2 + cy * scale };
}

function resample(path: WorldPath, pixelLength: number): { points: THREE.Vector3[]; pressures: number[] } {
  const target = Math.max(2, Math.min(MAX_POINTS_PER_PATH, Math.round(pixelLength / PIXELS_PER_SAMPLE)));
  if (target >= path.points.length) return path;
  const points: THREE.Vector3[] = [];
  const pressures: number[] = [];
  const last = path.points.length - 1;
  for (let i = 0; i <= target; i++) {
    const idx = Math.round((i / target) * last);
    points.push(path.points[idx]);
    pressures.push(path.pressures[idx]);
  }
  return { points, pressures };
}

export function buildBrushPaths(
  curves: THREE.Curve<THREE.Vector3>[],
  frame: BrushFrame,
  width: number,
  height: number,
  pose?: THREE.Matrix4,
): BrushPath[] {
  const sampled = sampleCurves(curves, pose);
  const plane = dominantPlane(sampled.flatMap((p) => p.points));
  const flatten = (v: THREE.Vector3) => {
    const [u, w] = planeCoords(plane, v);
    return new THREE.Vector3(u, w, 0);
  };
  const world = sampled.map((p) => ({ ...p, points: p.points.map(flatten) }));
  const flatFrame = { ...frame, center: flatten(frame.center) };
  const { scale, offsetX, offsetY } = computeFrameTransform(world, flatFrame, width, height);
  const paths: BrushPath[] = [];
  for (const path of world) {
    let worldLength = 0;
    for (let i = 1; i < path.points.length; i++) worldLength += path.points[i].distanceTo(path.points[i - 1]);
    const { points, pressures } = resample(path, worldLength * scale);
    const px: Array<[number, number, number]> = [];
    for (let i = 0; i < points.length; i++) {
      const x = offsetX + points[i].x * scale;
      const y = offsetY - points[i].y * scale;
      if (Number.isFinite(x) && Number.isFinite(y)) px.push([x, y, pressures[i]]);
    }
    // A closed CatmullRom's spaced samples repeat the start point at the end;
    // p5.brush closes the shape itself, so the duplicate would leave a kink.
    if (path.closed && px.length > 2) {
      const [ax, ay] = px[0];
      const [bx, by] = px[px.length - 1];
      if (Math.hypot(ax - bx, ay - by) < 0.5) px.pop();
    }
    if (px.length >= 2) paths.push({ points: px, closed: path.closed, color: path.color });
  }
  return paths;
}

/** FNV-1a over everything that changes pixels — cheap enough to run every frame. */
export function brushSceneSignature(scene: BrushScene): string {
  let h = 0x811c9dc5;
  const mix = (n: number) => {
    h ^= n & 0xffff;
    h = Math.imul(h, 0x01000193);
    h ^= n >>> 16;
    h = Math.imul(h, 0x01000193);
  };
  for (const path of scene.paths) {
    mix(path.closed ? 1 : 2);
    for (const [x, y, p] of path.points) {
      mix(Math.round(x * 4));
      mix(Math.round(y * 4));
      mix(Math.round(p * 100));
    }
    mix(0xffff);
  }
  const { paths: _paths, ...rest } = scene;
  const perPath = scene.paths.map((p) => `${p.color ?? ""}${p.stroke ? JSON.stringify(p.stroke) : ""}${p.fill ? JSON.stringify(p.fill) : ""}`);
  return `${(h >>> 0).toString(16)}:${scene.paths.length}:${JSON.stringify(rest)}:${perPath.join(",")}`;
}
