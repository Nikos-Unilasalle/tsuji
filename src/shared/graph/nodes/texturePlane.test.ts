import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import { TEXTURE_PLANE_NODE } from "./texture";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "plane-shadeless-1" };
const meshOf = (out: Record<string, unknown>) => {
  let mesh: THREE.Mesh | null = null;
  (out.geometry as THREE.Object3D).traverse((o) => {
    if (o instanceof THREE.Mesh) mesh = o;
  });
  return mesh as unknown as THREE.Mesh;
};

describe("Texture to Plane shadeless", () => {
  it("swaps to an unlit material that keeps the texture, and back", () => {
    const tex = new THREE.Texture({ width: 2, height: 2 } as unknown as HTMLImageElement);
    const params = { ...TEXTURE_PLANE_NODE.defaultParams };
    const lit = meshOf(TEXTURE_PLANE_NODE.evaluate({ texture: tex }, params, CTX));
    expect(lit.material).toBeInstanceOf(THREE.MeshStandardMaterial);

    const unlit = meshOf(TEXTURE_PLANE_NODE.evaluate({ texture: tex }, { ...params, shadeless: true }, CTX));
    expect(unlit.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect((unlit.material as THREE.MeshBasicMaterial).map).toBe(tex);
    expect(unlit.castShadow).toBe(false);

    const back = meshOf(TEXTURE_PLANE_NODE.evaluate({ texture: tex }, { ...params, shadeless: false }, CTX));
    expect(back.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect((back.material as THREE.MeshStandardMaterial).map).toBe(tex);
  });
});

describe("Texture to Plane aspect ratio", () => {
  it("stretches after the pose, so Location is not scaled and the gizmo can take the stretch back out", () => {
    const wide = new THREE.Texture({ width: 400, height: 100 } as unknown as HTMLImageElement);
    const params = { ...TEXTURE_PLANE_NODE.defaultParams, location: new THREE.Vector3(2, 0, 0), rotation: new THREE.Vector3(0, 0, 0) };
    const mesh = meshOf(TEXTURE_PLANE_NODE.evaluate({ texture: wide }, params, { ...CTX, nodeId: "plane-aspect-1" }));
    const pos = new THREE.Vector3().setFromMatrixPosition(mesh.matrix);
    expect(pos.x).toBeCloseTo(2);
    const scl = new THREE.Vector3();
    mesh.matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scl);
    expect(scl.x).toBeCloseTo(4);
    expect(mesh.matrix.clone().multiply((mesh.userData.poseOffset as THREE.Matrix4).clone().invert()).elements[0]).toBeCloseTo(1);
  });
});
