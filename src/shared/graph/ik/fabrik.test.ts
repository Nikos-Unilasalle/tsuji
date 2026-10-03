import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { applyPoles, boneLengths, IkRig, solveFabrik } from "./fabrik";

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** A chain going up the Y axis, slightly bent toward +Z so it has a side to fold to. */
function chain(segments: number, length = 1): IkRig {
  const rig: IkRig = { joints: [{ parent: -1 }], rest: [v(0, 0, 0)] };
  for (let i = 1; i <= segments; i++) {
    rig.joints.push({ parent: i - 1 });
    rig.rest.push(v(0, i * length, i % 2 ? 0.05 : 0));
  }
  return rig;
}

function expectLengthsKept(rig: IkRig, positions: THREE.Vector3[]) {
  const lengths = boneLengths(rig);
  rig.joints.forEach((j, i) => {
    if (j.parent >= 0) expect(positions[i].distanceTo(positions[j.parent])).toBeCloseTo(lengths[i], 5);
  });
}

describe("solveFabrik", () => {
  it("reaches a target inside the chain's reach, keeping every bone length", () => {
    const rig = chain(4);
    const target = v(1.5, 2, 0.5);
    const { positions, error } = solveFabrik(rig, [{ joint: 4, target }], { maxIterations: 50 });
    expect(error).toBeLessThan(1e-4);
    expect(positions[4].distanceTo(target)).toBeLessThan(1e-4);
    expect(positions[0].length()).toBe(0); // root pinned
    expectLengthsKept(rig, positions);
  });

  it("stretches straight toward a target out of reach", () => {
    const rig = chain(3);
    const { positions } = solveFabrik(rig, [{ joint: 3, target: v(10, 0, 0) }], { maxIterations: 50 });
    // A fully stretched chain: the tip is the total length out, along the target's direction.
    expect(positions[3].x).toBeCloseTo(boneLengths(rig).reduce((a, b) => a + b, 0), 2);
    expect(Math.abs(positions[3].y)).toBeLessThan(0.05);
    expectLengthsKept(rig, positions);
  });

  it("keeps rigid joints at their rest offset in the parent's frame", () => {
    // Root → spine (bone) → shoulder (rigid, offset +X) → hand (bone).
    const rig: IkRig = {
      joints: [{ parent: -1 }, { parent: 0 }, { parent: 1, rigid: true }, { parent: 2 }],
      rest: [v(0, 0, 0), v(0, 1, 0), v(0.5, 1, 0), v(0.5, 0.2, 0.1)],
    };
    const { positions } = solveFabrik(rig, [{ joint: 3, target: v(1, 0.8, 0.6) }], { maxIterations: 60 });
    expectLengthsKept(rig, positions);
    // The shoulder offset turned with the spine: same angle to it as at rest (90°).
    const spine = positions[1].clone().sub(positions[0]).normalize();
    const shoulder = positions[2].clone().sub(positions[1]);
    expect(shoulder.length()).toBeCloseTo(0.5, 5);
    expect(spine.dot(shoulder.normalize())).toBeCloseTo(0, 5);
  });

  it("moves a shared sub-base to the weighted centroid of its branches", () => {
    // Root → chest, with two arms out of the chest.
    const rig: IkRig = {
      joints: [{ parent: -1 }, { parent: 0 }, { parent: 1 }, { parent: 1 }],
      rest: [v(0, 0, 0), v(0, 1, 0), v(-1, 1, 0.01), v(1, 1, 0.01)],
    };
    const pull = (weight: number) =>
      solveFabrik(rig, [{ joint: 2, target: v(-3, 1, 0) }, { joint: 3, target: v(1, 1.5, 0), weight }], { maxIterations: 80 }).positions;
    // The left arm's unreachable target drags the chest left; a heavier right arm resists it.
    expect(pull(0)[1].x).toBeLessThan(pull(5)[1].x);
  });

  it("bends toward the pole", () => {
    const rig = chain(2);
    for (const side of [1, -1]) {
      const { positions } = solveFabrik(rig, [{ joint: 2, target: v(0, 1.2, 0) }], {
        poles: [{ joint: 1, pole: v(side * 2, 0.6, 0) }],
        maxIterations: 50,
      });
      expect(positions[2].distanceTo(v(0, 1.2, 0))).toBeLessThan(1e-3);
      expect(Math.sign(positions[1].x)).toBe(side);
      expectLengthsKept(rig, positions);
    }
  });
});

describe("applyPoles", () => {
  it("swings the joint about its neighbours without changing either bone", () => {
    const rig = chain(2);
    const positions = [v(0, 0, 0), v(0.6, 0.8, 0), v(0, 1.6, 0)];
    applyPoles(rig, positions, [{ joint: 1, pole: v(0, 0.8, 5) }]);
    expect(positions[1].x).toBeCloseTo(0, 6);
    expect(positions[1].z).toBeCloseTo(0.6, 6);
    expect(positions[1].length()).toBeCloseTo(1, 6);
    expect(positions[1].distanceTo(positions[2])).toBeCloseTo(1, 6);
  });
});
