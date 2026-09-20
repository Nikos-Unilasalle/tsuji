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
}

export type GreaseBrushType =
  | "ink_pen"
  | "ink_pen_rough"
  | "marker_bold"
  | "airbrush";

export interface GreaseStroke {
  id: string;
  points: StrokePoint[];
  color?: string; // hex string, e.g. "#38bdf8"
  width?: number; // base stroke width in px
  brushType?: GreaseBrushType;
  fill?: boolean;
  fillColor?: string;
  closed?: boolean;
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
    const pts2D: THREE.Vector2[] = [];
    for (const p of pts) {
      const diff = new THREE.Vector3(p.x, p.y, p.z).sub(origin);
      pts2D.push(new THREE.Vector2(diff.dot(u), diff.dot(v)));
    }

    // Triangulate using Three.js built-in ShapeUtils ear-clipping
    const triangles = THREE.ShapeUtils.triangulateShape(pts2D, []);
    if (!triangles || triangles.length === 0) continue;

    const startV = vertexOffset;
    for (const p of pts) {
      positions.push(p.x, p.y, p.z);
      colors.push(tmpColor.r, tmpColor.g, tmpColor.b);
      vertexOffset++;
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
 * Builds a variable-width polygonal ribbon geometry for grease strokes.
 * Supports distinct brush presets:
 * - "ink_pen": Smooth, clean vector calligraphy ribbon.
 * - "ink_pen_rough": Hand-drawn rough ink texture with micro-jittered edges.
 * - "marker_bold": Chisel-angled bold marker stroke.
 * - "airbrush": Soft stippled spray micro-droplets along trajectory.
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
  const indices: number[] = [];
  const tmpColor = new THREE.Color();
  let vertexOffset = 0;

  for (const stroke of strokes) {
    const pts = stroke.points;
    if (!pts || pts.length < 2) continue;

    tmpColor.set(overrideColorHex || stroke.color || defaultColorHex);
    const strokeWidth = stroke.width || baseBrushSize;
    const baseRadius = strokeWidth * 0.02;
    const brushType: GreaseBrushType = stroke.brushType || "ink_pen";

    // 1. Airbrush Preset: Soft Stippled Particle Spray
    if (brushType === "airbrush") {
      const sprayCountPerPoint = 6;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const pr = Math.max(0.04, Math.min(1.0, p.pressure ?? 0.6));
        const sprayRadius = baseRadius * pr * 1.8;
        const dotSize = Math.max(0.002, baseRadius * 0.12 * pr);

        for (let s = 0; s < sprayCountPerPoint; s++) {
          const hash = Math.sin(i * 37.17 + s * 13.51) * 43758.5453;
          const hash2 = Math.sin(i * 19.33 + s * 91.13) * 23421.631;
          const angle = (hash - Math.floor(hash)) * Math.PI * 2;
          const dist = Math.sqrt(hash2 - Math.floor(hash2)) * sprayRadius;

          const cx = p.x + Math.cos(angle) * dist;
          const cz = p.z + Math.sin(angle) * dist;
          const cy = p.y;

          const startV = vertexOffset;
          positions.push(cx - dotSize, cy, cz - dotSize);
          colors.push(tmpColor.r, tmpColor.g, tmpColor.b);
          vertexOffset++;

          positions.push(cx + dotSize, cy, cz - dotSize);
          colors.push(tmpColor.r, tmpColor.g, tmpColor.b);
          vertexOffset++;

          positions.push(cx + dotSize, cy, cz + dotSize);
          colors.push(tmpColor.r, tmpColor.g, tmpColor.b);
          vertexOffset++;

          positions.push(cx - dotSize, cy, cz + dotSize);
          colors.push(tmpColor.r, tmpColor.g, tmpColor.b);
          vertexOffset++;

          indices.push(startV, startV + 1, startV + 2);
          indices.push(startV, startV + 2, startV + 3);
        }
      }
      continue;
    }

    // Detect if this stroke is primarily horizontal (2D mode) or vertical/slanted (3D mode)
    let yDelta = 0;
    for (let k = 1; k < pts.length; k++) {
      yDelta += Math.abs(pts[k].y - pts[0].y);
    }
    const upVector = yDelta < 0.1 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);

