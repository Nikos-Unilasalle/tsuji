import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { RIPPLE_FIELD_NODE } from "./rippleField";
import { EvalContext } from "../types";
import { STEP_SECONDS } from "../clock";
import { createWaveField, disturb, sampleHeight, setSolid, StepParams, stepWaveField, surfaceHeights, WaveField } from "../ripples/waveField";

const AREA = { centerX: 0, centerZ: 0, sizeX: 10, sizeZ: 10 };
const STEP: StepParams = { speed: 1.5, damping: 0, edges: "reflect", border: 8 };
const ctx = (nodeId: string, step: number): EvalContext => ({ nodeId, step, time: step * STEP_SECONDS });
const params = (o: Record<string, unknown> = {}) => ({ ...(RIPPLE_FIELD_NODE.defaultParams as Record<string, unknown>), resolution: 64, ...o });

function run(field: WaveField, seconds: number, p: StepParams = STEP): void {
  for (let s = 0; s < Math.round(seconds / STEP_SECONDS); s++) stepWaveField(field, STEP_SECONDS, p);
}

function energy(field: WaveField): number {
  let e = 0;
  for (let k = 0; k < field.height.length; k++) e += field.height[k] ** 2 + (field.height[k] - field.previous[k]) ** 2;
  return e;
}

describe("wave field", () => {
  test("a drop spreads as a ring: the centre settles, a point further out starts moving", () => {
    const field = createWaveField(AREA, 64);
    disturb(field, 0, 0, 0.3, 0.1);
    expect(sampleHeight(field, 0, 0)).toBeLessThan(-0.05);
    expect(sampleHeight(field, 2, 0)).toBe(0);
    run(field, 1);
    expect(Math.abs(sampleHeight(field, 0, 0))).toBeLessThan(0.05);
    expect(Math.abs(sampleHeight(field, 1.5, 0))).toBeGreaterThan(1e-4);
  });

  test("the ring is round: equal distances in different directions move alike", () => {
    const field = createWaveField(AREA, 64);
    disturb(field, 0, 0, 0.3, 0.1);
    run(field, 0.8);
    expect(sampleHeight(field, 1.2, 0)).toBeCloseTo(sampleHeight(field, 0, 1.2), 6);
    expect(sampleHeight(field, -1.2, 0)).toBeCloseTo(sampleHeight(field, 0, -1.2), 6);
  });

  test("damping drains the motion; without it the motion lasts", () => {
    const still = createWaveField(AREA, 48);
    const damped = createWaveField(AREA, 48);
    disturb(still, 0, 0, 0.3, 0.1);
    disturb(damped, 0, 0, 0.3, 0.1);
    run(still, 3);
    run(damped, 3, { ...STEP, damping: 2 });
    expect(energy(damped)).toBeLessThan(energy(still) * 0.05);
  });

  test("absorbing edges swallow what reflecting edges send back", () => {
    const reflect = createWaveField(AREA, 48);
    const absorb = createWaveField(AREA, 48);
    disturb(reflect, 0, 0, 0.3, 0.1);
    disturb(absorb, 0, 0, 0.3, 0.1);
    run(reflect, 8);
    run(absorb, 8, { ...STEP, edges: "absorb" });
    expect(energy(absorb)).toBeLessThan(energy(reflect) * 0.05);
  });

  test("stays stable and finite at any wave speed", () => {
    const field = createWaveField(AREA, 64);
    disturb(field, 1, -2, 0.3, 0.1);
    run(field, 2, { ...STEP, speed: 500 });
    expect(Array.from(field.height).every(Number.isFinite)).toBe(true);
    expect(Math.max(...Array.from(field.height).map(Math.abs))).toBeLessThan(0.2);
  });

  test("a solid wall stops the waves: the far side stays calm", () => {
    const behind = (walled: boolean) => {
      const field = createWaveField(AREA, 64);
      if (walled) {
        const solid = new Uint8Array(64 * 64);
        for (let j = 0; j < 64; j++) solid[j * 64 + 32] = 1;
        setSolid(field, solid);
      }
      disturb(field, -2, 0, 0.3, 0.1);
      let max = 0;
      for (let s = 0; s < 240; s++) {
        stepWaveField(field, STEP_SECONDS, STEP);
        max = Math.max(max, Math.abs(sampleHeight(field, 2, 0)));
      }
      return max;
    };
    expect(behind(false)).toBeGreaterThan(1e-3);
    expect(behind(true)).toBe(0);
  });

  test("the drawn surface carries the water's height two cells into a wall, no further", () => {
    const field = createWaveField(AREA, 16);
    const solid = new Uint8Array(16 * 16);
    for (let j = 0; j < 16; j++) for (let i = 8; i < 16; i++) solid[j * 16 + i] = 1;
    setSolid(field, solid);
    for (let j = 0; j < 16; j++) field.height[j * 16 + 7] = 0.1;
    const shown = surfaceHeights(field, new Float32Array(256));
    const row = 5 * 16;
    expect(shown[row + 8]).toBeCloseTo(0.1, 6);
    expect(shown[row + 9]).toBeCloseTo(0.1, 6);
    expect(shown[row + 10]).toBe(0);
    expect(field.height[row + 8]).toBe(0);
  });
});

