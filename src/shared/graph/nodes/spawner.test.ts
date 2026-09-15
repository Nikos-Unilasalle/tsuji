import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { PHYSICS_SPAWNER_NODE, launchImpulse, launchOrigin } from "./spawner";

const FORWARD = new THREE.Vector3(0, 0, 1);
const ORIGIN = new THREE.Vector3(0, 2, 0);

function evaluate(inputs: Record<string, unknown>, nodeId: string, params = PHYSICS_SPAWNER_NODE.defaultParams) {
  return PHYSICS_SPAWNER_NODE.evaluate(inputs, params, { time: 0, step: 0, nodeId }) as {
    geometry: unknown;
    world: unknown;
    alive: number;
    spawned: number;
  };
}

describe("launchImpulse", () => {
  it("fires along the aim, scaled by speed and mass", () => {
    const impulse = launchImpulse(0, FORWARD, 6, 0, 1);

    expect(impulse.length()).toBeCloseTo(6, 5);
    expect(impulse.z).toBeCloseTo(6, 5);
    expect(impulse.x).toBeCloseTo(0, 6);

    // Impulse, so the same shot at twice the mass carries twice the push — and therefore the same
    // launch speed, which is what makes Mass feel like weight rather than like a speed dial.
    expect(launchImpulse(0, FORWARD, 6, 0, 2).length()).toBeCloseTo(12, 5);
  });

  it("normalises whatever direction it is given", () => {
    const long = launchImpulse(0, new THREE.Vector3(0, 0, 37), 4, 0, 1);
    const unit = launchImpulse(0, FORWARD, 4, 0, 1);

    expect(long.length()).toBeCloseTo(unit.length(), 6);
    expect(long.z).toBeCloseTo(unit.z, 6);
  });

  it("falls back to forward when there is no direction to aim along", () => {
    const impulse = launchImpulse(3, new THREE.Vector3(0, 0, 0), 5, 0, 1);

    expect(impulse.length()).toBeCloseTo(5, 5);
    expect(impulse.z).toBeCloseTo(5, 5);
  });

  it("scatters consecutive shots, and always the same way", () => {
    const a = launchImpulse(0, FORWARD, 6, 0.4, 1);
    const b = launchImpulse(1, FORWARD, 6, 0.4, 1);

    expect(a.angleTo(b)).toBeGreaterThan(0.001);
    expect(launchImpulse(0, FORWARD, 6, 0.4, 1).equals(a)).toBe(true);
    expect(launchImpulse(1, FORWARD, 6, 0.4, 1).equals(b)).toBe(true);
  });

  it("keeps the spread inside the cone it was asked for", () => {
    for (let shot = 0; shot < 200; shot++) {
      const tight = launchImpulse(shot, FORWARD, 6, 0.1, 1);
      const wide = launchImpulse(shot, FORWARD, 6, 1.2, 1);

      // Whatever the scatter, speed is untouched: spread aims a shot, it does not weaken it.
      expect(tight.length()).toBeCloseTo(6, 4);
      expect(tight.angleTo(FORWARD)).toBeLessThan(wide.angleTo(FORWARD) + 1e-9);
      expect(tight.angleTo(FORWARD)).toBeLessThan(0.15);
    }
  });
});

describe("launchOrigin", () => {
  it("stays within the jitter of the spawn point", () => {
    for (let shot = 0; shot < 200; shot++) {
      const p = launchOrigin(shot, ORIGIN, 0.5);
      expect(Math.abs(p.x - ORIGIN.x)).toBeLessThanOrEqual(0.25);
      expect(Math.abs(p.y - ORIGIN.y)).toBeLessThanOrEqual(0.25);
      expect(Math.abs(p.z - ORIGIN.z)).toBeLessThanOrEqual(0.25);
    }
  });

  it("lands exactly on the point with no jitter, and repeats", () => {
    expect(launchOrigin(7, ORIGIN, 0).equals(ORIGIN)).toBe(true);
    expect(launchOrigin(7, ORIGIN, 0.5).equals(launchOrigin(7, ORIGIN, 0.5))).toBe(true);
    expect(launchOrigin(8, ORIGIN, 0.5).equals(launchOrigin(7, ORIGIN, 0.5))).toBe(false);
  });
});

describe("PHYSICS_SPAWNER_NODE", () => {
  it("has the expected node schema", () => {
    expect(PHYSICS_SPAWNER_NODE.type).toBe("physics/spawner");
    expect(PHYSICS_SPAWNER_NODE.category).toBe("physics");
    expect(PHYSICS_SPAWNER_NODE.outputs.map((o) => o.id)).toEqual(["geometry", "world", "alive", "spawned"]);
    // The prototype is consumed: it is a template, not something to draw beside the copies.
    expect(PHYSICS_SPAWNER_NODE.inputs.find((i) => i.id === "prototype")?.owns).toBe(true);
  });

  it("passes the world through so it can sit mid-chain", () => {
    const world = { kind: "physics-world", nodeId: "w", bodies: new Map() };
    expect(evaluate({ world }, "pass").world).toBe(world);
    expect(evaluate({ world: "not-a-world" }, "pass2").world).toBe("not-a-world");
  });

  it("hands the prototype straight back while rapier is still loading", () => {
    const proto = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    const world = { kind: "physics-world", nodeId: "w", bodies: new Map() };

    // The engine is WebAssembly and never comes up here, which is also the first few frames of a
    // real session: the scene has to keep rendering rather than lose the object.
    const res = evaluate({ world, prototype: proto, trigger: 1 }, "cold");
    expect(res.geometry).toBe(proto);
    expect(res.alive).toBe(0);
    expect(res.spawned).toBe(0);
  });

  it("survives junk inputs", () => {
    expect(() => evaluate({}, "junk")).not.toThrow();
    expect(() => evaluate({ world: null, prototype: "cookie", trigger: 1 }, "junk2")).not.toThrow();
    expect(evaluate({ prototype: new THREE.Group() }, "junk3").alive).toBe(0);
  });

  it("keeps the original's pool defaults", () => {
    const p = PHYSICS_SPAWNER_NODE.defaultParams;
    expect(p.count).toBe(20);
    expect(p.shape).toBe("auto");
  });
});
