import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { COLLISION_NODE } from "./collision";
import { EvalContext } from "../types";

let n = 0;
const ctxAt = (id: string, time = 0, extra: Partial<EvalContext> = {}): EvalContext => ({ time, step: Math.round(time * 60), nodeId: id, ...extra });

function sphere(x: number, y = 0, r = 1): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshStandardMaterial());
  m.position.set(x, y, 0);
  m.updateMatrix();
  m.matrixAutoUpdate = false;
  return m;
}
const run = (a: unknown, b: unknown, id: string, time: number, mode = "mesh", extra: Partial<EvalContext> = {}) =>
  COLLISION_NODE.evaluate({ a, b }, { mode }, ctxAt(id, time, extra)) as { trigger: number; colliding: number };

describe("COLLISION_NODE", () => {
  it("is a logic node with two geometry inputs and a value trigger", () => {
    expect(COLLISION_NODE.category).toBe("logic");
    expect(COLLISION_NODE.inputs.map((i) => i.type)).toEqual(["geometry", "geometry"]);
    expect(COLLISION_NODE.outputs[0]).toMatchObject({ id: "trigger", type: "value" });
  });

  it("reports nothing with an input missing", () => {
    const id = `c${n++}`;
    expect(run(sphere(0), undefined, id, 0)).toEqual({ trigger: 0, colliding: 0 });
  });

  it("triggers once when two spheres start touching, holds colliding while they overlap", () => {
    const id = `c${n++}`;
    const a = sphere(0);
    const b = sphere(5);
    expect(run(a, b, id, 0).trigger).toBe(0);
    b.position.x = 1.5;
    b.updateMatrix();
    expect(run(a, b, id, 1 / 60)).toEqual({ trigger: 1, colliding: 1 });
    expect(run(a, b, id, 2 / 60)).toEqual({ trigger: 0, colliding: 1 });
    b.position.x = 5;
    b.updateMatrix();
    expect(run(a, b, id, 3 / 60)).toEqual({ trigger: 0, colliding: 0 });
    b.position.x = 1.5;
    b.updateMatrix();
    expect(run(a, b, id, 4 / 60).trigger).toBe(1);
  });

  it("mesh mode is exact: bounding boxes overlapping is not a hit", () => {
    // Two unit spheres whose boxes overlap at the corner but whose surfaces do not meet.
    const a = sphere(0);
    const b = sphere(1.8, 1.8);
    expect(run(a, b, `c${n++}`, 0, "mesh").colliding).toBe(0);
    expect(run(a, b, `c${n++}`, 0, "bounds").colliding).toBe(1);
  });

  it("any piece of a group counts, at its world pose through the parent chain", () => {
    const group = new THREE.Group();
    group.position.set(10, 0, 0);
    group.updateMatrix();
    group.matrixAutoUpdate = false;
    group.add(sphere(0), sphere(0, 5));
    // matrixWorld is deliberately not updated: the node must not rely on it.
    expect(run(group, sphere(10.5), `c${n++}`, 0).colliding).toBe(1);
    expect(run(group, sphere(0), `c${n++}`, 0).colliding).toBe(0);
  });

  it("re-arms after a Reset Simulation", () => {
    const id = `c${n++}`;
    const a = sphere(0);
    const b = sphere(1);
    expect(run(a, b, id, 0, "mesh", { simulationEpoch: 0 }).trigger).toBe(1);
    expect(run(a, b, id, 1 / 60, "mesh", { simulationEpoch: 0 }).trigger).toBe(0);
    expect(run(a, b, id, 2 / 60, "mesh", { simulationEpoch: 1 }).trigger).toBe(1);
  });
});
