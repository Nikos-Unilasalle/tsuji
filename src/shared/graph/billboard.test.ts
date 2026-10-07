import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { faceCamera } from "./billboard";
import { OBJECT_TEXT_NODE } from "./nodes/object";

describe("faceCamera", () => {
  test("turns the mesh to the camera at draw time, keeping its place and size", () => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
    mesh.matrixAutoUpdate = false;
    mesh.matrix.compose(new THREE.Vector3(1, 2, 3), new THREE.Quaternion(), new THREE.Vector3(2, 2, 2));
    faceCamera(mesh);
    const camera = new THREE.PerspectiveCamera();
    // Placed by its matrix only, as the Camera node places the output camera: its quaternion stays stale.
    camera.matrixAutoUpdate = false;
    camera.matrixWorld.makeRotationFromEuler(new THREE.Euler(0, Math.PI / 2, 0));
    const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0));
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    // The output view draws clones: they keep the material and the flag, not the mesh's own callbacks.
    for (const drawn of [mesh, mesh.clone()]) {
      (drawn.material as THREE.Material).onBeforeRender({} as THREE.WebGLRenderer, new THREE.Scene(), camera, drawn.geometry, drawn, null as unknown as THREE.Group);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      drawn.matrixWorld.decompose(p, q, s);
      expect(p.toArray()).toEqual([1, 2, 3]);
      expect(s.x).toBeCloseTo(2, 9);
      expect(q.angleTo(expected)).toBeLessThan(1e-6);
    }
  });

  test("switching it off leaves the mesh as placed", () => {
    const mesh = new THREE.Mesh();
    faceCamera(mesh, true);
    faceCamera(mesh, false);
    const before = mesh.matrixWorld.clone();
    (mesh.material as THREE.Material).onBeforeRender({} as THREE.WebGLRenderer, new THREE.Scene(), new THREE.PerspectiveCamera(), mesh.geometry, mesh, null as unknown as THREE.Group);
    expect(mesh.matrixWorld.equals(before)).toBe(true);
  });
});

describe("Text glyph fallbacks", () => {
  test("a typographic minus missing from the font prints as a hyphen, not a question mark", () => {
    const ctx = { nodeId: "text-minus", time: 0, step: 0 };
    const width = (text: string, id: string) => {
      const mesh = OBJECT_TEXT_NODE.evaluate({ text }, { ...OBJECT_TEXT_NODE.defaultParams }, { ...ctx, nodeId: id }).geometry as THREE.Mesh;
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox!;
      return box.max.x - box.min.x;
    };
    expect(width("a − b", "t1")).toBeCloseTo(width("a - b", "t2"), 6);
  });
});
