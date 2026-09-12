import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { LeavesForces, createLeafGeometry, seedLeaves, stepLeaves } from "./leaves";
import { DEFAULT_WIND } from "./windField";

const BASE: LeavesForces = {
  dt: 1 / 60,
  focusX: 0,
  focusZ: 0,
  size: 40,
  wind: null,
  windMultiplier: 4,
  upwardMultiplier: 1,
  gravity: 9.807,
  damping: 1.5,
  floorOffset: 0.02,
  ground: null,
  push: null,
  blast: null,
};

function positionsOf(state: ReturnType<typeof seedLeaves>) {
  return Array.from(state.positions);
}

describe("leaf geometry", () => {
  it("is a quad with its far corners pulled in, lying flat", () => {
    const geometry = createLeafGeometry();
    const p = geometry.attributes.position.array as Float32Array;

    expect(geometry.attributes.position.count).toBe(4);
    // rotateX put the quad in the XZ plane, so every vertex sits at y = 0.
    for (let i = 0; i < 4; i++) expect(p[i * 3 + 1]).toBeCloseTo(0, 6);
    // Two corners narrowed by 0.15 each, two widened: a leaf, not a square.
    const xs = [p[0], p[3], p[6], p[9]].map((v) => Math.abs(v));
    expect(Math.min(...xs)).toBeCloseTo(0.35, 6);
    expect(Math.max(...xs)).toBeCloseTo(0.65, 6);
  });
});

describe("seedLeaves", () => {
  it("scatters inside the field and is reproducible from its seed", () => {
    const a = seedLeaves(64, 40, 3);
    const b = seedLeaves(64, 40, 3);
    const other = seedLeaves(64, 40, 4);

    expect(positionsOf(a)).toEqual(positionsOf(b));
    expect(positionsOf(a)).not.toEqual(positionsOf(other));

    for (let i = 0; i < a.count; i++) {
      expect(Math.abs(a.positions[i * 3])).toBeLessThanOrEqual(20);
      expect(Math.abs(a.positions[i * 3 + 2])).toBeLessThanOrEqual(20);
      expect(a.positions[i * 3 + 1]).toBe(0);
      // Weight and scale stay in the original's ranges.
      expect(a.weights[i]).toBeGreaterThanOrEqual(0.1);
      expect(a.weights[i]).toBeLessThanOrEqual(0.2);
      expect(a.scales[i]).toBeGreaterThanOrEqual(0.5);
      expect(a.scales[i]).toBeLessThanOrEqual(1);
    }
  });

  it("scatters around the focus point", () => {
    const state = seedLeaves(64, 10, 1, 100, -50);

    for (let i = 0; i < state.count; i++) {
      expect(Math.abs(state.positions[i * 3] - 100)).toBeLessThanOrEqual(5);
      expect(Math.abs(state.positions[i * 3 + 2] + 50)).toBeLessThanOrEqual(5);
    }
  });
});

describe("stepLeaves", () => {
  it("settles a still field onto the floor and leaves it there", () => {
    const state = seedLeaves(32, 40, 1);
    const before = positionsOf(state);

    for (let i = 0; i < 60; i++) stepLeaves(state, BASE);

    // No wind and no push: they sink to the floor offset and stop, keeping their XZ exactly.
    for (let i = 0; i < state.count; i++) {
      expect(state.positions[i * 3]).toBe(before[i * 3]);
      expect(state.positions[i * 3 + 2]).toBe(before[i * 3 + 2]);
      expect(state.positions[i * 3 + 1]).toBeCloseTo(BASE.floorOffset, 6);
    }
  });

  it("blows leaves along the wind", () => {
    const state = seedLeaves(256, 40, 1);
    const wind = { ...DEFAULT_WIND, direction: new THREE.Vector2(1, 0), strength: 3, phase: 1 };

    let moved = 0;
    for (let i = 0; i < 120; i++) stepLeaves(state, { ...BASE, wind });
    for (let i = 0; i < state.count; i++) if (Math.abs(state.velocities[i * 3]) > 1e-4) moved++;

    expect(moved).toBeGreaterThan(state.count * 0.5);
  });

  it("lifts a leaf off the floor once it is moving sideways, and never sinks through it", () => {
    const state = seedLeaves(1, 40, 1);
    const wind = { ...DEFAULT_WIND, direction: new THREE.Vector2(1, 0), strength: 8, phase: 2 };

    let highest = 0;
    for (let i = 0; i < 200; i++) {
      stepLeaves(state, { ...BASE, wind, windMultiplier: 40 });
      highest = Math.max(highest, state.positions[1]);
      expect(state.positions[1]).toBeGreaterThanOrEqual(BASE.floorOffset - 1e-6);
    }

    expect(highest).toBeGreaterThan(BASE.floorOffset);
  });

  it("throws leaves outward from a blast, hardest just around it", () => {
    const state = seedLeaves(3, 40, 1);
    // On the blast, near it, and out past its radius.
    state.positions.set([0, 0, 0, 2, 0, 0, 9, 0, 0]);
    state.velocities.fill(0);

    stepLeaves(state, { ...BASE, blast: { x: 0, z: 0, radius: 5, strength: 20 } });

    // Nothing at the centre: there is no direction to be thrown in.
    expect(state.velocities[0]).toBe(0);
    expect(state.velocities[3]).toBeGreaterThan(0);
    // Past the radius the falloff has reached zero.
    expect(state.velocities[6]).toBe(0);
  });

  it("pushes leaves out of a mover's way", () => {
    const state = seedLeaves(1, 40, 1);
    state.positions.set([1, 0, 0]);
    state.velocities.fill(0);

    stepLeaves(state, {
      ...BASE,
      push: {
        position: new THREE.Vector3(0, 0, 0),
        velocity: new THREE.Vector3(0, 0, 4),
        multiplier: 100,
        sidewaysMultiplier: 20,
      },
    });

    // Carried along the mover's heading, and shoved off its line at the same time.
    expect(state.velocities[2]).toBeGreaterThan(0);
    expect(state.velocities[0]).toBeGreaterThan(0);
  });

  it("wraps the field around the focus point", () => {
    const state = seedLeaves(1, 10, 1);
    state.positions.set([4.6, 0, 0]);
    state.velocities.set([20, 0, 0]);

    stepLeaves(state, { ...BASE, size: 10, damping: 0, gravity: 0, upwardMultiplier: 0 });

    expect(Math.abs(state.positions[0])).toBeLessThanOrEqual(5);
  });

  it("clamps a bad dt rather than letting the field explode", () => {
    const state = seedLeaves(8, 40, 1);
    const wind = { ...DEFAULT_WIND, direction: new THREE.Vector2(1, 0), strength: 5, phase: 1 };

    stepLeaves(state, { ...BASE, dt: 1e6, wind });
    stepLeaves(state, { ...BASE, dt: Number.NaN, wind });
    stepLeaves(state, { ...BASE, dt: -4, wind });

    for (let i = 0; i < state.positions.length; i++) expect(Number.isFinite(state.positions[i])).toBe(true);
  });
});
