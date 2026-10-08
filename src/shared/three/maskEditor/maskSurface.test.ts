import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  findMaskSurfaces,
  frameAspect,
  pixelsPerUv,
  screenToUv,
  uvFrameOf,
  uvToScreen,
  uvToWorld,
  worldToUv,
} from "./maskSurface";

/** A plane the way Texture to Plane builds it: 1×1, scaled to its aspect, then posed. */
function plane(aspect: number, matrix = new THREE.Matrix4()): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(matrix).multiply(new THREE.Matrix4().makeScale(aspect, 1, 1));
  return mesh;
}

const cameraFacing = (z = 3) => {
  const camera = new THREE.PerspectiveCamera(50, 1.5, 0.1, 100);
  camera.position.set(0, 0, z);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
};

describe("uvFrameOf", () => {
  it("maps UV (0,0)…(1,1) onto a unit plane's corners", () => {
    const frame = uvFrameOf(plane(1))!;
    expect(uvToWorld(frame, 0, 0).toArray()).toEqual([-0.5, -0.5, 0].map((x) => expect.closeTo(x, 5)));
    expect(uvToWorld(frame, 1, 1).x).toBeCloseTo(0.5, 5);
    expect(uvToWorld(frame, 1, 1).y).toBeCloseTo(0.5, 5);
    expect(uvToWorld(frame, 0.5, 0.5).length()).toBeCloseTo(0, 5);
  });

  it("follows the plane's scale, rotation and position", () => {
    const pose = new THREE.Matrix4().compose(
      new THREE.Vector3(2, 1, -1),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)),
      new THREE.Vector3(1, 1, 1),
    );
    const frame = uvFrameOf(plane(2, pose))!;
    // Laid flat: v runs along world -z … and the centre is where the pose put it.
    const centre = uvToWorld(frame, 0.5, 0.5);
    expect(centre.x).toBeCloseTo(2, 5);
    expect(centre.y).toBeCloseTo(1, 5);
    expect(centre.z).toBeCloseTo(-1, 5);
    expect(frame.u.length()).toBeCloseTo(2, 5);
    expect(frame.v.length()).toBeCloseTo(1, 5);
    expect(Math.abs(frame.normal.y)).toBeCloseTo(1, 5);
  });

  it("reports the world aspect of the square", () => {
    expect(frameAspect(uvFrameOf(plane(16 / 9))!)).toBeCloseTo(16 / 9, 5);
  });

  it("round-trips world ↔ UV, including outside the square", () => {
    const frame = uvFrameOf(plane(1.5, new THREE.Matrix4().makeRotationZ(0.4)))!;
    for (const [u, v] of [[0.2, 0.7], [-0.3, 1.4], [1, 0]]) {
      const back = worldToUv(frame, uvToWorld(frame, u, v));
      expect(back.x).toBeCloseTo(u, 5);
      expect(back.y).toBeCloseTo(v, 5);
    }
  });

  it("a mesh without UVs has no frame", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
    expect(uvFrameOf(new THREE.Mesh(geometry))).toBeNull();
  });
});

