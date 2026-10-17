import * as THREE from "three";
import { ADDITION, Brush, Evaluator, INTERSECTION, SUBTRACTION } from "three-bvh-csg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bakeMeshesToGeometry, collectMeshMaterials } from "../bakeGeometry";
import { BOOLEAN_NODE } from "../nodes/boolean";
import { EvalContext } from "../types";
import { setJobExecutor } from "./jobs";
import { CloningExecutor } from "./testing";

function ctx(nodeId: string, extra: Partial<EvalContext> = {}): EvalContext {
  return { time: 0, step: 0, nodeId, simulationEpoch: 0, ...extra };
}

const OPERATIONS: Record<string, number> = { add: ADDITION, subtract: SUBTRACTION, intersect: INTERSECTION };

/** Boolean's evaluate before it moved to the worker, minus the caching: the reference the job must match. */
function oldInlineBoolean(inputA: THREE.Object3D, inputB: THREE.Object3D, operation: string, useGroups: boolean) {
  const meshes = (o: THREE.Object3D) => {
    const out: THREE.Mesh[] = [];
    o.traverse((c) => {
      if ((c as THREE.Mesh).isMesh) out.push(c as THREE.Mesh);
    });
    return out;
  };
  inputA.updateMatrixWorld(true);
  inputB.updateMatrixWorld(true);
  const meshesA = meshes(inputA);
  const meshesB = meshes(inputB);
  const materialsA = collectMeshMaterials(meshesA);
  const materialsB = collectMeshMaterials(meshesB);
  const brushA = new Brush(bakeMeshesToGeometry(meshesA)!, materialsA.length > 1 ? materialsA : materialsA[0]);
  const brushB = new Brush(bakeMeshesToGeometry(meshesB)!, materialsB.length > 1 ? materialsB : materialsB[0]);
  const evaluator = new Evaluator();
  evaluator.useGroups = useGroups;
  const result = evaluator.evaluate(brushA, brushB, OPERATIONS[operation] ?? SUBTRACTION);
  return { geometry: result.geometry, material: useGroups ? result.material : meshesA[0].material };
}

function expectSameResult(mesh: THREE.Mesh, expected: { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[] }) {
  const g = mesh.geometry;
  for (const name of ["position", "normal", "uv"]) {
    expect(g.getAttribute(name).array, name).toEqual(expected.geometry.getAttribute(name).array);
  }
  expect(g.index!.array).toEqual(expected.geometry.index!.array);
  expect(g.groups).toEqual(expected.geometry.groups);
  expect(g.drawRange).toEqual(expected.geometry.drawRange);
  // Same material objects, slot for slot.
  const actual = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const want = Array.isArray(expected.material) ? expected.material : [expected.material];
  expect(actual.length).toBe(want.length);
  actual.forEach((m, i) => expect(m).toBe(want[i]));
}

const red = new THREE.MeshStandardMaterial({ color: 0xff0000 });
const green = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
const blue = new THREE.MeshStandardMaterial({ color: 0x0000ff });

function box(material: THREE.Material, x = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material);
  mesh.position.x = x;
  return mesh;
}

function sphere(material: THREE.Material, x: number, y = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1.1, 16, 12), material);
  mesh.position.set(x, y, 0);
  mesh.rotation.z = 0.3;
  return mesh;
}

/** A side made of several meshes, two of them sharing a material — the case three-bvh-csg merges slots for. */
function group(...children: THREE.Mesh[]): THREE.Group {
  const g = new THREE.Group();
  g.position.z = 0.25;
  for (const c of children) g.add(c);
  return g;
}

const cases: [string, () => [THREE.Object3D, THREE.Object3D], string, boolean][] = [];
for (const operation of ["subtract", "add", "intersect"]) {
  for (const useGroups of [true, false]) {
    cases.push([`box ${operation} sphere`, () => [box(red), sphere(blue, 1)], operation, useGroups]);
    cases.push([
      `two boxes ${operation} three spheres (shared materials)`,
      () => [group(box(red, -0.5), box(green, 1.5)), group(sphere(blue, 0), sphere(red, 1.2, 0.5), sphere(blue, 2))],
      operation,
      useGroups,
    ]);
  }
}

