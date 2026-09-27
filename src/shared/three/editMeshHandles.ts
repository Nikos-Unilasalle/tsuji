import * as THREE from "three";
import type { MeshBVH } from "three-mesh-bvh";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { disposeGeometryBvh, getBoundsTree } from "./bvh";
import {
  QuadMesh,
  getQuadMeshEdges,
  computeFaceNormal,
  computeFaceCentroid,
  quadMeshSignature,
} from "../graph/quadMesh";
import { triangulateFace } from "../graph/mesh/triangulate";
import type { EdgeRef, SelectMode } from "../graph/mesh/selection";

const WIREFRAME_COLOR = 0x38bdf8;
const SELECTED_FACE_COLOR = 0x22c55e;
const POINT_COLOR = "#f8fafc";
const SELECTED_POINT_COLOR = "#ff7700"; // User requirement: selected points must be orange
const SELECTED_EDGE_COLOR = 0xff7700;
const HOVER_EDGE_COLOR = 0xfde68a;
const LOOPCUT_PREVIEW_COLOR = 0xfacc15;

const RENDER_ORDER = 998;

/** Point handle diameters, in px. */
const POINT_SIZE = 7;
const SELECTED_POINT_SIZE = 9;
/** Selected / hovered edge width, in px. */
const EDGE_WIDTH = 3;

/**
 * How far each point and edge handle is pulled toward the camera, as a
 * fraction of its distance, before the depth test. A vertex or edge sits
 * exactly on the faces around it, so without this it would z-fight with (and
 * be hidden by) its own surface. Relative rather than absolute so it holds at
 * any zoom or scale.
 */
const DEPTH_PULL = 0.004;
const PULL = (1 - DEPTH_PULL).toFixed(6);

function createCircleTexture(fillColor: string, strokeColor = "rgba(0,0,0,0.75)"): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 64, 64);
  ctx.beginPath();
  ctx.arc(32, 32, 23, 0, Math.PI * 2);
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.lineWidth = 7;
  ctx.strokeStyle = strokeColor;
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/**
 * Point handles depth-tested against the scene, so a vertex behind the
 * geometry is hidden — the same thing picking does outside X-ray. The pull
 * toward the camera is applied in view space, after the stock projection.
 */
function createPointMaterial(size: number, map: THREE.Texture): THREE.PointsMaterial {
  const material = new THREE.PointsMaterial({
    size,
    sizeAttenuation: false, // Zoom-independent constant pixel size
    map,
    transparent: true,
    alphaTest: 0.1,
    depthTest: true,
    depthWrite: false,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      "#include <project_vertex>",
      `#include <project_vertex>
      mvPosition.xyz *= ${PULL};
      gl_Position = projectionMatrix * mvPosition;`,
    );
  };
  material.customProgramCacheKey = () => "edit-mesh-point-depth-pull";
  return material;
}

/** A screen-space-width line material with the same depth pull as the points. */
function createEdgeMaterial(color: number): LineMaterial {
  const material = new LineMaterial({ color, linewidth: EDGE_WIDTH, transparent: true, depthWrite: false });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      "vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );",
      `vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );
      start.xyz *= ${PULL};
      end.xyz *= ${PULL};`,
    );
  };
  material.customProgramCacheKey = () => "edit-mesh-edge-depth-pull";
  return material;
}

// Circular point textures & materials, shared by every viewport — built on
// first use rather than at import, so nothing touches the DOM until a point
// handle is actually drawn.
let pointMaterials: { unselected: THREE.PointsMaterial; selected: THREE.PointsMaterial } | null = null;
function getPointMaterials() {
  if (!pointMaterials) {
    pointMaterials = {
      unselected: createPointMaterial(POINT_SIZE, createCircleTexture(POINT_COLOR, "rgba(15,23,42,0.8)")),
      selected: createPointMaterial(SELECTED_POINT_SIZE, createCircleTexture(SELECTED_POINT_COLOR, "rgba(124,45,18,0.9)")),
    };
  }
  return pointMaterials;
}

type Segment = [[number, number, number], [number, number, number]];

/** Everything the overlay draws for one frame. */
export interface EditMeshDisplayState {
  mesh: THREE.Mesh | null;
  quadMesh: QuadMesh | null;
  mode: SelectMode;
  points: ReadonlySet<number>;
  edges: ReadonlyArray<EdgeRef>;
  faces: ReadonlySet<number>;
  hoverFace?: number | null;
  hoverEdge?: EdgeRef | null;
  loopPreview?: Segment[] | null;
  proportionalDiameter?: number | null;
}

