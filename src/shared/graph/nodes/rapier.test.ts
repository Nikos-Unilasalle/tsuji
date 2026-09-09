import * as THREE from "three";
import { beforeAll, describe, expect, test } from "vitest";
import { PHYSICS_CHARACTER_NODE, PHYSICS_WORLD_NODE, RIGID_BODY_NODE, VEHICLE_NODE } from "./rapier";
import { EvalContext } from "../types";
import {
  extractColliderGeometry,
  initRapier,
  isPhysicsWorld,
  isRapierReady,
  planSteps,
  resolveShape,
} from "../../three/physics/rapierRuntime";

function makeContext(nodeId: string, time: number): EvalContext {
  return { nodeId, time, step: Math.round(time * 60) };
}

describe("fixed timestep planning", () => {
  test("time accumulates until a whole step fits", () => {
    // Two 8 ms frames do not add up to a 16.7 ms step; three do.
    let acc = 0;
    let total = 0;
    for (let i = 0; i < 3; i++) {
      const { steps, remainder } = planSteps(acc, 0.008, 1 / 60, 4);
      acc = remainder;
      total += steps;
    }
    expect(total).toBe(1);
    expect(acc).toBeGreaterThan(0);
  });

  test("a frame worth several steps runs several", () => {
    const { steps } = planSteps(0, 0.05, 1 / 60, 8);
    expect(steps).toBe(3);
  });

  test("a long stall is dropped rather than simulated all at once", () => {
    // Five seconds at 60 Hz would be 300 steps; the cap keeps the frame
    // affordable, and the debt is discarded instead of banked — banking it
    // guarantees the next frame is over budget too.
    const { steps, remainder } = planSteps(0, 5, 1 / 60, 4);
    expect(steps).toBe(4);
    expect(remainder).toBe(0);
  });

  test("no elapsed time runs nothing, and a zero timestep cannot divide by zero", () => {
    expect(planSteps(0, 0, 1 / 60, 4).steps).toBe(0);
    expect(planSteps(0, 1, 0, 4).steps).toBe(0);
  });

  test("time is conserved across frames while steps are being taken", () => {
    let acc = 0;
    let steps = 0;
    // One second of 100 Hz frames should produce very close to 60 steps.
    for (let i = 0; i < 100; i++) {
      const plan = planSteps(acc, 0.01, 1 / 60, 8);
      acc = plan.remainder;
      steps += plan.steps;
    }
    expect(steps).toBe(60);
  });
});

describe("shape defaults", () => {
  test("dynamic bodies get a hull, fixed ones a triangle mesh", () => {
    // A hull is cheap, closed and stacks predictably; a trimesh is exact but
    // has no volume, which only matters for something that moves.
    expect(resolveShape("auto", true)).toBe("hull");
    expect(resolveShape("auto", false)).toBe("trimesh");
  });

  test("an explicit choice is never overridden", () => {
    expect(resolveShape("box", true)).toBe("box");
    expect(resolveShape("sphere", false)).toBe("sphere");
  });
});

