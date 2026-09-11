import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import { BOOLEAN_NODE } from "./boolean";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "boolean-test" };

/** A box at a world position, driven the same way an object node drives its mesh (matrixAutoUpdate off). */
function boxAt(x: number, material?: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material ?? new THREE.MeshStandardMaterial());
  mesh.matrixAutoUpdate = false;
  mesh.matrix.makeTranslation(x, 0, 0);
  mesh.updateMatrixWorld(true);
  return mesh;
}

describe("BOOLEAN_NODE", () => {
  it("subtracts the second shape from the first", () => {
    const a = boxAt(0);
    const b = boxAt(0.5);
    const res = BOOLEAN_NODE.evaluate(
      { geometry: a, boolean: b, operation: "subtract" },
      BOOLEAN_NODE.defaultParams,
      CTX,
    );
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(mesh.geometry.attributes.position.count).toBeGreaterThan(0);
  });

  it("unions two shapes", () => {
    const a = boxAt(0);
    const b = boxAt(0.5);
    const res = BOOLEAN_NODE.evaluate(
      { geometry: a, boolean: b, operation: "add" },
      BOOLEAN_NODE.defaultParams,
      CTX,
    );
    expect((res.geometry as THREE.Mesh).geometry.attributes.position.count).toBeGreaterThan(0);
  });

  it("intersects two shapes", () => {
    const a = boxAt(0);
    const b = boxAt(0.5);
    const res = BOOLEAN_NODE.evaluate(
      { geometry: a, boolean: b, operation: "intersect" },
      BOOLEAN_NODE.defaultParams,
      CTX,
    );
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    // The two boxes overlap in a smaller volume — a real result, not empty.
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox!;
    expect(bb.max.x - bb.min.x).toBeLessThan(1.5);
  });

  it("re-runs CSG when a source's pose (matrix) changes, even with a stale matrixWorld", () => {
    const a = boxAt(0);
    const b = boxAt(0.5);
    const r1 = BOOLEAN_NODE.evaluate(
      { geometry: a, boolean: b, operation: "intersect" },
      BOOLEAN_NODE.defaultParams,
      CTX,
    );
    const g1 = (r1.geometry as THREE.Mesh).geometry;

    // Animate b's pose the way a graph-driven mesh is driven: matrix set via
    // matrix.copy() (matrixAutoUpdate off), leaving matrixWorld *stale*. The
    // boolean must force the recompute to see the new pose.
    b.matrix.makeTranslation(4, 0, 0);

    const r2 = BOOLEAN_NODE.evaluate(
      { geometry: a, boolean: b, operation: "intersect" },
      BOOLEAN_NODE.defaultParams,
      CTX,
    );
    // The result must be recomputed, not a stale cache hit.
    expect((r2.geometry as THREE.Mesh).geometry).not.toBe(g1);
  });

  it("re-runs CSG when a source's vertices change in place (vertex animation)", () => {
    const a = boxAt(0);
    const b = boxAt(0.5);
    const r1 = BOOLEAN_NODE.evaluate(
      { geometry: a, boolean: b, operation: "intersect" },
      BOOLEAN_NODE.defaultParams,
      CTX,
    );
    const g1 = (r1.geometry as THREE.Mesh).geometry;

    // Mutate b's vertices in place — same geometry uuid, as a deforming source.
    const pos = b.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setX(i, pos.getX(i) + 5);
    pos.needsUpdate = true;

    const r2 = BOOLEAN_NODE.evaluate(
      { geometry: a, boolean: b, operation: "intersect" },
      BOOLEAN_NODE.defaultParams,
      CTX,
    );
    // The result must be recomputed, not a stale cache hit.
    expect((r2.geometry as THREE.Mesh).geometry).not.toBe(g1);
  });

  it("inherits each shape's material on the faces it contributed (useGroups)", () => {
    const a = boxAt(0, new THREE.MeshStandardMaterial({ color: 0xff0000 }));
    const b = boxAt(0.5, new THREE.MeshStandardMaterial({ color: 0x00ff00 }));
    const res = BOOLEAN_NODE.evaluate(
      { geometry: a, boolean: b, operation: "add" },
      BOOLEAN_NODE.defaultParams,
      CTX,
    );
    const mesh = res.geometry as THREE.Mesh;
    // With useGroups on, the result carries a per-input material array and the
    // geometry keeps groups so faces from object 2 use object 2's material.
    expect(Array.isArray(mesh.material)).toBe(true);
    const mats = mesh.material as THREE.Material[];
    expect(mats.length).toBeGreaterThanOrEqual(2);
    expect(mesh.geometry.groups.length).toBeGreaterThan(0);
  });
});

