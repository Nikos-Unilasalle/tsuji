import * as THREE from "three";
import type { GreaseStroke } from "./greasePencil";
import { createNodeCache } from "../nodeCaches";
import {
  BRUSH_NAMES,
  BrushPath,
  BrushScene,
  DrawingPlane,
  dominantPlane,
  planeCoords,
} from "../../three/brushScene";
import { brushEngineAvailable } from "../../three/brushEngine";
import { BrushTextureCache } from "../../three/brushTextureCache";

/**
 * Grease Pencil strokes drawn with p5.brush media. p5.brush is a raster
 * painter, so these strokes can't be ribbons: every p5 stroke of the active
 * drawing is painted into one texture, laid on a quad in whichever local axis
 * plane the strokes are flattest across (XY front, XZ ground, YZ side) —
 * depth across that plane is flattened to the strokes' mean.
 */

export type P5BrushName = (typeof BRUSH_NAMES)[number];
export type P5GreaseBrushType = `p5:${P5BrushName}` | "p5:watercolor";

export const P5_GREASE_BRUSH_TYPES: P5GreaseBrushType[] = [
  ...BRUSH_NAMES.map((n): P5GreaseBrushType => `p5:${n}`),
  "p5:watercolor",
];

export const P5_GREASE_BRUSH_LABELS: Array<[P5GreaseBrushType, string]> = [
  ["p5:2B", "p5 Pencil 2B"],
  ["p5:HB", "p5 Pencil HB"],
  ["p5:2H", "p5 Pencil 2H"],
  ["p5:cpencil", "p5 Colour Pencil"],
  ["p5:charcoal", "p5 Charcoal"],
  ["p5:pastel", "p5 Pastel"],
  ["p5:crayon", "p5 Crayon"],
  ["p5:pen", "p5 Pen"],
  ["p5:rotring", "p5 Rotring"],
  ["p5:marker", "p5 Marker"],
  ["p5:spray", "p5 Spray"],
  ["p5:sumi", "p5 Ink Brush 毛笔"],
  ["p5:sumi-dry", "p5 Dry Ink Brush 飞白"],
  ["p5:watercolor", "p5 Watercolour Wash"],
];

export function isP5GreaseBrush(type: unknown): type is P5GreaseBrushType {
  return typeof type === "string" && (P5_GREASE_BRUSH_TYPES as string[]).includes(type);
}

export interface GreaseP5Options {
  /** Texture pixels per Grease Pencil unit — also sets how big the media's grain reads. */
  density: number;
  maxTextureSize: number;
  seed: number;
  /** Watercolor pigment load, 0-255 (p5.brush's unit). */
  opacity: number;
  bleed: number;
  texture: number;
  border: number;
  defaultColor: string;
  defaultWidth: number;
}

export interface GreaseP5Layout {
  scene: BrushScene;
  /** Quad centre and size in Grease Pencil local units. */
  center: THREE.Vector3;
  plane: DrawingPlane;
  width: number;
  height: number;
}

// Matches Brush Canvas: one p5.brush unit per 200px of a 1024² canvas at
// 256px/unit, so the same brush reads the same size in both nodes.
const BRUSH_SCALE_PER_DENSITY = 1 / 50;
// Ribbon width 4 (the GP default) ≈ p5 weight 1.5, Brush Canvas's default.
const WIDTH_TO_WEIGHT = 1 / 2.7;
const MIN_POINT_SPACING_PX = 3;
const MAX_POINTS_PER_STROKE = 400;

function strokePixels(
  stroke: GreaseStroke,
  plane: DrawingPlane,
  toPx: (u: number, v: number) => [number, number],
): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (const p of stroke.points) {
    const [x, y] = toPx(...planeCoords(plane, p));
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const last = out[out.length - 1];
    if (last && Math.hypot(last[0] - x, last[1] - y) < MIN_POINT_SPACING_PX) continue;
    out.push([x, y, 0.2 + Math.max(0, Math.min(1, p.pressure ?? 0.6))]);
  }
  if (out.length <= MAX_POINTS_PER_STROKE) return out;
  const step = (out.length - 1) / (MAX_POINTS_PER_STROKE - 1);
  return Array.from({ length: MAX_POINTS_PER_STROKE }, (_, i) => out[Math.round(i * step)]);
}

