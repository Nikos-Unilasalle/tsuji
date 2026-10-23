import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { METABALLS_NODE } from "./metaballs";
import { EvalContext } from "../types";

function ctx(nodeId: string): EvalContext {
  return { time: 0, step: 0, nodeId, simulationEpoch: 0 };
}

function run(
  inputs: Record<string, unknown>,
  nodeId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const params = { ...(METABALLS_NODE.defaultParams as Record<string, unknown>), ...overrides };
  return METABALLS_NODE.evaluate(inputs, params, ctx(nodeId));
}

function meshOf(out: Record<string, unknown>): THREE.Mesh {
  return out.geometry as THREE.Mesh;
}

/** Vertices actually drawn: all of them when indexed, the draw range of a triangle soup otherwise. */
function vertexCount(out: Record<string, unknown>): number {
  const geometry = meshOf(out).geometry;
  return geometry.getIndex() ? geometry.getAttribute("position").count : geometry.drawRange.count;
}

function bounds(out: Record<string, unknown>): THREE.Box3 {
  const geometry = meshOf(out).geometry;
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const box = new THREE.Box3();
  for (let i = 0; i < vertexCount(out); i++) {
    box.expandByPoint(new THREE.Vector3(position.getX(i), position.getY(i), position.getZ(i)));
  }
  return box;
}

