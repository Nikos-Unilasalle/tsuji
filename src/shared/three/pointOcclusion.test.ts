import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { computePointVisibility } from "./pointOcclusion";

const W = 64;
const H = 64;

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

/** A depth readback with `surface` everywhere inside the given pixel box (GL rows, bottom up), 0 (no surface) elsewhere. */
function depthBuffer(surface: number, box = { x0: 0, y0: 0, x1: W, y1: H }): Float32Array {
  const depth = new Float32Array(W * H * 4);
  for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) depth[(y * W + x) * 4] = surface;
  return depth;
}

function run(points: THREE.Vector3[], depth: Float32Array, space = new THREE.Matrix4()): number[] {
  const cam = camera();
  const positions = new Float32Array(points.flatMap((p) => [p.x, p.y, p.z]));
  const modelView = new THREE.Matrix4().multiplyMatrices(cam.matrixWorldInverse, space);
  const mvp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, modelView);
  const out = new Uint8Array(points.length);
  computePointVisibility(positions, points.length, modelView, mvp, depth, W, H, out);
  return Array.from(out);
}

describe("computePointVisibility", () => {
  it("hides a point behind the surface and keeps one on it", () => {
    // Surface 10 units from the camera, i.e. the z = 0 plane.
    const depth = depthBuffer(10);
    expect(run([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -2)], depth)).toEqual([1, 0]);
  });

  it("keeps a point in front of the surface", () => {
    expect(run([new THREE.Vector3(0, 0, 3)], depthBuffer(10))).toEqual([1]);
  });

  it("tolerates a vertex a hair behind its own rasterised faces", () => {
    // 0.2% further than the surface: within DEPTH_TOLERANCE, still on it.
    expect(run([new THREE.Vector3(0, 0, -0.02)], depthBuffer(10))).toEqual([1]);
  });

  it("counts a point next to the silhouette as seen", () => {
    // Surface only on the left half; a far point sitting on its edge has background beside it.
    const depth = depthBuffer(10, { x0: 0, y0: 0, x1: W / 2, y1: H });
    expect(run([new THREE.Vector3(0, 0, -2)], depth)).toEqual([1]);
    // Well inside the surface, the same depth is hidden.
    expect(run([new THREE.Vector3(-2, 0, -2)], depth)).toEqual([0]);
  });

  it("follows the cloud's space matrix", () => {
    // The point is at local z = 0 but placed 2 units back.
    const space = new THREE.Matrix4().makeTranslation(0, 0, -2);
    expect(run([new THREE.Vector3(0, 0, 0)], depthBuffer(10), space)).toEqual([0]);
  });

  it("treats off-screen and behind-camera points as seen (the picks skip them anyway)", () => {
    expect(run([new THREE.Vector3(100, 0, 0), new THREE.Vector3(0, 0, 20)], depthBuffer(10))).toEqual([1, 1]);
  });
});
