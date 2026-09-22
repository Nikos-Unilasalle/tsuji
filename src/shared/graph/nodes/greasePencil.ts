import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { composeNativeMatrix } from "./transform";

export interface StrokePoint {
  x: number;
  y: number;
  z: number;
  pressure: number; // 0.0 to 1.0
  nx?: number;
  ny?: number;
  nz?: number;
  /** Stylus tilt direction, in radians within the drawing plane. */
  tiltAngle?: number;
  /** How far the stylus is tilted from vertical, 0 (upright) to 1 (flat). */
  tiltInc?: number;
}

export type GreaseBrushType =
  | "ink_pen"
  | "ink_pen_rough"
  | "marker_bold"
  | "airbrush"
  | "pencil"
  | "charcoal"
  | "watercolor";

/** Brush ids handed to the shader for procedural grain (see applyStrokeEdgeAA). */
export const BRUSH_SHADER_ID: Record<GreaseBrushType, number> = {
  ink_pen: 0,
  ink_pen_rough: 0,
  marker_bold: 0,
  airbrush: 0,
  pencil: 1,
  charcoal: 2,
  watercolor: 3,
};

export interface GreaseStroke {
  id: string;
  points: StrokePoint[];
  color?: string; // hex string, e.g. "#38bdf8"
  width?: number; // base stroke width in px
  brushType?: GreaseBrushType;
  fill?: boolean;
  fillColor?: string;
  closed?: boolean;
  /** Regions subtracted from this stroke's fill by the Carver tool. */
  holes?: StrokePoint[][];
}

export interface KeyframeDrawing {
  frame: number;
  strokes: GreaseStroke[];
}

export interface GreasePencilState {
  group?: THREE.Group;
  activeMesh?: THREE.Mesh;
  activeGeo?: THREE.BufferGeometry;
  activeMat?: THREE.MeshBasicMaterial;
  fillMesh?: THREE.Mesh;
  fillGeo?: THREE.BufferGeometry;
  fillMat?: THREE.MeshBasicMaterial;
  onionPrevMesh?: THREE.Mesh;
  onionPrevGeo?: THREE.BufferGeometry;
  onionPrevMat?: THREE.MeshBasicMaterial;
  onionNextMesh?: THREE.Mesh;
  onionNextGeo?: THREE.BufferGeometry;
  onionNextMat?: THREE.MeshBasicMaterial;
  lastSignature?: string;
}

const greasePencilCache = createNodeCache<GreasePencilState>((s) => {
  if (s.activeGeo) s.activeGeo.dispose();
  if (s.activeMat) s.activeMat.dispose();
  if (s.fillGeo) s.fillGeo.dispose();
  if (s.fillMat) s.fillMat.dispose();
  if (s.onionPrevGeo) s.onionPrevGeo.dispose();
  if (s.onionPrevMat) s.onionPrevMat.dispose();
  if (s.onionNextGeo) s.onionNextGeo.dispose();
  if (s.onionNextMat) s.onionNextMat.dispose();
  if (s.group) disposeObject3D(s.group);
});

function getState(nodeId: string): GreasePencilState {
  let state = greasePencilCache.get(nodeId);
  if (!state) {
    state = {};
    greasePencilCache.set(nodeId, state);
  }
  return state;
}

/**
 * Finds the drawing corresponding to the active frame (holding the latest keyframe <= currentFrame).
 */
export function resolveActiveDrawing(frames: KeyframeDrawing[], currentFrame: number): KeyframeDrawing | null {
  if (!frames || frames.length === 0) return null;
  const sorted = [...frames].sort((a, b) => a.frame - b.frame);
  let active: KeyframeDrawing | null = null;
  for (const f of sorted) {
    if (f.frame <= currentFrame) {
      active = f;
    } else {
      break;
    }
  }
  return active || sorted[0];
}

/**
 * Resolves adjacent drawings for Onion Skinning.
 */
export function resolveOnionSkinDrawings(
  frames: KeyframeDrawing[],
  currentFrame: number,
  beforeCount = 1,
  afterCount = 1,
): { prev: KeyframeDrawing[]; next: KeyframeDrawing[] } {
  if (!frames || frames.length === 0) return { prev: [], next: [] };
  const sorted = [...frames].sort((a, b) => a.frame - b.frame);
  const prev: KeyframeDrawing[] = [];
  const next: KeyframeDrawing[] = [];

  for (const f of sorted) {
    if (f.frame < currentFrame) {
      prev.push(f);
    } else if (f.frame > currentFrame) {
      next.push(f);
    }
  }

  return {
    prev: beforeCount > 0 ? prev.slice(-beforeCount) : [],
    next: afterCount > 0 ? next.slice(0, afterCount) : [],
  };
}

/**
 * Builds a variable-width polygonal ribbon geometry for grease strokes.
 * Each vertex width along the stroke is directly scaled by the recorded pressure (speed/stylus),
 * yielding an authentic calligraphic stroke with natural thickness dynamics.
 */
/**
 * Builds solid fill mesh geometry for strokes that have solid fill enabled.
 * Triangulates the interior polygon of each closed or open stroke loop using native ear-clipping.
 */