describe("RIPPLE_FIELD_NODE", () => {
  test("with nothing wired: a flat surface, two maps, same objects every frame", () => {
    const a = RIPPLE_FIELD_NODE.evaluate({}, params(), ctx("rip-flat", 0));
    const b = RIPPLE_FIELD_NODE.evaluate({}, params(), ctx("rip-flat", 1));
    expect(a.geometry).toBeInstanceOf(THREE.Mesh);
    expect(b.geometry).toBe(a.geometry);
    expect(b.normalMap).toBe(a.normalMap);
    expect(b.heightMap).toBeInstanceOf(THREE.DataTexture);
    const pos = (b.geometry as THREE.Mesh).geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) expect(pos.getY(i)).toBe(0);
  });

  test("a drop dents the surface where it lands, in the node's own placement", () => {
    const id = "rip-drop";
    const p = params({ location: new THREE.Vector3(5, 1, 0) });
    RIPPLE_FIELD_NODE.evaluate({}, p, ctx(id, 0));
    const out = RIPPLE_FIELD_NODE.evaluate(
      { drop: 1, dropPoint: new THREE.Vector3(7, 1, 0), probes: [new THREE.Vector3(7, 0, 0), new THREE.Vector3(3, 0, 0)] },
      p,
      ctx(id, 1),
    );
    const [hit, away] = out.probeHeights as number[];
    expect(hit).toBeLessThan(1 - 0.03);
    expect(away).toBeCloseTo(1, 6);
  });

  test("the drop fires on the rising edge only", () => {
    const id = "rip-edge";
    const probe = [new THREE.Vector3(0, 0, 0)];
    RIPPLE_FIELD_NODE.evaluate({ drop: 1, dropPoint: new THREE.Vector3(), probes: probe }, params({ waveSpeed: 0, damping: 0 }), ctx(id, 0));
    const once = (RIPPLE_FIELD_NODE.evaluate({ drop: 1, dropPoint: new THREE.Vector3(), probes: probe }, params({ waveSpeed: 0, damping: 0 }), ctx(id, 1)).probeHeights as number[])[0];
    const still = (RIPPLE_FIELD_NODE.evaluate({ drop: 1, dropPoint: new THREE.Vector3(), probes: probe }, params({ waveSpeed: 0, damping: 0 }), ctx(id, 2)).probeHeights as number[])[0];
    expect(still).toBeCloseTo(once, 9);
  });

  test("a moving source leaves a wake, a resting one does not", () => {
    const run = (id: string, move: boolean) => {
      let out: Record<string, unknown> = {};
      for (let s = 0; s < 30; s++) {
        const x = move ? -2 + s * 0.05 : 0;
        out = RIPPLE_FIELD_NODE.evaluate({ sources: [new THREE.Vector3(x, 0, 0)] }, params(), ctx(id, s));
      }
      const pos = (out.geometry as THREE.Mesh).geometry.getAttribute("position");
      let max = 0;
      for (let i = 0; i < pos.count; i++) max = Math.max(max, Math.abs(pos.getY(i)));
      return max;
    };
    expect(run("rip-still", false)).toBe(0);
    expect(run("rip-wake", true)).toBeGreaterThan(1e-4);
  });

  test("Depth Falloff ignores sources far below the surface", () => {
    let out: Record<string, unknown> = {};
    for (let s = 0; s < 30; s++) {
      out = RIPPLE_FIELD_NODE.evaluate({ sources: [new THREE.Vector3(-2 + s * 0.05, -3, 0)] }, params({ depthFalloff: 0.5 }), ctx("rip-deep", s));
    }
    const pos = (out.geometry as THREE.Mesh).geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) expect(pos.getY(i)).toBe(0);
  });

  test("a scrub backwards calms the water", () => {
    const id = "rip-rewind";
    RIPPLE_FIELD_NODE.evaluate({}, params(), ctx(id, 0));
    RIPPLE_FIELD_NODE.evaluate({ drop: 1, dropPoint: new THREE.Vector3() }, params(), ctx(id, 10));
    const out = RIPPLE_FIELD_NODE.evaluate({ probes: [new THREE.Vector3()] }, params(), ctx(id, 0));
    expect((out.probeHeights as number[])[0]).toBe(0);
  });

  test("each viewport keeps its own water: a lagging one neither resets nor drains the other", () => {
    const view = (sessionId: string, step: number): EvalContext => ({ ...ctx("rip-views", step), sessionId });
    const probe = { probes: [new THREE.Vector3(0.6, 0, 0)] };
    RIPPLE_FIELD_NODE.evaluate({}, params(), view("viewport-0", 0));
    RIPPLE_FIELD_NODE.evaluate({ drop: 1, dropPoint: new THREE.Vector3() }, params(), view("viewport-0", 1));
    let moved = 0;
    for (let s = 2; s < 30; s++) {
      RIPPLE_FIELD_NODE.evaluate({}, params(), view("viewport-1", 0));
      const h = (RIPPLE_FIELD_NODE.evaluate(probe, params(), view("viewport-0", s)).probeHeights as number[])[0];
      moved = Math.max(moved, Math.abs(h));
    }
    expect(moved).toBeGreaterThan(1e-3);
    expect((RIPPLE_FIELD_NODE.evaluate(probe, params(), view("viewport-1", 0)).probeHeights as number[])[0]).toBe(0);
  });

  test("water lets the shadows of what is beneath it through, unless asked to cast its own", () => {
    const water = RIPPLE_FIELD_NODE.evaluate({}, params(), ctx("rip-shadow", 0)).geometry as THREE.Mesh;
    expect(water.castShadow).toBe(false);
    expect(water.receiveShadow).toBe(true);
    const sheet = RIPPLE_FIELD_NODE.evaluate({}, params({ castShadow: true }), ctx("rip-shadow", 1)).geometry as THREE.Mesh;
    expect(sheet.castShadow).toBe(true);
  });

  test("obstacles still the water where they cross it, and follow when they move", () => {
    const rock = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial());
    rock.position.set(2, 0, 0);
    const probes = [new THREE.Vector3(2, 0, 0), new THREE.Vector3(-2, 0, 0)];
    let out: Record<string, unknown> = {};
    // 2 s: long enough for the ring to travel the 2.6 units to the open probe.
    for (let s = 0; s < 120; s++) {
      out = RIPPLE_FIELD_NODE.evaluate(
        { obstacles: rock, probes, drop: s === 1 ? 1 : 0, dropPoint: new THREE.Vector3(0.6, 0, 0) },
        params(),
        ctx("rip-rock", s),
      );
    }
    const [inRock, open] = out.probeHeights as number[];
    expect(inRock).toBe(0);
    expect(Math.abs(open)).toBeGreaterThan(1e-5);

    rock.position.set(-2, 0, 0);
    rock.updateMatrixWorld();
    for (let s = 120; s < 240; s++) out = RIPPLE_FIELD_NODE.evaluate({ obstacles: rock, probes, drop: s === 121 ? 1 : 0, dropPoint: new THREE.Vector3(0, 0, 0) }, params(), ctx("rip-rock", s));
    const [freed, blocked] = out.probeHeights as number[];
    expect(blocked).toBe(0);
    expect(Math.abs(freed)).toBeGreaterThan(1e-5);
  });

  test("waves climb the rock's flank on screen while the water inside stays still", () => {
    const rock = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial());
    rock.position.set(2, 0, 0);
    let flank = 0;
    let out: Record<string, unknown> = {};
    for (let s = 0; s < 120; s++) {
      out = RIPPLE_FIELD_NODE.evaluate(
        { obstacles: rock, drop: s === 1 ? 1 : 0, dropPoint: new THREE.Vector3(0, 0, 0), probes: [new THREE.Vector3(1.05, 0, 0)] },
        params(),
        ctx("rip-flank", s),
      );
      const pos = (out.geometry as THREE.Mesh).geometry.getAttribute("position");
      for (let v = 0; v < pos.count; v++) {
        // Just inside the rock's outline, where it meets the water.
        if (pos.getX(v) > 1.0 && pos.getX(v) < 1.16 && Math.abs(pos.getZ(v)) < 0.08) flank = Math.max(flank, Math.abs(pos.getY(v)));
      }
    }
    expect(flank).toBeGreaterThan(1e-4);
    expect((out.probeHeights as number[])[0]).toBe(0);
  });
});