/**
 * A screen-space selection region, in CSS px relative to the canvas: a
 * marquee box, a lasso, or the paint brush circle.
 */
export interface ScreenRegion {
  contains(x: number, y: number): boolean;
  /**
   * Whether an edge's on-screen segment counts as inside. Absent: both ends
   * must be inside (box, lasso). The brush circle instead catches any edge
   * passing under it.
   */
  hitsSegment?(ax: number, ay: number, bx: number, by: number): boolean;
}

export function rectRegion(minX: number, minY: number, maxX: number, maxY: number): ScreenRegion {
  return { contains: (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY };
}

export function circleRegion(cx: number, cy: number, radius: number): ScreenRegion {
  return {
    contains: (x, y) => Math.hypot(x - cx, y - cy) <= radius,
    hitsSegment(ax, ay, bx, by) {
      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      const t = lenSq > 1e-9 ? Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / lenSq)) : 0;
      return Math.hypot(ax + dx * t - cx, ay + dy * t - cy) <= radius;
    },
  };
}

/** A lasso: an even-odd point-in-polygon test on the drawn path. */
export function polygonRegion(path: ReadonlyArray<{ x: number; y: number }>): ScreenRegion {
  return {
    contains(x, y) {
      let inside = false;
      for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
        const a = path[i];
        const b = path[j];
        if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    },
  };
}

export interface EditMeshHandles {
  readonly group: THREE.Group;
  sync(state: EditMeshDisplayState): void;
  clear(): void;
  /**
   * X-ray: pick through the surface. Off (the default), points, edges and
   * faces hidden behind the mesh itself can't be clicked, box-selected or
   * painted, and hidden handles aren't drawn.
   */
  setXray(xray: boolean): void;
  pickFace(raycaster: THREE.Raycaster, quadMesh: QuadMesh, meshWorldMatrix: THREE.Matrix4): number | null;
  /** The visible vertex nearest the cursor, within 16 px; `exclude` ones are skipped (snapping past the selection). */
  pickPoint(
    ndc: THREE.Vector2,
    camera: THREE.Camera,
    widthPx: number,
    heightPx: number,
    quadMesh: QuadMesh,
    meshWorldMatrix: THREE.Matrix4,
    exclude?: ReadonlySet<number>,
  ): number | null;
  pickEdge(
    ndc: THREE.Vector2,
    camera: THREE.Camera,
    widthPx: number,
    heightPx: number,
    quadMesh: QuadMesh,
    meshWorldMatrix: THREE.Matrix4,
  ): EdgeRef | null;
  pickPointsInRegion(
    region: ScreenRegion,
    widthPx: number,
    heightPx: number,
    camera: THREE.Camera,
    quadMesh: QuadMesh,
    meshWorldMatrix: THREE.Matrix4,
  ): number[];
  pickEdgesInRegion(
    region: ScreenRegion,
    widthPx: number,
    heightPx: number,
    camera: THREE.Camera,
    quadMesh: QuadMesh,
    meshWorldMatrix: THREE.Matrix4,
  ): EdgeRef[];
  pickFacesInRegion(
    region: ScreenRegion,
    widthPx: number,
    heightPx: number,
    camera: THREE.Camera,
    quadMesh: QuadMesh,
    meshWorldMatrix: THREE.Matrix4,
  ): number[];
}

/** Screen-space radius, in CSS px, within which a click lands on an edge. */
const EDGE_PICK_RADIUS_PX = 10;