export function buildStrokesFillGeometry(
  strokes: GreaseStroke[],
  defaultFillColor: string,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const tmpColor = new THREE.Color();
  let vertexOffset = 0;

  for (const stroke of strokes) {
    if (!stroke.fill || !stroke.points || stroke.points.length < 3) continue;

    tmpColor.set(stroke.fillColor || stroke.color || defaultFillColor);
    const pts = stroke.points;

    // Newell's method for normal of 3D polygon
    const normal = new THREE.Vector3();
    for (let i = 0; i < pts.length; i++) {
      const p1 = pts[i];
      const p2 = pts[(i + 1) % pts.length];
      normal.x += (p1.y - p2.y) * (p1.z + p2.z);
      normal.y += (p1.z - p2.z) * (p1.x + p2.x);
      normal.z += (p1.x - p2.x) * (p1.y + p2.y);
    }
    if (normal.lengthSq() < 1e-6) {
      normal.set(0, 1, 0);
    } else {
      normal.normalize();
    }

    // Build orthonormal 2D basis (U, V) on the polygon plane
    let u = new THREE.Vector3();
    if (Math.abs(normal.y) < 0.9) {
      u.crossVectors(normal, new THREE.Vector3(0, 1, 0)).normalize();
    } else {
      u.crossVectors(normal, new THREE.Vector3(1, 0, 0)).normalize();
    }
    const v = new THREE.Vector3().crossVectors(normal, u).normalize();
    const origin = new THREE.Vector3(pts[0].x, pts[0].y, pts[0].z);

    // Project points into 2D plane coordinates
    const to2D = (p: StrokePoint) => {
      const diff = new THREE.Vector3(p.x, p.y, p.z).sub(origin);
      return new THREE.Vector2(diff.dot(u), diff.dot(v));
    };
    const pts2D: THREE.Vector2[] = pts.map(to2D);

    // Holes punched by the Carver tool, triangulated together with the
    // outline so the fill really is perforated rather than overdrawn.
    const holes3D = (stroke.holes ?? []).filter((h) => h && h.length >= 3);
    const holes2D = holes3D.map((h) => h.map(to2D));

    // Triangulate using Three.js built-in ShapeUtils ear-clipping
    const triangles = THREE.ShapeUtils.triangulateShape(pts2D, holes2D);
    if (!triangles || triangles.length === 0) continue;

    const startV = vertexOffset;
    // Vertex order must match what triangulateShape indexed: outline first,
    // then each hole in turn.
    for (const p of pts) {
      positions.push(p.x, p.y, p.z);
      colors.push(tmpColor.r, tmpColor.g, tmpColor.b);
      vertexOffset++;
    }
    for (const hole of holes3D) {
      for (const p of hole) {
        positions.push(p.x, p.y, p.z);
        colors.push(tmpColor.r, tmpColor.g, tmpColor.b);
        vertexOffset++;
      }
    }

    for (const tri of triangles) {
      indices.push(startV + tri[0], startV + tri[1], startV + tri[2]);
    }
  }

  const geo = new THREE.BufferGeometry();
  if (positions.length > 0) {
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
  }
  return geo;
}

/**
 * Resamples a raw stroke polyline along a centripetal Catmull-Rom spline at a
 * roughly constant arc-length spacing.
 *
 * Raw tablet samples are unevenly spaced (fast motion = wide gaps) and reveal
 * visible facets when the viewport is zoomed in. Resampling gives the ribbon
 * builder a dense, evenly spaced point set so joins stay smooth at any zoom,
 * while pressure and surface normals are interpolated along with position.
 */
export function resampleStrokePoints(points: StrokePoint[], spacing: number): StrokePoint[] {
  if (!points || points.length < 3 || !(spacing > 0)) return points ?? [];

  // Drop duplicate samples: they make the Catmull-Rom tangents degenerate.
  const src: StrokePoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = src[src.length - 1];
    const b = points[i];
    if (Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > 1e-6) src.push(b);
  }
  if (src.length < 3) return points;

  let totalLength = 0;
  for (let i = 1; i < src.length; i++) {
    totalLength += Math.hypot(src[i].x - src[i - 1].x, src[i].y - src[i - 1].y, src[i].z - src[i - 1].z);
  }
  if (totalLength <= spacing) return points;

  // Guard against pathological point counts on very long strokes.
  const maxPoints = 6000;
  const step = Math.max(spacing, totalLength / maxPoints);

  const vecs = src.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  const curve = new THREE.CatmullRomCurve3(vecs, false, "centripetal");
  const sampleCount = Math.max(2, Math.ceil(totalLength / step));

  // Map curve parameter -> source index so pressure/normals follow the position.
  const out: StrokePoint[] = [];
  for (let i = 0; i <= sampleCount; i++) {
    const t = i / sampleCount;
    const pos = curve.getPoint(t);
    const srcT = t * (src.length - 1);
    const i0 = Math.min(src.length - 1, Math.floor(srcT));
    const i1 = Math.min(src.length - 1, i0 + 1);
    const f = srcT - i0;
    const a = src[i0];
    const b = src[i1];

    const pt: StrokePoint = {
      x: pos.x,
      y: pos.y,
      z: pos.z,
      pressure: (a.pressure ?? 0.6) * (1 - f) + (b.pressure ?? 0.6) * f,
    };

    if (a.nx !== undefined && b.nx !== undefined) {
      const n = new THREE.Vector3(
        (a.nx ?? 0) * (1 - f) + (b.nx ?? 0) * f,
        (a.ny ?? 0) * (1 - f) + (b.ny ?? 0) * f,
        (a.nz ?? 0) * (1 - f) + (b.nz ?? 0) * f,
      );
      if (n.lengthSq() > 1e-8) {
        n.normalize();
        pt.nx = n.x;
        pt.ny = n.y;
        pt.nz = n.z;
      }
    }

    // Stylus tilt has to survive resampling, or the chisel brush loses the
    // nib angle the artist drew with. The azimuth is interpolated the short
    // way round so a stroke crossing ±π does not spin the nib.
    if (a.tiltAngle !== undefined || b.tiltAngle !== undefined) {
      const angA = a.tiltAngle ?? b.tiltAngle ?? 0;
      const angB = b.tiltAngle ?? a.tiltAngle ?? 0;
      let delta = angB - angA;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      pt.tiltAngle = angA + delta * f;
    }
    if (a.tiltInc !== undefined || b.tiltInc !== undefined) {
      pt.tiltInc = (a.tiltInc ?? b.tiltInc ?? 0) * (1 - f) + (b.tiltInc ?? a.tiltInc ?? 0) * f;
    }

    out.push(pt);
  }

  return out;
}

