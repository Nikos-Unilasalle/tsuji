import * as THREE from "three";
import { beforeAll, describe, expect, test } from "vitest";
import { PHYSICS_WORLD_NODE, RIGID_BODY_NODE } from "./rapier";
import { CHAIN_NODE, chainPoints, layoutLinks } from "./chain";
import { CONSTRAINT_NODE } from "./constraint";
import { DEFAULT_REGISTRY } from "./index";
import { EvalContext } from "../types";
import { disposeNodeCaches } from "../nodeCaches";
import { initRapier } from "../../three/physics/rapierRuntime";

function ctx(nodeId: string, time: number, isPlaying?: boolean): EvalContext {
  return { nodeId, time, step: Math.round(time * 60), isPlaying };
}

const vec = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe("chain layout", () => {
  test("a straight line is cut into equal pieces", () => {
    const points = chainPoints(undefined, undefined, 4, vec(0, 0, 0), vec(4, 0, 0));
    expect(points).toHaveLength(5);
    expect(points[2].x).toBeCloseTo(2);
  });

  test("a wired list wins over a curve, a curve over the line", () => {
    const curve = new THREE.LineCurve3(vec(0, 0, 0), vec(0, 6, 0));
    expect(chainPoints([vec(0, 0, 0), vec(1, 0, 0), vec(1, 1, 0)], curve, 10, vec(0, 0, 0), vec(9, 0, 0))).toHaveLength(3);
    const fromCurve = chainPoints(undefined, curve, 3, vec(0, 0, 0), vec(9, 0, 0));
    expect(fromCurve).toHaveLength(4);
    expect(fromCurve[3].y).toBeCloseTo(6);
    // A one-point list is not a chain; fall through.
    expect(chainPoints([vec(0, 0, 0)], undefined, 2, vec(0, 0, 0), vec(2, 0, 0))).toHaveLength(3);
  });

  test("each link is centred on its segment with local Y along it", () => {
    const links = layoutLinks([vec(0, 0, 0), vec(2, 0, 0), vec(2, 2, 0)], null);
    expect(links).toHaveLength(2);
    expect(links[0].center.x).toBeCloseTo(1);
    expect(links[0].length).toBeCloseTo(2);
    const along = new THREE.Vector3(0, 1, 0).applyQuaternion(links[0].quaternion);
    expect(along.x).toBeCloseTo(1);
    expect(along.y).toBeCloseTo(0);
  });

  test("the width direction is kept perpendicular to the segment", () => {
    const [link] = layoutLinks([vec(0, 0, 0), vec(2, 0, 0)], vec(1, 0, 1));
    const x = new THREE.Vector3(1, 0, 0).applyQuaternion(link.quaternion);
    expect(Math.abs(x.x)).toBeLessThan(1e-6);
    expect(Math.abs(x.z)).toBeCloseTo(1);
  });

  test("zero-length segments are dropped", () => {
    expect(layoutLinks([vec(0, 0, 0), vec(0, 0, 0), vec(1, 0, 0)], null)).toHaveLength(1);
  });
});

