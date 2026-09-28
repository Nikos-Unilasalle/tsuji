import * as THREE from "three";
import type { MutableRefObject } from "react";
import { findFirstMesh } from "../../graph/meshRequired";
import { findNodeDeep } from "../../graph/groups";
import {
  EDIT_MESH_NODE,
  resolveEditMeshData,
  readEditMeshSelection,
  editMeshSelectionParams,
} from "../../graph/nodes/editMesh";
import { EDIT_MESH_POINTS_NODE } from "../../graph/nodes/editMeshPoints";
import { extractPointsFromMesh } from "../../graph/nodes/pointsGeometry";
import {
  QuadMesh,
  cloneQuadMesh,
  createQuadBox,
  bufferGeometryToQuadMesh,
  loopCut,
  extrudeFaces,
  deleteFaces,
  computeFaceNormal,
  transformSelectionByMatrix,
  transformVertexGroups,
  ProportionalFalloff,
  gizmoWorldDelta,
  worldDeltaToLocal,
} from "../../graph/quadMesh";
import {
  combineSelection,
  convertSelection,
  emptySelection,
  EdgeRef,
  MeshSelection,
  selectionIslands,
  selectionVertices,
  SelectionOp,
  SelectMode,
} from "../../graph/mesh/selection";
import { edgeLoop, edgeRing, quadRing } from "../../graph/mesh/loops";
import {
  dissolveEdges,
  dissolveFaces,
  dissolveVertices,
  duplicateFaces,
  extrudeFacesIndividual,
  fillVertices,
  flipFaces,
  insetRegion,
  mergeVertices,
  mirrorMovesX,
  mirrorXMap,
  subdivideFaces,
} from "../../graph/mesh/tools";
import { bevelEdges } from "../../graph/mesh/bevel";
import { bridgeEdgeLoops, bridgeFaces, spinEdges } from "../../graph/mesh/bridge";
import { knifeCut, KnifePoint } from "../../graph/mesh/knife";
import { creaseMap, edgeKey, paintCorners, setEdgeCrease, setEdgeFlag } from "../../graph/mesh/attributes";
import { asVector3 } from "../../graph/nodes/transform";
import { asColor } from "../../graph/nodes/object";
import { circleRegion, EditMeshHandles, ScreenRegion } from "../editMeshHandles";
import type { TransformPatch } from "../gizmoWriteback";

/**
 * Edit Mesh's interaction in the viewport, out of Viewport.tsx: selection
 * gestures, the modal tools (extrude, inset, loop slide, move, bevel, spin,
 * knife), the one-shot operations, and writing gizmo drags back to the mesh.
 *
 * The viewport owns the scene, the camera, the gizmo and the DOM events; it
 * creates one controller per viewport and routes the Edit Mesh parts of
 * those events here. Everything the controller needs from the viewport comes
 * in through EditMeshControllerContext.
 */

/**
 * Edit Mesh Points' quad topology, rebuilt only when its geometry actually
 * changed. bufferGeometryToQuadMesh welds and re-pairs every triangle, and it
 * used to run on every frame (and every pointermove) for as long as the node
 * stayed selected. The result is shared: callers treat it as read-only.
 */
const pointsQuadMeshCache = new WeakMap<THREE.BufferGeometry, { version: number; mesh: QuadMesh }>();

/** The mesh an Edit Mesh (or Edit Mesh Points) node is editing right now. */
export function editMeshQuadMesh(
  node: { id: string; type: string; params: Record<string, unknown> },
  results: Map<string, Record<string, unknown>> | null | undefined,
  srcMesh: THREE.Mesh | null,
): QuadMesh {
  if (node.type === EDIT_MESH_NODE.type) return resolveEditMeshData(node, results);
  const geometry = srcMesh?.geometry;
  if (!geometry) return createQuadBox(1, 1, 1);
  const position = geometry.attributes.position;
  const version = position && !("isInterleavedBufferAttribute" in position) ? position.version : -1;
  let cached = pointsQuadMeshCache.get(geometry);
  if (!cached || cached.version !== version) {
    cached = { version, mesh: bufferGeometryToQuadMesh(geometry) };
    pointsQuadMeshCache.set(geometry, cached);
  }
  return cached.mesh;
}

/**
 * The Edit Mesh (or, with `points`, Edit Mesh Points) node with this id, at
 * any depth — inside a group as well as on the canvas itself (ids are unique
 * across the whole tree).
 */
export function findEditMeshNode<T extends { id: string; type: string; params: Record<string, unknown>; subgraph?: unknown }>(
  graph: { nodes: T[] },
  id: string | null | undefined,
  points: boolean,
): T | undefined {
  if (!id) return undefined;
  const node = findNodeDeep(graph as never, id) as T | undefined;
  if (!node) return undefined;
  return node.type === EDIT_MESH_NODE.type || (points && node.type === EDIT_MESH_POINTS_NODE.type) ? node : undefined;
}

/** The Edit Mesh paint-select brush radius, in CSS px (the drawn circle matches). */
export const EDIT_MESH_BRUSH_RADIUS_PX = 28;

