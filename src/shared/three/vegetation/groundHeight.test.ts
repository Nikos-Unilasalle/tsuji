import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { bakeGroundHeight, groundSignature } from "./groundHeight";
import { initBvhRaycast } from "../bvh";

/** A flat plate lying at `y`, `size` across. */
function plate(y: number, size = 10): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(size, size);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.position.y = y;
  mesh.updateMatrix();
  return mesh;
}

function heightAt(field: NonNullable<ReturnType<typeof bakeGroundHeight>>, x: number, z: number) {
  const width = field.texture.image.width;
  const data = field.texture.image.data as Float32Array;
  const u = (x - field.center.x) / field.size.x + 0.5;
  const v = (z - field.center.y) / field.size.y + 0.5;
  const i = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
  const j = Math.min(width - 1, Math.max(0, Math.floor(v * width)));
  const k = (j * width + i) * 4;
  return { height: data[k], hit: data[k + 1] };
}

describe("bakeGroundHeight", () => {
  beforeAll(() => {
    initBvhRaycast();
  });

  it("reads the height of a flat plate", () => {
    const field = bakeGroundHeight(plate(2.5), 16)!;

    expect(field).not.toBeNull();
    expect(field.size.x).toBeCloseTo(10, 3);
    expect(field.size.y).toBeCloseTo(10, 3);
    expect(field.center.x).toBeCloseTo(0, 3);

    const middle = heightAt(field, 0, 0);
    expect(middle.hit).toBe(1);
    expect(middle.height).toBeCloseTo(2.5, 3);
  });

  it("follows a slope rather than averaging it", () => {
    const mesh = plate(0, 10);
    mesh.rotation.z = 0.3;
    mesh.updateMatrix();

    const field = bakeGroundHeight(mesh, 32)!;
    const low = heightAt(field, -4, 0).height;
    const high = heightAt(field, 4, 0).height;

    expect(high).toBeGreaterThan(low + 1);
  });

  it("takes the highest surface when two overlap", () => {
    const group = new THREE.Group();
    group.add(plate(0));
    group.add(plate(3, 4));
    group.updateMatrix();

    const field = bakeGroundHeight(group, 32)!;

    // Over the small upper plate, and out beyond it on the lower one.
    expect(heightAt(field, 0, 0).height).toBeCloseTo(3, 3);
    expect(heightAt(field, 4.5, 0).height).toBeCloseTo(0, 3);
  });

  it("marks texels with no ground under them as misses", () => {
    const group = new THREE.Group();
    // Two plates apart on X: the middle of the bounding box has nothing under it.
    const left = plate(0, 4);
    left.position.set(-8, 0, 0);
    left.updateMatrix();
    const right = plate(0, 4);
    right.position.set(8, 0, 0);
    right.updateMatrix();
    group.add(left, right);

    const field = bakeGroundHeight(group, 32)!;

    expect(heightAt(field, -8, 0).hit).toBe(1);
    expect(heightAt(field, 8, 0).hit).toBe(1);
    expect(heightAt(field, 0, 0).hit).toBe(0);
  });

  it("returns null when there is nothing to sample", () => {
    expect(bakeGroundHeight(new THREE.Group(), 16)).toBeNull();
  });

  it("changes its signature when the mesh moves, and not otherwise", () => {
    const mesh = plate(1);
    const before = groundSignature(mesh, 64);

    expect(groundSignature(mesh, 64)).toBe(before);
    expect(groundSignature(mesh, 128)).not.toBe(before);

    mesh.position.x = 3;
    mesh.updateMatrix();
    expect(groundSignature(mesh, 64)).not.toBe(before);
  });

  it("reuses the previous texture when the resolution is unchanged", () => {
    const mesh = plate(1);
    const first = bakeGroundHeight(mesh, 16)!;
    mesh.position.y = 4;
    mesh.updateMatrix();
    const second = bakeGroundHeight(mesh, 16, first)!;

    expect(second.texture).toBe(first.texture);
    expect(heightAt(second, 0, 0).height).toBeCloseTo(4, 3);
  });
});