export function createEditMeshHandles(): EditMeshHandles {
  // quadMeshSignature memoised on identity: a frozen mesh is the same object
  // every frame, a live one a fresh clone whose content usually hasn't moved.
  let keyedMesh: QuadMesh | null = null;
  let keyedValue = "";
  let dragFrame = 0;
  function keyOf(mesh: QuadMesh): string {
    if (mesh !== keyedMesh) {
      // A new mesh sharing the last one's faces is a drag frame: its
      // vertices moved (that's the only reason to make one), so it gets a
      // fresh key without hashing every position to confirm it.
      const moved = keyedMesh !== null && mesh.faces === keyedMesh.faces && mesh.positions !== keyedMesh.positions;
      keyedValue = moved ? `moved:${++dragFrame}` : quadMeshSignature(mesh);
      keyedMesh = mesh;
    }
    return keyedValue;
  }

  // A triangulated copy of the edit cage with a BVH, used to decide what the
  // mesh hides from the camera. Rebuilt only when the cage changes.
  let occluderKey = "";
  let occluderGeometry: THREE.BufferGeometry | null = null;
  let occluderEpsilon = 1e-4;
  function occluderFor(mesh: QuadMesh): MeshBVH {
    const key = keyOf(mesh);
    if (!occluderGeometry || occluderKey !== key) {
      if (occluderGeometry) {
        disposeGeometryBvh(occluderGeometry);
        occluderGeometry.dispose();
      }
      const tris: number[] = [];
      for (const face of mesh.faces) {
        for (const tri of triangulateFace(mesh.positions, face)) {
          const [a, b, c] = tri.map((corner) => mesh.positions[face[corner]]);
          if (a && b && c) tris.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
        }
      }
      occluderGeometry = new THREE.BufferGeometry();
      occluderGeometry.setAttribute("position", new THREE.Float32BufferAttribute(tris, 3));
      occluderGeometry.computeBoundingBox();
      const size = occluderGeometry.boundingBox!.getSize(new THREE.Vector3()).length();
      // Rays aimed at a vertex graze the faces around it: a hit that close
      // in front is the vertex's own surface, not something hiding it.
      occluderEpsilon = Math.max(1e-5, size * 2e-3);
      occluderKey = key;
    }
    return getBoundsTree(occluderGeometry);
  }

  let xray = false;
  const visRaycaster = new THREE.Raycaster();
  const visNdc = new THREE.Vector2();
  const visWorld = new THREE.Vector3();
  const visInv = new THREE.Matrix4();

  /**
   * Whether a local-space point is seen by the camera rather than hidden
   * behind the mesh. Always true in x-ray.
   */
  function isVisible(local: THREE.Vector3, camera: THREE.Camera, meshWorldMatrix: THREE.Matrix4, bvh: MeshBVH | null): boolean {
    if (xray || !bvh) return true;
    visWorld.copy(local).applyMatrix4(meshWorldMatrix).project(camera);
    visNdc.set(visWorld.x, visWorld.y);
    visRaycaster.setFromCamera(visNdc, camera);
    visInv.copy(meshWorldMatrix).invert();
    const localRay = visRaycaster.ray.clone().applyMatrix4(visInv);
    const target = localRay.origin.distanceTo(local);
    const hit = bvh.raycastFirst(localRay, THREE.DoubleSide);
    return !hit || hit.distance >= target - occluderEpsilon;
  }

  /** Screen position (CSS px) of a local-space point, or null when behind the camera. */
  const projScratch = new THREE.Vector3();
  function toScreen(
    raw: readonly [number, number, number],
    camera: THREE.Camera,
    meshWorldMatrix: THREE.Matrix4,
    widthPx: number,
    heightPx: number,
    out: THREE.Vector2,
  ): THREE.Vector2 | null {
    projScratch.set(raw[0], raw[1], raw[2]).applyMatrix4(meshWorldMatrix).project(camera);
    if (projScratch.z > 1 || projScratch.z < -1) return null;
    return out.set((projScratch.x * 0.5 + 0.5) * widthPx, (-(projScratch.y * 0.5) + 0.5) * heightPx);
  }

  const group = new THREE.Group();
  group.matrixAutoUpdate = false;

  // Every overlay is created once and only has its geometry swapped when
  // what it draws actually changed. sync() runs every frame, and it used to
  // dispose and rebuild every buffer *and* material each time — constant GC
  // churn and GPU re-uploads that made anything past a few thousand vertices
  // stutter while nothing was moving.
  const wireframeMat = new THREE.LineBasicMaterial({
    color: WIREFRAME_COLOR,
    transparent: true,
    opacity: 0.95,
    depthTest: true,
    depthWrite: false,
  });
  const faceMat = new THREE.MeshBasicMaterial({
    color: SELECTED_FACE_COLOR,
    transparent: true,
    opacity: 0.45,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const loopCutMat = new THREE.LineBasicMaterial({ color: LOOPCUT_PREVIEW_COLOR, depthTest: false });
  const proportionalMat = new THREE.LineBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.45,
    depthTest: false,
  });
  const selectedEdgeMat = createEdgeMaterial(SELECTED_EDGE_COLOR);
  const hoverEdgeMat = createEdgeMaterial(HOVER_EDGE_COLOR);

  const wireframeLines = new THREE.LineSegments(new THREE.BufferGeometry(), wireframeMat);
  wireframeLines.renderOrder = RENDER_ORDER;
  const faceHighlightMesh = new THREE.Mesh(new THREE.BufferGeometry(), faceMat);
  faceHighlightMesh.renderOrder = RENDER_ORDER + 1;
  // Materials assigned when points are first drawn — see getPointMaterials.
  const unselectedPointsMesh = new THREE.Points(new THREE.BufferGeometry());
  unselectedPointsMesh.renderOrder = RENDER_ORDER + 2;
  const selectedPointsMesh = new THREE.Points(new THREE.BufferGeometry());
  selectedPointsMesh.renderOrder = RENDER_ORDER + 3;
  const selectedEdgeLines = new LineSegments2(new LineSegmentsGeometry(), selectedEdgeMat);
  selectedEdgeLines.renderOrder = RENDER_ORDER + 3;
  const hoverEdgeLines = new LineSegments2(new LineSegmentsGeometry(), hoverEdgeMat);
  hoverEdgeLines.renderOrder = RENDER_ORDER + 4;
  // Marked edges, coloured by what marks them: sharp cyan, seam red, crease
  // magenta (drawn over the wireframe, same depth test).
  const markedMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 1, depthWrite: false });
  const markedEdgeLines = new THREE.LineSegments(new THREE.BufferGeometry(), markedMat);
  markedEdgeLines.renderOrder = RENDER_ORDER + 1;
  const loopCutLines = new THREE.LineSegments(new THREE.BufferGeometry(), loopCutMat);
  loopCutLines.renderOrder = RENDER_ORDER + 4;
  const proportionalCircleLines = new THREE.LineSegments(new THREE.BufferGeometry(), proportionalMat);
  proportionalCircleLines.renderOrder = RENDER_ORDER + 2;

  // Screen-width lines need the viewport's size; read it off the renderer
  // at draw time, so each viewport sharing these handles gets its own.
  const sizeScratch = new THREE.Vector2();
  for (const line of [selectedEdgeLines, hoverEdgeLines]) {
    line.onBeforeRender = (renderer) => {
      renderer.getSize(sizeScratch);
      (line.material as LineMaterial).resolution.copy(sizeScratch);
    };
  }

  const overlays: THREE.Object3D[] = [
    wireframeLines,
    markedEdgeLines,
    faceHighlightMesh,
    unselectedPointsMesh,
    selectedPointsMesh,
    selectedEdgeLines,
    hoverEdgeLines,
    loopCutLines,
    proportionalCircleLines,
  ];
  for (const o of overlays) {
    o.matrixAutoUpdate = false;
    // Bounding spheres are never recomputed for these ever-changing buffers,
    // and they are always on screen when shown.
    o.frustumCulled = false;
    o.visible = false;
    group.add(o);
  }

  function setPositions(object: THREE.Mesh | THREE.LineSegments | THREE.Points, values: number[]) {
    object.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    if (values.length > 0) geometry.setAttribute("position", new THREE.Float32BufferAttribute(values, 3));
    object.geometry = geometry;
    object.visible = values.length > 0;
  }

  function setSegments(object: LineSegments2, values: number[]) {
    object.geometry.dispose();
    const geometry = new LineSegmentsGeometry();
    if (values.length > 0) geometry.setPositions(values);
    object.geometry = geometry;
    object.visible = values.length > 0;
  }

  function edgeSegments(mesh: QuadMesh, edges: ReadonlyArray<EdgeRef>): number[] {
    const out: number[] = [];
    for (const [a, b] of edges) {
      const pa = mesh.positions[a];
      const pb = mesh.positions[b];
      if (pa && pb) out.push(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2]);
    }
    return out;
  }

  // What each overlay was last built from. A key that matches means the
  // overlay is already right and is left alone.
  let lastMesh: QuadMesh | null = null;
  let meshKey = "";
  let wireKey = "";
  let markedKey = "";
  let facesKey = "";
  let pointsKey = "";
  let edgesKey = "";
  let hoverEdgeKey = "";
  let loopKey: unknown = null;
  let proportionalKey = "";

  function clear() {
    for (const o of overlays) o.visible = false;
    lastMesh = null;
    meshKey = wireKey = markedKey = facesKey = pointsKey = edgesKey = hoverEdgeKey = proportionalKey = "";
    loopKey = null;
  }

  return {
    group,
    clear,

    setXray(next) {
      xray = next;
    },

    sync(state) {
      const { mesh, quadMesh, mode } = state;
      if (!mesh || !quadMesh) {
        if (lastMesh || wireframeLines.visible) clear();
        return;
      }

      group.matrix.copy(mesh.matrixWorld);
      group.matrixWorldNeedsUpdate = true;
      group.updateMatrixWorld(true);

      // Outside X-ray, handles behind the geometry are hidden, matching what
      // can be picked; in X-ray every one of them shows (and is pickable).
      if (mode === "points") {
        const mats = getPointMaterials();
        mats.unselected.depthTest = !xray;
        mats.selected.depthTest = !xray;
      }
      selectedEdgeMat.depthTest = !xray;
      hoverEdgeMat.depthTest = !xray;

      // Identity first: a frozen mesh hands back the same object every frame
      // until it's edited. A live one is a fresh clone each frame, so it
      // falls through to the content signature.
      if (quadMesh !== lastMesh) {
        meshKey = keyOf(quadMesh);
        lastMesh = quadMesh;
      }

      const positions = quadMesh.positions;
      const selPointsKey = mode === "points" ? Array.from(state.points).join(",") : "";
      const selEdgesKey = mode === "edges" ? state.edges.map((e) => `${e[0]}_${e[1]}`).join(",") : "";
      const selFacesKey = mode === "faces" ? Array.from(state.faces).join(",") : "";

      // 1. Quad wireframe
      if (wireKey !== meshKey) {
        wireKey = meshKey;
        const wirePositions: number[] = [];
        for (const [u, v] of getQuadMeshEdges(quadMesh)) {
          const pu = positions[u];
          const pv = positions[v];
          if (pu && pv) wirePositions.push(pu[0], pu[1], pu[2], pv[0], pv[1], pv[2]);
        }
        setPositions(wireframeLines, wirePositions);
      }

      // 1b. Marked edges (sharp / seam / crease). The mesh signature covers
      // the marks, so this rebuilds exactly when they change.
      if (markedKey !== meshKey) {
        markedKey = meshKey;
        const pos: number[] = [];
        const col: number[] = [];
        const push = (edges: ReadonlyArray<readonly number[]> | undefined, color: THREE.Color) => {
          for (const e of edges ?? []) {
            const pa = positions[e[0]];
            const pb = positions[e[1]];
            if (!pa || !pb) continue;
            pos.push(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2]);
            col.push(color.r, color.g, color.b, color.r, color.g, color.b);
          }
        };
        push(quadMesh.sharpEdges, new THREE.Color(0x22d3ee));
        push(quadMesh.edgeCreases, new THREE.Color(0xe879f9));
        push(quadMesh.seamEdges, new THREE.Color(0xef4444));
        markedEdgeLines.geometry.dispose();
        const geometry = new THREE.BufferGeometry();
        if (pos.length > 0) {
          geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
          geometry.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
        }
        markedEdgeLines.geometry = geometry;
        markedEdgeLines.visible = pos.length > 0;
      }

      // 2. Face selection overlay (faces mode)
      const hoverFace = state.hoverFace ?? null;
      const nextFacesKey = mode === "faces" ? `${meshKey}|${selFacesKey}|${hoverFace ?? ""}` : "off";
      if (facesKey !== nextFacesKey) {
        facesKey = nextFacesKey;
        const faceVerts: number[] = [];
        if (mode === "faces") {
          const facesToHighlight = new Set<number>(state.faces);
          if (hoverFace !== null) facesToHighlight.add(hoverFace);
          for (const fIdx of facesToHighlight) {
            const face = quadMesh.faces[fIdx];
            if (!face || face.length < 3) continue;
            for (const tri of triangulateFace(positions, face)) {
              for (const corner of tri) {
                const p = positions[face[corner]];
                if (p) faceVerts.push(p[0], p[1], p[2]);
              }
            }
          }
        }
        setPositions(faceHighlightMesh, faceVerts);
      }

      // 3. Point handles (points mode): circular, zoom-independent, orange when selected
      const nextPointsKey = mode === "points" ? `${meshKey}|${selPointsKey}` : "off";
      if (pointsKey !== nextPointsKey) {
        pointsKey = nextPointsKey;
        const unselectedPos: number[] = [];
        const selectedPos: number[] = [];
        if (mode === "points") {
          const mats = getPointMaterials();
          unselectedPointsMesh.material = mats.unselected;
          selectedPointsMesh.material = mats.selected;
          for (let idx = 0; idx < positions.length; idx++) {
            const p = positions[idx];
            if (!p) continue;
            (state.points.has(idx) ? selectedPos : unselectedPos).push(p[0], p[1], p[2]);
          }
        }
        setPositions(unselectedPointsMesh, unselectedPos);
        setPositions(selectedPointsMesh, selectedPos);
      }

      // 4. Selected edges (edges mode), drawn thick and orange
      const nextEdgesKey = mode === "edges" ? `${meshKey}|${selEdgesKey}` : "off";
      if (edgesKey !== nextEdgesKey) {
        edgesKey = nextEdgesKey;
        setSegments(selectedEdgeLines, mode === "edges" ? edgeSegments(quadMesh, state.edges) : []);
      }

      // 5. Hovered edge (edges mode, and whatever a loop select would start from)
      const hoverEdge = state.hoverEdge ?? null;
      const nextHoverKey = hoverEdge ? `${meshKey}|${hoverEdge[0]}_${hoverEdge[1]}` : "off";
      if (hoverEdgeKey !== nextHoverKey) {
        hoverEdgeKey = nextHoverKey;
        setSegments(hoverEdgeLines, hoverEdge ? edgeSegments(quadMesh, [hoverEdge]) : []);
      }

      // 6. Loop cut preview (the viewport replaces the array on every hover change)
      const loopPreview = state.loopPreview ?? null;
      if (loopKey !== loopPreview) {
        loopKey = loopPreview;
        const linePositions: number[] = [];
        for (const [pA, pB] of loopPreview ?? []) {
          linePositions.push(pA[0], pA[1], pA[2], pB[0], pB[1], pB[2]);
        }
        setPositions(loopCutLines, linePositions);
      }

      // 7. Proportional editing influence cage
      const diameter = state.proportionalDiameter ?? null;
      const selVerts = new Set<number>();
      if (mode === "points") for (const p of state.points) selVerts.add(p);
      else if (mode === "edges") for (const [a, b] of state.edges) selVerts.add(a).add(b);
      else for (const f of state.faces) for (const v of quadMesh.faces[f] ?? []) selVerts.add(v);
      const nextPropKey =
        diameter && diameter > 0 && selVerts.size > 0
          ? `${meshKey}|${mode}|${selPointsKey}|${selEdgesKey}|${selFacesKey}|${diameter}`
          : "off";
      if (proportionalKey !== nextPropKey) {
        proportionalKey = nextPropKey;
        const circleVerts: number[] = [];
        if (nextPropKey !== "off") {
          const cx = new THREE.Vector3();
          let count = 0;
          for (const v of selVerts) {
            const p = positions[v];
            if (p) {
              cx.x += p[0]; cx.y += p[1]; cx.z += p[2];
              count++;
            }
          }
          if (count > 0) {
            cx.divideScalar(count);
            const r = diameter! / 2;
            const segments = 48;
            for (let i = 0; i < segments; i++) {
              const a1 = (i / segments) * Math.PI * 2;
              const a2 = ((i + 1) / segments) * Math.PI * 2;
              const c1 = Math.cos(a1) * r;
              const s1 = Math.sin(a1) * r;
              const c2 = Math.cos(a2) * r;
              const s2 = Math.sin(a2) * r;
              circleVerts.push(cx.x + c1, cx.y + s1, cx.z, cx.x + c2, cx.y + s2, cx.z);
              circleVerts.push(cx.x + c1, cx.y, cx.z + s1, cx.x + c2, cx.y, cx.z + s2);
              circleVerts.push(cx.x, cx.y + c1, cx.z + s1, cx.x, cx.y + c2, cx.z + s2);
            }
          }
        }
        setPositions(proportionalCircleLines, circleVerts);
      }
    },

    pickFace(raycaster, quadMesh, meshWorldMatrix) {
      // Nearest front-facing hit along the ray: occlusion is inherent, which
      // is also why x-ray doesn't apply to a single click on a face.
      const invMatrix = meshWorldMatrix.clone().invert();
      const localRay = raycaster.ray.clone().applyMatrix4(invMatrix);
      // The normal matrix, not transformDirection: under non-uniform scale a
      // transformed direction is no longer perpendicular to the face.
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(meshWorldMatrix);

      let closestDist = Infinity;
      let closestFaceIdx: number | null = null;

      const pA = new THREE.Vector3();
      const pB = new THREE.Vector3();
      const pC = new THREE.Vector3();
      const localHit = new THREE.Vector3();
      const worldHit = new THREE.Vector3();

      for (let f = 0; f < quadMesh.faces.length; f++) {
        const face = quadMesh.faces[f];
        if (face.length < 3) continue;

        const worldNormal = computeFaceNormal(quadMesh.positions, face).applyMatrix3(normalMatrix).normalize();
        if (!xray && raycaster.ray.direction.dot(worldNormal) >= -1e-4) continue; // Backface

        for (const [ia, ib, ic] of triangulateFace(quadMesh.positions, face)) {
          const rawA = quadMesh.positions[face[ia]];
          const rawB = quadMesh.positions[face[ib]];
          const rawC = quadMesh.positions[face[ic]];
          if (!rawA || !rawB || !rawC) continue;
          pA.set(rawA[0], rawA[1], rawA[2]);
          pB.set(rawB[0], rawB[1], rawB[2]);
          pC.set(rawC[0], rawC[1], rawC[2]);
          if (!localRay.intersectTriangle(pA, pB, pC, false, localHit)) continue;
          worldHit.copy(localHit).applyMatrix4(meshWorldMatrix);
          const worldDist = raycaster.ray.origin.distanceTo(worldHit);
          if (worldDist < closestDist) {
            closestDist = worldDist;
            closestFaceIdx = f;
          }
        }
      }

      return closestFaceIdx;
    },

    pickPointsInRegion(region, widthPx, heightPx, camera, quadMesh, meshWorldMatrix) {
      const bvh = xray ? null : occluderFor(quadMesh);
      const picked: number[] = [];
      const screen = new THREE.Vector2();
      const local = new THREE.Vector3();
      for (let i = 0; i < quadMesh.positions.length; i++) {
        const raw = quadMesh.positions[i];
        if (!raw || !toScreen(raw, camera, meshWorldMatrix, widthPx, heightPx, screen)) continue;
        if (!region.contains(screen.x, screen.y)) continue;
        if (!isVisible(local.set(raw[0], raw[1], raw[2]), camera, meshWorldMatrix, bvh)) continue;
        picked.push(i);
      }
      return picked;
    },

    pickEdgesInRegion(region, widthPx, heightPx, camera, quadMesh, meshWorldMatrix) {
      const bvh = xray ? null : occluderFor(quadMesh);
      const picked: EdgeRef[] = [];
      const a = new THREE.Vector2();
      const b = new THREE.Vector2();
      const mid = new THREE.Vector3();
      for (const [u, v] of getQuadMeshEdges(quadMesh)) {
        const pu = quadMesh.positions[u];
        const pv = quadMesh.positions[v];
        if (!pu || !pv) continue;
        if (!toScreen(pu, camera, meshWorldMatrix, widthPx, heightPx, a)) continue;
        if (!toScreen(pv, camera, meshWorldMatrix, widthPx, heightPx, b)) continue;
        const inside = region.hitsSegment
          ? region.hitsSegment(a.x, a.y, b.x, b.y)
          : region.contains(a.x, a.y) && region.contains(b.x, b.y);
        if (!inside) continue;
        mid.set((pu[0] + pv[0]) / 2, (pu[1] + pv[1]) / 2, (pu[2] + pv[2]) / 2);
        if (!isVisible(mid, camera, meshWorldMatrix, bvh)) continue;
        picked.push([u, v]);
      }
      return picked;
    },

    pickFacesInRegion(region, widthPx, heightPx, camera, quadMesh, meshWorldMatrix) {
      const bvh = xray ? null : occluderFor(quadMesh);
      const picked: number[] = [];
      const screen = new THREE.Vector2();
      const viewDir = new THREE.Vector3();
      const camPos = new THREE.Vector3();
      camera.getWorldDirection(viewDir);
      camera.getWorldPosition(camPos);
      const isOrtho = (camera as THREE.OrthographicCamera).isOrthographicCamera === true;
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(meshWorldMatrix);

      for (let f = 0; f < quadMesh.faces.length; f++) {
        const face = quadMesh.faces[f];
        if (face.length < 3) continue;

        const localCentroid = computeFaceCentroid(quadMesh.positions, face);
        if (!xray) {
          // Facing away from the camera: along the view direction for an
          // orthographic camera, towards the eye for a perspective one.
          const worldNormal = computeFaceNormal(quadMesh.positions, face).applyMatrix3(normalMatrix);
          const worldCentroid = localCentroid.clone().applyMatrix4(meshWorldMatrix);
          const toCam = isOrtho ? viewDir.clone().negate() : camPos.clone().sub(worldCentroid);
          if (worldNormal.dot(toCam) <= 0) continue;
          // Hidden behind other parts of the mesh.
          if (!isVisible(localCentroid, camera, meshWorldMatrix, bvh)) continue;
        }

        const c = localCentroid;
        if (toScreen([c.x, c.y, c.z], camera, meshWorldMatrix, widthPx, heightPx, screen) && region.contains(screen.x, screen.y)) {
          picked.push(f);
          continue;
        }
        for (const vIdx of face) {
          const raw = quadMesh.positions[vIdx];
          if (!raw || !toScreen(raw, camera, meshWorldMatrix, widthPx, heightPx, screen)) continue;
          if (region.contains(screen.x, screen.y)) {
            picked.push(f);
            break;
          }
        }
      }
      return picked;
    },

    pickPoint(ndc, camera, widthPx, heightPx, quadMesh, meshWorldMatrix, exclude) {
      const cursorX = (ndc.x * 0.5 + 0.5) * widthPx;
      const cursorY = (-(ndc.y * 0.5) + 0.5) * heightPx;
      const screen = new THREE.Vector2();

      // Everything within reach, nearest first; the first one the camera can
      // actually see wins — so a front vertex drawn over a back one is the
      // one picked, and a back one alone under the cursor isn't.
      const candidates: { idx: number; dist: number }[] = [];
      for (let i = 0; i < quadMesh.positions.length; i++) {
        const raw = quadMesh.positions[i];
        if (exclude?.has(i)) continue;
        if (!raw || !toScreen(raw, camera, meshWorldMatrix, widthPx, heightPx, screen)) continue;
        const dist = Math.hypot(screen.x - cursorX, screen.y - cursorY);
        if (dist < 16) candidates.push({ idx: i, dist });
      }
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => a.dist - b.dist);
      const bvh = xray ? null : occluderFor(quadMesh);
      const local = new THREE.Vector3();
      for (const { idx } of candidates) {
        const raw = quadMesh.positions[idx];
        if (isVisible(local.set(raw[0], raw[1], raw[2]), camera, meshWorldMatrix, bvh)) return idx;
      }
      return null;
    },

    pickEdge(ndc, camera, widthPx, heightPx, quadMesh, meshWorldMatrix) {
      // In screen pixels, like every other pick: a world-space threshold made
      // Loop Cut unusable on anything much smaller or larger than a unit box.
      const cursor = new THREE.Vector2((ndc.x * 0.5 + 0.5) * widthPx, (-(ndc.y * 0.5) + 0.5) * heightPx);
      const a = new THREE.Vector2();
      const b = new THREE.Vector2();
      const ab = new THREE.Vector2();
      const candidates: { edge: EdgeRef; dist: number }[] = [];

      for (const [u, v] of getQuadMeshEdges(quadMesh)) {
        const rawU = quadMesh.positions[u];
        const rawV = quadMesh.positions[v];
        if (!rawU || !rawV) continue;
        if (!toScreen(rawU, camera, meshWorldMatrix, widthPx, heightPx, a)) continue;
        if (!toScreen(rawV, camera, meshWorldMatrix, widthPx, heightPx, b)) continue;
        ab.subVectors(b, a);
        const lenSq = ab.lengthSq();
        const t = lenSq > 1e-9 ? Math.max(0, Math.min(1, cursor.clone().sub(a).dot(ab) / lenSq)) : 0;
        const dist = cursor.distanceTo(a.clone().addScaledVector(ab, t));
        if (dist <= EDGE_PICK_RADIUS_PX) candidates.push({ edge: [u, v], dist });
      }
      if (candidates.length === 0) return null;
      candidates.sort((x, y) => x.dist - y.dist);

      const bvh = xray ? null : occluderFor(quadMesh);
      const mid = new THREE.Vector3();
      for (const { edge } of candidates) {
        const pu = quadMesh.positions[edge[0]];
        const pv = quadMesh.positions[edge[1]];
        mid.set((pu[0] + pv[0]) / 2, (pu[1] + pv[1]) / 2, (pu[2] + pv[2]) / 2);
        if (isVisible(mid, camera, meshWorldMatrix, bvh)) return edge;
      }
      return null;
    },
  };
}
