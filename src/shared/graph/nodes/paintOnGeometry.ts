import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import { composeNativeMatrix } from "./transform";
import {
  GreaseBrushType,
  KeyframeDrawing,
  buildStrokesFillGeometry,
  buildStrokesRibbonGeometry,
  parseColorHex,
  resolveActiveDrawing,
  resolveOnionSkinDrawings,
  strokesToCurves,
} from "./greasePencil";

export interface PaintOnGeometryState {
  group?: THREE.Group;
  currentInputObj?: THREE.Object3D | null;
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

const paintOnGeometryCache = createNodeCache<PaintOnGeometryState>((s) => {
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

function getState(nodeId: string): PaintOnGeometryState {
  let state = paintOnGeometryCache.get(nodeId);
  if (!state) {
    state = {};
    paintOnGeometryCache.set(nodeId, state);
  }
  return state;
}

export const PAINT_ON_GEOMETRY_NODE: NodeDefinition = {
  type: "curve/paint-on-geometry",
  label: "Paint on geometry",
  category: "curve",
  inputs: [
    { id: "geometry", label: "Geometry", type: "geometry", owns: true },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "visible", label: "Visible", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Geometry", type: "geometry" },
    { id: "curves", label: "Curves", type: "curve" },
    { id: "matrix", label: "Matrix", type: "matrix" },
  ],
  reset: { params: ["frames"] },
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
      state.group.name = `PaintOnGeometry_${ctx.nodeId}`;
    }
    state.group.userData.nodeId = ctx.nodeId;

    // Handle connected target geometry
    const inputObj = inputs.geometry instanceof THREE.Object3D ? inputs.geometry : null;
    if (state.currentInputObj && state.currentInputObj !== inputObj) {
      state.group.remove(state.currentInputObj);
      state.currentInputObj = null;
    }
    if (inputObj && inputObj.parent !== state.group) {
      state.group.add(inputObj);
      state.currentInputObj = inputObj;
    } else if (inputObj) {
      state.currentInputObj = inputObj;
    }

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

    // Fingerprint of strokes contents
    let strokeFingerprint = "";
    for (let i = 0; i < strokes.length; i++) {
      const s = strokes[i];
      let pSum = 0;
      for (let k = 0; k < s.points.length; k++) {
        pSum += s.points[k].pressure;
      }
      strokeFingerprint += `${s.id}:${s.color}:${s.fillColor || ""}:${s.brushType}:${s.fill ? 1 : 0}:${s.points.length}:${pSum.toFixed(2)};`;
    }

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
          state.fillMesh.userData.isStrokeMesh = true;
          state.group.add(state.fillMesh);
        } else {
          state.fillMesh.geometry = state.fillGeo;
          state.fillMesh.renderOrder = 8;
          state.fillMesh.userData.nodeId = ctx.nodeId;
          state.fillMesh.userData.isStrokeMesh = true;
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
          state.activeMesh.userData.isStrokeMesh = true;
          state.group.add(state.activeMesh);
        } else {
          state.activeMesh.geometry = state.activeGeo;
          state.activeMesh.renderOrder = 10;
          state.activeMesh.userData.nodeId = ctx.nodeId;
          state.activeMesh.userData.isStrokeMesh = true;
        }
        state.activeMesh.visible = true;
      } else if (state.activeMesh) {
        state.activeMesh.visible = false;
      }

      // 3. Render Onion Skinning (if enabled)
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
            state.onionPrevMesh.userData.isStrokeMesh = true;
            state.group.add(state.onionPrevMesh);
          } else {
            state.onionPrevMesh.geometry = state.onionPrevGeo;
            state.onionPrevMesh.userData.isStrokeMesh = true;
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
            state.onionNextMesh.userData.isStrokeMesh = true;
            state.group.add(state.onionNextMesh);
          } else {
            state.onionNextMesh.geometry = state.onionNextGeo;
            state.onionNextMesh.userData.isStrokeMesh = true;
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

    if (state.activeMesh) state.activeMesh.userData.nodeId = ctx.nodeId;
    if (state.fillMesh) state.fillMesh.userData.nodeId = ctx.nodeId;
    if (state.onionPrevMesh) state.onionPrevMesh.userData.nodeId = ctx.nodeId;
    if (state.onionNextMesh) state.onionNextMesh.userData.nodeId = ctx.nodeId;

    // Ensure all active meshes remain parented to state.group
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