export function buildGreaseP5Layout(strokes: GreaseStroke[], opts: GreaseP5Options): GreaseP5Layout | null {
  const drawable = strokes.filter((s) => isP5GreaseBrush(s.brushType) && s.points.length >= 2);
  if (drawable.length === 0) return null;

  const plane = dominantPlane(drawable.flatMap((s) => s.points));
  const depthOf = (p: { x: number; y: number; z: number }) => (plane === "xy" ? p.z : plane === "xz" ? p.y : p.x);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let depthSum = 0;
  let depthCount = 0;
  let maxWidth = 0;
  for (const s of drawable) {
    maxWidth = Math.max(maxWidth, s.width || opts.defaultWidth);
    for (const p of s.points) {
      const [u, v] = planeCoords(plane, p);
      minX = Math.min(minX, u);
      minY = Math.min(minY, v);
      maxX = Math.max(maxX, u);
      maxY = Math.max(maxY, v);
      depthSum += depthOf(p);
      depthCount++;
    }
  }
  if (!Number.isFinite(minX)) return null;

  // Room for the stroke's own width plus watercolor bleed, which spreads
  // well past the drawn outline.
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const pad = maxWidth * 0.06 + 0.15 * Math.max(spanX, spanY, 0.5);
  const worldW = spanX + 2 * pad;
  const worldH = spanY + 2 * pad;
  const density = Math.min(
    Math.max(1, opts.density),
    opts.maxTextureSize / Math.max(worldW, worldH),
  );
  const width = Math.max(16, Math.round(worldW * density));
  const height = Math.max(16, Math.round(worldH * density));
  const left = minX - pad;
  const top = maxY + pad;
  const toPx = (u: number, v: number): [number, number] => [(u - left) * density, (top - v) * density];

  const paths: BrushPath[] = [];
  for (const s of drawable) {
    const points = strokePixels(s, plane, toPx);
    if (points.length < 2) continue;
    const color = s.color || opts.defaultColor;
    const isWatercolor = s.brushType === "p5:watercolor";
    const weight = Math.max(0.05, (s.width || opts.defaultWidth) * WIDTH_TO_WEIGHT);
    if (isWatercolor) {
      paths.push({
        points,
        closed: true,
        stroke: { enabled: false },
        fill: { mode: "watercolor", color },
      });
      continue;
    }
    const brushName = String(s.brushType).slice(3);
    const filled = Boolean(s.fill);
    paths.push({
      points,
      closed: Boolean(s.closed) || filled,
      stroke: { enabled: true, brush: brushName, color, weight },
      fill: filled ? { mode: "watercolor", color: s.fillColor || color } : { mode: "none" },
    });
  }
  if (paths.length === 0) return null;

  const scene: BrushScene = {
    width,
    height,
    background: null,
    seed: opts.seed,
    brushScale: density * BRUSH_SCALE_PER_DENSITY,
    field: "none",
    fieldTime: 0,
    wiggle: 0,
    curvature: 0.5,
    useStrokeColors: false,
    stroke: { enabled: true, brush: "2B", color: opts.defaultColor, weight: 1.5 },
    fill: {
      mode: "none",
      color: opts.defaultColor,
      opacity: Math.max(1, Math.min(255, opts.opacity)),
      bleed: opts.bleed,
      bleedDirection: "out",
      bleedAngle: null,
      texture: opts.texture,
      border: opts.border,
      scatter: true,
    },
    hatch: { enabled: false, brush: "2B", color: opts.defaultColor, weight: 1, distance: 8, angle: 45, rand: 0, gradient: 0 },
    paths,
  };

  const u = left + worldW / 2;
  const v = top - worldH / 2;
  const depth = depthSum / Math.max(1, depthCount);
  const center =
    plane === "xy" ? new THREE.Vector3(u, v, depth) : plane === "xz" ? new THREE.Vector3(u, depth, -v) : new THREE.Vector3(depth, v, -u);
  return { scene, center, plane, width: worldW, height: worldH };
}

