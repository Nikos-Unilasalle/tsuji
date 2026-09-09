import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { CAPSULE_CONTROLLER_NODE } from "./character";
import { EvalContext } from "../types";
import {
  DEFAULT_CAPSULE_PARAMS,
  accelerateHorizontal,
  applyFriction,
  collectColliders,
  createCapsuleState,
  depenetrateCapsule,
  isWalkable,
  slideAlong,
  stepCapsule,
} from "../../three/controls/capsuleController";

function makeContext(nodeId: string, time: number): EvalContext {
  return { nodeId, time, step: Math.round(time * 60) };
}

/** A floor whose top face sits exactly at y = 0. */
function floor(size = 40): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, 1, size));
  mesh.position.y = -0.5;
  mesh.updateMatrixWorld(true);
  return mesh;
}

/** A wall standing on the floor, its inner face at the given x. */
function wall(x: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 6, 20));
  mesh.position.set(x + 0.5, 3, 0);
  mesh.updateMatrixWorld(true);
  return mesh;
}

function world(...meshes: THREE.Mesh[]): THREE.Group {
  const group = new THREE.Group();
  for (const mesh of meshes) group.add(mesh);
  group.updateMatrixWorld(true);
  return group;
}

describe("capsule feel — pure maths", () => {
  test("a slope counts as ground until it is steeper than the limit", () => {
    const maxSlope = THREE.MathUtils.degToRad(45);
    expect(isWalkable(new THREE.Vector3(0, 1, 0), maxSlope)).toBe(true);

    const forty = new THREE.Vector3(Math.sin(THREE.MathUtils.degToRad(40)), Math.cos(THREE.MathUtils.degToRad(40)), 0);
    const fifty = new THREE.Vector3(Math.sin(THREE.MathUtils.degToRad(50)), Math.cos(THREE.MathUtils.degToRad(50)), 0);
    expect(isWalkable(forty, maxSlope)).toBe(true);
    expect(isWalkable(fifty, maxSlope)).toBe(false);

    // A wall is never ground, and neither is a ceiling.
    expect(isWalkable(new THREE.Vector3(1, 0, 0), maxSlope)).toBe(false);
    expect(isWalkable(new THREE.Vector3(0, -1, 0), maxSlope)).toBe(false);
  });

  test("acceleration reaches the target without overshooting on a long frame", () => {
    const velocity = new THREE.Vector3();
    const target = new THREE.Vector3(5, 0, 0);
    // A 1-second frame at 40 u/s² would sail to 40 without the clamp.
    accelerateHorizontal(velocity, target, 40, 1);
    expect(velocity.x).toBeCloseTo(5, 6);
  });

  test("acceleration only touches the horizontal plane", () => {
    const velocity = new THREE.Vector3(0, -9, 0);
    accelerateHorizontal(velocity, new THREE.Vector3(3, 0, 0), 100, 0.1);
    expect(velocity.y).toBe(-9);
  });

  test("friction is per second, so stopping distance does not depend on frame rate", () => {
    const coarse = applyFriction(new THREE.Vector3(10, 0, 0), 6, 0.2).x;

    const fine = new THREE.Vector3(10, 0, 0);
    for (let i = 0; i < 4; i++) applyFriction(fine, 6, 0.05);
    expect(fine.x).toBeCloseTo(coarse, 10);
  });

  test("sliding removes the push into a wall and keeps the walk along it", () => {
    const velocity = new THREE.Vector3(4, 0, 3);
    slideAlong(velocity, new THREE.Vector3(-1, 0, 0));
    // Into the wall: gone. Along it: untouched.
    expect(velocity.x).toBeCloseTo(0, 6);
    expect(velocity.z).toBeCloseTo(3, 6);
  });

  test("sliding leaves a velocity moving away from the surface alone", () => {
    const velocity = new THREE.Vector3(-4, 0, 0);
    slideAlong(velocity, new THREE.Vector3(-1, 0, 0));
    expect(velocity.x).toBeCloseTo(-4, 6);
  });
});

