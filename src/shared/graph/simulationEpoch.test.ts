import * as THREE from "three";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  getSimulationEpoch,
  isEpochCurrent,
  onSimulationReset,
  resetSimulationEpochForTesting,
  resetSimulations,
} from "./simulationEpoch";
import { INTEGRATE_NODE, INTEGRATE_VECTOR_NODE } from "./nodes/integrate";
import { CAPSULE_CONTROLLER_NODE } from "./nodes/character";
import { PHYSICS_WORLD_NODE, RIGID_BODY_NODE } from "./nodes/rapier";
import { initRapier } from "../three/physics/rapierRuntime";
import { EvalContext } from "./types";

function ctx(nodeId: string, time: number, epoch = getSimulationEpoch()): EvalContext {
  return { nodeId, time, step: Math.round(time * 60), simulationEpoch: epoch };
}

afterEach(() => {
  resetSimulationEpochForTesting();
});

describe("the epoch itself", () => {
  test("starts at zero and advances one reset at a time", () => {
    expect(getSimulationEpoch()).toBe(0);
    resetSimulations();
    expect(getSimulationEpoch()).toBe(1);
    resetSimulations();
    expect(getSimulationEpoch()).toBe(2);
  });

  test("listeners are told, and can stop listening", () => {
    let calls = 0;
    const stop = onSimulationReset(() => {
      calls += 1;
    });

    resetSimulations();
    expect(calls).toBe(1);

    stop();
    resetSimulations();
    expect(calls).toBe(1);
  });

  test("state built in this epoch is current; state from another is not", () => {
    expect(isEpochCurrent(0, 0)).toBe(true);
    expect(isEpochCurrent(0, 1)).toBe(false);
  });

  test("state that has never been built is not treated as stale", () => {
    // Otherwise the first frame after a load would rebuild what was just built.
    expect(isEpochCurrent(undefined, 0)).toBe(false);
  });

  test("a headless call with no epoch reads as zero", () => {
    expect(isEpochCurrent(0, undefined)).toBe(true);
  });
});

describe("integrators forget on a new epoch", () => {
  test("an accumulated total goes back to Initial", () => {
    const params = { ...INTEGRATE_NODE.defaultParams, initial: 0 };

    INTEGRATE_NODE.evaluate({ rate: 4 }, params, ctx("i1", 0));
    const walked = INTEGRATE_NODE.evaluate({ rate: 4 }, params, ctx("i1", 1)) as { value: number };
    expect(walked.value).toBeCloseTo(4, 6);

    resetSimulations();
    const after = INTEGRATE_NODE.evaluate({ rate: 4 }, params, ctx("i1", 1.1)) as { value: number };
    expect(after.value).toBe(0);
  });

  test("and carries on accumulating from there", () => {
    const params = { ...INTEGRATE_NODE.defaultParams, initial: 0 };
    INTEGRATE_NODE.evaluate({ rate: 2 }, params, ctx("i2", 0));
    INTEGRATE_NODE.evaluate({ rate: 2 }, params, ctx("i2", 1));

    resetSimulations();
    INTEGRATE_NODE.evaluate({ rate: 2 }, params, ctx("i2", 1.1));
    const moving = INTEGRATE_NODE.evaluate({ rate: 2 }, params, ctx("i2", 2.1)) as { value: number };
    expect(moving.value).toBeCloseTo(2, 6);
  });

  test("a vector integrator forgets too", () => {
    const params = { ...INTEGRATE_VECTOR_NODE.defaultParams };
    const rate = new THREE.Vector3(3, 0, 0);

    INTEGRATE_VECTOR_NODE.evaluate({ rate }, params, ctx("v1", 0));
    const walked = INTEGRATE_VECTOR_NODE.evaluate({ rate }, params, ctx("v1", 1)) as {
      value: THREE.Vector3;
    };
    expect(walked.value.x).toBeCloseTo(3, 6);

    resetSimulations();
    const after = INTEGRATE_VECTOR_NODE.evaluate({ rate }, params, ctx("v1", 1.1)) as {
      value: THREE.Vector3;
    };
    expect(after.value.x).toBe(0);
  });

  test("without a reset, nothing is forgotten", () => {
    const params = { ...INTEGRATE_NODE.defaultParams, initial: 0 };
    INTEGRATE_NODE.evaluate({ rate: 5 }, params, ctx("i3", 0));
    const held = INTEGRATE_NODE.evaluate({ rate: 0 }, params, ctx("i3", 1)) as { value: number };
    const still = INTEGRATE_NODE.evaluate({ rate: 0 }, params, ctx("i3", 2)) as { value: number };
    expect(still.value).toBeCloseTo(held.value, 6);
  });
});