describe("screen ↔ UV", () => {
  const rect = { width: 900, height: 600 };

  it("the middle of the screen is the middle of a plane facing the camera", () => {
    const frame = uvFrameOf(plane(1))!;
    const uv = screenToUv(frame, cameraFacing(), rect, 450, 300)!;
    expect(uv.x).toBeCloseTo(0.5, 4);
    expect(uv.y).toBeCloseTo(0.5, 4);
  });

  it("projecting a UV and picking it back returns the same UV", () => {
    const pose = new THREE.Matrix4().compose(
      new THREE.Vector3(0.3, -0.2, 0),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -0.5, 0.1)),
      new THREE.Vector3(1, 1, 1),
    );
    const frame = uvFrameOf(plane(1.77, pose))!;
    const camera = cameraFacing(4);
    for (const [u, v] of [[0.1, 0.1], [0.8, 0.3], [0.5, 0.95], [1.2, -0.1]]) {
      const s = uvToScreen(frame, camera, rect, u, v)!;
      const back = screenToUv(frame, camera, rect, s.x, s.y)!;
      expect(back.x).toBeCloseTo(u, 4);
      expect(back.y).toBeCloseTo(v, 4);
    }
  });

  it("works through an orthographic camera too", () => {
    const frame = uvFrameOf(plane(1))!;
    const camera = new THREE.OrthographicCamera(-1.5, 1.5, 1, -1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    const s = uvToScreen(frame, camera, rect, 0.75, 0.25)!;
    const back = screenToUv(frame, camera, rect, s.x, s.y)!;
    expect(back.x).toBeCloseTo(0.75, 4);
    expect(back.y).toBeCloseTo(0.25, 4);
  });

  it("v is up on screen: the top of the picture is v = 1", () => {
    const frame = uvFrameOf(plane(1))!;
    const camera = cameraFacing();
    const top = uvToScreen(frame, camera, rect, 0.5, 1)!;
    const bottom = uvToScreen(frame, camera, rect, 0.5, 0)!;
    expect(top.y).toBeLessThan(bottom.y);
  });

  it("a point behind the camera is not on screen, and a ray parallel to the plane never lands", () => {
    const frame = uvFrameOf(plane(1))!;
    const away = new THREE.PerspectiveCamera(50, 1.5, 0.1, 100);
    away.position.set(0, 0, 3);
    away.lookAt(0, 0, 10);
    away.updateMatrixWorld(true);
    away.updateProjectionMatrix();
    expect(uvToScreen(frame, away, rect, 0.5, 0.5)).toBeNull();
    const edgeOn = new THREE.PerspectiveCamera(50, 1.5, 0.1, 100);
    edgeOn.position.set(0, 0, 0);
    edgeOn.lookAt(0, 1, 0);
    edgeOn.updateMatrixWorld(true);
    expect(screenToUv(frame, edgeOn, rect, 450, 300)).toBeNull();
  });

  it("pixelsPerUv is the size of the picture on screen", () => {
    const frame = uvFrameOf(plane(1))!;
    const { x, y } = pixelsPerUv(frame, cameraFacing(), rect);
    expect(x).toBeGreaterThan(100);
    expect(x).toBeCloseTo(y, 1);
  });
});

describe("findMaskSurfaces", () => {
  const results = (entries: Record<string, unknown>) =>
    new Map(Object.entries(entries).map(([id, geometry]) => [id, { geometry } as Record<string, unknown>]));
  const wire = (from: string, to: string) => ({ id: `${from}-${to}`, fromNode: from, fromSocket: "x", toNode: to, toSocket: "y" });

  it("follows the wire to the plane it feeds", () => {
    const mesh = plane(1);
    const found = findMaskSurfaces({ connections: [wire("mask", "plane")] }, results({ plane: mesh }), "mask");
    expect(found?.nodeId).toBe("plane");
    expect(found?.meshes).toEqual([mesh]);
  });

  it("goes through nodes that make no geometry of their own", () => {
    const mesh = plane(1);
    const found = findMaskSurfaces(
      { connections: [wire("mask", "blur"), wire("blur", "apply"), wire("apply", "plane")] },
      results({ plane: mesh }),
      "mask",
    );
    expect(found?.nodeId).toBe("plane");
  });

  it("the nearest surface wins", () => {
    const near = plane(1);
    const far = plane(2);
    const found = findMaskSurfaces(
      { connections: [wire("mask", "near"), wire("mask", "mid"), wire("mid", "far")] },
      results({ near, far }),
      "mask",
    );
    expect(found?.nodeId).toBe("near");
  });

  it("finds meshes inside a group, ignores instanced and UV-less ones, and survives a cycle", () => {
    const group = new THREE.Group();
    const mesh = plane(1);
    group.add(mesh);
    group.add(new THREE.InstancedMesh(new THREE.PlaneGeometry(), undefined, 1));
    const bare = new THREE.Mesh(new THREE.BufferGeometry());
    group.add(bare);
    const found = findMaskSurfaces(
      { connections: [wire("mask", "a"), wire("a", "mask"), wire("a", "group")] },
      results({ group }),
      "mask",
    );
    expect(found?.meshes).toEqual([mesh]);
  });

  it("nothing downstream, or no results yet, is no surface", () => {
    expect(findMaskSurfaces({ connections: [] }, results({}), "mask")).toBeNull();
    expect(findMaskSurfaces({ connections: [wire("mask", "x")] }, null, "mask")).toBeNull();
  });
});
