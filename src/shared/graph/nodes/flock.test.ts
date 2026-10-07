import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { FLOCK_NODE } from "./flock";
import { EvalContext } from "../types";
import { STEP_SECONDS } from "../clock";
import { callFlock, createFlockState, FlockParams, resizeFlock, scatterFlock } from "../flock/state";
import { stepFlock } from "../flock/steering";
import { collectObstacles, makeAvoider, Avoidance } from "../obstacles";

const ctx = (nodeId: string, step: number, extra: Partial<EvalContext> = {}): EvalContext => ({ nodeId, step, time: step * STEP_SECONDS, ...extra });

function params(overrides: Partial<FlockParams> = {}): FlockParams {
  return {
    mode: "plane",
    seed: 1,
    swimStates: true,
    speed: 1.2,
    turnRate: (120 * Math.PI) / 180,
    variation: 0.35,
    wander: 0.6,
    cohesion: 0.5,
    alignment: 0.6,
    separation: 1.4,
    edge: 2,
    neighborRadius: 1.5,
    separationDistance: 0.5,
    boundsCenter: { x: 0, y: 0, z: 0 },
    boundsSize: { x: 10, y: 1, z: 6 },
    edgeMargin: 1,
    target: { x: 0, y: 0, z: 0 },
    targetWeight: 0,
    circle: 0.6,
    arriveRadius: 1,
    callDuration: 2.5,
    callSpread: 0.6,
    maxPitch: (35 * Math.PI) / 180,
    bank: 0.5,
    obstacle: 0,
    ...overrides,
  };
}

function run(p: FlockParams, count: number, seconds: number) {
  const state = createFlockState();
  resizeFlock(state, count, p);
  const steps = Math.round(seconds / STEP_SECONDS);
  for (let s = 0; s < steps; s++) stepFlock(state, p, STEP_SECONDS);
  return state;
}

function allFinite(arr: ArrayLike<number>, n: number): boolean {
  for (let i = 0; i < n; i++) if (!Number.isFinite(arr[i])) return false;
  return true;
}

describe("flock steering", () => {
  test("is deterministic for a given seed", () => {
    const a = run(params(), 30, 5);
    const b = run(params(), 30, 5);
    expect(Array.from(a.pos.subarray(0, 90))).toEqual(Array.from(b.pos.subarray(0, 90)));
  });

  test("a different seed gives a different flock", () => {
    const a = run(params(), 30, 1);
    const b = run(params({ seed: 2 }), 30, 1);
    expect(Array.from(a.pos.subarray(0, 90))).not.toEqual(Array.from(b.pos.subarray(0, 90)));
  });

  test("keeps agents inside the bounds (plus slack) and headings unit-length", () => {
    const p = params();
    const state = run(p, 60, 20);
    const slack = p.edgeMargin + p.speed;
    for (let i = 0; i < state.count; i++) {
      expect(Math.abs(state.pos[i * 3])).toBeLessThanOrEqual(5 + slack + 1e-9);
      expect(Math.abs(state.pos[i * 3 + 2])).toBeLessThanOrEqual(3 + slack + 1e-9);
      expect(state.pos[i * 3 + 1]).toBeGreaterThanOrEqual(-0.5 - 1e-9);
      expect(state.pos[i * 3 + 1]).toBeLessThanOrEqual(0.5 + 1e-9);
      const len = Math.hypot(state.dir[i * 3], state.dir[i * 3 + 1], state.dir[i * 3 + 2]);
      expect(len).toBeCloseTo(1, 6);
    }
    expect(allFinite(state.pos, state.count * 3)).toBe(true);
  });

  test("plane mode keeps headings horizontal; volume mode respects max pitch", () => {
    const plane = run(params(), 20, 3);
    for (let i = 0; i < plane.count; i++) expect(plane.dir[i * 3 + 1]).toBe(0);

    const p = params({ mode: "volume", boundsSize: { x: 10, y: 10, z: 10 } });
    const vol = run(p, 20, 5);
    for (let i = 0; i < vol.count; i++) expect(Math.abs(vol.dir[i * 3 + 1])).toBeLessThanOrEqual(Math.sin(p.maxPitch) + 1e-9);
  });

  test("target pull gathers the flock around the target", () => {
    const p = params({ targetWeight: 3, target: { x: 3, y: 0, z: 1 }, cohesion: 0, alignment: 0 });
    const state = run(p, 20, 12);
    let mean = 0;
    for (let i = 0; i < state.count; i++) mean += Math.hypot(state.pos[i * 3] - 3, state.pos[i * 3 + 2] - 1);
    expect(mean / state.count).toBeLessThan(2);
  });

  test("a call brings agents to the call point and up to the surface", () => {
    const p = params({ boundsSize: { x: 10, y: 2, z: 6 } });
    const state = run(p, 15, 2);
    callFlock(state, { x: -3, y: 0, z: 0 }, p);
    for (let s = 0; s < 150; s++) stepFlock(state, p, STEP_SECONDS);
    let dist = 0, depth = 0;
    for (let i = 0; i < state.count; i++) {
      dist += Math.hypot(state.pos[i * 3] + 3, state.pos[i * 3 + 2]);
      depth += state.pos[i * 3 + 1];
    }
    expect(dist / state.count).toBeLessThan(2.5);
    expect(depth / state.count).toBeGreaterThan(0.3);
  });

  test("scatter pushes agents away from the scatter point", () => {
    const p = params({ targetWeight: 3, target: { x: 0, y: 0, z: 0 } });
    const state = run(p, 20, 8);
    scatterFlock(state, { x: 0, y: 0, z: 0 });
    const pScatter = { ...p, targetWeight: 0 };
    let before = 0, after = 0;
    for (let i = 0; i < state.count; i++) before += Math.hypot(state.pos[i * 3], state.pos[i * 3 + 2]);
    for (let s = 0; s < 40; s++) stepFlock(state, pScatter, STEP_SECONDS);
    for (let i = 0; i < state.count; i++) after += Math.hypot(state.pos[i * 3], state.pos[i * 3 + 2]);
    expect(after).toBeGreaterThan(before);
  });

  test("growing the flock keeps existing agents in place", () => {
    const p = params();
    const state = run(p, 10, 2);
    const before = Array.from(state.pos.subarray(0, 30));
    resizeFlock(state, 50, p);
    expect(Array.from(state.pos.subarray(0, 30))).toEqual(before);
    expect(state.count).toBe(50);
  });

  test("degenerate inputs stay finite", () => {
    const p = params({ boundsSize: { x: 0, y: 0, z: 0 }, neighborRadius: 0.001, separationDistance: 0.001, speed: 0 });
    const state = run(p, 25, 1);
    expect(allFinite(state.pos, state.count * 3)).toBe(true);
    expect(allFinite(state.dir, state.count * 3)).toBe(true);
  });
});

