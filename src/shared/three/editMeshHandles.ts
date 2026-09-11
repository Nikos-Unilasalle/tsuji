import * as THREE from "three";
import {
  QuadMesh,
  getQuadMeshEdges,
  computeFaceNormal,
  computeFaceCentroid,
} from "../graph/quadMesh";

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

// Singleton circular point textures & materials for zoom-independent screen-space circles
const unselectedCircleTexture = createCircleTexture(POINT_COLOR, "rgba(15,23,42,0.8)");
const selectedCircleTexture = createCircleTexture(SELECTED_POINT_COLOR, "rgba(124,45,18,0.9)");

const unselectedPointsMat = new THREE.PointsMaterial({
  size: 9,
  sizeAttenuation: false, // Zoom-independent constant pixel size
  map: unselectedCircleTexture,
  transparent: true,
  alphaTest: 0.1,
  depthTest: false,
});

const selectedPointsMat = new THREE.PointsMaterial({
  size: 11,
  sizeAttenuation: false, // Zoom-independent constant pixel size
  map: selectedCircleTexture,
  transparent: true,
  alphaTest: 0.1,
  depthTest: false,
});

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
  pickEdge(raycaster: THREE.Raycaster, quadMesh: QuadMesh, meshWorldMatrix: THREE.Matrix4): [number, number] | null;
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

