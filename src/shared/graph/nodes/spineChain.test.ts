import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { SPINE_CHAIN_NODE } from "./spineChain";
import { EvalContext } from "../types";
import { createChainSet, followChain, resizeChains, seedChain, WaveParams, wavedSpine } from "../spine/chain";

const ctx = (nodeId: string, time: number): EvalContext => ({ nodeId, time, step: Math.round(time * 60) });
const WAVE: WaveParams = { axis: "Side to Side", amplitude: 0.12, wavelength: 0.9, frequency: 1.4, speedDriven: true, refSpeed: 1.2 };

function chainOf(segments: number, length: number) {
  const set = createChainSet();
  resizeChains(set, 1, segments, (i) => seedChain(set, i, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, length));
  return set;
}

function ramp(n: number): Float64Array {
  return Float64Array.from({ length: n }, (_, k) => k / (n - 1));
}

/** Largest swing of point `k` off the X axis over one wave period, on the given axis (1 = y, 2 = z). */
function maxSwing(wave: WaveParams, k: number, component: 1 | 2): number {
  const set = chainOf(14, 1);
  set.speed[0] = wave.refSpeed;
  const out = new Float64Array(14 * 3);
  let max = 0;
  for (let s = 0; s < 32; s++) {
    wavedSpine(set, 0, 1, (s / 32) * Math.PI * 2, wave, ramp(14), out);
    max = Math.max(max, Math.abs(out[k * 3 + component]));
  }
  return max;
}

describe("spine chain", () => {
  test("seeds straight behind the head", () => {
    const set = chainOf(5, 2);
    expect(Array.from(set.points)).toEqual([0, 0, 0, -0.5, 0, 0, -1, 0, 0, -1.5, 0, 0, -2, 0, 0].map((v) => v + 0));
  });

  test("following keeps every segment at its length", () => {
    const set = chainOf(10, 3);
    for (let s = 0; s < 120; s++) {
      const a = s * 0.05;
      followChain(set, 0, { x: Math.cos(a) * 2, y: 0, z: Math.sin(a) * 2 }, 3, (30 * Math.PI) / 180);
    }
    const p = set.points;
    for (let k = 1; k < 10; k++) {
      expect(Math.hypot(p[k * 3] - p[k * 3 - 3], p[k * 3 + 1] - p[k * 3 - 2], p[k * 3 + 2] - p[k * 3 - 1])).toBeCloseTo(3 / 9, 9);
    }
  });

  test("a hairpin turn bends no joint past the limit", () => {
    const set = chainOf(8, 2);
    followChain(set, 0, { x: -0.3, y: 0, z: 0.05 }, 2, (20 * Math.PI) / 180);
    const p = set.points;
    for (let k = 2; k < 8; k++) {
      const ax = p[k * 3 - 3] - p[k * 3 - 6], az = p[k * 3 - 1] - p[k * 3 - 4];
      const bx = p[k * 3] - p[k * 3 - 3], bz = p[k * 3 + 2] - p[k * 3 - 1];
      const cos = (ax * bx + az * bz) / (Math.hypot(ax, az) * Math.hypot(bx, bz));
      expect(cos).toBeGreaterThanOrEqual(Math.cos((20 * Math.PI) / 180) - 1e-9);
    }
  });

  test("the swing follows the envelope: nothing at the head, full at the end", () => {
    expect(maxSwing(WAVE, 13, 2)).toBeCloseTo(0.12, 2);
    expect(maxSwing(WAVE, 0, 2)).toBeLessThan(1e-9);
  });

  test("Up and Down swings vertically, Off not at all", () => {
    const vertical = { ...WAVE, axis: "Up and Down" as const };
    expect(maxSwing(vertical, 13, 1)).toBeCloseTo(0.12, 2);
    expect(maxSwing(vertical, 13, 2)).toBeLessThan(1e-9);
    expect(maxSwing({ ...WAVE, axis: "Off" }, 13, 2)).toBe(0);
  });

  test("without Speed Driven the swing ignores the head's speed", () => {
    const set = chainOf(14, 1);
    set.speed[0] = 0;
    const out = new Float64Array(14 * 3);
    wavedSpine(set, 0, 1, Math.PI / 2 + Math.PI * 2 * 0.9, { ...WAVE, speedDriven: false }, ramp(14), out);
    expect(Math.abs(out[13 * 3 + 2])).toBeCloseTo(0.12, 6);
  });
});

describe("SPINE_CHAIN_NODE", () => {
  test("with nothing wired, one chain sits at the origin", () => {
    const out = SPINE_CHAIN_NODE.evaluate({}, SPINE_CHAIN_NODE.defaultParams, ctx("spine-default", 0));
    expect(out.count).toBe(1);
    const lists = out.pointLists as THREE.Vector3[][];
    expect(lists[0]).toHaveLength(14);
    expect(lists[0][0].length()).toBeLessThan(1e-9);
    expect(out.geometry).toBeInstanceOf(THREE.LineSegments);
  });

  test("one chain per head, scaled by Length Scales, same preview across frames", () => {
    const heads = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(3, 0, 0)];
    const a = SPINE_CHAIN_NODE.evaluate({ heads, sizes: [1, 0.5] }, SPINE_CHAIN_NODE.defaultParams, ctx("spine-two", 0));
    const b = SPINE_CHAIN_NODE.evaluate({ heads, sizes: [1, 0.5] }, SPINE_CHAIN_NODE.defaultParams, ctx("spine-two", 1 / 60));
    expect(b.geometry).toBe(a.geometry);
    const lists = b.pointLists as THREE.Vector3[][];
    expect(lists).toHaveLength(2);
    expect(lists[0][0].distanceTo(lists[0][13])).toBeGreaterThan(0.8);
    expect(lists[1][0].distanceTo(lists[1][13])).toBeLessThan(0.55);
  });

  test("the chain trails the path its head took", () => {
    const id = "spine-trail";
    let out: Record<string, unknown> = {};
    for (let s = 0; s <= 120; s++) {
      const t = s / 60;
      out = SPINE_CHAIN_NODE.evaluate({ head: new THREE.Vector3(t, 0, 0) }, SPINE_CHAIN_NODE.defaultParams, ctx(id, t));
    }
    const list = (out.pointLists as THREE.Vector3[][])[0];
    expect(list[0].x).toBeCloseTo(2, 9);
    expect(list[13].x).toBeLessThan(list[0].x - 0.9);
  });

  test("a teleported head re-seeds instead of stretching the chain", () => {
    const id = "spine-teleport";
    SPINE_CHAIN_NODE.evaluate({ head: new THREE.Vector3(0, 0, 0) }, SPINE_CHAIN_NODE.defaultParams, ctx(id, 0));
    const out = SPINE_CHAIN_NODE.evaluate({ head: new THREE.Vector3(50, 0, 0) }, SPINE_CHAIN_NODE.defaultParams, ctx(id, 1 / 60));
    const list = (out.pointLists as THREE.Vector3[][])[0];
    expect(list[0].distanceTo(list[13])).toBeLessThan(1.2);
  });

  test("bad list entries are skipped, not drawn at NaN", () => {
    const out = SPINE_CHAIN_NODE.evaluate({ heads: [new THREE.Vector3(1, 0, 0), "nope", null] }, SPINE_CHAIN_NODE.defaultParams, ctx("spine-bad", 0));
    expect(out.count).toBe(1);
  });
});