describe("FLOCK_NODE", () => {
  test("with nothing wired, draws the default count as one instanced mesh", () => {
    const out = FLOCK_NODE.evaluate({}, FLOCK_NODE.defaultParams, ctx("flock-default", 0));
    expect(out.count).toBe(40);
    expect(out.geometry).toBeInstanceOf(THREE.InstancedMesh);
    expect((out.geometry as THREE.InstancedMesh).count).toBe(40);
    expect((out.points as unknown[]).length).toBe(40);
    expect((out.rotations as THREE.Vector3[]).every((r) => Number.isFinite(r.x + r.y + r.z))).toBe(true);
  });

  test("returns the same mesh across frames", () => {
    const a = FLOCK_NODE.evaluate({}, FLOCK_NODE.defaultParams, ctx("flock-identity", 0)).geometry;
    const b = FLOCK_NODE.evaluate({}, FLOCK_NODE.defaultParams, ctx("flock-identity", 1)).geometry;
    expect(b).toBe(a);
  });

  test("agents move as the clock steps forward", () => {
    const id = "flock-moves";
    const first = (FLOCK_NODE.evaluate({}, FLOCK_NODE.defaultParams, ctx(id, 0)).points as THREE.Vector3[])[0].clone();
    let last = first;
    for (let s = 1; s <= 30; s++) last = (FLOCK_NODE.evaluate({}, FLOCK_NODE.defaultParams, ctx(id, s)).points as THREE.Vector3[])[0];
    expect(last.distanceTo(first)).toBeGreaterThan(0.1);
  });

  test("a scrub backwards restarts the flock where it began", () => {
    const id = "flock-rewind";
    const start = (FLOCK_NODE.evaluate({}, FLOCK_NODE.defaultParams, ctx(id, 0)).points as THREE.Vector3[])[0].clone();
    for (let s = 1; s <= 30; s++) FLOCK_NODE.evaluate({}, FLOCK_NODE.defaultParams, ctx(id, s));
    const again = (FLOCK_NODE.evaluate({}, FLOCK_NODE.defaultParams, ctx(id, 0)).points as THREE.Vector3[])[0];
    expect(again.distanceTo(start)).toBeLessThan(1e-9);
  });

  test("a wired shape's material is borrowed, not copied", () => {
    const material = new THREE.MeshStandardMaterial();
    const shape = new THREE.Mesh(new THREE.SphereGeometry(0.5), material);
    const out = FLOCK_NODE.evaluate({ shape, count: 5 }, FLOCK_NODE.defaultParams, ctx("flock-shape", 0));
    const mesh = out.geometry as THREE.InstancedMesh;
    expect(mesh.material).toBe(material);
    expect(mesh.geometry).not.toBe(shape.geometry);
    expect(mesh.count).toBe(5);
  });

  test("bad count input falls back and stays within limits", () => {
    expect(FLOCK_NODE.evaluate({ count: Number.NaN }, FLOCK_NODE.defaultParams, ctx("flock-nan", 0)).count).toBe(40);
    expect(FLOCK_NODE.evaluate({ count: -5 }, FLOCK_NODE.defaultParams, ctx("flock-neg", 0)).count).toBe(0);
  });

  test("viewports on different clocks keep their own flock instead of resetting each other", () => {
    const live = (step: number) => ctx("flock-views", step, { sessionId: "viewport-0" });
    const exporting = (step: number) => ctx("flock-views", step, { sessionId: "export" });
    const first = (FLOCK_NODE.evaluate({}, FLOCK_NODE.defaultParams, live(0)).points as THREE.Vector3[])[0].clone();
    let liveAt = first;
    for (let s = 1; s <= 60; s++) {
      liveAt = (FLOCK_NODE.evaluate({}, FLOCK_NODE.defaultParams, live(s)).points as THREE.Vector3[])[0].clone();
      // The export replays from frame 0 between live frames.
      FLOCK_NODE.evaluate({}, FLOCK_NODE.defaultParams, exporting(Math.floor(s / 4)));
    }
    expect(liveAt.distanceTo(first)).toBeGreaterThan(0.3);
    const replay = (FLOCK_NODE.evaluate({}, FLOCK_NODE.defaultParams, exporting(0)).points as THREE.Vector3[])[0];
    expect(replay.distanceTo(first)).toBeLessThan(1e-9);
  });
});

