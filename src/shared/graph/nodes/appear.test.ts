import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { APPEAR_NODE, appearPose, easeOutBack, localProgress } from "./appear";
import { EvalContext } from "../types";

const defaults = APPEAR_NODE.defaultParams;
let n = 0;
const ctx = (id = `ap-${n++}`): EvalContext => ({ time: 0, step: 0, nodeId: id });

function cube(x: number, material = new THREE.MeshStandardMaterial()): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material);
  m.position.set(x, 0, 0);
  m.updateMatrix();
  return m;
}

function merged(...xs: number[]): THREE.Group {
  const g = new THREE.Group();
  xs.forEach((x) => g.add(cube(x)));
  return g;
}

/** Scale factor and centre of a drawn item, read back off its matrix. */
function readPose(obj: THREE.Object3D): { scale: number; center: THREE.Vector3 } {
  const scale = new THREE.Vector3();
  const center = new THREE.Vector3();
  obj.matrix.decompose(center, new THREE.Quaternion(), scale);
  return { scale: scale.x, center };
}

describe("easing", () => {
  it("hits 0 and 1, and overshoots only when asked", () => {
    expect(easeOutBack(0, 1)).toBeCloseTo(0);
    expect(easeOutBack(1, 1)).toBeCloseTo(1);
    const peak = Math.max(...Array.from({ length: 101 }, (_, i) => easeOutBack(i / 100, 1)));
    expect(peak).toBeGreaterThan(1.05);
    const smooth = Math.max(...Array.from({ length: 101 }, (_, i) => easeOutBack(i / 100, 0)));
    expect(smooth).toBeLessThanOrEqual(1);
  });

  it("stagger keeps 0 hidden and 1 shown for every offset", () => {
    for (const offset of [0, 0.3, 1]) {
      expect(localProgress(0, offset, 0.8)).toBe(0);
      expect(localProgress(1, offset, 0.8)).toBe(1);
    }
    expect(localProgress(0.5, 0, 1)).toBe(1);
    expect(localProgress(0.5, 1, 1)).toBe(0);
  });

  it("lift starts below rest and settles", () => {
    expect(appearPose("pop", 0, 1, 0.3).dy).toBeCloseTo(-0.3);
    expect(appearPose("pop", 1, 1, 0.3).dy).toBeCloseTo(0);
    expect(appearPose("opacity", 0, 1, 0.3).dy).toBe(0);
  });
});