/**
 * A Group of meshes is what Array / Merge / an imported model hand down a
 * `geometry` wire — the shape Boolean used to see only the first mesh of.
 */
function groupOf(...meshes: THREE.Mesh[]): THREE.Group {
  const group = new THREE.Group();
  meshes.forEach((m) => group.add(m));
  group.updateMatrixWorld(true);
  return group;
}

/** How far the result actually reaches along X — the cheapest proof a distant part took part. */
function boundsX(mesh: THREE.Mesh): { min: number; max: number } {
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox!;
  return { min: box.min.x, max: box.max.x };
}

describe("BOOLEAN_NODE — multi-mesh inputs (Array, Merge, imported models)", () => {
  it("cuts with every mesh of the Boolean Shape, not just the first", () => {
    // Three separate cutters spread along X. Only the first overlaps the bar
    // near x=0; if the other two were dropped the bar would keep its full
    // span, which is exactly what an Array wired into Boolean Shape used to do.
    const bar = new THREE.Mesh(new THREE.BoxGeometry(12, 1, 1), new THREE.MeshStandardMaterial());
    bar.matrixAutoUpdate = false;
    bar.matrix.identity();
    bar.updateMatrixWorld(true);

    const cutters = groupOf(boxAt(-5.9), boxAt(0), boxAt(5.9));
    const res = BOOLEAN_NODE.evaluate(
      { geometry: bar, boolean: cutters, operation: "subtract" },
      BOOLEAN_NODE.defaultParams,
      { ...CTX, nodeId: "bool-multi-b" },
    );
    const mesh = res.geometry as THREE.Mesh;
    const { min, max } = boundsX(mesh);
    // The far cutters straddle both ends (±5.9 ± 0.5), so a bar that really
    // met all three is bitten in at each end rather than reaching ±6.
    expect(min).toBeGreaterThan(-6);
    expect(max).toBeLessThan(6);
  });

  it("subtracts from every mesh of the target, not just the first", () => {
    const targets = groupOf(boxAt(0), boxAt(4));
    // One tall cutter crossing both boxes.
    const cutter = new THREE.Mesh(new THREE.BoxGeometry(10, 0.4, 2), new THREE.MeshStandardMaterial());
    cutter.matrixAutoUpdate = false;
    cutter.matrix.makeTranslation(2, 0, 0);
    cutter.updateMatrixWorld(true);

    const res = BOOLEAN_NODE.evaluate(
      { geometry: targets, boolean: cutter, operation: "subtract" },
      BOOLEAN_NODE.defaultParams,
      { ...CTX, nodeId: "bool-multi-a" },
    );
    const mesh = res.geometry as THREE.Mesh;
    // Both boxes survive in the result — dropping the second would end the
    // geometry near x=0.5 instead of reaching the far box at x=4.
    expect(boundsX(mesh).max).toBeGreaterThan(3);
  });

  it("intersects against the union of the parts, so disjoint cutters do not cancel out", () => {
    // Folding the parts one after another (A ∩ B1 ∩ B2) is empty whenever the
    // cutters are disjoint, which is every Array. The parts have to combine
    // into one shape first.
    const bar = new THREE.Mesh(new THREE.BoxGeometry(12, 1, 1), new THREE.MeshStandardMaterial());
    bar.matrixAutoUpdate = false;
    bar.matrix.identity();
    bar.updateMatrixWorld(true);

    const cutters = groupOf(boxAt(-3), boxAt(3));
    const res = BOOLEAN_NODE.evaluate(
      { geometry: bar, boolean: cutters, operation: "intersect" },
      BOOLEAN_NODE.defaultParams,
      { ...CTX, nodeId: "bool-multi-int" },
    );
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh.geometry.attributes.position.count).toBeGreaterThan(0);
    // Both cut-outs survive: the result spans from the left box to the right.
    const { min, max } = boundsX(mesh);
    expect(min).toBeLessThan(-2);
    expect(max).toBeGreaterThan(2);
  });

  it("merges parts that carry different attribute sets rather than refusing them", () => {
    // A hand-built part with no uv next to a primitive that has one — the
    // mismatch mergeGeometries would otherwise reject outright.
    const plain = new THREE.BoxGeometry(1, 1, 1);
    plain.deleteAttribute("uv");
    const bare = new THREE.Mesh(plain, new THREE.MeshStandardMaterial());
    bare.matrixAutoUpdate = false;
    bare.matrix.makeTranslation(0, 0, 0);
    bare.updateMatrixWorld(true);

    const bar = new THREE.Mesh(new THREE.BoxGeometry(12, 1, 1), new THREE.MeshStandardMaterial());
    bar.matrixAutoUpdate = false;
    bar.matrix.identity();
    bar.updateMatrixWorld(true);

    const res = BOOLEAN_NODE.evaluate(
      { geometry: bar, boolean: groupOf(bare, boxAt(5.9)), operation: "subtract" },
      BOOLEAN_NODE.defaultParams,
      { ...CTX, nodeId: "bool-multi-attrs" },
    );
    const mesh = res.geometry as THREE.Mesh;
    expect(mesh.geometry.attributes.position.count).toBeGreaterThan(0);
    expect(boundsX(mesh).max).toBeLessThan(6);
  });

  it("re-runs the CSG when one instance deep in a multi-mesh input moves", () => {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(12, 1, 1), new THREE.MeshStandardMaterial());
    bar.matrixAutoUpdate = false;
    bar.matrix.identity();
    bar.updateMatrixWorld(true);

    const far = boxAt(5.9);
    const cutters = groupOf(boxAt(0), far);
    const ctx = { ...CTX, nodeId: "bool-multi-sig" };
    const first = BOOLEAN_NODE.evaluate({ geometry: bar, boolean: cutters, operation: "subtract" }, BOOLEAN_NODE.defaultParams, ctx);
    const firstMax = boundsX(first.geometry as THREE.Mesh).max;

    // Move only the second cutter off the bar's end — the signature has to
    // notice a mesh that is not the first one.
    far.matrix.makeTranslation(20, 0, 0);
    far.updateMatrixWorld(true);
    cutters.updateMatrixWorld(true);
    const second = BOOLEAN_NODE.evaluate({ geometry: bar, boolean: cutters, operation: "subtract" }, BOOLEAN_NODE.defaultParams, ctx);
    const secondMax = boundsX(second.geometry as THREE.Mesh).max;

    expect(secondMax).toBeGreaterThan(firstMax);
  });

  it("keeps each mesh's own material on a multi-mesh side, not just the first one's", () => {
    // Two differently-coloured boxes on side A, sharing no material — the
    // fix that groups bakeMeshesToGeometry's parts so each one lines up with
    // its own material instead of collapsing the whole side to boxAt(0)'s.
    const red = boxAt(0, new THREE.MeshStandardMaterial({ color: 0xff0000 }));
    const blue = boxAt(4, new THREE.MeshStandardMaterial({ color: 0x0000ff }));
    const targets = groupOf(red, blue);

    const cutter = boxAt(-10, new THREE.MeshStandardMaterial({ color: 0x00ff00 }));

    const res = BOOLEAN_NODE.evaluate(
      { geometry: targets, boolean: cutter, operation: "add" },
      BOOLEAN_NODE.defaultParams,
      { ...CTX, nodeId: "bool-multi-materials" },
    );
    const mesh = res.geometry as THREE.Mesh;
    expect(Array.isArray(mesh.material)).toBe(true);
    const mats = (mesh.material as THREE.Material[]).filter((m): m is THREE.MeshStandardMaterial => m instanceof THREE.MeshStandardMaterial);
    const hexes = mats.map((m) => m.color.getHex());
    expect(hexes).toContain(0xff0000);
    expect(hexes).toContain(0x0000ff);
  });
});
