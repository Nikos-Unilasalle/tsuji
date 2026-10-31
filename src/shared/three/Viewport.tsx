import { MutableRefObject, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { installScaleGizmoTweaks } from "./gizmoScale";
import { ClockState, createClock, STEP_SECONDS, tickClock } from "../graph/clock";
import { EvalResult, deepResultEntries, disposeEvalSession, evaluateGraph } from "../graph/evaluate";
import { getEvalProfiler } from "../graph/evalProfiler";
import { copyTextureToCanvas, textureSize } from "../graph/gpuTexture";
import { CAMERA_FLY_TO_NODE, CAMERA_NODE } from "../graph/nodes/camera";
import { TEXTURE_CAMERA_NODE } from "../graph/nodes/textureCamera";
import { HubElement } from "../graph/nodes/hub";
import { asVector3, composeNativeMatrixWithPivot, PIVOT_TRANSFORM_NODE } from "../graph/nodes/transform";
import { quaternionToRotation, rotationToQuaternion } from "../graph/rotationMode";
import { resetAllParticleSimulations } from "../graph/particleRuntime";
import { getSimulationEpoch, onSimulationReset } from "../graph/simulationEpoch";
import { isIkControlNode, resolveCurveEditTarget } from "../graph/curveLookup";
import { resolveSceneRoots } from "../graph/sceneRoots";
import { findFirstMesh } from "../graph/meshRequired";
import { getBoundsTree } from "./bvh";
import { insertCurvePointAfter, removeCurvePoint } from "../graph/curvePoints";
import { GizmoTarget, resolveGizmoTarget } from "../graph/transformLookup";
import { CLIP_BOX_NODE, VISUAL_SLICE_NODE } from "../graph/nodes/visualSlice";
import { DECAL_NODE } from "../graph/nodes/decal";
import { POSE_PROXY_NODES } from "./poseProxyNodes";
import { createCurvePointHandles } from "./curveHandles";
import { createPointCloudHandles } from "./pointCloudHandles";
import { SKELETON_NODE_TYPE } from "../graph/nodes/skeleton";
import { SKIN_NODE, skinPaintMeshes, skinStoredPaint, skinWeightDab } from "../graph/nodes/skin";
import type { WeightBrush } from "../graph/ik/weightPaint";
import { SkeletonHud, SkinHud } from "./RigHuds";
import { BipedHud } from "./BipedHud";
import { PoseHud } from "./PoseHud";
import { RIG_BIPED_POSE_NODE } from "../graph/nodes/bipedPose";
import { RIG_BIPED_DANCE_NODE, type DanceInfo } from "../graph/nodes/bipedDance";
import { DanceHud } from "./DanceHud";
import { PatternHud } from "./PatternHud";
import { previewNote } from "../music/engine/bridge";
import { isTrack, sequenceOf, type PreviewSound } from "../music/engine/description";
import { RIG_HUMAN_NODE } from "../graph/nodes/rig";
import { RIG_BIPED_MOTION_NODE, type BipedGaitInfo } from "../graph/nodes/bipedMotion";
import { PointsInfluenceHud } from "./PointsInfluenceHud";
import { isRigNodeType, setInFront } from "./inFront";
import { skeletonOp, SkeletonOp } from "./skeletonEditor";
import { createSceneMembership, isSelfOrDescendantOf } from "./sceneMembership";
import {
  LATTICE_DEFORM_NODE,
  latticeBasePointForTarget,
  latticeEvaluatedPoints,
} from "../graph/nodes/lattice";
import { POINTS_SELECTION_NODE } from "../graph/nodes/pointsSelection";
import { applyWeldedPointMoves, EDIT_MESH_POINTS_NODE, RESEED_MESH_POINTS_ACTION } from "../graph/nodes/editMeshPoints";
import { extractPointsFromMesh } from "../graph/nodes/pointsGeometry";
import {
  POINTS_INFLUENCE_NODE,
  POINTS_INFLUENCE_BASE,
  POINTS_INFLUENCE_LEVELS,
  applyInfluenceGradient,
  blurInfluenceMap,
  blurInfluenceOnSurface,
  influenceStroke,
  prepareSurfaceBlur,
  type SurfaceBlurSetup,
} from "../graph/nodes/pointsInfluence";
import { FACE_SELECTION_NODE } from "../graph/nodes/meshEdit";
import { createFaceSelectionHandles } from "./faceSelectionHandles";
import {
  EDIT_MESH_NODE,
  EDIT_MESH_EXTRUDE_ACTION,
  EDIT_MESH_INSET_ACTION,
  EDIT_MESH_RESEED_ACTION,
  EDIT_MESH_SEPARATE_FACES_ACTION,
  resolveEditMeshData,
  readEditMeshSelection,
  editMeshSelectionParams,
  editMeshModeSwitchParams,
  materialInputSockets,
} from "../graph/nodes/editMesh";
import { createEditMeshHandles, polygonRegion, rectRegion } from "./editMeshHandles";
import { findNodeWithGraph, walkNodes } from "../graph/groups";
import {
  createEditMeshController,
  findEditMeshNode,
  editMeshQuadMesh,
  EDIT_MESH_BRUSH_RADIUS_PX,
  mirrorTolerance,
  EditMeshOp,
} from "./editMesh/controller";
import {
  combineSelection,
  emptySelection,
  flatFaces,
  growSelection,
  linkedSelection,
  MeshSelection,
  selectAll,
  selectionVertices,
  selectionOrientation,
  SelectMode,
  shrinkSelection,
} from "../graph/mesh/selection";
import { mirrorMovesX, mirrorXMap } from "../graph/mesh/tools";
import { layoutKey } from "./layoutKey";
import { ColorPickerInput } from "../../windows/ColorPickerInput";
import { QuadMesh, getLoopCutPreviewSegments, loopCut, quadMeshSignature, transformSelectionByMatrix, withFaceUVs } from "../graph/quadMesh";
import { swapInUVChecker } from "./uvChecker";
import { UV_PANEL_WIDTH, UVPreviewPanel, type UVPanelData } from "./UVPreviewPanel";
import { HudBar, HudSeparator, HudToolColumn, useHudToolMaxRows } from "./HudToolbars";
import { MaskEditor } from "./maskEditor/MaskEditor";
import { createPostProcessChain } from "./postProcessChain";
import { computeGizmoWriteback, TransformGizmoMode, TransformPatch } from "./gizmoWriteback";
import { enableSmoothShadows } from "./smoothShadows";

// Re-exported so call sites (App.tsx, SplitViewport) keep importing these
// from the component they belong to, not from its internals.
export type { TransformGizmoMode, TransformPatch };
/** Quiet time after the last stroke before a painted map is written to params. */
const TEXTURE_SNAPSHOT_DEBOUNCE_MS = 700;

export type GpToolMode =
  | "pen"
  | "line"
  | "rect"
  | "ellipse"
  | "arc"
  | "polyline"
  | "fill"
  | "eraser_hard"
  | "eraser_soft"
  | "eraser_stroke"
  | "tint"
  | "lasso"
  | "carve"
  | "select";

/** Tools that build a stroke from an anchor-to-cursor drag. */
const GP_SHAPE_TOOLS: ReadonlySet<GpToolMode> = new Set<GpToolMode>(["line", "rect", "ellipse", "arc"]);
/** Tools driven by a freehand screen-space lasso. */
const GP_LASSO_TOOLS: ReadonlySet<GpToolMode> = new Set<GpToolMode>(["lasso", "carve"]);
import { createElevationHUD, snapElevationValue } from "./elevationGizmo";
import {
  GREASE_PENCIL_NODE,
  KeyframeDrawing,
  GreaseStroke,
  StrokePoint,
  parseColorHex,
  resolveActiveDrawing,
} from "../graph/nodes/greasePencil";
import { PAINT_ON_GEOMETRY_NODE } from "../graph/nodes/paintOnGeometry";
import {
  applyStrokeTaper,
  projectScreenToDrawingPlane,
  projectScreenToTargetGeometry,
  addStrokeToFrames,
  duplicateDrawing,
  createBlankDrawing,
  clearDrawingAtFrame,
  eraseStrokesAtPosition,
  eraseStrokesCut,
  eraseStrokesSoft,
  tintStrokesAtPosition,
  smoothStrokePoints,
  trimStrokeDwellTail,
} from "./greasePencilDrawing";
import {
  buildPolylinePoints,
  buildShapePoints,
  densifyShapePoints,
  type ShapeKind,
  type ShapePoint,
} from "./strokeShapes";
import {
  carveStrokesWithLasso,
  deleteStrokes,
  selectStrokesInLasso,
  translateStrokes,
  type PointProjector,
} from "./strokeLasso";
import { computeFillRegion } from "./strokeFill";
import {
  collectPointerSamples,
  createPressureTracker,
  createStabilizer,
  tiltToBrushAngle,
  type PressureTracker,
  type PointerSample,
  type Stabilizer,
  type StabilizerMode,
} from "./strokeInput";
import type { GreaseBrushType } from "../graph/nodes/greasePencil";
import { P5_GREASE_BRUSH_LABELS } from "../graph/nodes/greasePencilP5";

/** The image a mesh's material maps, for the UV view's background. */
function textureImageOf(mesh: THREE.Mesh): CanvasImageSource | null {
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const image = (material as THREE.MeshStandardMaterial | undefined)?.map?.image as CanvasImageSource | undefined;
  return image && typeof image === "object" && "width" in image ? image : null;
}

function imageKeyOf(mesh: THREE.Mesh): string {
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  return (material as THREE.MeshStandardMaterial | undefined)?.map?.uuid ?? "none";
}

let lastGeometryUV: UVPanelData | null = null;
/** The UV view's data for a plain mesh: its triangles in UV space (memoised on the geometry's state). */
function geometryUVData(mesh: THREE.Mesh | null, checker: boolean, label: string): UVPanelData | null {
  if (!mesh) return null;
  const geometry = mesh.geometry;
  const uv = geometry?.getAttribute("uv") as THREE.BufferAttribute | undefined;
  const index = geometry?.getIndex();
  const key = `g:${geometry?.uuid}:${uv?.version ?? -1}:${uv?.count ?? 0}:${index?.version ?? -1}:${checker ? "checker" : imageKeyOf(mesh)}:${label}`;
  if (lastGeometryUV?.key === key) return lastGeometryUV;
  const polygons: [number, number][][] = [];
  if (uv) {
    const corner = (i: number): [number, number] => [uv.getX(i), uv.getY(i)];
    const count = index ? index.count : uv.count;
    // A cap on what gets drawn: past it the view is a solid smear anyway.
    for (let t = 0; t + 2 < count && polygons.length < 60000; t += 3) {
      const [a, b, c] = index ? [index.getX(t), index.getX(t + 1), index.getX(t + 2)] : [t, t + 1, t + 2];
      polygons.push([corner(a), corner(b), corner(c)]);
    }
  }
  lastGeometryUV = { key, label: uv ? label : `${label} — no UVs`, polygons, selected: polygons.map(() => false), image: checker ? null : textureImageOf(mesh) };
  return lastGeometryUV;
}

/**
 * The world matrix of an object's own native pose. A node that draws its
 * object a fixed offset away from that pose (the fire volume, lifted to sit
 * on its origin) publishes the offset, applied after the pose, as
 * `userData.poseOffset`: taken back out here so the gizmo and the pivot
 * cross sit on the pose a drag actually edits.
 */
function nativePoseWorldMatrix(object: THREE.Object3D): THREE.Matrix4 {
  const offset = object.userData?.poseOffset;
  return offset instanceof THREE.Matrix4
    ? object.matrixWorld.clone().multiply(offset.clone().invert())
    : object.matrixWorld;
}

function isPaintOrGreaseNode(node: { type: string } | null | undefined): boolean {
  if (!node) return false;
  return node.type === GREASE_PENCIL_NODE.type || node.type === PAINT_ON_GEOMETRY_NODE.type;
}

/**
 * Which node a click on this object selects.
 *
 * Objects carry their owner's id in `userData.nodeId`, and the nearest tagged
 * ancestor used to win outright. That answer stopped being right once groups
 * existed: a mesh inside a group is tagged with the id of the node that built
 * it, and that node lives in the group's *subgraph* — not in the graph this
 * viewport draws. Selecting it left the whole app pointing at something the
 * canvas has no node for: no gizmo, nothing to frame.
 *
 * So the walk keeps going until it finds a tag the current graph actually
 * knows, which for grouped geometry is the group's own container. Clicking a
 * thing inside a group selects the group — the same as Blender, and the same
 * as what the graph shows you at this level. Falls back to the nearest tag
 * when nothing matches, so an object whose node has just been deleted behaves
 * as it did before.
 */
function selectableNodeIdFor(object: THREE.Object3D, graph: Graph): string | null {
  let nearest: string | null = null;
  let curr: THREE.Object3D | null = object;
  while (curr) {
    const nodeId = curr.userData?.nodeId;
    if (typeof nodeId === "string" && nodeId) {
      if (nearest === null) nearest = nodeId;
      if (graph.nodes.some((n) => n.id === nodeId)) return nodeId;
    }
    curr = curr.parent;
  }
  return nearest;
}

import {
  applySculptStroke,
  SculptStrokeParams,
  TerrainBrushFalloff,
  TerrainBrushTool,
} from "./terrainSculpt";
import { TerrainGridConfig, hasAnyMaskWeight } from "./terrainEngine";
import { SculptMeshData, buildAdjacency, computeVertexNormals, syncBufferGeometry } from "./sculptMesh";
import { refineNearBrush } from "./sculptDyntopo";
import { BrushHud, BrushHudTool } from "./BrushHud";
import { applySculptStroke3D, SculptBrushTool, SculptStrokeParams3D } from "./sculptEngine";
import { BrushFalloff } from "./brushFalloff";

function isTerrainNode(node: { type: string } | null | undefined): boolean {
  if (!node) return false;
  return node.type === "object/terrain";
}

function getTerrainMeshForNode(
  nodeId: string,
  latestResults: Map<string, Record<string, unknown>> | null | undefined,
): THREE.Mesh | null {
  const res = latestResults?.get(nodeId);
  if (res?.geometry instanceof THREE.Mesh && res.geometry.userData?.isTerrain) {
    return res.geometry;
  }
  return null;
}

/** Same palette order on both nodes; a node just omits the tools its surface can't do (Terrain is a heightfield, so no Inflate/Grab; Sculpt has no Erode). */
const TERRAIN_HUD_TOOLS: BrushHudTool[] = [
  { id: "sculpt", kind: "draw" },
  { id: "clayStrip", kind: "clay" },
  { id: "smooth", kind: "smooth" },
  { id: "pinch", kind: "pinch" },
  { id: "crease", kind: "crease" },
  { id: "flatten", kind: "flatten" },
  { id: "noise", kind: "noise" },
  { id: "erode", kind: "erode" },
  { id: "mask", kind: "mask" },
];
const SCULPT_HUD_TOOLS: BrushHudTool[] = [
  { id: "draw", kind: "draw" },
  { id: "clay", kind: "clay" },
  { id: "inflate", kind: "inflate" },
  { id: "smooth", kind: "smooth" },
  { id: "pinch", kind: "pinch" },
  { id: "crease", kind: "crease" },
  { id: "flatten", kind: "flatten" },
  { id: "grab", kind: "grab" },
  { id: "noise", kind: "noise" },
  { id: "mask", kind: "mask" },
];

function isSculptNode(node: { type: string } | null | undefined): boolean {
  if (!node) return false;
  return node.type === "object/sculpt";
}

function getSculptMeshForNode(
  nodeId: string,
  latestResults: Map<string, Record<string, unknown>> | null | undefined,
): THREE.Mesh | null {
  const res = latestResults?.get(nodeId);
  if (res?.geometry instanceof THREE.Mesh && res.geometry.userData?.isSculpt) {
    return res.geometry;
  }
  return null;
}

import {
  TexturePaintTool,
  applyPaintStroke,
  clearPaintCanvas,
  exportCanvasToPNG,
  serializePaintCanvas,
} from "./texturePainter";
import {
  TextureMixFalloff,
  TextureMixTool,
  applyMixStroke,
} from "./textureMixEngine";
import { serializeSplatToPng } from "./splatSerialization";
import { compositeLayersAuto } from "./layeredTexture";
import { getTexturePaintState, texturePaintP5Style } from "../graph/nodes/texturePaint";
import { endBrushPaint } from "./brushPaintSession";
import { getTextureMixPaintState } from "../graph/nodes/textureMixPaint";

/** Nodes painted through Texture Paint's canvas, strokes and save path — Points Influence paints its influence map the same way. */
function isTexturePaintNode(node: { type: string } | null | undefined): boolean {
  return node?.type === "texture/paint" || node?.type === POINTS_INFLUENCE_NODE.type;
}

/** The tool and colour a Texture Paint stroke of this node uses. */
function texturePaintStroke(node: NodeInstance): { tool: TexturePaintTool; color: string } {
  if (node.type === POINTS_INFLUENCE_NODE.type) return influenceStroke(node.params);
  return {
    tool: (node.params.brushTool as TexturePaintTool) || "paint",
    color: String(node.params.brushColor || "#38bdf8"),
  };
}

/**
 * Points Influence's painted map drawn on its mesh: the gray as a cold-to-hot
 * heatmap, lit like any surface. Only in this viewport's render, swapped in
 * around it (see influenceMesh in tick()). Pulled toward the camera so that,
 * drawn as an overlay, it wins over the same surface shown downstream.
 */
/** The Blur drag's map at `radius`: over the surface, across seams, when the mesh has UVs; a plain map blur otherwise. */
function blurInfluence(session: { src: ImageData; surface: SurfaceBlurSetup | null }, radius: number): Uint8ClampedArray {
  const { src, surface } = session;
  return surface ? blurInfluenceOnSurface(surface, src.data, radius) : blurInfluenceMap(src.data, src.width, src.height, radius);
}

function createInfluenceHeatmapMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    roughness: 0.7,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.influenceCold = { value: INFLUENCE_COLD };
    shader.uniforms.influenceHot = { value: INFLUENCE_HOT };
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "uniform vec3 influenceCold;\nuniform vec3 influenceHot;\nvoid main() {")
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
  vec4 influenceTexel = texture2D( map, vMapUv );
  diffuseColor.rgb *= mix( influenceCold, influenceHot, clamp( influenceTexel.r * influenceTexel.a, 0.0, 1.0 ) );
#endif`,
      );
  };
  return material;
}

function isTextureMixNode(node: { type: string } | null | undefined): boolean {
  return node?.type === "texture/mix-paint";
}

function getTexturePaintMeshesForNode(
  nodeId: string,
  graph: Graph,
  latestResults: Map<string, Record<string, unknown>> | null | undefined,
): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  const res = latestResults?.get(nodeId);
  // Points Influence's points are its first mesh's vertices: that mesh is
  // the whole surface, and a BVH keeps its per-move raycast cheap.
  if (graph.nodes.find((n) => n.id === nodeId)?.type === POINTS_INFLUENCE_NODE.type) {
    const mesh = res?.geometry instanceof THREE.Object3D ? findFirstMesh(res.geometry) : null;
    if (!mesh) return [];
    getBoundsTree(mesh.geometry);
    return [mesh];
  }
  if (res?.geometry instanceof THREE.Object3D) {
    res.geometry.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        meshes.push(child as THREE.Mesh);
      }
    });
  }
  if (meshes.length === 0) {
    const conn = graph.connections.find((c) => c.toNode === nodeId && c.toSocket === "geometry");
    if (conn) {
      const srcRes = latestResults?.get(conn.fromNode);
      if (srcRes?.geometry instanceof THREE.Object3D) {
        srcRes.geometry.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            meshes.push(child as THREE.Mesh);
          }
        });
      }
    }
  }
  return meshes;
}

function createTerrainBrushGizmo(): THREE.LineLoop {
  const points: THREE.Vector3[] = [];
  const segments = 64;
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(theta), 0.05, Math.sin(theta)));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({
    color: 0x10b981,
    depthTest: false,
    transparent: true,
    opacity: 0.85,
  });
  const line = new THREE.LineLoop(geo, mat);
  line.visible = false;
  line.renderOrder = 9999;
  return line;
}

function createTextureBrushGizmo(): THREE.LineLoop {
  const points: THREE.Vector3[] = [];
  const segments = 64;
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(theta), 0.05, Math.sin(theta)));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({
    color: 0x38bdf8,
    depthTest: false,
    transparent: true,
    opacity: 0.9,
  });
  const line = new THREE.LineLoop(geo, mat);
  line.visible = false;
  line.renderOrder = 9999;
  return line;
}


function getTargetGeometryForNode(
  node: { id: string; type: string },
  graph: Graph,
  latestResults: Map<string, Record<string, unknown>> | null | undefined,
): THREE.Object3D | null {
  if (node.type !== PAINT_ON_GEOMETRY_NODE.type) return null;
  const incoming = graph.connections.find((c) => c.toNode === node.id && c.toSocket === "geometry");
  if (!incoming) return null;
  const res = latestResults?.get(incoming.fromNode);
  if (res?.geometry instanceof THREE.Object3D) {
    return res.geometry;
  }
  return null;
}

function resolvePointerPoint(
  clientX: number,
  clientY: number,
  node: NodeInstance,
  graph: Graph,
  latestResults: Map<string, Record<string, unknown>> | null | undefined,
  camera: THREE.Camera,
  domElement: HTMLElement,
  mode2D: boolean,
): { pos: THREE.Vector3; normal?: THREE.Vector3 } | null {
  if (node.type === PAINT_ON_GEOMETRY_NODE.type) {
    const targetObj = getTargetGeometryForNode(node, graph, latestResults);
    const paintGroup = (latestResults?.get(node.id)?.geometry as THREE.Object3D) || null;
    if (targetObj) {
      const hit = projectScreenToTargetGeometry(clientX, clientY, camera, domElement, targetObj, paintGroup);
      if (hit) {
        return { pos: hit.point, normal: hit.normal };
      }
      return null;
    }
  }

  const worldPos = projectScreenToDrawingPlane(clientX, clientY, {
    camera,
    domElement,
    elevationY: node.params.location instanceof THREE.Vector3 ? node.params.location.y : 0,
    mode2D,
    objectPosition: node.params.location instanceof THREE.Vector3 ? node.params.location : undefined,
  });

  return worldPos ? { pos: worldPos } : null;
}

function getGpInverseMatrix(
  node: NodeInstance,
  latestResults: Map<string, Record<string, unknown>> | null,
): THREE.Matrix4 {
  const gpGroup = (latestResults?.get(node.id)?.geometry as THREE.Object3D) || null;
  const inv = new THREE.Matrix4();
  if (gpGroup) {
    gpGroup.updateWorldMatrix(true, false);
    inv.copy(gpGroup.matrixWorld).invert();
  } else {
    const loc = node.params.location instanceof THREE.Vector3 ? node.params.location : new THREE.Vector3();
    const rot = node.params.rotation instanceof THREE.Vector3 ? node.params.rotation : new THREE.Vector3();
    const sca = node.params.scale instanceof THREE.Vector3 ? node.params.scale : new THREE.Vector3(1, 1, 1);
    const piv = node.params.pivot instanceof THREE.Vector3 ? node.params.pivot : new THREE.Vector3();
    const m = composeNativeMatrixWithPivot(undefined, loc, rot, sca, piv, node.params);
    inv.copy(m).invert();
  }
  return inv;
}
import { createBackgroundBlur } from "./backgroundBlur";
import { applyEnvironment, resolveActiveEnvironment } from "./environmentSync";
import {
  buildMainSceneGridAndAxes,
  createGizmoScene,
  createViewportBackground,
  updateViewportBackground,
  updateGridColor,
  disposeMainSceneGridAndAxes,
  disposeGizmoScene,
  GIZMO_ACTIVE_COLOR,
  GIZMO_X_COLOR,
  GIZMO_Y_COLOR,
  GIZMO_Z_COLOR,
} from "./viewportScenery";
import { getCurrentColors, ThemeColors } from "../theme/themeStore";
import { disposeObject3D } from "../graph/nodeCaches";
import { registerPointerViewport } from "../graph/pointerStore";
import { ShadowUpdateTracker } from "./shadowUpdateTracker";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { createMotionBlur } from "./motionBlur";
import { VolumetricPass, findVolumetricSettings, LAYER_VOLUMETRIC } from "./volumetricPass";
import { advancePlayhead, IDLE_PLAYHEAD, PlayheadState } from "./playhead";
import { PostProcessConfig } from "../graph/nodes/postprocessing";
import { Graph, KeyframeStore, NodeInstance, NodeRegistry } from "../graph/types";
import { isViewportZone, setInputZone } from "../graph/inputZoneStore";
import { isKeyReservedForPlayback } from "../graph/playbackKeys";
import { isTauri } from "../ipc";
import type { PreviewCameraPose } from "../ipc";
import { ViewportParamHUD } from "../../windows/ViewportParamHUD";
import { VirtualInterfaceHUD } from "../../windows/VirtualInterfaceHUD";
import { VIRTUAL_INTERFACE_NODE } from "../graph/nodes/virtualInterface";
import "./viewport.css";

// HUD elements are CSS/DOM overlays, which video export (which captures the
// WebGL canvas) would otherwise omit. These helpers redraw each element onto a
// 2D canvas so the export includes the HUD.
/**
 * Cold-blue (0) to hot-red (1) heatmap for Points Influence — the palette's
 * swatches here, the painted surface in influenceHeatmapMaterial. Both mix
 * the same two colours in linear space.
 */
const INFLUENCE_COLD = new THREE.Color(0x2563eb);
const INFLUENCE_HOT = new THREE.Color(0xef4444);
const INFLUENCE_RAMP: number[] = (() => {
  const cold = INFLUENCE_COLD;
  const hot = INFLUENCE_HOT;
  const mixed = new THREE.Color();
  return Array.from({ length: 256 }, (_, i) => mixed.copy(cold).lerp(hot, i / 255).getHex());
})();

function influenceColor(v: number): number {
  return INFLUENCE_RAMP[Math.round(Math.max(0, Math.min(1, v || 0)) * 255)];
}

/** The palette's level colors, in the same order as POINTS_INFLUENCE_LEVELS. */
const DISCRETE_LEVEL_HEX = POINTS_INFLUENCE_LEVELS.map((v) => `#${influenceColor(v).toString(16).padStart(6, "0")}`);

/** Hands each mounted viewport its own evaluator session id. */
let nextSessionOrdinal = 0;

/** At 60fps, one second of grace before an undecodable HUD image is given up on. */
const MAX_CAPTURE_WAIT_TICKS = 60;

/**
 * Edit Mesh Points reuses curveHandles — one draggable THREE.Mesh per point —
 * which is exactly right at a curve's handful of control points and
 * "catastrophic" (see pointCloudHandles.ts) at real mesh vertex counts. Past
 * this many points the handles are skipped rather than hanging the viewport;
 * a low-poly primitive (a Box, a coarse Sphere) stays well under it.
 */
const EDIT_MESH_POINTS_HANDLE_CAP = 2000;
let editMeshPointsCapWarned = false;

/**
 * Which editor viewport the keyboard currently belongs to. Every non-output
 * Viewport listens for keydown on `window`, and in 2D mode two of them are
 * mounted at once (the main view and the elevation view) — so E extruded
 * twice, Escape cleared twice, and so on. Keys go to the viewport the pointer
 * last entered or pressed in; the first one mounted holds them until then.
 */
const liveKeyboardViewports = new Map<symbol, () => boolean>();
let keyboardViewportOwner: symbol | null = null;

/** The owner if it can still take keys, else the first live, unsuspended one. */
function keyboardViewport(): symbol | null {
  const ownerSuspended = keyboardViewportOwner ? liveKeyboardViewports.get(keyboardViewportOwner) : undefined;
  if (ownerSuspended && !ownerSuspended()) return keyboardViewportOwner;
  for (const [token, isSuspended] of liveKeyboardViewports) {
    if (!isSuspended()) return token;
  }
  return null;
}

const exportImageCache = new Map<string, HTMLImageElement>();
function getExportImage(url: string): HTMLImageElement | null {
  let img = exportImageCache.get(url);
  if (!img) {
    img = new Image();
    img.src = url;
    exportImageCache.set(url, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/**
 * True once every HUD image in `elements` has decoded. Decoding is async and
 * starts on first use, so without this gate the opening frames of an export
 * encoded with the image elements simply missing — the very frames a title
 * card lives on.
 */
function hubImagesReady(elements: HubElement[]): boolean {
  for (const el of elements) {
    if (!el.visible || el.cssOpacity <= 0) continue;
    if (el.imageUrl && !getExportImage(el.imageUrl)) return false;
  }
  return true;
}

/** Drops cached decodes for object URLs no element references any more. */
function pruneExportImages(elements: HubElement[]): void {
  if (exportImageCache.size === 0) return;
  const live = new Set<string>();
  for (const el of elements) if (el.imageUrl) live.add(el.imageUrl);
  for (const url of exportImageCache.keys()) {
    if (!live.has(url)) exportImageCache.delete(url);
  }
}

/**
 * The animation part of a hub element's CSS transform — everything before the
 * `translate(-50%, -50%)` that merely centres it. The CSS overlay gets these
 * for free; the export canvas has to reproduce them, and not doing so meant
 * every animation except `fade` was invisible in the encoded video.
 */
function parseHubAnimationTransform(
  transform: string,
  frameWidth: number,
  frameHeight: number,
): { dx: number; dy: number; scale: number } {
  let dx = 0;
  let dy = 0;
  let scale = 1;
  const tx = transform.match(/translateX\((-?[\d.]+)vw\)/);
  if (tx) dx = (parseFloat(tx[1]) / 100) * frameWidth;
  const ty = transform.match(/translateY\((-?[\d.]+)vh\)/);
  if (ty) dy = (parseFloat(ty[1]) / 100) * frameHeight;
  const sc = transform.match(/scale\((-?[\d.]+)\)/);
  if (sc) scale = parseFloat(sc[1]);
  return { dx, dy, scale };
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawHubElement(
  ctx: CanvasRenderingContext2D,
  el: HubElement,
  frameWidth: number,
  frameHeight: number,
): void {
  if (!el.visible || el.cssOpacity <= 0) return;
  const anim = parseHubAnimationTransform(el.transform, frameWidth, frameHeight);
  if (anim.scale === 0) return;
  ctx.save();
  ctx.translate(el.x + anim.dx, el.y + anim.dy);
  if (anim.scale !== 1) ctx.scale(anim.scale, anim.scale);
  ctx.rotate((el.rotation * Math.PI) / 180);
  ctx.globalAlpha = el.cssOpacity;
  // `filter` carries the blur animation. Not every 2D context implements it,
  // so only set it when the property exists — the element still draws (sharp)
  // where it doesn't, rather than throwing mid-frame.
  if (el.filter && "filter" in ctx) ctx.filter = el.filter;

  if (el.imageUrl) {
    const img = getExportImage(el.imageUrl);
    if (img) {
      const w = (el.imageWidth ?? 200) * el.scale;
      const h = w / Math.max(1, img.naturalWidth / Math.max(1, img.naturalHeight));
      ctx.save();
      roundRectPath(ctx, -w / 2, -h / 2, w, h, el.borderRadius);
      ctx.clip();
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.restore();
      if (el.borderColor) {
        ctx.strokeStyle = el.borderColor;
        ctx.lineWidth = el.borderWidth;
        roundRectPath(ctx, -w / 2, -h / 2, w, h, el.borderRadius);
        ctx.stroke();
      }
    }
  } else {
    const fontSize = Math.max(1, el.fontSize * el.scale);
    ctx.font = `${fontSize}px ${el.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const tw = ctx.measureText(el.text).width;
    const bh = fontSize * 1.2 + 8;
    const bw = tw + 20;
    if (el.backgroundColor) {
      ctx.fillStyle = el.backgroundColor;
      roundRectPath(ctx, -bw / 2, -bh / 2, bw, bh, el.borderRadius);
      ctx.fill();
    }
    if (el.borderColor) {
      ctx.strokeStyle = el.borderColor;
      ctx.lineWidth = el.borderWidth;
      roundRectPath(ctx, -bw / 2, -bh / 2, bw, bh, el.borderRadius);
      ctx.stroke();
    }
    if (el.textShadow) {
      const m = el.textShadow.match(/(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(.*)$/);
      if (m) {
        ctx.shadowOffsetX = parseFloat(m[1]);
        ctx.shadowOffsetY = parseFloat(m[2]);
        ctx.shadowBlur = parseFloat(m[3]);
        ctx.shadowColor = m[4].trim();
      }
    }
    ctx.fillStyle = el.color;
    ctx.fillText(el.text, 0, 0);
  }
  ctx.restore();
}

/** Multiplies every `<n>px` token in a CSS string by `s` (HUD size scaling). */
function scalePxString(value: string | null | undefined, s: number): string | undefined {
  if (!value) return undefined;
  return value.replace(/(-?\d+(?:\.\d+)?)px/g, (_m, n: string) => `${(parseFloat(n) * s).toFixed(2)}px`);
}

/**
 * Copy a light's live state onto another instance of the same type. The
 * viewport's output pane holds its own clone of each graph light (they are
 * cached per node id at module scope and can only have one parent — see the * comment next to the clone in tick()), and this keeps that clone in step
 * with the shared original every frame, instead of re-cloning (which would
 * allocate a fresh shadow render target per frame).
 */
function copyLightState(src: THREE.Light, dst: THREE.Light) {
  dst.color.copy(src.color);
  dst.intensity = src.intensity;  dst.castShadow = src.castShadow;
  dst.position.copy(src.position);
  dst.quaternion.copy(src.quaternion);
  dst.scale.copy(src.scale);

  if (src instanceof THREE.PointLight && dst instanceof THREE.PointLight) {
    dst.distance = src.distance;
    dst.decay = src.decay;
  }
  if (src instanceof THREE.SpotLight && dst instanceof THREE.SpotLight) {
    dst.distance = src.distance;
    dst.decay = src.decay;
    dst.angle = src.angle;
    dst.penumbra = src.penumbra;
  }

  const srcTarget = (src as THREE.DirectionalLight | THREE.SpotLight).target;
  const dstTarget = (dst as THREE.DirectionalLight | THREE.SpotLight).target;
  if (srcTarget && dstTarget) {
    dstTarget.position.copy(srcTarget.position);
    dstTarget.updateMatrixWorld(true);
  }
  dst.updateMatrixWorld(true);
}


/**
 * The camera result currently driving the output — the same arbitration the
 * render loop uses to decide whose matrix positions the view: an active Fly
 * To wins over every Camera node, then the first active Camera, then the
 * first Camera regardless of its Active toggle. Extracted so the *previous*
 * frame's answer can be fed back into the next evaluation (see
 * EvalContext.activeCameraPose) without duplicating the rules.
 */
function resolveActiveCameraResult(
  results: Map<string, Record<string, unknown>>,
  graph: Graph,
): Record<string, unknown> | undefined {
  for (const node of walkNodes(graph)) {
    if (node.type !== CAMERA_FLY_TO_NODE.type) continue;
    const res = results.get(node.id);
    if (res && res.active !== 0 && res.active !== false) return res;
  }

  const cameraNodes = walkNodes(graph).filter((n) => n.type === CAMERA_NODE.type);
  for (const node of cameraNodes) {
    const res = results.get(node.id);
    if (res && res.active !== 0 && res.active !== false) return res;
  }
  if (cameraNodes.length > 0) return results.get(cameraNodes[0].id);
  return undefined;
}

function activeCameraPoseFrom(result: Record<string, unknown> | undefined): { matrix: THREE.Matrix4; fov: number } | null {
  if (!result || !(result.matrix instanceof THREE.Matrix4)) return null;
  return { matrix: result.matrix, fov: typeof result.fov === "number" ? result.fov : 50 };
}


interface ViewportProps {
  graph: Graph;
  registry: NodeRegistry;
  /**
   * Which node in the graph is the `render` node. Not a gate on what gets
   * drawn any more (see sceneRoots.ts) — it supplies the output settings,
   * the environment and the post-process chain, and its own subtree is what
   * the outline pass and the passe-partout guide treat as "the output".
   */
  renderNodeId: string;
  /**
   * When set, this Viewport becomes a 2D Render: no 3D scene is drawn to the
   * canvas at all — instead, every tick it looks up this node's evaluated
   * `texture` output and blits it full-frame (letterboxed to the texture's
   * own aspect). Scene assembly/evaluation still runs exactly as normal
   * (a `texture/camera` source needs the real 3D scene to render from), only
   * the final draw differs. See View2DWindow.tsx.
   */
  view2DNodeId?: string;
  epochMs?: number;
  /**
   * True for the projector-facing output window: no dev HUD, no orientation
   * gizmo, no debug ground grid/axis arrows baked into the projected image
   * — just the rendered scene. Default false (the editor's own viewport).
   */
  outputMode?: boolean;
  /**
   * Freezes this viewport's render loop entirely — no evaluation, no draw.
   * Set on the editor panes while a video export runs: stateful nodes
   * (particle sims, Ray Burst, hub triggers, Fly To) keep their state in
   * module-level caches keyed only by node id, so a preview pane ticking on
   * real time between two captured frames advanced the very state the export
   * was trying to sample deterministically.
   */
  suspended?: boolean;
  /** Drives which object shows a transform gizmo — shared with GraphEditor's own node selection (see App.tsx), so clicking an object here and clicking its node in the graph select the same thing. */
  selectedNodeId?: string | null;
  /** Fired on a click (not a drag) that hits a selectable mesh, or null on an empty-space click — mirrors GraphEditor's onSelectNode. Omit to disable click-to-select and the gizmo entirely. */
  onSelectNode?: (nodeId: string | null) => void;
  /** Fired continuously while dragging the gizmo, once the selected object's `matrix` input traces back to a plain Transform node (see transformLookup.ts) — nothing fires for an object with no such upstream node. */
  onTransformChange?: (transformNodeId: string, patch: TransformPatch) => void;
  /** Fired once when a gizmo drag begins — the parent records one undo step for the whole drag (see App.tsx). */
  onTransformStart?: () => void;
  /** Editor-only: fired on every orbit-camera change (and once on mount), so the output window can mirror the current view when there's no Camera node to lock onto instead — see the `previewCameraPose` prop below. */
  onCameraChange?: (pose: PreviewCameraPose) => void;
  /** Output-only: the editor's last-broadcast orbit pose. Applied only when there's no Camera node driving the camera (see the calibrationMatrix branch in tick()) — a Camera node's calibrated lock always wins. */
  previewCameraPose?: PreviewCameraPose | null;
  isSplitView?: boolean;
  onToggleSplitView?: () => void;
  currentFrame?: number;
  onEvaluatedResults?: (results: Map<string, Record<string, unknown>>) => void;
  isPlaying?: boolean;
  /**
   * Total timeline length. Only needed by the viewport that drives playback
   * (see `onFrameChange`); without it the incoming `currentFrame` is used as-is.
   */
  totalFrames?: number;
  /**
   * Set to make this viewport own the playhead while playing, advancing it off
   * the same clock it renders on and reporting each new frame back out.
   *
   * Keyframed motion only moves when `currentFrame` changes, so when an
   * outside timer pushed that frame in, two consecutive renders could land on
   * the same one. Motion blur's velocity buffer compares each render with the
   * one before it, so those duplicate renders measured no movement at all and
   * came out sharp — the reason a keyframed scene barely blurred while a
   * Time-node-driven one, running on this same clock, always did.
   *
   * Exactly one viewport should be given this.
   */
  onFrameChange?: (frame: number) => void;
  /** Fired continuously while dragging the 2D HUD gizmo on the camera view — writes the element's position/rotation/scale back to its hub node. */
  onHubChange?: (nodeId: string, patch: Partial<{ x: number; y: number; rotation: number; scale: number }>) => void;
  /**
   * Populated (by this component, into the ref the caller passed in) once
   * the render loop is up — see videoExport.ts. `captureFrame` forces the
   * *next* tick() to use `frameIndex/fps` for both the deterministic clock
   * (so Time-node/oscillator/particle output matches that instant rather
   * than real elapsed time) and keyframe evaluation, in place of whatever
   * live playback would have used that frame, then resolves once that
   * frame has been drawn.
   */
  exportHandleRef?: MutableRefObject<ViewportExportHandle | null>;
  /** Editor-only: the pinned viewport param HUD — see ViewportParamHUD. Not shown in outputMode. */
  keyframes?: KeyframeStore;
  keyframesEnabled?: boolean;
  onParamChange?: (
    paramId: string | Record<string, unknown>,
    value?: unknown,
    targetNodeId?: string,
    options?: { coalesce?: boolean },
  ) => void;
  onParamAction?: (nodeId: string, action: string) => void;
  onUnpinParam?: (nodeId: string, paramId: string) => void;
  onRenameExposedParam?: (nodeId: string, paramId: string, label: string) => void;
  mode2D?: boolean;
  elevationView?: boolean;
  snapElevation?: boolean;
  onToggleSnapElevation?: () => void;
  cameraView?: boolean;
  gpTool?: GpToolMode;
  onGpToolChange?: (mode: GpToolMode) => void;
  transformMode?: TransformGizmoMode;
  onTransformModeChange?: (mode: TransformGizmoMode) => void;
}

export interface ViewportExportHandle {
  getCanvas: () => HTMLCanvasElement | null;
  /**
   * `timelineFrame` is the frame keyframes and the playhead read, when it
   * isn't `frameIndex` — an export that follows Go To Canvas restarts the
   * timeline on each canvas while the clock keeps running.
   */
  captureFrame: (frameIndex: number, fps: number, timelineFrame?: number) => Promise<void>;
}



export function Viewport({
  graph,
  registry,
  renderNodeId,
  view2DNodeId,
  epochMs = 0,
  outputMode = false,
  suspended = false,
  onSelectNode,
  selectedNodeId = null,
  onTransformChange,
  onTransformStart,
  onCameraChange,
  previewCameraPose = null,
  isSplitView: _isSplitView = false,
  onToggleSplitView: _onToggleSplitView,
  currentFrame = -1,
  onEvaluatedResults,
  isPlaying = false,
  totalFrames = 0,
  onFrameChange,
  exportHandleRef,
  onHubChange,
  keyframes,
  keyframesEnabled = true,
  onParamChange,
  onParamAction,
  onUnpinParam,
  onRenameExposedParam,
  mode2D = false,
  elevationView = false,
  snapElevation = false,
  onToggleSnapElevation,
  cameraView = false,
  gpTool: gpToolProp,
  onGpToolChange,
  transformMode: transformModeProp,
  onTransformModeChange,
}: ViewportProps) {
  const [showUiOverlay, setShowUiOverlay] = useState(true);
  const showUiOverlayRef = useRef(showUiOverlay);
  showUiOverlayRef.current = showUiOverlay;
  // UV checker: the selected object (everything, with nothing selected) drawn
  // with the UV grid instead of its material — editor view only.
  const [uvChecker, setUvChecker] = useState(false);
  const uvCheckerRef = useRef(uvChecker);
  uvCheckerRef.current = uvChecker;
  // UV view: the selected object's UV layout, filled in by the render loop.
  const [uvPanelOpen, setUvPanelOpen] = useState(false);
  const uvPanelOpenRef = useRef(uvPanelOpen);
  uvPanelOpenRef.current = uvPanelOpen;
  const uvPanelDataRef = useRef<UVPanelData | null>(null);
  const [isHudCollapsed, setIsHudCollapsed] = useState(false);

  const currentFrameRef = useRef(currentFrame);
  currentFrameRef.current = currentFrame;
  const totalFramesRef = useRef(totalFrames);
  totalFramesRef.current = totalFrames;
  const onFrameChangeRef = useRef(onFrameChange);
  onFrameChangeRef.current = onFrameChange;

  /** Ties the timeline to the render clock while playing — see playhead.ts. */
  const playheadRef = useRef<PlayheadState>(IDLE_PLAYHEAD);

  // Set by captureFrame(), read (and cleared) by the very next tick() —
  // see ViewportExportHandle's own doc comment above.
  const pendingCaptureRef = useRef<{
    frameIndex: number;
    fps: number;
    timelineFrame?: number;
    resolve: () => void;
    /** Ticks this frame has been held waiting on HUD image decodes. */
    waited?: number;
  } | null>(null);
  const onEvaluatedResultsRef = useRef(onEvaluatedResults);
  onEvaluatedResultsRef.current = onEvaluatedResults;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  // A simulation run is live from the first Play until Reset Simulation: Pause keeps it (bodies and
  // pieces stay where they are), only Reset ends it. See EvalContext.simulationRun.
  const simulationRunRef = useRef(false);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  // One evaluator session per mounted viewport — see EvalContext.sessionId.
  const sessionIdRef = useRef<string>("");
  if (!sessionIdRef.current) {
    sessionIdRef.current = `viewport-${nextSessionOrdinal++}`;
  }

  const [showEnvInEditor, setShowEnvInEditor] = useState(Boolean(mode2D));
  const showEnvInEditorRef = useRef(showEnvInEditor);
  showEnvInEditorRef.current = showEnvInEditor;

  const [isCameraView, setIsCameraView] = useState(Boolean(cameraView));
  const isCameraViewRef = useRef(isCameraView);
  isCameraViewRef.current = isCameraView;

  useEffect(() => {
    setIsCameraView(Boolean(cameraView));
  }, [cameraView]);

  const [lockCameraToView, setLockCameraToView] = useState(false);
  const lockCameraToViewRef = useRef(lockCameraToView);
  lockCameraToViewRef.current = lockCameraToView;

  const [hubElements, setHubElements] = useState<HubElement[]>([]);
  const hubSigRef = useRef<string>("");
  // The render node's output resolution — HUD elements are positioned in these
  // pixels. Non-null means a render node exists (which enables the HUD).
  const [renderSize, setRenderSize] = useState<{ width: number; height: number } | null>(null);
  const renderSizeRef = useRef<{ width: number; height: number } | null>(null);
  // The on-screen rectangle the render frame occupies (viewport px). When the
  // output window's aspect doesn't match the render's, the frame is letterboxed
  // (see the scissor block in tick) and the HUD must live INSIDE that frame so
  // positions in render-pixels map exactly to the exported frame.
  const [renderFrame, setRenderFrame] = useState({ x: 0, y: 0, width: 1, height: 1 });
  const renderFrameRef = useRef({ x: 0, y: 0, width: 1, height: 1 });
  const renderFrameStateRef = useRef({ x: 0, y: 0, width: 1, height: 1 });
  // Whether the render node's holdout is on (blacks out the area outside the render frame).
  const holdoutRef = useRef(false);

  const hubDragRef = useRef<{
    mode: "move" | "rotate" | "size";
    startClientX: number;
    startClientY: number;
    originClientX: number;
    originClientY: number;
    baseX: number;
    baseY: number;
    baseRot: number;
    baseScale: number;
  } | null>(null);
  // Set once a drag actually moves the pointer — used to distinguish a real
  // drag from a plain click so a drag doesn't also trigger select.
  const hubDragMovedRef = useRef(false);

  const [marqueeBox, setMarqueeBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  /** Points Influence's Shift-drag gradient line while it is being dragged, in viewport pixels. */
  const [gradientLine, setGradientLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  // Grease Pencil drawing state
  const onParamChangeRef = useRef(onParamChange);
  onParamChangeRef.current = onParamChange;
  const onParamActionRef = useRef(onParamAction);
  onParamActionRef.current = onParamAction;
  const [internalGpTool, setInternalGpTool] = useState<GpToolMode>("pen");
  const gpTool = gpToolProp !== undefined ? gpToolProp : internalGpTool;
  const setGpTool = (action: React.SetStateAction<GpToolMode>) => {
    const next = typeof action === "function" ? action(gpTool) : action;
    setInternalGpTool(next);
    onGpToolChange?.(next);
  };
  const gpToolRef = useRef<GpToolMode>(gpTool);
  gpToolRef.current = gpTool;
  const [gpBrushType, setGpBrushType] = useState<GreaseBrushType>("ink_pen");
  const gpBrushTypeRef = useRef<GreaseBrushType>("ink_pen");
  gpBrushTypeRef.current = gpBrushType;
  const [gpSolidFill, setGpSolidFill] = useState<boolean>(false);
  const gpSolidFillRef = useRef<boolean>(false);
  gpSolidFillRef.current = gpSolidFill;
  const [isGpDrawing, setIsGpDrawing] = useState(false);
  const isGpDrawingRef = useRef(false);
  const [gpLivePreview, setGpLivePreview] = useState<{ screenX: number; screenY: number }[]>([]);
  const gpLivePreviewRef = useRef<{ screenX: number; screenY: number }[]>([]);
  const gpPrevPointerRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const gpActivePointsRef = useRef<StrokePoint[]>([]);
  const gpShiftAtStartRef = useRef(false);
  const gpCtrlAtStartRef = useRef(false);
  const gpPressureModifierRef = useRef(1.0);
  const gpWorkingFramesRef = useRef<KeyframeDrawing[] | null>(null);
  const gpSmoothedWorldPosRef = useRef<THREE.Vector3 | null>(null);
  // Screen-space stabilizer for the active stroke (see strokeInput.ts). Runs
  // before projection so smoothing behaves the same at any camera angle.
  const gpStabilizerRef = useRef<Stabilizer | null>(null);
  const gpPrevSampleRef = useRef<PointerSample | null>(null);
  /** Pressure resolver for the active stroke (hardware, else simulated). */
  const gpPressureTrackerRef = useRef<PressureTracker | null>(null);
  /** Screen position of the last point actually appended, for pixel dedup. */
  const gpLastAppendedScreenRef = useRef<{ x: number; y: number } | null>(null);
  /** Anchor point of the shape tools' drag, in client space. */
  const gpLineAnchorRef = useRef<{ x: number; y: number } | null>(null);
  /** Vertices committed so far by the polyline tool, in client space. */
  const gpPolylineVerticesRef = useRef<ShapePoint[]>([]);
  /** Freehand lasso path being drawn, in client space. */
  const gpLassoPointsRef = useRef<ShapePoint[]>([]);
  const [gpLassoPreview, setGpLassoPreview] = useState<ShapePoint[]>([]);
  /** Strokes picked by the lasso select tool. */
  const gpSelectedStrokeIdsRef = useRef<Set<string>>(new Set());
  const [gpSelectionOverlay, setGpSelectionOverlay] = useState<{ screenX: number; screenY: number }[][]>([]);
  /** In-flight drag that moves the lasso selection. */
  const gpSelectionDragRef = useRef<{ lastX: number; lastY: number } | null>(null);
  /** Last warning raised by the fill tool ("leaked" and friends). */
  const [gpToolHint, setGpToolHint] = useState<string | null>(null);
  /**
   * Bridge to the polyline finisher, which lives in the renderer effect while
   * the keyboard handler that ends a polyline lives in another one.
   */
  const gpFinishPolylineRef = useRef<((closeShape: boolean) => void) | null>(null);

  // Edit Mesh modeling state
  const [editMeshTool, setEditMeshTool] = useState<"select" | "loopcut" | "modal">("select");
  const editMeshToolRef = useRef<"select" | "loopcut" | "modal">("select");
  editMeshToolRef.current = editMeshTool;
  const editMeshHoverFaceRef = useRef<number | null>(null);
  const editMeshPreviewLoopRef = useRef<[ [number, number, number], [number, number, number] ][] | null>(null);
  const editMeshRectDragRef = useRef<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    /** The lasso's path so far, in client px (lasso shape only). */
    path: { x: number; y: number }[];
  } | null>(null);
  // Shift+drag draws a box or a lasso, toggled from the Edit Mesh HUD.
  const [editMeshMarqueeShape, setEditMeshMarqueeShape] = useState<"box" | "lasso">("box");
  const editMeshMarqueeShapeRef = useRef<"box" | "lasso">("box");
  editMeshMarqueeShapeRef.current = editMeshMarqueeShape;
  const [lassoPath, setLassoPath] = useState<string | null>(null);
  // Edit Mesh transform settings, per viewport like Blender's header: the
  // gizmo's orientation, what it pivots about, and what a move snaps to.
  const [editOrientation, setEditOrientation] = useState<"global" | "local" | "normal">("global");
  // Object mode's gizmo axes, as Blender's Transform Orientation: the world's,
  // or the selected object's own (the way it is turned, not its applied shape).
  const [objectOrientation, setObjectOrientation] = useState<"global" | "local">("global");
  const objectOrientationRef = useRef(objectOrientation);
  objectOrientationRef.current = objectOrientation;
  const editOrientationRef = useRef(editOrientation);
  editOrientationRef.current = editOrientation;
  const [editPivot, setEditPivot] = useState<"median" | "individual" | "origin">("median");
  const editPivotRef = useRef(editPivot);
  editPivotRef.current = editPivot;
  const [editSnap, setEditSnap] = useState<"off" | "increment" | "vertex">("off");
  const editSnapRef = useRef(editSnap);
  editSnapRef.current = editSnap;
  /** The running Edit Mesh modal tool's readout, or null when none is running. */
  const [editModalHud, setEditModalHud] = useState<string | null>(null);
  /**
   * The Edit Mesh's material inputs for the Assign menu, each shown by the
   * name of the material wired into it ("Gold"), including the free one to
   * wire next ("Empty"); slot 0 unwired is the source's own material ("Default").
   */
  const materialSlotOptions = (node: { id: string; type: string; params: Record<string, unknown> }) => {
    // The level that holds the node — a group's interior when it's in one.
    const holder = findNodeWithGraph(graph, node.id)?.graph ?? graph;
    const wired = holder.connections.filter((c) => c.toNode === node.id);
    const sockets = materialInputSockets(wired);
    return sockets.map((socket, slot) => {
      const conn = wired.find((c) => c.toSocket === socket.id);
      const from = conn ? holder.nodes.find((n) => n.id === conn.fromNode) : undefined;
      const name = from ? String(from.params.name || registry.get(from.type)?.label || from.type) : slot === 0 ? "Default" : "Empty";
      return { slot, label: name };
    });
  };

  /** Edit Mesh operations for the HUD buttons, bound by the viewport effect. */
  const editMeshCommandsRef = useRef<{
    run(op: EditMeshOp): boolean;
    duplicate(): boolean;
    extrude(): boolean;
    tool(tool: "bevel" | "spin" | "knife" | "bridge"): boolean;
  } | null>(null);
  /** The Skeleton palette's operations, bound by the viewport effect (it owns the picked joints). */
  const skeletonCommandsRef = useRef<{ run(op: SkeletonOp): boolean } | null>(null);
  /** Joints picked on the selected Skeleton node, mirrored out of the effect for its palette. */
  const [skeletonSelection, setSkeletonSelection] = useState<number[]>([]);
  const editMeshPaintDragRef = useRef<boolean>(false);
  const [editMeshPaintCursor, setEditMeshPaintCursor] = useState<{ x: number; y: number } | null>(null);
  const [editMeshLoopCuts, setEditMeshLoopCuts] = useState<number>(1);
  const editMeshLoopCutsRef = useRef<number>(1);
  editMeshLoopCutsRef.current = editMeshLoopCuts;
  const editMeshHoverEdgeRef = useRef<[number, number] | null>(null);
  // The tool lives on the viewport, not the node, so an armed Loop Cut would
  // otherwise follow the operator to the next Edit Mesh they select — and
  // withhold that node's gizmo with no visible reason why.
  useEffect(() => {
    setEditMeshTool("select");
    editMeshPreviewLoopRef.current = null;
    editMeshHoverEdgeRef.current = null;
  }, [selectedNodeId]);

  // Terrain sculpting state
  const [terrainBrushTool, setTerrainBrushTool] = useState<TerrainBrushTool>("sculpt");
  const terrainBrushToolRef = useRef<TerrainBrushTool>("sculpt");
  terrainBrushToolRef.current = terrainBrushTool;
  const [terrainBrushFalloff, setTerrainBrushFalloff] = useState<TerrainBrushFalloff>("smooth");
  const terrainBrushFalloffRef = useRef<TerrainBrushFalloff>("smooth");
  terrainBrushFalloffRef.current = terrainBrushFalloff;
  const [terrainInvert, setTerrainInvert] = useState(false);
  const terrainInvertRef = useRef(false);
  terrainInvertRef.current = terrainInvert;
  const isTerrainSculptingRef = useRef(false);
  const terrainSculptWorkingOffsetsRef = useRef<Record<number, number> | null>(null);
  const terrainMaskWorkingRef = useRef<Record<number, number> | null>(null);
  const terrainTargetHeightRef = useRef<number | null>(null);

  // Sculpt (object/sculpt) state
  const [sculptBrushTool, setSculptBrushTool] = useState<SculptBrushTool>("draw");
  const sculptBrushToolRef = useRef<SculptBrushTool>("draw");
  sculptBrushToolRef.current = sculptBrushTool;
  const [sculptBrushFalloff, setSculptBrushFalloff] = useState<BrushFalloff>("smooth");
  const sculptBrushFalloffRef = useRef<BrushFalloff>("smooth");
  sculptBrushFalloffRef.current = sculptBrushFalloff;
  const [sculptInvert, setSculptInvert] = useState(false);
  const sculptInvertRef = useRef(false);
  sculptInvertRef.current = sculptInvert;
  const isSculptingRef = useRef(false);
  const sculptWorkingMeshRef = useRef<SculptMeshData | null>(null);
  const sculptWorkingAdjacencyRef = useRef<number[][]>([]);
  const sculptStrokeOriginRef = useRef<THREE.Vector3 | null>(null);
  const sculptStrokeNormalRef = useRef<THREE.Vector3 | null>(null);
  const sculptLastHitRef = useRef<THREE.Vector3 | null>(null);
  /** Wall-clock throttle for dyntopo refinement during a drag — re-splitting on every pointermove is wasted work once edges are already near target size; 100ms matches marmelab/sculpt-3D's own throttle. */
  const sculptLastRefineTimeRef = useRef(0);
  const sculptPressureTrackerRef = useRef<PressureTracker>(createPressureTracker());
  const sculptLastPressureSampleRef = useRef<PointerSample | null>(null);

  // Texture Paint and Texture Mix painting state
  /** Pending debounced param writes for painted textures, by node id. */
  const textureSnapshotTimersRef = useRef<Map<string, number>>(new Map());
  /** Points Influence's Blur drag: the map as it was when the drag began, and its UV coverage. */
  const influenceBlurRef = useRef<{
    nodeId: string;
    src: ImageData;
    /** The mesh's welded surface; null without UVs (then a plain map blur). */
    surface: SurfaceBlurSetup | null;
    /** The radius the slider asks for, and the frame that will show it (a blur of the whole map takes ~100 ms: one per frame, the latest). */
    radius: number;
    frame: number | null;
  } | null>(null);
  const isTexturePaintingRef = useRef(false);
  const texturePaintLastUvRef = useRef<{ x: number; y: number } | null>(null);
  /** Client-pixel position of the last painted sample — where a stroke resumes from when its UV jumps (see texturePaintSegments). */
  const texturePaintLastScreenRef = useRef<{ x: number; y: number } | null>(null);
  const textureBrushGizmoRef = useRef<THREE.LineLoop | null>(null);
  const texturePaintLastPressureRef = useRef<number>(1.0);
  const texturePaintPressureTrackerRef = useRef<PressureTracker>(createPressureTracker());
  const texturePaintPrevSampleRef = useRef<PointerSample | null>(null);

  const snapSelectedCameraToEditorRef = useRef<() => void>(() => {});
  const cameraGuideRef = useRef<HTMLDivElement>(null);

  // Drives the 2D HUD gizmo: window-level pointermove/up translate a drag on a
  // selected hub element into x/y (move) or rotation (rotate) patches.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = hubDragRef.current;
      const nodeId = selectedNodeIdRef.current;
      if (!drag || !nodeId || !onHubChange || !hostRef.current) return;
      const frame = renderFrameRef.current;
      const rs = renderSizeRef.current;
      if (!rs) return;
      if (drag.mode === "move") {
        hubDragMovedRef.current = true;
        // Pointer delta in viewport px, scaled to the render-node resolution
        // through the actual frame (so a letterboxed output stays precise).
        const nx = drag.baseX + ((e.clientX - drag.startClientX) / frame.width) * rs.width;
        const ny = drag.baseY + ((e.clientY - drag.startClientY) / frame.height) * rs.height;
        onHubChange(nodeId, { x: nx, y: ny });
      } else if (drag.mode === "rotate") {
        const angle = Math.atan2(e.clientY - drag.originClientY, e.clientX - drag.originClientX) * (180 / Math.PI);
        const startAngle = Math.atan2(drag.startClientY - drag.originClientY, drag.startClientX - drag.originClientX) * (180 / Math.PI);
        const rot = (drag.baseRot + angle - startAngle + 360) % 360;
        onHubChange(nodeId, { rotation: rot });
      } else {
        const ns = Math.max(0.05, Math.min(4, drag.baseScale + (e.clientX - drag.startClientX) / 200));
        onHubChange(nodeId, { scale: ns });
      }
    };
    const onUp = () => {
      hubDragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [onHubChange]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const activeEl = document.activeElement;
      const isInput =
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          activeEl.tagName === "SELECT" ||
          (activeEl as HTMLElement).isContentEditable);
      if (isInput) return;

      // Plain Tab only — Shift+Tab (cycling Viewport/Split/Camera/Graph) is
      // handled globally in App.tsx now, not here, since one of those four
      // states (full-canvas Graph) unmounts every Viewport instance and a
      // listener that lives inside one can't fire once none are mounted.
      if (isKeyReservedForPlayback(e)) return;

      if ((e.key === "Tab" || e.code === "Tab") && !e.shiftKey) {
        e.preventDefault();
        setShowUiOverlay((prev) => !prev);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const hostRef = useRef<HTMLDivElement>(null);
  /** The camera this pane is rendering from right now — the Roto Mask editor projects through it. */
  const liveCameraRef = useRef<() => THREE.Camera | null>(() => null);
  const hudToolMaxRows = useHudToolMaxRows(hostRef);
  // The tool columns sit right of the UV panel while it is open (both top-left).
  const hudToolColumnLeft = uvPanelOpen ? 12 + UV_PANEL_WIDTH + 8 : 12;
  /** The small grab-circle that appears near the viewport's left/right edge — drag it vertically to zoom around the orbit target, same as a mouse-wheel dolly. */
  const [edgeZoomHandle, setEdgeZoomHandle] = useState<{ side: "left" | "right"; y: number } | null>(null);
  const edgeZoomDraggingRef = useRef(false);
  const edgeZoomLastYRef = useRef(0);
  const edgeZoomHandlersRef = useRef<{ move: (e: PointerEvent) => void; up: () => void } | null>(null);
  useEffect(
    () => () => {
      if (edgeZoomHandlersRef.current) {
        window.removeEventListener("pointermove", edgeZoomHandlersRef.current.move);
        window.removeEventListener("pointerup", edgeZoomHandlersRef.current.up);
        window.removeEventListener("pointercancel", edgeZoomHandlersRef.current.up);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        edgeZoomHandlersRef.current = null;
      }
    },
    [],
  );
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const registryRef = useRef(registry);
  registryRef.current = registry;
  /** Reads the ref, so the closures the effects keep from the first render stay current. */
  const hasParamHandles = (node: { type: string }) => Boolean(registryRef.current.get(node.type)?.paramHandles);
  const renderNodeIdRef = useRef(renderNodeId);
  renderNodeIdRef.current = renderNodeId;
  const view2DNodeIdRef = useRef(view2DNodeId);
  view2DNodeIdRef.current = view2DNodeId;
  const resetCameraRef = useRef<() => void>(() => {});
  const setAxisViewRef = useRef<(axis: "x" | "y" | "z", sign: 1 | -1) => void>(() => {});
  /** Which side each axis button last snapped to, so clicking it again flips to the opposite view (Left <-> Right, and so on). */
  const axisSideRef = useRef<Record<"x" | "y" | "z", 1 | -1>>({ x: -1, y: 1, z: 1 });
  const resetSimulationRef = useRef<() => void>(() => {});
  /** Snaps the orbit target + distance to frame a given node's object — see the selectedNodeId auto-focus effect below. */
  const focusOnNodeRef = useRef<(nodeId: string) => void>(() => {});
  /** Refreshed every tick() with that frame's evaluation results, so the focus effect (which runs on React's own schedule, not the render loop) can look up whatever a given node's own evaluate() produced — see focusOnNodeRef. */
  const latestResultsRef = useRef<EvalResult | null>(null);
  const selectedNodeIdRef = useRef(selectedNodeId);
  selectedNodeIdRef.current = selectedNodeId;
  const onSelectNodeRef = useRef(onSelectNode);
  onSelectNodeRef.current = onSelectNode;
  const onTransformChangeRef = useRef(onTransformChange);
  onTransformChangeRef.current = onTransformChange;
  const onTransformStartRef = useRef(onTransformStart);
  onTransformStartRef.current = onTransformStart;
  const onCameraChangeRef = useRef(onCameraChange);
  onCameraChangeRef.current = onCameraChange;
  const previewCameraPoseRef = useRef(previewCameraPose);
  previewCameraPoseRef.current = previewCameraPose;
  const [internalTransformMode, setInternalTransformMode] = useState<TransformGizmoMode>("translate");
  const transformMode = transformModeProp !== undefined ? transformModeProp : internalTransformMode;
  const setTransformMode = (action: React.SetStateAction<TransformGizmoMode>) => {
    const next = typeof action === "function" ? action(transformMode) : action;
    setInternalTransformMode(next);
    onTransformModeChange?.(next);
    const selNode = selectedNodeIdRef.current
      ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current)
      : null;
    if (isPaintOrGreaseNode(selNode)) {
      setGpTool("select");
    }
  };
  const transformModeRef = useRef(transformMode);
  transformModeRef.current = transformMode;

  const [isOrthographic, setIsOrthographic] = useState(false);
  const isOrthographicRef = useRef(isOrthographic);
  isOrthographicRef.current = isOrthographic;
  const toggleCameraModeRef = useRef<(isOrtho: boolean) => void>(() => {});
  const [isAxisView, setIsAxisView] = useState(false);
  const isAxisViewRef = useRef(false);
  const [isViewLocked, setIsViewLocked] = useState(false);
  const isViewLockedRef = useRef(false);
  const setViewLockRef = useRef<(locked: boolean) => void>(() => {});
  const setIsIsometricElevationRef = useRef<() => void>(() => {});

  useEffect(() => {
    toggleCameraModeRef.current(isOrthographic);
  }, [isOrthographic]);

  const prevMode2DRef = useRef(mode2D);
  useEffect(() => {
    if (mode2D) {
      setShowEnvInEditor(true);
      showEnvInEditorRef.current = true;
      setAxisViewRef.current?.("y", 1);
      setViewLockRef.current?.(true);
      setIsViewLocked(true);
    } else if (prevMode2DRef.current) {
      // Returning from 2D mode to 3D mode:
      // 1. unlock view
      setViewLockRef.current?.(false);
      setIsViewLocked(false);
      setLockCameraToView(false);
      setIsCameraView(false);
      isAxisViewRef.current = false;
      setIsAxisView(false);
      // 2. toggle environnement OFF
      setShowEnvInEditor(false);
      showEnvInEditorRef.current = false;
      // 3. Reset 3D camera view
      setIsOrthographic(false);
      resetCameraRef.current?.();
    } else if (elevationView) {
      setIsIsometricElevationRef.current?.();
      setViewLockRef.current?.(false);
      setIsViewLocked(false);
    }
    prevMode2DRef.current = mode2D;
  }, [mode2D, elevationView]);

  const toggleViewLock = () => {
    setIsViewLocked((prev) => {
      const next = !prev;
      isViewLockedRef.current = next;
      setViewLockRef.current(next);
      return next;
    });
  };

  useEffect(() => {
    if (!hostRef.current) return;
    const host: HTMLDivElement = hostRef.current;

    // stencil: true — three.js leaves this off by default; the Clip Box /
    // Visual Slice "solid cap" draws (clipCaps.ts) need a real stencil buffer
    // or their stencil ops are silent no-ops and no cap ever appears.
    // preserveDrawingBuffer: true — ensures WebGL buffer pixels remain readable
    // after composition for exportCtx.drawImage / canvas.toBlob on Linux (WebKitGTK/NVIDIA).
    const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true, preserveDrawingBuffer: true });
    // The native app can afford 2x on a retina display; the browser build is
    // CPU/GPU-bound, so cap it lower there — a big fill-rate saving on a 2x
    // display (4x pixels → 2.25x at 1.5) for a barely perceptible softness.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, isTauri() ? 2 : 1.5));
    renderer.autoClear = false;
    enableSmoothShadows();
    renderer.shadowMap.enabled = true;
    // PCFSoftShadowMap is deprecated as of three r180 and three itself
    // silently falls back to PCFShadowMap (with a console warning every
    // renderer construction) — asking for it directly gets the exact same
    // shadows with no warning.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // Shadow maps are re-rendered only on frames where something they depend
    // on changed — see shadowUpdateTracker.ts and the render step in tick().
    renderer.shadowMap.autoUpdate = false;
    const shadowTracker = new ShadowUpdateTracker();
    host.appendChild(renderer.domElement);

    // Composite canvas for video export: the WebGL frame + the 2D HUD overlay,
    // since MediaRecorder can only capture a canvas, not the CSS HUD.
    const exportCanvas = document.createElement("canvas");
    const exportCtx = exportCanvas.getContext("2d");

    const currentColors = getCurrentColors();
    const viewportBackground = createViewportBackground(
      currentColors.viewportBgTop,
      currentColors.viewportBgBottom,
    );
    const scene = new THREE.Scene();
    const bgScene = new THREE.Scene();
    bgScene.background = viewportBackground;
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
    scene.add(ambientLight);
    const sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
    sunLight.position.set(3, 5, 4);
    scene.add(sunLight);

    // Editor UI Overlay Scene — holds grid, transform controls, light helpers outside of main postprocess pipeline
    const editorUiScene = new THREE.Scene();
    let gridAndAxes: THREE.Group | null = null;

    // Grid & Origin Axes Helper — editor-only, never baked into the projected output
    if (!outputMode) {
      gridAndAxes = buildMainSceneGridAndAxes(currentColors.viewportGrid);
      editorUiScene.add(gridAndAxes);
    }
    const elevationHUD = createElevationHUD();
    editorUiScene.add(elevationHUD.group);

    // 2D Render mode's whole "scene": a single unlit quad filling an
    // orthographic frustum exactly, textured with whatever the `view2d`
    // node resolves to. Built unconditionally (cheap — one quad) rather
    // than only when view2DNodeId is set, so there's nothing to lazily
    // construct on the tick() hot path.
    const view2DMaterial = new THREE.MeshBasicMaterial({ map: null, toneMapped: false });
    const view2DQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), view2DMaterial);
    const view2DScene = new THREE.Scene();
    view2DScene.add(view2DQuad);
    const view2DCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const handleThemeColorsChanged = (e: Event) => {
      const colors = (e as CustomEvent<ThemeColors>).detail;
      if (!colors) return;
      if (viewportBackground) {
        updateViewportBackground(viewportBackground, colors.viewportBgTop, colors.viewportBgBottom);
      }
      if (gridAndAxes) {
        updateGridColor(gridAndAxes, colors.viewportGrid);
      }
    };
    window.addEventListener("tsuji-theme-colors-changed", handleThemeColorsChanged);

    const perspectiveCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    perspectiveCamera.position.set(3, 3, 5);
    perspectiveCamera.lookAt(0, 0, 0);

    const orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    orthographicCamera.position.set(3, 3, 5);
    orthographicCamera.lookAt(0, 0, 0);

    let activeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera = isOrthographic
      ? orthographicCamera
      : perspectiveCamera;
    let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = activeCamera;

    // Publish this pane as a pointer target, so the Mouse node can unproject
    // the cursor through the camera actually rendering it — the graph's
    // Camera-node pose is null whenever the pane is being flown by this
    // editor camera, which is most of the time. See pointerStore.ts.
    const unregisterPointerViewport = registerPointerViewport({
      element: renderer.domElement,
      getCamera: () => camera,
    });
    liveCameraRef.current = () => camera;

    const composer = new EffectComposer(renderer);
    // The renderer's own stencil (see `stencil: true` above) only covers the
    // canvas; once a post-process is on, the scene draws into the composer's
    // targets instead, which three.js makes without one. Clip caps are pure
    // stencil, so every cap quad then paints its whole face. Set before the
    // targets' first use, so they're allocated with it (and keep it on resize).
    composer.renderTarget1.stencilBuffer = true;
    composer.renderTarget2.stencilBuffer = true;
    const renderPass = new RenderPass(scene, activeCamera);
    const outputPass = new OutputPass();
    composer.addPass(renderPass);
    composer.addPass(outputPass);

    // Volume en résolution réduite. Instanciée une fois, mais jamais insérée dans
    // la chaîne tant qu'aucun maillage ne la demande (Render Resolution < 1).
    // Déclarée ICI, avec le composer : resize() la référence, et resize est
    // appelée au montage bien avant le bloc du postChain plus bas.
    const volumetricPass = new VolumetricPass(scene, activeCamera, host.clientWidth || 1, host.clientHeight || 1);

    const controls = new OrbitControls(activeCamera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    toggleCameraModeRef.current = (isOrtho: boolean) => {
      const nextCam = isOrtho ? orthographicCamera : perspectiveCamera;
      const prevCam = isOrtho ? perspectiveCamera : orthographicCamera;

      nextCam.position.copy(prevCam.position);
      nextCam.quaternion.copy(prevCam.quaternion);
      nextCam.up.copy(prevCam.up);

      const { clientWidth, clientHeight } = host;
      const aspect = clientWidth && clientHeight ? clientWidth / clientHeight : 1;

      if (isOrtho) {
        const d = nextCam.position.distanceTo(controls.target) || 5;
        const fovRad = THREE.MathUtils.degToRad(perspectiveCamera.fov);
        const halfHeight = Math.tan(fovRad / 2) * d;
        const halfWidth = halfHeight * aspect;
        orthographicCamera.left = -halfWidth;
        orthographicCamera.right = halfWidth;
        orthographicCamera.top = halfHeight;
        orthographicCamera.bottom = -halfHeight;
        orthographicCamera.updateProjectionMatrix();
      } else {
        perspectiveCamera.aspect = aspect;
        perspectiveCamera.updateProjectionMatrix();
      }

      activeCamera = nextCam;
      camera = activeCamera;
      controls.object = camera;
      renderPass.camera = camera;
      if (transformControls) transformControls.camera = camera;
      controls.update();
    };

    resetCameraRef.current = () => {
      perspectiveCamera.position.set(3, 3, 5);
      perspectiveCamera.up.set(0, 1, 0);
      perspectiveCamera.lookAt(0, 0, 0);

      orthographicCamera.position.set(3, 3, 5);
      orthographicCamera.up.set(0, 1, 0);
      orthographicCamera.lookAt(0, 0, 0);

      controls.target.set(0, 0, 0);
      controls.update();
      // Reset leaves the fixed axis view and releases the lock.
      isAxisSnapped = false;
      setViewLockRef.current(false);
      setIsViewLocked(false);
      isAxisViewRef.current = false;
      setIsAxisView(false);
    };

    /**
     * Frames a node's object: pans the orbit target to its bounding-sphere
     * center and dollies to a distance that fits it comfortably, keeping the
     * current viewing *direction* (same reasoning as setAxisViewRef above —
     * reframe what's already being looked at, don't reset the angle).
     * Damping (already enabled on `controls`) smooths the jump over the next
     * few frames on its own; no manual animation needed.
     */
    focusOnNodeRef.current = (nodeId: string) => {
      // Not every node with a selectable transform is a scene *root* (most
      // aren't — a Box feeding a Render is one link in a chain, not an entry
      // in sceneRoots' output map), so this reads the node's own evaluate()
      // record instead and takes whichever output happens to be an
      // Object3D — the one thing every geometry/light/camera/Empty node's
      // result has in common, regardless of which key it's under.
      const nodeResult = latestResultsRef.current?.get(nodeId);
      const object = nodeResult && (Object.values(nodeResult).find((v) => v instanceof THREE.Object3D) as THREE.Object3D | undefined);
      if (!object) return;

      const box = new THREE.Box3().setFromObject(object);
      const center = box.isEmpty() ? object.getWorldPosition(new THREE.Vector3()) : box.getCenter(new THREE.Vector3());
      const radius = box.isEmpty() ? 0 : box.getSize(new THREE.Vector3()).length() / 2;
      const comfortableRadius = Math.max(radius, 0.75);

      const direction = activeCamera.position.clone().sub(controls.target).normalize();
      if (direction.lengthSq() === 0) direction.set(0.6, 0.6, 1).normalize();

      const fovRad = THREE.MathUtils.degToRad(perspectiveCamera.fov);
      const distance = (comfortableRadius / Math.sin(fovRad / 2)) * 1.4;

      perspectiveCamera.position.copy(center).addScaledVector(direction, distance);
      perspectiveCamera.lookAt(center);
      orthographicCamera.position.copy(center).addScaledVector(direction, distance);
      orthographicCamera.lookAt(center);

      if (activeCamera === orthographicCamera) {
        const { clientWidth, clientHeight } = host;
        const aspect = clientWidth && clientHeight ? clientWidth / clientHeight : 1;
        const halfHeight = Math.tan(fovRad / 2) * distance;
        const halfWidth = halfHeight * aspect;
        orthographicCamera.left = -halfWidth;
        orthographicCamera.right = halfWidth;
        orthographicCamera.top = halfHeight;
        orthographicCamera.bottom = -halfHeight;
        orthographicCamera.updateProjectionMatrix();
      }

      controls.target.copy(center);
      controls.update();
    };

    // While the view is locked, orbit is disabled so the user can work
    // serenely in the fixed axis view. The component toggle reaches the
    // controls through this ref (they live in this mount-only closure).
    setViewLockRef.current = (locked: boolean) => {
      isViewLockedRef.current = locked;
      controls.enableRotate = !locked;
    };

    let isAxisSnapped = false;

    /**
     * Snaps to an axis-aligned view, the way Blender's numpad views work.
     * Keeps the current orbit target and distance, so it reframes what you
     * were already looking at instead of jumping back to the origin.
     */
    setAxisViewRef.current = (axis, sign) => {
      isAxisSnapped = true;
      isAxisViewRef.current = true;
      setIsAxisView(true);
      const target = controls.target.clone();
      const distance = activeCamera.position.distanceTo(target) || 5;
      const direction = new THREE.Vector3(
        axis === "x" ? sign : 0,
        axis === "y" ? sign : 0,
        axis === "z" ? sign : 0,
      );
      const upVector = new THREE.Vector3(0, axis === "y" ? 0 : 1, axis === "y" ? -sign : 0);

      perspectiveCamera.up.copy(upVector);
      perspectiveCamera.position.copy(target).addScaledVector(direction, distance);
      perspectiveCamera.lookAt(target);

      orthographicCamera.up.copy(upVector);
      orthographicCamera.position.copy(target).addScaledVector(direction, distance);
      orthographicCamera.lookAt(target);

      setIsOrthographic(true);
      controls.update();
    };

    setIsIsometricElevationRef.current = () => {
      isAxisSnapped = false;
      isAxisViewRef.current = false;
      setIsAxisView(false);
      const target = controls.target.clone();
      const distance = 35;
      const direction = new THREE.Vector3(1, 1, 1).normalize();
      const upVector = new THREE.Vector3(0, 1, 0);

      perspectiveCamera.up.copy(upVector);
      perspectiveCamera.position.copy(target).addScaledVector(direction, distance);
      perspectiveCamera.lookAt(target);

      orthographicCamera.up.copy(upVector);
      orthographicCamera.position.copy(target).addScaledVector(direction, distance);
      orthographicCamera.lookAt(target);

      setIsOrthographic(true);
      controls.enableRotate = true;
      controls.update();
    };

    function emitCameraPose() {
      onCameraChangeRef.current?.({
        position: [activeCamera.position.x, activeCamera.position.y, activeCamera.position.z],
        quaternion: [activeCamera.quaternion.x, activeCamera.quaternion.y, activeCamera.quaternion.z, activeCamera.quaternion.w],
      });
      if (lockCameraToViewRef.current) {
        snapSelectedCameraToEditorRef.current?.();
      }
    }

    const handleOrbitStart = () => {
      // While locked, orbit can't even start (enableRotate is off) and pan/
      // zoom don't break the axis alignment — so they must not exit the
      // fixed view either. Only an unlocked orbit returns to perspective.
      if (isViewLockedRef.current) return;
      if (isAxisSnapped) {
        isAxisSnapped = false;
        isAxisViewRef.current = false;
        setIsAxisView(false);
        setIsOrthographic(false);
      }
    };

    if (!outputMode) {
      controls.addEventListener("start", handleOrbitStart);
      controls.addEventListener("change", emitCameraPose);
      emitCameraPose();
    }

    const gizmo = outputMode ? null : createGizmoScene();

    const raycaster = outputMode ? null : new THREE.Raycaster();
    const transformControls = outputMode ? null : new TransformControls(activeCamera, renderer.domElement);
    transformControls?.setColors(GIZMO_X_COLOR, GIZMO_Y_COLOR, GIZMO_Z_COLOR, GIZMO_ACTIVE_COLOR);
    // Scale: the centre handle grows with any movement (Shift shrinks), and
    // Shift on an axis handle scales all three — see gizmoScale.ts.
    if (transformControls) {
      installScaleGizmoTweaks(
        transformControls,
        () => {
          const rect = renderer.domElement.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        },
        () => snapEnabled,
      );
    }
    let attachedObjectNodeId: string | null = null;
    let attachedGizmoTarget: GizmoTarget | null = null;

    // Curve control-point editing. `selectedPointIndices` holds the active
    // selection of control points (single or multiple via marquee/shift).
    // The gizmo belongs to the selected object when empty, and attaches to
    // the picked handle or multi-point centroid when non-empty.
    const curveHandles = createCurvePointHandles();
    let curvePointsNodeId: string | null = null;
    /** Params of the param-handle node as the current handle drag began (NodeDefinition.paramHandles). */
    let paramHandleDragStart: Record<string, unknown> | null = null;
    let selectedPointIndices = new Set<number>();
    let lastSkeletonSelection = "";
    let isMarqueeDragging = false;
    let marqueeStartPos: { x: number; y: number } | null = null;

    let dragStartCentroidPos = new THREE.Vector3();
    let dragStartCentroidQuat = new THREE.Quaternion();
    let dragStartCentroidScale = new THREE.Vector3(1, 1, 1);
    let dragStartPointPositions = new Map<number, THREE.Vector3>();

    // Points Selection editing — click/marquee-select a subset of a live
    // Points list (e.g. from Mesh to Points) in the viewport, no dragging:
    // this only ever writes `selectedIndices` back onto the selected Points
    // Selection node, immediately on click/marquee-release (curve points
    // write back on gizmo-release instead, since those actually move).
    // Parallel to, and mutually exclusive with, curve editing above — the
    // two share the marquee overlay and the click/drag-distance heuristic
    // but never both have handles active at once (only one node can be
    // selected in the graph at a time).
    //
    // Point *cloud* handles, not curve handles: these track a mesh's whole
    // vertex buffer, which is a scale curve handles' one-Mesh-per-point
    // design cannot survive (see pointCloudHandles.ts).
    const pointsSelectionHandles = createPointCloudHandles();
    // The selected Skin node's joints: dots to click, one at a time, to edit how that joint pulls on the mesh.
    const skinJointHandles = createPointCloudHandles();
    // Rigs drawn in front of the scene right now (see setInFront).
    const rigsInFront = new Set<string>();
    let pointsSelectionNodeId: string | null = null;
    let selectedPointsSelectionIndices = new Set<number>();
    /** Bumped on every change to selectedPointsSelectionIndices (each is followed by commitPointsSelection): the cloud resyncs only then. */
    let pointsSelectionRevision = 0;
    /** What the cloud was last synced from — unchanged points, matrix and revision skip the per-point resync. */
    let pointsSelectionSynced: { points: unknown[] | null; matrix: THREE.Matrix4; revision: number } = {
      points: null,
      matrix: new THREE.Matrix4(),
      revision: -1,
    };

    // Face Selection editing — Shift+left-click selects the face under the
    // cursor on the mesh feeding the selected Face Selection node, Shift+right
    // deselects it; the selected faces are drawn green by faceSelectionHandles.
    // The picked indices live in the node's `selectedFaces` param (same
    // save/undo-friendly convention as Points Selection's `selectedIndices`).
    const faceSelectionHandles = createFaceSelectionHandles();
    let faceSelectionNodeId: string | null = null;
    let faceSelectionSourceNodeId: string | null = null;
    let selectedFacesSet = new Set<number>();
    /**
     * Whether the node is in interactive mode, tracked locally as well as in
     * the param so the first click switches the highlight over immediately —
     * the param only comes back a frame later, through React.
     */
    let faceSelectionInteractive = false;
    /**
     * The `selectedFaces` param as this viewport last saw it. Re-seeding the
     * working set whenever the param differs is what lets an undo (or the
     * operator clearing the field) actually take effect: without it the stale
     * local set would silently re-commit itself on the very next click.
     */
    let lastCommittedFaceKey = "";

    // Edit Mesh editing — box modeling tools (extrude, inset, loop cut)
    // with pure quad wireframe and centroid-anchored gizmo
    const editMeshHandles = createEditMeshHandles();
    // X-ray's look: the edited mesh drawn see-through (and writing no depth,
    // so the cage's hidden edges show through it) — in this viewport's own
    // render only, swapped in and back out around it. See xrayMesh in tick().
    const editMeshXrayMaterial = new THREE.MeshStandardMaterial({
      color: 0xcbd5e1,
      roughness: 0.6,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const editMeshCentroidProxy = new THREE.Object3D();
    editMeshCentroidProxy.userData.isEditMeshCentroidProxy = true;

    // Edit Mesh: selection gestures, modal tools, operations and gizmo
    // drags live in their own controller (editMesh/controller.ts); the
    // viewport routes its events there.
    const editCtl = createEditMeshController({
      outputMode,
      renderer,
      camera,
      raycaster,
      editMeshHandles,
      graphRef,
      selectedNodeIdRef,
      latestResultsRef,
      onParamChangeRef,
      onTransformChangeRef,
      onTransformStartRef,
      transformModeRef,
      editSnapRef,
      editPivotRef,
      editMeshPreviewLoopRef,
      editMeshCommandsRef,
      setEditMeshTool,
      setEditModalHud,
      isSnapEnabled: () => snapEnabled,
      dragStartCentroidPos,
      dragStartCentroidQuat,
      dragStartCentroidScale,
    });
    const {
      editMeshTarget,
      commitEditSelection,
      applyEditPick,
      canvasPoint,
      pickEditElement,
      pickEditLoop,
      pickEditRegion,
      pickEditBrush,
      startEditModal,
      updateEditModal,
      cancelEditModal,
      clickEditModal,
      wheelEditModal,
      editModalKey,
      runEditOp,
      duplicateAndMove,
      extrudeAndMove,
      startBevel,
      applyEditMeshDrag,
    } = editCtl;


    // Points Influence paints a map on its mesh (isTexturePaintNode); the
    // viewport only swaps in a heatmap to show it, for its own render.
    const influenceHeatmapMaterial = createInfluenceHeatmapMaterial();
    /**
     * Stands in for the influence mesh when that mesh is not itself in the
     * scene — the usual case, since what is drawn is a downstream node's
     * output (Spring Vector's sprung copy, say), not Points Influence's
     * passthrough. Shares its geometry, placed at its world transform.
     */
    const influenceOverlay = new THREE.Mesh(new THREE.BufferGeometry(), influenceHeatmapMaterial);
    influenceOverlay.matrixAutoUpdate = false;

    // A Pivot Transform node's `pivot` isn't a pose you can drag through the
    // usual translate/rotate/scale gizmo math (see gizmoWriteback.ts): with
    // rotation/scale/location all neutral, the pivot cancels out of its own
    // matrix entirely (translate(pivot) * identity * translate(-pivot) =
    // identity) — dragging the object it feeds wouldn't move anything on
    // screen no matter what pivot was written. It needs its own visible,
    // independently-draggable point, so it reuses the exact same
    // single-marker machinery curve control points use, just for one point
    // instead of a polyline (see the sync() call for it below).
    const pivotHandle = createCurvePointHandles();
    let pivotHandleNodeId: string | null = null;

    // Visual Slice's plane isn't a mesh's pose — it has no location/
    // rotation/scale of its own for resolveGizmoTarget's "native" case to
    // find (its own `geometry` output is just the upstream mesh passed
    // through untouched, clipped). It gets the same "own draggable proxy,
    // not the normal gizmo" treatment as Pivot Transform's pivot marker
    // above, except this one needs full translate *and* rotate (a plane is
    // a point plus a normal direction), so it rides the real
    // TransformControls via the pickedCurveHandle path below rather than
    // pivotHandle's position-only marker. A translucent quad, rather than
    // pivotHandle's bare point, so the plane's current orientation is
    // visible before you start dragging it.
    const SLICE_NORMAL_AXIS = new THREE.Vector3(0, 1, 0); // matches DEFAULT_NORMAL in visualSlice.ts
    const sliceProxy = new THREE.Object3D();
    const sliceVisualGeometry = new THREE.PlaneGeometry(3, 3);
    const sliceVisual = new THREE.Mesh(
      sliceVisualGeometry,
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
    );
    // PlaneGeometry faces +Z by default; rotate so the *unrotated* proxy
    // faces +Y, matching DEFAULT_NORMAL — then sliceProxy.quaternion alone
    // (set from SLICE_NORMAL_AXIS -> the plane's actual normal below) is the
    // complete story of the visual's orientation.
    sliceVisual.rotation.x = -Math.PI / 2;
    const sliceVisualEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(sliceVisualGeometry),
      new THREE.LineBasicMaterial({ color: 0x38bdf8 }),
    );
    sliceVisualEdges.rotation.copy(sliceVisual.rotation);
    sliceProxy.add(sliceVisual, sliceVisualEdges);
    sliceProxy.visible = false;
    let sliceProxyNodeId: string | null = null;

    // Clip Box's proxy — the same story as sliceProxy, one dimension up. The
    // cut is a whole oriented volume rather than a plane, so this one also
    // takes the gizmo's *scale* mode (writing the node's Box Size), and it
    // draws as a wireframe: six translucent faces stacked in depth read as
    // fog, while the edges show exactly where the volume starts and stops.
    const clipBoxProxy = new THREE.Object3D();
    const clipBoxGeometry = new THREE.BoxGeometry(1, 1, 1);
    const clipBoxVisual = new THREE.Mesh(
      clipBoxGeometry,
      new THREE.MeshBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false }),
    );
    const clipBoxEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(clipBoxGeometry),
      new THREE.LineBasicMaterial({ color: 0xf59e0b }),
    );
    clipBoxProxy.add(clipBoxVisual, clipBoxEdges);
    clipBoxProxy.visible = false;
    let clipBoxProxyNodeId: string | null = null;

    // Decal's projector box — the same proxy idea again. A decal's own output
    // is world-space geometry sitting at the origin, so the normal gizmo path
    // would put the handles nowhere near the thing being aimed; this shows the
    // projector volume where it actually is and drags its params instead.
    const decalProxy = new THREE.Object3D();
    const decalProxyGeometry = new THREE.BoxGeometry(1, 1, 1);
    const decalProxyEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(decalProxyGeometry),
      new THREE.LineBasicMaterial({ color: 0x4ade80 }),
    );
    // A single filled face marks which way the projector points: the box alone
    // is symmetrical, and aiming it is the whole job.
    const decalProxyFace = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
    );
    decalProxyFace.position.z = 0.5;
    decalProxy.add(decalProxyEdges, decalProxyFace);
    decalProxy.visible = false;
    let decalProxyNodeId: string | null = null;

    // Pose proxy for nodes that own a `location` but draw nothing the gizmo
    // can grab (explosions, fluid solver) — see poseProxyNodes.ts.
    const poseProxy = new THREE.Object3D();
    // Helper colours come from the theme palette (Preferences > Themes), never fixed values: the accent colour for the marker
    // and its circles. Refreshed whenever the palette changes (see paintPoseProxy below).
    const poseProxyColor = new THREE.Color(getCurrentColors().accentColor);
    const poseProxyCoreGeo = new THREE.SphereGeometry(0.18, 16, 16);
    const poseProxyCoreMat = new THREE.MeshBasicMaterial({ color: poseProxyColor, depthWrite: false });
    // A radius is drawn as three discrete circles, one per axis plane — a skeleton of a sphere, not a surface.
    const poseCircleGeo = (() => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0));
      }
      return new THREE.BufferGeometry().setFromPoints(pts);
    })();
    const makePoseRings = (opacity: number) => {
      const material = new THREE.LineBasicMaterial({ color: poseProxyColor, transparent: true, opacity, depthWrite: false });
      const group = new THREE.Group();
      for (const rot of [[0, 0, 0], [Math.PI / 2, 0, 0], [0, Math.PI / 2, 0]]) {
        const ring = new THREE.Line(poseCircleGeo, material);
        ring.rotation.set(rot[0], rot[1], rot[2]);
        group.add(ring);
      }
      return { group, material };
    };
    const poseOuter = makePoseRings(0.55);
    const poseInner = makePoseRings(0.95);
    const poseProxySphere = poseOuter.group;
    const poseProxySphereMat = poseOuter.material;
    const poseProxyInner = poseInner.group;
    const poseProxyInnerMat = poseInner.material;
    poseProxyInner.visible = false;
    const poseProxyBoxUnitGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    const poseProxyBox = new THREE.LineSegments(poseProxyBoxUnitGeo, new THREE.LineBasicMaterial({ color: poseProxyColor }));
    poseProxy.add(new THREE.Mesh(poseProxyCoreGeo, poseProxyCoreMat), poseProxySphere, poseProxyInner, poseProxyBox);
    poseProxy.visible = false;
    let poseProxyNodeId: string | null = null;
    let poseProxyChannels: "location" | "trs" = "location";
    let poseProxyLocationParam = "location";
    // Scale mode on a sound: the radii as they were when the drag began, and which params they live in.
    // Params with the node type's defaults under them: a project saved before a param existed does not carry it.
    const paramsWithDefaults = (n: { type: string; params: Record<string, unknown> }): Record<string, unknown> => ({
      ...(registryRef.current.get(n.type)?.defaultParams ?? {}),
      ...n.params,
    });
    let poseProxyRadii: { outerParam: string; innerParam: string | null } | null = null;
    let poseProxyRadiiBase: { outer: number; inner: number } | null = null;

    // Speaker icons: one billboard per local sound, always visible in the editor (not in the output), so a sound can be
    // seen and clicked without selecting it first. Drawn once on a canvas.
    const soundIconGroup = new THREE.Group();
    const soundIconCanvas = document.createElement("canvas");
    soundIconCanvas.width = soundIconCanvas.height = 128;
    const soundIconTexture = new THREE.CanvasTexture(soundIconCanvas);
    soundIconTexture.colorSpace = THREE.SRGBColorSpace;
    let soundIconPaint = "";
    /** Redraws the icon in the theme's colours: the chrome pill for the disc, the accent for the speaker. */
    const paintSoundIcon = (accent: string, disc: string) => {
      const g = soundIconCanvas.getContext("2d")!;
      g.clearRect(0, 0, 128, 128);
      g.fillStyle = disc;
      g.beginPath(); g.arc(64, 64, 60, 0, Math.PI * 2); g.fill();
      g.strokeStyle = accent; g.lineWidth = 5; g.stroke();
      g.fillStyle = accent;
      g.beginPath(); g.moveTo(30, 52); g.lineTo(48, 52); g.lineTo(70, 34); g.lineTo(70, 94); g.lineTo(48, 76); g.lineTo(30, 76); g.closePath(); g.fill();
      g.strokeStyle = accent; g.lineWidth = 6; g.lineCap = "round";
      for (const r of [14, 26]) { g.beginPath(); g.arc(70, 64, r, -0.9, 0.9); g.stroke(); }
      soundIconTexture.needsUpdate = true;
    };
    /** Follows the palette: called every frame, repaints only when the accent or the pill colour changed. */
    let paintTick = 0;
    const paintPoseProxy = () => {
      // The palette lives in localStorage; look at it twice a second, not every frame.
      if (soundIconPaint !== "" && paintTick++ % 30 !== 0) return;
      const colors = getCurrentColors();
      const key = `${colors.accentColor}|${colors.chromePillBg}`;
      if (key === soundIconPaint) return;
      soundIconPaint = key;
      poseProxyColor.set(colors.accentColor);
      poseProxyCoreMat.color.copy(poseProxyColor);
      poseProxySphereMat.color.copy(poseProxyColor);
      poseProxyInnerMat.color.copy(poseProxyColor);
      (poseProxyBox.material as THREE.LineBasicMaterial).color.copy(poseProxyColor);
      paintSoundIcon(colors.accentColor, colors.chromePillBg);
    };
    paintPoseProxy();
    const soundIcons = new Map<string, THREE.Sprite>();

    // Force Field 3D proxy: shows interactive position & direction helper for
    // particles/force-field — same structure as the Particle Emitter proxy
    // (core + one ring + arrow) so the editor's helper markers read as one
    // visual family.
    const forceFieldProxy = new THREE.Object3D();
    const forceFieldCoreGeo = new THREE.SphereGeometry(0.18, 16, 16);
    const forceFieldCoreMat = new THREE.MeshBasicMaterial({ color: 0xec4899, depthWrite: false });
    const forceFieldCore = new THREE.Mesh(forceFieldCoreGeo, forceFieldCoreMat);
    const forceFieldRingGeo = new THREE.RingGeometry(0.35, 0.4, 32);
    const forceFieldRingMat = new THREE.MeshBasicMaterial({ color: 0xec4899, side: THREE.DoubleSide, depthWrite: false });
    const forceFieldRing = new THREE.Mesh(forceFieldRingGeo, forceFieldRingMat);
    forceFieldRing.rotation.x = Math.PI / 2;
    const forceFieldArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), 1.0, 0xec4899, 0.25, 0.12);
    forceFieldProxy.add(forceFieldCore, forceFieldRing, forceFieldArrow);
    forceFieldProxy.visible = false;
    let forceFieldProxyNodeId: string | null = null;

    // Particle Emitter proxy: translate moves position, rotate directs velocity
    const emitterProxy = new THREE.Object3D();
    const emitterCoreGeo = new THREE.SphereGeometry(0.18, 16, 16);
    const emitterCoreMat = new THREE.MeshBasicMaterial({ color: 0x06b6d4, depthWrite: false });
    const emitterCore = new THREE.Mesh(emitterCoreGeo, emitterCoreMat);
    const emitterRingGeo = new THREE.RingGeometry(0.35, 0.4, 32);
    const emitterRingMat = new THREE.MeshBasicMaterial({ color: 0x06b6d4, side: THREE.DoubleSide, depthWrite: false });
    const emitterRing = new THREE.Mesh(emitterRingGeo, emitterRingMat);
    emitterRing.rotation.x = Math.PI / 2;
    const emitterArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), 1.0, 0x06b6d4, 0.25, 0.12);
    emitterProxy.add(emitterCore, emitterRing, emitterArrow);
    emitterProxy.visible = false;
    let emitterProxyNodeId: string | null = null;
    let emitterVelocityLength = 1;

    // Pivot proxy for native objects: anchors TransformControls directly on the pivot point
    const gizmoPivotProxy = new THREE.Object3D();
    gizmoPivotProxy.visible = false;
    let gizmoPivotProxyNodeId: string | null = null;
    let gizmoPivotProxyRealObject: THREE.Object3D | null = null;

    // Yellow Pivot Cross Helper: displayed above geometry (depthTest: false) for objects with showPivot === true
    const pivotCrossGroup = new THREE.Group();
    const PIVOT_CROSS_SIZE = 0.35;
    const pivotCrossPositions = new Float32Array([
      -PIVOT_CROSS_SIZE, 0, 0,  PIVOT_CROSS_SIZE, 0, 0,
      0, -PIVOT_CROSS_SIZE, 0,  0, PIVOT_CROSS_SIZE, 0,
      0, 0, -PIVOT_CROSS_SIZE,  0, 0, PIVOT_CROSS_SIZE,
    ]);
    const pivotCrossGeo = new THREE.BufferGeometry();
    pivotCrossGeo.setAttribute("position", new THREE.BufferAttribute(pivotCrossPositions, 3));
    const pivotCrossMat = new THREE.LineBasicMaterial({
      color: 0xffe600,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    const pivotCrossPool: THREE.LineSegments[] = [];
    const terrainBrushGizmo = createTerrainBrushGizmo();
    const sculptBrushGizmo = createTerrainBrushGizmo();
    // A Skin node's weight brush: the same ring, amber, and the stroke under way.
    const weightBrushGizmo = createTerrainBrushGizmo();
    (weightBrushGizmo.material as THREE.LineBasicMaterial).color.set(0xf59e0b);
    let weightPainting: { nodeId: string; last: THREE.Vector3 | null } | null = null;
    /** Points Influence's Shift-drag gradient: where the line started, in canvas pixels. */
    let influenceGradient: { nodeId: string; start: { x: number; y: number } } | null = null;
    const textureBrushGizmo = createTextureBrushGizmo();
    textureBrushGizmoRef.current = textureBrushGizmo;

    if (!outputMode) {
      editorUiScene.add(curveHandles.group);
      editorUiScene.add(pointsSelectionHandles.group);
      editorUiScene.add(skinJointHandles.group);
      editorUiScene.add(pivotHandle.group);
      editorUiScene.add(sliceProxy);
      editorUiScene.add(clipBoxProxy);
      editorUiScene.add(decalProxy);
      editorUiScene.add(poseProxy);
      editorUiScene.add(soundIconGroup);
      editorUiScene.add(forceFieldProxy);
      editorUiScene.add(emitterProxy);
      editorUiScene.add(gizmoPivotProxy);
      editorUiScene.add(pivotCrossGroup);
      editorUiScene.add(terrainBrushGizmo);
      editorUiScene.add(sculptBrushGizmo);
      editorUiScene.add(weightBrushGizmo);
      editorUiScene.add(textureBrushGizmo);
      // The face-selection highlight lives in the *main* scene (not the
      // editor overlay, which clears depth and would show every selected face
      // through the object) so it is occluded like the surface it sits on.
      // Empty when no Face Selection node is selected, so it never renders.
      scene.add(faceSelectionHandles.group);
      scene.add(editMeshHandles.group);
      editorUiScene.add(editMeshCentroidProxy);
    }
    // Refreshed every tick() — the 'objectChange' listener needs the
    // *current* base matrix for an "offset" target (see below), and this is
    // the cheapest way to get it without re-running evaluateGraph itself.
    let latestResults: EvalResult | null = null;
    // Tracks whether the postprocess chain was active last frame. When it goes
    // inactive we release the chain once; repeating that every idle frame would
    // destroy and re-compile all the cached passes on the next activation
    // (their render targets and shaders are expensive to rebuild).
    let postChainWasActive = false;

    // Hold Shift to snap the gizmo to fixed increments — 1 unit for move,
    // 15° for rotate. On scale Shift has other jobs (it shrinks with the
    // centre handle and scales all three axes from an axis handle, see
    // gizmoScale.ts), so scale snaps with Ctrl / Cmd instead: whole steps on
    // an object, tenths in Edit Mesh. Three's TransformControls has no
    // built-in modifier-key toggle; it just reads translationSnap/
    // rotationSnap/scaleSnap fresh on every pointermove (see its own source),
    // so setting them live on keydown/keyup is enough to make snapping track
    // the key in real time, including toggling mid-drag.
    const TRANSLATION_SNAP = 1;
    const ROTATION_SNAP = THREE.MathUtils.degToRad(15);
    const SCALE_SNAP = 1;
    const EDIT_SCALE_SNAP = 0.1;

    // translationSnap is deliberately NEVER set on transformControls itself —
    // its world-space snap path calls object.getWorldPosition(), which goes
    // through updateWorldMatrix(). Every graph-driven mesh has
    // matrixAutoUpdate = false (see object.ts), which makes updateWorldMatrix
    // skip recomputing .matrix from the position TransformControls just set —
    // so it read back the *previous* frame's stale world position every time,
    // snapped that unchanging value, and wrote it straight back: the object
    // never appeared to move at all while translating with snap on. rotate's
    // snap (an internal angle accumulator) and scale's snap (mode='scale'
    // forces local space, a plain .scale round with no matrixWorld involved)
    // don't touch matrixWorld and so don't hit this — hence only translate
    // needed a workaround. Snapping translation ourselves, in objectChange
    // below, right before we call object.updateMatrix(), sidesteps the whole
    // stale-matrixWorld path: we round the position TransformControls *did*
    // just set correctly, not a stale re-derived one.
    let snapEnabled = false;
    let scaleSnapEnabled = false;

    function setSnapEnabled(enabled: boolean) {
      snapEnabled = enabled;
      if (!transformControls) return;
      transformControls.rotationSnap = enabled ? ROTATION_SNAP : null;
    }

    /** The scale step for whatever the gizmo holds: Ctrl / Cmd, or Edit Mesh's Step snap. */
    function currentScaleSnap(): number | null {
      if (transformControls?.object === editMeshCentroidProxy) {
        return scaleSnapEnabled || editSnapRef.current === "increment" ? EDIT_SCALE_SNAP : null;
      }
      return scaleSnapEnabled ? SCALE_SNAP : null;
    }

    function setScaleSnapEnabled(enabled: boolean) {
      scaleSnapEnabled = enabled;
      if (transformControls) transformControls.scaleSnap = currentScaleSnap();
    }

    function isInputElement(el: Element | null): boolean {
      if (!el) return false;
      const tagName = el.tagName.toLowerCase();
      return tagName === "input" || tagName === "textarea" || (el as HTMLElement).isContentEditable;
    }

    /** A Skeleton palette operation (or its A / D key) on the joints picked now. One result, one undo step. */
    function runSkeletonOp(op: SkeletonOp): boolean {
      const node = graphRef.current.nodes.find((n) => n.id === curvePointsNodeId);
      if (!node || node.type !== SKELETON_NODE_TYPE || !onTransformChangeRef.current) return false;
      const result = skeletonOp(op, node.params, Array.from(selectedPointIndices));
      if (!result) return false;
      if (result.params) {
        // One discrete edit, one undo step (a drag records its own on start).
        onTransformStartRef.current?.();
        onTransformChangeRef.current(node.id, result.params);
      }
      selectedPointIndices = new Set(result.selection);
      return true;
    }
    skeletonCommandsRef.current = { run: runSkeletonOp };

    /**
     * Add or remove a control point on the curve whose handles are showing —
     * the only way to change how many points a curve has, since `pointsList`
     * has no param-panel field of its own. A no-op unless a handle is
     * actually picked, so A and D stay free for everything else.
     */
    /** The axes a picked param handle may move along, or null for any other gizmo target. */
    function paramHandleAxesFor(object: THREE.Object3D): ("x" | "y" | "z")[] | null {
      if (!object.userData?.isCurvePointHandle || !curvePointsNodeId) return null;
      const node = graphRef.current.nodes.find((n) => n.id === curvePointsNodeId);
      const def = node ? registryRef.current.get(node.type) : undefined;
      if (!def?.paramHandles) return null;
      return def.paramHandleAxes && node ? def.paramHandleAxes(object.userData.pointIndex as number, node.params) : ["x", "y", "z"];
    }

    function paramHandleRotatesFor(object: THREE.Object3D): boolean {
      const node = graphRef.current.nodes.find((n) => n.id === curvePointsNodeId);
      const rotates = node ? registryRef.current.get(node.type)?.paramHandleRotates : undefined;
      return Boolean(rotates?.(object.userData.pointIndex as number));
    }

    function editPickedCurvePoint(operation: "insert" | "remove"): boolean {
      if (selectedPointIndices.size === 0 || !curvePointsNodeId) return false;
      const node = graphRef.current.nodes.find((n) => n.id === curvePointsNodeId);
      if (!node || !onTransformChangeRef.current) return false;
      // A skeleton keeps parents with its joints: A adds a child, D deletes.
      if (node.type === SKELETON_NODE_TYPE) return runSkeletonOp(operation === "insert" ? "add" : "delete");
      // Fixed topology: every pointsList entry has to keep lining up with the
      // source mesh's own vertex index for writePointsToMesh's write-back to
      // mean anything — unlike a curve, there is no legal insert/remove here.
      if (node.type === EDIT_MESH_POINTS_NODE.type || isIkControlNode(node) || hasParamHandles(node)) return false;

      const index = Array.from(selectedPointIndices)[0];
      const nextPoints =
        operation === "insert"
          ? insertCurvePointAfter(node.params.pointsList, index)
          : removeCurvePoint(node.params.pointsList, index);
      // Null means the edit isn't legal — removing the last two points, say.
      if (!nextPoints) return false;

      // One discrete edit, one undo step (a drag records its own on start).
      onTransformStartRef.current?.();
      onTransformChangeRef.current(node.id, { pointsList: nextPoints });
      // Keep a point selected either way: the one just inserted, or the
      // neighbour that took the removed one's place.
      const newIdx = operation === "insert" ? index + 1 : Math.min(index, nextPoints.length - 1);
      selectedPointIndices = new Set([newIdx]);
      return true;
    }

    /**
     * The viewport's keys, heard first (capture phase). While editing a mesh
     * — an Edit Mesh node selected, or one of its tools running — a key the
     * viewport acted on stops there: every panel listens on window, and the
     * graph editor would otherwise *also* delete the Edit Mesh node on Delete
     * or duplicate it on Cmd+D, and the timeline drop a marker on M.
     */
    function onViewportKeyDownCaptured(e: KeyboardEvent) {
      const editing = editCtl.modalNodeId !== null || (keyboardViewport() === keyboardToken && editMeshTarget() !== null);
      onViewportKeyDown(e);
      if (editing && e.defaultPrevented) e.stopImmediatePropagation();
    }

    function onViewportKeyDown(e: KeyboardEvent) {
      if (isInputElement(document.activeElement)) return;
      if (keyboardViewport() !== keyboardToken) return;
      // A running Edit Mesh tool owns the keyboard until it's confirmed or cancelled.
      if (editModalKey(e, layoutKey(e))) return;
      // A running scene owns the keys its Keyboard nodes listen for: S must
      // walk the character rather than arm the scale gizmo behind it.
      if (isKeyReservedForPlayback(e)) return;

      // Blender-style shortcut: Ctrl+Alt+0 (or Cmd+Alt+0) to Align Active Camera to View
      if ((e.ctrlKey || e.metaKey) && e.altKey && (e.code === "Numpad0" || e.code === "Digit0" || e.key === "0")) {
        e.preventDefault();
        snapSelectedCameraToEditorRef.current?.();
        return;
      }

      const key = layoutKey(e);

      // Edit Mesh shortcut: Ctrl+R (or Cmd+R) for Loop Cut
      if ((e.ctrlKey || e.metaKey) && !e.altKey && key === "r") {
        const activeEditMeshNode = selectedNodeIdRef.current
          ? findEditMeshNode(graphRef.current, selectedNodeIdRef.current, false)
          : null;
        if (activeEditMeshNode) {
          e.preventDefault();
          setEditMeshTool((t) => (t === "loopcut" ? "select" : "loopcut"));
          return;
        }
      }

      // X-ray toggle (Blender's Alt+Z): pick through the surface
      if (e.altKey && !e.ctrlKey && !e.metaKey && key === "z") {
        const activeEditMeshNode = selectedNodeIdRef.current
          ? findEditMeshNode(graphRef.current, selectedNodeIdRef.current, true)
          : null;
        if (activeEditMeshNode) {
          e.preventDefault();
          onParamChangeRef.current?.("xray", activeEditMeshNode.params.xray !== true, activeEditMeshNode.id);
          return;
        }
        const activePointsSelNode = graphRef.current.nodes.find(
          (n) => n.id === selectedNodeIdRef.current && n.type === POINTS_SELECTION_NODE.type,
        );
        if (activePointsSelNode) {
          e.preventDefault();
          onParamChangeRef.current?.("xray", activePointsSelNode.params.xray !== true, activePointsSelNode.id);
          return;
        }
      }

      // Escape leaves Loop Cut before it touches the selection: the gizmo is
      // withheld for as long as that tool is armed, so treating Escape as
      // "deselect" there emptied the selection and left the tool armed —
      // every selection made afterwards then showed no gizmo at all.
      if (key === "escape" && editMeshToolRef.current !== "select") {
        e.preventDefault();
        e.stopPropagation();
        editMeshPreviewLoopRef.current = null;
        editMeshHoverEdgeRef.current = null;
        setEditMeshTool("select");
        return;
      }

      // Edit Mesh selection keys (Blender's):
      //   A select all · Alt+A / Cmd/Ctrl+D / Escape deselect all
      //   L select linked under the cursor · Shift+L deselect linked
      //   Cmd/Ctrl+L select everything linked to the selection
      //   Cmd/Ctrl+= grow · Cmd/Ctrl+- shrink
      const target = editMeshTarget();
      if (target) {
        const mod = e.ctrlKey || e.metaKey;
        let next: MeshSelection | null = null;
        if (key === "a" && !mod && !e.altKey) {
          next = selectAll(target.quadMesh, target.mode, target.selection);
        } else if ((e.altKey && (key === "a" || key === "q")) || (mod && key === "d")) {
          next = emptySelection();
        } else if (key === "escape") {
          const hasSelection = selectionVertices(target.quadMesh, target.mode, target.selection).size > 0;
          if (hasSelection) {
            e.stopPropagation();
            next = emptySelection();
          }
        } else if (key === "l" && mod && !e.altKey) {
          next = linkedSelection(target.quadMesh, target.mode, target.selection);
        } else if (key === "l" && !mod && !e.altKey && editCtl.pointer) {
          const picked = pickEditElement(target, editCtl.pointer.clientX, editCtl.pointer.clientY);
          if (picked) {
            const linked = linkedSelection(target.quadMesh, target.mode, picked);
            next = combineSelection(target.mode, target.selection, linked, e.shiftKey ? "remove" : "add");
          }
        } else if (mod && !e.altKey && (e.key === "=" || e.key === "+")) {
          next = growSelection(target.quadMesh, target.mode, target.selection);
        } else if (mod && !e.altKey && (e.key === "-" || e.key === "_")) {
          next = shrinkSelection(target.quadMesh, target.mode, target.selection);
        }
        if (next) {
          e.preventDefault();
          commitEditSelection(target, next);
          return;
        }

        // Modelling tools (Blender's keys). The modal ones start from the
        // pointer's position over the canvas, or its centre.
        const rect = renderer.domElement.getBoundingClientRect();
        const px = editCtl.pointer?.clientX ?? rect.left + rect.width / 2;
        const py = editCtl.pointer?.clientY ?? rect.top + rect.height / 2;
        const hasFaces = target.mode === "faces" && target.selection.faces.length > 0;
        let handled = false;
        if (key === "e" && !mod && !e.shiftKey && hasFaces) {
          handled = startEditModal("extrude", target, px, py, { individual: e.altKey });
        } else if (key === "e" && !mod && !e.shiftKey && !e.altKey && target.mode !== "faces") {
          handled = extrudeAndMove(target, px, py);
        } else if (key === "i" && !mod && !e.altKey && !e.shiftKey && hasFaces) {
          handled = startEditModal("inset", target, px, py);
        } else if (key === "d" && e.shiftKey && !mod && !e.altKey) {
          handled = duplicateAndMove(target, px, py);
        } else if (key === "b" && mod && !e.altKey && !e.shiftKey) {
          handled = startBevel(target, px, py);
        } else if (key === "k" && !mod && !e.altKey && !e.shiftKey) {
          handled = startEditModal("knife", target, px, py);
        } else if (key === "m" && !mod && !e.altKey && !e.shiftKey) {
          handled = runEditOp(target, "merge");
        } else if (key === "x" && mod && !e.altKey) {
          handled = runEditOp(target, "dissolve");
        } else if (key === "f" && !mod && !e.altKey && !e.shiftKey && target.mode !== "faces") {
          handled = runEditOp(target, "fill");
        } else if ((key === "delete" || key === "backspace") && !mod && !e.altKey) {
          handled = runEditOp(target, "delete");
        }
        if (handled) {
          e.preventDefault();
          return;
        }
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Curve control point editing — checked before the gizmo/camera keys so
      // they only take over while a point is picked.
      if (key === "a" && editPickedCurvePoint("insert")) {
        e.preventDefault();
        return;
      }
      if (key === "d" && editPickedCurvePoint("remove")) {
        e.preventDefault();
        return;
      }

      // Everything below is a bare single-key shortcut. With a modifier held
      // it's someone else's chord (Cmd+S is Save, not Scale; Option+E on a
      // Mac is not Extrude), so it stops here.
      if (e.altKey || e.ctrlKey || e.metaKey) return;

      // Edit Mesh keyboard shortcuts
      const activeEditMeshNode = selectedNodeIdRef.current
        ? findEditMeshNode(graphRef.current, selectedNodeIdRef.current, false)
        : null;
      if (activeEditMeshNode) {
        // E / I / Delete are handled with the selection keys above, as modal
        // tools and one-shot operations.
        if (key === "o") {
          e.preventDefault();
          onParamChangeRef.current?.(
            "proportionalEditing",
            !activeEditMeshNode.params.proportionalEditing,
            activeEditMeshNode.id,
          );
          return;
        } else if (key === "p" && activeEditMeshNode.params.selectMode === "faces") {
          const faces = Array.isArray(activeEditMeshNode.params.selectedFaces) ? (activeEditMeshNode.params.selectedFaces as number[]) : [];
          if (faces.length > 0) {
            e.preventDefault();
            onParamActionRef.current?.(activeEditMeshNode.id, EDIT_MESH_SEPARATE_FACES_ACTION);
            return;
          }
        }
      }

      // Gizmo mode shortcuts: G / W (translate), R (rotate), S (scale)
      if (key === "g" || key === "w") {
        e.preventDefault();
        setTransformMode("translate");
        if (transformControls) transformControls.setMode("translate");
      } else if (key === "r") {
        e.preventDefault();
        setTransformMode("rotate");
        if (transformControls) transformControls.setMode("rotate");
      } else if (key === "s") {
        e.preventDefault();
        setTransformMode("scale");
        if (transformControls) transformControls.setMode("scale");
      }
      // Camera axis snapping shortcuts: X (Right), Y (Top), Z (Front)
      else if (key === "x") {
        e.preventDefault();
        setAxisViewRef.current?.("x", 1);
      } else if (key === "y") {
        e.preventDefault();
        setAxisViewRef.current?.("y", 1);
      } else if (key === "z") {
        e.preventDefault();
        setAxisViewRef.current?.("z", 1);
      } else if (key === "l" && isAxisViewRef.current) {
        // Lock the fixed axis view (toggle) — only meaningful in an X/Y/Z view.
        e.preventDefault();
        toggleViewLock();
      }

      // Grease Pencil tool gestures: finish a polyline, drop a lasso
      // selection, delete the selected strokes.
      const gpKeyNode = selectedNodeIdRef.current
        ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && isPaintOrGreaseNode(n))
        : null;
      if (gpKeyNode) {
        const targetFrame = currentFrameRef.current >= 0 ? currentFrameRef.current : 0;

        if (gpToolRef.current === "polyline" && gpPolylineVerticesRef.current.length >= 2) {
          if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            // Enter closes the shape, Escape leaves it open.
            gpFinishPolylineRef.current?.(e.key === "Enter");
            return;
          }
        }

        if (gpSelectedStrokeIdsRef.current.size > 0) {
          if (e.key === "Escape") {
            e.preventDefault();
            gpSelectedStrokeIdsRef.current = new Set();
            setGpSelectionOverlay([]);
            setGpToolHint(null);
            return;
          }
          if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            const frames = (gpKeyNode.params.frames as KeyframeDrawing[]) || [];
            const next = deleteStrokes(frames, targetFrame, gpSelectedStrokeIdsRef.current);
            if (next !== frames) onParamChangeRef.current?.("frames", next, gpKeyNode.id);
            gpSelectedStrokeIdsRef.current = new Set();
            setGpSelectionOverlay([]);
            setGpToolHint(null);
            return;
          }
        }
      }

      // Brush size: [ shrinks, ] grows. One rule for every brush in the app —
      // terrain sculpt, texture paint, texture mix and grease pencil — rather
      // than a shortcut that only works on the tool it was written for.
      const smaller = e.key === "[" || e.key === "{";
      const bigger = e.key === "]" || e.key === "}";
      if (smaller || bigger) {
        const brushNode = selectedNodeIdRef.current
          ? graphRef.current.nodes.find(
              (n) =>
                n.id === selectedNodeIdRef.current &&
                (isTerrainNode(n) ||
                  isSculptNode(n) ||
                  isTexturePaintNode(n) ||
                  isTextureMixNode(n) ||
                  isPaintOrGreaseNode(n)),
            )
          : null;
        if (brushNode) {
          e.preventDefault();
          // Terrain sizes are scene units and move in halves; sculpt sizes
          // are small scene-unit radii and move proportionally like the
          // pixel-space brushes (halves would be far too coarse at 0.02-2).
          const isTerrain = isTerrainNode(brushNode);
          const isSculpt = isSculptNode(brushNode);
          const cur = Number(brushNode.params.brushSize) || (isTerrain ? 4 : isSculpt ? 0.3 : 24);
          const next = isTerrain
            ? Math.max(0.5, Math.min(50, Math.round((cur + (bigger ? 0.5 : -0.5)) * 2) / 2))
            : isSculpt
            ? Math.max(0.02, Math.min(2, bigger ? cur * 1.15 : cur / 1.15))
            : Math.max(1, Math.min(512, Math.round(bigger ? cur * 1.15 + 1 : cur / 1.15 - 1)));
          onParamChangeRef.current?.("brushSize", next, brushNode.id);
          return;
        }
      }
    }

    function onSnapKeyDown(e: KeyboardEvent) {
      if (e.key === "Shift") setSnapEnabled(true);
      if (e.key === "Control" || e.key === "Meta") setScaleSnapEnabled(true);
    }
    function onSnapKeyUp(e: KeyboardEvent) {
      if (e.key === "Shift") setSnapEnabled(false);
      if (e.key === "Control" || e.key === "Meta") setScaleSnapEnabled(false);
    }
    // Alt-tabbing away mid-drag fires no keyup for whatever was held — without
    // this, snapping could get stuck on until the next press-and-release.
    function onSnapWindowBlur() {
      setSnapEnabled(false);
      setScaleSnapEnabled(false);
    }
    if (!outputMode) {
      window.addEventListener("keydown", onSnapKeyDown);
      window.addEventListener("keydown", onViewportKeyDownCaptured, true);
      window.addEventListener("keyup", onSnapKeyUp);
      window.addEventListener("blur", onSnapWindowBlur);
    }

    if (transformControls) {
      editorUiScene.add(transformControls.getHelper());

      // The textbook three.js idiom: disable orbit for the whole gesture the
      // instant a gizmo handle is grabbed, synchronously within the same
      // pointerdown dispatch OrbitControls itself is listening to — by the
      // time OrbitControls would act on a subsequent pointermove, `enabled`
      // is already false. tick()'s own loop (below) is what keeps it false
      // for the rest of the drag, since this only fires on state *changes*.
      transformControls.addEventListener("dragging-changed", (event) => {
        controls.enabled = !event.value;
        if (event.value) {
          onTransformStartRef.current?.();
          // A param handle works every patch out from the params the drag started on.
          const startNode = transformControls.object?.userData?.isCurvePointHandle ? graphRef.current.nodes.find((n) => n.id === curvePointsNodeId) : undefined;
          paramHandleDragStart = startNode && hasParamHandles(startNode) ? { ...startNode.params } : null;
          if (transformControls.object?.userData?.isCurveCentroidHandle) {
            const centroid = transformControls.object;
            dragStartCentroidPos.copy(centroid.position);
            dragStartCentroidQuat.copy(centroid.quaternion);
            dragStartCentroidScale.copy(centroid.scale);
            dragStartPointPositions.clear();
            const node = graphRef.current.nodes.find((n) => n.id === curvePointsNodeId);
            const rawList = Array.isArray(node?.params.pointsList) ? node!.params.pointsList : [];
            selectedPointIndices.forEach((idx) => {
              const handle = curveHandles.handleAt(idx);
              const pos = handle ? handle.position.clone() : asVector3(rawList[idx], new THREE.Vector3());
              dragStartPointPositions.set(idx, pos);
            });
          }
          if (transformControls.object?.userData?.isEditMeshCentroidProxy) {
            editCtl.beginDrag(transformControls.object);
          }
        }
        if (!event.value) {
          suppressNextClick = true;
          editCtl.endDrag();
        }
      });

      transformControls.addEventListener("objectChange", () => {
        const object = transformControls.object;
        if (!object) return;

        // Manual translation snap — see the comment by TRANSLATION_SNAP's
        // declaration for why this can't just be transformControls'
        // own translationSnap. .position here is what TransformControls'
        // translate math just set correctly this frame (a plain local
        // assignment, no matrixWorld involved) — rounding it directly, before
        // updateMatrix() below, is what makes the *displayed* mesh snap, not
        // just whatever eventually gets written back to the graph.
        // (Edit Mesh's selection proxy snaps relative to where the drag began,
        // in applyEditMeshDrag, not to this absolute grid.)
        if (snapEnabled && transformModeRef.current === "translate" && object !== editMeshCentroidProxy) {
          object.position.set(
            Math.round(object.position.x / TRANSLATION_SNAP) * TRANSLATION_SNAP,
            Math.round(object.position.y / TRANSLATION_SNAP) * TRANSLATION_SNAP,
            Math.round(object.position.z / TRANSLATION_SNAP) * TRANSLATION_SNAP,
          );
        } else if (elevationView && snapElevation && transformModeRef.current === "translate") {
          object.position.y = snapElevationValue(object.position.y, 0.5);
        }

        // object.ts sets matrixAutoUpdate = false on every graph-driven mesh
        // (so it can hold an exact matrix.copy() from the graph), which also
        // means nothing recomputes .matrix from position/quaternion/scale
        // automatically. TransformControls mutates those three directly but
        // never calls this itself — without it the drag was inert on
        // screen: the mesh only ever snapped to its new pose once dragging
        // ended and evaluateGraph's own matrix.copy() ran again next frame.
        object.updateMatrix();

        // The pivot marker drag: same "already in the right space" story as
        // a curve point (see below), just written to `pivot` on the Pivot
        // Transform node instead of a pointsList entry. Checked before the
        // generic isCurvePointHandle branch below — pivotHandle reuses the
        // same handle factory, so its one marker carries that same flag.
        if (object === pivotHandle.handleAt(0) && pivotHandleNodeId && onTransformChangeRef.current) {
          onTransformChangeRef.current(pivotHandleNodeId, { pivot: object.position.clone() });
          return;
        }

        // Visual Slice's plane proxy: translate moves `point`, rotate turns
        // `direction` (derived from the proxy's current orientation either
        // way, since only one of the two actually changed this drag).
        if (object === sliceProxy && sliceProxyNodeId && onTransformChangeRef.current) {
          const direction = SLICE_NORMAL_AXIS.clone().applyQuaternion(object.quaternion).normalize();
          onTransformChangeRef.current(sliceProxyNodeId, { point: object.position.clone(), direction });
          return;
        }

        // Clip Box's volume proxy: all three modes write back at once, since
        // only whichever one the drag actually changed differs from what the
        // params already hold. Scale is taken as an absolute — TransformControls
        // will happily drag an axis through zero into a negative, which would
        // flip the box inside out rather than shrink it.
        if (object === clipBoxProxy && clipBoxProxyNodeId && onTransformChangeRef.current) {
          const euler = new THREE.Euler().setFromQuaternion(object.quaternion);
          onTransformChangeRef.current(clipBoxProxyNodeId, {
            location: object.position.clone(),
            rotation: new THREE.Vector3(euler.x, euler.y, euler.z),
            size: new THREE.Vector3(Math.abs(object.scale.x), Math.abs(object.scale.y), Math.abs(object.scale.z)),
          });
          return;
        }

        // Decal's projector proxy: its pose *is* the projection, so all three
        // channels go back at once and the decal re-projects next evaluate.
        if (object === decalProxy && decalProxyNodeId && onTransformChangeRef.current) {
          const euler = new THREE.Euler().setFromQuaternion(object.quaternion);
          onTransformChangeRef.current(decalProxyNodeId, {
            location: object.position.clone(),
            rotation: new THREE.Vector3(euler.x, euler.y, euler.z),
            scale: new THREE.Vector3(Math.abs(object.scale.x), Math.abs(object.scale.y), Math.abs(object.scale.z)),
          });
          return;
        }

        // Pose proxy: a bare location, or the full pose for the fluid solver.
        if (object === poseProxy && poseProxyNodeId && onTransformChangeRef.current) {
          if (poseProxyChannels === "location") {
            if (poseProxyRadii && transformControls?.getMode() === "scale") {
              // Scale mode resizes the sphere: both radii grow by the same factor, from where they were when the drag began.
              if (!poseProxyRadiiBase) {
                const found = graphRef.current.nodes.find((n) => n.id === poseProxyNodeId);
                const params = found ? paramsWithDefaults(found) : {};
                poseProxyRadiiBase = {
                  outer: Number(params[poseProxyRadii.outerParam]) || 1,
                  inner: poseProxyRadii.innerParam ? Number(params[poseProxyRadii.innerParam]) || 0 : 0,
                };
              }
              const sx = object.scale.x, sy = object.scale.y, sz = object.scale.z;
              // The axis dragged the furthest from 1 decides (the centre handle moves all three together).
              const factor = [sx, sy, sz].reduce((best, v) => (Math.abs(v - 1) > Math.abs(best - 1) ? v : best), 1);
              const k = Math.max(0.01, Math.abs(factor));
              const patch: Record<string, number> = { [poseProxyRadii.outerParam]: poseProxyRadiiBase.outer * k };
              if (poseProxyRadii.innerParam) patch[poseProxyRadii.innerParam] = poseProxyRadiiBase.inner * k;
              onTransformChangeRef.current(poseProxyNodeId, patch as TransformPatch);
              return;
            }
            // A node whose point is not called `location` (a sound's `position`) gets its own key; the patch is just a param write.
            onTransformChangeRef.current(poseProxyNodeId, { [poseProxyLocationParam]: object.position.clone() } as TransformPatch);
          } else {
            const found = graphRef.current.nodes.find((n) => n.id === poseProxyNodeId);
            const turned = quaternionToRotation(object.quaternion, found ? paramsWithDefaults(found) : undefined);
            onTransformChangeRef.current(poseProxyNodeId, {
              location: object.position.clone(),
              ...turned,
              scale: new THREE.Vector3(Math.abs(object.scale.x), Math.abs(object.scale.y), Math.abs(object.scale.z)),
            });
          }
          return;
        }

        // Force Field's 3D proxy: translate moves `position`, rotate turns `axis`
        if (object === forceFieldProxy && forceFieldProxyNodeId && onTransformChangeRef.current) {
          const direction = new THREE.Vector3(0, 1, 0).applyQuaternion(object.quaternion).normalize();
          onTransformChangeRef.current(forceFieldProxyNodeId, {
            position: object.position.clone(),
            axis: direction,
          });
          return;
        }

        // Particle Emitter's 3D proxy: translate moves `position`, rotate turns `velocity`
        if (object === emitterProxy && emitterProxyNodeId && onTransformChangeRef.current) {
          const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(object.quaternion).normalize();
          const newVelocity = dir.multiplyScalar(emitterVelocityLength);
          onTransformChangeRef.current(emitterProxyNodeId, {
            position: object.position.clone(),
            velocity: newVelocity,
          });
          return;
        }

        // Native object gizmo anchored directly at the pivot point
        if (object === gizmoPivotProxy && gizmoPivotProxyNodeId && gizmoPivotProxyRealObject && onTransformChangeRef.current) {
          const node = graphRef.current.nodes.find((n) => n.id === gizmoPivotProxyNodeId);
          if (!node) return;
          const piv =
            gizmoPivotProxyRealObject.userData && gizmoPivotProxyRealObject.userData.pivot
              ? asVector3(gizmoPivotProxyRealObject.userData.pivot, new THREE.Vector3())
              : asVector3(node.params.pivot, new THREE.Vector3());
          const targetNodeId = gizmoPivotProxyNodeId;
          const deltaConn = graphRef.current.connections.find((c) => c.toNode === targetNodeId && c.toSocket === "matrix");
          const upstreamNodeId = deltaConn ? deltaConn.fromNode : null;
          const upstreamResult = upstreamNodeId ? latestResults?.get(upstreamNodeId)?.matrix : undefined;
          // A node whose pose sits on top of a parent frame the graph can't
          // show (Edit Mesh composes its own pose onto the *source geometry's*
          // world matrix, not just its `matrix` socket) publishes that frame
          // on the object itself — and it already includes whatever is wired
          // into `matrix`, so it replaces the graph-derived upstream rather
          // than multiplying with it. Without it a drag solves against the
          // identity and the mesh jumps by the source's pose.
          const publishedParent = gizmoPivotProxyRealObject.userData?.poseParent;
          const upstream =
            publishedParent instanceof THREE.Matrix4
              ? publishedParent.clone()
              : upstreamResult instanceof THREE.Matrix4
                ? upstreamResult
                : new THREE.Matrix4();
          const upstreamInv = upstream.clone().invert();

          const worldMatrix = new THREE.Matrix4().compose(gizmoPivotProxy.position, gizmoPivotProxy.quaternion, gizmoPivotProxy.scale);
          const parentMatrix = upstreamInv.clone().multiply(worldMatrix);

          const parentPos = new THREE.Vector3();
          const parentQuat = new THREE.Quaternion();
          const parentScale = new THREE.Vector3();
          parentMatrix.decompose(parentPos, parentQuat, parentScale);

          const solvedLocation = parentPos.clone().sub(piv);
          // In the node's own Rotation Mode, so a drag writes back the numbers
          // that same mode composes into this orientation.
          const nodeParams = paramsWithDefaults(node);
          const solvedTurn = quaternionToRotation(parentQuat, nodeParams);
          const solvedScale = parentScale.clone();

          const wiredSockets = new Set(
            graphRef.current.connections.filter((c) => c.toNode === targetNodeId).map((c) => c.toSocket),
          );

          const patch: TransformPatch = {};
          if (transformModeRef.current === "translate" && !wiredSockets.has("location")) {
            if (elevationView && snapElevation) {
              solvedLocation.y = snapElevationValue(solvedLocation.y, 0.5);
            }
            patch.location = solvedLocation;
          }
          if (transformModeRef.current === "rotate" && !wiredSockets.has("rotation")) {
            patch.rotation = solvedTurn.rotation;
            if (solvedTurn.rotationAngle !== undefined) patch.rotationAngle = solvedTurn.rotationAngle;
          }
          if (transformModeRef.current === "scale" && !wiredSockets.has("scale")) {
            patch.scale = solvedScale;
          }

          const loc = patch.location ?? asVector3(node.params.location, new THREE.Vector3());
          const rot = patch.rotation ?? asVector3(node.params.rotation, new THREE.Vector3());
          const scl = patch.scale ?? asVector3(node.params.scale, new THREE.Vector3(1, 1, 1));
          const localMatrix = composeNativeMatrixWithPivot(undefined, loc, rot, scl, piv, { ...nodeParams, ...patch });
          gizmoPivotProxyRealObject.matrix.multiplyMatrices(upstream, localMatrix);
          const poseOffset = gizmoPivotProxyRealObject.userData?.poseOffset;
          if (poseOffset instanceof THREE.Matrix4) gizmoPivotProxyRealObject.matrix.multiply(poseOffset);
          gizmoPivotProxyRealObject.updateMatrixWorld(true);

          if (Object.keys(patch).length > 0) {
            onTransformChangeRef.current(targetNodeId, patch);
          }
          return;
        }

        // A single curve control point drag: `object.position` is already
        // in the curve's own space (the handles' group carries the drawing
        // object's world matrix — see curveHandles.ts), which is exactly what
        // `pointsList` stores, so it goes back verbatim.
        if (object.userData?.isCurvePointHandle) {
          const pointIdx = object.userData.pointIndex as number;
          const node = graphRef.current.nodes.find((n) => n.id === curvePointsNodeId);
          if (!node || !onTransformChangeRef.current) return;
          // A param handle: the node says which params put it where it was dropped.
          const toParams = registryRef.current.get(node.type)?.paramHandles;
          if (toParams) {
            const rotation = transformControls.mode === "rotate" ? object.quaternion.clone() : undefined;
            const patch = toParams(pointIdx, object.position.clone(), paramHandleDragStart ?? node.params, node.id, rotation);
            if (patch) onTransformChangeRef.current(node.id, patch);
            return;
          }
          let rawList = Array.isArray(node.params.pointsList) ? [...node.params.pointsList] : [];
          if (rawList.length === 0 && (node.type === EDIT_MESH_POINTS_NODE.type || isIkControlNode(node))) {
            rawList = [];
            for (let i = 0; i < curveHandles.count(); i++) {
              const h = curveHandles.handleAt(i);
              rawList.push(h ? h.position.clone() : new THREE.Vector3());
            }
          }
          if (pointIdx < 0 || pointIdx >= rawList.length) return;
          // A mesh's stored points are raw vertex-buffer entries, so a corner
          // is several coincident ones — the drag has to carry all of them or
          // the mesh tears open along its seams (see applyWeldedPointMoves).
          if (node.type === EDIT_MESH_POINTS_NODE.type) {
            const welded = applyWeldedPointMoves(rawList, new Map([[pointIdx, object.position.clone()]]));
            onTransformChangeRef.current(node.id, { pointsList: welded });
            return;
          }
          // A lattice handle is drawn on the deformed cage, so where it was
          // dropped is not what `pointsList` stores — the base point that
          // lands there once the modulators run is. Storing the handle
          // position verbatim would bake the modulator in and then apply it
          // a second time on the next evaluation.
          rawList[pointIdx] =
            node.type === LATTICE_DEFORM_NODE.type
              ? latticeBasePointForTarget(node.params, pointIdx, object.position)
              : object.position.clone();
          onTransformChangeRef.current(node.id, { pointsList: rawList });
          return;
        }

        // Multi-point centroid drag: applies relative translation, rotation, and scaling
        // around the selection center to all selected control points simultaneously.
        if (object.userData?.isCurveCentroidHandle) {
          const node = graphRef.current.nodes.find((n) => n.id === curvePointsNodeId);
          if (!node || !onTransformChangeRef.current) return;
          // Param handles each mean something different: there is no moving several at once.
          if (hasParamHandles(node)) return;
          let rawList = Array.isArray(node.params.pointsList) ? [...node.params.pointsList] : [];
          if (rawList.length === 0 && (node.type === EDIT_MESH_POINTS_NODE.type || isIkControlNode(node))) {
            rawList = [];
            for (let i = 0; i < curveHandles.count(); i++) {
              const h = curveHandles.handleAt(i);
              rawList.push(h ? h.position.clone() : new THREE.Vector3());
            }
          }

          const deltaQuat = new THREE.Quaternion().copy(object.quaternion).multiply(dragStartCentroidQuat.clone().invert());
          const deltaScaleX = dragStartCentroidScale.x !== 0 ? object.scale.x / dragStartCentroidScale.x : 1;
          const deltaScaleY = dragStartCentroidScale.y !== 0 ? object.scale.y / dragStartCentroidScale.y : 1;
          const deltaScaleZ = dragStartCentroidScale.z !== 0 ? object.scale.z / dragStartCentroidScale.z : 1;

          // Collected rather than written straight into rawList, so the mesh
          // case below can weld coincident vertices against the *pre-drag*
          // positions — see applyWeldedPointMoves.
          const moves = new Map<number, THREE.Vector3>();
          for (const [idx, initialPos] of dragStartPointPositions.entries()) {
            if (idx < 0 || idx >= rawList.length) continue;
            const offset = new THREE.Vector3().subVectors(initialPos, dragStartCentroidPos);
            offset.x *= deltaScaleX;
            offset.y *= deltaScaleY;
            offset.z *= deltaScaleZ;
            offset.applyQuaternion(deltaQuat);
            const newPos = new THREE.Vector3().addVectors(object.position, offset);
            moves.set(idx, newPos);
            const handle = curveHandles.handleAt(idx);
            if (handle) handle.position.copy(newPos);
          }

          if (node.type === EDIT_MESH_POINTS_NODE.type) {
            onTransformChangeRef.current(node.id, { pointsList: applyWeldedPointMoves(rawList, moves) });
            return;
          }

          for (const [idx, newPos] of moves) {
            // Same deformed-cage conversion as the single-handle path above.
            rawList[idx] =
              node.type === LATTICE_DEFORM_NODE.type
                ? latticeBasePointForTarget(node.params, idx, newPos)
                : newPos;
          }

          onTransformChangeRef.current(node.id, { pointsList: rawList });
          return;
        }

        // Edit Mesh selection centroid drag: loc/rot/scale
        if (object.userData?.isEditMeshCentroidProxy) {
          applyEditMeshDrag(object);
          return;
        }

        if (!attachedGizmoTarget || !onTransformChangeRef.current) return;

        // Which node id actually owns the params a drag writes into — the
        // upstream Transform/MatrixTransform for "absolute"/"offset", or the
        // object itself for "native" (see transformLookup.ts).
        const targetNodeId =
          attachedGizmoTarget.kind === "native" ? attachedGizmoTarget.objectNodeId : attachedGizmoTarget.transformNodeId;

        // What sits upstream of the pose being solved for: the base an
        // "offset" delta is applied on top of, or the delta a "native" base
        // is composed with. Null when nothing is wired, which each node's own
        // evaluate treats as identity.
        const upstreamNodeId =
          attachedGizmoTarget.kind === "offset"
            ? attachedGizmoTarget.baseSourceNodeId
            : attachedGizmoTarget.kind === "native"
              ? attachedGizmoTarget.deltaSourceNodeId
              : null;
        const upstreamResult = upstreamNodeId ? latestResults?.get(upstreamNodeId)?.matrix : undefined;

        const nodeForPivot = graphRef.current.nodes.find((n) => n.id === targetNodeId);
        const patch = computeGizmoWriteback({
          target: attachedGizmoTarget,
          mode: transformModeRef.current,
          object,
          upstreamMatrix: upstreamResult instanceof THREE.Matrix4 ? upstreamResult : null,
          wiredSockets: new Set(
            graphRef.current.connections.filter((c) => c.toNode === targetNodeId).map((c) => c.toSocket),
          ),
          pivot: nodeForPivot ? asVector3(nodeForPivot.params?.pivot, new THREE.Vector3()) : undefined,
          params: nodeForPivot ? paramsWithDefaults(nodeForPivot) : undefined,
        });

        if (elevationView && snapElevation && patch.location) {
          patch.location.y = snapElevationValue(patch.location.y, 0.5);
        }

        if (Object.keys(patch).length > 0) {
          onTransformChangeRef.current(targetNodeId, patch);
        }
      });
    }

    // Click vs orbit-drag: a pointerup that moved less than this, and wasn't
    // the tail end of a gizmo drag (see suppressNextClick above), counts as
    // a selection click.
    const CLICK_MOVE_THRESHOLD_PX = 6;
    let pointerDownAt: { x: number; y: number } | null = null;
    let suppressNextClick = false;

    // Points Selection has no drag/gizmo step to defer to — a click or a
    // marquee release IS the commit, immediately, unlike curve points which
    // write back only when a drag ends.
    function commitPointsSelection() {
      pointsSelectionRevision++;
      if (pointsSelectionNodeId && onTransformChangeRef.current) {
        onTransformChangeRef.current(pointsSelectionNodeId, { selectedIndices: Array.from(selectedPointsSelectionIndices) });
      }
    }

    function commitFaceSelection() {
      if (faceSelectionNodeId && onTransformChangeRef.current) {
        const faces = Array.from(selectedFacesSet).sort((a, b) => a - b);
        // Remember what we just wrote, so the graph update this triggers is
        // recognised as our own and doesn't re-seed the working set from
        // under the operator mid-edit (see lastCommittedFaceKey).
        lastCommittedFaceKey = faces.join(",");
        faceSelectionInteractive = true;
        onTransformChangeRef.current(faceSelectionNodeId, {
          selectedFaces: faces,
          interactive: true,
        });
      }
    }

    /**
     * Reads the drawing settings off the Grease Pencil node, with defaults that
     * match the node definition so older files keep working.
     */
    function readGpDrawSettings(gpNode: { params: Record<string, unknown> }) {
      const modeParam = String(gpNode.params.stabilizerMode ?? "basic") as StabilizerMode;
      const mode: StabilizerMode =
        modeParam === "none" || modeParam === "basic" || modeParam === "weighted" || modeParam === "stabilizer"
          ? modeParam
          : "basic";
      return {
        stabilizerMode: mode,
        stabilizerStrength: Math.max(0, Math.min(1, Number(gpNode.params.stabilizerStrength ?? 0.35))),
        curve: {
          gamma: Number(gpNode.params.pressureCurve ?? 1),
          min: Number(gpNode.params.pressureMin ?? 0.05),
          max: Number(gpNode.params.pressureMax ?? 1),
        },
      };
    }

    /**
     * Projects one stabilized screen sample into the drawing and appends it to
     * the in-progress stroke.
     *
     * Kept separate from the pointer handlers because a single `pointermove`
     * now carries every coalesced tablet sample, and pen-up replays the
     * stabilizer's remaining lag through the same path.
     */
    function appendGpStrokePoint(
      gpNode: NonNullable<ReturnType<typeof findGpNode>>,
      screenPos: { x: number; y: number },
      pressure: number,
      invMatrix: THREE.Matrix4,
      tilt?: { angle: number; inclination: number } | null,
    ) {
      const rect = renderer.domElement.getBoundingClientRect();
      // Reject samples that land on the same pixel as the previous one. The
      // test is in screen space so it neither drops detail when zoomed in nor
      // lets a cluster of coincident points pile up when zoomed out — such a
      // pile makes the ribbon's tangents degenerate and shows up as a blob.
      const lastScreen = gpLastAppendedScreenRef.current;
      if (lastScreen && Math.hypot(screenPos.x - lastScreen.x, screenPos.y - lastScreen.y) < 0.6) {
        return;
      }

      const ptData = resolvePointerPoint(
        screenPos.x,
        screenPos.y,
        gpNode,
        graphRef.current,
        latestResultsRef.current,
        camera,
        renderer.domElement,
        mode2D,
      );
      if (!ptData?.pos) return;

      const localPos = ptData.pos.clone().applyMatrix4(invMatrix);
      const localNormal = ptData.normal ? ptData.normal.clone().transformDirection(invMatrix) : undefined;
      const last = gpActivePointsRef.current[gpActivePointsRef.current.length - 1];
      if (last && Math.hypot(last.x - localPos.x, last.y - localPos.y, last.z - localPos.z) < 1e-5) {
        return;
      }
      gpLastAppendedScreenRef.current = { x: screenPos.x, y: screenPos.y };

      gpActivePointsRef.current.push({
        x: localPos.x,
        y: localPos.y,
        z: localPos.z,
        pressure,
        nx: localNormal?.x,
        ny: localNormal?.y,
        nz: localNormal?.z,
        tiltAngle: tilt?.angle,
        tiltInc: tilt?.inclination,
      });

      // Preview points accumulate in the ref only. One pointer event can carry
      // twenty coalesced samples, and re-rendering the viewport once per
      // sample stalls the main thread badly enough to show up as input lag —
      // the caller flushes once per event instead (see flushGpLivePreview).
      gpLivePreviewRef.current = [
        ...gpLivePreviewRef.current,
        { screenX: screenPos.x - rect.left, screenY: screenPos.y - rect.top },
      ];
    }

    /** Publishes the accumulated live-preview points to React, once. */
    function flushGpLivePreview() {
      setGpLivePreview(gpLivePreviewRef.current);
    }

    /**
     * Writes a painted texture or splat map into the node's params.
     *
     * Debounced, because the encode is the expensive part and a working pass
     * is a burst of short strokes: without this, every pen-up paid for a full
     * PNG encode of the whole map.
     */
    function scheduleTextureSnapshot(nodeId: string) {
      const pending = textureSnapshotTimersRef.current;
      const existing = pending.get(nodeId);
      if (existing !== undefined) clearTimeout(existing);

      const timer = setTimeout(() => {
        pending.delete(nodeId);
        const node = graphRef.current.nodes.find((n) => n.id === nodeId);
        if (!node) return;

        if (isTexturePaintNode(node)) {
          const state = getTexturePaintState(nodeId);
          if (state.canvas) {
            onParamChangeRef.current?.("textureData", serializePaintCanvas(state.canvas), nodeId, { coalesce: false });
          }
        } else if (isTextureMixNode(node)) {
          const state = getTextureMixPaintState(nodeId);
          if (state.splatBuffer && state.res) {
            // PNG-packed rather than raw base64: the same map goes from
            // megabytes of base64 to tens of kilobytes, which is the
            // difference between fitting in the autosave quota and not.
            const encoded = serializeSplatToPng(
              state.splatBuffer,
              state.res,
              state.res,
              state.layerCount ?? 1,
            );
            if (encoded) {
              state.lastSplatData = encoded;
              onParamChangeRef.current?.("splatData", encoded, nodeId, { coalesce: false });
            }
          }
        }
      }, TEXTURE_SNAPSHOT_DEBOUNCE_MS) as unknown as number;

      pending.set(nodeId, timer);
    }

    /**
     * Writes a finished point list into the node's frames as a new stroke.
     * Shared by the freehand pen, the shape tools and the fill tool.
     */
    function commitGpStroke(
      gpNode: NonNullable<ReturnType<typeof findGpNode>>,
      points: StrokePoint[],
      opts: { closed?: boolean; fill?: boolean } = {},
    ) {
      if (points.length < 2) return;
      const strokeColor = parseColorHex(gpNode.params.activeColor, "#38bdf8");
      const customFillColor = parseColorHex(gpNode.params.fillColor, "");
      const fillColorVal = customFillColor || strokeColor;
      const fill = opts.fill ?? gpSolidFillRef.current;

      const newStroke: GreaseStroke = {
        id: `stroke_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        points,
        color: strokeColor,
        width: Number(gpNode.params.brushSize) || 4,
        brushType: gpBrushTypeRef.current,
        fill,
        fillColor: fill ? fillColorVal : undefined,
        closed: opts.closed,
      };

      const currentFrames = (gpNode.params.frames as KeyframeDrawing[]) || [];
      const targetFrame = currentFrameRef.current >= 0 ? currentFrameRef.current : 0;
      const nextFrames = addStrokeToFrames(currentFrames, targetFrame, newStroke);
      onParamChangeRef.current?.("frames", nextFrames, gpNode.id, { coalesce: false });
    }

    /**
     * Rebuilds the in-progress stroke from a screen-space outline.
     *
     * The shape tools regenerate their whole point list on every pointer move,
     * so this replaces rather than appends, and it bypasses the stabilizer:
     * a rectangle should be exactly a rectangle.
     */
    function setGpStrokeFromScreenPoints(
      gpNode: NonNullable<ReturnType<typeof findGpNode>>,
      screenPoints: ShapePoint[],
      invMatrix: THREE.Matrix4,
      pressure: number,
    ) {
      const rect = renderer.domElement.getBoundingClientRect();
      gpActivePointsRef.current = [];
      gpLivePreviewRef.current = [];

      // Sample the outline often enough that projecting onto a curved surface
      // or an angled plane still follows it.
      const dense = densifyShapePoints(screenPoints, 6);
      for (const sp of dense) {
        const ptData = resolvePointerPoint(
          sp.x,
          sp.y,
          gpNode,
          graphRef.current,
          latestResultsRef.current,
          camera,
          renderer.domElement,
          mode2D,
        );
        if (!ptData?.pos) continue;
        const local = ptData.pos.clone().applyMatrix4(invMatrix);
        const normal = ptData.normal ? ptData.normal.clone().transformDirection(invMatrix) : undefined;
        gpActivePointsRef.current.push({
          x: local.x,
          y: local.y,
          z: local.z,
          pressure,
          nx: normal?.x,
          ny: normal?.y,
          nz: normal?.z,
        });
        gpLivePreviewRef.current.push({ screenX: sp.x - rect.left, screenY: sp.y - rect.top });
      }
      flushGpLivePreview();
    }

    /** Projects a drawing-local stroke point back to client space. */
    function makeGpProjector(gpNode: NonNullable<ReturnType<typeof findGpNode>>): PointProjector {
      const rect = renderer.domElement.getBoundingClientRect();
      const matrix = getGpInverseMatrix(gpNode, latestResultsRef.current).clone().invert();
      const v = new THREE.Vector3();
      return (p: StrokePoint) => {
        v.set(p.x, p.y, p.z).applyMatrix4(matrix).project(camera);
        return {
          x: rect.left + ((v.x + 1) / 2) * rect.width,
          y: rect.top + ((1 - v.y) / 2) * rect.height,
        };
      };
    }

    /** Screen-space polylines of the active drawing, for selection overlays. */
    function projectStrokes(
      gpNode: NonNullable<ReturnType<typeof findGpNode>>,
      strokes: GreaseStroke[],
    ): { screenX: number; screenY: number }[][] {
      const rect = renderer.domElement.getBoundingClientRect();
      const project = makeGpProjector(gpNode);
      return strokes.map((s) =>
        s.points
          .map((p) => project(p))
          .filter((p): p is { x: number; y: number } => p !== null)
          .map((p) => ({ screenX: p.x - rect.left, screenY: p.y - rect.top })),
      );
    }

    /**
     * Closes the polyline in progress and commits it.
     *
     * `closeShape` joins the last vertex back to the first, which is how the
     * tool draws filled polygons.
     */
    function finishGpPolyline(
      gpNode: NonNullable<ReturnType<typeof findGpNode>>,
      invMatrix: THREE.Matrix4,
      closeShape = false,
    ) {
      const verts = gpPolylineVerticesRef.current;
      gpPolylineVerticesRef.current = [];
      isGpDrawingRef.current = false;
      setIsGpDrawing(false);
      controls.enabled = true;

      if (verts.length >= 2) {
        const outline = closeShape ? [...verts, verts[0]] : verts;
        setGpStrokeFromScreenPoints(gpNode, outline, invMatrix, 0.75);
        const points = gpActivePointsRef.current;
        if (points.length >= 2) {
          commitGpStroke(gpNode, points, {
            closed: closeShape,
            fill: closeShape ? gpSolidFillRef.current : false,
          });
        }
      }

      gpActivePointsRef.current = [];
      gpLivePreviewRef.current = [];
      setGpLivePreview([]);
    }

    // Let the keyboard handler (another effect) end the polyline in progress.
    gpFinishPolylineRef.current = (closeShape: boolean) => {
      const gpNode = findGpNode();
      if (!gpNode) return;
      finishGpPolyline(gpNode, getGpInverseMatrix(gpNode, latestResultsRef.current), closeShape);
    };

    /**
     * Fill tool: rasterizes the drawing around the click, floods the region
     * the artist pointed at and commits its outline as a filled stroke.
     */
    function runGpFill(gpNode: NonNullable<ReturnType<typeof findGpNode>>, seed: { x: number; y: number }) {
      const rect = renderer.domElement.getBoundingClientRect();
      const frames = (gpNode.params.frames as KeyframeDrawing[]) || [];
      const targetFrame = currentFrameRef.current >= 0 ? currentFrameRef.current : 0;
      const drawing = resolveActiveDrawing(frames, targetFrame);
      if (!drawing || drawing.strokes.length === 0) {
        setGpToolHint("Nothing to fill — draw a closed shape first");
        return;
      }

      const project = makeGpProjector(gpNode);
      const boundaries = drawing.strokes
        .map((s) => s.points.map((p) => project(p)).filter((p): p is { x: number; y: number } => p !== null))
        .filter((line) => line.length >= 2);
      if (boundaries.length === 0) {
        setGpToolHint("Nothing to fill — draw a closed shape first");
        return;
      }

      const result = computeFillRegion({
        boundaries,
        seed,
        bounds: { minX: rect.left, minY: rect.top, maxX: rect.right, maxY: rect.bottom },
        cellSize: 2,
        // Gap closing scales with the brush: a fat brush implies a sketch
        // whose corners are correspondingly loose.
        gapClose: Math.max(2, (Number(gpNode.params.brushSize) || 4) * 0.75),
        tolerance: 1.5,
      });

      if (result.leaked) {
        setGpToolHint("Fill leaked — the region is not closed (raise Brush Size to bridge bigger gaps)");
        return;
      }
      if (!result.contour) {
        setGpToolHint("Nothing to fill here");
        return;
      }

      const invMatrix = getGpInverseMatrix(gpNode, latestResultsRef.current);
      const points: StrokePoint[] = [];
      for (const sp of result.contour) {
        const hit = resolvePointerPoint(
          sp.x, sp.y, gpNode, graphRef.current, latestResultsRef.current, camera, renderer.domElement, mode2D,
        );
        if (!hit?.pos) continue;
        const local = hit.pos.clone().applyMatrix4(invMatrix);
        points.push({ x: local.x, y: local.y, z: local.z, pressure: 0.5 });
      }
      if (points.length < 3) {
        setGpToolHint("Nothing to fill here");
        return;
      }
      points.push({ ...points[0] });

      setGpToolHint(null);
      commitGpStroke(gpNode, points, { closed: true, fill: true });
    }

    /** Refreshes the highlight drawn over the lasso-selected strokes. */
    function refreshGpSelectionOverlay(gpNode: NonNullable<ReturnType<typeof findGpNode>> | null) {
      const ids = gpSelectedStrokeIdsRef.current;
      if (!gpNode || ids.size === 0) {
        setGpSelectionOverlay([]);
        return;
      }
      const frames = (gpNode.params.frames as KeyframeDrawing[]) || [];
      const drawing = resolveActiveDrawing(frames, currentFrameRef.current >= 0 ? currentFrameRef.current : 0);
      const selected = (drawing?.strokes ?? []).filter((s) => ids.has(s.id));
      setGpSelectionOverlay(projectStrokes(gpNode, selected));
    }

    function findGpNode() {
      return selectedNodeIdRef.current
        ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && isPaintOrGreaseNode(n)) ?? null
        : null;
    }

    /** The selected Skin node while its weight brush is on and a joint is picked to paint. */
    function weightPaintNode() {
      if (outputMode || elevationView || !selectedNodeIdRef.current) return null;
      const node = graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && n.type === SKIN_NODE.type);
      if (!node || !node.params.weightPaintMode) return null;
      return Math.round(Number(node.params.selectedJoint ?? -1)) >= 0 ? node : null;
    }

    function weightPaintHit(nodeId: string, e: PointerEvent) {
      if (!raycaster) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      return raycaster.intersectObjects(skinPaintMeshes(nodeId), false)[0] ?? null;
    }

    /**
     * One dab where the brush is, spaced a fifth of its radius from the last
     * so a slow drag does not paint harder than a fast one. Shift smooths, Alt
     * turns Add into Subtract and back.
     */
    function weightDab(node: { id: string; params: Record<string, unknown> }, point: THREE.Vector3, e: PointerEvent) {
      const radius = Math.max(0.001, Number(node.params.weightBrushSize) || 0.15);
      if (weightPainting?.last && weightPainting.last.distanceTo(point) < radius * 0.2) return;
      const brush = String(node.params.weightBrush ?? "Add") as WeightBrush;
      const tool: WeightBrush = e.shiftKey ? "Smooth" : e.altKey && brush !== "Smooth" ? (brush === "Add" ? "Subtract" : "Add") : brush;
      const pressure = e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 1;
      skinWeightDab(node.id, {
        joint: Math.round(Number(node.params.selectedJoint)),
        tool,
        center: point,
        radius,
        strength: (Number(node.params.weightBrushStrength) || 0.3) * pressure,
      });
      if (weightPainting) weightPainting.last = point.clone();
    }

    /**
     * Points Influence's gradient: every vertex of its mesh projected to the
     * screen and given its place along the line (1 at the start, 0 at the
     * end), painted into the map and handed to the points at once — the
     * gradient redefines the whole field, so it doesn't wait for Compute.
     */
    function applyInfluenceGradientLine(
      nodeId: string,
      start: { x: number; y: number },
      end: { x: number; y: number },
      rect: DOMRect,
    ) {
      const result = latestResultsRef.current?.get(nodeId);
      const mesh = result?.geometry instanceof THREE.Object3D ? findFirstMesh(result.geometry) : null;
      const pos = mesh?.geometry.attributes.position;
      if (!mesh || !pos) return;
      if (!mesh.geometry.attributes.uv) {
        console.warn("Points Influence: this mesh has no UVs, so a gradient cannot be painted on it.");
        return;
      }
      mesh.updateWorldMatrix(true, false);
      const toClip = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(mesh.matrixWorld);
      const screen = new Float32Array(pos.count * 2);
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(toClip);
        screen[i * 2] = ((v.x + 1) / 2) * rect.width;
        screen[i * 2 + 1] = ((1 - v.y) / 2) * rect.height;
      }
      const influences = applyInfluenceGradient(nodeId, mesh.geometry, screen, start, end);
      const state = getTexturePaintState(nodeId);
      if (!influences || !state.canvas) return;
      // The map is already what the param will say: mark it restored so the
      // node doesn't decode its own PNG back over it.
      const textureData = serializePaintCanvas(state.canvas);
      state.lastDataUrl = textureData;
      const pending = textureSnapshotTimersRef.current.get(nodeId);
      if (pending !== undefined) {
        clearTimeout(pending);
        textureSnapshotTimersRef.current.delete(nodeId);
      }
      onParamChangeRef.current?.({ textureData, influences }, undefined, nodeId, { coalesce: false });
    }

    /**
     * The stamps between the last painted sample and this one. A stroke is
     * joined in UV space, which is only the surface's shape inside one UV
     * island: when the cursor crosses a seam (onto an ear, a tail, another
     * island packed far away), the straight UV line between the two hits
     * runs across whatever islands lie between them and paints long streaks
     * there. So a jump longer than the brush is walked in screen space
     * instead — raycast every few pixels, each hit stamped, joined to the
     * previous one only while they stay close in UV — and samples that miss
     * the mesh break the stroke rather than bridging the gap.
     */
    function texturePaintSegments(
      prevUv: { x: number; y: number } | null,
      prevScreen: { x: number; y: number } | null,
      uv: { x: number; y: number },
      screen: { x: number; y: number },
      resPx: number,
      brushPx: number,
      targetMeshes: THREE.Object3D[],
    ): { uv: { x: number; y: number }; prevUv: { x: number; y: number } | null }[] {
      if (!prevUv) return [{ uv, prevUv: null }];
      const maxGap = Math.max(8, brushPx * 2);
      const close = (a: { x: number; y: number }, b: { x: number; y: number }) =>
        Math.hypot(a.x - b.x, a.y - b.y) * resPx <= maxGap;
      if (close(prevUv, uv)) return [{ uv, prevUv }];
      if (!prevScreen || !raycaster) return [{ uv, prevUv: null }];

      const rect = renderer.domElement.getBoundingClientRect();
      const steps = Math.min(48, Math.max(1, Math.ceil(Math.hypot(screen.x - prevScreen.x, screen.y - prevScreen.y) / 3)));
      const out: { uv: { x: number; y: number }; prevUv: { x: number; y: number } | null }[] = [];
      const ndc = new THREE.Vector2();
      let last: { x: number; y: number } | null = prevUv;
      for (let i = 1; i <= steps; i++) {
        let at: { x: number; y: number } | null = uv;
        if (i < steps) {
          const t = i / steps;
          const x = prevScreen.x + (screen.x - prevScreen.x) * t;
          const y = prevScreen.y + (screen.y - prevScreen.y) * t;
          ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
          raycaster.setFromCamera(ndc, camera);
          const hit = raycaster.intersectObjects(targetMeshes, true)[0];
          at = hit?.uv ? { x: hit.uv.x, y: hit.uv.y } : null;
        }
        if (!at) {
          last = null;
          continue;
        }
        out.push({ uv: at, prevUv: last && close(last, at) ? last : null });
        last = at;
      }
      return out;
    }

    function onCanvasPointerDown(e: PointerEvent) {
      if (e.ctrlKey && !e.metaKey && e.button === 0) {
        try {
          Object.defineProperty(e, "ctrlKey", { get: () => false });
        } catch {
          // ignore
        }
      }

      pointerDownAt = { x: e.clientX, y: e.clientY };

      // A running Edit Mesh tool: left click confirms, right click cancels,
      // and the click goes no further (no orbit, no selection change).
      if (editCtl.modalNodeId !== null) {
        if (e.button === 2) cancelEditModal();
        else clickEditModal();
        suppressNextClick = true;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }

      // Edit Mesh gestures: Cmd/Ctrl-drag (paint select) & Shift-drag (marquee select / shift-click)
      const editMeshNodeOnDown = !outputMode && selectedNodeIdRef.current
        ? findEditMeshNode(graphRef.current, selectedNodeIdRef.current, true)
        : null;

      // Alt(+Cmd/Ctrl)+click is a loop/ring select, handled on release like
      // any click — it must not start the brush or a marquee here.
      if (editMeshNodeOnDown && e.button === 0 && !e.altKey) {
        if (e.metaKey || e.ctrlKey) {
          // Brush selection start: Cmd/Ctrl+drag. Replaces the selection
          // unless Shift is held too; every later stroke sample adds.
          editMeshPaintDragRef.current = true;
          controls.enabled = false;
          if (host) {
            const hostRect = host.getBoundingClientRect();
            setEditMeshPaintCursor({ x: e.clientX - hostRect.left, y: e.clientY - hostRect.top });
          }
          const target = editMeshTarget();
          if (target) {
            const picked = pickEditBrush(target, e.clientX, e.clientY);
            if (picked || !e.shiftKey) applyEditPick(target, picked ?? emptySelection(), e.shiftKey ? "add" : "replace");
          }
          e.stopImmediatePropagation();
          return;
        } else if (e.shiftKey && (editMeshNodeOnDown.type === EDIT_MESH_POINTS_NODE.type || editMeshToolRef.current !== "loopcut")) {
          // Shift-drag (box or lasso) or Shift-click arming
          editMeshRectDragRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            currentX: e.clientX,
            currentY: e.clientY,
            path: [{ x: e.clientX, y: e.clientY }],
          };
          controls.enabled = false;
          e.stopImmediatePropagation();
          return;
        }
      }

      const isMarqueeModifier = e.metaKey;

      const gpNode = selectedNodeIdRef.current
        ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && isPaintOrGreaseNode(n))
        : null;

      const terrainNode = selectedNodeIdRef.current
        ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && isTerrainNode(n))
        : null;

      if (terrainNode && !outputMode && !elevationView && e.button === 0 && !isMarqueeModifier && raycaster) {
        const terrainMesh = getTerrainMeshForNode(terrainNode.id, latestResultsRef.current);
        if (terrainMesh) {
          const rect = renderer.domElement.getBoundingClientRect();
          const mouseNorm = new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1,
          );
          raycaster.setFromCamera(mouseNorm, camera);
          const intersects = raycaster.intersectObject(terrainMesh, false);
          if (intersects.length > 0) {
            const hit = intersects[0];
            const localHit = terrainMesh.worldToLocal(hit.point.clone());
            isTerrainSculptingRef.current = true;
            controls.enabled = false;

            const workingOffsets = { ...((terrainNode.params.sculptOffsets as Record<number, number>) || {}) };
            terrainSculptWorkingOffsetsRef.current = workingOffsets;
            const workingMask = { ...((terrainNode.params.maskWeights as Record<number, number>) || {}) };
            terrainMaskWorkingRef.current = workingMask;
            terrainTargetHeightRef.current = localHit.y;

            const brushRadius = Number(terrainNode.params.brushSize) || 4;
            const brushStrength = Number(terrainNode.params.brushStrength) || 0.5;
            const tool = (terrainNode.params.brushTool as TerrainBrushTool) || terrainBrushToolRef.current;
            const falloff = (terrainNode.params.brushFalloff as TerrainBrushFalloff) || terrainBrushFalloffRef.current;

            const strokeParams: SculptStrokeParams = {
              tool,
              falloff,
              radius: brushRadius,
              strength: brushStrength,
              invert: terrainInvertRef.current || e.altKey,
              hitPoint: localHit,
              targetHeight: localHit.y,
              deltaTime: 0.03,
              maskErase: e.shiftKey,
              symmetryX: Boolean(terrainNode.params.symmetryX),
              symmetryZ: Boolean(terrainNode.params.symmetryZ),
            };

            const terrainConfig = terrainMesh.userData.terrainConfig as TerrainGridConfig;
            const heightmapPixels = terrainMesh.userData.heightmapPixels;

            applySculptStroke(terrainMesh.geometry, terrainConfig, heightmapPixels, workingOffsets, strokeParams, workingMask);
            const terrainMaskActive = hasAnyMaskWeight(workingMask);
            const terrainMat = terrainMesh.material as THREE.MeshStandardMaterial;
            const terrainWantsVertexColors = Boolean(terrainNode.params.slopeShading) || terrainMaskActive;
            if (terrainMat.vertexColors !== terrainWantsVertexColors) {
              terrainMat.vertexColors = terrainWantsVertexColors;
              terrainMat.needsUpdate = true;
            }
            e.stopImmediatePropagation();
            return;
          }
        }
      }

      // The Skin weight brush; a click on a joint ball still picks the joint.
      const weightNode = weightPaintNode();
      if (weightNode && e.button === 0 && !isMarqueeModifier) {
        const rect = renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        const onJoint = skinJointHandles.count() > 0 && skinJointHandles.pick(ndc, camera, rect.width, rect.height) !== null;
        const hit = onJoint ? null : weightPaintHit(weightNode.id, e);
        if (hit) {
          weightPainting = { nodeId: weightNode.id, last: null };
          controls.enabled = false;
          weightDab(weightNode, hit.point, e);
          e.stopImmediatePropagation();
          return;
        }
      }

      const sculptNode = selectedNodeIdRef.current
        ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && isSculptNode(n))
        : null;

      if (sculptNode && !outputMode && !elevationView && e.button === 0 && !isMarqueeModifier && raycaster) {
        const sculptMesh = getSculptMeshForNode(sculptNode.id, latestResultsRef.current);
        if (sculptMesh) {
          const rect = renderer.domElement.getBoundingClientRect();
          const mouseNorm = new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1,
          );
          raycaster.setFromCamera(mouseNorm, camera);
          const intersects = raycaster.intersectObject(sculptMesh, false);
          if (intersects.length > 0 && intersects[0].face) {
            const hit = intersects[0];
            const localHit = sculptMesh.worldToLocal(hit.point.clone());
            // hit.face.normal is already in the geometry's own local space —
            // exactly the space applySculptStroke3D operates in, unlike the
            // gizmo (which needs the *world* normal to orient itself visibly
            // in the editor overlay scene, computed separately below).
            const localNormal = hit.face!.normal.clone().normalize();

            isSculptingRef.current = true;
            controls.enabled = false;

            const baseData = sculptMesh.userData.sculptMeshData as SculptMeshData;
            const workingMesh: SculptMeshData = {
              positions: baseData.positions.slice(),
              normals: baseData.normals.slice(),
              indices: baseData.indices.slice(),
              mask: baseData.mask ? baseData.mask.slice() : undefined,
            };
            sculptWorkingMeshRef.current = workingMesh;
            sculptWorkingAdjacencyRef.current = buildAdjacency(workingMesh.indices, workingMesh.positions.length / 3);
            sculptStrokeOriginRef.current = localHit.clone();
            sculptStrokeNormalRef.current = localNormal.clone();
            sculptLastHitRef.current = localHit.clone();

            const brushRadius = Number(sculptNode.params.brushSize) || 0.3;
            const brushStrength = Number(sculptNode.params.brushStrength) || 0.5;
            const tool = (sculptNode.params.brushTool as SculptBrushTool) || sculptBrushToolRef.current;
            const falloff = (sculptNode.params.brushFalloff as BrushFalloff) || sculptBrushFalloffRef.current;
            // Fraction of the brush radius dyntopo targets as edge length —
            // clamped so it can never end up smaller than the base mesh's
            // own edge length, which is what used to trigger a runaway
            // subdivision cascade the instant the brush touched the mesh.
            const dyntopoDetail = Math.max(0.1, Math.min(0.5, Number(sculptNode.params.dyntopoDetail) || 0.25));

            sculptPressureTrackerRef.current = createPressureTracker({
              gamma: Number(sculptNode.params.pressureCurve ?? 1),
              min: Number(sculptNode.params.pressureMin ?? 0.05),
              max: Number(sculptNode.params.pressureMax ?? 1),
            });
            const sample = collectPointerSamples(e, performance.now())[0];
            sculptLastPressureSampleRef.current = sample;
            const usePressure = Boolean(sculptNode.params.usePressure ?? true);
            const rawPressure = sculptPressureTrackerRef.current.next(sample, null);
            const pressure = usePressure && sample.isPen ? Math.max(0.04, Math.min(1.0, rawPressure)) : 1.0;
            const effectiveRadius = brushRadius * pressure;
            const effectiveStrength = brushStrength * pressure;

            const refined = refineNearBrush(workingMesh, localHit, effectiveRadius * 1.5, effectiveRadius * dyntopoDetail);
            sculptLastRefineTimeRef.current = performance.now();
            sculptWorkingMeshRef.current = refined;
            sculptWorkingAdjacencyRef.current = buildAdjacency(refined.indices, refined.positions.length / 3);

            const strokeParams3D: SculptStrokeParams3D = {
              tool,
              falloff,
              radius: effectiveRadius,
              strength: effectiveStrength,
              invert: sculptInvertRef.current || e.altKey,
              hitPoint: localHit,
              hitNormal: localNormal,
              strokeOrigin: localHit.clone(),
              strokeNormal: localNormal.clone(),
              deltaTime: 0.03,
              maskErase: e.shiftKey,
              symmetryX: Boolean(sculptNode.params.symmetryX),
              symmetryY: Boolean(sculptNode.params.symmetryY),
              symmetryZ: Boolean(sculptNode.params.symmetryZ),
            };
            applySculptStroke3D(refined, sculptWorkingAdjacencyRef.current, strokeParams3D);
            refined.normals = computeVertexNormals(refined.positions, refined.indices);
            const maskActive = syncBufferGeometry(sculptMesh.geometry, refined);
            const sculptMat = sculptMesh.material as THREE.MeshStandardMaterial;
            if (sculptMat.vertexColors !== maskActive) {
              sculptMat.vertexColors = maskActive;
              sculptMat.needsUpdate = true;
            }
            e.stopImmediatePropagation();
            return;
          }
        }
      }

      // Points Influence: Shift-drag draws a line, and the whole map becomes
      // a gradient along it (applyInfluenceGradientLine on release).
      if (!outputMode && !elevationView && e.button === 0 && e.shiftKey && !isMarqueeModifier) {
        const infNode = graphRef.current.nodes.find(
          (n) => n.id === selectedNodeIdRef.current && n.type === POINTS_INFLUENCE_NODE.type,
        );
        if (infNode) {
          const rect = renderer.domElement.getBoundingClientRect();
          const start = { x: e.clientX - rect.left, y: e.clientY - rect.top };
          influenceGradient = { nodeId: infNode.id, start };
          setGradientLine({ x1: start.x, y1: start.y, x2: start.x, y2: start.y });
          controls.enabled = false;
          if (textureBrushGizmo) textureBrushGizmo.visible = false;
          e.stopImmediatePropagation();
          return;
        }
      }

      const texPaintNode = selectedNodeIdRef.current
        ? graphRef.current.nodes.find(
            (n) => n.id === selectedNodeIdRef.current && (isTexturePaintNode(n) || isTextureMixNode(n)),
          )
        : null;

      if (texPaintNode && !outputMode && !elevationView && e.button === 0 && !isMarqueeModifier && raycaster) {
        const targetMeshes = getTexturePaintMeshesForNode(texPaintNode.id, graphRef.current, latestResultsRef.current);
        if (targetMeshes.length > 0) {
          const rect = renderer.domElement.getBoundingClientRect();
          const mouseNorm = new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1,
          );
          raycaster.setFromCamera(mouseNorm, camera);
          const intersects = raycaster.intersectObjects(targetMeshes, true);
          if (intersects.length > 0) {
            const hit = intersects[0];
            let uv = hit.uv ? { x: hit.uv.x, y: hit.uv.y } : null;
            if (!uv && hit.point) {
              uv = { x: ((hit.point.x % 1) + 1) % 1, y: ((hit.point.z % 1) + 1) % 1 };
            }
            if (uv) {
              isTexturePaintingRef.current = true;
              texturePaintLastUvRef.current = { ...uv };
              texturePaintLastScreenRef.current = { x: e.clientX, y: e.clientY };
              controls.enabled = false;

              texturePaintPressureTrackerRef.current = createPressureTracker({
                gamma: Number(texPaintNode.params.pressureCurve ?? 1),
                min: Number(texPaintNode.params.pressureMin ?? 0.05),
                max: Number(texPaintNode.params.pressureMax ?? 1),
              });
              const samples = collectPointerSamples(e, performance.now());
              const sample = samples[0];
              texturePaintPrevSampleRef.current = sample;
              const usePressure = Boolean(texPaintNode.params.usePressure ?? true);
              const pressureTarget = (texPaintNode.params.pressureTarget as any) || "both";
              const basePr = texturePaintPressureTrackerRef.current.next(sample, null);
              const pressure = usePressure && sample.isPen ? Math.max(0.04, Math.min(1.0, basePr)) : 1.0;
              texturePaintLastPressureRef.current = pressure;

              if (isTexturePaintNode(texPaintNode)) {
                const state = getTexturePaintState(texPaintNode.id);
                if (state.canvas) {
                  const { tool: brushTool, color: brushColor } = texturePaintStroke(texPaintNode);
                  const brushSize = Number(texPaintNode.params.brushSize) || 24;
                  const brushOpacity = Number(texPaintNode.params.brushOpacity ?? 1.0);
                  const brushHardness = Number(texPaintNode.params.brushHardness ?? 0.5);
                  const symmetryX = Boolean(texPaintNode.params.symmetryX);

                  const res = applyPaintStroke(state.canvas, {
                    tool: brushTool,
                    color: brushColor,
                    radius: brushSize,
                    opacity: brushOpacity,
                    hardness: brushHardness,
                    uv,
                    prevUv: null,
                    symmetryX,
                    pressure,
                    prevPressure: null,
                    pressureAffects: pressureTarget,
                    p5: texturePaintP5Style(texPaintNode.params),
                  });
                  if (res.sampledColor) {
                    onParamChangeRef.current?.("brushColor", res.sampledColor, texPaintNode.id);
                  }
                  if (state.texture) state.texture.needsUpdate = true;
                }
              } else if (isTextureMixNode(texPaintNode)) {
                const state = getTextureMixPaintState(texPaintNode.id);
                if (state.splatBuffer && state.outCanvas) {
                  const resPx = state.outCanvas.width;
                  const activeLayer = Number(texPaintNode.params.activeLayer) || 0;
                  const brushTool = (texPaintNode.params.brushTool as TextureMixTool) || "paint";
                  const brushSize = Number(texPaintNode.params.brushSize) || 32;
                  const brushStrength = Number(texPaintNode.params.brushStrength) || 0.8;
                  const brushFalloff = (texPaintNode.params.brushFalloff as any) || "smooth";

                  const dirty = applyMixStroke(state.splatBuffer, resPx, resPx, state.lastLayerCount || 1, {
                    tool: brushTool,
                    activeLayer,
                    radius: brushSize,
                    strength: brushStrength,
                    falloff: brushFalloff,
                    uv,
                    prevUv: null,
                    pressure,
                    prevPressure: null,
                    pressureAffects: pressureTarget,
                  });
                  // Recomposite only the rect the stamp touched, and tell the
                  // node its weights moved so its signature guard re-bakes.
                  // GPU pass when the renderer is up, CPU dirty-rect otherwise.
                  const composited = compositeLayersAuto(state, state.layers ?? [], {
                    renderer,
                    res: resPx,
                    layerCount: state.lastLayerCount || 1,
                    region: dirty,
                  });
                  if (composited) state.texture = composited;
                  state.splatVersion = (state.splatVersion ?? 0) + 1;
                  if (state.texture) state.texture.needsUpdate = true;
                  if (state.splatTexture) state.splatTexture.needsUpdate = true;
                }
              }
              e.stopImmediatePropagation();
              return;
            }
          }
        }
      }

      const isDrawingOrModifying =
        gpToolRef.current !== "select" &&
        !GP_LASSO_TOOLS.has(gpToolRef.current) &&
        gpToolRef.current !== "fill" &&
        gpToolRef.current !== "polyline";

      // Lasso-driven tools (select / carve) and the click-based tools (fill,
      // polyline) run their own gestures rather than the stroke pipeline.
      if (gpNode && !outputMode && !elevationView && e.button === 0 && !isMarqueeModifier && !e.altKey) {
        const tool = gpToolRef.current;

        if (GP_LASSO_TOOLS.has(tool)) {
          controls.enabled = false;
          const projector = makeGpProjector(gpNode);
          const frames = (gpNode.params.frames as KeyframeDrawing[]) || [];
          const targetFrame = currentFrameRef.current >= 0 ? currentFrameRef.current : 0;
          const drawing = resolveActiveDrawing(frames, targetFrame);

          // Pressing inside an existing selection moves it instead of
          // starting a new lasso — the usual select-then-drag idiom.
          if (tool === "lasso" && gpSelectedStrokeIdsRef.current.size > 0 && drawing) {
            const hitRadius = 12;
            const grabbed = drawing.strokes.some((s) => {
              if (!gpSelectedStrokeIdsRef.current.has(s.id)) return false;
              return s.points.some((p) => {
                const sp = projector(p);
                return sp !== null && Math.hypot(sp.x - e.clientX, sp.y - e.clientY) < hitRadius;
              });
            });
            if (grabbed) {
              gpSelectionDragRef.current = { lastX: e.clientX, lastY: e.clientY };
              gpWorkingFramesRef.current = frames;
              e.stopImmediatePropagation();
              return;
            }
          }

          gpLassoPointsRef.current = [{ x: e.clientX, y: e.clientY }];
          setGpLassoPreview(gpLassoPointsRef.current);
          isGpDrawingRef.current = true;
          setIsGpDrawing(true);
          e.stopImmediatePropagation();
          return;
        }

        if (tool === "fill") {
          runGpFill(gpNode, { x: e.clientX, y: e.clientY });
          e.stopImmediatePropagation();
          return;
        }

        if (tool === "polyline") {
          const invMatrix = getGpInverseMatrix(gpNode, latestResultsRef.current);
          // Double click closes the polyline.
          if (e.detail >= 2 && gpPolylineVerticesRef.current.length >= 2) {
            finishGpPolyline(gpNode, invMatrix);
          } else {
            gpPolylineVerticesRef.current = [...gpPolylineVerticesRef.current, { x: e.clientX, y: e.clientY }];
            isGpDrawingRef.current = true;
            setIsGpDrawing(true);
            controls.enabled = false;
            setGpStrokeFromScreenPoints(
              gpNode,
              buildPolylinePoints(gpPolylineVerticesRef.current),
              invMatrix,
              0.75,
            );
          }
          e.stopImmediatePropagation();
          return;
        }
      }

      if (gpNode && !outputMode && !elevationView && isDrawingOrModifying && e.button === 0 && !isMarqueeModifier && !e.altKey) {
        isGpDrawingRef.current = true;
        setIsGpDrawing(true);
        gpShiftAtStartRef.current = e.shiftKey || Boolean(e.getModifierState && e.getModifierState("Shift"));
        gpCtrlAtStartRef.current = Boolean(e.getModifierState && e.getModifierState("Control"));
        gpPressureModifierRef.current = gpShiftAtStartRef.current ? 0.45 : gpCtrlAtStartRef.current ? 1.75 : 1.0;
        controls.enabled = false;
        const rect = renderer.domElement.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        const now = performance.now();
        gpPrevPointerRef.current = { x: screenX, y: screenY, time: now };

        const ptData = resolvePointerPoint(
          e.clientX,
          e.clientY,
          gpNode,
          graphRef.current,
          latestResultsRef.current,
          camera,
          renderer.domElement,
          mode2D,
        );
        const worldPos = ptData?.pos ?? null;

        gpWorkingFramesRef.current = (gpNode.params.frames as KeyframeDrawing[]) || [];
        const bSize = Number(gpNode.params.brushSize) || 4;
        const toolRadius = Math.max(0.85, bSize * 0.1);

        if (worldPos) {
          const invMatrix = getGpInverseMatrix(gpNode, latestResultsRef.current);
          const localPos = worldPos.clone().applyMatrix4(invMatrix);
          const localNormal = ptData?.normal ? ptData.normal.clone().transformDirection(invMatrix) : undefined;
          const currentFrames = gpWorkingFramesRef.current;
          const targetFrame = currentFrameRef.current >= 0 ? currentFrameRef.current : 0;
          if (GP_SHAPE_TOOLS.has(gpToolRef.current)) {
            // Shapes only need their anchor on press; the outline is rebuilt
            // on every move until release.
            gpLineAnchorRef.current = { x: e.clientX, y: e.clientY };
            gpActivePointsRef.current = [];
            gpLivePreviewRef.current = [];
            flushGpLivePreview();
          } else if (gpToolRef.current === "eraser_hard") {
            const erased = eraseStrokesCut(currentFrames, targetFrame, localPos, toolRadius);
            gpWorkingFramesRef.current = erased;
            onParamChangeRef.current?.("frames", erased, gpNode.id);
          } else if (gpToolRef.current === "eraser_stroke") {
            // Whole-stroke eraser: touching a line removes all of it.
            const erased = eraseStrokesAtPosition(currentFrames, targetFrame, localPos, toolRadius);
            gpWorkingFramesRef.current = erased;
            onParamChangeRef.current?.("frames", erased, gpNode.id);
          } else if (gpToolRef.current === "eraser_soft") {
            const softErased = eraseStrokesSoft(currentFrames, targetFrame, localPos, toolRadius, 0.3);
            gpWorkingFramesRef.current = softErased;
            onParamChangeRef.current?.("frames", softErased, gpNode.id);
          } else if (gpToolRef.current === "tint") {
            const activeColorHex = parseColorHex(gpNode.params.activeColor, "#38bdf8");
            const tinted = tintStrokesAtPosition(currentFrames, targetFrame, localPos, activeColorHex, toolRadius, 0.4);
            gpWorkingFramesRef.current = tinted;
            onParamChangeRef.current?.("frames", tinted, gpNode.id);
          } else {
            const settings = readGpDrawSettings(gpNode);
            const sample = collectPointerSamples(e, now)[0];
            gpPrevSampleRef.current = sample;
            gpStabilizerRef.current = createStabilizer(settings.stabilizerMode, settings.stabilizerStrength);
            gpStabilizerRef.current.begin({ x: e.clientX, y: e.clientY });
            // Origin for the straight-line / shape tools (see gpToolRef).
            gpLineAnchorRef.current = { x: e.clientX, y: e.clientY };

            gpPressureTrackerRef.current = createPressureTracker(settings.curve);
            const basePr = gpPressureTrackerRef.current.next(sample, null);
            const pressure = Math.max(0.04, Math.min(2.5, basePr * gpPressureModifierRef.current));
            gpActivePointsRef.current = [
              {
                x: localPos.x,
                y: localPos.y,
                z: localPos.z,
                pressure,
                nx: localNormal?.x,
                ny: localNormal?.y,
                nz: localNormal?.z,
              },
            ];
            gpSmoothedWorldPosRef.current = worldPos.clone();
            gpLastAppendedScreenRef.current = { x: e.clientX, y: e.clientY };
            gpLivePreviewRef.current = [{ screenX, screenY }];
            setGpLivePreview([{ screenX, screenY }]);
          }
        }
        e.stopImmediatePropagation();
        return;
      }

      if (isMarqueeModifier && (curveHandles.count() > 0 || pointsSelectionHandles.count() > 0) && !outputMode) {
        isMarqueeDragging = true;
        marqueeStartPos = { x: e.clientX, y: e.clientY };
        controls.enabled = false;
        e.stopImmediatePropagation();
      }
    }

    function onCanvasPointerMove(e: PointerEvent) {
      // A running Edit Mesh tool follows the mouse and nothing else does.
      if (editCtl.modalNodeId !== null) {
        updateEditModal(e.clientX, e.clientY, e);
        return;
      }
      if (influenceGradient) {
        const rect = renderer.domElement.getBoundingClientRect();
        const { start } = influenceGradient;
        setGradientLine({ x1: start.x, y1: start.y, x2: e.clientX - rect.left, y2: e.clientY - rect.top });
        return;
      }
      const terrainNode = selectedNodeIdRef.current
        ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && isTerrainNode(n))
        : null;

      if (terrainNode && !outputMode && host && raycaster) {
        const terrainMesh = getTerrainMeshForNode(terrainNode.id, latestResultsRef.current);
        if (terrainMesh) {
          const rect = renderer.domElement.getBoundingClientRect();
          const mouseNorm = new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1,
          );
          raycaster.setFromCamera(mouseNorm, camera);
          const intersects = raycaster.intersectObject(terrainMesh, false);

          if (intersects.length > 0) {
            const hit = intersects[0];
            const localHit = terrainMesh.worldToLocal(hit.point.clone());
            const brushRadius = Number(terrainNode.params.brushSize) || 4;

            if (terrainBrushGizmo) {
              terrainBrushGizmo.visible = true;
              terrainBrushGizmo.position.copy(hit.point);
              if (hit.face) {
                const worldNormal = hit.face.normal.clone().transformDirection(terrainMesh.matrixWorld);
                terrainBrushGizmo.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), worldNormal);
              }
              terrainBrushGizmo.scale.set(brushRadius, brushRadius, brushRadius);
            }

            if (isTerrainSculptingRef.current && terrainSculptWorkingOffsetsRef.current) {
              const brushStrength = Number(terrainNode.params.brushStrength) || 0.5;
              const tool = (terrainNode.params.brushTool as TerrainBrushTool) || terrainBrushToolRef.current;
              const falloff = (terrainNode.params.brushFalloff as TerrainBrushFalloff) || terrainBrushFalloffRef.current;

              const strokeParams: SculptStrokeParams = {
                tool,
                falloff,
                radius: brushRadius,
                strength: brushStrength,
                invert: terrainInvertRef.current || e.altKey,
                hitPoint: localHit,
                targetHeight: terrainTargetHeightRef.current ?? localHit.y,
                deltaTime: 0.016,
                maskErase: e.shiftKey,
                symmetryX: Boolean(terrainNode.params.symmetryX),
                symmetryZ: Boolean(terrainNode.params.symmetryZ),
              };

              const terrainConfig = terrainMesh.userData.terrainConfig as TerrainGridConfig;
              const heightmapPixels = terrainMesh.userData.heightmapPixels;

              applySculptStroke(
                terrainMesh.geometry,
                terrainConfig,
                heightmapPixels,
                terrainSculptWorkingOffsetsRef.current,
                strokeParams,
                terrainMaskWorkingRef.current ?? undefined,
              );
              const terrainMaskActive = hasAnyMaskWeight(terrainMaskWorkingRef.current);
              const terrainMat = terrainMesh.material as THREE.MeshStandardMaterial;
              const terrainWantsVertexColors = Boolean(terrainNode.params.slopeShading) || terrainMaskActive;
              if (terrainMat.vertexColors !== terrainWantsVertexColors) {
                terrainMat.vertexColors = terrainWantsVertexColors;
                terrainMat.needsUpdate = true;
              }
              e.stopImmediatePropagation();
              return;
            }
          } else if (!isTerrainSculptingRef.current && terrainBrushGizmo) {
            terrainBrushGizmo.visible = false;
          }
        }
      } else if (terrainBrushGizmo && terrainBrushGizmo.visible) {
        terrainBrushGizmo.visible = false;
      }

      const weightMoveNode = weightPaintNode();
      if (weightMoveNode && raycaster) {
        const hit = weightPaintHit(weightMoveNode.id, e);
        if (hit) {
          const radius = Math.max(0.001, Number(weightMoveNode.params.weightBrushSize) || 0.15);
          weightBrushGizmo.visible = true;
          weightBrushGizmo.position.copy(hit.point);
          if (hit.face) weightBrushGizmo.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), hit.face.normal.clone().transformDirection(hit.object.matrixWorld));
          weightBrushGizmo.scale.setScalar(radius);
          if (weightPainting?.nodeId === weightMoveNode.id) weightDab(weightMoveNode, hit.point, e);
        } else {
          weightBrushGizmo.visible = false;
        }
        // Off the mesh mid-stroke: still the brush's drag, not an orbit.
        if (weightPainting) {
          e.stopImmediatePropagation();
          return;
        }
      } else if (weightBrushGizmo.visible) {
        weightBrushGizmo.visible = false;
      }

      const sculptNode = selectedNodeIdRef.current
        ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && isSculptNode(n))
        : null;

      if (sculptNode && !outputMode && host && raycaster) {
        const sculptMesh = getSculptMeshForNode(sculptNode.id, latestResultsRef.current);
        if (sculptMesh) {
          const rect = renderer.domElement.getBoundingClientRect();
          const mouseNorm = new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1,
          );
          raycaster.setFromCamera(mouseNorm, camera);
          const intersects = raycaster.intersectObject(sculptMesh, false);

          if (intersects.length > 0 && intersects[0].face) {
            const hit = intersects[0];
            const localHit = sculptMesh.worldToLocal(hit.point.clone());
            const localNormal = hit.face!.normal.clone().normalize();
            const brushRadius = Number(sculptNode.params.brushSize) || 0.3;

            if (sculptBrushGizmo) {
              sculptBrushGizmo.visible = true;
              sculptBrushGizmo.position.copy(hit.point);
              const worldNormal = hit.face!.normal.clone().transformDirection(sculptMesh.matrixWorld);
              sculptBrushGizmo.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), worldNormal);
              sculptBrushGizmo.scale.set(brushRadius, brushRadius, brushRadius);
            }

            if (isSculptingRef.current && sculptWorkingMeshRef.current) {
              const brushStrength = Number(sculptNode.params.brushStrength) || 0.5;
              const tool = (sculptNode.params.brushTool as SculptBrushTool) || sculptBrushToolRef.current;
              const falloff = (sculptNode.params.brushFalloff as BrushFalloff) || sculptBrushFalloffRef.current;
              const dyntopoDetail = Math.max(0.1, Math.min(0.5, Number(sculptNode.params.dyntopoDetail) || 0.25));

              const samples = collectPointerSamples(e, performance.now());
              const usePressure = Boolean(sculptNode.params.usePressure ?? true);
              let pressure = 1.0;
              for (const s of samples) {
                const rawPressure = sculptPressureTrackerRef.current.next(s, sculptLastPressureSampleRef.current);
                pressure = usePressure && s.isPen ? Math.max(0.04, Math.min(1.0, rawPressure)) : 1.0;
                sculptLastPressureSampleRef.current = s;
              }
              const effectiveRadius = brushRadius * pressure;
              const effectiveStrength = brushStrength * pressure;
              const detailSize = effectiveRadius * dyntopoDetail;

              // Re-splitting on every pointermove is wasted work once edges
              // near the brush are already at target size — throttle to a
              // wall-clock interval and let a continuous drag converge over
              // a few calls instead of one every frame.
              let workingMesh = sculptWorkingMeshRef.current;
              let adjacency = sculptWorkingAdjacencyRef.current;
              const now = performance.now();
              if (now - sculptLastRefineTimeRef.current > 100) {
                sculptLastRefineTimeRef.current = now;
                const refined = refineNearBrush(workingMesh, localHit, effectiveRadius * 1.5, detailSize);
                if (refined !== workingMesh) {
                  workingMesh = refined;
                  adjacency = buildAdjacency(workingMesh.indices, workingMesh.positions.length / 3);
                }
              }

              const moveDelta = sculptLastHitRef.current ? localHit.clone().sub(sculptLastHitRef.current) : new THREE.Vector3();
              sculptLastHitRef.current = localHit.clone();

              const strokeParams3D: SculptStrokeParams3D = {
                tool,
                falloff,
                radius: effectiveRadius,
                strength: effectiveStrength,
                invert: sculptInvertRef.current || e.altKey,
                hitPoint: localHit,
                hitNormal: localNormal,
                strokeOrigin: sculptStrokeOriginRef.current ?? localHit,
                strokeNormal: sculptStrokeNormalRef.current ?? localNormal,
                moveDelta,
                deltaTime: 0.016,
                maskErase: e.shiftKey,
                symmetryX: Boolean(sculptNode.params.symmetryX),
                symmetryY: Boolean(sculptNode.params.symmetryY),
                symmetryZ: Boolean(sculptNode.params.symmetryZ),
              };
              applySculptStroke3D(workingMesh, adjacency, strokeParams3D);
              workingMesh.normals = computeVertexNormals(workingMesh.positions, workingMesh.indices);
              sculptWorkingMeshRef.current = workingMesh;
              sculptWorkingAdjacencyRef.current = adjacency;
              const maskActive = syncBufferGeometry(sculptMesh.geometry, workingMesh);
              const sculptMat = sculptMesh.material as THREE.MeshStandardMaterial;
              if (sculptMat.vertexColors !== maskActive) {
                sculptMat.vertexColors = maskActive;
                sculptMat.needsUpdate = true;
              }
              e.stopImmediatePropagation();
              return;
            }
          } else if (!isSculptingRef.current && sculptBrushGizmo) {
            sculptBrushGizmo.visible = false;
          }
        }
      } else if (sculptBrushGizmo && sculptBrushGizmo.visible) {
        sculptBrushGizmo.visible = false;
      }

      const texPaintNode = selectedNodeIdRef.current
        ? graphRef.current.nodes.find(
            (n) => n.id === selectedNodeIdRef.current && (isTexturePaintNode(n) || isTextureMixNode(n)),
          )
        : null;

      if (texPaintNode && !outputMode && host && raycaster) {
        const targetMeshes = getTexturePaintMeshesForNode(texPaintNode.id, graphRef.current, latestResultsRef.current);
        if (targetMeshes.length > 0) {
          const rect = renderer.domElement.getBoundingClientRect();
          const mouseNorm = new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1,
          );
          raycaster.setFromCamera(mouseNorm, camera);
          const intersects = raycaster.intersectObjects(targetMeshes, true);
          if (intersects.length > 0) {
            const hit = intersects[0];
            let uv = hit.uv ? { x: hit.uv.x, y: hit.uv.y } : null;
            if (!uv && hit.point) {
              uv = { x: ((hit.point.x % 1) + 1) % 1, y: ((hit.point.z % 1) + 1) % 1 };
            }

            const samples = collectPointerSamples(e, performance.now());
            const sample = samples[samples.length - 1];
            const usePressure = Boolean(texPaintNode.params.usePressure ?? true);
            const pressureTarget = (texPaintNode.params.pressureTarget as any) || "both";
            const basePr = texturePaintPressureTrackerRef.current.next(sample, texturePaintPrevSampleRef.current);
            texturePaintPrevSampleRef.current = sample;
            const pressure = usePressure && sample.isPen ? Math.max(0.04, Math.min(1.0, basePr)) : 1.0;
            const prevPressure = texturePaintLastPressureRef.current;
            texturePaintLastPressureRef.current = pressure;

            if (textureBrushGizmo) {
              textureBrushGizmo.visible = true;
              textureBrushGizmo.position.copy(hit.point);
              if (hit.face) {
                const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
                textureBrushGizmo.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), worldNormal);
              }
              const brushSize = Number(texPaintNode.params.brushSize) || 24;
              const effectiveBrushSize =
                usePressure && sample.isPen && (pressureTarget === "both" || pressureTarget === "size")
                  ? Math.max(1, brushSize * pressure)
                  : brushSize;
              const scaleRadius = Math.max(0.05, (effectiveBrushSize / 1024) * 5);
              textureBrushGizmo.scale.set(scaleRadius, scaleRadius, scaleRadius);
              if (isTexturePaintNode(texPaintNode)) {
                (textureBrushGizmo.material as THREE.LineBasicMaterial).color.set(
                  texturePaintStroke(texPaintNode).color,
                );
              } else {
                (textureBrushGizmo.material as THREE.LineBasicMaterial).color.set(0xf59e0b);
              }
            }

            if (isTexturePaintingRef.current && uv) {
              const resPx = isTexturePaintNode(texPaintNode)
                ? (getTexturePaintState(texPaintNode.id).canvas?.width ?? 1024)
                : (getTextureMixPaintState(texPaintNode.id).outCanvas?.width ?? 1024);
              const segments = texturePaintSegments(
                texturePaintLastUvRef.current,
                texturePaintLastScreenRef.current,
                uv,
                { x: e.clientX, y: e.clientY },
                resPx,
                Number(texPaintNode.params.brushSize) || 24,
                targetMeshes,
              );
              texturePaintLastUvRef.current = { ...uv };
              texturePaintLastScreenRef.current = { x: e.clientX, y: e.clientY };

              for (const { uv, prevUv } of segments) {
                if (isTexturePaintNode(texPaintNode)) {
                  const state = getTexturePaintState(texPaintNode.id);
                  if (state.canvas) {
                    const { tool: brushTool, color: brushColor } = texturePaintStroke(texPaintNode);
                    const brushSize = Number(texPaintNode.params.brushSize) || 24;
                    const brushOpacity = Number(texPaintNode.params.brushOpacity ?? 1.0);
                    const brushHardness = Number(texPaintNode.params.brushHardness ?? 0.5);
                    const symmetryX = Boolean(texPaintNode.params.symmetryX);

                    const res = applyPaintStroke(state.canvas, {
                      tool: brushTool,
                      color: brushColor,
                      radius: brushSize,
                      opacity: brushOpacity,
                      hardness: brushHardness,
                      uv,
                      prevUv,
                      symmetryX,
                      pressure,
                      prevPressure,
                      pressureAffects: pressureTarget,
                      p5: texturePaintP5Style(texPaintNode.params),
                    });
                    if (res.sampledColor) {
                      onParamChangeRef.current?.("brushColor", res.sampledColor, texPaintNode.id);
                    }
                    if (state.texture) state.texture.needsUpdate = true;
                  }
                } else if (isTextureMixNode(texPaintNode)) {
                  const state = getTextureMixPaintState(texPaintNode.id);
                  if (state.splatBuffer && state.outCanvas) {
                    const resPx = state.outCanvas.width;
                    const activeLayer = Number(texPaintNode.params.activeLayer) || 0;
                    const brushTool = (texPaintNode.params.brushTool as TextureMixTool) || "paint";
                    const brushSize = Number(texPaintNode.params.brushSize) || 32;
                    const brushStrength = Number(texPaintNode.params.brushStrength) || 0.8;
                    const brushFalloff = (texPaintNode.params.brushFalloff as any) || "smooth";

                    const dirty = applyMixStroke(state.splatBuffer, resPx, resPx, state.lastLayerCount || 1, {
                      tool: brushTool,
                      activeLayer,
                      radius: brushSize,
                      strength: brushStrength,
                      falloff: brushFalloff,
                      uv,
                      prevUv,
                      pressure,
                      prevPressure,
                      pressureAffects: pressureTarget,
                    });
                    // GPU pass when the renderer is up, CPU dirty-rect otherwise.
                    const composited = compositeLayersAuto(state, state.layers ?? [], {
                      renderer,
                      res: resPx,
                      layerCount: state.lastLayerCount || 1,
                      region: dirty,
                    });
                    if (composited) state.texture = composited;
                    state.splatVersion = (state.splatVersion ?? 0) + 1;
                    if (state.texture) state.texture.needsUpdate = true;
                    if (state.splatTexture) state.splatTexture.needsUpdate = true;
                  }
                }
              }
              e.stopImmediatePropagation();
              return;
            }
          } else if (!isTexturePaintingRef.current && textureBrushGizmo) {
            textureBrushGizmo.visible = false;
          }
        }
      } else if (textureBrushGizmo && textureBrushGizmo.visible) {
        textureBrushGizmo.visible = false;
      }

      // Edit Mesh marquee dragging (Shift-drag): a box, or a lasso path
      if (editMeshRectDragRef.current && host) {
        const drag = editMeshRectDragRef.current;
        drag.currentX = e.clientX;
        drag.currentY = e.clientY;
        const rect = host.getBoundingClientRect();
        if (editMeshMarqueeShapeRef.current === "lasso") {
          const last = drag.path[drag.path.length - 1];
          if (!last || Math.hypot(e.clientX - last.x, e.clientY - last.y) >= 3) {
            drag.path.push({ x: e.clientX, y: e.clientY });
            setLassoPath(drag.path.map((p) => `${p.x - rect.left},${p.y - rect.top}`).join(" "));
          }
          return;
        }
        const x1 = Math.min(drag.startX, e.clientX) - rect.left;
        const x2 = Math.max(drag.startX, e.clientX) - rect.left;
        const y1 = Math.min(drag.startY, e.clientY) - rect.top;
        const y2 = Math.max(drag.startY, e.clientY) - rect.top;
        setMarqueeBox({
          left: x1,
          top: y1,
          width: Math.max(1, x2 - x1),
          height: Math.max(1, y2 - y1),
        });
        return;
      }

      // Edit Mesh brush selection dragging (Cmd/Ctrl-drag): add what passes under it
      if (editMeshPaintDragRef.current && host) {
        const hostRect = host.getBoundingClientRect();
        setEditMeshPaintCursor({ x: e.clientX - hostRect.left, y: e.clientY - hostRect.top });
        const target = editMeshTarget();
        const picked = target ? pickEditBrush(target, e.clientX, e.clientY) : null;
        if (target && picked) {
          const next = combineSelection(target.mode, target.selection, picked, "add");
          const size = (sel: MeshSelection) => sel.points.length + sel.edges.length + sel.faces.length;
          if (size(next) !== size(target.selection)) commitEditSelection(target, next);
        }
        return;
      }

      // Edit Mesh hover and loop cut preview. Only while the pointer is over
      // *this* canvas: pointermove is heard on window, so with two editor
      // viewports mounted each one used to track hover (and draw a Loop Cut
      // preview) for a pointer in the other.
      const hoverTarget = e.target === renderer.domElement ? editMeshTarget() : null;
      if (hoverTarget && raycaster) {
        editCtl.pointer = { clientX: e.clientX, clientY: e.clientY };
        const { quadMesh, srcMesh } = hoverTarget;
        const { rect, ndc } = canvasPoint(e.clientX, e.clientY);
        raycaster.setFromCamera(ndc, camera);

        if (hoverTarget.node.type === EDIT_MESH_NODE.type && editMeshToolRef.current === "loopcut") {
          const edge = editMeshHandles.pickEdge(ndc, camera, rect.width, rect.height, quadMesh, srcMesh.matrixWorld);
          const prev = editMeshHoverEdgeRef.current;
          const sameEdge = Boolean(edge && prev && edge[0] === prev[0] && edge[1] === prev[1]);
          editMeshHoverEdgeRef.current = edge;
          // A new preview array on every mousemove would rebuild the
          // overlay each time; keep it while the hovered edge is the same.
          if (!sameEdge) {
            editMeshPreviewLoopRef.current = edge
              ? getLoopCutPreviewSegments(quadMesh, edge, editMeshLoopCutsRef.current)
              : null;
          }
          editMeshHoverFaceRef.current = null;
        } else {
          editMeshPreviewLoopRef.current = null;
          // The edge an edge click — or, with Alt held, a loop — would start from.
          const edgeHover = hoverTarget.mode === "edges" || e.altKey;
          const edge = edgeHover
            ? editMeshHandles.pickEdge(ndc, camera, rect.width, rect.height, quadMesh, srcMesh.matrixWorld)
            : null;
          const prev = editMeshHoverEdgeRef.current;
          if (!(edge && prev && edge[0] === prev[0] && edge[1] === prev[1])) editMeshHoverEdgeRef.current = edge;
          editMeshHoverFaceRef.current =
            hoverTarget.mode === "faces" && !e.altKey ? editMeshHandles.pickFace(raycaster, quadMesh, srcMesh.matrixWorld, { widthPx: rect.width, heightPx: rect.height })
              : null;
        }
      } else {
        editCtl.pointer = null;
        editMeshHoverEdgeRef.current = null;
        editMeshPreviewLoopRef.current = null;
        editMeshHoverFaceRef.current = null;
      }

      const gpNode = selectedNodeIdRef.current
        ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && isPaintOrGreaseNode(n))
        : null;

      // Dragging a lasso selection around.
      if (gpSelectionDragRef.current && gpNode) {
        const drag = gpSelectionDragRef.current;
        const invMatrix = getGpInverseMatrix(gpNode, latestResultsRef.current);
        const from = resolvePointerPoint(
          drag.lastX, drag.lastY, gpNode, graphRef.current, latestResultsRef.current, camera, renderer.domElement, mode2D,
        );
        const to = resolvePointerPoint(
          e.clientX, e.clientY, gpNode, graphRef.current, latestResultsRef.current, camera, renderer.domElement, mode2D,
        );
        if (from?.pos && to?.pos) {
          const a = from.pos.clone().applyMatrix4(invMatrix);
          const b = to.pos.clone().applyMatrix4(invMatrix);
          const frames = gpWorkingFramesRef.current || ((gpNode.params.frames as KeyframeDrawing[]) || []);
          const targetFrame = currentFrameRef.current >= 0 ? currentFrameRef.current : 0;
          const moved = translateStrokes(frames, targetFrame, gpSelectedStrokeIdsRef.current, {
            x: b.x - a.x,
            y: b.y - a.y,
            z: b.z - a.z,
          });
          gpWorkingFramesRef.current = moved;
          onParamChangeRef.current?.("frames", moved, gpNode.id);
        }
        drag.lastX = e.clientX;
        drag.lastY = e.clientY;
        return;
      }

      // Freehand lasso path (select / carve).
      if (isGpDrawingRef.current && gpNode && GP_LASSO_TOOLS.has(gpToolRef.current)) {
        const last = gpLassoPointsRef.current[gpLassoPointsRef.current.length - 1];
        if (!last || Math.hypot(e.clientX - last.x, e.clientY - last.y) > 2) {
          gpLassoPointsRef.current = [...gpLassoPointsRef.current, { x: e.clientX, y: e.clientY }];
          setGpLassoPreview(gpLassoPointsRef.current);
        }
        return;
      }

      // Shape tools rebuild their whole outline from anchor to cursor.
      if (isGpDrawingRef.current && gpNode && GP_SHAPE_TOOLS.has(gpToolRef.current) && gpLineAnchorRef.current) {
        const invMatrix = getGpInverseMatrix(gpNode, latestResultsRef.current);
        const shape = buildShapePoints(
          gpToolRef.current as ShapeKind,
          gpLineAnchorRef.current,
          { x: e.clientX, y: e.clientY },
          {
            constrain: e.shiftKey || Boolean(e.getModifierState && e.getModifierState("Shift")),
            fromCenter: Boolean(e.getModifierState && e.getModifierState("Control")),
            flip: Boolean(e.getModifierState && e.getModifierState("Alt")),
          },
        );
        setGpStrokeFromScreenPoints(gpNode, shape, invMatrix, 0.8);
        return;
      }

      // Polyline: preview the segment running to the cursor.
      if (gpNode && gpToolRef.current === "polyline" && gpPolylineVerticesRef.current.length > 0) {
        const invMatrix = getGpInverseMatrix(gpNode, latestResultsRef.current);
        setGpStrokeFromScreenPoints(
          gpNode,
          buildPolylinePoints(gpPolylineVerticesRef.current, { x: e.clientX, y: e.clientY }),
          invMatrix,
          0.75,
        );
        return;
      }

      if (isGpDrawingRef.current && gpNode && host) {
        const rect = renderer.domElement.getBoundingClientRect();
        const now = performance.now();

        const ptData = resolvePointerPoint(
          e.clientX,
          e.clientY,
          gpNode,
          graphRef.current,
          latestResultsRef.current,
          camera,
          renderer.domElement,
          mode2D,
        );
        const worldPos = ptData?.pos ?? null;

        if (worldPos) {
          const invMatrix = getGpInverseMatrix(gpNode, latestResultsRef.current);
          const localPos = worldPos.clone().applyMatrix4(invMatrix);
          const currentFrames = gpWorkingFramesRef.current || (gpNode.params.frames as KeyframeDrawing[]) || [];
          const targetFrame = currentFrameRef.current >= 0 ? currentFrameRef.current : 0;
          const bSize = Number(gpNode.params.brushSize) || 4;
          const toolRadius = Math.max(0.85, bSize * 0.1);
          if (gpToolRef.current === "eraser_hard") {
            const erased = eraseStrokesCut(currentFrames, targetFrame, localPos, toolRadius);
            gpWorkingFramesRef.current = erased;
            onParamChangeRef.current?.("frames", erased, gpNode.id);
          } else if (gpToolRef.current === "eraser_soft") {
            const softErased = eraseStrokesSoft(currentFrames, targetFrame, localPos, toolRadius, 0.25);
            gpWorkingFramesRef.current = softErased;
            onParamChangeRef.current?.("frames", softErased, gpNode.id);
          } else if (gpToolRef.current === "tint") {
            const activeColorHex = parseColorHex(gpNode.params.activeColor, "#38bdf8");
            const tinted = tintStrokesAtPosition(currentFrames, targetFrame, localPos, activeColorHex, toolRadius, 0.35);
            gpWorkingFramesRef.current = tinted;
            onParamChangeRef.current?.("frames", tinted, gpNode.id);
          } else {
            const isShift = e.shiftKey || Boolean(e.getModifierState && e.getModifierState("Shift"));
            const isCtrl = Boolean(e.getModifierState && e.getModifierState("Control"));
            const targetMod = isShift ? 0.35 : isCtrl ? 1.85 : 1.0;
            gpPressureModifierRef.current = THREE.MathUtils.lerp(gpPressureModifierRef.current, targetMod, 0.12);

            const settings = readGpDrawSettings(gpNode);
            if (!gpStabilizerRef.current) {
              gpStabilizerRef.current = createStabilizer(settings.stabilizerMode, settings.stabilizerStrength);
              gpStabilizerRef.current.begin({ x: e.clientX, y: e.clientY });
            }
            if (!gpPressureTrackerRef.current) {
              gpPressureTrackerRef.current = createPressureTracker(settings.curve);
            }

            // One pointermove carries every sample the tablet reported since
            // the last frame. Replaying them all is what keeps fast strokes
            // faithful instead of turning them into long straight chords.
            const samples = collectPointerSamples(e, now);
            // Only decimate far past what any tablet reports per frame; the
            // per-pixel dedup in appendGpStrokePoint is the real throttle, and
            // it never discards motion the way a fixed stride does.
            const maxSamples = 64;
            const stride = Math.max(1, Math.ceil(samples.length / maxSamples));
            const isPaintOnGeo = gpNode.type === PAINT_ON_GEOMETRY_NODE.type;

            for (let i = 0; i < samples.length; i++) {
              if (stride > 1 && i % stride !== 0 && i !== samples.length - 1) continue;
              const sample = samples[i];
              const basePr = gpPressureTrackerRef.current.next(sample, gpPrevSampleRef.current);
              const pressure = Math.max(0.04, Math.min(2.5, basePr * gpPressureModifierRef.current));

              // Pen speed in px/ms drives how much the stabilizer relaxes, so
              // a fast flick tracks the hand instead of trailing behind it.
              const prevSample = gpPrevSampleRef.current;
              const speed = prevSample
                ? Math.hypot(sample.x - prevSample.x, sample.y - prevSample.y) /
                  Math.max(1, sample.time - prevSample.time)
                : 0;
              const stabilized = gpStabilizerRef.current.push({ x: sample.x, y: sample.y }, speed);

              // Paint on geometry still sub-steps across wide gaps so strokes
              // wrap around curved surfaces instead of skipping over them.
              const prevScreen = gpPrevPointerRef.current;
              if (isPaintOnGeo && prevScreen) {
                const dx = stabilized.x - rect.left - prevScreen.x;
                const dy = stabilized.y - rect.top - prevScreen.y;
                const gap = Math.hypot(dx, dy);
                if (gap > 8) {
                  const steps = Math.min(6, Math.floor(gap / 6));
                  for (let s = 1; s < steps; s++) {
                    const t = s / steps;
                    appendGpStrokePoint(
                      gpNode,
                      { x: stabilized.x - (1 - t) * dx, y: stabilized.y - (1 - t) * dy },
                      pressure,
                      invMatrix,
                    );
                  }
                }
              }

              appendGpStrokePoint(gpNode, stabilized, pressure, invMatrix, tiltToBrushAngle(sample));
              gpPrevPointerRef.current = {
                x: stabilized.x - rect.left,
                y: stabilized.y - rect.top,
                time: sample.time,
              };
              gpPrevSampleRef.current = sample;
            }
            flushGpLivePreview();
          }
        }
        return;
      }

      if (isMarqueeDragging && marqueeStartPos && host) {
        const rect = host.getBoundingClientRect();
        const x1 = Math.min(marqueeStartPos.x, e.clientX) - rect.left;
        const x2 = Math.max(marqueeStartPos.x, e.clientX) - rect.left;
        const y1 = Math.min(marqueeStartPos.y, e.clientY) - rect.top;
        const y2 = Math.max(marqueeStartPos.y, e.clientY) - rect.top;
        setMarqueeBox({
          left: x1,
          top: y1,
          width: Math.max(1, x2 - x1),
          height: Math.max(1, y2 - y1),
        });
      }
    }

    function onCanvasPointerUp(e: PointerEvent) {
      if (influenceGradient) {
        const { nodeId, start } = influenceGradient;
        influenceGradient = null;
        pointerDownAt = null;
        controls.enabled = true;
        setGradientLine(null);
        const rect = renderer.domElement.getBoundingClientRect();
        const end = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        if (e.type === "pointerup" && Math.hypot(end.x - start.x, end.y - start.y) > CLICK_MOVE_THRESHOLD_PX) {
          applyInfluenceGradientLine(nodeId, start, end, rect);
        }
        return;
      }
      if (weightPainting) {
        const { nodeId } = weightPainting;
        weightPainting = null;
        pointerDownAt = null;
        controls.enabled = true;
        const stored = skinStoredPaint(nodeId);
        if (stored) onParamChangeRef.current?.("weightPaint", stored, nodeId, { coalesce: false });
        return;
      }
      if (editMeshPaintDragRef.current) {
        editMeshPaintDragRef.current = false;
        setEditMeshPaintCursor(null);
        controls.enabled = true;
        return;
      }

      if (editMeshRectDragRef.current) {
        const drag = editMeshRectDragRef.current;
        editMeshRectDragRef.current = null;
        setMarqueeBox(null);
        setLassoPath(null);
        controls.enabled = true;

        const target = editMeshTarget();
        if (target) {
          const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
          if (dist > CLICK_MOVE_THRESHOLD_PX) {
            // Box or lasso: replaces the selection, or adds to it with an
            // extra modifier held at release.
            const { rect } = canvasPoint(0, 0);
            const local = (p: { x: number; y: number }) => ({ x: p.x - rect.left, y: p.y - rect.top });
            const region =
              editMeshMarqueeShapeRef.current === "lasso" && drag.path.length >= 3
                ? polygonRegion([...drag.path, { x: e.clientX, y: e.clientY }].map(local))
                : rectRegion(
                    Math.min(drag.startX, e.clientX) - rect.left,
                    Math.min(drag.startY, e.clientY) - rect.top,
                    Math.max(drag.startX, e.clientX) - rect.left,
                    Math.max(drag.startY, e.clientY) - rect.top,
                  );
            const accumulate = e.altKey || e.ctrlKey || e.metaKey;
            applyEditPick(target, pickEditRegion(target, region), accumulate ? "add" : "replace");
          } else {
            // Shift-click toggles the element under the cursor
            applyEditPick(target, pickEditElement(target, e.clientX, e.clientY), "toggle");
          }
        }
        return;
      }

      if (isTerrainSculptingRef.current) {
        isTerrainSculptingRef.current = false;
        controls.enabled = true;
        const terrainNode = selectedNodeIdRef.current
          ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && isTerrainNode(n))
          : null;
        if (terrainNode && terrainSculptWorkingOffsetsRef.current) {
          onParamChangeRef.current?.(
            {
              sculptOffsets: { ...terrainSculptWorkingOffsetsRef.current },
              maskWeights: { ...(terrainMaskWorkingRef.current ?? {}) },
            },
            terrainNode.id,
            undefined,
            { coalesce: false },
          );
        }
        terrainSculptWorkingOffsetsRef.current = null;
        terrainMaskWorkingRef.current = null;
        terrainTargetHeightRef.current = null;
        return;
      }

      if (isSculptingRef.current) {
        isSculptingRef.current = false;
        controls.enabled = true;
        const sculptNode = selectedNodeIdRef.current
          ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && isSculptNode(n))
          : null;
        if (sculptNode && sculptWorkingMeshRef.current) {
          const mesh = sculptWorkingMeshRef.current;
          onParamChangeRef.current?.(
            "sculptMesh",
            {
              positions: Array.from(mesh.positions),
              indices: Array.from(mesh.indices),
              mask: mesh.mask ? Array.from(mesh.mask) : undefined,
            },
            sculptNode.id,
            { coalesce: false },
          );
        }
        sculptWorkingMeshRef.current = null;
        sculptWorkingAdjacencyRef.current = [];
        sculptStrokeOriginRef.current = null;
        sculptStrokeNormalRef.current = null;
        sculptLastHitRef.current = null;
        return;
      }

      if (isTexturePaintingRef.current) {
        isTexturePaintingRef.current = false;
        controls.enabled = true;
        texturePaintLastUvRef.current = null;
        texturePaintLastScreenRef.current = null;
        const node = selectedNodeIdRef.current
          ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current)
          : null;
        if (node && isTexturePaintNode(node)) {
          const paintState = getTexturePaintState(node.id);
          if (paintState.canvas && endBrushPaint(paintState.canvas) && paintState.texture) {
            paintState.texture.needsUpdate = true;
          }
        }
        // Encoding a 1024² map is expensive enough to be felt, and a working
        // pass is dozens of short strokes. Coalesce them: the buffer in memory
        // is the live one, the param only has to catch up before a save.
        if (node) scheduleTextureSnapshot(node.id);
        return;
      }

      const gpNode = selectedNodeIdRef.current
        ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && isPaintOrGreaseNode(n))
        : null;

      // End of a lasso-selection drag.
      if (gpSelectionDragRef.current) {
        gpSelectionDragRef.current = null;
        gpWorkingFramesRef.current = null;
        controls.enabled = true;
        refreshGpSelectionOverlay(gpNode ?? null);
        return;
      }

      // Lasso released: select the enclosed strokes, or carve them away.
      if (isGpDrawingRef.current && gpNode && GP_LASSO_TOOLS.has(gpToolRef.current)) {
        isGpDrawingRef.current = false;
        setIsGpDrawing(false);
        controls.enabled = true;

        const polygon = gpLassoPointsRef.current;
        gpLassoPointsRef.current = [];
        setGpLassoPreview([]);

        if (polygon.length >= 3) {
          const frames = (gpNode.params.frames as KeyframeDrawing[]) || [];
          const targetFrame = currentFrameRef.current >= 0 ? currentFrameRef.current : 0;
          const projector = makeGpProjector(gpNode);

          if (gpToolRef.current === "lasso") {
            const drawing = resolveActiveDrawing(frames, targetFrame);
            const mode = e.shiftKey || Boolean(e.getModifierState && e.getModifierState("Shift"))
              ? "enclose"
              : "touch";
            const picked = selectStrokesInLasso(drawing?.strokes ?? [], polygon, projector, mode);
            gpSelectedStrokeIdsRef.current = new Set(picked);
            refreshGpSelectionOverlay(gpNode);
            setGpToolHint(
              picked.length > 0
                ? `${picked.length} stroke${picked.length > 1 ? "s" : ""} selected — drag to move, ⌫ to delete`
                : null,
            );
          } else {
            // Carve: the lasso has to exist in drawing space too, so a hole
            // punched in a filled shape lands in the right place.
            const invMatrix = getGpInverseMatrix(gpNode, latestResultsRef.current);
            const localPolygon: StrokePoint[] = [];
            for (const sp of polygon) {
              const hit = resolvePointerPoint(
                sp.x, sp.y, gpNode, graphRef.current, latestResultsRef.current, camera, renderer.domElement, mode2D,
              );
              if (!hit?.pos) continue;
              const local = hit.pos.clone().applyMatrix4(invMatrix);
              localPolygon.push({ x: local.x, y: local.y, z: local.z, pressure: 0.6 });
            }
            const carved = carveStrokesWithLasso(frames, targetFrame, polygon, projector, localPolygon);
            if (carved !== frames) onParamChangeRef.current?.("frames", carved, gpNode.id);
          }
        }
        return;
      }

      // Shape tools commit the outline they previewed.
      if (isGpDrawingRef.current && gpNode && GP_SHAPE_TOOLS.has(gpToolRef.current)) {
        isGpDrawingRef.current = false;
        setIsGpDrawing(false);
        controls.enabled = true;
        const tool = gpToolRef.current;
        const points = gpActivePointsRef.current;
        gpActivePointsRef.current = [];
        gpLivePreviewRef.current = [];
        setGpLivePreview([]);
        gpLineAnchorRef.current = null;

        const closed = tool === "rect" || tool === "ellipse";
        if (points.length >= 2) {
          commitGpStroke(gpNode, points, { closed, fill: closed ? gpSolidFillRef.current : false });
        }
        return;
      }

      // Polyline stays armed across clicks; nothing to do on release.
      if (gpToolRef.current === "polyline") {
        controls.enabled = true;
        return;
      }

      if (isGpDrawingRef.current) {
        isGpDrawingRef.current = false;
        setIsGpDrawing(false);
        controls.enabled = true;
        setGpLivePreview([]);
        gpLivePreviewRef.current = [];

        // Drain the stabilizer's lag into the stroke so the line actually
        // reaches where the pen was lifted (Krita's "finish line").
        if (gpToolRef.current === "pen" && gpStabilizerRef.current && gpNode) {
          const tail = gpStabilizerRef.current.finish({ x: e.clientX, y: e.clientY });
          if (tail.length > 0) {
            const invMatrix = getGpInverseMatrix(gpNode, latestResultsRef.current);
            const lastPressure = gpActivePointsRef.current[gpActivePointsRef.current.length - 1]?.pressure ?? 0.6;
            for (let i = 0; i < tail.length; i++) {
              // Thin the catch-up tail out the way a real pen lifts off:
              // holding full width over the drained lag left an ink blob.
              const t = (i + 1) / tail.length;
              appendGpStrokePoint(gpNode, tail[i], lastPressure * (1 - 0.55 * t), invMatrix);
            }
          }
        }
        gpStabilizerRef.current = null;
        gpPrevSampleRef.current = null;
        gpLastAppendedScreenRef.current = null;
        gpLineAnchorRef.current = null;
        gpPrevPointerRef.current = null;
        setGpLivePreview([]);
        gpLivePreviewRef.current = [];

        if (gpToolRef.current === "pen" && gpActivePointsRef.current.length >= 1 && gpNode) {
          if (gpActivePointsRef.current.length === 1) {
            const p = gpActivePointsRef.current[0];
            gpActivePointsRef.current.push({ x: p.x + 0.002, y: p.y, z: p.z + 0.002, pressure: p.pressure });
          }
          const usedHardwarePressure = gpPressureTrackerRef.current?.usedHardware() ?? false;
          gpPressureTrackerRef.current = null;

          const taperStart = gpShiftAtStartRef.current;
          // Without a stylus reporting the lift-off, the stroke has to end
          // itself: velocity-simulated pressure always reads the hand's final
          // deceleration as "pressing harder".
          const taperEnd =
            !usedHardwarePressure || e.shiftKey || Boolean(e.getModifierState && e.getModifierState("Shift"));
          const widenStart = gpCtrlAtStartRef.current;
          const widenEnd = Boolean(e.getModifierState && e.getModifierState("Control"));
          gpShiftAtStartRef.current = false;
          gpCtrlAtStartRef.current = false;

          // Collapse the pile of samples left by the hand dwelling before the
          // pen came up; it renders as a blob at the stroke's tip.
          const strokeRadius = (Number(gpNode.params.brushSize) || 4) * 0.02;
          gpActivePointsRef.current = trimStrokeDwellTail(gpActivePointsRef.current, strokeRadius * 1.5);

          // The stabilizer already filtered the input live, and the ribbon
          // builder resamples onto a spline. Running the old post-pass at full
          // strength on top of both is what rounded off fast strokes, so it is
          // scaled back to a finishing touch whenever a stabilizer ran.
          const rawSmoothing = Math.max(0, Math.min(1, Number(gpNode.params.smoothing ?? 0.2)));
          const stabilizerActive = readGpDrawSettings(gpNode).stabilizerMode !== "none";
          const smoothing = stabilizerActive ? rawSmoothing * 0.35 : rawSmoothing;
          const smoothedPoints = smoothStrokePoints(gpActivePointsRef.current, smoothing);

          const finalPoints = (taperStart || taperEnd || widenStart || widenEnd)
            ? applyStrokeTaper(smoothedPoints, taperStart, taperEnd, widenStart, widenEnd)
            : smoothedPoints;
          const strokeColor = parseColorHex(gpNode.params.activeColor, "#38bdf8");
          const customFillColor = parseColorHex(gpNode.params.fillColor, "");
          const fillColorVal = customFillColor || strokeColor;

          const newStroke: GreaseStroke = {
            id: `stroke_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            points: finalPoints,
            color: strokeColor,
            width: Number(gpNode.params.brushSize) || 4,
            brushType: gpBrushTypeRef.current,
            fill: gpSolidFillRef.current,
            fillColor: gpSolidFillRef.current ? fillColorVal : undefined,
          };

          const currentFrames = (gpNode.params.frames as KeyframeDrawing[]) || [];
          const targetFrame = currentFrameRef.current >= 0 ? currentFrameRef.current : 0;
          const nextFrames = addStrokeToFrames(currentFrames, targetFrame, newStroke);
          onParamChangeRef.current?.("frames", nextFrames, gpNode.id);
        }
        gpActivePointsRef.current = [];
        gpWorkingFramesRef.current = null;
        return;
      }
      if (isMarqueeDragging) {
        isMarqueeDragging = false;
        setMarqueeBox(null);
        controls.enabled = true;

        if (marqueeStartPos) {
          const rect = renderer.domElement.getBoundingClientRect();
          const minX = Math.min(marqueeStartPos.x, e.clientX) - rect.left;
          const maxX = Math.max(marqueeStartPos.x, e.clientX) - rect.left;
          const minY = Math.min(marqueeStartPos.y, e.clientY) - rect.top;
          const maxY = Math.max(marqueeStartPos.y, e.clientY) - rect.top;

          if (Math.hypot(e.clientX - marqueeStartPos.x, e.clientY - marqueeStartPos.y) > CLICK_MOVE_THRESHOLD_PX) {
            if (pointsSelectionHandles.count() > 0) {
              const picked = pointsSelectionHandles.pickRect({ minX, minY, maxX, maxY }, camera, rect.width, rect.height);
              if (e.shiftKey) {
                picked.forEach((idx) => selectedPointsSelectionIndices.add(idx));
              } else {
                selectedPointsSelectionIndices = new Set(picked);
              }
              commitPointsSelection();
            } else {
              const picked = curveHandles.pickRect({ minX, minY, maxX, maxY }, camera, rect.width, rect.height);
              if (e.shiftKey) {
                picked.forEach((idx) => selectedPointIndices.add(idx));
              } else {
                selectedPointIndices = new Set(picked);
              }
            }
            pointerDownAt = null;
            return;
          }
        }
      }

      const down = pointerDownAt;
      pointerDownAt = null;
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      if (!down || !onSelectNodeRef.current || !raycaster) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_MOVE_THRESHOLD_PX) return;

      // A selected Roto Mask is an editing mode, like painting: the clicks
      // belong to its palette (shapes are picked and drawn on the very image
      // that would otherwise take the selection). Pick another node in the
      // graph to leave it.
      const selectedForClick = selectedNodeIdRef.current
        ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current)
        : null;
      if (selectedForClick?.type === "mask/roto") return;

      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      raycaster.params.Line = { threshold: 0.3 };
      raycaster.params.Points = { threshold: 0.3 };

      // Face Selection editing: Shift+left selects the face under the cursor,
      // Shift+right deselects it — but only when the hit lands on the mesh
      // feeding the selected Face Selection node (so a click on the extruded
      // tree sitting on that mesh is still just a normal object click).
      if (!outputMode && faceSelectionNodeId && e.shiftKey && (e.button === 0 || e.button === 2)) {
        // Same walk as the object-picking raycast below: an ancestor being
        // hidden has to disqualify the hit even when the tagged node itself
        // is visible, so the whole chain is checked rather than stopping at
        // the first nodeId. (The green overlay carries no nodeId at all, so
        // it can never steal the click meant for the face under it.)
        const hit = raycaster
          ? raycaster.intersectObjects(scene.children, true).find((i) => {
              let curr: THREE.Object3D | null = i.object;
              let taggedNode = false;
              while (curr) {
                if (curr.visible === false) return false;
                if (curr.userData?.nodeId) taggedNode = true;
                curr = curr.parent;
              }
              return taggedNode;
            })
          : undefined;
        if (hit && faceSelectionSourceNodeId && typeof hit.faceIndex === "number") {
          let hitNodeId: string | null = null;
          let curr: THREE.Object3D | null = hit.object;
          while (curr) {
            if (curr.userData?.nodeId) {
              hitNodeId = curr.userData.nodeId;
              break;
            }
            curr = curr.parent;
          }
          if (hitNodeId === faceSelectionSourceNodeId) {
            // faceIndex is the triangle number, matching the selection's own
            // per-face order on the source geometry.
            const face = hit.faceIndex;
            if (e.button === 0) selectedFacesSet.add(face);
            else selectedFacesSet.delete(face);
            commitFaceSelection();
            return;
          }
        }
      }

      // Edit Mesh interaction: points/faces selection & loop cut
      const activeEditMesh = !outputMode && selectedNodeIdRef.current
        ? findEditMeshNode(graphRef.current, selectedNodeIdRef.current, true)
        : null;
      if (activeEditMesh) {
        const meshObj = latestResultsRef.current?.get(activeEditMesh.id)?.geometry;
        const srcMesh = meshObj instanceof THREE.Object3D ? findFirstMesh(meshObj) : null;
        if (srcMesh) {
          const quadMesh: QuadMesh =
            editMeshQuadMesh(activeEditMesh, latestResultsRef.current, srcMesh);

          if (activeEditMesh.type === EDIT_MESH_NODE.type && editMeshToolRef.current === "loopcut") {
            const edge = editMeshHandles.pickEdge(ndc, camera, rect.width, rect.height, quadMesh, srcMesh.matrixWorld);
            if (edge) {
              editMeshPreviewLoopRef.current = null;
              editMeshHoverEdgeRef.current = null;
              setEditMeshTool("select");
              // One cut: slide it along the ring with the mouse before it's
              // placed (Blender's Loop Cut and Slide). Several: evenly spaced.
              const slideTarget = editMeshLoopCutsRef.current === 1 ? editMeshTarget() : null;
              if (slideTarget && startEditModal("loopslide", slideTarget, e.clientX, e.clientY, { edge, startValue: 0.5 })) {
                return;
              }
              const res = loopCut(quadMesh, edge, editMeshLoopCutsRef.current);
              onParamChangeRef.current?.(
                {
                  meshData: res.mesh,
                  selectMode: "edges",
                  selectedEdges: res.newEdgeIndices.map(([a, b]) => (a < b ? [a, b] : [b, a])),
                },
                activeEditMesh.id,
              );
              return;
            }
            // A click that misses every edge is a selection click: disarm
            // the tool rather than change the selection silently while the
            // gizmo stays withheld.
            editMeshPreviewLoopRef.current = null;
            editMeshHoverEdgeRef.current = null;
            setEditMeshTool("select");
          }

          const target = editMeshTarget();
          if (target) {
            // Alt+click: the loop through the edge under the cursor;
            // Cmd/Ctrl+Alt+click: its ring. Shift adds to the selection.
            if (e.altKey) {
              const loop = pickEditLoop(target, e.clientX, e.clientY, e.ctrlKey || e.metaKey);
              if (applyEditPick(target, loop, e.shiftKey ? "add" : "replace")) return;
            } else if (applyEditPick(target, pickEditElement(target, e.clientX, e.clientY), e.shiftKey ? "toggle" : "replace")) {
              return;
            }
          }

          // If click did not hit any point or face, check what was clicked
          const gizmoHelper = transformControls?.getHelper();
          const isGizmoHit = Boolean(
            transformControls?.axis !== null ||
            (gizmoHelper && raycaster.intersectObjects(
              gizmoHelper.children.filter((c: any) => !c.isTransformControlsPlane),
              true,
            ).some((h) => h.object.visible !== false && !(h.object as any).isTransformControlsPlane))
          );
          if (isGizmoHit) return;

          // Find the frontmost visible object hit by the raycast
          let frontHitNodeId: string | null = null;
          if (raycaster) {
            const hits = raycaster.intersectObjects(scene.children, true);
            for (const hit of hits) {
              let curr: THREE.Object3D | null = hit.object;
              let isVisible = true;
              while (curr) {
                if (curr.visible === false) {
                  isVisible = false;
                  break;
                }
                curr = curr.parent;
              }
              if (!isVisible) continue;

              curr = hit.object;
              while (curr) {
                if (curr.userData?.nodeId) {
                  frontHitNodeId = curr.userData.nodeId;
                  break;
                }
                curr = curr.parent;
              }
              break;
            }
          }

          const isUpstreamBasis = Boolean(
            frontHitNodeId &&
            activeEditMesh.type === EDIT_MESH_POINTS_NODE.type &&
            graphRef.current.connections.some(
              (c) => c.toNode === activeEditMesh.id && c.toSocket === "basis" && c.fromNode === frontHitNodeId,
            )
          );

          const hitActiveMesh = frontHitNodeId === activeEditMesh.id || isUpstreamBasis;
          const hitOtherNode = frontHitNodeId !== null && !hitActiveMesh;

          if (!hitOtherNode && !e.shiftKey) {
            // Clicked empty space or clicked active mesh surface outside of points/faces:
            // clear element selection, keep EditMesh node selected!
            if (target) commitEditSelection(target, emptySelection());
            return;
          }
        }
      }

      // A Skin node's joints, same reason: they sit inside the mesh they weigh.
      if (skinJointHandles.count() > 0) {
        const pickedJoint = skinJointHandles.pick(ndc, camera, rect.width, rect.height);
        const skinNodeId = selectedNodeIdRef.current;
        if (pickedJoint !== null && skinNodeId && onTransformChangeRef.current) {
          onTransformChangeRef.current(skinNodeId, { selectedJoint: pickedJoint, showWeights: true } as TransformPatch);
          return;
        }
      }
      // Curve control points win over whatever is behind them — a handle sits
      // on (or inside) the very mesh it shapes, so a raycast against the scene
      // would swallow every click meant for one. tick() does the actual gizmo
      // attach off this index, so it survives the next frame's re-evaluation.
      if (curveHandles.count() > 0) {
        const pickedIdx = curveHandles.pick(ndc, camera, rect.width, rect.height);
        if (pickedIdx !== null) {
          if (e.shiftKey) {
            if (selectedPointIndices.has(pickedIdx)) {
              selectedPointIndices.delete(pickedIdx);
            } else {
              selectedPointIndices.add(pickedIdx);
            }
          } else {
            selectedPointIndices = new Set([pickedIdx]);
          }
          return;
        }
      }
      if (pointsSelectionHandles.count() > 0) {
        const pickedIdx = pointsSelectionHandles.pick(ndc, camera, rect.width, rect.height);
        if (pickedIdx !== null) {
          if (e.shiftKey) {
            if (selectedPointsSelectionIndices.has(pickedIdx)) {
              selectedPointsSelectionIndices.delete(pickedIdx);
            } else {
              selectedPointsSelectionIndices.add(pickedIdx);
            }
          } else {
            selectedPointsSelectionIndices = new Set([pickedIdx]);
          }
          commitPointsSelection();
          return;
        }
        // Missed every handle: clear the selection and fall through to the
        // generic scene raycast below, same as curve editing does — a click
        // on empty space (or another object) shouldn't trap the operator in
        // Points Selection mode.
        if (selectedPointsSelectionIndices.size > 0) {
          selectedPointsSelectionIndices.clear();
          commitPointsSelection();
        }
      }
      // Clicking anywhere else drops the point and hands the gizmo back to
      // the object.
      selectedPointIndices.clear();

      // A speaker icon is clickable too: it is drawn over everything, so it wins over what lies behind it.
      if (raycaster && soundIcons.size > 0) {
        const iconHit = raycaster.intersectObjects(soundIconGroup.children, false)[0];
        const iconId = iconHit?.object.userData.soundNodeId as string | undefined;
        if (iconId) {
          onSelectNodeRef.current(iconId);
          return;
        }
      }

      // three's Raycaster hits invisible objects too — it only skips them if
      // you filter yourself — so a hidden object would otherwise still be
      // clickable, and would steal clicks from whatever is visible behind it.
      const hit = raycaster
        ? raycaster.intersectObjects(scene.children, true).find((i) => {
            let curr: THREE.Object3D | null = i.object;
            let taggedNode = false;
            while (curr) {
              if (curr.visible === false) return false;
              if (curr.userData?.nodeId) taggedNode = true;
              curr = curr.parent;
            }
            return taggedNode;
          })
        : undefined;

      onSelectNodeRef.current(hit ? selectableNodeIdFor(hit.object, graphRef.current) : null);
    }

    const onCanvasWheel = (e: WheelEvent) => {
      // Mid-drag with proportional editing: the wheel resizes the influence
      // (Blender's page up / down), updating the drag at once.
      if (
        transformControls?.dragging &&
        transformControls.object === editMeshCentroidProxy &&
        editCtl.wheelDuringDrag(editMeshCentroidProxy, e.deltaY)
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (wheelEditModal(e.deltaY)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      const activeEditMesh = selectedNodeIdRef.current
        ? findEditMeshNode(graphRef.current, selectedNodeIdRef.current, false)
        : null;
      if (activeEditMesh && editMeshToolRef.current === "loopcut") {
        // Registered in the capture phase and stopped *immediately*: orbit
        // controls listen for wheel on this same canvas, registered first, so
        // a plain stopPropagation still let every notch zoom the camera too.
        e.preventDefault();
        e.stopImmediatePropagation();
        const delta = e.deltaY < 0 ? 1 : -1;
        const nextCuts = Math.max(1, Math.min(32, editMeshLoopCutsRef.current + delta));
        if (nextCuts !== editMeshLoopCutsRef.current) {
          editMeshLoopCutsRef.current = nextCuts;
          setEditMeshLoopCuts(nextCuts);
          if (editMeshHoverEdgeRef.current) {
            const meshObj = latestResultsRef.current?.get(activeEditMesh.id)?.geometry;
            const srcMesh = meshObj instanceof THREE.Object3D ? findFirstMesh(meshObj) : null;
            if (srcMesh) {
              const quadMesh: QuadMesh = resolveEditMeshData(activeEditMesh, latestResultsRef.current);
              editMeshPreviewLoopRef.current = getLoopCutPreviewSegments(
                quadMesh,
                editMeshHoverEdgeRef.current,
                nextCuts,
              );
            }
          }
        }
      }
    };

    let removeContextMenu: (() => void) | null = null;

    // No browser context menu over the 3D view, ever. OrbitControls already
    // suppresses it — but only while `controls.enabled` is true, and tick()
    // turns that off whenever a Camera node drives the view. Every such gap
    // used to reach Chrome's canvas menu ("Save image as…"), which is fatal
    // to Face Selection's Shift+right-click deselect: once the native menu
    // opens the browser swallows the pointerup that gesture is read from,
    // so the menu appears *and* the face stays selected. Gating this on a
    // Face Selection node being active reopened the same gap one frame at a
    // time (faceSelectionNodeId is only assigned inside tick()), so it is
    // unconditional — right-click in a viewport is a camera/edit gesture,
    // never a request to save the canvas as a PNG.
    const onCanvasContextMenu = (e: MouseEvent) => e.preventDefault();
    renderer.domElement.addEventListener("contextmenu", onCanvasContextMenu);
    removeContextMenu = () => renderer.domElement.removeEventListener("contextmenu", onCanvasContextMenu);

    const keyboardToken = Symbol("viewport-keyboard");
    const claimKeyboard = () => {
      keyboardViewportOwner = keyboardToken;
    };
    if (!outputMode) {
      liveKeyboardViewports.set(keyboardToken, () => suspendedRef.current);
      if (keyboardViewportOwner === null) keyboardViewportOwner = keyboardToken;
      renderer.domElement.addEventListener("pointerenter", claimKeyboard);
      renderer.domElement.addEventListener("pointerdown", claimKeyboard, { capture: true });
      renderer.domElement.addEventListener("pointerdown", onCanvasPointerDown, { capture: true });
      renderer.domElement.addEventListener("wheel", onCanvasWheel, { passive: false, capture: true });
      window.addEventListener("pointermove", onCanvasPointerMove);
      window.addEventListener("pointerup", onCanvasPointerUp);
      window.addEventListener("pointercancel", onCanvasPointerUp);
    }

    const motionBlurEffect = createMotionBlur(host.clientWidth || 1, host.clientHeight || 1);

    function resize() {
      const { clientWidth, clientHeight } = host;
      if (clientWidth === 0 || clientHeight === 0) return;
      const aspect = clientWidth / clientHeight;
      renderer.setSize(clientWidth, clientHeight);
      composer.setSize(clientWidth, clientHeight);
      motionBlurEffect.setSize(clientWidth, clientHeight);
      volumetricPass.setSize(clientWidth, clientHeight);

      perspectiveCamera.aspect = aspect;
      perspectiveCamera.updateProjectionMatrix();

      const d = activeCamera.position.distanceTo(controls.target) || 5;
      const fovRad = THREE.MathUtils.degToRad(perspectiveCamera.fov);
      const halfHeight = Math.tan(fovRad / 2) * d;
      const halfWidth = halfHeight * aspect;
      orthographicCamera.left = -halfWidth;
      orthographicCamera.right = halfWidth;
      orthographicCamera.top = halfHeight;
      orthographicCamera.bottom = -halfHeight;
      orthographicCamera.updateProjectionMatrix();
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    let currentObject: THREE.Object3D | null = null;
    // The last frame region drawn (container size + letterbox rect). When it
    // changes the whole canvas is cleared once — see where it is used.
    let lastViewKey = "";
    let cachedRootsGraph: Graph | null = null;
    let cachedRoots: string[] = [];
    const activeLights = new Map<string, THREE.Light>();
    const activeLightHelpers = new Map<string, THREE.Object3D>();
    // Everything this viewport puts into a scene goes through one of these,
    // so nothing can be added without also being removable — see
    // sceneMembership.ts. `sceneContents` holds the render output plus any
    // standalone Empty anchors; `editorHelpers` holds the editor-only camera
    // helpers (never shown in the output window).
    const sceneContents = createSceneMembership(scene);
    const editorHelpers = createSceneMembership(editorUiScene);

    // A parking scene for gizmo targets that belong to no scene at all.
    //
    // TransformControls requires its attached object to be in a scene graph:
    // its pointerdown path calls `object.parent.updateMatrixWorld()` with no
    // null check, and its own updateMatrixWorld() logs "The attached 3D
    // object must be a part of the scene graph." A node whose geometry is
    // consumed by a *cloning* node (Array, Look At — see array.ts, which
    // clones its source rather than reparenting it) is exactly that case:
    // the clones are what get drawn, and the node's own object sits
    // parentless. Attaching to it gave a gizmo that drew but threw on the
    // first click, so it read as visible but dead.
    //
    // This scene is never rendered — it exists only to give such an object a
    // valid parent and a matrixWorld that tracks its matrix, without drawing
    // it a second time (which is the duplicate-render bug in the other
    // direction) and without touching `visible`, which the cloning nodes
    // copy onto their clones.
    const gizmoAnchorScene = new THREE.Scene();
    const postChain = createPostProcessChain({ renderer, composer, renderPass, outputPass, motionBlurEffect, volumetricPass });

    const backgroundBlur = createBackgroundBlur(renderer);

    let clock: ClockState = createClock(epochMs ?? Date.now());
    let frameId = 0;

    // Restarts the deterministic clock at "now" and drops every cached GPU
    // particle simulation (see particleRuntime.ts) — the next tick()
    // rebuilds everything fresh from each node's *current* params, same as
    // a first load. Only rewinds time and runtime state, not graph edits —
    // matches "reset the animation," not "revert my changes."
    resetSimulationRef.current = () => {
      clock = createClock(Date.now());
      resetAllParticleSimulations();
    };

    // The button and Shift+Space both go through the epoch, so the viewport
    // listens rather than being called directly — which also means a reset
    // triggered from anywhere reaches every mounted pane.
    const stopListeningForReset = onSimulationReset(() => {
      simulationRunRef.current = false;
      resetSimulationRef.current();
    });

    if (exportHandleRef) {
      exportHandleRef.current = {
        getCanvas: () => exportCanvas,
        captureFrame: (frameIndex, fps, timelineFrame) =>
          new Promise<void>((resolve) => {
            pendingCaptureRef.current = { frameIndex, fps, timelineFrame, resolve };
          }),
      };
    }

    snapSelectedCameraToEditorRef.current = () => {
      if (!onTransformChangeRef.current) return;

      // Target whichever camera is selected — 3D (calibration/camera) or 2D
      // (texture/camera) — so this works for a texture camera being lined
      // up for its shot too. Only a 3D Camera node has an "active" concept
      // to fall back to when nothing's selected; a texture/camera never
      // drives the main view, so there's nothing sensible to fall back to
      // for one — the button/shortcut simply does nothing in that case.
      let targetNode = selectedNodeIdRef.current
        ? graphRef.current.nodes.find(
            (n) =>
              n.id === selectedNodeIdRef.current &&
              (n.type === CAMERA_NODE.type || n.type === TEXTURE_CAMERA_NODE.type),
          )
        : undefined;

      if (!targetNode) {
        const cameraNodes = walkNodes(graphRef.current).filter((n) => n.type === CAMERA_NODE.type);
        if (cameraNodes.length === 0) return;

        targetNode =
          cameraNodes.find((n) => {
            const res = latestResultsRef.current?.get(n.id);
            return res && (res.active === 1 || res.active === true);
          }) || cameraNodes[0];
      }

      activeCamera.updateMatrixWorld(true);
      const mat = activeCamera.matrixWorld;
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      mat.decompose(pos, quat, scale);

      const euler = new THREE.Euler().setFromQuaternion(quat, "YXZ");

      const location = new THREE.Vector3(
        Math.round(pos.x * 100) / 100,
        Math.round(pos.y * 100) / 100,
        Math.round(pos.z * 100) / 100,
      );
      const rotation = new THREE.Vector3(
        euler.x,
        euler.y,
        euler.z,
      );

      const targetPos = controls.target.clone();
      const target = new THREE.Vector3(
        Math.round(targetPos.x * 100) / 100,
        Math.round(targetPos.y * 100) / 100,
        Math.round(targetPos.z * 100) / 100,
      );

      const isOrtho = isOrthographicRef.current;
      const fov = activeCamera instanceof THREE.PerspectiveCamera ? Math.round(activeCamera.fov) : undefined;

      onTransformStartRef.current?.();
      const patch: Record<string, unknown> = {
        location,
        rotation,
        target,
        up: activeCamera.up.clone(),
        projectionType: isOrtho ? "orthographic" : "perspective",
      };
      if (fov !== undefined && !isOrtho) patch.fov = fov;

      onTransformChangeRef.current(targetNode.id, patch);
    };

    // A copied-in projection matrix stays copied in until something rebuilds
    // it — switching the Camera node back to manual, or deleting it, would
    // otherwise leave the viewport stuck on the last solved frustum.
    let projectionOverridden = false;
    function restoreProjection() {
      if (!projectionOverridden) return;
      camera.updateProjectionMatrix();
      projectionOverridden = false;
    }

    let isDisposed = false;

    function tick() {
      if (isDisposed) return;
      try {
        const profiler = getEvalProfiler();
        if (profiler) {
          // Only ticks that evaluated count: a suspended pane ticks for free.
          const framesBefore = profiler.frameTotal;
          const tickStart = performance.now();
          tickInner();
          if (profiler.frameTotal !== framesBefore) {
            profiler.recordPhase("viewport tick (all)", performance.now() - tickStart);
            const mem = renderer.info.memory;
            profiler.setGauge("gpu geometries", mem.geometries);
            profiler.setGauge("gpu textures", mem.textures);
            profiler.setGauge("gpu programs", renderer.info.programs?.length ?? 0);
            const heap = (performance as { memory?: { usedJSHeapSize: number } }).memory;
            if (heap) profiler.setGauge("js heap MB", heap.usedJSHeapSize / 1048576);
          }
        } else {
          tickInner();
        }
      } catch (err) {
        console.error("Viewport tick uncaught error:", err);
      } finally {
        if (!isDisposed) {
          frameId = requestAnimationFrame(tick);
        }
      }
    }

    function tickInner() {
      // Frozen while this pane is hidden (SplitViewport keeps every pane
      // mounted now rather than unmounting on a view-mode switch — see its
      // own comment — so this can stay true for as long as the operator is
      // just looking at the graph or the other pane) or another viewport is
      // capturing an export. Keep the rAF alive so the pane picks straight
      // back up once visible again, but touch nothing else in between —
      // except re-anchoring the clock epoch every suspended frame, the same
      // reason the paused branch below does it: epochMs is what `time`/`step`
      // are computed *from* on the next real tick, and if it's left pointing
      // at whenever playback last started, resuming after a long suspension
      // computes step from every second that passed while hidden, backlog
      // included — the exact clock-jump bug already fixed for pause,
      // reachable a second way now that suspension can last minutes instead
      // of one export's worth of frames.
      if (suspendedRef.current) {
        clock = { epochMs: Date.now() - clock.time * 1000, step: clock.step, time: clock.time };
        return;
      }

      // A pending captureFrame() call wins over live playback entirely: the
      // clock is forced to exactly frameIndex/fps (not real elapsed time —
      // Time-node/oscillator/particle output must match that instant, not
      // whenever this tick happened to run), and keyframe evaluation uses
      // frameIndex directly rather than racing the currentFrame prop's own
      // React commit.
      const capture = pendingCaptureRef.current;
      const exportFrameIndex = capture ? capture.timelineFrame ?? capture.frameIndex : currentFrameRef.current;
      if (capture) {
        const stepSeconds = 1 / capture.fps;
        const time = capture.frameIndex * stepSeconds;
        clock = { epochMs: clock.epochMs, step: Math.round(time / STEP_SECONDS), time };
      } else if (isPlayingRef.current) {
        clock = tickClock(clock, Date.now());
      } else {
        // Freeze at the step matching the already-frozen `time` — NOT 0.
        // Forcing step to 0 (the previous behavior here) reads as "the
        // clock just jumped backward in time" to anything that compares
        // steps monotonically, GPUComputationRenderer particle sims chief
        // among them: particleRuntime.ts's `rewound` check
        // (currentStep < sim.lastSteppedStep) fires on literally every
        // pause once playback has advanced past step 0, tearing down and
        // rebuilding the whole simulation from its staggered-fresh-start
        // state — which is what actually produced the reported burst on
        // resume, not (only) the catch-up cap. Re-anchoring epochMs here
        // too keeps wall-clock time from accruing underneath the pause, so
        // tickClock's next call on resume continues smoothly from this same
        // step instead of computing one from everything elapsed since
        // playback originally started.
        clock = { epochMs: Date.now() - clock.time * 1000, step: Math.round(clock.time / STEP_SECONDS), time: clock.time };
      }

      // Suppress the graph-driven matrix overwrite for exactly the mesh the
      // gizmo is dragging this frame (see EvalContext.liveEditNodeId and
      // object.ts) — `transformControls.dragging` is set synchronously by
      // its own pointer handlers, so this is already current by the time
      // any given frame runs, no extra bookkeeping needed.
      const liveEditNodeId = transformControls?.dragging ? attachedObjectNodeId : null;

      // The active camera from last frame, so a Fly To with no wired Camera A
      // can lift off from the current view instead of the origin. Resolved
      // from the previous results (there is no "active" answer until a frame
      // has been evaluated) — one frame of lag on a flight's *start* pose,
      // which is imperceptible.
      const activeCameraPose = latestResults
        ? activeCameraPoseFrom(resolveActiveCameraResult(latestResults, graphRef.current))
        : null;

      let results;
      try {
        // Feed the previous frame's render resolution to hub/* nodes so they
        // can default their pixel positions to the scene centre.
        const prevRender = renderNodeIdRef.current && latestResults ? latestResults.get(renderNodeIdRef.current) : undefined;
        const renderSize =
          prevRender && typeof prevRender.width === "number" && typeof prevRender.height === "number"
            ? { width: prevRender.width as number, height: prevRender.height as number }
            : undefined;
        const renderFps = typeof prevRender?.fps === "number" ? (prevRender.fps as number) : undefined;

        // Advance the playhead here, off this same clock, rather than taking
        // whatever an outside timer last pushed in — see playhead.ts. Export
        // is untouched: it forces its own frame index above.
        let timelineFrame = exportFrameIndex;
        if (!capture) {
          const stepped = advancePlayhead(playheadRef.current, {
            driving: onFrameChangeRef.current !== undefined,
            playing: isPlayingRef.current,
            totalFrames: totalFramesRef.current,
            incomingFrame: currentFrameRef.current,
            fps: renderFps ?? 30,
            clockTime: clock.time,
          });
          playheadRef.current = stepped.state;
          timelineFrame = stepped.frame;
        }
        if (!capture && timelineFrame !== currentFrameRef.current) {
          // Keep our own view of it current for the rest of this frame: the
          // prop only comes back after React has committed, which is one or
          // more renders away, and every read until then must agree with what
          // was actually evaluated.
          currentFrameRef.current = timelineFrame;
          onFrameChangeRef.current?.(timelineFrame);
        } else if (!capture && playheadRef.current.anchor !== null) {
          // Report every driving tick, not only those that move the frame.
          // App's fallback timer yields only to a viewport that has reported
          // recently; at a render fps below the display rate most ticks land
          // on the same frame, so on Play the timer stepped in first, its +1
          // read here as an outside scrub, the anchor was retaken on it and
          // nothing was ever reported — leaving the 60 Hz timer in charge of
          // a 30 fps timeline, and the animation and its sound at double speed.
          onFrameChangeRef.current?.(timelineFrame);
        }

        if (isPlayingRef.current) simulationRunRef.current = true;
        results = evaluateGraph(graphRef.current, registryRef.current, {
          time: clock.time,
          step: clock.step,
          nodeId: "",
          liveEditNodeId,
          renderer,
          activeCameraPose,
          renderSize,
          fps: renderFps,
          sessionId: sessionIdRef.current,
          capturing: capture !== null,
          currentFrame: capture ? exportFrameIndex : currentFrameRef.current,
          keyframes: graphRef.current.keyframes,
          simulationEpoch: getSimulationEpoch(),
          isPlaying: isPlayingRef.current,
          simulationRun: simulationRunRef.current,
          scene,
        });
      } catch (err) {
        console.error("graph evaluation failed", err);
        if (capture) {
          pendingCaptureRef.current = null;
          capture.resolve();
        }
        return;
      }
      latestResults = results;
      latestResultsRef.current = results;
      onEvaluatedResultsRef.current?.(results);

      // Evaluate and sync ALL 3D Lights & Light Helpers in the scene (standalone,
      // array instances, or inside a group at any depth)
      const detectedLights = new Map<string, { light: THREE.Light; nodeId: string }>();
      for (const [nodeId, res] of deepResultEntries(results)) {
        const obj = (res.light || res.geometry) as THREE.Object3D;
        if (obj instanceof THREE.Object3D) {
          obj.traverse((child) => {
            if (child instanceof THREE.Light) {
              const ownerId = child.userData.nodeId || nodeId;
              detectedLights.set(child.uuid, { light: child, nodeId: ownerId });
            }
          });
        }
      }

      const activeLightUUIDs = new Set<string>();
      for (const [uuid, { light, nodeId }] of detectedLights.entries()) {
        activeLightUUIDs.add(uuid);

        if (!activeLights.has(uuid)) {
          // Light objects are cached per node id at module scope (see
          // nodeCaches.ts), so the split view's two panes would otherwise
          // fight over the single shared instance — three.js gives an
          // Object3D exactly one parent, and whichever scene.add() ran last
          // silently rips the light out of the other pane's scene. The
          // output pane holds its own disposable clone instead (same rule
          // as the geometry clones further down in tick()); it needs no
          // stable identity, and copyLightState() below keeps it in sync.
          const toAdd = outputMode ? light.clone() : light;
          if (!toAdd.parent) {
            scene.add(toAdd);
          }
          if ((toAdd as THREE.DirectionalLight | THREE.SpotLight).target && !(toAdd as THREE.DirectionalLight | THREE.SpotLight).target.parent) {
            scene.add((toAdd as THREE.DirectionalLight | THREE.SpotLight).target);
          }
          activeLights.set(uuid, toAdd);

          if (!outputMode) {
            let helper: THREE.Object3D | null = null;
            if (light instanceof THREE.DirectionalLight) {
              helper = new THREE.DirectionalLightHelper(light, 1, light.color);
            } else if (light instanceof THREE.PointLight) {
              helper = new THREE.PointLightHelper(light, 0.5, light.color);
            } else if (light instanceof THREE.SpotLight) {
              helper = new THREE.SpotLightHelper(light, light.color);
            }

            if (helper) {
              helper.userData.nodeId = nodeId;
              helper.traverse((c) => {
                c.userData.nodeId = nodeId;
              });
              editorUiScene.add(helper);
              activeLightHelpers.set(uuid, helper);
            }
          }
        }

        // Keep the output pane's clone in step with the shared original
        // (color, intensity, transform, spot/point params, aim target) so
        // live edits still show up in the preview pane.
        const sceneLight = activeLights.get(uuid);
        if (outputMode && sceneLight && sceneLight !== light) {
          copyLightState(light, sceneLight);
        }

        const helper = activeLightHelpers.get(uuid);
        if (helper) {
          if (typeof (helper as any).update === "function") {
            (helper as any).update();
          }
          if ((helper as any).color) {
            (helper as any).color.copy(light.color);
          }
        }
      }

      // Cleanup stale lights removed from graph
      for (const [uuid, light] of activeLights.entries()) {
        if (!activeLightUUIDs.has(uuid)) {
          if (light.parent === scene) {
            scene.remove(light);
          }
          const targetObj = (light as THREE.DirectionalLight | THREE.SpotLight).target;
          if (targetObj && targetObj.parent === scene) {
            scene.remove(targetObj);
          }
          activeLights.delete(uuid);
          const helper = activeLightHelpers.get(uuid);
          if (helper) {
            editorUiScene.remove(helper);
            activeLightHelpers.delete(uuid);
          }
        }
      }

      // Sync Camera 3D Helpers in editorUiScene (editor view only). Routed
      // through editorHelpers so a camera node that's been deleted — or a
      // whole graph replaced by "New" — takes its helper with it; these used
      // to be added and never removed, leaving the last camera floating in
      // an otherwise empty scene.
      const activeCameraHelpers = new Map<string, THREE.Object3D>();
      for (const [nodeId, res] of results.entries()) {
        const node = graphRef.current.nodes.find((n) => n.id === nodeId);
        if ((node?.type === CAMERA_NODE.type || node?.type === CAMERA_FLY_TO_NODE.type) && res.geometry instanceof THREE.Object3D) {
          activeCameraHelpers.set(nodeId, res.geometry as THREE.Object3D);
        }
      }
      editorHelpers.sync(outputMode ? new Map() : activeCameraHelpers);

      // A Camera or Fly To node drives the camera directly from its Matrix/
      // FOV (or its DLT solve) — but only in the *output* window. That is
      // the one view that has to show exactly what the real projector will
      // show, which orbit navigation would otherwise fight every frame. The
      // editor's own viewport stays freely orbitable regardless of a Camera
      // node's presence or mode, since it's for building/inspecting the
      // scene, not for judging alignment — that judgment only means
      // anything against the actual projected output (see OutputWindow).
      // Prioritize Fly To if active or in flight, then fallback to Camera nodes.
      const activeCameraResult = resolveActiveCameraResult(results, graphRef.current);

      const cameraResult = activeCameraResult;

      // The render node defines the scene's coordinate space (its output
      // resolution) and its presence is what enables the 2D HUD overlay.
      const hubRenderResult = renderNodeIdRef.current ? results.get(renderNodeIdRef.current) : undefined;
      const rs =
        hubRenderResult && typeof hubRenderResult.width === "number" && typeof hubRenderResult.height === "number"
          ? { width: hubRenderResult.width as number, height: hubRenderResult.height as number }
          : null;
      if (
        (rs === null) !== (renderSizeRef.current === null) ||
        (rs && renderSizeRef.current && (rs.width !== renderSizeRef.current.width || rs.height !== renderSizeRef.current.height))
      ) {
        renderSizeRef.current = rs;
        setRenderSize(rs);
      }

      // Keep the export canvas at the render-node resolution (not the live
      // viewport size) so captureStream produces a full-resolution video.
      // In 2D Render mode the export canvas follows the 2D texture instead (see below).
      if (!view2DNodeIdRef.current && rs && exportCtx && (exportCanvas.width !== rs.width || exportCanvas.height !== rs.height)) {
        exportCanvas.width = Math.round(rs.width);
        exportCanvas.height = Math.round(rs.height);
      }

      // Collect HUD elements produced by hub/* nodes this frame. Only re-render
      // React when their serialized appearance actually changed (text/style, or
      // an active animation moving opacity/transform), so idle frames don't churn.
      const collectedHub: HubElement[] = [];
      for (const [, res] of results.entries()) {
        const hud = res.hud;
        if (hud && typeof hud === "object") collectedHub.push(hud as HubElement);
      }
      const hubSig = JSON.stringify(collectedHub);
      if (hubSigRef.current !== hubSig) {
        hubSigRef.current = hubSig;
        // Start decoding any new HUD image now rather than on the first
        // captured frame, and let go of the ones no element points at.
        for (const el of collectedHub) if (el.imageUrl) getExportImage(el.imageUrl);
        pruneExportImages(collectedHub);
        setHubElements(collectedHub);
      }

      const shouldDriveCamera = outputMode || isCameraViewRef.current;
      // Only sync the ortho/perspective toggle to the active Camera node's
      // own projectionType while something is actually looking through that
      // camera (output window, or the editor's camera-preview pane) — same
      // gate as calibrationMatrix below. Ungated, this ran on every frame
      // regardless of view mode: a graph with an active perspective Camera
      // node fought the free-orbit editor's own ortho toggle and axis-view
      // snap (Numpad/X/Y/Z), reverting them to perspective the instant they
      // were set, even though nothing was rendering through that camera.
      if (shouldDriveCamera && cameraResult && typeof cameraResult.projectionType === "string") {
        const wantsOrtho = cameraResult.projectionType === "orthographic";
        if (wantsOrtho !== isOrthographicRef.current) {
          setIsOrthographic(wantsOrtho);
        }
      }
      const calibrationMatrix =
        shouldDriveCamera && cameraResult?.matrix instanceof THREE.Matrix4 ? cameraResult.matrix as THREE.Matrix4 : null;

      if (calibrationMatrix) {
        controls.enabled = false;
        const position = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        calibrationMatrix.decompose(position, quaternion, scale);
        camera.position.copy(position);
        camera.quaternion.copy(quaternion);

        // A solved projector has an off-centre principal point (lens shift),
        // which `fov` structurally cannot express — it forces a symmetric
        // frustum. So when the Camera node hands back a full projection
        // matrix, it is copied in directly, overriding whatever
        // updateProjectionMatrix built from fov/aspect. The copy happens
        // every frame, which is also what keeps it winning over the resize
        // handler's own updateProjectionMatrix call.
        const projection = cameraResult?.projection;
        if (projection instanceof THREE.Matrix4) {
          camera.projectionMatrix.copy(projection);
          camera.projectionMatrixInverse.copy(projection).invert();
          projectionOverridden = true;
        } else if (camera instanceof THREE.PerspectiveCamera) {
          const fov = Number(cameraResult?.fov) || camera.fov;
          const fovChanged = camera.fov !== fov;
          if (fovChanged) camera.fov = fov;
          restoreProjection();
          if (fovChanged) camera.updateProjectionMatrix();
        } else {
          restoreProjection();
        }
      } else if (outputMode && previewCameraPoseRef.current) {
        // Motion design: no Camera node exists to lock onto, so mirror
        // whatever the editor's own orbit camera is currently looking at
        // instead of sitting on a fixed default angle nobody chose. Applied
        // directly rather than through OrbitControls (the output window
        // has no pointer interaction of its own to reconcile with).
        controls.enabled = false;
        const [px, py, pz] = previewCameraPoseRef.current.position;
        const [qx, qy, qz, qw] = previewCameraPoseRef.current.quaternion;
        camera.position.set(px, py, pz);
        camera.quaternion.set(qx, qy, qz, qw);
        restoreProjection();
      } else {
        // Don't stomp the gizmo's own disable — tick() runs every animation
        // frame regardless of pointer state, and would otherwise flip
        // `enabled` back to true mid-drag within one frame of the
        // 'dragging-changed' listener turning it off.
        const selectedGpNode = graphRef.current.nodes.find(
          (n) => n.id === selectedNodeIdRef.current && isPaintOrGreaseNode(n),
        );
        if (!selectedGpNode && isGpDrawingRef.current) {
          isGpDrawingRef.current = false;
          setIsGpDrawing(false);
          controls.enabled = true;
        }

        if (!transformControls?.dragging && !isMarqueeDragging) {
          if (!isGpDrawingRef.current) {
            controls.enabled = true;
          }
          if (!Number.isFinite(controls.target.x) || !Number.isFinite(controls.target.y) || !Number.isFinite(controls.target.z)) {
            controls.target.set(0, 0, 0);
          }
          if (!Number.isFinite(camera.position.x) || !Number.isFinite(camera.position.y) || !Number.isFinite(camera.position.z)) {
            camera.position.set(0, 5, 10);
          }
          controls.update();
        }
        restoreProjection();
      }

      // Holdout: when the render node's holdout is on, the clear colour is
      // opaque black, so anything not drawn by the scene (the letterbox around
      // the render frame) is black instead of the editor background.
      const renderOut = renderNodeIdRef.current ? results.get(renderNodeIdRef.current) : undefined;
      const holdoutEnabled = !!renderOut?.holdout;
      if (holdoutRef.current !== holdoutEnabled) {
        holdoutRef.current = holdoutEnabled;
        renderer.setClearColor(holdoutEnabled ? 0x000000 : 0x000000, holdoutEnabled ? 1 : 0);
      }

      // Sync corner Gizmo camera orientation with main camera — derived from
      // the camera's own quaternion (not position-minus-controls.target,
      // which is only meaningful in orbit mode and would be stale while a
      // Camera node is driving the camera directly).
      if (gizmo) {
        const cameraForward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        gizmo.gizmoCamera.position.copy(cameraForward).multiplyScalar(-3);
        gizmo.gizmoCamera.lookAt(0, 0, 0);
      }

      // Everything this viewport shows, in one reconciliation: the object of
      // every node that is a scene root — one whose geometry nothing
      // downstream has taken ownership of (see sceneRoots.ts). A Render node
      // is one root among others rather than the only door into the scene,
      // which is what the Empty and light exemptions here were already
      // working around.
      //
      // The containment check is the safety net for *reparenting* owners: a
      // Merge pulls its inputs into its own group, and adding one to the
      // scene again would tear it back out (three.js gives an Object3D
      // exactly one parent). Cloning owners — Array, Look At, Spawner — are
      // covered by the ownership declaration instead, since their source is
      // never inside their output and no runtime check could tell the
      // resulting duplicate from a legitimate second object.
      // Only the graph's shape decides this, and it changes on an edit, not
      // on a frame — recomputing it 60 times a second would walk every
      // connection of every node for nothing.
      if (cachedRootsGraph !== graphRef.current) {
        cachedRootsGraph = graphRef.current;
        cachedRoots = resolveSceneRoots(graphRef.current, registryRef.current);
      }

      const rootObjects: { nodeId: string; object: THREE.Object3D }[] = [];
      for (const nodeId of cachedRoots) {
        const geometry = results.get(nodeId)?.geometry;
        if (!(geometry instanceof THREE.Object3D)) continue;
        rootObjects.push({ nodeId, object: geometry });
      }

      const desiredContents = new Map<string, THREE.Object3D>();
      for (const { nodeId, object } of rootObjects) {
        const insideAnotherRoot = rootObjects.some(
          (other) => other.object !== object && isSelfOrDescendantOf(object, other.object),
        );
        if (insideAnotherRoot) continue;

        // Split View's right pane (and the separate Output Window) run their
        // own tick() loop against the *same* graph, but every object/
        // instance/merge node hands back one THREE.Object3D cached per node
        // id at module scope (see nodeCaches.ts) — there is only ever one
        // such object for the whole process, not one per Viewport. three.js
        // gives an Object3D exactly one parent, so the instant a second
        // Viewport's scene.add() runs on it, it's silently ripped out of
        // whichever scene had it first: the editor pane's own scene.add()
        // this frame gets undone by the output pane's the next, leaving the
        // editor empty until the object's identity happens to change again.
        //
        // This pane has no TransformControls (outputMode skips that whole
        // block below) needing a *stable* object identity to attach to
        // across frames, so it's free to hold its own disposable clone
        // instead of fighting over the shared original. Object3D.clone(true)
        // deep-copies the hierarchy but shares geometry/material by
        // reference — cheap, and nothing GPU-owned needs disposing when the
        // old clone is dropped.
        desiredContents.set(nodeId, outputMode ? object.clone(true) : object);
      }
      sceneContents.sync(desiredContents);

      // What post-processing outlines and what the passe-partout guide frames
      // is still the Render node's own subtree — "the output" is a narrower
      // idea than "everything in the scene", and that is exactly what a
      // Render node is for.
      const renderOutput = results.get(renderNodeIdRef.current)?.geometry;
      currentObject = renderOutput instanceof THREE.Object3D ? (desiredContents.get(renderNodeIdRef.current) ?? renderOutput) : null;

      // Curve control-point handles for the selected curve, drawn through the
      // world matrix of whatever object draws that curve so they track the
      // tube when it is moved, rotated or scaled.
      const curveTarget = outputMode ? null : resolveCurveEditTarget(graphRef.current, selectedNodeIdRef.current, hasParamHandles);
      const curveNode = curveTarget ? graphRef.current.nodes.find((n) => n.id === curveTarget.pointsNodeId) : undefined;
      // Handles that edit a node's params (Biped Motion's gait): placed by the node, every frame.
      const isParamHandleNode = curveNode ? hasParamHandles(curveNode) : false;
      // A lattice's handles go on its *deformed* cage, not on the raw stored
      // grid: the stored points are the grid before taper/twist/bend are
      // applied, so with any of those dialled in, handles drawn there float
      // off the cage they are meant to be editing. A drag is converted back
      // through latticeBasePointForTarget below.
      const isLatticeNode = curveNode?.type === LATTICE_DEFORM_NODE.type;
      const isEditMeshPointsNode = curveNode?.type === EDIT_MESH_POINTS_NODE.type;
      const rawStoredPoints = Array.isArray(curveNode?.params.pointsList) ? curveNode.params.pointsList : [];

      let curvePoints: THREE.Vector3[];
      if (isLatticeNode) {
        curvePoints = latticeEvaluatedPoints(curveNode!.params);
      } else if (isEditMeshPointsNode && rawStoredPoints.length === 0) {
        const spaceObj = curveTarget ? results.get(curveTarget.spaceNodeId)?.geometry : undefined;
        const mesh = spaceObj instanceof THREE.Object3D ? findFirstMesh(spaceObj) : null;
        const extracted = mesh ? extractPointsFromMesh(spaceObj as THREE.Object3D, curveNode!.id, "Edit Mesh Points") : null;
        curvePoints = extracted?.points ?? [];
      } else if (isParamHandleNode || (isIkControlNode(curveNode) && rawStoredPoints.length === 0)) {
        // Rest pose: nothing stored yet, the node reports where its controls are.
        const derived = results.get(curveNode!.id)?.__controlPoints;
        curvePoints = Array.isArray(derived) ? derived.map((p) => asVector3(p, new THREE.Vector3())) : [];
      } else {
        curvePoints = rawStoredPoints.map((p) => asVector3(p, new THREE.Vector3()));
      }
      const overMeshPointsCap = isEditMeshPointsNode && curvePoints.length > EDIT_MESH_POINTS_HANDLE_CAP;
      if (overMeshPointsCap && !editMeshPointsCapWarned) {
        editMeshPointsCapWarned = true;
        console.warn(
          `Edit Mesh Points: ${curvePoints.length} vertices is too many for draggable handles (cap ${EDIT_MESH_POINTS_HANDLE_CAP}) — showing no handles for this node. Use it on lower-poly meshes.`,
        );
      }

      const isSkeletonNode = curveNode?.type === SKELETON_NODE_TYPE;
      if (curveTarget && curveNode && curveNode.type !== EDIT_MESH_POINTS_NODE.type && curvePoints.length >= (isSkeletonNode ? 1 : 2) && !overMeshPointsCap) {
        if (curvePointsNodeId !== curveNode.id) {
          curvePointsNodeId = curveNode.id;
          selectedPointIndices.clear();
        }
        // An index past the end of the list is left alone rather than
        // cleared: adding a point selects it one frame before the graph state
        // carrying it arrives here. handleAt() returns null for an index with
        // no handle, so the gizmo simply sits out that frame.

        // The pose the curve is drawn at. `matrix.copy()` on a graph-driven
        // mesh never flags matrixWorld as stale (see the gizmo block below),
        // so it has to be recomputed rather than read.
        const spaceObject = results.get(curveTarget.spaceNodeId)?.geometry;
        const spaceMatrix = new THREE.Matrix4();
        if (spaceObject instanceof THREE.Object3D) {
          spaceObject.updateWorldMatrix(true, false, true);
          spaceMatrix.copy(spaceObject.matrixWorld);
        }

        const isDraggingHandle =
          transformControls?.dragging &&
          (transformControls.object?.userData?.isCurvePointHandle ||
            transformControls.object?.userData?.isCurveCentroidHandle);
        const frozenIndices = isDraggingHandle ? selectedPointIndices : null;
        // Curve-from-points draws its own dark-gray curve via a geometry output
        // (see curve.ts), so skip the straight control-polygon line here. A
        // mesh's vertex-buffer order isn't a path either — a line through it
        // would zigzag across the mesh rather than trace anything meaningful.
        const hideStraightLine =
          isLatticeNode || curveNode?.type === "curve/from_points" || isEditMeshPointsNode || isIkControlNode(curveNode) || isSkeletonNode || isParamHandleNode;
        curveHandles.sync(curvePoints, spaceMatrix, selectedPointIndices, frozenIndices, !hideStraightLine, camera, host.clientHeight, isParamHandleNode);
        // The node's guides (the walk its handles shape) show only while it is being edited.
        const guides = spaceObject instanceof THREE.Object3D ? spaceObject.userData.selectionGuides : undefined;
        if (isParamHandleNode && guides instanceof THREE.Object3D) guides.visible = true;
        if (isSkeletonNode) {
          // The palette follows what is picked.
          const signature = Array.from(selectedPointIndices).join(",");
          if (signature !== lastSkeletonSelection) {
            lastSkeletonSelection = signature;
            setSkeletonSelection(Array.from(selectedPointIndices));
          }
        }
      } else if (curveHandles.count() > 0) {
        curveHandles.clear();
        curvePointsNodeId = null;
        selectedPointIndices.clear();
      }
      if (!isSkeletonNode && lastSkeletonSelection !== "") {
        lastSkeletonSelection = "";
        setSkeletonSelection([]);
      }

      // A selected rig is drawn over everything else, as Blender's armature
      // "In Front": inside a mesh it would otherwise be hidden by the very
      // mesh it moves. A selected Skin brings the rig wired into it forward too.
      const frontIds = new Set<string>();
      const frontSelected = !outputMode ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current) : undefined;
      if (frontSelected && isRigNodeType(frontSelected.type)) frontIds.add(frontSelected.id);
      if (frontSelected?.type === SKIN_NODE.type) {
        for (const c of graphRef.current.connections) if (c.toNode === frontSelected.id && c.toSocket === "rig") frontIds.add(c.fromNode);
      }
      for (const id of [...rigsInFront]) {
        if (frontIds.has(id)) continue;
        const rig = results.get(id)?.geometry;
        if (rig instanceof THREE.Object3D) setInFront(rig, false);
        rigsInFront.delete(id);
      }
      for (const id of frontIds) {
        const rig = results.get(id)?.geometry;
        if (!(rig instanceof THREE.Object3D)) continue;
        setInFront(rig, true);
        rigsInFront.add(id);
      }

      // A Skin node's joints, where its rig stands now: dots to click to pick
      // the joint whose influence the Skin palette edits. The weight overlay
      // belongs to that editing, so it shows only while the node is selected.
      const skinSelected = !outputMode
        ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && n.type === SKIN_NODE.type)
        : undefined;
      for (const node of graphRef.current.nodes) {
        if (node.type !== SKIN_NODE.type) continue;
        const skinned = results.get(node.id)?.geometry;
        if (!(skinned instanceof THREE.Object3D)) continue;
        skinned.traverse((child) => {
          if (child.userData?.skinHeat) child.visible = node.id === skinSelected?.id;
        });
      }
      const skinEdit = skinSelected ? (results.get(skinSelected.id)?.geometry as THREE.Object3D | undefined)?.userData?.skinEdit : undefined;
      if (skinSelected && skinEdit && Array.isArray(skinEdit.joints) && skinEdit.joints.length > 0) {
        skinJointHandles.sync(skinEdit.joints, new THREE.Matrix4(), skinEdit.selected >= 0 ? [skinEdit.selected] : null);
      } else if (skinJointHandles.count() > 0) {
        skinJointHandles.clear();
      }

      // Points Selection handles — same rendering/hit-testing machinery as
      // curve handles (createCurvePointHandles is generic point-cloud dots,
      // nothing curve-specific about it), but the points themselves come
      // from this node's own *live evaluated* output (Points is an input,
      // not a stored param — it's whatever Mesh to Points/upstream produced
      // this frame), and there's no polyline (showLine=false) or drag/gizmo
      // support: this feature only selects, it never moves a point.
      const pointsSelNode = !outputMode
        ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && n.type === POINTS_SELECTION_NODE.type)
        : undefined;
      if (pointsSelNode) {
        if (pointsSelectionNodeId !== pointsSelNode.id) {
          pointsSelectionNodeId = pointsSelNode.id;
          selectedPointsSelectionIndices = new Set(
            Array.isArray(pointsSelNode.params.selectedIndices) ? (pointsSelNode.params.selectedIndices as number[]) : [],
          );
          pointsSelectionRevision++;
        }
        const nodeResult = results.get(pointsSelNode.id);
        const rawPoints = Array.isArray(nodeResult?.points) ? (nodeResult.points as unknown[]) : [];
        const selMatrix = nodeResult?.matrix instanceof THREE.Matrix4 ? (nodeResult.matrix as THREE.Matrix4) : new THREE.Matrix4();

        if (rawPoints.length > 0) {
          // The node is pure: on a still mesh it hands back the same points array every frame.
          const synced = pointsSelectionSynced;
          const stale =
            synced.points !== rawPoints ||
            synced.revision !== pointsSelectionRevision ||
            !synced.matrix.equals(selMatrix) ||
            pointsSelectionHandles.count() !== rawPoints.length;
          if (stale) {
            const selPoints = rawPoints.map((p) => (p instanceof THREE.Vector3 ? p : asVector3(p, new THREE.Vector3())));
            pointsSelectionHandles.sync(selPoints, selMatrix, selectedPointsSelectionIndices);
            pointsSelectionSynced = { points: rawPoints, matrix: selMatrix.clone(), revision: pointsSelectionRevision };
          }
          // Same occlusion as Points Influence below: the input's first mesh
          // hides the far side from clicks and the marquee, outside X-ray.
          const selSource = nodeResult?.geometry instanceof THREE.Object3D ? findFirstMesh(nodeResult.geometry) : null;
          const selOccluder = selSource && selSource.geometry.attributes.position?.count === rawPoints.length ? selSource.geometry : null;
          pointsSelectionHandles.setOccluder(selOccluder, renderer);
          pointsSelectionHandles.setXray(pointsSelNode.params.xray === true);
          const selScene = pointsSelectionHandles.occludes() ? scene : editorUiScene;
          if (pointsSelectionHandles.group.parent !== selScene) selScene.add(pointsSelectionHandles.group);
        } else if (pointsSelectionHandles.count() > 0) {
          pointsSelectionHandles.clear();
        }
      } else if (pointsSelectionHandles.count() > 0) {
        pointsSelectionHandles.clear();
        pointsSelectionHandles.setOccluder(null, null);
        pointsSelectionNodeId = null;
        selectedPointsSelectionIndices.clear();
        pointsSelectionSynced = { points: null, matrix: new THREE.Matrix4(), revision: -1 };
      }

      // Points Influence: its mesh shows the painted map as a heatmap while
      // the node is selected, swapped in around this viewport's render only
      // — the node's output keeps the mesh's own material.
      let influenceMesh: THREE.Mesh | null = null;
      const pointsInfNode = !outputMode
        ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && n.type === POINTS_INFLUENCE_NODE.type)
        : undefined;
      if (pointsInfNode) {
        const infTexture = getTexturePaintState(pointsInfNode.id).texture ?? null;
        const nodeResult = results.get(pointsInfNode.id);
        const mesh = nodeResult?.geometry instanceof THREE.Object3D ? findFirstMesh(nodeResult.geometry) : null;
        if (mesh && infTexture && mesh.geometry.attributes.uv) {
          if (influenceHeatmapMaterial.map !== infTexture) {
            influenceHeatmapMaterial.map = infTexture;
            influenceHeatmapMaterial.needsUpdate = true;
          }
          influenceMesh = mesh;
        }
      }

      // Face Selection editing — the green highlight follows the selected
      // Face Selection node's source geometry. The local pick set is seeded
      // once per node from its current *effective* selection (the formula
      // result before the first click), then becomes the operator's own
      // working set, committed to the node's `selectedFaces` param.
      const faceSelNode = !outputMode
        ? graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current && n.type === FACE_SELECTION_NODE.type)
        : undefined;
      if (faceSelNode) {
        // The working set comes from the node's own stored `selectedFaces`
        // param, NOT from its evaluated `selection` output — same convention
        // as Points Selection's selectedIndices above, and for the same
        // reason: the evaluated output of a fresh node is the *formula*
        // result, which under the default "all" mode is every face, so
        // seeding from it would make the operator's first Shift+click hand
        // Extrude the entire mesh instead of the one face they clicked.
        const paramFaces = Array.isArray(faceSelNode.params.selectedFaces) ? (faceSelNode.params.selectedFaces as number[]) : [];
        const paramKey = paramFaces.join(",");
        if (faceSelectionNodeId !== faceSelNode.id || paramKey !== lastCommittedFaceKey) {
          faceSelectionNodeId = faceSelNode.id;
          selectedFacesSet = new Set<number>(paramFaces);
          lastCommittedFaceKey = paramKey;
          faceSelectionInteractive = faceSelNode.params.interactive === true;
        }
        faceSelectionSourceNodeId =
          graphRef.current.connections.find((c) => c.toNode === faceSelNode.id && c.toSocket === "geometry")?.fromNode ?? null;

        // What the green overlay shows is whatever is actually driving the
        // node's output: the operator's picks once interactive, otherwise a
        // live preview of the formula, so "Select: normal / Threshold" can be
        // dialled in visually before any clicking. Reading the picks from the
        // local set (rather than the evaluated result) keeps the highlight in
        // step with the click that just happened instead of a frame behind.
        let highlight: Set<number>;
        if (faceSelectionInteractive) {
          highlight = selectedFacesSet;
        } else {
          const rawSel = Array.isArray(results.get(faceSelNode.id)?.selection)
            ? (results.get(faceSelNode.id)!.selection as unknown[])
            : [];
          highlight = new Set<number>();
          rawSel.forEach((v, i) => {
            if (Boolean(v)) highlight.add(i);
          });
        }

        const srcObj = results.get(faceSelNode.id)?.geometry;
        const srcMesh = srcObj instanceof THREE.Object3D ? findFirstMesh(srcObj) : null;
        if (srcMesh) srcMesh.updateMatrixWorld(true);
        faceSelectionHandles.sync(srcMesh, highlight);
      } else if (faceSelectionNodeId !== null || faceSelectionHandles.count() > 0) {
        faceSelectionHandles.clear();
        faceSelectionNodeId = null;
        faceSelectionSourceNodeId = null;
        faceSelectionInteractive = false;
        lastCommittedFaceKey = "";
        selectedFacesSet.clear();
      }

      // A modal tool left running on a node that's no longer selected (the
      // selection changed from the graph) is cancelled, not left dangling.
      if (editCtl.modalNodeId !== null && editCtl.modalNodeId !== selectedNodeIdRef.current) cancelEditModal();

      // Edit Mesh handling: sync handles and anchor editMeshCentroidProxy
      let editMeshHasSelection = false;
      let xrayMesh: THREE.Mesh | null = null;
      let editMeshUV: UVPanelData | null = null;
      const editMeshNode = !outputMode
        ? findEditMeshNode(graphRef.current, selectedNodeIdRef.current, true)
        : undefined;
      if (editMeshNode) {
        const srcObj = results.get(editMeshNode.id)?.geometry;
        const srcMesh = srcObj instanceof THREE.Object3D ? findFirstMesh(srcObj) : null;
        if (srcMesh) srcMesh.updateMatrixWorld(true);

        const quadMesh: QuadMesh =
          editMeshQuadMesh(editMeshNode, results, srcMesh);

        const { mode: selectMode, selection } = readEditMeshSelection(editMeshNode);

        const propDiameter =
          editMeshNode.type === EDIT_MESH_NODE.type && editMeshNode.params.proportionalEditing
            ? Number(editMeshNode.params.proportionalDiameter) || 1.0
            : null;

        editMeshHandles.setXray(editMeshNode.params.xray === true);
        if (editMeshNode.params.xray === true && srcMesh) xrayMesh = srcMesh;
        if (uvPanelOpenRef.current && srcMesh) {
          // The UVs the geometry is actually built from, faces fully selected highlighted.
          const withUVs = withFaceUVs(quadMesh);
          const verts = selectionVertices(quadMesh, selectMode, selection);
          const image = uvCheckerRef.current ? null : textureImageOf(srcMesh);
          editMeshUV = {
            key: `em:${editMeshNode.id}:${quadMeshSignature(withUVs)}:${[...verts].join(",")}:${uvCheckerRef.current ? "checker" : imageKeyOf(srcMesh)}`,
            label: typeof editMeshNode.params.name === "string" && editMeshNode.params.name ? editMeshNode.params.name : "Edit Mesh",
            polygons: withUVs.faceUVs as [number, number][][],
            selected: quadMesh.faces.map((face) => face.length > 0 && face.every((v) => verts.has(v))),
            image,
          };
        }
        editMeshHandles.sync({
          mesh: srcMesh,
          quadMesh,
          mode: selectMode,
          points: new Set(selectMode === "points" ? selection.points : []),
          edges: selectMode === "edges" ? selection.edges : [],
          faces: new Set(selectMode === "faces" ? selection.faces : []),
          hoverFace: editMeshHoverFaceRef.current,
          hoverEdge: editMeshHoverEdgeRef.current,
          loopPreview: editMeshPreviewLoopRef.current,
          proportionalDiameter: propDiameter,
        });

        // Position editMeshCentroidProxy at selection centroid
        if (srcMesh && (!transformControls?.dragging || transformControls.object !== editMeshCentroidProxy)) {
          const meshMat = srcMesh.matrixWorld;
          const localCentroid = new THREE.Vector3();
          const targetVertices = selectionVertices(quadMesh, selectMode, selection);
          if (targetVertices.size > 0) {
            editMeshHasSelection = true;
            for (const vIdx of targetVertices) {
              const p = quadMesh.positions[vIdx];
              if (p) localCentroid.add(new THREE.Vector3(p[0], p[1], p[2]));
            }
            localCentroid.divideScalar(targetVertices.size);
            const worldCentroid = localCentroid.clone().applyMatrix4(meshMat);
            // Pivot: the selection's centre, or the object's origin. (Individual
            // Origins shows the gizmo at the centre too; each island pivots on
            // its own when the drag is applied.)
            editMeshCentroidProxy.position.copy(
              editPivotRef.current === "origin" ? new THREE.Vector3().applyMatrix4(meshMat) : worldCentroid,
            );
            // Orientation: world axes, the object's own, or the selection's
            // (Z along its normal).
            const objectQuat = new THREE.Quaternion();
            meshMat.decompose(new THREE.Vector3(), objectQuat, new THREE.Vector3());
            const orientation = editOrientationRef.current;
            if (orientation === "global") editMeshCentroidProxy.quaternion.identity();
            else if (orientation === "local") editMeshCentroidProxy.quaternion.copy(objectQuat);
            else editMeshCentroidProxy.quaternion.copy(objectQuat).multiply(selectionOrientation(quadMesh, selectMode, selection));
            editMeshCentroidProxy.scale.set(1, 1, 1);
            editMeshCentroidProxy.updateMatrixWorld(true);

            if (transformControls && editMeshToolRef.current === "select") {
              if (transformControls.object !== editMeshCentroidProxy) {
                transformControls.attach(editMeshCentroidProxy);
              }
              transformControls.setMode(transformModeRef.current);
              transformControls.setSpace(orientation === "global" ? "world" : "local");
              const incremental = snapEnabled || editSnapRef.current === "increment";
              transformControls.rotationSnap = incremental ? ROTATION_SNAP : null;
              transformControls.scaleSnap = currentScaleSnap();
              transformControls.enabled = true;
              transformControls.showX = true;
              transformControls.showY = true;
              transformControls.showZ = true;
              transformControls.getHelper().visible = true;
            }
          } else if (transformControls?.object === editMeshCentroidProxy) {
            transformControls.detach();
          }
        }
      } else {
        editMeshHandles.clear();
        if (transformControls?.object === editMeshCentroidProxy) {
          transformControls.detach();
        }
      }

      // Pivot Transform's single draggable pivot marker — see the comment by
      // pivotHandle's declaration for why it can't ride the normal gizmo.
      const selectedNodeForPivot = graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current);
      if (!outputMode && selectedNodeForPivot?.type === PIVOT_TRANSFORM_NODE.type) {
        pivotHandleNodeId = selectedNodeForPivot.id;
        const pivotPoint = asVector3(selectedNodeForPivot.params.pivot, new THREE.Vector3());
        // The same coordinate space `pivot` itself is defined in: whatever
        // feeds this node's own `matrix` input (its "base" — see
        // PIVOT_TRANSFORM_NODE's evaluate). Identity when nothing is wired,
        // matching that same fallback.
        const baseConnection = graphRef.current.connections.find(
          (c) => c.toNode === selectedNodeForPivot.id && c.toSocket === "matrix",
        );
        const baseObject = baseConnection ? results.get(baseConnection.fromNode)?.geometry : undefined;
        const pivotSpaceMatrix = new THREE.Matrix4();
        if (baseObject instanceof THREE.Object3D) {
          baseObject.updateWorldMatrix(true, false, true);
          pivotSpaceMatrix.copy(baseObject.matrixWorld);
        }
        pivotHandle.sync([pivotPoint], pivotSpaceMatrix, new Set([0]), null, false, camera, host.clientHeight);
      } else if (pivotHandle.count() > 0) {
        pivotHandle.clear();
        pivotHandleNodeId = null;
      }

      // Visual Slice's plane proxy — see its declaration above for why this
      // can't ride resolveGizmoTarget's normal object-pose path.
      if (!outputMode && selectedNodeForPivot?.type === VISUAL_SLICE_NODE.type) {
        sliceProxyNodeId = selectedNodeForPivot.id;
        sliceProxy.visible = true;
        // Not synced from params while a drag is live — that would fight
        // the drag itself with the pre-drag pose every frame.
        if (!transformControls?.dragging || transformControls.object !== sliceProxy) {
          const point = asVector3(selectedNodeForPivot.params.point, new THREE.Vector3());
          const direction = asVector3(selectedNodeForPivot.params.direction, SLICE_NORMAL_AXIS.clone());
          if (direction.lengthSq() < 1e-12) direction.copy(SLICE_NORMAL_AXIS);
          direction.normalize();
          sliceProxy.position.copy(point);
          sliceProxy.quaternion.setFromUnitVectors(SLICE_NORMAL_AXIS, direction);
        }
      } else if (sliceProxyNodeId) {
        sliceProxy.visible = false;
        sliceProxyNodeId = null;
      }

      // Clip Box's volume proxy — same contract as the slice plane above,
      // plus scale, since Box Size is part of the pose being dragged.
      // A wired Box input owns the volume then, and has its own gizmo.
      if (
        !outputMode &&
        selectedNodeForPivot?.type === CLIP_BOX_NODE.type &&
        !graphRef.current.connections.some((c) => c.toNode === selectedNodeForPivot.id && c.toSocket === "box")
      ) {
        clipBoxProxyNodeId = selectedNodeForPivot.id;
        clipBoxProxy.visible = true;
        if (!transformControls?.dragging || transformControls.object !== clipBoxProxy) {
          const location = asVector3(selectedNodeForPivot.params.location, new THREE.Vector3());
          const rotation = asVector3(selectedNodeForPivot.params.rotation, new THREE.Vector3());
          const size = asVector3(selectedNodeForPivot.params.size, new THREE.Vector3(1, 1, 1));
          clipBoxProxy.position.copy(location);
          clipBoxProxy.quaternion.setFromEuler(new THREE.Euler(rotation.x, rotation.y, rotation.z));
          // A zero on any axis collapses the proxy to nothing and leaves the
          // gizmo with no handle left to grab it back by.
          clipBoxProxy.scale.set(size.x || 1e-3, size.y || 1e-3, size.z || 1e-3);
        }
      } else if (clipBoxProxyNodeId) {
        clipBoxProxy.visible = false;
        clipBoxProxyNodeId = null;
      }

      // Decal's projector proxy — same contract as the clip box above.
      if (!outputMode && selectedNodeForPivot?.type === DECAL_NODE.type) {
        decalProxyNodeId = selectedNodeForPivot.id;
        decalProxy.visible = true;
        if (!transformControls?.dragging || transformControls.object !== decalProxy) {
          const location = asVector3(selectedNodeForPivot.params.location, new THREE.Vector3());
          const rotation = asVector3(selectedNodeForPivot.params.rotation, new THREE.Vector3());
          const size = asVector3(selectedNodeForPivot.params.scale, new THREE.Vector3(1, 1, 1));
          decalProxy.position.copy(location);
          decalProxy.quaternion.setFromEuler(new THREE.Euler(rotation.x, rotation.y, rotation.z));
          decalProxy.scale.set(size.x || 1e-3, size.y || 1e-3, size.z || 1e-3);
        }
      } else if (decalProxyNodeId) {
        decalProxy.visible = false;
        decalProxyNodeId = null;
      }

      // Pose proxy — location (or full pose) gizmo for nodes with nothing else to grab.
      const poseProxyConfigRaw = !outputMode && selectedNodeForPivot ? POSE_PROXY_NODES[selectedNodeForPivot.type] : undefined;
      const poseProxyConfig = poseProxyConfigRaw && (!poseProxyConfigRaw.when || poseProxyConfigRaw.when(paramsWithDefaults(selectedNodeForPivot!))) ? poseProxyConfigRaw : undefined;
      if (poseProxyConfig && selectedNodeForPivot) {
        const params = paramsWithDefaults(selectedNodeForPivot);
        poseProxyNodeId = selectedNodeForPivot.id;
        poseProxyChannels = poseProxyConfig.channels;
        poseProxyLocationParam = poseProxyConfig.locationParam ?? "location";
        poseProxyRadii = poseProxyConfig.scaleRadii && poseProxyConfig.radiusParam
          ? { outerParam: poseProxyConfig.radiusParam, innerParam: poseProxyConfig.innerRadiusParam ?? null }
          : null;
        poseProxy.visible = true;
        if (!transformControls?.dragging || transformControls.object !== poseProxy) {
          poseProxy.position.copy(asVector3(params[poseProxyLocationParam], new THREE.Vector3()));
          if (poseProxyConfig.channels === "trs") {
            const rotation = asVector3(params.rotation, new THREE.Vector3());
            const scale = asVector3(params.scale, new THREE.Vector3(1, 1, 1));
            poseProxy.quaternion.copy(rotationToQuaternion(rotation, params));
            poseProxy.scale.set(scale.x || 1e-3, scale.y || 1e-3, scale.z || 1e-3);
          } else {
            poseProxy.quaternion.identity();
            poseProxy.scale.set(1, 1, 1);
            poseProxyRadiiBase = null;
          }
        }
        // While a Scale drag is running the proxy itself is scaled by the gizmo and the params already follow it, so the
        // spheres divide that scale back out — otherwise they would grow twice.
        const radiusShown = poseProxyChannels === "location" ? Math.max(Math.abs(poseProxy.scale.x), 1e-3) : 1;
        // Children are in the proxy's local space, so the sphere/box dimensions
        // never touch the proxy's own scale (that is the gizmo's to drag).
        poseProxySphere.visible = !!poseProxyConfig.radiusParam;
        if (poseProxyConfig.radiusParam) {
          const radius = Number(params[poseProxyConfig.radiusParam]);
          poseProxySphere.scale.setScalar((Number.isFinite(radius) && radius > 0 ? radius : 1e-3) / radiusShown);
        }
        poseProxyInner.visible = !!poseProxyConfig.innerRadiusParam;
        if (poseProxyConfig.innerRadiusParam) {
          const inner = Number(params[poseProxyConfig.innerRadiusParam]);
          poseProxyInner.scale.setScalar((Number.isFinite(inner) && inner > 0 ? inner : 1e-3) / radiusShown);
        }
        poseProxyBox.visible = !!poseProxyConfig.box;
        if (poseProxyConfig.box) {
          const size = asVector3(params.boxSize, new THREE.Vector3(1, 1, 1));
          poseProxyBox.scale.set(size.x || 1e-3, size.y || 1e-3, size.z || 1e-3);
          poseProxyBox.position.set(0, params.groundAnchor === false ? 0 : size.y / 2, 0);
        }
      } else if (poseProxyNodeId) {
        poseProxy.visible = false;
        poseProxyNodeId = null;
        poseProxyRadii = null;
        poseProxyRadiiBase = null;
      }

      paintPoseProxy();

      // Speaker icons for local sounds: a billboard at each one's Position, in the editor only.
      const localSounds = outputMode ? [] : graphRef.current.nodes.filter((n) => n.type === "sound/player" && n.params.spatialMode === "local");
      const liveSounds = new Set<string>();
      for (const n of localSounds) {
        liveSounds.add(n.id);
        let icon = soundIcons.get(n.id);
        if (!icon) {
          icon = new THREE.Sprite(new THREE.SpriteMaterial({ map: soundIconTexture, depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true }));
          icon.scale.set(0.07, 0.07, 1);
          icon.renderOrder = 999;
          icon.userData.soundNodeId = n.id;
          soundIcons.set(n.id, icon);
          soundIconGroup.add(icon);
        }
        icon.position.copy(asVector3(n.params.position, new THREE.Vector3()));
        (icon.material as THREE.SpriteMaterial).opacity = n.id === selectedNodeIdRef.current ? 1 : 0.8;
      }
      for (const [id, icon] of [...soundIcons]) {
        if (liveSounds.has(id)) continue;
        soundIconGroup.remove(icon);
        (icon.material as THREE.Material).dispose();
        soundIcons.delete(id);
      }

      // Force Field proxy — position and axis gizmo
      if (!outputMode && (selectedNodeForPivot?.type === "particles/force-field" || selectedNodeForPivot?.type === "particles/curl-noise")) {
        forceFieldProxyNodeId = selectedNodeForPivot.id;
        forceFieldProxy.visible = true;
        if (!transformControls?.dragging || transformControls.object !== forceFieldProxy) {
          const pos = asVector3(selectedNodeForPivot.params.position, new THREE.Vector3());
          const axis = asVector3(selectedNodeForPivot.params.axis, new THREE.Vector3(0, 1, 0)).clone().normalize();
          if (axis.lengthSq() < 1e-4) axis.set(0, 1, 0);
          forceFieldProxy.position.copy(pos);
          forceFieldProxy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
        }
      } else if (forceFieldProxyNodeId) {
        forceFieldProxy.visible = false;
        forceFieldProxyNodeId = null;
      }

      // Particle Emitter proxy — position and velocity gizmo
      if (!outputMode && selectedNodeForPivot?.type === "particles/emitter") {
        emitterProxyNodeId = selectedNodeForPivot.id;
        emitterProxy.visible = true;
        if (!transformControls?.dragging || transformControls.object !== emitterProxy) {
          const pos = asVector3(selectedNodeForPivot.params.position, new THREE.Vector3());
          const vel = asVector3(selectedNodeForPivot.params.velocity, new THREE.Vector3());
          const velLen = vel.length();
          emitterVelocityLength = velLen > 1e-4 ? velLen : 1;
          const dir = velLen > 1e-4 ? vel.clone().normalize() : new THREE.Vector3(0, 1, 0);
          emitterProxy.position.copy(pos);
          emitterProxy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        }
      } else if (emitterProxyNodeId) {
        emitterProxy.visible = false;
        emitterProxyNodeId = null;
      }

      // Update yellow pivot crosses for any object with showPivot === true
      if (!outputMode) {
        let activeCrossCount = 0;
        for (const node of graphRef.current.nodes) {
          if (node.params?.showPivot) {
            let cross = pivotCrossPool[activeCrossCount];
            if (!cross) {
              cross = new THREE.LineSegments(pivotCrossGeo, pivotCrossMat);
              cross.renderOrder = 99999;
              pivotCrossPool.push(cross);
              pivotCrossGroup.add(cross);
            }
            cross.visible = true;

            // Find object's world matrix
            let targetObj: THREE.Object3D | undefined;
            scene.traverse((obj) => {
              if (!targetObj && obj.userData?.nodeId === node.id) targetObj = obj;
            });
            const pivOffset =
              targetObj && targetObj.userData && targetObj.userData.pivot
                ? asVector3(targetObj.userData.pivot, new THREE.Vector3())
                : asVector3(node.params?.pivot, new THREE.Vector3());
            const foundObj: THREE.Object3D | undefined = targetObj;
            if (foundObj) {
              foundObj.updateWorldMatrix(true, false);
              cross.position.copy(pivOffset).applyMatrix4(nativePoseWorldMatrix(foundObj));
            } else {
              const loc = asVector3(node.params?.location, new THREE.Vector3());
              cross.position.copy(loc).add(pivOffset);
            }
            activeCrossCount++;
          }
        }
        for (let i = activeCrossCount; i < pivotCrossPool.length; i++) {
          pivotCrossPool[i].visible = false;
        }
      }

      // Move/rotate/scale gizmo: attach to selected mesh, Empty, Light,
      // to the picked control point / multi-point centroid proxy, or to the
      // pivot marker when a Pivot Transform is selected
      let targetObject: THREE.Object3D | null = null;
      let pickedCurveHandle: THREE.Object3D | null = null;
      if (transformControls) {
        if (selectedPointIndices.size === 1) {
          const singleIdx = Array.from(selectedPointIndices)[0];
          pickedCurveHandle = curveHandles.handleAt(singleIdx);
        } else if (selectedPointIndices.size > 1) {
          pickedCurveHandle = curveHandles.getCentroidHandle();
        } else if (pivotHandleNodeId) {
          pickedCurveHandle = pivotHandle.handleAt(0);
        } else if (sliceProxyNodeId) {
          pickedCurveHandle = sliceProxy;
        } else if (clipBoxProxyNodeId) {
          pickedCurveHandle = clipBoxProxy;
        } else if (decalProxyNodeId) {
          pickedCurveHandle = decalProxy;
        } else if (poseProxyNodeId) {
          pickedCurveHandle = poseProxy;
        } else if (forceFieldProxyNodeId) {
          pickedCurveHandle = forceFieldProxy;
        } else if (emitterProxyNodeId) {
          pickedCurveHandle = emitterProxy;
        } else if (editMeshNode && editMeshToolRef.current === "select" && editMeshHasSelection) {
          pickedCurveHandle = editMeshCentroidProxy;
        }
      }

      if (transformControls && !transformControls.dragging && pickedCurveHandle) {
        targetObject = pickedCurveHandle;
        if (transformControls.object !== pickedCurveHandle) transformControls.attach(pickedCurveHandle);
        transformControls.setMode(
          pickedCurveHandle === poseProxy && poseProxyChannels === "location"
            ? (poseProxyRadii && transformModeRef.current === "scale" ? "scale" : "translate")
            : transformModeRef.current,
        );
        transformControls.enabled = true;
        transformControls.showX = true;
        transformControls.showY = true;
        transformControls.showZ = true;
        // A param handle moves only along what it edits: just those arrows, in the node's own axes.
        const axes = paramHandleAxesFor(pickedCurveHandle);
        if (axes) {
          // Turning is offered only by handles that mean something by it (a limb swinging about its joint).
          const rotates = paramHandleRotatesFor(pickedCurveHandle) && transformModeRef.current === "rotate";
          transformControls.setMode(rotates ? "rotate" : "translate");
          if (transformControls.space !== "local") transformControls.setSpace("local");
          transformControls.showX = rotates || axes.includes("x");
          transformControls.showY = rotates || axes.includes("y");
          transformControls.showZ = rotates || axes.includes("z");
        }
        transformControls.getHelper().visible = true;
        attachedObjectNodeId = null;
        attachedGizmoTarget = null;
        for (const parked of [...gizmoAnchorScene.children]) gizmoAnchorScene.remove(parked);
      } else if (transformControls && !transformControls.dragging) {
        const isGp = selectedNodeIdRef.current
          ? isPaintOrGreaseNode(graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current))
          : false;
        if (selectedNodeIdRef.current) {
          // The selected node's own result first — it is the authoritative
          // answer to "which object does this node drive", and the only one
          // that can't be a copy. The scene traversals below match on
          // `userData.nodeId`, which Object3D.clone() duplicates along with
          // everything else in userData: an Array's 16 copies of a Box, or a
          // Look At wrapper's clone of its input, each carry the *source*
          // node's id. Searching the scene first therefore latched the gizmo
          // onto whichever clone happened to be reached first, so dragging
          // moved a copy that the graph overwrote on the next frame while
          // the params were written back to a node whose real object never
          // moved. They stay as fallbacks for nodes with no geometry output
          // of their own (lights, camera helpers).
          if (editMeshNode) {
            targetObject = null;
            if (transformControls.object) transformControls.detach();
            if (gizmoPivotProxyNodeId) {
              gizmoPivotProxy.visible = false;
              gizmoPivotProxyNodeId = null;
              gizmoPivotProxyRealObject = null;
            }
          } else if (isGp && gpToolRef.current !== "select") {
            targetObject = null;
            if (transformControls.object) transformControls.detach();
            attachedObjectNodeId = null;
            attachedGizmoTarget = null;
            if (gizmoPivotProxyNodeId) {
              gizmoPivotProxy.visible = false;
              gizmoPivotProxyNodeId = null;
              gizmoPivotProxyRealObject = null;
            }
          } else {
            const ownResult = results.get(selectedNodeIdRef.current);
            if (ownResult?.geometry instanceof THREE.Object3D) {
              targetObject = ownResult.geometry;
            }
            if (!targetObject) {
              const light = activeLights.get(selectedNodeIdRef.current);
              if (light) targetObject = light;
            }
            if (!targetObject) {
              const camHelper = activeCameraHelpers.get(selectedNodeIdRef.current);
              if (camHelper) targetObject = camHelper;
            }
            if (!targetObject) {
              scene.traverse((obj) => {
                if (!targetObject && obj.userData.nodeId === selectedNodeIdRef.current) targetObject = obj;
              });
            }
          }
        }
        const gizmoTarget = targetObject ? resolveGizmoTarget(graphRef.current, selectedNodeIdRef.current!) : null;

        if (targetObject && gizmoTarget) {
          if (gizmoTarget.kind === "native") {
            // The node whose params a drag writes into — the object
            // resolveGizmoTarget actually resolved to, which for a pure
            // geometry modifier (Twist, Wave, ...) is one or more hops
            // upstream of the *selected* node. Using the selected node's id
            // here instead silently wrote drags into a modifier node with no
            // location/rotation/scale params of its own: the gizmo dragged
            // and rendered fine (it's keyed off `targetObject`, the modifier's
            // own mesh) but nothing ever moved, because the write landed on
            // a node that ignores it.
            gizmoPivotProxyNodeId = gizmoTarget.objectNodeId;
            gizmoPivotProxyRealObject = targetObject;
            gizmoPivotProxy.visible = true;

            if (!transformControls?.dragging || transformControls.object !== gizmoPivotProxy) {
              targetObject.updateWorldMatrix(true, false);
              const node = graphRef.current.nodes.find((n) => n.id === gizmoTarget.objectNodeId);
              const pivOffset =
                targetObject.userData && targetObject.userData.pivot
                  ? asVector3(targetObject.userData.pivot, new THREE.Vector3())
                  : asVector3(node?.params?.pivot, new THREE.Vector3());
              const poseWorld = nativePoseWorldMatrix(targetObject);
              const worldPivot = pivOffset.clone().applyMatrix4(poseWorld);
              poseWorld.decompose(new THREE.Vector3(), gizmoPivotProxy.quaternion, gizmoPivotProxy.scale);
              gizmoPivotProxy.position.copy(worldPivot);
              gizmoPivotProxy.updateMatrixWorld(true);
            }

            if (attachedObjectNodeId !== selectedNodeIdRef.current || transformControls.object !== gizmoPivotProxy) {
              transformControls.attach(gizmoPivotProxy);
              attachedObjectNodeId = selectedNodeIdRef.current;
            }
            attachedGizmoTarget = gizmoTarget;
            targetObject = gizmoPivotProxy;
          } else {
            if (gizmoPivotProxyNodeId) {
              gizmoPivotProxy.visible = false;
              gizmoPivotProxyNodeId = null;
              gizmoPivotProxyRealObject = null;
            }
            // Give a parentless target a home before attaching — see
            // gizmoAnchorScene's own comment for why TransformControls cannot
            // work with one that has no parent.
            if (!targetObject.parent) {
              gizmoAnchorScene.add(targetObject);
            }

            // Re-attach when the *object* changes too, not just the selection:
            // a node that rebuilds its mesh (Text on an edit, Line Graph on a
            // new point count) hands back a different instance under the same
            // node id, and the gizmo would otherwise stay bound to the
            // discarded one and appear to drag nothing.
            if (attachedObjectNodeId !== selectedNodeIdRef.current || transformControls.object !== targetObject) {
              transformControls.attach(targetObject);
              attachedObjectNodeId = selectedNodeIdRef.current;
            }
            attachedGizmoTarget = gizmoTarget;
          }
          transformControls.setMode(transformModeRef.current);
          transformControls.enabled = true;
          transformControls.getHelper().visible = true;
          if (mode2D) {
            transformControls.showX = true;
            transformControls.showY = false;
            transformControls.showZ = true;
            if (transformModeRef.current === "rotate") {
              transformControls.showX = false;
              transformControls.showY = true;
              transformControls.showZ = false;
            } else if (transformModeRef.current === "scale") {
              transformControls.showX = true;
              transformControls.showY = false;
              transformControls.showZ = true;
            }
          } else if (elevationView) {
            if (isGp) {
              transformControls.showX = true;
              transformControls.showY = true;
              transformControls.showZ = true;
            } else {
              transformControls.showX = false;
              transformControls.showY = true;
              transformControls.showZ = false;
            }
          } else {
            transformControls.showX = true;
            transformControls.showY = true;
            transformControls.showZ = true;
          }

          // object.ts drives these meshes by `matrix.copy(...)` with
          // matrixAutoUpdate off, which never touches position/quaternion/
          // scale — they sit at their defaults (origin, identity, 1) no
          // matter where the graph actually puts the object. TransformControls
          // reads exactly those on pointerdown (`_positionStart.copy(
          // object.position)`) and then sets `position = offset +
          // _positionStart`, so a drag started from the origin instead of the
          // object's real pose: the mesh snapped to its untransformed self
          // for the duration of the drag, then jumped back when the graph
          // reclaimed the matrix on release.
          //
          // Refreshed every frame rather than once at attach, so an object
          // being animated by the graph is still handed the pose it actually
          // has the moment a drag begins. This block only runs while the
          // gizmo is *not* dragging, so it can never fight the drag itself.
          if (targetObject !== gizmoPivotProxy && !targetObject.matrixAutoUpdate) {
            targetObject.matrix.decompose(targetObject.position, targetObject.quaternion, targetObject.scale);
          }

          // Nothing traverses the parking scene during rendering, so its
          // contents' matrixWorld would otherwise stay at whatever it was
          // when the object was last drawn — or identity if it never was.
          // TransformControls does all of its drag math in world space, so a
          // stale one is what makes a drag come out wrong rather than
          // simply not start. (`matrix.copy()` never sets
          // matrixWorldNeedsUpdate, so this has to be forced.)
          if (targetObject.parent === gizmoAnchorScene) {
            gizmoAnchorScene.updateMatrixWorld(true);
          }
        } else if (transformControls.object) {
          // `transformControls.object` rather than attachedObjectNodeId: the
          // gizmo may currently be holding a curve point handle, which owns no
          // node id of its own.
          transformControls.detach();
          attachedObjectNodeId = null;
          attachedGizmoTarget = null;
          if (gizmoPivotProxyNodeId) {
            gizmoPivotProxy.visible = false;
            gizmoPivotProxyNodeId = null;
            gizmoPivotProxyRealObject = null;
          }
        }

        // Release anything left parked once it is no longer the gizmo's
        // target — the parking scene should only ever hold the object being
        // edited right now. (An object that goes back to being drawn gets
        // reparented by scene.add() anyway; this just keeps the scene from
        // accumulating every object ever selected.)
        for (const parked of [...gizmoAnchorScene.children]) {
          if (parked !== targetObject) gizmoAnchorScene.remove(parked);
        }
      }

      // Orientation and step snapping set for Edit Mesh's proxy don't carry
      // over to whatever the gizmo holds next.
      if (
        transformControls &&
        !transformControls.dragging &&
        transformControls.object !== editMeshCentroidProxy &&
        !(transformControls.object && paramHandleAxesFor(transformControls.object))
      ) {
        const space = objectOrientationRef.current === "local" ? "local" : "world";
        if (transformControls.space !== space) transformControls.setSpace(space);
        transformControls.rotationSnap = snapEnabled ? ROTATION_SNAP : null;
        transformControls.scaleSnap = currentScaleSnap();
      }

      if (transformControls?.dragging && transformControls.object) {
        targetObject = transformControls.object;
      }

      // Sync Environment & HDRI / Background Color
      const renderResult = results.get(renderNodeIdRef.current);
      const activeEnv = resolveActiveEnvironment(results, renderNodeIdRef.current);
      const applyEnv = outputMode || showEnvInEditorRef.current;
      applyEnvironment(
        applyEnv ? activeEnv : null,
        { scene, bgScene, fallbackBackground: viewportBackground, ambientLight, sunLight },
        backgroundBlur,
        host.clientWidth,
        host.clientHeight,
      );

      // Toggle helper visibility (AxesHelper / Empty crosshairs / camera
      // frustums / Light target helpers). Controlled by showUiOverlay (Tab),
      // and always hidden in the physical output window.
      const hideSceneHelpers = outputMode || !showUiOverlayRef.current;
      scene.traverse((obj) => {
        if (obj.userData?.isHelper || obj instanceof THREE.AxesHelper || obj instanceof THREE.CameraHelper) {
          obj.visible = !hideSceneHelpers;
        }
      });

      // 1. Render Main Scene (with Post-Processing pipeline if active)
      const renderStart = getEvalProfiler() ? performance.now() : 0;
      const width = host.clientWidth;
      const height = host.clientHeight;

      // 2D Render mode: the 3D scene was still fully assembled and evaluated
      // above (a texture/camera source needs that to render from), but
      // nothing about it gets drawn here — just the `view2d` node's
      // resolved texture, letterboxed to its own aspect. Every other
      // per-frame concern below (postprocess chain, editor UI overlay,
      // orientation gizmo, minimap) is 3D-viewport-specific and skipped
      // outright by returning before reaching any of it.
      if (view2DNodeIdRef.current) {
        const view2DTexture = results.get(view2DNodeIdRef.current)?.texture;
        const texture = view2DTexture instanceof THREE.Texture ? view2DTexture : null;
        const texImage = texture?.image as { width?: number; height?: number } | undefined;
        const texAspect = texImage?.width && texImage?.height ? texImage.width / texImage.height : width / height;
        const containerAspect = width / height;
        let bx = 0, by = 0, bw = width, bh = height;
        if (containerAspect > texAspect) {
          bh = height;
          bw = height * texAspect;
          bx = (width - bw) / 2;
        } else {
          bw = width;
          bh = width / texAspect;
          by = (height - bh) / 2;
        }
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, width, height);
        renderer.setClearColor(0x000000, 1);
        renderer.clear();
        if (texture) {
          if (view2DMaterial.map !== texture) {
            view2DMaterial.map = texture;
            view2DMaterial.needsUpdate = true;
          }
          renderer.setViewport(bx, by, bw, bh);
          renderer.setScissor(bx, by, bw, bh);
          renderer.setScissorTest(true);
          renderer.render(view2DScene, view2DCamera);
          renderer.setScissorTest(false);
        }
        // Export reads the 2D texture's own pixels at its native size rather
        // than this letterboxed canvas. The canvas is kept at that size on
        // every tick, not only when capturing, so a video's captureStream
        // starts at the right resolution.
        const exportSize = textureSize(texture);
        if (exportSize && exportCtx && (exportCanvas.width !== exportSize[0] || exportCanvas.height !== exportSize[1])) {
          exportCanvas.width = exportSize[0];
          exportCanvas.height = exportSize[1];
        }
        if (capture) {
          // A 2D Camera renders the scene as assembled on the *previous* tick,
          // so the first tick at a new frame index still shows the last frame's
          // geometry (or nothing at all, right after the export view mounts).
          // Evaluate the same frame once more before recording it.
          capture.waited = (capture.waited ?? 0) + 1;
          if (capture.waited < 2) return;
          if (texture) copyTextureToCanvas(texture, exportCanvas);
          else exportCtx?.clearRect(0, 0, exportCanvas.width, exportCanvas.height);
          pendingCaptureRef.current = null;
          capture.resolve();
        }
        // No explicit requestAnimationFrame here — tick()'s own try/finally
        // wrapper (below tickInner's definition) always reschedules once
        // this call returns, early return included. Doing it here too
        // double-scheduled every frame: each tick queued two more, which
        // queued four, then eight — an exponential rAF pileup that froze
        // the tab within a couple of seconds of switching a pane into 2D
        // View mode.
        return;
      }

      let viewX = 0;
      let viewY = 0;
      let viewWidth = width;
      let viewHeight = height;

      const targetAspect = typeof renderResult?.aspect === "number" && renderResult.aspect > 0 ? (renderResult.aspect as number) : null;

      if ((outputMode || isCameraViewRef.current) && targetAspect && targetAspect > 0) {
        const containerAspect = width / height;
        if (containerAspect > targetAspect) {
          viewHeight = height;
          viewWidth = height * targetAspect;
          viewX = (width - viewWidth) / 2;
        } else {
          viewWidth = width;
          viewHeight = width / targetAspect;
          viewY = (height - viewHeight) / 2;
        }
        if (camera instanceof THREE.PerspectiveCamera) {
          if (camera.aspect !== targetAspect) {
            camera.aspect = targetAspect;
            camera.updateProjectionMatrix();
          }
        }
      } else if (camera instanceof THREE.PerspectiveCamera && !projectionOverridden) {
        const aspect = width / height;
        if (camera.aspect !== aspect) {
          camera.aspect = aspect;
          camera.updateProjectionMatrix();
        }
      }

      // The perspective branches above keep aspect in step with the drawn
      // region every frame; an orthographic camera needs the same, or its
      // frustum (sized for the whole pane by resize(), or by the other
      // projection before a switch) is squashed into the letterboxed region —
      // the frame looks stretched until something happens to resize the pane.
      // Height is kept, width follows the region.
      if (camera instanceof THREE.OrthographicCamera && !projectionOverridden && viewWidth > 0 && viewHeight > 0) {
        const halfHeight = (camera.top - camera.bottom) / 2;
        const halfWidth = halfHeight * (viewWidth / viewHeight);
        if (halfHeight > 0 && (Math.abs(camera.right - halfWidth) > 1e-6 || Math.abs(camera.left + halfWidth) > 1e-6)) {
          camera.left = -halfWidth;
          camera.right = halfWidth;
          camera.updateProjectionMatrix();
        }
      }

      // Passe-partout guide: the editor's own camera keeps this pane's live
      // aspect ratio (free orbit, unconstrained by any Camera node — see the
      // comment above the calibrationMatrix branch), but "Aligner Caméra"
      // captures only the vertical FOV, which reproduces the wrong framing
      // whenever the output's aspect (targetAspect) differs from this pane's.
      // Drawing the target-aspect crop as a guide, rather than actually
      // letterboxing the editor's render, lets you compose within the
      // correct bounds before hitting Align without losing free navigation.
      const guideEl = cameraGuideRef.current;
      if (guideEl) {
        const selectedIsCamera =
          !!selectedNodeIdRef.current &&
          graphRef.current.nodes.find((n) => n.id === selectedNodeIdRef.current)?.type === CAMERA_NODE.type;
        if (!outputMode && !isCameraViewRef.current && selectedIsCamera && targetAspect && targetAspect > 0) {
          const containerAspect = width / height;
          let guideWidth = width;
          let guideHeight = height;
          if (containerAspect > targetAspect) {
            guideHeight = height;
            guideWidth = height * targetAspect;
          } else {
            guideWidth = width;
            guideHeight = width / targetAspect;
          }
          guideEl.style.display = "block";
          guideEl.style.width = `${guideWidth}px`;
          guideEl.style.height = `${guideHeight}px`;
          guideEl.style.left = `${(width - guideWidth) / 2}px`;
          guideEl.style.top = `${(height - guideHeight) / 2}px`;
        } else {
          guideEl.style.display = "none";
        }
      }

      // renderer.clear() honours the scissor, so once a letterboxed region is
      // active nothing ever wipes the bars around it. Whatever was drawn
      // there before the region changed (a pane that just went from half to
      // full width, or from the free 3D view into camera view) would stay
      // on screen as stale residue — so wipe the whole canvas whenever the
      // region changes.
      const viewKey = `${width}x${height}:${viewX},${viewY},${viewWidth},${viewHeight}`;
      if (viewKey !== lastViewKey) {
        lastViewKey = viewKey;
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, width, height);
        renderer.clear();
      }

      renderer.setViewport(viewX, viewY, viewWidth, viewHeight);
      renderer.setScissor(viewX, viewY, viewWidth, viewHeight);
      renderer.setScissorTest((outputMode || isCameraViewRef.current) && targetAspect !== null);

      // The HUD must map onto the actual rendered frame. When a render node
      // defines a target aspect, that region (possibly letterboxed) is the
      // frame HUD coordinates live in — in the editor's camera view the 3D
      // render still fills the pane, but snapping the HUD to the target-aspect
      // region keeps positions pixel-exact against the exported frame. Kept in
      // a ref for the drag handlers and mirrored to state so React re-renders.
      let frameX = 0;
      let frameY = 0;
      let frameW = width;
      let frameH = height;
      if (targetAspect && targetAspect > 0) {
        const containerAspect = width / height;
        if (containerAspect > targetAspect) {
          frameH = height;
          frameW = height * targetAspect;
          frameX = (width - frameW) / 2;
        } else {
          frameW = width;
          frameH = width / targetAspect;
          frameY = (height - frameH) / 2;
        }
      }
      const frame = { x: frameX, y: frameY, width: frameW, height: frameH };
      renderFrameRef.current = frame;
      if (
        renderFrameStateRef.current.x !== frame.x ||
        renderFrameStateRef.current.y !== frame.y ||
        renderFrameStateRef.current.width !== frame.width ||
        renderFrameStateRef.current.height !== frame.height
      ) {
        renderFrameStateRef.current = frame;
        setRenderFrame(frame);
      }

      // Editor viewport: post-prod effects only show with the environment
      // toggle on (applyEnv); the output window always applies them.
      const postConfigs = applyEnv && Array.isArray(renderResult?.postprocess)
        ? (renderResult.postprocess as PostProcessConfig[])
        : [];

      // Collect per-object modifier outlines for 3D meshes
      const modifierOutlineConfigs: PostProcessConfig[] = [];
      const outlineGroups = new Map<
        string,
        {
          meshes: THREE.Mesh[];
          mod: {
            edgeColor: THREE.Color;
            edgeStrength: number;
            edgeThickness: number;
            sharpness: number;
            outlineSide: number;
            nodeId?: string;
          };
        }
      >();

      scene.traverse((obj) => {
        const mod = obj.userData?.outlineModifier;
        if (mod && mod.is3D) {
          const key = mod.nodeId || String(obj.id);
          let group = outlineGroups.get(key);
          if (!group) {
            group = { meshes: [], mod };
            outlineGroups.set(key, group);
          }
          if (obj instanceof THREE.Mesh) {
            if (!group.meshes.includes(obj)) group.meshes.push(obj);
          } else {
            obj.traverse((child) => {
              if (child instanceof THREE.Mesh && !group!.meshes.includes(child)) {
                group!.meshes.push(child);
              }
            });
          }
        }
      });

      for (const [key, { meshes, mod }] of outlineGroups.entries()) {
        if (meshes.length > 0) {
          modifierOutlineConfigs.push({
            type: "outline",
            nodeId: `mod-outline-${key}`,
            params: {
              selectedObjects: meshes,
              edgeColor: mod.edgeColor,
              edgeStrength: (typeof mod.edgeStrength === "number" ? mod.edgeStrength : 1.0) * 3.0,
              edgeThickness: typeof mod.edgeThickness === "number" ? mod.edgeThickness : 3.0,
              edgeGlow: Math.max(0, (1.0 - (typeof mod.sharpness === "number" ? mod.sharpness : 1.0)) * 1.5),
              outlineSide: typeof mod.outlineSide === "number" ? mod.outlineSide : 0.0,
            },
          });
        }
      }

      const effectivePostConfigs = [...modifierOutlineConfigs, ...postConfigs];

      // Motion blur lives on the Render node itself rather than in the
      // postprocess chain (it's a property of the output, not an effect a
      // graph wires up), so it can switch the composer path on by itself
      // even with no postprocess node connected at all.
      const motionBlur = applyEnv && typeof renderResult?.motionBlur === "number" ? renderResult.motionBlur : 0;

      // Un maillage volumétrique demandant une résolution réduite impose le
      // chemin composer : la passe séparée ne peut pas s'exécuter autrement.
      const volumetric = findVolumetricSettings(scene);

      // UV checker / UV view: the selected object's meshes (every mesh, with
      // nothing selected — bar custom shaders like volumes and skies).
      const uvSelectedId = selectedNodeIdRef.current;
      const uvMeshes: THREE.Mesh[] = [];
      if (!outputMode && (uvCheckerRef.current || uvPanelOpenRef.current)) {
        scene.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh || !mesh.visible || mesh.userData.looseEdges) return;
          if (uvSelectedId) {
            if (selectableNodeIdFor(mesh, graphRef.current) !== uvSelectedId) return;
          } else if (mesh.material instanceof THREE.ShaderMaterial) {
            return;
          }
          uvMeshes.push(mesh);
        });
      }
      if (uvPanelOpenRef.current && !outputMode) {
        const selectedNode = uvSelectedId ? graphRef.current.nodes.find((n) => n.id === uvSelectedId) : undefined;
        const nodeLabel =
          typeof selectedNode?.params.name === "string" && selectedNode.params.name
            ? selectedNode.params.name
            : (selectedNode?.type.split("/").pop() ?? "Mesh");
        uvPanelDataRef.current = editMeshUV ?? (uvSelectedId ? geometryUVData(uvMeshes[0] ?? null, uvCheckerRef.current, nodeLabel) : null);
      }

      // Restored in the finally below even if a render throws: the material
      // swap must never outlive this frame's draw. The checker goes on first
      // and comes off last, so X-ray's own swap nests inside it.
      const restoreUVChecker = !outputMode && uvCheckerRef.current ? swapInUVChecker(uvMeshes) : () => {};
      const xrayOriginalMaterial = xrayMesh ? xrayMesh.material : null;
      if (xrayMesh) xrayMesh.material = editMeshXrayMaterial;
      let influenceInScene = false;
      for (let o: THREE.Object3D | null = influenceMesh; o; o = o.parent) if (o === scene) influenceInScene = true;
      const influenceSwapped = influenceMesh && influenceInScene ? influenceMesh : null;
      const influenceOriginalMaterial = influenceSwapped ? influenceSwapped.material : null;
      if (influenceSwapped) influenceSwapped.material = influenceHeatmapMaterial;
      else if (influenceMesh) {
        influenceOverlay.geometry = influenceMesh.geometry;
        influenceOverlay.matrix.copy(influenceMesh.matrixWorld);
        influenceOverlay.matrixWorld.copy(influenceMesh.matrixWorld);
        scene.add(influenceOverlay);
      }
      if (shadowTracker.check(scene, renderer)) renderer.shadowMap.needsUpdate = true;
      try {
        if (postChain.isActive(effectivePostConfigs, motionBlur, volumetric)) {
          postChainWasActive = true;
          scene.background = bgScene.background;
          // Le volume est rendu par sa propre passe : l'exclure du rendu de scène
          // sans quoi il serait dessiné deux fois.
          if (volumetric) camera.layers.disable(LAYER_VOLUMETRIC);
          postChain.render({
            scene,
            camera,
            configs: effectivePostConfigs,
            motionBlur,
            width,
            height,
            outlineTarget: currentObject,
            time: clock.time,
            volumetric,
          });
          if (volumetric) camera.layers.enable(LAYER_VOLUMETRIC);
        } else {
          // Nothing in the chain this frame — release the passes once we actually
          // turn the chain off (not every idle frame, which would re-allocate all
          // the cached passes the moment an effect switches back on).
          if (postChainWasActive) {
            postChain.dispose();
            postChainWasActive = false;
          }

          scene.fog = null;
          scene.background = bgScene.background;
          (scene as any).backgroundBlurriness = (bgScene as any).backgroundBlurriness ?? 0;
          renderer.clear();
          renderer.render(scene, camera);
        }
      } finally {
        if (influenceSwapped && influenceOriginalMaterial) influenceSwapped.material = influenceOriginalMaterial;
        if (influenceOverlay.parent) influenceOverlay.removeFromParent();
        if (xrayMesh && xrayOriginalMaterial) xrayMesh.material = xrayOriginalMaterial;
        restoreUVChecker();
      }

      // 1b. Render Editor UI Overlay (Grid, Transform Controls, Light Helpers) - isolated from Postprocess
      if (!outputMode && showUiOverlayRef.current) {
        elevationHUD.update(targetObject, Boolean(elevationView));
        renderer.clearDepth();
        renderer.render(editorUiScene, camera);
      }

      // 2. Render Corner 3D Orientation Gizmo HUD (110x110 px in bottom-left)
      if (gizmo && !outputMode && showUiOverlayRef.current) {
        const gizmoSize = 110;
        renderer.clearDepth();
        renderer.setScissorTest(true);
        renderer.setScissor(12, 12, gizmoSize, gizmoSize);
        renderer.setViewport(12, 12, gizmoSize, gizmoSize);
        renderer.render(gizmo.gizmoScene, gizmo.gizmoCamera);
        renderer.setScissorTest(false);
      }
      // CPU side of the draw calls only — the GPU runs asynchronously, so a
      // GPU-bound frame shows up as a long "viewport tick" with a short render.
      if (renderStart) getEvalProfiler()?.recordPhase("render (cpu submit)", performance.now() - renderStart);

      if (capture) {
        // Hold the frame until every HUD image has decoded — the capture is
        // only resolved below, so exportVideo simply waits one more tick and
        // this same frame index is rendered again. Bounded so a broken image
        // can never wedge the export.
        capture.waited = (capture.waited ?? 0) + 1;
        if (capture.waited < MAX_CAPTURE_WAIT_TICKS && !hubImagesReady(collectedHub)) {
          return;
        }
        // Composite the WebGL frame + the 2D HUD overlay onto the export
        // canvas, which is what MediaRecorder actually captures.
        if (exportCtx) {
          const src = renderer.domElement;
          exportCtx.clearRect(0, 0, exportCanvas.width, exportCanvas.height);
          // Scale the (possibly dpr-sized) WebGL frame to fill the export
          // canvas, preserving aspect.
          const scale = Math.min(
            exportCanvas.width / Math.max(1, src.width),
            exportCanvas.height / Math.max(1, src.height),
          );
          const dw = src.width * scale;
          const dh = src.height * scale;
          const dx = (exportCanvas.width - dw) / 2;
          const dy = (exportCanvas.height - dh) / 2;
          exportCtx.drawImage(src, dx, dy, dw, dh);
          const rs = renderSizeRef.current;
          if (rs && rs.width > 0 && rs.height > 0) {
            const sx = exportCanvas.width / rs.width;
            const sy = exportCanvas.height / rs.height;
            exportCtx.save();
            exportCtx.scale(sx, sy);
            for (const el of collectedHub) drawHubElement(exportCtx, el, rs.width, rs.height);
            exportCtx.restore();
          }
        }
        pendingCaptureRef.current = null;
        capture.resolve();
      }
    }

    frameId = requestAnimationFrame(tick);

    return () => {
      isDisposed = true;
      cancelAnimationFrame(frameId);
      disposeEvalSession(sessionIdRef.current);
      unregisterPointerViewport();
      resizeObserver.disconnect();
      removeContextMenu?.();
      if (!outputMode) {
        liveKeyboardViewports.delete(keyboardToken);
        if (keyboardViewportOwner === keyboardToken) keyboardViewportOwner = null;
        renderer.domElement.removeEventListener("pointerenter", claimKeyboard);
        renderer.domElement.removeEventListener("pointerdown", claimKeyboard, { capture: true });
        renderer.domElement.removeEventListener("pointerdown", onCanvasPointerDown, { capture: true });
        renderer.domElement.removeEventListener("wheel", onCanvasWheel, { capture: true });
        window.removeEventListener("pointermove", onCanvasPointerMove);
        window.removeEventListener("pointerup", onCanvasPointerUp);
        window.removeEventListener("pointercancel", onCanvasPointerUp);
        controls.removeEventListener("start", handleOrbitStart);
        controls.removeEventListener("change", emitCameraPose);
        window.removeEventListener("keydown", onSnapKeyDown);
        window.removeEventListener("keydown", onViewportKeyDownCaptured, true);
        window.removeEventListener("keyup", onSnapKeyUp);
        window.removeEventListener("blur", onSnapWindowBlur);
      }
      // A debounced texture snapshot outliving the viewport would write into
      // a graph this component no longer owns.
      for (const timer of textureSnapshotTimersRef.current.values()) clearTimeout(timer);
      textureSnapshotTimersRef.current.clear();
      transformControls?.dispose();
      elevationHUD.dispose();
      curveHandles.clear();
      pointsSelectionHandles.clear();
      skinJointHandles.clear();
      skeletonCommandsRef.current = null;
      influenceHeatmapMaterial.dispose();
      pivotHandle.clear();
      terrainBrushGizmo.removeFromParent();
      sculptBrushGizmo.removeFromParent();
      weightBrushGizmo.removeFromParent();
      textureBrushGizmo.removeFromParent();
      textureBrushGizmo.geometry.dispose();
      view2DQuad.geometry.dispose();
      view2DMaterial.dispose();
      sliceProxy.removeFromParent();
      sliceVisualGeometry.dispose();
      sliceVisual.material.dispose();
      sliceVisualEdges.geometry.dispose();
      sliceVisualEdges.material.dispose();
      clipBoxProxy.removeFromParent();
      clipBoxGeometry.dispose();
      clipBoxVisual.material.dispose();
      clipBoxEdges.geometry.dispose();
      clipBoxEdges.material.dispose();
      decalProxy.removeFromParent();
      decalProxyGeometry.dispose();
      decalProxyEdges.geometry.dispose();
      decalProxyEdges.material.dispose();
      decalProxyFace.geometry.dispose();
      decalProxyFace.material.dispose();
      poseProxy.removeFromParent();
      soundIconGroup.removeFromParent();
      for (const icon of soundIcons.values()) (icon.material as THREE.Material).dispose();
      soundIcons.clear();
      soundIconTexture.dispose();
      poseProxyCoreGeo.dispose();
      poseProxyCoreMat.dispose();
      poseCircleGeo.dispose();
      poseProxySphereMat.dispose();
      poseProxyInnerMat.dispose();
      poseProxyBoxUnitGeo.dispose();
      poseProxyBox.material.dispose();
      forceFieldProxy.removeFromParent();
      forceFieldCoreGeo.dispose();
      forceFieldCoreMat.dispose();
      forceFieldRingGeo.dispose();
      forceFieldRingMat.dispose();
      emitterProxy.removeFromParent();
      emitterCoreGeo.dispose();
      emitterCoreMat.dispose();
      emitterRingGeo.dispose();
      emitterRingMat.dispose();
      gizmoPivotProxy.removeFromParent();
      pivotCrossGroup.removeFromParent();
      pivotCrossGeo.dispose();
      pivotCrossMat.dispose();
      controls.dispose();
      // Per-viewport editor furniture (grid/axes, corner gizmo, zoom-scrub
      // bar) is not part of the shared per-node caches — it is built fresh for
      // this viewport and must release its GPU buffers on unmount, or every
      // StrictMode remount / split-view toggle leaks geometry & materials.
      if (gridAndAxes) disposeMainSceneGridAndAxes(gridAndAxes);
      if (gizmo) disposeGizmoScene(gizmo);
      // These objects are cached per node id at module scope and outlive
      // this viewport (see nodeCaches.ts) — hand them back rather than
      // leaving them parented to a scene that's about to be thrown away.
      sceneContents.clear();
      editorHelpers.clear();
      // Lights get the same hand-back treatment as the geometry above:
      // without it a cached light would keep pointing at this dead scene,
      // and the next viewport's `!light.parent` guard would refuse to add
      // it — the very "lights stay off after closing the split view" bug.
      // In outputMode the entries are this pane's own disposable clones;
      // detach those too and free their shadow render targets.
      for (const [, light] of activeLights) {
        if (light.parent === scene) {
          scene.remove(light);
        }
        const target = (light as THREE.DirectionalLight | THREE.SpotLight).target;
        if (target && target.parent === scene) {
          scene.remove(target);
        }
        if (outputMode) {
          light.dispose();
        }
      }
      for (const helper of activeLightHelpers.values()) {
        if (helper.parent) {
          helper.parent.remove(helper);
        }
        // Light helpers own their own geometry/material; release them here.
        disposeObject3D(helper);
      }
      activeLights.clear();
      activeLightHelpers.clear();
      postChain.dispose();
      viewportBackground.dispose();
      motionBlurEffect.dispose();
      // postChain.dispose() ne libère que les passes qu'il a instanciées ;
      // celle-ci lui est fournie, elle est donc à libérer ici.
      volumetricPass.dispose();
      backgroundBlur.dispose();
      window.removeEventListener("tsuji-theme-colors-changed", handleThemeColorsChanged);
      stopListeningForReset();
      renderer.dispose();
      if (host.contains(renderer.domElement)) {
        host.removeChild(renderer.domElement);
      }
    };
  }, [epochMs, outputMode]);

  // "F" frames the selected object — only while the mouse is actually over
  // this pane (its own "F" binding lives in GraphEditor.tsx for the canvas).
  useEffect(() => {
    if (outputMode) return;
    const handleFrameKey = (e: KeyboardEvent) => {
      if (!isViewportZone() || e.key.toLowerCase() !== "f" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isKeyReservedForPlayback(e)) return;
      const activeEl = document.activeElement;
      const isInput =
        activeEl &&
        (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA" || (activeEl as HTMLElement).isContentEditable);
      if (isInput || !selectedNodeIdRef.current) return;
      e.preventDefault();
      focusOnNodeRef.current(selectedNodeIdRef.current);
    };
    window.addEventListener("keydown", handleFrameKey);
    return () => window.removeEventListener("keydown", handleFrameKey);
  }, [outputMode]);

  const EDGE_ZOOM_THRESHOLD_PX = 28;
  const EDGE_ZOOM_DRAG_SENSITIVITY = 4;

  const handleViewportMouseMove = (e: React.MouseEvent) => {
    if (outputMode) return;
    setInputZone("viewport");
    if (edgeZoomDraggingRef.current) return;
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return;
    const fromLeft = e.clientX - rect.left;
    const fromRight = rect.right - e.clientX;
    if (fromLeft <= EDGE_ZOOM_THRESHOLD_PX) {
      setEdgeZoomHandle({ side: "left", y: e.clientY - rect.top });
    } else if (fromRight <= EDGE_ZOOM_THRESHOLD_PX) {
      setEdgeZoomHandle({ side: "right", y: e.clientY - rect.top });
    } else {
      setEdgeZoomHandle(null);
    }
  };

  const handleViewportMouseLeave = () => {
    if (outputMode) return;
    setInputZone(null);
    if (!edgeZoomDraggingRef.current) setEdgeZoomHandle(null);
  };

  // Dragging the handle dollies the camera the same way a mouse wheel does —
  // synthesizing wheel events lets OrbitControls' own zoom (already centered
  // on controls.target, and already correct for both perspective dolly and
  // orthographic camera.zoom) do the work instead of duplicating its math.
  const handleEdgeZoomPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    edgeZoomDraggingRef.current = true;
    edgeZoomLastYRef.current = e.clientY;
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    const canvas = hostRef.current?.querySelector("canvas");

    const onMove = (moveEvent: PointerEvent) => {
      if (!edgeZoomDraggingRef.current) return;
      const deltaY = moveEvent.clientY - edgeZoomLastYRef.current;
      edgeZoomLastYRef.current = moveEvent.clientY;
      if (deltaY !== 0 && canvas) {
        canvas.dispatchEvent(
          new WheelEvent("wheel", { deltaY: deltaY * EDGE_ZOOM_DRAG_SENSITIVITY, bubbles: true, cancelable: true }),
        );
      }
      const rect = hostRef.current?.getBoundingClientRect();
      if (rect) {
        setEdgeZoomHandle((prev) => (prev ? { ...prev, y: moveEvent.clientY - rect.top } : prev));
      }
    };
    const onUp = () => {
      edgeZoomDraggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      edgeZoomHandlersRef.current = null;
      setEdgeZoomHandle(null);
    };
    edgeZoomHandlersRef.current = { move: onMove, up: onUp };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  // The first Virtual Interface left shown, at the top level of the scene.
  const virtualInterfaceNode = graph.nodes.find((n) => n.type === VIRTUAL_INTERFACE_NODE.type && n.params.show !== false && n.params.show !== 0);

  return (
    <div
      className="viewport-container"
      ref={hostRef}
      onMouseEnter={outputMode ? undefined : () => setInputZone("viewport")}
      onMouseMove={outputMode ? undefined : handleViewportMouseMove}
      onMouseLeave={outputMode ? undefined : handleViewportMouseLeave}
    >
      {/* Edge Zoom Handle — grab and drag vertically near the left/right edge to dolly the camera around the orbit target */}
      {!outputMode && edgeZoomHandle && (
        <div
          onPointerDown={handleEdgeZoomPointerDown}
          title="Drag to zoom"
          style={{
            position: "absolute",
            left: edgeZoomHandle.side === "left" ? "6px" : undefined,
            right: edgeZoomHandle.side === "right" ? "6px" : undefined,
            top: `${edgeZoomHandle.y - 9}px`,
            width: "18px",
            height: "18px",
            borderRadius: "50%",
            border: "1.5px solid #38bdf8",
            backgroundColor: "rgba(56, 189, 248, 0.35)",
            cursor: "ns-resize",
            zIndex: 50,
            pointerEvents: "auto",
          }}
        />
      )}
      {/* Rectangular Marquee Selection Overlay (Cmd+Drag) */}
      {!outputMode && marqueeBox && (
        <div
          style={{
            position: "absolute",
            left: `${marqueeBox.left}px`,
            top: `${marqueeBox.top}px`,
            width: `${marqueeBox.width}px`,
            height: `${marqueeBox.height}px`,
            border: "1.5px dashed #38bdf8",
            backgroundColor: "rgba(56, 189, 248, 0.18)",
            pointerEvents: "none",
            zIndex: 40,
          }}
        />
      )}
      {/* Edit Mesh panel: gizmo orientation, pivot, snapping, edge marks,
          face material slot / colour, and the selection's median position.
          Not on the 2D mode's elevation view — it belongs to the edit pane. */}
      {!outputMode &&
        !elevationView &&
        selectedNodeId &&
        !editModalHud &&
        (() => {
          const node = findEditMeshNode(graph, selectedNodeId, false);
          if (!node) return null;
          const { mode, selection } = readEditMeshSelection(node);
          const meshObj = latestResultsRef.current?.get(node.id)?.geometry;
          const srcMesh = meshObj instanceof THREE.Object3D ? findFirstMesh(meshObj) : null;
          const quadMesh = srcMesh ? editMeshQuadMesh(node, latestResultsRef.current, srcMesh) : null;
          const vertices = quadMesh ? [...selectionVertices(quadMesh, mode, selection)] : [];
          const median = new THREE.Vector3();
          if (quadMesh && vertices.length > 0) {
            for (const v of vertices) median.add(new THREE.Vector3(...quadMesh.positions[v]));
            median.divideScalar(vertices.length);
          }
          const setMedian = (axis: 0 | 1 | 2, text: string) => {
            const value = parseFloat(text);
            if (!quadMesh || vertices.length === 0 || !Number.isFinite(value)) return;
            const delta = new THREE.Vector3();
            delta.setComponent(axis, value - median.getComponent(axis));
            if (Math.abs(delta.getComponent(axis)) < 1e-9) return;
            const moved = transformSelectionByMatrix(quadMesh, "points", vertices, new THREE.Matrix4().makeTranslation(delta.x, delta.y, delta.z));
            if (node.params.mirrorX === true) {
              const map = mirrorXMap(quadMesh, mirrorTolerance(quadMesh));
              const changes = new Map<number, [number, number, number]>(vertices.map((v) => [v, moved.positions[v]]));
              for (const [v, p] of mirrorMovesX(quadMesh, changes, map, mirrorTolerance(quadMesh))) moved.positions[v] = p;
            }
            onParamChange?.({ meshData: moved }, node.id, undefined, { coalesce: false });
          };
          const segmented = <T extends string>(
            value: T,
            options: { id: T; label: string; title: string }[],
            set: (v: T) => void,
          ) => (
            <div style={{ display: "flex", gap: 2 }}>
              {options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={`viewport-hud-button ${value === o.id ? "viewport-hud-button-active" : ""}`}
                  style={{ fontSize: 10, padding: "2px 6px", minWidth: 0, width: "auto" }}
                  onClick={() => set(o.id)}
                  title={o.title}
                >
                  {o.label}
                </button>
              ))}
            </div>
          );
          const row = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } as const;
          const label = { color: "#94a3b8", fontSize: 10 } as const;
          return (
            <div
              className="viewport-gp-hud"
              style={{
                position: "absolute",
                right: 12,
                bottom: 64,
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: "8px 10px",
                background: "var(--chrome-surface-raised)",
                border: "1px solid rgba(56, 189, 248, 0.3)",
                borderRadius: 8,
                color: "#fff",
                fontSize: 11,
                zIndex: 44,
                pointerEvents: "auto",
              }}
            >
              <div style={row}>
                <span style={label}>Orientation</span>
                {segmented(editOrientation, [
                  { id: "global", label: "Global", title: "Gizmo along the world axes" },
                  { id: "local", label: "Local", title: "Gizmo along the object's own axes" },
                  { id: "normal", label: "Normal", title: "Gizmo along the selection: Z out of its surface" },
                ], setEditOrientation)}
              </div>
              <div style={row}>
                <span style={label}>Pivot</span>
                {segmented(editPivot, [
                  { id: "median", label: "Median", title: "Rotate and scale about the selection's centre" },
                  { id: "individual", label: "Individual", title: "Each separate piece of the selection rotates and scales about its own centre" },
                  { id: "origin", label: "Origin", title: "Rotate and scale about the object's origin" },
                ], setEditPivot)}
              </div>
              <div style={row}>
                <span style={label}>Snap</span>
                {segmented(editSnap, [
                  { id: "off", label: "Off", title: "No snapping (hold Shift for steps)" },
                  { id: "increment", label: "Step", title: `Moves in steps of Snap Increment along the gizmo's axes, rotation in 15° steps` },
                  { id: "vertex", label: "Vertex", title: "A move snaps onto the vertex under the pointer" },
                ], setEditSnap)}
              </div>
              {vertices.length > 0 && (
                <div style={row}>
                  <span style={label} title="Marks on the selected edges (the edges of the selection in points / faces mode). Clicking again clears them.">
                    Mark
                  </span>
                  <div style={{ display: "flex", gap: 2 }}>
                    {(
                      [
                        { op: "sharp", label: "Sharp", color: "#22d3ee", title: "Sharp: shading stays hard across these edges" },
                        { op: "seam", label: "Seam", color: "#ef4444", title: "Seam: Unwrap and Smart UV Unwrap cut the layout here" },
                        { op: "crease", label: "Crease", color: "#e879f9", title: "Crease (Crease Weight): Subdivide keeps these edges tight" },
                      ] as const
                    ).map((b) => (
                      <button
                        key={b.op}
                        type="button"
                        className="viewport-hud-button"
                        style={{ fontSize: 10, padding: "2px 6px", minWidth: 0, width: "auto", color: b.color }}
                        onClick={() => editMeshCommandsRef.current?.run(b.op)}
                        title={b.title}
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {node.type === EDIT_MESH_NODE.type && (
                <div style={row}>
                  <span
                    style={label}
                    title="UV tools, as in Blender's U menu: on the selected faces, or every face with nothing selected. Turn on the UV Checker and the UV view (top-left of the viewport) to see the result."
                  >
                    UV
                  </span>
                  <div style={{ display: "flex", gap: 2, flexWrap: "wrap", justifyContent: "flex-end", maxWidth: 220 }}>
                    {(
                      [
                        { op: "uv-unwrap", label: "Unwrap", title: "Unwrap (conformal): flattens each island cut by the seams, keeping angles, then packs them into 0..1" },
                        { op: "uv-cube", label: "Cube", title: "Cube projection: each face onto its closest axis plane, 1 UV unit per scene unit" },
                        { op: "uv-cylinder", label: "Cylinder", title: "Cylinder projection round the vertical (Y) axis: around by up, at scene scale" },
                        { op: "uv-sphere", label: "Sphere", title: "Sphere projection about the selection's centre, Y the poles" },
                        { op: "uv-view", label: "View", title: "Project From View: the selection as the camera sees it, fitted into 0..1" },
                        { op: "uv-follow", label: "Follow", title: "Follow Active Quads: continues the last selected face's UVs across the others, quad by quad" },
                        { op: "uv-pack", label: "Pack", title: "Pack Islands: lays the existing UV islands out in 0..1 without reshaping them" },
                      ] as const
                    ).map((b) => (
                      <button
                        key={b.op}
                        type="button"
                        className="viewport-hud-button"
                        style={{ fontSize: 10, padding: "2px 6px", minWidth: 0, width: "auto" }}
                        onClick={() => editMeshCommandsRef.current?.run(b.op)}
                        title={b.title}
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {vertices.length > 0 && (
                <div style={row}>
                  <span style={label}>Material</span>
                  <div style={{ display: "flex", gap: 2 }}>
                    {/* Which material input the selected faces use */}
                    <select
                      value={Number(node.params.assignSlot ?? 1)}
                      onChange={(e) => onParamChange?.("assignSlot", Number(e.target.value), node.id)}
                      onKeyDown={(e) => e.stopPropagation()}
                      title="Material input to assign"
                      style={{
                        maxWidth: 110,
                        background: "rgba(15, 23, 42, 0.9)",
                        color: "#e2e8f0",
                        border: "1px solid rgba(148, 163, 184, 0.3)",
                        borderRadius: 4,
                        fontSize: 10,
                      }}
                    >
                      {materialSlotOptions(node).map((o) => (
                        <option key={o.slot} value={o.slot}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="viewport-hud-button"
                      style={{ fontSize: 10, padding: "2px 6px", minWidth: 0, width: "auto" }}
                      onClick={() => editMeshCommandsRef.current?.run("assign")}
                      title="Give the selected faces this material input"
                    >
                      Assign
                    </button>
                  </div>
                </div>
              )}
              {vertices.length > 0 && (
                <div style={row}>
                  <span style={label}>Colour</span>
                  <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
                    {/* Vertex colour: pick it here, then paint the selection with it */}
                    <div style={{ width: 110 }} title="Paint Colour">
                      <ColorPickerInput
                        value={node.params.paintColor ?? 0xff6b6b}
                        onChange={(color) => onParamChange?.("paintColor", color, node.id)}
                        placement="above-right"
                      />
                    </div>
                    <button
                      type="button"
                      className="viewport-hud-button"
                      style={{ fontSize: 10, padding: "2px 6px", minWidth: 0, width: "auto" }}
                      onClick={() => editMeshCommandsRef.current?.run("paint")}
                      title="Paint the selection with this colour (vertex colours)"
                    >
                      Paint
                    </button>
                  </div>
                </div>
              )}
              {vertices.length > 0 && (
                <div style={row}>
                  <span style={label} title="The selection's median position, in the object's own space — type a value to move it there">
                    Median
                  </span>
                  <div style={{ display: "flex", gap: 3 }}>
                    {(["x", "y", "z"] as const).map((axisName, axis) => (
                      <input
                        key={`${axisName}:${median.getComponent(axis).toFixed(4)}`}
                        type="number"
                        step={0.01}
                        defaultValue={Number(median.getComponent(axis).toFixed(4))}
                        title={axisName.toUpperCase()}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") setMedian(axis as 0 | 1 | 2, (e.target as HTMLInputElement).value);
                        }}
                        onBlur={(e) => setMedian(axis as 0 | 1 | 2, e.target.value)}
                        style={{
                          width: 58,
                          background: "rgba(15, 23, 42, 0.9)",
                          color: ["#f87171", "#4ade80", "#60a5fa"][axis],
                          border: "1px solid rgba(148, 163, 184, 0.3)",
                          borderRadius: 4,
                          fontSize: 11,
                          padding: "2px 4px",
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      {/* Edit Mesh modal tool readout */}
      {!outputMode && editModalHud && (
        <div
          style={{
            position: "absolute",
            top: 12,
            left: "50%",
            transform: "translateX(-50%)",
            padding: "6px 12px",
            borderRadius: 6,
            background: "var(--chrome-surface-raised)",
            border: "1px solid rgba(250, 204, 21, 0.5)",
            color: "#fde68a",
            fontSize: 12,
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            pointerEvents: "none",
            zIndex: 46,
            whiteSpace: "nowrap",
          }}
        >
          {editModalHud}
          <span style={{ color: "#94a3b8" }}> · type a value · Shift finer · click/Enter ✓ · right-click/Esc ✕</span>
        </div>
      )}
      {/* Edit Mesh Lasso Overlay (Shift+Drag, lasso shape) */}
      {!outputMode && lassoPath && (
        <svg
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 40 }}
        >
          <polygon
            points={lassoPath}
            fill="rgba(56, 189, 248, 0.18)"
            stroke="#38bdf8"
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
        </svg>
      )}
      {/* Edit Mesh Paint Cursor Overlay (Cmd+Drag) */}
      {!outputMode && editMeshPaintCursor && (
        <div
          style={{
            position: "absolute",
            left: `${editMeshPaintCursor.x - EDIT_MESH_BRUSH_RADIUS_PX}px`,
            top: `${editMeshPaintCursor.y - EDIT_MESH_BRUSH_RADIUS_PX}px`,
            width: `${EDIT_MESH_BRUSH_RADIUS_PX * 2}px`,
            height: `${EDIT_MESH_BRUSH_RADIUS_PX * 2}px`,
            borderRadius: "50%",
            border: "1.5px solid #f97316",
            backgroundColor: "rgba(249, 115, 22, 0.18)",
            pointerEvents: "none",
            zIndex: 40,
          }}
        />
      )}
      {/* Points Influence's Shift-drag gradient, while it is dragged: hot
          (influence 1) at the start, cold (0) at the end. */}
      {!outputMode && gradientLine && (
        <svg style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 40 }} width="100%" height="100%">
          <line
            x1={gradientLine.x1}
            y1={gradientLine.y1}
            x2={gradientLine.x2}
            y2={gradientLine.y2}
            stroke="#38bdf8"
            strokeWidth={2}
            strokeDasharray="6 4"
          />
          <circle cx={gradientLine.x1} cy={gradientLine.y1} r={5} fill={DISCRETE_LEVEL_HEX[DISCRETE_LEVEL_HEX.length - 1]} />
          <circle cx={gradientLine.x2} cy={gradientLine.y2} r={5} fill={DISCRETE_LEVEL_HEX[0]} />
        </svg>
      )}
      {/* Points Influence palette — tools on the left, the armed tool's
          options along the bottom (see PointsInfluenceHud). */}
      {!outputMode &&
        !elevationView &&
        selectedNodeId &&
        (() => {
          const infNode = graph.nodes.find((n) => n.id === selectedNodeId && n.type === POINTS_INFLUENCE_NODE.type);
          if (!infNode) return null;
          return (
            <PointsInfluenceHud
              node={infNode}
              levelColors={DISCRETE_LEVEL_HEX}
              maxRows={hudToolMaxRows}
              left={hudToolColumnLeft}
              onParams={(params, nodeId) => onParamChange?.(params, undefined, nodeId)}
              onClear={() => {
                const state = getTexturePaintState(infNode.id);
                if (state.canvas) clearPaintCanvas(state.canvas, POINTS_INFLUENCE_BASE);
                if (state.texture) state.texture.needsUpdate = true;
                onParamChange?.("textureData", "", infNode.id);
              }}
              onBlurPreview={(radius) => {
                const state = getTexturePaintState(infNode.id);
                const ctx2d = state.canvas?.getContext("2d", { willReadFrequently: true });
                if (!state.canvas || !ctx2d) return;
                let session = influenceBlurRef.current;
                if (!session || session.nodeId !== infNode.id) {
                  const result = latestResultsRef.current?.get(infNode.id);
                  const mesh = result?.geometry instanceof THREE.Object3D ? findFirstMesh(result.geometry) : null;
                  const uv = mesh?.geometry.attributes.uv;
                  const position = mesh?.geometry.attributes.position;
                  session = {
                    nodeId: infNode.id,
                    src: ctx2d.getImageData(0, 0, state.canvas.width, state.canvas.height),
                    surface:
                      uv && position
                        ? prepareSurfaceBlur(state.canvas.width, state.canvas.height, uv, position, mesh.geometry.index?.array)
                        : null,
                    radius,
                    frame: null,
                  };
                  influenceBlurRef.current = session;
                }
                session.radius = radius;
                if (session.frame !== null) return;
                const current = session;
                current.frame = requestAnimationFrame(() => {
                  current.frame = null;
                  if (influenceBlurRef.current !== current) return;
                  const blurred = blurInfluence(current, current.radius);
                  const { src } = current;
                  ctx2d.putImageData(new ImageData(blurred, src.width, src.height), 0, 0);
                  if (state.texture) state.texture.needsUpdate = true;
                });
              }}
              onBlurEnd={(commit) => {
                const session = influenceBlurRef.current;
                influenceBlurRef.current = null;
                const state = getTexturePaintState(infNode.id);
                if (!session || session.nodeId !== infNode.id || !state.canvas) return;
                const ctx2d = state.canvas.getContext("2d", { willReadFrequently: true });
                if (session.frame !== null) {
                  // Released before the last radius was shown: show it now, so what is kept is what was asked for.
                  cancelAnimationFrame(session.frame);
                  if (commit) {
                    const { src } = session;
                    const blurred = blurInfluence(session, session.radius);
                    ctx2d?.putImageData(new ImageData(blurred, src.width, src.height), 0, 0);
                    if (state.texture) state.texture.needsUpdate = true;
                  }
                }
                if (!commit) {
                  ctx2d?.putImageData(session.src, 0, 0);
                  if (state.texture) state.texture.needsUpdate = true;
                  return;
                }
                // The canvas already shows the result: mark it restored so the
                // node doesn't decode its own PNG back over it, and drop any
                // pending stroke snapshot this one supersedes.
                const textureData = serializePaintCanvas(state.canvas);
                state.lastDataUrl = textureData;
                const pending = textureSnapshotTimersRef.current.get(infNode.id);
                if (pending !== undefined) {
                  clearTimeout(pending);
                  textureSnapshotTimersRef.current.delete(infNode.id);
                }
                onParamChange?.("textureData", textureData, infNode.id, { coalesce: false });
              }}
            />
          );
        })()}
      {/* Points Selection palette — only the X-Ray toggle, in the same
          column Edit Mesh and Points Influence keep theirs in. */}
      {!outputMode &&
        !elevationView &&
        selectedNodeId &&
        (() => {
          const selNode = graph.nodes.find((n) => n.id === selectedNodeId && n.type === POINTS_SELECTION_NODE.type);
          if (!selNode) return null;
          const xray = selNode.params.xray === true;
          return (
            <HudToolColumn maxRows={hudToolMaxRows} left={hudToolColumnLeft}>
              <button
                type="button"
                className={`viewport-hud-button ${xray ? "viewport-hud-button-active" : ""}`}
                onClick={() => onParamChange?.("xray", !xray, selNode.id)}
                title={
                  xray
                    ? "X-Ray ON — clicks and the marquee reach the points behind the surface too (Shortcut: Alt+Z)"
                    : "X-Ray OFF — clicks and the marquee only reach the points the camera sees (Shortcut: Alt+Z)"
                }
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="4" y="4" width="11" height="11" rx="1" />
                  <rect x="9" y="9" width="11" height="11" rx="1" strokeDasharray="2 2" />
                </svg>
              </button>
            </HudToolColumn>
          );
        })()}
      {/* Grease Pencil live stroke drag preview */}
      {!outputMode && isGpDrawing && gpLivePreview.length > 1 && (
        <svg
          style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 42 }}
          width="100%"
          height="100%"
        >
          {gpSolidFill && gpLivePreview.length >= 3 && (
            <polygon
              points={gpLivePreview.map((p) => `${p.screenX},${p.screenY}`).join(" ")}
              fill={
                parseColorHex(
                  graph.nodes.find((n) => n.id === selectedNodeId)?.params.fillColor,
                  "",
                ) ||
                parseColorHex(
                  graph.nodes.find((n) => n.id === selectedNodeId)?.params.activeColor,
                  "#38bdf8",
                )
              }
              fillOpacity={0.35}
            />
          )}
          <polyline
            points={gpLivePreview.map((p) => `${p.screenX},${p.screenY}`).join(" ")}
            fill="none"
            stroke={parseColorHex(
              graph.nodes.find((n) => n.id === selectedNodeId)?.params.activeColor,
              "#38bdf8",
            )}
            strokeWidth={
              Number(graph.nodes.find((n) => n.id === selectedNodeId)?.params.brushSize) || 4
            }
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {/* Lasso path (select / carve) and the highlight over picked strokes */}
      {!outputMode && (gpLassoPreview.length > 1 || gpSelectionOverlay.length > 0) && (
        <svg
          style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 43 }}
          width="100%"
          height="100%"
        >
          {gpSelectionOverlay.map((line, i) => (
            <polyline
              key={`gp-sel-${i}`}
              points={line.map((p) => `${p.screenX},${p.screenY}`).join(" ")}
              fill="none"
              stroke="var(--accent-color, #38bdf8)"
              strokeWidth={3}
              strokeOpacity={0.9}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {gpLassoPreview.length > 1 &&
            (() => {
              const rect = hostRef.current?.getBoundingClientRect();
              const ox = rect?.left ?? 0;
              const oy = rect?.top ?? 0;
              const pts = gpLassoPreview.map((p) => `${p.x - ox},${p.y - oy}`).join(" ");
              return (
                // Both lassos take the interface accent; what tells them
                // apart is the dash — a tight, ticking outline for the
                // destructive one — rather than a hue the palette does not own.
                <polygon
                  points={pts}
                  fill="color-mix(in srgb, var(--accent-color, #38bdf8) 12%, transparent)"
                  stroke="var(--accent-color, #38bdf8)"
                  strokeWidth={1.5}
                  strokeDasharray={gpTool === "carve" ? "2 3" : "6 4"}
                />
              );
            })()}
        </svg>
      )}
      {/* Transient hint from the lasso / fill tools */}
      {!outputMode && gpToolHint && (
        <div
          style={{
            position: "absolute",
            bottom: 56,
            left: "50%",
            transform: "translateX(-50%)",
            padding: "6px 12px",
            borderRadius: 6,
            background: "var(--chrome-surface, #3b434f)",
            border: "1px solid var(--chrome-border, #5a6472)",
            color: "var(--chrome-text, #eef2f6)",
            fontSize: 11,
            pointerEvents: "none",
            zIndex: 44,
          }}
        >
          {gpToolHint}
        </div>
      )}
      {/* Passe-partout guide: target-output-aspect crop, shown while a Camera
          node is selected so "Aligner Caméra" reproduces what's actually
          framed — see the comment in tick() next to cameraGuideRef. */}
      {!outputMode && <div className="viewport-camera-guide" ref={cameraGuideRef} />}
      {/* Grease Pencil Floating Toolbar */}
      {!outputMode &&
        !elevationView &&
        selectedNodeId &&
        (() => {
          const gpNode = graph.nodes.find(
            (n) => n.id === selectedNodeId && isPaintOrGreaseNode(n),
          );
          if (!gpNode) return null;
          const activeColor = parseColorHex(gpNode.params.activeColor, "#38bdf8");
          const fillColor = parseColorHex(gpNode.params.fillColor, "");
          const brushSize = Number(gpNode.params.brushSize) || 4;
          const onionSkin = Boolean(gpNode.params.onionSkin ?? true);
          return (
            <>
              <HudToolColumn maxRows={hudToolMaxRows} left={hudToolColumnLeft}>
                {/* Tool: Pen */}
                <button
                  type="button"
                  className={`viewport-hud-button ${gpTool === "pen" ? "viewport-hud-button-active" : ""}`}
                  onClick={() => setGpTool("pen")}
                  title="Pen (freehand drawing — hold Shift at start/end to taper)"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                    <path d="m15 5 4 4" />
                  </svg>
                </button>

                {/* Shape tools. Shift constrains (square / circle / 15° line),
                    Ctrl draws from the centre, Alt flips an arc's bulge. */}
                {(
                  [
                    {
                      tool: "line" as GpToolMode,
                      title: "Line (Shift: snap angle · Ctrl: from centre)",
                      path: <line x1="4" y1="20" x2="20" y2="4" />,
                    },
                    {
                      tool: "rect" as GpToolMode,
                      title: "Rectangle (Shift: square · Ctrl: from centre)",
                      path: <rect x="4" y="5" width="16" height="14" rx="1" />,
                    },
                    {
                      tool: "ellipse" as GpToolMode,
                      title: "Ellipse (Shift: circle · Ctrl: from centre)",
                      path: <ellipse cx="12" cy="12" rx="9" ry="6.5" />,
                    },
                    {
                      tool: "arc" as GpToolMode,
                      title: "Arc (Alt: flip the bulge)",
                      path: <path d="M4 20 A 16 16 0 0 1 20 4" />,
                    },
                    {
                      tool: "polyline" as GpToolMode,
                      title: "Polyline (click each vertex · double-click or Enter to close · Esc to end open)",
                      path: <polyline points="3 18 9 8 14 15 21 5" />,
                    },
                    {
                      tool: "fill" as GpToolMode,
                      title: "Fill (click inside a closed region — Brush Size sets how big a gap is bridged)",
                      path: (
                        <>
                          <path d="M19 11 11 3 3 11l8 8z" />
                          <path d="M19 15c0 1.7 1.3 3 2 3s2-1.3 2-3-2-4-2-4-2 2.3-2 4Z" />
                        </>
                      ),
                    },
                  ] as const
                ).map(({ tool, title, path }) => (
                  <button
                    key={tool}
                    type="button"
                    className={`viewport-hud-button ${gpTool === tool ? "viewport-hud-button-active" : ""}`}
                    onClick={() => setGpTool(tool)}
                    title={title}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      {path}
                    </svg>
                  </button>
                ))}

                {/* Tool: Hard Eraser */}
                <button
                  type="button"
                  className={`viewport-hud-button ${gpTool === "eraser_hard" ? "viewport-hud-button-active" : ""}`}
                  onClick={() => setGpTool("eraser_hard")}
                  title="Hard Eraser (erase entire stroke on contact)"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
                    <path d="M22 21H7" />
                    <path d="m5 11 9 9" />
                  </svg>
                </button>

                {/* Tool: Soft Eraser */}
                <button
                  type="button"
                  className={`viewport-hud-button ${gpTool === "eraser_soft" ? "viewport-hud-button-active" : ""}`}
                  onClick={() => setGpTool("eraser_soft")}
                  title="Soft Eraser (gradually thin and fade strokes)"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray="2 2"
                  >
                    <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
                    <path d="M22 21H7" strokeDasharray="none" />
                    <path d="m5 11 9 9" />
                  </svg>
                </button>

                {/* Tool: Stroke Eraser — removes a whole line on contact */}
                <button
                  type="button"
                  className={`viewport-hud-button ${gpTool === "eraser_stroke" ? "viewport-hud-button-active" : ""}`}
                  onClick={() => setGpTool("eraser_stroke")}
                  title="Stroke Eraser (touch a line to delete all of it)"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 17c4-9 10-11 18-12" />
                    <path d="m14 8 7 7M21 8l-7 7" />
                  </svg>
                </button>

                {/* Tool: Lasso select (drag to pick, drag again to move, ⌫ to delete) */}
                <button
                  type="button"
                  className={`viewport-hud-button ${gpTool === "lasso" ? "viewport-hud-button-active" : ""}`}
                  onClick={() => setGpTool("lasso")}
                  title="Lasso Select (Shift: only fully enclosed · drag selection to move · ⌫ delete · Esc clear)"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <ellipse cx="12" cy="9" rx="9" ry="6" strokeDasharray="3 2" />
                    <path d="M8 14.5c0 2 1 3.5 1 5" />
                  </svg>
                </button>

                {/* Tool: Carver — boolean subtraction along a lasso */}
                <button
                  type="button"
                  className={`viewport-hud-button ${gpTool === "carve" ? "viewport-hud-button-active" : ""}`}
                  onClick={() => setGpTool("carve")}
                  title="Carver (lasso a region to subtract it — cuts strokes, punches holes in fills)"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="10" cy="12" r="7" strokeDasharray="3 2" />
                    <path d="M14 5h7v7" />
                    <path d="M21 5 13 13" />
                  </svg>
                </button>

                {/* Tool: Tint */}
                <button
                  type="button"
                  className={`viewport-hud-button ${gpTool === "tint" ? "viewport-hud-button-active" : ""}`}
                  onClick={() => setGpTool("tint")}
                  title="Tint (paint over strokes to blend their color with active color)"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11Z" />
                    <path d="m5 2 5 5" />
                    <circle cx="19" cy="19" r="3" />
                  </svg>
                </button>

                {/* Tool: Gizmo / Transform */}
                <button
                  type="button"
                  className={`viewport-hud-button ${gpTool === "select" ? "viewport-hud-button-active" : ""}`}
                  onClick={() =>
                    setGpTool((prev) => (prev === "select" ? "pen" : "select"))
                  }
                  title={
                    gpTool === "select"
                      ? "Gizmo active (modify object transform, drawing disabled — click to return to Pen)"
                      : "Gizmo (transform object in 3D without drawing)"
                  }
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="5 9 2 12 5 15" />
                    <polyline points="9 5 12 2 15 5" />
                    <polyline points="15 19 12 22 9 19" />
                    <polyline points="19 9 22 12 19 15" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <line x1="12" y1="2" x2="12" y2="22" />
                  </svg>
                </button>
              </HudToolColumn>

              <HudBar>
                {/* Frame Indicator */}
                <div
                  style={{
                    fontSize: "11px",
                    fontWeight: 700,
                    color: "#38bdf8",
                    padding: "2px 8px",
                    background: "rgba(56, 189, 248, 0.15)",
                    borderRadius: "4px",
                    letterSpacing: "0.02em",
                    userSelect: "none",
                  }}
                  title="Current frame"
                >
                  {currentFrame >= 0 ? currentFrame : 0}
                </div>

                <HudSeparator />

                {/* Brush Preset Selector */}
                <select
                  value={gpBrushType}
                  onChange={(e) => {
                    const b = e.target.value as GreaseBrushType;
                    setGpBrushType(b);
                    onParamChange?.("brushType", b, gpNode.id);
                  }}
                  style={{
                    background: "rgba(255, 255, 255, 0.08)",
                    color: "#f1f5f9",
                    border: "1px solid rgba(255, 255, 255, 0.15)",
                    borderRadius: 4,
                    fontSize: "11px",
                    height: 24,
                    padding: "0 6px",
                    outline: "none",
                    cursor: "pointer",
                  }}
                  title="Brush preset — Marker Bold follows stylus tilt; Pencil, Charcoal and Watercolour are textured media"
                >
                  <option value="ink_pen" style={{ background: "#1e293b", color: "#fff" }}>Ink Pen</option>
                  <option value="ink_pen_rough" style={{ background: "#1e293b", color: "#fff" }}>Ink Pen Rough</option>
                  <option value="marker_bold" style={{ background: "#1e293b", color: "#fff" }}>Marker Bold</option>
                  <option value="airbrush" style={{ background: "#1e293b", color: "#fff" }}>Airbrush</option>
                  <option value="pencil" style={{ background: "#1e293b", color: "#fff" }}>Pencil</option>
                  <option value="charcoal" style={{ background: "#1e293b", color: "#fff" }}>Charcoal</option>
                  <option value="watercolor" style={{ background: "#1e293b", color: "#fff" }}>Watercolour</option>
                  <optgroup label="p5.brush (painted texture)" style={{ background: "#1e293b", color: "#94a3b8" }}>
                    {P5_GREASE_BRUSH_LABELS.map(([value, label]) => (
                      <option key={value} value={value} style={{ background: "#1e293b", color: "#fff" }}>{label}</option>
                    ))}
                  </optgroup>
                </select>

                {/* Solid Fill Toggle */}
                <button
                  type="button"
                  className={`viewport-hud-button ${gpSolidFill ? "viewport-hud-button-active" : ""}`}
                  onClick={() => {
                    const next = !gpSolidFill;
                    setGpSolidFill(next);
                    onParamChange?.("solidFill", next, gpNode.id);
                  }}
                  title="Solid Fill (toggle shape interior fill)"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill={gpSolidFill ? "currentColor" : "none"}
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polygon points="12 2 2 22 22 22" />
                  </svg>
                </button>

                <HudSeparator />

                {/* Stroke Color picker */}
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    cursor: "pointer",
                  }}
                  title="Stroke color (outline)"
                >
                  <input
                    type="color"
                    value={activeColor}
                    onChange={(e) =>
                      onParamChange?.("activeColor", e.target.value, gpNode.id)
                    }
                    style={{
                      width: 18,
                      height: 18,
                      padding: 0,
                      border: "1px solid rgba(255,255,255,0.4)",
                      borderRadius: "50%",
                      cursor: "pointer",
                      backgroundColor: "transparent",
                    }}
                  />
                </label>

                {/* Fill Color picker */}
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    cursor: "pointer",
                    opacity: gpSolidFill ? 1 : 0.4,
                  }}
                  title={gpSolidFill ? "Fill color (interior shape color)" : "Fill color (enable Solid Fill to activate)"}
                >
                  <input
                    type="color"
                    value={fillColor || activeColor}
                    onChange={(e) =>
                      onParamChange?.("fillColor", e.target.value, gpNode.id)
                    }
                    style={{
                      width: 18,
                      height: 18,
                      padding: 0,
                      border: "1px solid rgba(255,255,255,0.4)",
                      borderRadius: 4,
                      cursor: "pointer",
                      backgroundColor: "transparent",
                    }}
                  />
                </label>

                {/* Brush Size Slider */}
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span
                    style={{
                      fontSize: "11px",
                      color: "#94a3b8",
                      minWidth: 24,
                      textAlign: "right",
                    }}
                  >
                    {brushSize}px
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={32}
                    value={brushSize}
                    onChange={(e) =>
                      onParamChange?.(
                        "brushSize",
                        Number(e.target.value),
                        gpNode.id,
                      )
                    }
                    style={{
                      width: 56,
                      accentColor: "#38bdf8",
                      cursor: "pointer",
                    }}
                    title="Brush thickness"
                  />
                </div>

                <HudSeparator />

                {/* Stroke Smoothing Slider */}
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span
                    style={{
                      fontSize: "11px",
                      color: "#94a3b8",
                      minWidth: 42,
                      textAlign: "right",
                    }}
                    title="Stroke smoothing to remove involuntary hand tremors"
                  >
                    Smooth {Math.round(Math.max(0, Math.min(1, Number(gpNode.params.smoothing ?? 0.2))) * 100)}%
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={Math.max(0, Math.min(1, Number(gpNode.params.smoothing ?? 0.2)))}
                    onChange={(e) =>
                      onParamChange?.(
                        "smoothing",
                        Number(e.target.value),
                        gpNode.id,
                      )
                    }
                    style={{
                      width: 50,
                      accentColor: "#38bdf8",
                      cursor: "pointer",
                    }}
                    title="Stroke smoothing (eliminates involuntary hand tremors during drawing)"
                  />
                </div>

                <HudSeparator />

                {/* Lock / Keyframe Button */}
                <button
                  type="button"
                  className="viewport-hud-button"
                  onClick={() => {
                    const currentFrames =
                      (gpNode.params.frames as KeyframeDrawing[]) || [];
                    const targetFrame =
                      currentFrame >= 0 ? currentFrame : 0;
                    const updated = duplicateDrawing(
                      currentFrames,
                      targetFrame,
                      targetFrame,
                    );
                    onParamChange?.("frames", updated, gpNode.id);
                  }}
                  title="Insert keyframe at current frame"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </button>

                {/* Blank Next Button */}
                <button
                  type="button"
                  className="viewport-hud-button"
                  onClick={() => {
                    const targetFrame =
                      (currentFrame >= 0 ? currentFrame : 0) + 1;
                    const currentFrames =
                      (gpNode.params.frames as KeyframeDrawing[]) || [];
                    const updated = createBlankDrawing(
                      currentFrames,
                      targetFrame,
                    );
                    onParamChange?.("frames", updated, gpNode.id);
                    onFrameChange?.(targetFrame);
                  }}
                  title="Blank keyframe at next frame"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 12h14" />
                    <path d="m12 5 7 7-7 7" />
                  </svg>
                </button>

                {/* Duplicate Next Button */}
                <button
                  type="button"
                  className="viewport-hud-button"
                  onClick={() => {
                    const curF = currentFrame >= 0 ? currentFrame : 0;
                    const targetFrame = curF + 1;
                    const currentFrames =
                      (gpNode.params.frames as KeyframeDrawing[]) || [];
                    const updated = duplicateDrawing(
                      currentFrames,
                      curF,
                      targetFrame,
                    );
                    onParamChange?.("frames", updated, gpNode.id);
                    onFrameChange?.(targetFrame);
                  }}
                  title="Duplicate drawing to next frame"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                  </svg>
                </button>

                {/* Clear Button */}
                <button
                  type="button"
                  className="viewport-hud-button"
                  onClick={() => {
                    const curF = currentFrame >= 0 ? currentFrame : 0;
                    const currentFrames =
                      (gpNode.params.frames as KeyframeDrawing[]) || [];
                    const updated = clearDrawingAtFrame(currentFrames, curF);
                    onParamChange?.("frames", updated, gpNode.id);
                  }}
                  title="Clear drawing at current frame"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 6h18" />
                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                  </svg>
                </button>

                <HudSeparator />

                {/* Onion Skin toggle */}
                <button
                  type="button"
                  className={`viewport-hud-button ${onionSkin ? "viewport-hud-button-active" : ""}`}
                  onClick={() => {
                    onParamChange?.("onionSkin", !onionSkin, gpNode.id);
                  }}
                  title={
                    onionSkin
                      ? "Disable onion skinning"
                      : "Enable onion skinning (ghosting)"
                  }
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <circle cx="12" cy="6" r="6" />
                    <circle cx="12" cy="2" r="2" />
                  </svg>
                </button>
              </HudBar>
            </>
          );
        })()}
      {/* Music: a selected Pattern is edited as a tracker grid (see PatternHud.tsx) */}
      {!outputMode &&
        !elevationView &&
        selectedNodeId &&
        (() => {
          const patternNode = graph.nodes.find((n) => n.id === selectedNodeId && n.type === "music/pattern");
          if (!patternNode) return null;
          // Follow the wires downstream (through Arps) to the voice the pattern plays on, and on to its Music Out.
          const downstream = (id: string) => graph.connections.filter((c) => c.fromNode === id).map((c) => graph.nodes.find((n) => n.id === c.toNode)).filter((n): n is NonNullable<typeof n> => !!n);
          let frontier = [patternNode];
          let voice: (typeof graph.nodes)[number] | undefined;
          for (let hops = 0; hops < 6 && frontier.length > 0 && !voice; hops++) {
            const next = frontier.flatMap((n) => downstream(n.id));
            voice = next.find((n) => n.type === "music/fm-voice" || n.type === "music/drum-kit");
            frontier = next.filter((n) => n.type === "music/arp");
          }
          const out = voice ? downstream(voice.id).find((n) => n.type === "music/out") : graph.nodes.find((n) => n.type === "music/out");
          const voiceResult = voice ? latestResultsRef.current?.get(voice.id)?.track : null;
          const previewSound: PreviewSound | null = isTrack(voiceResult)
            ? voiceResult.kind === "fm"
              ? { kind: "fm", patch: voiceResult.patch }
              : { kind: "drums", drums: voiceResult.drums }
            : null;
          return (
            <PatternHud
              node={patternNode}
              drums={voice?.type === "music/drum-kit"}
              readPlayhead={() => {
                const render = renderNodeIdRef.current ? latestResultsRef.current?.get(renderNodeIdRef.current) : undefined;
                return { frame: Math.max(0, currentFrameRef.current), fps: typeof render?.fps === "number" ? (render.fps as number) : 30 };
              }}
              readSequence={() => sequenceOf(latestResultsRef.current?.get(patternNode.id)?.sequence)}
              startFrame={Math.round(Number(out?.params.startFrame ?? 0)) || 0}
              previewSound={previewSound}
              onParams={(params, nodeId) => onParamChange?.(params, nodeId)}
              onPreview={(sound, note, velocity) => previewNote(sound, note, velocity)}
            />
          );
        })()}
      {/* Rig palettes: building a Skeleton, and editing how each joint pulls on a Skin's mesh */}
      {!outputMode &&
        !elevationView &&
        selectedNodeId &&
        (() => {
          const rigNode = graph.nodes.find(
            (n) =>
              n.id === selectedNodeId &&
              (n.type === SKELETON_NODE_TYPE ||
                n.type === SKIN_NODE.type ||
                n.type === RIG_BIPED_MOTION_NODE.type ||
                n.type === RIG_BIPED_POSE_NODE.type ||
                n.type === RIG_BIPED_DANCE_NODE.type ||
                n.type === RIG_HUMAN_NODE.type),
          );
          if (!rigNode) return null;
          if (rigNode.type === RIG_BIPED_POSE_NODE.type || rigNode.type === RIG_HUMAN_NODE.type) {
            const result = latestResultsRef.current?.get(rigNode.id);
            const geometry = result?.geometry as THREE.Object3D | undefined;
            const controls = Array.isArray(result?.__controlPoints) ? (result.__controlPoints as THREE.Vector3[]) : [];
            return (
              <PoseHud
                node={rigNode}
                skeleton={geometry?.userData?.humanRig?.skeleton ?? null}
                controls={controls}
                influence={rigNode.type === RIG_BIPED_POSE_NODE.type}
                onParams={(params, nodeId) => onParamChange?.(params, nodeId)}
                onAction={(nodeId, action) => onParamAction?.(nodeId, action)}
              />
            );
          }
          if (rigNode.type === RIG_BIPED_DANCE_NODE.type) {
            return (
              <DanceHud
                node={rigNode}
                laneNames={graph.connections
                  .filter((c) => c.toNode === rigNode.id && /^pose\d+$/.test(c.toSocket))
                  .reduce<string[]>((names, c) => {
                    const from = graph.nodes.find((n) => n.id === c.fromNode);
                    names[Number(c.toSocket.slice(4))] = String(from?.params.name || from?.type.replace("rig/", "") || "pose");
                    return names;
                  }, [])}
                readInfo={() => (latestResultsRef.current?.get(rigNode.id)?.__danceInfo as DanceInfo | undefined) ?? null}
                onParams={(params, nodeId) => onParamChange?.(params, nodeId)}
              />
            );
          }
          if (rigNode.type === RIG_BIPED_MOTION_NODE.type) {
            return (
              <BipedHud
                node={rigNode}
                poseNames={graph.connections
                  .filter((c) => c.toNode === rigNode.id && /^pose\d+$/.test(c.toSocket))
                  .reduce<string[]>((names, c) => {
                    const from = graph.nodes.find((n) => n.id === c.fromNode);
                    names[Number(c.toSocket.slice(4))] = String(from?.params.name || from?.type.replace("rig/", "") || "pose");
                    return names;
                  }, [])}
                readInfo={() => (latestResultsRef.current?.get(rigNode.id)?.__gaitInfo as BipedGaitInfo | undefined) ?? null}
                onParams={(params, nodeId) => onParamChange?.(params, nodeId)}
              />
            );
          }
          if (rigNode.type === SKELETON_NODE_TYPE) {
            return (
              <SkeletonHud
                node={rigNode}
                selection={skeletonSelection}
                maxRows={hudToolMaxRows}
                left={hudToolColumnLeft}
                onOp={(op) => skeletonCommandsRef.current?.run(op)}
                onParams={(params, nodeId) => onParamChange?.(params, nodeId)}
              />
            );
          }
          const published = (latestResultsRef.current?.get(rigNode.id)?.geometry as THREE.Object3D | undefined)?.userData?.skinEdit;
          return (
            <SkinHud
              node={rigNode}
              joints={published ? { names: published.names, count: published.joints.length, mirror: published.mirror } : null}
              onParams={(params, nodeId) => onParamChange?.(params, nodeId)}
            />
          );
        })()}

      {/* Edit Mesh Floating Toolbar */}
      {!outputMode &&
        !elevationView &&
        selectedNodeId &&
        (() => {
          const editMeshNode = findEditMeshNode(graph, selectedNodeId, true);
          if (!editMeshNode) return null;
          const { mode: selectMode, selection, isPointsOnly } = readEditMeshSelection(editMeshNode);
          const isFacesActive = !isPointsOnly && selectMode === "faces" && selection.faces.length > 0;
          const selectedCount =
            selectMode === "points" ? selection.points.length : selectMode === "edges" ? selection.edges.length : selection.faces.length;
          // What the node is editing right now — the HUD's selection tools
          // (mode switch, grow, shrink, linked, flat) all work on it.
          const hudQuadMesh = (): QuadMesh | null => {
            const meshObj = latestResultsRef.current?.get(editMeshNode.id)?.geometry;
            const srcMesh = meshObj instanceof THREE.Object3D ? findFirstMesh(meshObj) : null;
            return srcMesh ? editMeshQuadMesh(editMeshNode, latestResultsRef.current, srcMesh) : null;
          };
          const commitHudSelection = (next: (quadMesh: QuadMesh) => MeshSelection) => {
            const quadMesh = hudQuadMesh();
            if (quadMesh) onParamChange?.(editMeshSelectionParams(editMeshNode, selectMode, next(quadMesh), quadMesh), editMeshNode.id);
          };
          const switchMode = (to: SelectMode) => {
            const quadMesh = hudQuadMesh();
            onParamChange?.(quadMesh ? editMeshModeSwitchParams(editMeshNode, to, quadMesh) : { selectMode: to }, editMeshNode.id);
          };

          return (
            <>
              {/* Tool column: what a click or drag in the viewport does —
                  select mode, selection shape, gizmo, and the interactive
                  tools that act on the selection. */}
              <HudToolColumn maxRows={hudToolMaxRows} left={hudToolColumnLeft}>
                {/* Select modes — switching converts the selection (Blender's 1 / 2 / 3) */}
                <button
                  type="button"
                  className={`viewport-hud-button ${selectMode === "points" ? "viewport-hud-button-active" : ""}`}
                  onClick={() => {
                    if (!isPointsOnly) switchMode("points");
                  }}
                  title={isPointsOnly ? "Points Mode (Vertices)" : "Points Mode — Select and transform vertices"}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="5" cy="5" r="2.5" />
                    <circle cx="19" cy="5" r="2.5" />
                    <circle cx="5" cy="19" r="2.5" />
                    <circle cx="19" cy="19" r="2.5" />
                    <path d="M5 5h14v14H5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2" />
                  </svg>
                </button>

                {!isPointsOnly && (
                  <button
                    type="button"
                    className={`viewport-hud-button ${selectMode === "edges" ? "viewport-hud-button-active" : ""}`}
                    onClick={() => switchMode("edges")}
                    title="Edges Mode — Select and transform edges (Alt+click: edge loop, Cmd/Ctrl+Alt+click: edge ring)"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M4 4h16v16H4z" strokeDasharray="2 2" />
                      <line x1="4" y1="20" x2="20" y2="4" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                  </button>
                )}

                {!isPointsOnly && (
                  <button
                    type="button"
                    className={`viewport-hud-button ${selectMode === "faces" ? "viewport-hud-button-active" : ""}`}
                    onClick={() => switchMode("faces")}
                    title="Faces Mode — Select and transform faces (Alt+click: face loop)"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor" fillOpacity="0.3" />
                    </svg>
                  </button>
                )}

                {/* Selection shape: what Shift+drag draws */}
                <button
                  type="button"
                  className={`viewport-hud-button ${editMeshMarqueeShape === "lasso" ? "viewport-hud-button-active" : ""}`}
                  onClick={() => setEditMeshMarqueeShape((shape) => (shape === "box" ? "lasso" : "box"))}
                  title={
                    editMeshMarqueeShape === "lasso"
                      ? "Shift+drag draws a Lasso — click for Box"
                      : "Shift+drag draws a Box — click for Lasso"
                  }
                >
                  {editMeshMarqueeShape === "lasso" ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                      <path d="M7 16c-3-1-4-4-3-7 2-5 12-6 15-2 2 3-1 7-6 7-2 0-4 0-6 2" />
                      <path d="M7 16l-1 4" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <rect x="4" y="5" width="16" height="14" strokeDasharray="3 2" />
                    </svg>
                  )}
                </button>

                {/* Transform Mode: Loc */}
                <button
                  type="button"
                  className={`viewport-hud-button ${transformMode === "translate" ? "viewport-hud-button-active" : ""}`}
                  onClick={() => setTransformMode("translate")}
                  title="Translate / Move (Shortcut: G / W)"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="5 9 2 12 5 15" />
                    <polyline points="9 5 12 2 15 5" />
                    <polyline points="15 19 12 22 9 19" />
                    <polyline points="19 9 22 12 19 15" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <line x1="12" y1="2" x2="12" y2="22" />
                  </svg>
                </button>

                {/* Transform Mode: Rot */}
                <button
                  type="button"
                  className={`viewport-hud-button ${transformMode === "rotate" ? "viewport-hud-button-active" : ""}`}
                  onClick={() => setTransformMode("rotate")}
                  title="Rotate (Shortcut: R / E)"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" />
                    <polyline points="21 3 21 8 16 8" />
                  </svg>
                </button>

                {/* Transform Mode: Scale */}
                <button
                  type="button"
                  className={`viewport-hud-button ${transformMode === "scale" ? "viewport-hud-button-active" : ""}`}
                  onClick={() => setTransformMode("scale")}
                  title="Scale (Shortcut: S / R)"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 3 21 3 21 9" />
                    <polyline points="9 21 3 21 3 15" />
                    <line x1="21" y1="3" x2="14" y2="10" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </svg>
                </button>

                {/* Interactive tools — always listed so the column keeps its
                    shape; disabled until there is something to act on. */}
                {!isPointsOnly && (
                  <>
                    {/* Tool: Extrude */}
                    <button
                      type="button"
                      className="viewport-hud-button"
                      disabled={selectedCount === 0}
                      onClick={() =>
                        isFacesActive
                          ? onParamAction?.(editMeshNode.id, EDIT_MESH_EXTRUDE_ACTION)
                          : editMeshCommandsRef.current?.extrude()
                      }
                      title={
                        isFacesActive
                          ? "Extrude by Extrude Distance — or press E over the viewport to drag it (Alt+E: each face on its own)"
                          : "Extrude the selected points or edges, then move them with the mouse (Shortcut: E)"
                      }
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 19V5M5 12l7-7 7 7" />
                      </svg>
                    </button>

                    {/* Tool: Inset */}
                    <button
                      type="button"
                      className="viewport-hud-button"
                      disabled={!isFacesActive}
                      onClick={() => onParamAction?.(editMeshNode.id, EDIT_MESH_INSET_ACTION)}
                      title="Inset by Inset Thickness / Depth — or press I over the viewport to drag it (I again: each face on its own, Cmd/Ctrl: depth)"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <rect x="8" y="8" width="8" height="8" rx="1" />
                      </svg>
                    </button>

                    {/* Tool: Bevel */}
                    <button
                      type="button"
                      className="viewport-hud-button"
                      disabled={selectedCount === 0}
                      onClick={() => editMeshCommandsRef.current?.tool("bevel")}
                      title="Bevel the selected edges — drag for width, wheel for segments (Shortcut: Cmd/Ctrl+B)"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                        <path d="M4 20V9l5-5h11" />
                        <path d="M4 9h5V4" strokeDasharray="2 2" opacity="0.6" />
                      </svg>
                    </button>

                    {/* Tool: Loop Cut */}
                    <button
                      type="button"
                      className={`viewport-hud-button ${editMeshTool === "loopcut" ? "viewport-hud-button-active" : ""}`}
                      onClick={() => setEditMeshTool((t) => (t === "loopcut" ? "select" : "loopcut"))}
                      title={`Loop Cut (Shortcut: Ctrl+R) — Scroll wheel over mesh to set cuts count (${editMeshLoopCuts})`}
                      style={{ position: "relative" }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <line x1="3" y1="12" x2="21" y2="12" strokeDasharray="3 3" />
                      </svg>
                      {editMeshTool === "loopcut" && (
                        <span
                          style={{
                            position: "absolute",
                            top: -4,
                            right: -6,
                            fontSize: "10px",
                            fontWeight: 700,
                            color: "#facc15",
                            background: "rgba(40, 36, 20, 0.95)",
                            padding: "1px 4px",
                            borderRadius: "3px",
                            lineHeight: "1",
                          }}
                        >
                          {editMeshLoopCuts}
                        </span>
                      )}
                    </button>

                    {/* Tool: Knife */}
                    <button
                      type="button"
                      className="viewport-hud-button"
                      onClick={() => editMeshCommandsRef.current?.tool("knife")}
                      title="Knife — click along vertices and edges, Enter to cut (Shortcut: K)"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                        <path d="M4 20L16 8l3 3L7 20z" fill="currentColor" fillOpacity="0.3" />
                        <path d="M16 8l3-3" />
                      </svg>
                    </button>

                    {/* Tool: Bridge */}
                    <button
                      type="button"
                      className="viewport-hud-button"
                      disabled={selectedCount === 0}
                      onClick={() => editMeshCommandsRef.current?.tool("bridge")}
                      title="Bridge two edge loops — or two groups of faces, removed and joined into a tunnel"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <ellipse cx="6" cy="12" rx="2.5" ry="6" />
                        <ellipse cx="18" cy="12" rx="2.5" ry="6" />
                        <path d="M6 6h12M6 18h12" />
                      </svg>
                    </button>

                    {/* Tool: Spin */}
                    <button
                      type="button"
                      className="viewport-hud-button"
                      disabled={selectedCount === 0}
                      onClick={() => editMeshCommandsRef.current?.tool("spin")}
                      title="Spin the selected edges around the object's axis (a lathe) — drag for angle, wheel for steps, X/Y/Z for the axis"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                        <line x1="12" y1="3" x2="12" y2="21" strokeDasharray="2 2" />
                        <path d="M5 8a7 3 0 0 0 14 0M5 16a7 3 0 0 0 14 0" />
                      </svg>
                    </button>
                  </>
                )}
              </HudToolColumn>

              {/* Bottom bar: editing options, then commands on the selection. */}
              <HudBar>
                {/* Proportional Editing Toggle */}
                {!isPointsOnly && (
                  <button
                    type="button"
                    className={`viewport-hud-button ${editMeshNode.params.proportionalEditing ? "viewport-hud-button-active" : ""}`}
                    onClick={() => {
                      onParamChange?.("proportionalEditing", !editMeshNode.params.proportionalEditing, editMeshNode.id);
                    }}
                    title={
                      editMeshNode.params.proportionalEditing
                        ? `Proportional Editing ON (Influence Diameter: ${editMeshNode.params.proportionalDiameter ?? 1.0}; mouse wheel while dragging resizes it) — Click to turn OFF (Shortcut: O)`
                        : "Proportional Editing OFF — Click to turn ON (Shortcut: O)"
                    }
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="3" fill="currentColor" />
                      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeDasharray="3 3" />
                    </svg>
                  </button>
                )}

                {/* X-mirror: edits mirror across the object's local X axis */}
                {!isPointsOnly && (
                  <button
                    type="button"
                    className={`viewport-hud-button ${editMeshNode.params.mirrorX === true ? "viewport-hud-button-active" : ""}`}
                    onClick={() => onParamChange?.("mirrorX", editMeshNode.params.mirrorX !== true, editMeshNode.id)}
                    title={
                      editMeshNode.params.mirrorX === true
                        ? "X-Mirror ON — moving a vertex moves its mirror image across local X too"
                        : "X-Mirror OFF — click to mirror edits across the object's local X axis"
                    }
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                      <line x1="12" y1="3" x2="12" y2="21" strokeDasharray="2 2" />
                      <path d="M9 7L4 12l5 5zM15 7l5 5-5 5z" fill="currentColor" fillOpacity="0.3" />
                    </svg>
                  </button>
                )}

                {/* X-ray: pick through the surface */}
                <button
                  type="button"
                  className={`viewport-hud-button ${editMeshNode.params.xray === true ? "viewport-hud-button-active" : ""}`}
                  onClick={() => onParamChange?.("xray", editMeshNode.params.xray !== true, editMeshNode.id)}
                  title={
                    editMeshNode.params.xray === true
                      ? "X-Ray ON — hidden points and faces can be selected (Shortcut: Alt+Z)"
                      : "X-Ray OFF — only what the camera sees can be selected (Shortcut: Alt+Z)"
                  }
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <rect x="4" y="4" width="11" height="11" rx="1" />
                    <rect x="9" y="9" width="11" height="11" rx="1" strokeDasharray="2 2" />
                  </svg>
                </button>

                {/* Face Side: which side of the faces is drawn — a face (the
                    circle) with its normals pointing out, in, or both ways */}
                {!isPointsOnly &&
                  ([
                    ["out", "M16 12h6M19.5 9.5L22 12l-2.5 2.5M8 12H2M4.5 9.5L2 12l2.5 2.5", "Face Side: Out — only the side the normals point to is drawn"],
                    ["in", "M22 12h-6M18.5 9.5L16 12l2.5 2.5M2 12h6M5.5 9.5L8 12l-2.5 2.5", "Face Side: In — only the side against the normals is drawn"],
                    [
                      "both",
                      "M15.5 12h7M17.5 10L15.5 12l2 2M20.5 10l2 2-2 2M8.5 12h-7M6.5 10l2 2-2 2M3.5 10l-2 2 2 2",
                      "Face Side: Both — both sides of every face are drawn",
                    ],
                  ] as const).map(([side, arrows, title]) => (
                    <button
                      key={side}
                      type="button"
                      className={`viewport-hud-button ${editMeshNode.params.faceSide === side ? "viewport-hud-button-active" : ""}`}
                      onClick={() => onParamChange?.("faceSide", side, editMeshNode.id)}
                      title={title}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="3.5" fill="currentColor" fillOpacity={side === "both" ? 0.6 : 0.25} />
                        <path d={arrows} />
                      </svg>
                    </button>
                  ))}

                <HudSeparator />

                {/* Selection tools */}
                <button
                  type="button"
                  className="viewport-hud-button"
                  disabled={selectedCount === 0}
                  onClick={() => commitHudSelection((m) => growSelection(m, selectMode, selection))}
                  title="Grow Selection (Shortcut: Cmd/Ctrl + =)"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" fillOpacity="0.4" />
                    <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="viewport-hud-button"
                  disabled={selectedCount === 0}
                  onClick={() => commitHudSelection((m) => shrinkSelection(m, selectMode, selection))}
                  title="Shrink Selection (Shortcut: Cmd/Ctrl + -)"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <rect x="4" y="4" width="16" height="16" rx="1" strokeDasharray="2 2" />
                    <path d="M9 5v4H5M15 5v4h4M19 15h-4v4M5 15h4v4" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="viewport-hud-button"
                  disabled={selectedCount === 0}
                  onClick={() => commitHudSelection((m) => linkedSelection(m, selectMode, selection))}
                  title="Select Linked — the whole piece the selection is on (Shortcut: Cmd/Ctrl+L; L over the mesh picks the piece under the cursor, Shift+L deselects it)"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
                    <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
                  </svg>
                </button>
                {selectMode === "faces" && !isPointsOnly && (
                  <button
                    type="button"
                    className="viewport-hud-button"
                    disabled={selectedCount === 0}
                    onClick={() =>
                      commitHudSelection((m) => ({
                        ...selection,
                        faces: flatFaces(m, selection.faces, Number(editMeshNode.params.flatAngle) || 10),
                      }))
                    }
                    title={`Select Flat Region — grow across edges bending less than ${Number(editMeshNode.params.flatAngle) || 10}° (Flat Angle)`}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                      <path d="M3 15l9-5 9 5-9 5z" fill="currentColor" fillOpacity="0.3" />
                      <path d="M3 10l9-5 9 5" strokeDasharray="2 2" />
                    </svg>
                  </button>
                )}
                {selectedCount > 0 && (
                  <button
                    type="button"
                    className="viewport-hud-button"
                    onClick={() => commitHudSelection(() => emptySelection())}
                    title={`Deselect All (${selectedCount} selected) (Shortcut: Esc / Alt+A)`}
                    style={{
                      color: "#f87171",
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="9" />
                      <line x1="15" y1="9" x2="9" y2="15" />
                      <line x1="9" y1="9" x2="15" y2="15" />
                    </svg>
                  </button>
                )}

                {!isPointsOnly && selectedCount > 0 && (
                  <>
                    <HudSeparator />
                    {/* One-shot operations */}
                    <button
                      type="button"
                      className="viewport-hud-button"
                      onClick={() => editMeshCommandsRef.current?.run("merge")}
                      title="Merge at Center (Shortcut: M)"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <circle cx="12" cy="12" r="2.5" fill="currentColor" />
                        <path d="M4 4l5 5M20 4l-5 5M4 20l5-5M20 20l-5-5" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="viewport-hud-button"
                      onClick={() => editMeshCommandsRef.current?.run("dissolve")}
                      title="Dissolve — points, edges or faces merge into the faces around them (Shortcut: Cmd/Ctrl+X)"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <rect x="3" y="5" width="18" height="14" rx="1" />
                        <line x1="12" y1="5" x2="12" y2="19" strokeDasharray="2 2" opacity="0.5" />
                      </svg>
                    </button>
                    {selectMode !== "faces" && (
                      <button
                        type="button"
                        className="viewport-hud-button"
                        onClick={() => editMeshCommandsRef.current?.run("fill")}
                        title="Fill — make a face from the selected points / edges (Shortcut: F)"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5">
                          <path d="M5 18L8 6h9l2 12z" fillOpacity="0.35" />
                        </svg>
                      </button>
                    )}
                    <button
                      type="button"
                      className="viewport-hud-button"
                      onClick={() => editMeshCommandsRef.current?.run("subdivide")}
                      title="Subdivide the selected faces"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                        <rect x="4" y="4" width="16" height="16" />
                        <line x1="12" y1="4" x2="12" y2="20" />
                        <line x1="4" y1="12" x2="20" y2="12" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="viewport-hud-button"
                      onClick={() => editMeshCommandsRef.current?.run("flip")}
                      title="Flip Normals of the selected faces"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M4 12h16" />
                        <path d="M8 8l-4 4 4 4M16 8l4 4-4 4" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="viewport-hud-button"
                      onClick={() => editMeshCommandsRef.current?.duplicate()}
                      title="Duplicate, then move with the mouse (Shortcut: Shift+D)"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <rect x="3" y="3" width="12" height="12" rx="1" />
                        <rect x="9" y="9" width="12" height="12" rx="1" fill="currentColor" fillOpacity="0.3" />
                      </svg>
                    </button>
                  </>
                )}

                {!isPointsOnly && (
                  <>
                    <HudSeparator />

                    {/* Tool: Separate Face Selection */}
                    <button
                      type="button"
                      className="viewport-hud-button"
                      disabled={!isFacesActive}
                      onClick={() => {
                        if (isFacesActive) {
                          onParamAction?.(editMeshNode.id, EDIT_MESH_SEPARATE_FACES_ACTION);
                        }
                      }}
                      title={
                        isFacesActive
                          ? "Separate Face Selection (Shortcut: P) — Create a new object node from selected face(s)"
                          : "Separate Face Selection (Disabled in Points mode or when no faces selected)"
                      }
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect x="3" y="9" width="11" height="11" rx="2" />
                        <path d="M9 3h10a2 2 0 0 1 2 2v10" strokeDasharray="2.5 2.5" />
                        <path d="M14 10l6-6m0 0h-4m4 0v4" />
                      </svg>
                    </button>

                    {/* Tool: Delete the selection — points, edges or faces, Blender's way */}
                    <button
                      type="button"
                      className="viewport-hud-button"
                      disabled={selectedCount === 0}
                      onClick={() => editMeshCommandsRef.current?.run("delete")}
                      title={
                        selectedCount > 0
                          ? "Delete Selection (Shortcut: Delete) — points and edges take the faces using them; the rest of those faces' edges stay"
                          : "Delete Selection (nothing selected)"
                      }
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 6h18" />
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                        <line x1="10" y1="11" x2="10" y2="17" />
                        <line x1="14" y1="11" x2="14" y2="17" />
                      </svg>
                    </button>
                  </>
                )}

                <HudSeparator />

                {/* Reset from Input Button */}
                <button
                  type="button"
                  className="viewport-hud-button"
                  onClick={() => onParamAction?.(editMeshNode.id, isPointsOnly ? RESEED_MESH_POINTS_ACTION : EDIT_MESH_RESEED_ACTION)}
                  title={isPointsOnly ? "Reset Points from Basis" : "Reset Mesh from Input or default Cube"}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                </button>
              </HudBar>
            </>
          );
        })()}
      {/* Terrain Sculpt Floating Toolbar */}
      {!outputMode &&
        !elevationView &&
        selectedNodeId &&
        (() => {
          const tNode = graph.nodes.find(
            (n) => n.id === selectedNodeId && isTerrainNode(n),
          );
          if (!tNode) return null;
          const currentTool = (tNode.params.brushTool as TerrainBrushTool) || terrainBrushTool;
          const brushSize = Number(tNode.params.brushSize) || 4;
          const brushStrength = Number(tNode.params.brushStrength) || 0.5;
          const brushFalloff = (tNode.params.brushFalloff as TerrainBrushFalloff) || terrainBrushFalloff;

          return (
            <BrushHud
              badge="TERRAIN"
              badgeTitle="Terrain Sculpting Tool"
              accentRgb="16, 185, 129"
              accentHex="#10b981"
              tools={TERRAIN_HUD_TOOLS}
              currentTool={currentTool}
              onTool={(id) => {
                setTerrainBrushTool(id as TerrainBrushTool);
                onParamChange?.("brushTool", id, tNode.id);
              }}
              invert={terrainInvert}
              invertTitles={{
                on: "Inverted: Digging / Lowering (or hold Alt)",
                off: "Normal: Raising (or hold Alt to invert)",
              }}
              onInvert={() => setTerrainInvert(!terrainInvert)}
              symmetry={(["symmetryX", "symmetryZ"] as const).map((key) => ({
                axis: key === "symmetryX" ? "X" : "Z",
                active: Boolean(tNode.params[key]),
                onToggle: () => onParamChange?.(key, !tNode.params[key], tNode.id),
              }))}
              radius={{
                value: brushSize,
                min: 0.5,
                max: 30,
                step: 0.5,
                label: `R: ${brushSize}m`,
                onChange: (v) => onParamChange?.("brushSize", v, tNode.id),
              }}
              strength={{ value: brushStrength, onChange: (v) => onParamChange?.("brushStrength", v, tNode.id) }}
              falloff={{
                value: brushFalloff,
                onChange: (f) => {
                  setTerrainBrushFalloff(f as TerrainBrushFalloff);
                  onParamChange?.("brushFalloff", f, tNode.id);
                },
              }}
              resetTitle="Reset manual sculpting offsets"
              onReset={() => {
                if (window.confirm("Reset all manual sculpt offsets on this terrain?")) {
                  onParamChange?.({ sculptOffsets: {}, maskWeights: {} }, tNode.id);
                }
              }}
            />
          );
        })()}
      {/* Sculpt Floating Toolbar */}
      {!outputMode &&
        !elevationView &&
        selectedNodeId &&
        (() => {
          const sNode = graph.nodes.find((n) => n.id === selectedNodeId && isSculptNode(n));
          if (!sNode) return null;
          const currentTool = (sNode.params.brushTool as SculptBrushTool) || sculptBrushTool;
          const brushSize = Number(sNode.params.brushSize) || 0.3;
          const brushStrength = Number(sNode.params.brushStrength) || 0.5;
          const brushFalloff = (sNode.params.brushFalloff as BrushFalloff) || sculptBrushFalloff;
          const dyntopoDetail = Math.max(0.1, Math.min(0.5, Number(sNode.params.dyntopoDetail) || 0.25));

          return (
            <BrushHud
              badge="SCULPT"
              badgeTitle="Sculpt Tool"
              accentRgb="56, 189, 248"
              accentHex="#38bdf8"
              tools={SCULPT_HUD_TOOLS}
              currentTool={currentTool}
              onTool={(id) => {
                setSculptBrushTool(id as SculptBrushTool);
                onParamChange?.("brushTool", id, sNode.id);
              }}
              invert={sculptInvert}
              invertTitles={{
                on: "Inverted (or hold Alt)",
                off: "Normal (or hold Alt to invert)",
              }}
              onInvert={() => setSculptInvert(!sculptInvert)}
              symmetry={(["symmetryX", "symmetryY", "symmetryZ"] as const).map((key) => ({
                axis: key.slice(-1),
                active: Boolean(sNode.params[key]),
                onToggle: () => onParamChange?.(key, !sNode.params[key], sNode.id),
              }))}
              radius={{
                value: brushSize,
                min: 0.02,
                max: 2,
                step: 0.02,
                label: `R: ${brushSize.toFixed(2)}`,
                onChange: (v) => onParamChange?.("brushSize", v, sNode.id),
              }}
              strength={{ value: brushStrength, onChange: (v) => onParamChange?.("brushStrength", v, sNode.id) }}
              falloff={{
                value: brushFalloff,
                onChange: (f) => {
                  setSculptBrushFalloff(f as BrushFalloff);
                  onParamChange?.("brushFalloff", f, sNode.id);
                },
              }}
              extras={
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span
                      style={{ fontSize: "11px", color: "#94a3b8", minWidth: 20 }}
                      title="Dyntopo detail as a fraction of brush radius — smaller means finer detail under the brush"
                    >
                      Det
                    </span>
                    <input
                      type="range"
                      min={0.1}
                      max={0.5}
                      step={0.01}
                      value={dyntopoDetail}
                      onChange={(e) => onParamChange?.("dyntopoDetail", Number(e.target.value), sNode.id)}
                      style={{ width: 50, accentColor: "#38bdf8", cursor: "pointer" }}
                      title="Dyntopo Detail"
                    />
                  </div>
                  <button
                    type="button"
                    className={`viewport-hud-button ${Boolean(sNode.params.usePressure ?? true) ? "viewport-hud-button-active" : ""}`}
                    onClick={() => onParamChange?.("usePressure", !Boolean(sNode.params.usePressure ?? true), sNode.id)}
                    title="Stylus Pressure Sensitivity (Tablet / Pen)"
                    style={{ fontSize: "11px", padding: "2px 6px", width: "auto" }}
                  >
                    🖊️ Pen
                  </button>
                </>
              }
              resetTitle="Reset to base primitive"
              onReset={() => {
                if (window.confirm("Reset this sculpt back to its base mesh? All sculpted detail will be lost.")) {
                  onParamChange?.("sculptMesh", null, sNode.id);
                }
              }}
            />
          );
        })()}
      {/* Roto Mask drawing palette */}
      {!outputMode &&
        !elevationView &&
        selectedNodeId &&
        (() => {
          const maskNode = graph.nodes.find((n) => n.id === selectedNodeId && n.type === "mask/roto");
          if (!maskNode) return null;
          return (
            <MaskEditor
              key={maskNode.id}
              node={maskNode}
              graph={graph}
              getResults={() => latestResultsRef.current}
              getCamera={() => liveCameraRef.current()}
              onParamsChange={(updates, options) => onParamChange?.(updates, maskNode.id, undefined, options)}
              hudMaxRows={hudToolMaxRows}
              hudLeft={hudToolColumnLeft}
            />
          );
        })()}
      {/* Texture Paint Floating Toolbar */}
      {!outputMode &&
        !elevationView &&
        selectedNodeId &&
        (() => {
          const tpNode = graph.nodes.find(
            (n) => n.id === selectedNodeId && n.type === "texture/paint",
          );
          if (!tpNode) return null;
          const currentTool = (tpNode.params.brushTool as TexturePaintTool) || "paint";
          const brushColor = String(tpNode.params.brushColor || "#38bdf8");
          const brushSize = Number(tpNode.params.brushSize) || 24;
          const brushOpacity = Number(tpNode.params.brushOpacity ?? 1.0);
          const symmetryX = Boolean(tpNode.params.symmetryX);
          const state = getTexturePaintState(tpNode.id);

          return (
            <div
              className="viewport-texture-paint-hud"
              style={{
                position: "absolute",
                bottom: 16,
                left: "50%",
                transform: "translateX(-50%)",
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 14px",
                background: "var(--chrome-surface-raised)",
                backdropFilter: "blur(12px)",
                border: "1px solid rgba(56, 189, 248, 0.45)",
                borderRadius: "8px",
                boxShadow:
                  "0 8px 24px rgba(0, 0, 0, 0.5), 0 0 16px rgba(56, 189, 248, 0.2)",
                color: "#ffffff",
                fontSize: "12px",
                zIndex: 45,
                pointerEvents: "auto",
              }}
            >
              {/* Badge */}
              <div
                style={{
                  fontSize: "11px",
                  fontWeight: 700,
                  color: "#38bdf8",
                  padding: "2px 8px",
                  background: "rgba(56, 189, 248, 0.15)",
                  borderRadius: "4px",
                  letterSpacing: "0.04em",
                  userSelect: "none",
                }}
                title="3D Texture Painting Tool"
              >
                PAINT
              </div>

              <div style={{ width: 1, height: 16, background: "rgba(255, 255, 255, 0.15)" }} />

              {/* Tool: Paint */}
              <button
                type="button"
                className={`viewport-hud-button ${currentTool === "paint" ? "viewport-hud-button-active" : ""}`}
                onClick={() => onParamChange?.("brushTool", "paint", tpNode.id)}
                title="Brush: Paint onto surface"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m18 2 4 4-12 12H6v-4L18 2z" />
                  <path d="M14 6l4 4" />
                </svg>
              </button>

              {/* Tool: Erase */}
              <button
                type="button"
                className={`viewport-hud-button ${currentTool === "erase" ? "viewport-hud-button-active" : ""}`}
                onClick={() => onParamChange?.("brushTool", "erase", tpNode.id)}
                title="Eraser: Erase to transparent or base color"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
                  <path d="M22 21H7" />
                  <path d="m5 11 9 9" />
                </svg>
              </button>

              {/* Tool: Smooth */}
              <button
                type="button"
                className={`viewport-hud-button ${currentTool === "smooth" ? "viewport-hud-button-active" : ""}`}
                onClick={() => onParamChange?.("brushTool", "smooth", tpNode.id)}
                title="Smooth / Soften: Blur painted area"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 12c3-4 6-4 9 0s6 4 9 0" />
                  <path d="M2 17c3-4 6-4 9 0s6 4 9 0" />
                </svg>
              </button>

              {/* Tool: Eyedropper */}
              <button
                type="button"
                className={`viewport-hud-button ${currentTool === "eyedropper" ? "viewport-hud-button-active" : ""}`}
                onClick={() => onParamChange?.("brushTool", "eyedropper", tpNode.id)}
                title="Eyedropper: Pick color from texture"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m2 22 1-1h3l9-9" />
                  <path d="M3 21v-3l9-9" />
                  <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9" />
                </svg>
              </button>

              {/* Tool: Fill */}
              <button
                type="button"
                className={`viewport-hud-button ${currentTool === "fill" ? "viewport-hud-button-active" : ""}`}
                onClick={() => onParamChange?.("brushTool", "fill", tpNode.id)}
                title="Fill Bucket: Fill entire canvas with color"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 11 11 3 3 11l8 8z" />
                  <path d="M19 15c0 1.7 1.3 3 2 3s2-1.3 2-3-2-4-2-4-2 2.3-2 4Z" />
                </svg>
              </button>

              {/* Tool: p5.brush stroke */}
              <button
                type="button"
                className={`viewport-hud-button ${currentTool === "brush" ? "viewport-hud-button-active" : ""}`}
                onClick={() => onParamChange?.("brushTool", "brush", tpNode.id)}
                title="p5 Brush: natural pencil / charcoal / marker stroke (brush picked in the node's p5.brush settings)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 21c3-1 4-3 5-5" />
                  <path d="m8 16 9.5-9.5a2.1 2.1 0 0 1 3 3L11 19" />
                  <path d="M8 16l3 3" />
                </svg>
              </button>

              {/* Tool: p5.brush watercolor */}
              <button
                type="button"
                className={`viewport-hud-button ${currentTool === "watercolor" ? "viewport-hud-button-active" : ""}`}
                onClick={() => onParamChange?.("brushTool", "watercolor", tpNode.id)}
                title="Watercolor: the gesture outlines a wash that bleeds and darkens at its edges"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3c-3 4-6 7.5-6 11a6 6 0 0 0 12 0c0-3.5-3-7-6-11Z" />
                  <path d="M9 15a3 3 0 0 0 3 3" />
                </svg>
              </button>

              <div style={{ width: 1, height: 16, background: "rgba(255, 255, 255, 0.15)" }} />

              {/* Color Picker */}
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  cursor: "pointer",
                }}
                title="Brush color"
              >
                <input
                  type="color"
                  value={brushColor}
                  onChange={(e) => onParamChange?.("brushColor", e.target.value, tpNode.id)}
                  style={{
                    width: 20,
                    height: 20,
                    padding: 0,
                    border: "1px solid rgba(255,255,255,0.4)",
                    borderRadius: "50%",
                    cursor: "pointer",
                    backgroundColor: "transparent",
                  }}
                />
              </label>

              {/* Brush Size */}
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: "11px", color: "#94a3b8", minWidth: 26 }} title="Brush Radius">
                  {brushSize}px
                </span>
                <input
                  type="range"
                  min={2}
                  max={128}
                  value={brushSize}
                  onChange={(e) => onParamChange?.("brushSize", Number(e.target.value), tpNode.id)}
                  style={{ width: 56, accentColor: "#38bdf8", cursor: "pointer" }}
                  title="Brush Size (px)"
                />
              </div>

              {/* Opacity */}
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: "11px", color: "#94a3b8", minWidth: 30 }} title="Brush Opacity">
                  {Math.round(brushOpacity * 100)}%
                </span>
                <input
                  type="range"
                  min={0.05}
                  max={1.0}
                  step={0.05}
                  value={brushOpacity}
                  onChange={(e) => onParamChange?.("brushOpacity", Number(e.target.value), tpNode.id)}
                  style={{ width: 50, accentColor: "#38bdf8", cursor: "pointer" }}
                  title="Brush Opacity"
                />
              </div>

              {/* Symmetry Mirror */}
              <button
                type="button"
                className={`viewport-hud-button ${symmetryX ? "viewport-hud-button-active" : ""}`}
                onClick={() => onParamChange?.("symmetryX", !symmetryX, tpNode.id)}
                title="Symmetry: Mirror along X axis"
                style={{ fontSize: "11px", padding: "2px 6px" }}
              >
                Mirror
              </button>

              {/* Stylus Pressure */}
              <button
                type="button"
                className={`viewport-hud-button ${Boolean(tpNode.params.usePressure ?? true) ? "viewport-hud-button-active" : ""}`}
                onClick={() => onParamChange?.("usePressure", !Boolean(tpNode.params.usePressure ?? true), tpNode.id)}
                title="Stylus Pressure Sensitivity (Tablet / Pen)"
                style={{ fontSize: "11px", padding: "2px 6px" }}
              >
                🖊️ Pen
              </button>

              <div style={{ width: 1, height: 16, background: "rgba(255, 255, 255, 0.15)" }} />

              {/* Clear */}
              <button
                type="button"
                className="viewport-hud-button"
                onClick={() => {
                  if (state.canvas && window.confirm("Clear painted canvas?")) {
                    clearPaintCanvas(state.canvas, String(tpNode.params.baseColor || "#ffffff"));
                    const dataUrl = serializePaintCanvas(state.canvas);
                    onParamChange?.("textureData", dataUrl, tpNode.id);
                    if (state.texture) state.texture.needsUpdate = true;
                  }
                }}
                title="Clear texture canvas"
                style={{ fontSize: "11px", padding: "2px 6px" }}
              >
                Clear
              </button>

              {/* Export */}
              <button
                type="button"
                className="viewport-hud-button"
                onClick={() => {
                  if (state.canvas) exportCanvasToPNG(state.canvas, `texture_paint_${tpNode.id}.png`);
                }}
                title="Export texture as PNG"
                style={{ fontSize: "11px", padding: "2px 6px" }}
              >
                Export
              </button>
            </div>
          );
        })()}
      {/* Texture Mix Floating Toolbar */}
      {!outputMode &&
        !elevationView &&
        selectedNodeId &&
        (() => {
          const tmNode = graph.nodes.find(
            (n) => n.id === selectedNodeId && isTextureMixNode(n),
          );
          if (!tmNode) return null;
          const activeLayer = Number(tmNode.params.activeLayer) || 0;
          const currentTool = (tmNode.params.brushTool as TextureMixTool) || "paint";
          const brushSize = Number(tmNode.params.brushSize) || 32;
          const brushStrength = Number(tmNode.params.brushStrength) || 0.8;
          const brushFalloff = (tmNode.params.brushFalloff as TextureMixFalloff) || "smooth";
          const state = getTextureMixPaintState(tmNode.id);

          // Find connected texture sockets
          const conns = graph.connections.filter((c) => c.toNode === tmNode.id && c.toSocket.startsWith("texture"));
          const layerCount = Math.max(1, conns.length + 1);

          return (
            <div
              className="viewport-texture-mix-hud"
              style={{
                position: "absolute",
                bottom: 16,
                left: "50%",
                transform: "translateX(-50%)",
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 14px",
                background: "var(--chrome-surface-raised)",
                backdropFilter: "blur(12px)",
                border: "1px solid rgba(245, 158, 11, 0.45)",
                borderRadius: "8px",
                boxShadow:
                  "0 8px 24px rgba(0, 0, 0, 0.5), 0 0 16px rgba(245, 158, 11, 0.2)",
                color: "#ffffff",
                fontSize: "12px",
                zIndex: 45,
                pointerEvents: "auto",
              }}
            >
              {/* Badge */}
              <div
                style={{
                  fontSize: "11px",
                  fontWeight: 700,
                  color: "#f59e0b",
                  padding: "2px 8px",
                  background: "rgba(245, 158, 11, 0.15)",
                  borderRadius: "4px",
                  letterSpacing: "0.04em",
                  userSelect: "none",
                }}
                title="Multi-Texture Splat Painting Tool"
              >
                TEXTURE MIX
              </div>

              <div style={{ width: 1, height: 16, background: "rgba(255, 255, 255, 0.15)" }} />

              {/* Dynamic Layer Pills */}
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                {Array.from({ length: layerCount }, (_, lIdx) => {
                  const isActive = activeLayer === lIdx;
                  return (
                    <button
                      key={lIdx}
                      type="button"
                      className={`viewport-hud-button ${isActive ? "viewport-hud-button-active" : ""}`}
                      onClick={() => onParamChange?.("activeLayer", lIdx, tmNode.id)}
                      style={{
                        fontSize: "11px",
                        fontWeight: isActive ? 700 : 500,
                        padding: "2px 8px",
                        borderRadius: "4px",
                      }}
                      title={`Select Layer ${lIdx + 1} to paint`}
                    >
                      Layer {lIdx + 1}
                    </button>
                  );
                })}
              </div>

              <div style={{ width: 1, height: 16, background: "rgba(255, 255, 255, 0.15)" }} />

              {/* Tool: Paint (Add weight) */}
              <button
                type="button"
                className={`viewport-hud-button ${currentTool === "paint" ? "viewport-hud-button-active" : ""}`}
                onClick={() => onParamChange?.("brushTool", "paint", tmNode.id)}
                title="Paint: Paint active layer texture onto surface"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m18 2 4 4-12 12H6v-4L18 2z" />
                  <path d="M14 6l4 4" />
                </svg>
              </button>

              {/* Tool: Erase (Remove weight) */}
              <button
                type="button"
                className={`viewport-hud-button ${currentTool === "erase" ? "viewport-hud-button-active" : ""}`}
                onClick={() => onParamChange?.("brushTool", "erase", tmNode.id)}
                title="Erase: Fade out active layer"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
                  <path d="M22 21H7" />
                  <path d="m5 11 9 9" />
                </svg>
              </button>

              {/* Tool: Smooth (Blend weights) */}
              <button
                type="button"
                className={`viewport-hud-button ${currentTool === "smooth" ? "viewport-hud-button-active" : ""}`}
                onClick={() => onParamChange?.("brushTool", "smooth", tmNode.id)}
                title="Smooth: Blend and soften transitions between textures"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 12c3-4 6-4 9 0s6 4 9 0" />
                  <path d="M2 17c3-4 6-4 9 0s6 4 9 0" />
                </svg>
              </button>

              {/* Tool: Fill */}
              <button
                type="button"
                className={`viewport-hud-button ${currentTool === "fill" ? "viewport-hud-button-active" : ""}`}
                onClick={() => onParamChange?.("brushTool", "fill", tmNode.id)}
                title="Fill: Cover surface with active layer"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 11 11 3 3 11l8 8z" />
                  <path d="M19 15c0 1.7 1.3 3 2 3s2-1.3 2-3-2-4-2-4-2 2.3-2 4Z" />
                </svg>
              </button>

              <div style={{ width: 1, height: 16, background: "rgba(255, 255, 255, 0.15)" }} />

              {/* Brush Size */}
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: "11px", color: "#94a3b8", minWidth: 26 }} title="Brush Radius">
                  {brushSize}px
                </span>
                <input
                  type="range"
                  min={4}
                  max={128}
                  value={brushSize}
                  onChange={(e) => onParamChange?.("brushSize", Number(e.target.value), tmNode.id)}
                  style={{ width: 56, accentColor: "#f59e0b", cursor: "pointer" }}
                  title="Brush Radius"
                />
              </div>

              {/* Brush Strength */}
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: "11px", color: "#94a3b8", minWidth: 30 }} title="Brush Strength">
                  {Math.round(brushStrength * 100)}%
                </span>
                <input
                  type="range"
                  min={0.05}
                  max={1.0}
                  step={0.05}
                  value={brushStrength}
                  onChange={(e) => onParamChange?.("brushStrength", Number(e.target.value), tmNode.id)}
                  style={{ width: 50, accentColor: "#f59e0b", cursor: "pointer" }}
                  title="Brush Strength"
                />
              </div>

              {/* Falloff */}
              <select
                value={brushFalloff}
                onChange={(e) => onParamChange?.("brushFalloff", e.target.value, tmNode.id)}
                style={{
                  background: "#1e293b",
                  color: "#fff",
                  border: "1px solid rgba(255, 255, 255, 0.15)",
                  borderRadius: 4,
                  fontSize: "11px",
                  height: 24,
                  padding: "0 6px",
                  outline: "none",
                  cursor: "pointer",
                }}
                title="Brush Falloff"
              >
                <option value="smooth">Smooth</option>
                <option value="linear">Linear</option>
                <option value="flat">Flat</option>
              </select>

              {/* Stylus Pressure */}
              <button
                type="button"
                className={`viewport-hud-button ${Boolean(tmNode.params.usePressure ?? true) ? "viewport-hud-button-active" : ""}`}
                onClick={() => onParamChange?.("usePressure", !Boolean(tmNode.params.usePressure ?? true), tmNode.id)}
                title="Stylus Pressure Sensitivity (Tablet / Pen)"
                style={{ fontSize: "11px", padding: "2px 6px" }}
              >
                🖊️ Pen
              </button>

              <div style={{ width: 1, height: 16, background: "rgba(255, 255, 255, 0.15)" }} />

              {/* Export */}
              <button
                type="button"
                className="viewport-hud-button"
                onClick={() => {
                  if (state.outCanvas) exportCanvasToPNG(state.outCanvas, `texture_mix_${tmNode.id}.png`);
                }}
                title="Export blended texture as PNG"
                style={{ fontSize: "11px", padding: "2px 6px" }}
              >
                Export
              </button>
            </div>
          );
        })()}
      {!outputMode && uvPanelOpen && <UVPreviewPanel source={uvPanelDataRef} onClose={() => setUvPanelOpen(false)} />}
      {/* Top-Left Viewport HUD & Controls — editor-only, never shown in the output window */}
      {/* Top-Left Viewport HUD & Controls — editor-only, never shown in the output window */}
      {!outputMode && (
        isHudCollapsed ? (
          <button
            type="button"
            className="viewport-hud-collapsed"
            onClick={() => setIsHudCollapsed(false)}
            title="Show 3D View controls"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        ) : (
          <div className="viewport-hud">
            {!elevationView && (
              <>
            {graph.nodes.some((n) => n.type === CAMERA_NODE.type || n.type === TEXTURE_CAMERA_NODE.type) && (
              <>
                <button
                  type="button"
                  className="viewport-hud-button"
                  onClick={() => snapSelectedCameraToEditorRef.current?.()}
                  title="Align selected camera (3D or 2D) to current 3D View — falls back to the active camera when nothing's selected (Ctrl+Alt+0)"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                </button>
                {graph.nodes.some((n) => n.type === CAMERA_NODE.type) && (
                  <button
                    type="button"
                    className={`viewport-hud-button ${lockCameraToView ? "viewport-hud-button-active" : ""}`}
                    onClick={() => {
                      setLockCameraToView((prev) => {
                        const next = !prev;
                        if (next) {
                          snapSelectedCameraToEditorRef.current?.();
                        }
                        return next;
                      });
                    }}
                    title={
                      lockCameraToView
                        ? "Camera lock active: camera tracks viewport in real-time (Lock Camera to View)"
                        : "Lock camera to 3D viewport continuously (Lock Camera to View)"
                    }
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d={lockCameraToView ? "M7 11V7a5 5 0 0 1 10 0v4" : "M7 11V7a5 5 0 0 1 9.9-1"} />
                    </svg>
                  </button>
                )}
              </>
            )}
            <button
              type="button"
              className={`viewport-hud-button ${showUiOverlay ? "viewport-hud-button-active" : ""}`}
              onClick={() => setShowUiOverlay((prev) => !prev)}
              title={
                showUiOverlay
                  ? "Hide construction elements / helpers (Tab)"
                  : "Show construction elements / helpers (Tab)"
              }
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {showUiOverlay ? (
                  <>
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </>
                ) : (
                  <>
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </>
                )}
              </svg>
            </button>
            <button
              type="button"
              className={`viewport-hud-button ${uvChecker ? "viewport-hud-button-active" : ""}`}
              onClick={() => setUvChecker((prev) => !prev)}
              title={
                uvChecker
                  ? "UV Checker ON — the selected object (everything, with nothing selected) shows the UV grid"
                  : "UV Checker — show the selected object with a labelled UV grid, to see stretching, scale and seams"
              }
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="1" />
                <path d="M3 12h18M12 3v18" />
                <path d="M3 3h9v9H3zM12 12h9v9h-9z" fill="currentColor" fillOpacity="0.45" stroke="none" />
              </svg>
            </button>
            <button
              type="button"
              className={`viewport-hud-button ${uvPanelOpen ? "viewport-hud-button-active" : ""}`}
              onClick={() => setUvPanelOpen((prev) => !prev)}
              title={uvPanelOpen ? "Hide the UV view" : "UV view — the selected object's UV layout over its texture"}
              style={{ fontSize: "10px", fontWeight: 700 }}
            >
              UV
            </button>
            <button
              type="button"
              className={`viewport-hud-button ${isOrthographic ? "viewport-hud-button-active" : ""}`}
              onClick={() => setIsOrthographic((prev) => !prev)}
              title={
                isOrthographic
                  ? "Orthographic View (click to switch to Perspective)"
                  : "Perspective View (click to switch to Orthographic)"
              }
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {isOrthographic ? (
                  <>
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M3 9h18M3 15h18M9 3v18M15 3v18" opacity="0.4" />
                  </>
                ) : (
                  <>
                    <polygon points="12 2 2 7 12 12 22 7 12 2" />
                    <polyline points="2 17 12 22 22 17" />
                    <polyline points="2 12 12 17 22 12" />
                  </>
                )}
              </svg>
            </button>
            <button
              type="button"
              className={`viewport-hud-button ${showEnvInEditor ? "viewport-hud-button-active" : ""}`}
              onClick={() => setShowEnvInEditor((prev) => !prev)}
              title="Toggle Environment (HDRI / Background)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            </button>
            <div className="viewport-hud-legend">
              {(
                [
                  { axis: "x", label: "X", views: ["Right", "Left"] },
                  { axis: "y", label: "Y", views: ["Top", "Bottom"] },
                  { axis: "z", label: "Z", views: ["Front", "Back"] },
                ] as const
              ).map(({ axis, label, views }) => (
                <button
                  key={axis}
                  type="button"
                  className={`viewport-hud-axis viewport-hud-axis-${axis}`}
                  title={`View ${views[0]} / ${views[1]} (click to toggle)`}
                  onClick={() => {
                    const sign = axisSideRef.current[axis];
                    setAxisViewRef.current(axis, sign);
                    axisSideRef.current[axis] = (sign === 1 ? -1 : 1) as 1 | -1;
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {isAxisView && (
              <button
                type="button"
                className={`viewport-hud-button ${isViewLocked ? "viewport-hud-button-active" : ""}`}
                onClick={toggleViewLock}
                title={
                  isViewLocked
                    ? "Unlock view — orbit re-enabled"
                    : "Lock view — disable orbit (work serenely in this fixed view)"
                }
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="11" width="16" height="10" rx="2" />
                  {isViewLocked ? (
                    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                  ) : (
                    <path d="M8 11V7a4 4 0 0 1 7.9-3.6" />
                  )}
                </svg>
              </button>
            )}
            </>
            )}
            <button
              type="button"
              className="viewport-hud-button"
              onClick={() => resetCameraRef.current()}
              title="Reset 3D Camera view"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
            {elevationView && onToggleSnapElevation && (
              <button
                type="button"
                className={`viewport-hud-button ${snapElevation ? "viewport-hud-button-active" : ""}`}
                onClick={onToggleSnapElevation}
                title={snapElevation ? "Elevation snapping active (0.5)" : "Enable elevation snapping (0.5)"}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 3v7a6 6 0 0 0 12 0V3" />
                  <line x1="4" y1="3" x2="8" y2="3" />
                  <line x1="16" y1="3" x2="20" y2="3" />
                </svg>
              </button>
            )}
            {onSelectNode && (
              <div className="viewport-hud-gizmo-modes">
                {(["translate", "rotate", "scale"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={
                      "viewport-hud-button" + (transformMode === mode ? " viewport-hud-button-active" : "")
                    }
                    onClick={() => setTransformMode(mode)}
                    title={
                      mode === "translate"
                        ? "Gizmo: Translate (W)"
                        : mode === "rotate"
                        ? "Gizmo: Rotate (E)"
                        : "Gizmo: Scale (R)"
                    }
                  >
                    {mode === "translate" ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="5 9 2 12 5 15" />
                        <polyline points="9 5 12 2 15 5" />
                        <polyline points="15 19 12 22 9 19" />
                        <polyline points="19 9 22 12 19 15" />
                        <line x1="2" y1="12" x2="22" y2="12" />
                        <line x1="12" y1="2" x2="12" y2="22" />
                      </svg>
                    ) : mode === "rotate" ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21.5 2v6h-6" />
                        <path d="M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="15 3 21 3 21 9" />
                        <polyline points="9 21 3 21 3 15" />
                        <line x1="21" y1="3" x2="14" y2="10" />
                        <line x1="3" y1="21" x2="10" y2="14" />
                      </svg>
                    )}
                  </button>
                ))}
                <button
                  type="button"
                  className={"viewport-hud-button" + (objectOrientation === "local" ? " viewport-hud-button-active" : "")}
                  onClick={() => setObjectOrientation((o) => (o === "global" ? "local" : "global"))}
                  title={
                    objectOrientation === "global"
                      ? "Gizmo axes: Global (the world's). Click for Local, the object's own"
                      : "Gizmo axes: Local (the object's own). Click for Global, the world's"
                  }
                >
                  {objectOrientation === "global" ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M3 12h18" />
                      <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z" />
                      <path d="M4 7.5 12 12l8-4.5" />
                      <line x1="12" y1="12" x2="12" y2="21" />
                    </svg>
                  )}
                </button>
              </div>
            )}
            <div className="viewport-hud-divider" />
            <button
              type="button"
              className="viewport-hud-button viewport-hud-hide"
              onClick={() => setIsHudCollapsed(true)}
              title="Hide 3D View controls"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
        )
      )}

      {/* Pinned params HUD — the editor's own free-orbit pane only, never the
          output/camera-preview pane, so it lives here rather than as an
          App.tsx-level overlay: this is the one place naturally scoped to
          just that pane's bounds (absolute within .viewport-container) and
          naturally unmounted whenever this pane isn't on screen at all
          (full-canvas Graph view). */}
      {/* A shown Virtual Interface plays the pinned params as knobs, switches and selectors, in place of the list. */}
      {!outputMode && onParamChange && virtualInterfaceNode && (
        <VirtualInterfaceHUD
          graph={graph}
          registry={registry}
          node={virtualInterfaceNode}
          currentFrame={currentFrame}
          keyframesEnabled={keyframesEnabled}
          onParamChange={onParamChange}
          onUnpin={onUnpinParam}
        />
      )}
      {!outputMode && onParamChange && onUnpinParam && !virtualInterfaceNode && (graph.exposedParams?.length ?? 0) > 0 && (
        <ViewportParamHUD
          graph={graph}
          registry={registry}
          keyframes={keyframes}
          currentFrame={currentFrame}
          keyframesEnabled={keyframesEnabled}
          onChange={onParamChange}
          onUnpin={onUnpinParam}
          onRename={onRenameExposedParam}
        />
      )}

      {/* 2D HUD overlay — shown over the camera view whenever a render node
          exists (its resolution defines the elements' pixel coordinate space).
          The overlay is inset to the actual rendered frame (letterboxed in the
          output window) and element sizes scale with the frame, so a HUD laid
          out at render resolution (0..1920) renders exactly as exported. */}
      {(outputMode || isCameraView) && renderSize && hubElements.length > 0 && (
        <div
          className="viewport-hub-overlay"
          style={{ left: renderFrame.x, top: renderFrame.y, width: renderFrame.width, height: renderFrame.height }}
        >
          {hubElements.map((el) => {
            const s = renderSize.width > 0 ? renderFrame.width / renderSize.width : 1;
            return (
              <div
                key={el.id}
                className={"viewport-hub-element" + (el.id === selectedNodeId ? " viewport-hub-element-selected" : "")}
                style={{
                  left: `${(el.x / renderSize.width) * 100}%`,
                  top: `${(el.y / renderSize.height) * 100}%`,
                  fontFamily: el.fontFamily,
                  fontSize: `${el.fontSize * el.scale * s}px`,
                  color: el.color,
                  textShadow: scalePxString(el.textShadow, s),
                  background: el.backgroundColor ?? undefined,
                  border: el.borderColor ? `${(el.borderWidth * s).toFixed(2)}px solid ${el.borderColor}` : undefined,
                  borderRadius: `${(el.borderRadius * s).toFixed(2)}px`,
                  boxShadow: scalePxString(el.shadow, s),
                  opacity: el.cssOpacity,
                  transform: el.transform,
                  filter: el.filter,
                  display: el.visible ? "block" : "none",
                  pointerEvents: onSelectNode ? "auto" : "none",
                  cursor: el.id === selectedNodeId ? "default" : "pointer",
                  padding: el.imageUrl ? 0 : undefined,
                }}
                onPointerDown={(e) => {
                  // Drag directly on the element to move it (no move handle).
                  if (!onHubChange || !hostRef.current) return;
                  e.stopPropagation();
                  hubDragMovedRef.current = false;
                  hubDragRef.current = {
                    mode: "move",
                    startClientX: e.clientX,
                    startClientY: e.clientY,
                    originClientX: 0,
                    originClientY: 0,
                    baseX: el.x,
                    baseY: el.y,
                    baseRot: el.rotation,
                    baseScale: el.scale,
                };
              }}
              onClick={(e) => {
                e.stopPropagation();
                // A real drag shouldn't also select the node.
                if (hubDragMovedRef.current) {
                  hubDragMovedRef.current = false;
                  return;
                }
                onSelectNode?.(el.id);
              }}
            >
              {el.imageUrl ? (
                <img
                  src={el.imageUrl}
                  alt=""
                  draggable={false}
                  className="viewport-hub-element-img"
                  style={{ width: `${(el.imageWidth ?? 200) * el.scale * s}px`, borderRadius: `${(el.borderRadius * s).toFixed(2)}px` }}
                />
              ) : (
                el.text
              )}
              {el.id === selectedNodeId && onHubChange && (
                <>
                  <div
                    className="viewport-hub-gizmo-rotate"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      if (!hostRef.current) return;
                      const frame = renderFrameRef.current;
                      const rs = renderSizeRef.current;
                      hubDragRef.current = {
                        mode: "rotate",
                        startClientX: e.clientX,
                        startClientY: e.clientY,
                        originClientX: frame.x + (el.x / (rs?.width ?? 1)) * frame.width,
                        originClientY: frame.y + (el.y / (rs?.height ?? 1)) * frame.height,
                        baseX: el.x,
                        baseY: el.y,
                        baseRot: el.rotation,
                        baseScale: el.scale,
                      };
                    }}
                    title="Drag to rotate"
                  />
                  <div
                    className="viewport-hub-gizmo-size"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      if (!hostRef.current) return;
                      hubDragRef.current = {
                        mode: "size",
                        startClientX: e.clientX,
                        startClientY: e.clientY,
                        originClientX: 0,
                        originClientY: 0,
                        baseX: el.x,
                        baseY: el.y,
                        baseRot: el.rotation,
                        baseScale: el.scale,
                      };
                    }}
                    title="Drag to resize"
                  />
                </>
              )}
            </div>
          );
          })}
        </div>
      )}
    </div>
  );
}