/**
 * Patches a MeshBasicMaterial so strokes get an anti-aliased, feathered edge
 * and per-brush media grain.
 *
 * The ribbon builder writes two attributes:
 * - `aEdge`: normalized offset from the stroke centerline (|aEdge| == 1 on the
 *   silhouette). Alpha fades over one screen pixel of that distance field,
 *   which kills the stair-stepping plain triangle edges show on diagonals.
 * - `aGrain`: (distance along the stroke in half-widths, brush id). Textured
 *   brushes use it to modulate alpha, so pencil tooth, charcoal break-up and
 *   watercolour pooling come out of the shader instead of needing texture
 *   assets — and they stay resolution-independent when the view is zoomed.
 */
export function applyStrokeEdgeAA(material: THREE.MeshBasicMaterial): THREE.MeshBasicMaterial {
  if (material.userData.strokeEdgeAA) return material;
  material.userData.strokeEdgeAA = true;
  material.transparent = true;

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute vec2 aEdge;\nattribute vec2 aGrain;\nvarying vec2 vEdge;\nvarying vec2 vGrain;",
      )
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvEdge = aEdge;\nvGrain = aGrain;");

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        [
          "#include <common>",
          "varying vec2 vEdge;",
          "varying vec2 vGrain;",
          "float strokeHash(vec2 p) {",
          "  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);",
          "}",
          "float strokeNoise(vec2 p) {",
          "  vec2 i = floor(p);",
          "  vec2 f = fract(p);",
          "  vec2 w = f * f * (3.0 - 2.0 * f);",
          "  float a = strokeHash(i);",
          "  float b = strokeHash(i + vec2(1.0, 0.0));",
          "  float c = strokeHash(i + vec2(0.0, 1.0));",
          "  float d = strokeHash(i + vec2(1.0, 1.0));",
          "  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);",
          "}",
        ].join("\n"),
      )
      .replace(
        "#include <dithering_fragment>",
        [
          "#include <dithering_fragment>",
          "float edgeDist = length(vEdge);",
          "float edgeWidth = max(fwidth(edgeDist), 1e-4);",
          "float strokeAlpha = 1.0 - smoothstep(1.0 - edgeWidth, 1.0, edgeDist);",
          "int brushId = int(vGrain.y + 0.5);",
          "vec2 grainUv = vec2(vGrain.x, vEdge.x);",
          "if (brushId == 1) {",
          // Pencil: fine paper tooth, biting harder where the lead rides light.
          "  float tooth = strokeNoise(grainUv * vec2(9.0, 5.0));",
          "  tooth = mix(tooth, strokeNoise(grainUv * vec2(31.0, 17.0)), 0.5);",
          "  strokeAlpha *= mix(0.45, 1.0, smoothstep(0.25, 0.8, tooth));",
          "  strokeAlpha *= mix(0.65, 1.0, 1.0 - abs(vEdge.x));",
          "} else if (brushId == 2) {",
          // Charcoal: coarse, high-contrast break-up with dry skips.
          "  float grain = strokeNoise(grainUv * vec2(5.0, 3.5));",
          "  float speck = strokeNoise(grainUv * vec2(23.0, 13.0));",
          "  strokeAlpha *= smoothstep(0.18, 0.62, grain * 0.65 + speck * 0.35);",
          "} else if (brushId == 3) {",
          // Watercolour: translucent body with pigment pooling at the edges.
          "  float wash = strokeNoise(grainUv * vec2(2.5, 2.0));",
          "  float pooling = smoothstep(0.35, 1.0, abs(vEdge.x));",
          "  strokeAlpha *= (0.28 + 0.34 * wash + 0.45 * pooling);",
          "}",
          "gl_FragColor.a *= clamp(strokeAlpha, 0.0, 1.0);",
          "if (gl_FragColor.a < 0.004) discard;",
        ].join("\n"),
      );
  };
  material.customProgramCacheKey = () => "strokeEdgeAA_v2";
  material.needsUpdate = true;
  return material;
}

const CAP_SEGMENTS = 10;

