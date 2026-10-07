import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { AXES_NODE } from "./axes";
import { EvalContext } from "../types";
import { formatTick, niceStep, spaceMatrix, ticks } from "../mathSpace";

const ctx = (nodeId: string): EvalContext => ({ nodeId, time: 0, step: 0 });
const params = (o: Record<string, unknown> = {}) => ({ ...(AXES_NODE.defaultParams as Record<string, unknown>), ...o });

describe("math space", () => {
  test("round tick steps", () => {
    expect(niceStep(10)).toBe(1);
    expect(niceStep(7.8)).toBe(1);
    expect(niceStep(100)).toBe(10);
    expect(niceStep(3)).toBe(0.2);
    expect(niceStep(40)).toBe(5);
  });

  test("ticks land on clean multiples", () => {
    expect(ticks(-1, 1, 0.1)).toContain(0.3);
    expect(ticks(-1, 1, 0.1)).toHaveLength(21);
    expect(ticks(0.5, 3.2, 1)).toEqual([1, 2, 3]);
  });

  test("tick labels as in a textbook", () => {
    expect(formatTick(-2)).toBe("−2");
    expect(formatTick(0.5)).toBe("0.5");
    expect(formatTick(Math.PI, true)).toBe("π");
    expect(formatTick(-Math.PI / 2, true)).toBe("−π/2");
    expect(formatTick((3 * Math.PI) / 2, true)).toBe("3π/2");
  });

  test("2D maps math straight onto the screen plane, scaled and placed", () => {
    const pose = new THREE.Matrix4().makeTranslation(5, 0, 0);
    const p = new THREE.Vector3(1, 2, 0).applyMatrix4(spaceMatrix(pose, "2D", new THREE.Vector3(2, 1, 1)));
    expect(p.toArray()).toEqual([7, 2, 0]);
  });

  test("3D puts math z up and keeps the frame right-handed", () => {
    const space = spaceMatrix(new THREE.Matrix4(), "3D", new THREE.Vector3(1, 1, 1));
    expect(new THREE.Vector3(0, 0, 1).applyMatrix4(space).toArray().map((v) => v + 0)).toEqual([0, 1, 0]);
    const x = new THREE.Vector3(1, 0, 0).applyMatrix4(space);
    const y = new THREE.Vector3(0, 1, 0).applyMatrix4(space);
    expect(new THREE.Vector3().crossVectors(x, y).toArray().map((v) => Math.round(v) + 0)).toEqual([0, 1, 0]);
  });
});

describe("AXES_NODE", () => {
  test("draws axes, grid and labels, and hands on its space", () => {
    const out = AXES_NODE.evaluate({}, params({ location: new THREE.Vector3(1, 0, 0) }), ctx("axes-a"));
    const root = out.geometry as THREE.Group;
    expect(root.children.length).toBeGreaterThan(3);
    const p = new THREE.Vector3(2, 1, 0).applyMatrix4(out.space as THREE.Matrix4);
    expect(p.toArray()).toEqual([3, 1, 0]);
  });

  test("unchanged settings keep the same drawing", () => {
    const a = AXES_NODE.evaluate({}, params(), ctx("axes-b")).geometry as THREE.Group;
    const geometry = (a.children[0] as THREE.Mesh).geometry;
    const b = AXES_NODE.evaluate({}, params(), ctx("axes-b")).geometry as THREE.Group;
    expect(b).toBe(a);
    expect((b.children[0] as THREE.Mesh).geometry).toBe(geometry);
  });

  test("3D adds the z axis and its arrow", () => {
    const flat = AXES_NODE.evaluate({}, params({ labels: false, names: "" }), ctx("axes-2d")).geometry as THREE.Group;
    const deep = AXES_NODE.evaluate({}, params({ dimension: "3D", labels: false, names: "" }), ctx("axes-3d")).geometry as THREE.Group;
    const arrowCount = (g: THREE.Group) => ((g.children[2] as THREE.Mesh).geometry.getAttribute("position").count);
    expect(arrowCount(deep)).toBeGreaterThan(arrowCount(flat));
  });
});