describe("depenetration against real geometry", () => {
  const radius = DEFAULT_CAPSULE_PARAMS.radius;
  const height = DEFAULT_CAPSULE_PARAMS.height;

  test("a capsule sunk into the floor is pushed straight up", () => {
    const colliders = collectColliders(world(floor()));
    // Centre at 0.5 puts the bottom cap well below y = 0.
    const { offset, normal } = depenetrateCapsule(colliders, new THREE.Vector3(0, 0.5, 0), radius, height);

    expect(offset.y).toBeGreaterThan(0);
    expect(Math.abs(offset.x)).toBeLessThan(1e-6);
    expect(normal).not.toBeNull();
    expect(normal!.y).toBeCloseTo(1, 3);
  });

  test("a capsule clear of everything is not moved at all", () => {
    const colliders = collectColliders(world(floor()));
    const { offset, normal } = depenetrateCapsule(colliders, new THREE.Vector3(0, 10, 0), radius, height);
    expect(offset.length()).toBe(0);
    expect(normal).toBeNull();
  });

  test("with no collider wired, nothing is solid", () => {
    const { offset } = depenetrateCapsule([], new THREE.Vector3(0, -5, 0), radius, height);
    expect(offset.length()).toBe(0);
  });

  test("a wall pushes horizontally, and reports a horizontal normal", () => {
    const colliders = collectColliders(world(wall(2)));
    // Overlapping the wall's face, with the capsule's centre still outside it —
    // which is the only state a moving character can actually reach.
    const { offset, normal } = depenetrateCapsule(colliders, new THREE.Vector3(1.8, 1, 0), radius, height);

    expect(offset.x).toBeLessThan(0);
    expect(Math.abs(offset.y)).toBeLessThan(1e-6);
    expect(normal).not.toBeNull();
    expect(Math.abs(normal!.y)).toBeLessThan(0.2);
  });

  test("a centre already deep inside a solid is out of scope, and documented as such", () => {
    // Closest-point depenetration reads "outwards" from the surface nearest the
    // capsule's axis, so a centre past the face resolves the wrong way. A
    // character stepped forward frame by frame never reaches that state; this
    // pins the limitation rather than pretending it does not exist.
    const colliders = collectColliders(world(wall(2)));
    const { offset } = depenetrateCapsule(colliders, new THREE.Vector3(2.2, 1, 0), radius, height);
    expect(offset.x).toBeGreaterThan(0);
  });

  test("the collider's world transform is respected", () => {
    // The same box moved up by 5 must push the capsule at 5, not at 0.
    const raised = floor();
    raised.position.y = 4.5;
    raised.updateMatrixWorld(true);

    const colliders = collectColliders(world(raised));
    const { offset } = depenetrateCapsule(colliders, new THREE.Vector3(0, 5.4, 0), radius, height);
    expect(offset.y).toBeGreaterThan(0);
  });
});

describe("colliders with a scaled transform", () => {
  /**
   * A unit cube scaled by its matrix — which is what every `object/box` in the
   * graph is, and what the demo levels are built from.
   */
  function scaledBox(scale: THREE.Vector3, position: THREE.Vector3): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.scale.copy(scale);
    mesh.position.copy(position);
    mesh.updateMatrixWorld(true);
    return mesh;
  }

  test("a non-uniformly scaled floor is solid", () => {
    // The bug this pins: taking the capsule into the mesh's local space to test
    // it there works only for a uniform scale. A 16 × 1 × 16 floor squashes the
    // capsule into something with no single radius, and the character fell
    // straight through — in every demo, since scaled unit cubes are how levels
    // are built.
    const floorMesh = scaledBox(new THREE.Vector3(16, 1, 16), new THREE.Vector3(0, -0.5, 0));
    const colliders = collectColliders(world(floorMesh));
    const state = createCapsuleState(new THREE.Vector3(0, 3, 0));

    for (let i = 0; i < 180; i++) {
      stepCapsule(state, { move: new THREE.Vector3(), jump: false }, colliders, DEFAULT_CAPSULE_PARAMS, 1 / 60);
    }

    expect(state.grounded).toBe(true);
    expect(state.position.y).toBeCloseTo(DEFAULT_CAPSULE_PARAMS.height / 2, 1);
  });

  test("a non-uniformly scaled wall stops a walk", () => {
    const colliders = collectColliders(
      world(
        scaledBox(new THREE.Vector3(16, 1, 16), new THREE.Vector3(0, -0.5, 0)),
        scaledBox(new THREE.Vector3(0.6, 3, 10), new THREE.Vector3(5, 1.5, 0)),
      ),
    );
    const state = createCapsuleState(new THREE.Vector3(0, 3, 0));

    for (let i = 0; i < 600; i++) {
      stepCapsule(state, { move: new THREE.Vector3(1, 0, 0), jump: false }, colliders, DEFAULT_CAPSULE_PARAMS, 1 / 60);
    }

    // The wall's near face is at x = 4.7; the capsule stops a radius short.
    expect(state.position.x).toBeLessThan(4.7);
    expect(state.position.x).toBeGreaterThan(4);
    expect(state.grounded).toBe(true);
  });

  test("a rotated collider is solid, and its slope is walkable ground", () => {
    const ramp = scaledBox(new THREE.Vector3(6, 0.5, 6), new THREE.Vector3(0, 1, 0));
    ramp.rotation.z = -0.4; // ~23°, well inside the walkable limit
    ramp.updateMatrixWorld(true);

    const colliders = collectColliders(world(ramp));
    const state = createCapsuleState(new THREE.Vector3(0, 6, 0));

    let landedAt: number | null = null;
    for (let i = 0; i < 120; i++) {
      stepCapsule(state, { move: new THREE.Vector3(), jump: false }, colliders, DEFAULT_CAPSULE_PARAMS, 1 / 60);
      if (landedAt === null && state.grounded) landedAt = state.position.y;
    }

    // It touches down on the slope rather than passing through it. What happens
    // next is not this test's business: a 23° ramp with nothing to walk into is
    // a slide, and the character does slide off the end of it.
    expect(landedAt).not.toBeNull();
    expect(landedAt!).toBeGreaterThan(1);
  });
});

