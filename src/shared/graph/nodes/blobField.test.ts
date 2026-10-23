import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { BlobFieldValue } from "./blobElements";
import { BLOB_FIELD_COMBINE_NODE, BLOB_FIELD_POINTS_NODE, BLOB_FIELD_POLYLINE_NODE } from "./blobField";
import { METABALLS_NODE } from "./metaballs";
import { NodeDefinition } from "../types";

function evaluate(def: NodeDefinition, inputs: Record<string, unknown>, overrides: Record<string, unknown> = {}, nodeId = "f") {
  return def.evaluate(inputs, { ...(def.defaultParams as Record<string, unknown>), ...overrides }, { time: 0, step: 0, nodeId, simulationEpoch: 0 });
}

const fieldOf = (out: Record<string, unknown>) => out.field as BlobFieldValue;

function meshBounds(field: BlobFieldValue, nodeId: string, overrides: Record<string, unknown> = {}): THREE.Box3 {
  const out = evaluate(METABALLS_NODE, { field }, overrides, nodeId);
  const geometry = (out.geometry as THREE.Mesh).geometry;
  geometry.computeBoundingBox();
  return geometry.boundingBox!;
}

const v = (x: number, y = 0, z = 0) => new THREE.Vector3(x, y, z);

describe("Blob Field: Points", () => {
  test("one element per point, with its radius, weight and colour", () => {
    const out = evaluate(BLOB_FIELD_POINTS_NODE, { points: [v(0), v(2)], radii: [0.3], colors: [0xff0000] }, { radius: 0.5, weight: -2 });
    const { elements } = fieldOf(out);
    expect(out.count).toBe(2);
    expect(elements[0]).toMatchObject({ kind: 0, a: [0, 0, 0], radius: 0.3, weight: -2, color: [1, 0, 0] });
    expect(elements[1]).toMatchObject({ a: [2, 0, 0], radius: 0.5, weight: -2 });
  });

  test("geometry is read in world space, so several sources share one space", () => {
    const group = new THREE.Group();
    group.position.set(10, 0, 0);
    const child = new THREE.Mesh(new THREE.SphereGeometry(0.1), new THREE.MeshStandardMaterial());
    child.position.set(1, 2, 3);
    group.add(child);
    group.updateMatrixWorld(true);
    const { elements } = fieldOf(evaluate(BLOB_FIELD_POINTS_NODE, { geometry: group }));
    expect(elements[0].a).toEqual([11, 2, 3]);
  });

  test("garbage and zero radii are skipped (Radii index the readable points)", () => {
    const out = evaluate(BLOB_FIELD_POINTS_NODE, { points: [null, "x", v(NaN), v(0), v(1)], radii: [0] });
    expect(out.count).toBe(1);
  });
});

describe("Blob Field: Polyline", () => {
  test("a point list is one chained polyline", () => {
    const { elements } = fieldOf(evaluate(BLOB_FIELD_POLYLINE_NODE, { points: [v(0), v(1), v(2)] }));
    expect(elements).toHaveLength(2);
    expect(elements.every((e) => e.kind === 1 && e.chain === 1)).toBe(true);
  });

  test("a curve is sampled into one more polyline with its own chain", () => {
    const curve = new THREE.LineCurve3(v(0, 5), v(4, 5));
    const out = evaluate(BLOB_FIELD_POLYLINE_NODE, { curve, points: [[v(0), v(1)], [v(5), v(6)]] }, { samples: 5 });
    const { elements } = fieldOf(out);
    expect(out.count).toBe(2 + 4);
    expect(new Set(elements.map((e) => e.chain))).toEqual(new Set([1, 2, 3]));
    expect(elements[elements.length - 1].b![0]).toBeCloseTo(4, 5);
  });
});

describe("Blob Field: Combine", () => {
  test("adds fields and renumbers chains so polylines from different fields never merge", () => {
    const a = fieldOf(evaluate(BLOB_FIELD_POLYLINE_NODE, { points: [v(0), v(1), v(2)] }));
    const b = fieldOf(evaluate(BLOB_FIELD_POLYLINE_NODE, { points: [v(0, 3), v(1, 3)] }));
    const out = evaluate(BLOB_FIELD_COMBINE_NODE, { in0: a, in1: b });
    expect(fieldOf(out).elements.map((e) => e.chain)).toEqual([1, 1, 2]);
  });

  test("Subtract flips and scales weights", () => {
    const body = fieldOf(evaluate(BLOB_FIELD_POINTS_NODE, { points: [v(0)] }, { radius: 1 }));
    const hole = fieldOf(evaluate(BLOB_FIELD_POINTS_NODE, { points: [v(1)] }, { radius: 0.6 }));
    const { elements } = fieldOf(evaluate(BLOB_FIELD_COMBINE_NODE, { in0: body, subtract: hole }, { subtractStrength: 2 }));
    expect(elements.map((e) => e.weight)).toEqual([1, -2]);
  });

  test("non-field inputs are ignored", () => {
    expect(evaluate(BLOB_FIELD_COMBINE_NODE, { in0: [1, 2], subtract: "nope" }).count).toBe(0);
  });
});

describe("Metaballs fed a Blob Field", () => {
  test("each element keeps its own radius, whatever Metaballs' own Radius", () => {
    const small = fieldOf(evaluate(BLOB_FIELD_POINTS_NODE, { points: [v(-4)] }, { radius: 0.5 }));
    const big = fieldOf(evaluate(BLOB_FIELD_POINTS_NODE, { points: [v(4)] }, { radius: 1.5 }));
    const both = fieldOf(evaluate(BLOB_FIELD_COMBINE_NODE, { in0: small, in1: big }));
    const box = meshBounds(both, "mbf-radii", { radius: 3 });
    expect(box.min.x).toBeCloseTo(-4.5, 1);
    expect(box.max.x).toBeCloseTo(5.5, 1);
    expect(box.max.y).toBeCloseTo(1.5, 1);
  });

  test("a subtracted field carves", () => {
    const body = fieldOf(evaluate(BLOB_FIELD_POINTS_NODE, { points: [v(0)] }, { radius: 1 }));
    const hole = fieldOf(evaluate(BLOB_FIELD_POINTS_NODE, { points: [v(1)] }, { radius: 0.6 }));
    const whole = meshBounds(body, "mbf-whole");
    const carved = meshBounds(fieldOf(evaluate(BLOB_FIELD_COMBINE_NODE, { in0: body, subtract: hole })), "mbf-carved");
    expect(whole.max.x).toBeCloseTo(1, 1);
    expect(carved.max.x).toBeLessThan(0.8);
  });

  test("a curve field meshes as a tube along it", () => {
    const curve = new THREE.LineCurve3(v(-2), v(2));
    const tube = fieldOf(evaluate(BLOB_FIELD_POLYLINE_NODE, { curve }, { radius: 0.3, samples: 9 }));
    const box = meshBounds(tube, "mbf-tube");
    expect(box.min.x).toBeCloseTo(-2.3, 1);
    expect(box.max.x).toBeCloseTo(2.3, 1);
    expect(box.max.y).toBeCloseTo(0.3, 1);
  });

  test("field elements come on top of the node's own centres", () => {
    const extra = fieldOf(evaluate(BLOB_FIELD_POINTS_NODE, { points: [v(5)] }));
    const out = evaluate(METABALLS_NODE, { points: [v(0)], field: extra }, {}, "mbf-both");
    expect(out.count).toBe(2);
  });
});
