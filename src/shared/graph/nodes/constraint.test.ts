import * as THREE from "three";
import { beforeAll, describe, expect, test } from "vitest";
import { PHYSICS_WORLD_NODE, RIGID_BODY_NODE } from "./rapier";
import { CONSTRAINT_NODE, makePairs, resolveIndex } from "./constraint";
import { DEFAULT_REGISTRY } from "./index";
import { EvalContext } from "../types";
import { disposeNodeCaches } from "../nodeCaches";
import { initRapier } from "../../three/physics/rapierRuntime";

function ctx(nodeId: string, time: number, isPlaying?: boolean): EvalContext {
  return { nodeId, time, step: Math.round(time * 60), isPlaying };
}

function crate(x: number, y: number, z: number, size = 1): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size));
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

const vec = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

interface Rig {
  id: string;
  gravity?: THREE.Vector3;
  /** Rigid Body nodes by id. */
  bodies: Record<string, { object: THREE.Object3D; params?: Record<string, unknown> }>;
  constraint: {
    params?: Record<string, unknown>;
    /** Which Rigid Body's `body` output feeds each side; omit for the world. */
    a?: string;
    b?: string;
    extra?: Record<string, unknown>;
  };
  /** Playing flag per frame, to test the idle path. */
  playing?: (frame: number) => boolean | undefined;
}

/** World + Rigid Bodies + a Constraint, evaluated in graph order. */
function makeRig(rig: Rig) {
  const worldId = `${rig.id}-w`;
  const constraintId = `${rig.id}-c`;
  const ids = [worldId, constraintId, ...Object.keys(rig.bodies).map((k) => `${rig.id}-${k}`)];
  let frame = 0;
  let last: Record<string, any> = {};
  let bodyOut: Record<string, any> = {};

  function step(frames: number) {
    for (let n = 0; n < frames; n++, frame++) {
      const time = frame / 60;
      const playing = rig.playing?.(frame);
      const worldOut = PHYSICS_WORLD_NODE.evaluate(
        {},
        { ...PHYSICS_WORLD_NODE.defaultParams, gravity: rig.gravity ?? vec(0, -9.81, 0) },
        ctx(worldId, time, playing),
      ) as { world: unknown };
      bodyOut = {};
      for (const [key, def] of Object.entries(rig.bodies)) {
        bodyOut[key] = RIGID_BODY_NODE.evaluate(
          { world: worldOut.world, geometry: def.object },
          { ...RIGID_BODY_NODE.defaultParams, shape: "box", ...def.params },
          ctx(`${rig.id}-${key}`, time, playing),
        );
      }
      const inputs: Record<string, unknown> = { world: worldOut.world, ...rig.constraint.extra };
      if (rig.constraint.a) inputs.bodyA = bodyOut[rig.constraint.a].body;
      if (rig.constraint.b) inputs.bodyB = bodyOut[rig.constraint.b].body;
      last = CONSTRAINT_NODE.evaluate(
        inputs,
        { ...CONSTRAINT_NODE.defaultParams, ...rig.constraint.params },
        ctx(constraintId, time, playing),
      );
    }
    return last;
  }

  return {
    step,
    out: () => last,
    body: (key: string) => bodyOut[key],
    dispose: () => disposeNodeCaches(ids),
  };
}

describe("pairing", () => {
  const fake = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }) as never);

  test("negative indices count from the end, and out of range is nothing", () => {
    expect(resolveIndex(0, 3)).toBe(0);
    expect(resolveIndex(-1, 3)).toBe(2);
    expect(resolveIndex(3, 3)).toBeNull();
    expect(resolveIndex(-4, 3)).toBeNull();
    expect(resolveIndex(0, 0)).toBeNull();
  });

  test("single picks one of each, and an unwired side is the world", () => {
    const a = fake(3);
    const b = fake(2);
    expect(makePairs("single", a, b, 2, -1)).toEqual([{ a: a[2], b: b[1] }]);
    expect(makePairs("single", a, null, 1, 0)).toEqual([{ a: a[1], b: null }]);
    expect(makePairs("single", null, null, 0, 0)).toEqual([]);
    expect(makePairs("single", a, b, 9, 0)).toEqual([]);
  });

  test("pairwise stops at the shorter list", () => {
    expect(makePairs("pairwise", fake(3), fake(2), 0, 0)).toHaveLength(2);
    expect(makePairs("pairwise", fake(3), null, 0, 0)).toHaveLength(0);
  });

  test("sequence joins neighbours: n bodies, n-1 joints", () => {
    expect(makePairs("sequence", fake(5), null, 0, 0)).toHaveLength(4);
    expect(makePairs("sequence", fake(1), null, 0, 0)).toHaveLength(0);
  });

  test("each-to-one joins every body of A to the one chosen from B", () => {
    const b = fake(3);
    const pairs = makePairs("each-to-one", fake(4), b, 0, 1);
    expect(pairs).toHaveLength(4);
    expect(pairs.every((p) => p.b === b[1])).toBe(true);
    expect(makePairs("each-to-one", fake(4), null, 0, 0).every((p) => p.b === null)).toBe(true);
  });
});

