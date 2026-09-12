import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { OBJECT_EXPLOSION_NODE } from "./explosion";

type ExplosionResult = {
  geometry: THREE.Mesh;
  matrix: THREE.Matrix4;
  progress: number;
  active: number;
};

function evaluate(
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
  time: number,
  nodeId: string,
): ExplosionResult {
  return OBJECT_EXPLOSION_NODE.evaluate(inputs, params, { time, step: Math.round(time * 60), nodeId }) as ExplosionResult;
}

const DEFAULTS = OBJECT_EXPLOSION_NODE.defaultParams;
const NO_LOOP = { ...DEFAULTS, loop: 0 };

function scaleOf(res: ExplosionResult): number {
  return new THREE.Vector3().setFromMatrixScale(res.matrix).x;
}

describe("OBJECT_EXPLOSION_NODE", () => {
  it("has the expected node schema", () => {
    expect(OBJECT_EXPLOSION_NODE.type).toBe("object/explosion");
    expect(OBJECT_EXPLOSION_NODE.category).toBe("object");
    expect(OBJECT_EXPLOSION_NODE.outputs.map((o) => o.id)).toEqual(["geometry", "matrix", "progress", "active"]);
  });

  it("runs the original's timeline when looping", () => {
    const start = evaluate({}, DEFAULTS, 0, "loop");
    expect(start.active).toBe(1);
    expect(start.progress).toBeCloseTo(0.15, 5);
    expect(scaleOf(start)).toBeCloseTo(0.5, 5);

    // Grown to the full fire radius by the end of the 0.6s grow tween.
    expect(scaleOf(evaluate({}, DEFAULTS, 0.6, "loop"))).toBeCloseTo(5, 5);

    // The burn starts after its 0.25s delay and is done 2s later.
    expect(evaluate({}, DEFAULTS, 0.2, "loop").progress).toBeCloseTo(0.15, 5);
    expect(evaluate({}, DEFAULTS, 1.25, "loop").progress).toBeCloseTo(0.575, 5);
    expect(evaluate({}, DEFAULTS, 2.25, "loop").progress).toBeCloseTo(1, 5);
  });

  it("goes dark between loops and comes back on the next one", () => {
    const dead = evaluate({}, DEFAULTS, 2.6, "gap");
    expect(dead.active).toBe(0);
    expect(dead.geometry.visible).toBe(false);

    const reborn = evaluate({}, DEFAULTS, 3.1, "gap");
    expect(reborn.active).toBe(1);
    expect(reborn.geometry.visible).toBe(true);
    expect(reborn.progress).toBeCloseTo(0.15, 5);
  });

  it("scrubbing the timeline lands on the same burst", () => {
    const forward = evaluate({}, DEFAULTS, 6.4, "scrub");
    const rotationA = new THREE.Quaternion().setFromRotationMatrix(forward.matrix);
    evaluate({}, DEFAULTS, 11.0, "scrub");
    const again = evaluate({}, DEFAULTS, 6.4, "scrub");
    const rotationB = new THREE.Quaternion().setFromRotationMatrix(again.matrix);

    expect(again.progress).toBeCloseTo(forward.progress, 6);
    expect(rotationB.angleTo(rotationA)).toBeCloseTo(0, 6);
  });

  it("fires on a rising edge when looping is off", () => {
    expect(evaluate({ trigger: 0 }, NO_LOOP, 0, "trig").active).toBe(0);

    expect(evaluate({ trigger: 1 }, NO_LOOP, 1, "trig").active).toBe(1);
    // Held high, it does not retrigger: the burn keeps running from the first edge.
    expect(evaluate({ trigger: 1 }, NO_LOOP, 2.0, "trig").progress).toBeCloseTo(0.4687, 3);
    expect(evaluate({ trigger: 1 }, NO_LOOP, 3.5, "trig").active).toBe(0);

    evaluate({ trigger: 0 }, NO_LOOP, 3.6, "trig");
    expect(evaluate({ trigger: 1 }, NO_LOOP, 3.7, "trig").progress).toBeCloseTo(0.15, 5);
  });

  it("reuses one mesh and keeps its uniforms finite on junk input", () => {
    const first = evaluate({}, DEFAULTS, 0.1, "stable").geometry;
    const second = evaluate(
      { fireRadius: Number.NaN, emissiveStrength: "loud", location: null },
      DEFAULTS,
      0.2,
      "stable",
    );

    expect(second.geometry).toBe(first);
    const u = (second.geometry.material as THREE.ShaderMaterial).uniforms;
    expect(u.emissiveStrength.value).toBe(2.5);
    expect(Number.isFinite(scaleOf(second))).toBe(true);
    expect(scaleOf(second)).toBeGreaterThan(0);
  });

  it("takes colours and radius from wired inputs", () => {
    const res = evaluate(
      { fireRadius: 2, emissiveColorA: new THREE.Color(0x00ff00), emissiveStrength: 3 },
      DEFAULTS,
      0.6,
      "wired",
    );
    const u = (res.geometry.material as THREE.ShaderMaterial).uniforms;

    expect(scaleOf(res)).toBeCloseTo(2, 5);
    expect(u.emissiveColorA.value.getHex()).toBe(0x00ff00);
    expect(u.emissiveStrength.value).toBe(3);
  });
});
