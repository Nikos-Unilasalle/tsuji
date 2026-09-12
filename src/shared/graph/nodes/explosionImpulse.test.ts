import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { BlastSettings, PHYSICS_EXPLOSION_NODE, blastImpulse } from "./explosionImpulse";

const SETTINGS: BlastSettings = { radius: 5, strength: 8, innerRadius: 1, lift: 0.5 };
const CENTRE = new THREE.Vector3(0, 0, 0);

function evaluate(inputs: Record<string, unknown>, time: number, nodeId: string) {
  return PHYSICS_EXPLOSION_NODE.evaluate(inputs, PHYSICS_EXPLOSION_NODE.defaultParams, {
    time,
    step: Math.round(time * 60),
    nodeId,
  }) as { world: unknown; hits: number };
}

describe("blastImpulse", () => {
  it("throws a body out and up at the original's angle", () => {
    const impulse = blastImpulse(new THREE.Vector3(1, 0, 0), CENTRE, 1, SETTINGS)!;

    expect(impulse).not.toBeNull();
    // 0.5 sideways against one unit of up, normalised: about 63 degrees above the horizontal.
    const angle = (Math.atan2(impulse.y, Math.hypot(impulse.x, impulse.z)) * 180) / Math.PI;
    expect(angle).toBeCloseTo(63.43, 2);
    expect(impulse.x).toBeGreaterThan(0);
    expect(impulse.z).toBeCloseTo(0, 6);
  });

  it("fades from full strength at the inner radius to nothing at the outer one", () => {
    const atInner = blastImpulse(new THREE.Vector3(1, 0, 0), CENTRE, 1, SETTINGS)!;
    const halfway = blastImpulse(new THREE.Vector3(3, 0, 0), CENTRE, 1, SETTINGS)!;

    expect(atInner.length()).toBeCloseTo(8, 5);
    expect(halfway.length()).toBeCloseTo(4, 5);
    // Inside the inner radius it is still full strength, not more.
    expect(blastImpulse(new THREE.Vector3(0.4, 0, 0), CENTRE, 1, SETTINGS)!.length()).toBeCloseTo(8, 5);
    // At and beyond the radius, nothing at all.
    expect(blastImpulse(new THREE.Vector3(5, 0, 0), CENTRE, 1, SETTINGS)).toBeNull();
    expect(blastImpulse(new THREE.Vector3(40, 0, 0), CENTRE, 1, SETTINGS)).toBeNull();
  });

  it("measures the distance across the ground, ignoring height", () => {
    const flat = blastImpulse(new THREE.Vector3(2, 0, 0), CENTRE, 1, SETTINGS)!;
    const high = blastImpulse(new THREE.Vector3(2, 9, 0), CENTRE, 1, SETTINGS)!;

    expect(high.length()).toBeCloseTo(flat.length(), 6);
  });

  it("sends a body sitting on the blast point straight up", () => {
    const impulse = blastImpulse(CENTRE.clone(), CENTRE, 1, SETTINGS)!;

    expect(impulse.x).toBeCloseTo(0, 6);
    expect(impulse.z).toBeCloseTo(0, 6);
    expect(impulse.y).toBeCloseTo(8, 5);
  });

  it("scales with mass, so heavy and light bodies accelerate alike", () => {
    const light = blastImpulse(new THREE.Vector3(2, 0, 0), CENTRE, 1, SETTINGS)!;
    const heavy = blastImpulse(new THREE.Vector3(2, 0, 0), CENTRE, 7, SETTINGS)!;

    expect(heavy.length() / light.length()).toBeCloseTo(7, 5);
  });

  it("takes the lift ratio: 0 skims along the ground, high shoves sideways", () => {
    const skim = blastImpulse(new THREE.Vector3(2, 0, 0), CENTRE, 1, { ...SETTINGS, lift: 0 })!;
    const shove = blastImpulse(new THREE.Vector3(2, 0, 0), CENTRE, 1, { ...SETTINGS, lift: 4 })!;

    expect(skim.x).toBeCloseTo(0, 6);
    expect(skim.y).toBeGreaterThan(0);
    expect(shove.x).toBeGreaterThan(shove.y);
  });

  it("stays finite on a degenerate radius", () => {
    const impulse = blastImpulse(new THREE.Vector3(1, 0, 0), CENTRE, 1, { ...SETTINGS, radius: 1, innerRadius: 1 });
    expect(impulse === null || Number.isFinite(impulse.length())).toBe(true);
  });
});

describe("PHYSICS_EXPLOSION_NODE", () => {
  it("has the expected node schema", () => {
    expect(PHYSICS_EXPLOSION_NODE.type).toBe("physics/explosion");
    expect(PHYSICS_EXPLOSION_NODE.category).toBe("physics");
    expect(PHYSICS_EXPLOSION_NODE.outputs.map((o) => o.id)).toEqual(["world", "hits"]);
  });

  it("passes the world through so it can sit mid-chain", () => {
    const world = { kind: "physics-world", nodeId: "w", bodies: new Map() };
    expect(evaluate({ world }, 0, "pass").world).toBe(world);
    // Anything that is not a world still flows on rather than becoming null mid-graph.
    expect(evaluate({ world: "not-a-world" }, 0, "pass2").world).toBe("not-a-world");
  });

  it("reports nothing and throws nothing while rapier is still loading", () => {
    const world = { kind: "physics-world", nodeId: "w", bodies: new Map() };

    // The engine is WebAssembly and never comes up in this environment, which is exactly the
    // first few frames of a real session: the node has to pass through quietly.
    expect(evaluate({ world, trigger: 0 }, 0, "cold").hits).toBe(0);
    expect(evaluate({ world, trigger: 1 }, 1, "cold").hits).toBe(0);
  });

  it("survives junk inputs", () => {
    expect(() => evaluate({ world: null, trigger: 1 }, 0, "junk")).not.toThrow();
    expect(() => evaluate({}, 0, "junk2")).not.toThrow();
    expect(evaluate({ world: undefined, trigger: "yes" }, 0, "junk3").hits).toBe(0);
  });

  it("keeps the original's defaults", () => {
    const params = PHYSICS_EXPLOSION_NODE.defaultParams;
    expect(params.radius).toBe(5);
    expect(params.strength).toBe(8);
    expect(params.innerRadius).toBe(1);
    expect(params.lift).toBe(0.5);
  });
});