describe("the capsule controller forgets on a new epoch", () => {
  test("it returns to its start position", () => {
    const params = {
      ...CAPSULE_CONTROLLER_NODE.defaultParams,
      startPosition: new THREE.Vector3(0, 5, 0),
    };
    const move = new THREE.Vector3(1, 0, 0);

    for (let f = 0; f < 60; f++) {
      CAPSULE_CONTROLLER_NODE.evaluate({ move }, params, ctx("c1", f / 60));
    }
    const walked = CAPSULE_CONTROLLER_NODE.evaluate({ move }, params, ctx("c1", 1)) as {
      position: THREE.Vector3;
    };
    expect(walked.position.x).toBeGreaterThan(0.5);

    resetSimulations();
    const after = CAPSULE_CONTROLLER_NODE.evaluate({ move }, params, ctx("c1", 1.02)) as {
      position: THREE.Vector3;
    };
    expect(after.position.toArray()).toEqual([0, 5, 0]);
  });
});

describe("the physics world rebuilds on a new epoch", () => {
  beforeAll(async () => {
    await initRapier();
  });

  test("bodies go back to where the graph put them", () => {
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8));
    ball.position.set(0, 10, 0);
    ball.updateMatrixWorld(true);

    const worldParams = { ...PHYSICS_WORLD_NODE.defaultParams };
    const bodyParams = { ...RIGID_BODY_NODE.defaultParams, shape: "sphere" };

    for (let f = 0; f < 90; f++) {
      const world = PHYSICS_WORLD_NODE.evaluate({}, worldParams, ctx("w1", f / 60)) as { world: unknown };
      RIGID_BODY_NODE.evaluate({ world: world.world, geometry: ball }, bodyParams, ctx("b1", f / 60));
    }
    const fallen = ball.position.y;
    expect(fallen).toBeLessThan(10);

    // The world is rebuilt, and the body with it — at whatever pose the object
    // currently has, which is what "start over from here" means for a scene
    // whose objects the graph places.
    resetSimulations();
    const world = PHYSICS_WORLD_NODE.evaluate({}, worldParams, ctx("w1", 1.55)) as {
      world: unknown;
      bodies: number;
    };
    const after = RIGID_BODY_NODE.evaluate(
      { world: world.world, geometry: ball },
      bodyParams,
      ctx("b1", 1.55),
    ) as { position: THREE.Vector3; velocity: THREE.Vector3 };

    // A fresh world starts with no bodies until each one re-registers.
    expect(after.position.y).toBeCloseTo(fallen, 3);
    // The inherited fall speed is gone, which is the point of the rebuild.
    expect(Math.abs(after.velocity.y)).toBeLessThan(1);
  });

  test("without a reset the world is left alone", () => {
    const worldParams = { ...PHYSICS_WORLD_NODE.defaultParams };
    const first = PHYSICS_WORLD_NODE.evaluate({}, worldParams, ctx("w2", 0)) as { world: any };
    const second = PHYSICS_WORLD_NODE.evaluate({}, worldParams, ctx("w2", 1 / 60)) as { world: any };
    expect(second.world).toBe(first.world);
    expect(second.world.generation).toBe(first.world.generation);
  });
});