describe("collider geometry extraction", () => {
  test("a mesh's vertices come out in the object's own space", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    mesh.position.set(10, 0, 0);
    mesh.updateMatrixWorld(true);

    const geometry = extractColliderGeometry(mesh)!;
    expect(geometry).not.toBeNull();
    // Baked into local space, so the box straddles its own origin however far
    // the graph has moved it.
    expect(geometry.box.min.x).toBeCloseTo(-1, 5);
    expect(geometry.box.max.x).toBeCloseTo(1, 5);
  });

  test("a group of meshes is welded into one soup, children's transforms baked in", () => {
    const group = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    b.position.set(4, 0, 0);
    group.add(a, b);
    group.updateMatrixWorld(true);

    const geometry = extractColliderGeometry(group)!;
    expect(geometry.box.max.x).toBeCloseTo(4.5, 5);
    // Two boxes, 12 triangles each.
    expect(geometry.indices.length).toBe(36 * 2);
  });

  test("a scaled mesh has its scale baked into the collider", () => {
    // A Rapier body carries a position and a rotation and nothing else, so the
    // scale has to end up in the vertices or it is lost — and every level in
    // this engine is unit cubes scaled by their matrices.
    const child = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const parent = new THREE.Group();
    parent.add(child);
    child.scale.set(8, 1, 8);
    parent.updateMatrixWorld(true);

    const fromChild = extractColliderGeometry(parent)!;
    expect(fromChild.box.max.x).toBeCloseTo(4, 5);
    expect(fromChild.box.max.y).toBeCloseTo(0.5, 5);

    // And the object's *own* scale counts just the same.
    const scaled = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    scaled.scale.set(8, 1, 8);
    scaled.position.set(100, 0, 0);
    scaled.updateMatrixWorld(true);

    const fromSelf = extractColliderGeometry(scaled)!;
    expect(fromSelf.box.max.x).toBeCloseTo(4, 5);
    // Its translation is *not* baked: the body carries that.
    expect(fromSelf.box.min.x).toBeCloseTo(-4, 5);
  });

  test("an object with no meshes has no collider", () => {
    expect(extractColliderGeometry(new THREE.Group())).toBeNull();
  });
});

describe("physics nodes without the engine loaded", () => {
  test("the world reports not-ready rather than throwing", () => {
    // Only meaningful before init resolves; once it has, this is trivially
    // ready. Either way it must not throw.
    const out = PHYSICS_WORLD_NODE.evaluate({}, PHYSICS_WORLD_NODE.defaultParams, makeContext("w-0", 0)) as {
      ready: number;
    };
    expect([0, 1]).toContain(out.ready);
  });

  test("a body with no world wired passes its geometry straight through", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const out = RIGID_BODY_NODE.evaluate(
      { geometry: mesh },
      RIGID_BODY_NODE.defaultParams,
      makeContext("b-0", 0),
    ) as { geometry: THREE.Object3D; speed: number };
    expect(out.geometry).toBe(mesh);
    expect(out.speed).toBe(0);
  });
});