describe("APPEAR_NODE", () => {
  it("is empty without geometry", () => {
    const res = APPEAR_NODE.evaluate({}, defaults, ctx());
    expect((res.geometry as THREE.Group).children.length).toBe(0);
  });

  it("is a no-op at progress 1: same material, original pose", () => {
    const mat = new THREE.MeshStandardMaterial();
    const src = cube(3, mat);
    const out = APPEAR_NODE.evaluate({ geometry: src }, defaults, ctx()).geometry as THREE.Mesh;
    expect(out.material).toBe(mat);
    expect(out.visible).toBe(true);
    const { scale, center } = readPose(out);
    expect(scale).toBeCloseTo(1);
    expect(center.x).toBeCloseTo(3);
  });

  it("hides everything at progress 0, never touching the source", () => {
    const mat = new THREE.MeshStandardMaterial();
    const src = cube(0, mat);
    const out = APPEAR_NODE.evaluate({ geometry: src, progress: 0 }, defaults, ctx()).geometry as THREE.Mesh;
    expect(out.visible).toBe(false);
    expect(mat.opacity).toBe(1);
    expect(mat.transparent).toBe(false);
  });

  it("fades through a copy of the material and keeps the original opaque", () => {
    const mat = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const src = cube(0, mat);
    const params = { ...defaults, mode: "opacity" };
    const out = APPEAR_NODE.evaluate({ geometry: src, progress: 0.5 }, params, ctx()).geometry as THREE.Mesh;
    const faded = out.material as THREE.MeshStandardMaterial;
    expect(faded).not.toBe(mat);
    expect(faded.transparent).toBe(true);
    expect(faded.opacity).toBeGreaterThan(0);
    expect(faded.opacity).toBeLessThan(1);
    expect(faded.color.getHex()).toBe(0xff0000);
    expect(mat.opacity).toBe(1);
  });

  it("scales each item about its own centre", () => {
    const g = merged(-10, 10);
    const params = { ...defaults, mode: "pop", overshoot: 0, lift: 0 };
    const out = APPEAR_NODE.evaluate({ geometry: g, progress: 0.5 }, params, ctx()).geometry as THREE.Group;
    expect(out.children.length).toBe(2);
    const [a, b] = out.children.map(readPose);
    expect(a.scale).toBeGreaterThan(0);
    expect(a.scale).toBeLessThan(1);
    expect(a.scale).toBeCloseTo(b.scale);
    expect(a.center.x).toBeCloseTo(-10);
    expect(b.center.x).toBeCloseTo(10);
  });

  it("base pivot keeps the bottom of each item planted", () => {
    const g = merged(0);
    const params = { ...defaults, mode: "pop", overshoot: 0, lift: 0, pivot: "base" };
    const out = APPEAR_NODE.evaluate({ geometry: g, progress: 0.5 }, params, ctx()).geometry as THREE.Group;
    const mesh = out.children[0] as THREE.Mesh;
    const box = mesh.geometry.boundingBox ?? (mesh.geometry.computeBoundingBox(), mesh.geometry.boundingBox!);
    const bottom = new THREE.Vector3(0, box.min.y, 0).applyMatrix4(mesh.matrix);
    expect(bottom.y).toBeCloseTo(-1);
  });

  it("staggers: the first item is further along than the last", () => {
    const g = merged(0, 5, 10);
    const params = { ...defaults, mode: "pop", overshoot: 0, lift: 0, stagger: 1 };
    const out = APPEAR_NODE.evaluate({ geometry: g, progress: 0.5 }, params, ctx()).geometry as THREE.Group;
    const scales = out.children.map((c) => readPose(c).scale);
    expect(scales[0]).toBeGreaterThan(scales[1]);
    expect(scales[1]).toBeGreaterThan(scales[2]);
    expect(out.children[2].visible).toBe(false);
  });

  it("order reverse flips the sequence, x order follows position", () => {
    const g = merged(10, 0);
    const base = { ...defaults, mode: "pop", overshoot: 0, lift: 0, stagger: 1 };
    const byX = APPEAR_NODE.evaluate({ geometry: g, progress: 0.5 }, { ...base, order: "x" }, ctx()).geometry as THREE.Group;
    // x = 0 goes first even though it is the second child
    expect(readPose(byX.children[1]).scale).toBeGreaterThan(readPose(byX.children[0]).scale);
    const rev = APPEAR_NODE.evaluate({ geometry: g, progress: 0.5 }, { ...base, order: "reverse" }, ctx()).geometry as THREE.Group;
    expect(readPose(rev.children[1]).scale).toBeGreaterThan(readPose(rev.children[0]).scale);
  });

  it("keeps the same stand-in mesh across frames", () => {
    const src = cube(0);
    const id = "ap-stable";
    const a = APPEAR_NODE.evaluate({ geometry: src, progress: 0.4 }, defaults, ctx(id)).geometry;
    const b = APPEAR_NODE.evaluate({ geometry: src, progress: 0.6 }, defaults, ctx(id)).geometry;
    expect(b).toBe(a);
  });

  it("rides the posed wrapper of a merge", () => {
    const g = merged(0);
    g.position.set(0, 7, 0);
    g.updateMatrix();
    const out = APPEAR_NODE.evaluate({ geometry: g }, defaults, ctx()).geometry as THREE.Group;
    expect(out.matrix.elements[13]).toBeCloseTo(7);
  });
});