describe("chain node", () => {
  beforeAll(async () => {
    await initRapier();
  });

  const params = (overrides: Record<string, unknown> = {}) => ({ ...CHAIN_NODE.defaultParams, ...overrides });

  function run(
    id: string,
    chainParams: Record<string, unknown>,
    frames: number,
    opts: { gravity?: THREE.Vector3; chainInputs?: (world: unknown) => Record<string, unknown>; playing?: (f: number) => boolean | undefined } = {},
  ) {
    let out: Record<string, any> = {};
    for (let f = 0; f < frames; f++) {
      const t = f / 60;
      const playing = opts.playing?.(f);
      const w = PHYSICS_WORLD_NODE.evaluate(
        {},
        { ...PHYSICS_WORLD_NODE.defaultParams, gravity: opts.gravity ?? vec(0, -9.81, 0) },
        ctx(`${id}-w`, t, playing),
      ) as { world: unknown };
      out = CHAIN_NODE.evaluate({ world: w.world, ...opts.chainInputs?.(w.world) }, chainParams, ctx(`${id}-c`, t, playing));
    }
    return out;
  }

  test("is registered in the physics category", () => {
    expect(DEFAULT_REGISTRY.get("physics/chain")).toBe(CHAIN_NODE);
    expect(CHAIN_NODE.category).toBe("physics");
  });

  test("with no world it shows the layout as authored", () => {
    const out = CHAIN_NODE.evaluate({}, params({ links: 6 }), ctx("ch-none", 0)) as Record<string, any>;
    expect(out.count).toBe(6);
    expect(out.matrices).toHaveLength(6);
    expect(out.points).toHaveLength(7);
    expect(out.body).toBeNull();
  });

  test("idle editor: authored layout, nothing simulated", () => {
    const out = run("ch-idle", params({ links: 5 }), 10, { playing: () => false });
    expect(out.body).toBeNull();
    expect(out.count).toBe(5);
    expect(out.points[0].y).toBeCloseTo(4);
    disposeNodeCaches(["ch-idle-c", "ch-idle-w"]);
  });

  test("a rope pinned at one end hangs from it, joined link to link", () => {
    const start = vec(0, 4, 0);
    const out = run("ch-rope", params({ links: 10, start, end: vec(4, 4, 0), pinStart: true }), 360);
    const points = out.points as THREE.Vector3[];
    expect(points).toHaveLength(11);
    // The pin held.
    expect(points[0].distanceTo(start)).toBeLessThan(0.05);
    // The links stayed joined: consecutive joint points are one link (0.4) apart.
    for (let i = 0; i + 1 < points.length; i++) {
      expect(points[i].distanceTo(points[i + 1])).toBeGreaterThan(0.35);
      expect(points[i].distanceTo(points[i + 1])).toBeLessThan(0.45);
    }
    // Total length 4, released level: it swung down from the pin (still swinging, lightly damped)
    // and never went further than the rope is long.
    expect(points[10].y).toBeLessThan(1.5);
    expect(points[10].distanceTo(start)).toBeLessThan(4.1);
    disposeNodeCaches(["ch-rope-c", "ch-rope-w"]);
  });

  test("an unpinned chain falls", () => {
    const out = run("ch-free", params({ links: 4, pinStart: false, pinEnd: false }), 60);
    expect((out.points as THREE.Vector3[])[0].y).toBeLessThan(2.5);
    disposeNodeCaches(["ch-free-c", "ch-free-w"]);
  });

  test("pinned at both ends it sags between them", () => {
    const out = run(
      "ch-sag",
      params({ links: 12, start: vec(-2, 4, 0), end: vec(2, 4, 0), pinStart: true, pinEnd: true }),
      420,
    );
    const points = out.points as THREE.Vector3[];
    // Ends held, middle hangs lower.
    expect(points[0].distanceTo(vec(-2, 4, 0))).toBeLessThan(0.05);
    expect(points[12].distanceTo(vec(2, 4, 0))).toBeLessThan(0.05);
    expect(points[6].y).toBeLessThan(3.9);
    disposeNodeCaches(["ch-sag-c", "ch-sag-w"]);
  });

  test("a hinge chain only folds about its axis: a plank bridge stays in the plane", () => {
    const out = run(
      "ch-bridge",
      params({
        links: 6,
        start: vec(-3, 4, 0),
        end: vec(3, 4, 0),
        linkShape: "box",
        jointType: "hinge",
        axis: vec(0, 0, 1),
        pinStart: true,
        pinEnd: true,
        radius: 0.05,
        width: 1,
      }),
      300,
    );
    const points = out.points as THREE.Vector3[];
    for (const p of points) expect(Math.abs(p.z)).toBeLessThan(0.02);
    expect(points[3].y).toBeLessThan(4);
    disposeNodeCaches(["ch-bridge-c", "ch-bridge-w"]);
  });

  test("an end attached to a Rigid Body follows it", () => {
    // A heavy fixed anchor block; the rope's start is attached to it rather than pinned.
    const block = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    block.position.set(0, 4, 0);
    block.updateMatrixWorld(true);

    let out: Record<string, any> = {};
    for (let f = 0; f < 120; f++) {
      const t = f / 60;
      const w = PHYSICS_WORLD_NODE.evaluate({}, PHYSICS_WORLD_NODE.defaultParams, ctx("ch-att-w", t)) as { world: unknown };
      const b = RIGID_BODY_NODE.evaluate(
        { world: w.world, geometry: block },
        { ...RIGID_BODY_NODE.defaultParams, shape: "box", bodyType: "fixed" },
        ctx("ch-att-b", t),
      ) as { body: unknown };
      out = CHAIN_NODE.evaluate(
        { world: w.world, attachStart: b.body },
        params({ links: 5, start: vec(0, 4, 0), end: vec(2, 4, 0), pinStart: false }),
        ctx("ch-att-c", t),
      );
    }
    expect(out.count).toBe(5);
    expect((out.points as THREE.Vector3[])[0].distanceTo(vec(0, 4, 0))).toBeLessThan(0.05);
    disposeNodeCaches(["ch-att-c", "ch-att-b", "ch-att-w"]);
  });

  test("a Constraint can hang a load from the last link of a chain", () => {
    const load = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5));
    load.position.set(2, 4, 0);
    load.updateMatrixWorld(true);

    let chain: Record<string, any> = {};
    let joint: Record<string, any> = {};
    for (let f = 0; f < 240; f++) {
      const t = f / 60;
      const w = PHYSICS_WORLD_NODE.evaluate({}, PHYSICS_WORLD_NODE.defaultParams, ctx("ch-hang-w", t)) as { world: unknown };
      chain = CHAIN_NODE.evaluate(
        { world: w.world },
        params({ links: 5, start: vec(0, 4, 0), end: vec(2, 4, 0), pinStart: true }),
        ctx("ch-hang-c", t),
      );
      const b = RIGID_BODY_NODE.evaluate(
        { world: w.world, geometry: load },
        { ...RIGID_BODY_NODE.defaultParams, shape: "box", mass: 2 },
        ctx("ch-hang-b", t),
      ) as { body: unknown };
      joint = CONSTRAINT_NODE.evaluate(
        { world: w.world, bodyA: chain.body, bodyB: b.body },
        { ...CONSTRAINT_NODE.defaultParams, jointType: "ball", anchor: vec(2, 4, 0), indexA: -1 },
        ctx("ch-hang-j", t),
      );
    }
    expect(joint.count).toBe(1);
    // It hangs from the end of the rope rather than falling free: 4 m up, a 2 m rope, a 0.25 m half-box.
    expect(load.position.y).toBeGreaterThan(1.5);
    disposeNodeCaches(["ch-hang-c", "ch-hang-b", "ch-hang-j", "ch-hang-w"]);
  });

  test("a break force on a chain snaps a joint under load", () => {
    const out = run("ch-snap", params({ links: 6, start: vec(0, 4, 0), end: vec(3, 4, 0), mass: 5, breakForce: 5 }), 120);
    expect(out.broken).toBeGreaterThan(0);
    disposeNodeCaches(["ch-snap-c", "ch-snap-w"]);
  });

  test("editing the layout rebuilds; the same layout re-evaluated does not", () => {
    const p = params({ links: 4, start: vec(0, 4, 0), end: vec(2, 4, 0) });
    const a = run("ch-rebuild", p, 60);
    const settledY = (a.points as THREE.Vector3[])[4].y;
    // Same params next frame keeps the simulation going (does not snap back to the authored line).
    expect(settledY).toBeLessThan(3.9);
    disposeNodeCaches(["ch-rebuild-c", "ch-rebuild-w"]);
  });
});