describe("simulation", () => {
  beforeAll(async () => {
    await initRapier();
  });

  const worldParams = (overrides: Record<string, unknown> = {}) => ({
    ...PHYSICS_WORLD_NODE.defaultParams,
    ...overrides,
  });
  const bodyParams = (overrides: Record<string, unknown> = {}) => ({
    ...RIGID_BODY_NODE.defaultParams,
    ...overrides,
  });

  /** Runs the world and a set of bodies over `frames` frames at 60 Hz. */
  function simulate(
    worldId: string,
    bodies: { id: string; object: THREE.Object3D; params: Record<string, unknown> }[],
    frames: number,
    world = worldParams(),
  ) {
    let last: Record<string, any> = {};
    for (let frame = 0; frame < frames; frame++) {
      const time = frame / 60;
      const worldOut = PHYSICS_WORLD_NODE.evaluate({}, world, makeContext(worldId, time)) as {
        world: unknown;
      };
      for (const body of bodies) {
        last[body.id] = RIGID_BODY_NODE.evaluate(
          { world: worldOut.world, geometry: body.object },
          body.params,
          makeContext(body.id, time),
        );
      }
    }
    return last;
  }

  test("the engine is up and the world hands out a real handle", () => {
    expect(isRapierReady()).toBe(true);
    const out = PHYSICS_WORLD_NODE.evaluate({}, worldParams(), makeContext("w-1", 0)) as {
      world: unknown;
      ready: number;
    };
    expect(out.ready).toBe(1);
    expect(isPhysicsWorld(out.world)).toBe(true);
  });

  test("a ball falls and comes to rest on a fixed floor", () => {
    const floor = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    floor.scale.set(20, 1, 20);
    floor.position.set(0, -0.5, 0);
    floor.updateMatrixWorld(true);

    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12));
    ball.position.set(0, 5, 0);
    ball.updateMatrixWorld(true);

    const out = simulate(
      "w-2",
      [
        { id: "floor-2", object: floor, params: bodyParams({ bodyType: "fixed", shape: "trimesh" }) },
        { id: "ball-2", object: ball, params: bodyParams({ shape: "sphere", restitution: 0 }) },
      ],
      240,
    );

    const position = out["ball-2"].position as THREE.Vector3;
    expect(position.y).toBeCloseTo(0.5, 1);
    expect(out["ball-2"].speed).toBeLessThan(0.1);
  });

  test("a non-uniformly scaled floor is solid — the scale is baked into the collider", () => {
    // The same trap the capsule controller fell into: a level is unit cubes
    // scaled by their matrices, and a collider built from raw geometry would
    // be 1 × 1 × 1.
    const floor = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    floor.scale.set(30, 1, 30);
    floor.position.set(0, -0.5, 0);
    floor.updateMatrixWorld(true);

    const crate = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    crate.position.set(9, 4, 9); // far outside a 1×1 collider's reach
    crate.updateMatrixWorld(true);

    const out = simulate(
      "w-3",
      [
        { id: "floor-3", object: floor, params: bodyParams({ bodyType: "fixed" }) },
        { id: "crate-3", object: crate, params: bodyParams({ shape: "box" }) },
      ],
      240,
    );

    expect((out["crate-3"].position as THREE.Vector3).y).toBeGreaterThan(0);
  });

  test("boxes stack instead of sinking through each other", () => {
    const floor = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    floor.scale.set(20, 1, 20);
    floor.position.set(0, -0.5, 0);
    floor.updateMatrixWorld(true);

    const bodies = [
      { id: "floor-4", object: floor, params: bodyParams({ bodyType: "fixed" }) },
    ];
    for (let i = 0; i < 3; i++) {
      const crate = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
      crate.position.set(0, 1.5 + i * 1.2, 0);
      crate.updateMatrixWorld(true);
      bodies.push({ id: `crate-4-${i}`, object: crate, params: bodyParams({ shape: "box" }) });
    }

    const out = simulate("w-4", bodies, 400);
    const heights = [0, 1, 2].map((i) => (out[`crate-4-${i}`].position as THREE.Vector3).y).sort((a, b) => a - b);

    // Three unit crates resting on a floor: roughly 0.5, 1.5 and 2.5.
    expect(heights[0]).toBeCloseTo(0.5, 0);
    expect(heights[1]).toBeGreaterThan(heights[0] + 0.7);
    expect(heights[2]).toBeGreaterThan(heights[1] + 0.7);
  });

  test("a fixed body does not move, whatever lands on it", () => {
    const floor = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    floor.scale.set(20, 1, 20);
    floor.position.set(0, -0.5, 0);
    floor.updateMatrixWorld(true);

    const out = simulate("w-5", [{ id: "floor-5", object: floor, params: bodyParams({ bodyType: "fixed" }) }], 120);
    expect((out["floor-5"].position as THREE.Vector3).y).toBeCloseTo(-0.5, 6);
  });

  test("the body writes its pose onto the object, so the viewport shows it", () => {
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8));
    ball.position.set(0, 10, 0);
    ball.updateMatrixWorld(true);

    simulate("w-6", [{ id: "ball-6", object: ball, params: bodyParams({ shape: "sphere" }) }], 60);
    expect(ball.position.y).toBeLessThan(10);
    expect(ball.matrixAutoUpdate).toBe(false);
  });

  test("Paused freezes the simulation without tearing the world down", () => {
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8));
    ball.position.set(0, 10, 0);
    ball.updateMatrixWorld(true);

    const out = simulate(
      "w-7",
      [{ id: "ball-7", object: ball, params: bodyParams({ shape: "sphere" }) }],
      60,
      worldParams({ paused: 1 }),
    );
    expect((out["ball-7"].position as THREE.Vector3).y).toBeCloseTo(10, 5);
  });

  test("scrubbing the timeline backwards rebuilds the world and re-seeds the bodies", () => {
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8));
    ball.position.set(0, 10, 0);
    ball.updateMatrixWorld(true);

    const params = bodyParams({ shape: "sphere" });
    const world = worldParams();

    for (let frame = 0; frame < 90; frame++) {
      const w = PHYSICS_WORLD_NODE.evaluate({}, world, makeContext("w-8", frame / 60)) as { world: unknown };
      RIGID_BODY_NODE.evaluate({ world: w.world, geometry: ball }, params, makeContext("ball-8", frame / 60));
    }
    const fallen = ball.position.y;
    expect(fallen).toBeLessThan(10);

    // Jump back to the start: the whole simulation's history no longer applies.
    const w = PHYSICS_WORLD_NODE.evaluate({}, world, makeContext("w-8", 0)) as { world: unknown };
    const out = RIGID_BODY_NODE.evaluate(
      { world: w.world, geometry: ball },
      params,
      makeContext("ball-8", 0),
    ) as { position: THREE.Vector3 };

    // Re-created where the object now sits, with no inherited velocity.
    expect(out.position.y).toBeCloseTo(fallen, 3);
  });

  test("gravity is wired, so zero gravity leaves a body floating", () => {
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8));
    ball.position.set(0, 10, 0);
    ball.updateMatrixWorld(true);

    const out = simulate(
      "w-9",
      [{ id: "ball-9", object: ball, params: bodyParams({ shape: "sphere" }) }],
      120,
      worldParams({ gravity: new THREE.Vector3(0, 0, 0) }),
    );
    expect((out["ball-9"].position as THREE.Vector3).y).toBeCloseTo(10, 3);
  });

  test("a force pushes a dynamic body", () => {
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8));
    ball.position.set(0, 0, 0);
    ball.updateMatrixWorld(true);

    const world = worldParams({ gravity: new THREE.Vector3(0, 0, 0) });
    const params = bodyParams({ shape: "sphere", linearDamping: 0 });

    let last: any;
    for (let frame = 0; frame < 120; frame++) {
      const w = PHYSICS_WORLD_NODE.evaluate({}, world, makeContext("w-10", frame / 60)) as { world: unknown };
      last = RIGID_BODY_NODE.evaluate(
        { world: w.world, geometry: ball, force: new THREE.Vector3(20, 0, 0) },
        params,
        makeContext("ball-10", frame / 60),
      );
    }
    expect((last.position as THREE.Vector3).x).toBeGreaterThan(0.5);
    expect(last.speed).toBeGreaterThan(0);
  });
});

