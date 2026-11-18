import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { EvalContext } from "../types";
import { BLOB_FIELD_POINTS_NODE } from "./blobField";
import { METABALL_ATTRIBUTES_NODE } from "./metaballAttributes";
import { METABALLS_NODE } from "./metaballs";

const ctx = (nodeId: string): EvalContext => ({ time: 0, step: 0, nodeId, simulationEpoch: 0 });

const ball = (x = 0) => {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.1), new THREE.MeshStandardMaterial());
  mesh.position.set(x, 0, 0);
  return mesh;
};

function tag(object: THREE.Object3D, attrs: Record<string, number>, id: string): THREE.Object3D {
  const params = { ...(METABALL_ATTRIBUTES_NODE.defaultParams as Record<string, unknown>), ...attrs };
  return METABALL_ATTRIBUTES_NODE.evaluate({ geometry: object }, params, ctx(id)).geometry as THREE.Object3D;
}

function mesh(inputs: Record<string, unknown>, id: string, overrides: Record<string, unknown> = {}): THREE.Mesh {
  const params = { ...(METABALLS_NODE.defaultParams as Record<string, unknown>), ...overrides };
  return METABALLS_NODE.evaluate(inputs, params, ctx(id)).geometry as THREE.Mesh;
}

function box(m: THREE.Mesh): THREE.Box3 {
  const position = m.geometry.getAttribute("position") as THREE.BufferAttribute;
  const b = new THREE.Box3();
  for (let i = 0; i < position.count; i++) b.expandByPoint(new THREE.Vector3().fromBufferAttribute(position, i));
  return b;
}

const group = (...children: THREE.Object3D[]) => {
  const g = new THREE.Group();
  for (const c of children) g.add(c);
  return g;
};

describe("METABALL_ATTRIBUTES_NODE", () => {
  test("tags a copy, never the incoming object, and reuses it while nothing changes", () => {
    const source = ball();
    const a = tag(source, { radius: 1 }, "ma-copy");
    expect(a).not.toBe(source);
    expect(source.userData.metaball).toBeUndefined();
    expect(a.userData.metaball).toEqual({ radius: 1, weight: 1 });
    expect(tag(source, { radius: 1 }, "ma-copy")).toBe(a);
    source.position.x = 2;
    expect(tag(source, { radius: 1 }, "ma-copy")).not.toBe(a);
  });

  test("an object's own radius sizes its blob, the others keep the node's", () => {
    const big = tag(ball(-3), { radius: 1.2 }, "ma-r");
    const out = mesh({ geometry: group(big, ball(3)) }, "mb-ma-r", { radius: 0.5 });
    const b = box(out);
    expect(b.min.x).toBeCloseTo(-4.2, 1);
    expect(b.max.x).toBeCloseTo(3.5, 1);
    expect(b.max.y).toBeCloseTo(1.2, 1);
  });

  test("an object's own smooth changes how far it blends, not its size", () => {
    const lone = box(mesh({ geometry: group(tag(ball(), { smooth: 3 }, "ma-s1")) }, "mb-ma-s1", { radius: 0.5 }));
    expect(lone.max.x).toBeCloseTo(0.5, 1);

    // 1.1 apart with radius 0.5: the node's Smooth bridges them, a tight one leaves a gap.
    const bridged = (m: THREE.Mesh) => {
      const p = m.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) if (Math.abs(p.getX(i)) < 0.04) return true;
      return false;
    };
    expect(bridged(mesh({ geometry: group(ball(-0.55), ball(0.55)) }, "mb-ma-s2", { radius: 0.5 }))).toBe(true);
    const tight = group(tag(ball(-0.55), { smooth: 1.05 }, "ma-s3"), tag(ball(0.55), { smooth: 1.05 }, "ma-s4"));
    expect(bridged(mesh({ geometry: tight }, "mb-ma-s3", { radius: 0.5 }))).toBe(false);
  });

  test("a resolution can only refine the whole mesh", () => {
    const coarse = mesh({ geometry: group(ball()) }, "mb-ma-res1", { resolution: 16 });
    const fine = mesh({ geometry: group(tag(ball(), { resolution: 64 }, "ma-res")) }, "mb-ma-res2", { resolution: 16 });
    const lower = mesh({ geometry: group(tag(ball(), { resolution: 8 }, "ma-res3")) }, "mb-ma-res3", { resolution: 16 });
    const count = (m: THREE.Mesh) => m.geometry.getAttribute("position").count;
    expect(count(fine)).toBeGreaterThan(count(coarse) * 4);
    expect(count(lower)).toBe(count(coarse));
  });

  test("tagging a group covers its children; a Radii list still wins", () => {
    const tagged = tag(group(ball(-3), ball(3)), { radius: 1 }, "ma-g");
    expect(box(mesh({ geometry: tagged }, "mb-ma-g", { radius: 0.5 })).max.y).toBeCloseTo(1, 1);
    expect(box(mesh({ geometry: tagged, radii: [0.3, 0.3] }, "mb-ma-g2", { radius: 0.5 })).max.y).toBeCloseTo(0.3, 1);
  });

  test("a carver's own radius and weight set its hole", () => {
    const base = { points: [new THREE.Vector3()] };
    const carver = ball(1);
    const plain = box(mesh({ ...base, carveGeometry: carver }, "mb-ma-c1", { radius: 1, carveRadius: 0.4 }));
    const wide = box(mesh({ ...base, carveGeometry: tag(carver, { radius: 0.9 }, "ma-c2") }, "mb-ma-c2", { radius: 1, carveRadius: 0.4 }));
    const off = box(mesh({ ...base, carveGeometry: tag(carver, { weight: 0 }, "ma-c3") }, "mb-ma-c3", { radius: 1, carveRadius: 0.4 }));
    expect(wide.max.x).toBeLessThan(plain.max.x - 0.1);
    expect(off.max.x).toBeCloseTo(1, 1);
  });

  test("Blob Field reads an object's radius and weight too", () => {
    const params = { ...(BLOB_FIELD_POINTS_NODE.defaultParams as Record<string, unknown>) };
    const out = BLOB_FIELD_POINTS_NODE.evaluate({ geometry: group(tag(ball(), { radius: 0.8, weight: 2 }, "ma-bf")) }, params, ctx("bf"));
    const e = (out.field as { elements: { radius: number; weight: number }[] }).elements[0];
    expect([e.radius, e.weight]).toEqual([0.8, 2]);
  });
});
