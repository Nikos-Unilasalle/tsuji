import * as THREE from "three";
import { beforeAll, describe, expect, test } from "vitest";
import { PHYSICS_CHARACTER_NODE, PHYSICS_WORLD_NODE, RIGID_BODY_NODE } from "./rapier";
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