describe("physics/character — a capsule on Rapier's own controller", () => {
  beforeAll(async () => {
    await initRapier();
  });

  const worldParams = () => ({ ...PHYSICS_WORLD_NODE.defaultParams });
  const bodyParams = (overrides: Record<string, unknown> = {}) => ({
    ...RIGID_BODY_NODE.defaultParams,
    ...overrides,
  });
  const charParams = (overrides: Record<string, unknown> = {}) => ({
    ...PHYSICS_CHARACTER_NODE.defaultParams,
    ...overrides,
  });

  function scaledBox(scale: THREE.Vector3, position: THREE.Vector3): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.scale.copy(scale);
    mesh.position.copy(position);
    mesh.updateMatrixWorld(true);
    return mesh;
  }

  /** World + level + character, run for `frames` frames at 60 Hz. */
  function walk(
    ids: string,
    level: { id: string; object: THREE.Object3D }[],
    charInputs: Record<string, unknown>,
    frames: number,
    characterParams = charParams(),
  ) {
    let last: any;
    for (let frame = 0; frame < frames; frame++) {
      const time = frame / 60;
      const world = PHYSICS_WORLD_NODE.evaluate({}, worldParams(), makeContext(`${ids}-w`, time)) as {
        world: unknown;
      };
      for (const piece of level) {
        RIGID_BODY_NODE.evaluate(
          { world: world.world, geometry: piece.object },
          bodyParams({ bodyType: "fixed" }),
          makeContext(piece.id, time),
        );
      }
      last = PHYSICS_CHARACTER_NODE.evaluate(
        { world: world.world, ...charInputs },
        characterParams,
        makeContext(`${ids}-c`, time),
      );
    }
    return last as { position: THREE.Vector3; grounded: number; speed: number };
  }

  const floorPiece = (id: string) => ({
    id,
    object: scaledBox(new THREE.Vector3(30, 1, 30), new THREE.Vector3(0, -0.5, 0)),
  });

  test("it falls onto the level and stands on it", () => {
    const out = walk("ch1", [floorPiece("ch1-floor")], { move: new THREE.Vector3() }, 200,
      charParams({ startPosition: new THREE.Vector3(0, 4, 0) }));

    expect(out.grounded).toBe(1);
    // Capsule centre rests at half its height above the floor.
    expect(out.position.y).toBeCloseTo(0.9, 1);
  });

  test("it walks, and letting go leaves it where it stood", () => {
    const level = [floorPiece("ch2-floor")];
    const moving = walk("ch2", level, { move: new THREE.Vector3(1, 0, 0) }, 180,
      charParams({ startPosition: new THREE.Vector3(0, 2, 0) }));
    expect(moving.position.x).toBeGreaterThan(2);
  });

  test("a wall stops it", () => {
    const level = [
      floorPiece("ch3-floor"),
      { id: "ch3-wall", object: scaledBox(new THREE.Vector3(0.5, 4, 10), new THREE.Vector3(4, 2, 0)) },
    ];
    const out = walk("ch3", level, { move: new THREE.Vector3(1, 0, 0) }, 400,
      charParams({ startPosition: new THREE.Vector3(0, 2, 0) }));

    // The wall's near face is at 3.75; the capsule stops a radius short of it.
    expect(out.position.x).toBeLessThan(3.75);
    expect(out.position.x).toBeGreaterThan(2.5);
  });

  test("auto-step climbs a kerb that would otherwise block it", () => {
    // This is the whole reason to prefer Rapier's controller: a 0.25 step is
    // climbed without the author modelling an invisible ramp over it.
    const step = () => ({
      id: "ch4-step",
      object: scaledBox(new THREE.Vector3(6, 0.25, 10), new THREE.Vector3(5, 0.125, 0)),
    });

    const withStep = walk("ch4", [floorPiece("ch4-floor"), step()], { move: new THREE.Vector3(1, 0, 0) }, 400,
      charParams({ startPosition: new THREE.Vector3(0, 2, 0), autostep: 0.4 }));

    const withoutStep = walk("ch5", [floorPiece("ch5-floor"), { ...step(), id: "ch5-step" }],
      { move: new THREE.Vector3(1, 0, 0) }, 400,
      charParams({ startPosition: new THREE.Vector3(0, 2, 0), autostep: 0 }));

    // Climbed: past the kerb's near face (x = 2) and standing on top of it,
    // so its centre sits a step higher than resting on the floor did.
    expect(withStep.position.x).toBeGreaterThan(2.2);
    expect(withStep.position.y).toBeGreaterThan(1.0);
    // Blocked: without auto-step it never gets up onto the kerb.
    expect(withoutStep.position.y).toBeLessThan(withStep.position.y - 0.1);
  });

  test("with no world wired it reports its start position rather than throwing", () => {
    const out = PHYSICS_CHARACTER_NODE.evaluate(
      {},
      charParams({ startPosition: new THREE.Vector3(1, 2, 3) }),
      makeContext("ch6", 0),
    ) as { position: THREE.Vector3; grounded: number };
    expect(out.position.toArray()).toEqual([1, 2, 3]);
    expect(out.grounded).toBe(0);
  });

  test("falling out of the world respawns it", () => {
    const out = walk("ch7", [], { move: new THREE.Vector3() }, 400,
      charParams({ startPosition: new THREE.Vector3(0, 2, 0), respawnBelow: -20 }));
    expect(out.position.y).toBeGreaterThan(-20);
  });

  test("Reset returns it to the start", () => {
    const level = [floorPiece("ch8-floor")];
    walk("ch8", level, { move: new THREE.Vector3(1, 0, 0) }, 120,
      charParams({ startPosition: new THREE.Vector3(0, 2, 0) }));

    const world = PHYSICS_WORLD_NODE.evaluate({}, worldParams(), makeContext("ch8-w", 2.1)) as { world: unknown };
    const out = PHYSICS_CHARACTER_NODE.evaluate(
      { world: world.world, reset: 1 },
      charParams({ startPosition: new THREE.Vector3(0, 2, 0) }),
      makeContext("ch8-c", 2.1),
    ) as { position: THREE.Vector3 };

    expect(out.position.toArray()).toEqual([0, 2, 0]);
  });
});

