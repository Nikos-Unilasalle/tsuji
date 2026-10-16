import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { skeletonOp } from "./skeletonEditor";
import { readSkeleton } from "../graph/ik/skeletonEdit";

const v = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z);
const node = (extra: Record<string, unknown> = {}) => ({
  pointsList: [v(0, 0), v(0, 1), v(0, 2)],
  parents: [-1, 0, 1],
  names: ["A", "B", "C"],
  mode: "Edit",
  restPoints: [],
  ...extra,
});

describe("skeleton palette operations", () => {
  it("adds a joint under the picked one, or the last joint when nothing is picked", () => {
    const under = skeletonOp("add", node(), [1])!;
    expect(readSkeleton(under.params!).parents[3]).toBe(1);
    expect(under.selection).toEqual([3]);
    expect(readSkeleton(skeletonOp("add", node(), [])!.params!).parents[3]).toBe(2);
  });

  it("deletes the picked joints but never the last one", () => {
    const out = skeletonOp("delete", node(), [1])!;
    expect(readSkeleton(out.params!).points.length).toBe(2);
    expect(out.selection.length).toBe(1);
    expect(skeletonOp("delete", node({ pointsList: [v(0, 0)], parents: [-1], names: ["A"] }), [0])).toBeNull();
    expect(skeletonOp("delete", node(), [])).toBeNull();
  });

  it("splits and mirrors", () => {
    expect(readSkeleton(skeletonOp("subdivide", node(), [2])!.params!).points.length).toBe(4);
    expect(skeletonOp("subdivide", node(), [0])).toBeNull();
    const mirrored = skeletonOp("mirror", node({ pointsList: [v(0, 0), v(1, 1), v(2, 2)] }), [1, 2])!;
    expect(readSkeleton(mirrored.params!).points[3].x).toBe(-1);
    expect(mirrored.selection).toEqual([3, 4]);
  });

  it("walks the hierarchy by selecting", () => {
    expect(skeletonOp("selectChildren", node(), [0])!.selection).toEqual([1]);
    expect(skeletonOp("selectParent", node(), [2])!.selection).toEqual([1]);
    expect(skeletonOp("selectParent", node(), [0])).toBeNull();
    expect(skeletonOp("selectAll", node(), [])!.selection).toEqual([0, 1, 2]);
    expect(skeletonOp("selectAll", node(), [])!.params).toBeUndefined();
  });

  it("goes to Pose mode keeping the rest, and back to it", () => {
    const toPose = skeletonOp("mode", node(), [])!;
    expect(toPose.params!.mode).toBe("Pose");
    expect((toPose.params!.restPoints as THREE.Vector3[]).length).toBe(3);
    const posed = node({ mode: "Pose", pointsList: [v(0, 0), v(0, 1), v(1, 1)], restPoints: toPose.params!.restPoints });
    const back = skeletonOp("mode", posed, [])!;
    expect(back.params!.mode).toBe("Edit");
    expect(readSkeleton(back.params!).points[2].x).toBe(0);
    expect(back.params!.restPoints).toEqual([]);
  });

  it("leaves the joints alone in Pose mode", () => {
    const posed = node({ mode: "Pose" });
    expect(skeletonOp("add", posed, [0])).toBeNull();
    expect(skeletonOp("delete", posed, [1])).toBeNull();
    expect(skeletonOp("selectAll", posed, [])).not.toBeNull();
  });
});
