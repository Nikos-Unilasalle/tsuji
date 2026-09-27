import { describe, it, expect, beforeAll, vi } from "vitest";
import * as THREE from "three";
import { createEditMeshHandles } from "./editMeshHandles";
import { initBvhRaycast } from "./bvh";
import { createQuadBox, cloneQuadMesh } from "../graph/quadMesh";

const W = 800;
const H = 600;

/** A camera looking straight down -Z at the origin from `distance`. */
function frontCamera(distance: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, W / H, distance * 0.01, distance * 10);
  camera.position.set(0, 0, distance);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

function toNdc(world: THREE.Vector3, camera: THREE.Camera): THREE.Vector2 {
  const p = world.clone().project(camera);
  return new THREE.Vector2(p.x, p.y);
}

describe("editMeshHandles picking", () => {
  beforeAll(() => initBvhRaycast());

  const box = createQuadBox(1, 1, 1); // front face (+Z) = vertices 4,5,6,7
  const identity = new THREE.Matrix4();

  it("won't pick a vertex hidden behind the mesh, unless x-ray is on", () => {
    const handles = createEditMeshHandles();
    const camera = frontCamera(5);
    // Vertex 2 (0.5, 0.5, -0.5): the back corner, seen through the front face.
    const ndc = toNdc(new THREE.Vector3(0.5, 0.5, -0.5), camera);
    expect(handles.pickPoint(ndc, camera, W, H, box, identity)).toBeNull();
    handles.setXray(true);
    expect(handles.pickPoint(ndc, camera, W, H, box, identity)).toBe(2);
  });

  it("box-selects only visible vertices and faces", () => {
    const handles = createEditMeshHandles();
    const camera = frontCamera(5);
    expect(handles.pickPointsInRect(0, 0, W, H, W, H, camera, box, identity).sort()).toEqual([4, 5, 6, 7]);
    expect(handles.pickFacesInRect(0, 0, W, H, W, H, camera, box, identity)).toEqual([0]);

    handles.setXray(true);
    expect(handles.pickPointsInRect(0, 0, W, H, W, H, camera, box, identity)).toHaveLength(8);
    expect(handles.pickFacesInRect(0, 0, W, H, W, H, camera, box, identity)).toHaveLength(6);
  });

  it("picks edges in screen pixels, whatever the object's size", () => {
    // Front top edge 6–7, clicked a few pixels off its midpoint. The old
    // world-space threshold (0.15 units) missed entirely on a 100-unit box.
    for (const size of [0.01, 1, 100]) {
      const handles = createEditMeshHandles();
      const camera = frontCamera(5 * size);
      const scaled = cloneQuadMesh(box);
      scaled.positions = scaled.positions.map(([x, y, z]) => [x * size, y * size, z * size]);
      const ndc = toNdc(new THREE.Vector3(0, 0.5 * size, 0.5 * size), camera);
      ndc.y -= 4 / (H / 2); // 4 px below the edge
      const edge = handles.pickEdge(ndc, camera, W, H, scaled, identity);
      expect(edge && [...edge].sort()).toEqual([6, 7]);
    }
  });

  it("uses the object's world matrix for occlusion", () => {
    const handles = createEditMeshHandles();
    const camera = frontCamera(5);
    // Turned half a revolution: vertex 2 now faces the camera.
    const turned = new THREE.Matrix4().makeRotationY(Math.PI);
    const ndc = toNdc(new THREE.Vector3(0.5, 0.5, -0.5).applyMatrix4(turned), camera);
    expect(handles.pickPoint(ndc, camera, W, H, box, turned)).toBe(2);
  });
});

describe("editMeshHandles overlays", () => {
  it("rebuilds an overlay only when what it draws changed", () => {
    const handles = createEditMeshHandles();
    const host = new THREE.Mesh();
    const mesh = createQuadBox(1, 1, 1);
    const [wire, faces] = handles.group.children as THREE.Mesh[];

    handles.sync(host, mesh, "faces", new Set(), new Set([0]), null, null);
    const wireGeometry = wire.geometry;
    const faceGeometry = faces.geometry;
    expect(wire.visible).toBe(true);
    expect(faces.visible).toBe(true);

    // Same content, fresh clone (a live, unfrozen mesh): nothing rebuilt.
    handles.sync(host, cloneQuadMesh(mesh), "faces", new Set(), new Set([0]), null, null);
    expect(wire.geometry).toBe(wireGeometry);
    expect(faces.geometry).toBe(faceGeometry);

    // Selection changed: the face overlay is rebuilt, the wireframe isn't.
    handles.sync(host, mesh, "faces", new Set(), new Set([1]), null, null);
    expect(wire.geometry).toBe(wireGeometry);
    expect(faces.geometry).not.toBe(faceGeometry);

    handles.clear();
    expect(handles.group.children.every((c) => !c.visible)).toBe(true);
  });
});

describe("editMeshHandles point handles", () => {
  it("hide behind the geometry outside X-ray, and show through it in X-ray", () => {
    // The circle sprites are drawn on a 2D canvas; node has none.
    const ctx = new Proxy({}, { get: () => () => undefined });
    vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) });
    try {
      const handles = createEditMeshHandles();
      const host = new THREE.Mesh();
      const mesh = createQuadBox(1, 1, 1);
      const points = handles.group.children.filter((c): c is THREE.Points => c instanceof THREE.Points);

      handles.sync(host, mesh, "points", new Set([0]), new Set(), null, null);
      const [unselected, selected] = points.map((p) => p.material as THREE.PointsMaterial);
      expect(unselected.depthTest).toBe(true);
      expect(selected.depthTest).toBe(true);
      expect(unselected.depthWrite).toBe(false);
      expect(unselected.size).toBeLessThan(9);
      expect(selected.size).toBeGreaterThan(unselected.size);

      handles.setXray(true);
      handles.sync(host, mesh, "points", new Set([0]), new Set(), null, null);
      expect(unselected.depthTest).toBe(false);
      expect(selected.depthTest).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