export function createEditMeshHandles(): EditMeshHandles {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;

  // Wireframe quad edges
  let wireframeLines: THREE.LineSegments | null = null;
  // Face selection highlight mesh
  let faceHighlightMesh: THREE.Mesh | null = null;
  // Point handles (zoom-independent circles via Points)
  let unselectedPointsMesh: THREE.Points | null = null;
  let selectedPointsMesh: THREE.Points | null = null;
  // Loop cut preview line
  let loopCutLines: THREE.LineSegments | null = null;

  function clear() {
    if (wireframeLines) {
      group.remove(wireframeLines);
      wireframeLines.geometry.dispose();
      (wireframeLines.material as THREE.Material).dispose();
      wireframeLines = null;
    }
    if (faceHighlightMesh) {
      group.remove(faceHighlightMesh);
      faceHighlightMesh.geometry.dispose();
      (faceHighlightMesh.material as THREE.Material).dispose();
      faceHighlightMesh = null;
    }
    if (unselectedPointsMesh) {
      group.remove(unselectedPointsMesh);
      unselectedPointsMesh.geometry.dispose();
      unselectedPointsMesh = null;
    }
    if (selectedPointsMesh) {
      group.remove(selectedPointsMesh);
      selectedPointsMesh.geometry.dispose();
      selectedPointsMesh = null;
    }
    if (loopCutLines) {
      group.remove(loopCutLines);
      loopCutLines.geometry.dispose();
      (loopCutLines.material as THREE.Material).dispose();
      loopCutLines = null;
    }
  }

  return {
    group,
    clear,

    sync(mesh, quadMesh, selectMode, selectedPoints, selectedFaces, hoverFace, previewLoopCutSegments) {
      clear();
      if (!mesh || !quadMesh) return;

      group.matrix.copy(mesh.matrixWorld);
      group.updateMatrixWorld(true);

      const positions = quadMesh.positions;

      // 1. Quad Wireframe
      const edges = getQuadMeshEdges(quadMesh);
      const wirePositions: number[] = [];
      for (const [u, v] of edges) {
        const pu = positions[u];
        const pv = positions[v];
        if (pu && pv) {
          wirePositions.push(pu[0], pu[1], pu[2], pv[0], pv[1], pv[2]);
        }
      }

      if (wirePositions.length > 0) {
        const wireGeom = new THREE.BufferGeometry();
        wireGeom.setAttribute("position", new THREE.Float32BufferAttribute(wirePositions, 3));
        const wireMat = new THREE.LineBasicMaterial({
          color: WIREFRAME_COLOR,
          transparent: true,
          opacity: 0.95,
          polygonOffset: true,
          polygonOffsetFactor: -1.5,
          polygonOffsetUnits: -4,
          depthTest: true,
          depthWrite: false,
        });
        wireframeLines = new THREE.LineSegments(wireGeom, wireMat);
        wireframeLines.renderOrder = RENDER_ORDER;
        wireframeLines.matrixAutoUpdate = false;
        group.add(wireframeLines);
      }

      // 2. Face Selection Overlay (in faces mode)
      if (selectMode === "faces") {
        const faceVerts: number[] = [];
        const facesToHighlight = new Set<number>(selectedFaces);
        if (hoverFace !== null && !facesToHighlight.has(hoverFace)) {
          facesToHighlight.add(hoverFace);
        }

        for (const fIdx of facesToHighlight) {
          const face = quadMesh.faces[fIdx];
          if (!face || face.length < 3) continue;

          const p0 = positions[face[0]];
          const p1 = positions[face[1]];
          const p2 = positions[face[2]];
          if (!p0 || !p1 || !p2) continue;

          faceVerts.push(
            p0[0], p0[1], p0[2],
            p1[0], p1[1], p1[2],
            p2[0], p2[1], p2[2],
          );

          if (face.length === 4) {
            const p3 = positions[face[3]];
            if (p3) {
              faceVerts.push(
                p0[0], p0[1], p0[2],
                p2[0], p2[1], p2[2],
                p3[0], p3[1], p3[2],
              );
            }
          } else if (face.length > 4) {
            for (let i = 2; i < face.length - 1; i++) {
              const pi = positions[face[i]];
              const piNext = positions[face[i + 1]];
              if (pi && piNext) {
                faceVerts.push(
                  p0[0], p0[1], p0[2],
                  pi[0], pi[1], pi[2],
                  piNext[0], piNext[1], piNext[2],
                );
              }
            }
          }
        }

        if (faceVerts.length > 0) {
          const faceGeom = new THREE.BufferGeometry();
          faceGeom.setAttribute("position", new THREE.Float32BufferAttribute(faceVerts, 3));
          faceGeom.computeVertexNormals();

          const faceMat = new THREE.MeshBasicMaterial({
            color: SELECTED_FACE_COLOR,
            transparent: true,
            opacity: 0.45,
            side: THREE.DoubleSide,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -2,
          });

          faceHighlightMesh = new THREE.Mesh(faceGeom, faceMat);
          faceHighlightMesh.renderOrder = RENDER_ORDER + 1;
          faceHighlightMesh.matrixAutoUpdate = false;
          group.add(faceHighlightMesh);
        }
      }

      // 3. Point Control Handles (in points mode): circular, zoom-independent, orange when selected
      if (selectMode === "points") {
        const unselectedPos: number[] = [];
        const selectedPos: number[] = [];

        for (let idx = 0; idx < positions.length; idx++) {
          const p = positions[idx];
          if (!p) continue;
          if (selectedPoints.has(idx)) {
            selectedPos.push(p[0], p[1], p[2]);
          } else {
            unselectedPos.push(p[0], p[1], p[2]);
          }
        }

        if (unselectedPos.length > 0) {
          const unselGeom = new THREE.BufferGeometry();
          unselGeom.setAttribute("position", new THREE.Float32BufferAttribute(unselectedPos, 3));
          unselectedPointsMesh = new THREE.Points(unselGeom, unselectedPointsMat);
          unselectedPointsMesh.renderOrder = RENDER_ORDER + 2;
          unselectedPointsMesh.matrixAutoUpdate = false;
          group.add(unselectedPointsMesh);
        }

        if (selectedPos.length > 0) {
          const selGeom = new THREE.BufferGeometry();
          selGeom.setAttribute("position", new THREE.Float32BufferAttribute(selectedPos, 3));
          selectedPointsMesh = new THREE.Points(selGeom, selectedPointsMat);
          selectedPointsMesh.renderOrder = RENDER_ORDER + 3;
          selectedPointsMesh.matrixAutoUpdate = false;
          group.add(selectedPointsMesh);
        }
      }

      // 4. Loop Cut Preview Line (drawn across mesh quads before click)
      if (previewLoopCutSegments && previewLoopCutSegments.length > 0) {
        const linePositions: number[] = [];
        for (const [pA, pB] of previewLoopCutSegments) {
          linePositions.push(pA[0], pA[1], pA[2], pB[0], pB[1], pB[2]);
        }
        if (linePositions.length > 0) {
          const cutGeom = new THREE.BufferGeometry();
          cutGeom.setAttribute("position", new THREE.Float32BufferAttribute(linePositions, 3));
          const cutMat = new THREE.LineBasicMaterial({
            color: LOOPCUT_PREVIEW_COLOR,
            linewidth: 3,
            depthTest: false,
          });
          loopCutLines = new THREE.LineSegments(cutGeom, cutMat);
          loopCutLines.renderOrder = RENDER_ORDER + 4;
          loopCutLines.matrixAutoUpdate = false;
          group.add(loopCutLines);
        }
      }
    },

    pickFace(raycaster, quadMesh, meshWorldMatrix) {
      // Transform ray to local mesh coordinates
      const invMatrix = meshWorldMatrix.clone().invert();
      const localRay = raycaster.ray.clone().applyMatrix4(invMatrix);

      let closestDist = Infinity;
      let closestFaceIdx: number | null = null;

      const pA = new THREE.Vector3();
      const pB = new THREE.Vector3();
      const pC = new THREE.Vector3();
      const pD = new THREE.Vector3();
      const localHit = new THREE.Vector3();
      const worldHit = new THREE.Vector3();

      for (let f = 0; f < quadMesh.faces.length; f++) {
        const face = quadMesh.faces[f];
        if (face.length < 3) continue;

        // Backface culling: face normal in world space must point toward camera
        const faceNormal = computeFaceNormal(quadMesh.positions, face);
        const worldNormal = faceNormal.clone().transformDirection(meshWorldMatrix).normalize();
        if (raycaster.ray.direction.dot(worldNormal) >= -1e-4) {
          continue; // Backface
        }

        const rawA = quadMesh.positions[face[0]];
        const rawB = quadMesh.positions[face[1]];
        const rawC = quadMesh.positions[face[2]];
        pA.set(rawA[0], rawA[1], rawA[2]);
        pB.set(rawB[0], rawB[1], rawB[2]);
        pC.set(rawC[0], rawC[1], rawC[2]);

        let hitFound = false;
        let intersect = localRay.intersectTriangle(pA, pB, pC, true, localHit);
        if (intersect) {
          hitFound = true;
        } else if (face.length === 4) {
          const rawD = quadMesh.positions[face[3]];
          pD.set(rawD[0], rawD[1], rawD[2]);
          intersect = localRay.intersectTriangle(pA, pC, pD, true, localHit);
          if (intersect) {
            hitFound = true;
          }
        }

        if (hitFound) {
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
      const selectedIndices: number[] = [];
      const worldPos = new THREE.Vector3();
      const projPos = new THREE.Vector3();

      for (let i = 0; i < quadMesh.positions.length; i++) {
        const raw = quadMesh.positions[i];
        worldPos.set(raw[0], raw[1], raw[2]).applyMatrix4(meshWorldMatrix);
        projPos.copy(worldPos).project(camera);

        if (projPos.z > 1) continue; // Behind camera

        const px = (projPos.x * 0.5 + 0.5) * widthPx;
        const py = (-(projPos.y * 0.5) + 0.5) * heightPx;

        if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
          selectedIndices.push(i);
        }
      }

      return selectedIndices;
    },

    pickFacesInRect(minX, minY, maxX, maxY, widthPx, heightPx, camera, quadMesh, meshWorldMatrix) {
      const selectedIndices: number[] = [];
      const worldPos = new THREE.Vector3();
      const projPos = new THREE.Vector3();

      for (let f = 0; f < quadMesh.faces.length; f++) {
        const face = quadMesh.faces[f];
        if (face.length < 3) continue;

        // Backface check: face must face toward camera
        const faceNormal = computeFaceNormal(quadMesh.positions, face);
        const worldNormal = faceNormal.clone().transformDirection(meshWorldMatrix).normalize();
        const centroid = computeFaceCentroid(quadMesh.positions, face).applyMatrix4(meshWorldMatrix);
        const toCam = camera.position.clone().sub(centroid).normalize();
        if (worldNormal.dot(toCam) <= 0) continue; // Facing away from camera

        // Check if centroid or any vertex projects into the rectangle
        centroid.project(camera);
        if (centroid.z > 1) continue;

        const cpx = (centroid.x * 0.5 + 0.5) * widthPx;
        const cpy = (-(centroid.y * 0.5) + 0.5) * heightPx;

        if (cpx >= minX && cpx <= maxX && cpy >= minY && cpy <= maxY) {
          selectedIndices.push(f);
          continue;
        }

        // Also check if face vertices are inside
        let vertsInside = 0;
        for (const vIdx of face) {
          const raw = quadMesh.positions[vIdx];
          worldPos.set(raw[0], raw[1], raw[2]).applyMatrix4(meshWorldMatrix);
          projPos.copy(worldPos).project(camera);
          if (projPos.z <= 1) {
            const vpx = (projPos.x * 0.5 + 0.5) * widthPx;
            const vpy = (-(projPos.y * 0.5) + 0.5) * heightPx;
            if (vpx >= minX && vpx <= maxX && vpy >= minY && vpy <= maxY) {
              vertsInside++;
            }
          }
        }
        if (vertsInside > 0) {
          selectedIndices.push(f);
        }
      }

      return selectedIndices;
    },

    pickPointsInRadius(screenX, screenY, radiusPx, widthPx, heightPx, camera, quadMesh, meshWorldMatrix) {
      const result: number[] = [];
      const worldPos = new THREE.Vector3();
      const projPos = new THREE.Vector3();

      for (let i = 0; i < quadMesh.positions.length; i++) {
        const raw = quadMesh.positions[i];
        worldPos.set(raw[0], raw[1], raw[2]).applyMatrix4(meshWorldMatrix);
        projPos.copy(worldPos).project(camera);

        if (projPos.z > 1) continue;

        const px = (projPos.x * 0.5 + 0.5) * widthPx;
        const py = (-(projPos.y * 0.5) + 0.5) * heightPx;
        if (Math.hypot(px - screenX, py - screenY) <= radiusPx) {
          result.push(i);
        }
      }

      return result;
    },

    pickPoint(ndc, camera, widthPx, heightPx, quadMesh, meshWorldMatrix) {
      const screenPos = new THREE.Vector2((ndc.x * 0.5 + 0.5) * widthPx, (-(ndc.y * 0.5) + 0.5) * heightPx);
      const worldPos = new THREE.Vector3();
      const projPos = new THREE.Vector3();

      let bestIdx: number | null = null;
      let bestDist = 16; // 16px radius

      for (let i = 0; i < quadMesh.positions.length; i++) {
        const raw = quadMesh.positions[i];
        worldPos.set(raw[0], raw[1], raw[2]).applyMatrix4(meshWorldMatrix);
        projPos.copy(worldPos).project(camera);

        if (projPos.z > 1) continue; // Behind camera

        const px = (projPos.x * 0.5 + 0.5) * widthPx;
        const py = (-(projPos.y * 0.5) + 0.5) * heightPx;
        const dist = Math.hypot(px - screenPos.x, py - screenPos.y);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }

      return bestIdx;
    },

    pickEdge(raycaster, quadMesh, meshWorldMatrix) {
      // Find closest edge to ray
      const invMatrix = meshWorldMatrix.clone().invert();
      const localRay = raycaster.ray.clone().applyMatrix4(invMatrix);

      const edges = getQuadMeshEdges(quadMesh);
      let bestEdge: [number, number] | null = null;
      let bestDist = Infinity;

      const pA = new THREE.Vector3();
      const pB = new THREE.Vector3();
      const segPoint = new THREE.Vector3();

      for (const [u, v] of edges) {
        const rawU = quadMesh.positions[u];
        const rawV = quadMesh.positions[v];
        if (!rawU || !rawV) continue;

        pA.set(rawU[0], rawU[1], rawU[2]);
        pB.set(rawV[0], rawV[1], rawV[2]);

        localRay.distanceSqToSegment(pA, pB, undefined, segPoint);
        const dist = segPoint.distanceTo(localRay.closestPointToPoint(segPoint, new THREE.Vector3()));
        if (dist < 0.15 && dist < bestDist) {
          bestDist = dist;
          bestEdge = [u, v];
        }
      }

      return bestEdge;
    },
  };
}