/**
 * Builds a variable-width polygonal ribbon geometry for grease strokes.
 * Supports distinct brush presets:
 * - "ink_pen": Smooth, clean vector calligraphy ribbon.
 * - "ink_pen_rough": Hand-drawn rough ink texture with micro-jittered edges.
 * - "marker_bold": Chisel-angled bold marker stroke, steered by stylus tilt.
 * - "airbrush": Soft stippled spray micro-droplets along trajectory.
 * - "pencil" / "charcoal" / "watercolor": textured media, shaded from the
 *   `aGrain` coordinate by the material patched with `applyStrokeEdgeAA`.
 *
 * Geometry quality notes:
 * - Points are resampled onto a centripetal Catmull-Rom spline first, so the
 *   ribbon stays smooth however coarse the raw tablet samples were.
 * - Corners are mitered (with a bevel fallback past the miter limit) instead of
 *   simply offsetting along the averaged tangent, which used to pinch the
 *   ribbon on tight turns.
 * - Both stroke ends get a round cap, and every vertex carries an `aEdge`
 *   distance-field coordinate consumed by `applyStrokeEdgeAA` for smooth edges.
 */
export function buildStrokesRibbonGeometry(
  strokes: GreaseStroke[],
  defaultColorHex: string,
  baseBrushSize = 4,
  overrideColorHex?: string,
  _overrideOpacity?: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const edges: number[] = [];
  const grains: number[] = [];
  const indices: number[] = [];
  const tmpColor = new THREE.Color();
  let vertexOffset = 0;
  // Set per stroke, before its vertices are emitted.
  let grainAlong = 0;
  let grainBrush = 0;

  const pushVertex = (x: number, y: number, z: number, ex: number, ey: number) => {
    positions.push(x, y, z);
    colors.push(tmpColor.r, tmpColor.g, tmpColor.b);
    edges.push(ex, ey);
    grains.push(grainAlong, grainBrush);
    return vertexOffset++;
  };

  for (const stroke of strokes) {
    const rawPts = stroke.points;
    if (!rawPts || rawPts.length < 2) continue;

    tmpColor.set(overrideColorHex || stroke.color || defaultColorHex);
    const strokeWidth = stroke.width || baseBrushSize;
    const baseRadius = strokeWidth * 0.02;
    const brushType: GreaseBrushType = stroke.brushType || "ink_pen";
    grainBrush = BRUSH_SHADER_ID[brushType] ?? 0;
    grainAlong = 0;

    // 1. Airbrush Preset: Soft Stippled Particle Spray
    if (brushType === "airbrush") {
      const sprayCountPerPoint = 6;
      for (let i = 0; i < rawPts.length; i++) {
        const p = rawPts[i];
        const pr = Math.max(0.04, Math.min(1.0, p.pressure ?? 0.6));
        const sprayRadius = baseRadius * pr * 1.8;
        const dotSize = Math.max(0.002, baseRadius * 0.18 * pr);

        for (let s = 0; s < sprayCountPerPoint; s++) {
          const hash = Math.sin(i * 37.17 + s * 13.51) * 43758.5453;
          const hash2 = Math.sin(i * 19.33 + s * 91.13) * 23421.631;
          const angle = (hash - Math.floor(hash)) * Math.PI * 2;
          const dist = Math.sqrt(hash2 - Math.floor(hash2)) * sprayRadius;

          const cx = p.x + Math.cos(angle) * dist;
          const cz = p.z + Math.sin(angle) * dist;
          const cy = p.y;

          // Corner edge coords make each quad shade as a soft round droplet.
          const startV = pushVertex(cx - dotSize, cy, cz - dotSize, -1, -1);
          pushVertex(cx + dotSize, cy, cz - dotSize, 1, -1);
          pushVertex(cx + dotSize, cy, cz + dotSize, 1, 1);
          pushVertex(cx - dotSize, cy, cz + dotSize, -1, 1);

          indices.push(startV, startV + 1, startV + 2);
          indices.push(startV, startV + 2, startV + 3);
        }
      }
      continue;
    }

    // Detect if this stroke is primarily horizontal (2D mode) or vertical/slanted (3D mode)
    let yDelta = 0;
    for (let k = 1; k < rawPts.length; k++) {
      yDelta += Math.abs(rawPts[k].y - rawPts[0].y);
    }
    const upVector = yDelta < 0.1 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);

    const pts = resampleStrokePoints(rawPts, Math.max(0.003, baseRadius * 0.4));
    if (pts.length < 2) continue;

    const centers: THREE.Vector3[] = [];
    const leftVerts: THREE.Vector3[] = [];
    const rightVerts: THREE.Vector3[] = [];
    const sides: THREE.Vector3[] = [];
    const tangents: THREE.Vector3[] = [];
    const radii: number[] = [];

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const pVec = new THREE.Vector3(p.x, p.y, p.z);
      const pr = Math.max(0.03, Math.min(1.0, p.pressure ?? 0.6));
      const radius = Math.max(0.001, baseRadius * pr);

      // Segment directions around this point, used both for the frame and for
      // the miter length at corners.
      const dirIn = new THREE.Vector3();
      const dirOut = new THREE.Vector3();
      if (i > 0) {
        dirIn.subVectors(pVec, new THREE.Vector3(pts[i - 1].x, pts[i - 1].y, pts[i - 1].z));
        if (dirIn.lengthSq() > 1e-12) dirIn.normalize();
        else dirIn.set(0, 0, 0);
      }
      if (i < pts.length - 1) {
        dirOut.subVectors(new THREE.Vector3(pts[i + 1].x, pts[i + 1].y, pts[i + 1].z), pVec);
        if (dirOut.lengthSq() > 1e-12) dirOut.normalize();
        else dirOut.set(0, 0, 0);
      }

      const tangent = new THREE.Vector3().addVectors(dirIn, dirOut);
      if (tangent.lengthSq() < 1e-8) {
        tangent.copy(dirOut.lengthSq() > 0 ? dirOut : dirIn);
      }
      if (tangent.lengthSq() < 1e-8) tangent.set(1, 0, 0);
      tangent.normalize();

      let side: THREE.Vector3;
      if (p.nx !== undefined && p.ny !== undefined && p.nz !== undefined) {
        const pNorm = new THREE.Vector3(p.nx, p.ny, p.nz).normalize();
        side = new THREE.Vector3().crossVectors(tangent, pNorm);
        if (side.lengthSq() < 1e-4) {
          side = new THREE.Vector3().crossVectors(tangent, upVector);
        }
      } else {
        side = new THREE.Vector3().crossVectors(tangent, upVector);
      }
      if (side.lengthSq() < 1e-4) {
        side.set(-tangent.z, tangent.y, tangent.x);
        if (side.lengthSq() < 1e-4) side.set(0, 0, 1);
      }
      side.normalize();

      // 2. Marker Bold: chisel tip. The nib direction follows the stylus tilt
      // when the tablet reports it (a real chisel marker turns as you rotate
      // your hand), and falls back to a fixed 45° slant otherwise.
      if (brushType === "marker_bold") {
        const chiselDir = new THREE.Vector3(0.7071, 0, 0.7071);
        if (yDelta >= 0.1) chiselDir.set(0.7071, 0.7071, 0);

        if (p.tiltAngle !== undefined) {
          // Build the nib direction inside the stroke's own plane from the
          // tilt azimuth: side and tangent span that plane.
          const ca = Math.cos(p.tiltAngle);
          const sa = Math.sin(p.tiltAngle);
          chiselDir
            .copy(side)
            .multiplyScalar(ca)
            .addScaledVector(tangent, sa);
          if (chiselDir.lengthSq() < 1e-6) chiselDir.copy(side);
          chiselDir.normalize();
        }

        // A flatter stylus lays more of the nib down, so the slant bites more.
        const blend = p.tiltInc !== undefined ? 0.3 + 0.6 * Math.min(1, Math.max(0, p.tiltInc)) : 0.6;
        side.lerp(chiselDir, blend).normalize();
      }

      // Miter compensation: the averaged frame is shorter than the true offset
      // by cos(theta/2), so widen it there — clamped to keep spikes in check.
      //
      // Past a right angle the widening is dropped entirely: a near-reversal
      // (which a jittery sample or a catch-up tail can produce) would
      // otherwise balloon the ribbon into a blob right where the artist wanted
      // a point.
      let miter = 1;
      if (dirIn.lengthSq() > 0 && dirOut.lengthSq() > 0) {
        const dot = dirIn.dot(dirOut);
        if (dot > 0) {
          const cosHalf = Math.sqrt(Math.max(0, (1 + dot) * 0.5));
          miter = Math.min(1.6, 1 / Math.max(0.35, cosHalf));
        }
      }

      // 3. Ink Pen Rough: Micro-jittered edges
      let rL = radius * miter;
      let rR = radius * miter;
      if (brushType === "ink_pen_rough") {
        const nL = Math.sin(i * 12.9898 + p.x * 37.1) * 43758.5453;
        const nR = Math.sin(i * 27.6543 + p.z * 51.3) * 43758.5453;
        rL *= 0.7 + 0.6 * (nL - Math.floor(nL));
        rR *= 0.7 + 0.6 * (nR - Math.floor(nR));
      }

      centers.push(pVec);
      sides.push(side);
      tangents.push(tangent);
      radii.push(radius);
      leftVerts.push(pVec.clone().addScaledVector(side, -rL));
      rightVerts.push(pVec.clone().addScaledVector(side, rR));
    }

    const startV = vertexOffset;
    // Grain runs along the stroke in units of half-width, so the texture
    // density of a thin stroke matches that of a thick one.
    const grainScale = 1 / Math.max(1e-4, baseRadius);
    let along = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) along += centers[i].distanceTo(centers[i - 1]) * grainScale;
      grainAlong = along;
      pushVertex(leftVerts[i].x, leftVerts[i].y, leftVerts[i].z, -1, 0);
      pushVertex(rightVerts[i].x, rightVerts[i].y, rightVerts[i].z, 1, 0);
    }

    for (let i = 0; i < pts.length - 1; i++) {
      const baseIdx = startV + i * 2;
      indices.push(baseIdx, baseIdx + 1, baseIdx + 2);
      indices.push(baseIdx + 1, baseIdx + 3, baseIdx + 2);
    }

    // Round caps at both ends, built as fans in the (side, tangent) plane so
    // the stroke terminates on a disc rather than a flat chopped edge.
    const addCap = (idx: number, outward: THREE.Vector3) => {
      const radius = radii[idx];
      if (radius <= 1e-5) return;
      const center = centers[idx];
      const side = sides[idx];
      grainAlong = idx === 0 ? 0 : along;
      const centerIdx = pushVertex(center.x, center.y, center.z, 0, 0);

      let prevIdx = -1;
      for (let s = 0; s <= CAP_SEGMENTS; s++) {
        const a = (s / CAP_SEGMENTS) * Math.PI - Math.PI / 2;
        const ex = Math.sin(a);
        const ey = Math.cos(a);
        const px = center.x + side.x * radius * ex + outward.x * radius * ey;
        const py = center.y + side.y * radius * ex + outward.y * radius * ey;
        const pz = center.z + side.z * radius * ex + outward.z * radius * ey;
        const vIdx = pushVertex(px, py, pz, ex, ey);
        if (prevIdx >= 0) indices.push(centerIdx, prevIdx, vIdx);
        prevIdx = vIdx;
      }
    };

    if (!stroke.closed) {
      addCap(0, tangents[0].clone().negate());
      addCap(pts.length - 1, tangents[pts.length - 1].clone());
    }
  }

  const geo = new THREE.BufferGeometry();
  if (positions.length > 0) {
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute("aEdge", new THREE.Float32BufferAttribute(edges, 2));
    geo.setAttribute("aGrain", new THREE.Float32BufferAttribute(grains, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
  }
  return geo;
}

/**
 * Converts strokes into standard THREE.CatmullRomCurve3 curves for node chaining.
 */
export function strokesToCurves(strokes: GreaseStroke[]): THREE.CatmullRomCurve3[] {
  const curves: THREE.CatmullRomCurve3[] = [];
  for (const stroke of strokes) {
    if (!stroke.points || stroke.points.length < 2) continue;
    const vectors = stroke.points.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    const curve = new THREE.CatmullRomCurve3(vectors, Boolean(stroke.closed), "centripetal");
    curves.push(curve);
  }
  return curves;
}

/**
 * Safely parses color values (string, THREE.Color, or {r, g, b}) into hex format.
 */
export function parseColorHex(v: unknown, fallback = "#38bdf8"): string {
  if (!v) return fallback;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return fallback;
    return s.startsWith("#") ? s : `#${s}`;
  }
  if (v instanceof THREE.Color) {
    return `#${v.getHexString()}`;
  }
  if (typeof v === "object" && v !== null && "r" in v && "g" in v && "b" in v) {
    const { r, g, b } = v as { r: number; g: number; b: number };
    return `#${new THREE.Color(r, g, b).getHexString()}`;
  }
  return fallback;
}