interface GreaseP5State {
  mesh?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  textures: BrushTextureCache;
  geometryKey?: string;
}

// About one grid cell per tenth of a unit: dense enough for Wave / Twist /
// any vertex deformer downstream to bend the painting smoothly.
const GRID_CELL = 0.1;
const MAX_GRID_SEGMENTS = 128;

/**
 * The painted quad as a subdivided grid with its pose baked into the
 * vertices, in the Grease Pencil group's own space — the same convention as
 * the ink ribbons. Deformers clone a mesh's geometry and drop its object
 * transform, so a unit quad placed by position/scale would collapse to a
 * 1×1 square at the origin, and four vertices could not bend anyway.
 */
export function buildGreaseP5Geometry(layout: GreaseP5Layout): THREE.BufferGeometry {
  const segX = Math.max(1, Math.min(MAX_GRID_SEGMENTS, Math.round(layout.width / GRID_CELL)));
  const segY = Math.max(1, Math.min(MAX_GRID_SEGMENTS, Math.round(layout.height / GRID_CELL)));
  const geometry = new THREE.PlaneGeometry(layout.width, layout.height, segX, segY);
  // PlaneGeometry lies in XY; turn it so its +u/+v match planeCoords.
  if (layout.plane === "xz") geometry.rotateX(-Math.PI / 2);
  else if (layout.plane === "yz") geometry.rotateY(Math.PI / 2);
  geometry.translate(layout.center.x, layout.center.y, layout.center.z);
  return geometry;
}

const greaseP5Cache = createNodeCache<GreaseP5State>((s) => {
  s.textures.dispose();
  s.mesh?.geometry.dispose();
  s.mesh?.material.dispose();
});

/**
 * Keeps the node's p5 layer mesh in `group` in sync with `strokes`. Only
 * repaints when the painted result would change — a held drawing costs a
 * signature hash per frame, not a repaint.
 */
export function syncGreaseP5Layer(
  group: THREE.Group,
  nodeId: string,
  strokes: GreaseStroke[],
  opts: GreaseP5Options,
  /** Timeline frame while playing — see BrushTextureCache. */
  frameKey?: number,
): void {
  let state = greaseP5Cache.get(nodeId);
  const layout = brushEngineAvailable() ? buildGreaseP5Layout(strokes, opts) : null;
  if (!layout) {
    if (state?.mesh) state.mesh.visible = false;
    return;
  }
  if (!state) {
    state = { textures: new BrushTextureCache() };
    greaseP5Cache.set(nodeId, state);
  }
  if (!state.mesh) {
    state.mesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1.5,
        polygonOffsetUnits: -1.5,
      }),
    );
    // Above solid fills (8), below vector ink ribbons (10).
    state.mesh.renderOrder = 9;
  }
  const mesh = state.mesh;
  if (mesh.parent !== group) group.add(mesh);
  mesh.userData.nodeId = nodeId;

  const texture = state.textures.resolve(layout.scene, frameKey);
  if (!texture) {
    mesh.visible = false;
    return;
  }
  if (mesh.material.map !== texture) {
    mesh.material.map = texture;
    mesh.material.needsUpdate = true;
  }
  // Rebuilt only when the painting's footprint moves, so a held drawing keeps
  // one geometry (downstream caches key on its uuid).
  const c = layout.center;
  const geometryKey = `${layout.plane}:${layout.width}:${layout.height}:${c.x}:${c.y}:${c.z}`;
  if (state.geometryKey !== geometryKey) {
    mesh.geometry.dispose();
    mesh.geometry = buildGreaseP5Geometry(layout);
    state.geometryKey = geometryKey;
  }
  mesh.visible = true;
}