describe("flock obstacles", () => {
  const rock = () => new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial());
  const blank = (): Avoidance => ({ x: 0, y: 0, z: 0, weight: 0, inside: false, distance: 0 });

  test("the avoider points away from the nearest surface, outward even from inside", () => {
    const avoid = makeAvoider(collectObstacles(rock()), 1)!;
    const near = blank();
    expect(avoid(1.5, 0, 0, near)).toBe(true);
    expect(near.inside).toBe(false);
    expect(near.x).toBeGreaterThan(0.95);
    expect(near.weight).toBeCloseTo(0.25, 1);
    const within = blank();
    expect(avoid(0.4, 0, 0, within)).toBe(true);
    expect(within.inside).toBe(true);
    expect(within.x).toBeGreaterThan(0.95);
    expect(avoid(5, 0, 0, blank())).toBe(false);
  });

  test("follows the obstacle's own placement", () => {
    const moved = rock();
    moved.position.set(4, 0, 0);
    const group = new THREE.Group();
    group.add(moved);
    const out = blank();
    expect(makeAvoider(collectObstacles(group), 1)!(5.5, 0, 0, out)).toBe(true);
    expect(out.x).toBeGreaterThan(0.95);
  });

  test("agents keep out of a rock in the middle of the pond", () => {
    const count = (withRock: boolean) => {
      const p = params({ boundsSize: { x: 8, y: 1, z: 8 }, obstacle: withRock ? 3 : 0, avoid: withRock ? makeAvoider(collectObstacles(rock()), 1) : undefined });
      const state = createFlockState();
      resizeFlock(state, 40, p);
      let inside = 0;
      for (let s = 0; s < 1200; s++) {
        stepFlock(state, p, STEP_SECONDS);
        if (s % 10) continue;
        // In 3D: the sphere narrows away from its middle, so a fish deep enough is clear of it closer to its axis.
        for (let i = 0; i < state.count; i++) if (Math.hypot(state.pos[i * 3], state.pos[i * 3 + 1], state.pos[i * 3 + 2]) < 0.95) inside++;
      }
      return inside;
    };
    const free = count(false);
    expect(free).toBeGreaterThan(20);
    expect(count(true)).toBe(0);
  });

  test("the node takes any geometry as obstacles", () => {
    const id = "flock-rock";
    let points: THREE.Vector3[] = [];
    const p = { ...FLOCK_NODE.defaultParams, boundsSize: new THREE.Vector3(8, 1, 8) };
    for (let s = 0; s < 600; s++) points = FLOCK_NODE.evaluate({ obstacles: rock() }, p, ctx(id, s)).points as THREE.Vector3[];
    for (const pt of points) expect(pt.length()).toBeGreaterThan(0.95);
  });
});