afterEach(() => setJobExecutor(null));

describe("boolean kernel parity with the old inline CSG", () => {
  it.each(cases)("%s (%s, useGroups %s) inline", (_name, make, operation, useGroups) => {
    const [a, b] = make();
    const out = BOOLEAN_NODE.evaluate({ geometry: a, boolean: b }, { operation, useGroups }, ctx(`bool-inline-${_name}-${operation}-${useGroups}`));
    expectSameResult(out.geometry as THREE.Mesh, oldInlineBoolean(a, b, operation, useGroups));
  });

  it.each(cases)("%s (%s, useGroups %s) through the worker", async (_name, make, operation, useGroups) => {
    const exec = new CloningExecutor();
    setJobExecutor(exec);
    const id = `bool-worker-${_name}-${operation}-${useGroups}`;
    const [a, b] = make();
    // First evaluation runs inline (nothing to show yet); move B to send a job.
    BOOLEAN_NODE.evaluate({ geometry: a, boolean: b }, { operation, useGroups }, ctx(id));
    const before = ((b.children.length ? b.children[0] : b) as THREE.Mesh).geometry;
    b.position.y += 0.4;
    const stale = BOOLEAN_NODE.evaluate({ geometry: a, boolean: b }, { operation, useGroups }, ctx(id)).geometry as THREE.Mesh;
    const staleGeometry = stale.geometry;
    await exec.flush();
    expect(exec.jobs).toBe(1);
    const landed = BOOLEAN_NODE.evaluate({ geometry: a, boolean: b }, { operation, useGroups }, ctx(id)).geometry as THREE.Mesh;
    expect(landed).toBe(stale);
    expect(landed.geometry).not.toBe(staleGeometry);
    expectSameResult(landed, oldInlineBoolean(a, b, operation, useGroups));
    // The inputs' own arrays were copied into the payload, not transferred away.
    const input = (b.children.length ? b.children[0] : b) as THREE.Mesh;
    expect(input.geometry).toBe(before);
    expect(input.geometry.getAttribute("position").array.length).toBeGreaterThan(0);
  });
});

describe("Boolean failures", () => {
  it("passes the first input through when the CSG throws, and does not retry the same inputs", () => {
    const a = box(red);
    const b = sphere(blue, 1);
    const spy = vi.spyOn(Evaluator.prototype, "evaluate").mockImplementation(() => {
      throw new Error("degenerate input");
    });
    const errors: unknown[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const out = BOOLEAN_NODE.evaluate({ geometry: a, boolean: b }, { operation: "subtract", useGroups: true }, ctx("bool-fail"));
      expect(out.geometry).toBe(a);
      BOOLEAN_NODE.evaluate({ geometry: a, boolean: b }, { operation: "subtract", useGroups: true }, ctx("bool-fail"));
    } finally {
      console.error = realError;
      spy.mockRestore();
    }
    expect(errors.length).toBe(1);
    expect(String(errors[0])).toContain("degenerate input");
  });

  it("runs inline while capturing", () => {
    setJobExecutor(new CloningExecutor());
    const a = box(red);
    const b = sphere(blue, 1);
    BOOLEAN_NODE.evaluate({ geometry: a, boolean: b }, { operation: "subtract", useGroups: true }, ctx("bool-capture"));
    b.position.y = 0.7;
    const out = BOOLEAN_NODE.evaluate({ geometry: a, boolean: b }, { operation: "subtract", useGroups: true }, ctx("bool-capture", { capturing: true }));
    expectSameResult(out.geometry as THREE.Mesh, oldInlineBoolean(a, b, "subtract", true));
  });
});