describe("stepCapsule — a body in a world", () => {
  const params = { ...DEFAULT_CAPSULE_PARAMS };
  const still = { move: new THREE.Vector3(), jump: false };

  function simulate(
    colliders: ReturnType<typeof collectColliders>,
    input: { move: THREE.Vector3; jump: boolean },
    frames: number,
    state = createCapsuleState(new THREE.Vector3(0, 3, 0)),
    dt = 1 / 60,
  ) {
    for (let i = 0; i < frames; i++) stepCapsule(state, input, colliders, params, dt);
    return state;
  }

  test("a character dropped in the air falls and comes to rest on the floor", () => {
    const colliders = collectColliders(world(floor()));
    const state = simulate(colliders, still, 180);

    // At rest the capsule's bottom cap touches y = 0, so its centre sits at
    // half its height.
    expect(state.position.y).toBeCloseTo(params.height / 2, 1);
    expect(state.grounded).toBe(true);
    // Standing still must not keep accumulating downward speed.
    expect(Math.abs(state.velocity.y)).toBeLessThan(0.5);
  });

  test("with nothing to stand on, it keeps falling", () => {
    const state = simulate([], still, 60);
    expect(state.position.y).toBeLessThan(0);
    expect(state.grounded).toBe(false);
  });

  test("walking moves it across the floor at about walk speed", () => {
    const colliders = collectColliders(world(floor()));
    const settled = simulate(colliders, still, 120);
    const startX = settled.position.x;

    for (let i = 0; i < 60; i++) {
      stepCapsule(settled, { move: new THREE.Vector3(1, 0, 0), jump: false }, colliders, params, 1 / 60);
    }

    const travelled = settled.position.x - startX;
    // One second of walking, minus the ramp up to speed.
    expect(travelled).toBeGreaterThan(params.walkSpeed * 0.7);
    expect(travelled).toBeLessThan(params.walkSpeed * 1.05);
  });

  test("a wall stops it, and it does not pass through", () => {
    const colliders = collectColliders(world(floor(), wall(2)));
    const state = simulate(colliders, still, 120);

    for (let i = 0; i < 240; i++) {
      stepCapsule(state, { move: new THREE.Vector3(1, 0, 0), jump: false }, colliders, params, 1 / 60);
    }

    // Held at the wall's face, less its own radius — never beyond it.
    expect(state.position.x).toBeLessThan(2);
    expect(state.position.x).toBeGreaterThan(2 - params.radius - 0.35);
  });

  test("pushing diagonally into a wall still slides along it", () => {
    const colliders = collectColliders(world(floor(), wall(2)));
    const state = simulate(colliders, still, 120);
    const startZ = state.position.z;

    for (let i = 0; i < 120; i++) {
      stepCapsule(state, { move: new THREE.Vector3(1, 0, 1).normalize(), jump: false }, colliders, params, 1 / 60);
    }

    // Blocked on X, but the walk along Z carries on — a sticky wall would
    // have stopped both.
    expect(state.position.x).toBeLessThan(2);
    expect(state.position.z - startZ).toBeGreaterThan(1);
  });

  test("it jumps, rises, and lands back on the floor", () => {
    const colliders = collectColliders(world(floor()));
    const state = simulate(colliders, still, 120);
    const restY = state.position.y;

    stepCapsule(state, { move: new THREE.Vector3(), jump: true }, colliders, params, 1 / 60);
    let peak = state.position.y;
    for (let i = 0; i < 40; i++) {
      stepCapsule(state, still, colliders, params, 1 / 60);
      peak = Math.max(peak, state.position.y);
    }
    expect(peak).toBeGreaterThan(restY + 0.5);

    for (let i = 0; i < 200; i++) stepCapsule(state, still, colliders, params, 1 / 60);
    expect(state.position.y).toBeCloseTo(restY, 1);
    expect(state.grounded).toBe(true);
  });

  test("it cannot jump again in mid-air", () => {
    const colliders = collectColliders(world(floor()));
    const state = simulate(colliders, still, 120);

    stepCapsule(state, { move: new THREE.Vector3(), jump: true }, colliders, params, 1 / 60);
    const afterFirst = state.velocity.y;

    // Holding jump while rising must not add speed.
    stepCapsule(state, { move: new THREE.Vector3(), jump: true }, colliders, params, 1 / 60);
    expect(state.velocity.y).toBeLessThan(afterFirst);
  });

  test("a half-pushed stick walks at half speed", () => {
    const colliders = collectColliders(world(floor()));

    const full = simulate(colliders, { move: new THREE.Vector3(1, 0, 0), jump: false }, 180);
    const half = simulate(colliders, { move: new THREE.Vector3(0.5, 0, 0), jump: false }, 180);

    const fullSpeed = Math.hypot(full.velocity.x, full.velocity.z);
    const halfSpeed = Math.hypot(half.velocity.x, half.velocity.z);
    expect(halfSpeed).toBeCloseTo(fullSpeed / 2, 1);
  });

  test("a diagonal is not faster than a straight line", () => {
    // Clamping rather than normalising keeps a partial push partial, but a
    // full diagonal push must still not exceed walk speed.
    const colliders = collectColliders(world(floor()));
    const diagonal = simulate(colliders, { move: new THREE.Vector3(1, 0, 1), jump: false }, 180);
    const speed = Math.hypot(diagonal.velocity.x, diagonal.velocity.z);
    expect(speed).toBeLessThanOrEqual(params.walkSpeed + 1e-6);
  });

  test("no time passing changes nothing", () => {
    const colliders = collectColliders(world(floor()));
    const state = createCapsuleState(new THREE.Vector3(0, 3, 0));
    stepCapsule(state, { move: new THREE.Vector3(1, 0, 0), jump: true }, colliders, params, 0);
    expect(state.position.toArray()).toEqual([0, 3, 0]);
    expect(state.velocity.length()).toBe(0);
  });
});