/** X-mirror matching tolerance: a small fraction of the mesh's size. */
export function mirrorTolerance(mesh: QuadMesh): number {
  let size = 0;
  for (const p of mesh.positions) size = Math.max(size, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  return Math.max(1e-6, size * 1e-4);
}

/** Edit Mesh one-shot operations on the selection (see runEditOp). */
export type EditMeshOp =
  | "merge"
  | "dissolve"
  | "fill"
  | "flip"
  | "subdivide"
  | "delete"
  | "sharp"
  | "seam"
  | "crease"
  | "assign"
  | "paint";

export interface EditMeshCommands {
  run(op: EditMeshOp): boolean;
  duplicate(): boolean;
  tool(tool: "bevel" | "spin" | "knife" | "bridge"): boolean;
}

type GraphLike = { nodes: { id: string; type: string; params: Record<string, unknown>; subgraph?: unknown }[] };
type ParamChange = (
  paramId: string | Record<string, unknown>,
  value?: unknown,
  targetNodeId?: string,
  options?: { coalesce?: boolean },
) => void;

export interface EditMeshControllerContext {
  outputMode: boolean;
  renderer: THREE.WebGLRenderer;
  camera: THREE.Camera;
  raycaster: THREE.Raycaster | null;
  editMeshHandles: EditMeshHandles;
  graphRef: MutableRefObject<GraphLike>;
  selectedNodeIdRef: MutableRefObject<string | null>;
  latestResultsRef: MutableRefObject<Map<string, Record<string, unknown>> | null>;
  onParamChangeRef: MutableRefObject<ParamChange | undefined>;
  onTransformChangeRef: MutableRefObject<((nodeId: string, patch: TransformPatch) => void) | undefined>;
  onTransformStartRef: MutableRefObject<(() => void) | undefined>;
  transformModeRef: MutableRefObject<"translate" | "rotate" | "scale">;
  editSnapRef: MutableRefObject<"off" | "increment" | "vertex">;
  editPivotRef: MutableRefObject<"median" | "individual" | "origin">;
  editMeshPreviewLoopRef: MutableRefObject<[[number, number, number], [number, number, number]][] | null>;
  editMeshCommandsRef: MutableRefObject<EditMeshCommands | null>;
  setEditMeshTool: (tool: "select" | "loopcut" | "modal") => void;
  setEditModalHud: (text: string | null) => void;
  /** Shift held: step snapping (a mutable viewport flag, hence a getter). */
  isSnapEnabled: () => boolean;
  /** The gizmo proxy's pose when a drag began (shared with the curve handles' drag). */
  dragStartCentroidPos: THREE.Vector3;
  dragStartCentroidQuat: THREE.Quaternion;
  dragStartCentroidScale: THREE.Vector3;
}

export function createEditMeshController(ctx: EditMeshControllerContext) {
  const {
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
    dragStartCentroidPos,
    dragStartCentroidQuat,
    dragStartCentroidScale,
  } = ctx;

  // --- Edit Mesh selection: one path for every gesture ------------------
  // Click, Shift+click, Alt(+Ctrl)+click, box, lasso, brush and the
  // keyboard all resolve the node the same way and write the result the
  // same way; they differ only in what they pick and how it combines.

  interface EditMeshTarget {
    node: GraphNodeLike;
    srcMesh: THREE.Mesh;
    quadMesh: QuadMesh;
    mode: SelectMode;
    selection: MeshSelection;
    isPointsOnly: boolean;
  }
  type GraphNodeLike = { id: string; type: string; params: Record<string, unknown> };

  /** Where the pointer last was over this canvas — L selects what's under it. */
  let editPointer: { clientX: number; clientY: number } | null = null;

  /** The selected Edit Mesh / Edit Mesh Points node with what it's editing, or null. */
  function editMeshTarget(): EditMeshTarget | null {
    if (outputMode || !selectedNodeIdRef.current) return null;
    const node = findEditMeshNode(graphRef.current, selectedNodeIdRef.current, true);
    if (!node) return null;
    const meshObj = latestResultsRef.current?.get(node.id)?.geometry;
    const srcMesh = meshObj instanceof THREE.Object3D ? findFirstMesh(meshObj) : null;
    if (!srcMesh) return null;
    srcMesh.updateMatrixWorld(true);
    const quadMesh = editMeshQuadMesh(node, latestResultsRef.current, srcMesh);
    return { node, srcMesh, quadMesh, ...readEditMeshSelection(node) };
  }

  function commitEditSelection(target: EditMeshTarget, next: MeshSelection) {
    onParamChangeRef.current?.(editMeshSelectionParams(target.node, target.mode, next, target.quadMesh), target.node.id);
  }

  function applyEditPick(target: EditMeshTarget, picked: MeshSelection | null, op: SelectionOp): boolean {
    if (!picked) return false;
    commitEditSelection(target, combineSelection(target.mode, target.selection, picked, op));
    return true;
  }

  function canvasPoint(clientX: number, clientY: number) {
    const rect = renderer.domElement.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return { rect, x, y, ndc: new THREE.Vector2((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1) };
  }

  /** The one element under the cursor in the target's mode, or null. */
  function pickEditElement(target: EditMeshTarget, clientX: number, clientY: number): MeshSelection | null {
    const { rect, ndc } = canvasPoint(clientX, clientY);
    const m = target.srcMesh.matrixWorld;
    if (target.mode === "points") {
      const p = editMeshHandles.pickPoint(ndc, camera, rect.width, rect.height, target.quadMesh, m);
      return p === null ? null : { ...emptySelection(), points: [p] };
    }
    if (target.mode === "edges") {
      const e = editMeshHandles.pickEdge(ndc, camera, rect.width, rect.height, target.quadMesh, m);
      return e ? { ...emptySelection(), edges: [e] } : null;
    }
    if (!raycaster) return null;
    raycaster.setFromCamera(ndc, camera);
    const f = editMeshHandles.pickFace(raycaster, target.quadMesh, m);
    return f === null ? null : { ...emptySelection(), faces: [f] };
  }

  /**
   * The loop (or, with `ring`, the ring) through the edge under the cursor:
   * an edge loop in points/edges mode, the quad ring in faces mode.
   */
  function pickEditLoop(target: EditMeshTarget, clientX: number, clientY: number, ring: boolean): MeshSelection | null {
    const { rect, ndc } = canvasPoint(clientX, clientY);
    const edge = editMeshHandles.pickEdge(ndc, camera, rect.width, rect.height, target.quadMesh, target.srcMesh.matrixWorld);
    if (!edge) return null;
    const out = emptySelection();
    if (target.mode === "faces") {
      out.faces = quadRing(target.quadMesh, edge[0], edge[1]).faces.map((r) => r.face);
      return out;
    }
    const edges = ring ? edgeRing(target.quadMesh, edge[0], edge[1]) : edgeLoop(target.quadMesh, edge[0], edge[1]);
    if (target.mode === "edges") out.edges = edges;
    else out.points = [...new Set(edges.flat())];
    return out;
  }

  /** Everything inside a screen region (box, lasso, brush) in the target's mode. */
  function pickEditRegion(target: EditMeshTarget, region: ScreenRegion): MeshSelection {
    const { rect } = canvasPoint(0, 0);
    const m = target.srcMesh.matrixWorld;
    const out = emptySelection();
    if (target.mode === "points") {
      out.points = editMeshHandles.pickPointsInRegion(region, rect.width, rect.height, camera, target.quadMesh, m);
    } else if (target.mode === "edges") {
      out.edges = editMeshHandles.pickEdgesInRegion(region, rect.width, rect.height, camera, target.quadMesh, m);
    } else {
      out.faces = editMeshHandles.pickFacesInRegion(region, rect.width, rect.height, camera, target.quadMesh, m);
    }
    return out;
  }

  /** The brush: points/edges under the circle, the face under its centre. */
  function pickEditBrush(target: EditMeshTarget, clientX: number, clientY: number): MeshSelection | null {
    if (target.mode === "faces") return pickEditElement(target, clientX, clientY);
    const { x, y } = canvasPoint(clientX, clientY);
    return pickEditRegion(target, circleRegion(x, y, EDIT_MESH_BRUSH_RADIUS_PX));
  }

  // --- Edit Mesh modal tools --------------------------------------------
  // Extrude (E, Alt+E individual), Inset (I), Loop Cut & Slide, and the
  // move that follows Duplicate (Shift+D) all run the same way: the mouse
  // (or a typed number) drives the amount with a live preview; click or
  // Enter confirms, Escape or right-click cancels. The whole gesture is one
  // undo step: it's recorded once when the tool starts (onTransformStart),
  // and every preview is written through the history-free transform path.

  type EditModalKind = "extrude" | "inset" | "loopslide" | "move" | "bevel" | "spin" | "knife";
  interface EditModal {
    kind: EditModalKind;
    nodeId: string;
    /** The mesh the tool works from; every preview is recomputed from it. */
    base: QuadMesh;
    /** The node's params before the tool, put back on cancel. */
    restore: Record<string, unknown>;
    mode: SelectMode;
    selection: MeshSelection;
    matrix: THREE.Matrix4;
    individual: boolean;
    value: number;
    depth: number;
    /** A typed amount; overrides the mouse while non-empty. */
    typed: string;
    lastX: number;
    lastY: number;
    startX: number;
    startY: number;
    /** Screen px per local unit along the extrude normal (client space). */
    axis: THREE.Vector2;
    /** The selection's centre on screen (client space). */
    center: THREE.Vector2;
    /** Screen px per local unit at the selection's depth. */
    pxPerUnit: number;
    edge?: EdgeRef;
    edgeA?: THREE.Vector2;
    edgeB?: THREE.Vector2;
    /** Move: the selection centre in world space, and the resulting local offset. */
    moveOrigin?: THREE.Vector3;
    moveDelta?: THREE.Vector3;
    /** Bevel / Spin: the edges they act on, and their step count (mouse wheel). */
    edges?: EdgeRef[];
    segments?: number;
    /** Spin: the local axis (X / Y / Z keys switch it). */
    axis3?: "x" | "y" | "z";
    /** Knife: the points placed so far, and the one under the cursor. */
    knifePoints?: KnifePoint[];
    knifeCandidate?: KnifePoint | null;
  }
  let editModal: EditModal | null = null;

  function localToClient(p: THREE.Vector3, matrix: THREE.Matrix4): THREE.Vector2 {
    const rect = renderer.domElement.getBoundingClientRect();
    const v = p.clone().applyMatrix4(matrix).project(camera);
    return new THREE.Vector2(rect.left + (v.x * 0.5 + 0.5) * rect.width, rect.top + (-v.y * 0.5 + 0.5) * rect.height);
  }

  /** The world point under a client position, at `depthOf`'s depth. */
  function clientToWorldAtDepth(clientX: number, clientY: number, depthOf: THREE.Vector3): THREE.Vector3 {
    const rect = renderer.domElement.getBoundingClientRect();
    const z = depthOf.clone().project(camera).z;
    return new THREE.Vector3(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1, z).unproject(camera);
  }

  const EDIT_MODAL_LABELS: Record<EditModalKind, string> = {
    extrude: "Extrude",
    inset: "Inset",
    loopslide: "Loop Cut — slide",
    move: "Move",
    bevel: "Bevel",
    spin: "Spin",
    knife: "Knife",
  };

  function editModalAmount(modal: EditModal): number {
    const typed = parseFloat(modal.typed);
    return modal.typed !== "" && Number.isFinite(typed) ? typed : modal.value;
  }

  /** The params the tool would leave at its current amount. */
  function editModalResult(modal: EditModal): Record<string, unknown> {
    const amount = editModalAmount(modal);
    const faces = modal.selection.faces;
    if (modal.kind === "extrude") {
      const r = modal.individual ? extrudeFacesIndividual(modal.base, faces, amount) : extrudeFaces(modal.base, faces, amount);
      return { meshData: r.mesh, selectMode: "faces", selectedFaces: r.newFaces };
    }
    if (modal.kind === "inset") {
      const r = insetRegion(modal.base, faces, Math.max(0, amount), modal.depth, modal.individual);
      return { meshData: r.mesh, selectMode: "faces", selectedFaces: r.newFaces };
    }
    if (modal.kind === "loopslide") {
      const r = loopCut(modal.base, modal.edge!, Math.min(0.98, Math.max(0.02, amount)));
      return {
        meshData: r.mesh,
        selectMode: "edges",
        selectedEdges: r.newEdgeIndices.map(([a, b]) => (a < b ? [a, b] : [b, a])),
      };
    }
    if (modal.kind === "bevel") {
      const r = bevelEdges(modal.base, modal.edges ?? [], Math.max(0, amount), modal.segments ?? 1);
      return { meshData: r.mesh, selectMode: "faces", selectedFaces: r.newFaces };
    }
    if (modal.kind === "spin") {
      const r = spinEdges(modal.base, modal.edges ?? [], modal.axis3 ?? "y", amount, modal.segments ?? 12);
      return { meshData: r.mesh, selectMode: "faces", selectedFaces: r.newFaces };
    }
    if (modal.kind === "knife") {
      const r = knifeCut(modal.base, modal.knifePoints ?? []);
      return { meshData: r.mesh, selectMode: "edges", selectedEdges: r.newEdges };
    }
    const delta = modal.moveDelta ?? new THREE.Vector3();
    const vertices = [...selectionVertices(modal.base, modal.mode, modal.selection)];
    const moved = transformSelectionByMatrix(modal.base, "points", vertices, new THREE.Matrix4().makeTranslation(delta.x, delta.y, delta.z));
    return { meshData: moved };
  }

  /** A knife point's local position on the tool's base mesh. */
  function knifePosition(modal: EditModal, p: KnifePoint): [number, number, number] {
    if ("vertex" in p) return modal.base.positions[p.vertex];
    const a = modal.base.positions[p.edge[0]];
    const b = modal.base.positions[p.edge[1]];
    return [a[0] + (b[0] - a[0]) * p.t, a[1] + (b[1] - a[1]) * p.t, a[2] + (b[2] - a[2]) * p.t];
  }

  function previewEditModal() {
    if (!editModal) return;
    if (editModal.kind === "knife") {
      // The knife cuts only on confirm; until then, its path is drawn.
      const pts = [...(editModal.knifePoints ?? [])];
      if (editModal.knifeCandidate) pts.push(editModal.knifeCandidate);
      const positions = pts.map((p) => knifePosition(editModal!, p));
      editMeshPreviewLoopRef.current = positions.slice(1).map((p, i) => [positions[i], p]);
      const placed = editModal.knifePoints?.length ?? 0;
      setEditModalHud(`Knife: ${placed} point${placed === 1 ? "" : "s"} · click to add · Backspace removes the last · Enter cuts`);
      return;
    }
    onTransformChangeRef.current?.(editModal.nodeId, editModalResult(editModal));
    const amount = editModalAmount(editModal);
    const parts = [`${EDIT_MODAL_LABELS[editModal.kind]}: ${editModal.typed !== "" ? editModal.typed : amount.toFixed(3)}`];
    if (editModal.kind === "inset") parts.push(`depth ${editModal.depth.toFixed(3)} (Cmd/Ctrl)`);
    if (editModal.kind === "extrude" || editModal.kind === "inset") parts.push(editModal.individual ? "individual (I)" : "region (I)");
    if (editModal.kind === "bevel") parts.push(`${editModal.segments ?? 1} segment${editModal.segments === 1 ? "" : "s"} (wheel)`);
    if (editModal.kind === "spin") {
      parts[0] = `Spin: ${editModal.typed !== "" ? editModal.typed : amount.toFixed(1)}°`;
      parts.push(`${editModal.segments ?? 12} steps (wheel)`, `axis ${(editModal.axis3 ?? "y").toUpperCase()} (X/Y/Z)`);
    }
    if (editModal.kind === "move" && editModal.moveDelta) {
      const d = editModal.moveDelta;
      parts[0] = `Move: ${d.x.toFixed(3)}, ${d.y.toFixed(3)}, ${d.z.toFixed(3)}`;
    }
    setEditModalHud(parts.join(" · "));
  }

  /**
   * Starts a modal tool on the target. `base`/`selection`/`restore` default
   * to the node as it is; Duplicate passes its own (the duplicated mesh, the
   * copies, and the pre-duplicate params so cancelling removes the copies).
   */
  function startEditModal(
    kind: EditModalKind,
    target: EditMeshTarget,
    clientX: number,
    clientY: number,
    opts: {
      individual?: boolean;
      edge?: EdgeRef;
      base?: QuadMesh;
      selection?: MeshSelection;
      mode?: SelectMode;
      restore?: Record<string, unknown>;
      startValue?: number;
      edges?: EdgeRef[];
      segments?: number;
      axis3?: "x" | "y" | "z";
    } = {},
  ): boolean {
    if (target.node.type !== EDIT_MESH_NODE.type || editModal) return false;
    const base = opts.base ?? target.quadMesh;
    const mode = opts.mode ?? target.mode;
    const selection = opts.selection ?? target.selection;
    const matrix = target.srcMesh.matrixWorld.clone();

    // Centre, and the averaged normal of the faces involved.
    const center = new THREE.Vector3();
    const normal = new THREE.Vector3();
    if (kind === "loopslide" && opts.edge) {
      const [a, b] = opts.edge;
      center.set(...base.positions[a]).add(new THREE.Vector3(...base.positions[b])).multiplyScalar(0.5);
    } else if (kind === "bevel" || kind === "spin") {
      if (!opts.edges || opts.edges.length === 0) return false;
      const vertices = new Set(opts.edges.flat());
      for (const v of vertices) center.add(new THREE.Vector3(...base.positions[v]));
      center.divideScalar(vertices.size);
    } else if (kind !== "knife") {
      const vertices = selectionVertices(base, mode, selection);
      if (vertices.size === 0) return false;
      for (const v of vertices) center.add(new THREE.Vector3(...base.positions[v]));
      center.divideScalar(vertices.size);
      for (const f of selection.faces) normal.add(computeFaceNormal(base.positions, base.faces[f] ?? []));
    }
    if (normal.lengthSq() < 1e-12) normal.set(0, 0, 1);
    normal.normalize();

    const c = localToClient(center, matrix);
    const axis = localToClient(center.clone().add(normal), matrix).sub(c);
    const worldCenter = center.clone().applyMatrix4(matrix);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const pxPerWorld = Math.max(1e-6, localToClient(worldCenter.clone().add(right), new THREE.Matrix4()).distanceTo(c));
    const pxPerUnit = pxPerWorld * Math.max(1e-6, matrix.getMaxScaleOnAxis());
    // A normal pointing (nearly) at the camera gives no usable screen
    // direction: fall back to screen-up.
    if (axis.length() < 4) axis.set(0, -pxPerUnit);

    const node = target.node;
    const restore = opts.restore ?? {
      meshData: node.params.meshData ?? null,
      selectMode: node.params.selectMode ?? "faces",
      selectedPoints: node.params.selectedPoints ?? [],
      selectedEdges: node.params.selectedEdges ?? [],
      selectedFaces: node.params.selectedFaces ?? [],
    };

    const modal: EditModal = {
      kind,
      nodeId: node.id,
      base,
      restore,
      mode,
      selection,
      matrix,
      individual: Boolean(opts.individual),
      value: opts.startValue ?? 0,
      depth: 0,
      typed: "",
      lastX: clientX,
      lastY: clientY,
      startX: clientX,
      startY: clientY,
      axis,
      center: c,
      pxPerUnit,
    };
    if (kind === "loopslide" && opts.edge) {
      modal.edge = opts.edge;
      modal.edgeA = localToClient(new THREE.Vector3(...base.positions[opts.edge[0]]), matrix);
      modal.edgeB = localToClient(new THREE.Vector3(...base.positions[opts.edge[1]]), matrix);
    }
    if (kind === "move") {
      modal.moveOrigin = worldCenter;
      modal.moveDelta = new THREE.Vector3();
    }
    if (kind === "bevel" || kind === "spin") {
      modal.edges = opts.edges;
      modal.segments = opts.segments ?? (kind === "spin" ? 12 : 1);
      modal.axis3 = opts.axis3 ?? "y";
    }
    if (kind === "knife") {
      modal.knifePoints = [];
      modal.knifeCandidate = null;
    }

    onTransformStartRef.current?.();
    editModal = modal;
    setEditMeshTool("modal");
    previewEditModal();
    return true;
  }

  /** The knife point under the cursor: a vertex within reach, else the nearest edge. */
  function knifeSnap(modal: EditModal, clientX: number, clientY: number): KnifePoint | null {
    const { rect, ndc } = canvasPoint(clientX, clientY);
    const v = editMeshHandles.pickPoint(ndc, camera, rect.width, rect.height, modal.base, modal.matrix);
    if (v !== null) return { vertex: v };
    const edge = editMeshHandles.pickEdge(ndc, camera, rect.width, rect.height, modal.base, modal.matrix);
    if (!edge) return null;
    const a = localToClient(new THREE.Vector3(...modal.base.positions[edge[0]]), modal.matrix);
    const b = localToClient(new THREE.Vector3(...modal.base.positions[edge[1]]), modal.matrix);
    const ab = b.clone().sub(a);
    const t = ab.lengthSq() > 1e-6 ? new THREE.Vector2(clientX, clientY).sub(a).dot(ab) / ab.lengthSq() : 0.5;
    return { edge, t: Math.min(0.98, Math.max(0.02, t)) };
  }

  function updateEditModal(clientX: number, clientY: number, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) {
    const modal = editModal;
    if (!modal) return;
    const dx = clientX - modal.lastX;
    const dy = clientY - modal.lastY;
    modal.lastX = clientX;
    modal.lastY = clientY;
    // Shift: ten times finer, as in Blender.
    const precision = e.shiftKey ? 0.1 : 1;
    if (modal.kind === "extrude") {
      modal.value += ((dx * modal.axis.x + dy * modal.axis.y) / modal.axis.lengthSq()) * precision;
    } else if (modal.kind === "inset") {
      if (e.ctrlKey || e.metaKey) {
        modal.depth += (-dy / modal.pxPerUnit) * precision;
      } else {
        // Towards the centre thickens the inset.
        const before = Math.hypot(clientX - dx - modal.center.x, clientY - dy - modal.center.y);
        const after = Math.hypot(clientX - modal.center.x, clientY - modal.center.y);
        modal.value = Math.max(0, modal.value + ((before - after) / modal.pxPerUnit) * precision);
      }
    } else if (modal.kind === "bevel") {
      // Away from the centre widens the bevel.
      const before = Math.hypot(clientX - dx - modal.center.x, clientY - dy - modal.center.y);
      const after = Math.hypot(clientX - modal.center.x, clientY - modal.center.y);
      modal.value = Math.max(0, modal.value + ((after - before) / modal.pxPerUnit) * precision);
    } else if (modal.kind === "spin") {
      modal.value += dx * 0.5 * precision;
    } else if (modal.kind === "knife") {
      modal.knifeCandidate = knifeSnap(modal, clientX, clientY);
    } else if (modal.kind === "loopslide" && modal.edgeA && modal.edgeB) {
      const ab = modal.edgeB.clone().sub(modal.edgeA);
      const t = ab.lengthSq() > 1e-6 ? new THREE.Vector2(clientX, clientY).sub(modal.edgeA).dot(ab) / ab.lengthSq() : 0.5;
      modal.value = Math.min(0.98, Math.max(0.02, t));
    } else if (modal.kind === "move" && modal.moveOrigin) {
      const from = clientToWorldAtDepth(modal.startX, modal.startY, modal.moveOrigin);
      const to = clientToWorldAtDepth(clientX, clientY, modal.moveOrigin);
      const worldDelta = to.sub(from);
      // To local: difference of two transformed points, so translation cancels.
      const inv = modal.matrix.clone().invert();
      modal.moveDelta = modal.moveOrigin.clone().add(worldDelta).applyMatrix4(inv).sub(modal.moveOrigin.clone().applyMatrix4(inv));
    }
    previewEditModal();
  }

  function endEditModal() {
    editModal = null;
    setEditModalHud(null);
    setEditMeshTool("select");
  }

  function confirmEditModal() {
    if (!editModal) return;
    if (editModal.kind === "knife") {
      editMeshPreviewLoopRef.current = null;
      if ((editModal.knifePoints?.length ?? 0) >= 2) onTransformChangeRef.current?.(editModal.nodeId, editModalResult(editModal));
    }
    // Otherwise the graph already holds the last preview: that's the result.
    endEditModal();
  }

  function cancelEditModal() {
    if (!editModal) return;
    if (editModal.kind === "knife") editMeshPreviewLoopRef.current = null;
    else onTransformChangeRef.current?.(editModal.nodeId, editModal.restore);
    endEditModal();
  }

  /** A left click while a tool runs: the knife places a point, everything else confirms. */
  function clickEditModal() {
    const modal = editModal;
    if (!modal) return;
    if (modal.kind !== "knife") return confirmEditModal();
    if (modal.knifeCandidate) {
      modal.knifePoints!.push(modal.knifeCandidate);
      previewEditModal();
    }
  }

  /** The mouse wheel while Bevel or Spin runs: segments / steps. */
  function wheelEditModal(deltaY: number): boolean {
    const modal = editModal;
    if (!modal || (modal.kind !== "bevel" && modal.kind !== "spin")) return false;
    const step = deltaY < 0 ? 1 : -1;
    const max = modal.kind === "spin" ? 256 : 16;
    modal.segments = Math.max(1, Math.min(max, (modal.segments ?? 1) + step));
    previewEditModal();
    return true;
  }

  /** Keys while a modal tool runs: the amount, the options, confirm and cancel. Returns true when handled. */
  function editModalKey(e: KeyboardEvent, key: string): boolean {
    const modal = editModal;
    if (!modal) return false;
    e.preventDefault();
    e.stopPropagation();
    if (key === "escape") cancelEditModal();
    else if (e.key === "Enter") confirmEditModal();
    else if (modal.kind === "knife") {
      if (e.key === "Backspace" && modal.knifePoints!.length > 0) {
        modal.knifePoints!.pop();
        previewEditModal();
      }
    } else if (modal.kind === "spin" && (key === "x" || key === "y" || key === "z")) {
      modal.axis3 = key;
      previewEditModal();
    }
    else if (/^[0-9.]$/.test(e.key) || (e.key === "-" && modal.typed === "")) {
      modal.typed += e.key;
      previewEditModal();
    } else if (e.key === "Backspace") {
      modal.typed = modal.typed.slice(0, -1);
      previewEditModal();
    } else if (key === "i" && (modal.kind === "inset" || modal.kind === "extrude")) {
      modal.individual = !modal.individual;
      previewEditModal();
    }
    return true;
  }

  // --- Edit Mesh one-shot operations ---------------------------------------
  // Merge, dissolve, fill, flip, subdivide, delete: applied at once, one
  // undo step each, with the selection set to what they produced.

  function applyEditOp(target: EditMeshTarget, patch: Record<string, unknown>) {
    onParamChangeRef.current?.(patch, target.node.id, undefined, { coalesce: false });
  }

  /** The faces an operation should act on in any mode: the selected ones, or those fully selected. */
  function targetFaces(target: EditMeshTarget): number[] {
    return target.mode === "faces"
      ? target.selection.faces
      : convertSelection(target.quadMesh, target.mode, target.selection, "faces").faces;
  }

  function runEditOp(target: EditMeshTarget, op: EditMeshOp): boolean {
    if (target.node.type !== EDIT_MESH_NODE.type) return false;
    const mesh = target.quadMesh;
    const vertices = [...selectionVertices(mesh, target.mode, target.selection)];
    if (vertices.length === 0) return false;

    // Marking edges: a toggle — already all marked, it clears them.
    if (op === "sharp" || op === "seam") {
      const edges = targetEdges(target);
      if (edges.length === 0) return false;
      const attribute = op === "sharp" ? "sharpEdges" : "seamEdges";
      const marked = new Set((mesh[attribute] ?? []).map(([a, b]) => edgeKey(a, b)));
      const allMarked = edges.every(([a, b]) => marked.has(edgeKey(a, b)));
      applyEditOp(target, { meshData: setEdgeFlag(mesh, attribute, edges, allMarked) });
      return true;
    }
    if (op === "crease") {
      const edges = targetEdges(target);
      if (edges.length === 0) return false;
      const weight = Math.max(0, Math.min(1, Number(target.node.params.creaseWeight ?? 1)));
      const current = creaseMap(mesh);
      const already = edges.every(([a, b]) => current.get(edgeKey(a, b)) === weight);
      applyEditOp(target, { meshData: setEdgeCrease(mesh, edges, already ? 0 : weight) });
      return true;
    }
    if (op === "assign") {
      const faces = targetFaces(target);
      if (faces.length === 0) return false;
      const slot = Math.max(0, Math.min(63, Math.round(Number(target.node.params.assignSlot ?? 1))));
      const faceMaterials = mesh.faces.map((_, f) => mesh.faceMaterials?.[f] ?? 0);
      for (const f of faces) faceMaterials[f] = slot;
      applyEditOp(target, { meshData: { ...cloneQuadMesh(mesh), faceMaterials } });
      return true;
    }
    if (op === "paint") {
      // asColor, like every node's colour param: the picker stores a
      // THREE.Color, which Number() turned into NaN — black.
      const hex = asColor(target.node.params.paintColor, new THREE.Color(0xff6b6b));
      const color: [number, number, number] = [hex.r, hex.g, hex.b];
      const painted =
        target.mode === "faces"
          ? paintCorners(mesh, color, { faces: target.selection.faces })
          : paintCorners(mesh, color, { vertices });
      applyEditOp(target, { meshData: painted });
      return true;
    }

    if (op === "merge") {
      const r = mergeVertices(mesh, vertices, "center");
      applyEditOp(target, {
        meshData: r.mesh,
        selectMode: "points",
        selectedPoints: r.vertex === null ? [] : [r.vertex],
        selectedEdges: [],
        selectedFaces: [],
      });
      return true;
    }
    if (op === "dissolve") {
      const r =
        target.mode === "points"
          ? dissolveVertices(mesh, target.selection.points)
          : target.mode === "edges"
            ? dissolveEdges(mesh, target.selection.edges)
            : dissolveFaces(mesh, target.selection.faces);
      applyEditOp(target, { meshData: r.mesh, selectMode: "faces", selectedFaces: r.newFaces, selectedPoints: [], selectedEdges: [] });
      return true;
    }
    if (op === "fill") {
      const r = fillVertices(mesh, vertices);
      if (r.newFaces.length === 0) return false;
      applyEditOp(target, { meshData: r.mesh, selectMode: "faces", selectedFaces: r.newFaces });
      return true;
    }
    const faces = targetFaces(target);
    if (faces.length === 0 && op !== "delete") return false;
    if (op === "flip") {
      applyEditOp(target, { meshData: flipFaces(mesh, faces) });
      return true;
    }
    if (op === "subdivide") {
      const r = subdivideFaces(mesh, faces);
      applyEditOp(target, { meshData: r.mesh, selectMode: "faces", selectedFaces: r.newFaces });
      return true;
    }
    if (op === "delete") {
      // Points/edges: every face touching them goes (Blender's Delete Vertices / Edges).
      const touched = new Set(vertices);
      const doomed =
        target.mode === "faces"
          ? faces
          : mesh.faces.flatMap((face, f) => {
              if (target.mode === "points") return face.some((v) => touched.has(v)) ? [f] : [];
              const keys = new Set(target.selection.edges.map(([a, b]) => `${a}_${b}`));
              return face.some((v, i) => {
                const w = face[(i + 1) % face.length];
                return keys.has(v < w ? `${v}_${w}` : `${w}_${v}`);
              })
                ? [f]
                : [];
            });
      if (doomed.length === 0) return false;
      applyEditOp(target, { meshData: deleteFaces(mesh, doomed), selectedPoints: [], selectedEdges: [], selectedFaces: [] });
      return true;
    }
    return false;
  }

  /** Shift+D: copy the selected faces, then move the copies with the mouse. */
  function duplicateAndMove(target: EditMeshTarget, clientX: number, clientY: number): boolean {
    if (target.node.type !== EDIT_MESH_NODE.type) return false;
    const faces = targetFaces(target);
    if (faces.length === 0) return false;
    const node = target.node;
    const restore = {
      meshData: node.params.meshData ?? null,
      selectMode: node.params.selectMode ?? "faces",
      selectedPoints: node.params.selectedPoints ?? [],
      selectedEdges: node.params.selectedEdges ?? [],
      selectedFaces: node.params.selectedFaces ?? [],
    };
    const r = duplicateFaces(target.quadMesh, faces);
    const selection = { ...emptySelection(), faces: r.newFaces };
    // The duplicate, selected, is the new state the move starts from.
    onTransformChangeRef.current?.(node.id, { meshData: r.mesh, selectMode: "faces", selectedFaces: r.newFaces });
    return startEditModal("move", target, clientX, clientY, { base: r.mesh, selection, mode: "faces", restore });
  }

  /** The edges Bevel / Spin / Bridge act on in any mode: the selected ones, or those of the selection. */
  function targetEdges(target: EditMeshTarget): EdgeRef[] {
    return target.mode === "edges"
      ? target.selection.edges
      : convertSelection(target.quadMesh, target.mode, target.selection, "edges").edges;
  }

  function startBevel(target: EditMeshTarget, clientX: number, clientY: number): boolean {
    const edges = targetEdges(target);
    return edges.length > 0 && startEditModal("bevel", target, clientX, clientY, { edges, startValue: 0 });
  }

  function startSpin(target: EditMeshTarget, clientX: number, clientY: number): boolean {
    const edges = targetEdges(target);
    return edges.length > 0 && startEditModal("spin", target, clientX, clientY, { edges, startValue: 360, segments: 12, axis3: "y" });
  }

  /** Bridge: two edge loops, or two groups of faces (removed and joined). */
  function runBridge(target: EditMeshTarget): boolean {
    if (target.node.type !== EDIT_MESH_NODE.type) return false;
    const r = target.mode === "faces" ? bridgeFaces(target.quadMesh, target.selection.faces) : bridgeEdgeLoops(target.quadMesh, targetEdges(target));
    if (r.error) {
      flashEditMessage(`Bridge: ${r.error}`);
      return false;
    }
    applyEditOp(target, { meshData: r.mesh, selectMode: "faces", selectedFaces: r.newFaces, selectedPoints: [], selectedEdges: [] });
    return true;
  }

  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  /** A short message in the tool readout, for an operation that couldn't run. */
  function flashEditMessage(text: string) {
    if (editModal) return;
    setEditModalHud(text);
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      if (!editModal) setEditModalHud(null);
    }, 2500);
  }

  const canvasCentre = () => {
    const rect = renderer.domElement.getBoundingClientRect();
    return [rect.left + rect.width / 2, rect.top + rect.height / 2] as const;
  };

  editMeshCommandsRef.current = {
    tool(tool) {
      const target = editMeshTarget();
      if (!target) return false;
      const [x, y] = canvasCentre();
      if (tool === "bevel") return startBevel(target, x, y);
      if (tool === "spin") return startSpin(target, x, y);
      if (tool === "knife") return startEditModal("knife", target, x, y);
      return runBridge(target);
    },
    run(op) {
      const target = editMeshTarget();
      return target ? runEditOp(target, op) : false;
    },
    duplicate() {
      const target = editMeshTarget();
      if (!target) return false;
      const rect = renderer.domElement.getBoundingClientRect();
      return duplicateAndMove(target, rect.left + rect.width / 2, rect.top + rect.height / 2);
    },
  };

  /**
   * Writes an Edit Mesh gizmo drag back to the mesh: snapping, the pivot
   * mode (one matrix, or one per island for Individual Origins),
   * proportional editing and X-mirror. Runs on every gizmo change, and again
   * when the mouse wheel resizes the proportional radius mid-drag.
   */
  function applyEditMeshDrag(object: THREE.Object3D) {
    const node = findEditMeshNode(graphRef.current, selectedNodeIdRef.current, true);
    if (!node || !dragStartMeshData || !onParamChangeRef.current) return;

    const meshObj = latestResultsRef.current?.get(node.id)?.geometry;
    const srcMesh = meshObj instanceof THREE.Object3D ? findFirstMesh(meshObj) : null;
    const meshWorldMat = srcMesh ? srcMesh.matrixWorld : new THREE.Matrix4();

    // Snapping a move: onto the vertex under the pointer (Vertex), or in
    // steps of Snap Increment along the gizmo's own axes (Increment, or
    // Shift held). Rotate and scale snap through transformControls itself.
    if (transformModeRef.current === "translate" && node.type === EDIT_MESH_NODE.type) {
      const snap = editSnapRef.current;
      let snapped = false;
      if (snap === "vertex" && editPointer) {
        const { mode: m, selection: sel } = readEditMeshSelection(node);
        const exclude = selectionVertices(dragStartMeshData, m, sel);
        const { rect, ndc } = canvasPoint(editPointer.clientX, editPointer.clientY);
        const v = editMeshHandles.pickPoint(ndc, camera, rect.width, rect.height, dragStartMeshData, meshWorldMat, exclude);
        if (v !== null) {
          object.position.set(...dragStartMeshData.positions[v]).applyMatrix4(meshWorldMat);
          snapped = true;
        }
      }
      if (!snapped && (snap === "increment" || ctx.isSnapEnabled())) {
        const step = (Number(node.params.snapIncrement) || 0.1) * meshWorldMat.getMaxScaleOnAxis();
        const toGizmo = dragStartCentroidQuat.clone().invert();
        const d = object.position.clone().sub(dragStartCentroidPos).applyQuaternion(toGizmo);
        d.set(Math.round(d.x / step) * step, Math.round(d.y / step) * step, Math.round(d.z / step) * step);
        object.position.copy(dragStartCentroidPos).add(d.applyQuaternion(dragStartCentroidQuat));
      }
      object.updateMatrix();
    }

    // The whole drag as one local-space matrix — see worldDeltaToLocal
    // for why rotation and scale can't be applied as read off the gizmo.
    const localDelta = worldDeltaToLocal(
      gizmoWorldDelta(
        dragStartCentroidPos,
        dragStartCentroidQuat,
        dragStartCentroidScale,
        object.position,
        object.quaternion,
        object.scale,
      ),
      meshWorldMat,
    );

    if (node.type === EDIT_MESH_POINTS_NODE.type) {
      if (!onTransformChangeRef.current || !dragStartPointPositionsList) return;
      const selectedIndices = Array.isArray(node.params.selectedPoints)
        ? (node.params.selectedPoints as number[])
        : [];
      if (selectedIndices.length === 0) return;

      const transformedUniquePoints = new Map<number, THREE.Vector3>();
      for (const idx of selectedIndices) {
        const raw = dragStartMeshData.positions[idx];
        if (!raw) continue;
        transformedUniquePoints.set(idx, new THREE.Vector3(raw[0], raw[1], raw[2]).applyMatrix4(localDelta));
      }

      const originPos = new THREE.Vector3();
      const resultList = dragStartPointPositionsList.map((pt) => pt.clone());
      for (let i = 0; i < dragStartPointPositionsList.length; i++) {
        const pt = dragStartPointPositionsList[i];
        for (const [uniqueIdx, targetPos] of transformedUniquePoints) {
          const orig = dragStartMeshData.positions[uniqueIdx];
          originPos.set(orig[0], orig[1], orig[2]);
          if (pt.distanceToSquared(originPos) <= 1e-6) {
            resultList[i].copy(targetPos);
            break;
          }
        }
      }

      onTransformChangeRef.current(node.id, { pointsList: resultList });
      return;
    }

    if (!onTransformChangeRef.current) return;

    // Every mode moves the vertices it covers — a face's corners, an
    // edge's ends — so the drag works on points whatever the mode.
    const { mode, selection } = readEditMeshSelection(node);
    const vertices = [...selectionVertices(dragStartMeshData, mode, selection)];

    // Individual Origins: each island turns and scales about its own
    // centre; the move itself is shared.
    let groups: { vertices: number[]; matrix: THREE.Matrix4 }[] = [{ vertices, matrix: localDelta }];
    if (dragStartIslands && dragStartIslands.length > 1) {
      const linear = localDelta.clone().setPosition(0, 0, 0);
      const pivot = dragStartCentroidPos.clone().applyMatrix4(meshWorldMat.clone().invert());
      const move = pivot.clone().applyMatrix4(localDelta).sub(pivot);
      groups = dragStartIslands.map(({ vertices: island, center }) => ({
        vertices: island,
        matrix: new THREE.Matrix4()
          .makeTranslation(center.x + move.x, center.y + move.y, center.z + move.z)
          .multiply(linear)
          .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z)),
      }));
    }

    const updatedMesh = transformVertexGroups(dragStartMeshData, groups, {
      enabled: Boolean(node.params.proportionalEditing),
      diameter: dragDiameterOverride ?? (Number(node.params.proportionalDiameter) || 1.0),
      falloff: (node.params.proportionalFalloff as ProportionalFalloff) || "smooth",
      connected: node.params.proportionalConnected === true,
    });

    // X-mirror: every vertex this drag moved has its counterpart across
    // local X = 0 follow it, mirrored (and one on the plane stays on it).
    if (dragStartMirrorMap) {
      const moved = new Map<number, [number, number, number]>();
      updatedMesh.positions.forEach((p, i) => {
        const o = dragStartMeshData!.positions[i];
        if (p[0] !== o[0] || p[1] !== o[1] || p[2] !== o[2]) moved.set(i, p);
      });
      for (const [v, p] of mirrorMovesX(dragStartMeshData, moved, dragStartMirrorMap, mirrorTolerance(dragStartMeshData))) {
        updatedMesh.positions[v] = p;
      }
    }

    // History-free: the drag's one undo step was recorded when it began
    // (dragging-changed → onTransformStart). Writing through
    // onParamChange recorded another whenever the drag paused longer
    // than the coalescing window.
    onTransformChangeRef.current(node.id, { meshData: updatedMesh });
    return;
  }


  // --- Gizmo drag state ----------------------------------------------------
  let dragStartMeshData: QuadMesh | null = null;
  /** X-mirror counterparts for the drag in progress, when the node has X-mirror on. */
  let dragStartMirrorMap: Int32Array | null = null;
  /** Individual Origins: the selection's islands and their centres, when the drag began. */
  let dragStartIslands: { vertices: number[]; center: THREE.Vector3 }[] | null = null;
  /** The proportional radius as the mouse wheel set it during this drag. */
  let dragDiameterOverride: number | null = null;
  let dragStartPointPositionsList: THREE.Vector3[] | null = null;

  /** A gizmo drag of the selection proxy begins: snapshot what it starts from. */
  function beginDrag(proxy: THREE.Object3D) {
    dragStartCentroidPos.copy(proxy.position);
    dragStartCentroidQuat.copy(proxy.quaternion);
    dragStartCentroidScale.copy(proxy.scale);
    const node = findEditMeshNode(graphRef.current, selectedNodeIdRef.current, true);
    if (node?.type === EDIT_MESH_NODE.type) {
      dragStartMeshData = cloneQuadMesh(resolveEditMeshData(node, latestResultsRef.current));
      dragStartMirrorMap = node.params.mirrorX === true ? mirrorXMap(dragStartMeshData, mirrorTolerance(dragStartMeshData)) : null;
      dragDiameterOverride = null;
      dragStartIslands = null;
      if (editPivotRef.current === "individual") {
        const { mode, selection } = readEditMeshSelection(node);
        const start = dragStartMeshData;
        dragStartIslands = selectionIslands(start, mode, selection).map((island) => {
          const center = new THREE.Vector3();
          for (const v of island) center.add(new THREE.Vector3(...start.positions[v]));
          return { vertices: island, center: center.divideScalar(island.length) };
        });
      }
      dragStartPointPositionsList = null;
    } else if (node?.type === EDIT_MESH_POINTS_NODE.type) {
      const meshObj = latestResultsRef.current?.get(node.id)?.geometry;
      const srcMesh = meshObj instanceof THREE.Object3D ? findFirstMesh(meshObj) : null;
      if (srcMesh?.geometry) {
        dragStartMeshData = bufferGeometryToQuadMesh(srcMesh.geometry);
        const rawList = Array.isArray(node.params.pointsList) && node.params.pointsList.length > 0
          ? node.params.pointsList
          : extractPointsFromMesh(srcMesh, node.id, "Edit Mesh Points")?.points ?? [];
        dragStartPointPositionsList = rawList.map((p) => asVector3(p, new THREE.Vector3()).clone());
      }
    }
  }

  function endDrag() {
    dragStartMeshData = null;
    dragStartMirrorMap = null;
    dragStartIslands = null;
    dragDiameterOverride = null;
    dragStartPointPositionsList = null;
  }

  /**
   * The mouse wheel during a drag with proportional editing: resizes the
   * influence (Blender's page up / down) and updates the drag at once.
   * Returns false when it doesn't apply.
   */
  function wheelDuringDrag(proxy: THREE.Object3D, deltaY: number): boolean {
    const node = findEditMeshNode(graphRef.current, selectedNodeIdRef.current, true);
    if (!node?.params.proportionalEditing) return false;
    const current = dragDiameterOverride ?? (Number(node.params.proportionalDiameter) || 1.0);
    dragDiameterOverride = Math.max(1e-3, current * (deltaY < 0 ? 1.15 : 1 / 1.15));
    onTransformChangeRef.current?.(node.id, { proportionalDiameter: dragDiameterOverride });
    applyEditMeshDrag(proxy);
    return true;
  }

  return {
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
    confirmEditModal,
    cancelEditModal,
    clickEditModal,
    wheelEditModal,
    editModalKey,
    runEditOp,
    duplicateAndMove,
    startBevel,
    applyEditMeshDrag,
    beginDrag,
    endDrag,
    wheelDuringDrag,
    /** Where the pointer last was over this canvas — L selects what's under it. */
    get pointer() {
      return editPointer;
    },
    set pointer(p: { clientX: number; clientY: number } | null) {
      editPointer = p;
    },
    /** The running modal tool's node, or null when none runs. */
    get modalNodeId(): string | null {
      return editModal?.nodeId ?? null;
    },
  };
}

export type EditMeshController = ReturnType<typeof createEditMeshController>;
