import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { boneRotations, buildBones, poseBones, SkinWeights, skinVertices } from "./skinning";
import { poseDualQuats, skinVerticesDualQuat } from "./dualQuat";

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
// A chain along +y: root, elbow, hand.
const parents = [-1, 0, 1];
const rest = [v(0, 0, 0), v(0, 1, 0), v(0, 2, 0)];
const bones = buildBones(parents, rest);

/** A tube round the chain, every vertex blended between the two arm bones by height. */
function tube(rings = 21, around = 16, radius = 0.2) {
  const positions: number[] = [];
  const indices: number[] = [];
  const weights: number[] = [];
  for (let r = 0; r < rings; r++) {
    const y = (2 * r) / (rings - 1);
    // Soft blend across the elbow, as automatic weights give.
    const t = Math.max(0, Math.min(1, (y - 0.6) / 0.8));
    for (let a = 0; a < around; a++) {
      const th = (2 * Math.PI * a) / around;
      positions.push(radius * Math.cos(th), y, radius * Math.sin(th));
      indices.push(1, 2);
      weights.push(1 - t, t);
    }
  }
  const skin: SkinWeights = { influences: 2, indices: Uint16Array.from(indices), weights: Float32Array.from(weights) };
  return { positions: Float32Array.from(positions), skin, rings, around };
}

const linear = (pose: THREE.Vector3[], base: Float32Array, skin: SkinWeights, frame = new THREE.Matrix4(), stretch = false) => {
  const out = new Float32Array(base.length);
  skinVertices(out, base, skin, poseBones(bones, pose, frame, { stretch, amount: 1 }).pos);
  return out;
};
const dual = (pose: THREE.Vector3[], base: Float32Array, skin: SkinWeights, frame = new THREE.Matrix4(), stretch = false, amount = 1) => {
  const out = new Float32Array(base.length);
  skinVerticesDualQuat(out, base, skin, poseDualQuats(bones, pose, { stretch, amount }, boneRotations(bones, pose)), frame);
  return out;
};

describe("dual quaternion skinning", () => {
  it("leaves the mesh as it is at rest", () => {
    const { positions, skin } = tube();
    dual(rest, positions, skin).forEach((x, i) => expect(x).toBeCloseTo(positions[i], 5));
  });

  it("moves a vertex on one bone exactly as linear skinning does", () => {
    const base = Float32Array.of(0.2, 0.5, 0, 0, 1.5, 0.3);
    const skin: SkinWeights = { influences: 1, indices: Uint16Array.of(1, 2), weights: Float32Array.of(1, 1) };
    const pose = [v(0.3, 0.1, 0), v(1.1, 0.6, 0.2), v(1.4, 1.5, -0.4)];
    const a = linear(pose, base, skin);
    const b = dual(pose, base, skin);
    b.forEach((x, i) => expect(x).toBeCloseTo(a[i], 5));
  });

  it("keeps the elbow's thickness where linear skinning pinches it", () => {
    const { positions, skin, rings, around } = tube();
    // Forearm folded 120° forward.
    const angle = (120 * Math.PI) / 180;
    const pose = [rest[0], rest[1], v(0, 1 + Math.cos(angle), Math.sin(angle))];
    const middle = Math.floor(rings / 2);
    const thickness = (out: Float32Array) => {
      // Mean distance of the middle ring's vertices from their centre.
      let cx = 0, cy = 0, cz = 0;
      for (let a = 0; a < around; a++) {
        const o = (middle * around + a) * 3;
        cx += out[o]; cy += out[o + 1]; cz += out[o + 2];
      }
      cx /= around; cy /= around; cz /= around;
      let r = 0;
      for (let a = 0; a < around; a++) {
        const o = (middle * around + a) * 3;
        r += Math.hypot(out[o] - cx, out[o + 1] - cy, out[o + 2] - cz);
      }
      return r / around;
    };
    const lbs = thickness(linear(pose, positions, skin));
    const dqs = thickness(dual(pose, positions, skin));
    expect(lbs).toBeLessThan(0.16);
    expect(dqs).toBeGreaterThan(0.19);
  });

  it("stretches a bone along its length with Stretch Bones", () => {
    const base = Float32Array.of(0, 2, 0);
    const skin: SkinWeights = { influences: 1, indices: Uint16Array.of(2), weights: Float32Array.of(1) };
    const pose = [rest[0], rest[1], v(0, 2.5, 0)];
    const out = dual(pose, base, skin, undefined, true);
    expect(Array.from(out)).toEqual([0, 2.5, 0].map((x) => expect.closeTo(x, 5)));
    expect(dual(pose, base, skin, undefined, false)[1]).toBeCloseTo(2, 5);
  });

  it("works on a mesh placed in the rig's space by its own matrix, like linear skinning", () => {
    const frame = new THREE.Matrix4().compose(v(0.5, -0.2, 0.1), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.6, -0.2)), v(1.5, 1.5, 1.5));
    const toLocal = frame.clone().invert();
    const world = [v(0.2, 0.5, 0), v(0, 1.5, 0.3)];
    const base = Float32Array.from(world.flatMap((p) => p.clone().applyMatrix4(toLocal).toArray()));
    const skin: SkinWeights = { influences: 1, indices: Uint16Array.of(1, 2), weights: Float32Array.of(1, 1) };
    const pose = [v(0, 0, 0), v(0.4, 0.9, 0), v(1.2, 1.3, 0.3)];
    const a = linear(pose, base, skin, frame);
    const b = dual(pose, base, skin, frame);
    b.forEach((x, i) => expect(x).toBeCloseTo(a[i], 4));
  });

  it("goes from rest to the pose with Amount, without shrinking on the way", () => {
    const base = Float32Array.of(0.2, 1.5, 0);
    const skin: SkinWeights = { influences: 1, indices: Uint16Array.of(2), weights: Float32Array.of(1) };
    const pose = [rest[0], rest[1], v(1, 1, 0)];
    const half = dual(pose, base, skin, undefined, false, 0.5);
    // Halfway through a 90° turn about the elbow, still 0.5 along the bone and 0.2 off it.
    const d = Math.hypot(half[0], half[1] - 1, half[2]);
    expect(d).toBeCloseTo(Math.hypot(0.2, 0.5), 5);
  });
});