    const leftVerts: THREE.Vector3[] = [];
    const rightVerts: THREE.Vector3[] = [];

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const pVec = new THREE.Vector3(p.x, p.y, p.z);
      const pr = Math.max(0.03, Math.min(1.0, p.pressure ?? 0.6));
      const radius = Math.max(0.001, baseRadius * pr);

      let tangent = new THREE.Vector3();
      if (i === 0) {
        tangent.subVectors(new THREE.Vector3(pts[1].x, pts[1].y, pts[1].z), pVec);
      } else if (i === pts.length - 1) {
        tangent.subVectors(pVec, new THREE.Vector3(pts[i - 1].x, pts[i - 1].y, pts[i - 1].z));
      } else {
        tangent.subVectors(
          new THREE.Vector3(pts[i + 1].x, pts[i + 1].y, pts[i + 1].z),
          new THREE.Vector3(pts[i - 1].x, pts[i - 1].y, pts[i - 1].z),
        );
      }
      if (tangent.lengthSq() < 1e-6) tangent.set(1, 0, 0);
      else tangent.normalize();

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

      // 2. Marker Bold: Chisel tip slant (~45 deg)
      if (brushType === "marker_bold") {
        const chiselDir = new THREE.Vector3(0.7071, 0, 0.7071);
        if (yDelta >= 0.1) chiselDir.set(0.7071, 0.7071, 0);
        side.lerp(chiselDir, 0.6).normalize();
      }

      // 3. Ink Pen Rough: Micro-jittered edges
      let rL = radius;
      let rR = radius;
      if (brushType === "ink_pen_rough") {
        const nL = Math.sin(i * 12.9898 + p.x * 37.1) * 43758.5453;
        const nR = Math.sin(i * 27.6543 + p.z * 51.3) * 43758.5453;
        rL = radius * (0.7 + 0.6 * (nL - Math.floor(nL)));
        rR = radius * (0.7 + 0.6 * (nR - Math.floor(nR)));
      }

      leftVerts.push(pVec.clone().addScaledVector(side, -rL));
      rightVerts.push(pVec.clone().addScaledVector(side, rR));
    }

    const startV = vertexOffset;
    for (let i = 0; i < pts.length; i++) {
      const l = leftVerts[i];
      const r = rightVerts[i];

      positions.push(l.x, l.y, l.z);
      colors.push(tmpColor.r, tmpColor.g, tmpColor.b);
      vertexOffset++;

      positions.push(r.x, r.y, r.z);
      colors.push(tmpColor.r, tmpColor.g, tmpColor.b);
      vertexOffset++;
    }

    for (let i = 0; i < pts.length - 1; i++) {
      const baseIdx = startV + i * 2;
      indices.push(baseIdx, baseIdx + 1, baseIdx + 2);
      indices.push(baseIdx + 1, baseIdx + 3, baseIdx + 2);
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
      options: ["ink_pen", "ink_pen_rough", "marker_bold", "airbrush"],
    },
    { id: "solidFill", label: "Solid Fill", kind: "boolean" },
    { id: "fillColor", label: "Fill Color", kind: "color" },
    { id: "smoothing", label: "Smoothing", kind: "number", step: 0.05 },
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
          state.activeMat = new THREE.MeshBasicMaterial({
            side: THREE.DoubleSide,
            vertexColors: true,
            depthTest: true,
            depthWrite: false,
            transparent: true,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
          });
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
            state.onionPrevMat = new THREE.MeshBasicMaterial({
              side: THREE.DoubleSide,
              vertexColors: true,
              transparent: true,
              opacity: ghostOpacity,
              depthTest: true,
              depthWrite: false,
            });
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
            state.onionNextMat = new THREE.MeshBasicMaterial({
              side: THREE.DoubleSide,
              vertexColors: true,
              transparent: true,
              opacity: ghostOpacity,
              depthTest: true,
              depthWrite: false,
            });
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
