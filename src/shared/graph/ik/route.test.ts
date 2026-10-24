import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { planRoute, projectOnRoute, type RouteMark } from "./route";

const straight = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 10)];
const speeds = { walk: 1.3, run: 3 };

describe("route plan", () => {
  it("sets off from standing, walks at its speed, and stops at the end", () => {
    const plan = planRoute(straight, [], speeds)!;
    expect(plan.curve.length).toBeCloseTo(10, 3);
    expect(plan.sample(0).speed).toBeCloseTo(0, 6);
    expect(plan.sample(plan.duration / 2).speed).toBeCloseTo(1.3, 2);
    const end = plan.sample(plan.duration + 5);
    expect(end.s).toBeCloseTo(10, 3);
    expect(end.speed).toBe(0);
    // 10 m at 1.3 m/s, plus a little to speed up and slow down.
    expect(plan.duration).toBeGreaterThan(10 / 1.3);
    expect(plan.duration).toBeLessThan(10 / 1.3 + 3);
  });

  it("moves forward continuously: never back, never a jump", () => {
    const plan = planRoute(straight, [{ kind: "run", at: 0.3 }, { kind: "stop", at: 0.7, hold: 2 }], speeds)!;
    let last = 0;
    for (let t = 0; t <= plan.duration; t += 1 / 60) {
      const s = plan.sample(t).s;
      expect(s).toBeGreaterThanOrEqual(last - 1e-9);
      expect(s - last).toBeLessThan(3.2 / 60 + 1e-3);
      last = s;
    }
  });

  it("runs from a run mark, and holds a stop for its time, easing the pose in and out", () => {
    const marks: RouteMark[] = [{ kind: "run", at: 0.2 }, { kind: "stop", at: 0.8, hold: 2, pose: "wave" }];
    const plan = planRoute(straight, marks, speeds)!;
    const runAt = plan.markTimes[0];
    const stopAt = plan.markTimes[1];
    expect(plan.sample((runAt + stopAt) / 2).speed).toBeGreaterThan(2.5);
    const held = plan.sample(stopAt + 1);
    expect(held.holding).toBe(1);
    expect(held.speed).toBe(0);
    expect(held.s).toBeCloseTo(8, 1);
    expect(held.poseWeight).toBeCloseTo(1, 6);
    expect(plan.sample(stopAt + 0.1).poseWeight).toBeLessThan(0.5);
    expect(plan.sample(stopAt + 2.2).holding).toBe(-1);
  });

  it("slows down in a tight bend", () => {
    const hairpin = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 6), new THREE.Vector3(0.6, 0, 6.3), new THREE.Vector3(1.2, 0, 6), new THREE.Vector3(1.2, 0, 0)];
    const plan = planRoute(hairpin, [{ kind: "run", at: 0 }], speeds)!;
    const bend = projectOnRoute(plan.curve, new THREE.Vector3(0.6, 0, 6.3));
    let bendSpeed = Infinity;
    for (let t = 0; t <= plan.duration; t += 1 / 60) {
      const sample = plan.sample(t);
      if (Math.abs(sample.s / plan.curve.length - bend) < 0.02) bendSpeed = Math.min(bendSpeed, sample.speed);
    }
    expect(bendSpeed).toBeLessThan(2);
  });

  it("turns on the spot during a stop on a corner", () => {
    const corner = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 4), new THREE.Vector3(4, 0, 4)];
    const at = projectOnRoute(planRoute(corner, [], speeds)!.curve, new THREE.Vector3(0, 0, 4));
    const plan = planRoute(corner, [{ kind: "stop", at, hold: 2 }], speeds)!;
    const arrive = plan.sample(plan.markTimes[0] + 0.05).heading;
    const leave = plan.sample(plan.markTimes[0] + 1.95).heading;
    expect(arrive.angleTo(leave)).toBeGreaterThan(0.5);
  });

  it("needs two distinct points", () => {
    expect(planRoute([new THREE.Vector3()], [], speeds)).toBeNull();
    expect(planRoute([new THREE.Vector3(), new THREE.Vector3()], [], speeds)).toBeNull();
  });
});
