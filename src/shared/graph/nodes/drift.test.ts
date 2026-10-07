import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { DRIFT_NODE } from "./drift";
import { EvalContext } from "../types";
import { STEP_SECONDS } from "../clock";

const ctx = (nodeId: string, step: number, extra: Partial<EvalContext> = {}): EvalContext => ({ nodeId, step, time: step * STEP_SECONDS, ...extra });
const params = (o: Record<string, unknown> = {}) => ({ ...(DRIFT_NODE.defaultParams as Record<string, unknown>), ...o });

function run(id: string, inputs: Record<string, unknown>, p: Record<string, unknown>, steps: number): THREE.Vector3[] {
  let out: Record<string, unknown> = {};
  for (let s = 0; s < steps; s++) out = DRIFT_NODE.evaluate(inputs, p, ctx(id, s));
  return out.points as THREE.Vector3[];
}

describe("DRIFT_NODE", () => {
  test("with no force, points rest at home", () => {
    const homes = [new THREE.Vector3(1, 2, 3)];
    const [p] = run("drift-rest", { points: homes }, params(), 60);
    expect(p.distanceTo(homes[0])).toBe(0);
  });

  test("a shared force carries points along and drag caps their speed", () => {
    const out = run("drift-current", { points: [new THREE.Vector3()], force: new THREE.Vector3(1, 0, 0) }, params({ drag: 2 }), 240);
    expect(out[0].x).toBeGreaterThan(1);
    const speed = (DRIFT_NODE.evaluate({ points: [new THREE.Vector3()], force: new THREE.Vector3(1, 0, 0) }, params({ drag: 2 }), ctx("drift-current", 240)).speeds as number[])[0];
    expect(speed).toBeCloseTo(0.5, 1);
  });

  test("per-point forces push each point its own way, scaled", () => {
    const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(5, 0, 0)];
    const forces = [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)];
    const out = run("drift-own", { points, forces }, params({ forceScale: 2 }), 60);
    expect(out[0].z).toBeGreaterThan(0.1);
    expect(out[1].z).toBeLessThan(-0.1);
  });

  test("Keep Height holds every point at its home height", () => {
    const out = run("drift-flat", { points: [new THREE.Vector3(0, 1.5, 0)], force: new THREE.Vector3(1, -5, 0) }, params(), 60);
    expect(out[0].y).toBe(1.5);
    const free = run("drift-free", { points: [new THREE.Vector3(0, 1.5, 0)], force: new THREE.Vector3(1, -5, 0) }, params({ keepHeight: false }), 60);
    expect(free[0].y).toBeLessThan(1);
  });

  test("a tether pulls a point back once it strays past the slack", () => {
    const pushed = (tether: number) => run(`drift-tether-${tether}`, { points: [new THREE.Vector3()], force: new THREE.Vector3(1, 0, 0) }, params({ tether, slack: 0.2, drag: 3 }), 600)[0].x;
    expect(pushed(0)).toBeGreaterThan(2);
    const held = pushed(10);
    expect(held).toBeGreaterThan(0.2);
    expect(held).toBeLessThan(0.4);
  });

  test("points spread apart until they no longer overlap", () => {
    const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.1, 0, 0), new THREE.Vector3(0, 0, 0)];
    const out = run("drift-spacing", { points }, params({ radius: 0.25, spacing: 8 }), 240);
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) expect(out[i].distanceTo(out[j])).toBeGreaterThan(0.45);
    }
  });

  test("points slide round an obstacle instead of through it", () => {
    const rock = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial());
    let closest = Infinity;
    let out: Record<string, unknown> = {};
    for (let s = 0; s < 600; s++) {
      out = DRIFT_NODE.evaluate({ points: [new THREE.Vector3(-3, 0, 0.05)], force: new THREE.Vector3(2, 0, 0), obstacles: rock }, params({ drag: 2, radius: 0.1 }), ctx("drift-rock", s));
      closest = Math.min(closest, (out.points as THREE.Vector3[])[0].length());
    }
    expect(closest).toBeGreaterThan(0.95);
    expect((out.points as THREE.Vector3[])[0].x).toBeGreaterThan(1);
  });

  test("Wrap bounds bring a point leaving one side back in at the other", () => {
    const out = run("drift-wrap", { points: [new THREE.Vector3(4.9, 0, 0)], force: new THREE.Vector3(3, 0, 0) }, params({ boundsMode: "wrap", drag: 0 }), 30);
    expect(out[0].x).toBeLessThan(0);
    expect(out[0].x).toBeGreaterThanOrEqual(-5);
  });

  test("viewports keep their own drift; a scrub back sends points home", () => {
    const inputs = { points: [new THREE.Vector3()], force: new THREE.Vector3(1, 0, 0) };
    for (let s = 0; s < 60; s++) {
      DRIFT_NODE.evaluate(inputs, params(), ctx("drift-views", s, { sessionId: "viewport-0" }));
      DRIFT_NODE.evaluate(inputs, params(), ctx("drift-views", 0, { sessionId: "export" }));
    }
    const live = (DRIFT_NODE.evaluate(inputs, params(), ctx("drift-views", 60, { sessionId: "viewport-0" })).points as THREE.Vector3[])[0].x;
    expect(live).toBeGreaterThan(0.3);
    const back = (DRIFT_NODE.evaluate(inputs, params(), ctx("drift-views", 0, { sessionId: "viewport-0" })).points as THREE.Vector3[])[0].x;
    expect(back).toBeLessThan(0.01);
  });
});