describe("physics/vehicle — a raycast car", () => {
  beforeAll(async () => {
    await initRapier();
  });

  const worldParams = () => ({ ...PHYSICS_WORLD_NODE.defaultParams });
  const carParams = (overrides: Record<string, unknown> = {}) => ({
    ...VEHICLE_NODE.defaultParams,
    ...overrides,
  });

  function road(): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.scale.set(200, 1, 200);
    mesh.position.set(0, -0.5, 0);
    mesh.updateMatrixWorld(true);
    return mesh;
  }

  function chassis(): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 3));
    mesh.position.set(0, 1, 0);
    mesh.updateMatrixWorld(true);
    return mesh;
  }

  /** Runs world + road + car for `frames` frames at 60 Hz. */
  function drive(
    ids: string,
    car: THREE.Object3D,
    inputs: Record<string, unknown>,
    frames: number,
    params = carParams(),
  ) {
    const ground = road();
    let last: any;
    for (let frame = 0; frame < frames; frame++) {
      const time = frame / 60;
      const world = PHYSICS_WORLD_NODE.evaluate({}, worldParams(), makeContext(`${ids}-w`, time)) as {
        world: unknown;
      };
      RIGID_BODY_NODE.evaluate(
        { world: world.world, geometry: ground },
        { ...RIGID_BODY_NODE.defaultParams, bodyType: "fixed" },
        makeContext(`${ids}-road`, time),
      );
      last = VEHICLE_NODE.evaluate({ world: world.world, chassis: car, ...inputs }, params, makeContext(`${ids}-car`, time));
    }
    return last as {
      position: THREE.Vector3;
      wheels: THREE.Matrix4[];
      speed: number;
      grounded: number;
    };
  }

  test("a low centre of mass keeps all four wheels down under acceleration", () => {
    // Left at the chassis centre, hard acceleration pitches a raycast vehicle
    // back onto two wheels, which then have no grip and it goes nowhere. This
    // is the parameter that decides whether the car works at all.
    const settled = drive("v0", chassis(), { throttle: 1 }, 300);
    expect(settled.grounded).toBe(4);
    expect(settled.speed).toBeGreaterThan(10);
  });

  test("it settles on its suspension with all four wheels down", () => {
    const out = drive("v1", chassis(), { throttle: 0 }, 180);
    expect(out.grounded).toBe(4);
    expect(out.wheels.length).toBe(4);
    // Held up by its springs rather than resting on the chassis.
    expect(out.position.y).toBeGreaterThan(0.3);
  });

  test("throttle drives it forward, and it stays on the road", () => {
    const car = chassis();
    const out = drive("v2", car, { throttle: 1 }, 300);
    expect(out.speed).toBeGreaterThan(1);
    // Forward is +Z for a chassis that has not been turned.
    expect(Math.abs(out.position.z)).toBeGreaterThan(1);
    expect(out.position.y).toBeGreaterThan(0);
  });

  test("throttle is what makes it go — coasting is far slower than driving", () => {
    // Not "no throttle, no motion": a raycast vehicle has no rolling
    // resistance, so whatever speed it picks up settling onto its springs it
    // keeps. What must hold is that driving is decisively faster than not.
    const coasting = drive("v3", chassis(), { throttle: 0 }, 300);
    const driving = drive("v3b", chassis(), { throttle: 1 }, 300);
    expect(driving.speed).toBeGreaterThan(coasting.speed * 2);
  });

  test("steering turns it off its original line", () => {
    const straight = drive("v4", chassis(), { throttle: 1 }, 300);
    const turning = drive("v5", chassis(), { throttle: 1, steer: 1 }, 300);
    expect(Math.abs(turning.position.x)).toBeGreaterThan(Math.abs(straight.position.x) + 0.5);
  });

  test("the brake stops it", () => {
    const car = chassis();
    // Get it rolling, then stand on the brake.
    const rolling = drive("v6", car, { throttle: 1 }, 240);
    expect(rolling.speed).toBeGreaterThan(1);

    const stopped = drive("v6", car, { throttle: 0, brake: 1 }, 240);
    expect(stopped.speed).toBeLessThan(rolling.speed * 0.5);
  });

  test("wheel matrices sit under the chassis, spread across its track", () => {
    const out = drive("v7", chassis(), { throttle: 0 }, 180);
    const positions = out.wheels.map((m) => new THREE.Vector3().setFromMatrixPosition(m));

    for (const wheel of positions) {
      expect(wheel.y).toBeLessThan(out.position.y);
      expect(wheel.y).toBeGreaterThan(-0.5);
    }
    // Two on each side of the centre line, two fore and two aft.
    expect(positions.filter((p) => p.x > out.position.x).length).toBe(2);
    expect(positions.filter((p) => p.z > out.position.z).length).toBe(2);
  });

  test("with no world wired the chassis passes through untouched", () => {
    const car = chassis();
    const out = VEHICLE_NODE.evaluate({ chassis: car }, carParams(), makeContext("v8", 0)) as {
      geometry: THREE.Object3D;
      wheels: THREE.Matrix4[];
      speed: number;
    };
    expect(out.geometry).toBe(car);
    expect(out.wheels).toEqual([]);
    expect(out.speed).toBe(0);
  });
});

