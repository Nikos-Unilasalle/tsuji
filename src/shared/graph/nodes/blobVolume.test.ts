import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { EvalContext } from "../types";
import { MAX_VOLUME_ELEMENTS, volumeBlobs, VolumeBlobs } from "./blobVolume";
import { METABALL_ATTRIBUTES_NODE } from "./metaballAttributes";
import { METABALLS_NODE } from "./metaballs";

const I = new THREE.Matrix4();

/** The volume's own field, normalized so its flat faces read 1. */
function field(v: VolumeBlobs, x: number, y: number, z: number): number {
  const r2 = v.reach * v.reach;
  let sum = 0;
  for (let i = 0; i < v.count; i++) {
    const d2 = (v.points[i * 3] - x) ** 2 + (v.points[i * 3 + 1] - y) ** 2 + (v.points[i * 3 + 2] - z) ** 2;
    if (d2 < r2) sum += v.fill[i] * v.unitWeight * (1 - d2 / r2) ** 3;
  }
  return sum;
}

const ctx = (nodeId: string): EvalContext => ({ time: 0, step: 0, nodeId, simulationEpoch: 0 });

function metaballs(inputs: Record<string, unknown>, id: string, overrides: Record<string, unknown> = {}): THREE.Mesh {
  const params = { ...(METABALLS_NODE.defaultParams as Record<string, unknown>), volumes: true, resolution: 96, ...overrides };
  return METABALLS_NODE.evaluate(inputs, params, ctx(id)).geometry as THREE.Mesh;
}

function bounds(m: THREE.Mesh): THREE.Box3 {
  const p = m.geometry.getAttribute("position") as THREE.BufferAttribute;
  const b = new THREE.Box3();
  for (let i = 0; i < p.count; i++) b.expandByPoint(new THREE.Vector3().fromBufferAttribute(p, i));
  return b;
}

const solid = (geometry: THREE.BufferGeometry, color = 0xff8800) => new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color }));

describe("volumeBlobs", () => {
  test("a flat face sits where the mesh's face is, wherever it falls in the lattice", () => {
    for (const softness of [0.3, 0.37, 0.52]) {
      const v = volumeBlobs(new THREE.BoxGeometry(2, 2, 2), I, softness)!;
      expect(v.sheet).toBe(false);
      for (const [x, y, z] of [[1, 0, 0], [0, -1, 0.3], [0.2, 0.4, 1]]) expect(field(v, x, y, z)).toBeCloseTo(1, 1);
      expect(field(v, 0, 0, 0)).toBeGreaterThan(1.8);
      expect(field(v, 1 + softness * 0.5, 0, 0)).toBeLessThan(0.5);
    }
  });

  test("a face at an angle to the lattice lands right too", () => {
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.3, 0.7, 0.2));
    const v = volumeBlobs(new THREE.BoxGeometry(2, 2, 2), m, 0.35)!;
    const normal = new THREE.Vector3(1, 0, 0).applyMatrix4(m);
    expect(field(v, normal.x, normal.y, normal.z)).toBeCloseTo(1, 1);
  });

  test("overlapping closed parts are one solid; a mesh with no inside becomes a sheet", () => {
    const a = new THREE.BoxGeometry(2, 1, 1);
    const b = new THREE.BoxGeometry(1, 2, 1);
    const merged = new THREE.BufferGeometry();
    const pa = a.toNonIndexed().attributes.position.array;
    const pb = b.toNonIndexed().attributes.position.array;
    merged.setAttribute("position", new THREE.BufferAttribute(Float32Array.from([...pa, ...pb]), 3));
    const v = volumeBlobs(merged, I, 0.25)!;
    expect(field(v, 0, 0, 0)).toBeGreaterThan(1.8);
    expect(field(v, 1, 0, 0)).toBeCloseTo(1, 1);

    const plane = volumeBlobs(new THREE.PlaneGeometry(2, 2), I, 0.4)!;
    expect(plane.sheet).toBe(true);
    expect(field(plane, 0, 0, 0.1)).toBeCloseTo(1, 1);
  });

  test("a huge object at a tiny softness is coarsened to stay under the element cap", () => {
    const v = volumeBlobs(new THREE.BoxGeometry(40, 40, 40), I, 0.05)!;
    expect(v.count).toBeLessThanOrEqual(MAX_VOLUME_ELEMENTS);
    expect(v.reach).toBeGreaterThan(0.05);
  });
});

describe("Metaballs with Objects as Volumes", () => {
  test("a box stays a box, rounded at its edges", () => {
    const b = bounds(metaballs({ geometry: solid(new THREE.BoxGeometry(2, 1, 1)) }, "vol-box", { softness: 0.2 }));
    expect(b.min.x).toBeCloseTo(-1, 1);
    expect(b.max.x).toBeCloseTo(1, 1);
    expect(b.max.y).toBeCloseTo(0.5, 1);
  });

  test("a torus keeps its hole", () => {
    const out = metaballs({ geometry: solid(new THREE.TorusGeometry(1, 0.35, 16, 48)) }, "vol-torus", { softness: 0.2 });
    const p = out.geometry.getAttribute("position") as THREE.BufferAttribute;
    let nearest = Infinity;
    for (let i = 0; i < p.count; i++) nearest = Math.min(nearest, Math.hypot(p.getX(i), p.getY(i)));
    expect(nearest).toBeGreaterThan(0.55);
    expect(bounds(out).max.x).toBeCloseTo(1.35, 1);
  });

  test("Metaball Attributes switches one object to a volume, the other stays a point", () => {
    const box = solid(new THREE.BoxGeometry(2, 2, 2));
    box.position.x = -3;
    const tagged = METABALL_ATTRIBUTES_NODE.evaluate(
      { geometry: box },
      { ...(METABALL_ATTRIBUTES_NODE.defaultParams as Record<string, unknown>), shape: "volume", softness: 0.2 },
      ctx("vol-attr"),
    ).geometry as THREE.Object3D;
    const marker = solid(new THREE.SphereGeometry(0.1));
    marker.position.x = 3;
    const group = new THREE.Group().add(tagged, marker);
    const b = bounds(metaballs({ geometry: group }, "vol-mixed", { volumes: false, radius: 0.5 }));
    expect(b.min.x).toBeCloseTo(-4, 1);
    expect(b.max.x).toBeCloseTo(3.5, 1);
  });

  test("a carver volume cuts its own shape out", () => {
    const hole = solid(new THREE.BoxGeometry(1, 1, 4));
    const out = metaballs({ geometry: solid(new THREE.BoxGeometry(2, 2, 2)), carveGeometry: hole }, "vol-carve", { softness: 0.15 });
    const p = out.geometry.getAttribute("position") as THREE.BufferAttribute;
    let nearest = Infinity;
    for (let i = 0; i < p.count; i++) nearest = Math.min(nearest, Math.hypot(p.getX(i), p.getY(i)));
    // The square hole's walls are half a unit from the axis; nothing is left inside them.
    expect(nearest).toBeGreaterThan(0.4);
    expect(nearest).toBeLessThan(0.6);
  });
});