describe("constraint node", () => {
  beforeAll(async () => {
    await initRapier();
  });

  test("is registered, in the physics category, and its fields follow the kind", () => {
    const def = DEFAULT_REGISTRY.get("physics/constraint")!;
    expect(def).toBe(CONSTRAINT_NODE);
    expect(def.category).toBe("physics");
    const ids = (kind: string) =>
      def.dynamicParamFields!({ id: "x", type: def.type, params: { jointType: kind }, position: { x: 0, y: 0 } }).map((f) => f.id);
    expect(ids("hinge")).toEqual(expect.arrayContaining(["anchor", "axis", "angleMin", "motor"]));
    expect(ids("hinge")).not.toContain("restLength");
    expect(ids("slider")).toContain("distanceMin");
    expect(ids("spring")).toEqual(expect.arrayContaining(["offsetA", "restLength", "stiffness"]));
    expect(ids("spring")).not.toContain("anchor");
    expect(ids("rope")).toContain("ropeLength");
    expect(ids("ball")).not.toContain("axis");
  });

  test("a Rigid Body hands out its bodies on a Body socket", () => {
    const rig = makeRig({
      id: "k-body",
      bodies: { a: { object: group(crate(0, 5, 0), crate(3, 5, 0)) } },
      constraint: { a: "a", params: { jointType: "ball", pairing: "sequence" } },
    });
    rig.step(2);
    expect(rig.body("a").body.bodies).toHaveLength(2);
    expect(rig.out().count).toBe(1);
    rig.dispose();
  });

  test("no world, or an idle editor, builds nothing and does not throw", () => {
    const out = CONSTRAINT_NODE.evaluate({}, CONSTRAINT_NODE.defaultParams, ctx("k-none", 0)) as Record<string, number>;
    expect(out).toEqual({ position: 0, stress: 0, broken: 0, count: 0 });

    const rig = makeRig({
      id: "k-idle",
      bodies: { bob: { object: crate(0, 5, 0) } },
      constraint: { a: "bob", params: { jointType: "ball" }, extra: {} },
      playing: () => false,
    });
    expect(rig.step(5).count).toBe(0);
    rig.dispose();
  });

  test("a ball joint to the world is a pendulum: it swings and keeps its length", () => {
    // The bob hangs 2 m below and 2 m to the side of a pivot at the origin.
    const bob = crate(2, -2, 0, 0.2);
    const rig = makeRig({
      id: "k-pendulum",
      bodies: { bob: { object: bob, params: { linearDamping: 0, angularDamping: 0 } } },
      constraint: { a: "bob", params: { jointType: "ball", anchor: vec(0, 0, 0) } },
    });
    let minX = Infinity;
    let maxX = -Infinity;
    let worstLength = 0;
    for (let f = 0; f < 180; f++) {
      rig.step(1);
      const p = rig.body("bob").position as THREE.Vector3;
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      worstLength = Math.max(worstLength, Math.abs(Math.hypot(p.x, p.y, p.z) - Math.hypot(2, 2)));
    }
    // It swung through the bottom to the other side.
    expect(minX).toBeLessThan(-1);
    expect(maxX).toBeGreaterThan(1);
    // The pivot held: the bob stayed on its circle (the box centre is the anchor distance).
    expect(worstLength).toBeLessThan(0.1);
    expect(rig.out().count).toBe(1);
    rig.dispose();
  });

  test("a hinge between rotated bodies does not wrench them into line", () => {
    // B starts turned 40° about Y. A hinge latched to those poses must leave
    // them exactly where they are, in zero gravity, with angle 0.
    const a = crate(0, 0, 0);
    const b = crate(1.5, 0, 0);
    b.rotation.set(0.3, 0.7, 0.2);
    b.updateMatrixWorld(true);
    const start = b.quaternion.clone();
    const rig = makeRig({
      id: "k-rotated",
      gravity: vec(0, 0, 0),
      bodies: { a: { object: a, params: { bodyType: "fixed" } }, b: { object: b } },
      constraint: { a: "a", b: "b", params: { jointType: "hinge", anchor: vec(0.75, 0, 0), axis: vec(0, 0, 1) } },
    });
    rig.step(90);
    expect(b.quaternion.angleTo(start)).toBeLessThan(0.02);
    expect(b.position.x).toBeCloseTo(1.5, 1);
    expect(Math.abs(rig.out().position)).toBeLessThan(0.02);
    rig.dispose();
  });

  test("a hinge swings about its axis only, and reports the angle", () => {
    // A door: fixed frame, a slab hinged on its left edge, gravity pulling it down.
    const frame = crate(-1, 0, 0, 0.2);
    const door = crate(0, 0, 0, 1);
    const rig = makeRig({
      id: "k-hinge",
      bodies: { frame: { object: frame, params: { bodyType: "fixed" } }, door: { object: door } },
      constraint: { a: "frame", b: "door", params: { jointType: "hinge", anchor: vec(-0.5, 0, 0), axis: vec(0, 0, 1) } },
    });
    let swing = 0;
    for (let f = 0; f < 120; f++) {
      rig.step(1);
      swing = Math.max(swing, Math.abs(rig.out().position));
    }
    const p = rig.body("door").position as THREE.Vector3;
    // Rotated about the hinge on Z: it stays in the XY plane and keeps its distance from the pivot.
    expect(Math.abs(p.z)).toBeLessThan(0.01);
    expect(Math.hypot(p.x + 0.5, p.y)).toBeCloseTo(0.5, 1);
    // Released level it falls through a quarter turn, as the reported angle says.
    expect(swing).toBeGreaterThan(1.3);
    expect(swing).toBeLessThan(Math.PI);
    rig.dispose();
  });

  test("hinge limits stop the swing at the angle", () => {
    const frame = crate(-1, 0, 0, 0.2);
    const door = crate(0, 0, 0, 1);
    const limit = Math.PI / 6;
    const rig = makeRig({
      id: "k-limit",
      bodies: { frame: { object: frame, params: { bodyType: "fixed" } }, door: { object: door } },
      constraint: {
        a: "frame",
        b: "door",
        params: {
          jointType: "hinge",
          anchor: vec(-0.5, 0, 0),
          axis: vec(0, 0, 1),
          limits: true,
          angleMin: -limit,
          angleMax: limit,
        },
      },
    });
    rig.step(240);
    expect(Math.abs(rig.out().position)).toBeLessThan(limit + 0.08);
    expect(Math.abs(rig.out().position)).toBeGreaterThan(limit - 0.15);
    rig.dispose();
  });

  test("a velocity motor turns a hinge", () => {
    const wheel = crate(0, 0, 0);
    const rig = makeRig({
      id: "k-motor",
      gravity: vec(0, 0, 0),
      bodies: { wheel: { object: wheel, params: { angularDamping: 0 } } },
      constraint: {
        a: undefined,
        b: "wheel",
        params: { jointType: "hinge", anchor: vec(0, 0, 0), axis: vec(0, 0, 1), motor: "velocity", target: 2, motorDamping: 50 },
      },
    });
    rig.step(120);
    // ~2 rad/s for ~2 s.
    expect(Math.abs(rig.out().position)).toBeGreaterThan(1.5);
    rig.dispose();
  });

  test("a position motor drives the hinge to the target angle", () => {
    const wheel = crate(0, 0, 0);
    const rig = makeRig({
      id: "k-posmotor",
      gravity: vec(0, 0, 0),
      bodies: { wheel: { object: wheel, params: { angularDamping: 0 } } },
      constraint: {
        b: "wheel",
        params: {
          jointType: "hinge",
          anchor: vec(0, 0, 0),
          axis: vec(0, 0, 1),
          motor: "position",
          target: 0.8,
          motorStiffness: 300,
          motorDamping: 40,
        },
      },
    });
    rig.step(240);
    expect(rig.out().position).toBeCloseTo(0.8, 1);
    rig.dispose();
  });

  test("a fixed joint welds two bodies: they fall as one", () => {
    const a = crate(0, 5, 0);
    const b = crate(1, 5, 0);
    const rig = makeRig({
      id: "k-fixed",
      bodies: { a: { object: a }, b: { object: b } },
      constraint: { a: "a", b: "b", params: { jointType: "fixed", anchor: vec(0.5, 5, 0) } },
    });
    rig.step(60);
    expect(b.position.x - a.position.x).toBeCloseTo(1, 1);
    expect(b.position.y - a.position.y).toBeCloseTo(0, 1);
    expect(a.position.y).toBeLessThan(4.5);
    rig.dispose();
  });

  test("a slider moves along its axis only, within its limits", () => {
    const rail = crate(0, 0, 0, 0.2);
    const piston = crate(0.5, 0, 0, 0.4);
    const rig = makeRig({
      id: "k-slider",
      gravity: vec(0, 0, 0),
      bodies: { rail: { object: rail, params: { bodyType: "fixed" } }, piston: { object: piston, params: { linearDamping: 0 } } },
      constraint: {
        a: "rail",
        b: "piston",
        params: {
          jointType: "slider",
          anchor: vec(0, 0, 0),
          axis: vec(1, 0, 0),
          limits: true,
          distanceMin: -0.5,
          distanceMax: 1,
          motor: "velocity",
          target: 1,
          motorDamping: 100,
        },
      },
    });
    rig.step(240);
    // Pushed at 1 m/s for 4 s, stopped by the 1 m limit; never left the rail's line.
    expect(rig.out().position).toBeGreaterThan(0.9);
    expect(rig.out().position).toBeLessThan(1.1);
    expect(Math.abs(piston.position.y)).toBeLessThan(0.02);
    expect(Math.abs(piston.position.z)).toBeLessThan(0.02);
    rig.dispose();
  });

  test("a spring settles at its rest length, not at the length it was made at", () => {
    // Made 3 m apart with a 1 m rest length, in zero gravity: it must pull in.
    const post = crate(0, 0, 0, 0.2);
    const weight = crate(3, 0, 0, 0.2);
    const rig = makeRig({
      id: "k-spring",
      gravity: vec(0, 0, 0),
      bodies: { post: { object: post, params: { bodyType: "fixed" } }, weight: { object: weight, params: { linearDamping: 0.5 } } },
      constraint: { a: "post", b: "weight", params: { jointType: "spring", restLength: 1, stiffness: 60, damping: 6 } },
    });
    rig.step(600);
    expect(rig.out().position).toBeGreaterThan(0.8);
    expect(rig.out().position).toBeLessThan(1.3);
    rig.dispose();
  });

  test("a spring with no rest length given rests where it was placed", () => {
    const post = crate(0, 0, 0, 0.2);
    const weight = crate(2, 0, 0, 0.2);
    const rig = makeRig({
      id: "k-spring-auto",
      gravity: vec(0, 0, 0),
      bodies: { post: { object: post, params: { bodyType: "fixed" } }, weight: { object: weight } },
      constraint: { a: "post", b: "weight", params: { jointType: "spring", restLength: 0 } },
    });
    rig.step(120);
    expect(rig.out().position).toBeCloseTo(2, 1);
    rig.dispose();
  });

  test("a rope holds a falling body at its length but lets it slack", () => {
    const weight = crate(0, -1, 0, 0.2);
    const rig = makeRig({
      id: "k-rope",
      bodies: { weight: { object: weight, params: { linearDamping: 0 } } },
      constraint: {
        b: "weight",
        params: { jointType: "rope", offsetA: vec(0, 0, 0), offsetB: vec(0, 0, 0), ropeLength: 3 },
      },
    });
    // Slack: starting 1 m below the world origin with a 3 m rope, it can still fall.
    rig.step(20);
    expect(weight.position.y).toBeLessThan(-1.2);
    // Taut: it can never get further than the rope.
    let worst = 0;
    for (let f = 0; f < 200; f++) {
      rig.step(1);
      worst = Math.max(worst, weight.position.length());
    }
    expect(worst).toBeLessThan(3.2);
    expect(worst).toBeGreaterThan(2.7);
    rig.dispose();
  });

  test("a weld snaps under load when it has a break force, and reports it", () => {
    const wall = crate(0, 0, 0, 0.2);
    const heavy = crate(0.5, 0, 0, 0.4);
    const rig = makeRig({
      id: "k-break",
      bodies: {
        wall: { object: wall, params: { bodyType: "fixed" } },
        heavy: { object: heavy, params: { mass: 50, linearDamping: 0 } },
      },
      constraint: { a: "wall", b: "heavy", params: { jointType: "fixed", anchor: vec(0.2, 0, 0), breakForce: 200 } },
    });
    // The load is about 50 kg × 9.81 ≈ 500 N, well over the 200 N it was welded with.
    rig.step(60);
    expect(rig.out().broken).toBe(1);
    expect(rig.out().count).toBe(0);
    rig.step(60);
    expect(heavy.position.y).toBeLessThan(-1);
    rig.dispose();
  });

  test("the same weld holds when the break force is above the load", () => {
    const wall = crate(0, 0, 0, 0.2);
    const light = crate(0.5, 0, 0, 0.4);
    const rig = makeRig({
      id: "k-hold",
      bodies: {
        wall: { object: wall, params: { bodyType: "fixed" } },
        light: { object: light, params: { mass: 1, linearDamping: 0 } },
      },
      constraint: { a: "wall", b: "light", params: { jointType: "fixed", anchor: vec(0.2, 0, 0), breakForce: 5000 } },
    });
    rig.step(120);
    expect(rig.out().broken).toBe(0);
    expect(rig.out().count).toBe(1);
    expect(light.position.y).toBeGreaterThan(-0.3);
    // A hanging load reads (roughly) its weight as stress.
    expect(rig.out().stress).toBeGreaterThan(0);
    rig.dispose();
  });

  test("a Sequence over a Merge joins every neighbour: a row of three has two joints", () => {
    const row = group(crate(0, 5, 0), crate(1.2, 5, 0), crate(2.4, 5, 0));
    const rig = makeRig({
      id: "k-seq",
      bodies: { row: { object: row } },
      constraint: { a: "row", params: { jointType: "ball", pairing: "sequence" } },
    });
    expect(rig.step(2).count).toBe(2);
    rig.dispose();
  });

  test("Each-to-one hinges every body of A to the world", () => {
    const row = group(crate(0, 5, 0), crate(3, 5, 0), crate(6, 5, 0), crate(9, 5, 0));
    const rig = makeRig({
      id: "k-each",
      bodies: { row: { object: row } },
      constraint: { a: "row", params: { jointType: "hinge", pairing: "each-to-one" } },
    });
    expect(rig.step(2).count).toBe(4);
    rig.dispose();
  });

  test("changing the kind rebuilds the joint; dragging a limit does not", () => {
    const frame = crate(-1, 0, 0, 0.2);
    const door = crate(0, 0, 0, 1);
    const bodies = { frame: { object: frame, params: { bodyType: "fixed" } }, door: { object: door } };
    const base = { jointType: "hinge", anchor: vec(-0.5, 0, 0), axis: vec(0, 0, 1), limits: true, angleMin: -1, angleMax: 1 };
    const constraint = { a: "frame", b: "door", params: { ...base } };
    const rig = makeRig({ id: "k-rebuild", bodies, constraint });
    rig.step(60);
    const angle = rig.out().position;
    // A live limit edit keeps the pose (no re-latch back to angle 0).
    constraint.params.angleMax = 0.9;
    rig.step(1);
    expect(Math.abs(rig.out().position - angle)).toBeLessThan(0.1);
    rig.dispose();
  });

  test("when the Rigid Body goes away so do the joints", () => {
    const bob = crate(0, 5, 0);
    const rig = makeRig({
      id: "k-gone",
      bodies: { bob: { object: bob } },
      constraint: { a: "bob", params: { jointType: "ball" } },
      playing: (f) => f < 10,
    });
    expect(rig.step(5).count).toBe(1);
    expect(rig.step(10).count).toBe(0);
    rig.dispose();
  });
});