describe("physics/capsule-controller node", () => {
  const params = (overrides: Record<string, unknown> = {}) => ({
    ...CAPSULE_CONTROLLER_NODE.defaultParams,
    ...overrides,
  });

  function run(
    nodeId: string,
    frames: { time: number; inputs?: Record<string, unknown> }[],
    nodeParams: Record<string, unknown>,
  ) {
    return frames.map(
      (frame) =>
        CAPSULE_CONTROLLER_NODE.evaluate(frame.inputs ?? {}, nodeParams, makeContext(nodeId, frame.time)) as {
          position: THREE.Vector3;
          matrix: THREE.Matrix4;
          grounded: number;
          velocity: THREE.Vector3;
          speed: number;
        },
    );
  }

  test("the first frame reports the start position, not a fall", () => {
    const [first] = run("cap-1", [{ time: 0 }], params({ startPosition: new THREE.Vector3(1, 4, -2) }));
    expect(first.position.toArray()).toEqual([1, 4, -2]);
    expect(first.grounded).toBe(0);
  });

  test("the matrix output carries the same position", () => {
    const [first] = run("cap-2", [{ time: 0 }], params({ startPosition: new THREE.Vector3(3, 2, 1) }));
    const fromMatrix = new THREE.Vector3().setFromMatrixPosition(first.matrix);
    expect(fromMatrix.toArray()).toEqual([3, 2, 1]);
  });

  test("it falls onto a wired collider and settles", () => {
    const collider = world(floor());
    const frames = Array.from({ length: 200 }, (_, i) => ({
      time: i / 60,
      inputs: { collider, move: new THREE.Vector3() },
    }));
    const out = run("cap-3", frames, params({ startPosition: new THREE.Vector3(0, 4, 0) }));
    const last = out[out.length - 1];

    expect(last.grounded).toBe(1);
    expect(last.position.y).toBeCloseTo(DEFAULT_CAPSULE_PARAMS.height / 2, 1);
  });

  test("Reset puts it back at the start", () => {
    const collider = world(floor());
    const frames = [
      ...Array.from({ length: 60 }, (_, i) => ({
        time: i / 60,
        inputs: { collider, move: new THREE.Vector3(1, 0, 0) },
      })),
      { time: 1.1, inputs: { collider, reset: 1 } },
    ];
    const out = run("cap-4", frames, params({ startPosition: new THREE.Vector3(0, 3, 0) }));
    expect(out[out.length - 1].position.toArray()).toEqual([0, 3, 0]);
  });

  test("scrubbing the timeline backwards puts it back at the start too", () => {
    const collider = world(floor());
    const out = run(
      "cap-5",
      [
        { time: 0, inputs: { collider } },
        { time: 2, inputs: { collider } },
        { time: 0.1, inputs: { collider } },
      ],
      params({ startPosition: new THREE.Vector3(0, 5, 0) }),
    );
    expect(out[2].position.toArray()).toEqual([0, 5, 0]);
  });

  test("falling out of the world respawns rather than falling for ever", () => {
    const frames = Array.from({ length: 300 }, (_, i) => ({ time: i / 60 }));
    const out = run("cap-6", frames, params({ startPosition: new THREE.Vector3(0, 2, 0), respawnBelow: -20 }));
    // With no collider it falls; the floor of last resort catches it.
    expect(out[out.length - 1].position.y).toBeGreaterThan(-20);
  });

  test("a long stall does not teleport it through the floor", () => {
    // A backgrounded tab or a shader compile can hand over a huge dt; the step
    // is clamped so one frame can never cross a wall.
    const collider = world(floor());
    const out = run(
      "cap-7",
      [
        { time: 0, inputs: { collider } },
        { time: 0.02, inputs: { collider } },
        { time: 5, inputs: { collider } },
      ],
      params({ startPosition: new THREE.Vector3(0, 3, 0) }),
    );
    expect(out[2].position.y).toBeGreaterThan(0);
  });

  test("speed reports the horizontal pace only", () => {
    const collider = world(floor());
    const frames = Array.from({ length: 120 }, (_, i) => ({
      time: i / 60,
      inputs: { collider, move: new THREE.Vector3(1, 0, 0) },
    }));
    const out = run("cap-8", frames, params());
    const last = out[out.length - 1];
    expect(last.speed).toBeCloseTo(Math.hypot(last.velocity.x, last.velocity.z), 6);
  });

  test("Walk Speed is wired, so the pace can be driven from the graph", () => {
    const collider = world(floor());
    const frames = Array.from({ length: 150 }, (_, i) => ({
      time: i / 60,
      inputs: { collider, move: new THREE.Vector3(1, 0, 0), walkSpeed: 2 },
    }));
    const out = run("cap-9", frames, params());
    expect(out[out.length - 1].speed).toBeCloseTo(2, 1);
  });

  test("outputs are cloned, so a downstream node cannot move the character", () => {
    const collider = world(floor());
    const out = run(
      "cap-10",
      [
        { time: 0, inputs: { collider } },
        { time: 1 / 60, inputs: { collider } },
        { time: 2 / 60, inputs: { collider } },
      ],
      params({ startPosition: new THREE.Vector3(0, 3, 0) }),
    );
    out[1].position.set(100, 100, 100);
    expect(out[2].position.x).toBeCloseTo(0, 6);
  });
});
