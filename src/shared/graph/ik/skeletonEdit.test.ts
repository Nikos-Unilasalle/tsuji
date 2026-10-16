import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { addJoint, descendantsOf, mirrorJoints, moveWithDescendants, readSkeleton, removeJoints, skeletonParams, subdivideBone } from "./skeletonEdit";

const v = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z);
// 0 root, 1 child of 0, 2 child of 1, 3 child of 0
const chain = () => readSkeleton({ pointsList: [v(0, 0), v(0, 1), v(0, 2), v(1, 0)], parents: [-1, 0, 1, 0], names: ["Root", "Spine", "Head", "Arm Left"] });

describe("readSkeleton", () => {
  it("starts from nothing as an empty skeleton and fills in what is missing", () => {
    expect(readSkeleton({}).points.length).toBe(0);
    const s = readSkeleton({ pointsList: [v(0, 0), v(1, 0)] });
    expect(s.parents).toEqual([-1, -1]);
    expect(s.names).toEqual(["Joint 1", "Joint 2"]);
  });

  it("turns a bad parent into a root and cuts a loop", () => {
    expect(readSkeleton({ pointsList: [v(0, 0), v(1, 0)], parents: [5, 1] }).parents).toEqual([-1, -1]);
    const loop = readSkeleton({ pointsList: [v(0, 0), v(1, 0), v(2, 0)], parents: [2, 0, 1] });
    expect(loop.parents.filter((p) => p < 0).length).toBe(1);
  });

  it("round-trips through its params", () => {
    const s = chain();
    const again = readSkeleton(skeletonParams(s));
    expect(again.parents).toEqual(s.parents);
    expect(again.names).toEqual(s.names);
  });
});

describe("editing", () => {
  it("adds a child further along its own bone, or up from a root", () => {
    const { data, index } = addJoint(chain(), 2);
    expect(index).toBe(4);
    expect(data.parents[4]).toBe(2);
    expect(data.points[4].y).toBeGreaterThan(2);
    const fromRoot = addJoint(chain(), 0).data.points[4];
    expect(fromRoot.y).toBeGreaterThan(0);
    expect(new Set(data.names).size).toBe(data.names.length);
  });

  it("deletes a joint, handing its children to its parent, and never the last one", () => {
    const { data, remap } = removeJoints(chain(), [1])!;
    expect(data.points.length).toBe(3);
    expect(remap).toEqual([0, -1, 1, 2]);
    // Head (old 2) now hangs from the root.
    expect(data.parents[1]).toBe(0);
    expect(removeJoints(readSkeleton({ pointsList: [v(0, 0)] }), [0])).toBeNull();
    expect(removeJoints(chain(), [0, 1, 2, 3])).toBeNull();
  });

  it("splits a bone in two", () => {
    const { data, index } = subdivideBone(chain(), 2)!;
    expect(data.points[index].y).toBeCloseTo(1.5);
    expect(data.parents[index]).toBe(1);
    expect(data.parents[2]).toBe(index);
    expect(subdivideBone(chain(), 0)).toBeNull();
  });

  it("mirrors joints across X, keeping the chain and swapping sides in names", () => {
    const { data, added } = mirrorJoints(chain(), [3], 0)!;
    expect(data.points[added[0]].x).toBeCloseTo(-1);
    expect(data.parents[added[0]]).toBe(0);
    expect(data.names[added[0]]).toBe("Arm Right");
    const both = mirrorJoints(chain(), [1, 2], 0, 0.5)!;
    expect(both.data.parents[both.added[1]]).toBe(both.added[0]);
    expect(both.data.points[both.added[0]].x).toBeCloseTo(1);
  });

  it("moves a joint with everything below it", () => {
    const moved = moveWithDescendants(chain(), 1, v(0, 0, 5));
    expect(moved.points[1].z).toBe(5);
    expect(moved.points[2].z).toBe(5);
    expect(moved.points[3].z).toBe(0);
    expect(descendantsOf(chain(), 0).sort()).toEqual([1, 2, 3]);
  });
});