describe("METABALLS_NODE", () => {
  test("one ball meshes a blob centred on the point", () => {
    const out = run({ points: [new THREE.Vector3(2, 1, -1)] }, "mb-one");
    expect(vertexCount(out)).toBeGreaterThan(0);
    expect(out.count).toBe(1);

    const center = bounds(out).getCenter(new THREE.Vector3());
    expect(center.x).toBeCloseTo(2, 1);
    expect(center.y).toBeCloseTo(1, 1);
    expect(center.z).toBeCloseTo(-1, 1);
  });

  test("radius sets the size of the blob in world units", () => {
    const small = run({ points: [new THREE.Vector3(0, 0, 0)] }, "mb-small", { radius: 0.5 });
    const smallSize = bounds(small).getSize(new THREE.Vector3()).x;
    const big = run({ points: [new THREE.Vector3(0, 0, 0)] }, "mb-big", { radius: 1.5 });
    const bigSize = bounds(big).getSize(new THREE.Vector3()).x;

    expect(smallSize).toBeGreaterThan(0.5);
    expect(smallSize).toBeLessThan(1.6);
    expect(bigSize).toBeGreaterThan(smallSize * 2);
  });

  test("two near points fuse into one blob, far ones stay separate", () => {
    const near = run({ points: [new THREE.Vector3(-0.3, 0, 0), new THREE.Vector3(0.3, 0, 0)] }, "mb-near");
    const far = run({ points: [new THREE.Vector3(-6, 0, 0), new THREE.Vector3(6, 0, 0)] }, "mb-far");

    // The fused pair is wider than tall; two islands 12 apart are far wider still.
    const nearBox = bounds(near).getSize(new THREE.Vector3());
    expect(nearBox.x).toBeGreaterThan(nearBox.y);
    expect(nearBox.x).toBeLessThan(3);
    expect(bounds(far).getSize(new THREE.Vector3()).x).toBeGreaterThan(11);
  });

  test("a geometry wire uses its children as centres", () => {
    const group = new THREE.Group();
    for (const x of [-0.4, 0.4]) {
      const child = new THREE.Mesh(new THREE.SphereGeometry(0.1), new THREE.MeshStandardMaterial());
      child.position.set(x, 0, 0);
      group.add(child);
    }
    group.updateMatrixWorld(true);

    const out = run({ geometry: group }, "mb-geom");
    expect(out.count).toBe(2);
    expect(vertexCount(out)).toBeGreaterThan(0);
  });

  test("no centres wired gives an empty mesh, not a throw", () => {
    const out = run({}, "mb-empty");
    expect(out.count).toBe(0);
    expect(vertexCount(out)).toBe(0);
    expect(meshOf(out).geometry.getAttribute("position").count).toBe(0);
  });

  test("returns the same mesh and geometry every evaluation", () => {
    const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.5, 0, 0)];
    const first = run({ points }, "mb-identity");
    const second = run({ points }, "mb-identity");
    expect(second.geometry).toBe(first.geometry);
    expect(meshOf(second).geometry).toBe(meshOf(first).geometry);
  });

  test("moving a centre moves the mesh", () => {
    const before = run({ points: [new THREE.Vector3(0, 0, 0)] }, "mb-move");
    const beforeX = bounds(before).getCenter(new THREE.Vector3()).x;
    const after = run({ points: [new THREE.Vector3(3, 0, 0)] }, "mb-move");
    expect(bounds(after).getCenter(new THREE.Vector3()).x).toBeGreaterThan(beforeX + 2);
  });

  test("garbage in the point list is skipped, not meshed", () => {
    const out = run({ points: [null, "nope", { x: 0, y: 0, z: 0 }, new THREE.Vector3(NaN, 0, 0)] }, "mb-garbage");
    expect(out.count).toBe(1);
    expect(Number.isFinite(bounds(out).getCenter(new THREE.Vector3()).x)).toBe(true);
  });

  test("Surface Nets meshes indexed, smooth-shaded geometry; the legacy mesher a triangle soup", () => {
    const points = [new THREE.Vector3(0, 0, 0)];
    const sn = meshOf(run({ points }, "mb-sn")).geometry;
    expect(sn.getIndex()).not.toBeNull();
    expect(sn.drawRange.count).toBe(sn.getIndex()!.count);
    const mc = meshOf(run({ points }, "mb-mc", { mesher: "marchingCubes", resolution: 32 })).geometry;
    expect(mc.getIndex()).toBeNull();
    expect(mc.drawRange.count % 3).toBe(0);
  });

  test("switching mesher on the same node swaps the geometry layout in place", () => {
    const points = [new THREE.Vector3(0, 0, 0)];
    const first = meshOf(run({ points }, "mb-switch"));
    run({ points }, "mb-switch", { mesher: "marchingCubes" });
    expect(first.geometry.getIndex()).toBeNull();
    const back = meshOf(run({ points }, "mb-switch"));
    expect(back).toBe(first);
    expect(back.geometry.getIndex()).not.toBeNull();
  });

  test("a lone ball's surface sits at its radius", () => {
    const out = run({ points: [new THREE.Vector3(0, 0, 0)] }, "mb-exact", { radius: 1.25 });
    expect(bounds(out).getSize(new THREE.Vector3()).x).toBeCloseTo(2.5, 1);
  });

  test("Radii sets each ball's own size", () => {
    const out = run({ points: [new THREE.Vector3(-4, 0, 0), new THREE.Vector3(4, 0, 0)], radii: [0.5, 2] }, "mb-radii");
    const box = bounds(out);
    expect(box.min.x).toBeCloseTo(-4.5, 1);
    expect(box.max.x).toBeCloseTo(6, 1);
    expect(box.max.y).toBeCloseTo(2, 1);
  });

  test("a negative weight carves a ball out of its neighbour", () => {
    const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)];
    const out = run({ points, radii: [1, 0.6], weights: [1, -1] }, "mb-carve");
    expect(out.count).toBe(2);
    expect(bounds(out).max.x).toBeLessThan(0.8);
  });

  test("Segments mesh capsules", () => {
    const out = run({ segments: [[new THREE.Vector3(0, -2, 0), new THREE.Vector3(0, 2, 0)]] }, "mb-capsule", { radius: 0.4 });
    expect(out.count).toBe(1);
    const size = bounds(out).getSize(new THREE.Vector3());
    expect(size.y).toBeCloseTo(4.8, 1);
    expect(size.x).toBeCloseTo(0.8, 1);
  });

  test("a point list on Segments is a polyline: one capsule per span", () => {
    const zigzag = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 0, 0), new THREE.Vector3(2, 2, 0), null, new THREE.Vector3(4, 2, 0)];
    const out = run({ segments: zigzag }, "mb-polyline", { radius: 0.3 });
    expect(out.count).toBe(3);
    const box = bounds(out);
    expect(box.min.x).toBeCloseTo(-0.3, 1);
    expect(box.max.x).toBeCloseTo(4.3, 1);
    expect(box.max.y).toBeCloseTo(2.3, 1);
  });

  test("Segments takes several polylines, and {start, end} objects", () => {
    const lists = run({ segments: [[new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 2, 0)], [new THREE.Vector3(5, 0, 0), new THREE.Vector3(5, 1, 0)]] }, "mb-polylines");
    expect(lists.count).toBe(3);
    const objects = run({ segments: [{ start: new THREE.Vector3(0, 0, 0), end: new THREE.Vector3(0, 3, 0) }] }, "mb-objects");
    expect(objects.count).toBe(1);
  });

  test("Colors blend into a vertex colour attribute the material shows", () => {
    const out = run({ points: [new THREE.Vector3(-3, 0, 0), new THREE.Vector3(3, 0, 0)], colors: [new THREE.Color(1, 0, 0), 0x0000ff] }, "mb-colors");
    const mesh = meshOf(out);
    const color = mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    expect(color.count).toBe(mesh.geometry.getAttribute("position").count);
    expect((mesh.material as THREE.MeshStandardMaterial).vertexColors).toBe(true);
    const position = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < color.count; i++) {
      expect(color.getX(i)).toBeCloseTo(position.getX(i) < 0 ? 1 : 0, 4);
    }
    const plain = meshOf(run({ points: [new THREE.Vector3(0, 0, 0)] }, "mb-colors"));
    expect(plain.geometry.getAttribute("color")).toBeUndefined();
    expect((plain.material as THREE.MeshStandardMaterial).vertexColors).toBe(false);
  });

  test("instances become ellipsoids along their scale, and can inherit their colours", () => {
    const instanced = new THREE.InstancedMesh(new THREE.SphereGeometry(0.1), new THREE.MeshStandardMaterial(), 1);
    instanced.setMatrixAt(0, new THREE.Matrix4().makeScale(3, 1, 1));
    instanced.setColorAt(0, new THREE.Color(0, 1, 0));
    const group = new THREE.Group();
    group.add(instanced);
    group.updateMatrixWorld(true);
    const shaped = run({ geometry: group }, "mb-shape", { radius: 0.5, instanceShape: true, inheritColors: true });
    const size = bounds(shaped).getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(3, 1);
    expect(size.y).toBeCloseTo(1, 1);
    const color = meshOf(shaped).geometry.getAttribute("color") as THREE.BufferAttribute;
    expect(color.getY(0)).toBeCloseTo(1, 4);
    const round = run({ geometry: group }, "mb-round", { radius: 0.5 });
    expect(bounds(round).getSize(new THREE.Vector3()).x).toBeCloseTo(1, 1);
  });

  test("extreme params stay finite", () => {
    const points = [new THREE.Vector3(0, 0, 0)];
    for (const overrides of [
      { radius: 0 },
      { radius: -5 },
      { smooth: 1 },
      { smooth: 0 },
      { smooth: 1000 },
      { resolution: 0 },
      { resolution: 10000 },
      { autoFit: false, fieldSize: 0 },
      { mesher: "marchingCubes", resolution: 10000 },
      { mesher: "marchingCubes", autoFit: false, fieldSize: 0 },
    ]) {
      const out = run({ points }, `mb-extreme-${JSON.stringify(overrides)}`, overrides);
      const position = meshOf(out).geometry.getAttribute("position") as THREE.BufferAttribute;
      // One assertion for the whole buffer: a per-float expect() on a 96³
      // field is hundreds of thousands of them, which is seconds of runtime.
      let allFinite = true;
      for (let i = 0; i < position.count * 3; i++) {
        if (!Number.isFinite(position.array[i])) allFinite = false;
      }
      expect(allFinite, `non-finite vertex with ${JSON.stringify(overrides)}`).toBe(true);
    }
  });
});
