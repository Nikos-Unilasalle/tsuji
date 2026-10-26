import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ShadowUpdateTracker } from "./shadowUpdateTracker";

const renderer = {
  shadowMap: { type: THREE.PCFShadowMap },
  localClippingEnabled: false,
  clippingPlanes: [],
} as unknown as Pick<THREE.WebGLRenderer, "shadowMap" | "localClippingEnabled" | "clippingPlanes">;

function setup() {
  const scene = new THREE.Scene();
  const light = new THREE.PointLight();
  light.castShadow = true;
  light.position.set(0, 3, 0);
  scene.add(light);
  const mesh = new THREE.Mesh<THREE.BufferGeometry>(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.castShadow = true;
  scene.add(mesh);
  const tracker = new ShadowUpdateTracker();
  return { scene, light, mesh, tracker };
}

describe("ShadowUpdateTracker", () => {
  it("updates on the first frame, then only when something changes", () => {
    const { scene, tracker } = setup();
    expect(tracker.check(scene, renderer)).toBe(true);
    expect(tracker.check(scene, renderer)).toBe(false);
    expect(tracker.check(scene, renderer)).toBe(false);
  });

  it("updates when a caster or a light moves", () => {
    const { scene, light, mesh, tracker } = setup();
    tracker.check(scene, renderer);
    mesh.position.x = 1;
    expect(tracker.check(scene, renderer)).toBe(true);
    expect(tracker.check(scene, renderer)).toBe(false);
    light.position.y = 4;
    expect(tracker.check(scene, renderer)).toBe(true);
  });

  it("updates when geometry is edited in place or swapped", () => {
    const { scene, mesh, tracker } = setup();
    tracker.check(scene, renderer);
    mesh.geometry.attributes.position.needsUpdate = true;
    expect(tracker.check(scene, renderer)).toBe(true);
    mesh.geometry = new THREE.SphereGeometry();
    expect(tracker.check(scene, renderer)).toBe(true);
    expect(tracker.check(scene, renderer)).toBe(false);
  });

  it("updates when a caster appears, hides or stops casting", () => {
    const { scene, mesh, tracker } = setup();
    tracker.check(scene, renderer);
    const other = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    other.castShadow = true;
    scene.add(other);
    expect(tracker.check(scene, renderer)).toBe(true);
    mesh.visible = false;
    expect(tracker.check(scene, renderer)).toBe(true);
    other.castShadow = false;
    expect(tracker.check(scene, renderer)).toBe(true);
  });

  it("ignores objects that don't cast and lights that don't shadow", () => {
    const { scene, tracker } = setup();
    const receiver = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial());
    const fill = new THREE.DirectionalLight();
    scene.add(receiver, fill);
    tracker.check(scene, renderer);
    receiver.rotation.x = 1;
    fill.position.x = 5;
    expect(tracker.check(scene, renderer)).toBe(false);
  });

  it("follows skinning bones and instance matrices", () => {
    const { scene, tracker } = setup();
    const bone = new THREE.Bone();
    const skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    skinned.castShadow = true;
    skinned.add(bone);
    skinned.bind(new THREE.Skeleton([bone]));
    const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), 2);
    instanced.castShadow = true;
    scene.add(skinned, instanced);
    tracker.check(scene, renderer);
    bone.rotation.z = 0.5;
    expect(tracker.check(scene, renderer)).toBe(true);
    expect(tracker.check(scene, renderer)).toBe(false);
    instanced.setMatrixAt(0, new THREE.Matrix4().makeTranslation(1, 0, 0));
    instanced.instanceMatrix.needsUpdate = true;
    expect(tracker.check(scene, renderer)).toBe(true);
  });

  it("always updates with a custom depth material, whose uniforms may animate", () => {
    const { scene, mesh, tracker } = setup();
    mesh.customDepthMaterial = new THREE.MeshDepthMaterial();
    expect(tracker.check(scene, renderer)).toBe(true);
    expect(tracker.check(scene, renderer)).toBe(true);
    mesh.customDepthMaterial = undefined;
    expect(tracker.check(scene, renderer)).toBe(true);
    expect(tracker.check(scene, renderer)).toBe(false);
  });
});
