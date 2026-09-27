import * as THREE from "three";
import type { MeshBVH } from "three-mesh-bvh";
import { disposeGeometryBvh, getBoundsTree } from "./bvh";
import {
  QuadMesh,
  getQuadMeshEdges,
  computeFaceNormal,
  computeFaceCentroid,
  quadMeshSignature,
} from "../graph/quadMesh";
import { triangulateFace } from "../graph/mesh/triangulate";

const WIREFRAME_COLOR = 0x38bdf8;
const SELECTED_FACE_COLOR = 0x22c55e;
const POINT_COLOR = "#f8fafc";
const SELECTED_POINT_COLOR = "#ff7700"; // User requirement: selected points must be orange
const LOOPCUT_PREVIEW_COLOR = 0xfacc15;

const RENDER_ORDER = 998;

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

/** Point handle diameters, in px. */
const POINT_SIZE = 7;
const SELECTED_POINT_SIZE = 9;

/**
 * How far each point handle is pulled toward the camera, as a fraction of
 * its distance, before the depth test. A vertex sits exactly on the faces
 * around it, so without this it would z-fight with (and be hidden by) its own
 * surface. Relative rather than absolute so it holds at any zoom or scale.
 */
const POINT_DEPTH_PULL = 0.004;

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
      mvPosition.xyz *= ${(1 - POINT_DEPTH_PULL).toFixed(6)};
      gl_Position = projectionMatrix * mvPosition;`,
    );
  };
  material.customProgramCacheKey = () => "edit-mesh-point-depth-pull";
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

export interface EditMeshHandles {
  readonly group: THREE.Group;
  sync(
    mesh: THREE.Mesh | null,
    quadMesh: QuadMesh | null,
    selectMode: "points" | "faces",
    selectedPoints: Set<number>,
    selectedFaces: Set<number>,
    hoverFace: number | null,
    previewLoopCutSegments: [ [number, number, number], [number, number, number] ][] | null,
    proportionalDiameter?: number | null,
  ): void;
  clear(): void;
  pickFace(raycaster: THREE.Raycaster, quadMesh: QuadMesh, meshWorldMatrix: THREE.Matrix4): number | null;
  pickPoint(
    ndc: THREE.Vector2,
    camera: THREE.Camera,
    widthPx: number,
    heightPx: number,
    quadMesh: QuadMesh,
    meshWorldMatrix: THREE.Matrix4,
  ): number | null;
  pickEdge(
    ndc: THREE.Vector2,
    camera: THREE.Camera,
    widthPx: number,
    heightPx: number,
    quadMesh: QuadMesh,
    meshWorldMatrix: THREE.Matrix4,
  ): [number, number] | null;
  /**
   * X-ray: pick through the surface. Off (the default), points and faces
   * hidden behind the mesh itself can't be clicked, box-selected or painted.
   */
  setXray(xray: boolean): void;
  pickPointsInRect(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    widthPx: number,
    heightPx: number,
    camera: THREE.Camera,
    quadMesh: QuadMesh,
    meshWorldMatrix: THREE.Matrix4,
  ): number[];
  pickFacesInRect(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    widthPx: number,
    heightPx: number,
    camera: THREE.Camera,
    quadMesh: QuadMesh,
    meshWorldMatrix: THREE.Matrix4,
  ): number[];
  pickPointsInRadius(
    screenX: number,
    screenY: number,
    radiusPx: number,
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
  function keyOf(mesh: QuadMesh): string {
    if (mesh !== keyedMesh) {
      keyedMesh = mesh;
      keyedValue = quadMeshSignature(mesh);
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
      if (occluderGeometry) disposeGeometryBvh(occluderGeometry), occluderGeometry.dispose();
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
    raw: [number, number, number],
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
    polygonOffset: true,
    polygonOffsetFactor: -1.5,
    polygonOffsetUnits: -4,
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
  const loopCutMat = new THREE.LineBasicMaterial({ color: LOOPCUT_PREVIEW_COLOR, linewidth: 3, depthTest: false });
  const proportionalMat = new THREE.LineBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.45,
    depthTest: false,
  });

  const wireframeLines = new THREE.LineSegments(new THREE.BufferGeometry(), wireframeMat);
  wireframeLines.renderOrder = RENDER_ORDER;
  const faceHighlightMesh = new THREE.Mesh(new THREE.BufferGeometry(), faceMat);
  faceHighlightMesh.renderOrder = RENDER_ORDER + 1;
  // Materials assigned when points are first drawn — see getPointMaterials.
  const unselectedPointsMesh = new THREE.Points(new THREE.BufferGeometry());
  unselectedPointsMesh.renderOrder = RENDER_ORDER + 2;
  const selectedPointsMesh = new THREE.Points(new THREE.BufferGeometry());
  selectedPointsMesh.renderOrder = RENDER_ORDER + 3;
  const loopCutLines = new THREE.LineSegments(new THREE.BufferGeometry(), loopCutMat);
  loopCutLines.renderOrder = RENDER_ORDER + 4;
  const proportionalCircleLines = new THREE.LineSegments(new THREE.BufferGeometry(), proportionalMat);
  proportionalCircleLines.renderOrder = RENDER_ORDER + 2;

  const overlays: THREE.Object3D[] = [
    wireframeLines,
    faceHighlightMesh,
    unselectedPointsMesh,
    selectedPointsMesh,
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

  // What each overlay was last built from. A key that matches means the
  // overlay is already right and is left alone.
  let lastMesh: QuadMesh | null = null;
  let meshKey = "";
  let wireKey = "";
  let facesKey = "";
  let pointsKey = "";
  let loopKey: unknown = null;
  let proportionalKey = "";

  function clear() {
    for (const o of overlays) o.visible = false;
    lastMesh = null;
    meshKey = wireKey = facesKey = pointsKey = proportionalKey = "";
    loopKey = null;
  }

  return {
    group,
    clear,

    sync(mesh, quadMesh, selectMode, selectedPoints, selectedFaces, hoverFace, previewLoopCutSegments, proportionalDiameter) {
      if (!mesh || !quadMesh) {
        if (lastMesh || wireframeLines.visible) clear();
        return;
      }

      group.matrix.copy(mesh.matrixWorld);
      group.matrixWorldNeedsUpdate = true;
      group.updateMatrixWorld(true);

      // Outside X-ray, handles behind the geometry are hidden, matching what
      // can be picked; in X-ray every one of them shows (and is pickable).
      if (selectMode === "points") {
        const mats = getPointMaterials();
        mats.unselected.depthTest = !xray;
        mats.selected.depthTest = !xray;
      }

      // Identity first: a frozen mesh hands back the same object every frame
      // until it's edited. A live one is a fresh clone each frame, so it
      // falls through to the content signature.
      if (quadMesh !== lastMesh) {
        meshKey = keyOf(quadMesh);
        lastMesh = quadMesh;
      }

      const positions = quadMesh.positions;
      const selPointsKey = selectMode === "points" ? Array.from(selectedPoints).join(",") : "";
      const selFacesKey = selectMode === "faces" ? Array.from(selectedFaces).join(",") : "";

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

      // 2. Face selection overlay (faces mode)
      const nextFacesKey = selectMode === "faces" ? `${meshKey}|${selFacesKey}|${hoverFace ?? ""}` : "off";
      if (facesKey !== nextFacesKey) {
        facesKey = nextFacesKey;
        const faceVerts: number[] = [];
        if (selectMode === "faces") {
          const facesToHighlight = new Set<number>(selectedFaces);
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
      const nextPointsKey = selectMode === "points" ? `${meshKey}|${selPointsKey}` : "off";
      if (pointsKey !== nextPointsKey) {
        pointsKey = nextPointsKey;
        const unselectedPos: number[] = [];
        const selectedPos: number[] = [];
        if (selectMode === "points") {
          const mats = getPointMaterials();
          unselectedPointsMesh.material = mats.unselected;
          selectedPointsMesh.material = mats.selected;
          for (let idx = 0; idx < positions.length; idx++) {
            const p = positions[idx];
            if (!p) continue;
            (selectedPoints.has(idx) ? selectedPos : unselectedPos).push(p[0], p[1], p[2]);
          }
        }
        setPositions(unselectedPointsMesh, unselectedPos);
        setPositions(selectedPointsMesh, selectedPos);
      }

      // 4. Loop cut preview (the viewport replaces the array on every hover change)
      if (loopKey !== previewLoopCutSegments) {
        loopKey = previewLoopCutSegments;
        const linePositions: number[] = [];
        for (const [pA, pB] of previewLoopCutSegments ?? []) {
          linePositions.push(pA[0], pA[1], pA[2], pB[0], pB[1], pB[2]);
        }
        setPositions(loopCutLines, linePositions);
      }

      // 5. Proportional editing influence cage
      const hasSelection = selectMode === "points" ? selectedPoints.size > 0 : selectedFaces.size > 0;
      const nextPropKey =
        proportionalDiameter && proportionalDiameter > 0 && hasSelection
          ? `${meshKey}|${selectMode}|${selPointsKey}|${selFacesKey}|${proportionalDiameter}`
          : "off";
      if (proportionalKey !== nextPropKey) {
        proportionalKey = nextPropKey;
        const circleVerts: number[] = [];
        if (nextPropKey !== "off") {
          const selVerts = new Set<number>();
          if (selectMode === "points") {
            for (const p of selectedPoints) selVerts.add(p);
          } else {
            for (const f of selectedFaces) {
              const face = quadMesh.faces[f];
              if (face) for (const v of face) selVerts.add(v);
            }
          }
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
            const r = proportionalDiameter! / 2;
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

    setXray(next) {
      xray = next;
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

    pickPointsInRect(minX, minY, maxX, maxY, widthPx, heightPx, camera, quadMesh, meshWorldMatrix) {
      const bvh = xray ? null : occluderFor(quadMesh);
      const selectedIndices: number[] = [];
      const screen = new THREE.Vector2();
      const local = new THREE.Vector3();
      for (let i = 0; i < quadMesh.positions.length; i++) {
        const raw = quadMesh.positions[i];
        if (!raw || !toScreen(raw, camera, meshWorldMatrix, widthPx, heightPx, screen)) continue;
        if (screen.x < minX || screen.x > maxX || screen.y < minY || screen.y > maxY) continue;
        if (!isVisible(local.set(raw[0], raw[1], raw[2]), camera, meshWorldMatrix, bvh)) continue;
        selectedIndices.push(i);
      }
      return selectedIndices;
    },

    pickFacesInRect(minX, minY, maxX, maxY, widthPx, heightPx, camera, quadMesh, meshWorldMatrix) {
      const bvh = xray ? null : occluderFor(quadMesh);
      const selectedIndices: number[] = [];
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
        if (toScreen([c.x, c.y, c.z], camera, meshWorldMatrix, widthPx, heightPx, screen)) {
          if (screen.x >= minX && screen.x <= maxX && screen.y >= minY && screen.y <= maxY) {
            selectedIndices.push(f);
            continue;
          }
        }
        for (const vIdx of face) {
          const raw = quadMesh.positions[vIdx];
          if (!raw || !toScreen(raw, camera, meshWorldMatrix, widthPx, heightPx, screen)) continue;
          if (screen.x >= minX && screen.x <= maxX && screen.y >= minY && screen.y <= maxY) {
            selectedIndices.push(f);
            break;
          }
        }
      }
      return selectedIndices;
    },

    pickPointsInRadius(screenX, screenY, radiusPx, widthPx, heightPx, camera, quadMesh, meshWorldMatrix) {
      const bvh = xray ? null : occluderFor(quadMesh);
      const result: number[] = [];
      const screen = new THREE.Vector2();
      const local = new THREE.Vector3();
      for (let i = 0; i < quadMesh.positions.length; i++) {
        const raw = quadMesh.positions[i];
        if (!raw || !toScreen(raw, camera, meshWorldMatrix, widthPx, heightPx, screen)) continue;
        if (Math.hypot(screen.x - screenX, screen.y - screenY) > radiusPx) continue;
        if (!isVisible(local.set(raw[0], raw[1], raw[2]), camera, meshWorldMatrix, bvh)) continue;
        result.push(i);
      }
      return result;
    },

    pickPoint(ndc, camera, widthPx, heightPx, quadMesh, meshWorldMatrix) {
      const cursorX = (ndc.x * 0.5 + 0.5) * widthPx;
      const cursorY = (-(ndc.y * 0.5) + 0.5) * heightPx;
      const screen = new THREE.Vector2();

      // Everything within reach, nearest first; the first one the camera can
      // actually see wins — so a front vertex drawn over a back one is the
      // one picked, and a back one alone under the cursor isn't.
      const candidates: { idx: number; dist: number }[] = [];
      for (let i = 0; i < quadMesh.positions.length; i++) {
        const raw = quadMesh.positions[i];
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
      const candidates: { edge: [number, number]; dist: number }[] = [];

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