export const GREASE_PENCIL_NODE: NodeDefinition = {
  type: "curve/grease-pencil",
  label: "Grease Pencil",
  category: "curve",
  inputs: [
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "visible", label: "Visible", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "curves", label: "Curves", type: "curve" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  defaultParams: {
    activeColor: "#38bdf8",
    brushSize: 4,
    brushType: "ink_pen" as GreaseBrushType,
    solidFill: false,
    fillColor: "",
    smoothing: 0.2,
    // Input stabilization (see shared/three/strokeInput.ts). "basic" is the
    // default because it removes digitizer jitter with no perceptible lag;
    // "stabilizer" trades latency for very smooth long curves.
    stabilizerMode: "basic",
    stabilizerStrength: 0.35,
    // Tablet pressure response: exponent + output range
    pressureCurve: 1,
    pressureMin: 0.05,
    pressureMax: 1,
    onionSkin: true,
    onionSkinBefore: 1,
    onionSkinAfter: 1,
    onionSkinOpacity: 0.35,
    frames: [] as KeyframeDrawing[],
    visible: true,
    location: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Vector3(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    showPivot: false,
    pivot: new THREE.Vector3(0, 0, 0),
  },
  paramFields: [
    { id: "activeColor", label: "Color", kind: "color" },
    { id: "brushSize", label: "Brush Size", kind: "number", step: 1 },
    {
      id: "brushType",
      label: "Brush Type",
      kind: "select",
      options: [
        "ink_pen",
        "ink_pen_rough",
        "marker_bold",
        "airbrush",
        "pencil",
        "charcoal",
        "watercolor",
      ],
    },
    { id: "solidFill", label: "Solid Fill", kind: "boolean" },
    { id: "fillColor", label: "Fill Color", kind: "color" },
    { id: "smoothing", label: "Smoothing", kind: "number", step: 0.05 },
    {
      id: "stabilizerMode",
      label: "Stabilizer",
      kind: "select",
      options: ["none", "basic", "weighted", "stabilizer"],
    },
    { id: "stabilizerStrength", label: "Stabilizer Amount", kind: "number", step: 0.05 },
    { id: "pressureCurve", label: "Pressure Curve", kind: "number", step: 0.05 },
    { id: "pressureMin", label: "Pressure Min", kind: "number", step: 0.01 },
    { id: "pressureMax", label: "Pressure Max", kind: "number", step: 0.01 },
    { id: "onionSkin", label: "Onion Skin", kind: "boolean" },
    { id: "onionSkinBefore", label: "Ghost Before", kind: "number", step: 1 },
    { id: "onionSkinAfter", label: "Ghost After", kind: "number", step: 1 },
    { id: "onionSkinOpacity", label: "Ghost Opacity", kind: "number", step: 0.05 },
    { id: "visible", label: "Visible", kind: "boolean", group: "Transform" },
    { id: "location", label: "Location", kind: "vector", group: "Transform" },
    { id: "rotation", label: "Rotation (°)", kind: "vector", step: 1, degrees: true, group: "Transform" },
    { id: "scale", label: "Scale", kind: "vector", group: "Transform" },
    { id: "showPivot", label: "Show Pivot", kind: "boolean", group: "Transform" },
    { id: "pivot", label: "Pivot Offset", kind: "vector", group: "Transform" },
  ],
  evaluate: (inputs, params, ctx) => {
    const isVis = inputs.visible !== undefined ? Boolean(inputs.visible) : Boolean(params.visible ?? true);
    if (!isVis) {
      return { geometry: null, curves: [], matrix: new THREE.Matrix4() };
    }

    const state = getState(ctx.nodeId);
    if (!state.group) {
      state.group = new THREE.Group();
      state.group.name = `GreasePencil_${ctx.nodeId}`;
    }
    state.group.userData.nodeId = ctx.nodeId;

    const frames = (Array.isArray(params.frames) ? params.frames : []) as KeyframeDrawing[];
    const rawFrame = ctx.currentFrame ?? 0;
    const currentFrame = rawFrame >= 0 ? rawFrame : 0;
    const activeDrawing = resolveActiveDrawing(frames, currentFrame);
    const strokes = activeDrawing?.strokes ?? [];

    const activeColorHex = parseColorHex(params.activeColor, "#38bdf8");
    const brushSize = Number(params.brushSize) || 4;
    const nodeBrushType: GreaseBrushType = (params.brushType as GreaseBrushType) || "ink_pen";
    const nodeSolidFill = Boolean(params.solidFill);
    const customFillColor = parseColorHex(params.fillColor, "");
    const nodeFillColor = customFillColor || activeColorHex;
    const onionSkinEnabled = Boolean(params.onionSkin ?? true);

    const onionSkinBefore = Number(params.onionSkinBefore) ?? 1;
    const onionSkinAfter = Number(params.onionSkinAfter) ?? 1;
    const onionSkinOpacity = Number(params.onionSkinOpacity) ?? 0.35;

    // Fingerprint of strokes contents (tracks additions, point counts, colors, fills, and pressures)
    let strokeFingerprint = "";
    for (let i = 0; i < strokes.length; i++) {
      const s = strokes[i];
      let pSum = 0;
      for (let k = 0; k < s.points.length; k++) {
        pSum += s.points[k].pressure;
      }
      strokeFingerprint += `${s.id}:${s.color}:${s.fillColor || ""}:${s.brushType}:${s.fill ? 1 : 0}:${s.points.length}:${pSum.toFixed(2)};`;
    }

    // Signature for caching and fast path
    const signature = JSON.stringify({
      currentFrame,
      drawingFrame: activeDrawing?.frame ?? -1,
      strokeCount: strokes.length,
      strokeFingerprint,
      onionSkinEnabled,
      onionSkinBefore,
      onionSkinAfter,
      onionSkinOpacity,
      brushSize,
      nodeBrushType,
      nodeSolidFill,
      nodeFillColor,
      activeColorHex,
    });

    if (state.lastSignature !== signature) {
      state.lastSignature = signature;

      // 1. Render Solid Fill Mesh (underneath strokes)
      const filledStrokes = strokes.map((s) => ({
        ...s,
        fill: s.fill ?? nodeSolidFill,
        fillColor:
          typeof s.fillColor === "string" && s.fillColor.trim() !== ""
            ? s.fillColor
            : typeof s.color === "string" && s.color.trim() !== ""
            ? s.color
            : nodeFillColor,
      }));
      const fillGeo = buildStrokesFillGeometry(filledStrokes, nodeFillColor);

      if (fillGeo.getAttribute("position")?.count > 0) {
        if (state.fillGeo) state.fillGeo.dispose();
        state.fillGeo = fillGeo;

        if (!state.fillMat) {
          state.fillMat = new THREE.MeshBasicMaterial({
            side: THREE.DoubleSide,
            vertexColors: true,
            depthTest: true,
            depthWrite: false,
            transparent: true,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
          });
        }
        state.fillMat.side = THREE.DoubleSide;
        state.fillMat.vertexColors = true;
        state.fillMat.depthTest = true;
        state.fillMat.depthWrite = false;
        state.fillMat.transparent = true;
        state.fillMat.polygonOffset = true;
        state.fillMat.polygonOffsetFactor = -1;
        state.fillMat.polygonOffsetUnits = -1;

        if (!state.fillMesh) {
          state.fillMesh = new THREE.Mesh(state.fillGeo, state.fillMat);
          state.fillMesh.renderOrder = 8;
          state.fillMesh.userData.nodeId = ctx.nodeId;
          state.group.add(state.fillMesh);
        } else {
          state.fillMesh.geometry = state.fillGeo;
          state.fillMesh.renderOrder = 8;
          state.fillMesh.userData.nodeId = ctx.nodeId;
        }
        state.fillMesh.visible = true;
      } else if (state.fillMesh) {
        state.fillMesh.visible = false;
      }

      // 2. Render Active Drawing as variable-width ribbon mesh
      const activeStrokes = strokes.map((s) => ({
        ...s,
        brushType: s.brushType || nodeBrushType,
      }));
      const activeRibbonGeo = buildStrokesRibbonGeometry(activeStrokes, activeColorHex, brushSize);

      if (activeRibbonGeo.getAttribute("position")?.count > 0) {
        if (state.activeGeo) state.activeGeo.dispose();
        state.activeGeo = activeRibbonGeo;

        if (!state.activeMat) {
          state.activeMat = applyStrokeEdgeAA(
            new THREE.MeshBasicMaterial({
              side: THREE.DoubleSide,
              vertexColors: true,
              depthTest: true,
              depthWrite: false,
              transparent: true,
              polygonOffset: true,
              polygonOffsetFactor: -2,
              polygonOffsetUnits: -2,
            }),
          );
        }
        state.activeMat.side = THREE.DoubleSide;
        state.activeMat.vertexColors = true;
        state.activeMat.depthTest = true;
        state.activeMat.depthWrite = false;
        state.activeMat.transparent = true;
        state.activeMat.polygonOffset = true;
        state.activeMat.polygonOffsetFactor = -2;
        state.activeMat.polygonOffsetUnits = -2;

        if (!state.activeMesh) {
          state.activeMesh = new THREE.Mesh(state.activeGeo, state.activeMat);
          state.activeMesh.renderOrder = 10;
          state.activeMesh.userData.nodeId = ctx.nodeId;
          state.group.add(state.activeMesh);
        } else {
          state.activeMesh.geometry = state.activeGeo;
          state.activeMesh.renderOrder = 10;
          state.activeMesh.userData.nodeId = ctx.nodeId;
        }
        state.activeMesh.visible = true;
      } else if (state.activeMesh) {
        state.activeMesh.visible = false;
      }

      // 2. Render Onion Skinning (if enabled)
      if (onionSkinEnabled && frames.length > 1) {
        const { prev, next } = resolveOnionSkinDrawings(
          frames,
          currentFrame,
          onionSkinBefore,
          onionSkinAfter,
        );

        const ghostOpacity = Math.max(0.1, Math.min(1.0, onionSkinOpacity));

        // Previous frames (tinted green: #22c55e)
        const prevStrokes = prev.flatMap((f) => f.strokes);
        if (prevStrokes.length > 0) {
          const prevGeo = buildStrokesRibbonGeometry(prevStrokes, "#22c55e", brushSize, "#22c55e", ghostOpacity);
          if (state.onionPrevGeo) state.onionPrevGeo.dispose();
          state.onionPrevGeo = prevGeo;

          if (!state.onionPrevMat) {
            state.onionPrevMat = applyStrokeEdgeAA(
              new THREE.MeshBasicMaterial({
                side: THREE.DoubleSide,
                vertexColors: true,
                transparent: true,
                opacity: ghostOpacity,
                depthTest: true,
                depthWrite: false,
              }),
            );
          }
          state.onionPrevMat.opacity = ghostOpacity;

          if (!state.onionPrevMesh) {
            state.onionPrevMesh = new THREE.Mesh(state.onionPrevGeo, state.onionPrevMat);
            state.onionPrevMesh.renderOrder = 5;
            state.group.add(state.onionPrevMesh);
          } else {
            state.onionPrevMesh.geometry = state.onionPrevGeo;
          }
          state.onionPrevMesh.visible = true;
        } else if (state.onionPrevMesh) {
          state.onionPrevMesh.visible = false;
        }

        // Next frames (tinted orange: #f97316)
        const nextStrokes = next.flatMap((f) => f.strokes);
        if (nextStrokes.length > 0) {
          const nextGeo = buildStrokesRibbonGeometry(nextStrokes, "#f97316", brushSize, "#f97316", ghostOpacity);
          if (state.onionNextGeo) state.onionNextGeo.dispose();
          state.onionNextGeo = nextGeo;

          if (!state.onionNextMat) {
            state.onionNextMat = applyStrokeEdgeAA(
              new THREE.MeshBasicMaterial({
                side: THREE.DoubleSide,
                vertexColors: true,
                transparent: true,
                opacity: ghostOpacity,
                depthTest: true,
                depthWrite: false,
              }),
            );
          }
          state.onionNextMat.opacity = ghostOpacity;

          if (!state.onionNextMesh) {
            state.onionNextMesh = new THREE.Mesh(state.onionNextGeo, state.onionNextMat);
            state.onionNextMesh.renderOrder = 5;
            state.group.add(state.onionNextMesh);
          } else {
            state.onionNextMesh.geometry = state.onionNextGeo;
          }
          state.onionNextMesh.visible = true;
        } else if (state.onionNextMesh) {
          state.onionNextMesh.visible = false;
        }
      } else {
        if (state.onionPrevMesh) state.onionPrevMesh.visible = false;
        if (state.onionNextMesh) state.onionNextMesh.visible = false;
      }
    }

    // Apply Transformation Matrix
    const matrix = composeNativeMatrix(
      inputs.matrix as THREE.Matrix4 | undefined,
      params.location as THREE.Vector3,
      params.rotation as THREE.Vector3,
      params.scale as THREE.Vector3,
      params,
    );
    state.group.matrix.copy(matrix);
    state.group.matrixAutoUpdate = false;
    matrix.decompose(state.group.position, state.group.quaternion, state.group.scale);
    state.group.updateMatrixWorld(true);

    state.group.userData.nodeId = ctx.nodeId;
    if (state.activeMesh) state.activeMesh.userData.nodeId = ctx.nodeId;
    if (state.fillMesh) state.fillMesh.userData.nodeId = ctx.nodeId;
    if (state.onionPrevMesh) state.onionPrevMesh.userData.nodeId = ctx.nodeId;
    if (state.onionNextMesh) state.onionNextMesh.userData.nodeId = ctx.nodeId;

    // Ensure all active meshes remain parented to state.group even if downstream nodes
    // reparented them during evaluation
    if (state.activeMesh && state.activeMesh.parent !== state.group) {
      state.group.add(state.activeMesh);
    }
    if (state.fillMesh && state.fillMesh.parent !== state.group) {
      state.group.add(state.fillMesh);
    }
    if (state.onionPrevMesh && state.onionPrevMesh.parent !== state.group) {
      state.group.add(state.onionPrevMesh);
    }
    if (state.onionNextMesh && state.onionNextMesh.parent !== state.group) {
      state.group.add(state.onionNextMesh);
    }

    const curves = strokesToCurves(strokes);

    return {
      geometry: state.group,
      curves,
      matrix,
    };
  },
};