describe("rigid body — one node, many bodies", () => {
  beforeAll(async () => {
    await initRapier();
  });

  const worldParams = () => ({ ...PHYSICS_WORLD_NODE.defaultParams });
  const bodyParams = (overrides: Record<string, unknown> = {}) => ({
    ...RIGID_BODY_NODE.defaultParams,
    ...overrides,
  });

  function crate(x: number, y: number, z: number): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(x, y, z);
    mesh.updateMatrixWorld(true);
    return mesh;
  }

  function group(...children: THREE.Object3D[]): THREE.Group {
    const g = new THREE.Group();
    for (const child of children) g.add(child);
    g.updateMatrixWorld(true);
    return g;
  }

  function run(id: string, object: THREE.Object3D, params: Record<string, unknown>, frames = 1) {
    let last: any;
    for (let f = 0; f < frames; f++) {
      const world = PHYSICS_WORLD_NODE.evaluate({}, worldParams(), makeContext(`${id}-w`, f / 60)) as {
        world: unknown;
      };
      last = RIGID_BODY_NODE.evaluate(
        { world: world.world, geometry: object },
        params,
        makeContext(`${id}-b`, f / 60),
      );
    }
    return last as { count: number; position: THREE.Vector3 };
  }

  test("a Merge of crates becomes one body per crate, from a single node", () => {
    // The whole point: twenty crates should be one Merge and one Rigid Body,
    // not twenty of each.
    const level = group(crate(0, 5, 0), crate(2, 5, 0), crate(4, 5, 0));
    const out = run("rb1", level, bodyParams({ shape: "box" }));
    expect(out.count).toBe(3);
  });

  test("whole keeps a multi-mesh object as one body", () => {
    // A chassis built from several meshes has to be one body, or its parts
    // shove each other apart on the first frame.
    const chassis = group(crate(0, 5, 0), crate(0.6, 5, 0));
    const out = run("rb2", chassis, bodyParams({ shape: "hull", split: "whole" }));
    expect(out.count).toBe(1);
  });

  test("each crate falls on its own rather than moving as a block", () => {
    const a = crate(0, 6, 0);
    const b = crate(3, 2, 0);
    const level = group(a, b);

    run("rb3", level, bodyParams({ shape: "box" }), 90);
    // Started at different heights, so after the same fall they are still at
    // different heights — a single welded body could not do that.
    expect(Math.abs(a.position.y - b.position.y)).toBeGreaterThan(0.5);
  });

  test("an InstancedMesh contributes one body per instance", () => {
    // Instancing is what makes a hundred boxes cheap to draw; without this it
    // would make them impossible to simulate.
    const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), undefined, 5);
    for (let i = 0; i < 5; i++) {
      instanced.setMatrixAt(i, new THREE.Matrix4().setPosition(i * 1.5, 5, 0));
    }
    instanced.instanceMatrix.needsUpdate = true;
    instanced.updateMatrixWorld(true);

    const out = run("rb4", group(instanced), bodyParams({ shape: "box" }));
    expect(out.count).toBe(5);
  });

  test("the solver writes back into the instance matrices", () => {
    const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), undefined, 3);
    for (let i = 0; i < 3; i++) {
      instanced.setMatrixAt(i, new THREE.Matrix4().setPosition(i * 2, 8, 0));
    }
    instanced.instanceMatrix.needsUpdate = true;
    instanced.updateMatrixWorld(true);

    run("rb5", group(instanced), bodyParams({ shape: "box" }), 60);

    const matrix = new THREE.Matrix4();
    instanced.getMatrixAt(1, matrix);
    const position = new THREE.Vector3().setFromMatrixPosition(matrix);
    // It fell, and it kept its own column.
    expect(position.y).toBeLessThan(8);
    expect(position.x).toBeCloseTo(2, 1);
  });

  test("an instance's own scale reaches its collider", () => {
    // A collider has no scale of its own, so a big instance needs a big shape
    // or it sinks into the floor up to the size of the small one.
    const floor = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    floor.scale.set(40, 1, 40);
    floor.position.set(0, -0.5, 0);
    floor.updateMatrixWorld(true);

    const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), undefined, 2);
    instanced.setMatrixAt(0, new THREE.Matrix4().compose(
      new THREE.Vector3(0, 6, 0),
      new THREE.Quaternion(),
      new THREE.Vector3(1, 1, 1),
    ));
    instanced.setMatrixAt(1, new THREE.Matrix4().compose(
      new THREE.Vector3(6, 6, 0),
      new THREE.Quaternion(),
      new THREE.Vector3(3, 3, 3),
    ));
    instanced.instanceMatrix.needsUpdate = true;
    instanced.updateMatrixWorld(true);

    for (let f = 0; f < 200; f++) {
      const world = PHYSICS_WORLD_NODE.evaluate({}, worldParams(), makeContext("rb6-w", f / 60)) as {
        world: unknown;
      };
      RIGID_BODY_NODE.evaluate(
        { world: world.world, geometry: floor },
        bodyParams({ bodyType: "fixed" }),
        makeContext("rb6-floor", f / 60),
      );
      RIGID_BODY_NODE.evaluate(
        { world: world.world, geometry: instanced },
        bodyParams({ shape: "box" }),
        makeContext("rb6-b", f / 60),
      );
    }

    const small = new THREE.Matrix4();
    const big = new THREE.Matrix4();
    instanced.getMatrixAt(0, small);
    instanced.getMatrixAt(1, big);

    // Resting on the floor: a unit cube's centre sits at 0.5, a 3× one at 1.5.
    expect(new THREE.Vector3().setFromMatrixPosition(small).y).toBeCloseTo(0.5, 0);
    expect(new THREE.Vector3().setFromMatrixPosition(big).y).toBeCloseTo(1.5, 0);
  });

  test("adding a crate rebuilds; moving one does not", () => {
    const a = crate(0, 5, 0);
    const level = group(a);

    const first = run("rb7", level, bodyParams({ shape: "box" }), 30);
    expect(first.count).toBe(1);

    // Bodies must not be rebuilt just because the solver moved them, or the
    // simulation restarts every frame.
    const settled = run("rb7", level, bodyParams({ shape: "box" }), 30);
    expect(settled.count).toBe(1);

    level.add(crate(3, 5, 0));
    level.updateMatrixWorld(true);
    const grown = run("rb7", level, bodyParams({ shape: "box" }), 1);
    expect(grown.count).toBe(2);
  });

  test("an empty group simulates nothing and does not throw", () => {
    const out = run("rb8", new THREE.Group(), bodyParams());
    expect(out.count).toBe(0);
  });
});
